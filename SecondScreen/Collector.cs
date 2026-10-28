using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using Dalamud.Game.ClientState.Fates;
using Dalamud.Game.ClientState.Objects.Enums;
using Dalamud.Game.ClientState.Objects.SubKinds;
using Dalamud.Game.Text.SeStringHandling;
using Dalamud.Plugin.Services;
using FFXIVClientStructs.FFXIV.Client.UI.Agent;
using Lumina.Excel;
using Lumina.Excel.Sheets;

namespace SecondScreen;

/// <summary>
/// The only component that touches game state. Runs on IFramework.Update, throttled to ~10 Hz,
/// and publishes an immutable <see cref="Snapshot"/> through a volatile field. A slower (~1 Hz) pass builds
/// <see cref="LiveMarkers"/> (FATEs, gathering nodes, quest markers, map flag) the same way.
/// </summary>
internal sealed unsafe class Collector : IDisposable
{
    private static readonly long IntervalTicks = Stopwatch.Frequency / 10;
    private static readonly long LiveIntervalTicks = Stopwatch.Frequency; // 1 Hz
    private const int MaxGathering = 80;
    private const int QuestSlots = 20; // QuestLinkContainer capacity

    private readonly IFramework framework;
    private readonly IClientState clientState;
    private readonly IObjectTable objectTable;
    private readonly IPartyList partyList;
    private readonly IFateTable fateTable;
    private readonly IPluginLog log;
    private readonly ExcelSheet<Level>? levels;
    private readonly ExcelSheet<Quest>? quests;
    private readonly ExcelSheet<GatheringPoint>? gatheringPoints;
    private readonly Dictionary<uint, (int Level, uint Icon)> gatherInfo = new(); // framework thread only

    private volatile Snapshot current = Snapshot.Empty;
    private volatile LiveMarkers live = LiveMarkers.Empty;
    private long lastTick;
    private long lastLiveTick;
    private long liveSeq;
    private bool errorLogged;
    private bool liveErrorLogged;

    public Collector(IFramework framework, IClientState clientState, IObjectTable objectTable, IPartyList partyList,
        IFateTable fateTable, IDataManager data, IPluginLog log)
    {
        this.framework = framework;
        this.clientState = clientState;
        this.objectTable = objectTable;
        this.partyList = partyList;
        this.fateTable = fateTable;
        this.log = log;
        levels = data.GetExcelSheet<Level>();
        quests = data.GetExcelSheet<Quest>();
        gatheringPoints = data.GetExcelSheet<GatheringPoint>();
        this.framework.Update += OnUpdate;
    }

    public Snapshot Current => current;

    /// <summary>Slow-changing markers (about 1 Hz). Replaced wholesale; <see cref="LiveMarkers.Seq"/> bumps on every rebuild.</summary>
    public LiveMarkers Live => live;

    public void Dispose() => framework.Update -= OnUpdate;

    private void OnUpdate(IFramework _)
    {
        var now = Stopwatch.GetTimestamp();
        if (now - lastLiveTick >= LiveIntervalTicks)
        {
            lastLiveTick = now;
            try
            {
                live = BuildLive();
                liveErrorLogged = false;
            }
            catch (Exception ex)
            {
                if (!liveErrorLogged)
                {
                    log.Error(ex, "SecondScreen live marker collection failed");
                    liveErrorLogged = true;
                }
            }
        }

        if (now - lastTick < IntervalTicks) return;
        lastTick = now;

        try
        {
            current = Build();
            errorLogged = false;
        }
        catch (Exception ex)
        {
            if (!errorLogged)
            {
                log.Error(ex, "SecondScreen collector failed");
                errorLogged = true;
            }
        }
    }

    private Snapshot Build()
    {
        var ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var loggedIn = clientState.IsLoggedIn;
        var local = loggedIn ? objectTable.LocalPlayer : null;
        if (local == null)
            return new Snapshot(ts, loggedIn, null, clientState.TerritoryType, clientState.MapId, Array.Empty<PartyMemberInfo>());

        var player = BuildPlayer(local);

        var party = new List<PartyMemberInfo>(partyList.Length);
        foreach (var m in partyList)
        {
            var name = m.Name.TextValue;
            party.Add(new PartyMemberInfo(
                name,
                m.ClassJob.ValueNullable?.Abbreviation.ToString() ?? "",
                m.Level,
                m.CurrentHP, m.MaxHP,
                m.CurrentMP, m.MaxMP,
                m.Position.X, m.Position.Y, m.Position.Z,
                m.Territory.RowId,
                name == player.Name));
        }

        return new Snapshot(ts, true, player, clientState.TerritoryType, clientState.MapId, party);
    }

    // ---- live markers (framework thread, ~1 Hz) ----------------------------------------------------

    private LiveMarkers BuildLive()
    {
        var local = clientState.IsLoggedIn ? objectTable.LocalPlayer : null;
        if (local == null) return LiveMarkers.Empty;

        var mapId = clientState.MapId;
        var ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var playerPos = local.Position;

        // FATEs (IFateTable only holds the current zone's FATEs).
        var fates = new List<FateMarker>();
        foreach (var f in fateTable)
        {
            if (f == null || f.State is FateState.Ended or FateState.Failed) continue;
            var pos = f.Position;
            var icon = f.MapIconId != 0 ? f.MapIconId : f.IconId;
            fates.Add(new FateMarker(f.FateId, f.Name.TextValue, pos.X, pos.Y, pos.Z, f.Radius, f.Progress,
                f.TimeRemaining, f.Level, f.MaxLevel, icon, f.State.ToString()));
        }

        // Gathering nodes: only targetable (currently spawned / visible) GatheringPoint objects, nearest first.
        var gathering = new List<(float Dist, GatherMarker Marker)>();
        foreach (var o in objectTable)
        {
            if (o == null || o.ObjectKind != ObjectKind.GatheringPoint || !o.IsTargetable) continue;
            var pos = o.Position;
            var (level, icon) = GatherInfo(o.BaseId);
            var dx = pos.X - playerPos.X;
            var dz = pos.Z - playerPos.Z;
            gathering.Add((dx * dx + dz * dz, new GatherMarker(o.EntityId, o.Name.TextValue, pos.X, pos.Y, pos.Z, level, icon)));
        }
        var gather = gathering.OrderBy(g => g.Dist).Take(MaxGathering).Select(g => g.Marker).ToList();

        // Game map state (AgentMap): quest objective markers and the map flag.
        var questMarkers = new List<QuestMarker>();
        FlagMarker? flag = null;
        var agent = AgentMap.Instance();
        if (agent != null)
        {
            // MiniMapQuestLinkContainer is refreshed continuously (the minimap is always up), unlike the
            // window's MapQuestLinkContainer. A QuestLinkMarker has no position of its own: LevelId is a Level
            // sheet row (world X/Y/Z) that must belong to the map we are looking at.
            var container = &agent->MiniMapQuestLinkContainer;
            var count = Math.Min((int)container->MarkerCount, QuestSlots);
            var span = container->Markers;
            var seen = new HashSet<(uint, uint)>();
            for (var i = 0; i < count; i++)
            {
                ref var q = ref span[i];
                if (q.Valid == 0 || q.LevelId == 0) continue;
                if (levels == null || !levels.TryGetRow(q.LevelId, out var lv) || lv.Map.RowId != mapId) continue;
                if (!seen.Add((q.QuestId, q.LevelId))) continue;
                questMarkers.Add(new QuestMarker(q.QuestId, QuestName(ref q), lv.X, lv.Y, lv.Z, q.RecommendedLevel, q.IconId));
            }

            // FlagMapMarker.XFloat / YFloat are world X / Z (cf. AgentMap.SetFlagMapMarker(territory, map, worldPosition, icon)).
            if (agent->FlagMarkerCount > 0)
            {
                ref var fm = ref agent->FlagMapMarkers[0];
                if (fm.MapId == mapId) flag = new FlagMarker(fm.XFloat, fm.YFloat, fm.MapMarker.IconId);
            }
        }

        return new LiveMarkers(++liveSeq, ts, clientState.TerritoryType, mapId, fates, gather, questMarkers, flag);
    }

    private string QuestName(ref FFXIVClientStructs.FFXIV.Client.UI.Agent.QuestLinkMarker q)
    {
        try
        {
            var text = SeString.Parse(q.TooltipText.AsSpan()).TextValue.Trim();
            if (text.Length > 0) return text;
        }
        catch { /* fall through to the Quest sheet */ }
        // Quest row ids are 65536 + the 16-bit id stored in the marker.
        return quests != null && quests.TryGetRow(65536u + q.QuestId, out var row) ? row.Name.ToString() : "";
    }

    private (int Level, uint Icon) GatherInfo(uint baseId)
    {
        if (gatherInfo.TryGetValue(baseId, out var cached)) return cached;
        var level = 0;
        uint icon = 0;
        if (gatheringPoints != null && gatheringPoints.TryGetRow(baseId, out var gp) && gp.GatheringPointBase.ValueNullable is { } b)
        {
            level = b.GatheringLevel;
            icon = (uint)(b.GatheringType.ValueNullable?.IconMain ?? 0);
        }
        return gatherInfo[baseId] = (level, icon);
    }

    // World is the HOME world (not the current/visiting one); the data center and region derive from it (Universalis prices by home DC).
    private static PlayerInfo BuildPlayer(IPlayerCharacter p) => new(
        p.Name.TextValue,
        p.HomeWorld.ValueNullable?.Name.ToString() ?? "",
        p.ClassJob.ValueNullable?.Abbreviation.ToString() ?? "",
        p.Level,
        p.CurrentHp, p.MaxHp,
        p.CurrentMp, p.MaxMp,
        p.Position.X, p.Position.Y, p.Position.Z,
        p.Rotation,
        p.HomeWorld.RowId,
        p.HomeWorld.ValueNullable?.DataCenter.ValueNullable?.Name.ToString() ?? "",
        p.HomeWorld.ValueNullable?.DataCenter.ValueNullable?.Region.ValueNullable?.Name.ToString() ?? "");
}
