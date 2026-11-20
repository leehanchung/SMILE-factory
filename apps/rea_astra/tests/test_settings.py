"""Persistence and recovered contracts; provider checks are injectable fixtures."""

import hashlib
import importlib.util
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

from backend.settings import Service
from backend.store import Store


class Handler:
    def __init__(self, path):
        self.query = parse_qs(urlsplit(path).query)
        self.response = None

    def json(self, status, body):
        self.response = status, body


class SettingsCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / "data")
        self.workspace = self.store.create_workspace("Original")
        self.other = self.store.create_workspace("Destination")
        self.thread = self.store.create_thread(self.workspace["id"])
        self.meta = {}
        self.hosted = SimpleNamespace(
            store=self.store,
            runner=SimpleNamespace(executable="codex"),
            get_meta=lambda session: self.meta.get(session, {}),
            set_meta=self.set_meta,
        )
        self.checks = 0
        self.service = Service(self.hosted, self.provider)

    def tearDown(self):
        self.temp.cleanup()

    def provider(self):
        self.checks += 1
        return {"provider": "codex", "installed": True, "authenticated": False, "auth_method": "unknown"}

    def set_meta(self, session, **fields):
        self.meta.setdefault(session, {}).update(fields)

    def route(self, path, method="GET", body=None):
        handler = Handler(path)
        self.assertTrue(self.service.route(handler, method, urlsplit(path).path, body or {}))
        return handler.response

    def test_folder_rename_archive_pin_persist_across_service_reload(self):
        workspace = self.workspace["id"]
        self.assertEqual(
            self.route("/api/workspaces/" + workspace, "PATCH", {"display_name": "Renamed"})[1]["display_name"],
            "Renamed",
        )
        self.route("/api/workspaces/" + workspace + "/archive", "POST", {"archived": True})
        self.route("/api/orgs/local/folders/" + workspace + "/pin", "POST", {"pinned": True})
        restored = Service(self.hosted, self.provider)
        self.assertEqual(restored.workspace_meta(workspace), {"archived": True, "pinned": True})
        self.assertEqual(restored.workspace(workspace)["name"], "Renamed")
        self.assertEqual(self.route("/api/workspaces/" + workspace, "PATCH", {"display_name": " "})[0], 400)

    def test_move_transfers_thread_and_workers_without_moving_cwd(self):
        worker = self.store.create_thread(self.workspace["id"])
        with self.store.connect() as db:
            db.execute(
                "CREATE TABLE hosted_experiments (eid TEXT,workspace TEXT,parent TEXT,worker TEXT,deleted INTEGER)"
            )
            db.execute(
                "INSERT INTO hosted_experiments VALUES (?,?,?,?,0)",
                ("exp", self.workspace["id"], self.thread["id"], worker["id"]),
            )
        cwd = self.store.thread_path(self.thread["id"])
        (cwd / "result.txt").write_text("retained")
        result = self.route(
            "/api/orgs/local/threads/" + self.thread["id"] + "/move", "POST", {"target_folder_id": self.other["id"]}
        )
        self.assertEqual(result[0], 200)
        self.assertEqual(self.store.get_thread(self.thread["id"])["workspace_id"], self.other["id"])
        self.assertEqual(self.store.get_thread(worker["id"])["workspace_id"], self.other["id"])
        self.assertEqual((cwd / "result.txt").read_text(), "retained")
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT workspace FROM hosted_experiments").fetchone()[0], self.other["id"])

    def test_thread_folder_endpoint_validates_scope_and_uses_workspace_not_legacy_fk(self):
        path = "/api/workspaces/" + self.workspace["id"] + "/threads/" + self.thread["id"] + "/folder"
        self.assertEqual(self.route(path, "POST", {"folder_id": self.other["id"]})[0], 200)
        self.assertIsNone(self.store.get_thread(self.thread["id"])["folder_id"])
        self.assertEqual(self.route(path, "POST", {"folder_id": self.workspace["id"]})[0], 400)

    def test_cascade_deletion_keeps_files_and_revokes_publications(self):
        path = self.store.thread_path(self.thread["id"]) / "evidence.txt"
        path.write_text("keep this")
        with self.store.connect() as db:
            db.execute("CREATE TABLE hosted_experiments (eid TEXT,workspace TEXT,deleted INTEGER)")
            db.execute("CREATE TABLE hosted_report_sharing (eid TEXT,visibility TEXT)")
            db.execute("INSERT INTO hosted_experiments VALUES (?,?,0)", ("exp", self.workspace["id"]))
            db.execute("INSERT INTO hosted_report_sharing VALUES ('exp','public')")
        endpoint = "/api/orgs/local/folders/" + self.workspace["id"]
        self.assertEqual(self.route(endpoint, "DELETE")[0], 400)
        self.assertEqual(self.route(endpoint + "?cascade=true", "DELETE")[0], 200)
        self.assertIsNone(self.store.get_thread(self.thread["id"]))
        self.assertEqual(path.read_text(), "keep this")
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT deleted FROM hosted_experiments").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT visibility FROM hosted_report_sharing").fetchone()[0], "private")

    def test_running_folder_cannot_be_deleted(self):
        self.store.create_run(self.thread["id"], "Queued fixture")
        response = self.route("/api/orgs/local/folders/" + self.workspace["id"] + "?cascade=true", "DELETE")
        self.assertEqual(response[0], 400)
        self.assertIn("Stop running", response[1]["error"])
        self.assertIsNotNone(self.store.get_thread(self.thread["id"]))

    def test_terminal_run_callback_handle_still_blocks_folder_deletion(self):
        worker = self.store.create_thread(self.workspace["id"])
        run = self.store.create_run(worker["id"], "Finishing callback fixture")
        self.store.finish_run(run["id"], "completed")
        self.hosted.runner.is_active = lambda session: session == worker["id"]
        with self.assertRaisesRegex(ValueError, "callback finalization"):
            self.service.delete_workspace(self.workspace["id"], True)
        self.assertIsNotNone(self.store.get_thread(worker["id"]))
        self.hosted.runner.is_active = lambda _: False
        self.service.delete_workspace(self.workspace["id"], True)
        self.assertIsNone(self.store.get_thread(worker["id"]))

    def test_move_and_delete_serialize_with_dispatch_lock(self):
        class Gate:
            def __init__(self):
                self.lock = threading.RLock()
                self.attempt = threading.Event()

            def __enter__(self):
                self.attempt.set()
                self.lock.acquire()

            def __exit__(self, *args):
                self.lock.release()

        gate = Gate()
        self.hosted.thread_features = SimpleNamespace(lock=gate)
        for operation in (
            lambda: self.service.move(self.thread["id"], self.other["id"]),
            lambda: self.service.delete_workspace(self.other["id"], True),
        ):
            done, errors = threading.Event(), []

            def run(operation=operation, errors=errors, done=done):
                try:
                    operation()
                except Exception as exc:
                    errors.append(exc)
                finally:
                    done.set()

            gate.attempt.clear()
            with gate.lock:
                thread = threading.Thread(target=run)
                thread.start()
                self.assertTrue(gate.attempt.wait(2))
                self.assertFalse(done.is_set())
            thread.join(2)
            self.assertTrue(done.is_set())
            self.assertEqual(errors, [])

    def test_last_folder_replacement_preserves_hosted_workspace_id_format(self):
        self.service.delete_workspace(self.other["id"], True)
        self.service.delete_workspace(self.workspace["id"], True)
        remaining = self.store.list_workspaces()
        self.assertEqual(len(remaining), 1)
        self.assertRegex(remaining[0]["id"], r"^ws_[0-9a-f]{26}$")

    def test_dispatching_queue_blocks_deletion_and_pending_rows_cascade(self):
        with self.store.connect() as db:
            db.execute(
                "CREATE TABLE hosted_queue (id TEXT, session TEXT REFERENCES threads(id) ON DELETE CASCADE, state TEXT)"
            )
            db.execute("INSERT INTO hosted_queue VALUES ('q',?,'dispatching')", (self.thread["id"],))
        with self.assertRaisesRegex(ValueError, "dispatching"):
            self.service.delete_workspace(self.workspace["id"], True)
        with self.store.connect() as db:
            db.execute("UPDATE hosted_queue SET state='pending'")
        self.service.delete_workspace(self.workspace["id"], True)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM hosted_queue").fetchone()[0], 0)

    def test_thread_pin_and_explicit_order(self):
        other = self.store.create_thread(self.workspace["id"])
        self.route("/api/orgs/local/threads/" + self.thread["id"] + "/pin", "POST", {"pinned": True})
        self.route("/api/orgs/local/pins/threads", "PUT", {"thread_ids": [other["id"], self.thread["id"]]})
        self.assertEqual(self.meta[other["id"]]["pin_rank"], 0)
        self.assertEqual(self.meta[self.thread["id"]]["pin_rank"], 1)
        self.route("/api/orgs/local/threads/" + self.thread["id"] + "/pin", "POST", {"pinned": False})
        self.assertFalse(self.meta[self.thread["id"]]["pinned"])

    def test_custom_instructions_are_scoped_persistent_and_available_to_runner(self):
        self.route("/api/settings/instructions?scope=user", "PUT", {"content": "Use concise prose."})
        self.route("/api/settings/instructions?scope=org&org_id=local", "PUT", {"content": "Cite actual measurements."})
        restored = Service(self.hosted, self.provider)
        self.assertEqual(restored.instructions(), "Cite actual measurements.\n\nUse concise prose.")
        self.assertTrue(self.route("/api/settings/instructions?scope=user")[1]["exists"])
        self.assertEqual(
            self.route("/api/settings/instructions?scope=org&org_id=other", "PUT", {"content": "bad"})[0], 400
        )

    def test_only_configured_model_is_advertised_no_fake_authenticated_provider(self):
        flags = self.route("/api/feature-flags")[1]
        self.assertEqual([m["value"] for m in flags["models"]], ["codex-default"])
        self.assertEqual(flags["models"][0]["label"], "Codex · CLI default")
        self.assertFalse(flags["providers"]["claude"])
        self.assertEqual(self.route("/api/settings/model", "PUT", {"model": "invented-model"})[0], 400)
        self.assertEqual(self.route("/api/settings/model", "PUT", {"model": "codex-default"})[0], 200)
        self.assertEqual(Service(self.hosted, self.provider).model(), "codex-default")
        verification = self.route("/api/integrations/verify", "POST", {"service": "codex"})[1]
        self.assertFalse(verification["valid"])
        self.assertEqual(verification["reason"], "not_authenticated")
        self.assertEqual(self.checks, 1)

    def test_credentials_and_hosted_policies_are_explicitly_unsupported(self):
        self.assertEqual(self.route("/api/settings/env")[1]["vars"], [])
        for endpoint, body in [
            ("/api/settings/env", {"vars": [{"name": "TOKEN", "value": "fixture"}]}),
            ("/api/settings/sandbox", {"network_allowlist_enabled": True}),
            ("/api/orgs/local/privacy", {"training_opt_out": True}),
        ]:
            self.assertEqual(self.route(endpoint, "PUT", body)[0], 501)
        self.assertEqual(self.route("/api/integrations/verify", "POST", {"service": "claude"})[0], 501)
        self.assertEqual(self.checks, 0)


class LocalLoginBuildCase(unittest.TestCase):
    def test_copy_changes_preserve_auth_logic_source_artifact_and_hash(self):
        script = Path(__file__).resolve().parents[1] / "scripts/build_hosted.py"
        spec = importlib.util.spec_from_file_location("build_hosted", script)
        build = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(build)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "evidence/hosted-static"
            (source / "assets").mkdir(parents=True)
            original = "const login=`Sign in with GitHub`;const title=`Welcome to Silico`;if(!config.auth_required){originalLoginBranch();}"
            (source / "assets/main.js").write_text(original)
            (source / "entry.html").write_text("<html><head><title>Silico</title></head><body></body></html>")
            build.build(root)
            output = (root / "hosted-preview/assets/main.js").read_text()
            self.assertIn("Open local workspace", output)
            self.assertIn("if(!config.auth_required){originalLoginBranch();}", output)
            self.assertEqual((source / "assets/main.js").read_text(), original)
            manifest = json.loads((root / "hosted-preview/build-manifest.json").read_text())
            asset = next(row for row in manifest if row["path"] == "assets/main.js")
            self.assertEqual(asset["source_sha256"], hashlib.sha256(original.encode()).hexdigest())
            self.assertNotEqual(asset["sha256"], asset["source_sha256"])
            self.assertEqual(len(asset["presentation_patches"]), 2)

    def test_local_sharing_copy_preserves_access_values(self):
        script = Path(__file__).resolve().parents[1] / "scripts/build_hosted.py"
        spec = importlib.util.spec_from_file_location("build_hosted", script)
        build = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(build)
        original = "{value:`link`,label:`Anyone with the link`,description:`Anyone can open this ${t} on the web`};{value:`org`,description:`Org members can open this ${t}`}"
        output, changes = build.patch_presentation(original)
        self.assertIn("value:`link`", output)
        self.assertIn("value:`org`", output)
        self.assertIn("Open this ${t} through its local URL on this computer", output)
        self.assertIn("Available inside this local workspace", output)
        self.assertNotIn("on the web", output)
        self.assertEqual(len(changes), 3)


if __name__ == "__main__":
    unittest.main()
