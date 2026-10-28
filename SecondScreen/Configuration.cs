using System;
using System.Security.Cryptography;
using Dalamud.Configuration;

namespace SecondScreen;

[Serializable]
public sealed class Configuration : IPluginConfiguration
{
    public int Version { get; set; } = 2;

    public int Port { get; set; } = DefaultPort;
    public const int DefaultPort = 47435;
    public bool BindAll { get; set; } = true;
    public string AccessToken { get; set; } = string.Empty;
    public bool AutoStart { get; set; } = true;

    /// <summary>Applies config migrations. Returns true if the config changed.</summary>
    public bool Migrate()
    {
        if (Version >= 2) return false;
        // v1 default port 37435 sits inside a Windows range (36430-40525) that cannot be bound on some machines.
        if (Port == 37435) Port = DefaultPort;
        Version = 2;
        return true;
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
