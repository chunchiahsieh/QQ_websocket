namespace CollectorDesktop;

internal static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        // Setup automation only reads process-scoped variables and persists
        // them through CollectorSettingsStore (Windows DPAPI). It never
        // prints, logs, or embeds credentials in source code.
        if (args.Length == 1 && args[0].Equals("--configure-official-login", StringComparison.OrdinalIgnoreCase))
        {
            var username = Environment.GetEnvironmentVariable("JSHEN_COLLECTOR_USERNAME");
            var password = Environment.GetEnvironmentVariable("JSHEN_COLLECTOR_PASSWORD");
            if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password)) Environment.ExitCode = 2;
            else CollectorSettingsStore.Save(CollectorSettingsStore.Load() with { Username = username, Password = password });
            return;
        }
        if (args.Length == 1 && args[0].Equals("--configure-ingest-key", StringComparison.OrdinalIgnoreCase))
        {
            var key = Environment.GetEnvironmentVariable("JSHEN_COLLECTOR_INGEST_KEY");
            if (string.IsNullOrWhiteSpace(key) || key.Length < 32) Environment.ExitCode = 2;
            else CollectorSettingsStore.Save(CollectorSettingsStore.Load() with { IngestKey = key });
            return;
        }
        if (args.Length == 1 && args[0].Equals("--verify-setup", StringComparison.OrdinalIgnoreCase))
        {
            // Intentionally expose only readiness through the exit code. This
            // command never writes the account, password, or ingestion key.
            var settings = CollectorSettingsStore.Load();
            Environment.ExitCode = !string.IsNullOrWhiteSpace(settings.Username)
                && !string.IsNullOrWhiteSpace(settings.Password)
                && settings.IngestKey.Length >= 32
                ? 0
                : 3;
            return;
        }
        ApplicationConfiguration.Initialize();
        Application.Run(new CollectorForm());
    }
}
