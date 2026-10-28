using System;
using Lumina.Data.Files;
using Lumina.Excel;
using Lumina.Excel.Sheets;

namespace SecondScreen;

/// <summary>Static metadata for one map (row of the Map sheet). Immutable, safe to share across threads.</summary>
public sealed record MapInfo(
    uint MapId,
    string Id,
    int SizeFactor,
    int OffsetX,
    int OffsetY,
    string Region,
    string Zone,
    string SubArea,
    string Name,
    uint TerritoryId);

/// <summary>
/// Dalamud-free map helpers (Lumina only) so the same code can be exercised by an offline console test.
/// </summary>
internal static class MapData
{
    /// <summary>Map textures are always 2048x2048 px.</summary>
    public const int TextureSize = 2048;

    public static MapInfo? Describe(ExcelSheet<Map> maps, uint mapId)
    {
        if (!maps.TryGetRow(mapId, out var m)) return null;
        var id = m.Id.ToString();
        if (string.IsNullOrEmpty(id)) return null;

        var region = m.PlaceNameRegion.ValueNullable?.Name.ToString() ?? "";
        var zone = m.PlaceName.ValueNullable?.Name.ToString() ?? "";
        var sub = m.PlaceNameSub.ValueNullable?.Name.ToString() ?? "";
        var territory = m.TerritoryType.ValueNullable;
        if (zone.Length == 0) zone = territory?.PlaceName.ValueNullable?.Name.ToString() ?? "";
        if (region.Length == 0) region = territory?.PlaceNameRegion.ValueNullable?.Name.ToString() ?? "";

        return new MapInfo(mapId, id, m.SizeFactor, m.OffsetX, m.OffsetY, region, zone, sub,
            zone.Length > 0 ? zone : sub, m.TerritoryType.RowId);
    }

    /// <summary>"w1f2/00" -> "ui/map/w1f2/00/w1f200_m.tex"</summary>
    public static string TexturePath(string id) => $"ui/map/{id}/{id.Replace("/", "")}_m.tex";

    public static byte[]? RenderPng(MapInfo info, Func<string, TexFile?> getFile)
    {
        var tex = getFile(TexturePath(info.Id));
        if (tex == null) return null;
        // TexFile.ImageData is the first mip converted to tightly packed B8G8R8A8.
        return PngEncoder.EncodeBgra(tex.ImageData, tex.Header.Width, tex.Header.Height);
    }

    // Coordinate math (matches Dalamud.Utility.MapUtil.ConvertWorldCoordXZToMapCoord):
    //   c       = SizeFactor / 100
    //   pixel   = (world + Offset) * c + 1024            (position on the 2048px texture; world X -> px X, world Z -> px Y)
    //   display = 41 / c * (pixel / 2048) + 1             (the "X: 12.3 Y: 34.5" shown in game)
    public static double ToPixel(double world, int offset, int sizeFactor) => (world + offset) * (sizeFactor / 100.0) + 1024.0;

    public static double ToDisplay(double world, int offset, int sizeFactor)
        => 41.0 / (sizeFactor / 100.0) * (ToPixel(world, offset, sizeFactor) / TextureSize) + 1.0;
}
