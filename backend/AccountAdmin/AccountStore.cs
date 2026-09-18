using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;

namespace AccountAdmin;

public sealed record Account(Guid Id, string Username, string PasswordHash, bool Enabled, DateTimeOffset ExpiresAt, string Stamp);
public sealed record AccountView(Guid Id, string Username, bool Enabled, DateTimeOffset ExpiresAt);
public sealed record FileData(int Version, string AdminName, string AdminHash, string AdminStamp, List<Account> Accounts);

public sealed class AccountStore : IDisposable
{
    readonly string file;
    readonly FileStream processLock;
    readonly object gate = new();
    readonly PasswordHasher<string> hasher = new(Microsoft.Extensions.Options.Options.Create(new PasswordHasherOptions { IterationCount = 210000 }));
    FileData data = null!;
    readonly string dummyHash;
    public AccountStore(string directory) {
        Directory.CreateDirectory(directory); file = Path.Combine(directory, "accounts.json");
        // Exactly one writer process; a second instance fails rather than overwriting data.
        processLock = new FileStream(Path.Combine(directory,"writer.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        dummyHash = hasher.HashPassword("dummy", Convert.ToHexString(RandomNumberGenerator.GetBytes(32)));
    }
    public void Initialize(string admin, string? password) {
        lock (gate) {
            if (File.Exists(file)) {
                data = JsonSerializer.Deserialize<FileData>(File.ReadAllText(file)) ?? throw new InvalidDataException("Invalid account file.");
                if (data.Version != 1 || data.Accounts == null || string.IsNullOrEmpty(data.AdminHash)) throw new InvalidDataException("Invalid account schema.");
                return;
            }
            ValidateName(admin); ValidateAdminPassword(password);
            Save(new(1, admin, hasher.HashPassword(admin,password!), NewStamp(), []));
        }
    }
    public string? LoginAdmin(string username, string password) {
        lock(gate) { var match = string.Equals(username,data.AdminName,StringComparison.OrdinalIgnoreCase);
            return Verify(match ? data.AdminHash : dummyHash,password) && match ? data.AdminStamp : null; }
    }
    public bool IsAdminSession(string? stamp) { lock(gate) return stamp != null && stamp == data.AdminStamp; }
    public List<AccountView> List() { lock(gate) return data.Accounts.OrderBy(a=>a.Username).Select(a=>new AccountView(a.Id,a.Username,a.Enabled,a.ExpiresAt)).ToList(); }
    public Account? Login(string username, string password) {
        lock(gate) {
            var account = data.Accounts.FirstOrDefault(a=>a.Username.Equals(username,StringComparison.OrdinalIgnoreCase));
            var valid = Verify(account?.PasswordHash ?? dummyHash,password);
            return valid && account is { Enabled:true } && account.ExpiresAt > DateTimeOffset.UtcNow ? account : null;
        }
    }
    public bool Validate(Guid id, string stamp) { lock(gate) return data.Accounts.Any(a=>a.Id==id && a.Stamp==stamp && a.Enabled && a.ExpiresAt>DateTimeOffset.UtcNow); }
    public void Create(string username, string password, DateTimeOffset expires) {
        username=username.Trim(); ValidateName(username); ValidatePassword(password);
        if(expires<=DateTimeOffset.UtcNow) throw new ArgumentException("到期時間必須晚於現在。");
        lock(gate) {
            if(data.Accounts.Any(a=>a.Username.Equals(username,StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("帳號已存在。");
            Save(data with { Accounts = [..data.Accounts,new(Guid.NewGuid(),username,hasher.HashPassword(username,password),true,expires.ToUniversalTime(),NewStamp())] });
        }
    }
    public void Update(Guid id, bool enabled, DateTimeOffset expires, string? password) {
        if(!string.IsNullOrEmpty(password)) ValidatePassword(password);
        lock(gate) {
            var current = data.Accounts.FirstOrDefault(a=>a.Id==id) ?? throw new ArgumentException("找不到帳號。");
            var updated = current with { Enabled=enabled, ExpiresAt=expires.ToUniversalTime(),
                PasswordHash=string.IsNullOrEmpty(password)?current.PasswordHash:hasher.HashPassword(current.Username,password),
                Stamp=NewStamp() };
            Save(data with { Accounts = data.Accounts.Select(a=>a.Id==id?updated:a).ToList() });
        }
    }
    public bool ChangeAdminPassword(string current, string next) {
        ValidateAdminPassword(next);
        lock(gate) { if(!Verify(data.AdminHash,current)) return false;
            Save(data with { AdminHash=hasher.HashPassword(data.AdminName,next),AdminStamp=NewStamp() }); return true; }
    }
    bool Verify(string hash,string password) => hasher.VerifyHashedPassword("",hash,password)!=PasswordVerificationResult.Failed;
    static string NewStamp() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    static void ValidateName(string name) { if(!Regex.IsMatch(name,@"^[a-zA-Z0-9_.-]{3,64}$")) throw new ArgumentException("帳號須為 3–64 位英數字、底線、句點或減號。"); }
    static void ValidatePassword(string? value) { if(value is null || value.Length<6 || value.Length>128) throw new ArgumentException("密碼須為 6–128 個字元。"); }
    static void ValidateAdminPassword(string? value) { if(value is null || value.Length<4 || value.Length>128) throw new ArgumentException("管理員密碼須為 4–128 個字元。"); }
    void Save(FileData next) {
        var temporary=file+"."+Guid.NewGuid().ToString("N")+".tmp";
        try {
            using(var stream=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
                JsonSerializer.Serialize(stream,next,new JsonSerializerOptions { WriteIndented=true }); stream.Flush(true);
            }
            if(!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary,UnixFileMode.UserRead|UnixFileMode.UserWrite);
            if(File.Exists(file)) File.Replace(temporary,file,file+".bak"); else File.Move(temporary,file);
            data=next; // Publish only after the durable write succeeds.
        } finally { if(File.Exists(temporary)) File.Delete(temporary); }
    }
    public void Dispose() => processLock.Dispose();
}
