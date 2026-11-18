"""Real process fixtures exercise runner behavior; they do not impersonate inference."""

import json
import os
import sys
import tempfile
import unittest
from itertools import pairwise
from pathlib import Path
from unittest import mock

from backend.runner import RunManager, agent_env, redact
from backend.store import Store

SUCCESS = r'''
import json, pathlib, sys
prompt = sys.stdin.read()
def emit(value): print(json.dumps(value), flush=True)
emit({"type":"thread.started","thread_id":"provider-fixture-id"})
emit({"type":"turn.started"})
pathlib.Path("results.csv").write_text("metric,value\nmean,3\npopulation_variance,2\n")
emit({"type":"item.completed","item":{"id":"cmd-1","type":"command_execution","command":"fixture operation","aggregated_output":"fixture output","exit_code":0,"status":"completed"}})
emit({"type":"item.completed","item":{"id":"message-1","type":"agent_message","text":"Fixture completed, not model inference"}})
emit({"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}})
'''


class BackendCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / "data")
        self.thread = self.store.create_thread(title="Fixture research")
        self.runners = []

    def tearDown(self):
        for runner in self.runners:
            runner.shutdown()
        self.temp.cleanup()

    def runner(self, source=SUCCESS, **options):
        runner = RunManager(self.store, command_factory=lambda *_: [sys.executable, "-c", source], **options)
        self.runners.append(runner)
        return runner

    def test_success_persists_messages_native_events_and_artifact(self):
        runner = self.runner()
        run = runner.start(self.thread["id"], "Compute a fixture", search=False)
        result = runner.wait(run["id"], 10)
        self.assertEqual(result["status"], "completed", result)
        self.assertEqual(result["return_code"], 0)
        self.assertEqual(self.store.get_thread(self.thread["id"])["provider_thread_id"], "provider-fixture-id")
        self.assertEqual([m["role"] for m in self.store.list_messages(self.thread["id"])], ["user", "assistant"])
        events = self.store.list_events(run["id"])
        self.assertIn("item.completed", [event["kind"] for event in events])
        self.assertEqual(events[-1]["kind"], "run.finished")
        self.assertTrue(all(a["id"] < b["id"] for a, b in pairwise(events)))
        self.assertEqual(self.store.list_events(run["id"], events[-2]["id"]), events[-1:])
        files = self.store.list_files(self.thread["id"])
        self.assertEqual(files[0]["path"], "results.csv")
        with self.store.open_file(self.thread["id"], "results.csv") as stream:
            self.assertIn(b"mean,3", stream.read())
        restored = Store(self.store.root)
        self.assertEqual(restored.thread_detail(self.thread["id"])["runs"][0]["status"], "completed")

    def test_failed_provider_never_becomes_simulated_success(self):
        runner = self.runner('import json; print(json.dumps({"type":"turn.failed","error":{"message":"Unavailable provider"}})); raise SystemExit(2)')
        result = runner.wait(runner.start(self.thread["id"], "Task")["id"], 10)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"], "Unavailable provider")
        self.assertEqual(result["final_text"], "")
        self.assertEqual(len(self.store.list_messages(self.thread["id"])), 1)

    def test_zero_exit_without_completed_turn_is_failure(self):
        runner = self.runner('print("not JSON")')
        result = runner.wait(runner.start(self.thread["id"], "Task")["id"], 10)
        self.assertEqual(result["status"], "failed")
        self.assertIn("without a completed turn", result["error"])

    def test_timeout_and_output_limit(self):
        runner = self.runner("import time; time.sleep(30)", timeout_seconds=0.15)
        result = runner.wait(runner.start(self.thread["id"], "Task")["id"], 10)
        self.assertEqual(result["status"], "failed")
        self.assertIn("exceeded", result["error"])
        runner.shutdown()
        runner = self.runner('print("x" * 10000)', max_output_bytes=100)
        result = runner.wait(runner.start(self.thread["id"], "Task")["id"], 10)
        self.assertEqual(result["status"], "failed")
        self.assertIn("size limit", result["error"])

    def test_timeout_reaps_background_child_even_if_launcher_exited(self):
        source = 'import subprocess,sys; subprocess.Popen([sys.executable,"-c","import time; time.sleep(30)"])'
        runner = self.runner(source, timeout_seconds=0.2)
        result = runner.wait(runner.start(self.thread["id"], "Task")["id"], 10)
        self.assertEqual(result["status"], "failed")
        self.assertIn("exceeded", result["error"])
        self.assertFalse(runner._handles)

    def test_cancel_prevents_concurrent_turn_and_cleans_process(self):
        runner = self.runner('import time; time.sleep(30)')
        run = runner.start(self.thread["id"], "First task")
        with self.assertRaisesRegex(ValueError, "already active"):
            runner.start(self.thread["id"], "Conflicting task")
        runner.cancel(run["id"])
        result = runner.wait(run["id"], 10)
        self.assertEqual(result["status"], "cancelled")
        self.assertNotIn(run["id"], runner._handles)

    def test_resume_passes_stored_provider_identity_to_adapter(self):
        captured = []
        def command(run, thread, workspace):
            captured.append(thread["provider_thread_id"])
            return [sys.executable, "-c", SUCCESS]
        runner = RunManager(self.store, command_factory=command)
        self.runners.append(runner)
        runner.wait(runner.start(self.thread["id"], "First")["id"], 10)
        runner.wait(runner.start(self.thread["id"], "Second")["id"], 10)
        self.assertEqual(captured, [None, "provider-fixture-id"])
        self.assertEqual(len(self.store.list_messages(self.thread["id"])), 4)

    def test_restart_marks_unfinished_runs_interrupted(self):
        run = self.store.create_run(self.thread["id"], "Task")
        self.runner()
        self.assertEqual(self.store.get_run(run["id"])["status"], "interrupted")
        self.assertFalse(self.store.finish_run(run["id"], "completed", "too late"))

    def test_files_confined_and_symlinks_rejected(self):
        thread_id = self.thread["id"]
        root = self.store.thread_path(thread_id)
        for relative in ("../secret", "/tmp/secret", ".env", "folder/.secret", "a\\b"):
            with self.assertRaises(ValueError): self.store.file_path(thread_id, relative)
        external = Path(self.temp.name) / "external.txt"
        external.write_text("outside")
        (root / "link.txt").symlink_to(external)
        with self.assertRaises(ValueError): self.store.open_file(thread_id, "link.txt")
        self.store.write_upload(thread_id, "uploads/sample.txt", b"research input")
        item = self.store.register_file(thread_id, "uploads/sample.txt", kind="upload")
        self.assertEqual(item["kind"], "upload")
        with self.assertRaises(FileExistsError): self.store.write_upload(thread_id, "uploads/sample.txt", b"replace")

    def test_delete_thread_preserves_research_files_and_blocks_active(self):
        root = self.store.thread_path(self.thread["id"])
        (root / "keep.txt").write_text("keep")
        run = self.store.create_run(self.thread["id"], "Task")
        with self.assertRaisesRegex(ValueError, "running thread"): self.store.delete_thread(self.thread["id"])
        self.store.finish_run(run["id"], "cancelled")
        self.store.delete_thread(self.thread["id"])
        self.assertIsNone(self.store.get_thread(self.thread["id"]))
        self.assertTrue((root / "keep.txt").is_file())

    def test_secret_values_redacted_from_event_payloads(self):
        result = redact({"authorization": "secret", "output": "Bearer abc.123 OPENAI_API_KEY=secret-value sk-1234567890123456789"})
        self.assertEqual(result["authorization"], "[redacted]")
        self.assertNotIn("secret-value", result["output"])
        self.assertNotIn("abc.123", result["output"])

    def test_agent_env_is_allowlisted(self):
        source = {"PATH": "/bin", "HOME": "/home/u", "LANG": "C.UTF-8", "LC_ALL": "C", "TMPDIR": "/tmp",
                  "OPENAI_API_KEY": "sk-fixture", "OPENAI_BASE_URL": "https://example.invalid", "CODEX_HOME": "/c",
                  "HTTPS_PROXY": "http://proxy", "SSL_CERT_FILE": "/ca.pem",
                  "ANTHROPIC_API_KEY": "x", "AWS_SECRET_ACCESS_KEY": "x", "GH_TOKEN": "x", "GITHUB_TOKEN": "x",
                  "GOOGLE_APPLICATION_CREDENTIALS": "x", "HF_TOKEN": "x", "DATABASE_URL": "x", "MODAL_TOKEN_SECRET": "x",
                  "SLACK_BOT_TOKEN": "x", "AZURE_OPENAI_API_KEY": "x", "DISCORD_TOKEN": "x", "PYTHONPATH": "/evil"}
        self.assertEqual(sorted(agent_env(source)), sorted(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "OPENAI_API_KEY",
                                                            "OPENAI_BASE_URL", "CODEX_HOME", "HTTPS_PROXY", "SSL_CERT_FILE"]))
        self.assertEqual(agent_env(source)["OPENAI_API_KEY"], "sk-fixture")
        self.assertEqual(agent_env({}), {})

    def test_agent_subprocess_receives_only_allowlisted_env(self):
        source = 'import json, os, pathlib; pathlib.Path("env.json").write_text(json.dumps(sorted(os.environ)))\n' + SUCCESS
        with mock.patch.dict(os.environ, {"HF_TOKEN": "leak", "DATABASE_URL": "leak", "AWS_SECRET_ACCESS_KEY": "leak",
                                          "CODEX_HOME": "/codex-home", "OPENAI_API_KEY": "sk-fixture"}):
            runner = self.runner(source)
            run = runner.start(self.thread["id"], "Dump env", search=False)
            result = runner.wait(run["id"], 10)
        self.assertEqual(result["status"], "completed", result)
        with self.store.open_file(self.thread["id"], "env.json") as stream:
            names = set(json.loads(stream.read()))
        self.assertIn("CODEX_HOME", names)
        self.assertIn("OPENAI_API_KEY", names)
        self.assertTrue({"HF_TOKEN", "DATABASE_URL", "AWS_SECRET_ACCESS_KEY"}.isdisjoint(names), names)
        # Python may add a few interpreter-specific variables of its own (e.g. __PYVENV_LAUNCHER__ on macOS).
        allowed = {"PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TZ", "TMPDIR", "TMP", "TEMP"}
        unexpected = {n for n in names if n not in allowed and not n.startswith(("LC_", "OPENAI_", "CODEX_", "XDG_", "__"))
                      and n.upper() not in {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}
                      and n not in {"SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "RUST_LOG"}}
        self.assertEqual(unexpected, set())


if __name__ == "__main__":
    unittest.main()
