using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading.Tasks;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;
using FFXIVClientStructs.FFXIV.Client.Game;
using FFXIVClientStructs.FFXIV.Client.Game.UI;

namespace SecondScreen;

/// <summary>
/// Owns tracker definitions and their evaluation. Game memory is only touched on the framework thread:
/// inventory counts are re-evaluated at ~1 Hz and published as an immutable list through a volatile field;
/// achievement progress is fetched one request at a time (see <see cref="PumpAchievements"/>); quest completion
/// (MSQ / single quest trackers) is read from QuestManager at most every <see cref="QuestRefreshMs"/>.
/// Web threads call the CRUD methods, which lock around the config list and then save.
/// </summary>
internal sealed unsafe class TrackerService : IDisposable
{
    private const long EvalIntervalMs = 1000;
    private const long PumpIntervalMs = 200;
    private const long AchievementRefreshMs = 5 * 60 * 1000;
    private const long RequestTimeoutMs = 8000;
    private const long RetryBackoffMs = 60 * 1000;
    private const long CompletedRequestIntervalMs = 30 * 1000;
    private const long SaveDebounceMs = 5000;
    private const long QuestRefreshMs = 10 * 1000;

    private sealed class ActiveRequest
    {
        public uint AchievementId;
        public long StartedMs;
        public bool SawRequested;
    }

    private readonly IFramework framework;
    private readonly IClientState clientState;
    private readonly IDalamudPluginInterface pi;
    private readonly Configuration config;
    private readonly IPluginLog log;
    private readonly MsqModel quests;
    private readonly IPlayerState playerState;
    private readonly object gate = new(); // guards config.Trackers, forced and the dirty flag

    private readonly HashSet<uint> forced = new();            // achievements to re-request now (gate)
    private readonly Dictionary<uint, long> retryAt = new();   // achievement id -> monotonic ms before which not to retry (gate)
    private ActiveRequest? active;                             // framework thread only
    private bool dirty;                                        // config needs saving (gate)

    private volatile IReadOnlyList<TrackerProgress> progress = Array.Empty<TrackerProgress>();
    private volatile bool evalNow = true;
    private long lastEval = long.MinValue / 2;
    private long lastPump = long.MinValue / 2;
    private long lastSave;
    private long lastCompletedRequest = long.MinValue / 2;
    private bool errorLogged;

    // Quest completion cache (framework thread only). Completion never reverts, so once a quest is seen complete it is
    // kept; only the still-incomplete quests are re-checked, at most every QuestRefreshMs. Reset when the character changes.
    private readonly HashSet<uint> completedQuests = new();
    private readonly HashSet<uint> checkedQuests = new();     // ids asked at least once since the last reset
    private readonly Dictionary<uint, QuestInfo?> questInfoCache = new();
    private ulong questCharacter;
    private long lastQuestRefresh = long.MinValue / 2;
    private int questVersion;                                  // bumped whenever completedQuests/character changes
    private MsqSnapshot? msqSnapshot;
    private int msqSnapshotVersion = -1;

    public TrackerService(IFramework framework, IClientState clientState, IDalamudPluginInterface pi, Configuration config, IPluginLog log, MsqModel quests, IPlayerState playerState)
    {
        this.framework = framework;
        this.clientState = clientState;
        this.pi = pi;
        this.config = config;
        this.log = log;
        this.quests = quests;
        this.playerState = playerState;
        this.framework.Update += OnUpdate;
    }

    /// <summary>Latest evaluated trackers (immutable; safe from any thread).</summary>
    public IReadOnlyList<TrackerProgress> Progress => progress;

    public void Dispose()
    {
        framework.Update -= OnUpdate;
        lock (gate) SaveLocked();
    }

    // ---- definitions (any thread) ----------------------------------------------------------------------------

    public TrackerDef Add(string kind, uint targetId, int? targetCount, string title, uint iconId, bool includeHq = true)
    {
        if (!TrackerKinds.IsSupported(kind) || kind == TrackerKinds.Msq) throw new ArgumentException("Unsupported tracker kind");
        var def = new TrackerDef
        {
            Kind = kind,
            TargetId = targetId,
            TargetCount = NormalizeCount(targetCount),
            IncludeHq = includeHq,
            Title = title,
            IconId = iconId,
        };
        lock (gate)
        {
            def.Order = config.Trackers.Count == 0 ? 0 : config.Trackers.Max(t => t.Order) + 1;
            config.Trackers.Add(def);
            if (kind == TrackerKinds.Achievement) forced.Add(targetId);
            dirty = true;
            SaveLocked();
        }
        evalNow = true;
        return def.Clone();
    }

    /// <summary>
    /// Adds the (single) Main Scenario tracker, or returns the existing one. Awaits the MSQ model build only to pick
    /// the card icon, so it never blocks a web thread.
    /// </summary>
    public Task<TrackerDef> AddMsqAsync()
    {
        lock (gate)
        {
            var existing = config.Trackers.FirstOrDefault(t => t.Kind == TrackerKinds.Msq);
            if (existing != null) return Task.FromResult(existing.Clone());
        }
        return quests.GetAsync().ContinueWith(t => AddMsqCore(t.Result.IconId), TaskScheduler.Default);
    }

    private TrackerDef AddMsqCore(uint iconId)
    {
        TrackerDef copy;
        lock (gate)
        {
            var existing = config.Trackers.FirstOrDefault(t => t.Kind == TrackerKinds.Msq);
            if (existing != null) return existing.Clone();
            var def = new TrackerDef { Kind = TrackerKinds.Msq, Title = "Main Scenario", IconId = iconId };
            def.Order = config.Trackers.Count == 0 ? 0 : config.Trackers.Max(t => t.Order) + 1;
            config.Trackers.Add(def);
            dirty = true;
            SaveLocked();
            copy = def.Clone();
        }
        evalNow = true;
        return copy;
    }

    /// <summary>Applies the supplied fields. Returns the updated copy, or null if the id is unknown.</summary>
    public TrackerDef? Update(string id, bool setCount, int? targetCount, string? title, int? order)
    {
        TrackerDef copy;
        lock (gate)
        {
            var def = config.Trackers.FirstOrDefault(t => t.Id == id);
            if (def == null) return null;
            if (setCount) def.TargetCount = NormalizeCount(targetCount);
            if (title != null && title.Trim().Length > 0) def.Title = title.Trim();
            if (order.HasValue) def.Order = order.Value;
            dirty = true;
            SaveLocked();
            copy = def.Clone();
        }
        evalNow = true;
        return copy;
    }

    /// <summary>
    /// Assigns Order = index to the listed ids (unknown and duplicate ids are ignored). Trackers not listed keep their
    /// relative order and follow the listed ones. Returns how many listed ids matched a tracker.
    /// </summary>
    public int Reorder(IReadOnlyList<string> ids)
    {
        int matched;
        lock (gate)
        {
            var byId = config.Trackers.GroupBy(t => t.Id).ToDictionary(g => g.Key, g => g.First());
            var listed = new List<TrackerDef>(ids.Count);
            var seen = new HashSet<string>();
            foreach (var id in ids)
                if (byId.TryGetValue(id, out var def) && seen.Add(id)) listed.Add(def);
            matched = listed.Count;
            if (matched == 0) return 0;

            var rest = config.Trackers.Where(t => !seen.Contains(t.Id)).OrderBy(t => t.Order).ThenBy(t => t.Created).ToList();
            var order = 0;
            foreach (var t in listed) t.Order = order++;
            foreach (var t in rest) t.Order = order++;
            dirty = true;
            SaveLocked();
        }
        evalNow = true;
        return matched;
    }

    public bool Remove(string id)
    {
        lock (gate)
        {
            var removed = config.Trackers.RemoveAll(t => t.Id == id) > 0;
            if (removed) { dirty = true; SaveLocked(); }
            if (removed) evalNow = true;
            return removed;
        }
    }

    /// <summary>Queues an achievement progress re-request for the tracker. False if unknown or not an achievement.</summary>
    public bool RequestRefresh(string id)
    {
        lock (gate)
        {
            var def = config.Trackers.FirstOrDefault(t => t.Id == id);
            if (def == null || def.Kind != TrackerKinds.Achievement) return false;
            forced.Add(def.TargetId);
            retryAt.Remove(def.TargetId);
        }
        evalNow = true;
        return true;
    }

    private static int? NormalizeCount(int? count) => count is > 0 ? count : null;

    private void SaveLocked()
    {
        if (!dirty) return;
        try { pi.SavePluginConfig(config); dirty = false; lastSave = Stopwatch.GetTimestamp(); }
        catch (Exception ex) { log.Warning(ex, "SecondScreen: saving tracker config failed"); }
    }

    // ---- framework thread ------------------------------------------------------------------------------------

    private static long NowMs() => Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency;
    private static long WallMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private void OnUpdate(IFramework _)
    {
        try
        {
            var now = NowMs();
            if (now - lastPump >= PumpIntervalMs)
            {
                lastPump = now;
                PumpAchievements(now);
            }
            if (evalNow || now - lastEval >= EvalIntervalMs)
            {
                evalNow = false;
                lastEval = now;
                progress = Evaluate();
            }
            FlushIfDue();
            errorLogged = false;
        }
        catch (Exception ex)
        {
            if (!errorLogged)
            {
                log.Error(ex, "SecondScreen tracker update failed");
                errorLogged = true;
            }
        }
    }

    private void FlushIfDue()
    {
        lock (gate)
        {
            if (!dirty) return;
            var sinceSaveMs = (Stopwatch.GetTimestamp() - lastSave) * 1000 / Stopwatch.Frequency;
            if (sinceSaveMs >= SaveDebounceMs) SaveLocked();
        }
    }

    /// <summary>
    /// One achievement progress request at a time. The game exposes a single result slot
    /// (ProgressRequestState / ProgressAchievementId / ProgressCurrent / ProgressMax), so we request one id,
    /// poll the slot every pump until it is Loaded for that id (or time out), then move on to the next due one.
    /// </summary>
    private void PumpAchievements(long now)
    {
        if (!clientState.IsLoggedIn) { active = null; return; }
        var ach = Achievement.Instance();
        if (ach == null) return;

        // The completion bitmap (IsComplete) is only valid once the game has loaded it from the server.
        if (!ach->IsLoaded() && ach->State != Achievement.AchievementState.Requested
            && now - lastCompletedRequest >= CompletedRequestIntervalMs && HasAchievementTrackers())
        {
            lastCompletedRequest = now;
            ach->RequestCompletedAchievements();
        }

        if (active is { } a)
        {
            var state = ach->ProgressRequestState;
            if (state == Achievement.AchievementState.Requested) a.SawRequested = true;
            if (state == Achievement.AchievementState.Loaded && ach->ProgressAchievementId == a.AchievementId
                && (a.SawRequested || now - a.StartedMs > 1500))
            {
                StoreProgress(a.AchievementId, ach->ProgressCurrent, ach->ProgressMax);
                active = null;
                evalNow = true;
            }
            else if (now - a.StartedMs > RequestTimeoutMs)
            {
                log.Debug("SecondScreen: achievement {Id} progress request timed out", a.AchievementId);
                lock (gate) retryAt[a.AchievementId] = now + RetryBackoffMs;
                active = null;
            }
            return;
        }

        // Do not stomp a request the game's own achievement window has in flight.
        if (ach->ProgressRequestState == Achievement.AchievementState.Requested) return;

        var next = PickDueAchievement(now);
        if (next == 0) return;
        ach->RequestAchievementProgress(next);
        active = new ActiveRequest
        {
            AchievementId = next,
            StartedMs = now,
            SawRequested = ach->ProgressRequestState == Achievement.AchievementState.Requested,
        };
    }

    private bool HasAchievementTrackers()
    {
        lock (gate) return config.Trackers.Any(t => t.Kind == TrackerKinds.Achievement);
    }

    private uint PickDueAchievement(long now)
    {
        var wall = WallMs();
        lock (gate)
        {
            foreach (var id in forced)
            {
                forced.Remove(id);
                return id;
            }
            uint best = 0;
            var bestUpdated = long.MaxValue;
            foreach (var t in config.Trackers)
            {
                if (t.Kind != TrackerKinds.Achievement) continue;
                if (wall - t.LastUpdatedMs < AchievementRefreshMs) continue;
                if (retryAt.TryGetValue(t.TargetId, out var until) && now < until) continue;
                if (t.LastUpdatedMs < bestUpdated) { bestUpdated = t.LastUpdatedMs; best = t.TargetId; }
            }
            return best;
        }
    }

    private void StoreProgress(uint achievementId, uint current, uint max)
    {
        var wall = WallMs();
        lock (gate)
        {
            foreach (var t in config.Trackers)
            {
                if (t.Kind != TrackerKinds.Achievement || t.TargetId != achievementId) continue;
                t.LastCurrent = current;
                t.LastMax = max;
                t.LastUpdatedMs = wall;
                dirty = true;
            }
            retryAt.Remove(achievementId);
        }
    }

    private IReadOnlyList<TrackerProgress> Evaluate()
    {
        TrackerDef[] defs;
        lock (gate)
            defs = config.Trackers.OrderBy(t => t.Order).ThenBy(t => t.Created).Select(t => t.Clone()).ToArray();
        if (defs.Length == 0) return Array.Empty<TrackerProgress>();

        var loggedIn = clientState.IsLoggedIn;
        Dictionary<uint, (long Nq, long Hq)>? counts = null;
        var saddlebag = false;
        if (loggedIn && defs.Any(d => d.Kind == TrackerKinds.Item))
            counts = CountItems(defs.Where(d => d.Kind == TrackerKinds.Item).Select(d => d.TargetId).ToHashSet(), out saddlebag);

        var ach = loggedIn ? Achievement.Instance() : null;
        var achLoaded = ach != null && ach->IsLoaded();
        var activeId = active?.AchievementId;

        var wantMsq = defs.Any(d => d.Kind == TrackerKinds.Msq);
        var wantQuest = defs.Any(d => d.Kind == TrackerKinds.Quest);
        MsqModel.Data? msqData = null;
        var questDataReady = false;
        if (wantMsq || wantQuest) // also kicks off the one-time background model build
            questDataReady = quests.TryGetReady(out msqData);
        if (loggedIn && (wantMsq || wantQuest)) RefreshQuestCompletion(defs, wantMsq && questDataReady ? msqData : null);

        var list = new List<TrackerProgress>(defs.Length);
        foreach (var d in defs)
        {
            switch (d.Kind)
            {
                case TrackerKinds.Item:
                    list.Add(EvaluateItem(d, loggedIn ? counts : null, saddlebag));
                    break;
                case TrackerKinds.Achievement:
                    list.Add(EvaluateAchievement(d, loggedIn, ach, achLoaded, activeId));
                    break;
                case TrackerKinds.Msq:
                    list.Add(EvaluateMsq(d, loggedIn, questDataReady ? msqData : null));
                    break;
                case TrackerKinds.Quest:
                    list.Add(EvaluateQuest(d, loggedIn, questDataReady));
                    break;
                // Future kinds ("goal") plug in here; unknown kinds are shown but never evaluated.
                default:
                    list.Add(Base(d, null, null, false, "Unsupported tracker kind", null, false, false));
                    break;
            }
        }
        return list;
    }

    private static TrackerProgress Base(TrackerDef d, long? current, long? max, bool complete, string detail, long? updated, bool pending, bool live,
        MsqProgressInfo? msq = null, QuestInfo? quest = null)
        => new(d.Id, d.Kind, d.TargetId, d.TargetCount, d.IncludeHq, d.Title, d.Order, d.Created, d.IconId,
            current, max, complete, detail, updated, pending, live, msq, quest);

    // ---- quests (framework thread) ---------------------------------------------------------------------------

    /// <summary>
    /// Refreshes <see cref="completedQuests"/> for the quests the current trackers need (all MSQ quests when an MSQ
    /// tracker exists and the model is ready, plus each single-quest tracker). QuestManager.IsQuestComplete takes the
    /// quest id without the 0x10000 sheet offset (a ushort); the uint overload masks with 0xFFFF, so the Quest sheet
    /// row id is passed through <see cref="QuestKey"/>.
    /// </summary>
    private void RefreshQuestCompletion(TrackerDef[] defs, MsqModel.Data? msq)
    {
        var cid = playerState.IsLoaded ? playerState.ContentId : 0;
        if (cid != questCharacter)
        {
            questCharacter = cid;
            completedQuests.Clear();
            checkedQuests.Clear();
            lastQuestRefresh = long.MinValue / 2;
            questInfoCache.Clear();
            questVersion++;
        }

        var wanted = new List<uint>();
        if (msq != null && defs.Any(d => d.Kind == TrackerKinds.Msq))
            foreach (var q in msq.Ordered) wanted.Add(q.Id);
        foreach (var d in defs)
            if (d.Kind == TrackerKinds.Quest && d.TargetId != 0) wanted.Add(d.TargetId);

        var now = NowMs();
        var stale = now - lastQuestRefresh >= QuestRefreshMs;
        if (!stale && !wanted.Any(id => !checkedQuests.Contains(id))) return; // nothing new to ask, nothing due
        lastQuestRefresh = now;

        var changed = false;
        foreach (var id in wanted)
        {
            if (completedQuests.Contains(id)) continue; // completion never reverts
            checkedQuests.Add(id);
            if (QuestManager.IsQuestComplete(QuestKey(id))) { completedQuests.Add(id); changed = true; }
        }
        if (changed) questVersion++;
    }

    /// <summary>Quest sheet row id (65536 + n) -> the ushort the game API wants (n).</summary>
    private static ushort QuestKey(uint rowId) => (ushort)(rowId - 0x10000);

    private TrackerProgress EvaluateMsq(TrackerDef d, bool loggedIn, MsqModel.Data? data)
    {
        if (!loggedIn || data == null)
        {
            var known = d.LastMax is > 0;
            var detail = !loggedIn
                ? (known ? "Not logged in; showing last known progress" : "Not logged in")
                : "Loading quest data...";
            return Base(d, known ? d.LastCurrent : null, known ? d.LastMax : null, d.LastComplete, detail, null, false, false);
        }

        if (msqSnapshot == null || msqSnapshotVersion != questVersion)
        {
            msqSnapshot = data.Evaluate(completedQuests.Contains, DescribeQuest);
            msqSnapshotVersion = questVersion;
        }
        var snap = msqSnapshot;
        var complete = snap.Total > 0 && snap.Done >= snap.Total;
        if (d.LastCurrent != snap.Done || d.LastMax != snap.Total || d.LastComplete != complete)
        {
            lock (gate)
            {
                foreach (var t in config.Trackers)
                {
                    if (t.Kind != TrackerKinds.Msq) continue;
                    t.LastCurrent = snap.Done;
                    t.LastMax = snap.Total;
                    t.LastComplete = complete;
                    t.LastUpdatedMs = WallMs();
                }
                dirty = true;
            }
        }
        return Base(d, snap.Done, snap.Total, complete,
            "Main Scenario quests for your character; mutually exclusive starting city / Grand Company chains are counted once. Checked every 10 seconds",
            null, false, true, snap.Detail);
    }

    private TrackerProgress EvaluateQuest(TrackerDef d, bool loggedIn, bool dataReady)
    {
        var info = dataReady ? DescribeQuest(d.TargetId) : null;
        var complete = loggedIn ? completedQuests.Contains(d.TargetId) : d.LastComplete;
        if (loggedIn && complete != d.LastComplete)
        {
            lock (gate)
            {
                foreach (var t in config.Trackers)
                    if (t.Kind == TrackerKinds.Quest && t.TargetId == d.TargetId) t.LastComplete = complete;
                dirty = true;
            }
        }
        string detail;
        if (info != null) detail = $"{info.Name} \u00B7 Lv {info.Level}" + (info.Expansion.Length > 0 ? $" \u00B7 {info.Expansion}" : "");
        else detail = dataReady ? d.Title : "Loading quest data...";
        if (!loggedIn) detail += " (not logged in; showing last known state)";
        return Base(d, complete ? 1 : 0, 1, complete, detail, null, false, loggedIn, null, info);
    }

    private QuestInfo? DescribeQuest(uint questId)
    {
        if (!questInfoCache.TryGetValue(questId, out var info))
            questInfoCache[questId] = info = quests.Describe(questId);
        return info;
    }

    private static TrackerProgress EvaluateItem(TrackerDef d, Dictionary<uint, (long Nq, long Hq)>? counts, bool saddlebag)
    {
        if (counts == null) return Base(d, null, d.TargetCount, false, "Not logged in", null, false, false);
        counts.TryGetValue(d.TargetId, out var c);
        var total = d.IncludeHq ? c.Nq + c.Hq : c.Nq;
        var complete = d.TargetCount.HasValue && total >= d.TargetCount.Value;
        var detail = "Bags, armoury, equipped, crystals, currency" + (saddlebag ? ", saddlebag" : "") + "; retainers not counted";
        return Base(d, total, d.TargetCount, complete, detail, null, false, true);
    }

    private TrackerProgress EvaluateAchievement(TrackerDef d, bool loggedIn, Achievement* ach, bool achLoaded, uint? activeId)
    {
        var complete = d.LastComplete;
        if (ach != null && achLoaded)
        {
            complete = ach->IsComplete((int)d.TargetId);
            if (complete != d.LastComplete)
            {
                lock (gate)
                {
                    foreach (var t in config.Trackers)
                        if (t.Kind == TrackerKinds.Achievement && t.TargetId == d.TargetId) t.LastComplete = complete;
                    dirty = true;
                }
            }
        }

        long? current = d.LastCurrent, max = d.LastMax;
        if (max is 0) max = null; // the game reports 0 for achievements without a counter
        if (complete && max.HasValue) current = max;

        bool pending;
        lock (gate) pending = loggedIn && (activeId == d.TargetId || forced.Contains(d.TargetId));
        string detail;
        if (!loggedIn) detail = d.LastUpdatedMs > 0 ? "Not logged in; showing last known progress" : "Not logged in";
        else if (!achLoaded) detail = "Waiting for achievement data from the server";
        else if (d.LastUpdatedMs == 0) detail = "Waiting for progress from the server";
        else if (!max.HasValue && !complete) detail = "This achievement has no progress counter";
        else detail = "Progress is fetched from the server every 5 minutes";

        return Base(d, current, max, complete, detail, d.LastUpdatedMs > 0 ? d.LastUpdatedMs : null, pending, loggedIn && achLoaded);
    }

    /// <summary>Sums wanted item ids over every loaded container in <see cref="InventoryContainers.Player"/> (+ saddlebags if loaded).</summary>
    private static Dictionary<uint, (long Nq, long Hq)> CountItems(HashSet<uint> wanted, out bool saddlebagLoaded)
    {
        var result = new Dictionary<uint, (long Nq, long Hq)>();
        saddlebagLoaded = false;
        var inv = InventoryManager.Instance();
        if (inv == null) return result;

        foreach (var d in InventoryContainers.Player) Scan(inv, d.Type, wanted, result);
        foreach (var d in InventoryContainers.Saddlebag)
            if (Scan(inv, d.Type, wanted, result)) saddlebagLoaded = true;
        return result;
    }

    private static bool Scan(InventoryManager* inv, InventoryType type, HashSet<uint> wanted, Dictionary<uint, (long Nq, long Hq)> result)
    {
        var container = InventoryContainers.GetLoaded(inv, type);
        if (container == null) return false;
        for (var i = 0; i < container->Size; i++)
        {
            var item = container->Items + i;
            var id = item->ItemId;
            if (id == 0 || !wanted.Contains(id)) continue;
            result.TryGetValue(id, out var c);
            if (item->IsHighQuality()) c.Hq += item->Quantity; else c.Nq += item->Quantity;
            result[id] = c;
        }
        return true;
    }
}
