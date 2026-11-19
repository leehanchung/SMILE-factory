"""Bounded real-agent subprocess execution, durable events, and cancellation."""

import hashlib
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from .store import now

MODEL = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,99}$")
DEFAULT_INSTRUCTIONS = """You are the real research agent for REA Astra, a local research workspace.
Work only in the current workspace. User attachments are in uploads/ if present.
Use real tools and report real evidence; never claim an experiment ran unless you executed it.
Save useful research outputs and reproducible code in this directory, with report.md for the final report.
For research using the web, cite primary-source URLs and distinguish observed facts from hypotheses.
Do not access credentials, other projects, or unrelated personal files. Do not install packages,
publish, push, deploy, send messages externally, or delegate to other agents unless the user explicitly asks.
If a tool or service is unavailable, report that failure honestly. Do not substitute simulated findings.
"""


def redact(value):
    if isinstance(value, dict):
        return {key: ("[redacted]" if re.search(r"^(access_token|refresh_token|api_key|authorization)$", key, re.IGNORECASE) else redact(item)) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        value = re.sub(r"\bBearer\s+[A-Za-z0-9._~+/-]+=*", "Bearer [redacted]", value, flags=re.IGNORECASE)
        value = re.sub(r"\bsk-[A-Za-z0-9_-]{16,}", "[redacted-api-key]", value)
        value = re.sub(r"(?i)((?:OPENAI_API_KEY|ANTHROPIC_API_KEY|ACCESS_TOKEN|REFRESH_TOKEN)\s*[=:]\s*)[^\s\"']+", r"\1[redacted]", value)
    return value


# Environment forwarded to the agent subprocess. Allowlist, not denylist: the
# backend's own environment can carry unrelated credentials (cloud, VCS, other
# model providers, ...), and anything forwarded is visible to the agent and to
# every command it runs. Codex itself only needs a working process environment,
# its own config/auth home (CODEX_HOME, default ~/.codex), OpenAI API settings
# when API-key auth is used, and network/TLS settings for corporate proxies.
AGENT_ENV_KEYS = frozenset({
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TZ",
    "TMPDIR", "TMP", "TEMP", "__CF_USER_TEXT_ENCODING",
    "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    # Non-secret trust-store paths, so corporate-CA setups keep working for every client.
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
    "GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "CODEX_CA_CERTIFICATE", "RUST_LOG",
    # Codex CLI auth/config. Enumerated explicitly (no OPENAI_*/CODEX_* prefix
    # match) so unrelated provider secrets such as OPENAI_WEBHOOK_SECRET or admin
    # keys never reach the agent.
    "CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL",
    "OPENAI_ORG_ID", "OPENAI_ORGANIZATION", "OPENAI_PROJECT",
})
# Locale categories only (LC_ALL, LC_CTYPE, ...): never secrets.
AGENT_ENV_PREFIXES = ("LC_",)


def agent_env(source=None):
    """Return the allowlisted subset of ``source`` (default ``os.environ``) for the agent subprocess."""
    source = os.environ if source is None else source
    return {key: value for key, value in source.items() if key in AGENT_ENV_KEYS or key.startswith(AGENT_ENV_PREFIXES)}


def provider_status(executable="codex"):
    binary = shutil.which(executable)
    result = {"provider": "codex", "installed": bool(binary), "authenticated": False,
              "auth_method": "unknown", "capabilities": ["coding", "research", "files", "web_search", "streaming", "cancel"]}
    if not binary:
        return result
    try:
        version = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=10, check=False)
        result["version"] = version.stdout.strip().splitlines()[-1] if version.stdout.strip() else "unknown"
        status = subprocess.run([binary, "login", "status"], capture_output=True, text=True, timeout=10, check=False)
        text = status.stdout + status.stderr
        result["authenticated"] = status.returncode == 0 and "Logged in" in text
        result["auth_method"] = "ChatGPT" if "ChatGPT" in text else "API key" if "API key" in text else "unknown"
    except (OSError, subprocess.TimeoutExpired):
        result["error"] = "Could not inspect installed CLI status"
    return result


@dataclass
class Handle:
    thread_id: str = ""
    cancel: threading.Event = field(default_factory=threading.Event)
    process: subprocess.Popen | None = None
    worker: threading.Thread | None = None


class RunManager:
    def __init__(self, store, timeout_seconds=600, command_factory=None, max_output_bytes=16 * 1024 * 1024,
                 max_concurrent=2, on_run_finished=None, executable="codex"):
        self.store = store
        self.timeout_seconds = timeout_seconds
        self.command_factory = command_factory
        self.max_output_bytes = max_output_bytes
        self.max_concurrent = max_concurrent
        self.on_run_finished = on_run_finished
        self.executable = executable
        self._lock = threading.RLock()
        self._handles = {}
        self._closing = False
        self.store.interrupt_abandoned_runs()

    def start(self, thread_id, prompt, model="", auto_research=True, instructions="", search=True):
        thread = self.store.get_thread(thread_id)
        if not thread:
            raise ValueError("Thread not found")
        if not isinstance(auto_research, bool) or not isinstance(search, bool):
            raise ValueError("auto_research and search must be booleans")
        model = model or thread.get("planner_model") or ""
        if model == "codex-default":
            model = ""
        if model and (not isinstance(model, str) or not MODEL.fullmatch(model)):
            raise ValueError("Invalid model name")
        with self._lock:
            if self._closing:
                raise ValueError("Backend is shutting down")
            if self.is_active(thread_id):
                raise ValueError("A run is already active or finalizing for this thread")
            if len(self._handles) >= self.max_concurrent:
                raise ValueError("Research capacity reached; wait for a current run to finish")
            run = self.store.create_run(thread_id, prompt, model=model, auto_research=auto_research)
            handle = Handle(thread_id=thread_id)
            self._handles[run["id"]] = handle
            handle.worker = threading.Thread(target=self._run, args=(run, thread, prompt, instructions, search, handle), daemon=True, name=f"research-{run['id']}")
            handle.worker.start()
        return run

    def is_active(self, thread_id):
        """Keep a thread reserved through durable completion projection."""
        with self._lock:
            return any(handle.thread_id == thread_id for handle in self._handles.values())

    def _command(self, run, thread, workspace, search):
        if self.command_factory:
            return self.command_factory(run, thread, workspace)
        executable = shutil.which(self.executable)
        if not executable:
            raise RuntimeError("Codex CLI is not installed or not on PATH")
        argv = [executable, "-a", "never", "-s", "workspace-write", "-C", str(workspace)]
        if search:
            argv.append("--search")
        argv.extend(["exec", "--ignore-user-config", "--json", "--skip-git-repo-check"])
        if run["model"]:
            argv.extend(["--model", run["model"]])
        if thread.get("provider_thread_id"):
            argv.extend(["resume", thread["provider_thread_id"]])
        argv.append("-")
        return argv

    @staticmethod
    def _stop(process):
        if process is None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        except PermissionError:
            # On macOS a reaped/vanished process group can report EPERM, not ESRCH.
            # Never retry a foreign group; a live owned launcher can still be terminated directly.
            if process.poll() is not None:
                return
            process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            process.wait(timeout=5)
        # The launcher may have exited while a tool child still holds a pipe open.
        # The process group is ours even after the direct child has been reaped.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

    def cancel(self, run_id):
        with self._lock:
            handle = self._handles.get(run_id)
            if handle:
                handle.cancel.set()
                process = handle.process
            else:
                process = None
        if process:
            self._stop(process)
        return self.store.get_run(run_id)

    def shutdown(self):
        with self._lock:
            self._closing = True
            handles = list(self._handles.values())
            for handle in handles:
                handle.cancel.set()
        for handle in handles:
            self._stop(handle.process)
        for handle in handles:
            if handle.worker and handle.worker is not threading.current_thread():
                handle.worker.join(timeout=10)

    def wait(self, run_id, timeout=30):
        with self._lock:
            handle = self._handles.get(run_id)
        if handle and handle.worker and handle.worker is not threading.current_thread():
            handle.worker.join(timeout=timeout)
        return self.store.get_run(run_id)

    def _scan_files(self, thread_id, run_id, previous):
        root = self.store.thread_path(thread_id)
        count = 0
        for directory, dirs, names in os.walk(root, followlinks=False):
            dirs[:] = [name for name in dirs if not name.startswith(".") and name not in {"node_modules", "__pycache__", "venv"} and not (Path(directory) / name).is_symlink()]
            for name in names:
                path = Path(directory) / name
                if name.startswith(".") or path.is_symlink() or path.suffix in {".pyc"}:
                    continue
                count += 1
                if count > 500:
                    self.store.add_event(run_id, "artifact.warning", {"message": "Artifact inventory limited to 500 files"})
                    return
                relative = path.relative_to(root).as_posix()
                try:
                    if path.stat().st_size > 100 * 1024 * 1024:
                        continue
                    with path.open("rb") as stream:
                        digest = hashlib.file_digest(stream, "sha256").hexdigest()
                    if previous.get(relative) == digest:
                        continue
                    item = self.store.register_file(thread_id, relative, run_id)
                    self.store.add_event(run_id, "artifact.created", item)
                except (OSError, ValueError):
                    continue

    def _run(self, run, thread, prompt, instructions, search, handle):
        run_id = run["id"]
        final_messages = {}
        usage = None
        error = None
        completed = False
        return_code = None
        process = None
        stop_readers = threading.Event()
        terminal = "failed"
        previous = {item["path"]: item["sha256"] for item in self.store.list_files(thread["id"])}
        try:
            if handle.cancel.is_set():
                terminal = "cancelled"
                return
            workspace = self.store.thread_path(thread["id"])
            workspace.mkdir(parents=True, exist_ok=True)
            argv = self._command(run, thread, workspace, search)
            self.store.update_run(run_id, status="running", started_at=now())
            self.store.add_event(run_id, "run.started", {"run_id": run_id, "provider": "codex", "model": run["model"] or "default", "auto_research": bool(run["auto_research"]), "sandbox": "workspace-write"})
            env = agent_env()
            process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       cwd=workspace, env=env, start_new_session=True, bufsize=0)
            with self._lock:
                handle.process = process
            full_prompt = DEFAULT_INSTRUCTIONS + "\n" + instructions + "\n\nUser request:\n" + prompt
            if not run["auto_research"]:
                full_prompt += "\n\nAuto-research is disabled: gather only evidence needed to propose a plan; do not run a substantial experiment until explicitly approved."
            data = full_prompt.encode()
            def write_input():
                try:
                    remaining = memoryview(data)
                    while remaining:
                        count = process.stdin.write(remaining)
                        remaining = remaining[count:]
                    process.stdin.close()
                except (BrokenPipeError, OSError, ValueError):
                    pass
            threading.Thread(target=write_input, daemon=True).start()
            output_queue = queue.Queue(maxsize=256)
            def enqueue(item):
                while not stop_readers.is_set():
                    try:
                        output_queue.put(item, timeout=0.2)
                        return
                    except queue.Full:
                        continue
            def drain(stream, source):
                try:
                    while True:
                        line = stream.readline(1024 * 1024 + 1)
                        if not line:
                            break
                        enqueue((source, line))
                except (OSError, ValueError):
                    pass
                finally:
                    enqueue((source, None))
            readers = [threading.Thread(target=drain, args=(process.stdout, "stdout"), daemon=True), threading.Thread(target=drain, args=(process.stderr, "stderr"), daemon=True)]
            for reader in readers:
                reader.start()
            deadline = time.monotonic() + self.timeout_seconds
            ended, total = set(), 0
            while len(ended) < 2:
                if handle.cancel.is_set():
                    terminal = "cancelled"
                    break
                if time.monotonic() >= deadline:
                    error = f"Run exceeded {self.timeout_seconds:g} seconds"
                    break
                try:
                    source, line = output_queue.get(timeout=0.2)
                except queue.Empty:
                    continue
                if line is None:
                    ended.add(source)
                    continue
                total += len(line)
                if total > self.max_output_bytes or len(line) > 1024 * 1024:
                    error = "Provider output exceeded configured size limit"
                    break
                text = line.decode("utf-8", errors="replace").strip()
                if not text:
                    continue
                if source == "stderr":
                    self.store.add_event(run_id, "provider.stderr", {"text": redact(text[:16000])})
                    continue
                try:
                    event = json.loads(text)
                except json.JSONDecodeError:
                    self.store.add_event(run_id, "provider.warning", {"message": "Non-JSON provider output omitted"})
                    continue
                if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                    continue
                event = redact(event)
                kind = event["type"]
                self.store.add_event(run_id, kind, event)
                if kind == "thread.started" and isinstance(event.get("thread_id"), str):
                    self.store.update_thread(thread["id"], provider_thread_id=event["thread_id"])
                    self.store.update_run(run_id, provider_thread_id=event["thread_id"])
                elif kind == "item.completed":
                    item = event.get("item", {})
                    if isinstance(item, dict) and item.get("type") == "agent_message" and isinstance(item.get("text"), str):
                        final_messages[item.get("id", str(len(final_messages)))] = item["text"]
                elif kind == "turn.completed":
                    completed, usage = True, event.get("usage")
                elif kind in {"turn.failed", "error"}:
                    detail = event.get("error", event)
                    error = detail.get("message", "Provider failed") if isinstance(detail, dict) else str(detail)
            if handle.cancel.is_set():
                terminal = "cancelled"
            if error or terminal == "cancelled":
                self._stop(process)
            try:
                return_code = process.wait(timeout=max(0.1, min(5, deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                error = error or "Provider did not exit after its output closed"
                self._stop(process)
                return_code = process.returncode
            stop_readers.set()
            for reader in readers:
                reader.join(timeout=1)
            if terminal != "cancelled":
                if return_code == 0 and completed and not error:
                    terminal = "completed"
                else:
                    terminal = "failed"
                    error = error or f"Provider exited {return_code} without a completed turn"
            self._scan_files(thread["id"], run_id, previous)
        except Exception as exc:
            error = redact(str(exc))[:2000]
            terminal = "cancelled" if handle.cancel.is_set() else "failed"
        finally:
            stop_readers.set()
            if process:
                self._stop(process)
                return_code = process.returncode
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream:
                        try:
                            stream.close()
                        except OSError:
                            pass
            final_text = "\n\n".join(final_messages.values())
            self.store.finish_run(run_id, terminal, final_text=final_text, error=error, return_code=return_code, usage=usage)
            self.store.add_event(run_id, "run.finished", {"run_id": run_id, "status": terminal, "error": error, "return_code": return_code, "usage": usage})
            try:
                if self.on_run_finished:
                    try:
                        self.on_run_finished(self.store.get_run(run_id))
                    except Exception as exc:
                        self.store.add_event(run_id, "integration.warning", {"message": redact(str(exc))[:1000]})
            finally:
                with self._lock:
                    self._handles.pop(run_id, None)
