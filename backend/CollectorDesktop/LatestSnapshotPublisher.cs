namespace CollectorDesktop;

// The browser protocol can send a burst of per-table updates while the lobby
// is being populated.  Those packets must all be decoded, but publishing every
// intermediate full snapshot is both noisy and unsafe: a heartbeat that was
// captured a moment earlier could otherwise arrive after a newer snapshot and
// make the visible table count go backwards.
//
// This class deliberately coalesces only *already decoded full snapshots*.
// It never owns, drops, or reorders protocol packets.  A single publishing
// worker keeps Render writes ordered, waits briefly for an update burst to
// settle, and retries the newest complete snapshot on a transient failure.
public sealed class LatestSnapshotPublisher<T> : IAsyncDisposable
{
    readonly Func<T, CancellationToken, Task> publish;
    readonly Action<Exception> onFailure;
    readonly TimeSpan debounce;
    readonly TimeSpan retryDelay;
    readonly object gate = new();
    readonly SemaphoreSlim wake = new(0, 1);
    readonly CancellationTokenSource stop = new();
    readonly Task worker;

    T? latest;
    bool hasLatest;
    bool wakePending;
    bool keepAliveRequested;
    long latestVersion;
    long sentVersion;
    DateTimeOffset latestChangedAt;

    public LatestSnapshotPublisher(
        Func<T, CancellationToken, Task> publish,
        Action<Exception> onFailure,
        TimeSpan? debounce = null,
        TimeSpan? retryDelay = null)
    {
        this.publish = publish ?? throw new ArgumentNullException(nameof(publish));
        this.onFailure = onFailure ?? throw new ArgumentNullException(nameof(onFailure));
        this.debounce = debounce ?? TimeSpan.FromMilliseconds(300);
        this.retryDelay = retryDelay ?? TimeSpan.FromSeconds(2);
        if (this.debounce < TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(debounce));
        if (this.retryDelay < TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(retryDelay));
        worker = Task.Run(WorkerAsync);
    }

    // Replaces the pending full-state view with a newer one.  The caller has
    // already applied every source event to its local table state before this
    // method is called.
    public void Submit(T snapshot)
    {
        lock (gate)
        {
            if (stop.IsCancellationRequested) return;
            latest = snapshot;
            hasLatest = true;
            latestVersion++;
            latestChangedAt = DateTimeOffset.UtcNow;
            SignalUnsafe();
        }
    }

    // Reposts the latest accepted state so the private store's TTL cannot
    // expire between official table updates.  It never fabricates a snapshot.
    public void Pulse()
    {
        lock (gate)
        {
            if (stop.IsCancellationRequested || !hasLatest) return;
            keepAliveRequested = true;
            SignalUnsafe();
        }
    }

    void SignalUnsafe()
    {
        if (wakePending) return;
        wakePending = true;
        wake.Release();
    }

    async Task WorkerAsync()
    {
        try
        {
            while (true)
            {
                await wake.WaitAsync(stop.Token);
                lock (gate) wakePending = false;
                await FlushNewestAsync(stop.Token);
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
    }

    async Task FlushNewestAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            T snapshot;
            long version;
            DateTimeOffset changedAt;
            bool needsPublish;
            lock (gate)
            {
                if (!hasLatest) return;
                needsPublish = latestVersion > sentVersion || keepAliveRequested;
                if (!needsPublish) return;
                snapshot = latest!;
                version = latestVersion;
                changedAt = latestChangedAt;
            }

            // During a burst, always take a fresh look after the quiet period
            // instead of uploading an earlier partial lobby state.
            if (version > sentVersion)
            {
                var remaining = debounce - (DateTimeOffset.UtcNow - changedAt);
                if (remaining > TimeSpan.Zero)
                {
                    await Task.Delay(remaining, ct);
                    continue;
                }
            }

            try
            {
                await publish(snapshot, ct);
                lock (gate)
                {
                    if (version > sentVersion) sentVersion = version;
                    // A newer update that arrived during the HTTP call keeps
                    // its own request pending.  Do not erase it here.
                    if (version >= latestVersion) keepAliveRequested = false;
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                // UI logging must never be able to kill the one worker that
                // preserves/retries the newest complete snapshot.
                try { onFailure(ex); } catch { }
                await Task.Delay(retryDelay, ct);
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        stop.Cancel();
        try { await worker; } catch (OperationCanceledException) { }
        stop.Dispose();
        wake.Dispose();
    }
}
