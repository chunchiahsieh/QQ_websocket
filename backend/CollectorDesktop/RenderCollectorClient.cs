using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text.Json;

namespace CollectorDesktop;

// The official sockets stay on this Windows PC. This connection only forwards
// completed MT/DG/AB snapshots and receives Render viewer demand.
public sealed class RenderCollectorClient : IDisposable
{
    const string DefaultRelayUrl = CollectorDefaults.RelayUrl;
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    readonly HttpClient publicHttp;
    readonly HttpClient relayHttp;
    readonly Uri relaySocketUrl;
    readonly bool localMode;
    readonly string ingestKey;
    readonly string collectorId;
    readonly CollectorInstallationState installation;
    readonly SemaphoreSlim connectGate = new(1, 1);
    readonly SemaphoreSlim sendGate = new(1, 1);
    readonly SemaphoreSlim mtGate = new(1, 1);
    readonly SemaphoreSlim dgGate = new(1, 1);
    readonly SemaphoreSlim abGate = new(1, 1);
    readonly ConcurrentDictionary<(string, long), TaskCompletionSource<Ack>> pending = new();
    readonly CancellationTokenSource stop = new();
    readonly object stateGate = new();
    ClientWebSocket? socket;
    TaskCompletionSource<bool>? helloWaiter;
    DateTimeOffset nextConnectAt;
    DateTimeOffset demandReceivedAt;
    DateTimeOffset lastFrameAt;
    CollectorDemand? demandCache;
    bool helloAccepted;
    long mtAckMilliseconds = -1;
    long dgAckMilliseconds = -1;
    long abAckMilliseconds = -1;
    string mode = "尚未連線";

    public string TransportMode => Volatile.Read(ref mode);

    public string TransportSummary
    {
        get
        {
            var mt = Interlocked.Read(ref mtAckMilliseconds);
            var dg = Interlocked.Read(ref dgAckMilliseconds);
            var ab = Interlocked.Read(ref abAckMilliseconds);
            return Volatile.Read(ref mode) + "；MT ACK " + (mt < 0 ? "—" : mt + " ms")
                + "；DG ACK " + (dg < 0 ? "—" : dg + " ms")
                + "；歐博 ACK " + (ab < 0 ? "—" : ab + " ms");
        }
    }

    public RenderCollectorClient(CollectorSettings settings)
    {
        if (!Uri.TryCreate(settings.RenderUrl, UriKind.Absolute, out var publicUrl)
            || (publicUrl.Scheme != Uri.UriSchemeHttps && !(publicUrl.Scheme == Uri.UriSchemeHttp && IsPrivateLan(publicUrl))))
            throw new InvalidOperationException("Render 目標必須使用 HTTPS；區網測試只允許本機或私有區網 HTTP 網址。");
        if (settings.Target == CollectorTarget.Test && publicUrl.Host.Equals(new Uri(CollectorDefaults.RenderUrl).Host, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("測試區網站網址不得指向正式區。");
        localMode = publicUrl.Scheme == Uri.UriSchemeHttp;
        if (settings.IngestKey.Length < 32) throw new InvalidOperationException("採集端金鑰至少需要 32 個字元。");
        var relayEndpoint = settings.Target == CollectorTarget.Test
            ? settings.TestRelayUrl
            : DefaultRelayUrl;
        Uri? relayUrl = null;
        if (!localMode && (!Uri.TryCreate(relayEndpoint, UriKind.Absolute, out relayUrl) || relayUrl.Scheme != Uri.UriSchemeHttps))
            throw new InvalidOperationException("此區的採集轉送站網址必須是 HTTPS 完整網址；測試區不會退回正式區轉送站。");
        if (settings.Target == CollectorTarget.Test && !localMode && relayUrl!.Host.Equals(new Uri(DefaultRelayUrl).Host, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("測試區轉送站網址不得指向正式區。");
        var device = string.IsNullOrWhiteSpace(settings.DeviceId) ? "windows-collector-a" : settings.DeviceId.Trim();
        if (device.Length > 80) device = device[..80];
        installation = CollectorInstallationState.ForCurrentMachine();
        collectorId = device + "-" + installation.MachineBoundSuffix;
        ingestKey = settings.IngestKey;
        publicHttp = CreateHttp(publicUrl, ingestKey);
        relayHttp = localMode ? publicHttp : CreateHttp(relayUrl!, ingestKey);
        relaySocketUrl = localMode ? new Uri("wss://localhost/unused") : new UriBuilder(new Uri(relayUrl!, "/ws/ingest")) { Scheme = "wss", Port = -1 }.Uri;
    }

    static bool IsPrivateLan(Uri uri)
    {
        if (uri.IsLoopback) return true;
        if (!System.Net.IPAddress.TryParse(uri.Host, out var address)
            || address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork) return false;
        var bytes = address.GetAddressBytes();
        return bytes[0] == 10
            || bytes[0] == 127
            || (bytes[0] == 172 && bytes[1] is >= 16 and <= 31)
            || (bytes[0] == 192 && bytes[1] == 168);
    }

    static HttpClient CreateHttp(Uri baseAddress, string key)
    {
        var client = new HttpClient { BaseAddress = baseAddress, Timeout = TimeSpan.FromSeconds(12) };
        client.DefaultRequestHeaders.Add("X-Collector-Ingest-Key", key);
        return client;
    }

    public async Task<bool> ShouldCollectAsync(CancellationToken ct) =>
        (await GetDemandAsync(ct)).ShouldCollect;

    internal async Task<CollectorDemand> GetDemandAsync(CancellationToken ct)
    {
        if (localMode) return await ReadDemandAsync(publicHttp, ct);
        var connected = false;
        try
        {
            await EnsureConnectedAsync(ct);
            connected = true;
            lock (stateGate)
                if (demandCache is { } demand && DateTimeOffset.UtcNow - demandReceivedAt < TimeSpan.FromSeconds(20))
                    return demand;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception) { }
        // A failed WebSocket connection to an as-yet undeployed relay should
        // not cost a second HTTP timeout before checking the working site.
        if (!connected) return await ReadDemandAsync(publicHttp, ct);
        try { return await ReadDemandAsync(relayHttp, ct); }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception) { return await ReadDemandAsync(publicHttp, ct); }
    }

    static async Task<CollectorDemand> ReadDemandAsync(HttpClient client, CancellationToken ct)
    {
        using var response = await client.GetAsync("api/collector/demand", ct);
        response.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(ct));
        if (!CollectorDemand.TryParse(json.RootElement, out var demand))
            throw new InvalidDataException("Render 觀看需求資料格式不正確。");
        return demand;
    }

    public Task PublishStatusAsync(string platform, string status, string message, CancellationToken ct) =>
        PublishAsync(platform, new { type = "status", status, message }, isStatus: true, ct);

    public Task PublishSnapshotAsync(string platform, IReadOnlyCollection<Dictionary<string, object?>> tables, CancellationToken ct) =>
        PublishAsync(platform, new { type = "snapshot", tables }, isStatus: false, ct);

    async Task PublishAsync(string platform, object payload, bool isStatus, CancellationToken ct)
    {
        var gate = platform switch {
            "MT" => mtGate,
            "DG" => dgGate,
            "AB" => abGate,
            _ => throw new ArgumentOutOfRangeException(nameof(platform), platform, "不支援的採集平台。"),
        };
        await gate.WaitAsync(ct);
        try
        {
            if (localMode)
            {
                await PostToPublicAsync(platform, NextSequence(platform), payload, isStatus, ct);
                Volatile.Write(ref mode, "區網 HTTP 上傳中");
                return;
            }
            try
            {
                var sequence = NextSequence(platform);
                var elapsed = await PublishOverSocketAsync(platform, sequence, payload, ct);
                SetAckMilliseconds(platform, elapsed);
                Volatile.Write(ref mode, "WebSocket 上傳中");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (RelayRejectedException ex) when (isStatus && ex.Retryable)
            {
                // A previous collector instance owns the 45-second lease.
                // Status updates do not acquire ownership, so rejecting a
                // cosmetic "connecting" status must not abort the official
                // browser before its complete snapshot can be retried.
            }
            catch (RelayRejectedException) { throw; }
            catch (Exception)
            {
                // Temporary compatibility while the relay is being deployed.
                // A fresh sequence avoids replaying an ambiguous frame after
                // a WebSocket ACK was lost but the store accepted the frame.
                await PostToPublicAsync(platform, NextSequence(platform), payload, isStatus, ct);
                SetAckMilliseconds(platform, -1);
                Volatile.Write(ref mode, "HTTP 備援上傳中");
            }
        }
        finally { gate.Release(); }
    }

    // One durable global counter is strictly increasing for each individual
    // platform, including when this Windows process restarts.
    long NextSequence(string platform) => platform is "MT" or "DG" or "AB"
        ? installation.NextSequence()
        : throw new ArgumentOutOfRangeException(nameof(platform), platform, "不支援的採集平台。");

    void SetAckMilliseconds(string platform, long elapsed)
    {
        switch (platform) {
            case "MT": Interlocked.Exchange(ref mtAckMilliseconds, elapsed); break;
            case "DG": Interlocked.Exchange(ref dgAckMilliseconds, elapsed); break;
            case "AB": Interlocked.Exchange(ref abAckMilliseconds, elapsed); break;
        }
    }

    async Task<long> PublishOverSocketAsync(string platform, long sequence, object payload, CancellationToken ct)
    {
        var connection = await EnsureConnectedAsync(ct);
        var key = (platform, sequence);
        var waiter = new TaskCompletionSource<Ack>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!pending.TryAdd(key, waiter)) throw new InvalidOperationException("採集序號重複。");
        var clock = Stopwatch.StartNew();
        try
        {
            await SendAsync(connection, CreateFrame(platform, sequence, payload), ct);
            Ack ack;
            try { ack = await waiter.Task.WaitAsync(TimeSpan.FromSeconds(8), ct); }
            catch (TimeoutException)
            {
                BreakConnection(connection);
                throw new InvalidOperationException("WebSocket 確認逾時。");
            }
            if (!ack.Accepted)
                throw new RelayRejectedException(ack.Retryable
                    ? "Render 暫時拒絕最新快照，將保留完整資料重試。"
                    : "Render 拒絕採集資料格式，請檢查採集器與轉送站版本。", ack.Retryable);
            return clock.ElapsedMilliseconds;
        }
        finally { pending.TryRemove(key, out _); }
    }

    static Dictionary<string, object?> CreateFrame(string platform, long sequence, object payload)
    {
        var frame = new Dictionary<string, object?> { ["platform"] = platform, ["sequence"] = sequence };
        foreach (var property in JsonSerializer.SerializeToElement(payload, Json).EnumerateObject())
            frame[property.Name] = property.Value.Clone();
        return frame;
    }

    async Task PostToPublicAsync(string platform, long sequence, object payload, bool isStatus, CancellationToken ct)
    {
        var frame = CreateFrame(platform, sequence, payload);
        frame["collectorId"] = collectorId;
        using var response = await publicHttp.PostAsJsonAsync($"api/collector/ingest/{platform}", frame, Json, ct);
        response.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(ct));
        if (!isStatus && json.RootElement.TryGetProperty("accepted", out var accepted) && accepted.ValueKind == JsonValueKind.False)
            throw new InvalidOperationException(platform + " 快照被 Render 拒絕；將保留完整資料重試。");
    }

    async Task<ClientWebSocket> EnsureConnectedAsync(CancellationToken ct)
    {
        lock (stateGate)
            if (socket is { State: WebSocketState.Open } active && helloAccepted) return active;
        await connectGate.WaitAsync(ct);
        try
        {
            lock (stateGate)
            {
                if (socket is { State: WebSocketState.Open } active && helloAccepted) return active;
                if (DateTimeOffset.UtcNow < nextConnectAt)
                    throw new InvalidOperationException("WebSocket 正在等待重新連線。");
            }
            var connection = new ClientWebSocket();
            connection.Options.SetRequestHeader("X-Collector-Ingest-Key", ingestKey);
            connection.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct, stop.Token);
                timeout.CancelAfter(TimeSpan.FromSeconds(6));
                await connection.ConnectAsync(relaySocketUrl, timeout.Token);
                var hello = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                lock (stateGate) { socket = connection; helloWaiter = hello; helloAccepted = false; }
                _ = Task.Run(() => ReceiveLoopAsync(connection, stop.Token));
                await SendAsync(connection, new { type = "hello", protocol = 1, collectorId }, timeout.Token);
                await hello.Task.WaitAsync(TimeSpan.FromSeconds(6), timeout.Token);
                _ = Task.Run(() => PingLoopAsync(connection, stop.Token));
                return connection;
            }
            catch
            {
                BreakConnection(connection);
                connection.Dispose();
                lock (stateGate) nextConnectAt = DateTimeOffset.UtcNow.AddSeconds(5);
                throw;
            }
        }
        finally { connectGate.Release(); }
    }

    async Task SendAsync(ClientWebSocket connection, object frame, CancellationToken ct)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(frame, Json);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct, stop.Token);
        timeout.CancelAfter(TimeSpan.FromSeconds(5));
        var entered = false;
        try
        {
            await sendGate.WaitAsync(timeout.Token);
            entered = true;
            if (connection.State != WebSocketState.Open) throw new WebSocketException("WebSocket 已中斷。");
            await connection.SendAsync(bytes, WebSocketMessageType.Text, true, timeout.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested && !stop.IsCancellationRequested)
        {
            BreakConnection(connection);
            throw new InvalidOperationException("WebSocket 發送逾時，將重新連線。");
        }
        finally { if (entered) sendGate.Release(); }
    }

    async Task ReceiveLoopAsync(ClientWebSocket connection, CancellationToken ct)
    {
        try
        {
            var buffer = new byte[16 * 1024];
            while (!ct.IsCancellationRequested && connection.State == WebSocketState.Open)
            {
                using var frame = new MemoryStream();
                ValueWebSocketReceiveResult result;
                do
                {
                    result = await connection.ReceiveAsync(buffer.AsMemory(), ct);
                    if (result.MessageType == WebSocketMessageType.Close)
                        throw new WebSocketException("WebSocket 轉送站已關閉連線。");
                    if (result.MessageType != WebSocketMessageType.Text || frame.Length + result.Count > 1_500_000)
                        throw new InvalidDataException("轉送站訊息格式不正確。");
                    frame.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);
                using var json = JsonDocument.Parse(frame.GetBuffer().AsMemory(0, checked((int)frame.Length)));
                HandleFrame(connection, json.RootElement);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception) { }
        finally { BreakConnection(connection); }
    }

    void HandleFrame(ClientWebSocket connection, JsonElement frame)
    {
        if (!frame.TryGetProperty("type", out var type)) return;
        lock (stateGate)
            if (ReferenceEquals(socket, connection)) lastFrameAt = DateTimeOffset.UtcNow;
        switch (type.GetString())
        {
            case "hello":
                var accepted = frame.TryGetProperty("accepted", out var response) && response.ValueKind == JsonValueKind.True;
                lock (stateGate)
                {
                    if (!ReferenceEquals(socket, connection)) return;
                    helloAccepted = accepted;
                    if (frame.TryGetProperty("demand", out var initial)) RememberDemandUnsafe(initial);
                    if (accepted)
                    {
                        Volatile.Write(ref mode, "WebSocket 已連線");
                        helloWaiter?.TrySetResult(true);
                    }
                    else helloWaiter?.TrySetException(new InvalidOperationException("採集轉送站拒絕連線。"));
                }
                break;
            case "demand":
                lock (stateGate)
                    if (ReferenceEquals(socket, connection) && frame.TryGetProperty("demand", out var demand))
                        RememberDemandUnsafe(demand);
                break;
            case "ack":
                if (!frame.TryGetProperty("platform", out var platformField)
                    || !frame.TryGetProperty("sequence", out var sequenceField)
                    || !sequenceField.TryGetInt64(out var sequence)) return;
                var platform = platformField.GetString();
                if (platform is not null && pending.TryGetValue((platform, sequence), out var waiter))
                    waiter.TrySetResult(new Ack(
                        frame.TryGetProperty("accepted", out var ack) && ack.ValueKind == JsonValueKind.True,
                        frame.TryGetProperty("retryable", out var retry) && retry.ValueKind == JsonValueKind.True));
                break;
        }
    }

    void RememberDemandUnsafe(JsonElement frame)
    {
        if (!CollectorDemand.TryParse(frame, out var demand)) return;
        demandCache = demand;
        demandReceivedAt = DateTimeOffset.UtcNow;
    }

    async Task PingLoopAsync(ClientWebSocket connection, CancellationToken ct)
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(10));
            while (await timer.WaitForNextTickAsync(ct))
            {
                lock (stateGate)
                {
                    if (!ReferenceEquals(socket, connection)) return;
                    if (DateTimeOffset.UtcNow - lastFrameAt > TimeSpan.FromSeconds(35))
                        throw new InvalidOperationException("WebSocket 轉送站超過 35 秒未回應。");
                }
                await SendAsync(connection, new { type = "ping" }, ct);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception) { BreakConnection(connection); }
    }

    void BreakConnection(ClientWebSocket connection)
    {
        lock (stateGate)
        {
            if (!ReferenceEquals(socket, connection)) return;
            socket = null;
            helloAccepted = false;
            Volatile.Write(ref mode, "WebSocket 中斷");
            helloWaiter?.TrySetException(new InvalidOperationException("WebSocket 連線中斷。"));
            helloWaiter = null;
            nextConnectAt = DateTimeOffset.UtcNow.AddSeconds(2);
        }
        try { connection.Abort(); } catch { }
        connection.Dispose();
        foreach (var waiter in pending.Values)
            waiter.TrySetException(new InvalidOperationException("WebSocket 中斷，將重送最新快照。"));
    }

    public void Dispose()
    {
        stop.Cancel();
        ClientWebSocket? connection;
        lock (stateGate) connection = socket;
        if (connection is not null) BreakConnection(connection);
        publicHttp.Dispose();
        if (!ReferenceEquals(relayHttp, publicHttp)) relayHttp.Dispose();
        // Do not dispose gates while their asynchronous finally blocks may
        // still be releasing them during normal application shutdown.
    }

    sealed record Ack(bool Accepted, bool Retryable);
    sealed class RelayRejectedException(string message, bool retryable) : InvalidOperationException(message)
    {
        public bool Retryable { get; } = retryable;
    }
}
