"""Independent local forks of observed transcript and registered file state.

Recovered wire contract: hosted frontend formatted lines 98929 and 122767.
Historical executions are copied with provenance, never rerun or represented as
new executions. Provider session IDs are cleared before any continuation.
"""

import json
import os
import re
import threading
import uuid
from contextlib import nullcontext
from urllib.parse import quote, unquote

from .store import now


def new_id(prefix):
    return prefix + "0" + uuid.uuid4().hex[:25]


class ForkService:
    def __init__(self, hosted):
        self.hosted, self.store = hosted, hosted.store
        self.lock = threading.RLock()
        with self.store.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS hosted_fork_jobs (
                    id TEXT PRIMARY KEY, source_workspace TEXT NOT NULL,
                    source_thread TEXT NOT NULL, destination TEXT NOT NULL,
                    created_at TEXT NOT NULL, data TEXT NOT NULL);
            """)

    def _job(self, job_id, **changes):
        with self.store.connect() as db:
            row = db.execute("SELECT data FROM hosted_fork_jobs WHERE id=?", (job_id,)).fetchone()
            data = json.loads(row[0])
            data.update(changes)
            db.execute("UPDATE hosted_fork_jobs SET data=? WHERE id=?", (json.dumps(data), job_id))
        return data

    def _snapshot(self, source, cursor_event=None, cursor_turn=None):
        self.hosted.sync(source)
        rows = self.store._all("SELECT * FROM hosted_events WHERE session=? ORDER BY id", (source,))
        for row in rows:
            row["event"] = json.loads(row["data"])
        index = None
        if cursor_event:
            index = next(
                (
                    i
                    for i, row in enumerate(rows)
                    if cursor_event in {row["event"].get("id"), row["source"], str(row["id"])}
                ),
                None,
            )
            if index is None:
                raise ValueError("Fork message was not found; reload this thread")
        elif cursor_turn:
            matches = [i for i, row in enumerate(rows) if row["event"].get("turn_id") == cursor_turn]
            if not matches:
                raise ValueError("Fork turn was not found; reload this thread")
            index = matches[-1]
        if index is not None:
            rows = rows[: index + 1]
            cutoff = rows[-1]["event"].get("timestamp")
        else:
            cutoff = None
        return rows, cutoff

    def start(self, source_workspace, source_thread, body):
        features = getattr(self.hosted, "thread_features", None)
        with features.lock if features else nullcontext(), self.lock:
            source = self.store.get_thread(source_thread)
            if not source or source["workspace_id"] != source_workspace:
                raise ValueError("Source thread is not in this workspace")
            destination = body.get("workspace_id") or source_workspace
            if not any(w["id"] == destination for w in self.store.list_workspaces()):
                raise ValueError("Destination workspace not found")
            rows, cutoff = self._snapshot(source_thread, body.get("cursor_event_id"), body.get("cursor_turn_id"))
            job_id = "fork_" + uuid.uuid4().hex
            initial = {
                "done": False,
                "stage": "copying",
                "files_done": 0,
                "files_total": 0,
                "bytes_done": 0,
                "bytes_total": 0,
            }
            with self.store.connect() as db:
                db.execute(
                    "INSERT INTO hosted_fork_jobs VALUES (?,?,?,?,?,?)",
                    (job_id, source_workspace, source_thread, destination, now(), json.dumps(initial)),
                )
            try:
                result = self._copy(job_id, source, destination, rows, cutoff)
                self._job(job_id, done=True, stage="complete", result=result)
            except Exception as exc:
                for thread in self.store.list_threads():
                    if self.hosted.get_meta(thread["id"]).get("fork_job_id") == job_id:
                        with self.store.connect() as db:
                            db.execute(
                                "UPDATE hosted_experiments SET deleted=1 WHERE worker=? OR parent=?",
                                (thread["id"], thread["id"]),
                            )
                        self.store.delete_thread(thread["id"])
                self._job(job_id, done=True, stage="failed", error=str(exc))
            return {"job_id": job_id}

    def _copy(self, job_id, source, destination, parent_events, cutoff):
        experiments = self.store._all(
            "SELECT * FROM hosted_experiments WHERE parent=? AND deleted=0 ORDER BY display_label", (source["id"],)
        )
        if cutoff:
            experiments = [e for e in experiments if e["created_at"] <= cutoff]
        sources = [source] + [self.store.get_thread(e["worker"]) for e in experiments]
        sources = [s for s in sources if s]
        thread_map, exp_map, run_map, message_map, native_map = {}, {}, {}, {}, {}
        path_map, source_events, selected_runs = {}, {}, {}
        for thread in sources:
            title = ("Fork of " + thread["title"]) if thread["id"] == source["id"] else thread["title"]
            target = self.store.create_thread(
                destination,
                title,
                planner_model=thread["planner_model"],
                worker_model=thread["worker_model"],
                thread_id=new_id("th_"),
            )
            thread_map[thread["id"]] = target["id"]
            self.hosted.set_meta(target["id"], fork_job_id=job_id, fork_incomplete=True)
            path_map[str(self.store.thread_path(thread["id"]))] = str(self.store.thread_path(target["id"]))
            path_map["/workspace-files/" + thread["id"]] = "/workspace-files/" + target["id"]
            events, _ = (parent_events, cutoff) if thread["id"] == source["id"] else self._snapshot(thread["id"])
            source_events[thread["id"]] = events
            limit = cutoff if thread["id"] == source["id"] else None
            selected_runs[thread["id"]] = [
                r for r in self.store.list_runs(thread["id"]) if not limit or r["created_at"] <= limit
            ]
            for run in selected_runs[thread["id"]]:
                run_map[run["id"]] = str(uuid.uuid4())
        for exp in experiments:
            exp_map[exp["eid"]] = new_id("exp_")
        replacement = {**thread_map, **exp_map, **run_map, **path_map}
        # Encoded file URLs occur in rendered assistant text.
        replacement.update({quote(k, safe=""): quote(v, safe="") for k, v in path_map.items()})

        def rewrite(value):
            if isinstance(value, dict):
                return {key: rewrite(item) for key, item in value.items()}
            if isinstance(value, list):
                return [rewrite(item) for item in value]
            if isinstance(value, str):
                for old, new in sorted(replacement.items(), key=lambda pair: len(pair[0]), reverse=True):
                    value = value.replace(old, new)
            return value

        # Copy actual durable records, with new application IDs and no provider
        # resume identity. Active source executions become stopped snapshots.
        for thread in sources:
            old, target = thread["id"], thread_map[thread["id"]]
            limit = cutoff if old == source["id"] else None
            with self.store.connect() as db:
                for run in selected_runs[old]:
                    cloned = dict(run)
                    cloned.update(id=run_map[run["id"]], thread_id=target, provider_thread_id=None)
                    if (
                        run["status"] in {"queued", "running"}
                        or limit
                        and (not run["finished_at"] or run["finished_at"] > limit)
                    ):
                        cloned.update(status="interrupted", finished_at=now(), final_text="", error=None)
                    columns = list(cloned)
                    db.execute(
                        "INSERT INTO runs (" + ",".join(columns) + ") VALUES (" + ",".join("?" for _ in columns) + ")",
                        tuple(cloned.values()),
                    )
                    for event in self.store._all("SELECT * FROM run_events WHERE run_id=? ORDER BY id", (run["id"],)):
                        if limit and event["created_at"] > limit:
                            continue
                        cursor = db.execute(
                            "INSERT INTO run_events(run_id,kind,payload_json,created_at) VALUES (?,?,?,?)",
                            (
                                cloned["id"],
                                event["kind"],
                                json.dumps(rewrite(json.loads(event["payload_json"]))),
                                event["created_at"],
                            ),
                        )
                        native_map[event["id"]] = cursor.lastrowid
                for message in self.store.list_messages(old):
                    if limit and message["created_at"] > limit:
                        continue
                    if message["run_id"] and message["run_id"] not in run_map:
                        continue
                    message_id = str(uuid.uuid4())
                    message_map[message["id"]] = message_id
                    db.execute(
                        "INSERT INTO messages VALUES (?,?,?,?,?,?)",
                        (
                            message_id,
                            target,
                            run_map.get(message["run_id"]),
                            message["role"],
                            rewrite(message["content"]),
                            message["created_at"],
                        ),
                    )
            meta = self.hosted.get_meta(old)
            safe = {
                k: rewrite(meta[k])
                for k in (
                    "kind",
                    "private",
                    "role_models",
                    "source_inputs",
                    "plan",
                    "plan_phase",
                    "last_plan_digest",
                    "last_report_revision",
                    "report_deleted",
                )
                if k in meta
            }
            if (
                limit
                and meta.get("plan")
                and not any(row["event"].get("plan_id") == meta["plan"].get("plan_id") for row in source_events[old])
            ):
                safe.update(plan=None, plan_phase=None)
            safe.update(
                auto_accept=False,
                forked_from=old,
                fork_job_id=job_id,
                fork_cutoff=limit,
                fork_run_provenance={
                    run_map[r["id"]]: {"source_run_id": r["id"], "source_status": r["status"]}
                    for r in selected_runs[old]
                },
            )
            self.hosted.set_meta(target, **safe)

        labels = {}
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            label = db.execute(
                "SELECT COALESCE(MAX(display_label),0) FROM hosted_experiments WHERE workspace=?", (destination,)
            ).fetchone()[0]
            for exp in experiments:
                label += 1
                labels[exp_map[exp["eid"]]] = label
                db.execute(
                    "INSERT INTO hosted_experiments(eid,workspace,parent,worker,plan_id,title,body,display_label,created_at,outcome) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (
                        exp_map[exp["eid"]],
                        destination,
                        thread_map[source["id"]],
                        thread_map[exp["worker"]],
                        rewrite(exp["plan_id"]),
                        exp["title"],
                        rewrite(exp["body"]),
                        label,
                        exp["created_at"],
                        exp.get("outcome"),
                    ),
                )
                for checkpoint in db.execute("SELECT * FROM hosted_checkpoints WHERE eid=?", (exp["eid"],)).fetchall():
                    db.execute(
                        "INSERT INTO hosted_checkpoints VALUES (?,?,?,?)",
                        (
                            exp_map[exp["eid"]],
                            checkpoint["sequence"],
                            run_map.get(checkpoint["run_id"]),
                            json.dumps(rewrite(json.loads(checkpoint["data"]))),
                        ),
                    )
                for snapshot in db.execute("SELECT * FROM hosted_file_snapshots WHERE eid=?", (exp["eid"],)).fetchall():
                    db.execute(
                        "INSERT INTO hosted_file_snapshots VALUES (?,?,?,?,?)",
                        (
                            exp_map[exp["eid"]],
                            snapshot["sequence"],
                            snapshot["path"],
                            snapshot["text"],
                            snapshot["sha256"],
                        ),
                    )
                for version in db.execute("SELECT * FROM hosted_report_versions WHERE eid=?", (exp["eid"],)).fetchall():
                    db.execute(
                        "INSERT INTO hosted_report_versions(id,eid,html,archive,label,created_at,entry) VALUES (?,?,?,?,?,?,?)",
                        (
                            rewrite(version["id"]),
                            exp_map[exp["eid"]],
                            version["html"],
                            version["archive"],
                            version["label"],
                            version["created_at"],
                            version["entry"],
                        ),
                    )

        files = [(thread["id"], item) for thread in sources for item in self.store.list_files(thread["id"])]
        self._job(job_id, files_total=len(files), bytes_total=sum(item["size"] for _, item in files))
        summary, total = {"copied": 0, "unavailable": 0, "omitted": 0, "items": []}, 0
        for number, (old, item) in enumerate(files, 1):
            target = thread_map[old]
            record = {"label": item["path"], "source_thread": old, "path": item["path"]}
            try:
                if item["size"] > 64 * 1024 * 1024 or total + item["size"] > 128 * 1024 * 1024:
                    raise ValueError("Local fork size limit")
                with self.store.open_file(old, item["path"]) as stream:
                    before = os.fstat(stream.fileno())
                    data = stream.read(64 * 1024 * 1024 + 1)
                    after = os.fstat(stream.fileno())
                if (
                    len(data) > 64 * 1024 * 1024
                    or total + len(data) > 128 * 1024 * 1024
                    or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns)
                ):
                    raise ValueError("Source file changed during copy")
                destination_file = self.store.file_path(target, item["path"])
                destination_file.parent.mkdir(parents=True, exist_ok=True)
                with destination_file.open("xb") as stream:
                    stream.write(data)
                self.store.register_file(target, item["path"], run_map.get(item["run_id"]), item["kind"])
                total += len(data)
                summary["copied"] += 1
                record["status"] = "copied"
            except (OSError, ValueError) as exc:
                summary["unavailable"] += 1
                record.update(status="unavailable", reason="file_not_copied", detail=str(exc))
            summary["items"].append(record)
            self._job(job_id, files_done=number, bytes_done=total)

        # Preserve the original rendered ordering and use the same projection
        # keys that HostedAPI.sync will produce for the copied native records.
        for old, events in source_events.items():
            target = thread_map[old]
            for row in events:
                key = row["source"]
                if key.startswith("provider:"):
                    mapped = native_map.get(int(key.split(":", 1)[1]))
                    if mapped is None:
                        continue
                    key = "provider:" + str(mapped)
                elif key.startswith("message:"):
                    mapped = message_map.get(key.split(":", 1)[1])
                    if mapped is None:
                        continue
                    key = "message:" + mapped
                else:
                    key = rewrite(key)
                event = rewrite(row["event"])
                event.setdefault("id", "fork:" + str(row["id"]))
                experiment = event.get("experiment_eid", event.get("eid"))
                if experiment in labels and "display_label" in event:
                    event["display_label"] = labels[experiment]
                self.hosted.emit(target, key, event)

        parent = thread_map[source["id"]]
        transcript = (
            "# Copied research context\n\nThis is historical evidence from a fork; these runs were not executed again. "
        )
        transcript += "Files are captured at fork time, not reconstructed historical versions. Continue in this independent workspace.\n\n"
        transcript += "Source thread: " + source["id"] + "\nSelected cutoff: " + str(cutoff or "latest") + "\n\n"
        for row in parent_events:
            event = rewrite(row["event"])
            transcript += "```json\n" + json.dumps(event, ensure_ascii=False) + "\n```\n\n"
        transcript += "## Copy manifest\n\n```json\n" + json.dumps(summary, ensure_ascii=False) + "\n```\n"
        context_file = "fork-context-" + job_id[5:13] + ".md"
        self.store.file_path(parent, context_file).write_text(transcript)
        self.store.register_file(parent, context_file, kind="context")
        self.hosted.set_meta(parent, fork_context_file=context_file, fork_copy_summary=summary)
        for original in sources:
            target = thread_map[original["id"]]
            if target != parent:
                worker_context = "# Historical worker context\n\nThis independent fork contains actual historical evidence; no execution was repeated during copying.\n\n"
                worker_context += "\n\n".join(
                    "```json\n" + json.dumps(rewrite(row["event"]), ensure_ascii=False) + "\n```"
                    for row in source_events[original["id"]]
                )
                self.store.file_path(target, context_file).write_text(worker_context)
                self.store.register_file(target, context_file, kind="context")
                self.hosted.set_meta(target, fork_context_file=context_file, fork_copy_summary=summary)
            self.store.update_thread(target, provider_thread_id=None)
            self.hosted.set_meta(target, fork_incomplete=False)
        return {
            "thread_id": parent,
            "session_uuid": parent,
            "workspace_id": destination,
            "path": f"/workspace/{destination}/thread/{parent}",
            "copy_summary": summary,
        }

    def context(self, session):
        thread = self.store.get_thread(session)
        if not thread or thread["provider_thread_id"]:
            return ""
        meta = self.hosted.get_meta(session)
        filename = meta.get("fork_context_file")
        if not filename:
            return ""
        return (
            "This is an independent fork of an existing research conversation. Before answering, read "
            + filename
            + " for the exact historical transcript and file-copy manifest. Historical runs are source evidence, not newly executed work. "
            "The provider session was reset deliberately. Use the copied local files and continue the user's request; do not repeat the original task unless asked."
        )

    def route(self, h, method, path, body):
        match = re.fullmatch(r"/api/workspaces/([^/]+)/threads/([^/]+)/fork(?:/([^/]+))?", unquote(path))
        if not match:
            return False
        workspace, thread, job_id = match.groups()
        if method == "POST" and not job_id:
            h.json(200, self.start(workspace, thread, body))
        elif method == "GET" and job_id:
            job = self.store._one(
                "SELECT * FROM hosted_fork_jobs WHERE id=? AND source_workspace=? AND source_thread=?",
                (job_id, workspace, thread),
            )
            h.json(200, json.loads(job["data"])) if job else h.json(404, {"error": "Fork job not found"})
        else:
            return False
        return True
