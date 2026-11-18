"""Loopback-only HTTP API, SSE replay, and confined research artifacts."""

import argparse
import json
import os
import secrets
import sqlite3
import sys
import time
import traceback
import uuid
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

from .runner import RunManager, provider_status, redact
from .store import TERMINAL, Store

MAX_BODY = 20 * 1024 * 1024


class ResearchHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def make_handler(store, runner, static_root, extra_route=None):
    root = Path(static_root).resolve()
    mutation_token = secrets.token_urlsafe(32)

    class Handler(SimpleHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def __init__(self, *args, **kwargs):
            self.store = store
            self.runner = runner
            self.body_bytes = b""
            self.body = {}
            self.query = {}
            super().__init__(*args, directory=str(root), **kwargs)

        def log_message(self, fmt, *args):
            # Paths may contain sensitive user queries; do not log request lines.
            pass

        def _allowed_hosts(self):
            port = self.server.server_port
            return {f"127.0.0.1:{port}", f"localhost:{port}"}

        def _guard(self, mutation=False):
            if self.headers.get("Host", "") not in self._allowed_hosts():
                self.json(403, {"error": "Invalid local Host header"})
                return False
            origin = self.headers.get("Origin")
            allowed = {f"http://{host}" for host in self._allowed_hosts()}
            if origin and origin not in allowed:
                self.json(403, {"error": "Cross-origin access denied"})
                return False
            if mutation and origin not in allowed and not secrets.compare_digest(self.headers.get("X-Rea-Token", ""), mutation_token):
                self.json(403, {"error": "Same-origin request or X-Rea-Token required"})
                return False
            return True

        def end_headers(self):
            self.send_header("Content-Security-Policy", getattr(self, "response_csp", None) or "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def json(self, status, data):
            encoded = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(encoded)

        def read_json(self):
            return self.body

        def parse_multipart(self):
            content_type = self.headers.get("Content-Type", "")
            if "\r" in content_type or "\n" in content_type or not content_type.lower().startswith("multipart/form-data"):
                raise ValueError("multipart/form-data content type required")
            message = BytesParser(policy=email_policy).parsebytes(b"Content-Type: " + content_type.encode("ascii", errors="strict") + b"\r\nMIME-Version: 1.0\r\n\r\n" + self.body_bytes)
            if not message.is_multipart() or message.defects:
                raise ValueError("Invalid multipart body or boundary")
            fields, files = {}, []
            for index, part in enumerate(message.iter_parts()):
                if index >= 100 or part.is_multipart():
                    raise ValueError("Too many multipart parts or unsupported nested multipart")
                name = part.get_param("name", header="content-disposition")
                if part.get_content_disposition() != "form-data" or not isinstance(name, str) or len(name) > 200:
                    raise ValueError("Invalid multipart field name")
                data = part.get_payload(decode=True)
                if not isinstance(data, bytes):
                    raise ValueError("Invalid multipart payload")
                filename = part.get_filename()
                if filename is None:
                    if len(data) > 100000:
                        raise ValueError("Multipart text field too large")
                    fields[name] = data.decode("utf-8", errors="strict")
                else:
                    files.append({"field": name, "filename": filename, "content_type": part.get_content_type(), "data": data})
            return {"fields": fields, "files": files}

        def _read_body(self):
            if self.headers.get("Transfer-Encoding"):
                raise ValueError("Chunked request bodies are not supported")
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > MAX_BODY:
                raise ValueError("Request body exceeds 20 MiB limit")
            self.connection.settimeout(30)
            self.body_bytes = self.rfile.read(length)
            if len(self.body_bytes) != length:
                raise ValueError("Incomplete request body")
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip()
            if self.body_bytes and content_type == "application/json":
                if length > 1024 * 1024:
                    raise ValueError("JSON body exceeds 1 MiB limit")
                self.body = json.loads(self.body_bytes)
                if not isinstance(self.body, dict):
                    raise ValueError("JSON body must be an object")
            elif not self.body_bytes:
                self.body = {}
            else:
                self.body = {}

        def stream_events(self, run_id, cursor=0):
            if not store.get_run(run_id):
                return self.json(404, {"error": "Run not found"})
            cursor = max(0, int(cursor))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            self.close_connection = True
            last_heartbeat = time.monotonic()
            try:
                while True:
                    events = store.list_events(run_id, after=cursor)
                    for event in events:
                        wire = f"id: {event['id']}\nevent: event\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
                        self.wfile.write(wire.encode())
                        cursor = event["id"]
                    if events:
                        self.wfile.flush()
                    run = store.get_run(run_id)
                    if not run or run["status"] in TERMINAL:
                        # One last query catches the event persisted just after the terminal status.
                        extra = store.list_events(run_id, after=cursor)
                        if extra:
                            for event in extra:
                                self.wfile.write(f"id: {event['id']}\nevent: event\ndata: {json.dumps(event)}\n\n".encode())
                            self.wfile.flush()
                        break
                    if time.monotonic() - last_heartbeat > 10:
                        self.wfile.write(b": heartbeat\n\n")
                        self.wfile.flush()
                        last_heartbeat = time.monotonic()
                    time.sleep(0.2)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass

        def send_artifact(self, item):
            try:
                stream = store.open_file(item["thread_id"], item["path"])
            except (OSError, ValueError):
                return self.json(404, {"error": "Artifact file no longer exists"})
            with stream:
                size = os.fstat(stream.fileno()).st_size
                if size > 100 * 1024 * 1024:
                    return self.json(413, {"error": "Artifact too large"})
                self.send_response(200)
                self.send_header("Content-Type", item["media_type"])
                self.send_header("Content-Length", str(size))
                self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(Path(item["path"]).name, safe=""))
                self.response_csp = "sandbox; default-src 'none'"
                self.end_headers()
                if self.command != "HEAD":
                    while chunk := stream.read(65536):
                        self.wfile.write(chunk)

        def _upload(self, thread_id):
            filename = self.query.get("name", [""])[0]
            if not filename or len(filename) > 200 or filename.startswith(".") or any(char in filename for char in "/\\\x00\r\n"):
                raise ValueError("A plain filename is required in ?name=")
            if not store.get_thread(thread_id):
                return self.json(404, {"error": "Thread not found"})
            relative = "uploads/" + str(uuid.uuid4()) + "-" + filename
            store.write_upload(thread_id, relative, self.body_bytes)
            return self.json(201, store.register_file(thread_id, relative, kind="upload"))

        def _generic(self, method, path, body):
            pieces = [unquote(part) for part in path.split("/") if part]
            if path == "/api/status" and method == "GET":
                return self.json(200, {"mode": "real", "providers": [provider_status(runner.executable)], "mutation_token": mutation_token,
                    "capabilities": {"research": True, "coding": True, "web_search": True, "files": True,
                                     "planner_worker_models": "stored; one model per run", "remote_clusters": False}})
            if path == "/api/workspaces":
                if method == "GET": return self.json(200, {"workspaces": store.list_workspaces()})
                if method == "POST": return self.json(201, store.create_workspace(body.get("name", "Local research")))
            if path == "/api/folders":
                if method == "GET": return self.json(200, {"folders": store.list_folders()})
                if method == "POST": return self.json(201, store.create_folder(body.get("name", "")))
            if path == "/api/threads":
                if method == "GET": return self.json(200, {"threads": store.list_threads(self.query.get("workspace_id", [None])[0])})
                if method == "POST": return self.json(201, store.create_thread(workspace_id=body.get("workspace_id"), title=body.get("title", "New research"), planner_model=body.get("planner_model", ""), worker_model=body.get("worker_model", ""), folder_id=body.get("folder_id")))
            if len(pieces) >= 3 and pieces[:2] == ["api", "threads"]:
                thread_id = pieces[2]
                if len(pieces) == 3:
                    if method == "GET":
                        item = store.thread_detail(thread_id)
                        return self.json(200 if item else 404, item or {"error": "Thread not found"})
                    if method == "PATCH": return self.json(200, store.update_thread(thread_id, **{key: value for key, value in body.items() if key in {"title", "folder_id", "planner_model", "worker_model"}}))
                    if method == "DELETE":
                        if runner.is_active(thread_id):
                            raise ValueError("Cannot delete a running thread or one finalizing its outputs")
                        store.delete_thread(thread_id)
                        return self.json(200, {"ok": True, "workspace_files_retained": True})
                if len(pieces) == 4 and pieces[3] == "messages":
                    if method == "GET": return self.json(200, {"messages": store.list_messages(thread_id)})
                    if method == "POST": return self.json(202, runner.start(thread_id, body.get("message", body.get("prompt", "")), model=body.get("model", ""), auto_research=body.get("auto_research", True), search=body.get("search", True)))
                if len(pieces) == 4 and pieces[3] == "files":
                    if method == "GET": return self.json(200, {"files": store.list_files(thread_id)})
                    if method == "POST": return self._upload(thread_id)
            if len(pieces) >= 3 and pieces[:2] == ["api", "runs"]:
                run_id = pieces[2]
                if len(pieces) == 3 and method == "GET":
                    item = store.get_run(run_id)
                    return self.json(200 if item else 404, item or {"error": "Run not found"})
                if len(pieces) == 4 and pieces[3] == "events" and method == "GET":
                    return self.stream_events(run_id, self.query.get("after", [self.headers.get("Last-Event-ID", "0")])[0])
                if len(pieces) == 4 and pieces[3] == "cancel" and method == "POST":
                    item = runner.cancel(run_id)
                    return self.json(200 if item else 404, item or {"error": "Run not found"})
            if len(pieces) == 3 and pieces[:2] == ["api", "artifacts"] and method in {"GET", "HEAD"}:
                item = store.get_file(pieces[2])
                return self.send_artifact(item) if item else self.json(404, {"error": "Artifact not found"})
            return self.json(404, {"error": "API route not found"})

        def _dispatch(self):
            self.response_csp = None
            self.body, self.body_bytes = {}, b""
            method = self.command
            if not self._guard(method not in {"GET", "HEAD"}):
                self.close_connection = True
                return
            parsed = urlsplit(self.path)
            self.query = parse_qs(parsed.query, keep_blank_values=True)
            try:
                if method not in {"GET", "HEAD"}:
                    self._read_body()
                if extra_route and extra_route(self, method, parsed.path, self.body):
                    return
                if parsed.path.startswith("/api/"):
                    if method not in {"GET", "HEAD"} and self.body_bytes and self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json" and not parsed.path.endswith("/files"):
                        raise ValueError("JSON content type required")
                    return self._generic(method, parsed.path, self.body)
                if method not in {"GET", "HEAD"}:
                    return self.json(405, {"error": "Method not allowed"})
                candidate = Path(self.translate_path(parsed.path)).resolve()
                if not candidate.is_relative_to(root):
                    return self.json(403, {"error": "Outside application directory"})
                if not candidate.exists() and not Path(parsed.path).suffix:
                    self.path = "/index.html"
                return super().do_HEAD() if method == "HEAD" else super().do_GET()
            except (BrokenPipeError, ConnectionResetError):
                pass
            except (ValueError, json.JSONDecodeError) as exc:
                code = 409 if "active" in str(exc) or "capacity" in str(exc) or "running thread" in str(exc) else 400
                self.json(code, {"error": str(exc)})
            except sqlite3.IntegrityError:
                self.json(409, {"error": "Record conflicts with existing state"})
            except Exception:
                print(redact(traceback.format_exc(limit=6)), file=sys.stderr, flush=True)
                self.json(500, {"error": "Backend operation failed"})

        do_GET = _dispatch
        do_HEAD = _dispatch
        do_POST = _dispatch
        do_PATCH = _dispatch
        do_PUT = _dispatch
        do_DELETE = _dispatch

        def list_directory(self, path):
            self.send_error(404, "Directory listing disabled")

    return Handler


def create_server(data_dir, static_root, port=8743, extra_route=None, timeout_seconds=600):
    store = Store(data_dir)
    runner = RunManager(store, timeout_seconds=timeout_seconds)
    server = ResearchHTTPServer(("127.0.0.1", port), make_handler(store, runner, static_root, extra_route))
    server.store, server.runner = store, runner
    return server


def main():
    app_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8743)
    parser.add_argument("--data-dir", type=Path, default=app_root / ".local")
    parser.add_argument("--static-root", type=Path, default=app_root / "preview")
    parser.add_argument("--timeout", type=float, default=600)
    args = parser.parse_args()
    server = create_server(args.data_dir, args.static_root, args.port, timeout_seconds=args.timeout)
    print(f"REA Astra real research backend: http://127.0.0.1:{server.server_port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.runner.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
