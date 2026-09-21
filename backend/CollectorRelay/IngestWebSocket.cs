using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CollectorRelay;

public static class IngestWebSocket
{
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static async Task HandleAsync(HttpContext context)
    {
        var settings = context.RequestServices.GetRequiredService<RelaySettings>();
        var registry = context.RequestServices.GetRequiredService<CollectorSessionRegistry>();
        var accountAdmin = context.RequestServices.GetRequiredService<AccountAdminClient>();

        if (!settings.IsIngestAuthorized(context.Request)) {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }
        if (!context.WebSockets.IsWebSocketRequest) {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            await context.Response.WriteAsJsonAsync(new { message = "此端點需要 WebSocket 連線。" }, context.RequestAborted);
            return;
        }

        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        using var connectionStop = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        var cancellationToken = connectionStop.Token;
        var sendGate = new SemaphoreSlim(1, 1);
        try {
            var hello = await ReceiveObjectAsync(socket, cancellationToken, TimeSpan.FromSeconds(15));
            if (!TryReadHello(hello, out var collectorId, out var helloError)) {
                if (hello is null) await CompleteCloseAsync(socket, cancellationToken);
                else
                await ClosePolicyViolationAsync(socket, helloError, cancellationToken);
                return;
            }

            if (!registry.TryAcquire(collectorId!, socket, out var lease, out var replacedSocket, out var rejection)) {
                await ClosePolicyViolationAsync(socket, rejection!, cancellationToken);
                return;
            }
            var acquiredLease = lease!;
            using (acquiredLease) {
                // A reconnect from the exact same desktop run takes over the
                // single writer lease. Abort is intentional: it makes any
                // late packet from the replaced socket impossible.
                if (replacedSocket is not null && !ReferenceEquals(replacedSocket, socket)) {
                    try { replacedSocket.Abort(); } catch { }
                }

                DemandSnapshot? initialDemand = null;
                try { initialDemand = await accountAdmin.GetDemandAsync(cancellationToken); }
                catch (Exception ex) when (IsExpectedUpstreamFailure(ex)) { }

                await SendAsync(socket, sendGate, new {
                    type = "hello", accepted = true, protocol = RelaySettings.ProtocolVersion,
                    demand = initialDemand is null ? null : ToWireDemand(initialDemand),
                }, cancellationToken);

                var demandTask = PumpDemandAsync(socket, sendGate, accountAdmin, connectionStop.Token);
                try {
                    while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open) {
                        JsonObject? message;
                        try { message = await ReceiveObjectAsync(socket, cancellationToken); }
                        catch (InvalidDataException) {
                            await ClosePolicyViolationAsync(socket, "採集資料格式或大小不正確。", cancellationToken);
                            return;
                        }
                        if (message is null) {
                            await CompleteCloseAsync(socket, cancellationToken);
                            return;
                        }
                        acquiredLease.Touch();
                        await HandleMessageAsync(socket, sendGate, accountAdmin, acquiredLease.CollectorId, message, cancellationToken);
                    }
                }
                finally {
                    connectionStop.Cancel();
                    try { await demandTask; } catch (OperationCanceledException) { }
                }
            }
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
        catch (WebSocketException) { }
        catch (InvalidDataException) {
            await ClosePolicyViolationAsync(socket, "採集資料格式或大小不正確。", CancellationToken.None);
        }
        finally {
            sendGate.Dispose();
        }
    }

    static async Task HandleMessageAsync(WebSocket socket, SemaphoreSlim sendGate, AccountAdminClient accountAdmin, string collectorId, JsonObject message, CancellationToken cancellationToken)
    {
        var type = ReadString(message, "type");
        if (type == "ping") {
            await SendAsync(socket, sendGate, new { type = "pong", serverAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }, cancellationToken);
            return;
        }
        if (type is not ("snapshot" or "status")) {
            await SendAsync(socket, sendGate, new { type = "error", code = "invalid_message", message = "採集訊息類型不正確。", retryable = false }, cancellationToken);
            return;
        }

        var platform = ReadString(message, "platform")?.ToUpperInvariant();
        var sequence = ReadLong(message, "sequence");
        if (platform is not ("MT" or "DG" or "AB") || sequence is null || sequence < 0 || !ValidPayload(message, type)) {
            await SendAsync(socket, sendGate, new { type = "ack", platform, sequence, accepted = false, retryable = false, message = "採集資料格式不正確。" }, cancellationToken);
            return;
        }

        // Do not trust any producer-supplied identity or timestamp. The
        // private store supplies its own receipt timestamp and the relay pins
        // identity to the authenticated WebSocket session.
        message.Remove("platform");
        message.Remove("receivedAt");
        message["collectorId"] = collectorId;

        try {
            var result = await accountAdmin.ForwardAsync(platform, message, cancellationToken);
            await SendAsync(socket, sendGate, new {
                type = "ack", platform, sequence, accepted = result.Accepted,
                retryable = !result.Accepted, receivedAt = result.ReceivedAt,
            }, cancellationToken);
        }
        catch (Exception ex) when (IsRetryableUpstreamFailure(ex, cancellationToken)) {
            await SendAsync(socket, sendGate, new {
                type = "ack", platform, sequence, accepted = false, retryable = true,
                message = "Render 儲存服務暫時無法使用，請保留最新完整快照後重試。",
            }, cancellationToken);
        }
    }

    static bool ValidPayload(JsonObject message, string type)
    {
        if (type == "snapshot") return message["tables"] is JsonArray tables && tables.Count <= RelaySettings.MaxTables;
        var status = ReadString(message, "status");
        if (status is not ("connected" or "connecting" or "offline")) return false;
        var text = ReadString(message, "message");
        return text is null || text.Length <= 2_000;
    }

    static async Task PumpDemandAsync(WebSocket socket, SemaphoreSlim sendGate, AccountAdminClient accountAdmin, CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(10));
        while (await timer.WaitForNextTickAsync(cancellationToken)) {
            try {
                var demand = await accountAdmin.GetDemandAsync(cancellationToken);
                await SendAsync(socket, sendGate, new { type = "demand", demand = ToWireDemand(demand) }, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { return; }
            catch (Exception ex) when (IsRetryableUpstreamFailure(ex, cancellationToken)) {
                // Do not end a healthy producer WebSocket because a single
                // private-service request failed. The next 10-second poll
                // retries and snapshot forwarding remains available.
                try {
                    await SendAsync(socket, sendGate, new { type = "demand", unavailable = true }, cancellationToken);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { return; }
                catch (WebSocketException) { return; }
            }
        }
    }

    static object ToWireDemand(DemandSnapshot demand) => new {
        shouldCollect = demand.ShouldCollect,
        viewerCount = demand.ViewerCount,
        lastViewerAt = demand.LastViewerAt,
        idleForMs = demand.IdleForMs,
    };

    static bool TryReadHello(JsonObject? message, out string? collectorId, out string error)
    {
        collectorId = null;
        error = "採集端握手格式不正確。";
        if (message is null || ReadString(message, "type") != "hello") return false;
        var protocol = ReadLong(message, "protocol");
        var candidate = ReadString(message, "collectorId")?.Trim();
        if (protocol != RelaySettings.ProtocolVersion || string.IsNullOrEmpty(candidate) || candidate.Length > 120) return false;
        collectorId = candidate;
        return true;
    }

    static string? ReadString(JsonObject value, string property) => value[property] is JsonValue item && item.TryGetValue<string>(out var text) ? text : null;
    static long? ReadLong(JsonObject value, string property) => value[property] is JsonValue item && item.TryGetValue<long>(out var number) ? number : null;

    static async Task<JsonObject?> ReceiveObjectAsync(WebSocket socket, CancellationToken cancellationToken, TimeSpan? timeout = null)
    {
        using var timeoutSource = timeout is null ? null : CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (timeout is { } timeoutValue) timeoutSource!.CancelAfter(timeoutValue);
        var token = timeoutSource?.Token ?? cancellationToken;
        var bytes = new byte[16 * 1024];
        using var frame = new MemoryStream();
        ValueWebSocketReceiveResult result;
        do {
            result = await socket.ReceiveAsync(bytes.AsMemory(), token);
            if (result.MessageType == WebSocketMessageType.Close) return null;
            if (result.MessageType != WebSocketMessageType.Text) throw new InvalidDataException();
            if (frame.Length + result.Count > RelaySettings.MaxMessageBytes) throw new InvalidDataException();
            frame.Write(bytes, 0, result.Count);
        } while (!result.EndOfMessage);

        try { return JsonNode.Parse(frame.GetBuffer().AsSpan(0, checked((int)frame.Length)))?.AsObject(); }
        catch (JsonException) { throw new InvalidDataException(); }
        catch (InvalidOperationException) { throw new InvalidDataException(); }
    }

    static async Task SendAsync(WebSocket socket, SemaphoreSlim sendGate, object message, CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(message, Json);
        await sendGate.WaitAsync(cancellationToken);
        try {
            if (socket.State == WebSocketState.Open)
                await socket.SendAsync(payload, WebSocketMessageType.Text, true, cancellationToken);
        }
        finally { sendGate.Release(); }
    }

    static async Task ClosePolicyViolationAsync(WebSocket socket, string description, CancellationToken cancellationToken)
    {
        if (socket.State is not WebSocketState.Open and not WebSocketState.CloseReceived) return;
        try { await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, description, cancellationToken); }
        catch (WebSocketException) { }
        catch (OperationCanceledException) { }
    }

    static async Task CompleteCloseAsync(WebSocket socket, CancellationToken cancellationToken)
    {
        if (socket.State != WebSocketState.CloseReceived) return;
        try { await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "closed", cancellationToken); }
        catch (WebSocketException) { }
        catch (OperationCanceledException) { }
    }

    static bool IsExpectedUpstreamFailure(Exception ex) => ex is AccountAdminUnavailableException or HttpRequestException or TaskCanceledException;
    static bool IsRetryableUpstreamFailure(Exception ex, CancellationToken cancellationToken) =>
        !cancellationToken.IsCancellationRequested && ex is not WebSocketException && ex is not OperationCanceledException;
}
