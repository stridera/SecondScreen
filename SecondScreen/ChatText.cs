using System.Collections.Generic;
using System.Text;
using Dalamud.Game.Text.SeStringHandling;
using Dalamud.Game.Text.SeStringHandling.Payloads;

namespace SecondScreen;

/// <summary>
/// SeString to plain text for the chat widget. Item links become "[Item Name]", private-use glyphs from the game's font are
/// mapped to something readable (or dropped), formatting payloads (colour, glow, italics) are ignored. Depends only on the
/// SeString payload classes (no Dalamud services), so it can be exercised offline.
/// </summary>
internal static class ChatText
{
    public const int MaxLength = 1000;

    public static string ToText(SeString? s)
    {
        if (s == null) return "";
        var sb = new StringBuilder();
        // Link payloads (item, player, map, status, quest, party finder) wrap their visible text in the payload and a link terminator.
        var open = new Stack<PayloadType>();
        foreach (var p in s.Payloads)
        {
            switch (p)
            {
                case TextPayload t:
                    AppendGlyphs(sb, t.Text ?? "");
                    break;
                case NewLinePayload:
                    sb.Append('\n');
                    break;
                case SeHyphenPayload:
                    sb.Append('-');
                    break;
                case AutoTranslatePayload at:
                    sb.Append('\u00AB');
                    try { AppendGlyphs(sb, at.Text ?? ""); }
                    catch { sb.Append("..."); } // resolved from game sheets; never let a bad lookup drop the whole line
                    sb.Append('\u00BB');
                    break;
                case IconPayload ip:
                    AppendIcon(sb, ip.Icon);
                    break;
                case RawPayload raw:
                    if (raw.Equals(RawPayload.LinkTerminator) && open.Count > 0)
                    {
                        if (open.Pop() == PayloadType.Item) sb.Append(']');
                    }
                    break;
                default:
                    switch (p.Type)
                    {
                        case PayloadType.Item:
                            open.Push(PayloadType.Item);
                            sb.Append('[');
                            break;
                        case PayloadType.Player:
                        case PayloadType.MapLink:
                        case PayloadType.Status:
                        case PayloadType.Quest:
                        case PayloadType.PartyFinder:
                        case PayloadType.DalamudLink:
                            open.Push(p.Type);
                            break;
                    }
                    break;
            }
            if (sb.Length > MaxLength * 2) break;
        }
        while (open.Count > 0) if (open.Pop() == PayloadType.Item) sb.Append(']'); // unbalanced link: close the bracket anyway
        return Clean(sb.ToString());
    }

    /// <summary>Sender name text without game glyphs (party slot numbers are dropped); trimmed.</summary>
    public static string SenderName(SeString? s)
    {
        if (s == null) return "";
        var sb = new StringBuilder();
        foreach (var p in s.Payloads)
            if (p is TextPayload t) AppendGlyphs(sb, t.Text ?? "", keepPartyNumbers: false);
        return Clean(sb.ToString());
    }

    private static void AppendIcon(StringBuilder sb, BitmapFontIcon icon)
    {
        // Most bitmap icons next to names are decoration (cross-world marker, role, mentor badges). Keep the few that carry meaning.
        switch (icon)
        {
            case BitmapFontIcon.Warning: sb.Append('\u26A0'); break;
            case BitmapFontIcon.Crafter: sb.Append("[Crafting]"); break;
            case BitmapFontIcon.Gatherer: sb.Append("[Gathering]"); break;
        }
    }

    private static void AppendGlyphs(StringBuilder sb, string text, bool keepPartyNumbers = true)
    {
        foreach (var c in text)
        {
            // Game-font private-use glyphs.
            
            switch (c)
            {
                case '\uE03C': sb.Append(" (HQ)"); break;            // high-quality marker after item names
                case '\uE03D': sb.Append(" (collectable)"); break;
                case '\uE040': sb.Append('\u00AB'); break;           // auto-translate brackets
                case '\uE041': sb.Append('\u00BB'); break;
                case '\uE06F': sb.Append('\u2192'); break;           // right arrow
                case '\uE0BB': break;                                // link arrow in front of item / map links
                case >= '\uE090' and <= '\uE097':                    // party slot 1-8 in front of party member names
                    if (keepPartyNumbers) sb.Append((char)('\u2460' + (c - '\uE090')));
                    break;
                case >= '\uE000' and <= '\uF8FF': break;             // any other private-use glyph has no readable equivalent
                default: sb.Append(c); break;
            }
        }
    }

    private static string Clean(string text)
    {
        text = text.Trim().Replace("\r", "");
        if (text.Length > MaxLength) text = text.Substring(0, MaxLength) + "\u2026";
        return text;
    }
}
