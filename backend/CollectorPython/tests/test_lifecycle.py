import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lifecycle import Action, ViewerLifecycle


class ViewerLifecycleTests(unittest.TestCase):
    def test_viewer_returns_before_idle_stop_without_restart(self):
        life = ViewerLifecycle()
        self.assertEqual(life.observe(0, 0), Action.NONE)
        self.assertEqual(life.observe(1, 200), Action.NONE)
        self.assertTrue(life.running)
        self.assertIsNone(life.empty_since)

    def test_viewer_after_idle_stop_starts_only_once(self):
        life = ViewerLifecycle()
        self.assertEqual(life.observe(0, 0), Action.NONE)
        self.assertEqual(life.observe(0, 301), Action.STOP)
        self.assertEqual(life.observe(1, 302), Action.START)
        self.assertEqual(life.observe(2, 303), Action.NONE)

    def test_demand_failure_does_not_change_state(self):
        life = ViewerLifecycle()
        life.observe(0, 0)
        # A failed HTTP read must not call observe or manufacture viewerCount=0.
        self.assertTrue(life.running)
        self.assertEqual(life.observe(0, 299), Action.NONE)


if __name__ == "__main__":
    unittest.main()
