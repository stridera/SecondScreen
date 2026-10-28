using System;
using System.Collections.Generic;
using System.Diagnostics;
using Dalamud.Game.ClientState.Objects.SubKinds;
using Dalamud.Plugin.Services;

namespace SecondScreen;

/// <summary>
/// The only component that touches game state. Runs on IFramework.Update, throttled to ~10 Hz,
/// and publishes an immutable <see cref="Snapshot"/> through a volatile field.
/// </summary>
internal sealed class Collector : IDisposable
{
    private static readonly long IntervalTicks = Stopwatch.Frequency / 10;

    private readonly IFramework framework;
    private readonly IClientState clientState;
    private readonly IObjectTable objectTable;
    private readonly IPartyList partyList;
    private readonly IPluginLog log;

    private volatile Snapshot current = Snapshot.Empty;
    private long lastTick;
    private bool errorLogged;

    public Collector(IFramework framework, IClientState clientState, IObjectTable objectTable, IPartyList partyList, IPluginLog log)
    {
        this.framework = framework;
        this.clientState = clientState;
        this.objectTable = objectTable;
        this.partyList = partyList;
        this.log = log;
        this.framework.Update += OnUpdate;
    }

    public Snapshot Current => current;

    public void Dispose() => framework.Update -= OnUpdate;

    private void OnUpdate(IFramework _)
    {
        var now = Stopwatch.GetTimestamp();
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

    private static PlayerInfo BuildPlayer(IPlayerCharacter p) => new(
        p.Name.TextValue,
        p.HomeWorld.ValueNullable?.Name.ToString() ?? "",
        p.ClassJob.ValueNullable?.Abbreviation.ToString() ?? "",
        p.Level,
        p.CurrentHp, p.MaxHp,
        p.CurrentMp, p.MaxMp,
        p.Position.X, p.Position.Y, p.Position.Z,
        p.Rotation);
}
