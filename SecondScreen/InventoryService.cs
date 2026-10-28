using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;
using FFXIVClientStructs.FFXIV.Client.Game;

namespace SecondScreen;

// ---- DTOs: published to the web (camelCase JSON) and persisted to inventory-cache.json -----------------------------------------

/// <summary>One occupied slot. Spiritbond / Condition are whole percents; Container is only set for retainer items.</summary>
public sealed class InvItem
{
    public uint ItemId { get; set; }
    public int Qty { get; set; }
    public bool Hq { get; set; }
    public int Slot { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? Spiritbond { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? Collectability { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? Condition { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Container { get; set; }
}

public sealed class InvContainer
{
    public string Id { get; set; } = "";
    public string Group { get; set; } = "";
    public string Label { get; set; } = "";
    public int Size { get; set; }
    public int Free { get; set; }
    /// <summary>False for a cached copy (saddlebag while its window is closed).</summary>
    public bool Loaded { get; set; } = true;
    /// <summary>Unix ms when a cached copy was captured; null for live data.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public long? CachedAt { get; set; }
    public List<InvItem> Items { get; set; } = new();

    public InvContainer View(bool loaded, long? cachedAt) => new()
    {
        Id = Id, Group = Group, Label = Label, Size = Size, Free = Free, Loaded = loaded, CachedAt = cachedAt, Items = Items,
    };
}

public sealed class RetainerVenture
{
    public uint TaskId { get; set; }
    public string Name { get; set; } = "";
    /// <summary>Unix SECONDS when the venture finishes (past = done, waiting to be collected).</summary>
    public long CompleteAt { get; set; }
}

public sealed class RetainerEntry
{
    /// <summary>RetainerId as a string (it exceeds the 2^53 JSON-number range).</summary>
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public int Order { get; set; }
    public string ClassJob { get; set; } = "";
    public int Level { get; set; }
    public long Gil { get; set; }
    public int ItemCount { get; set; }
    public int MarketItemCount { get; set; }
    public RetainerVenture? Venture { get; set; }
    /// <summary>Unix ms the retainer list data (gil / venture) was last seen live (refreshed every few minutes).</summary>
    public long LastSeen { get; set; }
    /// <summary>Unix ms the item contents were last captured while the retainer was open; 0 = never.</summary>
    public long ItemsSeen { get; set; }
    public List<InvItem> Items { get; set; } = new();

    public RetainerEntry Clone() => (RetainerEntry)MemberwiseClone();
}

public sealed class CharacterCache
{
    public string Name { get; set; } = "";
    public Dictionary<string, InvContainer> Saddlebags { get; set; } = new();
    public Dictionary<string, RetainerEntry> Retainers { get; set; } = new();
}

public sealed class InventoryCacheFile
{
    public int Version { get; set; } = 1;
    /// <summary>Keyed by character content id.</summary>
    public Dictionary<string, CharacterCache> Characters { get; set; } = new();
}

public sealed record CharacterRef(string Id, string Name);
public sealed record SlotCount(int Free, int Total);
public sealed record SaddlebagSummary(int Free, int Total, bool Loaded, long? CachedAt);

/// <summary>Immutable (by convention) inventory view published by the framework thread.</summary>
public sealed class InventoryModel
{
    public int Version { get; init; }
    public long GeneratedAt { get; init; }
    public bool LoggedIn { get; init; }
    public CharacterRef? Character { get; init; }
    public long Gil { get; init; }
    public long RetainerGil { get; init; }
    public SlotCount Bags { get; init; } = new(0, 0);
    public SaddlebagSummary? Saddlebag { get; init; }
    public List<InvContainer> Containers { get; init; } = new();
    public List<RetainerEntry> Retainers { get; init; } = new();
}

/// <summary>
/// Builds the inventory model on the framework thread (~1 Hz, rebuilt only when a cheap hash over the loaded containers changes)
/// and keeps two kinds of cache, per character content id, in inventory-cache.json in the plugin config directory
/// (NOT the main config): the last-seen saddlebag, and each retainer (list data from RetainerManager plus the item contents
/// captured while that retainer was open). Web threads only read the published model / its cached JSON.
/// </summary>
internal sealed unsafe class InventoryService : IDisposable
{
    private static readonly long IntervalTicks = Stopwatch.Frequency; // 1 Hz
    private const long MetaRefreshMs = 5 * 60 * 1000;
    private const long SaveDebounceMs = 5000;
    private const ulong FnvOffset = 14695981039346656037UL;
    private const ulong FnvPrime = 1099511628211UL;

    private readonly IFramework framework;
    private readonly IClientState clientState;
    private readonly IPlayerState playerState;
    private readonly IPluginLog log;
    private readonly ItemInfoStore info;
    private readonly string cachePath;
    private readonly object jsonGate = new();

    private volatile InventoryModel model = new() { Version = 0 };
    private int version;
    private string? json;
    private int jsonVersion = -1;

    // Framework thread only:
    private InventoryCacheFile file = new();
    private CharacterCache? cache;
    private ulong character;
    private ulong lastHash;
    private bool force = true;
    private long lastTick;
    private bool cacheDirty;
    private long dirtySinceMs;
    private bool errorLogged;
    private ulong lastRetHash;
    private readonly Dictionary<string, ulong> committedRetainers = new();   // retainer id -> content hash already stored
    private readonly Dictionary<string, ulong> saddleHashes = new();         // container id -> hash of the cached copy

    public InventoryService(IFramework framework, IClientState clientState, IPlayerState playerState, IDalamudPluginInterface pi,
        ItemInfoStore info, IPluginLog log)
    {
        this.framework = framework;
        this.clientState = clientState;
        this.playerState = playerState;
        this.info = info;
        this.log = log;
        // Seed from the clock so a plugin reload never reuses a version a browser already saw.
        version = (int)(DateTimeOffset.UtcNow.ToUnixTimeSeconds() % 1_000_000_000L);
        cachePath = Path.Combine(pi.GetPluginConfigDirectory(), "inventory-cache.json");
        LoadFile();
        this.framework.Update += OnUpdate;
    }

    /// <summary>Changes whenever the published inventory changes (sent as inventoryVersion in the WebSocket payload).</summary>
    public int Version => model.Version;

    public void Dispose()
    {
        framework.Update -= OnUpdate;
        if (cacheDirty) WriteFile(Serialize(), true);
    }

    // ---- web side -----------------------------------------------------------------------------------------------------------

    /// <summary>The full /api/inventory body for the current version (built lazily on the calling thread, then cached).</summary>
    public string GetJson()
    {
        var m = model;
        lock (jsonGate)
        {
            if (json != null && jsonVersion == m.Version) return json;
            var ids = new HashSet<uint>();
            foreach (var c in m.Containers) foreach (var i in c.Items) ids.Add(i.ItemId);
            foreach (var r in m.Retainers) foreach (var i in r.Items) ids.Add(i.ItemId);
            var items = new Dictionary<string, ItemInfo>(ids.Count);
            foreach (var id in ids)
            {
                var item = info.GetItem(id);
                if (item != null) items[id.ToString(CultureInfo.InvariantCulture)] = item;
            }
            json = Json.Serialize(new
            {
                m.Version, m.GeneratedAt, m.LoggedIn, m.Character, m.Gil, m.RetainerGil, m.Bags, m.Saddlebag,
                m.Containers, m.Retainers, Items = items,
            });
            jsonVersion = m.Version;
            return json;
        }
    }

    // ---- framework thread ---------------------------------------------------------------------------------------------------

    private void OnUpdate(IFramework _)
    {
        var now = Stopwatch.GetTimestamp();
        if (now - lastTick < IntervalTicks) return;
        lastTick = now;
        try
        {
            Tick();
            errorLogged = false;
        }
        catch (Exception ex)
        {
            if (!errorLogged) { log.Error(ex, "SecondScreen inventory collection failed"); errorLogged = true; }
        }
        try { MaybeSave(); } catch (Exception ex) { log.Warning(ex, "SecondScreen inventory cache save failed"); }
    }

    private void Tick()
    {
        var cid = clientState.IsLoggedIn && playerState.IsLoaded ? playerState.ContentId : 0UL;
        var inv = InventoryManager.Instance();
        if (cid == 0 || inv == null)
        {
            if (character != 0 || model.Version == 0)
            {
                character = 0; cache = null; lastHash = 0; force = true;
                Publish(new InventoryModel { Version = ++version, GeneratedAt = NowMs(), LoggedIn = false });
            }
            return;
        }
        if (cid != character) SwitchCharacter(cid);
        var c = cache!;
        var nowMs = NowMs();
        var rm = RetainerManager.Instance();

        if (CaptureRetainer(inv, rm, nowMs)) force = true;
        if (RefreshRetainerList(rm, nowMs)) force = true;
        if (CaptureSaddlebags(inv, nowMs)) force = true;

        var gil = inv->GetGil();
        var h = Mix(FnvOffset, cid);
        h = Mix(h, gil);
        foreach (var d in InventoryContainers.Player)
        {
            var cont = InventoryContainers.GetLoaded(inv, d.Type);
            h = Mix(h, cont == null ? (ulong)d.Type : HashContainer(cont) ^ (ulong)d.Type);
        }
        if (!force && h == lastHash) return;
        lastHash = h;
        force = false;

        Publish(BuildModel(inv, c, cid, gil, nowMs));
    }

    private void SwitchCharacter(ulong cid)
    {
        if (cacheDirty) WriteFile(Serialize());
        character = cid;
        var key = cid.ToString(CultureInfo.InvariantCulture);
        if (!file.Characters.TryGetValue(key, out var c)) file.Characters[key] = c = new CharacterCache();
        c.Saddlebags ??= new();
        c.Retainers ??= new();
        cache = c;
        committedRetainers.Clear();
        saddleHashes.Clear();
        lastRetHash = 0;
        lastHash = 0;
        force = true;
    }

    private InventoryModel BuildModel(InventoryManager* inv, CharacterCache c, ulong cid, uint gil, long nowMs)
    {
        var containers = new List<InvContainer>();
        int bagFree = 0, bagTotal = 0;
        foreach (var d in InventoryContainers.Player)
        {
            var cont = InventoryContainers.GetLoaded(inv, d.Type);
            if (cont == null) continue;
            var ic = BuildContainer(cont, d, null);
            containers.Add(ic);
            if (d.Group == InventoryContainers.GroupBags) { bagFree += ic.Free; bagTotal += ic.Size; }
        }

        int sFree = 0, sTotal = 0;
        var sAny = false;
        var sLoaded = true;
        long? sCached = null;
        foreach (var d in InventoryContainers.Saddlebag)
        {
            if (!c.Saddlebags.TryGetValue(d.Id, out var sc) || sc.Size <= 0) continue;
            var live = InventoryContainers.GetLoaded(inv, d.Type) != null;
            containers.Add(sc.View(live, live ? null : sc.CachedAt));
            sAny = true;
            sFree += sc.Free; sTotal += sc.Size;
            if (!live)
            {
                sLoaded = false;
                if (sc.CachedAt is { } at && (sCached == null || at < sCached)) sCached = at;
            }
        }

        var retainers = c.Retainers.Values.OrderBy(r => r.Order).ThenBy(r => r.Name, StringComparer.OrdinalIgnoreCase).Select(r => r.Clone()).ToList();
        return new InventoryModel
        {
            Version = ++version,
            GeneratedAt = nowMs,
            LoggedIn = true,
            Character = new CharacterRef(cid.ToString(CultureInfo.InvariantCulture), playerState.CharacterName ?? ""),
            Gil = gil,
            RetainerGil = retainers.Sum(r => r.Gil),
            Bags = new SlotCount(bagFree, bagTotal),
            Saddlebag = sAny ? new SaddlebagSummary(sFree, sTotal, sLoaded, sCached) : null,
            Containers = containers,
            Retainers = retainers,
        };
    }

    private void Publish(InventoryModel m)
    {
        model = m;
        if (m.LoggedIn && cache != null && string.IsNullOrEmpty(cache.Name) && m.Character != null && m.Character.Name.Length > 0)
        {
            cache.Name = m.Character.Name;
            MarkDirty();
        }
    }

    // ---- reading game memory --------------------------------------------------------------------------------------------------

    private static InvContainer BuildContainer(InventoryContainer* cont, InventoryContainers.Def d, string? tag)
    {
        var size = cont->Size;
        var items = new List<InvItem>(Math.Max(0, size));
        for (var i = 0; i < size; i++)
        {
            var item = cont->Items + i;
            if (item->ItemId == 0) continue;
            items.Add(ReadItem(item, i, tag));
        }
        return new InvContainer { Id = d.Id, Group = d.Group, Label = d.Label, Size = size, Free = size - items.Count, Loaded = true, Items = items };
    }

    private static InvItem ReadItem(InventoryItem* item, int slot, string? tag)
    {
        var collectable = (item->Flags & InventoryItem.ItemFlags.Collectable) != 0;
        var sb = item->SpiritbondOrCollectability;
        var o = new InvItem
        {
            ItemId = item->ItemId,
            Qty = item->Quantity,
            Hq = item->IsHighQuality(),
            Slot = slot,
            Container = tag,
        };
        if (collectable) o.Collectability = sb;
        else if (sb >= 100) o.Spiritbond = sb / 100;
        if (item->Condition > 0) o.Condition = item->Condition / 300; // 30000 = 100%
        return o;
    }

    private static ulong Mix(ulong h, ulong v)
    {
        h ^= v;
        return h * FnvPrime;
    }

    /// <summary>Hash over (slot, itemId, qty, hq, spiritbond %, condition %) so spiritbond ticking inside one percent does not rebuild.</summary>
    private static ulong HashContainer(InventoryContainer* cont)
    {
        var h = Mix(FnvOffset, (ulong)cont->Size);
        for (var i = 0; i < cont->Size; i++)
        {
            var item = cont->Items + i;
            if (item->ItemId == 0) continue;
            var sb = (ulong)(item->SpiritbondOrCollectability / 100);
            var cond = (ulong)(item->Condition / 300);
            h = Mix(h, (uint)i | ((ulong)item->ItemId << 32));
            h = Mix(h, (uint)item->Quantity | ((item->IsHighQuality() ? 1UL : 0UL) << 32) | (sb << 33) | (cond << 48));
        }
        return h;
    }

    /// <summary>Stores the saddlebag containers whenever they are loaded and differ from the cached copy. True if the cache changed.</summary>
    private bool CaptureSaddlebags(InventoryManager* inv, long nowMs)
    {
        var changed = false;
        foreach (var d in InventoryContainers.Saddlebag)
        {
            var cont = InventoryContainers.GetLoaded(inv, d.Type);
            if (cont == null || cont->Size <= 0) continue;
            var h = HashContainer(cont);
            if (saddleHashes.TryGetValue(d.Id, out var old) && old == h) continue;
            saddleHashes[d.Id] = h;
            var ic = BuildContainer(cont, d, null);
            ic.Loaded = false; // the stored copy is by definition not live
            ic.CachedAt = nowMs;
            cache!.Saddlebags[d.Id] = ic;
            changed = true;
        }
        if (changed) MarkDirty();
        return changed;
    }

    /// <summary>
    /// Copies the active retainer's item containers into the cache. They are only populated while that retainer is open, so the
    /// same content hash must be seen on two consecutive ticks (guards against reading the previous retainer's stale pages),
    /// and non-empty content already stored for a different retainer is treated as stale and skipped.
    /// </summary>
    private bool CaptureRetainer(InventoryManager* inv, RetainerManager* rm, long nowMs)
    {
        var active = rm != null ? rm->GetActiveRetainer() : null;
        if (active == null || active->RetainerId == 0 || InventoryContainers.GetLoaded(inv, InventoryType.RetainerPage1) == null)
        {
            lastRetHash = 0;
            return false;
        }

        var content = FnvOffset;
        var stacks = 0;
        foreach (var d in InventoryContainers.Retainer)
        {
            var cont = InventoryContainers.GetLoaded(inv, d.Type);
            if (cont == null) continue;
            content = Mix(content, HashContainer(cont) ^ (ulong)d.Type);
            for (var i = 0; i < cont->Size; i++) if (cont->Items[i].ItemId != 0) stacks++;
        }
        var id = active->RetainerId.ToString(CultureInfo.InvariantCulture);
        var h = Mix(content, active->RetainerId);
        if (h != lastRetHash) { lastRetHash = h; return false; }
        if (committedRetainers.TryGetValue(id, out var done) && done == content) return false;
        if (stacks > 0 && committedRetainers.Any(kv => kv.Key != id && kv.Value == content)) return false; // stale pages of another retainer

        var items = new List<InvItem>(stacks);
        var ordinal = 0;
        foreach (var d in InventoryContainers.Retainer)
        {
            var cont = InventoryContainers.GetLoaded(inv, d.Type);
            ordinal++;
            if (cont == null) continue;
            for (var i = 0; i < cont->Size; i++)
            {
                var item = cont->Items + i;
                if (item->ItemId == 0) continue;
                items.Add(ReadItem(item, ordinal * 100 + i, d.Label));
            }
        }

        committedRetainers[id] = content;
        var e = GetOrAddRetainer(id);
        var name = active->NameString;
        if (!string.IsNullOrEmpty(name)) e.Name = name;
        e.Items = items;
        e.ItemsSeen = nowMs;
        MarkDirty();
        return true;
    }

    private RetainerEntry GetOrAddRetainer(string id)
    {
        if (!cache!.Retainers.TryGetValue(id, out var e)) cache.Retainers[id] = e = new RetainerEntry { Id = id, Order = int.MaxValue };
        return e;
    }

    /// <summary>Updates name / job / level / gil / venture for every retainer RetainerManager currently knows. True if anything changed.</summary>
    private bool RefreshRetainerList(RetainerManager* rm, long nowMs)
    {
        if (rm == null || !rm->IsReady) return false;
        var count = (int)rm->GetRetainerCount();
        if (count == 0) return false;

        var changed = false;
        var live = new HashSet<string>();
        for (var i = 0; i < count; i++)
        {
            var r = rm->GetRetainerBySortedIndex((uint)i);
            if (r == null || r->RetainerId == 0) continue;
            var name = r->NameString;
            if (string.IsNullOrEmpty(name)) continue;
            var id = r->RetainerId.ToString(CultureInfo.InvariantCulture);
            live.Add(id);
            var isNew = !cache!.Retainers.ContainsKey(id);
            var e = GetOrAddRetainer(id);

            RetainerVenture? venture = null;
            if (r->VentureId != 0)
                venture = new RetainerVenture { TaskId = r->VentureId, Name = info.RetainerTaskName(r->VentureId), CompleteAt = r->VentureComplete };
            var job = info.ClassJobAbbreviation(r->ClassJob);

            if (isNew || e.Name != name || e.Order != i || e.ClassJob != job || e.Level != r->Level || e.Gil != r->Gil
                || e.ItemCount != r->ItemCount || e.MarketItemCount != r->MarketItemCount
                || e.Venture?.TaskId != venture?.TaskId || e.Venture?.CompleteAt != venture?.CompleteAt
                || nowMs - e.LastSeen >= MetaRefreshMs)
            {
                e.Name = name; e.Order = i; e.ClassJob = job; e.Level = r->Level; e.Gil = r->Gil;
                e.ItemCount = r->ItemCount; e.MarketItemCount = r->MarketItemCount;
                e.Venture = venture;
                e.LastSeen = nowMs;
                changed = true;
            }
        }

        // Only prune (dismissed / sold retainers) when every slot resolved, so a partial read never wipes the cache.
        if (live.Count == count)
        {
            foreach (var id in cache!.Retainers.Keys.Where(k => !live.Contains(k)).ToList())
            {
                cache.Retainers.Remove(id);
                committedRetainers.Remove(id);
                changed = true;
            }
        }
        if (changed) MarkDirty();
        return changed;
    }

    // ---- persistence ---------------------------------------------------------------------------------------------------------

    private static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private void MarkDirty()
    {
        if (!cacheDirty) dirtySinceMs = Environment.TickCount64;
        cacheDirty = true;
    }

    private void MaybeSave()
    {
        if (!cacheDirty || Environment.TickCount64 - dirtySinceMs < SaveDebounceMs) return;
        WriteFile(Serialize());
    }

    private string Serialize() => Json.Serialize(file);

    private void WriteFile(string text, bool sync = false)
    {
        cacheDirty = false;
        var path = cachePath;
        // Serialized on the framework thread (consistent snapshot); the disk write happens off it (except on dispose).
        void Write()
        {
            try
            {
                var tmp = path + ".tmp";
                File.WriteAllText(tmp, text, Json.Utf8NoBom);
                File.Move(tmp, path, true);
            }
            catch (Exception ex)
            {
                log.Warning(ex, "SecondScreen could not write {Path}", path);
            }
        }
        if (sync) Write(); else Task.Run(Write);
    }

    private void LoadFile()
    {
        try
        {
            if (!File.Exists(cachePath)) return;
            var loaded = System.Text.Json.JsonSerializer.Deserialize<InventoryCacheFile>(File.ReadAllText(cachePath, Json.Utf8NoBom), Json.Options);
            if (loaded?.Characters != null) file = loaded;
        }
        catch (Exception ex)
        {
            log.Warning(ex, "SecondScreen could not read {Path}; starting with an empty inventory cache", cachePath);
            file = new InventoryCacheFile();
        }
    }
}
