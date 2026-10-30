using System.Collections.Generic;
using FFXIVClientStructs.FFXIV.Client.Game;

namespace SecondScreen;

/// <summary>
/// Shared "how many of item X does the player own" logic for <see cref="TrackerService"/> and <see cref="CharacterService"/>.
/// Must be called on the framework thread. Two places hold items: inventory containers (bags, armoury, equipped, crystals,
/// the Currency container, saddlebags) and <see cref="CurrencyManager"/> buckets, which hold scrips, Centurio/Allied seals,
/// Bicolor Gemstones and similar and are NOT in any InventoryContainer.
/// </summary>
internal static unsafe class ItemCounts
{
    /// <summary>Amount held of a currency: the Currency container first, then CurrencyManager. -1 when neither knows the item.</summary>
    public static long Currency(InventoryManager* inv, CurrencyManager* cm, uint itemId)
    {
        var cont = InventoryContainers.GetLoaded(inv, InventoryType.Currency);
        if (cont != null)
            for (var i = 0; i < cont->Size; i++)
            {
                var it = cont->Items + i;
                if (it->ItemId == itemId) return it->Quantity;
            }
        if (cm != null && cm->HasItem(itemId)) return cm->GetItemCount(itemId);
        return -1;
    }

    /// <summary>
    /// Totals (normal / HQ) for each wanted item id over every loaded player container (+ saddlebags if loaded), plus
    /// CurrencyManager buckets for ids the containers did not account for as a currency.
    /// </summary>
    public static Dictionary<uint, (long Nq, long Hq)> Count(HashSet<uint> wanted, out bool saddlebagLoaded)
    {
        var result = new Dictionary<uint, (long Nq, long Hq)>();
        saddlebagLoaded = false;
        var inv = InventoryManager.Instance();
        if (inv == null) return result;

        foreach (var d in InventoryContainers.Player) Scan(inv, d.Type, wanted, result);
        foreach (var d in InventoryContainers.Saddlebag)
            if (Scan(inv, d.Type, wanted, result)) saddlebagLoaded = true;

        // Special currencies (Bicolor Gemstone, scrips, seals, ...) live in CurrencyManager buckets, not in any container.
        var cm = CurrencyManager.Instance();
        if (cm != null)
        {
            var cur = new Dictionary<uint, (long Nq, long Hq)>();
            Scan(inv, InventoryType.Currency, wanted, cur);
            foreach (var id in wanted)
            {
                if (cur.ContainsKey(id) || !cm->HasItem(id)) continue; // already counted from the Currency container
                result.TryGetValue(id, out var c);
                c.Nq += cm->GetItemCount(id);
                result[id] = c;
            }
        }
        return result;
    }

    private static bool Scan(InventoryManager* inv, InventoryType type, HashSet<uint> wanted, Dictionary<uint, (long Nq, long Hq)> result)
    {
        var container = InventoryContainers.GetLoaded(inv, type);
        if (container == null) return false;
        for (var i = 0; i < container->Size; i++)
        {
            var item = container->Items + i;
            var id = item->ItemId;
            if (id == 0 || !wanted.Contains(id)) continue;
            result.TryGetValue(id, out var c);
            if (item->IsHighQuality()) c.Hq += item->Quantity; else c.Nq += item->Quantity;
            result[id] = c;
        }
        return true;
    }
}
