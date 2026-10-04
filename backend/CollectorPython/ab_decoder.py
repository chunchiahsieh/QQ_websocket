"""AB CaliBet TableDO status/road decoder for baccarat tables."""

from __future__ import annotations

import json
import time

from roads import ab_roads


def _now() -> int:
    return int(time.time() * 1000)


def _text(value: dict, key: str) -> str:
    field = value.get(key)
    return "" if field is None else str(field)


def _results(rows: object) -> list[str]:
    if not isinstance(rows, list) or not rows or not isinstance(rows[0], list):
        return []
    return [x for x in rows[0] if isinstance(x, str) and len(x) == 12 and x[0] in "0123456"]


class AbDecoder:
    BACCARAT_TYPES = {101, 1011, 1012, 103, 104, 110, 111}

    def __init__(self):
        self.tables: dict[str, dict] = {}
        self.openings: dict[str, dict] = {}

    def _state(self, table: dict, opening: dict, state: int) -> None:
        table["state"] = state
        if state == 101:
            try:
                opening["settled_round"] = int(table["playId"])
            except (KeyError, ValueError):
                pass
            opening["saw_positive"] = False
            opening["deadline"] = None
        elif state != 100:
            table["openingStarted"] = False
            opening["opening_round"] = None
            opening["saw_positive"] = False
            opening["deadline"] = None

    def _countdown(self, table: dict, opening: dict, seconds: int, live: bool) -> None:
        seconds = max(0, seconds)
        now = _now()
        table.update(countDown=seconds, receivedAt=now)
        try:
            round_number = int(table["playId"])
        except (KeyError, ValueError):
            return
        if table.get("state") != 100 or opening.get("settled_round") == round_number:
            return
        if seconds > 0:
            if table.get("openingStarted"):
                if opening.get("opening_round") == round_number:
                    return
                table["openingStarted"] = False
                opening["opening_round"] = None
            opening["saw_positive"] = True
            opening["deadline"] = now + seconds * 1000
        elif live and opening.get("saw_positive"):
            table["openingStarted"] = True
            opening["opening_round"] = round_number
            opening["saw_positive"] = False
            opening["deadline"] = None

    def _status(self, table: dict, opening: dict, status: dict, live: bool) -> None:
        if "BB" in status and int(status["BB"]) > 0:
            next_round = int(status["BB"])
            previous = table.get("playId")
            if previous is not None and next_round < int(previous):
                table["results"] = []
            if previous != str(next_round):
                opening.update(saw_positive=False, deadline=None, settled_round=None)
            table["playId"] = str(next_round)
        if "DD" in status:
            state = int(status["DD"])
            self._state(table, opening, state)
            if state != 100:
                table.update(countDown=0, receivedAt=_now())
        if "EE" in status:
            self._countdown(table, opening, int(status["EE"]), live)

    def _upsert(self, item: dict, changed: set[str]) -> None:
        if not isinstance(item, dict) or item.get("DD") not in self.BACCARAT_TYPES:
            return
        key = _text(item, "AA")
        if not key:
            return
        if key not in self.tables:
            self.tables[key] = {"tableId": key, "results": [], "openingStarted": False}
            self.openings[key] = {"saw_positive": False, "deadline": None,
                                  "opening_round": None, "settled_round": None}
        table, opening = self.tables[key], self.openings[key]
        table["tableName"] = _text(item, "BB")
        table["dealer"] = {"name": _text(item, "II").split("_")[0]}
        if "CC" in item:
            table["enterCount"] = int(item["CC"])
        if isinstance(item.get("HH"), dict):
            self._status(table, opening, item["HH"], False)
        if "Z3" in item:
            self._state(table, opening, int(item["Z3"]))
        if "WW3" in item:
            table["results"] = _results(item["WW3"])
        changed.add(key)

    def accept(self, data: bytes | str) -> list[dict]:
        root = json.loads(data)
        if not isinstance(root, dict) or not isinstance(root.get("p"), dict):
            return []
        command, payload = root.get("c"), root["p"]
        changed: set[str] = set()
        if command == "getGameHall":
            for item in payload.get("D", []):
                self._upsert(item, changed)
        elif command == "pushGHAdd":
            self._upsert(payload.get("A", {}), changed)
        elif command == "pushGameStatus":
            for item in payload.get("A", []):
                key = _text(item, "AA")
                if key in self.tables:
                    self._status(self.tables[key], self.openings[key], item, True)
                    changed.add(key)
        elif command == "getCountDown":
            for item in payload.get("C", []):
                key = _text(item, "AA")
                if key in self.tables and "DD" in item:
                    self._countdown(self.tables[key], self.openings[key], int(item["DD"]), True)
                    changed.add(key)
        elif command == "getRoadData":
            key = _text(payload, "C")
            if key in self.tables and "G" in payload:
                self.tables[key]["results"] = _results(payload["G"])
                changed.add(key)
        elif command == "pushGameTableResults":
            key = _text(payload, "A")
            if key in self.tables and "G" in payload and "C" in payload:
                results = _results(payload["G"])
                index = int(payload["C"]) - 1
                history = self.tables[key]["results"]
                if index >= 0 and len(results) == 1 and index <= len(history):
                    if index == len(history):
                        history.append(results[0])
                    else:
                        history[index] = results[0]
                    changed.add(key)
        elif command == "pushGHDealer":
            key = _text(payload, "AA")
            if key in self.tables:
                self.tables[key]["dealer"] = {"name": _text(payload, "BB").split("_")[0]}
                changed.add(key)
        return [dict(self.tables[key]) for key in changed]

    def advance_time(self, now_ms: int | None = None) -> list[dict]:
        now_ms = _now() if now_ms is None else now_ms
        changed = []
        for key, opening in self.openings.items():
            deadline = opening.get("deadline")
            table = self.tables[key]
            if not opening.get("saw_positive") or deadline is None or now_ms < deadline:
                continue
            try:
                round_number = int(table["playId"])
            except (KeyError, ValueError):
                continue
            if table.get("state") != 100 or opening.get("settled_round") == round_number:
                continue
            table.update(openingStarted=True, countDown=0, receivedAt=now_ms)
            opening.update(opening_round=round_number, saw_positive=False, deadline=None)
            changed.append(dict(table))
        return changed


def to_card(source: dict) -> dict:
    key = str(source["tableId"])
    name = source.get("tableName") or key
    row = {"id": "AB:" + key, "name": name, "gameType": "BAC",
           "dealer": source.get("dealer", {}).get("name", ""),
           "dealerPhoto": source.get("dealerPhoto"), "videoUrl": source.get("videoUrl"),
           "room": name, "shoe": "—", "round": str(source.get("playId", "—")), "players": "—"}
    if "state" in source:
        state = int(source["state"])
        row["tablePhase"] = "dealing" if source.get("openingStarted") and state != 102 else None
        if state == 102:
            row["tableState"] = "2"
    if "countDown" in source:
        received = int(source.get("receivedAt", _now()))
        row.update(countdownReceivedAt=received,
                   countdownDeadline=received + max(0, int(source["countDown"])) * 1000)
    row.update(ab_roads(source.get("results", [])))
    return row
