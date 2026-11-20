"""Resuming from a checkpoint with pickle files needs an explicit opt-in.

torch 2.14 (pinned by vLLM 0.34) is affected by GHSA-v32g-mr63-3j83, so
``torch.load(weights_only=True)`` is not a safe boundary for untrusted files,
whether that is a legacy adapter_model.bin or Trainer state such as
optimizer.pt next to a safetensors adapter.
"""

import pytest

finetune = pytest.importorskip("finetune")


def _ckpt(tmp_path, *names):
    for name in names:
        (tmp_path / name).write_bytes(b"x")
    return str(tmp_path)


@pytest.mark.parametrize(
    "names",
    [
        ("adapter_model.bin",),
        ("adapter_model.safetensors", "optimizer.pt", "rng_state.pth"),
        ("adapter_model.safetensors", "scheduler.pt"),
    ],
)
def test_pickle_checkpoint_refused_by_default(monkeypatch, tmp_path, names):
    monkeypatch.delenv(finetune.TRUST_CHECKPOINT_ENV, raising=False)
    with pytest.raises(SystemExit, match="GHSA-v32g-mr63-3j83"):
        finetune._require_trusted_checkpoint(_ckpt(tmp_path, *names))


def test_pickle_checkpoint_allowed_with_opt_in(monkeypatch, tmp_path):
    monkeypatch.setenv(finetune.TRUST_CHECKPOINT_ENV, "1")
    finetune._require_trusted_checkpoint(
        _ckpt(tmp_path, "adapter_model.bin", "optimizer.pt")
    )


def test_safetensors_only_checkpoint_needs_no_opt_in(monkeypatch, tmp_path):
    monkeypatch.delenv(finetune.TRUST_CHECKPOINT_ENV, raising=False)
    names = ("adapter_model.safetensors", "adapter_config.json", "trainer_state.json")
    finetune._require_trusted_checkpoint(_ckpt(tmp_path, *names))


def test_base_model_requires_safetensors_by_default(monkeypatch):
    monkeypatch.delenv(finetune.TRUST_CHECKPOINT_ENV, raising=False)
    assert finetune._base_model_use_safetensors() is True


def test_base_model_pickle_fallback_with_opt_in(monkeypatch):
    monkeypatch.setenv(finetune.TRUST_CHECKPOINT_ENV, "1")
    assert finetune._base_model_use_safetensors() is None
