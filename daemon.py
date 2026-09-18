#!/usr/bin/env python3
"""本机 Chrome <-> agent 的 localhost 桥。只绑 127.0.0.1。"""
from __future__ import annotations

import base64
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HOST, PORT = "127.0.0.1", 17321
MAX_BODY_BYTES = 15_000_000
BRIDGE_HEADER = "X-Chrome-Bridge"
ROOT = Path(__file__).resolve().parent
SHOT = ROOT / "last.jpg"
INDEX = ROOT / "last.json"
TEXT = ROOT / "last.txt"
READ_TEXT = ROOT / "last-read.txt"


class Bridge:
    def __init__(self) -> None:
        self.cv = threading.Condition()
        self.cmd: dict | None = None
        self.result: dict | None = None
        self.in_flight = False
        self.last_pull = 0.0

    def post_cmd(self, payload: dict, timeout: float = 60.0) -> dict:
        cid = uuid.uuid4().hex[:12]
        with self.cv:
            deadline = time.monotonic() + timeout
            while self.cmd is not None:
                left = deadline - time.monotonic()
                if left <= 0:
                    return {"ok": False, "error": "busy: previous command still running"}
                self.cv.wait(left)
            self.cmd = {**payload, "id": cid}
            self.result = None
            self.in_flight = False
            self.cv.notify_all()
            ok = self.cv.wait_for(
                lambda: self.result is not None and self.result.get("id") == cid,
                timeout=max(0.1, deadline - time.monotonic()),
            )
            r = self.result if ok else None
            self.cmd = None
            self.result = None
            self.in_flight = False
            self.cv.notify_all()
            if not ok:
                return {"ok": False, "error": "timeout: Chrome 扩展没响应，确认已加载且点过工具栏图标"}
            return _materialize_shot(r) if r else {"ok": False, "error": "empty result"}

    def pull(self, wait: float = 25.0) -> dict | None:
        with self.cv:
            self.last_pull = time.monotonic()
            self.cv.wait_for(lambda: self.cmd is not None and not self.in_flight, timeout=wait)
            if self.cmd is None or self.in_flight:
                return None
            self.in_flight = True
            return dict(self.cmd)

    def push_result(self, result: dict) -> bool:
        with self.cv:
            # Ignore a late response after the caller timed out or a newer command took its place
            if self.cmd is None or not self.in_flight or result.get("id") != self.cmd.get("id"):
                return False
            self.result = result
            self.in_flight = False
            self.cv.notify_all()
            return True


def format_index(elements: list) -> str:
    lines = []
    for e in elements:
        lines.append(
            f"#{e.get('id')}  {e.get('role', '')} {json.dumps(e.get('name', ''), ensure_ascii=False)}"
            f" @ ({e.get('x')}, {e.get('y')}, {e.get('w')}, {e.get('h')})"
        )
    return "\n".join(lines)


def _materialize_shot(r: dict) -> dict:
    data = r.get("data")
    if not isinstance(data, dict):
        return r
    url = data.get("dataUrl")
    if isinstance(url, str) and "," in url:
        SHOT.write_bytes(base64.b64decode(url.split(",", 1)[1]))
        data.pop("dataUrl", None)
        data["path"] = str(SHOT)
    els = data.get("elements")
    if isinstance(els, list):
        INDEX.write_text(json.dumps(els, ensure_ascii=False, indent=2), encoding="utf-8")
        idx = data.get("index")
        TEXT.write_text(idx if isinstance(idx, str) else format_index(els), encoding="utf-8")
    page_text = data.get("text")
    if isinstance(page_text, str):
        READ_TEXT.write_text(page_text, encoding="utf-8")
        data["textPath"] = str(READ_TEXT)
    return r


BRIDGE = Bridge()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[chrome-bridge] {fmt % args}")

    def _send(self, code: int, body: dict | bytes, content_type: str = "application/json") -> None:
        raw = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        origin = self.headers.get("Origin")
        if origin and origin.startswith("chrome-extension://"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(raw)

    def _origin_allowed(self) -> bool:
        origin = self.headers.get("Origin")
        # CLI calls have no Origin; browser pages must be the installed extension
        return not origin or origin.startswith("chrome-extension://")

    def do_OPTIONS(self) -> None:
        if not self._origin_allowed():
            self._send(403, {"ok": False, "error": "origin not allowed"})
            return
        self.send_response(204)
        origin = self.headers.get("Origin")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", f"content-type, {BRIDGE_HEADER}")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:
        if not self._origin_allowed():
            self._send(403, {"ok": False, "error": "origin not allowed"})
            return
        path = urlparse(self.path).path
        if path == "/health":
            lag = time.monotonic() - BRIDGE.last_pull if BRIDGE.last_pull else None
            self._send(
                200,
                {
                    "ok": True,
                    "extension": lag is not None and lag < 40,
                    "lastPullAgoSec": None if lag is None else round(lag, 1),
                },
            )
            return
        if path == "/shot":
            if not SHOT.exists():
                self._send(404, {"ok": False, "error": "no screenshot yet"})
                return
            self._send(200, SHOT.read_bytes(), "image/jpeg")
            return
        if path == "/pull":
            if self.headers.get(BRIDGE_HEADER) != "1":
                self._send(403, {"ok": False, "error": "bridge header required"})
                return
            cmd = BRIDGE.pull(25)
            self._send(200, cmd or {"idle": True})
            return
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        if not self._origin_allowed():
            self._send(403, {"ok": False, "error": "origin not allowed"})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._send(400, {"ok": False, "error": "bad content length"})
            return
        if n < 0 or n > MAX_BODY_BYTES:
            self._send(413, {"ok": False, "error": "request body too large"})
            return
        try:
            data = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"ok": False, "error": "bad json"})
            return
        path = urlparse(self.path).path
        if path == "/cmd":
            if not isinstance(data, dict) or not data.get("action"):
                self._send(400, {"ok": False, "error": "need {action}"})
                return
            self._send(200, BRIDGE.post_cmd(data))
            return
        if path == "/result":
            if self.headers.get(BRIDGE_HEADER) != "1":
                self._send(403, {"ok": False, "error": "bridge header required"})
                return
            if not isinstance(data, dict) or "id" not in data:
                self._send(400, {"ok": False, "error": "need {id}"})
                return
            accepted = BRIDGE.push_result(data)
            self._send(200 if accepted else 409, {"ok": accepted, "error": None if accepted else "stale result"})
            return
        self._send(404, {"ok": False, "error": "not found"})


def _self_check() -> None:
    b = Bridge()

    def worker() -> None:
        time.sleep(0.05)
        got = b.pull(1)
        assert got and got["action"] == "ping", got
        b.push_result({"id": got["id"], "ok": True, "data": "pong"})

    t = threading.Thread(target=worker)
    t.start()
    r = b.post_cmd({"action": "ping"}, timeout=2)
    t.join()
    assert r == {"id": r["id"], "ok": True, "data": "pong"}, r
    assert format_index([{"id": 1, "role": "button", "name": "创建", "x": 10, "y": 20, "w": 30, "h": 12}]) == (
        '#1  button "创建" @ (10, 20, 30, 12)'
    )
    stale = Bridge()
    stale.push_result({"id": "late", "ok": True})
    assert stale.result is None
    print("self-check ok")


if __name__ == "__main__":
    import sys

    if "--check" in sys.argv:
        _self_check()
        raise SystemExit(0)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"chrome-bridge http://{HOST}:{PORT}")
    httpd.serve_forever()
