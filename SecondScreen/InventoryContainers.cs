using FFXIVClientStructs.FFXIV.Client.Game;

namespace SecondScreen;

/// <summary>
/// The inventory containers SecondScreen knows about, shared by <see cref="TrackerService"/> (item counts) and
/// <see cref="InventoryService"/> (the inventory widget). Group ids are part of the /api/inventory contract.
/// </summary>
internal static unsafe class InventoryContainers
{
    public const string GroupBags = "bags";
    public const string GroupEquipped = "equipped";
    public const string GroupArmoury = "armoury";
    public const string GroupCrystals = "crystals";
    public const string GroupCurrency = "currency";
    public const string GroupSaddlebag = "saddlebag";

    public readonly record struct Def(InventoryType Type, string Id, string Group, string Label);

    /// <summary>Always-available containers of the logged-in character. Retainers and the armoire/glamour dresser are not covered.</summary>
    public static readonly Def[] Player =
    {
        new(InventoryType.Inventory1, "Inventory1", GroupBags, "Bag 1"),
        new(InventoryType.Inventory2, "Inventory2", GroupBags, "Bag 2"),
        new(InventoryType.Inventory3, "Inventory3", GroupBags, "Bag 3"),
        new(InventoryType.Inventory4, "Inventory4", GroupBags, "Bag 4"),
        new(InventoryType.EquippedItems, "EquippedItems", GroupEquipped, "Equipped"),
        new(InventoryType.ArmoryMainHand, "ArmoryMainHand", GroupArmoury, "Main Hand"),
        new(InventoryType.ArmoryOffHand, "ArmoryOffHand", GroupArmoury, "Off Hand"),
        new(InventoryType.ArmoryHead, "ArmoryHead", GroupArmoury, "Head"),
        new(InventoryType.ArmoryBody, "ArmoryBody", GroupArmoury, "Body"),
        new(InventoryType.ArmoryHands, "ArmoryHands", GroupArmoury, "Hands"),
        new(InventoryType.ArmoryWaist, "ArmoryWaist", GroupArmoury, "Waist"),
        new(InventoryType.ArmoryLegs, "ArmoryLegs", GroupArmoury, "Legs"),
        new(InventoryType.ArmoryFeets, "ArmoryFeets", GroupArmoury, "Feet"),
        new(InventoryType.ArmoryEar, "ArmoryEar", GroupArmoury, "Ears"),
        new(InventoryType.ArmoryNeck, "ArmoryNeck", GroupArmoury, "Neck"),
        new(InventoryType.ArmoryWrist, "ArmoryWrist", GroupArmoury, "Wrists"),
        new(InventoryType.ArmoryRings, "ArmoryRings", GroupArmoury, "Rings"),
        new(InventoryType.ArmorySoulCrystal, "ArmorySoulCrystal", GroupArmoury, "Soul Crystals"),
        new(InventoryType.Crystals, "Crystals", GroupCrystals, "Crystals"),
        new(InventoryType.Currency, "Currency", GroupCurrency, "Currency"),
        new(InventoryType.KeyItems, "KeyItems", GroupCurrency, "Key Items"),
    };

    /// <summary>Only loaded while the saddlebag window has been opened; the inventory widget caches the last copy.</summary>
    public static readonly Def[] Saddlebag =
    {
        new(InventoryType.SaddleBag1, "SaddleBag1", GroupSaddlebag, "Saddlebag 1"),
        new(InventoryType.SaddleBag2, "SaddleBag2", GroupSaddlebag, "Saddlebag 2"),
        new(InventoryType.PremiumSaddleBag1, "PremiumSaddleBag1", GroupSaddlebag, "Premium Saddlebag 1"),
        new(InventoryType.PremiumSaddleBag2, "PremiumSaddleBag2", GroupSaddlebag, "Premium Saddlebag 2"),
    };

    /// <summary>Retainer containers (only loaded while a retainer is open). Label = the per-item container tag.</summary>
    public static readonly Def[] Retainer =
    {
        new(InventoryType.RetainerPage1, "RetainerPage1", "retainer", "Inventory"),
        new(InventoryType.RetainerPage2, "RetainerPage2", "retainer", "Inventory"),
        new(InventoryType.RetainerPage3, "RetainerPage3", "retainer", "Inventory"),
        new(InventoryType.RetainerPage4, "RetainerPage4", "retainer", "Inventory"),
        new(InventoryType.RetainerPage5, "RetainerPage5", "retainer", "Inventory"),
        new(InventoryType.RetainerPage6, "RetainerPage6", "retainer", "Inventory"),
        new(InventoryType.RetainerPage7, "RetainerPage7", "retainer", "Inventory"),
        new(InventoryType.RetainerEquippedItems, "RetainerEquippedItems", "retainer", "Equipped"),
        new(InventoryType.RetainerCrystals, "RetainerCrystals", "retainer", "Crystals"),
        new(InventoryType.RetainerMarket, "RetainerMarket", "retainer", "Market"),
    };

    /// <summary>The container if it exists and is loaded with usable item memory, else null.</summary>
    public static InventoryContainer* GetLoaded(InventoryManager* inv, InventoryType type)
    {
        var container = inv->GetInventoryContainer(type);
        return container == null || !container->IsLoaded || container->Items == null ? null : container;
    }
}
