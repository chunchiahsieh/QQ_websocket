"""DG V3.3.3 protobuf table decoder; ignores account/control fields."""

from __future__ import annotations

import time
from urllib.parse import urlparse

from roads import dg_roads


class ProtoReader:
    def __init__(self, data: bytes):
        self.data, self.offset = data, 0

    @property
    def done(self) -> bool:
        return self.offset == len(self.data)

    def uint(self) -> int:
        value = 0
        for shift in range(0, 70, 7):
            if self.offset >= len(self.data):
                break
            byte = self.data[self.offset]
            self.offset += 1
            if shift == 63 and byte > 1:
                break
            value |= (byte & 127) << shift
            if not byte & 128:
                return value
        raise ValueError("invalid protobuf varint")

    def tag(self) -> tuple[int, int]:
        tag = self.uint()
        if tag < 8 or tag > 0xffffffff:
            raise ValueError("invalid protobuf tag")
        return tag >> 3, tag & 7

    def bytes(self) -> bytes:
        size = self.uint()
        if size > len(self.data) - self.offset:
            raise ValueError("invalid protobuf length")
        start = self.offset
        self.offset += size
        return self.data[start:self.offset]

    def text(self) -> str:
        return self.bytes().decode("utf-8", errors="replace")

    def skip(self, wire: int) -> None:
        if wire == 0:
            self.uint()
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
            if self.offset + size > len(self.data):
                raise ValueError("invalid protobuf fixed width")
            self.offset += size
        elif wire == 2:
            self.bytes()
        else:
            raise ValueError("unsupported protobuf wire type")


def _dealer(data: bytes) -> dict:
    reader, result = ProtoReader(data), {}
    while not reader.done:
        field, wire = reader.tag()
        if field == 1 and wire == 0:
            result["id"] = str(reader.uint())
        elif field in (2, 4) and wire == 2:
            result["name" if field == 2 else "photo"] = reader.text()
        else:
            reader.skip(wire)
    return result


def _table(data: bytes) -> dict:
    reader, result = ProtoReader(data), {}
    numbers = {4: "state", 5: "countDown", 16: "onlineCount", 18: "gameId"}
    strings = {6: "result", 7: "poker", 11: "gameNo", 12: "fms", 13: "tableName"}
    while not reader.done:
        field, wire = reader.tag()
        if field in (1, 2, 3) and wire == 0:
            result[{1: "tableId", 2: "shoeId", 3: "playId"}[field]] = str(reader.uint())
        elif field in numbers and wire == 0:
            result[numbers[field]] = reader.uint()
        elif field in strings and wire == 2:
            result[strings[field]] = reader.text()
        elif field == 10 and wire == 2:
            result.setdefault("roads", []).append(reader.text())
        elif field == 17 and wire == 2:
            result["dealer"] = _dealer(reader.bytes())
        else:
            reader.skip(wire)
    return result


def _lobby(data: bytes) -> tuple[str | None, int | None]:
    reader, table_id, count = ProtoReader(data), None, None
    while not reader.done:
        field, wire = reader.tag()
        if field == 1 and wire == 0:
            table_id = str(reader.uint())
        elif field == 2 and wire == 0:
            count = reader.uint()
        else:
            reader.skip(wire)
    return table_id, count


class DgDecoder:
    def __init__(self):
        self.tables: dict[str, dict] = {}
        self.lobby_counts: set[str] = set()
        self.pending_counts: dict[str, int] = {}

    def accept(self, data: bytes) -> list[dict]:
        reader = ProtoReader(data)
        command, table_id, roads, updates, lobby = 0, None, [], [], []
        while not reader.done:
            field, wire = reader.tag()
            if field == 1 and wire == 0:
                command = reader.uint()
            elif field == 6 and wire == 0:
                table_id = str(reader.uint())
            elif field == 12 and wire == 2:
                roads.append(reader.text())
            elif field == 16 and wire == 2:
                lobby.append(_lobby(reader.bytes()))
            elif field == 17 and wire == 2:
                updates.append(_table(reader.bytes()))
            else:
                reader.skip(wire)
        if command == 1004 and table_id in self.tables:
            updates.append({"tableId": table_id, "roads": roads})
        changed: set[str] = set()
        for update in updates:
            key = update.get("tableId")
            if not key:
                continue
            if key not in self.tables:
                if update.get("gameId") != 1 or len(self.tables) >= 300:
                    continue
                self.tables[key] = {}
            if "gameId" in update and update["gameId"] != 1:
                self.tables.pop(key, None)
                self.lobby_counts.discard(key)
                self.pending_counts.pop(key, None)
                continue
            current = self.tables[key]
            if key in self.lobby_counts:
                update.pop("onlineCount", None)
            if "countDown" in update:
                update["receivedAt"] = int(time.time() * 1000)
            if "shoeId" in update and current.get("shoeId") != update["shoeId"]:
                current["roads"] = []
            current.update(update)
            if key in self.pending_counts:
                current["onlineCount"] = self.pending_counts.pop(key)
                self.lobby_counts.add(key)
            changed.add(key)
        if command == 207:
            for key, count in lobby:
                if key is None or count is None:
                    continue
                if key not in self.tables:
                    if len(self.pending_counts) >= 300:
                        self.pending_counts.pop(next(iter(self.pending_counts)))
                    self.pending_counts[key] = count
                    continue
                current = self.tables[key]
                first = key not in self.lobby_counts
                self.lobby_counts.add(key)
                if first or current.get("onlineCount") != count:
                    current["onlineCount"] = count
                    changed.add(key)
        return [dict(self.tables[key]) for key in changed if key in self.tables]


def to_card(source: dict, page_url: str) -> dict:
    key = str(source["tableId"])
    name = str(source.get("tableName") or key)
    row = {"id": "DG:" + key, "name": name, "gameType": "BAC", "room": name,
           "shoe": str(source.get("shoeId", "—")), "round": str(source.get("playId", "—")),
           "players": str(source.get("onlineCount", "—"))}
    row.update(dg_roads(source.get("roads", [])))
    if "countDown" in source:
        seconds = max(0, int(source["countDown"]))
        received = int(source.get("receivedAt", int(time.time() * 1000)))
        row.update(countdownValue=seconds, countdownDeadline=received + seconds * 950,
                   countdownReceivedAt=received)
    if "state" in source:
        row["tablePhase"] = "dealing" if source["state"] in (2, 3, 4) else "shuffling" if source["state"] == 8 else None
    dealer = source.get("dealer")
    if isinstance(dealer, dict):
        row["dealer"] = str(dealer.get("name") or "未指派")
        photo = dealer.get("photo")
        if isinstance(photo, str) and photo and ".." not in photo and ":" not in photo:
            parsed = urlparse(page_url)
            row["dealerPhoto"] = f"{parsed.scheme}://{parsed.netloc}/vd/vd/image/Image/dealer/{photo.lstrip('/')}"
    return row
