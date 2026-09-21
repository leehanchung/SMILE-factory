from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from skillsbench_trajectory_transfer import evaluate


def test_run_subprocess_is_shell_free(monkeypatch):
    observed = {}

    def fake_run(command, **kwargs):
        observed.update(command=command, kwargs=kwargs)
        return SimpleNamespace(returncode=0, stdout="ok", stderr="")

    monkeypatch.setattr(evaluate.subprocess, "run", fake_run)
    result = evaluate.run_subprocess(["echo", "toy"], timeout=4)
    assert result.stdout == "ok"
    assert observed["command"] == ["echo", "toy"]
    assert observed["kwargs"]["check"] is True
    assert "shell" not in observed["kwargs"]


def test_artifacts_verify_all_metadata_without_byte_reads(tmp_path, monkeypatch):
    manifest = tmp_path / "manifest.json"
    snapshot = tmp_path / "snapshot.json"
    manifest.write_text(
        json.dumps(
            {
                "objects": [
                    {"ref": "artifact://one", "size": 11, "etag": "v1"},
                    {"ref": "artifact://two", "size": 22, "version": 7},
                ]
            }
        ),
        encoding="utf-8",
    )
    snapshot.write_text(
        json.dumps(
            {
                "objects": [
                    {"ref": "artifact://one", "existence": True, "size": 11, "etag": "v1"},
                    {"ref": "artifact://two", "existence": True, "size": 22, "version": 7},
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        evaluate.urllib.request, "urlopen", lambda *args, **kwargs: pytest.fail("network used")
    )
    assert evaluate.verify_artifacts(manifest, snapshot) == {"verified": 2, "status": "ok"}

    stale = json.loads(snapshot.read_text(encoding="utf-8"))
    stale["objects"][1]["size"] = 23
    snapshot.write_text(json.dumps(stale), encoding="utf-8")
    with pytest.raises(ValueError, match="stale size metadata"):
        evaluate.verify_artifacts(manifest, snapshot)


def test_artifacts_reject_missing_and_unverified_metadata(tmp_path):
    manifest = tmp_path / "manifest.json"
    snapshot = tmp_path / "snapshot.json"
    manifest.write_text(
        json.dumps({"objects": [{"path": "adapter", "size": 4, "etag": "abc"}]}),
        encoding="utf-8",
    )
    snapshot.write_text(json.dumps({"objects": []}), encoding="utf-8")
    with pytest.raises(ValueError, match="missing verified metadata"):
        evaluate.verify_artifacts(manifest, snapshot)

    snapshot.write_text(
        json.dumps({"objects": [{"path": "adapter", "exists": False, "size": 4, "etag": "abc"}]}),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="existence=true"):
        evaluate.verify_artifacts(manifest, snapshot)


def test_tool_restraint_toy_panel(tmp_path):
    panel = tmp_path / "panel.jsonl"
    panel.write_text(
        "\n".join(
            [
                json.dumps({"should_call_tool": False, "tool_calls": []}),
                json.dumps({"should_call_tool": True, "called_tool": True}),
            ]
        ),
        encoding="utf-8",
    )
    assert evaluate.evaluate_tool_restraint(panel) == {"correct": 2, "total": 2, "accuracy": 1.0}
