import numpy as np
import pytest

from jev_research.brier_decomposition import decompose


def test_bin_identity_and_residual():
    p = [0.11, 0.19, 0.55, 0.59, 0.99]
    for q in ([0, 1, 0, 1, 1], [0.2, 0.8, 0.4, 0.7, 0.95]):
        d = decompose(p, q)
        assert d["grouped_brier"] == pytest.approx(
            d["uncertainty"] - d["resolution"] + d["reliability"]
        )
        assert d["raw_brier"] == pytest.approx(d["grouped_brier"] + d["binning_residual"])
        assert d["binning_residual"] != pytest.approx(0)


def test_oracle_and_constant():
    q = np.array([0.01, 0.2, 0.5, 0.8, 0.99])
    assert decompose(q, q)["reliability"] == pytest.approx(0)
    d = decompose(np.full(len(q), q.mean()), q)
    assert d["resolution"] == pytest.approx(0)
    assert d["reliability"] == pytest.approx(0)
    assert d["raw_brier"] == pytest.approx(d["uncertainty"])
    assert decompose([0, 0], [0, 0])["normalized_reliability"] is None


def test_validation():
    with pytest.raises(ValueError):
        decompose([np.nan], [0])
    with pytest.raises(ValueError):
        decompose([1.2], [0])
    with pytest.raises(ValueError):
        decompose([], [])
