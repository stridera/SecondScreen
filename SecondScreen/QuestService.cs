using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Dalamud.Plugin.Services;
using FFXIVClientStructs.FFXIV.Client.Game;
using FFXIVClientStructs.FFXIV.Client.Game.UI;

namespace SecondScreen;

/// <summary>One quest marker of GET /api/quests/map/{mapId}. X / Y are pixels on the 2048px map texture, Cx / Cy in-game coordinates.</summary>
public sealed record QuestMapItem(
    uint Id, string Name, int Level, string Cat, uint Icon, string Genre, string Giver,
    int X, int Y, double Cx, double Cy, string Status, string? Reason, bool Repeat, string Job, IReadOnlyList<QuestUnlock> Unlocks);

public sealed record QuestMapResponse(uint MapId, bool LoggedIn, long Version, IReadOnlyList<QuestMapItem> Quests);

public sealed record QuestLink(uint Id, string Name, int Level, bool Done);

/// <summary>Response of GET /api/quests/{id}.</summary>
public sealed record QuestDetail(
    uint Id, string Name, int Level, string Cat, uint Icon, string Genre, string Expansion, string Giver, uint MapId,
    int X, int Y, double Cx, double Cy, string Status, string? Reason, string Job, bool Repeat, string Summary,
    IReadOnlyList<QuestUnlock> Unlocks, QuestRewards Rewards, IReadOnlyList<QuestLink> Prereqs, bool PrereqAny, IReadOnlyList<QuestLink> LeadsTo);

/// <summary>
/// Per-character quest state for the map "Quests" layer. Game memory (QuestManager completion bits, accepted quests,
/// PlayerState class levels) is read only on the framework thread, and only while some client has asked for quest data
/// in the last minute: one pass over ~6000 completion bits every <see cref="RefreshMs"/>, published as an immutable
/// <see cref="QuestState"/> through a volatile field. Web threads read that snapshot plus the Lumina quest model.
/// </summary>
internal sealed class QuestService : IDisposable
{
    private const long RefreshMs = 5000;
    private const long WantedMs = 60_000;
    private const int MaxQuestBits = 6008;   // QuestManager.CompletedQuests is 751 bytes

    private readonly IFramework framework;
    private readonly IPlayerState playerState;
    private readonly IClientState clientState;
    private readonly QuestModel model;
    private readonly MapService maps;

    private QuestState state = QuestState.Empty;
    private long wantedUntil;                    // Environment.TickCount64 until which the framework thread keeps refreshing
    private long lastRefresh = long.MinValue / 2;
    private long version;

    public QuestService(IFramework framework, IClientState clientState, IPlayerState playerState, QuestModel model, MapService maps)
    {
        this.framework = framework;
        this.clientState = clientState;
        this.playerState = playerState;
        this.model = model;
        this.maps = maps;
        framework.Update += OnUpdate;
    }

    public void Dispose() => framework.Update -= OnUpdate;

    // ---- framework thread --------------------------------------------------------------------------------------------------

    private void OnUpdate(IFramework _)
    {
        var now = Environment.TickCount64;
        if (now > Volatile.Read(ref wantedUntil)) return;          // nobody is looking at the quest layer: zero cost
        if (now - lastRefresh < RefreshMs) return;
        lastRefresh = now;
        try { Refresh(); } catch { /* game state not ready this frame: try again at the next interval */ }
    }

    private unsafe void Refresh()
    {
        if (!clientState.IsLoggedIn || !playerState.IsLoaded || QuestManager.Instance() == null || PlayerState.Instance() == null)
        {
            if (!ReferenceEquals(state, QuestState.Empty)) state = QuestState.Empty;
            return;
        }

        var cid = playerState.ContentId;
        var completed = new HashSet<uint>();
        for (var i = 1; i < MaxQuestBits; i++)
            if (QuestManager.IsQuestComplete((ushort)i)) completed.Add(0x10000u + (uint)i);

        var accepted = new HashSet<uint>();
        var qm = QuestManager.Instance();
        foreach (var w in qm->NormalQuests)
            if (w.QuestId != 0) accepted.Add(0x10000u + w.QuestId);

        var src = PlayerState.Instance()->ClassJobLevels;
        var levels = new short[src.Length];
        for (var i = 0; i < levels.Length; i++) levels[i] = src[i];

        var old = state;
        if (old.Character == cid && old.Completed.SetEquals(completed) && old.Accepted.SetEquals(accepted) && old.Levels.AsSpan().SequenceEqual(levels))
            return; // nothing changed: keep the version stable so clients can skip redraws
        state = new QuestState(++version, cid, completed, accepted, levels);
    }

    // ---- web threads --------------------------------------------------------------------------------------------------------

    /// <summary>Marks the layer as in use and returns the newest snapshot, waiting briefly for the first one.</summary>
    private async Task<QuestState> GetStateAsync()
    {
        Volatile.Write(ref wantedUntil, Environment.TickCount64 + WantedMs);
        for (var i = 0; i < 50; i++)
        {
            var s = Volatile.Read(ref state);
            if (s.Version > 0) return s;
            await Task.Delay(40).ConfigureAwait(false);
        }
        return Volatile.Read(ref state);
    }

    private static string StatusName(QuestStatus s) => s switch
    {
        QuestStatus.Accepted => "accepted",
        QuestStatus.Locked => "locked",
        _ => "available",
    };

    public async Task<QuestMapResponse> GetMapAsync(uint mapId)
    {
        var data = await model.GetAsync().ConfigureAwait(false);
        var s = await GetStateAsync().ConfigureAwait(false);
        if (s.Version == 0) return new QuestMapResponse(mapId, false, 0, Array.Empty<QuestMapItem>());
        var list = new List<QuestMapItem>();
        if (data.ByMap.TryGetValue(mapId, out var quests))
        {
            foreach (var q in quests)
            {
                var st = QuestModel.Evaluate(q, s, data.ById, out var reason);
                if (st is QuestStatus.Done or QuestStatus.Blocked) continue;
                list.Add(new QuestMapItem(q.Id, q.Name, q.Level, q.Category, q.IconId, q.Genre, q.Giver, q.X, q.Y, q.Cx, q.Cy,
                    StatusName(st), reason, q.Repeatable, q.JobName, q.Unlocks));
            }
        }
        return new QuestMapResponse(mapId, true, s.Version, list);
    }

    public async Task<QuestDetail?> GetDetailAsync(uint questId)
    {
        var data = await model.GetAsync().ConfigureAwait(false);
        if (!data.ById.TryGetValue(questId, out var q)) return null;
        var s = await GetStateAsync().ConfigureAwait(false);
        var loggedIn = s.Version > 0;

        string? reason = null;
        var status = loggedIn ? QuestModel.Evaluate(q, s, data.ById, out reason) : QuestStatus.Available;
        QuestLink Link(uint id)
        {
            var found = data.ById.TryGetValue(id, out var o);
            return new QuestLink(id, found ? o!.Name : model.NameOf(id), found ? o!.Level : 0, loggedIn && s.Completed.Contains(id));
        }

        var statusName = status switch
        {
            QuestStatus.Done => "done",
            QuestStatus.Blocked => "blocked",
            _ => StatusName(status),
        };
        var leads = new List<QuestLink>();
        foreach (var id in q.LeadsTo) leads.Add(Link(id));
        var prereqs = new List<QuestLink>();
        foreach (var id in q.Prev) prereqs.Add(Link(id));

        return await Task.Run(() => new QuestDetail(q.Id, q.Name, q.Level, q.Category, q.IconId, q.Genre, q.Expansion, q.Giver, q.MapId,
            q.X, q.Y, q.Cx, q.Cy, loggedIn ? statusName : "unknown", reason, q.JobName, q.Repeatable, model.Summary(q.Id),
            q.Unlocks, model.Rewards(q.Id), prereqs, q.PrevAny, leads)).ConfigureAwait(false);
    }
}
