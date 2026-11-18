import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "cto_assessment.py"
SPEC = importlib.util.spec_from_file_location("cto_assessment", MODULE_PATH)
cto_assessment = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cto_assessment)


class CTOAssessmentTest(unittest.TestCase):
    def setUp(self):
        self.assessment = cto_assessment.CTOAssessment()

    def fill_responses(self, rating):
        self.assessment.responses = {
            category: {skill: rating for skill, _ in details["skills"]}
            for category, details in self.assessment.competencies.items()
        }

    def test_calculates_weighted_scores(self):
        self.fill_responses(4)

        results = self.assessment.calculate_scores()

        self.assertEqual(results["overall_score"], 4.0)
        self.assertEqual(results["category_scores"]["Strategic Leadership"]["average"], 4.0)
        self.assertEqual(results["category_scores"]["Strategic Leadership"]["weighted"], 1.0)
        self.assertEqual(len(results["strengths"]), 30)
        self.assertEqual(results["gaps"], [])

    def test_prioritizes_high_weight_gaps(self):
        gaps = [
            ("External Engagement", "Industry leadership", 1),
            ("Strategic Leadership", "Technology investment planning", 1),
        ]

        priorities = self.assessment._prioritize_development(gaps)

        self.assertEqual(priorities[0], "Strategic Leadership: Technology investment planning")

    def test_readiness_levels(self):
        self.assertTrue(self.assessment._get_readiness_level(4.6).startswith("READY"))
        self.assertTrue(self.assessment._get_readiness_level(3.2).startswith("EMERGING"))
        self.assertTrue(self.assessment._get_readiness_level(2.9).startswith("EARLY STAGE"))


if __name__ == "__main__":
    unittest.main()
