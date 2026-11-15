from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from serve import PreviewHandler


class ServerTests(unittest.TestCase):
    def test_serves_only_preview_and_blocks_external_connections(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            preview = base / "preview"
            preview.mkdir()
            (preview / "index.html").write_text("<!doctype html><title>Local test</title>")
            secret = base / "private.txt"
            secret.write_text("must not serve")
            (preview / "escape.txt").symlink_to(secret)
            (preview / "empty").mkdir()
            server = ThreadingHTTPServer(("127.0.0.1", 0), partial(PreviewHandler, directory=str(preview)))
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            url = f"http://127.0.0.1:{server.server_port}"
            try:
                with urlopen(url) as response:
                    self.assertIn(b"Local test", response.read())
                    self.assertIn("connect-src 'none'", response.headers["Content-Security-Policy"])
                    self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
                for path, code in (("/escape.txt", 403), ("/empty/", 404), ("/../private.txt", 404)):
                    with self.subTest(path=path), self.assertRaises(HTTPError) as error:
                        urlopen(url + path)
                    self.assertEqual(error.exception.code, code)
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
