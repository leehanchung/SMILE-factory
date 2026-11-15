import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest

from backend.runner import RunManager
from backend.server import make_handler, ResearchHTTPServer
from backend.store import Store


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        static = root / "static"
        static.mkdir()
        (static / "index.html").write_text("<h1>research</h1>")
        self.static = static
        self.store = Store(root / "data")
        self.runner = RunManager(self.store, command_factory=lambda *_: [sys.executable, "-c", 'import json; print(json.dumps({"type":"turn.completed","usage":{}}))'])
        self.server = ResearchHTTPServer(("127.0.0.1", 0), make_handler(self.store, self.runner, static))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.host = f"127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.runner.shutdown()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)
        actual = dict(headers or {})
        if isinstance(body, dict):
            body = json.dumps(body)
            actual.setdefault("Content-Type", "application/json")
        connection.request(method, path, body, actual)
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_origin_host_and_json_guards(self):
        status, _, _ = self.request("POST", "/api/workspaces", {"name":"x"})
        self.assertEqual(status, 403)
        status, _, _ = self.request("POST", "/api/workspaces", {"name":"x"}, {"Origin":"https://malicious.example"})
        self.assertEqual(status, 403)
        status, _, _ = self.request("GET", "/api/workspaces", headers={"Host":"malicious.example"})
        self.assertEqual(status, 403)
        status, _, body = self.request("POST", "/api/workspaces", {"name":"Actual"}, {"Origin":f"http://{self.host}"})
        self.assertEqual(status, 201)
        self.assertEqual(json.loads(body)["name"], "Actual")

    def test_api_run_replay_and_static_spa(self):
        headers = {"Origin":f"http://{self.host}"}
        status, _, body = self.request("POST", "/api/threads", {"title":"Test"}, headers)
        self.assertEqual(status, 201)
        thread = json.loads(body)
        status, _, body = self.request("POST", f"/api/threads/{thread['id']}/messages", {"message":"Fixture"}, headers)
        self.assertEqual(status, 202)
        run = json.loads(body)
        self.runner.wait(run["id"], 10)
        status, response_headers, body = self.request("GET", f"/api/runs/{run['id']}/events")
        self.assertEqual(status, 200)
        self.assertEqual(response_headers["Content-Type"], "text/event-stream")
        self.assertIn(b'"status": "completed"', body)
        cursor = self.store.list_events(run["id"])[-1]["id"]
        status, _, body = self.request("GET", f"/api/runs/{run['id']}/events?after={cursor}")
        self.assertEqual(body, b"")
        status, response_headers, body = self.request("GET", "/workspace/a/new")
        self.assertEqual(status, 200)
        self.assertIn(b"research", body)
        self.assertIn("connect-src 'self'", response_headers["Content-Security-Policy"])

    def test_upload_and_artifact_download(self):
        thread = self.store.create_thread()
        headers = {"Origin":f"http://{self.host}", "Content-Type":"application/octet-stream"}
        status, _, body = self.request("POST", f"/api/threads/{thread['id']}/files?name=notes.txt", b"actual upload", headers)
        self.assertEqual(status, 201)
        item = json.loads(body)
        status, response_headers, body = self.request("GET", f"/api/artifacts/{item['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"actual upload")
        self.assertIn("attachment", response_headers["Content-Disposition"])
        status, _, _ = self.request("POST", f"/api/threads/{thread['id']}/files?name=../escape", b"bad", headers)
        self.assertEqual(status, 400)

    def test_generic_delete_waits_for_completion_callback_after_sql_terminal_status(self):
        entered, release = threading.Event(), threading.Event()

        def finalize(run):
            entered.set()
            release.wait(10)

        self.runner.on_run_finished = finalize
        thread = self.store.create_thread(title="Finalization boundary")
        run = self.runner.start(thread["id"], "Fixture", search=False)
        try:
            self.assertTrue(entered.wait(3))
            self.assertEqual(self.store.get_run(run["id"])["status"], "completed")
            self.assertTrue(self.runner.is_active(thread["id"]))
            status, _, body = self.request("DELETE", f"/api/threads/{thread['id']}", headers={"Origin": f"http://{self.host}"})
            self.assertEqual(status, 409)
            self.assertIn("finalizing", json.loads(body)["error"])
            self.assertIsNotNone(self.store.get_thread(thread["id"]))
        finally:
            release.set()
            self.runner.wait(run["id"], 3)
        self.assertFalse(self.runner.is_active(thread["id"]))
        status, _, _ = self.request("DELETE", f"/api/threads/{thread['id']}", headers={"Origin": f"http://{self.host}"})
        self.assertEqual(status, 200)
        self.assertIsNone(self.store.get_thread(thread["id"]))

    def test_compatibility_put_multipart_and_response_csp_override(self):
        def route(handler, method, path, body):
            if path == "/api/test-put" and method == "PUT":
                handler.json(200, {"received": body})
            elif path == "/api/test-multipart" and method == "POST":
                parts = handler.parse_multipart()
                handler.json(200, {"fields": parts["fields"], "files": [{"name": item["filename"], "text": item["data"].decode()} for item in parts["files"]]})
            elif path == "/api/test-report" and method == "GET":
                handler.response_csp = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'"
                handler.json(200, {"ok": True})
            else:
                return False
            return True
        self.server.RequestHandlerClass = make_handler(self.store, self.runner, self.static, route)
        origin = {"Origin": f"http://{self.host}"}
        status, _, body = self.request("PUT", "/api/test-put", {"visibility": "private"}, origin)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["received"], {"visibility": "private"})
        multipart = b'--sample\r\nContent-Disposition: form-data; name="label"\r\n\r\nEvidence\r\n--sample\r\nContent-Disposition: form-data; name="file"; filename="input.txt"\r\nContent-Type: text/plain\r\n\r\nactual bytes\r\n--sample--\r\n'
        status, _, body = self.request("POST", "/api/test-multipart", multipart, {**origin, "Content-Type": "multipart/form-data; boundary=sample"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"fields": {"label": "Evidence"}, "files": [{"name": "input.txt", "text": "actual bytes"}]})
        status, headers, _ = self.request("GET", "/api/test-report")
        self.assertIn("sandbox allow-scripts", headers["Content-Security-Policy"])
        self.assertNotIn("script-src 'self'", headers["Content-Security-Policy"])
        status, headers, _ = self.request("GET", "/workspace/example/new")
        self.assertIn("script-src 'self'", headers["Content-Security-Policy"])


if __name__ == "__main__":
    unittest.main()
