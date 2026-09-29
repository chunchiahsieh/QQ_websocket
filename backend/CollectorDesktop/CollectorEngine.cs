namespace CollectorDesktop;

public sealed class CollectorEngine : IAsyncDisposable
{
    readonly CollectorSettings settings;
    readonly Action<string, string> status;
    readonly Action<string> log;
    readonly CancellationTokenSource stop = new();
    Task? supervisor;
    CancellationTokenSource? capture;
    Task? captureTask;

    public CollectorEngine(CollectorSettings settings, Action<string, string> status, Action<string> log)
    { this.settings = settings; this.status = status; this.log = log; }

    public void Start()
    {
        if (supervisor is not null) return;
        supervisor = Task.Run(() => SuperviseAsync(stop.Token));
    }

    async Task SuperviseAsync(CancellationToken ct)
    {
        using var render = new RenderCollectorClient(settings);
        var viewerPresence = new ViewerPresenceTracker();
        var lastTransportMode = "";
        status("Render", "正在檢查觀看需求…");
        status("需求", "正在讀取觀看人數；持續採集中");
        // Start the official workers immediately. An authoritative zero-viewer
        // sample starts the five-minute idle countdown after this warm start.
        try
        {
            StartCapture(render, ct);
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    var restartedThisPoll = false;
                    if (viewerPresence.ShouldRunCapture && (captureTask is null || captureTask.IsCompleted))
                    {
                        log("採集工作意外結束，正在重新啟動 MT／DG／歐博。");
                        await StopCaptureAsync();
                        ct.ThrowIfCancellationRequested();
                        StartCapture(render, ct);
                        restartedThisPoll = true;
                    }

                    var demand = await render.GetDemandAsync(ct);
                    status("Render", render.TransportSummary);
                    if (render.TransportMode != lastTransportMode)
                    {
                        lastTransportMode = render.TransportMode;
                        log("Render 傳輸狀態：" + lastTransportMode);
                    }
                    var action = viewerPresence.Observe(demand.ViewerCount);
                    status("需求", demand.ViewerCount > 0
                        ? $"{demand.ViewerCount} 位觀看者：採集中"
                        : viewerPresence.ShouldRunCapture
                            ? "無觀看者：5 分鐘後待命"
                            : "無觀看者：已待命");
                    if (action == ViewerLifecycleAction.Restart)
                    {
                        log("觀看人數從 0 增至正數，正在重新啟動 MT／DG／歐博採集服務。");
                        if (!restartedThisPoll)
                        {
                            await StopCaptureAsync();
                            ct.ThrowIfCancellationRequested();
                            StartCapture(render, ct);
                        }
                    }
                    else if (action == ViewerLifecycleAction.Stop)
                    {
                        log("已連續 5 分鐘無觀看者，MT／DG／歐博採集服務已待命；持續監看觀看需求。");
                        await StopCaptureAsync();
                        status("MT", "待命"); status("DG", "待命"); status("AB", "待命");
                        await PublishOfflineAsync(render, "無觀看者 5 分鐘，本機採集器已待命。");
                    }
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
                catch (Exception ex) { status("Render", "連線失敗"); log("Render 需求檢查失敗：" + SafeMessage(ex)); }
                try { await Task.Delay(TimeSpan.FromSeconds(10), ct); }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            }
        }
        finally
        {
            await StopCaptureAsync();
            // A deliberate close must not leave Render showing the last
            // successful "connected" status after its snapshot expires.
            await PublishOfflineAsync(render, "本機採集器已正常停止。");
            status("MT", "已停止");
            status("DG", "已停止");
            status("AB", "已停止");
        }
    }

    void StartCapture(RenderCollectorClient render, CancellationToken ct)
    {
        var activeCapture = CancellationTokenSource.CreateLinkedTokenSource(ct);
        try
        {
            var task = Task.Run(() => CaptureAsync(render, activeCapture.Token), CancellationToken.None);
            capture = activeCapture;
            captureTask = task;
        }
        catch
        {
            activeCapture.Dispose();
            throw;
        }
    }

    async Task CaptureAsync(RenderCollectorClient render, CancellationToken ct)
    {
        using var broker = new OfficialAuthorizationBroker(settings);
        status("官方", "等待 MT/DG/歐博取得共用官方登入…");

        // MT and DG have separate short-lived game URLs.  Never share a
        // per-round cancellation token: a failure in one platform must not
        // cancel, duplicate or restart the other platform's collector.
        var mt = RunPlatformLoopAsync(
            "MT", "MTLI",
            (url, token) => new MtBrowserCollector(render, log).RunAsync(url, token),
            broker, render, ct);
        var dg = RunPlatformLoopAsync(
            "DG", "DGLI",
            (url, token) => new DgCollector(render, log).RunAsync(url, token),
            broker, render, ct);
        var ab = RunPlatformLoopAsync(
            "AB", "AB01",
            (url, token) => new AbCollector(render, log).RunAsync(url, token),
            broker, render, ct);
        await Task.WhenAll(mt, dg, ab);
    }

    async Task RunPlatformLoopAsync(
        string platform,
        string gameCode,
        Func<string, CancellationToken, Task> worker,
        OfficialAuthorizationBroker broker,
        RenderCollectorClient render,
        CancellationToken ct)
    {
        var failures = 0;
        var generation = 0;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                status(platform, "正在取得官方授權…");
                var gameUrl = await broker.GetGameUrlAsync(gameCode, ct);
                generation++;
                log(platform + " 採集工作階段 #" + generation + " 啟動。");
                using var attempt = CancellationTokenSource.CreateLinkedTokenSource(ct);
                try { await RunPlatformAsync(platform, worker(gameUrl, attempt.Token), render, ct); }
                finally { attempt.Cancel(); }
                if (!ct.IsCancellationRequested) throw new InvalidOperationException(platform + " 採集器意外結束。");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (Exception ex)
            {
                failures = Math.Min(failures + 1, 5);
                status(platform, "錯誤，將單獨重試");
                log(platform + " 採集輪次失敗：" + SafeMessage(ex));
                await Task.Delay(TimeSpan.FromSeconds(Math.Min(60, 5 * Math.Pow(2, failures))), ct);
            }
        }
    }

    async Task RunPlatformAsync(string platform, Task worker, RenderCollectorClient render, CancellationToken ct)
    {
        try {
            status(platform, "連線中");
            await worker;
            if (!ct.IsCancellationRequested) throw new InvalidOperationException(platform + " 採集器意外結束。");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception) when (ct.IsCancellationRequested) { throw new OperationCanceledException(ct); }
        catch (Exception ex) {
            status(platform, "錯誤，將重試"); log(platform + " 採集錯誤：" + SafeMessage(ex));
            try { await render.PublishStatusAsync(platform, "offline", platform + " 即時連線中斷，將自動重連。", CancellationToken.None); } catch { }
            throw;
        }
    }

    // Never add URLs, request bodies or credentials to the UI log. Exception
    // messages here are implementation/status messages only.
    static string SafeMessage(Exception ex) => string.IsNullOrWhiteSpace(ex.Message) ? ex.GetType().Name : ex.Message;

    async Task StopCaptureAsync()
    {
        var endingCapture = capture;
        var endingTask = captureTask;
        capture = null;
        captureTask = null;
        endingCapture?.Cancel();
        if (endingTask is not null)
        {
            try { await endingTask; }
            catch (OperationCanceledException) { }
            catch (Exception ex) { log("採集器停止時發生錯誤：" + SafeMessage(ex)); }
        }
        endingCapture?.Dispose();
    }

    async Task PublishOfflineAsync(RenderCollectorClient render, string message)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        try
        {
            await Task.WhenAll(
                render.PublishStatusAsync("MT", "offline", message, timeout.Token),
                render.PublishStatusAsync("DG", "offline", message, timeout.Token),
                render.PublishStatusAsync("AB", "offline", message, timeout.Token));
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested)
        {
            log("採集器停止狀態未能在 5 秒內送達 Render。");
        }
        catch (Exception ex)
        {
            log("採集器停止狀態送達 Render 失敗：" + SafeMessage(ex));
        }
    }

    public async ValueTask DisposeAsync()
    {
        stop.Cancel();
        if (supervisor is not null) try { await supervisor; } catch (OperationCanceledException) { }
        await StopCaptureAsync();
        stop.Dispose();
    }
}
