using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Lumina;
using Lumina.Excel.Sheets;

namespace SecondScreen;

/// <summary>A quest as shown on a tracker card ("Next: name (Lv N)", the quest tracker detail).</summary>
public sealed record QuestInfo(uint Id, string Name, int Level, string Expansion, string PlaceName, string Genre);

/// <summary>Done/total for one expansion, counting only the quests that apply to this character.</summary>
public sealed record ExpansionProgress(string Expansion, int Done, int Total);

/// <summary>MSQ specifics of a tracker card: per-expansion breakdown, the expansion holding the next quest, and that quest.</summary>
public sealed record MsqProgressInfo(IReadOnlyList<ExpansionProgress> Expansions, ExpansionProgress? Current, QuestInfo? Next);

/// <summary>Result of <see cref="MsqModel.Data.Evaluate"/>: overall done/total plus the detail above.</summary>
public sealed record MsqSnapshot(int Done, int Total, MsqProgressInfo Detail);

/// <summary>
/// The Main Scenario Quest (MSQ) model, built once from the Lumina Quest sheet and cached. Dalamud-free (Lumina only)
/// so an offline console app can compile and exercise the same code. Build runs on a thread-pool thread, never the
/// game thread; <see cref="TryGetReady"/> is non-blocking for the framework thread.
///
/// How MSQ quests are identified: Quest.JournalGenre -> JournalCategory -> JournalSection, where the section name
/// starts with "Main Scenario" ("Main Scenario (A Realm Reborn through Endwalker)" and "Main Scenario (Dawntrail)").
/// Quests are grouped by Quest.Expansion (ExVersion sheet).
///
/// Order: topological over PreviousQuest links (prerequisites that are not themselves MSQ quests are followed
/// through to the MSQ quests behind them), ties broken by (expansion, level, SortKey, id).
///
/// Mutually exclusive branches (starting city-state chains, class-specific first quests, Grand Company choice) are
/// detected from the data, not from id lists: PreviousQuestJoin == 2 means "any ONE of the previous quests", so a
/// quest with such a join and two or more MSQ prerequisites is a merge point of alternatives. For every
/// alternative, the quests that are ancestors of that alternative but of none of the others form its exclusive
/// branch (e.g. the whole Gridania chain). Nested merges (Ul'dah vs. Gridania+Limsa, then Gridania vs. Limsa) fall
/// out naturally: a quest can be exclusive to several (choice, option) pairs and applies only if all of them are
/// active. At evaluation time an option is active when the player has completed any quest in it; if no option of a
/// choice has any progress, only one representative option (the one earliest in the order) is counted, so the total
/// is not inflated by chains the character will never see.
/// </summary>
internal sealed class MsqModel
{
    private const int OrJoin = 2;
    private const string SectionPrefix = "Main Scenario";

    public sealed class MsqQuest
    {
        public uint Id { get; init; }
        public string Name { get; init; } = "";
        public int Level { get; init; }
        public int Expansion { get; init; }
        public string PlaceName { get; init; } = "";
        public string Genre { get; init; } = "";
        public uint SortKey { get; init; }
    }

    /// <summary>One merge point of mutually exclusive alternatives; Options[i] holds indices into <see cref="Data.Ordered"/>.</summary>
    public sealed class Choice
    {
        public uint MergeQuestId { get; init; }
        public int[][] Options { get; init; } = Array.Empty<int[]>();
    }

    public sealed class Data
    {
        public string[] Expansions { get; init; } = Array.Empty<string>();
        /// <summary>Every MSQ quest of every branch, in topological order.</summary>
        public MsqQuest[] Ordered { get; init; } = Array.Empty<MsqQuest>();
        public Choice[] Choices { get; init; } = Array.Empty<Choice>();
        /// <summary>Per quest (same index as Ordered): the (choice, option) pairs it is exclusive to.</summary>
        public (int Choice, int Option)[][] Memberships { get; init; } = Array.Empty<(int, int)[]>();
        public uint IconId { get; init; }
        public Dictionary<uint, int> IndexById { get; init; } = new();

        /// <summary>Which quests apply to a character with the given completion state (see class remarks).</summary>
        public bool[] ApplicableQuests(bool[] done)
        {
            var active = new bool[Choices.Length][];
            for (var c = 0; c < Choices.Length; c++)
            {
                var opts = Choices[c].Options;
                var a = new bool[opts.Length];
                var any = false;
                for (var o = 0; o < opts.Length; o++)
                    if (opts[o].Any(i => done[i])) { a[o] = true; any = true; }
                if (!any)
                {
                    // No progress in any option: count only the option whose first quest comes earliest in the order.
                    var best = 0;
                    for (var o = 1; o < opts.Length; o++)
                        if (opts[o].Min() < opts[best].Min()) best = o;
                    a[best] = true;
                }
                active[c] = a;
            }

            var applies = new bool[Ordered.Length];
            for (var i = 0; i < Ordered.Length; i++)
            {
                var ok = true;
                foreach (var (c, o) in Memberships[i])
                    if (!active[c][o]) { ok = false; break; }
                applies[i] = ok;
            }
            return applies;
        }

        /// <summary>Overall and per-expansion progress plus the next quest, given a completion predicate over quest row ids.</summary>
        public MsqSnapshot Evaluate(Func<uint, bool> isComplete, Func<uint, QuestInfo?> describe)
        {
            var done = new bool[Ordered.Length];
            for (var i = 0; i < done.Length; i++) done[i] = isComplete(Ordered[i].Id);
            var applies = ApplicableQuests(done);

            var totals = new int[Expansions.Length];
            var dones = new int[Expansions.Length];
            var doneAll = 0;
            var totalAll = 0;
            var next = -1;
            for (var i = 0; i < Ordered.Length; i++)
            {
                if (!applies[i]) continue;
                var e = Ordered[i].Expansion;
                totals[e]++;
                totalAll++;
                if (done[i]) { dones[e]++; doneAll++; }
                else if (next < 0) next = i;
            }

            var list = new List<ExpansionProgress>();
            for (var e = 0; e < Expansions.Length; e++)
                if (totals[e] > 0) list.Add(new ExpansionProgress(Expansions[e], dones[e], totals[e]));

            ExpansionProgress? current = null;
            if (next >= 0) current = list.FirstOrDefault(x => x.Expansion == Expansions[Ordered[next].Expansion]);
            else if (list.Count > 0) current = list[^1]; // everything done: show the latest expansion
            var nextInfo = next >= 0 ? describe(Ordered[next].Id) : null;
            return new MsqSnapshot(doneAll, totalAll, new MsqProgressInfo(list, current, nextInfo));
        }
    }

    private readonly GameData gd;
    private readonly object gate = new();
    private Task<Data>? building;
    private long retryAfterTicks; // after a failed build, wait before trying again (TryGetReady is polled at ~1 Hz)

    public MsqModel(GameData gd) => this.gd = gd;

    /// <summary>Starts the background build if needed. Completes when the model is usable.</summary>
    public Task<Data> GetAsync()
    {
        lock (gate)
        {
            var failed = building != null && (building.IsFaulted || building.IsCanceled);
            if (failed && retryAfterTicks == 0) retryAfterTicks = System.Diagnostics.Stopwatch.GetTimestamp() + 30 * System.Diagnostics.Stopwatch.Frequency;
            if (building == null || (failed && System.Diagnostics.Stopwatch.GetTimestamp() >= retryAfterTicks))
            {
                retryAfterTicks = 0;
                building = Task.Run(Build);
            }
            return building!;
        }
    }

    /// <summary>Non-blocking: kicks off the build and returns the model once it exists (never blocks the caller).</summary>
    public bool TryGetReady(out Data data)
    {
        var t = GetAsync();
        if (t.IsCompletedSuccessfully) { data = t.Result; return true; }
        data = null!;
        return false;
    }

    /// <summary>Name/level/expansion of any quest row; null for unknown rows. Cheap once the model has been built.</summary>
    public QuestInfo? Describe(uint questId)
    {
        var sheet = gd.GetExcelSheet<Quest>();
        if (sheet == null || !sheet.TryGetRow(questId, out var row)) return null;
        return ToInfo(row);
    }

    internal static QuestInfo ToInfo(Quest row) => new(
        row.RowId,
        row.Name.ToString(),
        Level(row),
        row.Expansion.ValueNullable?.Name.ToString() ?? "",
        row.PlaceName.ValueNullable?.Name.ToString() ?? "",
        row.JournalGenre.ValueNullable?.Name.ToString() ?? "");

    internal static int Level(Quest row) => row.ClassJobLevel.Count > 0 ? row.ClassJobLevel[0] : 0;

    private static bool IsMsq(Quest q)
    {
        if (string.IsNullOrWhiteSpace(q.Name.ToString())) return false;
        var section = q.JournalGenre.ValueNullable?.JournalCategory.ValueNullable?.JournalSection.ValueNullable?.Name.ToString();
        return section != null && section.StartsWith(SectionPrefix, StringComparison.Ordinal);
    }

    /// <summary>Synchronous build (public for the offline test app; production goes through <see cref="GetAsync"/>).</summary>
    public Data Build()
    {
        var sheet = gd.GetExcelSheet<Quest>()!;
        var msq = new Dictionary<uint, Quest>();
        foreach (var row in sheet)
            if (IsMsq(row)) msq[row.RowId] = row;

        // Effective MSQ prerequisites: direct MSQ prerequisites, plus - for prerequisites that are not MSQ quests
        // themselves - the MSQ quests behind them. Memoised; the visiting set guards against data cycles.
        var memo = new Dictionary<uint, uint[]>();
        var visiting = new HashSet<uint>();
        uint[] MsqPrereqs(uint id)
        {
            if (memo.TryGetValue(id, out var cached)) return cached;
            if (!visiting.Add(id) || !sheet.TryGetRow(id, out var row)) return Array.Empty<uint>();
            var result = new HashSet<uint>();
            foreach (var p in row.PreviousQuest)
            {
                if (p.RowId == 0) continue;
                if (msq.ContainsKey(p.RowId)) result.Add(p.RowId);
                else foreach (var x in MsqPrereqs(p.RowId)) result.Add(x);
            }
            visiting.Remove(id);
            var arr = result.ToArray();
            memo[id] = arr;
            return arr;
        }

        // Kahn's algorithm with a priority queue: always release the ready quest that sorts first.
        var ids = msq.Keys.ToArray();
        (int Exp, int Level, uint Sort, uint Id) Key(uint id) => ((int)msq[id].Expansion.RowId, Level(msq[id]), msq[id].SortKey, id);
        var indeg = new Dictionary<uint, int>();
        var dependents = ids.ToDictionary(i => i, _ => new List<uint>());
        var prereqs = new Dictionary<uint, uint[]>();
        foreach (var id in ids)
        {
            var p = MsqPrereqs(id).Where(x => x != id).ToArray();
            prereqs[id] = p;
            indeg[id] = p.Length;
            foreach (var x in p) dependents[x].Add(id);
        }
        var ready = new SortedSet<(int Exp, int Level, uint Sort, uint Id)>(ids.Where(i => indeg[i] == 0).Select(Key));
        var orderedIds = new List<uint>(ids.Length);
        while (ready.Count > 0)
        {
            var head = ready.Min;
            ready.Remove(head);
            orderedIds.Add(head.Id);
            foreach (var d in dependents[head.Id])
                if (--indeg[d] == 0) ready.Add(Key(d));
        }
        if (orderedIds.Count < ids.Length) // only if the data contains a prerequisite cycle
            orderedIds.AddRange(ids.Except(orderedIds).OrderBy(i => Key(i)));

        var expansions = gd.GetExcelSheet<ExVersion>()!.Select(e => e.Name.ToString()).ToArray();
        var indexById = new Dictionary<uint, int>();
        var ordered = new MsqQuest[orderedIds.Count];
        for (var i = 0; i < ordered.Length; i++)
        {
            var row = msq[orderedIds[i]];
            ordered[i] = new MsqQuest
            {
                Id = row.RowId,
                Name = row.Name.ToString(),
                Level = Level(row),
                Expansion = (int)Math.Min(row.Expansion.RowId, (uint)(expansions.Length - 1)),
                PlaceName = row.PlaceName.ValueNullable?.Name.ToString() ?? "",
                Genre = row.JournalGenre.ValueNullable?.Name.ToString() ?? "",
                SortKey = row.SortKey,
            };
            indexById[row.RowId] = i;
        }

        // Branch detection (see class remarks).
        var ancestorCache = new Dictionary<uint, HashSet<uint>>();
        HashSet<uint> Ancestors(uint id) // the quest itself plus all of its (effective) MSQ prerequisites
        {
            if (ancestorCache.TryGetValue(id, out var cached)) return cached;
            var set = new HashSet<uint>();
            var stack = new Stack<uint>();
            stack.Push(id);
            while (stack.Count > 0)
            {
                var x = stack.Pop();
                if (!set.Add(x)) continue;
                foreach (var p in prereqs[x]) stack.Push(p);
            }
            ancestorCache[id] = set;
            return set;
        }

        var choices = new List<Choice>();
        var memberships = new List<(int, int)>[ordered.Length];
        for (var i = 0; i < memberships.Length; i++) memberships[i] = new List<(int, int)>();
        foreach (var id in orderedIds)
        {
            if (msq[id].PreviousQuestJoin != OrJoin) continue;
            var alts = prereqs[id];
            if (alts.Length < 2) continue;
            var sets = alts.Select(Ancestors).ToArray();
            var options = new List<int[]>();
            for (var i = 0; i < alts.Length; i++)
            {
                var self = i;
                var exclusive = sets[self].Where(q => sets.Where((_, j) => j != self).All(s => !s.Contains(q)))
                    .Select(q => indexById[q]).OrderBy(x => x).ToArray();
                if (exclusive.Length > 0) options.Add(exclusive);
            }
            if (options.Count < 2) continue; // alternatives that share their whole history are not a real choice
            var ci = choices.Count;
            choices.Add(new Choice { MergeQuestId = id, Options = options.ToArray() });
            for (var o = 0; o < options.Count; o++)
                foreach (var q in options[o]) memberships[q].Add((ci, o));
        }

        // Tracker icon: the journal genre icon of the first MSQ quest.
        var iconId = 0u;
        if (ordered.Length > 0 && msq[ordered[0].Id].JournalGenre.ValueNullable is { } genre && genre.Icon > 0)
            iconId = (uint)genre.Icon;

        return new Data
        {
            Expansions = expansions,
            Ordered = ordered,
            Choices = choices.ToArray(),
            Memberships = memberships.Select(m => m.ToArray()).ToArray(),
            IconId = iconId,
            IndexById = indexById,
        };
    }
}
