"""SQLite state and confined files for a single-user research application."""

import hashlib
import json
import mimetypes
import os
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

TERMINAL = {"completed", "failed", "cancelled", "interrupted"}
IDENTIFIER = re.compile(r"^[a-zA-Z0-9_-]{1,100}$")


def now():
    return datetime.now(UTC).isoformat()


def identifier(value):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ValueError("Invalid identifier")
    return value


class Store:
    def __init__(self, data_dir):
        self.root = Path(data_dir).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.workspace_root = self.root / "workspaces"
        self.workspace_root.mkdir(exist_ok=True)
        self.database = self.root / "research.sqlite3"
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS workspaces (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS folders (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS threads (
                    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                    folder_id TEXT REFERENCES folders(id), title TEXT NOT NULL,
                    planner_model TEXT NOT NULL DEFAULT '', worker_model TEXT NOT NULL DEFAULT '',
                    provider_thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                    status TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', auto_research INTEGER NOT NULL,
                    created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
                    return_code INTEGER, final_text TEXT NOT NULL DEFAULT '',
                    usage_json TEXT, error TEXT, provider_thread_id TEXT);
                CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(thread_id)
                    WHERE status IN ('queued','running');
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
                    role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS run_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS event_run_cursor ON run_events(run_id,id);
                CREATE TABLE IF NOT EXISTS files (
                    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
                    path TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
                    media_type TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL,
                    UNIQUE(thread_id,path));
            """)
        os.chmod(self.database, 0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=10000")
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def _all(self, sql, params=()):
        with self.connect() as db:
            return [dict(row) for row in db.execute(sql, params).fetchall()]

    def _one(self, sql, params=()):
        rows = self._all(sql, params)
        return rows[0] if rows else None

    def create_workspace(self, name="Local research"):
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Workspace name required")
        item = {"id": "ws_" + uuid.uuid4().hex[:26], "name": name.strip()[:200], "created_at": now()}
        with self.connect() as db:
            db.execute("INSERT INTO workspaces VALUES (:id,:name,:created_at)", item)
        return item

    def list_workspaces(self):
        return self._all("SELECT * FROM workspaces ORDER BY created_at")

    def create_folder(self, name):
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Folder name required")
        item = {"id": str(uuid.uuid4()), "name": name.strip()[:200], "created_at": now()}
        with self.connect() as db:
            db.execute("INSERT INTO folders VALUES (:id,:name,:created_at)", item)
        return item

    def list_folders(self):
        return self._all("SELECT * FROM folders ORDER BY created_at")

    def create_thread(self, workspace_id=None, title="New research", planner_model="", worker_model="", folder_id=None, thread_id=None):
        if workspace_id is None:
            workspaces = self.list_workspaces()
            workspace_id = (workspaces[0] if workspaces else self.create_workspace())["id"]
        identifier(workspace_id)
        if not self._one("SELECT id FROM workspaces WHERE id=?", (workspace_id,)):
            raise ValueError("Workspace not found")
        thread_id = identifier(thread_id) if thread_id else str(uuid.uuid4())
        for value in (title, planner_model, worker_model):
            if not isinstance(value, str):
                raise ValueError("Thread fields must be strings")
        item = {"id": thread_id, "workspace_id": workspace_id, "folder_id": folder_id,
                "title": title.strip()[:200] or "New research", "planner_model": planner_model[:100],
                "worker_model": worker_model[:100], "provider_thread_id": None,
                "created_at": now(), "updated_at": now()}
        with self.connect() as db:
            db.execute("""INSERT INTO threads VALUES
                (:id,:workspace_id,:folder_id,:title,:planner_model,:worker_model,
                 :provider_thread_id,:created_at,:updated_at)""", item)
        self.thread_path(thread_id).mkdir(mode=0o700, parents=True, exist_ok=True)
        return item

    def list_threads(self, workspace_id=None):
        if workspace_id:
            return self._all("SELECT * FROM threads WHERE workspace_id=? ORDER BY updated_at DESC", (identifier(workspace_id),))
        return self._all("SELECT * FROM threads ORDER BY updated_at DESC")

    def get_thread(self, thread_id):
        return self._one("SELECT * FROM threads WHERE id=?", (identifier(thread_id),))

    def update_thread(self, thread_id, **changes):
        allowed = {"title", "folder_id", "planner_model", "worker_model", "provider_thread_id"}
        updates = {key: value for key, value in changes.items() if key in allowed}
        for key in ("title", "planner_model", "worker_model"):
            if key in updates:
                if not isinstance(updates[key], str):
                    raise ValueError(f"{key} must be a string")
                updates[key] = updates[key].strip()[:200]
        if "title" in updates and not updates["title"]:
            raise ValueError("Title must not be empty")
        updates["updated_at"] = now()
        with self.connect() as db:
            db.execute("UPDATE threads SET " + ",".join(f"{key}=?" for key in updates) + " WHERE id=?", (*updates.values(), identifier(thread_id)))
        return self.get_thread(thread_id)

    def delete_thread(self, thread_id):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT id FROM runs WHERE thread_id=? AND status IN ('queued','running')", (identifier(thread_id),)).fetchone():
                raise ValueError("Cannot delete a running thread")
            db.execute("DELETE FROM threads WHERE id=?", (thread_id,))
        # Deliberately retain workspace files; deleting chat history must not destroy research data.

    def thread_path(self, thread_id):
        root = self.workspace_root.resolve()
        candidate = root / identifier(thread_id)
        if candidate.is_symlink() or not candidate.resolve().is_relative_to(root):
            raise ValueError("Invalid workspace path")
        return candidate

    def file_path(self, thread_id, relative):
        if not self.get_thread(thread_id):
            raise ValueError("Thread not found")
        if not isinstance(relative, str) or not relative or "\\" in relative or "\x00" in relative:
            raise ValueError("Invalid file path")
        path = Path(relative)
        if path.is_absolute() or any(part in ("..", ".") or part.startswith(".") for part in path.parts):
            raise ValueError("Hidden or escaped files are not served")
        root = self.thread_path(thread_id).resolve()
        result = root / path
        current = root
        for component in path.parts:
            current /= component
            if current.is_symlink():
                raise ValueError("Symlink files are not served")
        if not result.resolve().is_relative_to(root):
            raise ValueError("File outside workspace")
        return result

    def add_message(self, thread_id, role, content, run_id=None):
        if role not in {"user", "assistant", "system"} or not isinstance(content, str):
            raise ValueError("Invalid message")
        item = {"id": str(uuid.uuid4()), "thread_id": identifier(thread_id), "run_id": run_id,
                "role": role, "content": content, "created_at": now()}
        with self.connect() as db:
            db.execute("INSERT INTO messages VALUES (:id,:thread_id,:run_id,:role,:content,:created_at)", item)
        return item

    def open_file(self, thread_id, relative):
        """Open each component without following links, including during agent writes."""
        self.file_path(thread_id, relative)
        parts = Path(relative).parts
        descriptor = os.open(self.thread_path(thread_id), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in parts[:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                os.close(descriptor)
                descriptor = child
            file_descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
            import stat
            if not stat.S_ISREG(os.fstat(file_descriptor).st_mode):
                os.close(file_descriptor)
                raise ValueError("Only ordinary files can be served")
            return os.fdopen(file_descriptor, "rb")
        finally:
            os.close(descriptor)

    def write_upload(self, thread_id, relative, content):
        self.file_path(thread_id, relative)
        parts = Path(relative).parts
        if len(parts) != 2 or parts[0] != "uploads":
            raise ValueError("Uploads must use the uploads directory")
        root = os.open(self.thread_path(thread_id), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            try:
                os.mkdir("uploads", mode=0o700, dir_fd=root)
            except FileExistsError:
                pass
            directory = os.open("uploads", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
            try:
                descriptor = os.open(parts[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(content)
            finally:
                os.close(directory)
        finally:
            os.close(root)

    def list_messages(self, thread_id):
        return self._all("SELECT * FROM messages WHERE thread_id=? ORDER BY rowid", (identifier(thread_id),))

    def create_run(self, thread_id, prompt, model="", auto_research=True):
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 100000:
            raise ValueError("Prompt must contain 1–100000 characters")
        run_id, timestamp = str(uuid.uuid4()), now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT id FROM threads WHERE id=?", (identifier(thread_id),)).fetchone():
                raise ValueError("Thread not found")
            try:
                db.execute("INSERT INTO runs(id,thread_id,status,model,auto_research,created_at) VALUES (?,?,?,?,?,?)", (run_id, thread_id, "queued", model, int(bool(auto_research)), timestamp))
            except sqlite3.IntegrityError as exc:
                raise ValueError("A run is already active for this thread") from exc
            db.execute("INSERT INTO messages VALUES (?,?,?,?,?,?)", (str(uuid.uuid4()), thread_id, run_id, "user", prompt, timestamp))
            db.execute("UPDATE threads SET updated_at=? WHERE id=?", (timestamp, thread_id))
        return self.get_run(run_id)

    def get_run(self, run_id):
        item = self._one("SELECT * FROM runs WHERE id=?", (identifier(run_id),))
        if item and item["usage_json"]:
            item["usage"] = json.loads(item["usage_json"])
        return item

    def list_runs(self, thread_id):
        return self._all("SELECT * FROM runs WHERE thread_id=? ORDER BY created_at", (identifier(thread_id),))

    def update_run(self, run_id, **changes):
        allowed = {"status", "started_at", "finished_at", "return_code", "final_text", "usage_json", "error", "provider_thread_id"}
        updates = {key: value for key, value in changes.items() if key in allowed}
        if updates:
            with self.connect() as db:
                db.execute("UPDATE runs SET " + ",".join(f"{key}=?" for key in updates) + " WHERE id=? AND status NOT IN ('completed','failed','cancelled','interrupted')", (*updates.values(), identifier(run_id)))
        return self.get_run(run_id)

    def finish_run(self, run_id, status, final_text="", error=None, return_code=None, usage=None):
        if status not in TERMINAL:
            raise ValueError("Invalid terminal status")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            run = db.execute("SELECT * FROM runs WHERE id=?", (identifier(run_id),)).fetchone()
            if not run or run["status"] in TERMINAL:
                return False
            db.execute("UPDATE runs SET status=?,finished_at=?,return_code=?,final_text=?,error=?,usage_json=? WHERE id=?", (status, now(), return_code, final_text, error, json.dumps(usage) if usage else None, run_id))
            if final_text:
                db.execute("INSERT INTO messages VALUES (?,?,?,?,?,?)", (str(uuid.uuid4()), run["thread_id"], run_id, "assistant", final_text, now()))
            db.execute("UPDATE threads SET updated_at=? WHERE id=?", (now(), run["thread_id"]))
        return True

    def add_event(self, run_id, kind, payload):
        with self.connect() as db:
            cur = db.execute("INSERT INTO run_events(run_id,kind,payload_json,created_at) VALUES (?,?,?,?)", (identifier(run_id), kind, json.dumps(payload, ensure_ascii=False), now()))
            return cur.lastrowid

    def list_events(self, run_id, after=0, limit=500):
        rows = self._all("SELECT * FROM run_events WHERE run_id=? AND id>? ORDER BY id LIMIT ?", (identifier(run_id), max(0, int(after)), min(1000, max(1, int(limit)))))
        for row in rows:
            row["payload"] = json.loads(row.pop("payload_json"))
        return rows

    def interrupt_abandoned_runs(self):
        active = self._all("SELECT id FROM runs WHERE status IN ('queued','running')")
        for run in active:
            self.finish_run(run["id"], "interrupted", error="Backend restarted before this run completed")
            self.add_event(run["id"], "run.finished", {"status": "interrupted", "error": "Backend restarted"})
        return len(active)

    def register_file(self, thread_id, relative, run_id=None, kind="artifact"):
        path = self.file_path(thread_id, relative)
        if not path.is_file():
            raise ValueError("File not found")
        size = path.stat().st_size
        if size > 100 * 1024 * 1024:
            raise ValueError("File exceeds 100 MiB artifact limit")
        with self.open_file(thread_id, relative) as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        existing = self._one("SELECT id FROM files WHERE thread_id=? AND path=?", (thread_id, relative))
        item = {"id": existing["id"] if existing else str(uuid.uuid4()), "thread_id": thread_id,
                "run_id": run_id, "path": relative, "size": size, "sha256": digest,
                "media_type": mimetypes.guess_type(path.name)[0] or "application/octet-stream", "kind": kind, "created_at": now()}
        with self.connect() as db:
            db.execute("""INSERT INTO files VALUES (:id,:thread_id,:run_id,:path,:size,:sha256,:media_type,:kind,:created_at)
                ON CONFLICT(thread_id,path) DO UPDATE SET run_id=excluded.run_id,size=excluded.size,
                sha256=excluded.sha256,media_type=excluded.media_type,kind=excluded.kind,created_at=excluded.created_at""", item)
        return item

    def list_files(self, thread_id):
        return self._all("SELECT * FROM files WHERE thread_id=? ORDER BY created_at", (identifier(thread_id),))

    def get_file(self, file_id):
        return self._one("SELECT * FROM files WHERE id=?", (identifier(file_id),))

    def thread_detail(self, thread_id):
        thread = self.get_thread(thread_id)
        if thread:
            thread.update(messages=self.list_messages(thread_id), runs=self.list_runs(thread_id), files=self.list_files(thread_id))
        return thread
