#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"
PORT = int(os.environ["NQC_PFT_PROXY_PORT"])
UPSTREAM_URL = os.environ["NQC_PFT_UPSTREAM_URL"]
UPSTREAM_ID = os.environ["NQC_PFT_UPSTREAM_ID"]
LOG_PATH = Path(os.environ["NQC_PFT_PROXY_LOG"])
MIN_INTERVAL_SECONDS = float(os.environ.get("NQC_PFT_MIN_INTERVAL_SECONDS", "0.25"))
MAX_ATTEMPTS = int(os.environ.get("NQC_PFT_MAX_ATTEMPTS", "9"))
TIMEOUT_SECONDS = float(os.environ.get("NQC_PFT_UPSTREAM_TIMEOUT_SECONDS", "45"))

_lock = threading.Lock()
_last_request_at = 0.0
_stats_lock = threading.Lock()
_stats = {
    "requests": 0,
    "upstream_attempts": 0,
    "retries": 0,
    "http_429": 0,
    "http_5xx": 0,
    "rpc_rate_limits": 0,
    "failures": 0,
}


def log(event: dict) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "ts": time.time(),
        "upstream_id": UPSTREAM_ID,
        **event,
    }
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n")


def bump(key: str) -> None:
    with _stats_lock:
        _stats[key] += 1


def stats_snapshot() -> dict:
    with _stats_lock:
        return dict(_stats)


def response_has_rate_limit(payload) -> bool:
    items = payload if isinstance(payload, list) else [payload]
    for item in items:
        if not isinstance(item, dict):
            continue
        error = item.get("error")
        if not isinstance(error, dict):
            continue
        code = error.get("code")
        message = str(error.get("message", "")).lower()
        if code in (-32097, -32005, 429) or "rate limit" in message or "too many" in message:
            return True
    return False


def method_summary(payload) -> list[str]:
    items = payload if isinstance(payload, list) else [payload]
    methods = []
    for item in items:
        if isinstance(item, dict):
            methods.append(str(item.get("method", "<missing>")))
    return methods[:32]


def retry_delay(attempt: int, retry_after: str | None = None) -> float:
    if retry_after:
        try:
            return min(30.0, max(0.25, float(retry_after)))
        except ValueError:
            pass
    return min(8.0, 0.5 * (2 ** max(0, attempt - 1)))


def forward(raw: bytes, payload):
    global _last_request_at

    last_error: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        retry_after = None
        try:
            with _lock:
                elapsed = time.monotonic() - _last_request_at
                if elapsed < MIN_INTERVAL_SECONDS:
                    time.sleep(MIN_INTERVAL_SECONDS - elapsed)

                bump("upstream_attempts")
                request = urllib.request.Request(
                    UPSTREAM_URL,
                    data=raw,
                    headers={
                        "content-type": "application/json",
                        "accept": "application/json",
                        "user-agent": "nqc-t39-foundry-rpc-throttle/1",
                    },
                    method="POST",
                )
                try:
                    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                        body = response.read()
                        status = response.status
                        retry_after = response.headers.get("Retry-After")
                finally:
                    _last_request_at = time.monotonic()

            parsed = json.loads(body)
            if response_has_rate_limit(parsed):
                bump("rpc_rate_limits")
                if attempt == MAX_ATTEMPTS:
                    raise RuntimeError("JSON-RPC rate limit persisted through retry budget")
                bump("retries")
                delay = retry_delay(attempt, retry_after)
                log({
                    "event": "retry_rpc_rate_limit",
                    "attempt": attempt,
                    "delay_seconds": delay,
                    "methods": method_summary(payload),
                })
                time.sleep(delay)
                continue

            log({
                "event": "upstream_success",
                "attempt": attempt,
                "http_status": status,
                "methods": method_summary(payload),
            })
            return body

        except urllib.error.HTTPError as exc:
            last_error = exc
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            body = exc.read()
            if exc.code == 429:
                bump("http_429")
            if 500 <= exc.code <= 599:
                bump("http_5xx")
            retryable = exc.code == 429 or 500 <= exc.code <= 599
            log({
                "event": "http_error",
                "attempt": attempt,
                "status": exc.code,
                "retryable": retryable,
                "methods": method_summary(payload),
                "body_excerpt": body.decode("utf-8", "replace")[:512],
            })
            if not retryable or attempt == MAX_ATTEMPTS:
                raise
            bump("retries")
            time.sleep(retry_delay(attempt, retry_after))

        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            last_error = exc
            log({
                "event": "transport_error",
                "attempt": attempt,
                "error": f"{type(exc).__name__}: {exc}",
                "methods": method_summary(payload),
            })
            if attempt == MAX_ATTEMPTS:
                raise
            bump("retries")
            time.sleep(retry_delay(attempt))

    raise RuntimeError(f"upstream retry budget exhausted: {last_error}")


class Handler(BaseHTTPRequestHandler):
    server_version = "NqcPftRpcThrottle/1"

    def log_message(self, format, *args):
        return

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(
                200,
                {
                    "status": "READY",
                    "upstream_id": UPSTREAM_ID,
                    "stats": stats_snapshot(),
                },
            )
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        bump("requests")
        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > 16 * 1024 * 1024:
                raise ValueError("invalid content length")
            raw = self.rfile.read(length)
            payload = json.loads(raw)
            body = forward(raw, payload)
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            bump("failures")
            log({
                "event": "proxy_failure",
                "error": f"{type(exc).__name__}: {exc}",
            })
            self._json(
                502,
                {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {
                        "code": -32099,
                        "message": f"rate-controlled upstream failure: {type(exc).__name__}: {exc}",
                    },
                },
            )


if __name__ == "__main__":
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    log({
        "event": "proxy_start",
        "host": HOST,
        "port": PORT,
        "min_interval_seconds": MIN_INTERVAL_SECONDS,
        "max_attempts": MAX_ATTEMPTS,
    })
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(
        json.dumps(
            {
                "status": "READY",
                "host": HOST,
                "port": PORT,
                "upstream_id": UPSTREAM_ID,
                "min_interval_seconds": MIN_INTERVAL_SECONDS,
                "max_attempts": MAX_ATTEMPTS,
            },
            sort_keys=True,
        ),
        flush=True,
    )
    try:
        server.serve_forever()
    finally:
        log({"event": "proxy_stop", "stats": stats_snapshot()})
        server.server_close()
