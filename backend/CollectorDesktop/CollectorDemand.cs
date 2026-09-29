using System.Text.Json;

namespace CollectorDesktop;

internal readonly record struct CollectorDemand(bool ShouldCollect, long ViewerCount)
{
    public static bool TryParse(JsonElement value, out CollectorDemand demand)
    {
        demand = default;
        if (value.ValueKind != JsonValueKind.Object
            || !value.TryGetProperty("shouldCollect", out var shouldCollect)
            || shouldCollect.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
            || !value.TryGetProperty("viewerCount", out var viewerCount)
            || viewerCount.ValueKind != JsonValueKind.Number
            || !viewerCount.TryGetInt64(out var count)
            || count < 0) return false;

        demand = new CollectorDemand(shouldCollect.ValueKind == JsonValueKind.True, count);
        return true;
    }
}

internal enum ViewerLifecycleAction { None, Restart, Stop }

// Failed demand reads never call Observe. Expiry is acted on only when another
// authoritative zero-viewer sample arrives, so an outage cannot stop capture.
internal sealed class ViewerPresenceTracker
{
    readonly TimeProvider clock;
    readonly TimeSpan idleTimeout;
    bool? hadViewers;
    DateTimeOffset? emptySince;

    public ViewerPresenceTracker(TimeProvider? clock = null, TimeSpan? idleTimeout = null)
    {
        this.clock = clock ?? TimeProvider.System;
        this.idleTimeout = idleTimeout ?? TimeSpan.FromMinutes(5);
        if (this.idleTimeout <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(idleTimeout));
    }

    public bool ShouldRunCapture { get; private set; } = true;

    public ViewerLifecycleAction Observe(long viewerCount)
    {
        if (viewerCount < 0) throw new ArgumentOutOfRangeException(nameof(viewerCount));
        var hasViewers = viewerCount > 0;
        if (hasViewers)
        {
            var becameOccupied = hadViewers == false;
            hadViewers = true;
            emptySince = null;
            ShouldRunCapture = true;
            return becameOccupied ? ViewerLifecycleAction.Restart : ViewerLifecycleAction.None;
        }

        if (hadViewers != false) emptySince = clock.GetUtcNow();
        hadViewers = hasViewers;
        if (ShouldRunCapture && emptySince is { } since && clock.GetUtcNow() - since >= idleTimeout)
        {
            ShouldRunCapture = false;
            return ViewerLifecycleAction.Stop;
        }
        return ViewerLifecycleAction.None;
    }
}
