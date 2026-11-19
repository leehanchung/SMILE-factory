"""Hybrid orchestrator: K8s control plane + node-agent session execution.

The scheduler maintains a registry of worker nodes (discovered via K8s
DaemonSet endpoints or static config). When a session is requested, it:
  1. Builds a ResourceRequest from the session's environment config
  2. Runs the constraint-based scheduler to pick the best worker
  3. POSTs to that worker's node agent to spawn the sandboxed session
  4. Tracks session→worker mapping in Redis for fast lookup

Workers are heterogeneous — different hardware, GPUs, storage, labels.
The scheduler handles bin-packing, affinity, anti-affinity, and
constraint matching across all dimensions.

Horizontal scaling = add more workers (any hardware profile).
"""

import asyncio
import logging
import os
import time
from typing import AsyncIterator, Optional

import httpx
import redis.asyncio as aioredis

from .base import (
    BaseOrchestrator,
    ResourceRequest,
    SchedulingStrategy,
    SessionInfo,
    SessionStatus,
    WorkerCapabilities,
    WorkerInfo,
)
from .scheduler import Scheduler, SchedulerConfig

logger = logging.getLogger(__name__)

# Redis key patterns
SESSION_WORKER_KEY = "session:{session_id}:worker"
SESSION_TAGS_KEY = "session:{session_id}:tags"
SESSION_RESOURCES_KEY = "session:{session_id}:resources"


class HybridOrchestrator(BaseOrchestrator):
    """Schedules sessions across heterogeneous worker nodes."""

    def __init__(
        self,
        redis_url: str,
        worker_addresses: Optional[list[str]] = None,
        discovery_mode: str = "static",  # "static" or "k8s"
        k8s_namespace: str = "managed-agents",
        k8s_daemonset_name: str = "node-agent",
        health_check_interval: int = 10,
        scheduling_strategy: str = "bin_pack",
        node_agent_token: str | None = None,
    ) -> None:
        self.redis_url = redis_url
        # Shared secret for the node agents' bearer auth (see node_agent.py).
        self._node_agent_token = (
            node_agent_token if node_agent_token is not None else os.getenv("NODE_AGENT_TOKEN", "")
        ).strip()
        self.discovery_mode = discovery_mode
        self.k8s_namespace = k8s_namespace
        self.k8s_daemonset_name = k8s_daemonset_name
        self.health_check_interval = health_check_interval

        self._static_workers = worker_addresses or []
        self._workers: dict[str, WorkerInfo] = {}
        self._redis: Optional[aioredis.Redis] = None
        self._http: Optional[httpx.AsyncClient] = None
        self._health_task: Optional[asyncio.Task] = None

        # Scheduler with configurable strategy
        strategy = SchedulingStrategy(scheduling_strategy)
        self._scheduler = Scheduler(SchedulerConfig(strategy=strategy))

    async def _ensure_clients(self) -> None:
        """Lazy-init Redis and HTTP clients, start health polling."""
        if self._redis is None:
            self._redis = aioredis.from_url(self.redis_url)
        if self._http is None:
            headers = {}
            if self._node_agent_token:
                headers["Authorization"] = f"Bearer {self._node_agent_token}"
            else:
                logger.warning(
                    "NODE_AGENT_TOKEN is not set; node agents will reject requests "
                    "unless they run with NODE_AGENT_INSECURE_DEV=1"
                )
            self._http = httpx.AsyncClient(timeout=10.0, headers=headers)
        if self._health_task is None:
            self._health_task = asyncio.create_task(self._health_poll_loop())

    # ------------------------------------------------------------------
    # Worker discovery & health
    # ------------------------------------------------------------------

    async def _health_poll_loop(self) -> None:
        """Periodically poll all workers for health/capacity."""
        while True:
            try:
                await self._refresh_workers()
            except Exception as e:
                logger.error(f"Worker health poll failed: {e}")
            await asyncio.sleep(self.health_check_interval)

    async def _refresh_workers(self) -> None:
        """Fetch health from all known worker addresses."""
        addresses = await self._discover_worker_addresses()
        tasks = [self._fetch_worker_health(addr) for addr in addresses]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        new_workers = {}
        for addr, result in zip(addresses, results):
            if isinstance(result, WorkerInfo):
                new_workers[result.worker_id] = result
            else:
                logger.warning(f"Worker {addr} unhealthy: {result}")

        self._workers = new_workers
        logger.debug(
            f"Worker registry refreshed: {len(new_workers)} healthy "
            f"out of {len(addresses)} discovered"
        )

    async def _discover_worker_addresses(self) -> list[str]:
        """Get list of worker node-agent addresses."""
        if self.discovery_mode == "static":
            return list(self._static_workers)

        elif self.discovery_mode == "k8s":
            try:
                from kubernetes_asyncio import client, config

                try:
                    await config.load_incluster_config()
                except config.ConfigException:
                    config.load_kube_config()

                v1 = client.CoreV1Api()
                pods = await v1.list_namespaced_pod(
                    namespace=self.k8s_namespace,
                    label_selector=f"app={self.k8s_daemonset_name}",
                )
                return [
                    f"http://{pod.status.pod_ip}:9090"
                    for pod in pods.items
                    if pod.status.pod_ip and pod.status.phase == "Running"
                ]
            except Exception as e:
                logger.error(f"K8s worker discovery failed: {e}")
                return []

        return []

    async def _fetch_worker_health(self, address: str) -> WorkerInfo:
        """GET /health from a single worker node agent."""
        resp = await self._http.get(f"{address}/health")
        resp.raise_for_status()
        data = resp.json()

        caps = data.get("capabilities", {})

        return WorkerInfo(
            worker_id=data["worker_id"],
            address=address,
            capabilities=WorkerCapabilities(
                total_cpu_millicores=caps.get(
                    "total_cpu_millicores", data.get("total_cpu_millicores", 4000)
                ),
                total_memory_mb=caps.get(
                    "total_memory_mb", data.get("total_memory_mb", 8192)
                ),
                total_gpu_count=caps.get("total_gpu_count", 0),
                total_disk_mb=caps.get("total_disk_mb", 50000),
                available_cpu_millicores=caps.get(
                    "available_cpu_millicores",
                    data.get("available_cpu_millicores", 4000),
                ),
                available_memory_mb=caps.get(
                    "available_memory_mb",
                    data.get("available_memory_mb", 8192),
                ),
                available_gpu_count=caps.get("available_gpu_count", 0),
                available_disk_mb=caps.get("available_disk_mb", 50000),
                labels=caps.get("labels", data.get("labels", {})),
                active_session_tags=caps.get(
                    "active_session_tags", data.get("active_session_tags", [])
                ),
            ),
            active_sessions=data.get("active_sessions", 0),
            max_sessions=data.get("max_sessions", 20),
            healthy=data.get("healthy", True),
            last_heartbeat_epoch=time.time(),
        )

    # ------------------------------------------------------------------
    # BaseOrchestrator interface
    # ------------------------------------------------------------------

    async def create_session(
        self,
        session_id: str,
        agent_config: dict,
        environment_config: dict,
        redis_url: str,
        api_base_url: str,
        resources: Optional[ResourceRequest] = None,
        tags: Optional[list[str]] = None,
    ) -> SessionInfo:
        """Schedule a session on the best-fit worker."""
        await self._ensure_clients()

        # Build resource request from environment config if not provided
        if resources is None:
            resources = self._build_resource_request(environment_config)

        tags = tags or []

        # Run the scheduler
        workers = list(self._workers.values())
        selected, breakdowns = self._scheduler.select(workers, resources, tags)

        # Extract harness from environment_config (or default to custom-python)
        harness_cfg = environment_config.get("harness", {})
        harness_payload = {
            "name": harness_cfg.get("name", "custom-python"),
            "rootfs_path": harness_cfg.get("rootfs_path", ""),
            "image": harness_cfg.get("image", ""),
            "entrypoint": harness_cfg.get("entrypoint", []),
            "command": harness_cfg.get("command", []),
            "runtime": harness_cfg.get("runtime", "firecracker"),
        }

        # Session-specific env vars (API keys, bot tokens, etc.)
        session_env = environment_config.get("env", {})

        # POST to the selected worker's node agent
        resp = await self._http.post(
            f"{selected.address}/sessions",
            json={
                "session_id": session_id,
                "harness": harness_payload,
                "env": session_env,
                "agent_config": agent_config,
                "environment_config": environment_config,
                "redis_url": redis_url,
                "api_base_url": api_base_url,
                "resource_request": {
                    "cpu_millicores": resources.cpu_millicores,
                    "memory_mb": resources.memory_mb,
                    "gpu_count": resources.gpu_count,
                    "timeout_seconds": resources.timeout_seconds,
                },
                "resource_overrides": {
                    "cpu_millicores": resources.cpu_millicores,
                    "memory_mb": resources.memory_mb,
                },
                "tags": tags,
            },
        )
        resp.raise_for_status()
        data = resp.json()

        # Store session→worker mapping and metadata in Redis
        pipe = self._redis.pipeline()
        pipe.set(
            SESSION_WORKER_KEY.format(session_id=session_id),
            selected.address,
            ex=86400,
        )
        if tags:
            pipe.set(
                SESSION_TAGS_KEY.format(session_id=session_id),
                ",".join(tags),
                ex=86400,
            )
        await pipe.execute()

        return SessionInfo(
            session_id=session_id,
            status=SessionStatus.RUNNING,
            worker_id=selected.worker_id,
            pid=data.get("pid"),
            resources=resources,
            tags=tags,
        )

    async def terminate_session(self, session_id: str) -> None:
        """Kill a session on whatever worker it's running on."""
        await self._ensure_clients()
        worker_addr = await self._get_worker_for_session(session_id)
        if worker_addr is None:
            logger.warning(f"No worker found for session {session_id}")
            return

        try:
            resp = await self._http.delete(f"{worker_addr}/sessions/{session_id}")
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            if e.response.status_code != 404:
                raise

        # Clean up Redis
        pipe = self._redis.pipeline()
        pipe.delete(SESSION_WORKER_KEY.format(session_id=session_id))
        pipe.delete(SESSION_TAGS_KEY.format(session_id=session_id))
        await pipe.execute()

    async def get_session_status(self, session_id: str) -> SessionInfo:
        """Query session status from its worker."""
        await self._ensure_clients()
        worker_addr = await self._get_worker_for_session(session_id)
        if worker_addr is None:
            return SessionInfo(
                session_id=session_id, status=SessionStatus.TERMINATED
            )

        try:
            resp = await self._http.get(f"{worker_addr}/sessions/{session_id}")
            if resp.status_code == 404:
                return SessionInfo(
                    session_id=session_id, status=SessionStatus.TERMINATED
                )
            resp.raise_for_status()
            data = resp.json()

            return SessionInfo(
                session_id=session_id,
                status=(
                    SessionStatus.RUNNING
                    if data["status"] == "running"
                    else SessionStatus.TERMINATED
                ),
                worker_id=data.get("worker_id"),
                pid=data.get("pid"),
            )
        except httpx.HTTPError:
            return SessionInfo(
                session_id=session_id, status=SessionStatus.UNKNOWN
            )

    async def stream_logs(self, session_id: str) -> AsyncIterator[str]:
        """Stream logs from the worker hosting this session."""
        await self._ensure_clients()
        worker_addr = await self._get_worker_for_session(session_id)
        if worker_addr is None:
            yield "Session not found\n"
            return

        async with self._http.stream(
            "GET", f"{worker_addr}/sessions/{session_id}/logs"
        ) as resp:
            async for line in resp.aiter_lines():
                yield line

    async def list_workers(self) -> list[WorkerInfo]:
        """Return current worker registry."""
        await self._ensure_clients()
        return list(self._workers.values())

    async def close(self) -> None:
        """Clean up."""
        if self._health_task:
            self._health_task.cancel()
        if self._http:
            await self._http.aclose()
        if self._redis:
            await self._redis.close()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _get_worker_for_session(self, session_id: str) -> Optional[str]:
        """Look up which worker hosts a session."""
        addr = await self._redis.get(
            SESSION_WORKER_KEY.format(session_id=session_id)
        )
        if addr:
            return addr.decode() if isinstance(addr, bytes) else addr
        return None

    def _build_resource_request(self, environment_config: dict) -> ResourceRequest:
        """Extract resource requirements from environment config.

        Supports both explicit resource requests and inference from
        environment properties (e.g., if a GPU model is specified,
        set gpu_count=1).
        """
        resources_cfg = environment_config.get("resources", {})
        networking_cfg = environment_config.get("networking", {})
        scheduling_cfg = environment_config.get("scheduling", {})

        # Parse K8s-style resource strings
        cpu = _parse_cpu_millicores(resources_cfg.get("cpu_request", "1000m"))
        memory = _parse_memory_mb(resources_cfg.get("memory_request", "2Gi"))
        gpu = int(resources_cfg.get("gpu_count", 0))

        return ResourceRequest(
            cpu_millicores=cpu,
            memory_mb=memory,
            gpu_count=gpu,
            disk_mb=int(resources_cfg.get("disk_mb", 1024)),
            required_labels=scheduling_cfg.get("required_labels", {}),
            preferred_labels=scheduling_cfg.get("preferred_labels", {}),
            anti_affinity_tags=scheduling_cfg.get("anti_affinity_tags", []),
            affinity_tags=scheduling_cfg.get("affinity_tags", []),
            priority=int(scheduling_cfg.get("priority", 0)),
            timeout_seconds=int(resources_cfg.get("timeout_seconds", 3600)),
        )


# ------------------------------------------------------------------
# Parsing helpers
# ------------------------------------------------------------------

def _parse_cpu_millicores(s: str) -> int:
    """Parse K8s-style CPU string to millicores."""
    s = str(s).strip()
    if s.endswith("m"):
        return int(s[:-1])
    else:
        try:
            return int(float(s) * 1000)
        except ValueError:
            return 1000


def _parse_memory_mb(s: str) -> int:
    """Parse K8s-style memory string to MB."""
    s = str(s).strip()
    if s.endswith("Gi"):
        return int(float(s[:-2]) * 1024)
    elif s.endswith("Mi"):
        return int(float(s[:-2]))
    elif s.endswith("G"):
        return int(float(s[:-1]) * 1000)
    elif s.endswith("M"):
        return int(float(s[:-1]))
    else:
        try:
            return int(s) // (1024 * 1024)
        except ValueError:
            return 2048


__all__ = ["HybridOrchestrator"]
