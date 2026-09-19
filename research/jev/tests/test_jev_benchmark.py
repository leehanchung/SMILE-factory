import json

import numpy as np
import pytest

from jev_research.jev_api import BenchmarkError, _request, collect, parse_response
from jev_research.monte_carlo import evaluate, scenarios


def response():
    return {
        "model": "jev-1.13.0",
        "answers": {
            "choice": {"type": "choice", "probabilities": {"heads": 0.6, "tails": 0.4}},
            "event": {"type": "noul", "noul": 0.6},
            "complement": {"type": "noul", "noul": 0.4},
        },
        "usage": {"input_tokens": 100},
    }


def test_parser_allowlists_and_rejects_invalid_probabilities():
    data = response()
    data["extra"] = "private-unexpected-content"
    parsed = parse_response(data, "jev-1.13.0", "heads", "tails")
    assert "private-unexpected-content" not in json.dumps(parsed)
    data["answers"]["choice"]["probabilities"]["heads"] = 0.9
    with pytest.raises(BenchmarkError, match="body withheld"):
        parse_response(data, "jev-1.13.0", "heads", "tails")


def test_oracle_and_boundary_log_loss():
    rows = [{**c, "choice_p": c["q"], "noul_p": c["q"]} for c in scenarios()]
    details, summary, reliability = evaluate(rows, repetitions=100)
    assert details.absolute_probability_error.max() == 0
    assert np.isfinite(details.expected_nll).all()
    assert np.allclose(details.expected_brier, details.oracle_expected_brier)
    assert np.max(abs(summary.expected_brier - summary.mc_brier_mean)) < 0.002
    assert np.allclose(reliability.mean_prediction, reliability.oracle_event_rate)
    assert summary.oracle_binned_ece_10.max() == pytest.approx(0)
    rows[0]["choice_p"] = 1.0  # q=0, certain wrong prediction
    details, _, _ = evaluate(rows, repetitions=10)
    assert np.isinf(details.iloc[0].expected_nll)


def test_scenarios_and_complements():
    cases = scenarios()
    assert len(cases) == 63
    assert len({c["scenario_id"] for c in cases}) == len(cases)
    assert all(0 <= c["q"] <= 1 for c in cases)
    normal = [c for c in cases if c["family"] == "normal" and c["track"] == "parameters"]
    assert normal[1]["q"] == 0.5
    assert normal[0]["q"] + normal[-1]["q"] == pytest.approx(1)


def test_offline_does_not_send_and_live_resumes(tmp_path, monkeypatch):
    import jev_research.jev_api as api

    (tmp_path / ".env").write_text("TYPESAFE_API_KEY=fake-secret\nJEV_MODEL=jev-1.13.0\n")
    called = []

    def fake_request(root, payload):
        called.append(payload)
        return response()

    monkeypatch.setattr(api, "_request", fake_request)
    cases = [scenarios()[9]]  # p=.6
    assert collect(tmp_path, cases, live=False) == []
    assert not called
    rows = collect(tmp_path, cases, live=True)
    assert rows[0]["choice_p"] == 0.6
    assert len(called) == 1
    assert collect(tmp_path, cases, live=True) == rows
    assert len(called) == 1
    for path in (tmp_path / "runs").rglob("*.json"):
        assert "fake-secret" not in path.read_text()


def test_transport_error_does_not_expose_secret(tmp_path, monkeypatch):
    import requests

    env = tmp_path / ".env"
    env.write_text("TYPESAFE_API_KEY=fake-secret\n")
    env.chmod(0o600)

    def fail(*args, **kwargs):
        raise requests.ConnectionError("fake-secret in untrusted exception text")

    monkeypatch.setattr(requests.Session, "post", fail)
    with pytest.raises(BenchmarkError) as caught:
        _request(tmp_path, {})
    assert "fake-secret" not in str(caught.value)
    assert caught.value.__context__ is None


def test_notebook_analysis_with_oracle_fixture(tmp_path, monkeypatch):
    """Exercise every analysis/plot/export cell without network or saved fake Jev results."""
    pytest.importorskip("IPython")
    from pathlib import Path

    import matplotlib

    import jev_research.jev_api as api

    matplotlib.use("Agg")
    source = Path(__file__).resolve().parents[1]
    notebook = json.loads((source / "notebooks/01_jev_off_the_shelf_calibration.ipynb").read_text())
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts/uv.sh").touch()
    monkeypatch.chdir(tmp_path)
    oracle = [
        {**c, "choice_p": c["q"], "noul_p": c["q"], "complement_p": 1 - c["q"], "input_tokens": 0}
        for c in scenarios()
    ]
    monkeypatch.setattr(api, "collect", lambda *args, **kwargs: oracle)
    scope = {}
    for cell in notebook["cells"]:
        if cell["cell_type"] == "code":
            code = "".join(cell["source"])
            code = "\n".join(line for line in code.splitlines() if not line.startswith("%"))
            exec(compile(code, "notebook-offline-test", "exec"), scope)
    assert scope["complete"]
    assert scope["details"].absolute_probability_error.max() == 0
    assert (tmp_path / "runs/jev-off-the-shelf/jev-1.13.0/analysis/summary.csv").exists()
