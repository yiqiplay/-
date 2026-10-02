using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.Versioning;
using System.Text;

namespace LanControl;

/// <summary>
/// 二维码生成器（字节模式，纠错等级 M，版本 1~10 自动选择）。
///
/// 本实现逐条移植自已验证的参考实现（npm qrcode 的 core，MIT，Kazuhiko Arase 原始算法），
/// 以便在不引入第三方依赖的前提下得到**真正能被扫码器读出**的二维码。
/// 版本 1..10 的 M 级都是单块结构，因此不需要块间交错。
///
/// 此前自研版本反复扫不出来的四个真实缺陷（均已修复，并由 tools/qr-decode.mjs 验收）：
///   1. 完全没写 Reed-Solomon 纠错码字；
///   2. RS 综合除法把 remainder[i] 自身异或掉（首一多项式 gen[0]=1），数据被破坏；
///   3. 定位图案保留区算错（应为 9×9：7×7 图案 + 一圈分隔符），侵占/丢失数据模块；
///   4. 格式信息两个副本的写入坐标错位。
/// </summary>
[SupportedOSPlatform("windows")]
internal static class QrCode
{
    private const int EcLevelBit = 0b00;    // M
    private const int MaskPattern = 0;      // (row + col) % 2 == 0

    /// <summary>各版本符号总码字数（数据 + 纠错）。</summary>
    private static readonly int[] TotalCodewords =
    {
        0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346
    };

    /// <summary>版本 1..10、纠错 M 的纠错码字总数。</summary>
    private static readonly int[] EcCodewordsM = { 0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26 };

    /// <summary>版本 1..10、纠错 M 的块数。</summary>
    private static readonly int[] BlocksM = { 0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5 };

    /* ======================= 对外接口 ======================= */

    public static Bitmap Render(string text, int pixelSize)
    {
        var matrix = Encode(text);
        int modules = matrix.GetLength(0);
        const int quiet = 4;
        int total = modules + quiet * 2;
        int scale = Math.Max(2, pixelSize / total);
        int size = total * scale;
        var bmp = new Bitmap(size, size, PixelFormat.Format24bppRgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.White);
            using var brush = new SolidBrush(Color.Black);
            for (int y = 0; y < modules; y++)
                for (int x = 0; x < modules; x++)
                    if (matrix[y, x])
                        g.FillRectangle(brush, (x + quiet) * scale, (y + quiet) * scale, scale, scale);
        }
        return bmp;
    }

    public static bool[,] Encode(string text)
    {
        var data = Encoding.UTF8.GetBytes(text);
        int version = 1;
        while (version <= 10 && AvailableDataBytes(version) < data.Length) version++;
        if (version > 10) throw new InvalidOperationException("内容过长，无法生成二维码");

        int size = version * 4 + 17;
        var m = new bool[size, size];
        var reserved = new bool[size, size];

        // ---- 功能图案 ----
        SetupFinderPattern(m, reserved, version);
        SetupTimingPattern(m, reserved);
        SetupAlignmentPattern(m, reserved, version);

        // 先用临时值占位，确保格式信息区被标记为保留（不参与掩码），稍后用正确值覆盖
        SetupFormatInfo(m, reserved, size, MaskPattern);

        // ---- 数据 ----
        var codewords = BuildCodewords(data, version);
        SetupData(m, reserved, size, codewords);

        // ---- 掩码 + 正确的格式信息 ----
        ApplyMask(m, reserved, size, MaskPattern);
        SetupFormatInfo(m, reserved, size, MaskPattern);

        LastReserved = reserved;
        LastVersion = version;
        return m;
    }

    internal static bool[,]? LastReserved { get; private set; }
    internal static int LastVersion { get; private set; }

    /* ======================= 功能图案（逐条对齐参考实现） ======================= */

    /// <summary>
    /// 定位图案：7×7 本体，外加一圈分隔符 —— 保留区共 9×9。
    /// 参考实现的循环是 r/c 取 -1..7（含图案外的两圈边界），这里保持一致。
    /// </summary>
    private static void SetupFinderPattern(bool[,] m, bool[,] r, int version)
    {
        int size = version * 4 + 17;
        foreach (var (row, col) in FinderPositions(version))
        {
            for (int rr = -1; rr <= 7; rr++)
            {
                if (row + rr <= -1 || row + rr >= size) continue;
                for (int cc = -1; cc <= 7; cc++)
                {
                    if (col + cc <= -1 || col + cc >= size) continue;
                    bool on = (rr >= 0 && rr <= 6 && (cc == 0 || cc == 6)) ||
                              (cc >= 0 && cc <= 6 && (rr == 0 || rr == 6)) ||
                              (rr >= 2 && rr <= 4 && cc >= 2 && cc <= 4);
                    m[row + rr, col + cc] = on;
                    r[row + rr, col + cc] = true;
                }
            }
        }
    }

    private static IEnumerable<(int row, int col)> FinderPositions(int version)
    {
        int size = version * 4 + 17;
        yield return (0, 0);
        yield return (0, size - 7);
        yield return (size - 7, 0);
    }

    /// <summary>定时图案：第 6 行与第 6 列，下标 8..size-9，偶数下标为深色。</summary>
    private static void SetupTimingPattern(bool[,] m, bool[,] r)
    {
        int size = m.GetLength(0);
        for (int i = 8; i < size - 8; i++)
        {
            bool on = i % 2 == 0;
            m[i, 6] = on; r[i, 6] = true;
            m[6, i] = on; r[6, i] = true;
        }
    }

    /// <summary>校正图案 5×5：外圈深色、内圈浅色、中心深色。</summary>
    private static void SetupAlignmentPattern(bool[,] m, bool[,] r, int version)
    {
        foreach (var (row, col) in AlignmentPositions(version))
        {
            for (int rr = -2; rr <= 2; rr++)
                for (int cc = -2; cc <= 2; cc++)
                {
                    bool on = rr == -2 || rr == 2 || cc == -2 || cc == 2 || (rr == 0 && cc == 0);
                    m[row + rr, col + cc] = on;
                    r[row + rr, col + cc] = true;
                }
        }
    }

    /// <summary>校正图案中心坐标（与参考实现同样的推导公式）。</summary>
    private static List<(int row, int col)> AlignmentPositions(int version)
    {
        var result = new List<(int, int)>();
        if (version == 1) return result;

        int size = version * 4 + 17;
        int posCount = version / 7 + 2;
        int intervals = size == 145 ? 26 : (int)Math.Ceiling((size - 13) / (2.0 * posCount - 2)) * 2;
        var positions = new List<int> { size - 7 };
        for (int i = 1; i < posCount - 1; i++)
            positions.Add(positions[i - 1] - intervals);
        positions.Add(6);
        positions.Reverse();

        int n = positions.Count;
        for (int i = 0; i < n; i++)
            for (int j = 0; j < n; j++)
            {
                if ((i == 0 && j == 0) || (i == 0 && j == n - 1) || (i == n - 1 && j == 0)) continue;
                result.Add((positions[i], positions[j]));
            }
        return result;
    }

    /* ======================= 格式信息 ======================= */

    /// <summary>
    /// 写入 15 位格式信息（含固定暗模块）。
    /// 坐标完全按参考实现：
    ///   纵向：i&lt;6 → (i,8)；i&lt;8 → (i+1,8)；否则 (size-15+i, 8)
    ///   横向：i&lt;8 → (8,size-i-1)；i&lt;9 → (8,15-i)；否则 (8,15-i-1)
    /// </summary>
    private static void SetupFormatInfo(bool[,] m, bool[,] r, int size, int mask)
    {
        int bits = FormatBits(EcLevelBit, mask);
        for (int i = 0; i < 15; i++)
        {
            bool mod = ((bits >> i) & 1) == 1;

            int vr, vc;
            if (i < 6) { vr = i; vc = 8; }
            else if (i < 8) { vr = i + 1; vc = 8; }
            else { vr = size - 15 + i; vc = 8; }
            m[vr, vc] = mod; r[vr, vc] = true;

            int hr, hc;
            if (i < 8) { hr = 8; hc = size - i - 1; }
            else if (i < 9) { hr = 8; hc = 15 - i; }
            else { hr = 8; hc = 15 - i - 1; }
            m[hr, hc] = mod; r[hr, hc] = true;
        }

        m[size - 8, 8] = true;   // 固定暗模块
        r[size - 8, 8] = true;
    }

    /// <summary>(15,5) BCH 格式信息，最后异或 0x5412。G15 = 0x537。</summary>
    private static int FormatBits(int ecBit, int mask)
    {
        const int G15 = 0x537;
        const int G15_MASK = 0x5412;
        int data = (ecBit << 3) | mask;
        int d = data << 10;
        while (BchDigit(d) - BchDigit(G15) >= 0)
            d ^= G15 << (BchDigit(d) - BchDigit(G15));
        return ((data << 10) | d) ^ G15_MASK;
    }

    /// <summary>最高有效位的位置（位数）。</summary>
    private static int BchDigit(int data)
    {
        int digit = 0;
        while (data != 0) { digit++; data = (int)((uint)data >> 1); }
        return digit;
    }

    /* ======================= 数据：码字与比特 ======================= */

    private static int DataCodewords(int version) => TotalCodewords[version] - EcCodewordsM[version];

    private static int AvailableDataBytes(int version)
    {
        int lengthBits = version >= 10 ? 16 : 8;
        return (DataCodewords(version) * 8 - 4 - lengthBits) / 8;
    }

    /// <summary>数据码字 + Reed-Solomon 纠错码字（版本 1..10 / M 级均为单块，无需交错）。</summary>
    private static byte[] BuildCodewords(byte[] data, int version)
    {
        int total = TotalCodewords[version];
        int ecCount = EcCodewordsM[version];
        int dataCount = total - ecCount;
        if (BlocksM[version] != 1) throw new InvalidOperationException("版本 " + version + " 不是单块结构");

        // ---- 位缓冲：模式 + 计数 + 数据 ----
        var bits = new List<bool>();
        void Put(int value, int length)
        {
            for (int i = length - 1; i >= 0; i--) bits.Add(((value >> i) & 1) == 1);
        }
        Put(0b0100, 4);                                        // 字节模式
        Put(data.Length, version >= 10 ? 16 : 8);              // 字符计数指示符
        foreach (var b in data) Put(b, 8);

        int dataBits = dataCount * 8;
        if (bits.Count > dataBits) throw new InvalidOperationException("数据超出容量");
        if (bits.Count + 4 <= dataBits) Put(0, 4);             // 结束符
        while (bits.Count % 8 != 0) bits.Add(false);           // 补齐字节

        var dataCw = new List<byte>(dataCount);
        for (int i = 0; i + 8 <= bits.Count; i += 8)
        {
            int v = 0;
            for (int j = 0; j < 8; j++) v = (v << 1) | (bits[i + j] ? 1 : 0);
            dataCw.Add((byte)v);
        }
        int remaining = (dataBits - bits.Count) / 8;
        for (int i = 0; i < remaining; i++) dataCw.Add(i % 2 == 1 ? (byte)0x11 : (byte)0xEC);

        var ec = ComputeErrorCorrection(dataCw.ToArray(), ecCount);
        var all = new byte[total];
        dataCw.CopyTo(all, 0);
        ec.CopyTo(all, dataCount);
        return all;
    }

    /// <summary>
    /// Reed-Solomon 纠错码字（GF(256)，本原多项式 0x11D）。
    /// 标准综合除法：只处理消息部分，且必须跳过 gen[0]（首一多项式首项为 1，
    /// 异或上去等于把当前字节清零 —— 这是早期版本扫码失败的根因之一）。
    /// </summary>
    private static byte[] ComputeErrorCorrection(byte[] data, int ecCount)
    {
        var gen = BuildGeneratorPolynomial(ecCount);
        var rem = new byte[data.Length + ecCount];
        Array.Copy(data, rem, data.Length);

        for (int i = 0; i < data.Length; i++)
        {
            byte factor = rem[i];
            if (factor == 0) continue;
            for (int j = 1; j < gen.Length; j++)
                rem[i + j] ^= (byte)GfMul(gen[j], factor);
        }

        var ec = new byte[ecCount];
        Array.Copy(rem, data.Length, ec, 0, ecCount);
        return ec;
    }

    private static byte[] BuildGeneratorPolynomial(int ecCount)
    {
        var poly = new byte[] { 1 };
        for (int i = 0; i < ecCount; i++)
        {
            var next = new byte[poly.Length + 1];
            for (int j = 0; j < poly.Length; j++)
            {
                next[j] ^= poly[j];
                next[j + 1] ^= (byte)GfMul(poly[j], GfPow(2, i));
            }
            poly = next;
        }
        return poly;
    }

    /* ---------- GF(256) ---------- */
    private static readonly byte[] GfExp = new byte[512];
    private static readonly byte[] GfLog = new byte[256];

    static QrCode()
    {
        int x = 1;
        for (int i = 0; i < 255; i++)
        {
            GfExp[i] = (byte)x;
            GfLog[x] = (byte)i;
            x <<= 1;
            if ((x & 0x100) != 0) x ^= 0x11D;
        }
        for (int i = 255; i < 512; i++) GfExp[i] = GfExp[i - 255];
    }

    private static int GfMul(int a, int b)
    {
        if (a == 0 || b == 0) return 0;
        return GfExp[GfLog[a] + GfLog[b]];
    }

    private static int GfPow(int a, int power)
    {
        if (power == 0) return 1;
        if (a == 0) return 0;
        return GfExp[(GfLog[a] * power) % 255];
    }

    /* ======================= 数据放置与掩码 ======================= */

    /// <summary>
    /// 数据放置：与参考实现逐行等价 —— 从最右列开始每次两列，
    /// 行指针自下而上/自上而下交替（列 6 跳过），跳过保留模块，
    /// 每字节高位在前（bitIndex 从 7 递减）。
    /// </summary>
    private static void SetupData(bool[,] m, bool[,] r, int size, byte[] data)
    {
        int inc = -1;
        int row = size - 1;
        int bitIndex = 7;
        int byteIndex = 0;

        for (int col = size - 1; col > 0; col -= 2)
        {
            if (col == 6) col--;

            while (true)
            {
                for (int c = 0; c < 2; c++)
                {
                    if (!r[row, col - c])
                    {
                        bool dark = false;
                        if (byteIndex < data.Length)
                            dark = ((data[byteIndex] >> bitIndex) & 1) == 1;

                        m[row, col - c] = dark;
                        bitIndex--;
                        if (bitIndex == -1) { byteIndex++; bitIndex = 7; }
                    }
                }

                row += inc;
                if (row < 0 || row >= size)
                {
                    row -= inc;
                    inc = -inc;
                    break;
                }
            }
        }
    }

    private static void ApplyMask(bool[,] m, bool[,] r, int size, int mask)
    {
        for (int row = 0; row < size; row++)
            for (int col = 0; col < size; col++)
            {
                if (r[row, col]) continue;
                bool invert = mask switch
                {
                    0 => (row + col) % 2 == 0,
                    1 => row % 2 == 0,
                    2 => col % 3 == 0,
                    3 => (row + col) % 3 == 0,
                    4 => (row / 2 + col / 3) % 2 == 0,
                    5 => (row * col) % 2 + (row * col) % 3 == 0,
                    6 => ((row * col) % 2 + (row * col) % 3) % 2 == 0,
                    _ => ((row + col) % 2 + (row * col) % 3) % 2 == 0,
                };
                if (invert) m[row, col] = !m[row, col];
            }
    }

    /* ======================= 自检 / 调试 ======================= */

    internal static byte[] DebugCodewords(string text)
    {
        var data = Encoding.UTF8.GetBytes(text);
        int version = 1;
        while (version <= 10 && AvailableDataBytes(version) < data.Length) version++;
        return BuildCodewords(data, version);
    }

    internal static int DebugFormatValue() => FormatBits(EcLevelBit, MaskPattern);

    internal static string DebugReserved(string text)
    {
        Encode(text);
        var r = LastReserved!;
        int size = r.GetLength(0);
        var sb = new StringBuilder();
        sb.AppendLine($"RESERVED {size}");
        for (int y = 0; y < size; y++)
        {
            for (int x = 0; x < size; x++) sb.Append(r[y, x] ? '1' : '0');
            sb.AppendLine();
        }
        return sb.ToString();
    }

    /// <summary>结构自检：数据模块数必须等于"码字比特 + 余数位(0..7)"。</summary>
    internal static string SelfCheck(int version)
    {
        int size = version * 4 + 17;
        var m = new bool[size, size];
        var r = new bool[size, size];
        SetupFinderPattern(m, r, version);
        SetupTimingPattern(m, r);
        SetupAlignmentPattern(m, r, version);
        SetupFormatInfo(m, r, size, MaskPattern);

        int dataModules = 0, reserved = 0;
        for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++)
            {
                if (r[y, x]) reserved++; else dataModules++;
            }

        int cwBits = TotalCodewords[version] * 8;
        int remainder = dataModules - cwBits;
        bool ok = remainder >= 0 && remainder <= 7;
        return $"v{version} size={size} 保留={reserved} 数据={dataModules} 码字比特={cwBits} 余数={remainder} => {(ok ? "OK" : "错误")}";
    }
}
