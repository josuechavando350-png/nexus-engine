#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import socketserver
import sys
import urllib.request
from pathlib import Path

SOCKET_PATH = Path(os.environ["NQC_PFT_IPC_SOCKET"])
UPSTREAM_URL = os.environ["NQC_PFT_UPSTREAM_URL"]
UPSTREAM_ID = os.environ["NQC_PFT_UPSTREAM_ID"]
TIMEOUT = 30
DECODER = json.JSONDecoder()


def forward(payload):
    body = json.dumps(payload, separators=(",", ":")).encode()
    request = urllib.request.Request(
        UPSTREAM_URL,
        data=body,
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "user-agent": "nqc-t39-ipc-http-bridge/1",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        raw = response.read()
    parsed = json.loads(raw)
    return parsed


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        buffer = ""
        while True:
            chunk = self.request.recv(65536)
            if not chunk:
                return
            buffer += chunk.decode()
            while True:
                stripped = buffer.lstrip()
                if not stripped:
                    buffer = ""
                    break
                skipped = len(buffer) - len(stripped)
                try:
                    payload, end = DECODER.raw_decode(stripped)
                except json.JSONDecodeError:
                    break
                buffer = stripped[end:]
                try:
                    response = forward(payload)
                except Exception as exc:
                    request_id = payload.get("id") if isinstance(payload, dict) else None
                    response = {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {
                            "code": -32099,
                            "message": f"bridge upstream failure: {type(exc).__name__}: {exc}",
                        },
                    }
                encoded = json.dumps(response, separators=(",", ":")).encode() + b"\n"
                self.request.sendall(encoded)


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


if SOCKET_PATH.exists():
    SOCKET_PATH.unlink()
SOCKET_PATH.parent.mkdir(parents=True, exist_ok=True)

with Server(str(SOCKET_PATH), Handler) as server:
    print(
        json.dumps(
            {
                "status": "READY",
                "upstream_id": UPSTREAM_ID,
                "socket_path": str(SOCKET_PATH),
            },
            sort_keys=True,
        ),
        flush=True,
    )
    server.serve_forever()
