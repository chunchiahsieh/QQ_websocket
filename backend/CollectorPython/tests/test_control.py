import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from collector import Controller
from collector_probe import Settings


class ControlTests(unittest.IsolatedAsyncioTestCase):
    async def test_start_all_starts_each_platform_once(self):
        settings = Settings("https://www.tz6868.com/", "u", "p", "device", "k" * 32,
                            ("https://jason-mt.onrender.com/",))
        controller = Controller(settings)
        seen = []

        async def wait_worker(platform):
            seen.append(platform)
            await asyncio.Event().wait()

        controller._run = wait_worker
        controller.start_all()
        await asyncio.sleep(0)
        self.assertEqual(seen, ["MT", "DG", "AB"])
        controller.start_all()
        await asyncio.sleep(0)
        self.assertEqual(seen, ["MT", "DG", "AB"])
        await asyncio.gather(*(controller.stop(p) for p in ("MT", "DG", "AB")))

    async def test_platforms_start_and_stop_independently(self):
        settings = Settings("https://www.tz6868.com/", "u", "p", "device", "k" * 32,
                            ("https://jason-mt.onrender.com/",))
        controller = Controller(settings)
        seen = []

        async def wait_worker(platform):
            seen.append(platform)
            await asyncio.Event().wait()

        controller._run = wait_worker
        controller.start("MT")
        controller.start("DG")
        await asyncio.sleep(0)
        self.assertEqual(seen, ["MT", "DG"])
        await controller.stop("MT")
        self.assertTrue(controller.tasks["DG"] and not controller.tasks["DG"].done())
        await controller.stop("DG")


if __name__ == "__main__":
    unittest.main()
