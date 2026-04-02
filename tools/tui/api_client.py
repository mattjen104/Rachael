import json
import os
import asyncio
import threading
import time
from typing import Optional, Any

import aiohttp
import ssl


def _load_api_key() -> str:
    key = os.environ.get("OPENCLAW_API_KEY", "")
    if key:
        return key
    env_path = "/opt/rachael/.env"
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("OPENCLAW_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


class RachaelAPI:
    def __init__(self, base_url: Optional[str] = None, api_key: Optional[str] = None):
        self.base_url = (base_url or os.environ.get("RACHAEL_URL", "http://localhost:5000")).rstrip("/")
        self.api_key = api_key or _load_api_key()
        insecure = os.environ.get("RACHAEL_TLS_INSECURE", "") == "1"
        if insecure:
            self._ssl: Any = False
        else:
            self._ssl = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._session: Optional[aiohttp.ClientSession] = None
        self._sse_task: Optional[asyncio.Task] = None

    def start(self):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        future = asyncio.run_coroutine_threadsafe(self._init_session(), self._loop)
        future.result(timeout=10)

    def stop(self):
        if self._sse_task and self._loop:
            self._loop.call_soon_threadsafe(self._sse_task.cancel)
        if self._session and self._loop:
            future = asyncio.run_coroutine_threadsafe(self._session.close(), self._loop)
            try:
                future.result(timeout=5)
            except Exception:
                pass
        if self._loop:
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread:
            self._thread.join(timeout=5)

    def _run_loop(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    async def _init_session(self):
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = "Bearer " + self.api_key
        connector = aiohttp.TCPConnector(ssl=self._ssl)
        self._session = aiohttp.ClientSession(
            base_url=self.base_url,
            headers=headers,
            connector=connector,
            timeout=aiohttp.ClientTimeout(total=30),
        )

    def _call(self, coro):
        if not self._loop:
            raise RuntimeError("API client not started")
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=35)

    async def _request(self, method: str, path: str, body: Any = None,
                       params: Optional[dict] = None) -> Any:
        kwargs: dict = {}
        if params:
            kwargs["params"] = params
        if body is not None:
            kwargs["json"] = body
        async with self._session.request(method, path, **kwargs) as resp:
            if resp.status >= 400:
                text = await resp.text()
                raise APIError(resp.status, text)
            text = await resp.text()
            if not text:
                return None
            return json.loads(text)

    async def _get(self, path: str, params: Optional[dict] = None) -> Any:
        return await self._request("GET", path, params=params)

    async def _post(self, path: str, body: Any = None) -> Any:
        return await self._request("POST", path, body=body)

    async def _patch(self, path: str, body: Any = None) -> Any:
        return await self._request("PATCH", path, body=body)

    async def _put(self, path: str, body: Any = None) -> Any:
        return await self._request("PUT", path, body=body)

    async def _delete(self, path: str) -> Any:
        return await self._request("DELETE", path)

    def programs(self) -> list:
        return self._call(self._get("/api/programs")) or []

    def program(self, pid: int) -> dict:
        return self._call(self._get("/api/programs/" + str(pid))) or {}

    def toggle_program(self, pid: int) -> dict:
        return self._call(self._post("/api/programs/" + str(pid) + "/toggle")) or {}

    def trigger_program(self, pid: int) -> dict:
        return self._call(self._post("/api/programs/" + str(pid) + "/trigger")) or {}

    def tasks(self, status: Optional[str] = None) -> list:
        p = {}
        if status:
            p["status"] = status
        return self._call(self._get("/api/tasks", params=p)) or []

    def agenda(self) -> dict:
        return self._call(self._get("/api/tasks/agenda")) or {}

    def toggle_task(self, tid: int) -> dict:
        return self._call(self._post("/api/tasks/" + str(tid) + "/toggle")) or {}

    def create_task(self, data: dict) -> dict:
        return self._call(self._post("/api/tasks", body=data)) or {}

    def update_task(self, tid: int, data: dict) -> dict:
        return self._call(self._patch("/api/tasks/" + str(tid), body=data)) or {}

    def notes(self) -> list:
        return self._call(self._get("/api/notes")) or []

    def note(self, nid: int) -> dict:
        return self._call(self._get("/api/notes/" + str(nid))) or {}

    def create_note(self, data: dict) -> dict:
        return self._call(self._post("/api/notes", body=data)) or {}

    def skills(self) -> list:
        return self._call(self._get("/api/skills")) or []

    def captures(self, limit: int = 50) -> list:
        return self._call(self._get("/api/captures", params={"limit": str(limit)})) or []

    def smart_capture(self, text: str) -> dict:
        return self._call(self._post("/api/captures/smart", body={"rawText": text})) or {}

    def results(self, program: Optional[str] = None, limit: int = 100) -> list:
        p: dict = {"limit": str(limit)}
        if program:
            p["program"] = program
        return self._call(self._get("/api/results", params=p)) or []

    def result(self, rid: int) -> dict:
        return self._call(self._get("/api/results/" + str(rid))) or {}

    def reader_pages(self) -> list:
        return self._call(self._get("/api/reader")) or []

    def reader_page(self, pid: int) -> dict:
        return self._call(self._get("/api/reader/" + str(pid))) or {}

    def create_reader_page(self, url: str) -> dict:
        return self._call(self._post("/api/reader", body={"url": url})) or {}

    def delete_reader_page(self, pid: int) -> Any:
        return self._call(self._delete("/api/reader/" + str(pid)))

    def runtime(self) -> dict:
        return self._call(self._get("/api/runtime")) or {}

    def toggle_runtime(self) -> dict:
        return self._call(self._post("/api/runtime/toggle")) or {}

    def budget(self) -> dict:
        return self._call(self._get("/api/budget")) or {}

    def models(self) -> dict:
        return self._call(self._get("/api/models")) or {}

    def search(self, query: str) -> list:
        return self._call(self._get("/api/search", params={"q": query})) or []

    def cli_execute(self, command: str) -> dict:
        return self._call(self._post("/api/cli/run", body={"command": command})) or {}

    def cli_help(self) -> dict:
        return self._call(self._get("/api/cli/help")) or {}

    def control_state(self) -> dict:
        return self._call(self._get("/api/control")) or {}

    def toggle_control_mode(self) -> dict:
        return self._call(self._post("/api/control/toggle")) or {}

    def resolve_takeover(self, tp_id: str, decision: str) -> dict:
        return self._call(self._post(
            "/api/control/takeover-points/" + tp_id + "/resolve",
            body={"decision": decision})) or {}

    def audit_log(self, limit: int = 50) -> list:
        return self._call(self._get("/api/audit-log", params={"limit": str(limit)})) or []

    def action_permissions(self) -> list:
        return self._call(self._get("/api/control/action-permissions")) or []

    def site_profiles(self) -> list:
        return self._call(self._get("/api/site-profiles")) or []

    def navigation_paths(self) -> list:
        return self._call(self._get("/api/cockpit/nav/sessions")) or []

    def evolution_state(self) -> dict:
        return self._call(self._get("/api/evolution/state")) or {}

    def evolution_versions(self, limit: int = 20) -> list:
        return self._call(self._get("/api/evolution/versions", params={"limit": str(limit)})) or []

    def evolution_rollback(self, vid: int) -> dict:
        return self._call(self._post("/api/evolution/versions/" + str(vid) + "/rollback")) or {}

    def evolution_golden_suite(self) -> list:
        return self._call(self._get("/api/evolution/golden-suite")) or []

    def evolution_observations(self) -> list:
        return self._call(self._get("/api/evolution/observations")) or []

    def evolution_consolidate(self) -> dict:
        return self._call(self._post("/api/evolution/consolidate")) or {}

    def evolution_judge_costs(self) -> dict:
        return self._call(self._get("/api/evolution/judge-costs")) or {}

    def notifications(self) -> list:
        return self._call(self._get("/api/notifications")) or []

    def mark_notification_read(self, nid: str) -> Any:
        return self._call(self._post("/api/notifications/" + nid + "/read"))

    def config_list(self) -> list:
        return self._call(self._get("/api/config")) or []

    def get_config(self, key: str) -> dict:
        return self._call(self._get("/api/config/" + key)) or {}

    def set_config(self, key: str, value: str) -> dict:
        return self._call(self._put("/api/config/" + key, body={"value": value})) or {}

    def proposals(self) -> list:
        return self._call(self._get("/api/proposals")) or []

    def accept_proposal(self, pid: int) -> dict:
        return self._call(self._post("/api/proposals/" + str(pid) + "/accept")) or {}

    def reject_proposal(self, pid: int) -> dict:
        return self._call(self._post("/api/proposals/" + str(pid) + "/reject")) or {}

    def transcripts(self) -> list:
        return self._call(self._get("/api/transcripts")) or []

    def transcript(self, tid: int) -> dict:
        return self._call(self._get("/api/transcripts/" + str(tid))) or {}

    def start_sse(self, callback):
        if self._loop:
            self._sse_task = asyncio.run_coroutine_threadsafe(
                self._sse_loop(callback), self._loop
            )

    def stop_sse(self):
        if self._sse_task:
            self._sse_task.cancel()

    async def _sse_loop(self, callback):
        url = "/api/cockpit/events"
        while True:
            try:
                async with self._session.get(url) as resp:
                    buf = ""
                    async for chunk in resp.content.iter_any():
                        buf += chunk.decode("utf-8", errors="replace")
                        while "\n\n" in buf:
                            msg, buf = buf.split("\n\n", 1)
                            lines = msg.strip().split("\n")
                            data_lines = []
                            for ln in lines:
                                if ln.startswith("data:"):
                                    data_lines.append(ln[5:].strip())
                            if data_lines:
                                raw = "\n".join(data_lines)
                                try:
                                    event = json.loads(raw)
                                    callback(event)
                                except json.JSONDecodeError:
                                    pass
            except asyncio.CancelledError:
                return
            except Exception:
                await asyncio.sleep(3)


class APIError(Exception):
    def __init__(self, status: int, body: str):
        self.status = status
        self.body = body
        super().__init__("HTTP " + str(status) + ": " + body[:200])
