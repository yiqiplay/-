using System.Drawing;
using System.Text;
using System.Windows.Forms;

namespace LanControl;

/// <summary>
/// 命令模式（--scan-old / --clean-old / --install / --uninstall / --deploy）的报告输出。
///
/// 为什么不用 Console：本程序是 WinExe（没有控制台子系统），
/// AttachConsole(-1) 在不同宿主下时灵时不灵，用户经常看到"一闪而过什么都没有"。
/// 所以这里始终把报告写到文件，并且可以弹一个可滚动的窗口显示出来，
/// 保证双击和 .cmd 调用两种场景下用户都一定看得到结果。
/// </summary>
internal static class Report
{
    private static readonly StringBuilder Buffer = new();
    private static bool _showWindow;

    public static string FilePath { get; } =
        Path.Combine(Path.GetTempPath(), "LanControl-report.txt");

    public static void Init(bool showWindow)
    {
        _showWindow = showWindow;
        Buffer.Clear();
    }

    public static void Line(string text = "")
    {
        Buffer.AppendLine(text);
        try { Console.WriteLine(text); } catch { }
    }

    public static void Head(string title)
    {
        Line(new string('=', 62));
        Line("  " + title);
        Line(new string('=', 62));
        Line();
    }

    public static void Flush()
    {
        try { File.WriteAllText(FilePath, Buffer.ToString(), Encoding.UTF8); } catch { }
        if (_showWindow) ShowDialog();
    }

    private static void ShowDialog()
    {
        try
        {
            var form = new Form
            {
                Text = "局域网远程控制 · 运行结果",
                ClientSize = new Size(760, 520),
                StartPosition = FormStartPosition.CenterScreen,
                Font = new Font("Microsoft YaHei UI", 9F),
                Icon = SystemIcons.Application,
                ShowInTaskbar = true,
            };
            var box = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Both,
                WordWrap = false,
                Dock = DockStyle.Fill,
                Font = new Font("Consolas", 9.5F),
                BackColor = Color.White,
                Text = Buffer.ToString(),
            };
            var bar = new FlowLayoutPanel
            {
                Dock = DockStyle.Bottom,
                Height = 42,
                FlowDirection = FlowDirection.LeftToRight,
                Padding = new Padding(10, 7, 10, 7),
            };
            var copy = new Button { Text = "复制全部", Width = 90, Height = 28 };
            copy.Click += (_, _) =>
            {
                try { Clipboard.SetText(Buffer.ToString()); copy.Text = "已复制"; } catch { }
            };
            var open = new Button { Text = "打开日志目录", Width = 110, Height = 28 };
            open.Click += (_, _) => InputInjector.OpenPath(Log.LogDirectory);
            var close = new Button { Text = "关闭", Width = 80, Height = 28 };
            close.Click += (_, _) => form.Close();
            bar.Controls.Add(copy);
            bar.Controls.Add(open);
            bar.Controls.Add(close);
            form.Controls.Add(box);
            form.Controls.Add(bar);
            form.AcceptButton = close;
            form.CancelButton = close;
            Application.Run(form);
        }
        catch (Exception ex)
        {
            try { MessageBox.Show(Buffer + "\n\n(窗口显示失败: " + ex.Message + ")", "局域网远程控制"); } catch { }
        }
    }
}
