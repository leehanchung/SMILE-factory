"""Session orchestrator with pluggable backends and harness-agnostic sandboxing.

Two orchestrator backends:

  - "k8s": Each session = a K8s Job/Pod. Simple setup, ~2-5s startup.
  - "hybrid": K8s control plane + Firecracker microVMs on worker nodes.
    ~125ms boot, harness-agnostic, full kernel-level isolation.

Harnesses (what runs inside each microVM):

  - claude-code: Claude Code CLI with MCP plugins
  - claude-code-discord: Claude Code + Discord bot
  - custom-python: Custom Python agent loop
  - swe-agent: Princeton's SWE-agent
  - openhands: OpenHands (CodeAct agent)
  - aider: AI pair programming
  - (any custom rootfs image)

Sandbox isolation (via Firecracker):

  - Own Linux kernel per session
  - Own filesystem (ext4 rootfs + workspace overlay)
  - Own network stack (TAP device + iptables filtering)
  - Jailer for defense in depth (chroot + seccomp + cgroup)
"""

import os

from .base import (
    BaseOrchestrator,
    ResourceRequest,
    SandboxBackend,
    SchedulingStrategy,
    SessionInfo,
    SessionStatus,
    WorkerCapabilities,
    WorkerInfo,
)
from .harness import (
    BUILTIN_HARNESSES,
    ContainerRuntime,  # backward compat alias
    HarnessDefinition,
    HarnessNetworkPolicy,
    SandboxRuntime,
)
from .sandbox import (
    FirecrackerSandbox,
    MicroVMInfo,
    SandboxConfig,
)
from .container import build_init_container, build_network_policy, build_resource_mounts


def create_orchestrator(
    backend: str | None = None,
    **kwargs,
) -> BaseOrchestrator:
    """Factory: create the right orchestrator based on config.

    Args:
        backend: "k8s" or "hybrid". Defaults to ORCHESTRATOR_BACKEND env var.
        **kwargs: Passed to the orchestrator constructor.
    """
    backend = backend or os.getenv("ORCHESTRATOR_BACKEND", "k8s")

    if backend == "k8s":
        from .k8s import K8sOrchestrator

        return K8sOrchestrator(
            namespace=kwargs.get("namespace", "managed-agents"),
        )

    elif backend == "hybrid":
        from .hybrid import HybridOrchestrator

        return HybridOrchestrator(
            redis_url=kwargs.get("redis_url", os.getenv("REDIS_URL", "redis://localhost:6379")),
            worker_addresses=kwargs.get("worker_addresses"),
            discovery_mode=kwargs.get("discovery_mode", "k8s"),
            k8s_namespace=kwargs.get("k8s_namespace", "managed-agents"),
            k8s_daemonset_name=kwargs.get("k8s_daemonset_name", "node-agent"),
            node_agent_token=kwargs.get("node_agent_token"),
        )

    else:
        raise ValueError(f"Unknown orchestrator backend: {backend!r}. Use 'k8s' or 'hybrid'.")


__all__ = [
    # Orchestrator
    "BaseOrchestrator",
    "create_orchestrator",
    # Models
    "ResourceRequest",
    "SandboxBackend",
    "SchedulingStrategy",
    "SessionInfo",
    "SessionStatus",
    "WorkerCapabilities",
    "WorkerInfo",
    # Harness
    "BUILTIN_HARNESSES",
    "ContainerRuntime",
    "HarnessDefinition",
    "HarnessNetworkPolicy",
    "SandboxRuntime",
    # Sandbox (Firecracker)
    "FirecrackerSandbox",
    "MicroVMInfo",
    "SandboxConfig",
    # K8s helpers
    "build_init_container",
    "build_network_policy",
    "build_resource_mounts",
]
