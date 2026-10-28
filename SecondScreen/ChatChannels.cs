using System;
using System.Collections.Generic;
using Dalamud.Game.Text;

namespace SecondScreen;

/// <summary>Maps the game's XivChatType to the friendly channel ids the chat widget filters on (labels / colours live in tabs/chat.js).</summary>
internal static class ChatChannels
{
    /// <summary>Spammy types that are not recorded unless the user removes them from Configuration.ChatIgnoredTypes.</summary>
    public static readonly string[] DefaultIgnored =
    {
        nameof(XivChatType.Damage), nameof(XivChatType.Miss), nameof(XivChatType.Action), nameof(XivChatType.Item), nameof(XivChatType.Healing),
        nameof(XivChatType.GainBuff), nameof(XivChatType.GainDebuff), nameof(XivChatType.LoseBuff), nameof(XivChatType.LoseDebuff),
    };

    public static HashSet<XivChatType> ParseIgnored(IEnumerable<string>? names)
    {
        var set = new HashSet<XivChatType>();
        foreach (var n in names ?? DefaultIgnored)
            if (Enum.TryParse<XivChatType>(n, true, out var t)) set.Add(t);
        return set;
    }

    public static string Map(XivChatType t) => t switch
    {
        XivChatType.Say => "say",
        XivChatType.Shout => "shout",
        XivChatType.Yell => "yell",
        XivChatType.Party or XivChatType.CrossParty => "party",
        XivChatType.Alliance => "alliance",
        XivChatType.FreeCompany or XivChatType.FreeCompanyAnnouncement or XivChatType.FreeCompanyLoginLogout => "fc",
        XivChatType.TellIncoming => "tellin",
        XivChatType.TellOutgoing => "tellout",
        XivChatType.NoviceNetwork or XivChatType.NoviceNetworkSystem => "novice",
        XivChatType.Echo => "echo",
        XivChatType.CustomEmote or XivChatType.StandardEmote => "emote",
        XivChatType.Ls1 => "ls1", XivChatType.Ls2 => "ls2", XivChatType.Ls3 => "ls3", XivChatType.Ls4 => "ls4",
        XivChatType.Ls5 => "ls5", XivChatType.Ls6 => "ls6", XivChatType.Ls7 => "ls7", XivChatType.Ls8 => "ls8",
        XivChatType.CrossLinkShell1 => "cwls1", XivChatType.CrossLinkShell2 => "cwls2", XivChatType.CrossLinkShell3 => "cwls3",
        XivChatType.CrossLinkShell4 => "cwls4", XivChatType.CrossLinkShell5 => "cwls5", XivChatType.CrossLinkShell6 => "cwls6",
        XivChatType.CrossLinkShell7 => "cwls7", XivChatType.CrossLinkShell8 => "cwls8",
        XivChatType.Notice or XivChatType.Urgent or XivChatType.SystemMessage or XivChatType.SystemError or XivChatType.ErrorMessage
            or XivChatType.GatheringSystemMessage or XivChatType.Progress or XivChatType.LootNotice or XivChatType.LootRoll
            or XivChatType.Crafting or XivChatType.Gathering or XivChatType.RetainerSale or XivChatType.RandomNumber
            or XivChatType.Orchestrion or XivChatType.GlamourNotifications or XivChatType.Alarm or XivChatType.Sign
            or XivChatType.MessageBook => "system",
        _ => "other",
    };

    /// <summary>Types whose Sender is meaningful (someone spoke). For the rest the widget shows the text on its own.</summary>
    public static bool HasSpeaker(string channel) => channel is not ("system" or "other" or "echo");
}
