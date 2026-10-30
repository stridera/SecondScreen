using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using Dalamud.Plugin.Services;
using FFXIVClientStructs.FFXIV.Client.Game;
using FFXIVClientStructs.FFXIV.Client.Game.UI;

namespace SecondScreen;

/// <summary>
/// Builds the character sheet (job levels, equipped gear, item level, gil, tomestones and other currencies) on the framework thread
/// at ~1 Hz and publishes it as ready-made JSON. The version bumps only when the content changes (sent as characterVersion in the
/// WebSocket payload; the widget refetches GET /api/character when it moves). Web threads only read the published string.
///
/// Game memory used: PlayerState (ClassJobLevels / ClassJobExperience indexed by ClassJob.ExpArrayIndex, CurrentClassJobId,
/// GrandCompany, GetGrandCompanyRank), UIState.CurrentItemLevel, InventoryManager (EquippedItems container, GetGil,
/// GetWeeklyAcquiredTomestoneCount, GetLimitedTomestoneWeeklyLimit, GetTomestoneCount), CurrencyManager (HasItem / GetItemCount /
/// GetItemMaxCount for currencies that live outside the Currency container, e.g. scrips and Centurio Seals).
/// </summary>
internal sealed unsafe class CharacterService : IDisposable
{
    private static readonly long IntervalTicks = Stopwatch.Frequency; // 1 Hz

    /// <summary>EquippedItems slot indices (index 5, the retired belt, is skipped). The two rings are 11 and 12.</summary>
    private static readonly (string Key, string Label, int Index)[] Slots =
    {
        ("main", "Main Hand", 0), ("off", "Off Hand", 1), ("head", "Head", 2), ("body", "Body", 3), ("hands", "Hands", 4),
        ("legs", "Legs", 6), ("feet", "Feet", 7), ("ears", "Earrings", 8), ("neck", "Necklace", 9), ("wrists", "Bracelets", 10),
        ("ring1", "Ring", 11), ("ring2", "Ring", 12), ("soul", "Soul Crystal", 13),
    };

    private readonly IFramework framework;
    private readonly IClientState clientState;
    private readonly IPlayerState playerState;
    private readonly ItemInfoStore items;
    private readonly CharacterStatic stat;
    private readonly IPluginLog log;

    private volatile string json = "{\"version\":0,\"loggedIn\":false}";
    private int version;
    private string? lastBody;
    private long lastTick;
    private bool errorLogged;

    public CharacterService(IFramework framework, IClientState clientState, IPlayerState playerState, ItemInfoStore items,
        CharacterStatic stat, IPluginLog log)
    {
        this.framework = framework;
        this.clientState = clientState;
        this.playerState = playerState;
        this.items = items;
        this.stat = stat;
        this.log = log;
        // Seed from the clock so a plugin reload never reuses a version a browser already saw.
        version = (int)(DateTimeOffset.UtcNow.ToUnixTimeSeconds() % 1_000_000_000L);
        this.framework.Update += OnUpdate;
    }

    public int Version => Volatile.Read(ref version);

    /// <summary>The GET /api/character body (built on the framework thread).</summary>
    public string GetJson() => json;

    public void Dispose() => framework.Update -= OnUpdate;

    private void OnUpdate(IFramework _)
    {
        var now = Stopwatch.GetTimestamp();
        if (now - lastTick < IntervalTicks) return;
        lastTick = now;
        try
        {
            var body = Build();
            errorLogged = false;
            if (body == lastBody) return;
            lastBody = body;
            var v = Volatile.Read(ref version) + 1;
            json = "{\"version\":" + v + "," + body.Substring(1);
            Volatile.Write(ref version, v);
        }
        catch (Exception ex)
        {
            if (!errorLogged) { log.Error(ex, "SecondScreen character collection failed"); errorLogged = true; }
        }
    }

    private string Build()
    {
        var inv = InventoryManager.Instance();
        var ps = PlayerState.Instance();
        if (!clientState.IsLoggedIn || !playerState.IsLoaded || inv == null || ps == null)
            return Json.Serialize(new { loggedIn = false });

        var cm = CurrencyManager.Instance();
        var maxLevel = stat.MaxLevel;

        // ---- jobs -------------------------------------------------------------------------------------------------------------
        var levels = ps->ClassJobLevels;
        var exps = ps->ClassJobExperience;
        var jobs = new List<object>(stat.Jobs.Count);
        var currentLevel = 0;
        foreach (var j in stat.Jobs)
        {
            var level = j.ExpIndex < levels.Length ? levels[j.ExpIndex] : 0;
            if (level <= 0) continue; // not unlocked
            var exp = j.ExpIndex < exps.Length ? Math.Max(0, exps[j.ExpIndex]) : 0;
            var max = j.Limited ? 0 : maxLevel;
            var atMax = max > 0 && level >= max;
            var next = atMax || j.Limited ? 0 : stat.ExpToNext(level);
            if (j.Id == ps->CurrentClassJobId) currentLevel = level;
            jobs.Add(new { id = j.Id, abbr = j.Abbr, name = j.Name, group = j.Group, level, exp = atMax ? 0 : exp, expToNext = next, max, iconId = j.IconId });
        }

        // ---- gear -------------------------------------------------------------------------------------------------------------
        var gear = new List<object>(Slots.Length);
        var ilvls = new int[Slots.Length];
        var mainBlocksOff = false;
        var equipped = InventoryContainers.GetLoaded(inv, InventoryType.EquippedItems);
        for (var s = 0; s < Slots.Length; s++)
        {
            var (key, label, index) = Slots[s];
            InventoryItem* it = equipped != null && index < equipped->Size ? equipped->Items + index : null;
            if (it == null || it->ItemId == 0)
            {
                gear.Add(new { slot = key, label, itemId = 0u });
                continue;
            }
            var id = it->ItemId;
            var info = items.GetItem(id);
            ilvls[s] = info?.Ilvl ?? 0;
            if (key == "main") mainBlocksOff = stat.BlocksOffHand(info?.Id ?? id);

            var materia = new List<string>();
            var materiaCount = it->GetMateriaCount();
            for (byte m = 0; m < materiaCount && m < 5; m++)
            {
                var name = stat.MateriaName(it->GetMateriaId(m), it->GetMateriaGrade(m));
                materia.Add(name.Length > 0 ? name : "Materia");
            }
            var glamourId = it->GlamourId;
            var glamour = glamourId != 0 ? items.GetItem(glamourId) : null;
            var sb = it->SpiritbondOrCollectability;
            gear.Add(new
            {
                slot = key, label, itemId = id,
                name = info?.Name ?? $"Item #{id}", iconId = info?.IconId ?? 0u, ilvl = info?.Ilvl ?? 0,
                category = info?.Category ?? "", rarity = (int)(info?.Rarity ?? 1), hq = it->IsHighQuality(),
                condition = it->Condition > 0 ? it->Condition / 300 : (int?)null,   // 30000 = 100%
                spiritbond = sb >= 100 && !it->IsCollectable() ? sb / 100 : (int?)null,
                materia,
                glamour = glamour == null ? null : new { id = glamour.Id, name = glamour.Name, iconId = glamour.IconId },
            });
        }
        var others = new List<int>(10);
        for (var s = 2; s < Slots.Length - 1; s++) others.Add(ilvls[s]); // head .. ring2 (soul crystal is last and ignored)
        var calc = CharacterStatic.AverageItemLevel(ilvls[0], ilvls[1], mainBlocksOff, others);
        var ui = UIState.Instance();
        int game = ui != null ? ui->CurrentItemLevel : 0;

        // ---- currencies -------------------------------------------------------------------------------------------------------
        var gil = inv->GetGil();
        var weeklyAcquired = inv->GetWeeklyAcquiredTomestoneCount();
        var weeklyLimit = InventoryManager.GetLimitedTomestoneWeeklyLimit();

        var tomestones = new List<object>();
        foreach (var t in stat.Tomestones)
        {
            var count = ItemCounts.Currency(inv, cm, t.ItemId);
            if (count < 0) count = inv->GetTomestoneCount(t.ItemId);
            object? weekly = t.WeeklyLimit > 0
                ? new { acquired = Math.Max(0, weeklyAcquired), limit = weeklyLimit > 0 ? weeklyLimit : t.WeeklyLimit }
                : null;
            tomestones.Add(new { itemId = t.ItemId, name = t.Name, iconId = t.IconId, count, cap = Cap(cm, t.ItemId, t.StackCap), weekly });
        }

        var currencies = new List<object>();
        var gc = (int)ps->GrandCompany;
        var gcRank = (int)ps->GetGrandCompanyRank();
        var sealItem = CharacterStatic.GrandCompanySealItem(gc);
        object? grandCompany = null;
        if (sealItem != 0 && stat.Currency(sealItem) is { } seal)
        {
            var count = ItemCounts.Currency(inv, cm, sealItem);
            var rankCap = stat.SealCap(gcRank);
            grandCompany = new { id = gc, name = stat.GrandCompanyName(gc), rank = gcRank };
            currencies.Add(new { itemId = seal.ItemId, name = seal.Name, iconId = seal.IconId, count = Math.Max(0, count), cap = rankCap > 0 ? rankCap : seal.StackCap, group = "gc" });
        }
        foreach (var (id, _) in CharacterStatic.OtherCurrencies)
        {
            var count = ItemCounts.Currency(inv, cm, id);
            if (count <= 0 || stat.Currency(id) is not { } c) continue; // only what we can read, and only what the player holds
            currencies.Add(new { itemId = c.ItemId, name = c.Name, iconId = c.IconId, count, cap = Cap(cm, id, c.StackCap), group = c.Group });
        }

        return Json.Serialize(new
        {
            loggedIn = true,
            name = playerState.CharacterName ?? "",
            world = playerState.CurrentWorld.ValueNullable?.Name.ToString() ?? "",
            homeWorld = playerState.HomeWorld.ValueNullable?.Name.ToString() ?? "",
            classJobId = (uint)ps->CurrentClassJobId,
            level = currentLevel,
            maxLevel,
            itemLevel = game > 0 ? game : calc,
            itemLevelGame = game,
            itemLevelCalc = calc,
            gil,
            gilCap = 999_999_999u,
            grandCompany,
            jobs,
            gear,
            tomestones,
            currencies,
        });
    }

    private static uint Cap(CurrencyManager* cm, uint itemId, uint stackCap)
    {
        if (cm != null && cm->HasItem(itemId))
        {
            var max = cm->GetItemMaxCount(itemId);
            if (max > 0) return max;
        }
        return stackCap;
    }
}
