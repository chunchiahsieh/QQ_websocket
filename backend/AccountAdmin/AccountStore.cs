using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;

namespace AccountAdmin;

public sealed record Account(Guid Id, string Username, string PasswordHash, bool Enabled, DateTimeOffset ExpiresAt, string Stamp);
public sealed record AccountView(Guid Id, string Username, bool Enabled, DateTimeOffset ExpiresAt);
public sealed record PayoutSetting(string Code, string Name, decimal Amount, decimal BaseAmount, decimal CapAmount, bool Enabled, decimal NextPayoutAmount = 0);
public sealed record PayoutRecord(Guid Id, string Username, string CategoryCode, string CategoryName, decimal Amount, DateTimeOffset CreatedAt);
public sealed record ScheduledPayout(Guid Id, string Username, string CategoryCode, decimal Amount, DateTimeOffset ScheduledAt, DateTimeOffset CreatedAt);
public sealed record PayoutSnapshot(List<PayoutSetting> Settings, List<PayoutRecord> Records, List<PayoutRecord> Announcements, long Revision);
public sealed record AdminDashboardView(List<AccountView> Accounts, List<PayoutSetting> PayoutSettings, List<PayoutRecord> PayoutRecords);
public sealed record FileData(int Version, string AdminName, string AdminHash, string AdminStamp, List<Account> Accounts);

public sealed class AccountStore : IDisposable
{
    readonly string file;
    readonly string payoutFile;
    readonly string payoutRecordsFile;
    readonly string scheduledPayoutsFile;
    readonly string focusedTablesFile;
    readonly FileStream processLock;
    readonly object gate = new();
    readonly PasswordHasher<string> hasher = new(Microsoft.Extensions.Options.Options.Create(new PasswordHasherOptions { IterationCount = 210000 }));
    FileData data = null!;
    readonly string dummyHash;
    public AccountStore(string directory) {
        Directory.CreateDirectory(directory); file = Path.Combine(directory, "accounts.json"); payoutFile = Path.Combine(directory, "payout-settings.json"); payoutRecordsFile = Path.Combine(directory, "payout-records.json"); scheduledPayoutsFile = Path.Combine(directory, "scheduled-payouts.json"); focusedTablesFile = Path.Combine(directory, "focused-tables.json");
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
    public List<PayoutSetting> ListPayoutSettings() { lock (gate) { AccrueAutomaticPayoutsUnsafe(); return ReadPayoutSettings(); } }
    public List<PayoutRecord> ListPayoutRecords(int limit = 100) {
        lock (gate) { return ReadPayoutRecords().OrderByDescending(item => item.CreatedAt).Take(Math.Clamp(limit, 1, 500)).ToList(); }
    }
    public List<ScheduledPayout> ListScheduledPayouts() { lock (gate) { ProcessScheduledPayoutsUnsafe(); return ReadScheduledPayouts().OrderBy(item => item.ScheduledAt).ToList(); } }
    public PayoutSnapshot GetPayoutSnapshot(string? username = null, int limit = 50) {
        lock (gate) {
            AccrueAutomaticPayoutsUnsafe();
            var allRecords = ReadPayoutRecords().OrderByDescending(item => item.CreatedAt).ToList();
            var records = allRecords.Where(item => string.IsNullOrWhiteSpace(username) || item.Username.Equals(username.Trim(), StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(item => item.CreatedAt).Take(Math.Clamp(limit, 1, 500)).ToList();
            var revision = File.Exists(payoutFile)
                ? new DateTimeOffset(File.GetLastWriteTimeUtc(payoutFile)).ToUnixTimeMilliseconds()
                : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            return new(ReadPayoutSettings(), records, allRecords.Take(Math.Clamp(limit, 1, 500)).ToList(), revision);
        }
    }
    public void SchedulePayout(string username, string code, decimal amount, DateTimeOffset scheduledAt) {
        username = username.Trim(); code = code.Trim().ToUpperInvariant();
        lock (gate) {
            var account = data.Accounts.FirstOrDefault(item => item.Username.Equals(username, StringComparison.OrdinalIgnoreCase));
            if (account is null || !account.Enabled || account.ExpiresAt <= DateTimeOffset.UtcNow) throw new ArgumentException("指定帳號不存在、已停用或已到期。");
            var setting = ReadPayoutSettings().FirstOrDefault(item => item.Code.Equals(code, StringComparison.OrdinalIgnoreCase));
            if (setting is null) throw new ArgumentException("派彩類別不存在。");
            if (amount < setting.BaseAmount || amount > setting.CapAmount) throw new ArgumentException($"指定金額必須介於 {setting.BaseAmount:N2} 與 {setting.CapAmount:N2} 之間。");
            if (scheduledAt <= DateTimeOffset.UtcNow) throw new ArgumentException("預計派彩時間必須晚於現在。");
            var schedules = ReadScheduledPayouts();
            schedules.Add(new(Guid.NewGuid(), account.Username, code, decimal.Round(amount, 2), scheduledAt.ToUniversalTime(), DateTimeOffset.UtcNow));
            SaveScheduledPayouts(schedules);
        }
    }
    public void CancelScheduledPayout(Guid id) {
        lock (gate) {
            var schedules = ReadScheduledPayouts();
            if (!schedules.Any(item => item.Id == id)) throw new ArgumentException("找不到指定的待執行計畫。");
            SaveScheduledPayouts(schedules.Where(item => item.Id != id).ToList());
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
    public List<string> GetFocusedTables(Guid id, string stamp) {
        lock (gate) {
            if (!Validate(id, stamp)) throw new UnauthorizedAccessException();
            if (!File.Exists(focusedTablesFile)) return [];
            var all = JsonSerializer.Deserialize<Dictionary<Guid, List<string>>>(File.ReadAllText(focusedTablesFile)) ?? [];
            return all.GetValueOrDefault(id)?.ToList() ?? [];
        }
    }
    public List<string> SetFocusedTables(Guid id, string stamp, List<string> tables) {
        if (tables.Count > 100 || tables.Any(item => item.Length > 128 || !Regex.IsMatch(item, @"^(MT|DG|AB)::[A-Za-z0-9:_-]+$")))
            throw new ArgumentException("關注牌桌資料格式不正確。");
        lock (gate) {
            if (!Validate(id, stamp)) throw new UnauthorizedAccessException();
            var all = File.Exists(focusedTablesFile)
                ? JsonSerializer.Deserialize<Dictionary<Guid, List<string>>>(File.ReadAllText(focusedTablesFile)) ?? []
                : new Dictionary<Guid, List<string>>();
            all[id] = tables.ToList();
            var temporary = focusedTablesFile + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                    JsonSerializer.Serialize(stream, all); stream.Flush(true);
                }
                if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                if (File.Exists(focusedTablesFile)) File.Replace(temporary, focusedTablesFile, focusedTablesFile + ".bak");
                else File.Move(temporary, focusedTablesFile);
            } finally { if (File.Exists(temporary)) File.Delete(temporary); }
            return all[id].ToList();
        }
    }
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
    public void ResetPassword(string username, string password) {
        username = username.Trim(); ValidateName(username); ValidatePassword(password);
        lock (gate) {
            var current = data.Accounts.FirstOrDefault(a => a.Username.Equals(username, StringComparison.OrdinalIgnoreCase))
                ?? throw new ArgumentException("找不到帳號。");
            var updated = current with { PasswordHash = hasher.HashPassword(current.Username, password), Stamp = NewStamp() };
            Save(data with { Accounts = data.Accounts.Select(a => a.Id == current.Id ? updated : a).ToList() });
        }
    }
    public void Delete(Guid id) {
        lock (gate) {
            if (!data.Accounts.Any(a => a.Id == id)) throw new ArgumentException("找不到帳號。");
            Save(data with { Accounts = data.Accounts.Where(a => a.Id != id).ToList() });
        }
    }
    public PayoutRecord AwardPayout(string username, string code) {
        username = username.Trim(); code = code.Trim().ToUpperInvariant();
        ValidateName(username);
        lock (gate) {
            var account = data.Accounts.FirstOrDefault(item => item.Username.Equals(username, StringComparison.OrdinalIgnoreCase));
            if (account is null) throw new ArgumentException("找不到指定的使用者帳號。");
            if (!account.Enabled || account.ExpiresAt <= DateTimeOffset.UtcNow) throw new ArgumentException("指定的使用者帳號已停用或到期。");
            var settings = ReadPayoutSettings();
            var setting = settings.FirstOrDefault(item => item.Code.Equals(code, StringComparison.OrdinalIgnoreCase));
            if (setting is null) throw new ArgumentException("派彩類別不存在。");
            var record = new PayoutRecord(Guid.NewGuid(), account.Username, setting.Code, setting.Name, decimal.Round(setting.Amount, 2), DateTimeOffset.UtcNow);
            var nextSettings = settings.Select(item => item.Code.Equals(setting.Code, StringComparison.OrdinalIgnoreCase)
                ? item with { Amount = item.BaseAmount, NextPayoutAmount = 0 } : item).ToList();
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
    List<ScheduledPayout> ReadScheduledPayouts() {
        if (!File.Exists(scheduledPayoutsFile)) return [];
        return JsonSerializer.Deserialize<List<ScheduledPayout>>(File.ReadAllText(scheduledPayoutsFile)) ?? [];
    }
    void ProcessScheduledPayoutsUnsafe() {
        var schedules = ReadScheduledPayouts();
        var due = schedules.Where(item => item.ScheduledAt <= DateTimeOffset.UtcNow).OrderBy(item => item.ScheduledAt).ToList();
        if (due.Count == 0) return;
        var settings = ReadPayoutSettings();
        var records = ReadPayoutRecords();
        foreach (var schedule in due) {
            var account = data.Accounts.FirstOrDefault(item => item.Username.Equals(schedule.Username, StringComparison.OrdinalIgnoreCase));
            var setting = settings.FirstOrDefault(item => item.Code.Equals(schedule.CategoryCode, StringComparison.OrdinalIgnoreCase));
            if (account is null || setting is null || !account.Enabled || account.ExpiresAt <= DateTimeOffset.UtcNow) continue;
            var payoutAmount = schedule.Amount > 0 ? schedule.Amount : setting.Amount;
            records.Insert(0, new(Guid.NewGuid(), account.Username, setting.Code, setting.Name, decimal.Round(payoutAmount, 2), DateTimeOffset.UtcNow));
            settings = settings.Select(item => item.Code.Equals(setting.Code, StringComparison.OrdinalIgnoreCase) ? item with { Amount = item.BaseAmount, NextPayoutAmount = 0 } : item).ToList();
        }
        SavePayoutRecords(records.Take(1000).ToList());
        SavePayout(settings);
        SaveScheduledPayouts(schedules.Where(item => item.ScheduledAt > DateTimeOffset.UtcNow).ToList());
    }
    void AccrueAutomaticPayoutsUnsafe() {
        if (!File.Exists(payoutFile)) { SavePayout(DefaultPayoutSettings()); return; }
        var lastWrite = File.GetLastWriteTimeUtc(payoutFile);
        var elapsedSeconds = Math.Max(0, (DateTime.UtcNow - lastWrite).TotalSeconds);
        if (elapsedSeconds < 1) return;
        var nowTaipei = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, TimeZoneInfo.FindSystemTimeZoneById(OperatingSystem.IsWindows() ? "Taipei Standard Time" : "Asia/Taipei"));
        var range = nowTaipei.Hour < 6 ? (80m, 180m) : nowTaipei.Hour < 12 ? (180m, 350m) : nowTaipei.Hour < 18 ? (350m, 650m) : (650m, 1200m);
        var progressOfWindow = ((nowTaipei.Minute * 60m + nowTaipei.Second) % 300m) / 300m;
        var speed = (range.Item1 + (range.Item2 - range.Item1) * progressOfWindow) / 86m;
        var rates = new Dictionary<string, decimal>(StringComparer.OrdinalIgnoreCase) {
            ["GRAND"] = 0.21m / 1.2m, ["MAJOR"] = 0.12m / 0.9m, ["MINOR"] = 0.06m / 0.65m, ["MINI"] = 0.03m / 0.45m,
        };
        var settings = ReadPayoutSettings();
        var records = ReadPayoutRecords();
        var updated = new List<PayoutSetting>(settings.Count);
        foreach (var setting in settings) {
            var accrued = rates.GetValueOrDefault(setting.Code) * speed * (decimal)elapsedSeconds;
            var amount = Math.Clamp(setting.Amount, setting.BaseAmount, setting.CapAmount) + accrued;
            var trigger = ValidTrigger(setting) ? setting.NextPayoutAmount : RandomPayoutTrigger(setting);
            var cycles = 0;
            while (amount >= trigger && cycles++ < 100) {
                string winner;
                do { winner = $"幸運玩家{RandomNumberGenerator.GetInt32(100, 1000)}***"; }
                while (data.Accounts.Any(account => account.Username.Equals(winner, StringComparison.OrdinalIgnoreCase)));
                records.Insert(0, new(Guid.NewGuid(), winner, setting.Code, setting.Name, decimal.Round(trigger, 2), DateTimeOffset.UtcNow));
                amount = setting.BaseAmount + (amount - trigger);
                trigger = RandomPayoutTrigger(setting);
            }
            updated.Add(setting with { Amount = Math.Min(amount, setting.CapAmount), NextPayoutAmount = trigger });
        }
        SavePayoutRecords(records.Take(1000).ToList());
        SavePayout(updated);
    }
    static bool ValidTrigger(PayoutSetting setting) => setting.NextPayoutAmount > setting.BaseAmount && setting.NextPayoutAmount <= setting.CapAmount;
    static decimal RandomPayoutTrigger(PayoutSetting setting) {
        var range = setting.CapAmount - setting.BaseAmount;
        if (range <= 0) return setting.CapAmount;
        // Pick a fresh trigger between 10% and 100% of the configured range.
        // Persisting it with the pool prevents page refreshes or service restarts
        // from re-rolling the next payout point.
        var basisPoints = RandomNumberGenerator.GetInt32(1000, 10001);
        return decimal.Round(setting.BaseAmount + range * basisPoints / 10000m, 2);
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
    void SaveScheduledPayouts(List<ScheduledPayout> next) {
        var temporary = scheduledPayoutsFile + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                JsonSerializer.Serialize(stream, next, new JsonSerializerOptions { WriteIndented = true }); stream.Flush(true);
            }
            if (File.Exists(scheduledPayoutsFile)) File.Replace(temporary, scheduledPayoutsFile, scheduledPayoutsFile + ".bak"); else File.Move(temporary, scheduledPayoutsFile);
        } finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    public void Dispose() => processLock.Dispose();
}
