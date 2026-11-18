"""Node agent bearer auth and harness-override policy."""

import pytest
from fastapi.testclient import TestClient

from src.orchestrator import node_agent
from src.orchestrator.harness import SandboxRuntime
from src.orchestrator.node_agent import HarnessPayload, _resolve_harness


@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    monkeypatch.setenv("NODE_AGENT_TOKEN", "s3cret-token")
    monkeypatch.delenv("NODE_AGENT_INSECURE_DEV", raising=False)
    monkeypatch.delenv("NODE_AGENT_ALLOWED_RUNTIMES", raising=False)
    monkeypatch.delenv("NODE_AGENT_ALLOWED_IMAGE_PREFIXES", raising=False)
    rootfs = tmp_path / "rootfs"
    rootfs.mkdir()
    monkeypatch.setattr(node_agent, "ROOTFS_ROOT", str(rootfs))
    return rootfs


@pytest.fixture
def client():
    # No lifespan (would boot the sandbox manager); only routing + auth is tested.
    return TestClient(node_agent.app)


# --- auth -------------------------------------------------------------------


def test_healthz_is_open(client):
    assert client.get("/healthz").status_code == 200


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("post", "/sessions"),
        ("get", "/sessions"),
        ("get", "/sessions/abc"),
        ("delete", "/sessions/abc"),
        ("get", "/sessions/abc/logs"),
        ("get", "/harnesses"),
        ("get", "/health"),
    ],
)
def test_endpoints_require_token(client, method, path):
    assert getattr(client, method)(path).status_code == 401
    resp = getattr(client, method)(path, headers={"Authorization": "Bearer wrong"})
    assert resp.status_code == 401


def test_valid_token_passes_auth(client):
    resp = client.get("/harnesses", headers={"Authorization": "Bearer s3cret-token"})
    assert resp.status_code == 200


def test_fails_closed_without_token(monkeypatch, client):
    monkeypatch.delenv("NODE_AGENT_TOKEN")
    with pytest.raises(RuntimeError):
        node_agent.check_auth_configured()
    assert client.get("/harnesses", headers={"Authorization": "Bearer "}).status_code == 503


def test_insecure_dev_opt_out(monkeypatch, client):
    monkeypatch.delenv("NODE_AGENT_TOKEN")
    monkeypatch.setenv("NODE_AGENT_INSECURE_DEV", "1")
    node_agent.check_auth_configured()
    assert client.get("/harnesses").status_code == 200


def test_session_id_rejects_path_traversal(client):
    resp = client.post(
        "/sessions",
        headers={"Authorization": "Bearer s3cret-token"},
        json={"session_id": "../../etc", "harness": {"name": "claude-code"}},
    )
    assert resp.status_code == 422


# --- override policy --------------------------------------------------------


def test_builtin_harness_without_overrides():
    h = _resolve_harness(HarnessPayload(name="claude-code"))
    assert h.runtime == SandboxRuntime.FIRECRACKER


def test_runtime_downgrade_rejected(monkeypatch):
    monkeypatch.setenv("NODE_AGENT_ALLOWED_RUNTIMES", "firecracker,gvisor,runc")
    with pytest.raises(ValueError, match="downgrade"):
        _resolve_harness(HarnessPayload(name="claude-code", runtime="gvisor"))
    with pytest.raises(ValueError, match="downgrade"):
        _resolve_harness(HarnessPayload(name="claude-code", runtime="runc"))


def test_runtime_not_in_allowlist_rejected():
    # runc is not allowlisted by default, even for ad-hoc harnesses with no baseline.
    with pytest.raises(ValueError, match="not allowed"):
        _resolve_harness(HarnessPayload(name="adhoc", rootfs_path="x.ext4", runtime="runc"))


def test_unknown_runtime_rejected():
    with pytest.raises(ValueError, match="Unknown runtime"):
        _resolve_harness(HarnessPayload(name="claude-code", runtime="docker"))


def test_rootfs_inside_root_allowed(_env):
    h = _resolve_harness(HarnessPayload(name="claude-code", rootfs_path="custom.ext4"))
    assert h.rootfs_path == str((_env / "custom.ext4").resolve())
    h = _resolve_harness(HarnessPayload(name="adhoc", rootfs_path=str(_env / "sub" / "a.ext4")))
    assert h.rootfs_path == str((_env / "sub" / "a.ext4").resolve())


@pytest.mark.parametrize("path", ["/etc/shadow", "../escape.ext4", "sub/../../escape.ext4"])
def test_rootfs_outside_root_rejected(path):
    with pytest.raises(ValueError, match="rootfs_path must be inside"):
        _resolve_harness(HarnessPayload(name="claude-code", rootfs_path=path))


def test_rootfs_symlink_escape_rejected(_env, tmp_path):
    outside = tmp_path / "outside.ext4"
    outside.write_text("x")
    (_env / "link.ext4").symlink_to(outside)
    with pytest.raises(ValueError, match="rootfs_path must be inside"):
        _resolve_harness(HarnessPayload(name="claude-code", rootfs_path="link.ext4"))


def test_image_override_requires_allowlist(monkeypatch):
    with pytest.raises(ValueError, match="image overrides are not allowed"):
        _resolve_harness(HarnessPayload(name="claude-code", image="evil.io/x:latest"))
    monkeypatch.setenv("NODE_AGENT_ALLOWED_IMAGE_PREFIXES", "registry.internal/")
    h = _resolve_harness(HarnessPayload(name="claude-code", image="registry.internal/cc:1"))
    assert h.image == "registry.internal/cc:1"
    with pytest.raises(ValueError):
        _resolve_harness(HarnessPayload(name="claude-code", image="evil.io/x:latest"))


@pytest.mark.parametrize(
    ("prefix", "image", "allowed"),
    [
        ("registry.example.com/team", "registry.example.com/team/app:1", True),
        ("registry.example.com/team", "registry.example.com/team:tag", True),
        ("registry.example.com/team", "registry.example.com/team@sha256:abc", True),
        ("registry.example.com/team", "registry.example.com/team", True),
        ("registry.example.com/team", "registry.example.com/team-attacker/payload", False),
        ("registry.example.com/team", "registry.example.com/teamx:1", False),
        ("registry.example.com/team/", "registry.example.com/team/app:1", True),
        ("registry.example.com/team/", "registry.example.com/team-attacker/x", False),
    ],
)
def test_image_allowlist_matches_at_reference_boundaries(monkeypatch, prefix, image, allowed):
    monkeypatch.setenv("NODE_AGENT_ALLOWED_IMAGE_PREFIXES", prefix)
    payload = HarnessPayload(name="claude-code", image=image)
    if allowed:
        assert _resolve_harness(payload).image == image
    else:
        with pytest.raises(ValueError, match="image overrides are not allowed"):
            _resolve_harness(payload)


def test_argv_limits():
    with pytest.raises(ValueError):
        _resolve_harness(HarnessPayload(name="claude-code", command=["a\x00b"]))
    with pytest.raises(ValueError):
        _resolve_harness(HarnessPayload(name="claude-code", entrypoint=["x"] * 1000))


# --- orchestrator client ------------------------------------------------------


async def test_hybrid_orchestrator_sends_bearer_token():
    from src.orchestrator.hybrid import HybridOrchestrator

    orch = HybridOrchestrator(
        redis_url="redis://localhost:6379", worker_addresses=[], node_agent_token="tok-123"
    )
    await orch._ensure_clients()
    try:
        assert orch._http.headers["authorization"] == "Bearer tok-123"
    finally:
        orch._health_task.cancel()
        await orch._http.aclose()


def test_create_orchestrator_forwards_node_agent_token(monkeypatch):
    monkeypatch.delenv("NODE_AGENT_TOKEN", raising=False)
    from src.orchestrator import create_orchestrator

    orch = create_orchestrator(backend="hybrid", worker_addresses=[], node_agent_token="tok-456")
    assert orch._node_agent_token == "tok-456"


# --- resource override bounds ------------------------------------------------


def test_resource_override_within_bounds():
    assert node_agent._bounded_int({"vcpus": 4}, "vcpus", 2, 16) == 4
    assert node_agent._bounded_int({}, "vcpus", 2, 16) == 2


@pytest.mark.parametrize("value", [0, -1, 17, 10**9, "4", 2.5, True, None])
def test_resource_override_out_of_bounds_rejected(value):
    with pytest.raises(ValueError):
        node_agent._bounded_int({"vcpus": value}, "vcpus", 2, 16)


def test_timeout_override_allows_zero_sentinel():
    assert (
        node_agent._bounded_int({"timeout_seconds": 0}, "timeout_seconds", 3600, 86400, minimum=0)
        == 0
    )


@pytest.mark.parametrize("value", [-1, 86401])
def test_timeout_override_out_of_bounds_rejected(value):
    with pytest.raises(ValueError):
        node_agent._bounded_int(
            {"timeout_seconds": value}, "timeout_seconds", 3600, 86400, minimum=0
        )


def test_harness_defaults_are_clamped_to_ceilings():
    # No override: an operator ceiling below the harness default still applies.
    assert node_agent._bounded_int({}, "disk_mb", 4096, 1024) == 1024
    assert node_agent._bounded_int({}, "timeout_seconds", 0, 600, minimum=0) == 0
    assert node_agent._bounded_int({}, "vcpus", 0, 16) == 1


def test_custom_harness_runtime_string_is_coerced(tmp_path, monkeypatch):
    import json

    path = tmp_path / "harnesses.json"
    path.write_text(
        json.dumps(
            {
                "my-gvisor": {"runtime": "gvisor", "image": "x", "network": {"enabled": False}},
                "bad-runtime": {"runtime": "nope"},
            }
        )
    )
    monkeypatch.setattr(node_agent, "CUSTOM_HARNESSES_PATH", str(path))
    monkeypatch.setattr(node_agent, "_all_harnesses", dict(node_agent._all_harnesses))
    node_agent._load_custom_harnesses()
    harness = node_agent._all_harnesses["my-gvisor"]
    assert harness.runtime is SandboxRuntime.GVISOR
    assert "bad-runtime" not in node_agent._all_harnesses
    # Comparing against the coerced baseline no longer raises KeyError.
    monkeypatch.setenv("NODE_AGENT_ALLOWED_RUNTIMES", "firecracker,gvisor,runc")
    assert node_agent._validate_runtime("gvisor", baseline=harness.runtime) is SandboxRuntime.GVISOR


def test_validate_runtime_normalizes_string_baseline(monkeypatch):
    monkeypatch.setenv("NODE_AGENT_ALLOWED_RUNTIMES", "firecracker,gvisor,runc")
    with pytest.raises(ValueError, match="downgrade"):
        node_agent._validate_runtime("runc", baseline="gvisor")
