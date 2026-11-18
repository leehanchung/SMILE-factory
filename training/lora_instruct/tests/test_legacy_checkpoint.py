"""Resuming from a pickle-based adapter_model.bin needs an explicit opt-in.

torch 2.14 (pinned by vLLM 0.34) is affected by GHSA-v32g-mr63-3j83, so
``torch.load(weights_only=True)`` is not a safe boundary for untrusted files.
"""

import pytest

finetune = pytest.importorskip("finetune")


def test_bin_checkpoint_refused_by_default(monkeypatch):
    monkeypatch.delenv(finetune.LEGACY_CHECKPOINT_ENV, raising=False)
    with pytest.raises(SystemExit, match="GHSA-v32g-mr63-3j83"):
        finetune._require_legacy_checkpoint_opt_in("ckpt/adapter_model.bin")


def test_bin_checkpoint_allowed_with_opt_in(monkeypatch):
    monkeypatch.setenv(finetune.LEGACY_CHECKPOINT_ENV, "1")
    finetune._require_legacy_checkpoint_opt_in("ckpt/adapter_model.bin")
