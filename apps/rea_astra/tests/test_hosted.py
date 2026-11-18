"""Recovered UI contracts against genuine subprocess fixtures, not mocked run rows."""

import sys
import tempfile
import unittest
from pathlib import Path

from backend.hosted import MODEL, HostedAPI
from backend.runner import RunManager
from backend.store import Store

PLANNER_FIXTURE = r'''
import json, pathlib, sys
sys.stdin.read()
def emit(value): print(json.dumps(value), flush=True)
emit({"type":"thread.started","thread_id":"fixture-provider-session"})
emit({"type":"turn.started"})
emit({"type":"item.started","item":{"id":"command-1","type":"command_execution","command":"fixture evidence collection","aggregated_output":"","status":"in_progress"}})
emit({"type":"item.completed","item":{"id":"command-1","type":"command_execution","command":"fixture evidence collection","aggregated_output":"fixture evidence","status":"completed","exit_code":0}})
pathlib.Path("research-plan.json").write_text(json.dumps({"title":"Measure arithmetic","body":"Run Python statistics on [1,2,3,4,5] and record results.","check_in_steps":[],"max_gpus":0}))
emit({"type":"item.completed","item":{"id":"plan-file","type":"file_change","changes":[{"path":"research-plan.json","kind":"add"}],"status":"completed"}})
emit({"type":"item.completed","item":{"id":"answer-1","type":"agent_message","text":"Fixture proposal written; this fixture is not model inference."}})
emit({"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}})
'''


class HostedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / "data")
        self.captured = []
        def command(run, thread, directory):
            self.captured.append(dict(run))
            return [sys.executable, "-c", PLANNER_FIXTURE]
        self.runner = RunManager(self.store, command_factory=command)
        self.api = HostedAPI(self.store, self.runner)
        self.workspace = self.store.list_workspaces()[0]["id"]

    def tearDown(self):
        self.api.close()
        self.runner.shutdown()
        self.temp.cleanup()

    def start_and_wait(self, session_id="th_contract_test"):
        session = self.api.start_session(self.workspace, "Please plan a real computation", "Arithmetic", session_id=session_id,
                                         model=MODEL, auto_accept=False, client_message_id="client-1")
        run = self.store.list_runs(session)[-1]
        self.assertEqual(self.runner.wait(run["id"], 10)["status"], "completed")
        return session, run

    def test_start_retry_is_idempotent_and_rejects_changed_context_or_workspace(self):
        session, _run = self.start_and_wait()
        self.api.start_session(self.workspace, "Please plan a real computation", "Arithmetic", session_id=session,
                               model=MODEL, auto_accept=False, client_message_id="client-1")
        self.assertEqual(len(self.store.list_runs(session)), 1)
        with self.assertRaisesRegex(ValueError, "different content"):
            self.api.start_session(self.workspace, "Please plan a real computation", "Arithmetic", session_id=session,
                                   client_message_id="client-1", context_refs=[{"value": "different"}])
        other = self.store.create_workspace("Other")
        with self.assertRaisesRegex(ValueError, "does not belong"):
            self.api.start_session(other["id"], "Wrong folder", "Changed", session_id=session)
        self.assertEqual(self.store.get_thread(session)["title"], "Arithmetic")

    def test_start_reports_source_acquisition_failure(self):
        with self.assertRaisesRegex(ValueError, "source"):
            self.api.start_session(self.workspace, "Read source", "Failure", session_id="th_bad_source",
                                   context_refs=[{"value": "https://untrusted.example/source"}], client_message_id="bad-source")
        self.assertEqual(self.store.list_runs("th_bad_source"), [])

    def test_auto_accept_response_survives_reopening_and_matches_client_field(self):
        session = self.api.start_session(self.workspace, "", "Auto", auto_accept=True)
        class Handler:
            path = "/api/workspaces/" + self.workspace + "/threads/" + session + "/auto-accept"
            query = {}
            headers = {}
            def json(self, status, data):
                self.result = (status, data)
        handler = Handler()
        self.assertTrue(self.api.route(handler, "GET", handler.path, {}))
        self.assertEqual(handler.result, (200, {"ok": True, "enabled": True, "auto_accept": True}))

    def test_late_registered_file_links_are_resolved_in_snapshot(self):
        session, _run = self.start_and_wait()
        path = self.store.file_path(session, "late-report.md")
        self.api.emit(session, "late-file", {"type": "text", "text": "[report](" + str(path) + ":12)"})
        path.write_text("Actual report")
        self.store.register_file(session, "late-report.md")
        event = self.api.snapshot(session)["events"][-1]
        self.assertIn("/api/feed/file?path=", event["text"])
        self.assertNotIn(str(path), event["text"])

    def test_native_events_project_once_with_tool_identity_and_client_message(self):
        session, _run = self.start_and_wait()
        first = self.api.snapshot(session)
        second = self.api.snapshot(session)
        self.assertEqual(first["events"], second["events"])
        events = first["events"]
        user = next(event for event in events if event["type"] == "user_text")
        self.assertEqual(user["client_message_id"], "client-1")
        self.assertEqual(user["text"], "Please plan a real computation")
        tool_uses = [event for event in events if event["type"] == "tool_use" and event["tool"] == "Bash"]
        self.assertEqual(len(tool_uses), 1)
        tool_result = next(event for event in events if event["type"] == "tool_result" and event["tool_use_id"] == tool_uses[0]["tool_use_id"])
        self.assertFalse(tool_result["is_error"])
        self.assertEqual(tool_result["output"], "fixture evidence")
        self.assertFalse(first["busy"])
        self.assertEqual(self.api.snapshot(session, first["durable_cursor"])["events"], [])
        self.assertEqual(self.captured[0]["model"], "", "codex-default is UI sentinel, not a model identifier")

    def test_plan_is_derived_from_real_fixture_file_and_requires_review(self):
        session, run = self.start_and_wait()
        snapshot = self.api.snapshot(session)
        plan = snapshot["plan"]
        self.assertEqual(plan["title"], "Measure arithmetic")
        self.assertEqual(snapshot["plan_phase"], "review")
        self.assertEqual(plan["plan_id"], "plan_" + run["id"])
        ready = [event for event in snapshot["events"] if event["type"] == "plan_ready"]
        self.assertEqual(len(ready), 1)
        self.assertIn("statistics", ready[0]["plan"])
        self.assertEqual(self.api.experiments.rows(self.workspace), [], "Review-only plan must not launch an experiment")
        self.assertIn("research-plan.json", [item["path"] for item in self.store.list_files(session)])
        self.api.on_finish(self.store.get_run(run["id"]))
        self.assertEqual(len([event for event in self.api.snapshot(session)["events"] if event["type"] == "plan_ready"]), 1)

    def test_projection_and_plan_survive_api_reconstruction(self):
        session, _ = self.start_and_wait()
        initial = self.api.snapshot(session)
        self.api.close()
        self.api = HostedAPI(self.store, self.runner)
        recovered = self.api.snapshot(session)
        self.assertEqual(recovered["events"], initial["events"])
        self.assertEqual(recovered["plan"], initial["plan"])
        row = self.api.thread_row(self.store.get_thread(session))
        self.assertEqual(row["label"], "Arithmetic")
        self.assertTrue(row["awaiting_input"])
        self.assertEqual(row["session_uuid"], session)

    def test_failed_run_has_error_text_without_plan_or_fake_results(self):
        self.runner.command_factory = lambda *_: [sys.executable, "-c", 'import json; print(json.dumps({"type":"turn.failed","error":{"message":"Provider unavailable"}})); raise SystemExit(1)']
        session = self.api.start_session(self.workspace, "Actual task", "Unavailable")
        run = self.store.list_runs(session)[-1]
        self.assertEqual(self.runner.wait(run["id"], 10)["status"], "failed")
        snapshot = self.api.snapshot(session)
        self.assertIsNone(snapshot["plan"])
        self.assertTrue(any(event["type"] == "text" and "Provider unavailable" in event["text"] for event in snapshot["events"]))
        self.assertEqual(self.store.list_files(session), [])


if __name__ == "__main__":
    unittest.main()
