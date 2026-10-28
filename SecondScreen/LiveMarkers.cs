using System.Collections.Generic;

namespace SecondScreen;

// Live (slow, ~1 Hz) map markers. All positions are WORLD coordinates (X east, Z south, Y up); the web client
// converts to map pixels with the same formula as the player marker.

public sealed record FateMarker(
    uint Id,
    string Name,
    float X,
    float Y,
    float Z,
    float Radius,
    int Progress,
    long TimeRemaining, // seconds left at collection time (<= 0 when there is no running timer)
    int Level,
    int MaxLevel,
    uint IconId,
    string State);

public sealed record GatherMarker(
    uint Id,
    string Name,
    float X,
    float Y,
    float Z,
    int Level,
    uint IconId);

public sealed record QuestMarker(
    uint QuestId,
    string Name,
    float X,
    float Y,
    float Z,
    int Level,
    uint IconId);

public sealed record FlagMarker(float X, float Z, uint IconId);

/// <summary>Immutable slow-changing marker set. Built on the framework thread at ~1 Hz, read from web threads.</summary>
public sealed record LiveMarkers(
    long Seq,
    long Timestamp,
    uint TerritoryId,
    uint MapId,
    IReadOnlyList<FateMarker> Fates,
    IReadOnlyList<GatherMarker> Gathering,
    IReadOnlyList<QuestMarker> Quests,
    FlagMarker? Flag)
{
    public static readonly LiveMarkers Empty = new(0, 0, 0, 0,
        System.Array.Empty<FateMarker>(), System.Array.Empty<GatherMarker>(), System.Array.Empty<QuestMarker>(), null);
}
