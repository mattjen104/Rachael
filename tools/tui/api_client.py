import json
import os
import urllib.request
import urllib.error
import urllib.parse
import ssl
import threading
import time
from typing import Optional, Any


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
        self._insecure = os.environ.get("RACHAEL_TLS_INSECURE", "") == "1"
        self._ctx = ssl.create_default_context()
        if self._insecure:
            self._ctx.check_hostname = False
            self._ctx.verify_mode = ssl.CERT_NONE
        self._sse_thread: Optional[threading.Thread] = None
        self._sse_stop = threading.Event()

    def _headers(self, extra: Optional[dict] = None) -> dict:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = "Bearer " + self.api_key
        if extra:
            h.update(extra)
        return h

    def _request(self, method: str, path: str, body: Any = None,
                 params: Optional[dict] = None) -> Any:
        url = self.base_url + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=self._headers(), method=method)
        handler = urllib.request.HTTPSHandler(context=self._ctx)
        opener = urllib.request.build_opener(handler)
        try:
            resp = opener.open(req, timeout=30)
            raw = resp.read().decode("utf-8")
            if not raw:
                return None
            return json.loads(raw)
        except urllib.error.HTTPError as e:
            body_text = ""
            try:
                body_text = e.read().decode("utf-8")
            except Exception:
                pass
            raise APIError(e.code, body_text) from e
        except urllib.error.URLError as e:
            raise ConnectionError("Cannot reach Rachael: " + str(e.reason)) from e

    def get(self, path: str, params: Optional[dict] = None) -> Any:
        return self._request("GET", path, params=params)

    def post(self, path: str, body: Any = None) -> Any:
        return self._request("POST", path, body=body)

    def patch(self, path: str, body: Any = None) -> Any:
        return self._request("PATCH", path, body=body)

    def put(self, path: str, body: Any = None) -> Any:
        return self._request("PUT", path, body=body)

    def delete(self, path: str) -> Any:
        return self._request("DELETE", path)

    def programs(self) -> list:
        return self.get("/api/programs") or []

    def program(self, pid: int) -> dict:
        return self.get("/api/programs/" + str(pid)) or {}

    def toggle_program(self, pid: int) -> dict:
        return self.post("/api/programs/" + str(pid) + "/toggle") or {}

    def trigger_program(self, pid: int) -> dict:
        return self.post("/api/programs/" + str(pid) + "/trigger") or {}

    def tasks(self, status: Optional[str] = None) -> list:
        p = {}
        if status:
            p["status"] = status
        return self.get("/api/tasks", params=p) or []

    def agenda(self) -> dict:
        return self.get("/api/tasks/agenda") or {}

    def toggle_task(self, tid: int) -> dict:
        return self.post("/api/tasks/" + str(tid) + "/toggle") or {}

    def create_task(self, data: dict) -> dict:
        return self.post("/api/tasks", body=data) or {}

    def update_task(self, tid: int, data: dict) -> dict:
        return self.patch("/api/tasks/" + str(tid), body=data) or {}

    def notes(self) -> list:
        return self.get("/api/notes") or []

    def note(self, nid: int) -> dict:
        return self.get("/api/notes/" + str(nid)) or {}

    def create_note(self, data: dict) -> dict:
        return self.post("/api/notes", body=data) or {}

    def captures(self, limit: int = 50) -> list:
        return self.get("/api/captures", params={"limit": str(limit)}) or []

    def smart_capture(self, text: str) -> dict:
        return self.post("/api/captures/smart", body={"rawText": text}) or {}

    def results(self, program: Optional[str] = None, limit: int = 100) -> list:
        p: dict = {"limit": str(limit)}
        if program:
            p["program"] = program
        return self.get("/api/results", params=p) or []

    def result(self, rid: int) -> dict:
        return self.get("/api/results/" + str(rid)) or {}

    def reader_pages(self) -> list:
        return self.get("/api/reader") or []

    def reader_page(self, pid: int) -> dict:
        return self.get("/api/reader/" + str(pid)) or {}

    def create_reader_page(self, url: str) -> dict:
        return self.post("/api/reader", body={"url": url}) or {}

    def delete_reader_page(self, pid: int) -> Any:
        return self.delete("/api/reader/" + str(pid))

    def runtime(self) -> dict:
        return self.get("/api/runtime") or {}

    def toggle_runtime(self) -> dict:
        return self.post("/api/runtime/toggle") or {}

    def budget(self) -> dict:
        return self.get("/api/budget") or {}

    def models(self) -> dict:
        return self.get("/api/models") or {}

    def search(self, query: str) -> list:
        return self.get("/api/search", params={"q": query}) or []

    def cli_execute(self, command: str) -> dict:
        return self.post("/api/cli/run", body={"command": command}) or {}

    def cli_help(self) -> dict:
        return self.get("/api/cli/help") or {}

    def control_state(self) -> dict:
        return self.get("/api/control") or {}

    def toggle_control_mode(self) -> dict:
        return self.post("/api/control/toggle") or {}

    def resolve_takeover(self, tp_id: str, decision: str) -> dict:
        return self.post("/api/control/takeover-points/" + tp_id + "/resolve",
                         body={"decision": decision}) or {}

    def audit_log(self, limit: int = 50) -> list:
        return self.get("/api/audit-log", params={"limit": str(limit)}) or []

    def action_permissions(self) -> list:
        return self.get("/api/control/action-permissions") or []

    def site_profiles(self) -> list:
        return self.get("/api/site-profiles") or []

    def navigation_paths(self) -> list:
        return self.get("/api/cockpit/nav/sessions") or []

    def evolution_state(self) -> dict:
        return self.get("/api/evolution/state") or {}

    def evolution_versions(self, limit: int = 20) -> list:
        return self.get("/api/evolution/versions", params={"limit": str(limit)}) or []

    def evolution_rollback(self, vid: int) -> dict:
        return self.post("/api/evolution/versions/" + str(vid) + "/rollback") or {}

    def evolution_golden_suite(self) -> list:
        return self.get("/api/evolution/golden-suite") or []

    def evolution_observations(self) -> list:
        return self.get("/api/evolution/observations") or []

    def evolution_consolidate(self) -> dict:
        return self.post("/api/evolution/consolidate") or {}

    def evolution_judge_costs(self) -> dict:
        return self.get("/api/evolution/judge-costs") or {}

    def notifications(self) -> list:
        return self.get("/api/notifications") or []

    def mark_notification_read(self, nid: str) -> Any:
        return self.post("/api/notifications/" + nid + "/read")

    def config(self) -> list:
        return self.get("/api/config") or []

    def get_config(self, key: str) -> dict:
        return self.get("/api/config/" + key) or {}

    def set_config(self, key: str, value: str) -> dict:
        return self.put("/api/config/" + key, body={"value": value}) or {}

    def proposals(self) -> list:
        return self.get("/api/proposals") or []

    def accept_proposal(self, pid: int) -> dict:
        return self.post("/api/proposals/" + str(pid) + "/accept") or {}

    def reject_proposal(self, pid: int) -> dict:
        return self.post("/api/proposals/" + str(pid) + "/reject") or {}

    def transcripts(self) -> list:
        return self.get("/api/transcripts") or []

    def start_sse(self, callback):
        self._sse_stop.clear()
        self._sse_thread = threading.Thread(target=self._sse_loop,
                                            args=(callback,), daemon=True)
        self._sse_thread.start()

    def stop_sse(self):
        self._sse_stop.set()
        if self._sse_thread:
            self._sse_thread.join(timeout=5)

    def _sse_loop(self, callback):
        url = self.base_url + "/api/cockpit/events"
        while not self._sse_stop.is_set():
            try:
                req = urllib.request.Request(url, headers=self._headers())
                handler = urllib.request.HTTPSHandler(context=self._ctx)
                opener = urllib.request.build_opener(handler)
                resp = opener.open(req, timeout=60)
                buf = ""
                while not self._sse_stop.is_set():
                    chunk = resp.read(1)
                    if not chunk:
                        break
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
            except Exception:
                if not self._sse_stop.is_set():
                    time.sleep(3)


class APIError(Exception):
    def __init__(self, status: int, body: str):
        self.status = status
        self.body = body
        super().__init__("HTTP " + str(status) + ": " + body[:200])
