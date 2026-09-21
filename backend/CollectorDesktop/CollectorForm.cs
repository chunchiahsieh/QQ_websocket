using System.Drawing;

namespace CollectorDesktop;

public sealed class CollectorForm : Form
{
    readonly TextBox renderUrl = new() { Width = 410 };
    readonly TextBox ingestKey = new() { Width = 410, UseSystemPasswordChar = true };
    readonly TextBox officialUrl = new() { Width = 410 };
    readonly TextBox username = new() { Width = 410 };
    readonly TextBox password = new() { Width = 410, UseSystemPasswordChar = true };
    readonly TextBox deviceId = new() { Width = 410 };
    readonly Button start = new() { Text = "啟動採集端", AutoSize = true };
    readonly Button stop = new() { Text = "停止", AutoSize = true, Enabled = false };
    readonly TextBox output = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, BackColor = Color.FromArgb(13, 23, 38), ForeColor = Color.Gainsboro, Font = new Font("Consolas", 10), BorderStyle = BorderStyle.FixedSingle };
    readonly Dictionary<string, Label> states = new();
    CollectorEngine? engine;

    public CollectorForm()
    {
        Text = "J神 Windows 採集端 A"; MinimumSize = new Size(820, 700); StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(19, 29, 45); ForeColor = Color.White;
        var saved = CollectorSettingsStore.Load();
        renderUrl.Text = saved.RenderUrl; officialUrl.Text = saved.OfficialUrl; deviceId.Text = saved.DeviceId; ingestKey.Text = saved.IngestKey; username.Text = saved.Username; password.Text = saved.Password;
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 2, Padding = new Padding(18), BackColor = BackColor };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 58)); root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 42)); root.RowStyles.Add(new RowStyle(SizeType.AutoSize)); root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var config = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, Dock = DockStyle.Fill };
        config.Controls.Add(Title("採集器設定（只保存在這台 Windows 電腦，敏感欄位以 DPAPI 加密）"));
        Add(config, "Render 公開網址", renderUrl); Add(config, "採集器上傳金鑰", ingestKey); Add(config, "官方網址", officialUrl); Add(config, "官方採集帳號", username); Add(config, "官方採集密碼", password); Add(config, "採集器識別碼", deviceId);
        var controls = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight }; controls.Controls.Add(start); controls.Controls.Add(stop); config.Controls.Add(controls);
        config.Controls.Add(new Label { AutoSize = true, MaximumSize = new Size(420, 0), Margin = new Padding(3, 14, 3, 3), ForeColor = Color.LightSkyBlue, Text = "啟動後會每 10 秒讀取 Render 的觀看需求；有觀看者才登入官方並啟動 MT/DG。Render 僅收到標準化桌況 JSON。" });
        var health = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, Padding = new Padding(14), BackColor = Color.FromArgb(16, 35, 52) };
        health.Controls.Add(Title("即時執行狀況"));
        foreach (var key in new[] { "Render", "需求", "官方", "MT", "DG" }) { var label = new Label { AutoSize = true, Font = new Font(Font, FontStyle.Bold), ForeColor = Color.LightSteelBlue, Text = key + "：尚未啟動", Margin = new Padding(3, 8, 3, 8) }; states[key] = label; health.Controls.Add(label); }
        root.Controls.Add(config, 0, 0); root.Controls.Add(health, 1, 0); root.SetColumnSpan(output, 2); root.Controls.Add(output, 0, 1); Controls.Add(root);
        start.Click += StartClick; stop.Click += StopClick; FormClosing += OnCollectorFormClosing;
    }

    static Label Title(string text) => new() { Text = text, AutoSize = true, Font = new Font(SystemFonts.DefaultFont.FontFamily, 11, FontStyle.Bold), ForeColor = Color.Cyan, Margin = new Padding(3, 3, 3, 12) };
    static void Add(Control parent, string label, Control control) { parent.Controls.Add(new Label { Text = label, AutoSize = true, Margin = new Padding(3, 5, 3, 2) }); parent.Controls.Add(control); }
    CollectorSettings Settings() => new(renderUrl.Text, officialUrl.Text, deviceId.Text, ingestKey.Text, username.Text, password.Text);

    void StartClick(object? sender, EventArgs e)
    {
        try {
            var settings = Settings(); CollectorSettingsStore.Save(settings);
            engine = new CollectorEngine(settings, SetStatus, Log); engine.Start(); start.Enabled = false; stop.Enabled = true;
            Log("採集器已啟動：等待 Render 觀看需求。");
        } catch (Exception ex) { Log("設定無法儲存或啟動：" + ex.Message); }
    }
    async void StopClick(object? sender, EventArgs e) { await StopAsync(); }
    async void OnCollectorFormClosing(object? sender, FormClosingEventArgs e) { await StopAsync(); }
    async Task StopAsync() { if (engine is not null) { await engine.DisposeAsync(); engine = null; } start.Enabled = true; stop.Enabled = false; Log("採集器已停止。"); }
    void SetStatus(string key, string value) { if (InvokeRequired) { BeginInvoke(() => SetStatus(key, value)); return; } if (states.TryGetValue(key, out var label)) { label.Text = key + "：" + value; label.ForeColor = value.Contains("錯誤") || value.Contains("失敗") ? Color.LightCoral : value.Contains("中") || value.Contains("已取得") ? Color.PaleGreen : Color.LightSteelBlue; } }
    void Log(string message) { if (InvokeRequired) { BeginInvoke(() => Log(message)); return; } output.AppendText($"[{DateTime.Now:HH:mm:ss}] {message}{Environment.NewLine}"); }
}
