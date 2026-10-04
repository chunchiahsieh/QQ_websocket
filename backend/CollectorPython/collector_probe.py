"""Read-only three-platform connection probe for the planned Python collector.

This intentionally does not publish snapshots. A WebSocket frame is not proof
that a table was decoded correctly; production ingestion needs a separate port
of the existing MT/DG/AB normalizers.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import sys
import time
from dataclasses import dataclass
from urllib.parse import urlparse

GAME_CODES = {"MT": "MTLI", "DG": "DGLI", "AB": "AB01"}


def _find_text(value: object, names: tuple[str, ...]) -> str | None:
    if isinstance(value, dict):
        for name in names:
            found = value.get(name)
            if isinstance(found, str) and found.strip():
                return found.strip()
        for nested in value.values():
            found = _find_text(nested, names)
            if found:
                return found
    elif isinstance(value, list):
        for nested in value:
            found = _find_text(nested, names)
            if found:
                return found
    return None


def _valid_destination(raw: str) -> bool:
    parsed = urlparse(raw)
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        return False
    if parsed.scheme == "https":
        return True
    if parsed.scheme != "http":
        return False
    try:
        return ipaddress.ip_address(parsed.hostname).is_private or ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        return parsed.hostname == "localhost"


@dataclass(frozen=True)
class Settings:
    official_url: str
    username: str
    password: str
    device_id: str
    ingest_key: str
    destinations: tuple[str, ...]
    duration_seconds: int = 90

    @classmethod
    def from_env(cls) -> "Settings":
        official_url = os.getenv("TZ_OFFICIAL_URL", "https://www.tz6868.com/").strip()
        username = os.getenv("TZ_USERNAME", "").strip()
        password = os.getenv("TZ_PASSWORD", "")
        device_id = os.getenv("TZ_DEVICE_ID", "python-collector-a").strip()
        ingest_key = os.getenv("COLLECTOR_INGEST_KEY", "")
        destinations_raw = os.getenv("COLLECTOR_DESTINATIONS", "[]")
        try:
            parsed_destinations = json.loads(destinations_raw)
        except json.JSONDecodeError as exc:
            raise ValueError("COLLECTOR_DESTINATIONS 必須是 JSON 網址陣列。") from exc
        if not isinstance(parsed_destinations, list) or any(not isinstance(x, str) for x in parsed_destinations):
            raise ValueError("COLLECTOR_DESTINATIONS 必須是 JSON 網址陣列。")
        destinations = tuple(x.rstrip("/") + "/" for x in parsed_destinations)
        if len(set(destinations)) != len(destinations) or any(not _valid_destination(x) for x in destinations):
            raise ValueError("接收網址重複或格式不正確；正式站需 HTTPS，HTTP 僅限私有區網。")
        if not username or not password:
            raise ValueError("請設定 TZ_USERNAME 與 TZ_PASSWORD。")
        if not official_url.startswith("https://"):
            raise ValueError("TZ_OFFICIAL_URL 必須使用 HTTPS。")
        if destinations and len(ingest_key) < 32:
            raise ValueError("設定接收網址時，COLLECTOR_INGEST_KEY 至少需要 32 字元。")
        duration = int(os.getenv("COLLECTOR_PROBE_SECONDS", "90"))
        if not 10 <= duration <= 600:
            raise ValueError("COLLECTOR_PROBE_SECONDS 必須介於 10 與 600。")
        return cls(official_url, username, password, device_id, ingest_key, destinations, duration)


def _event(platform: str, stage: str, detail: str = "") -> None:
    # No URLs, tokens, account details, packets or credentials in logs.
    print(json.dumps({"time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                      "platform": platform, "stage": stage, "detail": detail},
                     ensure_ascii=False), flush=True)


def _allowed_socket(platform: str, raw: str) -> bool:
    parsed = urlparse(raw)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("ws", "wss"):
        return False
    if platform == "MT":
        return host.endswith(".ofalive99.net") and "/game/ws" in parsed.path.lower()
    if platform == "DG":
        return any(host.endswith(s) for s in (".taxyss.com", ".kindlestone.com", ".ywjxi.com"))
    return parsed.scheme == "wss" and any(host.endswith(s) for s in (".maofeiyan.com", ".51shengce.com", ".kindlestone.com"))


async def _authorize(settings: Settings) -> dict[str, str]:
    """One member login, then independent per-platform launch authorization."""
    import urllib.request

    def request(path: str, payload: dict[str, str], bearer: str | None = None) -> object:
        base = settings.official_url.rstrip("/") + "/"
        headers = {"Content-Type": "application/json"}
        if bearer:
            headers["Authorization"] = "Bearer " + bearer
        req = urllib.request.Request(base + path, json.dumps(payload).encode(), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=18) as response:
            return json.load(response)

    login = await asyncio.to_thread(request, "api/v1/login", {
        "username": settings.username, "password": settings.password, "device_id": settings.device_id})
    token = _find_text(login, ("token", "access_token"))
    if not token:
        raise RuntimeError("官方會員登入未取得授權。")
    result: dict[str, str] = {}
    for platform, code in GAME_CODES.items():
        try:
            launch = await asyncio.to_thread(request, f"api/v2/game/{code}/login", {
                "game_return_url": settings.official_url, "game_kind": "",
                "game_type": "", "game_device": "Desktop"}, token)
            url = _find_text(launch, ("game_url", "url"))
            parsed = urlparse(url or "")
            if parsed.scheme != "https" or not parsed.query:
                raise RuntimeError("官方未提供有效遊戲授權網址。")
            result[platform] = url or ""
            _event(platform, "authorized")
        except Exception:
            _event(platform, "authorization_failed")
    return result


async def _probe_platform(platform: str, launch_url: str, duration: int) -> bool:
    from playwright.async_api import async_playwright

    frames = 0
    sockets = 0
    first_frame = asyncio.Event()
    async with async_playwright() as playwright:
        channel = os.getenv("COLLECTOR_BROWSER_CHANNEL", "chrome" if sys.platform == "win32" else "").strip()
        browser = await playwright.chromium.launch(headless=True, **({"channel": channel} if channel else {}))
        try:
            context = await browser.new_context(accept_downloads=False)

            def attach_page(page: object) -> None:
                def attach_socket(socket: object) -> None:
                    nonlocal sockets, frames
                    if not _allowed_socket(platform, socket.url):
                        return
                    sockets += 1
                    _event(platform, "official_websocket_connected")

                    def received(_: object) -> None:
                        nonlocal frames
                        frames += 1
                        first_frame.set()

                    socket.on("framereceived", received)

                page.on("websocket", attach_socket)

            observed_pages: set[int] = set()

            def attach_once(page: object) -> None:
                if id(page) in observed_pages:
                    return
                observed_pages.add(id(page))
                attach_page(page)

            context.on("page", attach_once)
            page = await context.new_page()
            attach_once(page)
            response = await page.goto(launch_url, wait_until="domcontentloaded", timeout=60000)
            if response and response.status == 403:
                _event(platform, "official_rejected", "HTTP 403")
                return False
            _event(platform, "official_page_loaded")
            try:
                await asyncio.wait_for(first_frame.wait(), timeout=duration)
            except TimeoutError:
                _event(platform, "no_official_frame", f"socket_count={sockets}")
                return False
            await asyncio.sleep(min(10, duration / 3))
            _event(platform, "official_frames_received", f"frame_count={frames}")
            return True
        finally:
            await browser.close()


async def _check_destinations(settings: Settings) -> None:
    import urllib.request

    def check(destination: str) -> None:
        req = urllib.request.Request(destination + "api/collector/demand", headers={
            "X-Collector-Ingest-Key": settings.ingest_key})
        with urllib.request.urlopen(req, timeout=12) as response:
            value = json.load(response)
        if not isinstance(value, dict) or not isinstance(value.get("viewerCount"), int):
            raise ValueError("觀看需求格式不正確。")

    if not settings.destinations:
        _event("TARGETS", "no_destinations", "只測官方連線，不上傳")
        return
    for index, destination in enumerate(settings.destinations, 1):
        try:
            await asyncio.to_thread(check, destination)
            _event("TARGETS", "demand_ok", f"target={index}")
        except Exception:
            _event("TARGETS", "demand_failed", f"target={index}")


async def main() -> int:
    settings = Settings.from_env()
    await _check_destinations(settings)
    try:
        launches = await _authorize(settings)
    except Exception as exc:
        http_code = getattr(exc, "code", None)
        _event("OFFICIAL", "member_login_failed",
               f"HTTP {http_code}" if isinstance(http_code, int) else type(exc).__name__)
        return 1
    outcomes = await asyncio.gather(*(
        _probe_platform(platform, url, settings.duration_seconds)
        for platform, url in launches.items()), return_exceptions=True)
    passed = 0
    for platform, outcome in zip(launches, outcomes):
        if outcome is True:
            passed += 1
        elif isinstance(outcome, BaseException):
            _event(platform, "probe_failed", type(outcome).__name__)
    _event("SUMMARY", "connection_probe_finished", f"official_frame_platforms={passed}/3")
    return 0 if passed == 3 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
