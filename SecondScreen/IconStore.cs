using System;
using System.Collections.Generic;
using Lumina;
using Lumina.Data.Files;

namespace SecondScreen;

/// <summary>
/// Renders game icons (ui/icon/NNN000/NNNNNN.tex) to PNG with a small LRU cache. Dalamud-free (Lumina only).
/// Missing icons are cached as empty arrays so repeated 404s stay cheap.
/// </summary>
internal sealed class IconStore
{
    private const int MaxCached = 256;
    private static readonly byte[] Missing = Array.Empty<byte>();

    private readonly GameData gd;
    private readonly Dictionary<uint, LinkedListNode<KeyValuePair<uint, byte[]>>> map = new();
    private readonly LinkedList<KeyValuePair<uint, byte[]>> lru = new(); // most recent first
    private readonly object gate = new();

    public IconStore(GameData gd) => this.gd = gd;

    /// <summary>"ui/icon/065000/065001.tex" (folder = id / 1000 * 1000). hr1 = the 2x variant.</summary>
    public static string TexturePath(uint iconId, bool hr1 = false)
        => $"ui/icon/{iconId / 1000 * 1000:000000}/{iconId:000000}{(hr1 ? "_hr1" : "")}.tex";

    /// <summary>PNG bytes, or null when the icon does not exist.</summary>
    public byte[]? GetPng(uint iconId)
    {
        lock (gate)
        {
            if (map.TryGetValue(iconId, out var node))
            {
                lru.Remove(node);
                lru.AddFirst(node);
                return node.Value.Value.Length == 0 ? null : node.Value.Value;
            }
        }

        var png = Render(iconId);
        lock (gate)
        {
            if (!map.ContainsKey(iconId))
            {
                map[iconId] = lru.AddFirst(new KeyValuePair<uint, byte[]>(iconId, png ?? Missing));
                while (lru.Count > MaxCached)
                {
                    map.Remove(lru.Last!.Value.Key);
                    lru.RemoveLast();
                }
            }
        }
        return png;
    }

    private byte[]? Render(uint iconId)
    {
        // Prefer the 2x _hr1 texture (crisp on retina iPads at 44 css px); fall back to the base texture.
        var tex = TryLoad(TexturePath(iconId, true)) ?? TryLoad(TexturePath(iconId));
        if (tex == null) return null;
        return PngEncoder.EncodeBgra(tex.ImageData, tex.Header.Width, tex.Header.Height);
    }

    private TexFile? TryLoad(string path)
    {
        try { return gd.FileExists(path) ? gd.GetFile<TexFile>(path) : null; }
        catch { return null; }
    }
}
