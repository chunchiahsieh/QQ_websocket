"""Local, manually controlled MT/DG/AB collector for one test destination.

Only normalized, complete baccarat snapshots leave this computer. No bets.
"""

from __future__ import annotations

import asyncio
import argparse
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

from playwright.async_api import async_playwright

from ab_decoder import AbDecoder, to_card as ab_card
from collector_probe import GAME_CODES, Settings, _allowed_socket, _check_destinations, _event, _find_text
from dg_decoder import DgDecoder, to_card as dg_card
from mt_decoder import TABLES_ACTION, action_name, extract, merge

MT_SCRIPT = r"""(() => {
  const Native = window.WebSocket;
  const sockets = [];
  function Capture(...args) {
    const socket = new Native(...args);
    try { const url = new URL(socket.url);
      if (url.hostname.endsWith('.ofalive99.net') && url.pathname.includes('/game/ws')) sockets.push(socket);
    } catch {}
    return socket;
  }
  Capture.prototype = Native.prototype;
  Object.setPrototypeOf(Capture, Native);
  window.WebSocket = Capture;
  window.__collectorMtSend = packet => {
    const socket = sockets.find(item => item.readyState === Native.OPEN);
    if (!socket) return false;
    socket.send(JSON.stringify(packet));
    return true;
  };
})()"""

PORTRAITS_SCRIPT = """() => Array.from(document.querySelectorAll('.gameDesk'))
  .filter(card => card.getBoundingClientRect().width > 0)
  .map(card => ({table: card.querySelector('.gameDesk_tag_live span:last-child, .gameDesk_tag span:last-child')?.textContent?.trim() || '',
                 name: card.querySelector('.gameDesk_anchor .txt > span')?.textContent?.trim() || '',
                 photo: card.querySelector('.gameDesk_anchor img')?.src || ''}))"""


class Authorization:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.token: str | None = None
        self.lock = asyncio.Lock()

    def _request(self, path: str, payload: dict, token: str | None = None) -> dict:
        headers = {"Content-Type": "application/json", "Accept": "application/json",
                   "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"}
        if token:
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request(self.settings.official_url.rstrip("/") + "/" + path,
                                         json.dumps(payload).encode(), headers=headers, method="POST")
        with urllib.request.urlopen(request, timeout=18) as response:
            value = json.load(response)
        if not isinstance(value, dict):
            raise ValueError("official response is not an object")
        return value

    async def game_url(self, platform: str) -> str:
        async with self.lock:
            if not self.token:
                login = await asyncio.to_thread(self._request, "api/v1/login", {
                    "username": self.settings.username, "password": self.settings.password,
                    "device_id": self.settings.device_id})
                self.token = _find_text(login, ("token", "access_token"))
                if not self.token:
                    raise RuntimeError("official member token missing")
            code = GAME_CODES[platform]
            payload = {"game_return_url": self.settings.official_url, "game_kind": "",
                       "game_type": "", "game_device": "Desktop"}
            launch = await asyncio.to_thread(self._request, f"api/v2/game/{code}/login", payload, self.token)
            url = _find_text(launch, ("game_url", "url"))
            parsed = urlparse(url or "")
            if parsed.scheme != "https" or not parsed.query:
                raise RuntimeError("official game authorization missing")
            return url or ""


class Publisher:
    def __init__(self, destination: str, key: str):
        self.destination, self.key = destination, key
        self.collector_id = "python-collector-local"
        self.last_sequence = 0
        self.sequence_lock = threading.Lock()

    def _post(self, platform: str, tables: list[dict]) -> None:
        with self.sequence_lock:
            self.last_sequence = max(self.last_sequence + 1, time.time_ns() // 1000)
            sequence = self.last_sequence
        frame = {"type": "snapshot", "platform": platform, "tables": tables,
                 "sequence": sequence, "collectorId": self.collector_id}
        request = urllib.request.Request(
            self.destination + f"api/collector/ingest/{platform}",
            json.dumps(frame, ensure_ascii=False, separators=(",", ":")).encode(),
            headers={"Content-Type": "application/json", "X-Collector-Ingest-Key": self.key}, method="POST")
        with urllib.request.urlopen(request, timeout=15) as response:
            answer = json.load(response)
        if not isinstance(answer, dict) or answer.get("accepted") is not True:
            raise RuntimeError("test site rejected snapshot")

    async def publish(self, platform: str, tables: list[dict]) -> None:
        await asyncio.to_thread(self._post, platform, tables)


def _portraits(records: list[dict]) -> dict[str, tuple[str, str]]:
    result: dict[str, tuple[str, str]] = {}
    ambiguous: set[str] = set()
    for item in records:
        match = re.fullmatch(r"B([0-9]{1,3}[A-Z]{0,2})(-L)?", str(item.get("table", "")).upper())
        photo = str(item.get("photo", ""))
        parsed = urlparse(photo)
        if not match or parsed.scheme != "https" or parsed.hostname != "ds.ofalive99.net":
            continue
        key = "BAV" + match.group(1) + ("_LIVE" if match.group(2) else "")
        candidate = (photo, str(item.get("name", "")))
        if key in result and result[key] != candidate:
            ambiguous.add(key)
        else:
            result[key] = candidate
    for key in ambiguous:
        result.pop(key, None)
    return result


class Worker:
    def __init__(self, platform: str, auth: Authorization, publisher: Publisher):
        self.platform, self.auth, self.publisher = platform, auth, publisher
        self.tables: dict[str, dict] = {}
        self.dirty = False
        self.initial_at: float | None = None
        self.last_publish = 0.0
        self.last_mt_command = 0.0
        self.last_frame = time.monotonic()
        self.page = None
        self.mt_authenticated = False
        self.joined = ""
        self.decoder = DgDecoder() if platform == "DG" else AbDecoder() if platform == "AB" else None
        self.portraits: dict[str, tuple[str, str]] = {}

    def _snapshot(self) -> list[dict]:
        rows = sorted(self.tables.values(), key=lambda row: str(row.get("name", "")))
        if self.platform == "MT":
            baccarat = [row for row in rows if row.get("gameType") in ("BAC", "BAS")]
            rows = baccarat or rows
            result = []
            for row in rows:
                copy = dict(row)
                copy.pop("dealer", None)
                copy.pop("dealerPhoto", None)
                portrait = self.portraits.get(str(copy.get("id")))
                if portrait:
                    copy["dealerPhoto"], copy["dealer"] = portrait
                result.append(copy)
            return result
        return [dict(row) for row in rows]

    async def _send_mt(self, packet: dict) -> None:
        if not self.page or not await self.page.evaluate("packet => Boolean(window.__collectorMtSend && window.__collectorMtSend(packet))", packet):
            raise RuntimeError("MT official websocket is not ready")

    async def _accept(self, frame: bytes | str) -> None:
        self.last_frame = time.monotonic()
        if self.platform == "MT":
            try:
                root = json.loads(frame)
                if not isinstance(root, dict):
                    return
            except (ValueError, UnicodeDecodeError):
                return
            action = action_name(root)
            if action == "/api/v1/authenticate":
                if root.get("err") not in (None, 0):
                    raise RuntimeError("MT official authentication rejected")
                self.mt_authenticated = True
                await self._send_mt({"method": "POST", "action": {"name": "/api/v1/member/me", "lang": "zhtw"}})
                await self._send_mt({"method": "GET", "action": {"name": TABLES_ACTION, "data": {"gametype_id": 3, "game_id": 1, "room_id": 1}}})
                return
            if action == "/api/v1/member/logout":
                raise RuntimeError("MT official session logged out")
            updates = extract(root)
            if not updates:
                return
            merge(self.tables, updates)
            if action == TABLES_ACTION:
                joined = ",".join(sorted(str(row["id"]) for row in updates))
                if joined and joined != self.joined:
                    self.joined = joined
                    await self._send_mt({"method": "GET", "action": {
                        "name": "/api/v1/gametype/*/game/*/room/*/mulitple_join", "data": {"table_id": joined}}})
                if self.initial_at is None:
                    self.initial_at = time.monotonic()
            self.dirty = True
            return
        try:
            updates = self.decoder.accept(frame)
        except (ValueError, UnicodeDecodeError, KeyError, TypeError):
            return  # Official control packets are not table packets.
        for update in updates:
            if self.platform == "DG":
                card = dg_card(update, self.page.url)
                self.tables[card["id"]] = {**self.tables.get(card["id"], {}), **card}
            else:
                card = ab_card(update)
                self.tables[card["id"]] = card
        if updates:
            if self.initial_at is None:
                self.initial_at = time.monotonic()
            self.dirty = True

    async def run(self) -> None:
        url = await self.auth.game_url(self.platform)
        _event(self.platform, "authorized")
        async with async_playwright() as playwright:
            channel = os.getenv("COLLECTOR_BROWSER_CHANNEL", "chrome").strip()
            browser = await playwright.chromium.launch(headless=os.getenv("COLLECTOR_HEADLESS") == "1",
                                                       **({"channel": channel} if channel else {}))
            try:
                context = await browser.new_context(accept_downloads=False)
                if self.platform == "MT":
                    await context.add_init_script(script=MT_SCRIPT)
                queue: asyncio.Queue[bytes | str] = asyncio.Queue()
                observed: set[int] = set()

                def attach(page):
                    if id(page) in observed:
                        return
                    observed.add(id(page))

                    def socket_open(socket):
                        if not _allowed_socket(self.platform, socket.url):
                            return
                        if self.platform == "MT":
                            self.page = page
                        _event(self.platform, "official_websocket_connected")
                        socket.on("framereceived", lambda payload: queue.put_nowait(payload))
                    page.on("websocket", socket_open)

                context.on("page", attach)
                page = await context.new_page()
                attach(page)
                self.page = page
                response = await page.goto(url, wait_until="domcontentloaded", timeout=60000)
                if response and response.status == 403:
                    raise RuntimeError("official page HTTP 403")
                _event(self.platform, "official_page_loaded")
                while True:
                    try:
                        frame = await asyncio.wait_for(queue.get(), timeout=1)
                        await self._accept(frame)
                    except TimeoutError:
                        pass
                    now = time.monotonic()
                    if now - self.last_frame > 65:
                        raise TimeoutError("official socket frame timeout")
                    if self.platform == "AB":
                        for update in self.decoder.advance_time():
                            card = ab_card(update)
                            self.tables[card["id"]] = card
                            self.dirty = True
                    if self.platform == "MT" and self.mt_authenticated and now - self.last_mt_command >= 5:
                        await self._send_mt({"method": "POST", "action": {"name": "/api/v1/ping"}})
                        await self._send_mt({"method": "GET", "action": {"name": TABLES_ACTION, "data": {
                            "gametype_id": 3, "game_id": 1, "room_id": 1}}})
                        self.last_mt_command = now
                    if self.platform == "MT" and self.initial_at is not None:
                        try:
                            observed_portraits = _portraits(await page.evaluate(PORTRAITS_SCRIPT))
                            if observed_portraits:
                                self.portraits.update(observed_portraits)
                        except Exception:
                            pass
                    if (self.initial_at is not None and self.tables and
                            now - self.initial_at >= (0 if self.platform == "MT" else 10) and
                            (self.dirty or now - self.last_publish >= 10) and
                            now - self.last_publish >= 1):
                        snapshot = self._snapshot()
                        await self.publisher.publish(self.platform, snapshot)
                        self.dirty, self.last_publish = False, now
                        _event(self.platform, "snapshot_accepted", f"tables={len(snapshot)}")
            finally:
                await browser.close()


class Controller:
    def __init__(self, settings: Settings):
        if len(settings.destinations) != 1 or settings.destinations[0] != "https://jason-mt.onrender.com/":
            raise ValueError("本次測試只允許 jason-mt；設定 COLLECTOR_DESTINATIONS 為該單一網址。")
        self.auth = Authorization(settings)
        self.publisher = Publisher(settings.destinations[0], settings.ingest_key)
        self.tasks: dict[str, asyncio.Task] = {}

    async def _run(self, platform: str) -> None:
        while True:
            try:
                _event(platform, "connecting")
                await Worker(platform, self.auth, self.publisher).run()
            except asyncio.CancelledError:
                _event(platform, "stopped")
                raise
            except urllib.error.HTTPError as exc:
                _event(platform, "http_error", f"HTTP {exc.code}")
                if exc.code == 403:
                    # Do not hammer an account that may be locked or rejected by policy.
                    return
            except Exception as exc:
                _event(platform, "retrying", type(exc).__name__)
            await asyncio.sleep(10)

    def start(self, platform: str) -> None:
        task = self.tasks.get(platform)
        if task and not task.done():
            _event(platform, "already_running")
            return
        self.tasks[platform] = asyncio.create_task(self._run(platform))
        _event(platform, "started")

    def start_all(self) -> None:
        for platform in GAME_CODES:
            self.start(platform)

    async def stop(self, platform: str) -> None:
        task = self.tasks.pop(platform, None)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        else:
            _event(platform, "already_stopped")


async def main() -> None:
    settings = Settings.from_env()
    controller = Controller(settings)
    await _check_destinations(settings)
    parser = argparse.ArgumentParser(description="本機三平台採集器；預設以命令手動啟停。")
    parser.add_argument("--smoke", choices=tuple(GAME_CODES), help="只測單一平台連線，逾時後退出。")
    parser.add_argument("--seconds", type=int, default=40)
    parser.add_argument("--start-all", action="store_true", help="啟動時自動採集 MT、DG、歐博。")
    args = parser.parse_args()
    if args.smoke:
        if not 10 <= args.seconds <= 600:
            raise ValueError("--seconds 必須介於 10 與 600。")
        try:
            await asyncio.wait_for(Worker(args.smoke, controller.auth, controller.publisher).run(), args.seconds)
        except TimeoutError:
            _event(args.smoke, "smoke_timeout", f"seconds={args.seconds}")
        except urllib.error.HTTPError as exc:
            _event(args.smoke, "official_or_upload_http_error", f"HTTP {exc.code}")
        except Exception as exc:
            _event(args.smoke, "smoke_failed", type(exc).__name__)
        return
    if args.start_all:
        controller.start_all()
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.gather(*(controller.stop(p) for p in GAME_CODES))
        return
    _event("SYSTEM", "ready", "Commands: start ALL/MT/DG/AB, stop MT/DG/AB, status, quit")
    try:
        while True:
            try:
                command = (await asyncio.to_thread(input, "> ")).strip().upper().split()
            except EOFError:
                break
            if command == ["QUIT"]:
                break
            if command == ["STATUS"]:
                for platform in GAME_CODES:
                    task = controller.tasks.get(platform)
                    _event(platform, "running" if task and not task.done() else "stopped")
            elif command == ["START", "ALL"]:
                controller.start_all()
            elif len(command) == 2 and command[1] in GAME_CODES and command[0] == "START":
                controller.start(command[1])
            elif len(command) == 2 and command[1] in GAME_CODES and command[0] == "STOP":
                await controller.stop(command[1])
            else:
                _event("SYSTEM", "invalid_command")
    finally:
        await asyncio.gather(*(controller.stop(p) for p in GAME_CODES))


if __name__ == "__main__":
    asyncio.run(main())
