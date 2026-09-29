namespace CollectorDesktop;

// One official member login is shared while collection demand is active.
// MT and DG receive separate, short-lived game URLs and can refresh them
// independently.  The lock prevents concurrent platform retries from
// creating duplicate official logins.
public sealed class OfficialAuthorizationBroker : IDisposable
{
    readonly CollectorSettings settings;
    readonly SemaphoreSlim gate = new(1, 1);
    string? memberToken;

    public OfficialAuthorizationBroker(CollectorSettings settings) => this.settings = settings;

    public async Task InitializeAsync(CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try { await EnsureMemberTokenAsync(ct); }
        finally { gate.Release(); }
    }

    public async Task<string> GetGameUrlAsync(string gameCode, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            using var official = new OfficialPlatformClient(settings);
            var token = await EnsureMemberTokenAsync(official, ct);
            try
            {
                return await official.AuthorizeGameAsync(token, gameCode, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch
            {
                // A rejected / expired member token is refreshed once.  Do
                // not touch the peer platform's active browser session.
                memberToken = await official.LoginAsync(ct);
                return await official.AuthorizeGameAsync(memberToken, gameCode, ct);
            }
        }
        finally { gate.Release(); }
    }

    async Task EnsureMemberTokenAsync(CancellationToken ct)
    {
        using var official = new OfficialPlatformClient(settings);
        await EnsureMemberTokenAsync(official, ct);
    }

    async Task<string> EnsureMemberTokenAsync(OfficialPlatformClient official, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(memberToken)) memberToken = await official.LoginAsync(ct);
        return memberToken;
    }

    public void Dispose() => gate.Dispose();
}
