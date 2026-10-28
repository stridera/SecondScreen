using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Lumina;
using Lumina.Excel.Sheets;

namespace SecondScreen;

/// <summary>One search hit / lookup result. Subtitle is the item category, the achievement description or "Lv X (middle dot) Expansion (middle dot) Journal genre" for quests.</summary>
public sealed record SearchResult(uint Id, string Name, uint IconId, string Subtitle);

/// <summary>
/// Lazily built, cached, case-insensitive name index over the Item, Achievement and Quest sheets.
/// Dalamud-free (Lumina only) so an offline console app can exercise the same code. Safe to call from any thread;
/// the index is built once on a thread-pool thread, never on the game thread.
/// </summary>
internal sealed class GameSearch
{
    public const string KindItem = "item";
    public const string KindAchievement = "achievement";
    public const string KindQuest = "quest";
    public const int MaxResults = 25;
    public const int MinQueryLength = 2;

    // Alt = secondary searchable text (an achievement's reward title, e.g. "Guardian Angel"); empty for items.
    // Sub = precomputed subtitle (quests only).
    private sealed record Entry(uint Id, string Name, string Lower, uint IconId, uint Aux, string Alt = "", string Sub = "");

    private sealed class Index
    {
        public Entry[] Items = Array.Empty<Entry>();
        public Entry[] Achievements = Array.Empty<Entry>();
        public Entry[] Quests = Array.Empty<Entry>();
        public Dictionary<uint, Entry> ItemById = new();
        public Dictionary<uint, Entry> AchievementById = new();
        public Dictionary<uint, Entry> QuestById = new();
    }

    private readonly GameData gd;
    private readonly object gate = new();
    private Task<Index>? building;

    public GameSearch(GameData gd) => this.gd = gd;

    public static bool IsKnownKind(string? kind) => kind == KindItem || kind == KindAchievement || kind == KindQuest;

    /// <summary>Starts the background build if it has not started yet. Completes when the index is usable.</summary>
    public Task WarmUpAsync() => GetIndexAsync();

    public async Task<IReadOnlyList<SearchResult>> SearchAsync(string kind, string query, int limit = MaxResults)
    {
        var q = (query ?? "").Trim().ToLowerInvariant();
        if (q.Length < MinQueryLength || !IsKnownKind(kind)) return Array.Empty<SearchResult>();
        var index = await GetIndexAsync().ConfigureAwait(false);
        var entries = kind == KindItem ? index.Items : kind == KindQuest ? index.Quests : index.Achievements;

        // rank: 0 exact, 1 prefix, 2 word start, 3 other substring, 4 reward-title match; then shorter names first, then id
        var hits = new List<(int Rank, int Len, uint Id, Entry E)>();
        foreach (var e in entries)
        {
            var at = e.Lower.IndexOf(q, StringComparison.Ordinal);
            int rank;
            if (at >= 0) rank = at == 0 ? (e.Lower.Length == q.Length ? 0 : 1) : e.Lower[at - 1] == ' ' ? 2 : 3;
            else if (e.Alt.Length > 0 && e.Alt.Contains(q, StringComparison.Ordinal)) rank = 4; // matched the reward title only
            else continue;
            hits.Add((rank, e.Lower.Length, e.Id, e));
        }
        hits.Sort((a, b) =>
        {
            var c = a.Rank.CompareTo(b.Rank);
            if (c != 0) return c;
            c = a.Len.CompareTo(b.Len);
            return c != 0 ? c : a.Id.CompareTo(b.Id);
        });

        var results = new List<SearchResult>(Math.Min(limit, hits.Count));
        for (var i = 0; i < hits.Count && i < limit; i++) results.Add(ToResult(kind, hits[i].E));
        return results;
    }

    /// <summary>Exact lookup by sheet row id (used to validate and name a new tracker).</summary>
    public async Task<SearchResult?> FindAsync(string kind, uint id)
    {
        if (!IsKnownKind(kind)) return null;
        var index = await GetIndexAsync().ConfigureAwait(false);
        var map = kind == KindItem ? index.ItemById : kind == KindQuest ? index.QuestById : index.AchievementById;
        return map.TryGetValue(id, out var e) ? ToResult(kind, e) : null;
    }

    private Task<Index> GetIndexAsync()
    {
        lock (gate)
        {
            if (building == null || building.IsFaulted || building.IsCanceled)
                building = Task.Run(Build);
            return building;
        }
    }

    private SearchResult ToResult(string kind, Entry e)
    {
        if (kind == KindAchievement) return new SearchResult(e.Id, e.Name, e.IconId, AchievementDescription(e.Id));
        if (kind == KindQuest) return new SearchResult(e.Id, e.Name, e.IconId, e.Sub);
        var category = "";
        if (e.Aux != 0 && gd.GetExcelSheet<ItemUICategory>()!.TryGetRow(e.Aux, out var cat))
            category = cat.Name.ToString();
        return new SearchResult(e.Id, e.Name, e.IconId, category);
    }

    private string AchievementDescription(uint id)
    {
        if (!gd.GetExcelSheet<Achievement>()!.TryGetRow(id, out var row)) return "";
        var text = row.Description.ToString();
        var title = row.Title.ValueNullable?.Masculine.ToString() ?? "";
        return title.Length > 0 ? $"{text} (Title: {title})" : text;
    }

    private Index Build()
    {
        var index = new Index();

        var items = new List<Entry>(50000);
        foreach (var row in gd.GetExcelSheet<Item>()!)
        {
            var name = row.Name.ToString();
            if (string.IsNullOrWhiteSpace(name)) continue;
            items.Add(new Entry(row.RowId, name, name.ToLowerInvariant(), row.Icon, row.ItemUICategory.RowId));
        }

        var achievements = new List<Entry>(3000);
        foreach (var row in gd.GetExcelSheet<Achievement>()!)
        {
            var name = row.Name.ToString();
            if (string.IsNullOrWhiteSpace(name)) continue;
            var title = row.Title.ValueNullable?.Masculine.ToString() ?? "";
            achievements.Add(new Entry(row.RowId, name, name.ToLowerInvariant(), row.Icon, 0, title.ToLowerInvariant()));
        }

        var quests = new List<Entry>(6000);
        foreach (var row in gd.GetExcelSheet<Quest>()!)
        {
            var name = row.Name.ToString();
            if (string.IsNullOrWhiteSpace(name)) continue;
            var genre = row.JournalGenre.ValueNullable;
            var parts = new List<string> { $"Lv {MsqModel.Level(row)}" };
            var expansion = row.Expansion.ValueNullable?.Name.ToString();
            if (!string.IsNullOrEmpty(expansion)) parts.Add(expansion);
            var genreName = genre?.Name.ToString();
            if (!string.IsNullOrEmpty(genreName)) parts.Add(genreName);
            // The journal genre icon (small, e.g. the MSQ marker) rather than Quest.Icon, which is a large banner image.
            var icon = genre is { Icon: > 0 } g ? (uint)g.Icon : 0u;
            quests.Add(new Entry(row.RowId, name, name.ToLowerInvariant(), icon, 0, "", string.Join(" \u00B7 ", parts)));
        }

        index.Items = items.ToArray();
        index.Achievements = achievements.ToArray();
        index.Quests = quests.ToArray();
        foreach (var e in index.Items) index.ItemById[e.Id] = e;
        foreach (var e in index.Achievements) index.AchievementById[e.Id] = e;
        foreach (var e in index.Quests) index.QuestById[e.Id] = e;
        return index;
    }
}
