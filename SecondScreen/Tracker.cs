using System;

namespace SecondScreen;

/// <summary>Tracker kinds. "goal" (shop/recipe cost trees) is reserved for a later phase.</summary>
public static class TrackerKinds
{
    public const string Item = "item";
    public const string Achievement = "achievement";
    /// <summary>Main Scenario progress; no target id (the quest list is derived from game data).</summary>
    public const string Msq = "msq";
    /// <summary>A single quest (TargetId = Quest sheet row id): complete or not.</summary>
    public const string Quest = "quest";
    // Reserved: public const string Goal = "goal";

    public static bool IsSupported(string? kind) => kind == Item || kind == Achievement || kind == Msq || kind == Quest;
}

/// <summary>
/// Persisted tracker definition (lives in <see cref="Configuration.Trackers"/>). Plain mutable class so Dalamud's
/// config serializer round-trips it; all access goes through <c>TrackerService</c>, which locks around it.
/// New kinds reuse TargetId as "the thing being tracked" (item id, achievement id, later goal id / quest id).
/// </summary>
[Serializable]
public sealed class TrackerDef
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Kind { get; set; } = TrackerKinds.Item;
    public uint TargetId { get; set; }
    public int? TargetCount { get; set; }
    public bool IncludeHq { get; set; } = true;
    public string Title { get; set; } = "";
    public int Order { get; set; }
    public DateTime Created { get; set; } = DateTime.UtcNow;

    /// <summary>Cached icon so the framework thread never needs the name index.</summary>
    public uint IconId { get; set; }

    // Last known server-side achievement progress (and MSQ done/total, quest completion), persisted so it shows after a restart.
    public long? LastCurrent { get; set; }
    public long? LastMax { get; set; }
    public long LastUpdatedMs { get; set; }
    public bool LastComplete { get; set; }

    public TrackerDef Clone() => (TrackerDef)MemberwiseClone();
}

/// <summary>Immutable evaluated view of one tracker; built on the framework thread, read from web threads.</summary>
public sealed record TrackerProgress(
    string Id,
    string Kind,
    uint TargetId,
    int? TargetCount,
    bool IncludeHq,
    string Title,
    int Order,
    DateTime Created,
    uint IconId,
    long? Current,
    long? Max,
    bool Complete,
    string Detail,
    long? UpdatedMs,
    bool Pending,
    bool Live,
    MsqProgressInfo? Msq = null,
    QuestInfo? Quest = null);
