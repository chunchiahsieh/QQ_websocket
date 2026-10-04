import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ab_decoder import AbDecoder, to_card as ab_card
from dg_decoder import DgDecoder, to_card as dg_card
from mt_decoder import TABLES_ACTION, extract, merge
from roads import ab_roads, dg_roads


def varint(number):
    result = bytearray()
    while number >= 128:
        result.append((number & 127) | 128)
        number >>= 7
    result.append(number)
    return bytes(result)


def field(number, value):
    if isinstance(value, int):
        return varint(number << 3) + varint(value)
    value = value.encode() if isinstance(value, str) else value
    return varint((number << 3) | 2) + varint(len(value)) + value


class DecoderTests(unittest.TestCase):
    def test_mt_snapshot_wait_and_live_alias(self):
        tables = {}
        root = {"action": {"name": TABLES_ACTION}, "data": [
            {"table_id": "BAV01", "table_name": "B01", "table_type": "BAC", "shoe": "12", "round": "2",
             "trend": {"bead_plate2": "0102", "total_round_banker": 1}},
            {"table_id": "BAV01_LIVE", "table_id_t": "BAV01", "table_name": "B01-L", "table_type": "BAC"}]}
        merge(tables, extract(root, 1000))
        self.assertEqual(tables["BAV01_LIVE"]["sourceTableId"], "BAV01")
        self.assertEqual(tables["BAV01_LIVE"]["shoe"], "12")
        wait = {"action": {"name": "/api/v1/table/wait"}, "data": {"table_id": "BAV01", "count": 9}}
        merge(tables, extract(wait, 2000))
        self.assertEqual(tables["BAV01_LIVE"]["countdownDeadline"], 11000)
        merge(tables, extract(root, 3000))
        self.assertEqual(tables["BAV01"]["countdownDeadline"], 11000)

    def test_dg_protobuf_table_and_lobby(self):
        decoder = DgDecoder()
        record = (field(1, 7) + field(2, 9) + field(3, 2) + field(5, 10) +
                  field(13, "RB07") + field(18, 1) + field(10, "1#3"))
        updates = decoder.accept(field(1, 206) + field(17, record))
        self.assertEqual(updates[0]["tableId"], "7")
        card = dg_card(updates[0], "https://example.com/lobby")
        self.assertEqual(card["id"], "DG:7")
        self.assertEqual(card["countdownDeadline"] - card["countdownReceivedAt"], 9500)
        self.assertEqual(card["banker"], "1")
        lobby = decoder.accept(field(1, 207) + field(16, field(1, 7) + field(2, 55)))
        self.assertEqual(lobby[0]["onlineCount"], 55)

    def test_ab_road_and_round_change(self):
        decoder = AbDecoder()
        first = {"c": "getGameHall", "p": {"D": [{"AA": "7", "BB": "C07", "DD": 101,
            "HH": {"BB": 2, "DD": 100, "EE": 10}, "WW3": [["1011ABCDEFGH"]]}]}}
        updates = decoder.accept(json.dumps(first))
        self.assertEqual(updates[0]["tableId"], "7")
        self.assertEqual(ab_card(updates[0])["id"], "AB:7")
        self.assertEqual(ab_card(updates[0])["banker"], "1")
        self.assertEqual(len(decoder.advance_time(updates[0]["receivedAt"] + 10000)), 1)
        self.assertEqual(ab_card(decoder.tables["7"])["tablePhase"], "dealing")
        self.assertEqual(dg_roads(["1#3"])["banker"], "1")
        self.assertEqual(ab_roads(["1011ABCDEFGH"])["banker"], "1")


if __name__ == "__main__":
    unittest.main()
