"""Thread operations with real bounded Python subprocesses as provider fixtures."""

import io
import json
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path

from backend.hosted import HostedAPI
from backend.runner import RunManager
from backend.store import Store
from backend.thread_features import Service

FIXTURE = r"""
import json,pathlib,sys,time
prompt=sys.stdin.read()
time.sleep(.15)
print(json.dumps({"type":"thread.started","thread_id":"fixture-session"}),flush=True)
if "Revise the existing" in prompt:
    pathlib.Path("research-plan.json").write_text(json.dumps({"title":"Revised proposal", "body":"Compute the corrected measurement with Python."}))
pathlib.Path("result.txt").write_text("actual subprocess artifact")
print(json.dumps({"type":"item.completed","item":{"type":"agent_message","id":"answer","text":"Actual fixture output: " + prompt[-500:]}}),flush=True)
print(json.dumps({"type":"turn.completed","usage":{}}),flush=True)
"""


class Handler:
    body_bytes = b""

    def __init__(self):
        self.wfile = io.BytesIO()
        self.headers = {}

    def json(self, status, data):
        self.status, self.data = status, data

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.headers[key] = value

    def end_headers(self):
        pass


class ThreadFeatureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / "data")
        self.runner = RunManager(
            self.store, max_concurrent=1, command_factory=lambda *_: [sys.executable, "-c", FIXTURE]
        )
        self.hosted = HostedAPI(self.store, self.runner)
        # Parent integration may already create the service; keep one dispatcher.
        if hasattr(self.hosted, "thread_features"):
            self.hosted.thread_features.close()
        self.service = Service(self.hosted, dispatch=False)
        self.workspace = self.store.list_workspaces()[0]["id"]
        self.session = self.hosted.start_session(self.workspace, "", "Research")

    def tearDown(self):
        self.service.close()
        self.hosted.close()
        self.runner.shutdown()
        self.temp.cleanup()

    def call(self, path, body=None, method="POST"):
        h = Handler()
        self.assertTrue(self.service.route(h, method, path, body or {}))
        return h

    def finish(self, run_id):
        run = self.runner.wait(run_id, 10)
        self.assertEqual(run["status"], "completed", run.get("error"))
        return run

    def proposal(self):
        self.hosted.set_meta(
            self.session,
            plan={"plan_id": "plan_test", "title": "Measure values", "body": "Compute actual arithmetic."},
            plan_phase="review",
        )

    def test_durable_fifo_queue_and_idempotent_retries(self):
        first = self.service.send(self.session, {"message": "first", "client_message_id": "one"})
        second = self.service.send(self.session, {"message": "second", "client_message_id": "two"})
        self.assertTrue(second["queued"])
        self.assertEqual(
            self.service.send(self.session, {"message": "second", "client_message_id": "two"})["queue_id"],
            second["queue_id"],
        )
        self.service.close()
        self.service = Service(self.hosted, dispatch=False)
        self.finish(first["run_id"])
        self.service.drain()
        rows = self.service.queue(self.session)
        self.assertEqual([row["state"] for row in rows], ["sent", "sent"])
        self.finish(rows[1]["run_id"])
        self.assertEqual(
            [row["content"] for row in self.store.list_messages(self.session) if row["role"] == "user"],
            ["first", "second"],
        )
        self.assertFalse(self.service.send(self.session, {"message": "second", "client_message_id": "two"})["queued"])
        self.assertEqual(len(self.store.list_runs(self.session)), 2)
        with self.assertRaises(ValueError):
            self.service.send(self.session, {"message": "different", "client_message_id": "two"})

    def test_queue_cancel_never_runs_and_unknown_id_is_not_success(self):
        run = self.service.send(self.session, {"message": "first"})
        self.service.send(self.session, {"message": "cancel me", "client_message_id": "cancel"})
        result = self.call("/api/plan/cancel-queued", {"session": self.session, "client_message_id": "cancel"})
        self.assertEqual(result.data["cancelled_queued"], ["cancel"])
        self.finish(run["run_id"])
        self.service.drain()
        self.assertEqual(len(self.store.list_runs(self.session)), 1)
        self.assertEqual(
            self.call("/api/plan/cancel-queued", {"session": self.session, "client_message_id": "unknown"}).status, 409
        )

    def test_dispatcher_waits_for_global_capacity_and_drains_without_browser(self):
        other = self.hosted.start_session(self.workspace, "", "Other thread")
        first = self.service.send(self.session, {"message": "occupy the only slot"})
        second = self.service.send(other, {"message": "wait for capacity", "client_message_id": "waiting"})
        self.assertTrue(second["queued"])
        self.service.close()
        self.service = Service(self.hosted)
        self.finish(first["run_id"])
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            row = self.service.queue(other)[0]
            if row["run_id"]:
                break
            time.sleep(0.03)
        self.assertEqual(row["state"], "sent", row)
        self.finish(row["run_id"])
        self.assertIn("wait for capacity", self.store.list_messages(other)[-1]["content"])

    def test_proposal_revision_is_a_real_run_and_rejection_does_not_run(self):
        self.proposal()
        result = self.call(
            "/api/plan/decide", {"session": self.session, "accept": False, "feedback": "Use the corrected measurement."}
        )
        self.finish(result.data["run_id"])
        plan = self.hosted.get_meta(self.session)["plan"]
        self.assertEqual(plan["title"], "Revised proposal")
        events = self.hosted.snapshot(self.session)["events"]
        self.assertTrue(any(event.get("revised") for event in events))
        self.call("/api/plan/decide", {"session": self.session, "accept": False})
        self.assertIsNone(self.hosted.get_meta(self.session)["plan"])
        self.assertEqual(len(self.store.list_runs(self.session)), 1)
        self.assertTrue(
            any(event["type"] == "plan_dismissed" for event in self.hosted.snapshot(self.session)["events"])
        )

    def test_accept_launches_actual_worker_and_clear_plan(self):
        self.proposal()
        result = self.call("/api/plan/decide", {"session": self.session, "accept": True})
        exp = self.hosted.experiments.get(result.data["eid"])
        self.assertNotEqual(exp["worker"], self.session)
        self.finish(self.store.list_runs(exp["worker"])[-1]["id"])
        self.assertIsNone(self.hosted.get_meta(self.session)["plan"])
        self.assertEqual(self.hosted.experiments.status(exp), "completed")
        story = self.service.story(self.session)
        self.assertEqual(story["entries"][0]["refs"], ["exp:" + exp["eid"]])

    def test_story_notes_and_export_contain_actual_artifacts(self):
        result = self.service.send(self.session, {"message": "specific observation"})
        self.finish(result["run_id"])
        story = self.service.story(self.session)
        self.assertIn("specific observation", story["entries"][0]["text"])
        note = "<script>literal user content</script>"
        self.service.notes(self.session, result["run_id"], note)
        self.service.close()
        self.service = Service(self.hosted, dispatch=False)
        self.assertEqual(self.service.notes(self.session)["notes"][result["run_id"]], note)
        self.store.write_upload(self.session, "uploads/input.txt", b"excluded attachment")
        self.store.register_file(self.session, "uploads/input.txt", kind="attachment")
        archive = zipfile.ZipFile(io.BytesIO(self.service.export(self.session)))
        artifact = "files/" + self.session + "/result.txt"
        self.assertEqual(archive.read(artifact), b"actual subprocess artifact")
        self.assertFalse(any(name.endswith("input.txt") for name in archive.namelist()))
        manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual(manifest["format"], "rea-astra-thread-export-v1")
        self.assertEqual(manifest["notes"][result["run_id"]], note)
        self.assertEqual(manifest["omitted"][0]["reason"], "attached inputs excluded")
        self.service.notes(self.session, result["run_id"], "")
        self.assertEqual(self.service.notes(self.session)["notes"], {})

    def test_unsupported_features_fail_explicitly_and_scope_is_checked(self):
        cost = self.call("/api/plan/cost-estimate", {"session": self.session})
        self.assertFalse(cost.data["ok"])
        self.assertIsNone(cost.data["estimate"])
        self.assertEqual(self.call("/api/plan/answer", {"session": self.session, "answers": ["yes"]}).status, 409)
        self.assertEqual(self.call(f"/api/threads/{self.session}/shared").status, 501)
        self.assertEqual(self.call(f"/api/workspaces/{self.workspace}/threads/{self.session}/rewind").status, 501)
        with self.assertRaises(ValueError):
            self.call(f"/api/workspaces/wrong/threads/{self.session}/story", method="GET")

    def test_story_uses_final_response_and_resolves_absolute_artifact_link(self):
        script = r"""
import json,pathlib,sys
sys.stdin.read()
path=pathlib.Path("report.md").resolve()
path.write_text("# Actual fixture report")
for identifier,text in [("progress","Intermediate commentary should not appear in the story."),("final", "Final finding. [Read report]("+str(path)+")")]:
    print(json.dumps({"type":"item.completed","item":{"type":"agent_message","id":identifier,"text":text}}),flush=True)
print(json.dumps({"type":"turn.completed","usage":{}}),flush=True)
"""
        self.runner.command_factory = lambda *_: [sys.executable, "-c", script]
        run = self.service.send(self.session, {"message": "Write a report"})
        self.finish(run["run_id"])
        story = self.service.story(self.session)
        text = story["entries"][0]["text"]
        self.assertIn("Final finding.", text)
        self.assertNotIn("Intermediate commentary", text)
        self.assertIn("[Read report](/api/feed/file?path=", text)
        self.assertNotIn(str(self.store.thread_path(self.session)), text)
        self.assertEqual(story["brief"]["text"], text)

    def test_uncertain_dispatch_is_not_automatically_replayed(self):
        with self.store.connect() as db:
            db.execute(
                "INSERT INTO hosted_queue VALUES (?,?,?,?,?,?,NULL,NULL)",
                (
                    "uncertain",
                    self.session,
                    "crash",
                    json.dumps({"message": "might have run"}),
                    "dispatching",
                    "2026-11-10",
                ),
            )
        self.service.close()
        self.service = Service(self.hosted, dispatch=False)
        self.service.drain()
        self.assertEqual(self.service.queue(self.session)[0]["state"], "failed")
        self.assertEqual(self.store.list_runs(self.session), [])

    def test_completion_projection_reserves_thread_until_callback_finishes(self):
        entered, release = threading.Event(), threading.Event()
        original = self.runner.on_run_finished

        def completion(run):
            entered.set()
            release.wait(5)
            original(run)

        self.runner.on_run_finished = completion
        first = self.service.send(self.session, {"message": "first completion"})
        self.assertTrue(entered.wait(5))
        try:
            self.assertEqual(self.store.get_run(first["run_id"])["status"], "completed")
            self.assertTrue(self.runner.is_active(self.session))
            second = self.service.send(self.session, {"message": "must wait for projection"})
            self.assertTrue(second["queued"])
            self.assertEqual(len(self.store.list_runs(self.session)), 1)
            with self.assertRaisesRegex(ValueError, "finalizing"):
                self.runner.start(self.session, "bypass queue")
        finally:
            release.set()
        self.finish(first["run_id"])
        self.service.drain()
        self.finish(self.store.list_runs(self.session)[-1]["id"])

    def test_started_run_is_not_failed_or_duplicated_when_projection_raises(self):
        original = self.hosted.sync
        self.hosted.sync = lambda _: (_ for _ in ()).throw(ValueError("projection failed"))
        try:
            result = self.service.send(self.session, {"message": "deliver once", "client_message_id": "projection"})
        finally:
            self.hosted.sync = original
        self.assertTrue(result["ok"])
        self.assertIsNotNone(result["run_id"])
        self.finish(result["run_id"])
        retry = self.service.send(self.session, {"message": "deliver once", "client_message_id": "projection"})
        self.assertEqual(retry["run_id"], result["run_id"])
        self.assertEqual(len(self.store.list_runs(self.session)), 1)

    def test_dispatch_start_is_idempotent_and_selected_codebase_is_persisted(self):
        first = self.service.send(self.session, {"message": "busy"})
        result = self.service.send(
            self.session,
            {
                "message": "use selected repo",
                "base_repo": "https://github.com/example/repo",
                "base_ref": "branch",
                "client_message_id": "repo",
            },
        )
        row = self.store._one("SELECT body FROM hosted_queue WHERE id=?", (result["queue_id"],))
        self.assertEqual(json.loads(row["body"])["base_ref"], "branch")
        self.service.cancel_queued(self.session, "repo")
        self.service.start()
        worker = self.service.worker
        self.service.start()
        self.assertIs(worker, self.service.worker)
        self.finish(first["run_id"])

    def test_two_finishing_planners_each_auto_launch_one_actual_worker(self):
        self.runner.max_concurrent = 2
        self.hosted.thread_features = self.service
        script = r"""
import json,pathlib,sys,time
prompt=sys.stdin.read()
if "You are the planner in a local research application" in prompt:
    pathlib.Path("research-plan.json").write_text(json.dumps({"title":"Actual fixture plan", "body":"Write measured fixture artifact", "max_gpus":0}))
else:
    pathlib.Path("results.csv").write_text("value\n7\n")
time.sleep(.1)
print(json.dumps({"type":"item.completed","item":{"type":"agent_message","id":"final","text":"Actual subprocess completed."}}),flush=True)
print(json.dumps({"type":"turn.completed","usage":{}}),flush=True)
"""
        self.runner.command_factory = lambda *_: [sys.executable, "-c", script]
        barrier = threading.Barrier(2)
        callback = self.runner.on_run_finished

        def finish_together(run):
            if self.hosted.get_meta(run["thread_id"]).get("kind") == "planner":
                barrier.wait(5)
            callback(run)

        self.runner.on_run_finished = finish_together
        parents = [self.session, self.hosted.start_session(self.workspace, "", "Second planner")]
        for parent in parents:
            self.hosted.set_meta(parent, auto_accept=True)
            self.service.send(parent, {"message": "Make a bounded plan"})
        self.service.start()
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            experiments = self.store._all("SELECT * FROM hosted_experiments")
            if len(experiments) == 2 and all(self.hosted.experiments.status(exp) == "completed" for exp in experiments):
                break
            time.sleep(0.04)
        self.assertEqual(len(experiments), 2)
        self.assertEqual({exp["parent"] for exp in experiments}, set(parents))
        for exp in experiments:
            self.assertEqual(self.hosted.experiments.status(exp), "completed")
            self.assertEqual(len(self.store.list_runs(exp["worker"])), 1)
            self.assertIsNone(self.hosted.get_meta(exp["parent"])["plan"])
        self.assertEqual(self.service.launch_ready_plans(), [])
        self.assertEqual(len(self.store._all("SELECT * FROM hosted_experiments")), 2)

    def test_auto_launch_retries_capacity_but_not_plan_errors(self):
        blocker = self.hosted.start_session(self.workspace, "", "Capacity blocker")
        active = self.service.send(blocker, {"message": "Use the only slot"})
        self.proposal()
        self.hosted.set_meta(self.session, auto_accept=True)
        self.assertEqual(self.service.launch_ready_plans(), [])
        self.assertIsNone(self.hosted.get_meta(self.session).get("auto_accept_error"))
        reserved = self.store._one("SELECT eid FROM hosted_experiments WHERE parent=?", (self.session,))
        self.finish(active["run_id"])
        launched = self.service.launch_ready_plans()
        self.assertEqual(len(launched), 1)
        self.assertEqual(launched[0]["eid"], reserved["eid"])
        self.finish(self.store.list_runs(launched[0]["worker"])[0]["id"])

        self.hosted.set_meta(
            self.session,
            plan={"plan_id": "gpu-plan", "title": "Unavailable GPU", "body": "Requires a GPU", "max_gpus": 1},
            plan_phase="review",
        )
        self.assertEqual(self.service.launch_ready_plans(), [])
        error = self.hosted.get_meta(self.session)["auto_accept_error"]
        self.assertEqual(error["plan_id"], "gpu-plan")
        self.assertIn("GPU", error["message"])
        self.assertEqual(self.service.launch_ready_plans(), [])
        events = self.store._all(
            "SELECT source FROM hosted_events WHERE session=? AND source LIKE 'autoaccept-error:%'", (self.session,)
        )
        self.assertEqual(len(events), 1)
        self.assertEqual(self.hosted.get_meta(self.session)["plan"]["plan_id"], "gpu-plan")

    def test_auto_launch_preserves_manual_review_and_queued_followup(self):
        self.proposal()
        self.assertEqual(self.service.launch_ready_plans(), [])
        self.hosted.set_meta(self.session, auto_accept=True)
        with self.store.connect() as db:
            db.execute(
                "INSERT INTO hosted_queue VALUES (?,?,?,?,?,?,NULL,NULL)",
                (
                    "pending-review",
                    self.session,
                    "review",
                    json.dumps({"message": "Wait, revise this plan"}),
                    "pending",
                    "2026-11-10",
                ),
            )
        self.assertEqual(self.service.launch_ready_plans(), [])
        self.assertEqual(self.store._all("SELECT * FROM hosted_experiments"), [])

    def test_failed_revision_does_not_auto_approve_original_plan(self):
        self.proposal()
        self.hosted.set_meta(self.session, auto_accept=True)
        result = self.service.revise(
            self.session, "Use the new source", context={"context_refs": ["invalid reference"]}
        )
        self.assertFalse(result["ok"])
        self.assertEqual(self.hosted.get_meta(self.session)["auto_accept_error"]["plan_id"], "plan_test")
        self.assertEqual(self.service.launch_ready_plans(), [])
        self.assertEqual(self.store._all("SELECT * FROM hosted_experiments"), [])


if __name__ == "__main__":
    unittest.main()
