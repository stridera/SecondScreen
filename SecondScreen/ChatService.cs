using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;
using Dalamud.Game.Chat;
using Dalamud.Game.Text;
using Dalamud.Game.Text.SeStringHandling;
using Dalamud.Game.Text.SeStringHandling.Payloads;
using Dalamud.Plugin.Services;

namespace SecondScreen;

/// <summary>One recorded chat line. Ts is unix ms (when we received it); World is only set for players from another world.</summary>
public sealed class ChatLine
{
    public long Seq { get; init; }
    public long Ts { get; init; }
    public string Ch { get; init; } = "";
    public string Sender { get; init; } = "";
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? World { get; init; }
    public string Text { get; init; } = "";
}

/// <summary>
/// Read-only copy of the game's chat. Subscribes to IChatGui.ChatMessage (fires on the framework thread), converts each message to
/// plain text and keeps the last <see cref="Capacity"/> lines in an in-memory ring. Nothing is written to disk. The web side only asks
/// for lines newer than a sequence number (GET /api/chat?since=N); the WebSocket carries just the high-water mark.
/// Possible future feature: replying from the dashboard (would need a chat-input path; deliberately not implemented).
/// </summary>
internal sealed class ChatService : IDisposable
{
    public const int Capacity = 500;

    private readonly IChatGui gui;
    private readonly IPlayerState playerState;
    private readonly IPluginLog log;
    private readonly HashSet<XivChatType> ignored;
    private readonly object gate = new();
    private readonly ChatLine[] ring = new ChatLine[Capacity];
    private readonly long epoch = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private long seq;          // last assigned sequence number (0 = none yet)
    private long count;        // lines currently stored
    private bool errorLogged;

    public ChatService(IChatGui gui, IPlayerState playerState, Configuration config, IPluginLog log)
    {
        this.gui = gui;
        this.playerState = playerState;
        this.log = log;
        ignored = ChatChannels.ParseIgnored(config.ChatIgnoredTypes);
        gui.ChatMessage += OnChatMessage;
    }

    /// <summary>High-water mark: the sequence number of the newest line (0 when empty). Sent as chatSeq in the WebSocket payload.</summary>
    public long Seq { get { lock (gate) return seq; } }

    public void Dispose() => gui.ChatMessage -= OnChatMessage;

    private void OnChatMessage(IHandleableChatMessage message)
    {
        try
        {
            var kind = message.LogKind;
            if (ignored.Contains(kind)) return;
            var text = ChatText.ToText(message.Message);
            if (text.Length == 0) return;

            var channel = ChatChannels.Map(kind);
            var (sender, world) = ReadSender(message.Sender);
            var ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            lock (gate)
            {
                var n = ++seq;
                ring[(n - 1) % Capacity] = new ChatLine { Seq = n, Ts = ts, Ch = channel, Sender = sender, World = world, Text = text };
                if (count < Capacity) count++;
            }
        }
        catch (Exception ex)
        {
            if (!errorLogged) { log.Error(ex, "SecondScreen chat capture failed"); errorLogged = true; }
        }
    }

    /// <summary>Name and (for players from another world) world of the sender. Sender strings carry a PlayerPayload for real players.</summary>
    private (string Name, string? World) ReadSender(SeString? sender)
    {
        if (sender == null) return ("", null);
        var name = ChatText.SenderName(sender);
        string? world = null;
        foreach (var p in sender.Payloads)
        {
            if (p is not PlayerPayload pp) continue;
            if (!string.IsNullOrEmpty(pp.PlayerName)) name = pp.PlayerName;
            var w = pp.World.ValueNullable?.Name.ToString();
            var here = playerState.IsLoaded ? playerState.CurrentWorld.ValueNullable?.Name.ToString() : null;
            if (!string.IsNullOrEmpty(w) && !string.Equals(w, here, StringComparison.Ordinal)) world = w;
            break;
        }
        return (name, world);
    }

    /// <summary>The GET /api/chat body: lines with Seq greater than <paramref name="since"/> (at most <paramref name="limit"/>, newest kept).</summary>
    public string GetJson(long since, int limit)
    {
        limit = Math.Clamp(limit, 1, Capacity);
        List<ChatLine> lines;
        long high, first;
        lock (gate)
        {
            high = seq;
            first = high - count + 1;                 // oldest stored sequence number
            var from = Math.Max(since + 1, first);
            if (since > high) from = first;           // client is ahead of us (plugin restarted): resend everything
            lines = new List<ChatLine>((int)Math.Max(0, high - from + 1));
            for (var s = from; s <= high; s++) lines.Add(ring[(s - 1) % Capacity]);
        }
        if (lines.Count > limit) lines = lines.GetRange(lines.Count - limit, limit);
        return Json.Serialize(new { epoch, seq = high, first = Math.Max(first, 1), messages = lines });
    }
}
