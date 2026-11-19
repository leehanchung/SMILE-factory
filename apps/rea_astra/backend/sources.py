"""Recovered source-picker contracts backed by public services and real files.

No credentials, user Git configuration, private repositories or arbitrary URL
fetches are supported. Search is read-only; only explicit resource addition or
submitted context references acquire content. Feed-file serving is owned by the
experiment service. Public downloads have byte/time caps and reject redirects.
"""

import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET
from email.parser import BytesParser
from email.policy import default
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .store import now

MAX_UPLOAD = 100 * 1024 * 1024
MAX_FETCH = 25 * 1024 * 1024
ALLOWED_HOSTS = {"api.github.com", "huggingface.co", "export.arxiv.org", "arxiv.org"}
REPO = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*\Z")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Public source redirect refused")


def public_fetch(url, limit=MAX_FETCH):
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in ALLOWED_HOSTS
        or parsed.port not in (None, 443)
        or parsed.username
        or parsed.password
    ):
        raise ValueError("Unsupported public source URL")
    # No cookies, Authorization, ambient proxy settings, or redirect traversal.
    opener = build_opener(ProxyHandler({}), NoRedirect())
    request = Request(
        url, headers={"User-Agent": "rea-astra-local/1.0", "Accept": "application/json, application/atom+xml, */*"}
    )
    with opener.open(request, timeout=20) as response:
        if int(response.headers.get("Content-Length", "0")) > limit:
            raise ValueError("Public source exceeds download limit")
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError("Public source exceeds download limit")
        return data


def repo_name(value):
    if value.startswith("https://"):
        parsed = urlsplit(value)
        if parsed.netloc != "github.com" or parsed.query or parsed.fragment:
            raise ValueError("Only public github.com repository URLs are supported")
        value = parsed.path.strip("/")
    value = value.removesuffix(".git")
    if not REPO.fullmatch(value) or any(p in (".", "..") for p in value.split("/")):
        raise ValueError("Expected GitHub owner/repository")
    return value


def clone_public(repo, destination, ref=None):
    """Shallow HTTPS clone without ambient credentials, hooks, or Git config."""
    repo = repo_name(repo)
    if ref and (not isinstance(ref, str) or ref.startswith("-") or len(ref) > 200):
        raise ValueError("Invalid branch")
    env = {
        "PATH": os.defpath,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "/usr/bin/false",
        "GIT_LFS_SKIP_SMUDGE": "1",
    }
    command = [
        "git",
        "-c",
        "credential.helper=",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "http.followRedirects=false",
        "-c",
        "protocol.file.allow=never",
        "clone",
        "--depth=1",
        "--no-recurse-submodules",
    ]
    if ref:
        command += ["--branch", ref]
    command += ["--", "https://github.com/" + repo + ".git", str(destination)]
    with tempfile.TemporaryFile() as log:
        process = subprocess.Popen(command, env=env, stdout=log, stderr=log, start_new_session=True)
        deadline = time.monotonic() + 90
        try:
            while process.poll() is None:
                size = (
                    sum(p.lstat().st_size for p in destination.rglob("*") if not p.is_symlink() and p.is_file())
                    if destination.exists()
                    else 0
                )
                if time.monotonic() > deadline or size > MAX_UPLOAD:
                    raise ValueError("Repository exceeds clone time or size limit")
                time.sleep(0.1)
            if process.returncode:
                raise ValueError("Public repository clone failed; private credentials are unsupported")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()


class SourceService:
    def __init__(self, hosted, fetch=public_fetch, clone=clone_public):
        self.hosted, self.store, self.fetch, self.clone = hosted, hosted.store, fetch, clone
        with self.store.connect() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS source_resources (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, data TEXT NOT NULL)"
            )

    def json_fetch(self, url):
        return json.loads(self.fetch(url, 2 * 1024 * 1024))

    def cache_session(self, workspace):
        if workspace not in {w["id"] for w in self.store.list_workspaces()}:
            raise ValueError("Workspace not found")
        session = "sources_" + workspace
        if not self.store.get_thread(session):
            self.hosted.start_session(workspace, "", "Public source cache", session_id=session, kind="source-cache")
        return session

    def save(self, session, name, content, kind="input"):
        if len(content) > MAX_UPLOAD:
            raise ValueError("File exceeds 100 MiB local upload limit")
        name = re.sub(r"[^A-Za-z0-9_.-]", "_", Path(name.replace("\\", "/")).name).lstrip(".")[:120] or "attachment"
        relative = "uploads/" + uuid.uuid4().hex[:12] + "-" + name
        self.store.write_upload(session, relative, content)
        item = self.store.register_file(session, relative, kind=kind)
        return {**item, "path": str(self.store.file_path(session, relative))}

    def upload(self, h):
        raw = h.body_bytes
        if len(raw) > MAX_UPLOAD + 65536:
            raise ValueError("File exceeds 100 MiB local upload limit")
        content_type = h.headers.get("Content-Type", "")
        if "\r" in content_type or "\n" in content_type or not content_type.lower().startswith("multipart/form-data;"):
            raise ValueError("Expected multipart form-data")
        message = BytesParser(policy=default).parsebytes(
            b"Content-Type: " + content_type.encode("ascii") + b"\r\nMIME-Version: 1.0\r\n\r\n" + raw
        )
        if not message.is_multipart() or message.defects:
            raise ValueError("Invalid multipart boundary")
        fields, files = {}, []
        for index, part in enumerate(message.iter_parts()):
            if index >= 20 or part.is_multipart():
                raise ValueError("Too many or nested multipart fields")
            name = part.get_param("name", header="content-disposition")
            data = part.get_payload(decode=True) or b""
            if name == "file" and part.get_filename():
                files.append((part.get_filename(), data))
            elif name in {"thread_id", "project", "experiment_eid", "artifact_id"}:
                if len(data) > 1000:
                    raise ValueError("Multipart field too long")
                fields[name] = data.decode("utf-8")
        if len(files) != 1:
            raise ValueError("Exactly one file is required")
        session = fields.get("thread_id")
        experiment_id = fields.get("experiment_eid") or fields.get("artifact_id")
        if experiment_id:
            # Artifact-chat uploads deliberately omit thread_id in the original
            # renderer (F:131899); experiment/artifact IDs are not thread IDs.
            experiments = getattr(self.hosted, "experiments", None)
            experiment = experiments.get(experiment_id, fields.get("project")) if experiments else None
            if not experiment:
                raise ValueError("Upload experiment not found")
            session = experiment["worker"]
        if not session:
            session = self.cache_session(fields.get("project") or self.store.list_workspaces()[0]["id"])
        if not self.store.get_thread(session):
            raise ValueError("Upload thread not found; reserve it first")
        item = self.save(session, *files[0])
        return {"path": item["path"], "file_id": item["id"], "size": item["size"]}

    def entries(self):
        entries = []
        for thread in self.store.list_threads():
            for item in self.store.list_files(thread["id"]):
                try:
                    path = self.store.file_path(thread["id"], item["path"])
                    if path.is_file():
                        stat = path.stat()
                        entries.append(
                            {
                                "name": path.name,
                                "path": str(path),
                                "size": stat.st_size,
                                "modified": stat.st_mtime,
                                "is_dir": False,
                            }
                        )
                except (ValueError, OSError):
                    continue
        return entries

    def resolve(self, value):
        root = self.store.workspace_root.resolve()
        candidate = Path(value)
        if not candidate.is_absolute():
            raise ValueError("Expected a local workspace file path")
        try:
            parts = candidate.relative_to(root).parts
        except ValueError:
            raise ValueError("File outside local research workspaces") from None
        if len(parts) < 2:
            raise ValueError("Expected a file")
        relative = str(Path(*parts[1:]))
        self.store.file_path(parts[0], relative)
        return parts[0], relative

    def github(self, repo):
        repo = repo_name(repo)
        data = self.json_fetch("https://api.github.com/repos/" + repo)
        if data.get("private"):
            raise ValueError("Private GitHub credentials are not supported")
        return data

    def arxiv(self, query):
        match = re.fullmatch(
            r"(?:https://arxiv.org/(?:abs|pdf)/)?((?:\d{4}\.\d{4,5}|[a-z-]+/\d{7})(?:v\d+)?)(?:\.pdf)?", query
        )
        args = (
            {"id_list": match[1], "max_results": 10} if match else {"search_query": "all:" + query, "max_results": 10}
        )
        root = ET.fromstring(self.fetch("https://export.arxiv.org/api/query?" + urlencode(args), 2 * 1024 * 1024))
        ns = {"a": "http://www.w3.org/2005/Atom"}
        rows = []
        for entry in root.findall("a:entry", ns):
            identifier = entry.findtext("a:id", "", ns).rsplit("/abs/", 1)[-1]
            if not re.fullmatch(r"(?:\d{4}\.\d{4,5}|[a-z-]+/\d{7})(?:v\d+)?", identifier):
                continue
            rows.append(
                {
                    "id": identifier,
                    "title": " ".join(entry.findtext("a:title", "", ns).split()),
                    "abstract": entry.findtext("a:summary", "", ns).strip(),
                    "authors": [a.findtext("a:name", "", ns) for a in entry.findall("a:author", ns)],
                    "year": entry.findtext("a:published", "", ns)[:4],
                    "categories": [c.get("term", "") for c in entry.findall("a:category", ns)],
                    "url": "https://arxiv.org/abs/" + identifier,
                    "pdf_url": "https://arxiv.org/pdf/" + identifier,
                }
            )
        return rows

    def hf(self, kind, identifier):
        if kind not in {"model", "dataset"} or not REPO.fullmatch(identifier):
            raise ValueError("Expected a public model or dataset owner/name")
        return self.json_fetch("https://huggingface.co/api/" + kind + "s/" + identifier)

    def resources(self, workspace):
        with self.store.connect() as db:
            return [
                json.loads(row[0])
                for row in db.execute("SELECT data FROM source_resources WHERE workspace=?", (workspace,))
            ]

    def add_repository(self, workspace, value, ref=None):
        repo = repo_name(value)
        existing = next((r for r in self.resources(workspace) if r["name"] == repo and r.get("ref") == ref), None)
        if existing:
            return existing
        metadata = self.github(repo)
        if metadata.get("size", 0) > 50 * 1024:
            raise ValueError("Repository exceeds 50 MiB public source limit")
        session = self.cache_session(workspace)
        destination = self.store.file_path(session, "repo-" + uuid.uuid4().hex)
        try:
            self.clone(repo, destination, ref)
        except Exception:
            if destination.exists():
                shutil.rmtree(destination)
            raise
        org, name = repo.split("/")
        resource = {
            "id": "resource_" + uuid.uuid4().hex,
            "type": "github_repo",
            "name": repo,
            "org": org,
            "repo": name,
            "url": "https://github.com/" + repo,
            "visibility": "public",
            "description": metadata.get("description") or "",
            "added_at": now(),
            "ref": ref,
            "checkout_status": "ok",
            "checkout_path": str(destination),
            "health_status": "ok",
        }
        with self.store.connect() as db:
            db.execute("INSERT INTO source_resources VALUES (?,?,?)", (resource["id"], workspace, json.dumps(resource)))
        return resource

    def prepare_inputs(self, session, body):
        """Before runner.start: materialize submitted refs and return context text.

        Called for plan/start and plan/send. The client already appends uploaded
        paths to message; uploads with thread_id are already in the correct cwd.
        """
        thread = self.store.get_thread(session)
        if not thread:
            raise ValueError("Thread not found")
        prepared = self.hosted.get_meta(session).get("source_inputs", {})
        paths = []
        refs = list(body.get("context_refs") or [])
        # The recovered uploader embeds paths in the message rather than refs.
        # Match registered paths only, never parse arbitrary user text as a path.
        message = body.get("message", "")
        refs.extend({"value": e["path"]} for e in self.entries() if e["path"] in message)
        if body.get("base_repo"):
            refs.append(
                {"resource_url": body["base_repo"], "resource_type": "github_repo", "ref": body.get("base_ref")}
            )
        if len(refs) > 30:
            raise ValueError("At most 30 source references can be acquired per message")
        for ref in refs:
            if not isinstance(ref, dict):
                raise ValueError("Invalid source context reference")
            value = (
                ref.get("resource_url")
                or ref.get("resourceUrl")
                or ref.get("value")
                or ref.get("path")
                or ref.get("checkout_path")
                or ref.get("checkoutPath")
            )
            if not isinstance(value, str) or not value:
                raise ValueError("Source reference must have a nonempty value")
            local_type = ref.get("type") if ref.get("type") in ("thread", "experiment") else None
            # Local transcripts can change between submissions. Snapshot them
            # again, rather than reusing an earlier discussion as current state.
            if local_type:
                acquired = self.local_context(session, local_type, value, ref.get("workspace"))
                prepared[value] = acquired
                paths.extend(acquired)
                continue
            if prepared.get(value) and all(self.prepared_exists(p) for p in prepared[value]):
                paths.extend(prepared[value])
                continue
            acquired = []
            if value.startswith("hf://"):
                identifier = value[5:]
                kind = "dataset" if ref.get("attachment_kind", ref.get("attachmentKind")) == "data" else "model"
                metadata = self.hf(kind, identifier)
                if metadata.get("private") or metadata.get("gated"):
                    raise ValueError("Gated/private Hugging Face sources require unsupported credentials")
                acquired.append(
                    self.save(session, identifier.replace("/", "-") + ".json", json.dumps(metadata, indent=2).encode())[
                        "path"
                    ]
                )
            elif value.startswith("https://arxiv.org/"):
                hits = self.arxiv(value)
                if not hits:
                    raise ValueError("arXiv paper not found")
                hit = hits[0]
                acquired.append(self.save(session, hit["id"] + ".json", json.dumps(hit, indent=2).encode())["path"])
                acquired.append(self.save(session, hit["id"] + ".pdf", self.fetch(hit["pdf_url"], MAX_FETCH))["path"])
            elif (
                value.startswith("https://github.com/")
                or ref.get("resource_type", ref.get("resourceType")) == "github_repo"
            ):
                resource = self.add_repository(thread["workspace_id"], value, ref.get("ref"))
                acquired.extend(self.copy_repository(session, resource["checkout_path"]))
            elif value.startswith("/"):
                source_session, relative = self.resolve(value)
                source = self.store.file_path(source_session, relative)
                if not source.exists():
                    raise ValueError("Selected source file no longer exists")
                if source.is_dir():
                    acquired.extend(self.copy_repository(session, str(source)))
                elif source_session == session:
                    acquired.append(value)
                else:
                    with self.store.open_file(source_session, relative) as stream:
                        acquired.append(self.save(session, source.name, stream.read(MAX_UPLOAD + 1))["path"])
            else:
                raise ValueError(
                    "Unsupported source reference: only selected local files, threads, experiments, GitHub, arXiv, and Hugging Face are supported"
                )
            prepared[value] = acquired
            paths.extend(acquired)
        self.hosted.set_meta(session, source_inputs=prepared)
        return (
            "\n\nAcquired source files in your working directory:\n" + "\n".join("- " + p for p in paths)
            if paths
            else ""
        )

    def local_context(self, destination, kind, value, workspace=None):
        """Snapshot explicitly selected local conversations and copy artifacts.

        Recovered refs use {type:'thread',value:session,workspace?:id} or
        {type:'experiment',value:eid} (F:219895,224623,224912). Human display
        experiment numbers are not identifiers and cannot resolve ambiguously.
        """
        experiments = getattr(self.hosted, "experiments", None)
        experiment = experiments.get(value, workspace) if kind == "experiment" and experiments else None
        source_session = experiment["worker"] if experiment else value
        if kind == "experiment" and not experiment:
            raise ValueError("Selected experiment source not found")
        source = self.store.get_thread(source_session)
        if not source or (workspace and source["workspace_id"] != workspace):
            raise ValueError("Selected thread source not found in this workspace")
        sessions = [source_session]
        related = [experiment] if experiment else []
        if kind == "thread":
            with self.store.connect() as db:
                if db.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='hosted_experiments'"
                ).fetchone():
                    related = [
                        dict(row)
                        for row in db.execute(
                            "SELECT * FROM hosted_experiments WHERE parent=? AND deleted=0", (source_session,)
                        )
                    ]
                    sessions.extend(row["worker"] for row in related)
        snapshot = {
            "source_type": kind,
            "source_id": value,
            "workspace_id": source["workspace_id"],
            "title": source["title"],
            "captured_at": now(),
            "conversations": [],
            "artifacts": [],
            "experiments": [
                {key: exp.get(key) for key in ("eid", "title", "body", "display_label", "parent", "worker")}
                for exp in related
            ],
        }
        acquired, total, count = [], 0, 0
        for current in dict.fromkeys(sessions):
            thread = self.store.get_thread(current)
            if not thread:
                continue
            # Bounded, explicit snapshots retain the newest 200 messages.
            with self.store.connect() as db:
                message_count = db.execute("SELECT count(*) FROM messages WHERE thread_id=?", (current,)).fetchone()[0]
                rows = list(
                    reversed(
                        db.execute(
                            "SELECT role,content,created_at,run_id FROM messages WHERE thread_id=? ORDER BY rowid DESC LIMIT 200",
                            (current,),
                        ).fetchall()
                    )
                )
            messages = [
                {**dict(row), "content": row["content"][:20000], "content_truncated": len(row["content"]) > 20000}
                for row in rows
            ]
            snapshot["conversations"].append(
                {
                    "thread_id": current,
                    "title": thread["title"],
                    "messages": messages,
                    "total_messages": message_count,
                    "messages_truncated": message_count > len(messages),
                    "runs": [
                        {key: run.get(key) for key in ("id", "status", "created_at", "finished_at", "error")}
                        for run in self.store.list_runs(current)[-50:]
                    ],
                }
            )
            for item in self.store.list_files(current):
                # Don't recursively reattach earlier conversation snapshots.
                if item["kind"] == "context":
                    continue
                source_path = self.store.file_path(current, item["path"])
                with self.store.open_file(current, item["path"]) as stream:
                    content = stream.read(MAX_UPLOAD + 1)
                count += 1
                total += len(content)
                if count > 200 or total > MAX_UPLOAD:
                    raise ValueError("Selected source artifacts exceed 200 files or 100 MiB")
                local = (
                    str(source_path)
                    if current == destination
                    else self.save(destination, source_path.name, content, kind="context")["path"]
                )
                snapshot["artifacts"].append(
                    {"source_thread": current, "source_path": item["path"], "local_path": local, "bytes": len(content)}
                )
                acquired.append(local)
        encoded = json.dumps(snapshot, indent=2).encode()
        if len(encoded) > 5 * 1024 * 1024:
            raise ValueError("Selected source transcript exceeds 5 MiB snapshot limit")
        context_file = self.save(destination, kind + "-" + value + "-context.json", encoded, kind="context")["path"]
        return [context_file, *acquired]

    def prepared_exists(self, path):
        try:
            session, relative = self.resolve(path)
            return self.store.file_path(session, relative).exists()
        except (ValueError, OSError):
            return False

    def copy_repository(self, session, source):
        source_session, relative = self.resolve(source)
        source_path = self.store.file_path(source_session, relative)
        # Only acquired repository roots may be copied; never arbitrary directories.
        resources = [r for w in self.store.list_workspaces() for r in self.resources(w["id"])]
        if source not in {r["checkout_path"] for r in resources}:
            raise ValueError("Directory is not an acquired public repository")
        destination = self.store.file_path(session, "source-" + uuid.uuid4().hex[:12])
        destination.mkdir(mode=0o700)
        total, count = 0, 0
        for path in source_path.rglob("*"):
            relative_path = path.relative_to(source_path)
            if any(p.startswith(".") for p in relative_path.parts) or path.is_symlink() or not path.is_file():
                continue
            total += path.stat().st_size
            count += 1
            if total > MAX_UPLOAD or count > 10000:
                raise ValueError("Repository exceeds local source-copy limit")
            with self.store.open_file(source_session, str(Path(relative) / relative_path)) as stream:
                content = stream.read(MAX_UPLOAD + 1)
                if len(content) > MAX_UPLOAD:
                    raise ValueError("Source file exceeds size limit")
                self.write_source_file(session, str(Path(destination.name) / relative_path), content)
        return [str(destination)]

    def write_source_file(self, session, relative, content):
        """Create source files without following a concurrently substituted link."""
        self.store.file_path(session, relative)
        descriptor = os.open(self.store.thread_path(session), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            parts = Path(relative).parts
            for part in parts[:-1]:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                os.close(descriptor)
                descriptor = child
            fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
            with os.fdopen(fd, "wb") as stream:
                stream.write(content)
        finally:
            os.close(descriptor)

    def route(self, h, method, path, body):
        q = lambda key, fallback="": h.query.get(key, [fallback])[0]
        reply = lambda value, status=200: h.json(status, value)
        owned = path in {
            "/api/upload",
            "/api/artifacts/browse",
            "/api/artifacts/search",
            "/api/artifacts/stat",
            "/api/arxiv/search",
            "/api/huggingface/search",
            "/api/huggingface/check",
            "/api/huggingface/status",
            "/api/team/github/search",
            "/api/team/github/my-repos",
            "/api/team/github/branches",
            "/api/team/github/connect",
        } or path.startswith("/api/team/resources")
        if not owned:
            return False
        try:
            if path.startswith("/api/huggingface/") and h.headers.get("Close-HF-Token"):
                reply({"error": "Hugging Face credentials are unsupported; public metadata works without a token"}, 501)
                return True
            if path == "/api/upload" and method == "POST":
                reply(self.upload(h))
            elif path == "/api/artifacts/browse" and method == "GET":
                entries = self.entries()
                if q("path"):
                    entries = [e for e in entries if str(Path(e["path"]).parent) == q("path")]
                offset, limit = max(0, int(q("offset", "0"))), min(200, max(1, int(q("limit", "200"))))
                reply(
                    {
                        "entries": entries[offset : offset + limit],
                        "total": len(entries),
                        "truncated": offset + limit < len(entries),
                    }
                )
            elif path == "/api/artifacts/search" and method == "GET":
                entries = [e for e in self.entries() if q("q").lower() in e["name"].lower()]
                reply({"results": entries[:200], "truncated": len(entries) > 200})
            elif path == "/api/artifacts/stat" and method == "GET":
                entries = {e["path"]: e for e in self.entries()}
                reply(
                    {
                        "results": [
                            {**entries.get(p, {"path": p}), "exists": p in entries} for p in q("paths").split(",")[:100]
                        ]
                    }
                )
            elif path == "/api/arxiv/search" and method == "GET":
                reply(self.arxiv(q("q")[:500]))
            elif path == "/api/huggingface/status" and method == "GET":
                reply({"token_set": False})
            elif path == "/api/huggingface/search" and method == "GET":
                kind = q("type", "model")
                if kind not in {"model", "dataset"}:
                    raise ValueError("Unsupported Hugging Face source type")
                reply(
                    self.json_fetch(
                        "https://huggingface.co/api/"
                        + kind
                        + "s?"
                        + urlencode(
                            {
                                "search": q("query")[:300],
                                "limit": 20,
                                "full": "true",
                                "sort": "downloads",
                                "direction": -1,
                            }
                        )
                    )
                )
            elif path == "/api/huggingface/check" and method == "GET":
                item = self.hf(q("type", "model"), q("id"))
                blocked = item.get("private") or item.get("gated")
                reply({"accessible": not bool(blocked), "reason": "gated" if blocked else None})
            elif path == "/api/team/github/search" and method == "GET":
                result = self.json_fetch(
                    "https://api.github.com/search/repositories?"
                    + urlencode({"q": q("q")[:300] + " is:public", "per_page": 20})
                )
                reply(result.get("items", []))
            elif path == "/api/team/github/my-repos" and method == "GET":
                reply({"connected": False, "repos": []})
            elif path == "/api/team/github/connect":
                reply(
                    {
                        "error": "GitHub account credentials are unsupported; public repository search and import work without login"
                    },
                    501,
                )
            elif path == "/api/team/github/branches" and method == "GET":
                repo = repo_name(q("repo"))
                metadata = self.github(repo)
                branches = self.json_fetch("https://api.github.com/repos/" + repo + "/branches?per_page=100")
                reply(
                    {
                        "default_branch": metadata.get("default_branch"),
                        "branches": [b["name"] for b in branches if q("q").lower() in b["name"].lower()],
                    }
                )
            elif path == "/api/team/resources/preflight" and method == "POST":
                metadata = self.github(body.get("url", ""))
                reply(
                    {
                        "exists": True,
                        "detected_type": "github_repo",
                        "access_status": "ok",
                        "name": metadata["full_name"],
                    }
                )
            elif path == "/api/team/resources" and method == "GET":
                reply({"resources": self.resources(q("workspace_id"))})
            elif path == "/api/team/resources" and method == "POST":
                if body.get("type") != "github_repo":
                    raise ValueError("Only public GitHub repository additions are supported here")
                resource = self.add_repository(q("workspace_id"), body.get("url", ""))
                reply({"resource": resource, "needs_github_connection": False})
            elif match := re.fullmatch(r"/api/team/resources/([^/]+)(/verify)?", path):
                resource = next((r for r in self.resources(q("workspace_id")) if r["id"] == match[1]), None)
                if not resource:
                    reply({"error": "Resource not found"}, 404)
                elif method == "DELETE" and not match[2]:
                    with self.store.connect() as db:
                        db.execute("DELETE FROM source_resources WHERE id=?", (match[1],))
                    reply({"ok": True})
                elif method == "POST" and match[2]:
                    self.github(resource["url"])
                    reply({**resource, "resource": resource, "needs_github_connection": False})
                else:
                    reply({"error": "Method not supported"}, 405)
            else:
                reply({"error": "Method not supported"}, 405)
        except HTTPError as exc:
            reply({"error": f"Public source unavailable (HTTP {exc.code}); credentials are not used"}, 502)
        except (URLError, TimeoutError, OSError) as exc:
            reply({"error": "Public source acquisition failed: " + str(exc)}, 502)
        except (ValueError, ET.ParseError) as exc:
            reply({"error": str(exc)}, 400)
        return True
