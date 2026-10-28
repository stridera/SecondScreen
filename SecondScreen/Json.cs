using System.Text.Json;

namespace SecondScreen;

internal static class Json
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DictionaryKeyPolicy = null,
        IncludeFields = false,
    };

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);
}
