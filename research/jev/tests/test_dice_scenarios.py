from collections import Counter
from itertools import product

import pytest

from jev_research.monte_carlo import dice_scenarios


def test_dice_cases_match_enumerated_sample_space():
    counts = Counter(a + b for a, b in product(range(1, 7), repeat=2))
    cases = dice_scenarios()
    assert len(cases) == len({c["scenario_id"] for c in cases}) == 22
    for track in ["parameters", "explicit"]:
        panel = [c for c in cases if c["track"] == track]
        assert {c["sum"] for c in panel} == set(counts)
        assert sum(c["q"] for c in panel) == pytest.approx(1)
        for case in panel:
            assert case["q"] == pytest.approx(counts[case["sum"]] / 36)
            assert ("The probability" in case["state"]) == (track == "explicit")
