"""Local persistence for recovered folder/settings controls.

Hosted credential storage, network-policy controls, and remote provider privacy
settings are explicitly unsupported. This module never reads account files or
claims that changing a local preference changes a provider's account policy.
"""
import json
import re
import threading
import time
import uuid
from contextlib import nullcontext

from .runner import provider_status
from .store import identifier, now

DEFAULT_MODEL = "codex-default"


class Service:
    def __init__(self, hosted, status_reader=None):
        self.hosted, self.store = hosted, hosted.store
        self.status_reader = status_reader or (lambda: provider_status(getattr(hosted.runner, "executable", "codex")))
        self.status_lock = threading.Lock()
        self.cached_status, self.status_time = None, 0
        with self.store.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS local_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")

    def get(self, key, default=None):
        with self.store.connect() as db:
            row = db.execute("SELECT value FROM local_settings WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def put(self, key, value):
        with self.store.connect() as db:
            db.execute("INSERT INTO local_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value)))
        return value

    def workspace_meta(self, workspace):
        return self.get("workspace:" + workspace, {"archived": False, "pinned": False})

    def org_name(self):
        return self.get("org_name", "Local research")

    def model(self):
        return self.get("model", DEFAULT_MODEL)

    def instructions(self):
        return "\n\n".join(text for text in (self.get("instructions:org", ""), self.get("instructions:user", "")) if text)

    def status(self):
        with self.status_lock:
            if self.cached_status is None or time.monotonic() - self.status_time > 30:
                self.cached_status = self.status_reader()
                self.status_time = time.monotonic()
            return dict(self.cached_status)

    def flags(self):
        models = [{"value": DEFAULT_MODEL, "label": "Codex · CLI default", "provider": "codex"}]
        return {"flags": {}, "capabilities": {},
                "providers": {"codex": self.status().get("installed", False), "claude": False, "modal": False, "byo-model": False},
                "models": models, "default_model": self.model(), "roles": ["planner", "worker"],
                "role_models": models, "role_defaults": {"planner": self.model(), "worker": self.model()}}

    def workspace(self, workspace):
        identifier(workspace)
        item = next((w for w in self.store.list_workspaces() if w["id"] == workspace), None)
        if not item:
            raise ValueError("Workspace not found")
        return {**item, "workspace_id": workspace, "display_name": item["name"], **self.workspace_meta(workspace)}

    @staticmethod
    def text(value, label, limit=200):
        if not isinstance(value, str) or not value.strip() or len(value) > limit:
            raise ValueError(label + " must be a nonempty string of at most " + str(limit) + " characters")
        return value.strip()

    @staticmethod
    def boolean(body, key):
        if not isinstance(body.get(key), bool):
            raise ValueError(key + " must be a boolean")
        return body[key]

    @staticmethod
    def has_table(db, name):
        return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None

    def dispatch_guard(self):
        features = getattr(self.hosted, "thread_features", None)
        return getattr(features, "lock", None) or nullcontext()

    def move(self, session, target):
        with self.dispatch_guard():
            return self._move(session, target)

    def _move(self, session, target):
        self.workspace(target)
        if not self.store.get_thread(session):
            raise ValueError("Thread not found")
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            sessions = [session]
            if self.has_table(db, "hosted_experiments"):
                sessions += [r[0] for r in db.execute("SELECT worker FROM hosted_experiments WHERE parent=?", (session,))]
                db.execute("UPDATE hosted_experiments SET workspace=? WHERE parent=?", (target, session))
            # Research directories are keyed by thread, so moving the folder
            # doesn't mutate cwd or interrupt an in-flight worker.
            for item in sessions:
                db.execute("UPDATE threads SET workspace_id=?,folder_id=NULL,updated_at=? WHERE id=?", (target, now(), item))
        return {"ok": True, "session": session, "folder_id": target, "workspace_id": target}

    def delete_workspace(self, workspace, cascade):
        with self.dispatch_guard():
            return self._delete_workspace(workspace, cascade)

    def _delete_workspace(self, workspace, cascade):
        self.workspace(workspace)
        # A terminal SQL status precedes completion callbacks and handle cleanup.
        # Check handles before taking the DB write lock: runner.start takes its
        # own lock before SQLite, so doing this inside the transaction can invert
        # lock order. The dispatch guard prevents new queue starts meanwhile.
        active = getattr(self.hosted.runner, "is_active", None)
        if callable(active) and any(active(t["id"]) for t in self.store.list_threads(workspace)):
            raise ValueError("Wait for running research and callback finalization before deleting this folder")
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            busy = db.execute("SELECT 1 FROM runs JOIN threads ON threads.id=runs.thread_id WHERE threads.workspace_id=? AND runs.status IN ('queued','running') LIMIT 1", (workspace,)).fetchone()
            if busy:
                raise ValueError("Stop running research before deleting this folder")
            if self.has_table(db, "hosted_queue") and db.execute("SELECT 1 FROM hosted_queue JOIN threads ON threads.id=hosted_queue.session WHERE threads.workspace_id=? AND hosted_queue.state='dispatching' LIMIT 1", (workspace,)).fetchone():
                raise ValueError("Stop dispatching research before deleting this folder")
            count = db.execute("SELECT count(*) FROM threads WHERE workspace_id=?", (workspace,)).fetchone()[0]
            if count and not cascade:
                raise ValueError("Folder contains threads; explicit cascade deletion is required")
            if self.has_table(db, "hosted_experiments"):
                db.execute("UPDATE hosted_experiments SET deleted=1 WHERE workspace=?", (workspace,))
                if self.has_table(db, "hosted_report_sharing"):
                    db.execute("UPDATE hosted_report_sharing SET visibility='private' WHERE eid IN (SELECT eid FROM hosted_experiments WHERE workspace=?)", (workspace,))
            if self.has_table(db, "source_resources"):
                db.execute("DELETE FROM source_resources WHERE workspace=?", (workspace,))
            db.execute("DELETE FROM threads WHERE workspace_id=?", (workspace,))
            db.execute("DELETE FROM workspaces WHERE id=?", (workspace,))
            db.execute("DELETE FROM local_settings WHERE key=?", ("workspace:" + workspace,))
            if not db.execute("SELECT 1 FROM workspaces LIMIT 1").fetchone():
                db.execute("INSERT INTO workspaces VALUES (?,?,?)", ("ws_" + uuid.uuid4().hex[:26], "Local research", now()))
        return {"ok": True, "deleted_threads": count, "files_retained": True}

    def route(self, h, method, path, body):
        q = lambda key, default="": h.query.get(key, [default])[0]
        reply = lambda data, status=200: h.json(status, data)
        unsupported = "This local app uses the configured Codex CLI. Hosted credentials, account privacy, and hosted sandbox controls are unsupported."
        try:
            if path == "/api/feature-flags" and method == "GET":
                reply(self.flags())
            elif path == "/api/settings/model":
                if method == "PUT":
                    if body.get("model") != DEFAULT_MODEL:
                        raise ValueError("Only the configured Codex CLI model is available; no model catalog was discovered")
                    self.put("model", body["model"])
                elif method != "GET":
                    reply({"error": "Method not supported"}, 405)
                    return True
                reply({"model": self.model(), "models": self.flags()["models"], "provider": "codex"})
            elif path == "/api/settings/providers" and method == "GET":
                reply({"providers": [self.status()]})
            elif path == "/api/settings/env" and method == "GET":
                reply({"vars": [], "writable": False, "message": unsupported})
            elif path.startswith("/api/settings/env") or path == "/api/settings/sandbox" or re.fullmatch(r"/api/orgs/[^/]+/privacy", path):
                reply({"error": unsupported}, 501)
            elif path == "/api/integrations/verify" and method == "POST":
                if body.get("service") != "codex" or any(key in body for key in ("token", "api_key", "value")):
                    reply({"valid": False, "reason": "unsupported", "error": unsupported}, 501)
                else:
                    status = self.status()
                    reply({"valid": bool(status.get("installed") and status.get("authenticated")), "reason": None if status.get("authenticated") else "not_authenticated", "provider": status})
            elif path == "/api/settings/instructions" and method in ("GET", "PUT"):
                scope = q("scope", "user")
                if scope not in ("user", "org") or q("org_id", "local") != "local":
                    raise ValueError("Unknown local settings scope")
                if method == "PUT":
                    content = body.get("content")
                    if not isinstance(content, str) or len(content) > 64000:
                        raise ValueError("Instructions must be text of at most 64000 characters")
                    self.put("instructions:" + scope, content)
                content = self.get("instructions:" + scope, "")
                reply({"content": content, "exists": bool(content.strip())})
            elif path == "/api/orgs/local" and method == "PATCH":
                name = self.put("org_name", self.text(body.get("name"), "Name"))
                reply({"organization_id": "local", "name": name, "role": "owner"})
            elif path == "/api/orgs/local/folders/recover" and method == "POST":
                # Every local workspace is already represented by a folder.
                reply({"bound": []})
            elif (match := re.fullmatch(r"/api/workspaces/by-name/([^/]+)", path)) and method == "GET":
                item = next((w for w in self.store.list_workspaces() if w["name"] == match[1]), None)
                reply(self.workspace(item["id"]) if item else {"error": "Workspace not found"}, 200 if item else 404)
            elif (match := re.fullmatch(r"/api/workspaces/([^/]+)(/archive)?", path)) and (method in ("PATCH", "DELETE") or match[2]):
                workspace = match[1]
                self.workspace(workspace)
                if method == "PATCH" and not match[2]:
                    name = self.text(body.get("display_name", body.get("name")), "Folder name")
                    with self.store.connect() as db:
                        db.execute("UPDATE workspaces SET name=? WHERE id=?", (name, workspace))
                    reply(self.workspace(workspace))
                elif method == "POST" and match[2]:
                    self.put("workspace:" + workspace, {**self.workspace_meta(workspace), "archived": self.boolean(body, "archived")})
                    reply(self.workspace(workspace))
                elif method == "DELETE":
                    reply(self.delete_workspace(workspace, q("cascade") == "true"))
                else:
                    reply({"error": "Method not supported"}, 405)
            elif (match := re.fullmatch(r"/api/orgs/local/folders/([^/]+)(/pin)?", path)) and method in ("POST", "DELETE", "PATCH"):
                workspace = match[1]
                self.workspace(workspace)
                if method == "POST" and match[2]:
                    meta = self.put("workspace:" + workspace, {**self.workspace_meta(workspace), "pinned": self.boolean(body, "pinned")})
                    reply({"ok": True, **meta})
                elif method == "DELETE" and not match[2]:
                    reply(self.delete_workspace(workspace, q("cascade") == "true"))
                elif method == "PATCH" and not match[2]:
                    with self.store.connect() as db:
                        db.execute("UPDATE workspaces SET name=? WHERE id=?", (self.text(body.get("name"), "Folder name"), workspace))
                    reply(self.workspace(workspace))
                else:
                    reply({"error": "Method not supported"}, 405)
            elif (match := re.fullmatch(r"/api/orgs/local/threads/([^/]+)/(pin|move)", path)) and method == "POST":
                session, action = match.groups()
                if not self.store.get_thread(session):
                    raise ValueError("Thread not found")
                if action == "move":
                    reply(self.move(session, body.get("target_folder_id")))
                else:
                    pinned = self.boolean(body, "pinned")
                    self.hosted.set_meta(session, pinned=pinned, pin_rank=time.time_ns() if pinned else 0)
                    reply({"ok": True, "pinned": pinned})
            elif path == "/api/orgs/local/pins/threads" and method == "PUT":
                sessions = body.get("thread_ids")
                if not isinstance(sessions, list) or len(sessions) > 1000 or len(set(sessions)) != len(sessions):
                    raise ValueError("Expected unique thread IDs")
                if any(not isinstance(s, str) or not self.store.get_thread(s) for s in sessions):
                    raise ValueError("Thread not found")
                for rank, session in enumerate(sessions):
                    self.hosted.set_meta(session, pinned=True, pin_rank=rank)
                reply({"ok": True})
            elif (match := re.fullmatch(r"/api/workspaces/([^/]+)/threads/([^/]+)/(folder|model)", path)):
                workspace, session, action = match.groups()
                thread = self.store.get_thread(session)
                if not thread or thread["workspace_id"] != workspace:
                    raise ValueError("Thread not found in this workspace")
                if action == "folder" and method == "POST":
                    reply(self.move(session, body.get("folder_id") or self.store.list_workspaces()[0]["id"]))
                elif action == "model" and method in ("GET", "POST"):
                    if method == "POST":
                        role = body.get("role", "planner")
                        if role not in ("planner", "worker") or body.get("model") not in (None, "", DEFAULT_MODEL):
                            raise ValueError("Only planner/worker using the configured Codex CLI model are available")
                        self.store.update_thread(session, **{role + "_model": DEFAULT_MODEL})
                        self.put("model", DEFAULT_MODEL)
                    models = {role: self.store.get_thread(session)[role + "_model"] or self.model() for role in ("planner", "worker")}
                    reply({"ok": True, "model": models["planner"], "provider": "codex", "role_models": models, "effective_role_models": models})
                else:
                    return False
            else:
                return False
        except (ValueError, TypeError) as exc:
            reply({"error": str(exc)}, 400)
        return True
