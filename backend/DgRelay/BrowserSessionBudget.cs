// Render's free instance has limited memory. Keep the number of upstream
// browser sessions bounded so switching platforms cannot launch several Edge
// processes at the same time.
static class BrowserSessionBudget
{
    public static readonly SemaphoreSlim Gate = new(1, 1);
}
