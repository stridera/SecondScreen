using System.Collections.Concurrent;
using Lumina;
using Lumina.Excel.Sheets;

namespace SecondScreen;

/// <summary>Static item data for the inventory widget (sent once per id in /api/inventory "items").</summary>
public sealed record ItemInfo(
    uint Id,
    string Name,
    uint IconId,
    int Ilvl,
    string Category,
    uint StackSize,
    bool Untradable,
    byte Rarity,
    bool Gear);

/// <summary>
/// Lumina-backed lookups for the inventory widget: item info, retainer venture names and job abbreviations.
/// Dalamud-free so an offline console app can exercise the same code. Thread-safe; results are cached.
/// </summary>
internal sealed class ItemInfoStore
{
    private const uint HqOffset = 1_000_000;
    private const uint CollectableOffset = 500_000;

    private readonly GameData gd;
    private readonly ConcurrentDictionary<uint, ItemInfo?> items = new();
    private readonly ConcurrentDictionary<uint, string> tasks = new();
    private readonly ConcurrentDictionary<byte, string> jobs = new();

    public ItemInfoStore(GameData gd) => this.gd = gd;

    /// <summary>Strips the HQ (+1,000,000) / collectable (+500,000) offsets some APIs add to an item id.</summary>
    public static uint BaseId(uint id) => id >= HqOffset ? id - HqOffset : id >= CollectableOffset ? id - CollectableOffset : id;

    public ItemInfo? GetItem(uint itemId)
    {
        var id = BaseId(itemId);
        if (id == 0) return null;
        return items.GetOrAdd(id, Load);
    }

    private ItemInfo? Load(uint id)
    {
        try
        {
            if (!gd.GetExcelSheet<Item>()!.TryGetRow(id, out var row)) return null;
            var category = row.ItemUICategory.ValueNullable?.Name.ToString() ?? "";
            return new ItemInfo(id, row.Name.ToString(), row.Icon, (int)row.LevelItem.RowId, category,
                row.StackSize, row.IsUntradable, row.Rarity, row.EquipSlotCategory.RowId != 0);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Venture name for a RetainerTask row id ("Mythril Ore", "Quick Exploration", ...). Never null.</summary>
    public string RetainerTaskName(uint taskId) => tasks.GetOrAdd(taskId, LoadTask);

    private string LoadTask(uint taskId)
    {
        try
        {
            if (!gd.GetExcelSheet<RetainerTask>()!.TryGetRow(taskId, out var task)) return $"Venture #{taskId}";
            string? name = null;
            if (task.Task.RowId != 0)
            {
                if (task.IsRandom)
                {
                    if (gd.GetExcelSheet<RetainerTaskRandom>()!.TryGetRow(task.Task.RowId, out var random))
                        name = random.Name.ToString();
                }
                else if (gd.GetExcelSheet<RetainerTaskNormal>()!.TryGetRow(task.Task.RowId, out var normal))
                {
                    name = normal.Item.ValueNullable?.Name.ToString();
                }
            }
            return string.IsNullOrWhiteSpace(name) ? $"Venture #{taskId}" : name;
        }
        catch
        {
            return $"Venture #{taskId}";
        }
    }

    /// <summary>ClassJob row id to its abbreviation ("BTN"); empty for 0 / unknown.</summary>
    public string ClassJobAbbreviation(byte classJobId)
    {
        if (classJobId == 0) return "";
        return jobs.GetOrAdd(classJobId, id =>
        {
            try { return gd.GetExcelSheet<ClassJob>()!.TryGetRow(id, out var row) ? row.Abbreviation.ToString() : ""; }
            catch { return ""; }
        });
    }
}
