using AccountAdmin;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using System.Threading.RateLimiting;
using System.Security.AccessControl;
using System.Security.Principal;

var builder = WebApplication.CreateBuilder(args);
// Render injects PORT and requires a public bind.  Local development keeps
// the original loopback endpoint unless ADMIN_URLS is explicitly configured.
var configuredUrls = builder.Configuration["ADMIN_URLS"];
var renderPort = Environment.GetEnvironmentVariable("PORT");
builder.WebHost.UseUrls(!string.IsNullOrWhiteSpace(configuredUrls)
    ? configuredUrls
    : !string.IsNullOrWhiteSpace(renderPort)
        ? $"http://0.0.0.0:{renderPort}"
        : "http://127.0.0.1:5092");
var dataPath = Path.GetFullPath(builder.Configuration["ADMIN_DATA_DIR"] ??
    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TableAccountAdmin"));
var root = Path.GetFullPath(builder.Environment.ContentRootPath);
if (dataPath.Equals(root, StringComparison.OrdinalIgnoreCase) || dataPath.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
    throw new InvalidOperationException("ADMIN_DATA_DIR must be outside the application directory.");
Directory.CreateDirectory(dataPath);
if (OperatingSystem.IsWindows()) {
    var permissions = new DirectorySecurity();
    permissions.SetAccessRuleProtection(true, false);
    var identities = new[] { WindowsIdentity.GetCurrent().User!, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
        new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null) };
    foreach (var identity in identities) permissions.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.FullControl,
        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
    new DirectoryInfo(dataPath).SetAccessControl(permissions);
}
if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(dataPath, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
builder.Services.AddSingleton(new AccountStore(dataPath));
builder.Services.AddSingleton(new SharedFeedStore(dataPath));
var protection = builder.Services.AddDataProtection().PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(dataPath, "keys"))).SetApplicationName("TableAccountAdmin");
if (OperatingSystem.IsWindows()) protection.ProtectKeysWithDpapi();
builder.Services.AddControllersWithViews();
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme).AddCookie(options => {
    options.Cookie.Name = "account_admin"; options.Cookie.HttpOnly = true; options.Cookie.SameSite = SameSiteMode.Strict;
    options.Cookie.SecurePolicy = builder.Environment.IsDevelopment() ? CookieSecurePolicy.SameAsRequest : CookieSecurePolicy.Always;
    options.LoginPath = "/Admin/Login"; options.ExpireTimeSpan = TimeSpan.FromMinutes(30); options.SlidingExpiration = false;
    options.Events.OnValidatePrincipal = async context => {
        var store = context.HttpContext.RequestServices.GetRequiredService<AccountStore>();
        if (!store.IsAdminSession(context.Principal?.FindFirst("stamp")?.Value)) {
            context.RejectPrincipal(); await context.HttpContext.SignOutAsync();
        }
    };
});
builder.Services.AddAuthorization();
builder.Services.AddRateLimiter(options => {
    options.RejectionStatusCode = 429;
    options.AddPolicy("login", context => RateLimitPartition.GetFixedWindowLimiter(
        context.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => new FixedWindowRateLimiterOptions {
            PermitLimit = 10, Window = TimeSpan.FromMinutes(1), QueueLimit = 0
        }));
});
var app = builder.Build();
var store = app.Services.GetRequiredService<AccountStore>();
store.Initialize(builder.Configuration["ADMIN_BOOTSTRAP_USER"] ?? "admin", builder.Configuration["ADMIN_BOOTSTRAP_PASSWORD"]);
if (!app.Environment.IsDevelopment()) { app.UseExceptionHandler("/Admin/Error"); app.UseHsts(); app.UseHttpsRedirection(); }
app.Use(async (context, next) => {
    context.Response.Headers.CacheControl = "no-store";
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    context.Response.Headers["X-Frame-Options"] = "DENY";
    context.Response.Headers["Content-Security-Policy"] = "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'";
    await next();
});
app.UseRouting(); app.UseRateLimiter(); app.UseAuthentication(); app.UseAuthorization();
app.MapControllers();
app.MapControllerRoute("default", "{controller=Admin}/{action=Index}/{id?}");
app.Run();
