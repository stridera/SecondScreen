using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using Dalamud.Game.Chat;
using Dalamud.Game.Text;
using Dalamud.Plugin.Services;
using FFXIVClientStructs.FFXIV.Client.Enums;
using FFXIVClientStructs.FFXIV.Client.Game.UI;
using FFXIVClientStructs.FFXIV.Client.UI.Agent;
using Lumina.Excel;
using Lumina.Excel.Sheets;

namespace SecondScreen;

/// <summary>
/// Detects game events and feeds <see cref="NotificationService"/>. Game memory is only read on the framework thread
/// (a ~4 Hz pass for the duty queue, ready check and party invite; a ~0.2 Hz pass for ventures and resets).
///
///   duty_pop     IClientState.CfPop (primary) with a ContentsFinderQueueInfo.QueueState == Ready fallback
///   duty_pop_cleared / queue_ended / queue status   ContentsFinder.Instance()->QueueInfo state transitions
///   ready_check  AgentReadyCheck entry for the local ContentId == AwaitingResponse
///   party_invite AgentPartyInvite.InviterName while the agent is active
///   tell / mention   IChatGui.ChatMessage
///   venture_done InventoryService.Model retainers' Venture.CompleteAt passing
///   reset        UTC clock (daily 15:00, weekly Tuesday 08:00)
/// </summary>
internal sealed unsafe class NotificationSources : IDisposable
{
    private static readonly long FastTicks = Stopwatch.Frequency / 4;
    private static readonly long SlowTicks = Stopwatch.Frequency * 5;
    private const int PopWindowMs = 45_000;       // time the game gives you to accept a duty
    private const int ReadyCheckWindowMs = 35_000; // a ready check lasts 30 s
    private const int PopFallbackDelayMs = 1_500;  // how long to wait for CfPop before inferring a pop from the queue state

    private static readonly Dictionary<XivChatType, string> MentionChannels = new()
    {
        [XivChatType.Say] = "Say", [XivChatType.Shout] = "Shout", [XivChatType.Yell] = "Yell",
        [XivChatType.Party] = "Party", [XivChatType.CrossParty] = "Party", [XivChatType.Alliance] = "Alliance",
        [XivChatType.FreeCompany] = "Free Company", [XivChatType.NoviceNetwork] = "Novice Network", [XivChatType.PvPTeam] = "PvP Team",
        [XivChatType.Ls1] = "LS1", [XivChatType.Ls2] = "LS2", [XivChatType.Ls3] = "LS3", [XivChatType.Ls4] = "LS4",
        [XivChatType.Ls5] = "LS5", [XivChatType.Ls6] = "LS6", [XivChatType.Ls7] = "LS7", [XivChatType.Ls8] = "LS8",
        [XivChatType.CrossLinkShell1] = "CWLS1", [XivChatType.CrossLinkShell2] = "CWLS2", [XivChatType.CrossLinkShell3] = "CWLS3",
        [XivChatType.CrossLinkShell4] = "CWLS4", [XivChatType.CrossLinkShell5] = "CWLS5", [XivChatType.CrossLinkShell6] = "CWLS6",
        [XivChatType.CrossLinkShell7] = "CWLS7", [XivChatType.CrossLinkShell8] = "CWLS8",
    };

    private readonly IFramework framework;
    private readonly IClientState clientState;
    private readonly IChatGui chatGui;
    private readonly IPlayerState playerState;
    private readonly InventoryService inventory;
    private readonly NotificationService notifications;
    private readonly IPluginLog log;
    private readonly ExcelSheet<ContentFinderCondition>? duties;
    private readonly ExcelSheet<Lumina.Excel.Sheets.ContentRoulette>? roulettes;
    private readonly HashSet<string> failed = new();
    private readonly object popGate = new();

    private long lastFast, lastSlow;

    // queue
    private ContentsFinderQueueState prevState = ContentsFinderQueueState.None;
    private long queueObservedMs;
    private long readySinceMs;
    private string lastQueueName = "";
    private bool popActive;
    private long popAtMs;

    // ready check / party invite
    private bool readyCheckPending;
    private string inviteName = "";

    // ventures / resets
    private readonly HashSet<string> pendingVentures = new();
    private DateTime lastResetCheck = DateTime.UtcNow;

    public NotificationSources(IFramework framework, IClientState clientState, IChatGui chatGui, IPlayerState playerState,
        IDataManager data, InventoryService inventory, NotificationService notifications, IPluginLog log)
    {
        this.framework = framework;
        this.clientState = clientState;
        this.chatGui = chatGui;
        this.playerState = playerState;
        this.inventory = inventory;
        this.notifications = notifications;
        this.log = log;
        duties = data.GetExcelSheet<ContentFinderCondition>();
        roulettes = data.GetExcelSheet<Lumina.Excel.Sheets.ContentRoulette>();

        clientState.CfPop += OnCfPop;
        chatGui.ChatMessage += OnChat;
        framework.Update += OnUpdate;
    }

    public void Dispose()
    {
        framework.Update -= OnUpdate;
        chatGui.ChatMessage -= OnChat;
        clientState.CfPop -= OnCfPop;
    }

    private void Guard(string name, System.Action a)
    {
        try { a(); }
        catch (Exception ex)
        {
            if (failed.Add(name)) log.Error(ex, "SecondScreen notification source {Name} failed", name);
        }
    }

    private void OnUpdate(IFramework _)
    {
        var now = Stopwatch.GetTimestamp();
        if (now - lastFast >= FastTicks)
        {
            lastFast = now;
            Guard("queue", PollQueue);
            Guard("readycheck", PollReadyCheck);
            Guard("partyinvite", PollPartyInvite);
        }
        if (now - lastSlow >= SlowTicks)
        {
            lastSlow = now;
            Guard("ventures", PollVentures);
            Guard("resets", PollResets);
        }
    }

    // ---- duty queue / pop --------------------------------------------------------------------------------------------

    private void OnCfPop(ContentFinderCondition cfc)
    {
        try { EmitPop(Capitalize(cfc.Name.ToString()), cfc.RowId); }
        catch (Exception ex) { log.Warning(ex, "SecondScreen CfPop handler failed"); }
    }

    private void EmitPop(string name, uint conditionId)
    {
        lock (popGate)
        {
            var now = NotificationService.NowMs();
            if (popActive && now - popAtMs < 60_000) return; // CfPop and the state fallback both fire for one pop
            popActive = true;
            popAtMs = now;
        }
        notifications.Emit("duty_pop", "high", name.Length > 0 ? name : "Duty ready", "Your duty is ready. Accept it in the game.",
            new Dictionary<string, object?> { ["contentFinderConditionId"] = conditionId }, PopWindowMs);
    }

    private void ClearPop(string reason)
    {
        lock (popGate)
        {
            if (!popActive) return;
            popActive = false;
        }
        notifications.Emit("duty_pop_cleared", "low", "Duty pop cleared", reason, new Dictionary<string, object?> { ["reason"] = reason });
    }

    private void PollQueue()
    {
        var cf = ContentsFinder.Instance();
        if (!clientState.IsLoggedIn || cf == null)
        {
            prevState = ContentsFinderQueueState.None;
            notifications.Queue = null;
            lock (popGate) popActive = false;
            return;
        }

        var qi = &cf->QueueInfo;
        var state = qi->QueueState;
        var nowMs = NotificationService.NowMs();
        var prev = prevState;

        if (state != prev)
        {
            if (state is ContentsFinderQueueState.Pending or ContentsFinderQueueState.Queued && prev is ContentsFinderQueueState.None)
                queueObservedMs = nowMs;
            if (state == ContentsFinderQueueState.Ready) readySinceMs = nowMs;

            if (prev == ContentsFinderQueueState.Ready)
                ClearPop(state is ContentsFinderQueueState.Accepted or ContentsFinderQueueState.InContent ? "accepted" : "withdrawn");
            else if (prev is ContentsFinderQueueState.Pending or ContentsFinderQueueState.Queued && state == ContentsFinderQueueState.None)
                notifications.Emit("queue_ended", "normal", "Left the duty queue",
                    lastQueueName.Length > 0 ? $"You are no longer queued for {lastQueueName}." : "You are no longer in the duty queue.");
        }
        prevState = state;

        // A stale flag (e.g. a cleared event we never saw) must not block the next pop.
        lock (popGate) if (popActive && nowMs - popAtMs > 120_000) popActive = false;

        if (state is not (ContentsFinderQueueState.Pending or ContentsFinderQueueState.Queued or ContentsFinderQueueState.Ready))
        {
            notifications.Queue = null;
            return;
        }

        var status = BuildQueueStatus(qi, state, nowMs, out var poppedName, out var poppedId);
        notifications.Queue = status;
        if (status.Name.Length > 0) lastQueueName = status.Name;

        if (state == ContentsFinderQueueState.Ready && nowMs - readySinceMs > PopFallbackDelayMs)
        {
            bool active;
            lock (popGate) active = popActive;
            if (!active) EmitPop(poppedName.Length > 0 ? poppedName : status.Name, poppedId);
        }
    }

    private QueueStatus BuildQueueStatus(ContentsFinderQueueInfo* qi, ContentsFinderQueueState state, long nowMs, out string poppedName, out uint poppedId)
    {
        var regular = 0;
        string? first = null;
        uint rouletteId = 0;
        foreach (var e in qi->QueuedEntries)
        {
            if (e.Id == 0) continue;
            if (e.ContentType == ContentsType.Regular) { regular++; first ??= DutyName(e.Id); }
            else if (e.ContentType == ContentsType.Roulette && rouletteId == 0) rouletteId = e.Id;
        }
        if (rouletteId == 0 && regular == 0) rouletteId = qi->QueuedContentRouletteId;

        string kind, name;
        if (regular > 0) { kind = "duty"; name = regular > 1 ? $"{first} +{regular - 1}" : first ?? ""; }
        else if (rouletteId != 0) { kind = "roulette"; name = RouletteName(rouletteId); }
        else { kind = "duty"; name = ""; }

        poppedName = "";
        poppedId = 0;
        if (state == ContentsFinderQueueState.Ready && qi->PoppedQueueEntry.Id != 0)
        {
            poppedId = qi->PoppedQueueEntry.Id;
            if (qi->PoppedQueueEntry.ContentType == ContentsType.Regular) poppedName = DutyName(poppedId);
            else if (qi->PoppedQueueEntry.ContentType == ContentsType.Roulette) poppedName = RouletteName(poppedId);
        }

        // EnteredQueueTimestamp is unix seconds; distrust anything far from now and fall back to when we first saw the queue.
        long entered = qi->EnteredQueueTimestamp * 1000L;
        if (entered <= 0 || Math.Abs(entered - nowMs) > 24 * 3600 * 1000L) entered = queueObservedMs;

        var info = qi->InfoState;
        int? position = info.ContentType == QueueInfoState.QueueContentType.PositionAndWaitTime && info.PositionInQueue > 0 ? info.PositionInQueue : null;
        int? wait = info.ContentType <= QueueInfoState.QueueContentType.WaitTime && info.AverageWaitTime > 0 ? info.AverageWaitTime : null;
        QueueRoles? roles = null;
        if (info.ContentType == QueueInfoState.QueueContentType.THDAndWaitTime)
            roles = new QueueRoles(info.TanksFound, info.TanksNeeded, info.HealersFound, info.HealersNeeded, info.DPSFound, info.DPSNeeded);

        lock (popGate)
        {
            var popExpires = state == ContentsFinderQueueState.Ready && popActive ? popAtMs + PopWindowMs : (long?)null;
            return new QueueStatus(state.ToString().ToLowerInvariant(), kind, name, Math.Max(regular, rouletteId != 0 ? 1 : 0),
                entered, position, wait, roles, popExpires);
        }
    }

    private string DutyName(uint id)
        => duties != null && duties.TryGetRow(id, out var row) ? Capitalize(row.Name.ToString()) : "";

    private string RouletteName(uint id)
        => roulettes != null && roulettes.TryGetRow(id, out var row) ? Capitalize(row.Name.ToString()) : "";

    // ---- ready check / party invite ---------------------------------------------------------------------------------

    private void PollReadyCheck()
    {
        var pending = false;
        var agent = AgentReadyCheck.Instance();
        if (agent != null && clientState.IsLoggedIn && playerState.IsLoaded && (agent->IsAgentActive() || agent->IsAddonShown()))
        {
            var me = playerState.ContentId;
            foreach (var e in agent->ReadyCheckEntries)
            {
                if (e.ContentId == me && e.Status == ReadyCheckStatus.AwaitingResponse) { pending = true; break; }
            }
        }

        if (pending == readyCheckPending) return;
        readyCheckPending = pending;
        if (pending)
            notifications.Emit("ready_check", "high", "Ready check", "Your party is waiting for you to respond to a ready check in the game.", null, ReadyCheckWindowMs);
        else
            notifications.Emit("ready_check_cleared", "low", "Ready check cleared");
    }

    private void PollPartyInvite()
    {
        var name = "";
        var agent = AgentPartyInvite.Instance();
        if (agent != null && clientState.IsLoggedIn && agent->IsAgentActive())
            name = agent->InviterName.ToString().Trim();

        if (name == inviteName) return;
        inviteName = name;
        if (name.Length > 0)
            notifications.Emit("party_invite", "normal", "Party invite", $"{name} invited you to join a party.",
                new Dictionary<string, object?> { ["from"] = name });
    }

    // ---- chat --------------------------------------------------------------------------------------------------------

    private void OnChat(IHandleableChatMessage msg)
    {
        try
        {
            var type = msg.LogKind;
            if (type != XivChatType.TellIncoming && !MentionChannels.ContainsKey(type)) return;
            if (msg.SourceKind == XivChatRelationKind.LocalPlayer) return;

            var sender = CleanSender(msg.Sender.TextValue);
            var me = playerState.CharacterName ?? "";
            if (me.Length > 0 && sender.Equals(me, StringComparison.OrdinalIgnoreCase)) return; // own message
            var text = msg.Message.TextValue.Trim();
            if (text.Length == 0) return;
            if (text.Length > 240) text = text.Substring(0, 237) + "...";

            if (type == XivChatType.TellIncoming)
            {
                notifications.Emit("tell", "high", sender.Length > 0 ? sender : "Tell", text,
                    new Dictionary<string, object?> { ["from"] = sender });
                return;
            }

            string? matched = null;
            var first = me.Split(' ', 2)[0];
            if (first.Length >= 2 && ContainsWord(text, first)) matched = first;
            else
            {
                foreach (var k in notifications.Keywords)
                    if (ContainsWord(text, k)) { matched = k; break; }
            }
            if (matched == null) return;

            var channel = MentionChannels[type];
            notifications.Emit("mention", "normal", sender.Length > 0 ? $"{sender} in {channel}" : channel, text,
                new Dictionary<string, object?> { ["from"] = sender, ["channel"] = channel, ["match"] = matched });
        }
        catch (Exception ex)
        {
            if (failed.Add("chat")) log.Error(ex, "SecondScreen chat notification handler failed");
        }
    }

    /// <summary>Sender text carries private-use icons (party number, world marker); keep only the name between them.</summary>
    private static string CleanSender(string raw)
    {
        var i = 0;
        while (i < raw.Length && (IsPrivateUse(raw[i]) || char.IsWhiteSpace(raw[i]))) i++;
        var j = i;
        while (j < raw.Length && !IsPrivateUse(raw[j])) j++;
        return raw.Substring(i, j - i).Trim();
    }

    private static bool IsPrivateUse(char c) => c >= '' && c <= '';

    private static bool ContainsWord(string text, string word)
    {
        if (word.Length == 0) return false;
        var i = 0;
        while ((i = text.IndexOf(word, i, StringComparison.OrdinalIgnoreCase)) >= 0)
        {
            var end = i + word.Length;
            var leftOk = i == 0 || !char.IsLetterOrDigit(text[i - 1]);
            var rightOk = end >= text.Length || !char.IsLetterOrDigit(text[end]);
            if (leftOk && rightOk) return true;
            i++;
        }
        return false;
    }

    // ---- ventures ----------------------------------------------------------------------------------------------------

    private void PollVentures()
    {
        var m = inventory.Model;
        if (!m.LoggedIn || m.Character == null || m.Retainers.Count == 0) return;

        var nowSec = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var current = new HashSet<string>();
        foreach (var r in m.Retainers)
        {
            var v = r.Venture;
            if (v == null || v.CompleteAt <= 0) continue;
            var key = string.Create(CultureInfo.InvariantCulture, $"{m.Character.Id}:{r.Id}:{v.TaskId}:{v.CompleteAt}");
            current.Add(key);
            if (v.CompleteAt > nowSec) { pendingVentures.Add(key); continue; }
            // Only ventures we watched run out; ones already finished when the plugin loaded are old news.
            if (pendingVentures.Remove(key))
                notifications.Emit("venture_done", "normal", $"{r.Name}: venture complete",
                    string.IsNullOrEmpty(v.Name) ? "A retainer venture has finished." : v.Name,
                    new Dictionary<string, object?> { ["retainerId"] = r.Id, ["retainer"] = r.Name, ["venture"] = v.Name });
        }
        pendingVentures.RemoveWhere(k => !current.Contains(k));
    }

    // ---- daily / weekly reset ----------------------------------------------------------------------------------------

    private static DateTime LastDailyReset(DateTime utc)
    {
        var b = utc.Date.AddHours(15);
        return b <= utc ? b : b.AddDays(-1);
    }

    private static DateTime LastWeeklyReset(DateTime utc)
    {
        var d = utc.Date;
        var back = ((int)d.DayOfWeek - (int)DayOfWeek.Tuesday + 7) % 7;
        var b = d.AddDays(-back).AddHours(8);
        return b <= utc ? b : b.AddDays(-7);
    }

    private void PollResets()
    {
        var now = DateTime.UtcNow;
        var last = lastResetCheck;
        lastResetCheck = now;
        if (now <= last) return; // clock moved backwards

        if (LastDailyReset(now) > last)
            notifications.Emit("reset", "low", "Daily reset", "Duty Roulette, Beast Tribe quests and other daily tasks have reset.",
                new Dictionary<string, object?> { ["kind"] = "daily" });
        if (LastWeeklyReset(now) > last)
            notifications.Emit("reset", "low", "Weekly reset", "Weekly lockouts, Wondrous Tails and Challenge Log entries have reset.",
                new Dictionary<string, object?> { ["kind"] = "weekly" });
    }

    private static string Capitalize(string s)
        => s.Length > 0 && char.IsLower(s[0]) ? char.ToUpperInvariant(s[0]) + s.Substring(1) : s;
}
