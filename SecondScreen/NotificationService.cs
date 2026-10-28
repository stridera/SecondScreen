using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;

namespace SecondScreen;

/// <summary>
/// One alert for the web client. <see cref="Seq"/> is monotonic (seeded from the clock, so a plugin reload never reuses a value a
/// browser already saw); <see cref="Ts"/> and <see cref="ExpiresAt"/> are unix milliseconds.
/// Types ending in "_cleared" are control events: they tell the client to dismiss the matching banner and are not listed.
/// </summary>
public sealed record NotificationEvent(
    long Seq,
    long Ts,
    string Type,
    string Priority,
    string Title,
    string Body,
    IReadOnlyDictionary<string, object?> Data,
    long? ExpiresAt);

public sealed record QueueRoles(int Tanks, int TanksNeeded, int Healers, int HealersNeeded, int Dps, int DpsNeeded);

/// <summary>Duty Finder queue state for the dashboard chip. EnteredAt is unix ms (0 = unknown).</summary>
public sealed record QueueStatus(
    string State,
    string Kind,
    string Name,
    int Entries,
    long EnteredAt,
    int? Position,
    int? AvgWaitMin,
    QueueRoles? Roles,
    long? PopExpiresAt);

/// <summary>
/// Thread-safe ring buffer of the last <see cref="Capacity"/> events plus the plugin-side notification settings
/// (the mention keyword list, persisted in the plugin config). Event sources call <see cref="Emit"/>; the web layer reads
/// <see cref="Since"/> and the <see cref="Seq"/> high-water mark.
/// </summary>
internal sealed class NotificationService
{
    public const int Capacity = 200;
    public const int MaxKeywords = 50;
    public const int MaxKeywordLength = 40;

    private readonly object gate = new();
    private readonly List<NotificationEvent> ring = new();
    private readonly Configuration config;
    private readonly Action saveConfig;
    private long seq;
    private volatile string[] keywords;
    private volatile QueueStatus? queue;

    public NotificationService(Configuration config, Action saveConfig)
    {
        this.config = config;
        this.saveConfig = saveConfig;
        seq = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        keywords = Normalize(config.NotifyKeywords);
    }

    /// <summary>Highest sequence number handed out so far (sent as notifySeq in every WebSocket push).</summary>
    public long Seq => Volatile.Read(ref seq);

    /// <summary>Current queue state published by <see cref="NotificationSources"/>; null when not queued.</summary>
    public QueueStatus? Queue { get => queue; set => queue = value; }

    public string[] Keywords => keywords;

    public static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>Appends an event. <paramref name="ttlMs"/> sets ExpiresAt (now + ttl). Safe from any thread.</summary>
    public NotificationEvent Emit(string type, string priority, string title, string body = "",
        IReadOnlyDictionary<string, object?>? data = null, int? ttlMs = null)
    {
        var now = NowMs();
        lock (gate)
        {
            var ev = new NotificationEvent(++seq, now, type, priority, title, body,
                data ?? new Dictionary<string, object?>(), ttlMs is { } t ? now + t : null);
            ring.Add(ev);
            if (ring.Count > Capacity) ring.RemoveRange(0, ring.Count - Capacity);
            return ev;
        }
    }

    /// <summary>Events with Seq greater than <paramref name="since"/>, oldest first.</summary>
    public List<NotificationEvent> Since(long since)
    {
        lock (gate) return ring.Where(e => e.Seq > since).ToList();
    }

    /// <summary>Replaces the keyword list (trimmed, de-duplicated, capped) and saves the plugin config.</summary>
    public string[] SetKeywords(IEnumerable<string?> input)
    {
        var clean = Normalize(input);
        lock (gate)
        {
            keywords = clean;
            config.NotifyKeywords = clean.ToList();
        }
        try { saveConfig(); } catch { /* the in-memory list is already updated */ }
        return clean;
    }

    private static string[] Normalize(IEnumerable<string?>? input)
    {
        if (input == null) return Array.Empty<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var list = new List<string>();
        foreach (var raw in input)
        {
            var k = raw?.Trim();
            if (string.IsNullOrEmpty(k)) continue;
            if (k.Length > MaxKeywordLength) k = k.Substring(0, MaxKeywordLength);
            if (seen.Add(k)) list.Add(k);
            if (list.Count >= MaxKeywords) break;
        }
        return list.ToArray();
    }
}
