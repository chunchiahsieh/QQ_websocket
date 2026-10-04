"""MT lobby/partial-event normalization, keeping LIVE presentation IDs distinct."""

from __future__ import annotations

import time
from urllib.parse import urlparse

TABLES_ACTION = "/api/v1/gametype/*/game/*/room/*/tables"
SHARED = ("countdownDeadline", "countdownReceivedAt", "countdownValue", "countdownSource",
          "countdownRound", "tableState", "tablePhase", "shoe", "round", "mtEvent", "mtReceivedAt")
ROADS = ("beadPlate", "bigRoad", "bigEyeRoad", "smallRoad", "cockroachRoad")


def _text(obj: object, key: str) -> str | None:
    if not isinstance(obj, dict):
        return None
    value = obj.get(key)
    return str(value) if isinstance(value, (str, int, float)) else None


def _number(obj: object, *keys: str) -> int | None:
    for key in keys:
        try:
            value = _text(obj, key)
            if value is not None:
                return int(value)
        except ValueError:
            pass
    return None


def action_name(root: dict) -> str:
    return _text(root, "name") or _text(root, "event") or _text(root.get("action"), "name") or _text(root, "action") or _text(root, "method") or ""


def _records(value: object, depth: int = 0):
    if depth > 6:
        return
    if isinstance(value, list):
        for item in value:
            yield from _records(item, depth + 1)
    elif isinstance(value, dict):
        if _text(value, "table_id"):
            yield value
        for nested in value.values():
            yield from _records(nested, depth + 1)


def _video(table: dict) -> str | None:
    alias, key = _text(table, "table_id_t"), "video"
    if alias and alias != _text(table, "table_id"):
        key = "video_live"
    for line in table.get(key, []):
        if isinstance(line, list) and len(line) >= 3 and isinstance(line[2], str):
            parsed = urlparse(line[2])
            if parsed.scheme == "https" and parsed.path.lower().endswith(".flv"):
                return line[2]
    return None


def extract(root: dict, received_at: int | None = None) -> list[dict]:
    action = action_name(root)
    received = received_at if received_at is not None else int(time.time() * 1000)
    rows: dict[str, dict] = {}
    wait = "/wait" in action.lower() or ":wait" in action.lower()
    show = action.lower().endswith("/show_poker")
    complete = action.lower().endswith(("/summary", "/result", "/end"))
    for table in _records(root):
        key = _text(table, "table_id")
        if not key:
            continue
        trend = table.get("trend") if isinstance(table.get("trend"), dict) else {}
        dealer = table.get("dealer") if isinstance(table.get("dealer"), dict) else {}
        row = rows.setdefault(key, {"id": key})
        row.update(sourceTableId=_text(table, "table_id_t") or key,
                   mtEvent="snapshot" if action == TABLES_ACTION else "wait" if wait else "show_poker" if show else "complete" if complete else "update",
                   mtReceivedAt=received)
        deadline = _number(table, "countdownDeadline", "countdown_deadline", "deadline")
        seconds = _number(table, "countDown", "countdown", "countdown_seconds", "countdownSeconds",
                          "remaining_seconds", "remainingSeconds", "remain", "remainSeconds",
                          "wait_time", "waitTime")
        if seconds is None and wait:
            seconds = _number(table, "count")
        if deadline and deadline > 0:
            if deadline < 100_000_000_000:
                deadline *= 1000
            row.update(countdownDeadline=deadline, countdownReceivedAt=received,
                       countdownSource="wait" if wait else "explicit")
        elif seconds is not None:
            row.update(countdownValue=max(0, seconds), countdownDeadline=received + max(0, seconds) * 1000,
                       countdownReceivedAt=received, countdownSource="wait" if wait else "snapshot")
        if show or complete:
            row.update(countdownValue=0, countdownDeadline=received,
                       countdownReceivedAt=received, countdownSource="end")
        countdown_round = (_text(table, "game_sn") or _text(table, "gameSn") or _text(table, "round")
                           or _text(table, "round_id") or _text(trend, "current_round"))
        if countdown_round:
            row["countdownRound"] = countdown_round
        for target, source in (("name", "table_name"), ("gameType", "table_type"),
                               ("room", "room_id"), ("players", "totalplayers")):
            value = _text(table, source)
            if value:
                row[target] = value
        source_state = _text(table, "state")
        if source_state:
            row["tableState"] = source_state
        if wait and seconds is not None and seconds > 0:
            row["tableState"] = "0"
        if show or (wait and seconds == 0):
            row["tablePhase"] = "dealing"
        elif source_state == "2" or complete or (wait and seconds is not None and seconds > 0):
            row["tablePhase"] = None
        for target, options in (("shoe", (_text(table, "shoe"), _text(table, "shoe_id"), _text(trend, "current_shoe"))),
                                ("round", (_text(table, "round"), _text(table, "round_id"), _text(trend, "current_round")))):
            value = next((v for v in options if v), None)
            if value:
                row[target] = value
        for target, source in (("banker", "total_round_banker"), ("player", "total_round_player"),
                               ("tie", "total_round_tie"), ("beadPlate", "bead_plate2"),
                               ("bigRoad", "big2"), ("bigEyeRoad", "big_eye2"),
                               ("smallRoad", "small2"), ("cockroachRoad", "cockroach2")):
            value = _text(trend, source)
            if value:
                row[target] = value
        name = next((v for v in (_text(dealer, "nick_name"), _text(dealer, "nickname"),
                                  _text(dealer, "name"), _text(dealer, "username"),
                                  _text(table, "dealer_name")) if v), None)
        if name:
            row["dealer"] = name
        photo = next((v for v in (_text(table, "dealer_image"), _text(table, "dealer_image_url"),
                                   _text(dealer, "avatar_url"), _text(dealer, "image"),
                                   _text(dealer, "avatar"), _text(dealer, "photo")) if v), None)
        if photo and urlparse(photo).scheme == "https":
            row["dealerPhoto"] = photo
        video = _video(table)
        if video:
            row["videoUrl"] = video
    return list(rows.values())


def _valid_shoe(value: str | None) -> bool:
    return bool(value and value.strip().lower() not in ("-", "—", "–", "?", "unknown", "undefined", "null", "n/a", "0"))


def _older(current: dict, update: dict) -> bool:
    old_shoe, new_shoe = current.get("shoe"), update.get("shoe")
    if old_shoe and new_shoe and old_shoe != new_shoe:
        try:
            return int(new_shoe) < int(old_shoe)
        except ValueError:
            return False
    try:
        return int(update["round"]) < int(current["round"])
    except (KeyError, ValueError, TypeError):
        return False


def _reset(current: dict) -> None:
    for key in SHARED:
        current.pop(key, None)
    current["tablePhase"] = None
    current.update({key: "" for key in ROADS})
    current.update(banker="0", player="0", tie="0")
    current.pop("aiOutcomes", None)


def merge(tables: dict[str, dict], updates: list[dict]) -> None:
    for update in updates:
        key = update.get("id")
        if not key:
            continue
        if key not in tables:
            tables[key] = dict(update)
            continue
        current = tables[key]
        event = update.get("mtEvent", "update")
        passive = event in ("snapshot", "update")
        authoritative = current.get("countdownSource") in ("wait", "end")
        older = _older(current, update)
        new_shoe = (not older and _valid_shoe(current.get("shoe")) and _valid_shoe(update.get("shoe"))
                    and current["shoe"] != update["shoe"])
        old_round, next_round = current.get("countdownRound"), update.get("countdownRound")
        new_round = bool(old_round and next_round and old_round != next_round)
        previous_value, next_value = current.get("countdownValue"), update.get("countdownValue")
        backwards_wait = (event == "wait" and authoritative and not new_round
                          and previous_value is not None and next_value is not None and next_value > previous_value)
        protect = older or (not new_shoe and ((passive and authoritative) or backwards_wait))
        old_deadline, old_received = current.get("countdownDeadline"), current.get("countdownReceivedAt")
        old_dealer = current.get("dealer")
        if new_shoe:
            _reset(current)
        elif not protect and new_round and event in ("wait", "show_poker", "complete"):
            for field in tuple(current):
                if field.startswith("countdown"):
                    current.pop(field, None)
            current["tablePhase"] = None
        for field, value in update.items():
            if protect and (field.startswith("countdown") or field in SHARED):
                continue
            if older and field in (*ROADS, "banker", "player", "tie", "aiOutcomes"):
                continue
            if (field == "sourceTableId" and event != "snapshot" and value == key
                    and current.get("sourceTableId", key) != key):
                continue
            current[field] = value
        next_deadline = update.get("countdownDeadline")
        if not protect and not new_shoe and not new_round and old_deadline is not None and next_deadline is not None:
            if authoritative or (passive and previous_value == next_value):
                current["countdownDeadline"] = min(old_deadline, next_deadline)
                if previous_value == next_value and old_received is not None:
                    current["countdownReceivedAt"] = old_received
        if update.get("dealer") and update["dealer"] != old_dealer and "dealerPhoto" not in update:
            current.pop("dealerPhoto", None)
    for key, table in tables.items():
        source_id = table.get("sourceTableId")
        if not source_id or source_id == key or source_id not in tables:
            continue
        source = tables[source_id]
        if _valid_shoe(table.get("shoe")) and _valid_shoe(source.get("shoe")) and table["shoe"] != source["shoe"]:
            if _older(table, source):
                continue
            _reset(table)
        for field in SHARED:
            if field in source:
                table[field] = source[field]
