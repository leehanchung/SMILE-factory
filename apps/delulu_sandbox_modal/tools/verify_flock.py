"""Filesystem lock primitive scout for Modal Volumes.

Tests three lock primitives against a Modal Volume to see which (if
any) provide cross-container mutual exclusion:

1.  ``fcntl.flock(LOCK_EX)`` — the POSIX advisory lock. Fails on
    Modal Volumes because each container has its own kernel and the
    volume backend doesn't propagate lock state between them. Tested
    for completeness and to produce evidence for the PRD.

2.  ``os.mkdir`` — the classic "mkdir as a mutex" pattern. POSIX
    mandates that `mkdir` on an existing directory raises EEXIST,
    and this is atomic on local filesystems. Question is whether
    Modal's distributed volume backend serializes metadata creation
    across containers or whether each container's mkdir is
    independent.

3.  ``os.link`` — atomic-rename-lock pattern. Hard-linking a fresh
    unique source file to a shared lock path is POSIX-atomic; the
    link either succeeds (you own the lock) or raises EEXIST. Same
    cross-container question as ``os.mkdir``.

Run with:

    modal run apps/delulu_sandbox_modal/tools/verify_flock.py::verify

The scout runs all three tests in sequence (clearing state between
them) and prints a summary. If *any* primitive passes, use it in
``repo_provisioner.py``. If *none* pass, pivot to ``modal.Dict`` for
cross-container coordination — filesystem-based locks are a dead
end on Modal Volumes and no amount of atomic primitives will fix
it, because the volume itself is commit/reload-synced, not live.

Shape of each test:

- Three workers spawned concurrently via ``.map()``, each holding
  the lock for ``HOLD_SECONDS``.
- Check two independent signals:
    - **Non-overlapping enter/exit windows** (each worker's enter
      must be ≥ previous worker's exit, with clock-skew tolerance)
    - **Total wall clock** (should be ≥ ``NUM_WORKERS * HOLD_SECONDS``;
      if workers ran in parallel instead of serializing, total will
      be ~``HOLD_SECONDS`` regardless of worker count)
- Both must agree for PASS.

Shares the production ``claude-workspaces`` volume on purpose —
tests filesystem semantics against the exact backend the repo
provisioner will use, not a synthetic test volume. State is written
to ``/vol/.flock-scout/`` and cleaned up between tests and at the
end, so production data (``/vol/workspaces/*``, ``/vol/repo-cache/*``)
is untouched.
"""

from __future__ import annotations

import fcntl
import os
import time
import uuid
from typing import Any

import modal

app = modal.App("flock-scout")

volume = modal.Volume.from_name("claude-workspaces", create_if_missing=True)

VOLUME_ROOT = "/vol"
SCOUT_DIR = f"{VOLUME_ROOT}/.flock-scout"
FLOCK_PATH = f"{SCOUT_DIR}/flock.lock"
MKDIR_PATH = f"{SCOUT_DIR}/mkdir.lock"
LINK_PATH = f"{SCOUT_DIR}/link.lock"

NUM_WORKERS = 3
HOLD_SECONDS = 2.0
TOLERANCE_SECONDS = 0.2

# Polling interval for mkdir/link spin loops. Tight enough that the
# scout finishes in reasonable time when the lock works, loose enough
# that we don't flood the volume with metadata operations when it
# doesn't.
POLL_INTERVAL_SECONDS = 0.05

scout_image = (
    # Matches the production sandbox's Python 3.14. Requires Modal Image
    # Builder 2025.06 or newer (the Makefile pins it for deploys; for
    # `modal run` set it with `modal config set image_builder_version
    # 2025.06`). The filesystem semantics under test are kernel-level, so
    # nothing here depends on a specific Python version.
    modal.Image.debian_slim(python_version="3.14")
)


@app.function(image=scout_image, volumes={VOLUME_ROOT: volume}, timeout=120)
def clear_state() -> None:
    """Remove any leftover scout state from a previous run and commit.

    Committing is necessary so subsequent worker containers see the
    cleared state at mount time — otherwise a fresh worker might
    mount the volume with stale lock files still present.
    """
    import shutil

    if os.path.isdir(SCOUT_DIR):
        shutil.rmtree(SCOUT_DIR)
    os.makedirs(SCOUT_DIR, exist_ok=True)
    volume.commit()


@app.function(image=scout_image, volumes={VOLUME_ROOT: volume}, timeout=120)
def flock_worker(worker_id: int) -> dict[str, Any]:
    """Acquire LOCK_EX via fcntl.flock, hold HOLD_SECONDS, release."""
    os.makedirs(SCOUT_DIR, exist_ok=True)
    fd = os.open(FLOCK_PATH, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        wait_start = time.time()
        fcntl.flock(fd, fcntl.LOCK_EX)
        enter_time = time.time()
        wait_seconds = enter_time - wait_start

        time.sleep(HOLD_SECONDS)

        exit_time = time.time()
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)

    return {
        "worker_id": worker_id,
        "wait_seconds": wait_seconds,
        "enter_time": enter_time,
        "exit_time": exit_time,
    }


@app.function(image=scout_image, volumes={VOLUME_ROOT: volume}, timeout=120)
def mkdir_worker(worker_id: int) -> dict[str, Any]:
    """Acquire a mkdir-based lock, hold HOLD_SECONDS, release.

    Spins on ``os.mkdir(lock_path)`` until it succeeds. POSIX says
    mkdir on an existing directory raises EEXIST; this is atomic on
    local filesystems. The open question is whether Modal Volumes
    serialize metadata writes across containers.
    """
    os.makedirs(SCOUT_DIR, exist_ok=True)

    wait_start = time.time()
    while True:
        try:
            os.mkdir(MKDIR_PATH)
            break
        except FileExistsError:
            time.sleep(POLL_INTERVAL_SECONDS)
    enter_time = time.time()
    wait_seconds = enter_time - wait_start

    time.sleep(HOLD_SECONDS)

    exit_time = time.time()
    os.rmdir(MKDIR_PATH)

    return {
        "worker_id": worker_id,
        "wait_seconds": wait_seconds,
        "enter_time": enter_time,
        "exit_time": exit_time,
    }


@app.function(image=scout_image, volumes={VOLUME_ROOT: volume}, timeout=120)
def link_worker(worker_id: int) -> dict[str, Any]:
    """Acquire a link-based lock, hold HOLD_SECONDS, release.

    Creates a unique per-worker source file, then spins on
    ``os.link(src, lock_path)`` until the link succeeds. POSIX says
    link to an existing name raises EEXIST and the operation is
    atomic at the filesystem level on local filesystems.

    On Modal Volumes, ``os.link`` raises ``PermissionError`` (EPERM)
    — the volume backend doesn't support hard links at all. We
    surface that as a distinct ``unsupported`` result rather than
    crashing, so the scout can still print its summary and the
    evidence is clearly attributed to the primitive being
    unavailable rather than to atomicity failing.
    """
    os.makedirs(SCOUT_DIR, exist_ok=True)

    src_path = f"{SCOUT_DIR}/link.src.{worker_id}.{uuid.uuid4().hex}"
    with open(src_path, "w") as f:
        f.write(str(worker_id))

    wait_start = time.time()
    try:
        while True:
            try:
                os.link(src_path, LINK_PATH)
                break
            except FileExistsError:
                time.sleep(POLL_INTERVAL_SECONDS)
    except PermissionError as exc:
        # os.link not supported by the volume filesystem — report
        # back as unsupported so _run_test emits an UNSUPPORTED
        # verdict instead of raising.
        os.unlink(src_path)
        return {
            "worker_id": worker_id,
            "unsupported": True,
            "error": f"{exc.__class__.__name__}: {exc}",
        }
    enter_time = time.time()
    wait_seconds = enter_time - wait_start

    time.sleep(HOLD_SECONDS)

    exit_time = time.time()
    os.unlink(LINK_PATH)
    os.unlink(src_path)

    return {
        "worker_id": worker_id,
        "wait_seconds": wait_seconds,
        "enter_time": enter_time,
        "exit_time": exit_time,
    }


def _run_test(name: str, worker_fn: Any) -> str:
    """Run one race test, print the result, return PASS|FAIL|SUSPICIOUS|UNSUPPORTED."""
    print(f"▶  [{name}] Clearing scout state...")
    clear_state.remote()

    print(f"▶  [{name}] Spawning {NUM_WORKERS} concurrent workers...")
    wall_start = time.time()
    results = list(worker_fn.map(range(NUM_WORKERS)))
    total_wall = time.time() - wall_start

    # If any worker reports unsupported (e.g. os.link EPERM on the
    # volume backend), the primitive itself isn't usable — emit
    # UNSUPPORTED and skip the timing analysis entirely.
    unsupported = [r for r in results if r.get("unsupported")]
    if unsupported:
        first_error = unsupported[0].get("error", "unknown")
        print(f"   ⛔ [{name}] UNSUPPORTED — primitive not available on this volume")
        print(f"                {first_error}")
        print()
        return "UNSUPPORTED"

    results.sort(key=lambda r: r["enter_time"])
    earliest_enter = min(r["enter_time"] for r in results)

    print(f"   Total wall clock: {total_wall:.2f}s")
    print(f"   {'worker':<10}{'wait':>10}{'enter (rel)':>16}{'exit (rel)':>16}")
    for r in results:
        enter_rel = r["enter_time"] - earliest_enter
        exit_rel = r["exit_time"] - earliest_enter
        print(
            f"   {r['worker_id']:<10}"
            f"{r['wait_seconds']:>9.2f}s"
            f"{enter_rel:>15.2f}s"
            f"{exit_rel:>15.2f}s"
        )

    serialized = True
    overlaps: list[str] = []
    for i in range(1, len(results)):
        prev_exit = results[i - 1]["exit_time"]
        curr_enter = results[i]["enter_time"]
        if curr_enter + TOLERANCE_SECONDS < prev_exit:
            serialized = False
            overlap = prev_exit - curr_enter
            overlaps.append(
                f"worker {results[i]['worker_id']} entered "
                f"{overlap:.2f}s before worker {results[i - 1]['worker_id']} exited"
            )

    expected_min_wall = NUM_WORKERS * HOLD_SECONDS - 0.5
    wall_clock_ok = total_wall >= expected_min_wall

    if serialized and wall_clock_ok:
        verdict = "PASS"
        print(f"   ✅ [{name}] PASS — mutex provides cross-container exclusion.")
    elif not serialized:
        verdict = "FAIL"
        print(f"   ❌ [{name}] FAIL — workers overlapped inside the critical section.")
        for line in overlaps:
            print(f"             • {line}")
    else:
        verdict = "SUSPICIOUS"
        print(f"   ⚠️  [{name}] SUSPICIOUS — enter/exit ordering looks clean but total")
        print(
            f"                wall clock ({total_wall:.2f}s) < expected minimum "
            f"({expected_min_wall:.2f}s)."
        )
        print("                Re-run with more workers or longer HOLD_SECONDS.")
    print()
    return verdict


@app.local_entrypoint()
def verify() -> None:
    """Run all three lock-primitive tests and print a summary."""
    results: dict[str, str] = {}

    results["fcntl.flock"] = _run_test("fcntl.flock", flock_worker)
    results["os.mkdir"] = _run_test("os.mkdir", mkdir_worker)
    results["os.link"] = _run_test("os.link", link_worker)

    print("─" * 60)
    print("SUMMARY")
    print("─" * 60)
    verdict_icon = {
        "PASS": "✅",
        "FAIL": "❌",
        "SUSPICIOUS": "⚠️",
        "UNSUPPORTED": "⛔",
    }
    for primitive, verdict in results.items():
        icon = verdict_icon.get(verdict, "?")
        print(f"  {icon} {primitive:<15} {verdict}")
    print()

    passes = [p for p, v in results.items() if v == "PASS"]
    if passes:
        print(f"  Working primitive(s): {', '.join(passes)}")
        print("  Use the first one in `repo_provisioner.py`.")
    else:
        print("  No filesystem primitive provides cross-container mutual")
        print("  exclusion on Modal Volumes. This is consistent with the")
        print("  Modal Volume architecture (commit/reload sync, not live")
        print("  shared filesystem).")
        print()
        print("  Pivot to Modal's own orchestration primitives. Options:")
        print("  - `@app.function(max_containers=1)` on a dedicated")
        print("    provisioning function for global serialization")
        print("  - `modal.Dict` with CAS-style put-if-absent for per-key")
        print("    locks (requires verifying the API supports atomic CAS)")
        print()
        print("  Update the PRD's Concurrency section accordingly.")

    print()
    print("▶  Cleaning up scout state...")
    clear_state.remote()
