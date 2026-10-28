using System;
using System.IO;
using System.IO.Compression;

namespace SecondScreen;

/// <summary>
/// Minimal self-contained PNG writer (no System.Drawing / no external packages).
/// Input is tightly packed B8G8R8A8 (what Lumina's TexFile.ImageData returns); output is 8-bit RGB when every
/// pixel is opaque (about 25% smaller) or RGBA otherwise, using the Paeth filter on every scanline.
/// </summary>
internal static class PngEncoder
{
    private static readonly uint[] CrcTable = BuildCrcTable();

    public static byte[] EncodeBgra(ReadOnlySpan<byte> bgra, int width, int height)
    {
        if (width <= 0 || height <= 0) throw new ArgumentException("Invalid image size");
        if (bgra.Length < (long)width * height * 4) throw new ArgumentException("Pixel buffer too small");

        var opaque = true;
        for (var i = 3; i < width * height * 4; i += 4)
            if (bgra[i] != 255) { opaque = false; break; }

        var bpp = opaque ? 3 : 4;
        var stride = width * bpp;

        using var idat = new MemoryStream();
        using (var z = new ZLibStream(idat, CompressionLevel.Optimal, leaveOpen: true))
        {
            var prev = new byte[stride];
            var cur = new byte[stride];
            var line = new byte[stride + 1];
            line[0] = 4; // filter type 4 = Paeth
            for (var y = 0; y < height; y++)
            {
                var src = bgra.Slice(y * width * 4, width * 4);
                for (int x = 0, o = 0; x < width; x++, o += bpp)
                {
                    cur[o] = src[x * 4 + 2];     // R
                    cur[o + 1] = src[x * 4 + 1]; // G
                    cur[o + 2] = src[x * 4];     // B
                    if (!opaque) cur[o + 3] = src[x * 4 + 3];
                }
                for (var i = 0; i < stride; i++)
                {
                    int a = i >= bpp ? cur[i - bpp] : 0;
                    int b = prev[i];
                    int c = i >= bpp ? prev[i - bpp] : 0;
                    var p = a + b - c;
                    var pa = Math.Abs(p - a);
                    var pb = Math.Abs(p - b);
                    var pc = Math.Abs(p - c);
                    var pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
                    line[i + 1] = (byte)(cur[i] - pred);
                }
                z.Write(line, 0, line.Length);
                (prev, cur) = (cur, prev);
            }
        }

        using var png = new MemoryStream(checked((int)idat.Length + 128));
        png.Write(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A });

        var ihdr = new byte[13];
        WriteBe(ihdr, 0, (uint)width);
        WriteBe(ihdr, 4, (uint)height);
        ihdr[8] = 8;                          // bit depth
        ihdr[9] = (byte)(opaque ? 2 : 6);     // colour type: 2 = RGB, 6 = RGBA
        // ihdr[10..12] = compression 0, filter 0, interlace 0
        WriteChunk(png, "IHDR", ihdr, ihdr.Length);
        WriteChunk(png, "IDAT", idat.GetBuffer(), (int)idat.Length);
        WriteChunk(png, "IEND", Array.Empty<byte>(), 0);
        return png.ToArray();
    }

    private static void WriteChunk(Stream s, string type, byte[] data, int length)
    {
        var head = new byte[8];
        WriteBe(head, 0, (uint)length);
        for (var i = 0; i < 4; i++) head[4 + i] = (byte)type[i];
        s.Write(head, 0, 8);
        s.Write(data, 0, length);
        var crc = 0xFFFFFFFFu;
        for (var i = 4; i < 8; i++) crc = CrcTable[(crc ^ head[i]) & 0xFF] ^ (crc >> 8);
        for (var i = 0; i < length; i++) crc = CrcTable[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
        crc ^= 0xFFFFFFFFu;
        var tail = new byte[4];
        WriteBe(tail, 0, crc);
        s.Write(tail, 0, 4);
    }

    private static void WriteBe(byte[] b, int o, uint v)
    {
        b[o] = (byte)(v >> 24); b[o + 1] = (byte)(v >> 16); b[o + 2] = (byte)(v >> 8); b[o + 3] = (byte)v;
    }

    private static uint[] BuildCrcTable()
    {
        var t = new uint[256];
        for (uint n = 0; n < 256; n++)
        {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            t[n] = c;
        }
        return t;
    }
}
