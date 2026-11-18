#!/usr/bin/env python3
"""
CTO Readiness Assessment Tool
Evaluates current competencies and identifies development priorities
"""

import json
from datetime import datetime
from typing import Dict, List, Tuple

class CTOAssessment:
    def __init__(self):
        self.competencies = {
            "Strategic Leadership": {
                "weight": 0.25,
                "skills": [
                    ("Define enterprise technology vision", "Can you articulate a 3-year technology vision?"),
                    ("Align technology with business strategy", "Do you understand company's strategic priorities?"),
                    ("Drive digital transformation", "Have you led enterprise-wide transformation?"),
                    ("Technology investment planning", "Experience with $10M+ technology budgets?"),
                    ("Innovation portfolio management", "Do you balance innovation with stability?")
                ]
            },
            "Executive Presence": {
                "weight": 0.20,
                "skills": [
                    ("Board communication", "Comfortable presenting to board of directors?"),
                    ("C-suite collaboration", "Strong relationships with C-suite peers?"),
                    ("External representation", "Speaking at industry conferences?"),
                    ("Executive decision making", "Make high-stakes decisions quickly?"),
                    ("Political navigation", "Navigate organizational politics effectively?")
                ]
            },
            "Organizational Leadership": {
                "weight": 0.20,
                "skills": [
                    ("Scale management", "Experience managing 100+ people?"),
                    ("Leadership team building", "Built high-performing leadership teams?"),
                    ("Culture transformation", "Driven culture change at scale?"),
                    ("Talent development", "Strong succession planning and development?"),
                    ("Managing through layers", "Effective leading through 3+ layers?")
                ]
            },
            "Business Acumen": {
                "weight": 0.15,
                "skills": [
                    ("P&L understanding", "Understand P&L impact of decisions?"),
                    ("ROI articulation", "Demonstrate ROI of technology investments?"),
                    ("Market dynamics", "Understand competitive landscape?"),
                    ("Business model fluency", "Can explain company's business model?"),
                    ("Financial planning", "Partner with CFO on budgets?")
                ]
            },
            "Technical Breadth": {
                "weight": 0.15,
                "skills": [
                    ("Enterprise architecture", "Understand enterprise architecture?"),
                    ("Technology trends", "Current on emerging technologies?"),
                    ("Platform strategy", "Drive platform and infrastructure decisions?"),
                    ("Technical debt management", "Balance debt with innovation?"),
                    ("Security and compliance", "Own enterprise technology risk?")
                ]
            },
            "External Engagement": {
                "weight": 0.05,
                "skills": [
                    ("Industry leadership", "Known in industry circles?"),
                    ("Vendor partnerships", "Manage strategic vendor relationships?"),
                    ("Analyst relations", "Engage with Gartner/Forrester?"),
                    ("Customer engagement", "Regular customer interaction?"),
                    ("Ecosystem building", "Build technology partnerships?")
                ]
            }
        }
        self.responses = {}
        
    def run_assessment(self):
        """Run the interactive assessment"""
        print("\n" + "="*60)
        print("CTO READINESS ASSESSMENT")
        print("For Senior Director → CTO Transition")
        print("="*60)
        print("\nRate yourself on a scale of 1-5:")
        print("1 = No experience")
        print("2 = Limited experience")  
        print("3 = Moderate experience")
        print("4 = Strong experience")
        print("5 = Expert level")
        print("-"*60)
        
        for category, details in self.competencies.items():
            print(f"\n{category.upper()} (Weight: {details['weight']*100:.0f}%)")
            print("-" * 40)
            self.responses[category] = {}
            
            for skill, question in details['skills']:
                while True:
                    try:
                        response = input(f"\n{skill}:\n{question}\nYour rating (1-5): ")
                        rating = int(response)
                        if 1 <= rating <= 5:
                            self.responses[category][skill] = rating
                            break
                        else:
                            print("Please enter a number between 1 and 5")
                    except ValueError:
                        print("Please enter a valid number")
    
    def calculate_scores(self) -> Dict:
        """Calculate weighted scores and identify gaps"""
        results = {
            "category_scores": {},
            "overall_score": 0,
            "gaps": [],
            "strengths": [],
            "development_priorities": []
        }
        
        for category, details in self.competencies.items():
            if category in self.responses:
                scores = list(self.responses[category].values())
                avg_score = sum(scores) / len(scores)
                weighted_score = avg_score * details['weight']
                
                results["category_scores"][category] = {
                    "average": round(avg_score, 2),
                    "weighted": round(weighted_score, 2)
                }
                results["overall_score"] += weighted_score
                
                # Identify gaps (scores < 3) and strengths (scores >= 4)
                for skill, score in self.responses[category].items():
                    if score < 3:
                        results["gaps"].append((category, skill, score))
                    elif score >= 4:
                        results["strengths"].append((category, skill, score))
        
        results["overall_score"] = round(results["overall_score"], 2)
        
        # Prioritize development areas
        results["development_priorities"] = self._prioritize_development(results["gaps"])
        
        return results
    
    def _prioritize_development(self, gaps: List[Tuple]) -> List[str]:
        """Prioritize development based on weights and scores"""
        priorities = []
        
        # Sort gaps by category weight and score
        weighted_gaps = []
        for category, skill, score in gaps:
            weight = self.competencies[category]["weight"]
            priority_score = weight * (3 - score)  # Higher weight and lower score = higher priority
            weighted_gaps.append((priority_score, category, skill))
        
        weighted_gaps.sort(reverse=True)
        
        # Return top 5 priorities
        for _, category, skill in weighted_gaps[:5]:
            priorities.append(f"{category}: {skill}")
        
        return priorities
    
    def generate_report(self):
        """Generate assessment report"""
        results = self.calculate_scores()
        
        print("\n" + "="*60)
        print("ASSESSMENT RESULTS")
        print("="*60)
        
        # Overall readiness
        readiness_level = self._get_readiness_level(results["overall_score"])
        print(f"\nOverall CTO Readiness Score: {results['overall_score']}/5.0")
        print(f"Readiness Level: {readiness_level}")
        
        # Category breakdown
        print("\n" + "-"*40)
        print("COMPETENCY BREAKDOWN")
        print("-"*40)
        for category, scores in results["category_scores"].items():
            print(f"{category:30} {scores['average']}/5.0 (weighted: {scores['weighted']})")
        
        # Strengths
        if results["strengths"]:
            print("\n" + "-"*40)
            print("KEY STRENGTHS")
            print("-"*40)
            for category, skill, score in results["strengths"][:5]:
                print(f"• {skill} ({category}): {score}/5")
        
        # Development priorities
        if results["development_priorities"]:
            print("\n" + "-"*40)
            print("TOP DEVELOPMENT PRIORITIES")
            print("-"*40)
            for i, priority in enumerate(results["development_priorities"], 1):
                print(f"{i}. {priority}")
        
        # Recommendations
        print("\n" + "-"*40)
        print("RECOMMENDED NEXT STEPS")
        print("-"*40)
        recommendations = self._get_recommendations(results)
        for rec in recommendations:
            print(f"• {rec}")
        
        # Save results
        self._save_results(results)
        print("\n" + "-"*40)
        print("Results saved to: cto_assessment_results.json")
    
    def _get_readiness_level(self, score: float) -> str:
        """Determine readiness level based on score"""
        if score >= 4.5:
            return "READY - Strong candidate for CTO role"
        elif score >= 4.0:
            return "NEARLY READY - 6-12 months of development needed"
        elif score >= 3.5:
            return "DEVELOPING - 12-18 months of development needed"
        elif score >= 3.0:
            return "EMERGING - 18-24 months of development needed"
        else:
            return "EARLY STAGE - 2+ years of development needed"
    
    def _get_recommendations(self, results: Dict) -> List[str]:
        """Generate personalized recommendations"""
        recs = []
        
        # Based on overall score
        if results["overall_score"] < 3.5:
            recs.append("Focus on foundational leadership skills before CTO transition")
            recs.append("Seek mentor who has made Senior Director → CTO transition")
        elif results["overall_score"] < 4.0:
            recs.append("Target stretch assignments in weak areas")
            recs.append("Increase visibility through enterprise initiatives")
        else:
            recs.append("Build external industry presence")
            recs.append("Seek board or committee exposure opportunities")
        
        # Based on specific gaps
        for category in ["Strategic Leadership", "Executive Presence"]:
            if category in results["category_scores"]:
                if results["category_scores"][category]["average"] < 3.5:
                    if category == "Strategic Leadership":
                        recs.append("Shadow current CTO in strategy sessions")
                        recs.append("Lead digital transformation initiative")
                    elif category == "Executive Presence":
                        recs.append("Get executive communication coaching")
                        recs.append("Practice board-level presentations")
        
        return recs[:5]  # Return top 5 recommendations
    
    def _save_results(self, results: Dict):
        """Save results to JSON file"""
        output = {
            "assessment_date": datetime.now().isoformat(),
            "overall_score": results["overall_score"],
            "category_scores": results["category_scores"],
            "development_priorities": results["development_priorities"],
            "raw_responses": self.responses
        }
        
        with open("cto_assessment_results.json", "w") as f:
            json.dump(output, f, indent=2)

def main():
    """Run the assessment"""
    assessment = CTOAssessment()
    
    print("\n" + "="*60)
    print("Welcome to the CTO Readiness Assessment")
    print("="*60)
    print("\nThis assessment will help you:")
    print("• Evaluate your readiness for a CTO role")
    print("• Identify key development areas")
    print("• Create a personalized development plan")
    print("\nThe assessment takes about 10-15 minutes.")
    
    input("\nPress Enter to begin...")
    
    assessment.run_assessment()
    assessment.generate_report()
    
    print("\n" + "="*60)
    print("ASSESSMENT COMPLETE")
    print("="*60)
    print("\nNext steps:")
    print("1. Review your results with your coach/mentor")
    print("2. Create a development plan targeting gaps")
    print("3. Identify stretch assignments and opportunities")
    print("4. Re-assess quarterly to track progress")

if __name__ == "__main__":
    main()
