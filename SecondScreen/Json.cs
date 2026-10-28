using System.Text;
using System.Text.Json;

namespace SecondScreen;

internal static class Json
{
    /// <summary>UTF-8 without a byte-order mark (Encoding.UTF8 emits EF BB BF in HTTP bodies).</summary>
    public static readonly Encoding Utf8NoBom = new UTF8Encoding(false);

    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DictionaryKeyPolicy = null,
        IncludeFields = false,
    };

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);
}
