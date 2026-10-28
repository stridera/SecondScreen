using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using Dalamud.Plugin.Services;
using Lumina.Data.Files;
using Lumina.Excel.Sheets;

namespace SecondScreen;

/// <summary>
/// Map metadata + rendered PNG cache. Called from web threads; only touches Lumina data
/// (never game-object memory).
/// </summary>
internal sealed class MapService
{
    private const int MaxCachedImages = 8;

    private readonly IDataManager data;
    private readonly IPluginLog log;
    private readonly ConcurrentDictionary<uint, MapInfo> infos = new();
    private readonly ConcurrentDictionary<uint, string> markerJson = new(); // serialized StaticMarkerSet per map
    private readonly LinkedList<KeyValuePair<uint, byte[]>> lru = new(); // most recent first
    private readonly object lruGate = new();
    private readonly SemaphoreSlim renderGate = new(1, 1);

    public MapService(IDataManager data, IPluginLog log)
    {
        this.data = data;
        this.log = log;
    }

    public MapInfo? GetInfo(uint mapId)
    {
        if (infos.TryGetValue(mapId, out var cached)) return cached;
        var info = MapData.Describe(data.GetExcelSheet<Map>(), mapId);
        if (info != null) infos[mapId] = info;
        return info;
    }

    /// <summary>Static markers for a map as JSON (built from Lumina once, then cached), or null for an unknown map.</summary>
    public string? GetMarkersJson(uint mapId)
    {
        if (markerJson.TryGetValue(mapId, out var cached)) return cached;
        var set = MapMarkerData.Build(data.GetExcelSheet<Map>(), data.GetSubrowExcelSheet<MapMarker>(),
            data.GetExcelSheet<Aetheryte>(), data.GetExcelSheet<PlaceName>(), mapId);
        if (set == null) return null;
        return markerJson[mapId] = Json.Serialize(set);
    }

    public byte[]? GetPng(uint mapId)
    {
        if (TryGetCached(mapId, out var hit)) return hit;
        var info = GetInfo(mapId);
        if (info == null) return null;

        renderGate.Wait(); // serialise the (slow) encode so concurrent requests for one map don't repeat it
        try
        {
            if (TryGetCached(mapId, out hit)) return hit;
            var png = MapData.RenderPng(info, path => data.GetFile<TexFile>(path));
            if (png == null)
            {
                log.Warning("SecondScreen: map texture not found for map {MapId} ({Path})", mapId, MapData.TexturePath(info.Id));
                return null;
            }
            lock (lruGate)
            {
                lru.AddFirst(new KeyValuePair<uint, byte[]>(mapId, png));
                while (lru.Count > MaxCachedImages) lru.RemoveLast();
            }
            return png;
        }
        finally
        {
            renderGate.Release();
        }
    }

    private bool TryGetCached(uint mapId, out byte[]? png)
    {
        lock (lruGate)
        {
            for (var node = lru.First; node != null; node = node.Next)
            {
                if (node.Value.Key != mapId) continue;
                lru.Remove(node);
                lru.AddFirst(node);
                png = node.Value.Value;
                return true;
            }
        }
        png = null;
        return false;
    }
}
