using System.Net.WebSockets;

namespace CollectorRelay;

/// <summary>
/// Render runs this service as one instance, but a reconnect can overlap a
/// stale TCP/WebSocket connection.  This registry makes that overlap explicit:
/// exactly one producer may publish at a time.  AccountAdmin's persistent
/// collector lease remains the final cross-restart/cross-service safeguard.
/// </summary>
public sealed class CollectorSessionRegistry(RelaySettings settings)
{
    readonly object gate = new();
    ActiveSession? active;

    public bool TryAcquire(string collectorId, WebSocket socket, out CollectorSessionLease? lease, out WebSocket? replacedSocket, out string? rejection)
    {
        lock (gate) {
            var now = DateTimeOffset.UtcNow;
            var current = active;
            if (current is not null && (current.Socket.State != WebSocketState.Open || now - current.LastInboundAt > settings.ProducerIdleTimeout))
                active = current = null;

            // A reconnect from the same desktop run replaces the old socket.
            // A different active collector is refused rather than allowing two
            // browsers to race the same MT/DG feed.
            if (current is not null && !string.Equals(current.CollectorId, collectorId, StringComparison.Ordinal)) {
                lease = null;
                replacedSocket = null;
                rejection = "另一個採集端仍在連線中。";
                return false;
            }

            replacedSocket = current?.Socket;
            var next = new ActiveSession(collectorId, socket, Guid.NewGuid(), now);
            active = next;
            lease = new CollectorSessionLease(this, next);
            rejection = null;
            return true;
        }
    }

    internal void Touch(ActiveSession session)
    {
        lock (gate) {
            if (ReferenceEquals(active, session)) session.LastInboundAt = DateTimeOffset.UtcNow;
        }
    }

    internal void Release(ActiveSession session)
    {
        lock (gate) {
            if (ReferenceEquals(active, session)) active = null;
        }
    }

    public object Health()
    {
        lock (gate) {
            var now = DateTimeOffset.UtcNow;
            var current = active;
            var open = current is not null
                && current.Socket.State == WebSocketState.Open
                && now - current.LastInboundAt <= settings.ProducerIdleTimeout;
            return new {
                status = "ok",
                producerConnected = open,
                lastInboundAgeSeconds = open ? Math.Round((now - current!.LastInboundAt).TotalSeconds, 1) : (double?)null,
            };
        }
    }

    internal sealed class ActiveSession(string collectorId, WebSocket socket, Guid leaseId, DateTimeOffset lastInboundAt)
    {
        public string CollectorId { get; } = collectorId;
        public WebSocket Socket { get; } = socket;
        public Guid LeaseId { get; } = leaseId;
        public DateTimeOffset LastInboundAt { get; set; } = lastInboundAt;
    }
}

public sealed class CollectorSessionLease : IDisposable
{
    readonly CollectorSessionRegistry registry;
    readonly CollectorSessionRegistry.ActiveSession session;
    int released;

    internal CollectorSessionLease(CollectorSessionRegistry registry, CollectorSessionRegistry.ActiveSession session)
    {
        this.registry = registry;
        this.session = session;
    }

    public string CollectorId => session.CollectorId;
    public void Touch() => registry.Touch(session);

    public void Dispose()
    {
        if (Interlocked.Exchange(ref released, 1) == 0) registry.Release(session);
    }
}
