namespace CollectorDesktop;

public sealed class CollectorEngine : IAsyncDisposable
{
    readonly CollectorSettings settings;
    readonly Action<string, string> status;
    readonly Action<string> log;
    readonly CancellationTokenSource stop = new();
    Task? supervisor;
    CancellationTokenSource? capture;

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
        var collecting = false;
        status("Render", "正在檢查觀看需求…");
        while (!ct.IsCancellationRequested) {
            try {
                var demand = await render.ShouldCollectAsync(ct);
                status("需求", demand ? "有觀看者：採集中" : "無觀看者：待命");
                if (demand && !collecting) {
                    collecting = true; capture = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    await render.PublishStatusAsync("MT", "connecting", "正在由本機採集器登入官方平台…", ct);
                    await render.PublishStatusAsync("DG", "connecting", "正在由本機採集器登入官方平台…", ct);
                    _ = Task.Run(() => CaptureAsync(render, capture.Token), CancellationToken.None);
                }
                if (!demand && collecting) {
                    collecting = false; capture?.Cancel(); capture?.Dispose(); capture = null;
                    await render.PublishStatusAsync("MT", "offline", "無觀看者需求，本機採集器已待命。", ct);
                    await render.PublishStatusAsync("DG", "offline", "無觀看者需求，本機採集器已待命。", ct);
                    status("MT", "待命"); status("DG", "待命");
                }
            } catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex) { status("Render", "連線失敗"); log("Render 需求檢查失敗：" + SafeMessage(ex)); }
            await Task.Delay(TimeSpan.FromSeconds(10), ct);
        }
    }

    async Task CaptureAsync(RenderCollectorClient render, CancellationToken ct)
    {
        var failures = 0;
        while (!ct.IsCancellationRequested) {
            try {
                status("官方", "正在登入並取得 MT/DG 授權…");
                using var official = new OfficialPlatformClient(settings);
                var launch = await official.AuthorizeAsync(ct);
                status("官方", "MT/DG 授權已取得");
                using var round = CancellationTokenSource.CreateLinkedTokenSource(ct);
                var mt = RunPlatformAsync("MT", new MtCollector(render, log).RunAsync(launch.MtUrl, round.Token), render, round.Token);
                var dg = RunPlatformAsync("DG", new DgCollector(render, log).RunAsync(launch.DgUrl, round.Token), render, round.Token);
                // MTLI/DGLI are issued from one official login. When either
                // expires, discard that short-lived authorization as a unit;
                // no snapshot is deleted from Render during this recovery.
                var first = await Task.WhenAny(mt, dg);
                await first;
                round.Cancel();
                try { await Task.WhenAll(mt, dg); } catch (OperationCanceledException) { }
                failures = 0;
            } catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex) {
                failures = Math.Min(failures + 1, 5);
                log("採集輪次失敗：" + SafeMessage(ex)); status("官方", "授權或連線失敗，將重試");
            }
            await Task.Delay(TimeSpan.FromSeconds(Math.Min(60, 5 * Math.Pow(2, failures))), ct);
        }
    }

    async Task RunPlatformAsync(string platform, Task worker, RenderCollectorClient render, CancellationToken ct)
    {
        try { status(platform, "連線中"); await worker; }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex) {
            status(platform, "錯誤，將重試"); log(platform + " 採集錯誤：" + SafeMessage(ex));
            try { await render.PublishStatusAsync(platform, "offline", platform + " 本機採集器連線中斷，將重新授權。", CancellationToken.None); } catch { }
            throw;
        }
    }

    // Never add URLs, request bodies or credentials to the UI log. Exception
    // messages here are implementation/status messages only.
    static string SafeMessage(Exception ex) => string.IsNullOrWhiteSpace(ex.Message) ? ex.GetType().Name : ex.Message;
    public async ValueTask DisposeAsync() { stop.Cancel(); capture?.Cancel(); if (supervisor is not null) try { await supervisor; } catch (OperationCanceledException) { } stop.Dispose(); capture?.Dispose(); }
}
