using System;
using System.Collections.Generic;
using Lumina.Excel;
using Lumina.Excel.Sheets;

namespace SecondScreen;

/// <summary>One static marker from the MapMarker sheet. X/Y are pixels on the 2048px map texture.</summary>
public sealed record StaticMarker(int X, int Y, uint IconId, string Label, string Category);

/// <summary>Response body of GET /api/map/{mapId}/markers.</summary>
public sealed record StaticMarkerSet(uint MapId, IReadOnlyList<StaticMarker> Markers);

/// <summary>
/// Static map markers from the Lumina MapMarker sheet (Dalamud-free so an offline console test can run it).
///
/// Source: Map.MapMarkerRange is the row id into the MapMarker subrow sheet; each subrow is one marker.
/// Coordinates: MapMarker.X / Y are already pixels on the 2048x2048 map texture (verified against the
/// Aetheryte sheet world positions: px = (world + offset) * sizeFactor / 100 + 1024), so no conversion
/// is needed server side. The client turns them into in-game coordinates with the usual formula.
///
/// Categories (see <see cref="Categorize"/>):
///   aetheryte  DataType 3 (main aetheryte, DataKey = Aetheryte row) and DataType 4 (aethernet shard,
///              DataKey = PlaceName row of the shard name; DataType 2 also names itself via DataKey = PlaceName).
///   transition DataType 1 with an icon (link to another map, DataKey = Map row; text-only links are labels), plus dungeon/raid entrances (icons
///              60414, 60428), stairs/floor links (60446, 60447), area exits (60441, 60467, 60971) and
///              ferry / airship / pier travel points (60339, 60352, 60456).
///   label      Text-only markers (icon 0 with a name: area, region and town names) and named landmark
///              pins (icon 60442).
///   service    DataType 0 markers with a service icon: guild icons 60311..60364 (except travel icons),
///              vendors, inns, mailboxes, grand company, boards etc. (see ServiceIcons).
///   other      Everything else (housing plots DataType 5, unknown icons).
/// Placeholder rows (no icon and no name) are dropped.
/// </summary>
internal static class MapMarkerData
{
    public const string Aetheryte = "aetheryte";
    public const string Label = "label";
    public const string Service = "service";
    public const string Transition = "transition";
    public const string Other = "other";

    private static readonly HashSet<uint> TransitionIcons = new() { 60339, 60352, 60414, 60428, 60441, 60446, 60447, 60456, 60467, 60971 };

    private static readonly HashSet<uint> ServiceIcons = new()
    {
        60412, 60425, 60426, 60427, 60434, 60436, 60448, 60551, 60567, 60568, 60569, 60570, 60571,
        60581, 60582, 60768, 60910, 60926, 60927, 60935, 60959, 60960,
    };

    public static StaticMarkerSet? Build(ExcelSheet<Map> maps, SubrowExcelSheet<MapMarker> markers,
        ExcelSheet<Aetheryte> aetherytes, ExcelSheet<PlaceName> placeNames, uint mapId)
    {
        if (!maps.TryGetRow(mapId, out var map)) return null;
        var result = new List<StaticMarker>();
        if (map.MapMarkerRange != 0 && markers.TryGetRow(map.MapMarkerRange, out var rows))
        {
            foreach (var m in rows)
            {
                var icon = (uint)m.Icon;
                var label = m.PlaceNameSubtext.ValueNullable?.Name.ToString().Trim() ?? "";

                if (m.DataType == 3 && aetherytes.TryGetRow(m.DataKey.RowId, out var a))
                {
                    var name = a.PlaceName.ValueNullable?.Name.ToString().Trim() ?? "";
                    if (name.Length > 0) label = name;
                }
                else if (m.DataType is 2 or 4 && label.Length == 0 && placeNames.TryGetRow(m.DataKey.RowId, out var pn))
                {
                    label = pn.Name.ToString().Trim();
                }
                else if (m.DataType == 1 && label.Length == 0
                         && maps.TryGetRow(m.DataKey.RowId, out var target))
                {
                    label = target.PlaceName.ValueNullable?.Name.ToString().Trim() ?? "";
                }

                if (icon == 0 && label.Length == 0) continue; // placeholder row
                var category = Categorize(m.DataType, icon, label.Length > 0);
                result.Add(new StaticMarker(m.X, m.Y, icon, label, category));
            }
        }
        return new StaticMarkerSet(mapId, result);
    }

    public static string Categorize(byte dataType, uint icon, bool hasLabel)
    {
        switch (dataType)
        {
            case 3:
            case 4: return Aetheryte;
            case 1: return icon == 0 ? Label : Transition;
            case 2: return icon == 0 && hasLabel ? Label : Other;
            case 0: break;
            default: return Other;
        }
        if (icon == 0) return hasLabel ? Label : Other;
        if (icon == 60442) return Label;
        if (TransitionIcons.Contains(icon)) return Transition;
        if (icon is >= 60311 and <= 60364 || ServiceIcons.Contains(icon)) return Service;
        return Other;
    }
}
