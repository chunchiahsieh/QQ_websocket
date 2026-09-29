using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace CollectorDesktop;

// The private Render store remembers the last sequence for each collector.
// A random collector ID on every launch has to wait for the prior 45-second
// lease; a fixed ID with a reset sequence would be rejected indefinitely.
// Keep one machine-scoped installation identity and reserve sequence ranges
// on disk before sending any frame. A crash may skip numbers, never reuse them.
internal sealed class CollectorInstallationState
{
    const long SequenceBlockSize = 10_000;
    sealed record Persisted(string InstallationId, long ReservedThrough);

    readonly string path;
    readonly TimeProvider clock;
    readonly object gate = new();
    readonly string installationId;
    long reservedThrough;
    long nextSequence;

    public static string DirectoryPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JshenCollector");

    public static CollectorInstallationState ForCurrentMachine() => new(
        Path.Combine(DirectoryPath, "installation.json"), CurrentMachineScope());

    internal CollectorInstallationState(string path, string machineScope, TimeProvider? clock = null)
    {
        if (string.IsNullOrWhiteSpace(path)) throw new ArgumentException("Identity path is required.", nameof(path));
        if (string.IsNullOrWhiteSpace(machineScope)) throw new ArgumentException("Machine scope is required.", nameof(machineScope));
        this.path = path;
        this.clock = clock ?? TimeProvider.System;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);

        Persisted? loaded = null;
        try { loaded = JsonSerializer.Deserialize<Persisted>(File.ReadAllText(path)); }
        catch (FileNotFoundException) { }
        catch (JsonException) { }
        catch (IOException) { }
        if (loaded is not null && Guid.TryParseExact(loaded.InstallationId, "N", out _)
            && loaded.ReservedThrough >= 0)
        {
            installationId = loaded.InstallationId.ToLowerInvariant();
            reservedThrough = loaded.ReservedThrough;
        }
        else
        {
            // If the state is missing or unreadable, a new ID is safer than
            // reusing an old ID with an unknown sequence. Its first handoff
            // may wait for the old collector lease to expire automatically.
            installationId = Guid.NewGuid().ToString("N");
            Persist(0);
        }

        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(machineScope + ":" + installationId));
        MachineBoundSuffix = Convert.ToHexString(hash.AsSpan(0, 16)).ToLowerInvariant();
    }

    internal string MachineBoundSuffix { get; }

    internal long NextSequence()
    {
        lock (gate)
        {
            if (nextSequence == 0 || nextSequence > reservedThrough)
            {
                var fromClock = checked(Math.Max(0, clock.GetUtcNow().ToUnixTimeMilliseconds()) * 1_000);
                var start = Math.Max(checked(reservedThrough + 1), fromClock);
                var end = checked(start + SequenceBlockSize - 1);
                Persist(end); // Must be durable before any number in the block is sent.
                reservedThrough = end;
                nextSequence = start;
            }
            return nextSequence++;
        }
    }

    void Persist(long through)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write,
                FileShare.None, 4096, FileOptions.WriteThrough))
            {
                JsonSerializer.Serialize(file, new Persisted(installationId, through));
                file.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    internal static string CurrentMachineScope()
    {
        if (!OperatingSystem.IsWindows()) return Environment.MachineName;
        try
        {
            var machineGuid = Registry.GetValue(
                @"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography", "MachineGuid", null) as string;
            if (!string.IsNullOrWhiteSpace(machineGuid)) return machineGuid.Trim();
        }
        catch (Exception) { }
        return Environment.MachineName;
    }
}

// Program.Main holds this mutex for the UI lifetime. Without it, a second
// launch from the same installation could reuse the identity concurrently.
internal sealed class CollectorInstanceGuard : IDisposable
{
    readonly Mutex mutex;
    bool disposed;

    CollectorInstanceGuard(Mutex mutex) => this.mutex = mutex;

    internal static CollectorInstanceGuard? TryAcquire(string? scope = null)
    {
        var path = scope ?? Path.GetFullPath(CollectorInstallationState.DirectoryPath);
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(path.ToUpperInvariant()));
        var name = @"Global\JshenCollector-" + Convert.ToHexString(hash.AsSpan(0, 16));
        var mutex = new Mutex(false, name);
        bool acquired;
        try { acquired = mutex.WaitOne(0); }
        catch (AbandonedMutexException) { acquired = true; }
        if (acquired) return new CollectorInstanceGuard(mutex);
        mutex.Dispose();
        return null;
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        mutex.ReleaseMutex();
        mutex.Dispose();
    }
}
