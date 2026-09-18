using System.Globalization;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace AccountAdmin.Controllers;
[Authorize]
[AutoValidateAntiforgeryToken]
public sealed class AdminController(AccountStore store) : Controller
{
    public IActionResult Index() => View(new AdminDashboardView(store.List(), store.ListPayoutSettings(), store.ListPayoutRecords()));
    [AllowAnonymous, HttpGet] public IActionResult Login() => View();
    [AllowAnonymous, HttpPost, EnableRateLimiting("login")]
    public async Task<IActionResult> Login(string username, string password) {
        if(username?.Length>64 || password?.Length>128 || string.IsNullOrEmpty(username) || string.IsNullOrEmpty(password)) return LoginError();
        var stamp=store.LoginAdmin(username,password); if(stamp==null) return LoginError();
        await HttpContext.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme,new ClaimsPrincipal(new ClaimsIdentity(
            new[] {new Claim(ClaimTypes.Name,username),new Claim("stamp",stamp)},CookieAuthenticationDefaults.AuthenticationScheme)));
        return RedirectToAction(nameof(Index));
    }
    IActionResult LoginError() { ViewBag.Error="帳號或密碼不正確。"; return View("Login"); }
    [HttpPost] public async Task<IActionResult> Logout() { await HttpContext.SignOutAsync(); return RedirectToAction(nameof(Login)); }
    [HttpPost] public IActionResult Create(string username,string password,string expires) => Change(()=>store.Create(username ?? "",password ?? "",ParseDate(expires)));
    [HttpPost] public IActionResult Update(Guid id,bool enabled,string expires,string? password) => Change(()=>store.Update(id,enabled,ParseDate(expires),password));
    [HttpPost] public IActionResult Delete(Guid id) => Change(()=>store.Delete(id));
    [HttpPost] public IActionResult SavePayout(List<PayoutInput> payouts) => Change(() => store.UpdatePayoutSettings(payouts.Select(item => new PayoutSetting(item.Code ?? "", item.Name ?? "", item.Amount, item.BaseAmount, item.CapAmount, true))));
    [HttpPost] public IActionResult AwardPayout(string username, string code, decimal amount) => Change(() => store.AwardPayout(username ?? "", code ?? "", amount), "派彩完成，該類獎池已回到下限並開始重新累積。");
    [HttpPost] public async Task<IActionResult> Password(string current,string next) {
        try {
            if(!store.ChangeAdminPassword(current ?? "",next ?? "")) { TempData["Error"]="目前密碼不正確。"; return RedirectToAction(nameof(Index)); }
            await HttpContext.SignOutAsync(); return RedirectToAction(nameof(Login));
        } catch(ArgumentException e) { TempData["Error"]=e.Message; return RedirectToAction(nameof(Index)); }
    }
    IActionResult Change(Action action, string success = "已儲存。帳號變更後，舊驗證憑據失效。") {
        try { action(); TempData["Success"] = success; }
        catch(ArgumentException e) { TempData["Error"]=e.Message; }
        return RedirectToAction(nameof(Index));
    }
    static DateTimeOffset ParseDate(string value) {
        if(!DateTime.TryParseExact(value,"yyyy-MM-ddTHH:mm",CultureInfo.InvariantCulture,DateTimeStyles.None,out var date))
            throw new ArgumentException("請填寫有效的到期時間。");
        return new DateTimeOffset(DateTime.SpecifyKind(date,DateTimeKind.Unspecified),TimeSpan.FromHours(8));
    }
    [AllowAnonymous] public IActionResult Error() => Problem("服務發生錯誤，請聯絡管理員。請勿重複提交，先確認資料是否已儲存。",statusCode:500);

    public sealed class PayoutInput {
        public string? Code { get; set; }
        public string? Name { get; set; }
        public decimal Amount { get; set; }
        public decimal BaseAmount { get; set; }
        public decimal CapAmount { get; set; }
    }
}
