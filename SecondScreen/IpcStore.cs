using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace SecondScreen;

public sealed record IpcEntry(long Updated, JsonElement Value);

/// <summary>Thread-safe store of the latest value published by each plugin/key.</summary>
internal sealed class IpcStore
{
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, IpcEntry>> data = new();

    public void Publish(string plugin, string key, string json)
    {
        if (string.IsNullOrWhiteSpace(plugin) || string.IsNullOrWhiteSpace(key)) return;

        JsonElement value;
        try
        {
            using var doc = JsonDocument.Parse(json ?? "null");
            value = doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            // Not valid JSON: keep it as a plain string so nothing is lost.
            value = JsonSerializer.SerializeToElement(json);
        }

        var entry = new IpcEntry(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), value);
        data.GetOrAdd(plugin, _ => new()).AddOrUpdate(key, entry, (_, _) => entry);
    }

    public void Clear(string plugin) => data.TryRemove(plugin, out _);

    public void ClearAll() => data.Clear();

    public Dictionary<string, Dictionary<string, IpcEntry>> ToDictionary() =>
        data.ToDictionary(p => p.Key, p => p.Value.ToDictionary(k => k.Key, k => k.Value));
}
