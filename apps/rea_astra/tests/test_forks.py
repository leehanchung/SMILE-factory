"""Fork real local transcripts/files; never resume the source provider session."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.forks import ForkService
from backend.hosted import HostedAPI
from backend.runner import RunManager
from backend.store import Store

EXECUTOR = """
import json, os, pathlib, sys
prompt = sys.stdin.read()
pathlib.Path('result.txt').write_text(str(sum([2,4,6])))
pathlib.Path('report.md').write_text('# Actual sum\\n12\\n')
print(json.dumps({'type':'thread.started','thread_id':'provider-process-' + str(os.getpid())}))
text = 'Second answer' if 'second request' in prompt else 'First answer'
print(json.dumps({'type':'item.completed','item':{'id':'answer','type':'agent_message','text':text}}))
print(json.dumps({'type':'turn.completed'}))
"""


class ForkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(self.temp.name)
        self.runner = RunManager(self.store, command_factory=lambda *_: [sys.executable, "-c", EXECUTOR])
        self.hosted = HostedAPI(self.store, self.runner)
        self.hosted.forks = ForkService(self.hosted)
        self.forks = self.hosted.forks
        self.workspace = self.store.list_workspaces()[0]["id"]
        self.parent = self.store.create_thread(self.workspace, "Real source research")["id"]
        self.hosted.set_meta(self.parent, kind="planner")

    def tearDown(self):
        self.hosted.close()
        self.runner.shutdown()
        self.temp.cleanup()

    def run_source(self, prompt="First request"):
        run = self.runner.start(self.parent, prompt, search=False)
        result = self.runner.wait(run["id"], timeout=10)
        self.assertEqual(result["status"], "completed")
        self.hosted.sync(self.parent)
        return result

    def fork(self, **body):
        started = self.forks.start(self.workspace, self.parent, {"workspace_id": self.workspace, **body})
        row = self.store._one("SELECT data FROM hosted_fork_jobs WHERE id=?", (started["job_id"],))
        job = json.loads(row["data"])
        self.assertTrue(job["done"])
        self.assertNotIn("error", job, job.get("error"))
        return job["result"]

    def test_independent_copy_preserves_evidence_and_resets_provider(self):
        source_run = self.run_source()
        source_provider = self.store.get_thread(self.parent)["provider_thread_id"]
        result = self.fork()
        target = result["thread_id"]
        self.assertNotEqual(target, self.parent)
        self.assertRegex(target, r"^th_[0-7][0-9abcdefghjkmnpqrstvwxyz]{25}$")
        self.assertIsNone(self.store.get_thread(target)["provider_thread_id"])
        copied_run = self.store.list_runs(target)[0]
        self.assertNotEqual(copied_run["id"], source_run["id"])
        self.assertIsNone(copied_run["provider_thread_id"])
        self.assertEqual(self.hosted.get_meta(target)["fork_run_provenance"][copied_run["id"]]["source_run_id"], source_run["id"])
        self.assertEqual(self.store.file_path(target, "result.txt").read_text(), "12")
        self.store.file_path(self.parent, "result.txt").write_text("source changed")
        self.assertEqual(self.store.file_path(target, "result.txt").read_text(), "12")
        snapshot = self.hosted.snapshot(target)
        self.assertEqual(sum(e.get("text") == "First answer" for e in snapshot["events"]), 1)
        self.assertEqual(self.hosted.snapshot(target)["offset"], snapshot["offset"])
        self.assertIn("fork-context-", self.forks.context(target))
        # An actual child process continues the fork and obtains a fresh provider
        # session. The original provider session and files remain independent.
        run = self.runner.start(target, "Independent follow-up", instructions=self.forks.context(target), search=False)
        self.assertEqual(self.runner.wait(run["id"], timeout=10)["status"], "completed")
        self.assertNotEqual(self.store.get_thread(target)["provider_thread_id"], source_provider)
        self.assertEqual(self.store.get_thread(self.parent)["provider_thread_id"], source_provider)

    def test_cursor_fork_excludes_later_transcript_and_rejects_unknown_cursor(self):
        first = self.run_source()
        self.run_source("second request")
        result = self.fork(cursor_turn_id=first["id"])
        events = self.hosted.snapshot(result["thread_id"])["events"]
        self.assertTrue(any(e.get("text") == "First answer" for e in events))
        self.assertFalse(any(e.get("text") == "Second answer" for e in events))
        self.assertEqual(len(self.store.list_runs(result["thread_id"])), 1)
        with self.assertRaisesRegex(ValueError, "not found"):
            self.forks.start(self.workspace, self.parent, {"cursor_event_id": "nonexistent"})

    def test_fork_experiments_copy_actual_files_and_completed_state_privately(self):
        self.run_source()
        self.hosted.set_meta(self.parent, plan={"plan_id": "approved"}, plan_phase="review")
        exp = self.hosted.experiments.launch(self.workspace, {"session_uuid": self.parent, "plan_id": "approved", "title": "Compute sum", "body": "Execute sum and write report.md."})
        run = self.hosted.experiments.latest_run(exp)
        finished = self.runner.wait(run["id"], timeout=10)
        self.hosted.experiments.on_finish(finished)
        self.hosted.experiments.set_sharing(exp, {"visibility": "link"})
        result = self.fork()
        copies = self.store._all("SELECT * FROM hosted_experiments WHERE parent=?", (result["thread_id"],))
        self.assertEqual(len(copies), 1)
        copied = copies[0]
        self.assertNotEqual(copied["eid"], exp["eid"])
        self.assertNotEqual(copied["worker"], exp["worker"])
        self.assertIsNone(self.store.get_thread(copied["worker"])["provider_thread_id"])
        self.assertEqual(self.hosted.experiments.row(copied)["status"], "completed")
        self.assertEqual(self.hosted.experiments.sharing(copied)["visibility"], "private")
        self.assertEqual(self.store.file_path(copied["worker"], "result.txt").read_text(), "12")
        self.assertTrue(self.hosted.experiments.checkpoints(copied))
        events = self.hosted.snapshot(result["thread_id"])["events"]
        cards = [e for e in events if e["type"] == "result_page"]
        self.assertEqual(cards[-1]["experiment_eid"], copied["eid"])
        self.assertEqual(cards[-1]["display_label"], copied["display_label"])
        self.assertIn("fork-context-", self.forks.context(copied["worker"]))

    def test_missing_and_symlink_files_are_reported_without_following(self):
        self.run_source()
        file = self.store.file_path(self.parent, "result.txt")
        file.unlink()
        file.symlink_to("/etc/passwd")
        result = self.fork()
        summary = result["copy_summary"]
        self.assertEqual(summary["unavailable"], 1)
        unavailable = [item for item in summary["items"] if item["status"] == "unavailable"]
        self.assertEqual(unavailable[0]["label"], "result.txt")
        self.assertFalse(self.store.file_path(result["thread_id"], "result.txt").exists())


if __name__ == "__main__":
    unittest.main()
