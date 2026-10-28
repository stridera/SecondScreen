using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;
using FFXIVClientStructs.FFXIV.Client.Game;
using FFXIVClientStructs.FFXIV.Client.Game.UI;

namespace SecondScreen;

/// <summary>
/// Owns tracker definitions and their evaluation. Game memory is only touched on the framework thread:
/// inventory counts are re-evaluated at ~1 Hz and published as an immutable list through a volatile field;
/// achievement progress is fetched one request at a time (see <see cref="PumpAchievements"/>).
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

    // Everything an item tracker can be sitting in. Retainers and the armoire/glamour dresser are not covered.
    private static readonly InventoryType[] ItemContainers =
    {
        InventoryType.Inventory1, InventoryType.Inventory2, InventoryType.Inventory3, InventoryType.Inventory4,
        InventoryType.EquippedItems,
        InventoryType.ArmoryMainHand, InventoryType.ArmoryOffHand, InventoryType.ArmoryHead, InventoryType.ArmoryBody,
        InventoryType.ArmoryHands, InventoryType.ArmoryWaist, InventoryType.ArmoryLegs, InventoryType.ArmoryFeets,
        InventoryType.ArmoryEar, InventoryType.ArmoryNeck, InventoryType.ArmoryWrist, InventoryType.ArmoryRings,
        InventoryType.ArmorySoulCrystal,
        InventoryType.Crystals, InventoryType.Currency, InventoryType.KeyItems,
    };

    private static readonly InventoryType[] SaddlebagContainers =
    {
        InventoryType.SaddleBag1, InventoryType.SaddleBag2, InventoryType.PremiumSaddleBag1, InventoryType.PremiumSaddleBag2,
    };

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

    public TrackerService(IFramework framework, IClientState clientState, IDalamudPluginInterface pi, Configuration config, IPluginLog log)
    {
        this.framework = framework;
        this.clientState = clientState;
        this.pi = pi;
        this.config = config;
        this.log = log;
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
        if (!TrackerKinds.IsSupported(kind)) throw new ArgumentException("Unsupported tracker kind");
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
                // Future kinds ("goal", "quest") plug in here; unknown kinds are shown but never evaluated.
                default:
                    list.Add(Base(d, null, null, false, "Unsupported tracker kind", null, false, false));
                    break;
            }
        }
        return list;
    }

    private static TrackerProgress Base(TrackerDef d, long? current, long? max, bool complete, string detail, long? updated, bool pending, bool live)
        => new(d.Id, d.Kind, d.TargetId, d.TargetCount, d.IncludeHq, d.Title, d.Order, d.Created, d.IconId,
            current, max, complete, detail, updated, pending, live);

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

    /// <summary>Sums wanted item ids over every loaded container in <see cref="ItemContainers"/> (+ saddlebags if loaded).</summary>
    private static Dictionary<uint, (long Nq, long Hq)> CountItems(HashSet<uint> wanted, out bool saddlebagLoaded)
    {
        var result = new Dictionary<uint, (long Nq, long Hq)>();
        saddlebagLoaded = false;
        var inv = InventoryManager.Instance();
        if (inv == null) return result;

        foreach (var type in ItemContainers) Scan(inv, type, wanted, result);
        foreach (var type in SaddlebagContainers)
            if (Scan(inv, type, wanted, result)) saddlebagLoaded = true;
        return result;
    }

    private static bool Scan(InventoryManager* inv, InventoryType type, HashSet<uint> wanted, Dictionary<uint, (long Nq, long Hq)> result)
    {
        var container = inv->GetInventoryContainer(type);
        if (container == null || !container->IsLoaded || container->Items == null) return false;
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
