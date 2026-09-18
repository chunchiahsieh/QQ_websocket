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
    bool Authorized() {
        var key=config["ADMIN_INTERNAL_KEY"];
        var supplied=Request.Headers["X-Internal-Key"].ToString();
        return key?.Length>=32 && supplied.Length<=256 && CryptographicOperations.FixedTimeEquals(
            SHA256.HashData(Encoding.UTF8.GetBytes(key)),SHA256.HashData(Encoding.UTF8.GetBytes(supplied)));
    }
    [HttpPost("login"),EnableRateLimiting("login"),RequestSizeLimit(4096)]
    public IActionResult Login(LoginInput input) {
        if(!Authorized()) return Unauthorized();
        if(string.IsNullOrEmpty(input.Username)||input.Username.Length>64||string.IsNullOrEmpty(input.Password)||input.Password.Length>128) return Unauthorized();
        var account=store.Login(input.Username,input.Password);
        return account==null?Unauthorized(new {message="帳號無效、已停用或已到期。"}):Ok(new {account.Id,account.Username,account.ExpiresAt,account.Stamp});
    }
    [HttpPost("validate"),RequestSizeLimit(4096)] public IActionResult Validate(ValidateInput input) {
        if(!Authorized()) return Unauthorized();
        return Ok(new {valid=input.Stamp?.Length==64 && store.Validate(input.Id,input.Stamp)});
    }
}
