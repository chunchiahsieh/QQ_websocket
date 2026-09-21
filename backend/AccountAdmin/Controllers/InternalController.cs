using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace AccountAdmin.Controllers;
[ApiController, Route("internal/accounts")]
public sealed class InternalController(AccountStore store,IConfiguration config) : ControllerBase
{
    public record LoginInput(string Username,string Password);
    public record ValidateInput(Guid Id,string Stamp);
    public record PayoutsInput(string? Username);
    bool Authorized() {
        var key=config["ADMIN_INTERNAL_KEY"];
        var supplied=Request.Headers["X-Internal-Key"].ToString();
        if (key?.Length >= 32 && supplied.Length <= 256)
            return CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(key)), SHA256.HashData(Encoding.UTF8.GetBytes(supplied)));
        // Development is loopback-only; production still requires the internal key.
        return Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") == "Development"
            && HttpContext.Connection.RemoteIpAddress is { } address && System.Net.IPAddress.IsLoopback(address)
            && string.IsNullOrEmpty(supplied);
    }
    [HttpPost("login"),EnableRateLimiting("login"),RequestSizeLimit(4096)]
    public IActionResult Login(LoginInput input) {
        // Distinguish service-to-service authentication failures from invalid
        // viewer credentials. The public application can then report the
        // correct operational fault instead of always blaming the password.
        if(!Authorized()) return StatusCode(StatusCodes.Status403Forbidden);
        if(string.IsNullOrEmpty(input.Username)||input.Username.Length>64||string.IsNullOrEmpty(input.Password)||input.Password.Length>128) return Unauthorized();
        var account=store.Login(input.Username,input.Password);
        return account==null?Unauthorized(new {message="帳號無效、已停用或已到期。"}):Ok(new {account.Id,account.Username,account.ExpiresAt,account.Stamp});
    }
    [HttpPost("validate"),RequestSizeLimit(4096)] public IActionResult Validate(ValidateInput input) {
        if(!Authorized()) return StatusCode(StatusCodes.Status403Forbidden);
        return Ok(new {valid=input.Stamp?.Length==64 && store.Validate(input.Id,input.Stamp)});
    }
    [HttpPost("payouts"),RequestSizeLimit(4096)] public IActionResult Payouts(PayoutsInput? input) {
        if(!Authorized()) return StatusCode(StatusCodes.Status403Forbidden);
        var snapshot = store.GetPayoutSnapshot(input?.Username);
        return Ok(new { pools = snapshot.Settings, payouts = snapshot.Records });
    }
}
