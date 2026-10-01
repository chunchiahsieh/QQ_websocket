using System.Text.Json;
using CollectorDesktop;

static class MtTableStateTests
{
    const long ReceivedAt = 1_790_726_400_000;
    const string TablesAction = "/api/v1/gametype/*/game/*/room/*/tables";
    const string BaseRow = """
        {"table_id":"BAV01","table_name":"Baccarat 1","game_sn":"BAV01-A041","state":2,"countDown":20,"room_id":48,
         "dealer":{"nick_name":"Standard dealer","avatar_url":"https://media.example/standard.jpg"},
         "video":[[1,"standard","https://media.example/official/base-01.flv?token=base"]],
         "trend":{"current_shoe":646,"current_round":41,"bead_plate2":"0201","big2":"02"}}
        """;
    const string LiveRow = """
        {"table_id":"BAV01_LIVE","table_id_t":"BAV01","table_name":"Baccarat 1 LIVE","game_sn":"BAV01-A041","state":2,"countDown":20,"room_id":48,
         "dealer":{"nick_name":"Live dealer","avatar_url":"https://media.example/live.jpg"},
         "video":[[1,"standard","https://media.example/official/base-01.flv?token=base"]],
         "video_live":[[1,"live","https://media.example/official/live-camera-7.flv?token=live&quality=3"]],
         "trend":{"current_shoe":646,"current_round":41,"bead_plate2":"0102","big2":"01"}}
        """;
    const string OtherRow = """
        {"table_id":"BAV02","game_sn":"BAV02-Z007","countDown":7,"trend":{"current_shoe":912,"current_round":7,"bead_plate2":"0202"}}
        """;
    const string SuffixOnlyRow = """
        {"table_id":"BAV01_FAKE_LIVE","game_sn":"OTHER-A003","countDown":3,"trend":{"current_shoe":999,"current_round":3,"bead_plate2":"0101"}}
        """;

    public static void Run()
    {
        NormalizationUsesOfficialSourceAndMedia();
        foreach (var aliasFirst in new[] { false, true })
            SourceEventsReachOnlyDeclaredAliases(aliasFirst);
        WaitBeforeAliasSnapshotRetainsAuthority();
        FirstWaitReplacesZeroSnapshotAndSuppliesShoe();
        SnapshotCannotRestartAuthoritativeEvents();
        PositiveWaitEndsShuffleForSourceAndAlias();
        NewRoundRestartsAndOldRoundCannotRegress();
        NewShoeSnapshotReplacesAuthoritativeEvents();
        NewShoeClearsUnreportedState();
        NewAliasShoeCannotBeRewoundByItsSource();
        EndEventsPreserveMediaAndRoads();
        Console.WriteLine("MT explicit source identity, event ordering, countdown, and official media tests passed.");
    }

    static void NormalizationUsesOfficialSourceAndMedia()
    {
        var rows = Extract(Snapshot(BaseRow, LiveRow, SuffixOnlyRow), ReceivedAt);
        var standard = rows.Single(row => Equals(row["id"], "BAV01"));
        var live = rows.Single(row => Equals(row["id"], "BAV01_LIVE"));
        var unrelated = rows.Single(row => Equals(row["id"], "BAV01_FAKE_LIVE"));
        Equal(standard, "sourceTableId", "BAV01", "A full unaliased snapshot identifies itself as its source.");
        Equal(live, "sourceTableId", "BAV01", "Only the official table_id_t declares the shared source.");
        Equal(unrelated, "sourceTableId", "BAV01_FAKE_LIVE", "A LIVE suffix alone must not create an alias.");
        Equal(live, "countdownDeadline", ReceivedAt + 20_000, "An official LIVE snapshot countdown must not be suppressed.");
        Equal(live, "videoUrl", "https://media.example/official/live-camera-7.flv?token=live&quality=3",
            "Official video_live must take precedence with its path and query intact.");
        Equal(standard, "videoUrl", "https://media.example/official/base-01.flv?token=base",
            "The standard video must retain the official path and query.");
        Equal(live, "mtEvent", "snapshot", "Snapshot metadata must identify the event.");
        Equal(live, "mtReceivedAt", ReceivedAt, "Normalization must use the supplied receive time.");

        var partial = Extract(Packet("wait", """{"table_id":"BAV01_LIVE","game_sn":"BAV01-A041","count":18}"""), ReceivedAt).Single();
        Equal(partial, "sourceTableId", "BAV01_LIVE", "An unbound partial record defaults to its own exact source ID.");
        Equal(partial, "mtEvent", "wait", "Wait packets must identify their authority.");
        Equal(partial, "countdownSource", "wait", "An official wait countdown must be retained.");

        var fallback = Extract(Snapshot("""{"table_id":"BAV99_LIVE","video":[[1,"fallback","https://media.example/original/fallback.flv?auth=kept"]]}"""), ReceivedAt).Single();
        Equal(fallback, "videoUrl", "https://media.example/original/fallback.flv?auth=kept",
            "Without video_live, the supplied video URL must remain unchanged even for a LIVE ID.");
    }

    static void SourceEventsReachOnlyDeclaredAliases(bool aliasFirst)
    {
        var tables = NewTables();
        Apply(tables, aliasFirst ? Snapshot(LiveRow, OtherRow, BaseRow, SuffixOnlyRow) : Snapshot(BaseRow, OtherRow, LiveRow, SuffixOnlyRow), ReceivedAt);
        Check(tables.Count == 4, "Full table IDs must remain four distinct records regardless of source ordering.");
        SharedState(tables, ReceivedAt + 20_000, 20L, "BAV01-A041", null);
        Equal(tables["BAV01_LIVE"], "shoe", "646", "An alias shares the source shoe.");
        Equal(tables["BAV01_LIVE"], "round", "41", "An alias shares the source round.");
        var otherDeadline = tables["BAV02"]["countdownDeadline"];
        var suffixDeadline = tables["BAV01_FAKE_LIVE"]["countdownDeadline"];

        Apply(tables, Wait(19), ReceivedAt + 1_000);
        SharedState(tables, ReceivedAt + 20_000, 19L, "BAV01-A041", null);
        Equal(tables["BAV02"], "countdownDeadline", otherDeadline, "A source wait must not update an unrelated table.");
        Equal(tables["BAV01_FAKE_LIVE"], "countdownDeadline", suffixDeadline, "A suffix match without table_id_t must not receive source waits.");
        DistinctPresentation(tables);

        Apply(tables, Wait(19), ReceivedAt + 1_600);
        SharedState(tables, ReceivedAt + 20_000, 19L, "BAV01-A041", null);
        foreach (var id in new[] { "BAV01", "BAV01_LIVE" })
            Equal(tables[id], "countdownReceivedAt", ReceivedAt + 1_000, "A repeated count must retain the original timer receive time.");

        Apply(tables, Packet("update", """{"table_id":"BAV01_LIVE","totalplayers":88}"""), ReceivedAt + 1_700);
        Equal(tables["BAV01_LIVE"], "sourceTableId", "BAV01", "An alias-only occupancy update must retain its source mapping.");
        Apply(tables, Wait(18), ReceivedAt + 2_000);
        SharedState(tables, ReceivedAt + 20_000, 18L, "BAV01-A041", null);
        Equal(tables["BAV01_LIVE"], "players", "88", "Source events must preserve alias-specific occupancy.");
    }

    static void WaitBeforeAliasSnapshotRetainsAuthority()
    {
        var tables = NewTables();
        Apply(tables, Wait(19), ReceivedAt + 1_000);
        Apply(tables, Snapshot(LiveRow, BaseRow), ReceivedAt + 3_000);
        SharedState(tables, ReceivedAt + 20_000, 19L, "BAV01-A041", null);
        DistinctPresentation(tables);

        var seededSource = NewTables();
        Apply(seededSource, Snapshot(BaseRow), ReceivedAt);
        Apply(seededSource, Wait(19), ReceivedAt + 1_000);
        Apply(seededSource, Snapshot(LiveRow), ReceivedAt + 4_000);
        SharedState(seededSource, ReceivedAt + 20_000, 19L, "BAV01-A041", null);
    }

    static void SnapshotCannotRestartAuthoritativeEvents()
    {
        var tables = NewTables();
        Apply(tables, Snapshot(BaseRow, LiveRow), ReceivedAt);
        Apply(tables, Wait(19), ReceivedAt + 1_000);
        Apply(tables, Snapshot(BaseRow, LiveRow), ReceivedAt + 5_000);
        SharedState(tables, ReceivedAt + 20_000, 19L, "BAV01-A041", null);

        Apply(tables, Wait(0), ReceivedAt + 20_000);
        SharedState(tables, ReceivedAt + 20_000, 0L, "BAV01-A041", "dealing");
        Apply(tables, Snapshot(BaseRow, LiveRow), ReceivedAt + 21_000);
        SharedState(tables, ReceivedAt + 20_000, 0L, "BAV01-A041", "dealing");
        Apply(tables, Snapshot("""{"table_id":"BAV01","game_sn":"BAV01-A041","state":2,"trend":{"current_shoe":646,"current_round":41}}"""), ReceivedAt + 22_000);
        SharedState(tables, ReceivedAt + 20_000, 0L, "BAV01-A041", "dealing");
        Apply(tables, Wait(19), ReceivedAt + 23_000);
        SharedState(tables, ReceivedAt + 20_000, 0L, "BAV01-A041", "dealing");
        DistinctPresentation(tables);
    }

    static void FirstWaitReplacesZeroSnapshotAndSuppliesShoe()
    {
        var tables = NewTables();
        Apply(tables, Snapshot(
            """{"table_id":"BAV01","game_sn":"BAV01-A041","countDown":0,"state":2,"room_id":48}""",
            """{"table_id":"BAV01_LIVE","table_id_t":"BAV01","game_sn":"BAV01-A041","countDown":0,"state":2,"room_id":48}"""), ReceivedAt);
        SharedState(tables, ReceivedAt, 0L, "BAV01-A041", null);

        Apply(tables, Wait(20), ReceivedAt + 1_000);
        SharedState(tables, ReceivedAt + 21_000, 20L, "BAV01-A041", null);
        foreach (var id in new[] { "BAV01", "BAV01_LIVE" })
        {
            Equal(tables[id], "shoe", "646", "A wait's top-level shoe must populate the source and its declared alias.");
            Equal(tables[id], "round", "41", "The first wait must propagate the official round.");
        }
        Equal(Extract(Wait(20), ReceivedAt).Single(), "room", "48", "The official wait's room ID must be retained.");
    }

    static void PositiveWaitEndsShuffleForSourceAndAlias()
    {
        var tables = NewTables();
        Apply(tables, Snapshot(BaseRow, LiveRow), ReceivedAt);
        foreach (var id in new[] { "BAV01", "BAV01_LIVE" })
            Equal(tables[id], "tableState", "2", "The initial official shuffle state is retained.");

        Apply(tables, Wait(19), ReceivedAt + 1_000);
        foreach (var id in new[] { "BAV01", "BAV01_LIVE" })
        {
            Equal(tables[id], "tableState", "0", "A positive official wait ends the source and alias shuffle state.");
            Equal(tables[id], "tablePhase", null, "Opening a betting window clears the phase overlay.");
        }
        Apply(tables, Snapshot(BaseRow, LiveRow), ReceivedAt + 2_000);
        foreach (var id in new[] { "BAV01", "BAV01_LIVE" })
            Equal(tables[id], "tableState", "0", "A delayed shuffle snapshot cannot undo the authoritative positive wait.");

        Apply(tables, Wait(0), ReceivedAt + 20_000);
        foreach (var id in new[] { "BAV01", "BAV01_LIVE" })
            Equal(tables[id], "tablePhase", "dealing", "The following official zero still starts dealing.");
    }

    static void NewRoundRestartsAndOldRoundCannotRegress()
    {
        var tables = NewTables();
        Apply(tables, Snapshot(BaseRow, LiveRow), ReceivedAt);
        Apply(tables, Wait(0), ReceivedAt + 20_000);
        Apply(tables, Wait(20, "BAV01-B042", 42), ReceivedAt + 30_000);
        SharedState(tables, ReceivedAt + 50_000, 20L, "BAV01-B042", null);
        Equal(tables["BAV01_LIVE"], "round", "42", "A source's new round must propagate to its explicit aliases.");
        Apply(tables, Snapshot(LiveRow, BaseRow), ReceivedAt + 31_000);
        SharedState(tables, ReceivedAt + 50_000, 20L, "BAV01-B042", null);
        Equal(tables["BAV01"], "round", "42", "An older shoe/round snapshot must not regress source round identity.");
        Equal(tables["BAV01_LIVE"], "round", "42", "An older alias snapshot must not regress shared round identity.");
        Apply(tables, Wait(19, "BAV01-B042", 42), ReceivedAt + 31_000);
        SharedState(tables, ReceivedAt + 50_000, 19L, "BAV01-B042", null);
        Apply(tables, Wait(19, "BAV01-C043", 43), ReceivedAt + 60_000);
        SharedState(tables, ReceivedAt + 79_000, 19L, "BAV01-C043", null);
        foreach (var id in new[] { "BAV01", "BAV01_LIVE" })
            Equal(tables[id], "countdownReceivedAt", ReceivedAt + 60_000, "A new game with the same count must start a new clock.");
    }

    static void EndEventsPreserveMediaAndRoads()
    {
        var tables = NewTables();
        Apply(tables, Snapshot(BaseRow, LiveRow), ReceivedAt);
        Apply(tables, Packet("show_poker", """{"table_id":"BAV01","game_sn":"BAV01-A041","round":41}"""), ReceivedAt + 20_000);
        foreach (var id in new[] { "BAV01", "BAV01_LIVE" })
        {
            Equal(tables[id], "tablePhase", "dealing", "An official reveal must propagate the dealing phase.");
            Equal(tables[id], "countdownDeadline", ReceivedAt + 20_000, "An official reveal ends the shared countdown.");
        }
        Apply(tables, Snapshot(BaseRow, LiveRow), ReceivedAt + 21_000);
        Equal(tables["BAV01_LIVE"], "tablePhase", "dealing", "A stale snapshot must not undo a reveal event.");
        Apply(tables, Packet("summary", """{"table_id":"BAV01","game_sn":"BAV01-A041","round":41}"""), ReceivedAt + 25_000);
        foreach (var id in new[] { "BAV01", "BAV01_LIVE" })
            Equal(tables[id], "tablePhase", null, "Completion clears the shared dealing phase.");
        DistinctPresentation(tables);

        Equal(Extract(Packet("show_poker", """{"table_id":"BAV01"}"""), ReceivedAt).Single(), "mtEvent", "show_poker", "Reveal event metadata must be preserved.");
        Equal(Extract(Packet("summary", """{"table_id":"BAV01"}"""), ReceivedAt).Single(), "mtEvent", "complete", "Completion event metadata must be preserved.");
        Equal(Extract(Packet("update", """{"table_id":"BAV01","totalplayers":1}"""), ReceivedAt).Single(), "mtEvent", "update", "Ordinary updates must be classified without timer authority.");
    }

    static void NewShoeSnapshotReplacesAuthoritativeEvents()
    {
        foreach (var authority in new[] { "wait", "end" })
        foreach (var aliasFirst in new[] { false, true })
        {
            var tables = OldShoe(authority);
            var source = NewShoeRow("BAV01", "010102", "0101#02");
            var alias = NewShoeRow("BAV01_LIVE", "020101", "02#0101");
            Apply(tables, aliasFirst ? Snapshot(alias, source) : Snapshot(source, alias), ReceivedAt + 5_000);
            SharedState(tables, ReceivedAt + 25_000, 20L, "BAV01-S647-R3", null);
            foreach (var id in new[] { "BAV01", "BAV01_LIVE" })
            {
                Equal(tables[id], "shoe", "647", "A new official shoe must replace the prior authoritative clock identity.");
                Equal(tables[id], "round", "3", "New-shoe round 3 must not be treated as old-shoe round 56 rollback.");
                Equal(tables[id], "banker", "1", "The new shoe banker count must arrive with its identity.");
                Equal(tables[id], "player", "2", "The new shoe player count must arrive with its identity.");
                Equal(tables[id], "tie", "0", "The new shoe tie count must arrive with its identity.");
                Check(!tables[id].ContainsKey("aiOutcomes"), "An omitted full-history array must not survive from the old shoe.");
            }
            Equal(tables["BAV01"], "beadPlate", "010102", "The source must use its new three-round history.");
            Equal(tables["BAV01_LIVE"], "beadPlate", "020101", "An already-new alias retains its own reported history.");

            Apply(tables, Snapshot(BaseRow, LiveRow), ReceivedAt + 6_000);
            Apply(tables, Wait(19, "BAV01-A056", 56), ReceivedAt + 7_000);
            Apply(tables, Packet("summary", """{"table_id":"BAV01","shoe":646,"round":56}"""), ReceivedAt + 8_000);
            SharedState(tables, ReceivedAt + 25_000, 20L, "BAV01-S647-R3", null);
            Equal(tables["BAV01"], "shoe", "647", "A late older-shoe snapshot, wait, or end cannot restore the old identity.");
            Equal(tables["BAV01"], "beadPlate", "010102", "A late older-shoe packet cannot replace the new history.");
            Equal(tables["BAV01_LIVE"], "beadPlate", "020101", "A late older-shoe alias packet cannot replace the new alias history.");
        }
    }

    static void NewShoeClearsUnreportedState()
    {
        var tables = OldShoe("end");
        Apply(tables, Packet("wait", """{"table_id":"BAV01","shoe":647,"count":20}"""), ReceivedAt + 5_000);
        foreach (var id in new[] { "BAV01", "BAV01_LIVE" })
        {
            var table = tables[id];
            Equal(table, "shoe", "647", "A shoe-only wait must advance the source and alias identity.");
            Equal(table, "countdownDeadline", ReceivedAt + 25_000, "The new shoe must start its own countdown.");
            foreach (var key in new[] { "round", "countdownRound", "aiOutcomes" })
                Check(!table.ContainsKey(key), $"A shoe-only wait must clear the previous shoe's {key}.");
            foreach (var key in new[] { "banker", "player", "tie" })
                Equal(table, key, "0", "A new identity cannot inherit old-shoe counters.");
            foreach (var key in new[] { "beadPlate", "bigRoad", "bigEyeRoad", "smallRoad", "cockroachRoad" })
                Equal(table, key, "", "A new identity cannot inherit old-shoe roads.");
        }
        Equal(tables["BAV01_LIVE"], "dealer", "Live dealer", "Resetting game state must preserve presentation metadata.");

        tables = OldShoe("end");
        Apply(tables, Snapshot("""{"table_id":"BAV01","trend":{"current_shoe":647,"current_round":3,"total_round_banker":1,"total_round_player":2,"total_round_tie":0,"bead_plate2":"010102","big2":"0101#02"}}"""), ReceivedAt + 5_000);
        foreach (var id in new[] { "BAV01", "BAV01_LIVE" })
        {
            Equal(tables[id], "shoe", "647", "An untimed snapshot must advance both source and alias shoe identities.");
            foreach (var key in new[] { "countdownDeadline", "countdownReceivedAt", "countdownValue", "countdownSource", "tableState" })
                Check(!tables[id].ContainsKey(key), $"A new shoe snapshot without {key} must not inherit the old value.");
            Equal(tables[id], "tablePhase", null, "The preceding shoe's dealing phase must be cleared.");
        }
        Equal(tables["BAV01_LIVE"], "beadPlate", "", "A source-only shoe transition clears the alias's old history until its own history arrives.");
    }

    static void NewAliasShoeCannotBeRewoundByItsSource()
    {
        var tables = OldShoe("wait");
        Apply(tables, Snapshot(NewShoeRow("BAV01_LIVE", "020101", "02#0101")), ReceivedAt + 5_000);
        Equal(tables["BAV01"], "shoe", "646", "The source has not received the new lobby shoe yet.");
        Equal(tables["BAV01_LIVE"], "shoe", "647", "An older source cannot overwrite the alias's accepted new shoe.");
        Equal(tables["BAV01_LIVE"], "beadPlate", "020101", "The new alias history stays associated with its new shoe.");
        Apply(tables, Snapshot(NewShoeRow("BAV01", "010102", "0101#02")), ReceivedAt + 6_000);
        Equal(tables["BAV01_LIVE"], "shoe", "647", "The alias remains in the new shoe after its source catches up.");
        Equal(tables["BAV01_LIVE"], "beadPlate", "020101", "Source catch-up must preserve already-new alias roads.");
    }

    static Dictionary<string, Dictionary<string, object?>> OldShoe(string authority)
    {
        var tables = NewTables();
        Apply(tables, Snapshot(BaseRow, LiveRow), ReceivedAt);
        Apply(tables, Wait(19, "BAV01-A056", 56), ReceivedAt + 1_000);
        if (authority == "end")
            Apply(tables, Packet("summary", """{"table_id":"BAV01","game_sn":"BAV01-A056","shoe":646,"round":56}"""), ReceivedAt + 2_000);
        foreach (var table in tables.Values)
        {
            table["banker"] = "28";
            table["player"] = "28";
            table["tie"] = "0";
            table["beadPlate"] = string.Concat(Enumerable.Repeat("0201", 28));
            table["aiOutcomes"] = Enumerable.Range(0, 56).Select(index => index % 2 == 0 ? "2" : "1").ToArray();
        }
        return tables;
    }

    static string NewShoeRow(string id, string beads, string road) => JsonSerializer.Serialize(new {
        table_id = id, table_id_t = id == "BAV01_LIVE" ? "BAV01" : id,
        game_sn = "BAV01-S647-R3", countDown = 20, state = 0,
        trend = new { current_shoe = 647, current_round = 3, total_round_banker = 1, total_round_player = 2, total_round_tie = 0,
            bead_plate2 = beads, big2 = road },
    });

    static void DistinctPresentation(Dictionary<string, Dictionary<string, object?>> tables)
    {
        Equal(tables["BAV01"], "id", "BAV01", "The source retains its exact display ID.");
        Equal(tables["BAV01_LIVE"], "id", "BAV01_LIVE", "The alias retains its exact display ID.");
        Equal(tables["BAV01"], "beadPlate", "0201", "Source game-state propagation must not copy alias roads.");
        Equal(tables["BAV01_LIVE"], "beadPlate", "0102", "The alias retains its own reported road.");
        Equal(tables["BAV01"], "bigRoad", "02", "The source retains its reported big road.");
        Equal(tables["BAV01_LIVE"], "bigRoad", "01", "The alias retains its reported big road.");
        Equal(tables["BAV01"], "dealer", "Standard dealer", "The source retains its dealer identity.");
        Equal(tables["BAV01_LIVE"], "dealer", "Live dealer", "The alias retains its dealer identity.");
        Equal(tables["BAV01"], "dealerPhoto", "https://media.example/standard.jpg", "The source retains its dealer photo.");
        Equal(tables["BAV01_LIVE"], "dealerPhoto", "https://media.example/live.jpg", "The alias retains its dealer photo.");
        Equal(tables["BAV01"], "videoUrl", "https://media.example/official/base-01.flv?token=base", "The source retains its official stream.");
        Equal(tables["BAV01_LIVE"], "videoUrl", "https://media.example/official/live-camera-7.flv?token=live&quality=3", "The alias retains its official live stream.");
    }

    static void SharedState(Dictionary<string, Dictionary<string, object?>> tables, long deadline, long seconds, string game, string? phase)
    {
        foreach (var id in new[] { "BAV01", "BAV01_LIVE" })
        {
            Equal(tables[id], "countdownDeadline", deadline, $"{id} must retain the authoritative countdown deadline.");
            Equal(tables[id], "countdownValue", seconds, $"{id} must retain the authoritative remaining seconds.");
            Equal(tables[id], "countdownRound", game, $"{id} must retain the authoritative game identity.");
            Equal(tables[id], "tablePhase", phase, $"{id} must retain the authoritative phase.");
        }
    }

    static Dictionary<string, Dictionary<string, object?>> NewTables() => new(StringComparer.Ordinal);
    static string Snapshot(params string[] rows) => "{\"action\":{\"name\":\"" + TablesAction + "\"},\"tables\":[" + string.Join(",", rows) + "]}";
    static string Packet(string action, string row) => "{\"action\":{\"name\":\"/api/v1/table/" + action + "\"},\"table\":" + row + "}";
    static string Wait(long count, string game = "BAV01-A041", int round = 41) => Packet("wait", JsonSerializer.Serialize(new { table_id = "BAV01", game_sn = game, room_id = 48, shoe = 646, round, count }));
    static List<Dictionary<string, object?>> Extract(string packet, long receivedAt)
    {
        using var document = JsonDocument.Parse(packet);
        return MtTableNormalizer.Extract(document.RootElement, receivedAt);
    }
    static void Apply(Dictionary<string, Dictionary<string, object?>> tables, string packet, long receivedAt) => MtTableState.Merge(tables, Extract(packet, receivedAt));
    static void Check(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }
    static void Equal(Dictionary<string, object?> row, string key, object? expected, string message)
    {
        Check(row.TryGetValue(key, out var actual) && Equals(actual, expected),
            $"{message} Field {key}: expected {expected ?? "<null>"}, got {(row.TryGetValue(key, out actual) ? actual ?? "<null>" : "<missing>")}.");
    }
}
