using System;
using System.Collections.Generic;
using System.Linq;
using Lumina;
using Lumina.Excel.Sheets;

namespace SecondScreen;

public sealed record JobDef(uint Id, string Abbr, string Name, string Group, int ExpIndex, uint IconId, bool Limited);

public sealed record CurrencyDef(uint ItemId, string Name, uint IconId, uint StackCap, string Group);

public sealed record TomestoneDef(uint ItemId, string Name, uint IconId, uint StackCap, int Order, int WeeklyLimit);

/// <summary>
/// Static game data for the character widget, from Lumina only (Dalamud-free so an offline console app can exercise it):
/// the jobs and where the game keeps their level / EXP (ClassJob.ExpArrayIndex), the tomestones, the other currencies we show,
/// Grand Company rank caps, and the average item level rule. Everything is read once on first use.
/// </summary>
internal sealed class CharacterStatic
{
    /// <summary>ClassJob icons are 62100 + the ClassJob row id (verified to exist for every job by the offline check).</summary>
    public const uint JobIconBase = 62100;

    public static readonly string[] GroupOrder = { "tank", "healer", "melee", "ranged", "caster", "crafter", "gatherer" };

    /// <summary>Currencies shown besides gil, tomestones and Grand Company seals. Item ids; names / icons / caps come from the Item sheet.</summary>
    public static readonly (uint Id, string Group)[] OtherCurrencies =
    {
        (27, "seal"),        // Allied Seal
        (10307, "seal"),     // Centurio Seal (CurrencyManager special bucket)
        (29, "gold"),        // MGP
        (25, "pvp"),         // Wolf Mark
        (26807, "pvp"),      // Bicolor Gemstone
        (41784, "scrip"),    // Orange Crafters' Scrip
        (41785, "scrip"),    // Orange Gatherers' Scrip
        (33913, "scrip"),    // Purple Crafters' Scrip
        (33914, "scrip"),    // Purple Gatherers' Scrip
    };

    /// <summary>Storm / Serpent / Flame Seal are item ids 20 / 21 / 22 for Grand Company 1 / 2 / 3.</summary>
    public static uint GrandCompanySealItem(int grandCompany) => grandCompany is >= 1 and <= 3 ? (uint)(19 + grandCompany) : 0;

    private readonly GameData gd;
    private readonly Lazy<IReadOnlyList<JobDef>> jobs;
    private readonly Lazy<int[]> expToNext;
    private readonly Lazy<IReadOnlyList<TomestoneDef>> tomestones;

    public CharacterStatic(GameData gd)
    {
        this.gd = gd;
        jobs = new(LoadJobs);
        expToNext = new(LoadExp);
        tomestones = new(LoadTomestones);
    }

    public IReadOnlyList<JobDef> Jobs => jobs.Value;
    public IReadOnlyList<TomestoneDef> Tomestones => tomestones.Value;

    /// <summary>Highest level that has an EXP requirement in ParamGrow (100 in Dawntrail).</summary>
    public int MaxLevel
    {
        get
        {
            var t = expToNext.Value;
            for (var i = t.Length - 1; i > 0; i--) if (t[i] > 0) return i;
            return 0;
        }
    }

    /// <summary>EXP needed to go from <paramref name="level"/> to the next one (ParamGrow row = level); 0 if unknown.</summary>
    public int ExpToNext(int level)
    {
        var t = expToNext.Value;
        return level > 0 && level < t.Length ? t[level] : 0;
    }

    private IReadOnlyList<JobDef> LoadJobs()
    {
        var list = new List<(JobDef Def, int Order)>();
        foreach (var j in gd.GetExcelSheet<ClassJob>()!)
        {
            if (j.ExpArrayIndex < 0) continue;
            var abbr = j.Abbreviation.ToString();
            if (abbr.Length == 0) continue;
            // Real jobs (JobIndex > 0) and crafters / gatherers (DohDolJobIndex >= 0); base classes (GLA, ACN, ...) share their job's slot.
            if (j.JobIndex == 0 && j.DohDolJobIndex < 0) continue;
            var name = j.NameEnglish.ToString();
            if (name.Length == 0) name = j.Name.ToString();
            // Title-case every word ("white mage" -> "White Mage").
            name = string.Join(' ', name.Split(' ').Select(w => w.Length > 0 ? char.ToUpperInvariant(w[0]) + w.Substring(1) : w));
            list.Add((new JobDef(j.RowId, abbr, name, GroupOf(j), j.ExpArrayIndex, JobIconBase + j.RowId, j.IsLimitedJob), j.UIPriority));
        }
        return list
            .OrderBy(x => Array.IndexOf(GroupOrder, x.Def.Group))
            .ThenBy(x => x.Order)
            .Select(x => x.Def)
            .ToList();
    }

    /// <summary>ClassJob.JobType: 1 tank, 2 / 6 healer, 3 melee, 4 ranged, 5 caster; crafters and gatherers via DohDolJobIndex / ClassJobCategory.</summary>
    private static string GroupOf(ClassJob j)
    {
        if (j.JobIndex == 0 && j.DohDolJobIndex >= 0) return j.ClassJobCategory.RowId == 33 ? "crafter" : "gatherer";
        return j.JobType switch
        {
            1 => "tank",
            2 or 6 => "healer",
            3 => "melee",
            4 => "ranged",
            5 => "caster",
            _ => j.Role switch { 1 => "tank", 2 => "melee", 3 => "ranged", 4 => "healer", _ => "melee" },
        };
    }

    private int[] LoadExp()
    {
        var sheet = gd.GetExcelSheet<ParamGrow>()!;
        var max = 0;
        foreach (var r in sheet) if (r.RowId < 1000 && r.RowId > max) max = (int)r.RowId;
        var t = new int[max + 1];
        foreach (var r in sheet) if (r.RowId <= max) t[r.RowId] = r.ExpToNext;
        return t;
    }

    private IReadOnlyList<TomestoneDef> LoadTomestones()
    {
        var items = gd.GetExcelSheet<Item>()!;
        var limits = gd.GetExcelSheet<Tomestones>()!;
        var list = new List<TomestoneDef>();
        foreach (var t in gd.GetExcelSheet<TomestonesItem>()!)
        {
            // Tomestones row 0 = retired tomestones; 1..n = the ones in rotation (this is the order the game lists them).
            if (t.Tomestones.RowId == 0 || t.Item.RowId == 0) continue;
            if (!items.TryGetRow(t.Item.RowId, out var item)) continue;
            var weekly = limits.TryGetRow(t.Tomestones.RowId, out var lim) ? lim.WeeklyLimit : 0;
            list.Add(new TomestoneDef(item.RowId, item.Name.ToString(), item.Icon, item.StackSize, (int)t.Tomestones.RowId, weekly));
        }
        return list.OrderBy(t => t.Order).ToList();
    }

    public CurrencyDef? Currency(uint itemId)
    {
        if (!gd.GetExcelSheet<Item>()!.TryGetRow(itemId, out var item)) return null;
        var group = OtherCurrencies.FirstOrDefault(c => c.Id == itemId).Group ?? "";
        return new CurrencyDef(item.RowId, item.Name.ToString(), item.Icon, item.StackSize, group);
    }

    /// <summary>GrandCompanyRank.MaxSeals for a rank (row id = rank); 0 if unknown.</summary>
    public uint SealCap(int rank)
        => rank > 0 && gd.GetExcelSheet<GrandCompanyRank>()!.TryGetRow((uint)rank, out var r) ? r.MaxSeals : 0;

    public string GrandCompanyName(int id)
        => id > 0 && gd.GetExcelSheet<GrandCompany>()!.TryGetRow((uint)id, out var g) ? g.Name.ToString() : "";

    /// <summary>Name of a melded materia, e.g. "Savage Aim Materia XII" (grade is 0-based). Empty if unknown.</summary>
    public string MateriaName(ushort materiaId, int grade)
    {
        try
        {
            if (!gd.GetExcelSheet<Materia>()!.TryGetRow(materiaId, out var m) || grade < 0 || grade >= m.Item.Count) return "";
            return m.Item[grade].ValueNullable?.Name.ToString() ?? "";
        }
        catch { return ""; }
    }

    /// <summary>True for two-handed weapons: their EquipSlotCategory blocks the off-hand slot (OffHand == -1).</summary>
    public bool BlocksOffHand(uint itemId)
    {
        try
        {
            return gd.GetExcelSheet<Item>()!.TryGetRow(itemId, out var item)
                && gd.GetExcelSheet<EquipSlotCategory>()!.TryGetRow(item.EquipSlotCategory.RowId, out var cat)
                && cat.OffHand < 0;
        }
        catch { return false; }
    }

    // ---- average item level ----------------------------------------------------------------------------------------------------

    /// <summary>
    /// The in-game average item level: the item levels of the 12 gear slots (main hand, off hand, head, body, hands, legs, feet,
    /// ears, neck, wrists, 2 rings) summed and divided by 12, rounded down. The soul crystal is ignored. A two-handed main hand
    /// (EquipSlotCategory.OffHand == -1, "off-hand blocked") fills the off-hand slot with its own item level, i.e. it counts twice.
    /// </summary>
    public static int AverageItemLevel(int mainHand, int offHand, bool mainHandBlocksOffHand, IReadOnlyList<int> others /* the 10 non-weapon slots */)
    {
        var sum = mainHand + (mainHandBlocksOffHand ? mainHand : offHand);
        foreach (var v in others) sum += v;
        return sum / 12;
    }
}
