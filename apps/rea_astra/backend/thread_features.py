"""Persistent local thread workflows for the recovered hosted client.

Wire evidence: index.formatted.js 45830–45990 (queue/decision), 46000–46090
(story), 46169 (review), 98895–98930 (sharing), 101761 (export), 124926
(story entry schema). Exact hosted .sil archives and provider rewind are not
reconstructed; exports are explicitly documented ZIP archives instead.
"""

import io
import json
import re
import threading
import uuid
import zipfile

from .store import now
from .runner import redact


class Service:
    def __init__(self, hosted, *, dispatch=True):
        self.hosted, self.store, self.runner = hosted, hosted.store, hosted.runner
        self.lock = threading.RLock()
        self.closed = threading.Event()
        with self.store.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS hosted_queue (
                    id TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                    client_id TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL,
                    created_at TEXT NOT NULL, run_id TEXT, error TEXT,
                    UNIQUE(session,client_id));
                CREATE TABLE IF NOT EXISTS hosted_story (
                    session TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                    id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session,id));
                CREATE TABLE IF NOT EXISTS hosted_story_notes (
                    session TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                    entry_id TEXT NOT NULL, text TEXT NOT NULL,
                    updated_at TEXT NOT NULL, PRIMARY KEY(session,entry_id));
            """)
        # A crash between provider dispatch and queue acknowledgement cannot be
        # blindly retried: inference might already have happened. Recover only
        # known client/run associations, otherwise leave a visible failure.
        for row in self.store._all("SELECT * FROM hosted_queue WHERE state='dispatching'"):
            meta = hosted.get_meta(row["session"])
            run_id = next((key[7:] for key, value in meta.items()
                           if key.startswith("client:") and value == row["client_id"]), None)
            self._update(row["id"], "sent" if run_id else "failed", run_id,
                         None if run_id else "Dispatch was interrupted; inspect the conversation before resending.")
        self.worker = None
        if dispatch:
            self.start()

    def start(self):
        """Start after HostedAPI has installed its completion callback."""
        with self.lock:
            if self.closed.is_set():
                raise ValueError("Message dispatcher is closed")
            if self.worker is None:
                self.worker = threading.Thread(target=self._loop, daemon=True, name="research-message-queue")
                self.worker.start()
        return self

    def close(self):
        self.closed.set()
        if self.worker:
            self.worker.join(timeout=2)

    def _thread(self, session, workspace=None):
        thread = self.store.get_thread(session)
        if not thread or (workspace is not None and thread["workspace_id"] != workspace):
            raise ValueError("Thread not found")
        return thread

    def _busy(self, session):
        active = getattr(self.runner, "is_active", lambda _: False)
        return active(session) or any(run["status"] in ("queued", "running") for run in self.store.list_runs(session))

    def _update(self, identifier, state, run_id=None, error=None):
        with self.store.connect() as db:
            db.execute("UPDATE hosted_queue SET state=?,run_id=?,error=? WHERE id=?",
                       (state, run_id, error, identifier))

    def queue(self, session):
        self._thread(session)
        return self.store._all("SELECT id,client_id,state,created_at,run_id,error FROM hosted_queue WHERE session=? ORDER BY rowid", (session,))

    def send(self, session, body):
        """Durably accept once per client id, then start real inference when free."""
        self._thread(session)
        prompt = body.get("message")
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 100000:
            raise ValueError("Message must contain 1–100000 characters")
        client_id = body.get("client_message_id") or "local_" + uuid.uuid4().hex
        if not isinstance(client_id, str) or len(client_id) > 200:
            raise ValueError("Invalid client message id")
        allowed = {key: body[key] for key in ("message", "display_text", "context_refs", "surface_context", "base_repo", "base_ref") if key in body}
        encoded = json.dumps(allowed, sort_keys=True)
        if len(encoded.encode()) > 200000:
            raise ValueError("Message context is too large")
        with self.lock, self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM hosted_queue WHERE session=? AND client_id=?", (session, client_id)).fetchone()
            if row:
                if row["body"] != encoded:
                    raise ValueError("Client message id was already used for different content")
            else:
                count = db.execute("SELECT COUNT(*) FROM hosted_queue WHERE session=? AND state IN ('pending','dispatching')", (session,)).fetchone()[0]
                if count >= 32:
                    raise ValueError("Thread message queue is full")
                identifier = "queue_" + uuid.uuid4().hex
                db.execute("INSERT INTO hosted_queue VALUES (?,?,?,?,?,?,NULL,NULL)",
                           (identifier, session, client_id, encoded, "pending", now()))
        self.drain(session)
        row = self.store._one("SELECT * FROM hosted_queue WHERE session=? AND client_id=?", (session, client_id))
        return {"ok": row["state"] not in ("failed", "cancelled"), "queued": row["state"] in ("pending", "dispatching"),
                "client_message_id": client_id, "run_id": row["run_id"], "error": row["error"], "queue_id": row["id"]}

    def drain(self, session=None):
        with self.lock:
            rows = self.store._all("SELECT * FROM hosted_queue WHERE state='pending' ORDER BY rowid")
            for row in rows:
                if session and session != row["session"]:
                    continue
                if self.closed.is_set() or self._busy(row["session"]):
                    continue
                # Folder deletion may remove a pending row after this scan. An
                # atomic claim lets deletion observe dispatching before files or
                # a provider process are touched, and skips vanished rows.
                with self.store.connect() as db:
                    claimed = db.execute("UPDATE hosted_queue SET state='dispatching' WHERE id=? AND state='pending'", (row["id"],)).rowcount
                if not claimed:
                    continue
                body = json.loads(row["body"])
                before = {run["id"] for run in self.store.list_runs(row["session"])}
                try:
                    run = self.hosted.send(row["session"], body["message"], row["client_id"], body)
                except ValueError as error:
                    if self._recover_started(row, body, before):
                        continue
                    if "capacity reached" in str(error) or "already active" in str(error):
                        self._update(row["id"], "pending")
                        continue
                    self._update(row["id"], "failed", error=str(error))
                except Exception as error:
                    if self._recover_started(row, body, before):
                        continue
                    self._update(row["id"], "failed", error=type(error).__name__ + ": queued dispatch failed")
                else:
                    self._update(row["id"], "sent", run["id"])
                updated = self.store._one("SELECT * FROM hosted_queue WHERE id=?", (row["id"],))
                if updated and updated["state"] == "failed":
                    self.hosted.emit(row["session"], "queue-error:" + row["id"],
                                     {"type": "error", "text": updated["error"], "client_message_id": row["client_id"]})

    def _recover_started(self, row, body, before):
        """Projection failure after start must not re-dispatch a delivered prompt."""
        meta = self.hosted.get_meta(row["session"])
        candidates = []
        for run in self.store.list_runs(row["session"]):
            if run["id"] in before:
                continue
            client = meta.get("client:" + run["id"])
            if client is not None and client != row["client_id"]:
                continue
            messages = [message for message in self.store.list_messages(row["session"])
                        if message["run_id"] == run["id"] and message["role"] == "user"]
            if client == row["client_id"] or any(message["content"] == body["message"] or message["content"].startswith(body["message"] + "\n\n") for message in messages):
                candidates.append(run)
        if len(candidates) != 1:
            return False
        run = candidates[0]
        self.hosted.set_meta(row["session"], **{"client:" + run["id"]: row["client_id"]})
        self._update(row["id"], "sent", run["id"])
        self.store.add_event(run["id"], "integration.warning", {"message": "Message delivered; conversation projection failed and will be retried on refresh."})
        return True

    def _loop(self):
        while not self.closed.wait(.4) and not self.hosted.closed.is_set():
            try:
                self.drain()
                self.launch_ready_plans()
            except Exception:
                # Database shutdown should not create an unbounded logging loop.
                if self.hosted.closed.is_set():
                    break

    def launch_ready_plans(self):
        """Launch approved automatic work only after planner finalization releases its slot."""
        launched = []
        with self.lock:
            for thread in self.store.list_threads():
                if self.closed.is_set() or self.hosted.closed.is_set():
                    break
                session = thread["id"]
                meta = self.hosted.get_meta(session)
                plan = meta.get("plan")
                if meta.get("kind") != "planner" or meta.get("auto_accept") is not True or meta.get("plan_phase") != "review" or not isinstance(plan, dict):
                    continue
                plan_id = plan.get("plan_id")
                if not plan_id or self._busy(session):
                    continue
                prior_error = meta.get("auto_accept_error")
                if isinstance(prior_error, dict) and prior_error.get("plan_id") == plan_id:
                    continue
                pending = self.store._one("SELECT 1 FROM hosted_queue WHERE session=? AND state IN ('pending','dispatching')", (session,))
                if pending:
                    continue
                try:
                    result = self.hosted.experiments.launch(thread["workspace_id"], {**plan, "session_uuid": session})
                except Exception as error:
                    if isinstance(error, ValueError) and "capacity reached" in str(error):
                        # The experiment service persists the same plan identity;
                        # a later tick resumes that reservation, never duplicates it.
                        continue
                    message = redact(str(error))[:1500] or type(error).__name__
                    self.hosted.set_meta(session, auto_accept_error={"plan_id": plan_id, "message": message, "timestamp": now()})
                    self.hosted.emit(session, "autoaccept-error:" + plan_id,
                                     {"type": "text", "text": "Automatic launch could not start: " + message + ". The plan remains available for review."})
                else:
                    self.hosted.set_meta(session, auto_accept_error=None)
                    launched.append(result)
        return launched

    def cancel_queued(self, session, client_id=None):
        self._thread(session)
        with self.lock, self.store.connect() as db:
            rows = db.execute("SELECT id,client_id FROM hosted_queue WHERE session=? AND state='pending'", (session,)).fetchall()
            selected = [row for row in rows if client_id is None or row["client_id"] == client_id]
            for row in selected:
                db.execute("UPDATE hosted_queue SET state='cancelled' WHERE id=?", (row["id"],))
        return [row["client_id"] for row in selected]

    def revise(self, session, feedback, client_id=None, context=None):
        # A very fast provider may finish during send(). Keep its projection
        # callback behind this update so it cannot lose the new review card.
        with self.lock, self.hosted.lock:
            return self._revise(session, feedback, client_id, context)

    def _revise(self, session, feedback, client_id=None, context=None):
        meta = self.hosted.get_meta(session)
        plan = meta.get("plan")
        if not plan:
            raise ValueError("No proposal is awaiting review")
        if not isinstance(feedback, str) or not feedback.strip():
            raise ValueError("Revision feedback is required")
        message = ("Revise the existing research proposal in research-plan.json using this feedback. "
                   "Write the revised proposal and explain the changes; do not execute the experiment yet.\n\n"
                   + "Current proposal: " + plan["title"] + "\n" + plan["body"] + "\n\nFeedback:\n" + feedback)
        result = self.send(session, {**(context or {}), "message": message, "client_message_id": client_id})
        if result["ok"]:
            self.hosted.set_meta(session, plan=None, plan_phase="writing")
            self.hosted.emit(session, "revised:" + plan["plan_id"],
                             {"type": "plan_ready", "plan_id": plan["plan_id"], "title": plan["title"], "plan": plan["body"], "revised": True})
        else:
            # A failed revision request must not silently approve the old plan.
            self.hosted.set_meta(session, auto_accept_error={"plan_id": plan["plan_id"],
                                 "message": "Revision did not start: " + (result.get("error") or "message cancelled"), "timestamp": now()})
        return result

    def decide(self, session, accept, feedback=""):
        thread = self._thread(session)
        if not isinstance(accept, bool):
            raise ValueError("accept must be a boolean")
        with self.lock:
            plan = self.hosted.get_meta(session).get("plan")
            if not plan:
                raise ValueError("No proposal is awaiting review")
            if accept:
                if self._busy(session):
                    raise ValueError("Wait for the planner to finish before accepting")
                return self.hosted.experiments.launch(thread["workspace_id"], {**plan, "session_uuid": session})
            if feedback:
                return self.revise(session, feedback)
            self.hosted.set_meta(session, plan=None, plan_phase=None)
            self.hosted.emit(session, "dismissed:" + plan["plan_id"],
                             {"type": "plan_dismissed", "plan_id": plan["plan_id"], "title": plan["title"]})
            return {"ok": True, "dismissed": True}

    def story(self, session):
        """Persist an extractive timeline of actual outputs, never invented findings."""
        thread = self._thread(session)
        runs = [(run, []) for run in self.store.list_runs(session)]
        for exp in self.store._all("SELECT * FROM hosted_experiments WHERE parent=? AND deleted=0", (session,)):
            runs.extend((run, ["exp:" + exp["eid"]]) for run in self.store.list_runs(exp["worker"]))
        with self.store.connect() as db:
            for run, refs in runs:
                if run["status"] in ("queued", "running"):
                    continue
                text = self._final_output(run) or run.get("error")
                if not text:
                    continue
                # Preserve actual model language, with explicit provenance/status.
                text = self.hosted.render_text(run["thread_id"], text)
                if len(text) > 2400:
                    boundary = 2400
                    # Do not cut a resolved artifact link into a broken URL.
                    for match in re.finditer(r"\[[^\]]*\]\([^)]*\)", text):
                        if match.start() < boundary < match.end():
                            boundary = match.start()
                            break
                    text = text[:boundary].rstrip() + "…"
                entry = {"id": run["id"], "ts": run["finished_at"] or run["created_at"],
                         "text": run["status"].capitalize() + " · " + text, "refs": refs,
                         "tone": "neutral" if run["status"] == "completed" else "bad",
                         "source": "actual_run_output", "run_id": run["id"]}
                db.execute("INSERT OR REPLACE INTO hosted_story VALUES (?,?,?)", (session, run["id"], json.dumps(entry)))
            rows = db.execute("SELECT data FROM hosted_story WHERE session=?", (session,)).fetchall()
        entries = sorted((json.loads(row[0]) for row in rows), key=lambda item: (item["ts"], item["id"]))
        latest = entries[-1] if entries else None
        return {"ok": True, "entries": entries, "now": latest["text"] if latest else "",
                "brief": {"text": latest["text"], "updated_at": latest["ts"]} if latest else None,
                "summary_method": "extractive_actual_run_output", "title": thread["title"]}

    def _final_output(self, run):
        """Use the final completed response, not concatenated progress messages."""
        cursor, result = 0, None
        while True:
            events = self.store.list_events(run["id"], after=cursor, limit=1000)
            if not events:
                break
            for event in events:
                cursor = event["id"]
                payload = event["payload"]
                item = payload.get("item", {})
                if payload.get("type", event["kind"]) == "item.completed" and item.get("type") == "agent_message" and isinstance(item.get("text"), str):
                    result = item["text"]
            if len(events) < 1000:
                break
        return result if result is not None else run.get("final_text")

    def notes(self, session, entry_id=None, text=None):
        self._thread(session)
        if entry_id is not None:
            if not isinstance(entry_id, str) or not any(entry["id"] == entry_id for entry in self.story(session)["entries"]):
                raise ValueError("Unknown story entry")
            if not isinstance(text, str) or len(text) > 20000:
                raise ValueError("Note must contain at most 20000 characters")
            with self.store.connect() as db:
                if text:
                    db.execute("INSERT OR REPLACE INTO hosted_story_notes VALUES (?,?,?,?)", (session, entry_id, text, now()))
                else:
                    db.execute("DELETE FROM hosted_story_notes WHERE session=? AND entry_id=?", (session, entry_id))
        rows = self.store._all("SELECT entry_id,text FROM hosted_story_notes WHERE session=?", (session,))
        return {"ok": True, "notes": {row["entry_id"]: row["text"] for row in rows}}

    def export(self, session):
        thread = self._thread(session)
        experiments = self.store._all("SELECT * FROM hosted_experiments WHERE parent=? AND deleted=0", (session,))
        manifest = {"format": "rea-astra-thread-export-v1", "exported_at": now(), "thread": thread,
                    "experiments": experiments, "story": self.story(session), "notes": self.notes(session)["notes"],
                    "omitted": [], "threads": {}}
        output, total = io.BytesIO(), 0
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for identifier in [session] + [exp["worker"] for exp in experiments]:
                manifest["threads"][identifier] = {"messages": self.store.list_messages(identifier), "runs": self.store.list_runs(identifier)}
                for item in self.store.list_files(identifier):
                    path = item["path"]
                    reason = None
                    if path.startswith("uploads/") or item["kind"] == "attachment":
                        reason = "attached inputs excluded"
                    elif item["size"] > 10 * 1024 * 1024 or total + item["size"] > 32 * 1024 * 1024:
                        reason = "export size limit"
                    if reason is None:
                        try:
                            with self.store.open_file(identifier, path) as stream:
                                data = stream.read(10 * 1024 * 1024 + 1)
                            if len(data) > 10 * 1024 * 1024 or total + len(data) > 32 * 1024 * 1024:
                                reason = "export size limit"
                            else:
                                archive.writestr("files/" + identifier + "/" + path, data)
                                total += len(data)
                        except (ValueError, OSError):
                            reason = "file unavailable or unsafe"
                    if reason:
                        manifest["omitted"].append({"thread": identifier, "path": path, "reason": reason})
            archive.writestr("manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))
            archive.writestr("README.txt", "Local research export. This ZIP is not the proprietary Silico .sil format.\n"
                             "manifest.json contains actual conversations, run status, and experiment metadata.\n"
                             "files/ contains registered working artifacts; uploads and oversized files are omitted.\n")
        return output.getvalue()

    def route(self, h, method, path, body):
        body = body if isinstance(body, dict) else {}
        reply = lambda data, status=200: h.json(status, data)
        if path == "/api/plan/queue" and method == "GET":
            reply({"ok": True, "messages": self.queue(h.query.get("session", [""])[0])})
            return True
        if path.startswith("/api/plan/") and method == "POST":
            session = body.get("session")
            action = path.removeprefix("/api/plan/")
            if action not in ("send", "review-message", "decide", "cost-estimate", "cancel-queued", "interrupt", "answer"):
                return False
            self._thread(session)
            if action == "send":
                if body.get("interrupt"):
                    for run in self.store.list_runs(session):
                        if run["status"] in ("queued", "running"):
                            self.runner.cancel(run["id"])
                reply(self.send(session, body))
            elif action == "review-message":
                reply(self.revise(session, body.get("message"), body.get("client_message_id"), body))
            elif action == "decide":
                reply(self.decide(session, body.get("accept"), body.get("feedback", "")))
            elif action == "cost-estimate":
                reply({"ok": False, "estimate": None, "reason": "Local Codex billing and runtime estimates are unavailable; no Research Unit estimate is fabricated."})
            elif action == "cancel-queued":
                if not body.get("client_message_id"):
                    raise ValueError("client_message_id is required")
                cancelled = self.cancel_queued(session, body["client_message_id"])
                reply({"ok": bool(cancelled), "cancelled_queued": cancelled}, 200 if cancelled else 409)
            elif action == "interrupt":
                with self.lock:
                    cancelled = [] if body.get("preserve_queued") else self.cancel_queued(session)
                    for run in self.store.list_runs(session):
                        if run["status"] in ("queued", "running"):
                            self.runner.cancel(run["id"])
                reply({"ok": True, "cancelled_queued": cancelled})
            else:
                reply({"ok": False, "error": "This Codex executor has no pending interactive question. Send your answer as a normal message."}, 409)
            return True
        match = re.fullmatch(r"/api/workspaces/([^/]+)/threads/([^/]+)/(story|story-notes|story-backfill|rewind)", path)
        if match:
            workspace, session, action = match.groups()
            self._thread(session, workspace)
            if action == "rewind" and method == "POST":
                reply({"ok": False, "error": "Exact provider-history rewind is unavailable in Codex exec. Start a new thread to branch the research; existing files were not changed."}, 501)
            elif action == "story" and method == "GET":
                reply(self.story(session))
            elif action == "story-backfill" and method == "POST":
                story = self.story(session)
                reply({**story, "reason": None if story["entries"] else "no_history"})
            elif action == "story-notes" and method in ("GET", "POST"):
                if method == "POST":
                    if not body and h.body_bytes:
                        body = json.loads(h.body_bytes)
                    if not isinstance(body, dict) or "entry_id" not in body or "text" not in body:
                        raise ValueError("entry_id and text are required")
                    reply(self.notes(session, body["entry_id"], body["text"]))
                else:
                    reply(self.notes(session))
            else:
                return False
            return True
        match = re.fullmatch(r"/api/threads/([^/]+)/(export|shares|shared|org-access)", path)
        if match:
            session, action = match.groups()
            self._thread(session)
            if action == "export" and method in ("GET", "HEAD"):
                data = self.export(session)
                h.send_response(200)
                h.send_header("Content-Type", "application/zip")
                h.send_header("Content-Disposition", 'attachment; filename="research-thread.zip"')
                h.send_header("Content-Length", str(len(data)))
                h.end_headers()
                if method != "HEAD":
                    h.wfile.write(data)
            elif action == "shares" and method == "GET":
                reply({"ok": True, "shares": [], "org_access": "closed", "local_only": True})
            elif action == "org-access" and method == "PATCH" and body.get("org_access") == "closed":
                self.hosted.set_meta(session, private=True)
                reply({"ok": True, "org_access": "closed", "local_only": True})
            elif (action == "org-access" and method == "PATCH") or (action == "shared" and method == "POST"):
                reply({"ok": False, "error": "Team and public thread sharing require a remote service. This application is loopback-only; use Download a copy for a real local export."}, 501)
            else:
                return False
            return True
        return False
