using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;
using FFXIVClientStructs.FFXIV.Client.Game;
using FFXIVClientStructs.FFXIV.Client.Game.UI;
using Lumina;

namespace SecondScreen;

// ---- settings (persisted in Configuration.Dailies) -------------------------------------------------------------------------

/// <summary>Which checklist items are shown (per-id override of the default) and which region the Jumbo Cactpot timer follows.</summary>
public sealed class DailiesSettings
{
    /// <summary>Item id -> shown. Missing ids use the item's default.</summary>
    public Dictionary<string, bool> Items { get; set; } = new();

    /// <summary>One of <see cref="DailiesService.JumboRegions"/>; the draw time itself is computed by the web client.</summary>
    public string JumboRegion { get; set; } = "na";
}

// ---- DTOs (camelCase JSON, see GET /api/dailies) ---------------------------------------------------------------------------

public sealed class DailyPart
{
    public string Label { get; set; } = "";
    public int Value { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? Max { get; set; }
}

/// <summary>
/// One checklist row. Kind decides how the client renders Value/Max:
/// "flag" (Done only), "remaining" (allowances left: Value of Max, done at 0), "progress" (Value of Max, done at Max),
/// "info" (Value of Max, never counted as done) and "journal" (Wondrous Tails: State + Parts).
/// </summary>
public sealed class DailyItem
{
    public string Id { get; set; } = "";
    /// <summary>"daily" or "weekly".</summary>
    public string Group { get; set; } = "daily";
    public string Name { get; set; } = "";
    /// <summary>Game icon id (served by /api/icon); 0 = none, the client then draws the glyph.</summary>
    public uint IconId { get; set; }
    public string Glyph { get; set; } = "";
    public string Kind { get; set; } = "flag";
    public int Value { get; set; }
    public int Max { get; set; }
    public bool Done { get; set; }
    /// <summary>True for rows that are shown for information and do not count towards "n/m done".</summary>
    public bool Info { get; set; }
    public bool Enabled { get; set; } = true;
    public bool DefaultEnabled { get; set; } = true;
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? State { get; set; }
    /// <summary>Unix SECONDS of a game-reported event for this row (next leve refill, Wondrous Tails expiry).</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public long? At { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public List<DailyPart>? Parts { get; set; }
}

public sealed class DailiesModel
{
    public int Version { get; init; }
    /// <summary>Unix ms when this model was published.</summary>
    public long GeneratedAt { get; init; }
    public bool LoggedIn { get; init; }
    public string JumboRegion { get; init; } = "na";
    public IReadOnlyList<DailyItem> Items { get; init; } = Array.Empty<DailyItem>();
}

// ---- service ---------------------------------------------------------------------------------------------------------------

/// <summary>
/// Reads daily / weekly completion state straight from the game client (no other plugin involved) on the framework thread
/// at ~1 Hz and publishes an immutable JSON snapshot through a volatile field. Web threads only read the snapshot, or change
/// <see cref="DailiesSettings"/> under a lock (saved at once; changes are rare). <see cref="Version"/> moves only when the
/// published content (items or settings) actually changes, so clients can poll it cheaply from the WebSocket payload.
/// </summary>
internal sealed unsafe class DailiesService : IDisposable
{
    public static readonly string[] JumboRegions = { "na", "eu", "jp", "oce" };

    private const long EvalIntervalMs = 1000;
    private const int BeastTribeMax = 12;       // daily tribal quest allowances
    private const int LeveMax = 100;            // levequest allowance cap
    private const int WondrousTailsMax = 9;     // stickers per journal

    // Items that are not duty roulettes (fixed ids; persisted in settings, so never rename).
    private const string IdBeast = "beast", IdLeves = "leves", IdWt = "wt", IdDelivery = "delivery", IdTomestone = "tomestone";

    private sealed record Roulette(byte Id, string Name, uint IconId, int Sort);

    private readonly IFramework framework;
    private readonly IClientState clientState;
    private readonly IDalamudPluginInterface pi;
    private readonly Configuration config;
    private readonly IPluginLog log;
    private readonly IReadOnlyList<Roulette> roulettes;
    private readonly HashSet<string> knownIds;
    private readonly object gate = new(); // guards config.Dailies

    private sealed record Published(int Version, string Json);

    private volatile Published published = new(0, "{\"version\":0,\"loggedIn\":false,\"items\":[]}");
    private volatile bool evalNow = true;
    private long lastEval = long.MinValue / 2;
    private string lastSig = "";
    private int version;
    private bool errorLogged;

    public DailiesService(IFramework framework, IClientState clientState, IDalamudPluginInterface pi, Configuration config, IPluginLog log, GameData gameData)
    {
        this.framework = framework;
        this.clientState = clientState;
        this.pi = pi;
        this.config = config;
        this.log = log;
        roulettes = LoadRoulettes(gameData, log);
        knownIds = new HashSet<string>(roulettes.Select(r => RouletteKey(r.Id))) { IdBeast, IdLeves, IdWt, IdDelivery, IdTomestone };
        this.framework.Update += OnUpdate;
    }

    /// <summary>Changes whenever the published model changes (sent as dailiesVersion in the WebSocket payload).</summary>
    public int Version => published.Version;

    /// <summary>JSON for GET /api/dailies (immutable snapshot).</summary>
    public string GetJson() => published.Json;

    public void Dispose() => framework.Update -= OnUpdate;

    // ---- settings (any thread) ---------------------------------------------------------------------------------------

    /// <summary>Applies a partial settings update. Unknown item ids and invalid regions are rejected with ArgumentException.</summary>
    public void UpdateSettings(IReadOnlyDictionary<string, bool>? items, string? jumboRegion)
    {
        if (jumboRegion != null && !JumboRegions.Contains(jumboRegion)) throw new ArgumentException("Unknown Jumbo Cactpot region");
        if (items != null && items.Keys.Any(k => !knownIds.Contains(k))) throw new ArgumentException("Unknown item id");
        lock (gate)
        {
            var s = config.Dailies ??= new DailiesSettings();
            s.Items ??= new();
            if (items != null) foreach (var kv in items) s.Items[kv.Key] = kv.Value;
            if (jumboRegion != null) s.JumboRegion = jumboRegion;
            try { pi.SavePluginConfig(config); }
            catch (Exception ex) { log.Warning(ex, "SecondScreen: saving dailies settings failed"); }
        }
        evalNow = true;
    }

    // ---- framework thread --------------------------------------------------------------------------------------------

    private static long NowMs() => System.Diagnostics.Stopwatch.GetTimestamp() * 1000 / System.Diagnostics.Stopwatch.Frequency;

    private void OnUpdate(IFramework _)
    {
        try
        {
            var now = NowMs();
            if (!evalNow && now - lastEval < EvalIntervalMs) return;
            evalNow = false;
            lastEval = now;
            Publish();
            errorLogged = false;
        }
        catch (Exception ex)
        {
            if (!errorLogged) { log.Error(ex, "SecondScreen dailies update failed"); errorLogged = true; }
        }
    }

    private void Publish()
    {
        Dictionary<string, bool> overrides;
        string region;
        lock (gate)
        {
            var s = config.Dailies ??= new DailiesSettings();
            overrides = new Dictionary<string, bool>(s.Items ?? new());
            region = JumboRegions.Contains(s.JumboRegion) ? s.JumboRegion : "na";
        }

        var loggedIn = clientState.IsLoggedIn;
        var items = loggedIn ? Read() : new List<DailyItem>();
        foreach (var it in items) it.Enabled = overrides.TryGetValue(it.Id, out var on) ? on : it.DefaultEnabled;

        // Version moves only when the content changes (the timestamp is deliberately not part of the signature).
        var sig = Json.Serialize(new { loggedIn, region, items });
        if (sig == lastSig) return;
        lastSig = sig;
        var model = new DailiesModel
        {
            Version = ++version,
            GeneratedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            LoggedIn = loggedIn,
            JumboRegion = region,
            Items = items,
        };
        published = new Published(model.Version, Json.Serialize(model));
    }

    private List<DailyItem> Read()
    {
        var list = new List<DailyItem>();
        var ps = PlayerState.Instance();
        if (ps == null || !ps->IsLoaded) return list;

        // Daily: duty roulettes. InstanceContent.IsRouletteComplete takes the ContentRoulette row id.
        var ic = InstanceContent.Instance();
        if (ic != null)
        {
            foreach (var r in roulettes)
            {
                list.Add(new DailyItem
                {
                    Id = RouletteKey(r.Id), Group = "daily", Name = r.Name, IconId = r.IconId, Glyph = "roulette", Kind = "flag",
                    Done = ic->IsRouletteComplete(r.Id), DefaultEnabled = r.Id is not (4 or 7), // Guildhests / Frontline are opt-in
                });
            }
        }

        var qm = QuestManager.Instance();
        if (qm != null)
        {
            // Daily: tribal quests (allowances left today) and levequests (information only).
            var beast = (int)Math.Min(qm->GetBeastTribeAllowance(), (uint)BeastTribeMax);
            list.Add(new DailyItem { Id = IdBeast, Group = "daily", Name = "Tribal Quests", Glyph = "tribe", Kind = "remaining", Value = beast, Max = BeastTribeMax, Done = beast == 0 });

            var leves = Math.Clamp((int)qm->NumLeveAllowances, 0, LeveMax);
            long next = QuestManager.GetNextLeveAllowancesUnixTimestamp();
            list.Add(new DailyItem { Id = IdLeves, Group = "daily", Name = "Leve Allowances", Glyph = "leve", Kind = "info", Value = leves, Max = LeveMax, Info = true, At = next > 0 ? next : null });
        }

        // Weekly: Wondrous Tails.
        list.Add(ReadWondrousTails(ps));

        // Weekly: Custom Deliveries (allowances left this week).
        var sat = SatisfactionSupplyManager.Instance();
        if (sat != null)
        {
            var used = Math.Max(0, sat->GetUsedAllowances());
            var left = Math.Max(0, sat->GetRemainingAllowances());
            list.Add(new DailyItem { Id = IdDelivery, Group = "weekly", Name = "Custom Deliveries", Glyph = "delivery", Kind = "remaining", Value = left, Max = left + used, Done = left == 0 });
        }

        // Weekly: capped (limited) tomestone.
        var inv = InventoryManager.Instance();
        if (inv != null)
        {
            var limit = InventoryManager.GetLimitedTomestoneWeeklyLimit();
            if (limit > 0)
            {
                var got = Math.Clamp(inv->GetWeeklyAcquiredTomestoneCount(), 0, limit);
                list.Add(new DailyItem { Id = IdTomestone, Group = "weekly", Name = "Weekly Tomestones", Glyph = "tomestone", Kind = "progress", Value = got, Max = limit, Done = got >= limit });
            }
        }
        return list;
    }

    private static DailyItem ReadWondrousTails(PlayerState* ps)
    {
        var item = new DailyItem { Id = IdWt, Group = "weekly", Name = "Wondrous Tails", Glyph = "journal", Kind = "journal", Max = WondrousTailsMax };
        if (!ps->HasWeeklyBingoJournal)
        {
            // Never picked up, or already turned in: the game does not say which, so it must not block "all done".
            item.State = "none";
            item.Info = true;
            return item;
        }

        var placed = 0;
        var toPlace = 0;     // duties cleared whose sticker is not on the board yet
        var board = new bool[16];
        for (var i = 0; i < 16; i++)
        {
            board[i] = ps->IsWeeklyBingoStickerPlaced(i);
            if (board[i]) placed++;
            else if (ps->GetWeeklyBingoTaskStatus(i) == PlayerState.WeeklyBingoTaskStatus.Claimable) toPlace++;
        }
        placed = Math.Max(placed, Math.Min(ps->WeeklyBingoNumPlacedStickers, WondrousTailsMax));

        // 4x4 board: rows, columns and both diagonals; rewards unlock at 1, 2 and 3 lines.
        var lines = 0;
        for (var r = 0; r < 4; r++)
        {
            if (board[r * 4] && board[r * 4 + 1] && board[r * 4 + 2] && board[r * 4 + 3]) lines++;
            if (board[r] && board[4 + r] && board[8 + r] && board[12 + r]) lines++;
        }
        if (board[0] && board[5] && board[10] && board[15]) lines++;
        if (board[3] && board[6] && board[9] && board[12]) lines++;

        var expired = ps->IsWeeklyBingoExpired();
        item.Value = placed;
        item.State = expired ? "expired" : placed >= WondrousTailsMax ? "complete" : "active";
        item.Done = !expired && placed >= WondrousTailsMax;
        var expireAt = ps->GetWeeklyBingoExpireUnixTimestamp();
        if (expireAt > 0) item.At = expireAt;
        item.Parts = new List<DailyPart>
        {
            new() { Label = "Stickers", Value = placed, Max = WondrousTailsMax },
            new() { Label = "Lines", Value = Math.Min(lines, 3), Max = 3 },
            new() { Label = "To place", Value = toPlace },
            new() { Label = "Second chance", Value = (int)ps->WeeklyBingoNumSecondChancePoints },
        };
        return item;
    }

    // ---- Lumina ------------------------------------------------------------------------------------------------------

    private static string RouletteKey(byte id) => $"roulette:{id}";

    /// <summary>
    /// The daily duty roulettes: ContentRoulette rows with a CompletionArrayIndex (the bit the game keeps its "done today"
    /// flag in). Chocobo races, Crystalline Conflict etc. have -1 and are not daily.
    /// </summary>
    private static IReadOnlyList<Roulette> LoadRoulettes(GameData gd, IPluginLog log)
    {
        var list = new List<Roulette>();
        try
        {
            var sheet = gd.GetExcelSheet<Lumina.Excel.Sheets.ContentRoulette>();
            if (sheet != null)
            {
                foreach (var r in sheet)
                {
                    if (r.CompletionArrayIndex < 0 || r.RowId > byte.MaxValue) continue;
                    var name = r.Name.ExtractText();
                    if (string.IsNullOrWhiteSpace(name)) continue;
                    foreach (var prefix in new[] { "Duty Roulette: ", "Daily Challenge: " })
                        if (name.StartsWith(prefix, StringComparison.Ordinal)) name = name.Substring(prefix.Length);
                    list.Add(new Roulette((byte)r.RowId, name, r.Image, r.SortKey));
                }
            }
        }
        catch (Exception ex)
        {
            log.Warning(ex, "SecondScreen: could not read the ContentRoulette sheet");
        }
        return list.OrderBy(r => r.Sort).ThenBy(r => r.Id).ToList();
    }
}
