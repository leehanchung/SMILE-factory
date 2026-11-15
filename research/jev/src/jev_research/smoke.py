"""Offline environment check: imports, training, and probability evaluation."""

import importlib
import json
import os
import sys
from importlib.metadata import version
from pathlib import Path

import numpy as np
import torch
from scipy.optimize import minimize_scalar
from sklearn.metrics import brier_score_loss, log_loss


def train_step(device: str) -> dict:
    torch.manual_seed(42)
    model = torch.nn.Linear(3, 2).to(device)
    x = torch.tensor([[1.0, 0.0, -1.0], [-1.0, 0.0, 1.0]], device=device)
    y = torch.tensor([0, 1], device=device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.05)
    before = torch.nn.functional.cross_entropy(model(x), y).item()
    for _ in range(10):
        optimizer.zero_grad()
        loss = torch.nn.functional.cross_entropy(model(x), y)
        loss.backward()
        optimizer.step()
    after = torch.nn.functional.cross_entropy(model(x), y).item()
    assert np.isfinite(after) and after < before, (device, before, after)
    return {"device": device, "initial_loss": before, "final_loss": after}


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    assert Path(sys.prefix).resolve() == root / ".venv", sys.prefix
    for key in ("UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR", "HF_HOME", "TORCH_HOME"):
        assert Path(os.environ[key]).resolve().is_relative_to(root), key

    packages = {
        "torch": "torch",
        "gliner2": "gliner2",
        "transformers": "transformers",
        "datasets": "datasets",
        "accelerate": "accelerate",
        "peft": "peft",
        "safetensors": "safetensors",
        "sentencepiece": "sentencepiece",
        "numpy": "numpy",
        "scipy": "scipy",
        "scikit-learn": "sklearn",
        "pandas": "pandas",
        "pyarrow": "pyarrow",
        "matplotlib": "matplotlib",
        "seaborn": "seaborn",
        "pyyaml": "yaml",
    }
    for module in packages.values():
        importlib.import_module(module)
    # Trigger lazy imports for actual model and training classes, without downloads.
    from gliner2 import GLiNER2
    from gliner2.training.trainer import GLiNER2Trainer
    from transformers import Trainer

    assert GLiNER2 and GLiNER2Trainer and Trainer
    training = [train_step("cpu")]
    if torch.backends.mps.is_available():
        training.append(train_step("mps"))
    if torch.cuda.is_available():
        training.append(train_step("cuda"))

    rng = np.random.default_rng(42)
    q = rng.uniform(0.05, 0.95, 4000)
    y = rng.binomial(1, q)
    logits = 2 * np.log(q / (1 - q))

    def probabilities(log_t: float) -> np.ndarray:
        return 1 / (1 + np.exp(-logits / np.exp(log_t)))

    fit = minimize_scalar(
        lambda log_t: log_loss(y[:2000], probabilities(log_t)[:2000]),
        bounds=(-2, 2),
        method="bounded",
    )
    assert fit.success
    raw = probabilities(0)[2000:]
    calibrated = probabilities(fit.x)[2000:]
    raw_nll = log_loss(y[2000:], raw)
    calibrated_nll = log_loss(y[2000:], calibrated)
    assert calibrated_nll < raw_nll
    print(
        json.dumps(
            {
                "python": sys.version.split()[0],
                "environment": sys.prefix,
                "versions": {name: version(name) for name in packages},
                "training": training,
                "calibration_smoke": {
                    "temperature": float(np.exp(fit.x)),
                    "raw_test_nll": raw_nll,
                    "calibrated_test_nll": calibrated_nll,
                    "calibrated_test_brier": brier_score_loss(y[2000:], calibrated),
                },
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
