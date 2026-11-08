using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Lumina;
using Lumina.Data;
using Lumina.Excel;
using Lumina.Excel.Sheets;

namespace SecondScreen;

/// <summary>One "what this quest unlocks" entry. Kind is a short category ("Dungeon", "Emote", "Shop", ...), Text the name.</summary>
public sealed record QuestUnlock(string Kind, string Text);

/// <summary>Immutable, character-independent data about one quest that has an issuer on a map.</summary>
public sealed class QuestStatic
{
    public uint Id { get; init; }
    public string Name { get; init; } = "";
    public int Level { get; init; }
    /// <summary>msq | feature (blue "+") | side | repeatable</summary>
    public string Category { get; init; } = "side";
    public uint IconId { get; init; }
    public string Genre { get; init; } = "";
    public string Expansion { get; init; } = "";
    public string Giver { get; init; } = "";
    public uint MapId { get; init; }
    /// <summary>Position on the 2048px map texture.</summary>
    public int X { get; init; }
    public int Y { get; init; }
    /// <summary>In-game coordinates ("X: 12.3 Y: 34.5").</summary>
    public double Cx { get; init; }
    public double Cy { get; init; }
    public uint[] Prev { get; init; } = Array.Empty<uint>();
    public bool PrevAny { get; init; }
    public uint[] Lock { get; init; } = Array.Empty<uint>();
    /// <summary>"" for any class; otherwise the ClassJobCategory name ("Gladiator", "Disciples of the Land"...).</summary>
    public string JobName { get; init; } = "";
    /// <summary>ClassJob.ExpArrayIndex values that satisfy the level requirement; null = any class.</summary>
    public int[]? JobExp { get; init; }
    public bool Repeatable { get; init; }
    public QuestUnlock[] Unlocks { get; init; } = Array.Empty<QuestUnlock>();
    public uint[] LeadsTo { get; init; } = Array.Empty<uint>();
}

/// <summary>Per-character quest state read on the framework thread; immutable once published.</summary>
public sealed class QuestState
{
    public static readonly QuestState Empty = new(0, 0, new HashSet<uint>(), new HashSet<uint>(), Array.Empty<short>());

    public QuestState(long version, ulong character, HashSet<uint> completed, HashSet<uint> accepted, short[] levels)
    {
        Version = version;
        Character = character;
        Completed = completed;
        Accepted = accepted;
        Levels = levels;
    }

    public long Version { get; }
    public ulong Character { get; }
    /// <summary>Quest sheet row ids (65536 + n) of completed quests.</summary>
    public HashSet<uint> Completed { get; }
    public HashSet<uint> Accepted { get; }
    /// <summary>PlayerState.ClassJobLevels, indexed by ClassJob.ExpArrayIndex.</summary>
    public short[] Levels { get; }
}

/// <summary>Quest availability for the current character. "Done" and "Blocked" quests are not shown.</summary>
public enum QuestStatus { Available, Accepted, Locked, Done, Blocked }

/// <summary>Reward summary for the quest detail popover.</summary>
public sealed record QuestRewards(uint Gil, IReadOnlyList<string> Items, IReadOnlyList<string> Choose, IReadOnlyList<string> Other);

/// <summary>
/// Quest model for the map "Quests" layer: every quest that has an issuer location, plus a reverse index of what each
/// quest unlocks, built once from the Lumina sheets on a thread-pool thread (never the game thread) and cached.
/// Dalamud-free so an offline console app can compile and exercise the same code.
///
/// Where things come from (verified against the installed Lumina.Excel 7.0.0.0 sheets):
///   position   Quest.IssuerLocation -> Level row (Map, X, Z) -> map pixel with the Map sheet offset / size factor.
///   giver      Quest.IssuerStart -> ENpcResident.
///   icon       Quest.EventIconType -> EventIconType.MapIconAvailable + 1 (the listed id is a text placeholder icon; +1 is the real
///              one): 71001 main scenario, 71021 side quest, 71141 feature quest (blue "+"), 71081 repeatable.
///   category   EventIconType 3 = msq; 8 and 10 = feature; IsRepeatable / BeastTribe = repeatable; the rest = side.
/// </summary>
internal sealed class QuestModel
{
    public sealed class Data
    {
        public QuestStatic[] All { get; init; } = Array.Empty<QuestStatic>();
        public Dictionary<uint, QuestStatic> ById { get; init; } = new();
        public Dictionary<uint, QuestStatic[]> ByMap { get; init; } = new();
        /// <summary>Number of quests (with an issuer) that have at least one unlock entry.</summary>
        public int WithUnlocks { get; init; }
        public int BuildMs { get; init; }
    }

    private readonly GameData gd;
    private readonly object gate = new();
    private Task<Data>? building;
    private readonly ConcurrentDictionary<uint, string> summaries = new();

    public QuestModel(GameData gd) => this.gd = gd;

    /// <summary>Starts the background build if needed (retries after a failure).</summary>
    public Task<Data> GetAsync()
    {
        lock (gate)
        {
            if (building == null || building.IsFaulted || building.IsCanceled)
                building = Task.Run(Build);
            return building;
        }
    }

    internal static string Capitalize(string s) => s.Length > 0 && char.IsLower(s[0]) ? char.ToUpperInvariant(s[0]) + s[1..] : s;

    // ---- availability (pure; shared with the offline test) -------------------------------------------------------------------

    public static QuestStatus Evaluate(QuestStatic q, QuestState s, IReadOnlyDictionary<uint, QuestStatic> byId, out string? reason)
    {
        reason = null;
        if (!q.Repeatable && s.Completed.Contains(q.Id)) return QuestStatus.Done;
        foreach (var l in q.Lock)
            if (s.Completed.Contains(l)) return QuestStatus.Blocked; // an exclusive alternative was already done
        if (s.Accepted.Contains(q.Id)) return QuestStatus.Accepted;

        if (q.Prev.Length > 0)
        {
            var missing = q.Prev.Where(p => !s.Completed.Contains(p)).ToArray();
            var met = q.PrevAny ? missing.Length < q.Prev.Length : missing.Length == 0;
            if (!met)
            {
                var first = missing[0];
                var name = byId.TryGetValue(first, out var pq) ? pq.Name : $"quest {first}";
                reason = q.PrevAny && q.Prev.Length > 1 ? $"Needs one of {q.Prev.Length} earlier quests, e.g. {name}" : $"Needs quest: {name}";
                return QuestStatus.Locked;
            }
        }

        if (q.Level > 1)
        {
            var best = 0;
            if (q.JobExp == null) foreach (var lv in s.Levels) best = Math.Max(best, lv);
            else foreach (var i in q.JobExp) if (i >= 0 && i < s.Levels.Length) best = Math.Max(best, s.Levels[i]);
            if (best < q.Level)
            {
                reason = q.JobName.Length > 0 ? $"Needs {q.JobName} Lv {q.Level}" : $"Needs Lv {q.Level}";
                return QuestStatus.Locked;
            }
        }
        return QuestStatus.Available;
    }

    // ---- build ----------------------------------------------------------------------------------------------------------------

    public const string CatFeature = "feature", CatMsq = "msq", CatSide = "side", CatRepeatable = "repeatable";
    private const uint IconMsq = 71001, IconSide = 71021, IconFeature = 71141, IconRepeat = 71081;

    /// <summary>Synchronous build (public for the offline test app; production goes through <see cref="GetAsync"/>).</summary>
    public Data Build()
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var quests = gd.GetExcelSheet<Quest>()!;
        var maps = gd.GetExcelSheet<Map>()!;
        var npcs = gd.GetExcelSheet<ENpcResident>()!;
        var eventIcons = gd.GetExcelSheet<EventIconType>()!;

        var unlocks = new UnlockIndex(gd);
        unlocks.Build(quests);

        // ClassJobCategory -> ExpArrayIndex of every class / job it contains (the sheet has one bool column per job abbreviation).
        var catCache = new Dictionary<uint, int[]?>();
        var jobExp = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var j in gd.GetExcelSheet<ClassJob>()!)
            if (j.ExpArrayIndex >= 0 && j.Abbreviation.ToString() is { Length: > 0 } ab) jobExp[ab] = j.ExpArrayIndex;
        var expName = new Dictionary<int, string>();
        foreach (var j in gd.GetExcelSheet<ClassJob>()!)
            if (j.ExpArrayIndex >= 0 && !expName.ContainsKey(j.ExpArrayIndex)) expName[j.ExpArrayIndex] = j.Name.ToString();
        var catProps = typeof(ClassJobCategory).GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.PropertyType == typeof(bool) && jobExp.ContainsKey(p.Name)).ToArray();
        int[]? JobsOf(RowRef<ClassJobCategory> cat)
        {
            if (cat.RowId == 0) return null;
            if (catCache.TryGetValue(cat.RowId, out var c)) return c;
            int[]? result = null;
            if (cat.ValueNullable is { } row)
            {
                var boxed = (object)row;
                var list = catProps.Where(p => (bool)p.GetValue(boxed)!).Select(p => jobExp[p.Name]).Distinct().ToArray();
                // "All Classes", "All classes and jobs (excluding limited jobs)" etc. mean no class restriction.
                var all = row.Name.ToString().StartsWith("All ", StringComparison.OrdinalIgnoreCase) || list.Length * 5 >= jobExp.Count * 4;
                result = list.Length == 0 || all ? null : list;
            }
            catCache[cat.RowId] = result;
            return result;
        }

        var mapInfo = new Dictionary<uint, MapInfo?>();
        MapInfo? InfoOf(uint mapId)
        {
            if (!mapInfo.TryGetValue(mapId, out var mi)) mapInfo[mapId] = mi = MapData.Describe(maps, mapId);
            return mi;
        }

        var all = new List<QuestStatic>(5500);
        var leadsTo = new Dictionary<uint, List<uint>>();
        foreach (var q in quests)
        {
            var name = q.Name.ToString().Trim();
            if (name.Length == 0) continue;
            if (q.Festival.RowId != 0) continue; // seasonal event quests are only available during the event
            if (q.IssuerLocation.RowId == 0 || q.IssuerLocation.ValueNullable is not { } lv || lv.Map.RowId == 0) continue;
            var info = InfoOf(lv.Map.RowId);
            if (info == null) continue;

            var ev = q.EventIconType.RowId;
            var repeat = q.IsRepeatable || q.BeastTribe.RowId != 0;
            var cat = repeat ? CatRepeatable : ev == 3 ? CatMsq : ev is 8 or 10 ? CatFeature : CatSide;
            var icon = cat switch { CatMsq => IconMsq, CatFeature => IconFeature, CatRepeatable => IconRepeat, _ => IconSide };
            if (cat != CatRepeatable && ev is 1 or 3 or 8 or 10 && eventIcons.TryGetRow(ev, out var evRow) && evRow.MapIconAvailable != 0)
                icon = evRow.MapIconAvailable + 1; // the listed id is a "MAP ANONC ..." placeholder; +1 is the real icon

            var prev = q.PreviousQuest.Select(p => p.RowId).Where(p => p != 0).ToArray();
            foreach (var p in prev)
            {
                if (!leadsTo.TryGetValue(p, out var l)) leadsTo[p] = l = new List<uint>();
                l.Add(q.RowId);
            }
            var catRef = q.ClassJobCategory0;
            var jobs = JobsOf(catRef);
            var px = (int)Math.Round(MapData.ToPixel(lv.X, info.OffsetX, info.SizeFactor));
            var py = (int)Math.Round(MapData.ToPixel(lv.Z, info.OffsetY, info.SizeFactor));

            all.Add(new QuestStatic
            {
                Id = q.RowId,
                Name = name,
                Level = MsqModel.Level(q),
                Category = cat,
                IconId = icon,
                Genre = q.JournalGenre.ValueNullable?.Name.ToString() ?? "",
                Expansion = q.Expansion.ValueNullable?.Name.ToString() ?? "",
                Giver = npcs.TryGetRow(q.IssuerStart.RowId, out var npc) ? npc.Singular.ToString().Trim() : "",
                MapId = lv.Map.RowId,
                X = px,
                Y = py,
                Cx = Math.Round(MapData.ToDisplay(lv.X, info.OffsetX, info.SizeFactor), 1),
                Cy = Math.Round(MapData.ToDisplay(lv.Z, info.OffsetY, info.SizeFactor), 1),
                Prev = prev,
                PrevAny = q.PreviousQuestJoin == 2,
                Lock = q.QuestLock.Select(p => p.RowId).Where(p => p != 0).ToArray(),
                JobName = jobs == null ? "" : jobs.Length == 1 && expName.TryGetValue(jobs[0], out var jn) ? Capitalize(jn) : catRef.ValueNullable?.Name.ToString() ?? "",
                JobExp = jobs,
                Repeatable = repeat,
                Unlocks = unlocks.For(q.RowId),
            });
        }

        // LeadsTo is init-only and needs every quest present first, so the list is rebuilt once.
        var final = new List<QuestStatic>(all.Count);
        foreach (var q in all)
        {
            var next = leadsTo.TryGetValue(q.Id, out var l) ? l.Distinct().ToArray() : Array.Empty<uint>();
            final.Add(new QuestStatic
            {
                Id = q.Id, Name = q.Name, Level = q.Level, Category = q.Category, IconId = q.IconId, Genre = q.Genre,
                Expansion = q.Expansion, Giver = q.Giver, MapId = q.MapId, X = q.X, Y = q.Y, Cx = q.Cx, Cy = q.Cy,
                Prev = q.Prev, PrevAny = q.PrevAny, Lock = q.Lock, JobName = q.JobName, JobExp = q.JobExp,
                Repeatable = q.Repeatable, Unlocks = q.Unlocks, LeadsTo = next,
            });
        }

        return new Data
        {
            All = final.ToArray(),
            ById = final.ToDictionary(q => q.Id),
            ByMap = final.GroupBy(q => q.MapId).ToDictionary(g => g.Key, g => g.ToArray()),
            WithUnlocks = final.Count(q => q.Unlocks.Length > 0),
            BuildMs = (int)sw.ElapsedMilliseconds,
        };
    }

    // ---- detail (on demand) ---------------------------------------------------------------------------------------------------

    /// <summary>Short journal text of a quest (the first, "SEQ" step of its quest text sheet), or "" when unavailable.</summary>
    public string Summary(uint questId)
    {
        if (summaries.TryGetValue(questId, out var cached)) return cached;
        var text = "";
        try
        {
            var quests = gd.GetExcelSheet<Quest>()!;
            if (quests.TryGetRow(questId, out var q))
            {
                var id = q.Id.ToString();
                var us = id.LastIndexOf('_');
                if (us > 0 && int.TryParse(id.AsSpan(us + 1), out var n))
                {
                    var raw = gd.Excel.GetSheet<RawRow>(name: $"quest/{n / 100:000}/{id}");
                    if (raw != null)
                    {
                        foreach (var row in raw)
                        {
                            var key = row.ReadStringColumn(0).ToString();
                            if (!key.Contains("_SEQ_", StringComparison.Ordinal)) continue;
                            var t = row.ReadStringColumn(1).ToString().Trim();
                            if (t.Length == 0) continue;
                            text = t;
                            break;
                        }
                    }
                }
            }
        }
        catch { /* quest text sheet missing: no summary */ }
        summaries[questId] = text;
        return text;
    }

    /// <summary>Name of any quest row ("" when unknown); for prerequisites that have no issuer location and so are not in <see cref="Data"/>.</summary>
    public string NameOf(uint questId)
        => gd.GetExcelSheet<Quest>()!.TryGetRow(questId, out var q) ? q.Name.ToString().Trim() : "";

    public QuestRewards Rewards(uint questId)
    {
        var quests = gd.GetExcelSheet<Quest>()!;
        var items = gd.GetExcelSheet<Item>()!;
        var other = new List<string>();
        if (!quests.TryGetRow(questId, out var q)) return new QuestRewards(0, Array.Empty<string>(), Array.Empty<string>(), other);

        string ItemText(uint itemId, int count)
        {
            var n = items.TryGetRow(itemId, out var it) ? it.Name.ToString().Trim() : "";
            if (n.Length == 0) return "";
            return count > 1 ? $"{n} x{count}" : n;
        }

        var fixedItems = new List<string>();
        for (var i = 0; i < q.Reward.Count; i++)
        {
            var id = q.Reward[i].RowId;
            if (id == 0) continue;
            var t = ItemText(id, i < q.ItemCountReward.Count ? q.ItemCountReward[i] : 1);
            if (t.Length > 0) fixedItems.Add(t);
        }
        var choose = new List<string>();
        for (var i = 0; i < q.OptionalItemReward.Count; i++)
        {
            var id = q.OptionalItemReward[i].RowId;
            if (id == 0) continue;
            var t = ItemText(id, i < q.OptionalItemCountReward.Count ? q.OptionalItemCountReward[i] : 1);
            if (t.Length > 0) choose.Add(t);
        }
        if (q.CurrencyReward.RowId != 0 && q.CurrencyRewardCount > 0)
        {
            var t = ItemText(q.CurrencyReward.RowId, (int)q.CurrencyRewardCount);
            if (t.Length > 0) other.Add(t);
        }
        if (q.OtherReward.ValueNullable is { } o && o.Name.ToString().Trim() is { Length: > 0 } on) other.Add(on);
        if (q.BeastTribe.ValueNullable is { } bt && q.ReputationReward > 0) other.Add($"{bt.Name.ToString().Trim()} reputation");
        return new QuestRewards(q.GilReward, fixedItems, choose, other);
    }

    // ---- unlock index ------------------------------------------------------------------------------------------------------------

    /// <summary>
    /// Reverse index quest row id -> unlocked things. Sources implemented:
    ///  quest fields    InstanceContentUnlock (duty), EmoteReward, ActionReward, GeneralActionReward (system actions such as Cast Glamour),
    ///                  OtherReward (Aether Current, soul crystals...), ClassJobUnlock, reward items that are mounts / minions /
    ///                  orchestrion rolls / Triple Triad cards / secret recipe books (via ItemAction + ItemUICategory),
    ///  quest scripts   Quest.QuestParams: UNLOCK_ADD_NEW_CONTENT_TO_CF* + INSTANCEDUNGEON* (duty finder content, the main dungeon
    ///                  and trial unlock mechanism), HOW_TO* / HOWTO* (the tutorial that pops up: "Glamours", "Hunting Log", ...),
    ///                  a few UNLOCK_IMAGE_* / UNLOCK_SALVAGE features (Retainers, Dyeing, Materia, Desynthesis, Hunting Log, ...),
    ///  reverse links   ContentFinderCondition (UnlockType 1 -> quest), Aetheryte.RequiredQuest, ClassJob.UnlockQuest,
    ///                  Action.UnlockLink / Emote.UnlockLink (when the link is a quest row), Trait.Quest,
    ///                  GilShop / SpecialShop / InclusionShop / CollectablesShop .Quest (shops), Recipe.Quest (recipes),
    ///                  SatisfactionNpc.QuestRequired (Custom Deliveries), BeastTribe.IntersocietalQuest (allied societies).
    /// Skipped: Quest.SystemReward (opaque indices), ContentsNote.ReqUnlock, PreHandler.UnlockQuest, Buddy quest requirements,
    /// CharaMakeCustomize (hairstyles are item based) and UnlockLink flags below 65536 (set by scripts, not stored in sheets).
    /// </summary>
    private sealed class UnlockIndex
    {
        private static readonly Regex Digits = new(@"\d+$", RegexOptions.Compiled);

        private readonly GameData gd;
        private readonly Dictionary<uint, List<QuestUnlock>> map = new();
        private readonly HashSet<(uint, string, string)> seen = new();

        public UnlockIndex(GameData gd) => this.gd = gd;

        private static readonly string[] KindOrder =
        {
            "Dungeon", "Trial", "Raid", "Ultimate", "Deep Dungeon", "Guildhest", "Duty", "Class", "Job", "System", "Feature", "Action", "Trait",
            "Emote", "Mount", "Minion", "Orchestrion", "Triple Triad", "Recipe Book", "Recipe", "Aetheryte", "Shop", "Custom Delivery",
            "Allied Society", "Tutorial",
        };

        /// <summary>Unlocks of a quest in display order; the same text under two kinds (e.g. System + Tutorial "Desynthesis") is kept once.</summary>
        public QuestUnlock[] For(uint quest)
        {
            if (!map.TryGetValue(quest, out var l)) return Array.Empty<QuestUnlock>();
            var ordered = l.Select((u, i) => (u, i)).OrderBy(x => Math.Max(0, Array.IndexOf(KindOrder, x.u.Kind))).ThenBy(x => x.i).Select(x => x.u);
            var texts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            return ordered.Where(u => texts.Add(u.Text)).ToArray();
        }

        private void Add(uint quest, string kind, string text)
        {
            text = QuestModel.Capitalize(text.Trim());
            if (quest < 0x10000 || text.Length == 0 || !seen.Add((quest, kind, text))) return;
            if (!map.TryGetValue(quest, out var l)) map[quest] = l = new List<QuestUnlock>();
            l.Add(new QuestUnlock(kind, text));
        }

        private static string DutyKind(string contentType) => contentType switch
        {
            "Dungeons" => "Dungeon",
            "Trials" => "Trial",
            "Raids" => "Raid",
            "Guildhests" => "Guildhest",
            "Ultimate Raids" => "Ultimate",
            "Deep Dungeons" => "Deep Dungeon",
            _ => "Duty",
        };

        private (string Kind, string Name)? DutyOfCfc(ContentFinderCondition c)
        {
            var name = c.Name.ToString().Trim();
            if (name.Length == 0) return null;
            return (DutyKind(c.ContentType.ValueNullable?.Name.ToString() ?? ""), name);
        }

        private (string Kind, string Name)? DutyOfInstance(uint instanceId)
        {
            var ic = gd.GetExcelSheet<InstanceContent>()!;
            if (!ic.TryGetRow(instanceId, out var i) || i.ContentFinderCondition.ValueNullable is not { } c) return null;
            return DutyOfCfc(c);
        }

    
        // UNLOCK_* quest script instructions with a clear meaning (the numeric suffix is stripped before the lookup).
        private static readonly Dictionary<string, string> ScriptFeatures = new()
        {
            ["UNLOCK_IMAGE_RETAINER"] = "Retainers",
            ["UNLOCK_IMAGE_DYEING"] = "Dyeing",
            ["UNLOCK_IMAGE_MATERIA"] = "Materia",
            ["UNLOCK_IMAGE_MATERIA_EQUIP"] = "Materia Melding",
            ["UNLOCK_IMAGE_MATERIA_FORBIDDEN"] = "Advanced Materia Melding",
            ["UNLOCK_SALVAGE"] = "Desynthesis",
            ["UNLOCK_IMAGE_MONSTER_NOTE"] = "Hunting Log",
            ["UNLOCK_IMAGE_LEVE"] = "Levequests",
            ["UNLOCK_IMAGE_MOBHUNT"] = "Hunt Board",
            ["UNLOCK_IMAGE_RISKYMOBHUNT"] = "Elite Hunts",
            ["UNLOCK_IMAGE_DD"] = "Deep Dungeon",
            ["UNLOCK_IMAGE_GEAR_SET"] = "Gear Sets",
        };

        public void Build(ExcelSheet<Quest> quests)
        {
            var items = gd.GetExcelSheet<Item>()!;
            var itemActions = gd.GetExcelSheet<ItemAction>()!;
            var howTo = gd.GetExcelSheet<HowTo>()!;
            var emotes = gd.GetExcelSheet<Emote>()!;
            var actions = gd.GetExcelSheet<Lumina.Excel.Sheets.Action>()!;
            var mounts = gd.GetExcelSheet<Mount>()!;
            var companions = gd.GetExcelSheet<Companion>()!;
            var orchestrion = gd.GetExcelSheet<Orchestrion>()!;
            var itemCategories = gd.GetExcelSheet<ItemUICategory>()!;

            var secretBooks = new Dictionary<uint, string>(); // item row -> recipe book name
            foreach (var b in gd.GetExcelSheet<SecretRecipeBook>()!)
                if (b.Item.RowId != 0 && b.Name.ToString().Trim() is { Length: > 0 } bn) secretBooks[b.Item.RowId] = bn;

            string EmoteText(Emote e)
            {
                var cmd = e.TextCommand.ValueNullable?.Command.ToString().Trim() ?? "";
                var n = e.Name.ToString().Trim();
                return cmd.Length > 0 && n.Length > 0 ? $"{n} ({cmd})" : n.Length > 0 ? n : cmd;
            }

            string ActionText(Lumina.Excel.Sheets.Action a)
            {
                var n = a.Name.ToString().Trim();
                if (n.Length == 0) return "";
                var job = a.ClassJob.RowId != 0 ? a.ClassJob.ValueNullable?.Abbreviation.ToString().Trim() ?? "" : "";
                return job.Length > 0 ? $"{n} ({job})" : n;
            }

            // --- quest rows ---------------------------------------------------------------------------------------------------
            foreach (var q in quests)
            {
                if (q.Name.ToString().Trim().Length == 0) continue;
                var id = q.RowId;

                if (q.InstanceContentUnlock.RowId != 0 && DutyOfInstance(q.InstanceContentUnlock.RowId) is { } d) Add(id, d.Kind, d.Name);
                if (q.EmoteReward.RowId != 0 && q.EmoteReward.ValueNullable is { } em) Add(id, "Emote", EmoteText(em));
                if (q.ActionReward.RowId != 0 && q.ActionReward.ValueNullable is { } act) Add(id, "Action", ActionText(act));
                foreach (var ga in q.GeneralActionReward)
                    if (ga.RowId != 0 && ga.ValueNullable is { } g) Add(id, "System", g.Name.ToString());
                if (q.OtherReward.RowId != 0 && q.OtherReward.ValueNullable is { } o) Add(id, "Feature", o.Name.ToString());
                if (q.ClassJobUnlock.RowId != 0 && q.ClassJobUnlock.ValueNullable is { } cj)
                    Add(id, cj.ClassJobParent.RowId == cj.RowId || cj.ClassJobParent.RowId == 0 ? "Class" : "Job", cj.Name.ToString());

                // reward items that unlock something
                void RewardItem(uint itemId)
                {
                    if (itemId == 0 || !items.TryGetRow(itemId, out var it)) return;
                    var name = it.Name.ToString().Trim();
                    if (name.Length == 0) return;
                    if (secretBooks.TryGetValue(itemId, out var book)) { Add(id, "Recipe Book", book); return; }
                    if (it.ItemAction.RowId != 0 && itemActions.TryGetRow(it.ItemAction.RowId, out var ia) && ia.Data.Count > 0)
                    {
                        var kind = ia.Action.RowId;
                        var data = ia.Data[0];
                        if (kind == 1322 && mounts.TryGetRow(data, out var m)) { Add(id, "Mount", m.Singular.ToString()); return; }
                        if (kind == 853 && companions.TryGetRow(data, out var c)) { Add(id, "Minion", c.Singular.ToString()); return; }
                        if (kind == 25183 && orchestrion.TryGetRow(data, out var orch)) { Add(id, "Orchestrion", orch.Name.ToString()); return; }
                    }
                    var cat = itemCategories.TryGetRow(it.ItemUICategory.RowId, out var ic) ? ic.Name.ToString() : "";
                    if (cat == "Triple Triad Card") Add(id, "Triple Triad", name);
                    else if (cat == "Minion") Add(id, "Minion", name);
                    else if (cat == "Orchestrion Roll") Add(id, "Orchestrion", name);
                }
                foreach (var r in q.Reward) RewardItem(r.RowId);
                foreach (var r in q.OptionalItemReward) RewardItem(r.RowId);

                // quest script instructions
                var hasDutyUnlock = false;
                for (var i = 0; i < q.QuestParams.Count; i++)
                {
                    var ins = q.QuestParams[i].ScriptInstruction;
                    if (ins.IsEmpty) continue;
                    if (ins.ToString().StartsWith("UNLOCK_ADD_NEW_CONTENT", StringComparison.Ordinal)) { hasDutyUnlock = true; break; }
                }
                for (var i = 0; i < q.QuestParams.Count; i++)
                {
                    var p = q.QuestParams[i];
                    if (p.ScriptInstruction.IsEmpty) continue;
                    var s = Digits.Replace(p.ScriptInstruction.ToString(), "");
                    if (s == "INSTANCEDUNGEON")
                    {
                        if (hasDutyUnlock && DutyOfInstance(p.ScriptArg) is { } duty) Add(id, duty.Kind, duty.Name);
                    }
                    else if (s.StartsWith("HOW_TO", StringComparison.Ordinal) || s.StartsWith("HOWTO", StringComparison.Ordinal))
                    {
                        if (howTo.TryGetRow(p.ScriptArg, out var h) && h.Name.ToString().Trim() is { Length: > 0 } hn) Add(id, "Tutorial", hn);
                    }
                    else if (ScriptFeatures.TryGetValue(s, out var feature)) Add(id, "Feature", feature);
                }
            }

            // --- reverse links ---------------------------------------------------------------------------------------------------
            foreach (var c in gd.GetExcelSheet<ContentFinderCondition>()!)
            {
                if (c.UnlockType == 1 && c.UnlockCriteria.RowId != 0 && DutyOfCfc(c) is { } d) Add(c.UnlockCriteria.RowId, d.Kind, d.Name);
                if (c.UnlockType2 == 1 && c.UnlockCriteria2.RowId != 0 && DutyOfCfc(c) is { } d2) Add(c.UnlockCriteria2.RowId, d2.Kind, d2.Name);
            }

            foreach (var a in gd.GetExcelSheet<Aetheryte>()!)
                if (a.RequiredQuest.RowId != 0) Add(a.RequiredQuest.RowId, "Aetheryte", a.PlaceName.ValueNullable?.Name.ToString() ?? "");

            foreach (var j in gd.GetExcelSheet<ClassJob>()!)
                if (j.UnlockQuest.RowId != 0) Add(j.UnlockQuest.RowId, j.ClassJobParent.RowId == j.RowId || j.ClassJobParent.RowId == 0 ? "Class" : "Job", j.Name.ToString());

            foreach (var a in actions)
                if (a.UnlockLink.RowId >= 0x10000 && quests.HasRow(a.UnlockLink.RowId)) Add(a.UnlockLink.RowId, "Action", ActionText(a));

            foreach (var t in gd.GetExcelSheet<Trait>()!)
            {
                if (t.Quest.RowId == 0) continue;
                var n = t.Name.ToString().Trim();
                var job = t.ClassJob.RowId != 0 ? t.ClassJob.ValueNullable?.Abbreviation.ToString().Trim() ?? "" : "";
                Add(t.Quest.RowId, "Trait", job.Length > 0 ? $"{n} ({job})" : n);
            }

            foreach (var e in emotes)
                if (e.UnlockLink >= 0x10000 && quests.HasRow(e.UnlockLink)) Add(e.UnlockLink, "Emote", EmoteText(e));

            foreach (var s in gd.GetExcelSheet<GilShop>()!)
                if (s.Quest.RowId != 0 && s.Name.ToString().Trim() is { Length: > 0 } sn) Add(s.Quest.RowId, "Shop", sn);
            foreach (var s in gd.GetExcelSheet<SpecialShop>()!)
            {
                if (s.Quest.RowId == 0) continue;
                var sn = s.Name.ToString().Trim();
                if (sn.Length == 0)
                {
                    foreach (var entry in s.Item)
                    {
                        var first = entry.ReceiveItems.Count > 0 ? entry.ReceiveItems[0].Item.RowId : 0;
                        if (first != 0 && items.TryGetRow(first, out var it) && it.Name.ToString().Trim() is { Length: > 0 } iname) { sn = $"sells {iname} and more"; break; }
                    }
                    if (sn.Length == 0) continue;
                }
                Add(s.Quest.RowId, "Shop", sn);
            }
            foreach (var s in gd.GetExcelSheet<InclusionShop>()!)
                if (s.UnlockQuest.RowId != 0 && s.ShopName.ToString().Trim() is { Length: > 0 } sn) Add(s.UnlockQuest.RowId, "Shop", sn);
            foreach (var s in gd.GetExcelSheet<CollectablesShop>()!)
                if (s.Quest.RowId != 0 && s.Name.ToString().Trim() is { Length: > 0 } sn) Add(s.Quest.RowId, "Shop", sn);

            foreach (var r in gd.GetExcelSheet<Recipe>()!)
            {
                if (r.Quest.RowId == 0) continue;
                var n = items.TryGetRow(r.ItemResult.RowId, out var it) ? it.Name.ToString().Trim() : "";
                if (n.Length == 0) continue;
                var craft = r.CraftType.ValueNullable?.Name.ToString().Trim() ?? "";
                Add(r.Quest.RowId, "Recipe", craft.Length > 0 ? $"{n} ({craft})" : n);
            }

            foreach (var s in gd.GetExcelSheet<SatisfactionNpc>()!)
                if (s.QuestRequired.RowId != 0 && s.Npc.ValueNullable?.Singular.ToString().Trim() is { Length: > 0 } npc) Add(s.QuestRequired.RowId, "Custom Delivery", npc);

            foreach (var b in gd.GetExcelSheet<BeastTribe>()!)
                if (b.IntersocietalQuest.RowId != 0 && b.Name.ToString().Trim() is { Length: > 0 } bn) Add(b.IntersocietalQuest.RowId, "Allied Society", bn);
        }
    }
}
