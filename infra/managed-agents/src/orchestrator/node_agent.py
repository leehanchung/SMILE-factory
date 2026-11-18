"""Node agent: runs on each worker, manages Firecracker microVM sessions.

Each session is a Firecracker microVM running a harness (Claude Code,
SWE-agent, custom Python, etc.). The node agent:
  - Creates/boots/terminates VMs via FirecrackerSandbox
  - Reports worker capabilities (CPU, GPU, memory, disk, labels)
  - Reports active session tags (for scheduler affinity/anti-affinity)
  - Periodically cleans up dead VMs

Runs as either:
  - K8s DaemonSet (hybrid mode)
  - systemd service on bare metal
"""

import asyncio
import hmac
import json
import logging
import os
import platform
import shutil
from contextlib import asynccontextmanager
from pathlib import Path

import psutil
from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .harness import BUILTIN_HARNESSES, HarnessDefinition, SandboxRuntime
from .sandbox import FirecrackerSandbox, SandboxConfig

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------

class HarnessPayload(BaseModel):
    """Harness config sent by the scheduler."""

    name: str  # Must match a built-in or be a full custom definition
    rootfs_path: str = ""  # Path to rootfs on this worker
    image: str = ""  # OCI image (for rootfs build or container fallback)
    entrypoint: list[str] = []
    command: list[str] = []
    runtime: str = "firecracker"  # "firecracker", "gvisor", "runc"


class ResourceRequestPayload(BaseModel):
    vcpus: int = 2
    memory_mb: int = 2048
    disk_mb: int = 4096
    gpu_count: int = 0
    timeout_seconds: int = 3600

    # Backward compat
    cpu_millicores: int = 0  # If set, converted to vcpus

    def effective_vcpus(self) -> int:
        if self.cpu_millicores > 0:
            return max(1, self.cpu_millicores // 1000)
        return self.vcpus


class CreateSessionRequest(BaseModel):
    # Used to build per-session paths on the host -- never allow separators/"..".
    session_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    harness: HarnessPayload
    env: dict[str, str] = Field(default_factory=dict)
    resource_overrides: dict = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list)

    # Legacy fields (backward compat with hybrid orchestrator)
    agent_config: dict = Field(default_factory=dict)
    environment_config: dict = Field(default_factory=dict)
    redis_url: str = ""
    api_base_url: str = ""
    resource_request: ResourceRequestPayload = Field(
        default_factory=ResourceRequestPayload
    )


class SessionResponse(BaseModel):
    session_id: str
    vm_id: str
    harness_name: str
    status: str
    pid: int | None = None
    tags: list[str] = []
    runtime: str = "firecracker"


class CapabilitiesResponse(BaseModel):
    total_cpu_millicores: int
    total_memory_mb: int
    total_gpu_count: int
    total_disk_mb: int
    available_cpu_millicores: int
    available_memory_mb: int
    available_gpu_count: int
    available_disk_mb: int
    labels: dict[str, str]
    active_session_tags: list[str]
    available_runtimes: list[str]
    available_harnesses: list[str]
    available_rootfs: list[str]  # rootfs images present on this worker


class NodeHealthResponse(BaseModel):
    worker_id: str
    hostname: str
    arch: str
    capabilities: CapabilitiesResponse
    active_sessions: int
    max_sessions: int
    healthy: bool


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

WORKER_ID = os.getenv("WORKER_ID", platform.node())
MAX_SESSIONS = int(os.getenv("MAX_SESSIONS", "20"))
WORKSPACES_ROOT = os.getenv("WORKSPACES_ROOT", "/var/lib/managed-agents/workspaces")
LOGS_ROOT = os.getenv("LOGS_ROOT", "/var/lib/managed-agents/logs")
SOCKETS_ROOT = os.getenv("SOCKETS_ROOT", "/var/lib/managed-agents/sockets")
ROOTFS_ROOT = os.getenv("ROOTFS_ROOT", "/var/lib/managed-agents/rootfs")

# Upper bounds for per-session resource requests (resource_overrides /
# resource_request). Without them an authenticated caller could request
# arbitrarily large VMs or never-ending timeouts and starve the worker.
MAX_SESSION_VCPUS = int(os.getenv("MAX_SESSION_VCPUS", "16"))
MAX_SESSION_MEMORY_MB = int(os.getenv("MAX_SESSION_MEMORY_MB", "65536"))
MAX_SESSION_DISK_MB = int(os.getenv("MAX_SESSION_DISK_MB", "262144"))
MAX_SESSION_TIMEOUT_SECONDS = int(os.getenv("MAX_SESSION_TIMEOUT_SECONDS", "86400"))
KERNEL_PATH = os.getenv(
    "FC_KERNEL_PATH", "/var/lib/managed-agents/kernel/vmlinux"
)

# Worker labels
WORKER_LABELS: dict[str, str] = {}
labels_str = os.getenv("WORKER_LABELS", "")
if labels_str:
    for pair in labels_str.split(","):
        if "=" in pair:
            k, v = pair.split("=", 1)
            WORKER_LABELS[k.strip()] = v.strip()

# Custom harness definitions (loaded from JSON file or env)
CUSTOM_HARNESSES_PATH = os.getenv("CUSTOM_HARNESSES_PATH", "")


# ---------------------------------------------------------------------------
# Security: authentication + override policy
# ---------------------------------------------------------------------------

# Isolation strength, weakest -> strongest. A request may never pick a runtime
# weaker than the harness's own default.
_RUNTIME_STRENGTH: dict[SandboxRuntime, int] = {
    SandboxRuntime.RUNC: 0,
    SandboxRuntime.GVISOR: 1,
    SandboxRuntime.FIRECRACKER: 2,
}
_DEFAULT_ALLOWED_RUNTIMES = "firecracker,gvisor"
_MAX_ARGV_ITEMS = 64
_MAX_ARG_LEN = 4096


def _insecure_dev_mode() -> bool:
    return os.getenv("NODE_AGENT_INSECURE_DEV", "").strip().lower() in {"1", "true", "yes"}


def _configured_token() -> str:
    return os.getenv("NODE_AGENT_TOKEN", "").strip()


def check_auth_configured() -> None:
    """Fail closed: refuse to start without a token unless explicitly opted out."""
    if _configured_token():
        return
    if _insecure_dev_mode():
        logger.warning(
            "NODE_AGENT_TOKEN is unset and NODE_AGENT_INSECURE_DEV=1: the node agent "
            "API is UNAUTHENTICATED. Never run like this outside local development."
        )
        return
    raise RuntimeError(
        "NODE_AGENT_TOKEN is not set. Set it to a shared secret (the orchestrator sends it "
        "as 'Authorization: Bearer <token>'), or set NODE_AGENT_INSECURE_DEV=1 for local dev."
    )


async def require_node_agent_token(authorization: str | None = Header(default=None)) -> None:
    """Bearer-token check for every node-agent endpoint except /healthz."""
    expected = _configured_token()
    if not expected:
        if _insecure_dev_mode():
            return
        raise HTTPException(503, "Node agent authentication is not configured")
    scheme, _, presented = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(
        presented.strip().encode(), expected.encode()
    ):
        raise HTTPException(401, "Invalid or missing bearer token", headers={"WWW-Authenticate": "Bearer"})


def _allowed_runtimes() -> set[SandboxRuntime]:
    raw = os.getenv("NODE_AGENT_ALLOWED_RUNTIMES", _DEFAULT_ALLOWED_RUNTIMES)
    allowed: set[SandboxRuntime] = set()
    for item in raw.split(","):
        item = item.strip().lower()
        if not item:
            continue
        try:
            allowed.add(SandboxRuntime(item))
        except ValueError:
            logger.warning(f"Ignoring unknown runtime in NODE_AGENT_ALLOWED_RUNTIMES: {item!r}")
    return allowed


def _validate_runtime(requested: str, baseline: SandboxRuntime | None) -> SandboxRuntime:
    """Allowlist the runtime and refuse isolation downgrades."""
    try:
        runtime = SandboxRuntime(requested)
    except ValueError as e:
        raise ValueError(f"Unknown runtime '{requested}'") from e
    if runtime not in _allowed_runtimes():
        raise ValueError(f"Runtime '{runtime.value}' is not allowed on this worker")
    if baseline is not None and _RUNTIME_STRENGTH[runtime] < _RUNTIME_STRENGTH[baseline]:
        raise ValueError(
            f"Runtime '{runtime.value}' would downgrade isolation from '{baseline.value}'"
        )
    return runtime


def _validate_rootfs_path(rootfs_path: str) -> str:
    """Only allow rootfs images inside ROOTFS_ROOT (after resolving symlinks / '..')."""
    root = Path(ROOTFS_ROOT).resolve()
    candidate = Path(rootfs_path)
    if not candidate.is_absolute():
        candidate = root / candidate
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root):
        raise ValueError(f"rootfs_path must be inside {root}")
    return str(resolved)


def _image_under_prefix(image: str, prefix: str) -> bool:
    """True when `image` is `prefix` itself or lives under it at a reference boundary.

    A prefix ending in ``/`` names a namespace (``registry.io/team/`` allows
    ``registry.io/team/app:1``). A bare prefix names a repository or namespace,
    so it also allows its tags/digests and sub-paths, but never a sibling whose
    name merely starts the same (``registry.io/team-attacker/x``).
    """
    if prefix.endswith(("/", ":", "@")):
        return image.startswith(prefix)
    return image == prefix or image.startswith((prefix + "/", prefix + ":", prefix + "@"))


def _validate_image(image: str) -> str:
    """Image overrides are only accepted from configured registry prefixes."""
    prefixes = [
        p.strip()
        for p in os.getenv("NODE_AGENT_ALLOWED_IMAGE_PREFIXES", "").split(",")
        if p.strip()
    ]
    if not any(_image_under_prefix(image, p) for p in prefixes):
        raise ValueError(
            "image overrides are not allowed (configure NODE_AGENT_ALLOWED_IMAGE_PREFIXES)"
        )
    return image


def _validate_argv(name: str, argv: list[str]) -> list[str]:
    if len(argv) > _MAX_ARGV_ITEMS:
        raise ValueError(f"{name} has too many items (max {_MAX_ARGV_ITEMS})")
    for arg in argv:
        if len(arg) > _MAX_ARG_LEN or "\x00" in arg:
            raise ValueError(f"{name} contains an invalid argument")
    return argv

sandbox: FirecrackerSandbox = None  # type: ignore[assignment]
_session_tags: dict[str, list[str]] = {}
_session_harness: dict[str, str] = {}  # session_id → harness name
_allocated_resources: dict[str, ResourceRequestPayload] = {}
_all_harnesses: dict[str, HarnessDefinition] = dict(BUILTIN_HARNESSES)


def _load_custom_harnesses() -> None:
    """Load custom harness definitions from JSON file."""
    if not CUSTOM_HARNESSES_PATH or not Path(CUSTOM_HARNESSES_PATH).exists():
        return
    try:
        with open(CUSTOM_HARNESSES_PATH) as f:
            custom = json.load(f)
        for name, defn in custom.items():
            _all_harnesses[name] = HarnessDefinition(name=name, **defn)
        logger.info(f"Loaded {len(custom)} custom harnesses from {CUSTOM_HARNESSES_PATH}")
    except Exception as e:
        logger.error(f"Failed to load custom harnesses: {e}")


def _detect_available_rootfs() -> list[str]:
    """Scan ROOTFS_ROOT for available ext4 rootfs images."""
    rootfs_dir = Path(ROOTFS_ROOT)
    if not rootfs_dir.exists():
        return []
    return [
        f.stem  # e.g. "claude-code" from "claude-code.ext4"
        for f in rootfs_dir.glob("*.ext4")
    ]


def _resolve_harness(payload: HarnessPayload) -> HarnessDefinition:
    """Resolve a harness payload to a full HarnessDefinition.

    Overrides from the payload are validated: rootfs must live under ROOTFS_ROOT,
    images must match NODE_AGENT_ALLOWED_IMAGE_PREFIXES, the runtime must be
    allowlisted and may not be weaker than the registered harness's runtime.
    Raises ValueError on any policy violation.
    """
    entrypoint = _validate_argv("entrypoint", payload.entrypoint)
    command = _validate_argv("command", payload.command)
    rootfs_path = _validate_rootfs_path(payload.rootfs_path) if payload.rootfs_path else ""
    image = _validate_image(payload.image) if payload.image else ""

    # Try built-in / registered harnesses first
    if payload.name in _all_harnesses:
        harness = _all_harnesses[payload.name]
        runtime = _validate_runtime(payload.runtime, baseline=harness.runtime)
        # Apply overrides from payload
        overrides: dict = {}
        if rootfs_path:
            overrides["rootfs_path"] = rootfs_path
        if image:
            overrides["image"] = image
        if entrypoint:
            overrides["entrypoint"] = entrypoint
        if command:
            overrides["command"] = command
        if runtime != harness.runtime:
            overrides["runtime"] = runtime
        if overrides:
            harness = _clone_harness(harness, **overrides)
        return harness

    # Unknown harness — build from payload (must have rootfs or image)
    if not rootfs_path and not image:
        raise ValueError(
            f"Unknown harness '{payload.name}' and no rootfs_path or image provided"
        )
    return HarnessDefinition(
        name=payload.name,
        rootfs_path=rootfs_path,
        image=image,
        entrypoint=entrypoint,
        command=command,
        # Ad-hoc harnesses get no baseline, but still can't go below firecracker
        # unless the operator allowlists a weaker runtime.
        runtime=_validate_runtime(payload.runtime, baseline=None),
    )


def _clone_harness(base: HarnessDefinition, **overrides) -> HarnessDefinition:
    """Create a copy of a harness with specific fields overridden."""
    from dataclasses import asdict, fields as dc_fields

    data = {}
    for f in dc_fields(base):
        data[f.name] = getattr(base, f.name)
    data.update(overrides)

    # Re-create nested objects
    if "network" in data and isinstance(data["network"], dict):
        from .harness import HarnessNetworkPolicy
        data["network"] = HarnessNetworkPolicy(**data["network"])
    if "runtime" in data and isinstance(data["runtime"], str):
        data["runtime"] = SandboxRuntime(data["runtime"])
    return HarnessDefinition(**data)


def _bounded_int(
    overrides: dict, key: str, default: int, maximum: int, minimum: int = 1
) -> int:
    """Read an integer resource override, enforcing minimum <= value <= maximum."""
    if key not in overrides:
        return default
    value = overrides[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"resource override {key!r} must be an integer")
    if not minimum <= value <= maximum:
        raise ValueError(
            f"resource override {key!r}={value} outside allowed range {minimum}..{maximum}"
        )
    return value


def _harness_to_sandbox_config(
    harness: HarnessDefinition,
    session_env: dict[str, str],
    resource_overrides: dict,
) -> SandboxConfig:
    """Convert a HarnessDefinition + session env into a SandboxConfig for Firecracker."""

    # Resolve rootfs path — check worker-local rootfs directory first
    rootfs_path = harness.rootfs_path
    if not rootfs_path or not Path(rootfs_path).exists():
        # Try convention: ROOTFS_ROOT/<harness-name>.ext4
        candidate = Path(ROOTFS_ROOT) / f"{Path(harness.name).name}.ext4"
        if candidate.exists():
            rootfs_path = str(candidate)
        else:
            raise FileNotFoundError(
                f"Rootfs not found for harness '{harness.name}'. "
                f"Checked: {harness.rootfs_path}, {candidate}. "
                f"Build it with: python -m src.orchestrator.rootfs_builder --harness {harness.name}"
            )

    # Merge harness base_env with session-specific env
    merged_env = dict(harness.base_env)
    merged_env.update(session_env)

    # Apply resource overrides (bounded: see MAX_SESSION_*)
    vcpus = _bounded_int(resource_overrides, "vcpus", harness.default_vcpus, MAX_SESSION_VCPUS)
    memory_mb = _bounded_int(
        resource_overrides, "memory_mb", harness.default_memory_mb, MAX_SESSION_MEMORY_MB
    )
    disk_mb = _bounded_int(resource_overrides, "disk_mb", harness.default_disk_mb, MAX_SESSION_DISK_MB)
    # 0 is the documented "no timeout" sentinel (examples/sessions.yaml).
    timeout = _bounded_int(
        resource_overrides,
        "timeout_seconds",
        harness.default_timeout_seconds,
        MAX_SESSION_TIMEOUT_SECONDS,
        minimum=0,
    )

    # Backward compat: cpu_millicores → vcpus
    if "cpu_millicores" in resource_overrides:
        millicores = _bounded_int(
            resource_overrides, "cpu_millicores", 1000, MAX_SESSION_VCPUS * 1000
        )
        vcpus = max(1, millicores // 1000)

    return SandboxConfig(
        vcpu_count=vcpus,
        memory_mb=memory_mb,
        disk_size_mb=disk_mb,
        allow_network=harness.network.enabled,
        allowed_domains=harness.network.resolved_domains(),
        kernel_path=KERNEL_PATH,
        rootfs_path=rootfs_path,
        timeout_seconds=timeout,
        env=merged_env,
        entrypoint=harness.entrypoint or None,
        use_jailer=harness.use_jailer,
    )


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    global sandbox
    check_auth_configured()  # refuse to start without NODE_AGENT_TOKEN
    sandbox = FirecrackerSandbox(
        workspaces_root=WORKSPACES_ROOT,
        logs_root=LOGS_ROOT,
        sockets_root=SOCKETS_ROOT,
    )
    _load_custom_harnesses()
    logger.info(
        f"Node agent started: worker_id={WORKER_ID}, max_sessions={MAX_SESSIONS}, "
        f"labels={WORKER_LABELS}, harnesses={list(_all_harnesses.keys())}, "
        f"rootfs={_detect_available_rootfs()}"
    )

    # Background cleanup task
    async def cleanup_loop():
        while True:
            await asyncio.sleep(60)
            cleaned = await sandbox.cleanup_dead()
            # Also clean our tracking dicts
            active = set(sandbox.active_sessions().keys())
            for sid in list(_session_tags.keys()):
                if sid not in active:
                    _session_tags.pop(sid, None)
                    _session_harness.pop(sid, None)
                    _allocated_resources.pop(sid, None)

    cleanup_task = asyncio.create_task(cleanup_loop())

    yield

    cleanup_task.cancel()
    for sid in list(sandbox.active_sessions().keys()):
        await sandbox.terminate_session(sid)
    logger.info("Node agent shut down")


app = FastAPI(
    title="Managed Agents Node Agent",
    version="0.4.0",
    description="Worker-level agent that manages Firecracker microVM sandboxes",
    lifespan=lifespan,
)

# Every endpoint except /healthz requires the shared bearer token.
router = APIRouter(dependencies=[Depends(require_node_agent_token)])


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/healthz", include_in_schema=False)
async def healthz():
    """Unauthenticated liveness probe (no worker details)."""
    return {"status": "ok"}


@router.post("/sessions", response_model=SessionResponse, status_code=201)
async def create_session(req: CreateSessionRequest):
    """Start a new microVM session."""
    if sandbox.active_session_count() >= MAX_SESSIONS:
        raise HTTPException(503, "Worker at capacity")

    # Resolve harness
    try:
        harness = _resolve_harness(req.harness)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    # Merge env: legacy fields + explicit env
    session_env = dict(req.env)
    if req.redis_url:
        session_env.setdefault("REDIS_URL", req.redis_url)
    if req.api_base_url:
        session_env.setdefault("API_BASE_URL", req.api_base_url)

    # Resource overrides
    overrides = dict(req.resource_overrides)
    if not overrides and req.resource_request:
        overrides = {
            "vcpus": req.resource_request.effective_vcpus(),
            "memory_mb": req.resource_request.memory_mb,
            "disk_mb": req.resource_request.disk_mb,
            "timeout_seconds": req.resource_request.timeout_seconds,
        }

    # Build sandbox config from harness + env + overrides
    try:
        config = _harness_to_sandbox_config(harness, session_env, overrides)
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(400, str(e)) from e

    # Boot the microVM
    try:
        info = await sandbox.create_session(
            session_id=req.session_id,
            config=config,
        )
    except Exception as e:
        logger.error(f"Failed to create session {req.session_id}: {e}")
        raise HTTPException(500, f"Failed to create session: {e}") from e

    _session_tags[req.session_id] = req.tags
    _session_harness[req.session_id] = harness.name
    _allocated_resources[req.session_id] = req.resource_request

    return SessionResponse(
        session_id=req.session_id,
        vm_id=info.vm_id,
        harness_name=harness.name,
        status="running",
        pid=info.pid,
        tags=req.tags,
        runtime=harness.runtime.value,
    )


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str):
    await sandbox.terminate_session(session_id)
    _session_tags.pop(session_id, None)
    _session_harness.pop(session_id, None)
    _allocated_resources.pop(session_id, None)


@router.get("/sessions/{session_id}", response_model=SessionResponse)
async def get_session(session_id: str):
    info = await sandbox.get_session_info(session_id)
    if info is None:
        raise HTTPException(404, "Session not found or terminated")

    status = await sandbox.get_session_status(session_id)

    return SessionResponse(
        session_id=session_id,
        vm_id=info.vm_id,
        harness_name=_session_harness.get(session_id, "unknown"),
        status=status,
        pid=info.pid,
        tags=_session_tags.get(session_id, []),
    )


@router.get("/sessions", response_model=list[SessionResponse])
async def list_sessions():
    result = []
    for sid, info in sandbox.active_sessions().items():
        status = await sandbox.get_session_status(sid)
        result.append(
            SessionResponse(
                session_id=sid,
                vm_id=info.vm_id,
                harness_name=_session_harness.get(sid, "unknown"),
                status=status,
                pid=info.pid,
                tags=_session_tags.get(sid, []),
            )
        )
    return result


@router.get("/sessions/{session_id}/logs")
async def stream_session_logs(session_id: str):
    info = await sandbox.get_session_info(session_id)
    if info is None:
        raise HTTPException(404, "Session not found")

    return StreamingResponse(
        sandbox.stream_logs(session_id),
        media_type="text/plain",
    )


@router.get("/harnesses")
async def list_harnesses():
    """List all available harnesses on this worker."""
    available_rootfs = set(_detect_available_rootfs())
    return {
        name: {
            "description": h.description,
            "rootfs_path": h.rootfs_path,
            "image": h.image,
            "runtime": h.runtime.value,
            "default_vcpus": h.default_vcpus,
            "default_memory": h.default_memory_mb,
            "rootfs_available": h.name in available_rootfs,
        }
        for name, h in _all_harnesses.items()
    }


@router.get("/health", response_model=NodeHealthResponse)
async def health():
    mem = psutil.virtual_memory()
    cpu_count = psutil.cpu_count() or 1
    disk = shutil.disk_usage(WORKSPACES_ROOT)

    # Calculate allocated resources from active sessions
    allocated_vcpus = sum(r.effective_vcpus() for r in _allocated_resources.values())
    allocated_mem = sum(r.memory_mb for r in _allocated_resources.values())
    allocated_gpu = sum(r.gpu_count for r in _allocated_resources.values())

    total_cpu = cpu_count * 1000  # Report in millicores for scheduler compat
    total_mem = int(mem.total / (1024 * 1024))
    total_gpu = _detect_gpu_count()
    total_disk = int(disk.total / (1024 * 1024))

    all_tags = []
    for tags in _session_tags.values():
        all_tags.extend(tags)

    return NodeHealthResponse(
        worker_id=WORKER_ID,
        hostname=platform.node(),
        arch=platform.machine(),
        capabilities=CapabilitiesResponse(
            total_cpu_millicores=total_cpu,
            total_memory_mb=total_mem,
            total_gpu_count=total_gpu,
            total_disk_mb=total_disk,
            available_cpu_millicores=max(0, total_cpu - allocated_vcpus * 1000),
            available_memory_mb=max(0, total_mem - allocated_mem),
            available_gpu_count=max(0, total_gpu - allocated_gpu),
            available_disk_mb=int(disk.free / (1024 * 1024)),
            labels=dict(WORKER_LABELS),
            active_session_tags=all_tags,
            available_runtimes=_detect_runtimes(),
            available_harnesses=list(_all_harnesses.keys()),
            available_rootfs=_detect_available_rootfs(),
        ),
        active_sessions=sandbox.active_session_count(),
        max_sessions=MAX_SESSIONS,
        healthy=True,
    )


app.include_router(router)


# ---------------------------------------------------------------------------
# Detection helpers
# ---------------------------------------------------------------------------

def _detect_gpu_count() -> int:
    try:
        import subprocess

        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=count", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            return len(result.stdout.strip().split("\n"))
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return 0


def _detect_runtimes() -> list[str]:
    """Detect which sandbox runtimes are available on this worker."""
    runtimes = []
    # Firecracker
    if shutil.which("firecracker"):
        runtimes.append("firecracker")
    # gVisor
    if shutil.which("runsc"):
        runtimes.append("gvisor")
    # Standard containers (fallback)
    if shutil.which("runc"):
        runtimes.append("runc")
    return runtimes or ["firecracker"]  # Assume FC if detection fails


__all__ = ["app"]
