using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace LanControl;

/// <summary>鼠标/键盘注入（SendInput，绝对坐标 + Unicode 文本）。不需要管理员权限。</summary>
[SupportedOSPlatform("windows")]
internal static class InputInjector
{
    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT { public int dx, dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public INPUTUNION u; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr hIcon);

    private const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004,
        MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010, MOUSEEVENTF_MIDDLEDOWN = 0x0020,
        MOUSEEVENTF_MIDDLEUP = 0x0040, MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000,
        MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

    private static int ScreenW => Math.Max(GetSystemMetrics(78), 1);   // SM_CXVIRTUALSCREEN
    private static int ScreenH => Math.Max(GetSystemMetrics(79), 1);   // SM_CYVIRTUALSCREEN
    private static int ScreenX => GetSystemMetrics(76);                // SM_XVIRTUALSCREEN
    private static int ScreenY => GetSystemMetrics(77);                // SM_YVIRTUALSCREEN

    /// <summary>虚拟桌面几何信息（供光标位置归一化使用）。</summary>
    public static int VirtualLeft => ScreenX;
    public static int VirtualTop => ScreenY;
    public static int VirtualWidth => ScreenW;
    public static int VirtualHeight => ScreenH;

    /// <summary>当前鼠标屏幕坐标。</summary>
    public static System.Drawing.Point CursorPosition() => System.Windows.Forms.Cursor.Position;

    /// <summary>
    /// 输入注入自检：把光标挪动 1 像素再挪回来，看是否真的生效。
    /// 若进程不在当前输入桌面（例如被沙箱/服务会话隔离），SetCursorPos 会失败，
    /// 表现为"手机点了没反应"，这里主动检测出来并给出明确提示。
    /// </summary>
    public static (bool ok, string message) SelfTest()
    {
        try
        {
            var before = CursorPosition();
            bool moved = SetCursorPos(before.X + 1, before.Y);
            int err = Marshal.GetLastWin32Error();
            var after = CursorPosition();
            SetCursorPos(before.X, before.Y);
            bool changed = after.X != before.X || after.Y != before.Y;
            if (moved || changed)
                return (true, $"输入注入正常（光标 {before.X},{before.Y} -> {after.X},{after.Y}）");
            return (false, $"输入注入被系统拒绝（SetCursorPos 失败，错误码 {err}）。" +
                           "当前会话无法控制鼠标键盘：常见于在被限制的沙箱/远程会话里运行，" +
                           "或程序运行在非交互式桌面上。请把程序放到正常桌面会话里运行。");
        }
        catch (Exception ex)
        {
            return (false, "输入注入自检异常: " + ex.Message);
        }
    }

    private static INPUT Mouse(uint flags, int dx = 0, int dy = 0, int data = 0) => new()
    {
        type = INPUT_MOUSE,
        u = new INPUTUNION { mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = (uint)data, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero } }
    };

    private static INPUT Key(ushort vk, bool up)
    {
        // 扩展键：方向键、Home/End/PgUp/PgDn、Ins/Del、Win 键、小键盘回车等
        bool extended = vk is 0x21 or 0x22 or 0x23 or 0x24 or 0x25 or 0x26 or 0x27 or 0x28 or 0x2D or 0x2E or 0x5B or 0x5C;
        return new INPUT
        {
            type = INPUT_KEYBOARD,
            u = new INPUTUNION
            {
                ki = new KEYBDINPUT
                {
                    wVk = vk,
                    wScan = (ushort)MapVirtualKey(vk, 0),
                    dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0),
                    time = 0,
                    dwExtraInfo = IntPtr.Zero,
                }
            }
        };
    }

    private static INPUT Unicode(char ch, bool up) => new()
    {
        type = INPUT_KEYBOARD,
        u = new INPUTUNION
        {
            ki = new KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0), time = 0, dwExtraInfo = IntPtr.Zero }
        }
    };

    private static void Send(params INPUT[] inputs)
    {
        if (inputs.Length == 0) return;
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
    }

    private static int _desiredX = int.MinValue, _desiredY = int.MinValue;

    /// <summary>最近一次要求注入的目标位置（屏幕坐标），用于判断注入是否真的生效。</summary>
    public static (int x, int y) DesiredPosition => (_desiredX, _desiredY);

    /// <summary>最近一次要求注入的目标位置（归一化 0~1），供光标回传对齐使用。</summary>
    public static (double x, double y)? DesiredNormalized
    {
        get
        {
            if (_desiredX == int.MinValue) return null;
            int vw = Math.Max(ScreenW - 1, 1), vh = Math.Max(ScreenH - 1, 1);
            double nx = (_desiredX - ScreenX) / (double)vw;
            double ny = (_desiredY - ScreenY) / (double)vh;
            return (Math.Clamp(nx, 0, 1), Math.Clamp(ny, 0, 1));
        }
    }

    /// <summary>把 0~1 的归一化坐标映射到整个虚拟桌面并移动鼠标。</summary>
    public static void MoveNormalized(double nx, double ny)
    {
        nx = Math.Clamp(nx, 0, 1);
        ny = Math.Clamp(ny, 0, 1);
        int vx = ScreenX, vy = ScreenY, vw = ScreenW, vh = ScreenH;
        int x = vx + (int)Math.Round(nx * (vw - 1));
        int y = vy + (int)Math.Round(ny * (vh - 1));
        _desiredX = x;
        _desiredY = y;
        // 绝对坐标采用 0..65535 归一化，并要求 VIRTUALDESK 以便覆盖多屏
        int ax = (int)Math.Round((x - vx) * 65535.0 / Math.Max(vw - 1, 1));
        int ay = (int)Math.Round((y - vy) * 65535.0 / Math.Max(vh - 1, 1));
        Send(Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay));
        SetCursorPos(x, y);
    }

    public static void MoveAbsolute(int x, int y)
    {
        int vx = ScreenX, vy = ScreenY, vw = ScreenW, vh = ScreenH;
        _desiredX = x;
        _desiredY = y;
        SetCursorPos(x, y);
        int ax = (int)Math.Round((x - vx) * 65535.0 / Math.Max(vw - 1, 1));
        int ay = (int)Math.Round((y - vy) * 65535.0 / Math.Max(vh - 1, 1));
        Send(Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay));
    }

    /// <summary>
    /// 光标回传是否可信：比较"要求注入的位置"和"实际读回的位置"。
    /// 注入被系统拒绝时（受限会话），两者会长期不一致 —— 此时不该把位置回传给手机，
    /// 否则手机上的指针会被不断拉回真实（没动）的位置，看起来像"指针突然跳回中央"。
    /// </summary>
    public static bool CursorReportTrustworthy()
    {
        if (_desiredX == int.MinValue) return true;
        var p = CursorPosition();
        return Math.Abs(p.X - _desiredX) <= 24 && Math.Abs(p.Y - _desiredY) <= 24;
    }

    public static void MouseButton(string button, bool down)
    {
        uint flag = button switch
        {
            "right" => down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP,
            "middle" => down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP,
            _ => down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP,
        };
        Send(Mouse(flag));
    }

    public static void Click(string button = "left", int count = 1)
    {
        for (int i = 0; i < Math.Clamp(count, 1, 3); i++)
        {
            MouseButton(button, true);
            Thread.Sleep(18);
            MouseButton(button, false);
            if (i + 1 < count) Thread.Sleep(60);
        }
    }

    public static void Scroll(int delta, bool horizontal = false)
        => Send(Mouse(horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, 0, 0, delta));

    /// <summary>按下/抬起组合键，keys 形如 ["ctrl","shift","s"]。</summary>
    public static void KeyCombo(IEnumerable<string> keys, bool down)
    {
        var list = keys.Where(k => !string.IsNullOrWhiteSpace(k)).ToList();
        if (list.Count == 0) return;
        if (down)
        {
            foreach (var k in list) Send(Key(Vk(k), false));
        }
        else
        {
            for (int i = list.Count - 1; i >= 0; i--) Send(Key(Vk(list[i]), true));
        }
    }

    public static void Tap(IEnumerable<string> keys)
    {
        KeyCombo(keys, true);
        Thread.Sleep(30);
        KeyCombo(keys, false);
    }

    public static void TapVk(ushort vk)
    {
        Send(Key(vk, false));
        Thread.Sleep(25);
        Send(Key(vk, true));
    }

    /// <summary>以 Unicode 方式直接输入文本（支持中文等非 ASCII 字符，绕过输入法）。</summary>
    public static void TypeText(string text)
    {
        if (string.IsNullOrEmpty(text)) return;
        var buffer = new List<INPUT>(Math.Min(text.Length * 2, 512));
        foreach (char ch in text)
        {
            if (ch == '\r') continue;
            if (ch == '\n') { buffer.Add(Key(0x0D, false)); buffer.Add(Key(0x0D, true)); }
            else if (ch == '\t') { buffer.Add(Key(0x09, false)); buffer.Add(Key(0x09, true)); }
            else { buffer.Add(Unicode(ch, false)); buffer.Add(Unicode(ch, true)); }
            if (buffer.Count >= 400) { Send(buffer.ToArray()); buffer.Clear(); Thread.Sleep(4); }
        }
        if (buffer.Count > 0) Send(buffer.ToArray());
    }

    /// <summary>唤醒并置顶当前前台窗口（远程连接后便于立刻操作）。</summary>
    public static void Nudge()
    {
        try
        {
            var h = GetForegroundWindow();
            if (h != IntPtr.Zero && IsIconic(h)) ShowWindow(h, 9 /* SW_RESTORE */);
        }
        catch { }
    }

    private static readonly Dictionary<string, ushort> VkMap = new(StringComparer.OrdinalIgnoreCase)
    {
        ["backspace"] = 0x08, ["tab"] = 0x09, ["enter"] = 0x0D, ["return"] = 0x0D, ["shift"] = 0x10,
        ["ctrl"] = 0x11, ["control"] = 0x11, ["alt"] = 0x12, ["pause"] = 0x13, ["capslock"] = 0x14,
        ["esc"] = 0x1B, ["escape"] = 0x1B, ["space"] = 0x20, ["pageup"] = 0x21, ["pgup"] = 0x21,
        ["pagedown"] = 0x22, ["pgdn"] = 0x22, ["end"] = 0x23, ["home"] = 0x24, ["left"] = 0x25,
        ["up"] = 0x26, ["right"] = 0x27, ["down"] = 0x28, ["printscreen"] = 0x2C, ["insert"] = 0x2D,
        ["delete"] = 0x2E, ["del"] = 0x2E, ["win"] = 0x5B, ["lwin"] = 0x5B, ["meta"] = 0x5B,
        ["rwin"] = 0x5C, ["apps"] = 0x5D, ["numlock"] = 0x90, ["scrolllock"] = 0x91,
        ["volume_mute"] = 0xAD, ["volume_down"] = 0xAE, ["volume_up"] = 0xAF,
        ["media_next"] = 0xB0, ["media_prev"] = 0xB1, ["media_stop"] = 0xB2, ["media_play"] = 0xB3,
        ["semicolon"] = 0xBA, ["plus"] = 0xBB, ["comma"] = 0xBC, ["minus"] = 0xBD, ["period"] = 0xBE,
        ["slash"] = 0xBF, ["backtick"] = 0xC0, ["lbracket"] = 0xDB, ["backslash"] = 0xDC,
        ["rbracket"] = 0xDD, ["quote"] = 0xDE,
        ["f1"] = 0x70, ["f2"] = 0x71, ["f3"] = 0x72, ["f4"] = 0x73, ["f5"] = 0x74, ["f6"] = 0x75,
        ["f7"] = 0x76, ["f8"] = 0x77, ["f9"] = 0x78, ["f10"] = 0x79, ["f11"] = 0x7A, ["f12"] = 0x7B,
    };

    public static ushort Vk(string key)
    {
        if (string.IsNullOrEmpty(key)) return 0;
        if (VkMap.TryGetValue(key, out var vk)) return vk;
        if (key.Length == 1)
        {
            char c = char.ToUpperInvariant(key[0]);
            return c is >= 'A' and <= 'Z' or >= '0' and <= '9' ? c : (ushort)0;
        }
        if (key.StartsWith("0x", StringComparison.OrdinalIgnoreCase) &&
            ushort.TryParse(key[2..], System.Globalization.NumberStyles.HexNumber, null, out var hex))
            return hex;
        return 0;
    }

    /// <summary>把文本放入剪贴板并发送 Ctrl+V（比逐字注入更可靠，适合长文本）。</summary>
    public static void PasteText(string text)
    {
        var t = new Thread(() =>
        {
            try
            {
                System.Windows.Forms.Clipboard.SetText(text);
                Thread.Sleep(60);
                Tap(new[] { "ctrl", "v" });
            }
            catch { }
        });
        t.SetApartmentState(ApartmentState.STA);
        t.IsBackground = true;
        t.Start();
        t.Join(3000);
    }

    public static void OpenPath(string path)
    {
        try { Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); } catch { }
    }
}
