using QRCoder;

namespace SecondScreen;

/// <summary>
/// Builds the dark/light module grid for a QR code. Uses only QRCoder's managed encoder (no System.Drawing).
/// The returned grid is exactly the symbol (no quiet zone); callers add <see cref="QuietZone"/> modules of white.
/// </summary>
internal static class QrMatrix
{
    public const int QuietZone = 4;

    public static bool[,] Build(string text)
    {
        using var generator = new QRCodeGenerator();
        using var data = generator.CreateQrCode(text, QRCodeGenerator.ECCLevel.M);
        var matrix = data.ModuleMatrix;
        // QRCoder pads ModuleMatrix with its own quiet zone; strip it so we control the margin.
        var size = 17 + 4 * data.Version;
        var pad = (matrix.Count - size) / 2;
        var result = new bool[size, size];
        for (var y = 0; y < size; y++)
        {
            var row = matrix[y + pad];
            for (var x = 0; x < size; x++)
                result[y, x] = row[x + pad];
        }
        return result;
    }
}
