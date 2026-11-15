"""Run the recovered hosted UI against the independent local research service."""

import argparse
from pathlib import Path

from .hosted import HostedAPI
from .runner import RunManager
from .server import ResearchHTTPServer, make_handler
from .store import Store


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8744)
    parser.add_argument("--data-dir", type=Path, default=root / ".local/research")
    parser.add_argument("--static-root", type=Path, default=root / "hosted-preview")
    parser.add_argument("--timeout", type=float, default=1800)
    args = parser.parse_args()
    if not (args.static_root / "index.html").is_file():
        parser.error("Recovered UI missing; run python3 scripts/build_hosted.py first")
    store = Store(args.data_dir)
    runner = RunManager(store, timeout_seconds=args.timeout)
    hosted = HostedAPI(store, runner)
    server = ResearchHTTPServer(("127.0.0.1", args.port), make_handler(store, runner, args.static_root, hosted.route))
    print(f"REA Astra real research: http://127.0.0.1:{server.server_port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        hosted.close()
        runner.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
