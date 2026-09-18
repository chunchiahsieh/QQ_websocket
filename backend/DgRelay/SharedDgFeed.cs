using System.Text.Json;
using System.Threading.Channels;

// One upstream for the dedicated server account; clients only subscribe to snapshots.
sealed class SharedDgFeed
{
    readonly object gate = new();
    readonly Dictionary<long, Channel<byte[]>> clients = new();
    readonly Dictionary<string, JsonElement> tables = new();
    readonly CancellationToken shutdown;
    readonly Func<Func<object, CancellationToken, Task>, CancellationToken, Task> capture;
    Task? worker;
    long nextId;
    DateTimeOffset packetAt, tableAt, retryAt;
    bool upstreamOpen;
    int generation;
    bool loginBlocked;
    bool accessBlocked;
    readonly string name;

    public SharedDgFeed(CancellationToken shutdown,
        Func<Func<object, CancellationToken, Task>, CancellationToken, Task> capture, string name = "DG")
    { this.shutdown = shutdown; this.capture = capture; this.name = name; }

    bool Healthy => upstreamOpen && tables.Count > 0
        && DateTimeOffset.UtcNow - packetAt < TimeSpan.FromSeconds(60)
        && DateTimeOffset.UtcNow - tableAt < TimeSpan.FromMinutes(3);

    public object Health { get { lock (gate) return new {
        healthy = Healthy, subscribers = clients.Count, generation,
        running = worker is { IsCompleted: false }, loginRequired = loginBlocked
    }; } }

    public void Connection(bool open) { lock (gate) upstreamOpen = open; }
    public void Packet() { lock (gate) packetAt = DateTimeOffset.UtcNow; }

    public (long Id, ChannelReader<byte[]> Reader) Subscribe()
    {
        lock (gate)
        {
            var channel = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(8) {
                SingleReader = true, FullMode = BoundedChannelFullMode.DropOldest
            });
            var id = ++nextId;
            clients.Add(id, channel);
            channel.Writer.TryWrite(Healthy ? Snapshot() : JsonSerializer.SerializeToUtf8Bytes(new {
                type = loginBlocked || accessBlocked ? "error" : "status",
                message = accessBlocked ? $"{name} 上游拒絕連線（HTTP 403），請確認服務存取權限；不代表密碼錯誤。" : loginBlocked ? $"{name} 登入未完成，請確認後台帳密或人工驗證。" : $"正在取得 {name} 桌況…"
            }));
            if (!loginBlocked && !accessBlocked && (worker == null || worker.IsCompleted) && !shutdown.IsCancellationRequested)
                worker = Task.Run(Run);
            return (id, channel.Reader);
        }
    }

    public void Unsubscribe(long id)
    { lock (gate) { if (clients.Remove(id, out var channel)) channel.Writer.TryComplete(); } }

    byte[] Snapshot() => JsonSerializer.SerializeToUtf8Bytes(new { type = "tables", tables = tables.Values.ToArray(), snapshot = true });
    void Broadcast(byte[] message) { foreach (var channel in clients.Values) channel.Writer.TryWrite(message); }

    public Task Publish(object value, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var message = JsonSerializer.SerializeToElement(value);
        lock (gate)
        {
            if (message.GetProperty("type").GetString() == "tables")
            {
                foreach (var table in message.GetProperty("tables").EnumerateArray())
                    tables[table.GetProperty("tableId").GetString()!] = table.Clone();
                tableAt = DateTimeOffset.UtcNow;
                Broadcast(Snapshot()); // Full snapshots make slow-client coalescing safe.
            }
            else Broadcast(JsonSerializer.SerializeToUtf8Bytes(value));
        }
        return Task.CompletedTask;
    }

    public void Invalidate()
    {
        lock (gate)
        {
            upstreamOpen = false; tables.Clear(); packetAt = default; tableAt = default;
            Broadcast(JsonSerializer.SerializeToUtf8Bytes(new { type = "reset", message = $"{name} 重新連線中…" }));
        }
    }

    async Task Run()
    {
        var failures = 0;
        try
        {
            while (!shutdown.IsCancellationRequested)
            {
                var delay = retryAt - DateTimeOffset.UtcNow;
                if (delay > TimeSpan.Zero) await Task.Delay(delay, shutdown);
                Invalidate();
                lock (gate) generation++;
                var started = DateTimeOffset.UtcNow;
                try { await capture(Publish, shutdown); }
                catch (UpstreamAccessDeniedException)
                {
                    lock (gate) accessBlocked = true;
                    Invalidate();
                    await Publish(new { type = "error", message = $"{name} 上游拒絕連線（HTTP 403），請確認服務存取權限；不代表密碼錯誤。" }, shutdown);
                    return;
                }
                catch (DgLoginRequiredException ex) when (!ex.Permanent)
                {
                    // An already-authenticated browser can be logged out by
                    // the upstream service (for example when another session
                    // replaces it). Recycle only that browser session and
                    // retry; do not permanently block the platform.
                    Invalidate();
                    await Publish(new { type = "reset", message = $"{name} 工作階段已更新，重新連線中…" }, shutdown);
                    failures = Math.Min(failures + 1, 4);
                    retryAt = DateTimeOffset.UtcNow.AddSeconds(Math.Min(30, 5 * Math.Pow(2, failures - 1)));
                }
                catch (DgLoginRequiredException ex)
                {
                    lock (gate) loginBlocked = true;
                    Invalidate();
                    var detail = string.IsNullOrWhiteSpace(ex.Message) ? "" : $"（{ex.Message}）";
                    await Publish(new { type = "error", message = $"{name} 登入未完成{detail}，請確認後台帳密或人工驗證後重啟服務。" }, shutdown);
                    return;
                }
                catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { return; }
                catch (Exception) { /* Never expose browser URLs or credential-bearing exceptions. */ }
                Invalidate();
                failures = DateTimeOffset.UtcNow - started > TimeSpan.FromMinutes(5) ? 1 : failures + 1;
                retryAt = DateTimeOffset.UtcNow.AddSeconds(Math.Min(60, 5 * Math.Pow(2, Math.Min(failures - 1, 4))));
            }
        }
        catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { }
        finally { if (!loginBlocked && !accessBlocked) Invalidate(); }
    }
}

sealed class DgLoginRequiredException : Exception
{
    public bool Permanent { get; }
    public DgLoginRequiredException(bool permanent = true) { Permanent = permanent; }
    public DgLoginRequiredException(string message, bool permanent = true) : base(message) { Permanent = permanent; }
}
sealed class UpstreamAccessDeniedException : Exception { }
