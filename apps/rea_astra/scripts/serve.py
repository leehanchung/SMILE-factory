#!/usr/bin/env python3
"""Serve the offline reconstruction on loopback, without backend/proxy access."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class PreviewHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        requested = Path(self.translate_path(self.path)).resolve()
        root = Path(self.directory).resolve()
        if not requested.is_relative_to(root):
            self.send_error(403, "Outside preview directory")
            return None
        if requested.is_dir() and not (requested / "index.html").is_file():
            self.send_error(404, "Directory listing disabled")
            return None
        return super().send_head()

    def end_headers(self):
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8743)
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parents[1] / "preview")
    args = parser.parse_args()
    if not (args.directory / "index.html").is_file():
        parser.error("Preview missing; run make build first")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(PreviewHandler, directory=str(args.directory)))
    print(f"REA Astra: http://127.0.0.1:{server.server_port}/ (local simulation)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
