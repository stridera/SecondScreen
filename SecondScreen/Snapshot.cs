using System.Collections.Generic;

namespace SecondScreen;

public sealed record PlayerInfo(
    string Name,
    string World,
    string Job,
    int Level,
    uint Hp,
    uint MaxHp,
    uint Mp,
    uint MaxMp,
    float X,
    float Y,
    float Z,
    float Rotation);

public sealed record PartyMemberInfo(
    string Name,
    string Job,
    int Level,
    uint Hp,
    uint MaxHp,
    uint Mp,
    uint MaxMp,
    float X,
    float Y,
    float Z,
    uint TerritoryId,
    bool IsLocal);

/// <summary>Immutable view of game state. Built on the framework thread, read from web threads.</summary>
public sealed record Snapshot(
    long Timestamp,
    bool LoggedIn,
    PlayerInfo? Player,
    uint TerritoryId,
    uint MapId,
    IReadOnlyList<PartyMemberInfo> Party)
{
    public static readonly Snapshot Empty = new(0, false, null, 0, 0, System.Array.Empty<PartyMemberInfo>());
}
