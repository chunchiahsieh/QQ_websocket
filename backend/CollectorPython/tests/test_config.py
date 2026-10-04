import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from collector_probe import Settings


class ConfigTests(unittest.TestCase):
    def settings(self, destinations):
        with patch.dict(os.environ, {
            "TZ_USERNAME": "test-user", "TZ_PASSWORD": "test-password",
            "COLLECTOR_INGEST_KEY": "x" * 32,
            "COLLECTOR_DESTINATIONS": json.dumps(destinations),
        }, clear=True):
            return Settings.from_env()

    def test_zero_destinations(self):
        self.assertEqual(self.settings([]).destinations, ())

    def test_multiple_destinations_use_one_key(self):
        item = self.settings(["http://192.168.8.231:3000", "https://example.com"])
        self.assertEqual(len(item.destinations), 2)
        self.assertEqual(item.ingest_key, "x" * 32)

    def test_public_http_is_rejected(self):
        with self.assertRaises(ValueError):
            self.settings(["http://example.com"])

    def test_duplicate_destinations_are_rejected(self):
        with self.assertRaises(ValueError):
            self.settings(["https://example.com", "https://example.com/"])


if __name__ == "__main__":
    unittest.main()
