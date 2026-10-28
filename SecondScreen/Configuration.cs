using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using Dalamud.Configuration;

namespace SecondScreen;

[Serializable]
public sealed class Configuration : IPluginConfiguration
{
    public int Version { get; set; } = 3;

    public int Port { get; set; } = DefaultPort;
    public const int DefaultPort = 47435;
    public bool BindAll { get; set; } = true;
    public string AccessToken { get; set; } = string.Empty;
    public bool AutoStart { get; set; } = true;

    /// <summary>IP the user last picked for the QR code; null when no choice is saved.</summary>
    public string? QrAddress { get; set; }

    /// <summary>Tracker tab definitions (v3). Only access through TrackerService, which locks around it.</summary>
    public List<TrackerDef> Trackers { get; set; } = new();

    /// <summary>Extra words that raise a "mention" notification when they appear in chat (edited from the web UI).</summary>
    public List<string> NotifyKeywords { get; set; } = new();

    /// <summary>Applies config migrations. Returns true if the config changed.</summary>
    public bool Migrate()
    {
        var changed = false;
        if (Version < 2)
        {
            // v1 default port 37435 sits inside a Windows range (36430-40525) that cannot be bound on some machines.
            if (Port == 37435) Port = DefaultPort;
            Version = 2;
            changed = true;
        }
        if (Version < 3)
        {
            // v3 adds Trackers. Older files deserialize without the property, so make sure it is never null.
            Trackers ??= new();
            Version = 3;
            changed = true;
        }
        if (Trackers == null) { Trackers = new(); changed = true; }
        // Drop corrupt/unusable rows rather than letting them poison the tab.
        if (Trackers.RemoveAll(t => t == null || string.IsNullOrEmpty(t.Id) || string.IsNullOrEmpty(t.Kind)) > 0)
            changed = true;
        return changed;
    }

    /// <summary>Generates a token if none exists. Returns true if the config changed.</summary>
    public bool EnsureToken()
    {
        if (!string.IsNullOrEmpty(AccessToken)) return false;
        AccessToken = GenerateToken();
        return true;
    }

    public static string GenerateToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(18);
        return Convert.ToBase64String(bytes).Replace('+', '-').Replace('/', '_');
    }
}
