"""Exercise real child processes, persisted reports, and confined file serving.

The deterministic process is a provider-protocol fixture, not a model-quality
test. It actually computes and writes the artifacts asserted by these tests.
"""

import io
import json
import sys
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.hosted import HostedAPI
from backend.runner import RunManager
from backend.store import Store

EXECUTOR = """
import json, pathlib, statistics, sys
prompt = sys.stdin.read()
values = [2, 4, 6, 8]
result = statistics.mean(values)
pathlib.Path('analysis.py').write_text('import statistics\\nprint(statistics.mean([2, 4, 6, 8]))\\n')
pathlib.Path('result.json').write_text(json.dumps({'mean': result}))
pathlib.Path('report.md').write_text('# Measured result\\nMean: ' + str(result) + '\\n<script>evil()</script>')
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','id':'answer','text':'Computed mean = ' + str(result)}}))
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':1,'output_tokens':1}}))
"""


class Response:
    def __init__(self, path, method="GET"):
        self.path, self.command = path, method
        self.status = None
        self.headers = {}
        self.wfile = io.BytesIO()
        self.payload = None

    def json(self, status, data):
        self.status, self.payload = status, data

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.headers[key] = value

    def end_headers(self):
        pass


class ExperimentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(self.temp.name)
        self.runner = RunManager(self.store, command_factory=lambda *_: [sys.executable, "-c", EXECUTOR], timeout_seconds=10)
        self.hosted = HostedAPI(self.store, self.runner)
        self.service = self.hosted.experiments
        self.workspace = self.store.list_workspaces()[0]["id"]
        self.parent = self.store.create_thread(self.workspace, "Planner")["id"]
        self.hosted.set_meta(self.parent, kind="planner", plan={"plan_id": "approved"}, plan_phase="review")
        self.body = {"session_uuid": self.parent, "plan_id": "approved", "title": "Compute a mean", "body": "Compute the mean of 2, 4, 6, 8 and save reproducible code and results."}

    def tearDown(self):
        self.hosted.close()
        self.runner.shutdown()
        self.temp.cleanup()

    def launch_finished(self):
        exp = self.service.launch(self.workspace, self.body)
        run = self.service.latest_run(exp)
        result = self.runner.wait(run["id"], timeout=10)
        self.assertEqual(result["status"], "completed", result.get("error"))
        # wait() may observe completion just before callback starts on fast jobs;
        # on_finish is intentionally idempotent and may also run after recovery.
        self.service.on_finish(result)
        return exp, result

    def test_real_execution_registers_report_and_completes_parent(self):
        exp, run = self.launch_finished()
        self.assertEqual(self.service.row(exp)["status"], "completed")
        self.assertNotEqual(exp["worker"], self.parent)
        files = self.store.list_files(exp["worker"])
        self.assertIn("analysis.py", [f["path"] for f in files])
        result = json.loads(self.store.file_path(exp["worker"], "result.json").read_text())
        self.assertEqual(result, {"mean": 5})
        checkpoints = self.service.checkpoints(exp)
        self.assertEqual([p["type"] for p in checkpoints], ["plan", "completion"])
        self.assertTrue(checkpoints[-1]["artifacts"])
        self.assertIsNone(self.hosted.get_meta(self.parent)["plan"])
        events = self.hosted.snapshot(self.parent)["events"]
        self.assertEqual(sum(e["type"] == "plan_accepted" for e in events), 1)
        self.assertTrue(any("Computed mean" in e.get("text", "") for e in events))
        self.assertFalse(any(e["kind"] == "integration.warning" for e in self.store.list_events(run["id"])))

    def test_report_bridge_and_direct_edit_persist_source_with_conflict_guard(self):
        exp, _ = self.launch_finished()
        ref = "report:" + self.workspace + ":" + exp["eid"]
        response = Response("/app/")
        self.service.serve_report(response, exp)
        self.assertEqual(response.headers["X-Silico-App-Bridge"], "ready-v1")
        self.assertIn(b"silico-app-health-check", response.wfile.getvalue())
        self.assertIn(b"event.source !== parent", response.wfile.getvalue())
        def request(path, body=None):
            response = Response(path, "POST" if body is not None else "GET")
            self.assertTrue(self.service.route(response, response.command, path.split("?")[0], body or {}))
            return response
        state = request("/api/docs/state?ref=" + ref).payload
        update = {"ref": ref, "base_sha": state["sha"], "content": state["content"].replace("Mean: 5", "Mean: 5 (verified)")}
        self.assertEqual(request("/api/docs/edits", update).payload["detail"]["reason"], "lease_lost")
        self.assertEqual(request("/api/docs/lease", {"ref": ref}).status, 200)
        edited = request("/api/docs/edits", update)
        self.assertEqual(edited.status, 200, edited.payload)
        self.assertNotEqual(edited.payload["sha"], state["sha"])
        self.assertIn("Mean: 5 (verified)", self.store.file_path(exp["worker"], "report.md").read_text())
        self.assertEqual(len(self.service.sharing(exp)["versions"]), 2)
        self.assertEqual(request("/api/docs/edits", update).payload["detail"]["reason"], "stale_base")
        latest = request("/api/docs/state?ref=" + ref).payload
        invalid = {"ref": ref, "base_sha": latest["sha"], "content": "<p>Missing report root</p>"}
        self.assertEqual(request("/api/docs/edits", invalid).payload["detail"]["reason"], "structural")
        self.assertNotIn("data-rea-bridge", latest["content"])
        request("/api/docs/lease/release", {"ref": ref})
        self.assertEqual(request("/api/docs/lease/heartbeat", {"ref": ref}).payload["detail"]["reason"], "lease_lost")

    def test_plan_submit_is_idempotent_and_scoped_to_workspace(self):
        exp, _ = self.launch_finished()
        again = self.service.launch(self.workspace, self.body)
        self.assertEqual(exp["eid"], again["eid"])
        self.assertEqual(len(self.store.list_runs(exp["worker"])), 1)
        other = self.store.create_workspace("Other")["id"]
        with self.assertRaisesRegex(ValueError, "does not belong"):
            self.service.launch(other, self.body)

    def test_gpu_launch_and_dismissed_proposal_do_not_start_workers(self):
        with self.assertRaisesRegex(ValueError, "GPU execution is unavailable"):
            self.service.launch(self.workspace, {**self.body, "max_gpus": 1})
        self.hosted.set_meta(self.parent, plan=None, plan_phase=None)
        with self.assertRaisesRegex(ValueError, "no longer awaiting approval"):
            self.service.launch(self.workspace, self.body)
        self.assertEqual(self.service.rows(self.workspace), [])

    def test_new_ids_and_explicit_legacy_migration_preserve_references(self):
        exp, _ = self.launch_finished()
        self.assertRegex(exp["eid"], r"^exp_[0-7][0-9abcdefghjkmnpqrstvwxyz]{25}$")
        old = "exp_legacy32characteridentifier0001"
        with self.store.connect() as db:
            db.execute("UPDATE hosted_experiments SET eid=? WHERE eid=?", (old, exp["eid"]))
            db.execute("UPDATE hosted_checkpoints SET eid=? WHERE eid=?", (old, exp["eid"]))
            db.execute("UPDATE hosted_events SET data=replace(data,?,?)", (exp["eid"], old))
        pending = self.store.create_run(exp["worker"], "Pending continuation")
        with self.assertRaisesRegex(ValueError, "Stop active"):
            self.service.migrate_legacy_ids()
        self.store.finish_run(pending["id"], "cancelled")
        mapping = self.service.migrate_legacy_ids()
        new = mapping[old]
        self.assertRegex(new, r"^exp_[0-7][0-9abcdefghjkmnpqrstvwxyz]{25}$")
        self.assertEqual(len(self.service.checkpoints(self.service.get(new))), 2)
        events = self.hosted.snapshot(self.parent)["events"]
        self.assertTrue(any(event.get("experiment_eid") == new for event in events))
        self.assertFalse(any(old in json.dumps(event) for event in events))

    def test_launch_copies_registered_uploaded_and_source_inputs(self):
        self.store.write_upload(self.parent, "uploads/input.csv", b"value\n2\n4\n")
        self.store.register_file(self.parent, "uploads/input.csv")
        source = self.store.thread_path(self.parent) / "source-repository" / "example.py"
        source.parent.mkdir()
        source.write_text("print('user supplied code')")
        self.store.register_file(self.parent, "source-repository/example.py")
        exp, _ = self.launch_finished()
        self.assertEqual(self.store.file_path(exp["worker"], "uploads/input.csv").read_bytes(), b"value\n2\n4\n")
        self.assertEqual(self.store.file_path(exp["worker"], "source-repository/example.py").read_text(), source.read_text())

    def test_unproduced_report_is_not_fabricated(self):
        worker = self.store.create_thread(self.workspace)["id"]
        self.assertIsNone(self.service.report({"worker": worker, "title": "Pending"}))

    def test_registered_files_only_and_symlink_rejection(self):
        exp, _ = self.launch_finished()
        item, actual = self.service.resolve_file("report.md", exp)
        self.assertEqual(self.service.resolve_file(str(actual))[0]["id"], item["id"])
        self.assertEqual(self.service.resolve_file(self.service.virtual_path(item))[0]["id"], item["id"])
        hidden = self.store.thread_path(exp["worker"]) / "unregistered.txt"
        hidden.write_text("private")
        with self.assertRaises(FileNotFoundError):
            self.service.resolve_file(str(hidden))
        with self.assertRaises((FileNotFoundError, ValueError)):
            self.service.resolve_file("/etc/passwd")
        with self.assertRaises(ValueError):
            self.service.resolve_file("../report.md", exp)
        actual.unlink()
        actual.symlink_to(hidden)
        with self.assertRaises(ValueError):
            self.service.resolve_file(self.service.virtual_path(item))

    def test_deleted_input_has_real_diff_and_does_not_break_export(self):
        self.store.write_upload(self.parent, "uploads/obsolete.txt", b"remove this line\n")
        self.store.register_file(self.parent, "uploads/obsolete.txt")
        exp, _ = self.launch_finished()
        self.store.file_path(exp["worker"], "uploads/obsolete.txt").unlink()
        change = next(c for c in self.service.changeset(exp)["changes"] if c["rel_path"] == "uploads/obsolete.txt")
        self.assertEqual(change["change_type"], "deleted")
        self.assertIn("-remove this line", self.service.file_diff(exp, "uploads/obsolete.txt")["diff"])
        with zipfile.ZipFile(io.BytesIO(self.service.archive(exp, self.service.report(exp)))) as archive:
            self.assertNotIn("uploads/obsolete.txt", archive.namelist())

    def test_report_head_markdown_escaping_and_actual_diff(self):
        exp, _ = self.launch_finished()
        handler = Response("/", "HEAD")
        self.service.serve_report(handler, exp)
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.wfile.getvalue(), b"")
        self.assertEqual(handler.headers["X-Silico-App-Entrypoint"], "report.md")
        rendered = self.service.report(exp)["data"]
        self.assertIn(b"Mean: 5", rendered)
        self.assertIn(b"&lt;script&gt;", rendered)
        self.assertNotIn(b"<script>", rendered)
        diff = self.service.file_diff(exp, "analysis.py")
        self.assertIn("+import statistics", diff["diff"])
        checkpoint = self.service.checkpoints(exp)[-1]
        delta = self.service.delta(exp, checkpoint["sequence"])
        self.assertTrue(any(item["additions"] > 0 for item in delta["files"]))

    def test_publication_is_explicit_immutable_and_revocable(self):
        exp, _ = self.launch_finished()
        self.assertEqual(self.service.papers(), [])
        self.assertEqual(self.service.sharing(exp)["visibility"], "private")
        sharing = self.service.set_sharing(exp, {"visibility": "link"})
        self.assertEqual(sharing["versions"][0]["n"], 1)
        self.assertTrue(sharing["versions"][0]["active"])
        self.assertTrue(sharing["versions"][0]["pinned"])
        url = sharing["publication"]["url"]
        request = Response(url)
        self.assertTrue(self.service.route(request, "GET", url, {}))
        published = request.wfile.getvalue()
        self.store.file_path(exp["worker"], "report.md").write_text("# Changed after publication")
        self.store.register_file(exp["worker"], "report.md")
        self.assertTrue(self.service.sharing(exp)["diverged"])
        self.assertFalse(any(v["active"] for v in self.service.sharing(exp)["versions"]))
        second = Response(url)
        self.service.route(second, "GET", url, {})
        self.assertEqual(second.wfile.getvalue(), published)
        self.service.set_sharing(exp, {"visibility": "private"})
        denied = Response(url)
        self.service.route(denied, "GET", url, {})
        self.assertEqual(denied.status, 404)

    def test_persisted_reopen_and_archive_include_real_files(self):
        exp, _ = self.launch_finished()
        revision = self.service.save_version(exp, "Measured run")
        saved = self.store._one("SELECT * FROM hosted_report_versions WHERE id=?", (revision,))
        with zipfile.ZipFile(io.BytesIO(saved["archive"])) as archive:
            self.assertEqual(json.loads(archive.read("result.json")), {"mean": 5})
            self.assertIn("index.html", archive.namelist())
        from backend.experiments import ExperimentService
        reopened = ExperimentService(self.hosted)
        self.assertEqual(reopened.get(exp["eid"])["worker"], exp["worker"])
        self.assertEqual(reopened.row(exp)["status"], "completed")
        self.assertTrue(reopened.report(exp))

    def test_restore_and_nested_html_assets_use_saved_content(self):
        exp, _ = self.launch_finished()
        directory = self.store.thread_path(exp["worker"]) / "app"
        directory.mkdir()
        (directory / "index.html").write_text("<html><body>Original<img src='plot.svg'></body></html>")
        (directory / "plot.svg").write_text("<svg>original plot</svg>")
        self.store.register_file(exp["worker"], "app/index.html")
        self.store.register_file(exp["worker"], "app/plot.svg")
        original = self.service.save_version(exp)
        (directory / "index.html").write_text("<html>Changed</html>")
        (directory / "plot.svg").write_text("<svg>changed plot</svg>")
        self.store.register_file(exp["worker"], "app/index.html")
        self.store.register_file(exp["worker"], "app/plot.svg")
        sharing = self.service.set_sharing(exp, {"visibility": "link", "restore_revision_id": original})
        self.assertIn(b"Original", self.service.report(exp)["data"])
        request = Response(sharing["publication"]["url"] + "plot.svg")
        self.service.route(request, "GET", request.path, {})
        self.assertEqual(request.wfile.getvalue(), b"<svg>original plot</svg>")
        self.assertEqual((directory / "index.html").read_text(), "<html>Changed</html>")

    def test_workspace_sse_has_real_named_events_and_states(self):
        exp, _ = self.launch_finished()
        response = Response("/api/workspaces/" + self.workspace + "/events")
        self.service.workspace_stream(response, self.workspace, duration=0.01)
        frames = response.wfile.getvalue().decode()
        self.assertIn("event: experiment_created\n", frames)
        self.assertIn("event: checkpoint\n", frames)
        self.assertIn("event: result_page_revised\n", frames)
        self.assertIn(exp["eid"], frames)
        self.assertEqual(self.service.states(self.parent)[exp["eid"]]["status"], "completed")
        events = self.hosted.snapshot(self.parent)["events"]
        self.assertTrue(any(e["type"] == "result_page" and e["experiment_eid"] == exp["eid"] for e in events))

    def test_artifact_edit_reuses_worker_and_emits_actual_revision(self):
        exp, _ = self.launch_finished()
        start = Response("/api/worker/" + self.workspace + "/" + exp["eid"] + "/edit-session", "POST")
        self.service.route(start, "POST", start.path, {})
        self.assertEqual(start.payload["session_id"], exp["worker"])
        self.assertEqual(start.payload["artifact_id"], exp["eid"])
        self.assertEqual(start.payload["doc_ref"], "report:" + self.workspace + ":" + exp["eid"])
        self.runner.command_factory = lambda *_: [sys.executable, "-c", EXECUTOR.replace("Mean: ", "Revised mean: ")]
        run = self.hosted.send(exp["worker"], "Revise the report wording")
        done = self.runner.wait(run["id"], timeout=10)
        self.service.on_finish(done)
        self.assertEqual(done["status"], "completed")
        self.assertIn(b"Revised mean: 5", self.service.report(exp)["data"])
        events = self.hosted.snapshot(exp["worker"])["events"]
        self.assertTrue(any(e["type"] == "artifact_revision" and "report.md" in e["changed_paths"] for e in events))
        outcome = Response("/api/workspaces/" + self.workspace + "/experiments/" + exp["eid"] + "/outcome", "POST")
        self.service.route(outcome, "POST", outcome.path, {"outcome": "signal"})
        self.assertEqual(self.service.states(self.parent)[exp["eid"]]["outcome"], "signal")

    def test_legacy_report_edit_emits_revision_without_prior_baseline(self):
        exp, _ = self.launch_finished()
        # Legacy persisted workspaces predate last_report_revision metadata.
        self.hosted.set_meta(exp["worker"], last_report_revision=None)
        offset = self.hosted.snapshot(exp["worker"])["offset"]
        self.runner.command_factory = lambda *_: [sys.executable, "-c", EXECUTOR.replace("Mean: ", "Documented mean: ")]
        run = self.hosted.send(exp["worker"], "Document the report wording")
        done = self.runner.wait(run["id"], timeout=10)
        self.service.on_finish(done)
        self.service.on_finish(done)
        revisions = [e for e in self.hosted.snapshot(exp["worker"], offset)["events"] if e["type"] == "artifact_revision"]
        self.assertEqual(len(revisions), 1)
        self.assertIsNone(revisions[0]["prev_revision_id"])
        self.assertEqual(revisions[0]["revision_id"], self.service.report(exp)["revision"])
        self.assertIn("report.md", revisions[0]["changed_paths"])
        self.assertIn(b"Documented mean: 5", self.service.report(exp)["data"])

    def test_http_report_file_and_worker_contracts(self):
        from backend.server import ResearchHTTPServer, make_handler
        exp, _ = self.launch_finished()
        server = ResearchHTTPServer(("127.0.0.1", 0), make_handler(self.store, self.runner, self.temp.name, self.hosted.route))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        origin = "http://127.0.0.1:" + str(server.server_port)
        base = origin + "/api/workspaces/" + self.workspace + "/experiments/" + exp["eid"]
        try:
            with urlopen(Request(base + "/app/", method="HEAD")) as response:
                self.assertEqual(response.status, 200)
                self.assertIn("sandbox", response.headers["Content-Security-Policy"])
                self.assertEqual(len(response.headers.get_all("Content-Security-Policy")), 1)
                self.assertEqual(response.read(), b"")
            with urlopen(base + "/feed") as response:
                feed = json.load(response)
                self.assertEqual(feed["feed"][-1]["type"], "completion")
                self.assertFalse(feed["worker_alive"])
            with urlopen(origin + "/api/docs/state?ref=report:" + self.workspace + ":" + exp["eid"]) as response:
                document = json.load(response)
            self.assertTrue(document["can_edit"])
            self.assertIn("Mean: 5", document["content"])
            self.assertTrue(document["sha"])
            with urlopen(origin + "/api/worker/" + self.workspace + "/" + exp["eid"] + "/feed?offset=0") as response:
                snapshot = json.load(response)
                self.assertEqual(snapshot["session_id"], exp["worker"])
                self.assertTrue(any(e["type"] == "text" for e in snapshot["events"]))
            request = Request(base + "/artifacts/primary/sharing", method="PUT", data=json.dumps({"visibility": "link"}).encode(), headers={"Origin": origin, "Content-Type": "application/json"})
            with urlopen(request) as response:
                sharing = json.load(response)
            self.assertTrue(sharing["publication"]["url"].startswith(origin))
            with urlopen(sharing["publication"]["url"]) as response:
                self.assertIn(b"Mean: 5", response.read())
            with urlopen(origin + "/api/papers") as response:
                papers = json.load(response)
            self.assertEqual(papers[0]["fronted_artifact_id"], exp["eid"])
            with urlopen(origin + "/api/library/reports/" + papers[0]["pub_id"]) as response:
                resolution = json.load(response)
            self.assertEqual(resolution, {"artifact_id": exp["eid"], "is_owner": True})
            with urlopen(origin + "/api/library/artifacts/" + exp["eid"] + "/app") as response:
                app = json.load(response)
            self.assertEqual(app["url"], sharing["publication"]["url"])
            with urlopen(origin + "/api/library/artifacts?visibility=link") as response:
                library = json.load(response)
            self.assertEqual(library["artifacts"][0]["created_from"]["eid"], exp["eid"])
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
