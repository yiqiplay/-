using System.Drawing;
using System.Windows.Forms;

namespace LanControl;

/// <summary>
/// 控制面板：程序最主要的可见入口。
///
/// 布局（自 v2.0.0 修复）：
///   顶部标题 → 中间主体（左侧二维码 / 右侧地址+配对码）→ 可用地址+设备列表
///   → 状态栏 → 按钮条
///
/// 之前配对码不显示的根因：二维码用 SetRowSpan(3) 跨了三行，
/// 把第 3 行的配对码整块盖住了。现在二维码只占自己那一行，
/// 并且用固定高度的容器限制它，避免它把网页地址/配对码挤掉。
/// </summary>
internal sealed class InfoForm : Form
{
    private readonly ListBox _devices = new();
    private readonly PictureBox _qr = new();
    private readonly System.Windows.Forms.Timer _timer = new();
    private readonly Label _code = new();
    private readonly Label _url = new();
    private readonly Label _stats = new();
    private readonly Label _status = new();
    private readonly Label _addrList = new();

    public InfoForm()
    {
        Text = "局域网远程控制 · 被控端";
        ClientSize = new Size(820, 560);
        MinimumSize = new Size(760, 520);
        Font = new Font("Microsoft YaHei UI", 9F);
        Icon = LoadAppIcon();
        ShowInTaskbar = true;
        MaximizeBox = false;

        var title = new Label
        {
            Text = "被控端正在运行 —— 用手机扫左边的码，或手动输入右边的地址",
            Font = new Font("Microsoft YaHei UI", 12.5F, FontStyle.Bold),
            Dock = DockStyle.Top,
            Height = 38,
            TextAlign = ContentAlignment.MiddleCenter,
        };

        // ================= 主体：左右两栏，各自独立不跨行 =================
        var body = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            Padding = new Padding(16, 4, 16, 4),
        };
        body.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 360));   // 二维码栏（固定宽度）
        body.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));    // 信息栏

        // ---------- 左栏：二维码 ----------
        var qrPanel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(0, 4, 12, 4) };
        var qrCaption = new Label
        {
            Text = "① 手机相机扫这个码",
            Dock = DockStyle.Top,
            Height = 26,
            TextAlign = ContentAlignment.MiddleCenter,
            ForeColor = Color.DimGray,
        };
        _qr.SizeMode = PictureBoxSizeMode.Zoom;
        _qr.Dock = DockStyle.Fill;
        _qr.BackColor = Color.White;
        _qr.Cursor = Cursors.Hand;
        _qr.Click += (_, _) => CopyToClipboard(Program.PairUrl, "已复制含配对码的地址");
        qrPanel.Controls.Add(_qr);
        qrPanel.Controls.Add(qrCaption);
        body.Controls.Add(qrPanel, 0, 0);

        // ---------- 右栏：地址 + 配对码（各自占固定行，互不遮挡） ----------
        var info = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 5,
        };
        info.RowStyles.Add(new RowStyle(SizeType.Absolute, 26));    // 地址标题
        info.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));    // 地址
        info.RowStyles.Add(new RowStyle(SizeType.Absolute, 26));    // 配对码标题
        info.RowStyles.Add(new RowStyle(SizeType.Absolute, 96));    // 配对码
        info.RowStyles.Add(new RowStyle(SizeType.Percent, 100));    // 提示

        var urlCaption = new Label
        {
            Text = "② 或在手机浏览器打开：",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.BottomLeft,
            ForeColor = Color.DimGray,
        };
        info.Controls.Add(urlCaption, 0, 0);

        _url.Text = Program.Url;
        _url.Font = new Font("Consolas", 17F, FontStyle.Bold);
        _url.ForeColor = Color.FromArgb(20, 90, 190);
        _url.Dock = DockStyle.Fill;
        _url.TextAlign = ContentAlignment.MiddleLeft;
        _url.Cursor = Cursors.Hand;
        _url.Click += (_, _) => CopyToClipboard(_url.Text, "地址已复制到剪贴板");
        info.Controls.Add(_url, 0, 1);

        var codeCaption = new Label
        {
            Text = "③ 配对码（点一下可复制）：",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.BottomLeft,
            ForeColor = Color.DimGray,
        };
        info.Controls.Add(codeCaption, 0, 2);

        _code.Text = Program.DisplayCode(Program.Context.PairCode);
        _code.Font = new Font("Consolas", 44F, FontStyle.Bold);
        _code.ForeColor = Color.FromArgb(200, 60, 30);
        _code.Dock = DockStyle.Fill;
        _code.TextAlign = ContentAlignment.MiddleLeft;
        _code.Cursor = Cursors.Hand;
        _code.AutoEllipsis = false;
        _code.Click += (_, _) => CopyToClipboard(Program.Context.PairCode, "配对码已复制");   // 复制不带空格，便于粘贴
        info.Controls.Add(_code, 0, 3);

        var tip = new Label
        {
            Text = "手机端也可手动输入上面的地址 + 配对码；\n" +
                   "确认手机与电脑连在同一个 Wi-Fi。\n" +
                   "点地址或配对码即可复制。",
            Dock = DockStyle.Fill,
            ForeColor = Color.DimGray,
            TextAlign = ContentAlignment.TopLeft,
        };
        info.Controls.Add(tip, 0, 4);

        body.Controls.Add(info, 1, 0);
        body.SetColumnSpan(qrPanel, 1);

        // ================= 底部：可用地址 + 已连接设备 =================
        var bottom = new Panel { Dock = DockStyle.Bottom, Height = 96, Padding = new Padding(16, 4, 16, 0) };
        var bottomGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2 };
        bottomGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 46));
        bottomGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 54));

        _addrList.Dock = DockStyle.Fill;
        _addrList.ForeColor = Color.DimGray;
        _addrList.Font = new Font("Microsoft YaHei UI", 8.5F);
        _addrList.TextAlign = ContentAlignment.TopLeft;
        bottomGrid.Controls.Add(_addrList, 0, 0);

        _devices.Dock = DockStyle.Fill;
        _devices.IntegralHeight = false;
        _devices.Font = new Font("Microsoft YaHei UI", 9F);
        bottomGrid.Controls.Add(_devices, 1, 0);

        bottom.Controls.Add(bottomGrid);

        _stats.Dock = DockStyle.Bottom;
        _stats.Height = 22;
        _stats.TextAlign = ContentAlignment.MiddleLeft;
        _stats.Padding = new Padding(16, 0, 0, 0);
        _stats.ForeColor = Color.DimGray;
        _stats.Font = new Font("Microsoft YaHei UI", 8.5F);

        _status.Dock = DockStyle.Bottom;
        _status.Height = 24;
        _status.TextAlign = ContentAlignment.MiddleLeft;
        _status.Padding = new Padding(16, 0, 0, 0);
        _status.Text = "等待手机连接…";
        _status.ForeColor = Color.DimGray;

        // ================= 按钮条 =================
        // 高度按字体实际行高自适应，避免高 DPI / 大字体下文字被截断
        int btnH = Math.Max(32, (int)Math.Ceiling(Font.GetHeight()) + 14);
        var buttonBar = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            Height = btnH + 14,
            FlowDirection = FlowDirection.LeftToRight,
            Padding = new Padding(12, 7, 12, 7),
            WrapContents = false,
        };
        Button MakeBtn(string text, int minWidth, Action onClick)
        {
            // 用 TextRenderer 量出文字真实像素宽度，再加内边距 ——
            // 之前写死宽度/高度，在高 DPI 或大字体下会把中文截断（用户反馈过两次）。
            var measured = TextRenderer.MeasureText(text, Font);
            int needW = measured.Width + 26;                 // 左右内边距 + 边框
            int needH = Math.Max(btnH, measured.Height + 12);
            var b = new Button
            {
                Text = text,
                Height = needH,
                Width = Math.Max(minWidth, needW),
                Margin = new Padding(0, 0, 8, 0),
                AutoEllipsis = false,
                UseCompatibleTextRendering = false,
            };
            if (onClick != null) b.Click += (_, _) => onClick();
            return b;
        }

        var trayBtn = MakeBtn("让托盘图标常显", 140, () =>
        {
            string r = Program.PromoteTrayIconNow();
            MessageBox.Show(this, r, "局域网远程控制", MessageBoxButtons.OK, MessageBoxIcon.Information);
        });
        var hideBtn = MakeBtn("最小化到托盘", 120, () => Hide());
        var logBtn = MakeBtn("打开日志", 100, () => InputInjector.OpenPath(Log.LogDirectory));

        // 固定配对码：让配对码在重启后保持不变，手机端才能"记住此设备"。
        // 之前每次启动都重新随机，手机端记了也没用 —— 这是本次要解决的核心问题。
        // 注意：按钮文字必须在**每次点击后刷新**（refreshPinBtn），
        // 否则固定成功后仍显示「固定配对码」，用户会以为没生效 —— 实测踩过。
        var pinBtn = MakeBtn("", 150, null);
        void refreshPinBtn()
        {
            pinBtn.Text = Program.ReadFixedCode().Length > 0 ? "取消固定配对码" : "固定配对码";
        }
        pinBtn.Click += (_, _) =>
        {
            string now = Program.ReadFixedCode();
            if (now.Length > 0)
            {
                if (MessageBox.Show(this, $"当前固定配对码：{Program.DisplayCode(now)}\n\n取消固定后，每次启动都会重新随机生成，手机端将无法记住本机。\n\n确定取消吗？",
                        "固定配对码", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
                Program.SaveFixedCode("");
                MessageBox.Show(this, "已取消固定。重启被控端后将使用随机配对码。", "固定配对码",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            else
            {
                if (MessageBox.Show(this, $"将当前配对码 {Program.DisplayCode(Program.Context.PairCode)} 固定下来？\n\n" +
                        "固定后：\n" +
                        "  · 重启被控端，配对码保持不变\n" +
                        "  · 手机端勾选「记住此设备」后，下次可自动填入、免手输\n\n" +
                        "注意：固定配对码会降低安全性（码不变）。若只在可信的家庭局域网内使用，这样更方便。",
                        "固定配对码", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
                if (Program.SaveFixedCode(Program.Context.PairCode))
                    MessageBox.Show(this, $"已固定为 {Program.DisplayCode(Program.Context.PairCode)}，重启后不变。", "固定配对码",
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                else
                    MessageBox.Show(this, "保存失败（注册表不可写）。", "固定配对码",
                        MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            refreshPinBtn();   // 关键：点击后刷新按钮文字
        };
        refreshPinBtn();

        var exitBtn = MakeBtn("退出被控端", 110, () =>
        {
            if (MessageBox.Show(this, "确定要退出被控端吗？\n\n退出后手机将无法连接，监听端口会被释放。",
                    "局域网远程控制", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK)
            {
                Program.Shutdown("用户从控制面板退出");
                Application.Exit();
                Environment.Exit(Program.ExitCode);
            }
        });
        buttonBar.Controls.Add(trayBtn);
        buttonBar.Controls.Add(pinBtn);
        buttonBar.Controls.Add(hideBtn);
        buttonBar.Controls.Add(logBtn);
        buttonBar.Controls.Add(exitBtn);

        // 注意添加顺序：Dock 的填充控件必须先加，Bottom/Top 的后加
        Controls.Add(body);
        Controls.Add(bottom);
        Controls.Add(_stats);
        Controls.Add(_status);
        Controls.Add(buttonBar);
        Controls.Add(title);

        Load += (_, _) =>
        {
            BuildQr();
            RefreshDevices();
            UpdateStats();
        };

        _timer.Interval = 1500;
        _timer.Tick += (_, _) => { RefreshDevices(); UpdateStats(); };
        _timer.Start();
        FormClosing += (_, e) => Program.HandleWindowClose(e);
    }

    private void CopyToClipboard(string text, string toast)
    {
        try { Clipboard.SetText(text); _status.Text = toast; } catch { }
    }

    private void BuildQr()
    {
        try
        {
            // 二维码里带上配对码，手机扫完直接进控制界面，不用手输 6 位数字
            int side = Math.Max(240, Math.Min(_qr.Width, _qr.Height));
            _qr.Image = QrCode.Render(Program.PairUrl, side);
            Log.Info($"控制面板二维码已生成（{side}px，内容长度 {Program.PairUrl.Length}）");
        }
        catch (Exception ex)
        {
            Log.Warn("生成二维码失败: " + ex.Message);
            _qr.Image = null;
        }
    }

    /// <summary>取程序自带的图标，拿不到就退回系统图标（保证窗口/任务栏有图标）。</summary>
    private static Icon LoadAppIcon()
    {
        try
        {
            var stream = System.Reflection.Assembly.GetExecutingAssembly()
                .GetManifestResourceStream("LanControl.app.ico");
            if (stream != null) return new Icon(stream);
        }
        catch { }
        try
        {
            string exe = Environment.ProcessPath ?? "";
            if (File.Exists(exe))
            {
                var icon = Icon.ExtractAssociatedIcon(exe);
                if (icon != null) return icon;
            }
        }
        catch { }
        return SystemIcons.Application;
    }

    private void UpdateStats()
    {
        var (cpu, memUsed, memTotal) = SystemStats.Snapshot();
        string warn = Program.InputInjectionOk ? "" : "   ⚠ 输入注入不可用（手机点了不会有反应）";
        _stats.Text = $"CPU {cpu:0.0}%   内存 {memUsed}/{memTotal} GB   端口 {Program.Server.Port}   " +
                      $"版本 v{Program.Version}   托盘 {(Program.TrayVisible ? "已创建" : "未创建")}{warn}";
        _stats.ForeColor = Program.InputInjectionOk ? Color.DimGray : Color.FromArgb(200, 90, 40);

        try
        {
            var ips = Program.LocalAddresses();
            _addrList.Text = "本机所有可用地址：\n" +
                             string.Join("\n", ips.Select(ip => $"   http://{ip}:{Program.Server.Port}/"));
        }
        catch { }

        if (!Program.InputInjectionOk)
        {
            _status.Text = "⚠ " + Program.InputInjectionMessage;
            _status.ForeColor = Color.FromArgb(200, 60, 30);
        }
    }

    private void RefreshDevices()
    {
        var sessions = Program.Context.Sessions.Values.OrderBy(s => s.ConnectedAt).ToList();
        _devices.BeginUpdate();
        _devices.Items.Clear();
        foreach (var s in sessions)
            _devices.Items.Add($"{s.DeviceName} · {s.RemoteIp} · {(s.Authed ? "已配对" : "未配对")} · {s.ConnectedAt:HH:mm:ss}");
        if (sessions.Count == 0) _devices.Items.Add("（暂无设备连接）");
        _devices.EndUpdate();
        if (Program.InputInjectionOk)
            _status.Text = sessions.Count == 0
                ? "等待手机连接…（关闭本窗口 = 最小化；点任务栏图标可再打开）"
                : $"已连接 {sessions.Count} 台设备";
    }
}
