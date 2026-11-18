"""Observed hosted experiment contracts backed by real local worker runs.

No remote scheduler or public hosting is impersonated. Publications are immutable
local snapshots, and file routes resolve registered workspace files only.
"""

import difflib
import hashlib
import html
import io
import json
import mimetypes
import os
import re
import threading
import time
import uuid
import zipfile
from contextlib import nullcontext
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

from .report_bridge import MarkdownContent, inject_bridge
from .runner import MODEL
from .store import now

WORKER_INSTRUCTIONS = """You are executing an explicitly approved research plan.
Perform the actual analysis, code execution, or source research the plan requires.
Use the approved plan and supplied context below. Write reproducible code and
results in this workspace. Write report.md with methods, actual observations,
commands run, limitations, and source URLs where applicable. You may also write
an index.html report using local assets only. Never invent measured results or
claim unavailable GPU/cloud resources were used. Report failures honestly.
Do not propose another plan instead of executing this approved task. Do not
delegate, publish, push, deploy, or access unrelated personal files.
"""


class ExperimentService:
    def __init__(self, hosted):
        self.hosted = hosted
        self.store = hosted.store
        self.runner = hosted.runner
        self.lock = threading.RLock()
        self.base_url = ""
        self.document_leases = {}
        with self.store.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS hosted_experiments (
                    eid TEXT PRIMARY KEY, workspace TEXT NOT NULL,
                    parent TEXT NOT NULL, worker TEXT NOT NULL,
                    plan_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL,
                    display_label INTEGER NOT NULL, created_at TEXT NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
                    outcome TEXT,
                    UNIQUE(parent,plan_id));
                CREATE TABLE IF NOT EXISTS hosted_checkpoints (
                    eid TEXT NOT NULL, sequence INTEGER NOT NULL,
                    run_id TEXT, data TEXT NOT NULL,
                    PRIMARY KEY(eid,sequence), UNIQUE(eid,run_id));
                CREATE TABLE IF NOT EXISTS hosted_experiment_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL,
                    kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS hosted_file_snapshots (
                    eid TEXT NOT NULL, sequence INTEGER NOT NULL, path TEXT NOT NULL,
                    text TEXT, sha256 TEXT NOT NULL, PRIMARY KEY(eid,sequence,path));
                CREATE TABLE IF NOT EXISTS hosted_report_versions (
                    id TEXT PRIMARY KEY, eid TEXT NOT NULL, html BLOB NOT NULL,
                    archive BLOB NOT NULL, label TEXT, created_at TEXT NOT NULL,
                    entry TEXT NOT NULL DEFAULT 'index.html');
                CREATE TABLE IF NOT EXISTS hosted_report_sharing (
                    eid TEXT PRIMARY KEY, visibility TEXT NOT NULL DEFAULT 'private',
                    revision_id TEXT, pub_id TEXT UNIQUE, title TEXT,
                    updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS hosted_worker_messages (
                    eid TEXT NOT NULL, client_id TEXT NOT NULL, run_id TEXT NOT NULL,
                    PRIMARY KEY(eid,client_id));
            """)
            columns = {row["name"] for row in db.execute("PRAGMA table_info(hosted_report_versions)")}
            if "entry" not in columns:
                db.execute("ALTER TABLE hosted_report_versions ADD COLUMN entry TEXT NOT NULL DEFAULT 'index.html'")
            columns = {row["name"] for row in db.execute("PRAGMA table_info(hosted_experiments)")}
            if "outcome" not in columns:
                db.execute("ALTER TABLE hosted_experiments ADD COLUMN outcome TEXT")

    def get(self, eid, workspace=None):
        row = self.store._one("SELECT * FROM hosted_experiments WHERE eid=? AND deleted=0", (eid,))
        if row and (workspace is None or row["workspace"] == workspace):
            return row
        return None

    def event(self, exp, kind, **payload):
        data = {"eid": exp["eid"], **payload}
        with self.store.connect() as db:
            db.execute("INSERT INTO hosted_experiment_events(workspace,kind,payload,created_at) VALUES (?,?,?,?)",
                       (exp["workspace"], kind, json.dumps(data), now()))

    def events(self, workspace, after=0):
        rows = self.store._all("SELECT * FROM hosted_experiment_events WHERE workspace=? AND id>? ORDER BY id LIMIT 500",
                               (workspace, max(0, int(after))))
        for row in rows:
            row["payload"] = json.loads(row["payload"])
        return rows

    def latest_run(self, exp):
        runs = self.store.list_runs(exp["worker"])
        return runs[-1] if runs else None

    def status(self, exp):
        run = self.latest_run(exp)
        if not run:
            return "stopped"
        return {"queued": "running", "running": "running", "completed": "completed",
                "cancelled": "stopped", "interrupted": "stopped", "failed": "failed"}[run["status"]]

    def checkpoints(self, exp):
        return [json.loads(row["data"]) for row in self.store._all(
            "SELECT data FROM hosted_checkpoints WHERE eid=? ORDER BY sequence", (exp["eid"],))]

    def row(self, exp):
        points = self.checkpoints(exp)
        last = points[-1] if points else {}
        status = self.status(exp)
        return {"eid": exp["eid"], "display_label": exp["display_label"], "number": exp["display_label"],
                "title": exp["title"], "created_at": exp["created_at"], "status": status,
                "experiment_kind": "research", "outcome": exp.get("outcome"), "eta": None,
                "dispatched_by": exp["parent"], "thread_id": exp["parent"],
                "user_id": "local:dev",
                "worker_alive": status == "running", "checkpoint_count": len(points),
                "last_summary": last.get("summary"), "last_seq": last.get("sequence", 0),
                "allowed_actions": ["stop"] if status == "running" else ["resume", "rename", "delete"],
                "fabric_id": "local"}

    def rows(self, workspace):
        return [self.row(exp) for exp in self.store._all(
            "SELECT * FROM hosted_experiments WHERE workspace=? AND deleted=0 AND archived=0 ORDER BY display_label DESC", (workspace,))]

    def states(self, parent):
        result = {}
        for exp in self.store._all("SELECT * FROM hosted_experiments WHERE parent=? AND deleted=0", (parent,)):
            row = self.row(exp)
            result[exp["eid"]] = {key: row[key] for key in ("status", "outcome", "worker_alive")}
        return result

    def workspace_stream(self, h, workspace, after=0, duration=25):
        h.send_response(200)
        h.send_header("Content-Type", "text/event-stream; charset=utf-8")
        h.send_header("Cache-Control", "no-cache")
        h.send_header("Connection", "close")
        h.end_headers()
        h.close_connection = True
        deadline = time.monotonic() + duration
        try:
            while time.monotonic() < deadline and not self.hosted.closed.is_set():
                for event in self.events(workspace, after):
                    h.wfile.write(f"event: {event['kind']}\nid: {event['id']}\ndata: {json.dumps(event['payload'])}\n\n".encode())
                    after = event["id"]
                h.wfile.write(b": keepalive\n\n")
                h.wfile.flush()
                self.hosted.closed.wait(0.5)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    def _checkpoint(self, exp, kind, summary, body, run_id=None):
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if run_id and db.execute("SELECT 1 FROM hosted_checkpoints WHERE eid=? AND run_id=?", (exp["eid"], run_id)).fetchone():
                return None
            sequence = db.execute("SELECT COALESCE(MAX(sequence),0)+1 FROM hosted_checkpoints WHERE eid=?", (exp["eid"],)).fetchone()[0]
            files = self.store.list_files(exp["worker"])
            point = {"feed_id": f"chk_{sequence:03}", "category": "checkpoint", "type": kind,
                     "sequence": sequence, "timestamp": now(), "title": summary[:200],
                     "summary": summary, "body": body,
                     "artifacts": [{"path": self.virtual_path(item), "title": item["path"]} for item in files],
                     "visualizations": []}
            db.execute("INSERT INTO hosted_checkpoints VALUES (?,?,?,?)", (exp["eid"], sequence, run_id, json.dumps(point)))
        self._snapshot_files(exp, sequence)
        self.event(exp, "checkpoint", sequence=sequence, checkpoint_type=kind, summary=summary,
                   body=body, timestamp=point["timestamp"], rendered=True)
        return point

    def _snapshot_files(self, exp, sequence):
        with self.store.connect() as db:
            for item in self.store.list_files(exp["worker"]):
                try:
                    data = self.read_file(item, 2 * 1024 * 1024)
                    text = data.decode("utf-8") if len(data) <= 2 * 1024 * 1024 and b"\0" not in data else None
                except FileNotFoundError:
                    continue
                except (OSError, ValueError, UnicodeDecodeError):
                    text = None
                db.execute("INSERT OR REPLACE INTO hosted_file_snapshots VALUES (?,?,?,?,?)",
                           (exp["eid"], sequence, item["path"], text, item["sha256"]))

    def launch(self, workspace, body):
        features = getattr(self.hosted, "thread_features", None)
        with features.lock if features else nullcontext(), self.lock:
            return self._launch(workspace, body)

    def _launch(self, workspace, body):
        if body.get("max_gpus") is not None and body["max_gpus"] != 0:
            raise ValueError("GPU execution is unavailable in this local CPU workspace. Set max_gpus to 0 or connect a GPU executor before launching.")
        parent = body.get("session_uuid")
        thread = self.store.get_thread(parent)
        if not thread or thread["workspace_id"] != workspace:
            raise ValueError("Planner session does not belong to this workspace")
        title, plan = body.get("title"), body.get("body")
        if not isinstance(title, str) or not title.strip() or not isinstance(plan, str) or not plan.strip():
            raise ValueError("Plan title and body are required")
        plan_id = body.get("plan_id")
        # A deterministic idempotency key also covers clients omitting plan_id.
        plan_id = str(plan_id) if plan_id else hashlib.sha256((title + "\n" + plan).encode()).hexdigest()
        existing = self.store._one("SELECT * FROM hosted_experiments WHERE parent=? AND plan_id=?", (parent, plan_id))
        if existing:
            if not self.latest_run(existing):
                self._resume(existing, {"prompt": "Execute this approved plan:\n\n" + existing["body"]})
            self._accepted(existing, body.get("plan_id"))
            return {"ok": True, **existing}
        pending = self.hosted.get_meta(parent).get("plan")
        if body.get("plan_id") and (not pending or pending.get("plan_id") != body["plan_id"]):
            raise ValueError("This proposal is no longer awaiting approval; reload the current plan")
        eid = "exp_0" + uuid.uuid4().hex[:25]
        worker_model = "" if thread["worker_model"] == "codex-default" else thread["worker_model"]
        worker = self.store.create_thread(workspace, title, planner_model=worker_model, worker_model=worker_model,
                                          thread_id="th_0" + uuid.uuid4().hex[:25])
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            label = db.execute("SELECT COALESCE(MAX(display_label),0)+1 FROM hosted_experiments WHERE workspace=?", (workspace,)).fetchone()[0]
            db.execute("INSERT INTO hosted_experiments(eid,workspace,parent,worker,plan_id,title,body,display_label,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                       (eid, workspace, parent, worker["id"], plan_id, title.strip()[:200], plan, label, now()))
        exp = self.get(eid)
        self.hosted.set_meta(worker["id"], kind="worker", workspace=workspace, thread_id=worker["id"], parent=parent, eid=eid)
        for item in self.store.list_files(parent):
            if not item["path"].startswith(("uploads/", "source-")):
                continue
            if item["path"].startswith("uploads/"):
                self.store.write_upload(worker["id"], item["path"], self.read_file(item))
            else:
                destination = self.store.file_path(worker["id"], item["path"])
                destination.parent.mkdir(parents=True, exist_ok=True)
                with destination.open("xb") as stream:
                    stream.write(self.read_file(item))
            self.store.register_file(worker["id"], item["path"], kind="attachment")
        self._snapshot_files(exp, 0)
        self._checkpoint(exp, "plan", title.strip(), plan)
        context = "\n\n".join(message["role"] + ": " + message["content"] for message in self.store.list_messages(parent))[-20000:]
        prompt = f"Approved plan: {title}\n\n{plan}\n\nParent conversation context:\n{context}"
        try:
            self.runner.start(worker["id"], prompt, model="" if thread["worker_model"] == "codex-default" else thread["worker_model"], instructions=self.worker_instructions())
        except Exception:
            # A retry may start this same persisted experiment through /resume.
            self.event(exp, "status_changed", status="stopped")
            raise
        self._accepted(exp, body.get("plan_id"))
        return {"ok": True, **exp}

    def _accepted(self, exp, plan_id):
        parent, eid = exp["parent"], exp["eid"]
        pending = self.hosted.get_meta(parent).get("plan")
        if pending and (not plan_id or pending.get("plan_id") == plan_id):
            self.hosted.set_meta(parent, plan=None, plan_phase=None)
        already = self.store._one("SELECT id FROM hosted_events WHERE session=? AND source=?", (parent, "accepted:" + eid))
        self.hosted.emit(parent, "accepted:" + eid, {"type": "plan_accepted", "plan_id": plan_id,
                         "eid": eid, "display_label": exp["display_label"], "title": exp["title"], "timestamp": now()})
        self.hosted.emit(parent, "launched:" + eid, {"type": "plan_ready", "plan_id": plan_id,
                         "title": exp["title"], "plan": exp["body"], "kind": "experiment", "launched": True,
                         "experiment_eid": eid, "display_label": exp["display_label"], "timestamp": now()})
        if not already:
            self.event(exp, "experiment_created", **{key: value for key, value in self.row(exp).items() if key != "eid"})

    def migrate_legacy_ids(self):
        """Explicit offline repair for early local IDs; refuses active workers.

        Returns old->new IDs. Call only after the integration run has completed.
        The provider transcripts and research files remain unchanged evidence.
        """
        valid = re.compile(r"^exp_[0-7][0-9abcdefghjkmnpqrstvwxyz]{25}$")
        with self.lock, self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute("SELECT eid,worker FROM hosted_experiments").fetchall()
            mapping = {row["eid"]: "exp_0" + uuid.uuid4().hex[:25] for row in rows if not valid.fullmatch(row["eid"])}
            for row in rows:
                if row["eid"] in mapping and db.execute("SELECT 1 FROM runs WHERE thread_id=? AND status IN ('queued','running')", (row["worker"],)).fetchone():
                    raise ValueError("Stop active experiment workers before migrating IDs")
            for old, new in mapping.items():
                for table in ("hosted_experiments", "hosted_checkpoints", "hosted_file_snapshots", "hosted_report_versions", "hosted_report_sharing", "hosted_worker_messages"):
                    db.execute(f"UPDATE {table} SET eid=? WHERE eid=?", (new, old))
                for table, column in (("hosted_report_versions", "id"), ("hosted_report_sharing", "revision_id"),
                                      ("hosted_experiment_events", "payload"), ("hosted_checkpoints", "data"),
                                      ("hosted_events", "data"), ("hosted_events", "source"), ("hosted_meta", "data")):
                    db.execute(f"UPDATE {table} SET {column}=replace({column},?,?) WHERE instr({column},?)>0", (old, new, old))
            return mapping

    def on_finish(self, run):
        exp = self.store._one("SELECT * FROM hosted_experiments WHERE worker=? AND deleted=0", (run["thread_id"],))
        if not exp:
            return False
        succeeded = run["status"] == "completed"
        summary = "Research completed" if succeeded else "Research " + run["status"]
        body = (self.final_response(run) if succeeded else run.get("error")) or run.get("final_text") or summary
        point = self._checkpoint(exp, "completion" if succeeded else "stopped", summary, body, run["id"])
        if point:
            self.hosted.set_meta(exp["worker"], report_revision_override=None)
            if any(item["run_id"] == run["id"] and item["path"] in {"report.md", "report.html", "index.html", "app/index.html"}
                   for item in self.store.list_files(exp["worker"])):
                self.hosted.set_meta(exp["worker"], report_deleted=False)
            self.event(exp, "status_changed", status=self.status(exp))
            self.event(exp, "worker_alive_changed", alive=False)
            report = self.report(exp)
            if report:
                self.event(exp, "result_page_revised")
                previous = self.hosted.get_meta(exp["worker"]).get("last_report_revision")
                # Older persisted workers may have a report but no recorded
                # revision baseline. The client still needs this first event
                # to refresh its iframe; prev_revision_id:null is supported.
                if previous != report["revision"]:
                    self.hosted.emit(exp["worker"], "report-revision:" + run["id"],
                                     {"type": "artifact_revision", "revision_id": report["revision"],
                                      "prev_revision_id": previous, "summary": "Report updated by the worker",
                                      "changed_paths": [item["path"] for item in self.store.list_files(exp["worker"]) if item["run_id"] == run["id"]],
                                      "delete_paths": [], "timestamp": now()})
                self.hosted.set_meta(exp["worker"], last_report_revision=report["revision"])
                self.hosted.emit(exp["parent"], "result-page:" + run["id"],
                                 {"type": "result_page", "experiment_eid": exp["eid"],
                                  "display_label": exp["display_label"], "title": exp["title"],
                                  "result_file_path": report["source"], "timestamp": now()})
            self.hosted.emit(exp["parent"], "experiment-state:" + run["id"],
                             {"type": "experiment_completed" if succeeded else "experiment_stalled",
                              "experiment_eid": exp["eid"], "display_label": exp["display_label"],
                              "title": exp["title"], "timestamp": now()})
            self.hosted.emit(exp["parent"], "experiment-result:" + run["id"],
                             {"type": "text", "id": "result-" + run["id"], "text": f"Experiment #{exp['display_label']} — {summary}\n\n{self.hosted.render_text(exp['worker'], body)}",
                              "experiment_eid": exp["eid"], "timestamp": now()})
        return True

    def final_response(self, run):
        """Use the final actual assistant message, retaining full events elsewhere."""
        cursor, last = 0, ""
        while True:
            events = self.store.list_events(run["id"], after=cursor, limit=1000)
            for event in events:
                cursor = event["id"]
                payload = event["payload"]
                item = payload.get("item", {})
                if payload.get("type") == "item.completed" and item.get("type") == "agent_message" and isinstance(item.get("text"), str):
                    last = item["text"]
            if len(events) < 1000:
                return last or run.get("final_text", "")

    @staticmethod
    def virtual_path(item):
        return "/workspace-files/" + item["thread_id"] + "/" + item["path"]

    def resolve_file(self, path, exp=None, allow_missing=False):
        if not isinstance(path, str) or not path or "\x00" in path or "\\" in path or ".." in Path(path).parts:
            raise ValueError("Invalid file path")
        candidates = self.store.list_files(exp["worker"]) if exp else self.store._all("SELECT * FROM files")
        for item in candidates:
            actual = self.store.thread_path(item["thread_id"]) / item["path"]
            matches = {self.virtual_path(item), str(actual)}
            if exp:
                matches.add(item["path"])
            if path in matches:
                actual = self.store.file_path(item["thread_id"], item["path"])
                if actual.is_file() or allow_missing and not actual.exists():
                    return item, actual
        raise FileNotFoundError("File is not registered in this workspace")

    def read_file(self, item, limit=100 * 1024 * 1024):
        with self.store.open_file(item["thread_id"], item["path"]) as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError("File exceeds the size limit")
        return data

    def report(self, exp):
        meta = self.hosted.get_meta(exp["worker"])
        if meta.get("report_deleted"):
            return None
        override = meta.get("report_revision_override")
        if override:
            saved = self.store._one("SELECT * FROM hosted_report_versions WHERE id=? AND eid=?", (override, exp["eid"]))
            if saved:
                return {"data": saved["html"], "entry": saved["entry"],
                        "revision": saved["id"][len(exp["eid"]) + 1:], "source": saved["entry"],
                        "archive": saved["archive"]}
        files = {item["path"]: item for item in self.store.list_files(exp["worker"])}
        entry = next((name for name in ("index.html", "app/index.html", "report.html", "report.md")
                      if name in files and self.store.file_path(exp["worker"], name).is_file()), None)
        if not entry:
            return None
        item, _path = self.resolve_file(entry, exp)
        data = self.read_file(item)
        if entry.endswith(".md"):
            # Escaped preformatted Markdown preserves all evidence without executing it.
            data = ("<!doctype html><html><head><meta charset='utf-8'><title>" + html.escape(exp["title"]) +
                    "</title><style>body{max-width:900px;margin:3rem auto;padding:0 2rem;font:16px/1.65 system-ui;color:#222;background:#faf9f6}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}</style>"
                    "</head><body><pre data-rea-markdown='true'>" + html.escape(data.decode("utf-8", errors="replace")) + "</pre></body></html>").encode()
        inventory = "\n".join(name + ":" + info["sha256"] for name, info in sorted(files.items())).encode()
        return {"data": data, "entry": entry, "revision": hashlib.sha256(data + inventory).hexdigest(), "source": item["path"]}

    @staticmethod
    def send_bytes(h, data, content_type, headers=None):
        h.send_response(200)
        h.send_header("Content-Type", content_type)
        h.send_header("Content-Length", str(len(data)))
        h.send_header("X-Content-Type-Options", "nosniff")
        h.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            if key.lower() == "content-security-policy":
                h.response_csp = value
                continue
            h.send_header(key, value)
        h.end_headers()
        if h.command != "HEAD":
            h.wfile.write(data)

    def serve_report(self, h, exp, path=""):
        report = self.report(exp)
        if not report:
            h.json(404, {"error": "No report has been produced by this worker"})
            return
        if path and path not in (report["entry"], "index.html"):
            relative = str(Path(report["entry"]).parent / path)
            if "archive" in report:
                with zipfile.ZipFile(io.BytesIO(report["archive"])) as archive:
                    try:
                        data = archive.read(relative)
                    except KeyError as exc:
                        raise FileNotFoundError("Report asset not found") from exc
                media_type = mimetypes.guess_type(relative)[0] or "application/octet-stream"
            else:
                item, _file = self.resolve_file(relative, exp)
                data, media_type = self.read_file(item), item["media_type"]
            self.send_bytes(h, data, media_type, {"Content-Security-Policy": "sandbox"})
            return
        self.send_bytes(h, inject_bridge(report["data"]), "text/html; charset=utf-8", {
            "X-Silico-App-Entrypoint": report["entry"], "X-Silico-App-Revision": report["revision"],
            "X-Silico-App-Source": report["source"], "X-Silico-App-Portable-Html": "true",
            "X-Silico-App-Bridge": "ready-v1",
            "Content-Security-Policy": "sandbox allow-scripts allow-modals; default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; connect-src 'none'"})

    def changeset(self, exp):
        baseline = {row["path"]: row for row in self.store._all("SELECT * FROM hosted_file_snapshots WHERE eid=? AND sequence=0", (exp["eid"],))}
        changes = []
        for item in self.store.list_files(exp["worker"]):
            exists = self.store.file_path(item["thread_id"], item["path"]).is_file()
            changes.append({"path": self.virtual_path(item), "rel_path": item["path"], "in_worktree": True,
                            "change_type": "deleted" if not exists else "added" if item["path"] not in baseline else "modified" if item["sha256"] != baseline[item["path"]]["sha256"] else "unchanged",
                            "size": item["size"], "diff_available": item["size"] <= 2 * 1024 * 1024,
                            "internal": False, "fabric_id": "local"})
        return {"changes": changes, "experiment_dir": "/workspace-files/" + exp["worker"],
                "worktree_root": "/workspace-files/" + exp["worker"], "tracked_files": [],
                "truncated": False, "worktree_scan_failed": False, "tracked_files_truncated": False}

    def file_diff(self, exp, path, checkpoint=None):
        item, actual = self.resolve_file(path, exp, allow_missing=True)
        relative = item["path"]
        before_seq = 0
        if checkpoint is not None:
            sequence = int(checkpoint)
            row = self.store._one("SELECT MAX(sequence) AS n FROM hosted_file_snapshots WHERE eid=? AND sequence<?", (exp["eid"], sequence))
            before_seq = row["n"] or 0
            after = self.store._one("SELECT text FROM hosted_file_snapshots WHERE eid=? AND sequence=? AND path=?", (exp["eid"], sequence, relative))
            target = after["text"] if after else ""
        elif not actual.exists():
            target = ""
        else:
            if actual.stat().st_size > 2 * 1024 * 1024:
                return {"diff": "", "truncated": True}
            target = self.read_file(item, 2 * 1024 * 1024).decode("utf-8", errors="replace")
        before = self.store._one("SELECT text FROM hosted_file_snapshots WHERE eid=? AND sequence=? AND path=?", (exp["eid"], before_seq, relative))
        if target is None or before and before["text"] is None:
            return {"diff": "", "truncated": True}
        old = before["text"] if before else ""
        diff = "".join(difflib.unified_diff(old.splitlines(keepends=True), target.splitlines(keepends=True), "a/" + relative, "b/" + relative))
        return {"diff": diff, "truncated": False}

    def delta(self, exp, sequence):
        files = []
        for item in self.store.list_files(exp["worker"]):
            diff = self.file_diff(exp, item["path"], sequence)["diff"]
            if diff:
                files.append({"path": self.virtual_path(item), "internal": False, "kind": "artifact",
                              "additions": sum(line.startswith("+") and not line.startswith("+++") for line in diff.splitlines()),
                              "deletions": sum(line.startswith("-") and not line.startswith("---") for line in diff.splitlines())})
        return {"sequence": int(sequence), "status": "available", "files": files}

    def archive(self, exp, report):
        if "archive" in report:
            return report["archive"]
        output = io.BytesIO()
        total = 0
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for item in self.store.list_files(exp["worker"]):
                try:
                    _, path = self.resolve_file(item["path"], exp)
                except FileNotFoundError:
                    continue
                total += path.stat().st_size
                if total > 100 * 1024 * 1024:
                    raise ValueError("Export exceeds 100 MiB; download individual files")
                archive.writestr(item["path"], self.read_file(item))
            if report["entry"].endswith(".md"):
                archive.writestr("index.html", report["data"])
        return output.getvalue()

    def save_version(self, exp, label=None):
        report = self.report(exp)
        if not report:
            raise ValueError("No real report exists yet")
        revision = exp["eid"] + "-" + report["revision"]
        with self.store.connect() as db:
            if not db.execute("SELECT id FROM hosted_report_versions WHERE id=?", (revision,)).fetchone():
                db.execute("INSERT INTO hosted_report_versions(id,eid,html,archive,label,created_at,entry) VALUES (?,?,?,?,?,?,?)",
                           (revision, exp["eid"], report["data"], self.archive(exp, report), label, now(), report["entry"]))
        return revision

    def sharing(self, exp):
        row = self.store._one("SELECT * FROM hosted_report_sharing WHERE eid=?", (exp["eid"],))
        report = self.report(exp)
        current = exp["eid"] + "-" + report["revision"] if report else None
        versions = self.store._all("SELECT id AS revision_id,label,created_at FROM hosted_report_versions WHERE eid=? ORDER BY created_at,rowid", (exp["eid"],))
        for number, version in enumerate(versions, 1):
            version["n"] = number
            version["active"] = version["revision_id"] == current
            version["pinned"] = bool(row and row["visibility"] == "link" and version["revision_id"] == row["revision_id"])
        return {"artifact_id": exp["eid"], "kind": "report", "visibility": row["visibility"] if row else "private",
                "can_publish": bool(report), "publication": {"url": self.base_url + "/api/local-publications/" + row["pub_id"] + "/"} if row and row["pub_id"] and row["visibility"] == "link" else None,
                "active_revision_id": report["revision"] if report else None,
                "pinned_revision_id": row["revision_id"] if row else None, "diverged": bool(row and row["revision_id"] != current), "versions": versions}

    def set_sharing(self, exp, body):
        visibility = body.get("visibility", body.get("access", "private"))
        if visibility not in {"private", "org", "link"}:
            raise ValueError("Invalid visibility")
        revision = body.get("restore_revision_id") or body.get("revision_id")
        if revision and not self.store._one("SELECT id FROM hosted_report_versions WHERE id=? AND eid=?", (revision, exp["eid"])):
            # Current viewer sends the app content hash, not the qualified stored id.
            report = self.report(exp)
            if not report or revision != report["revision"]:
                raise ValueError("Unknown report revision")
            revision = None
        revision = revision or self.save_version(exp)
        if body.get("restore_revision_id"):
            self.hosted.set_meta(exp["worker"], report_revision_override=revision)
            self.event(exp, "result_page_revised")
        existing = self.store._one("SELECT * FROM hosted_report_sharing WHERE eid=?", (exp["eid"],))
        pub_id = existing["pub_id"] if existing else "local_" + uuid.uuid4().hex
        with self.store.connect() as db:
            db.execute("INSERT INTO hosted_report_sharing VALUES (?,?,?,?,?,?) ON CONFLICT(eid) DO UPDATE SET visibility=excluded.visibility,revision_id=excluded.revision_id,title=excluded.title,updated_at=excluded.updated_at",
                       (exp["eid"], visibility, revision, pub_id, body.get("title") or exp["title"], now()))
        return self.sharing(exp)

    def papers(self):
        rows = self.store._all("SELECT s.*,e.parent,e.workspace FROM hosted_report_sharing s JOIN hosted_experiments e ON e.eid=s.eid WHERE e.deleted=0")
        return [{"pub_id": row["pub_id"], "title": row["title"], "status": "published" if row["visibility"] == "link" else "draft",
                 "owner_user_id": "local:dev", "updated_at": row["updated_at"], "access": row["visibility"],
                 "published_version": next((v["n"] for v in self.sharing(self.get(row["eid"]))["versions"] if v["revision_id"] == row["revision_id"]), None), "has_unpublished_changes": self.sharing(self.get(row["eid"]))["diverged"],
                 "publication_kind": "report", "fronted_artifact_kind": "report", "fronted_artifact_id": row["eid"],
                 "url": "/api/local-publications/" + row["pub_id"] + "/"} for row in rows if not self.hosted.get_meta(self.get(row["eid"])["worker"]).get("report_deleted")]

    def library_artifact(self, exp):
        if not self.report(exp):
            return None
        sharing = self.sharing(exp)
        files = self.store.list_files(exp["worker"])
        return {"artifact_id": exp["eid"], "kind": "report", "store_kind": "artifact", "title": exp["title"],
                "owner_user_id": "local:dev", "updated_at": max((f["created_at"] for f in files), default=exp["created_at"]),
                "visibility": sharing["visibility"], "workspace_id": exp["workspace"], "can_edit": True,
                "created_from": {"kind": "experiment", "thread_id": exp["parent"], "eid": exp["eid"], "number": exp["display_label"]},
                "sources": [], "tombstone": False}

    def worker_instructions(self, session=None):
        settings = getattr(self.hosted, "settings", None)
        custom = settings.instructions() if settings else ""
        forks = getattr(self.hosted, "forks", None)
        fork_context = forks.context(session) if forks and session else ""
        return WORKER_INSTRUCTIONS + ("\n\nWorkspace custom instructions:\n" + custom if custom else "") + ("\n\n" + fork_context if fork_context else "")

    def _resume(self, exp, body):
        features = getattr(self.hosted, "thread_features", None)
        with features.lock if features else nullcontext(), self.lock:
            return self._resume_locked(exp, body)

    def _resume_locked(self, exp, body):
        client_id = body.get("client_message_id")
        if client_id:
            prior = self.store._one("SELECT run_id FROM hosted_worker_messages WHERE eid=? AND client_id=?", (exp["eid"], client_id))
            if prior:
                return {"ok": True, "run_id": prior["run_id"], "session_id": exp["worker"]}
        prompt = body.get("prompt", body.get("message"))
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("Worker message required")
        if body.get("context_refs"):
            prompt += "\n\nUser-selected context:\n" + json.dumps(body["context_refs"], ensure_ascii=False)
        active = self.latest_run(exp)
        if active and active["status"] in {"queued", "running"}:
            if not body.get("interrupt"):
                raise ValueError("Worker is busy; interrupt it before starting another message")
            self.runner.cancel(active["id"])
            self.runner.wait(active["id"], timeout=10)
        thread = self.store.get_thread(exp["worker"])
        run = self.runner.start(exp["worker"], prompt, model="" if thread["worker_model"] == "codex-default" else thread["worker_model"], instructions=self.worker_instructions(exp["worker"]))
        if client_id:
            self.hosted.set_meta(exp["worker"], **{"client:" + run["id"]: client_id})
            with self.store.connect() as db:
                db.execute("INSERT INTO hosted_worker_messages VALUES (?,?,?)", (exp["eid"], client_id, run["id"]))
        self.event(exp, "status_changed", status="running")
        self.event(exp, "worker_alive_changed", alive=True)
        return {"ok": True, "run_id": run["id"], "session_id": exp["worker"]}

    def document_route(self, h, method, path, body, query):
        ref = query.get("ref", [""])[0] if method == "GET" else body.get("ref", "")
        parts = ref.split(":", 2) if isinstance(ref, str) else []
        exp = self.get(parts[2], parts[1]) if len(parts) == 3 and parts[0] == "report" else None
        report = self.report(exp) if exp else None
        if not report:
            h.json(404, {"error": "Report document not found"})
            return True
        def failure(status, reason, message):
            h.json(status, {"detail": {"reason": reason, "message": message}})
        if path == "/api/docs/state" and method == "GET":
            h.json(200, {"ref": ref, "content": report["data"].decode("utf-8", errors="replace"),
                         "sha": hashlib.sha256(report["data"]).hexdigest(), "revision_id": report["revision"],
                         "can_edit": True, "owner_user_id": "local:dev"})
        elif path == "/api/docs/turn-diff" and method == "GET":
            # There are no proprietary data-eid block anchors in local reports.
            # Full immutable versions remain available through report sharing.
            h.json(200, {"etag": report["revision"], "hunks": [], "unavailable": True,
                         "reason": "Inline block review is unavailable for local reports; inspect the report and saved versions."})
        elif path == "/api/docs/turn-diff/resolve" and method == "POST":
            h.json(200, {"ok": True})
        elif path == "/api/docs/turn-diff/discard" and method == "POST":
            h.json(200, {"applied": False, "reason": "Restore a saved report version from Share instead."})
        elif path.startswith("/api/docs/lease") and method == "POST":
            if path.endswith("/release"):
                self.document_leases.pop(ref, None)
                h.json(200, {"ok": True})
            elif self.runner.is_active(exp["worker"]):
                failure(409, "worker_active", "Wait for the report worker to finish before editing.")
            elif path.endswith("/heartbeat") and self.document_leases.get(ref, 0) < time.monotonic():
                failure(409, "lease_lost", "The local editing lease expired.")
            elif path in {"/api/docs/lease", "/api/docs/lease/heartbeat"}:
                self.document_leases[ref] = time.monotonic() + 120
                h.json(200, {"ok": True, "expires_in": 120})
            else:
                return False
        elif path == "/api/docs/edits" and method == "POST":
            if self.runner.is_active(exp["worker"]):
                failure(409, "worker_active", "Wait for the report worker to finish before saving.")
            elif self.document_leases.get(ref, 0) < time.monotonic():
                failure(409, "lease_lost", "Start an editing session before saving.")
            elif body.get("base_sha") != hashlib.sha256(report["data"]).hexdigest():
                failure(409, "stale_base", "The report changed since editing began.")
            elif not isinstance(body.get("content"), str):
                failure(422, "structural", "Local reports support full-document text saves; block operations are unavailable.")
            elif len(body["content"].encode()) > 5 * 1024 * 1024:
                failure(413, "edit_failed", "Edited reports are limited to 5 MiB.")
            else:
                content = body["content"]
                try:
                    data = MarkdownContent.extract(content) if report["entry"].endswith(".md") else content.encode()
                except ValueError as exc:
                    failure(422, "structural", str(exc))
                    return True
                self.save_version(exp, "Before direct edit")
                self.write_report(exp, report["entry"], data)
                self.hosted.set_meta(exp["worker"], report_revision_override=None, report_deleted=False)
                version = self.save_version(exp, "Direct edit")
                revised = self.report(exp)
                self.event(exp, "result_page_revised")
                self.hosted.emit(exp["worker"], "direct-edit:" + revised["revision"],
                                 {"type": "artifact_revision", "revision_id": revised["revision"], "artifact_id": exp["eid"]})
                h.json(200, {"sha": hashlib.sha256(revised["data"]).hexdigest(), "version": version})
        else:
            return False
        return True

    def write_report(self, exp, relative, content):
        """Atomic no-follow replacement in an existing registered report directory."""
        self.store.file_path(exp["worker"], relative)
        parts = Path(relative).parts
        directory = os.open(self.store.thread_path(exp["worker"]), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        temp = ".rea-edit-" + uuid.uuid4().hex
        try:
            for part in parts[:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory)
                directory = child
            descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, parts[-1], src_dir_fd=directory, dst_dir_fd=directory)
        finally:
            try:
                os.unlink(temp, dir_fd=directory)
            except FileNotFoundError:
                pass
            os.close(directory)
        self.store.register_file(exp["worker"], relative, kind="artifact")

    def route(self, h, method, path, body):
        query = parse_qs(urlsplit(h.path).query)
        path = unquote(path)
        host = getattr(h, "headers", {}).get("Host", "")
        if re.fullmatch(r"(?:127\.0\.0\.1|localhost):\d+", host):
            self.base_url = "http://" + host
        def q(key, default=""):
            return query.get(key, [default])[0]
        if path.startswith("/api/docs/"):
            features = getattr(self.hosted, "thread_features", None)
            with features.lock if features else nullcontext(), self.lock:
                return self.document_route(h, method, path, body, query)
        stream_match = re.fullmatch(r"/api/workspaces/([^/]+)/events", path)
        if stream_match and method == "GET":
            self.workspace_stream(h, stream_match[1], int(q("after", "0")))
            return True
        if path == "/api/feed/file" and method in {"GET", "HEAD"}:
            item, actual = self.resolve_file(q("path"))
            headers = {"Content-Security-Policy": "sandbox"}
            if q("download") == "true":
                headers["Content-Disposition"] = "attachment; filename*=UTF-8''" + quote(actual.name)
            self.send_bytes(h, self.read_file(item), item["media_type"], headers)
            return True
        if path == "/api/papers" and method == "GET":
            h.json(200, self.papers())
            return True
        if path == "/api/library/artifacts" and method == "GET":
            artifacts = []
            for exp in self.store._all("SELECT * FROM hosted_experiments WHERE deleted=0"):
                artifact = self.library_artifact(exp)
                if not artifact:
                    continue
                if query.get("kind") and artifact["kind"] not in query["kind"]:
                    continue
                if query.get("visibility") and artifact["visibility"] not in query["visibility"]:
                    continue
                if q("q").casefold() not in artifact["title"].casefold() or q("scope") == "shared":
                    continue
                artifacts.append(artifact)
            artifacts.sort(key=lambda item: item["updated_at"], reverse=True)
            h.json(200, {"artifacts": artifacts, "next_cursor": None, "truncated": False})
            return True
        match = re.fullmatch(r"/api/library/reports/([^/]+)", path)
        if match and method == "GET":
            row = self.store._one("SELECT eid FROM hosted_report_sharing WHERE pub_id=?", (match[1],))
            exp = self.get(row["eid"]) if row else None
            if not exp or not self.report(exp):
                h.json(404, {"error": "Report not found"})
            else:
                h.json(200, {"artifact_id": exp["eid"], "is_owner": True})
            return True
        match = re.fullmatch(r"/api/library/artifacts/([^/]+)(?:/(app))?", path)
        if match and method in {"GET", "DELETE"}:
            exp = self.get(match[1])
            artifact = self.library_artifact(exp) if exp else None
            if not artifact:
                h.json(404, {"error": "Artifact not found"})
            elif method == "DELETE":
                self.hosted.set_meta(exp["worker"], report_deleted=True)
                with self.store.connect() as db:
                    db.execute("DELETE FROM hosted_report_sharing WHERE eid=?", (exp["eid"],))
                self.event(exp, "result_page_revised")
                h.json(200, {"ok": True})
            elif match[2] == "app":
                publication = self.sharing(exp)["publication"]
                url = publication["url"] if publication else f"/api/workspaces/{exp['workspace']}/experiments/{exp['eid']}/app/"
                h.json(200, {"kind": "app", "url": url})
            else:
                h.json(200, artifact)
            return True
        match = re.fullmatch(r"/api/papers/discovery/threads/([^/]+)/inventory", path)
        if match and method == "GET":
            thread = self.store.get_thread(match[1])
            experiments = self.store._all("SELECT * FROM hosted_experiments WHERE parent=? AND deleted=0", (match[1],))
            h.json(200, [{"kind": "thread", "id": match[1], "label": thread["title"], "diagrams": [],
                          "experiments": [{"eid": e["eid"], "number": e["display_label"], "exp_title": e["title"]} for e in experiments]}] if thread else [])
            return True
        match = re.fullmatch(r"/api/local-publications/([^/]+)(?:/(.*))?", path)
        if match and method in {"GET", "HEAD"}:
            row = self.store._one("SELECT v.html,v.archive,v.entry FROM hosted_report_sharing s JOIN hosted_report_versions v ON v.id=s.revision_id JOIN hosted_experiments e ON e.eid=s.eid WHERE s.pub_id=? AND s.visibility='link' AND e.deleted=0", (match[1],))
            if not row:
                h.json(404, {"error": "Publication not found"})
            else:
                data, media_type = row["html"], "text/html; charset=utf-8"
                asset = match[2]
                if asset:
                    if ".." in Path(asset).parts or Path(asset).is_absolute():
                        raise ValueError("Invalid publication asset")
                    asset = str(Path(row["entry"]).parent / asset)
                    with zipfile.ZipFile(io.BytesIO(row["archive"])) as archive:
                        try:
                            data = archive.read(asset)
                        except KeyError as exc:
                            raise FileNotFoundError("Publication asset not found") from exc
                    media_type = mimetypes.guess_type(asset)[0] or "application/octet-stream"
                self.send_bytes(h, data, media_type, {"Content-Security-Policy": "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'"})
            return True
        match = re.fullmatch(r"/api/papers/([^/]+)(?:/(publish|access))?", path)
        if match and method in {"POST", "DELETE"}:
            sharing = self.store._one("SELECT * FROM hosted_report_sharing WHERE pub_id=?", (match[1],))
            if not sharing:
                h.json(404, {"error": "Publication not found"})
            elif method == "DELETE":
                with self.store.connect() as db:
                    db.execute("DELETE FROM hosted_report_sharing WHERE pub_id=?", (match[1],))
                h.json(200, {"ok": True})
            else:
                exp = self.get(sharing["eid"])
                h.json(200, self.set_sharing(exp, {"visibility": "link"} if match[2] == "publish" else body))
            return True
        if path == "/api/experiments/recent" and method == "GET":
            rows = self.rows(q("workspace_id"))
            h.json(200, {"ok": True, "experiments": rows, "running": [r for r in rows if r["worker_alive"]], "completed": [r for r in rows if not r["worker_alive"]], "has_more": False})
            return True
        match = re.fullmatch(r"/api/artifact-sharing/([^/]+)", path)
        if match and method == "GET":
            exp = self.get(match[1])
            h.json(200, self.sharing(exp)) if exp else h.json(404, {"error": "Artifact not found"})
            return True
        if path == "/api/experiments/archive" and method == "POST":
            exp = self.get(body.get("eid"), body.get("repo"))
            if not exp:
                raise ValueError("Experiment not found")
            with self.store.connect() as db:
                db.execute("UPDATE hosted_experiments SET archived=1 WHERE eid=?", (exp["eid"],))
            h.json(200, {"ok": True})
            return True
        match = re.fullmatch(r"/api/workspaces/([^/]+)/(plan/submit|experiments|experiment-preferences)", path)
        if match:
            ws, action = match.groups()
            if action == "plan/submit" and method == "POST":
                exp = self.launch(ws, body)
                h.json(200, {"ok": True, "eid": exp["eid"], "display_label": exp["display_label"]})
            elif action == "experiments" and method == "GET":
                rows = self.rows(ws)
                h.json(200, {"ok": True, "running": [r for r in rows if r["worker_alive"]], "completed": [r for r in rows if not r["worker_alive"]]})
            elif action == "experiment-preferences" and method == "GET":
                h.json(200, {"ok": True, "preferences": {}, "archived_eids": []})
            else:
                return False
            return True
        match = re.fullmatch(r"/api/(?:slurm|wandb)/experiment/([^/]+)/([^/]+)/(jobs|metrics)", path)
        if match and method == "GET":
            h.json(200, {"jobs": [], "discovered_jobs": 0} if match[3] == "jobs" else {"available": False, "runs": [], "reason": "This local workspace is not connected to W&B", "series": {}, "key_metrics": []})
            return True
        match = re.fullmatch(r"/api/worker/([^/]+)/([^/]+)/(.*)", path)
        if match:
            exp = self.get(match[2], match[1])
            if not exp:
                h.json(404, {"error": "Worker not found"})
                return True
            action = match[3]
            if action in {"feed", "transcript", "artifact-chat/transcript"} and method == "GET":
                snap = self.hosted.snapshot(exp["worker"], int(q("offset", "0")))
                snap.update(session_id=exp["worker"], source="buffer", alive=self.status(exp) == "running", mode="append", rewind_generation=0)
                h.json(200, snap)
            elif action in {"message", "artifact-chat/handoff"} and method == "POST":
                if action == "artifact-chat/handoff" and body.get("kind") == "planning":
                    run = self.hosted.send(exp["parent"], body.get("message", ""), body.get("client_message_id"))
                    h.json(200, {"ok": True, "outcome": "sent", "session_id": exp["parent"], "run_id": run["id"]})
                else:
                    h.json(200, self._resume(exp, body))
            elif action in {"artifact-chat", "edit-session"} and method == "POST":
                if not self.report(exp):
                    raise ValueError("This experiment has no report to review or edit yet")
                meta = self.hosted.get_meta(exp["worker"])
                self.hosted.set_meta(exp["worker"], artifact_chat_open=True, artifact_edit_mode=action == "edit-session")
                h.json(200, {"ok": True, "session_id": exp["worker"], "artifact_id": exp["eid"], "repo": exp["workspace"],
                             "doc_ref": f"report:{exp['workspace']}:{exp['eid']}", "reused": bool(meta.get("artifact_chat_open"))})
            elif action == "edit-session" and method == "DELETE":
                self.hosted.set_meta(exp["worker"], artifact_chat_open=False, artifact_edit_mode=False)
                h.json(200, {"ok": True})
            elif action == "interrupt" and method == "POST":
                run = self.latest_run(exp)
                if run:
                    self.runner.cancel(run["id"])
                h.json(200, {"ok": True})
            elif action == "model" and method == "POST":
                model = body.get("model", "")
                if model and (not isinstance(model, str) or not MODEL.fullmatch(model)):
                    raise ValueError("Invalid model")
                model = "" if model == "codex-default" else model
                self.store.update_thread(exp["worker"], worker_model=model, planner_model=model)
                h.json(200, {"ok": True, "model": model})
            else:
                return False
            return True
        match = re.fullmatch(r"/api/workspaces/([^/]+)/experiments/([^/]+)(?:/(.*))?", path)
        if not match:
            return False
        exp = self.get(match[2], match[1])
        if not exp:
            h.json(404, {"error": "Experiment not found"})
            return True
        action = match[3] or ""
        if method == "GET" and action == "feed":
            points = self.checkpoints(exp)
            after = q("after")
            h.json(200, {"feed": [p for p in points if not after or p["timestamp"] > after], "worker_alive": self.status(exp) == "running", "background_tasks": [], "fabric_id": "local"})
        elif method == "GET" and action == "latest-completion":
            h.json(200, next((p for p in reversed(self.checkpoints(exp)) if p["type"] == "completion"), {}))
        elif method == "GET" and action == "status":
            h.json(200, self.row(exp))
        elif method == "GET" and action == "changeset":
            h.json(200, self.changeset(exp))
        elif method == "GET" and action == "file-diff":
            h.json(200, self.file_diff(exp, q("path"), q("checkpoint") or None))
        elif method == "GET" and action == "checkpoint-delta":
            h.json(200, self.delta(exp, int(q("checkpoint", "0"))))
        elif method in {"GET", "HEAD"} and (action == "app" or action.startswith("app/")):
            self.serve_report(h, exp, action[4:] if action.startswith("app/") else "")
        elif method in {"GET", "HEAD"} and action == "app-download":
            revision = q("revision_id")
            saved = self.store._one("SELECT archive FROM hosted_report_versions WHERE eid=? AND (id=? OR id=?)", (exp["eid"], revision, exp["eid"] + "-" + revision)) if revision else None
            if revision and not saved:
                raise ValueError("Unknown report revision")
            report = self.report(exp)
            if not saved and not report:
                raise ValueError("No report produced yet")
            self.send_bytes(h, saved["archive"] if saved else self.archive(exp, report), "application/zip", {"Content-Disposition": 'attachment; filename="research-report.zip"'})
        elif action == "artifacts/primary/sharing" and method in {"GET", "PUT"}:
            h.json(200, self.sharing(exp) if method == "GET" else self.set_sharing(exp, body))
        elif action == "artifacts/primary/versions" and method == "POST":
            self.save_version(exp, body.get("label"))
            h.json(200, self.sharing(exp))
        elif action == "rename" and method == "POST":
            title = body.get("title")
            if not isinstance(title, str) or not title.strip():
                raise ValueError("Title required")
            with self.store.connect() as db:
                db.execute("UPDATE hosted_experiments SET title=? WHERE eid=?", (title.strip()[:200], exp["eid"]))
            self.event(exp, "experiment_renamed", title=title.strip()[:200])
            h.json(200, {"ok": True})
        elif action == "stop" and method == "POST":
            run = self.latest_run(exp)
            if run:
                self.runner.cancel(run["id"])
            h.json(200, {"ok": True})
        elif action == "resume" and method == "POST":
            h.json(200, self._resume(exp, body))
        elif action == "outcome" and method in {"POST", "PUT"}:
            # Local HTTP extension; observed original classification is an MCP tool.
            outcome = body.get("outcome")
            if outcome is not None and (not isinstance(outcome, str) or outcome not in {"null", "signal", "partial_signal", "inconclusive"}):
                raise ValueError("Outcome must be null, signal, partial_signal, or inconclusive")
            with self.store.connect() as db:
                db.execute("UPDATE hosted_experiments SET outcome=? WHERE eid=?", (outcome, exp["eid"]))
            self.event(exp, "outcome_changed", outcome=outcome)
            h.json(200, {"ok": True, "outcome": outcome})
        elif not action and method == "DELETE":
            if self.status(exp) == "running":
                raise ValueError("Stop the experiment before deleting it")
            with self.store.connect() as db:
                db.execute("UPDATE hosted_experiments SET deleted=1 WHERE eid=?", (exp["eid"],))
            self.event(exp, "experiment_deleted")
            h.json(200, {"ok": True})
        else:
            return False
        return True
