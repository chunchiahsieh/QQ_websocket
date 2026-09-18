using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;

namespace AccountAdmin;

public sealed record Account(Guid Id, string Username, string PasswordHash, bool Enabled, DateTimeOffset ExpiresAt, string Stamp);
public sealed record AccountView(Guid Id, string Username, bool Enabled, DateTimeOffset ExpiresAt);
public sealed record PayoutSetting(string Code, string Name, decimal Amount, decimal BaseAmount, decimal CapAmount, bool Enabled);
public sealed record PayoutRecord(Guid Id, string Username, string CategoryCode, string CategoryName, decimal Amount, DateTimeOffset CreatedAt);
public sealed record PayoutSnapshot(List<PayoutSetting> Settings, List<PayoutRecord> Records);
public sealed record AdminDashboardView(List<AccountView> Accounts, List<PayoutSetting> PayoutSettings, List<PayoutRecord> PayoutRecords);
public sealed record FileData(int Version, string AdminName, string AdminHash, string AdminStamp, List<Account> Accounts);

public sealed class AccountStore : IDisposable
{
    readonly string file;
    readonly string payoutFile;
    readonly string payoutRecordsFile;
    readonly FileStream processLock;
    readonly object gate = new();
    readonly PasswordHasher<string> hasher = new(Microsoft.Extensions.Options.Options.Create(new PasswordHasherOptions { IterationCount = 210000 }));
    FileData data = null!;
    readonly string dummyHash;
    public AccountStore(string directory) {
        Directory.CreateDirectory(directory); file = Path.Combine(directory, "accounts.json"); payoutFile = Path.Combine(directory, "payout-settings.json"); payoutRecordsFile = Path.Combine(directory, "payout-records.json");
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
    public List<PayoutSetting> ListPayoutSettings() { lock (gate) return ReadPayoutSettings(); }
    public List<PayoutRecord> ListPayoutRecords(int limit = 100) {
        lock (gate) return ReadPayoutRecords().OrderByDescending(item => item.CreatedAt).Take(Math.Clamp(limit, 1, 500)).ToList();
    }
    public PayoutSnapshot GetPayoutSnapshot(string? username = null, int limit = 50) {
        lock (gate) {
            var records = ReadPayoutRecords().Where(item => string.IsNullOrWhiteSpace(username) || item.Username.Equals(username.Trim(), StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(item => item.CreatedAt).Take(Math.Clamp(limit, 1, 500)).ToList();
            return new(ReadPayoutSettings(), records);
        }
    }
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
    public void Delete(Guid id) {
        lock (gate) {
            if (!data.Accounts.Any(a => a.Id == id)) throw new ArgumentException("找不到帳號。");
            Save(data with { Accounts = data.Accounts.Where(a => a.Id != id).ToList() });
        }
    }
    public PayoutRecord AwardPayout(string username, string code, decimal amount) {
        username = username.Trim(); code = code.Trim().ToUpperInvariant();
        ValidateName(username);
        if (amount <= 0) throw new ArgumentException("派彩金額必須大於 0。");
        lock (gate) {
            var account = data.Accounts.FirstOrDefault(item => item.Username.Equals(username, StringComparison.OrdinalIgnoreCase));
            if (account is null) throw new ArgumentException("找不到指定的使用者帳號。");
            if (!account.Enabled || account.ExpiresAt <= DateTimeOffset.UtcNow) throw new ArgumentException("指定的使用者帳號已停用或到期。");
            var settings = ReadPayoutSettings();
            var setting = settings.FirstOrDefault(item => item.Code.Equals(code, StringComparison.OrdinalIgnoreCase));
            if (setting is null) throw new ArgumentException("派彩類別不存在。");
            if (amount < setting.BaseAmount || amount > setting.CapAmount)
                throw new ArgumentException($"派彩金額必須介於 {setting.BaseAmount:N2} 與 {setting.CapAmount:N2} 之間。");
            if (amount < setting.Amount)
                throw new ArgumentException($"派彩金額不可低於目前累積獎金 {setting.Amount:N2}。");
            var record = new PayoutRecord(Guid.NewGuid(), account.Username, setting.Code, setting.Name, decimal.Round(amount, 2), DateTimeOffset.UtcNow);
            var nextSettings = settings.Select(item => item.Code.Equals(setting.Code, StringComparison.OrdinalIgnoreCase)
                ? item with { Amount = item.BaseAmount } : item).ToList();
            var previousRecords = ReadPayoutRecords();
            var nextRecords = new List<PayoutRecord> { record };
            nextRecords.AddRange(previousRecords);
            try {
                SavePayoutRecords(nextRecords);
                SavePayout(nextSettings);
            } catch {
                try { SavePayoutRecords(previousRecords); } catch { }
                try { SavePayout(settings); } catch { }
                throw;
            }
            return record;
        }
    }
    public void UpdatePayoutSettings(IEnumerable<PayoutSetting> settings) {
        var next = settings.ToList();
        if (next.Count != 4 || next.Select(item => item.Code).Distinct(StringComparer.OrdinalIgnoreCase).Count() != 4)
            throw new ArgumentException("派彩設定必須包含 GRAND、MAJOR、MINOR、MINI 四類。");
        foreach (var item in next) {
            if (!new[] { "GRAND", "MAJOR", "MINOR", "MINI" }.Contains(item.Code, StringComparer.OrdinalIgnoreCase))
                throw new ArgumentException("派彩類別不正確。");
            if (string.IsNullOrWhiteSpace(item.Name) || item.Name.Length > 80)
                throw new ArgumentException("派彩名稱不可空白且不得超過 80 個字元。");
            if (item.BaseAmount < 0 || item.CapAmount <= item.BaseAmount || item.Amount < item.BaseAmount || item.Amount > item.CapAmount)
                throw new ArgumentException("派彩金額必須符合：下限 ≤ 目前金額 ≤ 上限，且上限大於下限。");
        }
        lock (gate) {
            var current = ReadPayoutSettings();
            foreach (var item in next) {
                var prior = current.FirstOrDefault(existing => existing.Code.Equals(item.Code, StringComparison.OrdinalIgnoreCase));
                if (prior is not null && item.Amount < prior.Amount)
                    throw new ArgumentException($"{item.Code} 目前累積獎金為 {prior.Amount:N2}，設定金額不可低於此金額。");
            }
            SavePayout(next.OrderBy(item => Array.IndexOf(new[] { "GRAND", "MAJOR", "MINOR", "MINI" }, item.Code.ToUpperInvariant())).ToList());
        }
    }
    public bool ChangeAdminPassword(string current, string next) {
        ValidateAdminPassword(next);
        lock(gate) { if(!Verify(data.AdminHash,current)) return false;
            Save(data with { AdminHash=hasher.HashPassword(data.AdminName,next),AdminStamp=NewStamp() }); return true; }
    }
    bool Verify(string hash,string password) => hasher.VerifyHashedPassword("",hash,password)!=PasswordVerificationResult.Failed;
    static string NewStamp() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    static List<PayoutSetting> DefaultPayoutSettings() => [
        new("GRAND", "ULTIMATE POWER", 323846.67m, 100000m, 500000m, true),
        new("MAJOR", "SUPER POWER", 86214.32m, 20000m, 100000m, true),
        new("MINOR", "EXTRA POWER", 12842.58m, 5000m, 20000m, true),
        new("MINI", "POWER", 2841.16m, 1000m, 5000m, true),
    ];
    List<PayoutSetting> ReadPayoutSettings() {
        if (!File.Exists(payoutFile)) return DefaultPayoutSettings();
        var settings = JsonSerializer.Deserialize<List<PayoutSetting>>(File.ReadAllText(payoutFile));
        return settings is { Count: 4 } && settings.Select(item => item.Code).Distinct(StringComparer.OrdinalIgnoreCase).Count() == 4
            ? settings : DefaultPayoutSettings();
    }
    List<PayoutRecord> ReadPayoutRecords() {
        if (!File.Exists(payoutRecordsFile)) return [];
        return JsonSerializer.Deserialize<List<PayoutRecord>>(File.ReadAllText(payoutRecordsFile)) ?? [];
    }
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
    void SavePayout(List<PayoutSetting> next) {
        var temporary = payoutFile + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                JsonSerializer.Serialize(stream, next, new JsonSerializerOptions { WriteIndented = true }); stream.Flush(true);
            }
            if (File.Exists(payoutFile)) File.Replace(temporary, payoutFile, payoutFile + ".bak"); else File.Move(temporary, payoutFile);
        } finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    void SavePayoutRecords(List<PayoutRecord> next) {
        var temporary = payoutRecordsFile + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                JsonSerializer.Serialize(stream, next, new JsonSerializerOptions { WriteIndented = true }); stream.Flush(true);
            }
            if (File.Exists(payoutRecordsFile)) File.Replace(temporary, payoutRecordsFile, payoutRecordsFile + ".bak"); else File.Move(temporary, payoutRecordsFile);
        } finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    public void Dispose() => processLock.Dispose();
}
