"""Real local file/contract tests; public network is supplied by bounded fixtures."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from backend.sources import SourceService, public_fetch, repo_name
from backend.store import Store


class HostedFixture:
    def __init__(self, store):
        self.store, self.meta = store, {}

    def start_session(self, workspace, prompt, title, session_id=None, **options):
        return self.store.create_thread(workspace, title, thread_id=session_id)["id"]

    def get_meta(self, session):
        return self.meta.get(session, {})

    def set_meta(self, session, **fields):
        self.meta.setdefault(session, {}).update(fields)


class Handler:
    def __init__(self, path, raw=b"", content_type="application/json"):
        self.path, self.body_bytes = path, raw
        self.query = parse_qs(urlsplit(path).query)
        self.headers = {"Content-Type": content_type}
        self.response = None

    def json(self, status, body):
        self.response = status, body


class SourceCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / "data")
        self.workspace = self.store.create_workspace()
        self.thread = self.store.create_thread(self.workspace["id"])
        self.hosted = HostedFixture(self.store)
        self.requests, self.clones = [], []
        self.service = SourceService(self.hosted, self.fetch, self.clone)

    def tearDown(self):
        self.temp.cleanup()

    def fetch(self, url, limit):
        self.requests.append((url, limit))
        if "export.arxiv.org" in url:
            return b'''<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/1706.03762v7</id><title>Attention Is All You Need</title><summary>Actual fixture abstract</summary><author><name>Author</name></author><published>2017-06-12</published><category term="cs.CL"/></entry></feed>'''
        if "arxiv.org/pdf/" in url:
            return b"%PDF-1.4 fixture bytes"
        if "search/repositories" in url:
            return json.dumps({"items": [{"full_name": "owner/repo", "description": "Fixture"}]}).encode()
        if "/branches?" in url:
            return b'[{"name":"main"},{"name":"test"}]'
        if "api.github.com/repos/" in url:
            return b'{"full_name":"owner/repo","private":false,"size":1,"default_branch":"main"}'
        if "huggingface.co" in url:
            item = {"id": "owner/model", "private": False, "gated": False, "downloads": 2}
            return json.dumps([item] if "?" in url else item).encode()
        self.fail("Unexpected fixture URL " + url)

    def clone(self, repo, destination, ref):
        self.clones.append((repo, destination, ref))
        destination.mkdir()
        (destination / "src").mkdir()
        (destination / "src" / "main.py").write_text("print('real fixture file')\n")
        (destination / ".git").mkdir()
        (destination / ".git" / "config").write_text("do not copy")
        (destination / "outside").symlink_to("/etc/passwd")

    def route(self, path, method="GET", body=None):
        handler = Handler(path)
        self.assertTrue(self.service.route(handler, method, urlsplit(path).path, body or {}))
        return handler.response

    def multipart(self, thread=True, filename="data.bin", content=b"\x00\xff\r\nreal bytes"):
        parts = [("thread_id", self.thread["id"])] if thread else [("project", self.workspace["id"])]
        raw = b""
        for name, value in parts:
            raw += ('--boundary\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n').encode()
        raw += ('--boundary\r\nContent-Disposition: form-data; name="file"; filename="' + filename + '"\r\nContent-Type: application/octet-stream\r\n\r\n').encode() + content + b"\r\n--boundary--\r\n"
        return Handler("/api/upload", raw, "multipart/form-data; boundary=boundary")

    def test_upload_preserves_binary_bytes_and_registers_real_file(self):
        handler = self.multipart(filename="../../input.bin")
        self.service.route(handler, "POST", "/api/upload", {})
        status, result = handler.response
        self.assertEqual(status, 200)
        path = Path(result["path"])
        self.assertTrue(path.is_relative_to(self.store.thread_path(self.thread["id"]) / "uploads"))
        self.assertEqual(path.read_bytes(), b"\x00\xff\r\nreal bytes")
        self.assertEqual(self.store.get_file(result["file_id"])["size"], len(path.read_bytes()))

    def test_unreserved_upload_is_copied_into_planner_cwd_and_deduplicated(self):
        handler = self.multipart(thread=False)
        item = self.service.upload(handler)
        message = "Analyze this\n- " + item["path"]
        context = self.service.prepare_inputs(self.thread["id"], {"message": message})
        files = self.store.list_files(self.thread["id"])
        self.assertEqual(len(files), 1)
        self.assertIn(str(self.store.thread_path(self.thread["id"])), context)
        self.service.prepare_inputs(self.thread["id"], {"message": message})
        self.assertEqual(len(self.store.list_files(self.thread["id"])), 1)

    def test_artifact_chat_upload_resolves_experiment_to_worker(self):
        worker = self.store.create_thread(self.workspace["id"])
        class Experiments:
            def get(self, eid, workspace=None):
                return {"worker": worker["id"]} if eid == "exp_fixture" else None
        self.hosted.experiments = Experiments()
        for field in ("experiment_eid", "artifact_id"):
            handler = self.multipart()
            handler.body_bytes = ('--boundary\r\nContent-Disposition: form-data; name="' + field + '"\r\n\r\nexp_fixture\r\n').encode() + handler.body_bytes
            item = self.service.upload(handler)
            self.assertTrue(Path(item["path"]).is_relative_to(self.store.thread_path(worker["id"])))
        self.assertEqual(len(self.store.list_files(worker["id"])), 2)
        self.assertEqual(self.store.list_files(self.thread["id"]), [])

    def test_removed_prepared_source_does_not_claim_missing_file_is_available(self):
        item = self.service.upload(self.multipart())
        body = {"context_refs": [{"value": item["path"]}]}
        self.service.prepare_inputs(self.thread["id"], body)
        Path(item["path"]).unlink()
        with self.assertRaisesRegex(ValueError, "no longer exists"):
            self.service.prepare_inputs(self.thread["id"], body)

    def test_unknown_source_url_fails_even_with_an_old_empty_cache_entry(self):
        url = "https://untrusted.example/source"
        for cached in ({}, {url: []}):
            self.hosted.set_meta(self.thread["id"], source_inputs=cached)
            with self.assertRaisesRegex(ValueError, "source"):
                self.service.prepare_inputs(self.thread["id"], {"context_refs": [{"type": "resource", "value": url}]})
        self.assertEqual(self.requests, [])
        self.assertEqual(self.store.list_runs(self.thread["id"]), [])

    def test_reference_limit_rejects_instead_of_silently_ignoring_later_sources(self):
        item = self.service.upload(self.multipart())
        refs = [{"value": item["path"]}] * 30 + [{"value": "https://untrusted.example/source"}]
        with self.assertRaisesRegex(ValueError, "30 source references"):
            self.service.prepare_inputs(self.thread["id"], {"context_refs": refs})
        self.assertEqual(self.hosted.get_meta(self.thread["id"]), {})

    def test_selected_thread_context_copies_actual_transcript_and_artifacts(self):
        source = self.store.create_thread(self.workspace["id"], "Referenced research")
        self.store.add_message(source["id"], "user", "Measure the fixture")
        self.store.add_message(source["id"], "assistant", "Measured value is 3")
        source_file = self.service.save(source["id"], "measurement.csv", b"value\n3\n", kind="artifact")
        body = {"context_refs": [{"type": "thread", "value": source["id"], "workspace": self.workspace["id"]}]}
        self.service.prepare_inputs(self.thread["id"], body)
        files = self.store.list_files(self.thread["id"])
        context = next(f for f in files if f["path"].endswith("context.json"))
        snapshot = json.loads(self.store.file_path(self.thread["id"], context["path"]).read_text())
        self.assertEqual([m["content"] for m in snapshot["conversations"][0]["messages"]], ["Measure the fixture", "Measured value is 3"])
        copied = Path(snapshot["artifacts"][0]["local_path"])
        self.assertNotEqual(str(copied), source_file["path"])
        self.assertEqual(copied.read_bytes(), b"value\n3\n")
        self.assertTrue(copied.is_relative_to(self.store.thread_path(self.thread["id"])))
        self.store.add_message(source["id"], "assistant", "New result: 4")
        self.service.prepare_inputs(self.thread["id"], body)
        latest = self.hosted.get_meta(self.thread["id"])["source_inputs"][source["id"]][0]
        self.assertEqual(json.loads(Path(latest).read_text())["conversations"][0]["messages"][-1]["content"], "New result: 4")
        self.assertEqual(self.requests, [])

    def test_selected_experiment_context_uses_worker_plan_results_and_scope(self):
        worker = self.store.create_thread(self.workspace["id"], "Experiment worker")
        self.store.add_message(worker["id"], "assistant", "Experiment measured 12")
        self.service.save(worker["id"], "report.html", b"<h1>Measured 12</h1>", kind="artifact")
        exp = {"eid": "exp_fixture", "workspace": self.workspace["id"], "worker": worker["id"],
               "parent": self.thread["id"], "title": "Actual experiment", "body": "Measure fixture", "display_label": 1}
        class Experiments:
            def get(self, eid, workspace=None):
                return exp if eid == exp["eid"] and workspace in (None, exp["workspace"]) else None
        self.hosted.experiments = Experiments()
        self.service.prepare_inputs(self.thread["id"], {"context_refs": [{"type": "experiment", "value": exp["eid"]}]})
        path = self.hosted.get_meta(self.thread["id"])["source_inputs"][exp["eid"]][0]
        snapshot = json.loads(Path(path).read_text())
        self.assertEqual(snapshot["experiments"][0]["body"], "Measure fixture")
        self.assertEqual(snapshot["conversations"][0]["messages"][0]["content"], "Experiment measured 12")
        self.assertEqual(Path(snapshot["artifacts"][0]["local_path"]).read_bytes(), b"<h1>Measured 12</h1>")
        with self.assertRaisesRegex(ValueError, "source not found"):
            self.service.prepare_inputs(self.thread["id"], {"context_refs": [{"type": "experiment", "value": exp["eid"], "workspace": "other"}]})

    def test_upload_rejects_bad_boundary_and_symlink_destination(self):
        handler = self.multipart()
        handler.headers["Content-Type"] = "multipart/form-data; boundary=incorrect"
        with self.assertRaisesRegex(ValueError, "boundary"):
            self.service.upload(handler)
        (self.store.thread_path(self.thread["id"]) / "uploads").symlink_to(self.temp.name)
        with self.assertRaises(ValueError):
            self.service.upload(self.multipart())

    def test_browse_search_stat_have_original_envelopes_and_no_external_files(self):
        item = self.service.upload(self.multipart())
        os.utime(item["path"], (1700000000, 1700000000))
        self.assertEqual(self.route("/api/artifacts/browse")[1]["total"], 1)
        self.assertEqual(len(self.route("/api/artifacts/search?q=data")[1]["results"]), 1)
        self.assertFalse(self.route("/api/artifacts/stat?paths=/etc/passwd")[1]["results"][0]["exists"])
        self.assertEqual(self.route("/api/artifacts/browse")[1]["entries"][0]["path"], item["path"])
        self.assertEqual(self.route("/api/artifacts/browse")[1]["entries"][0]["modified"], 1700000000)
        self.assertEqual(self.route("/api/artifacts/search?q=data")[1]["results"][0]["modified"], 1700000000)

    def test_public_search_does_not_clone_and_addition_really_acquires(self):
        status, hits = self.route("/api/team/github/search?q=example")
        self.assertEqual(status, 200)
        self.assertIsInstance(hits, list)
        self.assertFalse(self.clones)
        path = "/api/team/resources?workspace_id=" + self.workspace["id"]
        status, result = self.route(path, "POST", {"type": "github_repo", "url": "https://github.com/owner/repo"})
        self.assertEqual(status, 200)
        resource = result["resource"]
        self.assertEqual(resource["checkout_status"], "ok")
        self.assertTrue((Path(resource["checkout_path"]) / "src/main.py").is_file())
        self.assertEqual(self.route(path)[1]["resources"][0]["id"], resource["id"])
        context = self.service.prepare_inputs(self.thread["id"], {"context_refs": [{"value": resource["checkout_path"], "resourceUrl": resource["url"], "resourceType": "github_repo"}]})
        copied = next(self.store.thread_path(self.thread["id"]).glob("source-*"))
        self.assertTrue((copied / "src/main.py").is_file())
        self.assertFalse((copied / ".git").exists())
        self.assertFalse((copied / "outside").exists())
        self.assertIn(str(copied), context)
        self.assertEqual(len(self.clones), 1)

    def test_arxiv_selection_acquires_pdf_and_metadata_not_only_reference(self):
        status, hits = self.route("/api/arxiv/search?q=1706.03762")
        self.assertEqual(status, 200)
        self.assertEqual(hits[0]["authors"], ["Author"])
        self.service.prepare_inputs(self.thread["id"], {"context_refs": [{"value": hits[0]["url"]}]})
        files = self.store.list_files(self.thread["id"])
        self.assertEqual(len(files), 2)
        pdf = next(f for f in files if f["path"].endswith(".pdf"))
        self.assertTrue(self.store.file_path(self.thread["id"], pdf["path"]).read_bytes().startswith(b"%PDF"))

    def test_huggingface_search_check_and_actual_metadata_attachment(self):
        self.assertIsInstance(self.route("/api/huggingface/search?type=model&query=test")[1], list)
        self.assertTrue(self.route("/api/huggingface/check?type=model&id=owner/model")[1]["accessible"])
        self.assertFalse(self.route("/api/huggingface/status")[1]["token_set"])
        self.service.prepare_inputs(self.thread["id"], {"context_refs": [{"value": "hf://owner/model", "attachmentKind": "model"}]})
        item = self.store.list_files(self.thread["id"])[0]
        self.assertEqual(json.loads(self.store.file_path(self.thread["id"], item["path"]).read_text())["id"], "owner/model")

    def test_credentials_and_arbitrary_urls_are_not_silently_accepted(self):
        self.assertEqual(self.route("/api/team/github/connect", "POST")[0], 501)
        handler = Handler("/api/huggingface/search")
        handler.headers["Close-HF-Token"] = "fixture-not-a-real-token"
        self.service.route(handler, "GET", "/api/huggingface/search", {})
        self.assertEqual(handler.response[0], 501)
        self.assertFalse(self.requests)
        for value in ["https://evil.example/owner/repo", "https://github.com@127.0.0.1/a/b", "--upload-pack=bad", "owner/../secret"]:
            with self.assertRaises(ValueError):
                repo_name(value)
        for url in ["http://api.github.com/", "https://localhost/", "https://api.github.com:8443/", "https://a:b@api.github.com/"]:
            with self.assertRaises(ValueError):
                public_fetch(url)
        with self.assertRaisesRegex(ValueError, "outside"):
            self.service.prepare_inputs(self.thread["id"], {"context_refs": [{"value": "/etc/passwd"}]})

    def test_public_download_enforces_byte_limit(self):
        class Response:
            headers = {}

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def read(self, limit):
                return b"x" * limit

        with patch("backend.sources.build_opener") as opener:
            opener.return_value.open.return_value = Response()
            with self.assertRaisesRegex(ValueError, "limit"):
                public_fetch("https://api.github.com/repos/owner/repo", 4)

    def test_acquisition_failure_does_not_claim_checkout_success(self):
        def fail(*args):
            raise ValueError("Download failed")
        self.service.clone = fail
        status, body = self.route("/api/team/resources?workspace_id=" + self.workspace["id"], "POST", {"type": "github_repo", "url": "https://github.com/owner/repo"})
        self.assertEqual(status, 400)
        self.assertIn("Download failed", body["error"])
        self.assertEqual(self.service.resources(self.workspace["id"]), [])


if __name__ == "__main__":
    unittest.main()
