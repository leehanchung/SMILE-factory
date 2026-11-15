"""Compatibility layer for the recovered Silico web client, backed by real runs.

Wire contracts are documented in docs/hosted-frontend.md. No canned model
responses live here: planner text, tool results, proposals and files come from
the executor and its durable database.
"""

import json
import re
import threading
import time
from urllib.parse import parse_qs, quote, unquote, urlsplit
import uuid

from .store import now

MODEL = "codex-default"
PLANNER_INSTRUCTIONS = """You are the planner in a local research application.
Answer the user's actual question using evidence and tools where needed. Never
invent execution, sources, measurements, or successful results. Your working
directory is an isolated persistent research thread. Uploaded inputs are in it.
For substantive experiments or coding tasks, first write research-plan.json
with exactly these fields: title (string), body (detailed Markdown instructions
for an independent worker, including validation), check_in_steps (array),
max_gpus (0 for local CPU). Do not execute the proposed experiment yourself:
the UI will launch a separate worker after approval (or automatically when
Auto-research is enabled). Explain the plan in your reply. For simple questions
or follow-up interpretation, answer directly without proposing an experiment.
Never commit/push/publish, install packages, change credentials, or run destructive
commands unless specifically requested. Prefer a bounded CPU-only proof first.
"""


class HostedAPI:
    def __init__(self, store, runner):
        self.store, self.runner = store, runner
        self.lock = threading.RLock()
        self.closed = threading.Event()
        if not store.list_workspaces():
            store.create_workspace("Local research")
        with store.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS hosted_meta (
                    session TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
                    data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS hosted_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                    source TEXT NOT NULL, data TEXT NOT NULL,
                    UNIQUE(session,source));
                CREATE TABLE IF NOT EXISTS hosted_seen (
                    session TEXT PRIMARY KEY, seen_at TEXT NOT NULL);
            """)
        from .experiments import ExperimentService
        self.experiments = ExperimentService(self)
        from .sources import SourceService
        self.sources = SourceService(self)
        from .settings import Service as SettingsService
        self.settings = SettingsService(self)
        from .thread_features import Service as ThreadService
        self.thread_features = ThreadService(self, dispatch=False)
        from .forks import ForkService
        self.forks = ForkService(self)
        runner.on_run_finished = self.on_finish
        self.thread_features.start()

    def close(self):
        self.closed.set()
        self.thread_features.close()

    def get_meta(self, session):
        with self.store.connect() as db:
            row = db.execute("SELECT data FROM hosted_meta WHERE session=?", (session,)).fetchone()
        return json.loads(row[0]) if row else {}

    def set_meta(self, session, **fields):
        with self.lock, self.store.connect() as db:
            row = db.execute("SELECT data FROM hosted_meta WHERE session=?", (session,)).fetchone()
            data = json.loads(row[0]) if row else {}
            data.update(fields)
            db.execute("INSERT INTO hosted_meta VALUES (?,?) ON CONFLICT(session) DO UPDATE SET data=excluded.data", (session, json.dumps(data)))
        return data

    def emit(self, session, key, event):
        event = {"timestamp": now(), **event}
        with self.store.connect() as db:
            db.execute("INSERT OR IGNORE INTO hosted_events(session,source,data) VALUES (?,?,?)", (session, key, json.dumps(event)))

    def render_text(self, session, value):
        if not isinstance(value, str):
            return json.dumps(value)
        paths = {}
        for item in self.store.list_files(session):
            try:
                actual = self.store.file_path(session, item["path"])
                if not actual.is_file():
                    continue
            except (OSError, ValueError):
                continue
            url = "/api/feed/file?path=" + quote(self.experiments.virtual_path(item), safe="")
            paths[item["path"]] = url
            paths[str(actual)] = url
        def replace(match):
            destination = match[2]
            clean = re.sub(r":\d+(?::\d+)?$", "", destination)
            return "[" + match[1] + "](" + paths.get(clean, destination) + ")"
        return re.sub(r"\[([^\]]+)\]\(([^)]+)\)", replace, value)

    def start_session(self, workspace, prompt, title, session_id=None, kind="planner", **options):
        with self.thread_features.lock:
            return self._start_session(workspace, prompt, title, session_id, kind, **options)

    def _start_session(self, workspace, prompt, title, session_id=None, kind="planner", **options):
        session = session_id or "th_" + uuid.uuid4().hex[:26]
        existing = self.store.get_thread(session)
        if existing and existing["workspace_id"] != workspace:
            raise ValueError("Session does not belong to this workspace")
        client_id = options.get("client_message_id")
        if existing and client_id:
            queued = self.store._one("SELECT body FROM hosted_queue WHERE session=? AND client_id=?", (session, client_id))
            if queued:
                result = self.thread_features.send(session, {**options, "message": prompt})
                if not result["ok"]:
                    raise ValueError(result.get("error") or "The original request did not start")
                return session
        if not existing:
            self.store.create_thread(workspace, title or "New research", planner_model=options.get("model", MODEL), thread_id=session)
        elif prompt:
            self.store.update_thread(session, title=title or prompt[:80])
        if options.get("role_models"):
            roles = options["role_models"]
            self.store.update_thread(session, **{role + "_model": roles[role] for role in ("planner", "worker") if roles.get(role)})
        self.set_meta(session, kind=kind, auto_accept=bool(options.get("auto_accept", False)), private=bool(options.get("private", False)), role_models=options.get("role_models", {}))
        if prompt:
            result = self.thread_features.send(session, {**options, "message": prompt})
            if not result["ok"]:
                raise ValueError(result.get("error") or "The research request did not start")
        return session

    def send(self, session, prompt, client_id=None, context=None):
        with self.lock:
            return self._send(session, prompt, client_id, context)

    def _send(self, session, prompt, client_id=None, context=None):
        thread = self.store.get_thread(session)
        if not thread:
            raise ValueError("Thread not found")
        meta = self.get_meta(session)
        display_prompt = prompt
        context_text = self.sources.prepare_inputs(session, {**(context or {}), "message": prompt})
        if context_text:
            prompt += "\n\n" + context_text
        if not thread.get("provider_thread_id"):
            fork_context = self.forks.context(session)
            if fork_context:
                prompt += "\n\n" + fork_context
        model = thread["planner_model"]
        from .experiments import WORKER_INSTRUCTIONS
        worker = meta.get("kind") == "worker"
        run = self.runner.start(session, prompt, model="" if model == MODEL else model,
                                auto_research=True if worker else meta.get("auto_accept", False), instructions=(WORKER_INSTRUCTIONS if worker else PLANNER_INSTRUCTIONS) + "\n\n" + self.settings.instructions())
        if client_id:
            self.set_meta(session, **{"client:" + run["id"]: client_id})
        self.set_meta(session, **{"display:" + run["id"]: display_prompt})
        self.sync(session)
        return run

    def sync(self, session):
        """Project each real event exactly once; preserve durable replay order."""
        with self.lock:
            meta = self.get_meta(session)
            for run in self.store.list_runs(session):
                for message in self.store.list_messages(session):
                    if message["role"] == "user" and message["run_id"] == run["id"]:
                        self.emit(session, "message:" + message["id"], {"type": "user_text", "text": meta.get("display:" + run["id"], message["content"]), "turn_id": run["id"], "client_message_id": meta.get("client:" + run["id"]), "timestamp": message["created_at"]})
                cursor, has_text = 0, False
                while True:
                    rows = self.store.list_events(run["id"], after=cursor, limit=1000)
                    if not rows:
                        break
                    for row in rows:
                        cursor = row["id"]
                        native = row["payload"]
                        item = native.get("item", {})
                        kind = native.get("type", row["kind"])
                        event = None
                        key = "provider:" + str(row["id"])
                        if kind == "item.completed" and item.get("type") == "agent_message":
                            has_text = True
                            event = {"type": "text", "text": self.render_text(session, item.get("text", "")), "turn_id": run["id"]}
                        elif kind in ("item.started", "item.completed") and item.get("type") in ("command_execution", "mcp_tool_call", "web_search", "file_change"):
                            item_id = run["id"] + ":" + item.get("id", str(row["id"]))
                            tool = {"command_execution": "Bash", "web_search": "WebSearch", "file_change": "Edit"}.get(item.get("type"), item.get("tool", "Tool"))
                            tool_input = {"command": item["command"]} if "command" in item else {k: v for k, v in item.items() if k not in ("aggregated_output", "result")}
                            self.emit(session, "tool:start:" + item_id, {"type": "tool_use", "tool": tool, "tool_use_id": item_id, "input": tool_input, "turn_id": run["id"]})
                            if kind == "item.completed":
                                event = {"type": "tool_result", "tool_use_id": item_id, "output": item.get("aggregated_output", item.get("result", json.dumps(item))), "is_error": item.get("status") == "failed" or item.get("exit_code", 0) not in (0, None), "turn_id": run["id"]}
                        if event:
                            self.emit(session, key, {"timestamp": row["created_at"], **event})
                    if len(rows) < 1000:
                        break
                if run["status"] in ("completed", "failed", "cancelled", "interrupted"):
                    if run.get("final_text") and not has_text:
                        self.emit(session, "final:" + run["id"], {"type": "text", "text": self.render_text(session, run["final_text"]), "turn_id": run["id"]})
                    if run.get("error"):
                        self.emit(session, "error:" + run["id"], {"type": "text", "text": "Execution failed: " + run["error"], "turn_id": run["id"]})

    def on_finish(self, run):
        with self.thread_features.lock:
            self._on_finish(run)

    def _on_finish(self, run):
        session = run["thread_id"]
        self.sync(session)
        self.experiments.on_finish(run)
        if run["status"] != "completed" or self.get_meta(session).get("kind") != "planner":
            return
        try:
            with self.store.open_file(session, "research-plan.json") as stream:
                raw = stream.read(100001)
            if len(raw) > 100000:
                raise ValueError("Generated plan exceeds 100 KB")
            plan = json.loads(raw)
            if not isinstance(plan, dict) or not isinstance(plan.get("title"), str) or not isinstance(plan.get("body"), str):
                raise ValueError("Generated plan needs string title and body")
        except FileNotFoundError:
            return
        except (ValueError, OSError) as error:
            self.emit(session, "plan-error:" + run["id"], {"type": "text", "text": "Could not load the generated research plan: " + str(error)})
            return
        import hashlib
        digest = hashlib.sha256(raw).hexdigest()
        if self.get_meta(session).get("last_plan_digest") == digest:
            return
        plan = {"plan_id": "plan_" + run["id"], "title": plan["title"], "body": plan["body"], "file_path": "research-plan.json", "kind": "experiment", "check_in_steps": plan.get("check_in_steps"), "max_gpus": plan.get("max_gpus", 0)}
        self.set_meta(session, plan=plan, plan_phase="review", last_plan_digest=digest)
        self.emit(session, plan["plan_id"], {"type": "plan_ready", "plan_id": plan["plan_id"], "title": plan["title"], "plan": plan["body"], "plan_file_path": plan["file_path"], "kind": "experiment"})
        # The durable dispatcher launches auto-accepted plans after this run's
        # completion callback releases its executor reservation. This prevents
        # two simultaneous planner completions from exhausting worker capacity.

    def snapshot(self, session, offset=0):
        thread = self.store.get_thread(session)
        if not thread:
            raise ValueError("Thread not found")
        self.sync(session)
        with self.store.connect() as db:
            rows = db.execute("SELECT data FROM hosted_events WHERE session=? ORDER BY id", (session,)).fetchall()
        meta = self.get_meta(session)
        busy = any(r["status"] in ("queued", "running") for r in self.store.list_runs(session))
        states = self.experiments.states(session)
        events = [json.loads(r[0]) for r in rows[max(0, offset):]]
        for event in events:
            if event.get("type") in ("text", "text_snapshot", "text_delta"):
                exp = self.experiments.get(event.get("experiment_eid")) if event.get("experiment_eid") else None
                event["text"] = self.render_text(exp["worker"] if exp else session, event.get("text", ""))
        return {"ok": True, "mode": "live", "events": events, "offset": len(rows), "durable_cursor": len(rows), "busy": busy, "has_pending_question": False,
                "inflight_subagents": sum(s["worker_alive"] for s in states.values()), "inflight_workflows": 0, "plan": meta.get("plan"), "plan_phase": meta.get("plan_phase"),
                "auto_accept_deadline": None, "auto_accept_paused": False, "auto_continue_deadline": None, "warning": None,
                "provider": "codex", "model": thread["planner_model"] or MODEL, "experiment_states": states}

    def stream(self, h, session, offset=0):
        h.send_response(200)
        h.send_header("Content-Type", "text/event-stream; charset=utf-8")
        h.send_header("Cache-Control", "no-cache")
        h.send_header("Connection", "close")
        h.end_headers()
        deadline = time.monotonic() + 25
        try:
            while time.monotonic() < deadline and not self.closed.is_set():
                snapshot = self.snapshot(session, offset)
                for event in snapshot.pop("events"):
                    h.wfile.write(f"event: event\nid: {offset}\ndata: {json.dumps(event)}\n\n".encode())
                    offset += 1
                h.wfile.write(f"event: state\ndata: {json.dumps(snapshot)}\n\n".encode())
                h.wfile.flush()
                self.closed.wait(.3 if snapshot["busy"] else 2)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        h.close_connection = True

    def thread_row(self, thread):
        session = thread["id"]
        meta = self.get_meta(session)
        busy = any(r["status"] in ("queued", "running") for r in self.store.list_runs(session))
        experiments = [e for e in self.experiments.rows(thread["workspace_id"]) if e["thread_id"] == session]
        return {"session": session, "session_uuid": session, "session_id": session, "workspace_id": thread["workspace_id"], "project": thread["workspace_id"],
                "label": thread["title"], "created_at": thread["created_at"], "last_activity_at": thread["updated_at"], "last_user_message_at": thread["updated_at"],
                "has_pending_question": False, "awaiting_input": bool(meta.get("plan")), "busy": busy, "running": busy,
                "status": "archived" if meta.get("archived") else "active", "archived": bool(meta.get("archived")), "private": bool(meta.get("private")),
                "experiments": experiments, "next_thread_label": max((e["display_label"] for e in experiments), default=0) + 1, "can_write": True, "can_delete": not busy, "folder_id": thread["folder_id"],
                "pinned": meta.get("pinned", False), "pin_rank": meta.get("pin_rank", 0), "unread": False, "provider": "codex", "model": thread["planner_model"] or MODEL}

    def workspace_rows(self):
        return [{**w, "workspace_id": w["id"], "display_name": w["name"], **self.settings.workspace_meta(w["id"]), "organization_id": "local", "can_write": True} for w in self.store.list_workspaces()]

    def folder_rows(self):
        return [{**w, "folder_id": w["workspace_id"], "owner_user_id": "local:dev", "owned": True,
                 "shared": False, "org_shared": False, "is_default": index == 0}
                for index, w in enumerate(self.workspace_rows())]

    def route(self, h, method, path, body):
        body = body if isinstance(body, dict) else {}
        query = parse_qs(urlsplit(h.path).query)
        path = unquote(path)
        if method == "DELETE" and (delete_match := re.fullmatch(r"/api/threads/([^/]+)", path)):
            thread = self.store.get_thread(delete_match[1])
            if not thread:
                h.json(404, {"error": "Thread not found"})
                return True
            path = "/api/workspaces/" + thread["workspace_id"] + "/threads/" + thread["id"]
        q = lambda key, default="": query.get(key, [default])[0]
        reply = lambda data, status=200: h.json(status, data)
        if self.forks.route(h, method, path, body):
            return True
        if self.settings.route(h, method, path, body):
            return True
        if self.thread_features.route(h, method, path, body):
            return True
        if self.experiments.route(h, method, path, body):
            return True
        if self.sources.route(h, method, path, body):
            return True
        if method == "GET" and path == "/api/config":
            reply({"local_dev": True, "artifact_store_configured": True, "reporting_enabled": True, "zero_data_retention": False, "cluster_id": "rea-astra-local", "deployment_id": "rea-astra-local", "lab_login": "dev", "sentry_dsn": None, "sentry_environment": "local"})
        elif method == "GET" and path == "/api/auth/config":
            reply({"auth_required": False, "auth_url": "", "auth_origins": [], "tenant_id": "local", "pinned_login": None, "user_id": "local:dev", "username": "dev", "avatar_url": ""})
        elif method == "GET" and path == "/api/feature-flags":
            models = [{"value": MODEL, "label": "Codex · configured model", "provider": "codex"}]
            reply({"flags": {}, "capabilities": {}, "providers": {"codex": True, "claude": False, "modal": False, "byo-model": False}, "models": models, "default_model": MODEL, "roles": ["planner", "worker"], "role_models": models, "role_defaults": {"planner": MODEL, "worker": MODEL}})
        elif path == "/api/feed/session" and method == "POST":
            reply({"ok": True})
        elif path == "/api/orgs" and method == "GET":
            reply({"orgs_active": True, "orgs": [{"organization_id": "local", "name": self.settings.org_name(), "role": "owner"}]})
        elif path == "/api/workspaces" and method == "GET":
            reply({"workspaces": self.workspace_rows()})
        elif path == "/api/workspaces" and method == "POST":
            item = self.store.create_workspace(body.get("name", "Research workspace"))
            reply({"ok": True, **item, "workspace_id": item["id"]})
        elif re.fullmatch(r"/api/workspaces/[^/]+", path) and method == "GET":
            rows = [w for w in self.workspace_rows() if w["workspace_id"] == path.split("/")[-1]]
            reply(rows[0] if rows else {"error": "Workspace not found"}, 200 if rows else 404)
        elif path == "/api/skills" and method == "GET":
            reply({"display_names": {}, "skills": []})
        elif re.fullmatch(r"/api/orgs/[^/]+/sidebar", path) and method == "GET":
            folders = self.folder_rows()
            rows = [self.thread_row(t) for t in self.store.list_threads() if self.get_meta(t["id"]).get("kind", "planner") == "planner"]
            reply({"folders": folders, "threads": rows, "folder_threads": {f["id"]: [t for t in rows if t["workspace_id"] == f["id"] and not t["archived"]] for f in folders}, "folder_archived_threads": {f["id"]: [t for t in rows if t["workspace_id"] == f["id"] and t["archived"]] for f in folders}, "folder_publications": {}})
        elif re.fullmatch(r"/api/orgs/[^/]+/folders", path) and method == "GET":
            reply({"folders": self.folder_rows()})
        elif re.fullmatch(r"/api/orgs/[^/]+/folders", path) and method == "POST":
            folder = self.store.create_workspace(body.get("name", "New folder"))
            reply({"ok": True, **folder, "folder_id": folder["id"], "workspace_id": folder["id"]})
        elif path == "/api/plan/sessions" and method == "GET":
            reply([self.thread_row(t) for t in self.store.list_threads() if self.get_meta(t["id"]).get("kind", "planner") == "planner"])
        elif (match := re.fullmatch(r"/api/workspaces/([^/]+)/plan/(start|reserve-thread)", path)) and method == "POST":
            title = body.get("label") or body.get("message", "New research")[:80]
            session = self.start_session(match[1], body.get("message", "") if match[2] == "start" else "", title,
                                         session_id=body.get("session_uuid"), **{k: v for k, v in body.items() if k in ("model", "role_models", "auto_accept", "private", "client_message_id", "context_refs", "base_repo", "base_ref")})
            reply({"ok": True, "session_uuid": session, "session_id": session, "provider": "codex", "model": MODEL})
        elif path in ("/api/plan/send", "/api/plan/review-message") and method == "POST":
            run = self.send(body.get("session"), body.get("message", ""), body.get("client_message_id"), body)
            reply({"ok": True, "run_id": run["id"]})
        elif path == "/api/plan/stream" and method == "GET":
            self.stream(h, q("session"), int(q("offset", "0")))
        elif (match := re.fullmatch(r"/api/agent/([^/]+)/stream", path)) and method == "GET":
            self.stream(h, match[1], int(q("offset", "0")))
        elif path in ("/api/plan/poll", "/api/plan/thread-snapshot", "/api/plan/resume", "/api/plan/transcript", "/api/plan/events", "/api/plan/session-info"):
            session = body.get("session") or q("session")
            snapshot = self.snapshot(session, int(q("offset", "0")))
            if path.endswith("/resume"):
                reply({"ok": True, "mode": "live", "provider": "codex", "model": snapshot["model"], "snapshot": snapshot if body.get("include_snapshot", True) else None, "experiment_states": snapshot["experiment_states"]})
            elif path.endswith("/transcript"):
                reply({**snapshot, "next_offset": snapshot["offset"]})
            else:
                reply(snapshot)
        elif path == "/api/plan/interrupt" and method == "POST":
            for run in self.store.list_runs(body["session"]):
                if run["status"] in ("queued", "running"):
                    self.runner.cancel(run["id"])
            reply({"ok": True})
        elif path in ("/api/plan/seen", "/api/plan/seen-bulk", "/api/plan/resync") and method == "POST":
            sessions = body.get("sessions", [body.get("session")])
            with self.store.connect() as db:
                for session in sessions:
                    if session:
                        db.execute("INSERT OR REPLACE INTO hosted_seen VALUES (?,?)", (session, now()))
            reply({"ok": True})
        elif (match := re.fullmatch(r"/api/workspaces/([^/]+)/threads", path)) and method == "GET":
            reply({"ok": True, "threads": [self.thread_row(t) for t in self.store.list_threads(match[1]) if self.get_meta(t["id"]).get("kind", "planner") == "planner"]})
        elif (match := re.fullmatch(r"/api/workspaces/([^/]+)/threads/([^/]+)(?:/([^/]+))?", path)):
            ws, session, action = match.groups()
            thread = self.store.get_thread(session)
            if not thread or thread["workspace_id"] != ws:
                reply({"ok": False, "error": "Thread not found"}, 404)
            elif method == "DELETE" and action is None:
                with self.thread_features.lock:
                    children = self.store._all("SELECT worker FROM hosted_experiments WHERE parent=? AND deleted=0", (session,))
                    sessions = [session] + [row["worker"] for row in children]
                    if any(self.runner.is_active(item) or any(r["status"] in ("queued", "running") for r in self.store.list_runs(item)) for item in sessions):
                        raise ValueError("Stop running research before deleting this thread")
                    self.store.delete_thread(session)
                    with self.store.connect() as db:
                        db.execute("UPDATE hosted_experiments SET deleted=1 WHERE parent=?", (session,))
                reply({"ok": True})
            elif action == "rename" and method == "POST":
                self.store.update_thread(session, title=body["label"])
                reply({"ok": True})
            elif action == "model":
                if method == "POST":
                    role = body.get("role", "planner")
                    self.store.update_thread(session, **{role + "_model": body.get("model") or MODEL})
                thread = self.store.get_thread(session)
                models = {"planner": thread["planner_model"] or MODEL, "worker": thread["worker_model"] or MODEL}
                reply({"ok": True, "model": models["planner"], "provider": "codex", "role_models": models, "effective_role_models": models})
            elif action == "auto-accept":
                if method == "POST":
                    self.set_meta(session, auto_accept=bool(body.get("enabled")))
                enabled = self.get_meta(session).get("auto_accept", False)
                reply({"ok": True, "enabled": enabled, "auto_accept": enabled})
            elif action == "archive" and method == "POST":
                self.set_meta(session, archived=bool(body.get("archived")))
                reply({"ok": True})
            elif action == "folder":
                if method == "POST":
                    self.store.update_thread(session, folder_id=body.get("folder_id"))
                reply({"ok": True, "folder_id": self.store.get_thread(session)["folder_id"]})
            elif action == "transcript":
                snapshot = self.snapshot(session, int(q("since", "0")))
                reply({**snapshot, "next_offset": snapshot["offset"]})
            elif action in ("story", "story-notes"):
                reply({"ok": True, "entries": [], "notes": [], "summary": ""})
            else:
                return False
        else:
            return False
        return True
