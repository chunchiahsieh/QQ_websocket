namespace CollectorDesktop;

internal static class Program
{
    static bool TryLoadExisting(out CollectorSettings settings)
    {
        settings = CollectorSettingsStore.Load(out var warning);
        if (string.IsNullOrWhiteSpace(warning)) return true;
        Environment.ExitCode = 3;
        return false;
    }

    [STAThread]
    static async Task Main(string[] args)
    {
        // Setup automation only reads process-scoped variables and persists
        // them through CollectorSettingsStore (Windows DPAPI). It never
        // prints, logs, or embeds credentials in source code.
        if (args.Length == 1 && args[0].Equals("--configure-all", StringComparison.OrdinalIgnoreCase))
        {
            var rawUrl = Environment.GetEnvironmentVariable("JSHEN_COLLECTOR_RENDER_URL");
            var username = Environment.GetEnvironmentVariable("JSHEN_COLLECTOR_USERNAME");
            var password = Environment.GetEnvironmentVariable("JSHEN_COLLECTOR_PASSWORD");
            var ingestKey = Environment.GetEnvironmentVariable("JSHEN_COLLECTOR_INGEST_KEY");
            var deviceId = Environment.GetEnvironmentVariable("JSHEN_COLLECTOR_DEVICE_ID") ?? "windows-collector-a";
            if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out var renderUri)
                || renderUri.Scheme != Uri.UriSchemeHttps
                || string.IsNullOrWhiteSpace(username)
                || string.IsNullOrWhiteSpace(password)
                || string.IsNullOrWhiteSpace(ingestKey)
                || ingestKey.Length < 32)
            {
                Environment.ExitCode = 2;
            }
            else
            {
                // Atomic bootstrap: never depend on, or partially overwrite,
                // a potentially stale earlier settings file.
                CollectorSettingsStore.Save(new CollectorSettings(
                    renderUri.GetLeftPart(UriPartial.Authority) + "/",
                    "https://www.tz6868.com/",
                    deviceId,
                    ingestKey,
                    username,
                    password));
            }
            return;
        }
        if (args.Length == 1 && args[0].Equals("--configure-official-login", StringComparison.OrdinalIgnoreCase))
        {
            var username = Environment.GetEnvironmentVariable("JSHEN_COLLECTOR_USERNAME");
            var password = Environment.GetEnvironmentVariable("JSHEN_COLLECTOR_PASSWORD");
            if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password)) Environment.ExitCode = 2;
            else if (TryLoadExisting(out var settings)) CollectorSettingsStore.Save(settings with { Username = username, Password = password });
            return;
        }
        if (args.Length == 1 && args[0].Equals("--configure-ingest-key", StringComparison.OrdinalIgnoreCase))
        {
            var key = Environment.GetEnvironmentVariable("JSHEN_COLLECTOR_INGEST_KEY");
            if (string.IsNullOrWhiteSpace(key) || key.Length < 32) Environment.ExitCode = 2;
            else if (TryLoadExisting(out var settings)) CollectorSettingsStore.Save(settings with { IngestKey = key });
            return;
        }
        if (args.Length == 1 && args[0].Equals("--configure-render-url", StringComparison.OrdinalIgnoreCase))
        {
            var rawUrl = Environment.GetEnvironmentVariable("JSHEN_COLLECTOR_RENDER_URL");
            if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out var renderUri)
                || (renderUri.Scheme != Uri.UriSchemeHttps && renderUri.Scheme != Uri.UriSchemeHttp))
            {
                Environment.ExitCode = 2;
            }
            else if (TryLoadExisting(out var settings))
            {
                CollectorSettingsStore.Save(settings with
                {
                    RenderUrl = renderUri.GetLeftPart(UriPartial.Authority) + "/"
                });
            }
            return;
        }
        if (args.Length == 1 && args[0].Equals("--verify-setup", StringComparison.OrdinalIgnoreCase))
        {
            // Intentionally expose only readiness through the exit code. This
            // command never writes the account, password, or ingestion key.
            var settings = CollectorSettingsStore.Load(out var warning);
            Environment.ExitCode = string.IsNullOrWhiteSpace(warning)
                && !string.IsNullOrWhiteSpace(settings.Username)
                && !string.IsNullOrWhiteSpace(settings.Password)
                && settings.IngestKey.Length >= 32
                ? 0
                : 3;
            return;
        }
        if (args.Length == 1 && args[0].Equals("--verify-render", StringComparison.OrdinalIgnoreCase))
        {
            // Performs the same authenticated demand request used by the UI.
            // Only the exit code is exposed so that no key or credential can
            // be accidentally copied into a terminal log.
            try
            {
                using var client = new RenderCollectorClient(CollectorSettingsStore.Load() with {
                    RenderUrl = CollectorDefaults.RenderUrl,
                    Target = CollectorTarget.Production
                });
                await client.ShouldCollectAsync(CancellationToken.None);
                Environment.ExitCode = 0;
            }
            catch
            {
                Environment.ExitCode = 4;
            }
            return;
        }
        if (args.Length == 1 && args[0].Equals("--diagnose-settings", StringComparison.OrdinalIgnoreCase))
        {
            // The file deliberately excludes sensitive values. It reveals
            // exactly what this EXE loaded, without copying credentials or a
            // collector key into a terminal or diagnostic report.
            var settings = CollectorSettingsStore.Load(out var warning);
            var diagnosticPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JshenCollector", "diagnostic.json");
            File.WriteAllText(diagnosticPath, System.Text.Json.JsonSerializer.Serialize(new {
                build = "2026.09.21.RENDER-ENV-SELECT",
                uiUsesFixedDefaults = false,
                settingsFile = CollectorSettingsStore.SettingsFilePath,
                renderUrl = settings.RenderUrl,
                officialUrl = settings.OfficialUrl,
                settingsReady = string.IsNullOrWhiteSpace(warning),
                hasIngestKey = settings.IngestKey.Length >= 32,
                hasUsername = !string.IsNullOrWhiteSpace(settings.Username),
                hasPassword = !string.IsNullOrWhiteSpace(settings.Password)
            }));
            return;
        }
        using var instance = CollectorInstanceGuard.TryAcquire();
        if (instance is null)
        {
            MessageBox.Show("這台電腦的採集器已在執行；請使用原本的視窗。", "採集器已啟動");
            return;
        }
        ApplicationConfiguration.Initialize();
        Application.Run(new CollectorForm());
    }
}
