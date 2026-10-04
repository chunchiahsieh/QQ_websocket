import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lifecycle import Action
from supervisor import CollectorSupervisor


class SupervisorTests(unittest.IsolatedAsyncioTestCase):
    async def test_returning_viewer_keeps_existing_workers(self):
        entered = {name: 0 for name in ("MT", "DG", "AB")}

        async def worker(name):
            entered[name] += 1
            await asyncio.Event().wait()

        jobs = {name: lambda name=name: worker(name) for name in entered}
        sup = CollectorSupervisor(jobs, lambda *_: None)
        try:
            sup.start()
            await asyncio.sleep(0)
            before = dict(sup.tasks)
            self.assertEqual(await sup.observe(0, 0), Action.NONE)
            self.assertEqual(await sup.observe(1, 200), Action.NONE)
            self.assertEqual(sup.tasks, before)
            self.assertEqual(entered, {"MT": 1, "DG": 1, "AB": 1})
        finally:
            await sup.stop()

    async def test_idle_stop_then_viewer_start(self):
        async def worker():
            await asyncio.Event().wait()

        sup = CollectorSupervisor({name: worker for name in ("MT", "DG", "AB")}, lambda *_: None)
        try:
            sup.start()
            await sup.observe(0, 0)
            self.assertEqual(await sup.observe(0, 301), Action.STOP)
            self.assertEqual(sup.tasks, {})
            self.assertEqual(await sup.observe(1, 302), Action.START)
            self.assertEqual(set(sup.tasks), {"MT", "DG", "AB"})
        finally:
            await sup.stop()

    async def test_one_worker_failure_does_not_restart_peers(self):
        entered = {name: 0 for name in ("MT", "DG", "AB")}

        async def worker(name):
            entered[name] += 1
            if name == "DG" and entered[name] == 1:
                raise RuntimeError("DG lost connection")
            await asyncio.Event().wait()

        jobs = {name: lambda name=name: worker(name) for name in entered}
        sup = CollectorSupervisor(jobs, lambda *_: None, retry_seconds=0.01)
        try:
            sup.start()
            await asyncio.sleep(0.04)
            self.assertGreaterEqual(entered["DG"], 2)
            self.assertEqual(entered["MT"], 1)
            self.assertEqual(entered["AB"], 1)
        finally:
            await sup.stop()


if __name__ == "__main__":
    unittest.main()
