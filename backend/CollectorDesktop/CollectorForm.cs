using System.Drawing;

namespace CollectorDesktop;

public sealed class CollectorForm : Form
{
    const string BuildLabel = "2026.10.01.MT-TIMER-SHOE-HISTORY";
    readonly TextBox renderUrl = new() { Width = 410, ReadOnly = true };
    readonly TextBox testRenderUrl = new() { Width = 410 };
    readonly TextBox testRelayUrl = new() { Width = 410 };
    readonly TextBox ingestKey = new() { Width = 410, UseSystemPasswordChar = true };
    readonly TextBox officialUrl = new() { Width = 410 };
    readonly TextBox username = new() { Width = 410 };
    readonly TextBox password = new() { Width = 410, UseSystemPasswordChar = true };
    readonly TextBox deviceId = new() { Width = 410 };
    readonly ComboBox destination = new() { Width = 410, DropDownStyle = ComboBoxStyle.DropDownList };
    readonly Button start = new() { Text = "啟動採集端", AutoSize = true };
    readonly Button stop = new() { Text = "停止", AutoSize = true, Enabled = false };
    readonly TextBox output = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, BackColor = Color.FromArgb(13, 23, 38), ForeColor = Color.Gainsboro, Font = new Font("Consolas", 10), BorderStyle = BorderStyle.FixedSingle };
    readonly Dictionary<string, Label> states = new();
    CollectorEngine? engine;

    public CollectorForm()
    {
        Text = $"J神 Windows 採集端 A · build {BuildLabel}"; MinimumSize = new Size(820, 700); StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(19, 29, 45); ForeColor = Color.White;
        var saved = CollectorSettingsStore.Load(out var settingsWarning);
        // Always boot into production even if the previous run targeted the
        // test or LAN environment. Secrets remain in the encrypted local file.
        renderUrl.Text = CollectorDefaults.RenderUrl; officialUrl.Text = saved.OfficialUrl; deviceId.Text = saved.DeviceId; ingestKey.Text = saved.IngestKey; username.Text = saved.Username; password.Text = saved.Password;
        testRenderUrl.Text = string.IsNullOrWhiteSpace(saved.TestRenderUrl) || saved.TestRenderUrl.Contains("jshen.onrender.com", StringComparison.OrdinalIgnoreCase)
            ? CollectorDefaults.TestRenderUrl : saved.TestRenderUrl;
        testRelayUrl.Text = string.IsNullOrWhiteSpace(saved.TestRelayUrl) || saved.TestRelayUrl.Contains("jshen-test-relay.onrender.com", StringComparison.OrdinalIgnoreCase)
            ? CollectorDefaults.TestRelayUrl : saved.TestRelayUrl;
        destination.Items.AddRange(["Render 正式區", "Render 測試區", "區域網路"]);
        var startupTarget = Environment.GetEnvironmentVariable("JSHEN_COLLECTOR_TARGET");
        destination.SelectedIndex = startupTarget?.Equals("lan", StringComparison.OrdinalIgnoreCase) == true
            ? 2
            : startupTarget?.Equals("test", StringComparison.OrdinalIgnoreCase) == true ? 1 : 0;
        destination.SelectedIndexChanged += (_, _) => {
            renderUrl.Text = destination.SelectedIndex switch {
                1 => testRenderUrl.Text.Trim(),
                2 => "http://192.168.8.231:3000/",
                _ => CollectorDefaults.RenderUrl
            };
            states["Render"].Text = TargetName() + "：尚未啟動";
        };
        testRenderUrl.TextChanged += (_, _) => {
            if (destination.SelectedIndex == 1) renderUrl.Text = testRenderUrl.Text.Trim();
        };
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 2, Padding = new Padding(18), BackColor = BackColor };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 58)); root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 42)); root.RowStyles.Add(new RowStyle(SizeType.AutoSize)); root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var config = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, Dock = DockStyle.Fill };
        config.Controls.Add(Title("採集器設定（只保存在這台 Windows 電腦，敏感欄位以 DPAPI 加密）"));
        config.Controls.Add(new Label {
            AutoSize = true,
            MaximumSize = new Size(420, 0),
            Margin = new Padding(3, 0, 3, 6),
            ForeColor = Color.LightSkyBlue,
            Text = "設定檔位置：" + CollectorSettingsStore.SettingsFilePath
        });
        config.Controls.Add(new Label {
            AutoSize = true,
            MaximumSize = new Size(420, 0),
            Margin = new Padding(3, 0, 3, 10),
            ForeColor = Color.PaleGreen,
            Text = settingsWarning is null ? $"設定狀態：已載入本機加密設定（build {BuildLabel}）" : $"設定狀態：{settingsWarning}"
        });
        config.Controls.Add(new Label {
            AutoSize = true,
            MaximumSize = new Size(420, 0),
            Margin = new Padding(3, 0, 3, 10),
            ForeColor = Color.LightSkyBlue,
            Text = "採集模式：Chrome 官方頁面；Render 使用 WebSocket，區網測試使用本機 HTTP。"
        });
        Add(config, "資料傳送目標", destination); Add(config, "Render 測試區網址", testRenderUrl); Add(config, "測試區轉送站網址", testRelayUrl); Add(config, "實際目標網址", renderUrl); Add(config, "採集器上傳金鑰", ingestKey); Add(config, "官方網址", officialUrl); Add(config, "官方採集帳號", username); Add(config, "官方採集密碼", password); Add(config, "採集器識別碼", deviceId);
        var controls = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight }; controls.Controls.Add(start); controls.Controls.Add(stop); config.Controls.Add(controls);
        config.Controls.Add(new Label { AutoSize = true, MaximumSize = new Size(420, 0), Margin = new Padding(3, 14, 3, 3), ForeColor = Color.LightSkyBlue, Text = "啟動後立即開啟 MT／DG／歐博；無觀看者 5 分鐘後關閉三個 Chrome 工作階段，0→1 人時重新啟動。完整快照經 WebSocket 上傳並等待 ACK，連線異常時使用 HTTP 備援。" });
        var health = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, Padding = new Padding(14), BackColor = Color.FromArgb(16, 35, 52) };
        health.Controls.Add(Title("即時執行狀況"));
        foreach (var key in new[] { "Render", "需求", "官方", "MT", "DG", "AB" }) { var label = new Label { AutoSize = true, Font = new Font(Font, FontStyle.Bold), ForeColor = Color.LightSteelBlue, Text = StatusName(key) + "：尚未啟動", Margin = new Padding(3, 8, 3, 8) }; states[key] = label; health.Controls.Add(label); }
        root.Controls.Add(config, 0, 0); root.Controls.Add(health, 1, 0); root.SetColumnSpan(output, 2); root.Controls.Add(output, 0, 1); Controls.Add(root);
        start.Click += StartClick; stop.Click += StopClick; FormClosing += OnCollectorFormClosing;
        // Opening the app starts all three local collectors immediately;
        // the engine later applies the five-minute no-viewer idle policy.
        Shown += (_, _) => BeginInvoke(() => StartClick(this, EventArgs.Empty));
    }

    static Label Title(string text) => new() { Text = text, AutoSize = true, Font = new Font(SystemFonts.DefaultFont.FontFamily, 11, FontStyle.Bold), ForeColor = Color.Cyan, Margin = new Padding(3, 3, 3, 12) };
    static void Add(Control parent, string label, Control control) { parent.Controls.Add(new Label { Text = label, AutoSize = true, Margin = new Padding(3, 5, 3, 2) }); parent.Controls.Add(control); }
    CollectorSettings Settings() => new(renderUrl.Text, officialUrl.Text, deviceId.Text, ingestKey.Text, username.Text, password.Text, testRenderUrl.Text, testRelayUrl.Text, destination.SelectedIndex switch { 1 => CollectorTarget.Test, 2 => CollectorTarget.Lan, _ => CollectorTarget.Production });
    string TargetName() => destination.SelectedIndex switch { 1 => "Render 測試區", 2 => "區網", _ => "Render 正式區" };

    void StartClick(object? sender, EventArgs e)
    {
        try {
            var settings = Settings();
            if (string.IsNullOrWhiteSpace(settings.Username) || string.IsNullOrWhiteSpace(settings.Password) || settings.IngestKey.Length < 32) {
                Log("拒絕啟動：帳號、密碼或採集器上傳金鑰不完整；不會覆寫既有設定檔。");
                return;
            }
            if (destination.SelectedIndex == 1) {
                if (!Uri.TryCreate(settings.RenderUrl, UriKind.Absolute, out var testUri) || testUri.Scheme != Uri.UriSchemeHttps
                    || testUri.Host.Equals(new Uri(CollectorDefaults.RenderUrl).Host, StringComparison.OrdinalIgnoreCase)
                    || !Uri.TryCreate(settings.TestRelayUrl, UriKind.Absolute, out var relayUri) || relayUri.Scheme != Uri.UriSchemeHttps
                    || relayUri.Host.Equals(new Uri(CollectorDefaults.RelayUrl).Host, StringComparison.OrdinalIgnoreCase)) {
                    Log("拒絕啟動：請填入獨立的測試區網站與轉送站 HTTPS 網址；正式區設定未變更。");
                    return;
                }
            }
            CollectorSettingsStore.Save(settings);
            engine = new CollectorEngine(settings, SetStatus, Log); engine.Start(); start.Enabled = false; stop.Enabled = true; destination.Enabled = false; renderUrl.Enabled = false; testRenderUrl.Enabled = false; testRelayUrl.Enabled = false;
            Log($"採集器已啟動，目標為 {TargetName()}：立即開啟 MT／DG／歐博，並監看觀看人數變化。");
        } catch (Exception ex) { Log("設定無法儲存或啟動：" + ex.Message); }
    }
    async void StopClick(object? sender, EventArgs e) { await StopAsync(); }
    async void OnCollectorFormClosing(object? sender, FormClosingEventArgs e) { await StopAsync(); }
    async Task StopAsync() { var running = engine; if (running is null) return; engine = null; stop.Enabled = false; await running.DisposeAsync(); start.Enabled = true; destination.Enabled = true; renderUrl.Enabled = true; testRenderUrl.Enabled = true; testRelayUrl.Enabled = true; Log("採集器已停止。"); }
    static string StatusName(string key) => key == "AB" ? "歐博 (AB)" : key;
    void SetStatus(string key, string value) { if (InvokeRequired) { BeginInvoke(() => SetStatus(key, value)); return; } if (states.TryGetValue(key, out var label)) { label.Text = (key == "Render" ? TargetName() : StatusName(key)) + "：" + value; label.ForeColor = value.Contains("錯誤") || value.Contains("失敗") ? Color.LightCoral : value.Contains("中") || value.Contains("已取得") ? Color.PaleGreen : Color.LightSteelBlue; } }
    void Log(string message) { if (InvokeRequired) { BeginInvoke(() => Log(message)); return; } output.AppendText($"[{DateTime.Now:HH:mm:ss}] {message}{Environment.NewLine}"); }
}
