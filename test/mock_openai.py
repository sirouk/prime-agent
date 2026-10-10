"""An OpenAI-compatible stand-in for the tests.

GET /v1/models lists the configured models (or a full catalog); GET /v1/status returns
the configured status, like an Unsloth server, or 404 without one; POST
/v1/chat/completions streams a fixed reply; GET /moved/v1/models redirects to
`redirect_to`. With a key, everything answers 401 unless "Authorization: Bearer <key>"
is sent. Every request is recorded.

As a program: python3 mock_openai.py <log file> [--models a,b | --catalog file] [--key secret] [--status json]
It appends each request to the log file as a JSON line and prints the port it listens on.
"""

from __future__ import annotations

import argparse
import json
import socketserver
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional


class QuickBindServer(ThreadingHTTPServer):
    """HTTPServer.server_bind does a reverse DNS lookup of the address, which can take half a minute."""

    def server_bind(self) -> None:
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


def chunk(choices: List[Dict[str, Any]], **extra: Any) -> bytes:
    body = {"id": "mock", "object": "chat.completion.chunk", "created": 0, "model": "mock", "choices": choices, **extra}
    return f"data: {json.dumps(body)}\n\n".encode()


class MockServer:
    def __init__(
        self,
        models: List[str] = (),  # type: ignore[assignment]
        key: Optional[str] = None,
        status: Optional[Dict[str, Any]] = None,
        catalog: Optional[List[Dict[str, Any]]] = None,
        redirect_to: Optional[str] = None,
        files: Optional[Dict[str, bytes]] = None,
        on_request: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> None:
        self.requests: List[Dict[str, Any]] = []
        outer = self
        data = catalog if catalog is not None else [{"id": m, "object": "model", "max_model_len": 32768} for m in models]

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:
                pass

            def respond(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length).decode() if length else ""
                record = {
                    "method": self.command,
                    "url": self.path,
                    "authorization": self.headers.get("Authorization"),
                    "body": json.loads(raw) if raw else None,
                }
                outer.requests.append(record)
                if on_request:
                    on_request(record)
                if self.path.startswith("/moved/") and redirect_to:
                    self.send_response(302)
                    self.send_header("Location", redirect_to + self.path[len("/moved") :])
                    self.end_headers()
                elif key and self.headers.get("Authorization") != f"Bearer {key}":
                    self.send_json(401, {"error": "invalid api key"})
                elif self.command == "GET" and files and self.path in files:
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(files[self.path])))
                    self.end_headers()
                    self.wfile.write(files[self.path])
                elif self.command == "GET" and self.path.endswith("/v1/status") and status is not None:
                    self.send_json(200, status)
                elif self.command == "GET" and self.path.endswith("/v1/models"):
                    self.send_json(200, {"object": "list", "data": data})
                elif self.command == "POST" and self.path == "/v1/chat/completions":
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    for part in (
                        chunk([{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}]),
                        chunk([{"index": 0, "delta": {"content": "pong from mock"}, "finish_reason": None}]),
                        chunk([{"index": 0, "delta": {}, "finish_reason": "stop"}]),
                        chunk([], usage={"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}),
                        b"data: [DONE]\n\n",
                    ):
                        self.wfile.write(part)
                else:
                    self.send_response(404)
                    self.end_headers()

            def send_json(self, code: int, body: Any) -> None:
                payload = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = do_POST = respond

        self.server = QuickBindServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.base_url = f"http://127.0.0.1:{self.port}/v1"
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)

    def start(self) -> "MockServer":
        self.thread.start()
        return self

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("log")
    parser.add_argument("--models", default="")
    parser.add_argument("--catalog", help="a JSON file with the list of model entries to serve")
    parser.add_argument("--key")
    parser.add_argument("--status")
    args = parser.parse_args()

    def log(record: Dict[str, Any]) -> None:
        with open(args.log, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record) + "\n")

    server = MockServer(
        models=[m for m in args.models.split(",") if m],
        catalog=json.load(open(args.catalog, encoding="utf-8")) if args.catalog else None,
        key=args.key,
        status=json.loads(args.status) if args.status else None,
        on_request=log,
    )
    print(server.port, flush=True)
    sys.stdout.close()
    server.server.serve_forever(poll_interval=0.05)


if __name__ == "__main__":
    main()
