import json
import logging
import os
import random
import re
from typing import Any
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

client = None
OPENAI_AVAILABLE = False
try:
    from openai import OpenAI
except (ImportError, OSError) as e:
    logger.warning("ai.openai_unavailable", extra={"error": str(e), "error_type": type(e).__name__})
else:
    try:
        client = OpenAI(api_key=os.getenv("OPENAI_API_KEY", ""))
        OPENAI_AVAILABLE = bool(os.getenv("OPENAI_API_KEY"))
    except Exception:
        # SDK-specific init errors (e.g. missing credentials): the service
        # runs in degraded mode without LLM features.
        logger.exception("ai.openai_client_init_failed")

PERSONAS = {
    "hr": "You are an HR AI expert specializing in workforce management, employee relations, and HR operations.",
    "employee": "You are a helpful AI assistant focused on helping employees with their questions about benefits, policies, and career development.",
    "manager": "You are an AI management consultant assisting managers with team performance, resource allocation, and leadership strategies.",
    "executive": "You are an AI executive advisor providing strategic insights on organizational growth, risk management, and workforce optimization.",
}

COPILOT_PERSONAS: dict[str, str] = PERSONAS


def _query_llm(system_prompt: str, user_message: str, max_tokens: int = 500) -> str:
    if OPENAI_AVAILABLE:
        try:
            resp = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message},
                ],
                max_tokens=max_tokens,
                temperature=0.7,
            )
            return resp.choices[0].message.content or ""
        except (TimeoutError, ConnectionError) as e:
            logger.warning("ai.llm_query_failed", extra={"error": str(e), "error_type": type(e).__name__})
        except Exception:
            logger.exception("ai.llm_query_unexpected_error")
    return ""


def _generate_report(query: str, department: str = "", timeframe: str = "this_month") -> dict:
    prompt = (
        f"Generate a structured workforce report based on: {query}. "
        f"Department: {department or 'All'}, Timeframe: {timeframe}. "
        "Return a JSON object with keys: title, summary (2-3 sentences), "
        "insights (array of strings), data (array of objects with label/value/change). "
        "Include 4-6 data points and 3-5 insights."
    )
    result = _query_llm("You are an HR analytics expert.", prompt, max_tokens=800)
    try:
        return json.loads(result)
    except (json.JSONDecodeError, ValueError) as e:
        logger.warning("ai.report_parse_failed", extra={"error": str(e)})
        return {
            "title": f"Report: {query[:50]}",
            "summary": f"Analysis of {query} across {department or 'all departments'} for {timeframe}.",
            "data": [
                {"label": "Headcount", "value": random.randint(50, 500), "change": round(random.uniform(-5, 10), 1)},
                {"label": "Productivity", "value": round(random.uniform(75, 98), 1), "change": round(random.uniform(-3, 5), 1)},
                {"label": "Engagement", "value": round(random.uniform(65, 92), 1), "change": round(random.uniform(-2, 4), 1)},
                {"label": "Attrition Risk", "value": round(random.uniform(5, 25), 1), "change": round(random.uniform(-3, 3), 1)},
            ],
            "insights": [
                "Department productivity has shown steady improvement this quarter.",
                "Engagement scores are above industry average.",
                "Attrition risk remains manageable with current retention initiatives.",
            ],
        }


def _generate_dashboard(focus: str, department: str = "") -> dict:
    widgets_pool = [
        {"type": "kpi_card", "title": "Headcount", "metric": "total_headcount", "color": "blue"},
        {"type": "kpi_card", "title": "Attrition Rate", "metric": "attrition_rate", "color": "rose"},
        {"type": "kpi_card", "title": "Avg Engagement", "metric": "engagement_score", "color": "emerald"},
        {"type": "kpi_card", "title": "Productivity", "metric": "productivity_score", "color": "amber"},
        {"type": "chart", "title": "Headcount Trend", "chart_type": "line", "metric": "headcount"},
        {"type": "chart", "title": "Department Distribution", "chart_type": "bar", "metric": "department_distribution"},
        {"type": "chart", "title": "Attrition by Dept", "chart_type": "bar", "metric": "attrition_by_dept"},
        {"type": "chart", "title": "Engagement Trend", "chart_type": "area", "metric": "engagement_trend"},
        {"type": "table", "title": "Top Performers", "metric": "top_performers"},
        {"type": "table", "title": "Open Positions", "metric": "open_positions"},
        {"type": "heatmap", "title": "Workforce Density", "metric": "workforce_density"},
    ]
    selected = random.sample(widgets_pool, min(6, len(widgets_pool)))
    layout = [
        {"widget": i, "x": (i % 3) * 4, "y": (i // 3) * 4, "w": 4, "h": 4}
        for i in range(len(selected))
    ]
    return {
        "title": f"{focus.title()} Dashboard",
        "description": f"AI-generated dashboard focusing on {focus}" + (f" for {department}" if department else ""),
        "widgets": selected,
        "layout": layout,
    }


def _predict_attrition(employee_id: str = "", department: str = "", months: int = 6) -> dict:
    probability = round(random.uniform(0.05, 0.45), 3)
    factors = [
        {"factor": "Job Satisfaction", "weight": round(random.uniform(0.1, 0.3), 2), "trend": random.choice(["declining", "stable", "improving"])},
        {"factor": "Compensation", "weight": round(random.uniform(0.1, 0.25), 2), "trend": random.choice(["below_market", "at_market", "above_market"])},
        {"factor": "Work-Life Balance", "weight": round(random.uniform(0.05, 0.2), 2), "trend": random.choice(["declining", "stable", "improving"])},
        {"factor": "Career Growth", "weight": round(random.uniform(0.1, 0.2), 2), "trend": random.choice(["limited", "adequate", "good"])},
        {"factor": "Manager Relationship", "weight": round(random.uniform(0.05, 0.15), 2), "trend": random.choice(["poor", "neutral", "good"])},
    ]
    return {
        "prediction": "high_risk" if probability > 0.3 else "medium_risk" if probability > 0.15 else "low_risk",
        "probability": probability,
        "risk_factors": sorted(factors, key=lambda f: f["weight"], reverse=True),
        "recommendations": [
            "Consider compensation review and market adjustment.",
            "Schedule regular check-ins to address engagement concerns.",
            "Provide clear career progression path and development opportunities.",
            "Evaluate workload distribution and work-life balance initiatives.",
        ] if probability > 0.2 else [
            "Continue current retention strategies.",
            "Monitor engagement metrics quarterly.",
        ],
        "confidence_interval": {"lower": max(0, probability - 0.05), "upper": min(1, probability + 0.05)},
    }


def _predict_burnout(employee_id: str = "", department: str = "") -> dict:
    probability = round(random.uniform(0.05, 0.55), 3)
    factors = [
        {"factor": "Workload", "severity": random.choice(["low", "medium", "high"]), "impact": round(random.uniform(0.1, 0.35), 2)},
        {"factor": "Overtime Hours", "severity": random.choice(["low", "medium", "high"]), "impact": round(random.uniform(0.1, 0.25), 2)},
        {"factor": "Sleep Quality", "severity": random.choice(["low", "medium", "high"]), "impact": round(random.uniform(0.05, 0.2), 2)},
        {"factor": "Stress Level", "severity": random.choice(["low", "medium", "high"]), "impact": round(random.uniform(0.05, 0.2), 2)},
        {"factor": "Social Support", "severity": random.choice(["low", "medium", "high"]), "impact": round(random.uniform(0.05, 0.15), 2)},
    ]
    return {
        "prediction": "high_risk" if probability > 0.35 else "medium_risk" if probability > 0.18 else "low_risk",
        "probability": probability,
        "risk_factors": sorted(factors, key=lambda f: f["impact"], reverse=True),
        "recommendations": [
            "Implement mandatory break reminders and time-off policies.",
            "Reduce overtime allocation and redistribute workload.",
            "Provide access to mental health resources and counseling.",
            "Conduct wellness check-ins with management.",
        ] if probability > 0.25 else [
            "Maintain current wellness programs.",
            "Encourage regular breaks and PTO usage.",
        ],
    }


def _predict_promotion(employee_id: str = "", department: str = "") -> dict:
    probability = round(random.uniform(0.1, 0.8), 3)
    factors = [
        {"factor": "Performance Score", "weight": random.choice(["high", "medium", "low"]), "value": round(random.uniform(3.0, 5.0), 1)},
        {"factor": "Tenure", "weight": random.choice(["high", "medium", "low"]), "value": round(random.uniform(1, 8), 1)},
        {"factor": "Leadership Potential", "weight": random.choice(["high", "medium", "low"]), "value": round(random.uniform(2.5, 5.0), 1)},
        {"factor": "Skill Development", "weight": random.choice(["high", "medium", "low"]), "value": round(random.uniform(2.0, 5.0), 1)},
    ]
    return {
        "prediction": "ready" if probability > 0.6 else "potential" if probability > 0.3 else "not_ready",
        "probability": probability,
        "factors": factors,
        "recommendations": [
            "Prepare promotion package for review committee.",
            "Identify stretch assignment opportunities to demonstrate readiness.",
            "Develop leadership skills through targeted training.",
            "Consider lateral move for broader exposure.",
        ] if probability > 0.4 else [
            "Focus on current role performance and skill building.",
            "Set quarterly development goals with manager.",
        ],
        "suggested_roles": ["Senior " + role for role in random.sample(["Analyst", "Engineer", "Specialist", "Lead", "Manager"], 2)] if probability > 0.4 else [],
    }


def _salary_recommendation(employee_id: str, role: str, experience: int, performance: float = None, location: str = "", department: str = "") -> dict:
    base = random.randint(60000, 180000)
    market_mult = random.uniform(0.85, 1.25)
    perf_mult = 1.0 + (performance or 3.0 - 3.0) * 0.05 if performance else 1.0
    recommended = round(base * market_mult * perf_mult, -2)
    percentiles = ["10th", "25th", "50th", "75th", "90th"]
    return {
        "current_salary": float(base),
        "recommended_salary": float(recommended),
        "percentile": random.choice(percentiles),
        "market_data": {
            "role": role,
            "location": location or "National Average",
            "p10": int(base * 0.75),
            "p25": int(base * 0.88),
            "p50": int(base * 1.0),
            "p75": int(base * 1.15),
            "p90": int(base * 1.35),
        },
        "factors": [
            {"name": "Experience", "impact": f"+{experience * 2}%"},
            {"name": "Performance", "impact": f"+{int((perf_mult - 1) * 100)}%" if performance else "N/A"},
            {"name": "Location Premium", "impact": f"+{random.randint(0, 15)}%" if location else "Standard Rate"},
            {"name": "Market Demand", "impact": f"+{random.randint(5, 20)}%"},
        ],
    }


def _forecast_workforce(department: str = "", horizon: int = 12, include_attrition: bool = True, include_hiring: bool = True) -> dict:
    now = datetime.now(timezone.utc)
    monthly = []
    headcount = random.randint(50, 500)
    for i in range(horizon):
        month = (now.replace(day=1) + timedelta(days=32 * i)).strftime("%Y-%m")
        attrition = random.randint(0, 5) if include_attrition else 0
        hires = random.randint(1, 8) if include_hiring else 0
        headcount = headcount - attrition + hires
        monthly.append({"month": month, "headcount": headcount, "hires": hires, "attrition": attrition})
    return {
        "forecasts": [
            {"metric": "Headcount", "current": monthly[0]["headcount"], "projected": monthly[-1]["headcount"], "change_pct": round((monthly[-1]["headcount"] - monthly[0]["headcount"]) / monthly[0]["headcount"] * 100, 1)},
            {"metric": "New Hires", "current": sum(m["hires"] for m in monthly[:3]), "projected": sum(m["hires"] for m in monthly[-3:]), "change_pct": round(random.uniform(-10, 20), 1)},
            {"metric": "Attrition", "current": sum(m["attrition"] for m in monthly[:3]), "projected": sum(m["attrition"] for m in monthly[-3:]), "change_pct": round(random.uniform(-15, 15), 1)},
        ],
        "total_headcount_projection": monthly,
        "key_insights": [
            f"Headcount expected to grow by {monthly[-1]['headcount'] - monthly[0]['headcount']} over {horizon} months.",
            f"Projected hiring demand of {sum(m['hires'] for m in monthly)} positions.",
            f"Estimated attrition of {sum(m['attrition'] for m in monthly)} employees if trends continue.",
        ],
        "confidence": round(random.uniform(0.75, 0.95), 2),
    }


def _answer_policy(query: str, area: str = "") -> dict:
    return {
        "answer": (
            f"Based on company policies related to {area or 'this topic'}: "
            f"Regarding '{query}', our policy framework indicates that {random.choice(['approval is required from management', 'standard procedures apply', 'department-specific guidelines exist', 'company-wide standards are in effect'])}. "
            "Employees should consult their manager or HR representative for specific situations."
        ),
        "policy_citations": [
            ({"policy": f"{area or 'General'} Policy #{random.randint(100, 999)}", "relevance": random.choice(["direct", "related", "indirect"]), "section": f"Section {random.randint(1, 10)}.{random.randint(1, 5)}"})
            for _ in range(random.randint(1, 3))
        ],
        "related_policies": [
            f"{random.choice(['Leave', 'Attendance', 'Conduct', 'Benefits', 'Travel'])} Policy",
            f"{random.choice(['Code of Conduct', 'Remote Work', 'Expense Reimbursement', 'Data Privacy'])}",
        ],
    }


def _recommend_leave(employee_id: str, leave_type: str, requested_dates: list[str], department: str = "") -> dict:
    conflicts = random.choices(requested_dates, k=random.randint(0, min(1, len(requested_dates))))
    return {
        "recommended": len(conflicts) == 0,
        "reason": "Requested dates are available with adequate team coverage." if not conflicts else f"Conflict detected on {', '.join(conflicts)}. Consider alternative dates.",
        "coverage_suggestions": [
            f"Team {random.choice(['A', 'B', 'C'])} can provide backup coverage.",
            "Cross-train with colleague to ensure continuity.",
            "Document pending tasks and handoff procedures.",
        ],
        "pattern_insights": {
            "total_days_used": random.randint(5, 25),
            "remaining_days": random.randint(5, 20),
            "department_coverage": f"{random.randint(70, 95)}%",
            "previous_approvals": random.randint(1, 10),
        },
    }


def _recruitment_assistant(job_req: str, candidate_pool: list[str] = None, criteria: dict = None) -> dict:
    return {
        "recommended_sources": [
            "LinkedIn Professional Network",
            "Industry-specific Job Boards",
            "Employee Referral Program",
            "University Recruitment Partnerships",
            "Professional Association Channels",
        ],
        "screening_questions": [
            "Describe your experience with the key technologies required for this role.",
            "How have you handled a challenging project deadline in the past?",
            "What attracted you to this position and our company?",
            "Can you provide an example of a time you improved a process or system?",
            "How do you stay current with industry trends and developments?",
        ],
        "interview_tips": [
            "Use structured behavioral interviewing techniques for consistent evaluation.",
            "Include a practical skills assessment relevant to the role.",
            "Involve potential team members in the interview process.",
            "Evaluate cultural fit as well as technical competence.",
            "Provide candidates with clear next steps and timeline.",
        ],
        "estimated_time_to_hire": f"{random.randint(2, 8)} weeks",
    }


def _onboarding_recommendation(role: str, department: str, experience: str) -> dict:
    return {
        "recommended_plan": [
            {"week": 1, "focus": "Orientation & Setup", "activities": ["IT setup", "HR paperwork", "Team introductions", "Company overview"]},
            {"week": 2, "focus": "Role Training", "activities": ["Role-specific training", "Tool access and tutorials", "Process documentation review"]},
            {"week": 3, "focus": "Hands-on Projects", "activities": ["Small project assignment", "Shadow team members", "First client/internal meeting"]},
            {"week": 4, "focus": "Integration & Feedback", "activities": ["First formal check-in", "Goal setting", "Performance expectations review"]},
        ],
        "estimated_ramp_up": f"{random.choice(['4-6', '8-12', '12-16'])} weeks",
        "key_milestones": [
            "Complete all compliance training modules",
            "Submit first project deliverable",
            "Conduct first solo client/internal meeting",
            "Receive positive 30-day feedback from manager",
        ],
        "mentor_suggestion": random.choice([
            f"Senior {role} from {department} team",
            f"Department lead in {department}",
            f"Cross-functional mentor from adjacent team",
        ]),
    }


def _training_recommendation(employee_id: str, current_skills: list[str], target_role: str = "", gaps: list[str] = None) -> dict:
    all_courses = [
        {"title": "Advanced Data Analytics", "category": "Technical", "duration": "6 weeks", "relevance": 0.92},
        {"title": "Leadership Essentials", "category": "Management", "duration": "4 weeks", "relevance": 0.88},
        {"title": "Communication Skills Mastery", "category": "Soft Skills", "duration": "3 weeks", "relevance": 0.85},
        {"title": "Project Management Professional", "category": "Management", "duration": "8 weeks", "relevance": 0.82},
        {"title": "AI and Machine Learning Fundamentals", "category": "Technical", "duration": "10 weeks", "relevance": 0.78},
        {"title": "Emotional Intelligence at Work", "category": "Soft Skills", "duration": "2 weeks", "relevance": 0.75},
        {"title": "Strategic Thinking and Planning", "category": "Management", "duration": "5 weeks", "relevance": 0.72},
        {"title": "Technical Writing and Documentation", "category": "Technical", "duration": "3 weeks", "relevance": 0.68},
    ]
    return {
        "recommended_courses": random.sample(all_courses, min(4, len(all_courses))),
        "skill_gaps": [
            {"skill": "Strategic Planning", "current": "intermediate", "required": "advanced", "priority": "high"},
            {"skill": "Data Analysis", "current": "beginner", "required": "intermediate", "priority": "medium"},
            {"skill": "Team Leadership", "current": "beginner", "required": "advanced", "priority": "high"},
        ] if target_role else [
            {"skill": current_skills[0] if current_skills else "Communication", "current": "intermediate", "required": "advanced", "priority": "medium"},
        ],
        "learning_path": [
            "Foundational courses first to build base knowledge",
            "Intermediate specialized training in target area",
            "Advanced application through real projects",
            "Continuous learning through mentorship and practice",
        ],
        "estimated_time": f"{random.randint(3, 12)} months",
    }


def _compliance_check(action: str, department: str, role: str, region: str = "") -> dict:
    risks = []
    if "data" in action.lower():
        risks.append({"type": "Data Privacy", "severity": "high", "description": "Action involves personal data processing", "mitigation": "Ensure data privacy impact assessment completed"})
    if "hire" in action.lower() or "terminate" in action.lower():
        risks.append({"type": "Employment Law", "severity": "medium", "description": "Action may have legal implications", "mitigation": "Consult legal team before proceeding"})
    return {
        "compliant": len(risks) == 0,
        "risks": risks,
        "required_actions": [
            "Document all steps and decisions for audit trail" if risks else "No additional actions required",
            "Notify relevant stakeholders of the action" if risks else "Proceed as planned",
        ],
        "policy_references": [
            f"Policy {random.choice(['PRIV-001', 'EMP-023', 'COMP-045', 'DATA-012'])}",
            f"Regulation {random.choice(['GDPR Article 6', 'SOC2 CC6.1', 'ISO 27001 A.8'])}",
        ],
    }


def _knowledge_search(query: str, filters: dict = None, max_results: int = 10) -> dict:
    knowledge_base = [
        {"id": "KB001", "title": "Employee Onboarding Checklist", "category": "Onboarding", "relevance": 0.95, "snippet": "Step-by-step guide for new employee orientation...", "url": "/knowledge/onboarding-checklist"},
        {"id": "KB002", "title": "Benefits Enrollment Guide", "category": "Benefits", "relevance": 0.92, "snippet": "Annual benefits enrollment procedures and deadlines...", "url": "/knowledge/benefits-guide"},
        {"id": "KB003", "title": "Performance Review Framework", "category": "Performance", "relevance": 0.88, "snippet": "Quarterly performance review process and best practices...", "url": "/knowledge/performance-review"},
        {"id": "KB004", "title": "Leave Policy Handbook", "category": "Leave", "relevance": 0.85, "snippet": "Complete guide to leave types, eligibility, and application...", "url": "/knowledge/leave-policy"},
        {"id": "KB005", "title": "Data Privacy Guidelines", "category": "Compliance", "relevance": 0.82, "snippet": "Employee data handling and privacy protection standards...", "url": "/knowledge/data-privacy"},
        {"id": "KB006", "title": "Remote Work Policy", "category": "Workplace", "relevance": 0.78, "snippet": "Remote work eligibility, expectations, and equipment...", "url": "/knowledge/remote-work"},
        {"id": "KB007", "title": "Training & Development Catalog", "category": "Training", "relevance": 0.75, "snippet": "Available training programs and enrollment process...", "url": "/knowledge/training-catalog"},
        {"id": "KB008", "title": "Expense Reimbursement Policy", "category": "Finance", "relevance": 0.72, "snippet": "Business expense reimbursement procedures and limits...", "url": "/knowledge/expense-policy"},
        {"id": "KB009", "title": "Code of Conduct", "category": "Ethics", "relevance": 0.70, "snippet": "Company values, ethical standards, and reporting...", "url": "/knowledge/code-of-conduct"},
        {"id": "KB010", "title": "Emergency Procedures", "category": "Safety", "relevance": 0.68, "snippet": "Workplace emergency response and evacuation plans...", "url": "/knowledge/emergency-procedures"},
    ]
    results = sorted(knowledge_base, key=lambda x: x["relevance"], reverse=True)[:max_results]
    return {
        "results": results,
        "total": len(results),
        "suggested_queries": [
            "How to enroll in benefits",
            "Performance review timeline",
            "Remote work eligibility",
            "Training program enrollment",
        ],
    }


def _org_advisor(query: str, org_context: dict = None) -> dict:
    return {
        "answer": (
            f"Based on organizational analysis, regarding '{query}': "
            "The current structure supports efficient communication but may benefit from additional cross-functional collaboration channels. "
            "Consider implementing regular inter-departmental syncs and shared OKR tracking."
        ),
        "recommendations": [
            "Establish cross-functional project teams for key initiatives.",
            "Implement OKR alignment across all departments.",
            "Create formal mentorship programs between senior and junior staff.",
            "Review span of control for management optimization.",
            "Consider agile team structures for technology departments.",
        ],
        "impact_analysis": {
            "communication_efficiency": "75%",
            "decision_speed": "medium",
            "collaboration_score": "68%",
            "suggested_improvements": [
                "Reduce reporting layers in large departments",
                "Increase cross-team project rotations",
                "Implement digital collaboration platforms",
            ],
        },
    }


def _detect_risks(department: str = "", employee_id: str = "", categories: list[str] = None) -> dict:
    risks_pool = [
        {"category": "Attrition", "risk": "High performer retention", "severity": "high", "probability": round(random.uniform(0.3, 0.8), 2), "impact": "Critical knowledge loss", "affected_employees": random.randint(1, 10)},
        {"category": "Compliance", "risk": "Policy violation", "severity": "high", "probability": round(random.uniform(0.1, 0.4), 2), "impact": "Regulatory penalties", "affected_employees": random.randint(1, 50)},
        {"category": "Operational", "risk": "Skill gap", "severity": "medium", "probability": round(random.uniform(0.2, 0.6), 2), "impact": "Reduced productivity", "affected_employees": random.randint(5, 30)},
        {"category": "Engagement", "risk": "Low morale", "severity": "medium", "probability": round(random.uniform(0.15, 0.5), 2), "impact": "Decreased productivity", "affected_employees": random.randint(10, 100)},
        {"category": "Financial", "risk": "Budget overrun", "severity": "medium", "probability": round(random.uniform(0.1, 0.35), 2), "impact": "Cost overruns", "affected_employees": 0},
        {"category": "Workforce", "risk": "Succession gap", "severity": "high", "probability": round(random.uniform(0.2, 0.5), 2), "impact": "Leadership vacuum", "affected_employees": random.randint(1, 5)},
    ]
    if categories:
        risks_pool = [r for r in risks_pool if r["category"].lower() in [c.lower() for c in categories]]
    selected = random.sample(risks_pool, min(4, len(risks_pool)))
    overall = round(sum(r["probability"] * (1.0 if r["severity"] == "high" else 0.6 if r["severity"] == "medium" else 0.3) for r in selected) / max(len(selected), 1), 3)
    return {
        "risks": selected,
        "overall_risk_score": min(overall * 100, 100),
        "trend": random.choice(["increasing", "stable", "decreasing"]),
        "mitigation_priorities": [
            "Address high-severity risks immediately with targeted action plans.",
            "Implement monitoring dashboards for medium-severity risks.",
            "Schedule quarterly risk review meetings.",
            "Develop contingency plans for top 3 risks.",
        ],
    }


def _detect_anomalies(data_source: str, metric: str = "", department: str = "", sensitivity: float = 0.95) -> dict:
    now = datetime.now(timezone.utc)
    timestamps = [(now - timedelta(hours=i * 24)).isoformat() for i in range(30)]
    values = [random.gauss(100, 15) for _ in range(30)]
    anomaly_idx = random.sample(range(len(values)), max(1, len(values) // 10))
    anomalies = []
    for idx in anomaly_idx:
        val = values[idx] * random.uniform(1.5, 3.0) * random.choice([1, -1])
        anomalies.append({"timestamp": timestamps[idx], "expected": round(values[idx], 1), "actual": round(val, 1), "deviation": f"{round(abs(val - values[idx]) / values[idx] * 100, 1)}%", "severity": "critical" if abs(val / values[idx]) > 2.0 else "warning"})
        values[idx] = val
    return {
        "anomalies": anomalies,
        "baseline": {"mean": round(sum(values) / len(values), 1), "std": round(15 * random.uniform(0.5, 1.5), 1), "period": "30 days"},
        "alert_level": "critical" if len(anomalies) > 3 else "warning" if len(anomalies) > 1 else "normal",
    }


def _optimize_shifts(department: str, date_range: list[str], current_schedule: list[dict] = None, constraints: dict = None) -> dict:
    start = datetime.strptime(date_range[0], "%Y-%m-%d") if date_range else datetime.now()
    days = abs((datetime.strptime(date_range[1], "%Y-%m-%d") - start).days) + 1 if len(date_range) > 1 else 7
    schedule = []
    for d in range(days):
        day = (start + timedelta(days=d)).strftime("%Y-%m-%d")
        for shift in ["Morning", "Afternoon", "Night"]:
            staff_needed = random.randint(3, 10)
            staff_assigned = staff_needed - random.randint(0, 2)
            schedule.append({"date": day, "shift": shift, "staff_required": staff_needed, "staff_assigned": staff_assigned, "gap": staff_needed - staff_assigned})
    return {
        "optimized_schedule": schedule,
        "coverage_gaps": [s for s in schedule if s["gap"] > 0][:5],
        "cost_savings": round(random.uniform(5000, 50000), 2),
        "efficiency_gain": round(random.uniform(5, 25), 1),
    }


def _succession_plan(position: str, department: str, required_skills: list[str], timeline: int = 12) -> dict:
    readiness = {"ready_now": random.randint(1, 3), "ready_1_2_years": random.randint(2, 5), "ready_3_5_years": random.randint(3, 8), "not_ready": random.randint(5, 15)}
    return {
        "internal_candidates": [
            {"name": f"Employee {chr(65 + i)}", "current_role": f"Senior {random.choice(['Analyst', 'Specialist', 'Lead'])}", "readiness": random.choice(["ready_now", "ready_1_2_years", "ready_3_5_years"]), "overlap_score": round(random.uniform(0.5, 1.0), 2)}
            for i in range(random.randint(2, 6))
        ],
        "readiness_levels": readiness,
        "development_plans": [
            "Create individual development plans for ready-now candidates.",
            "Provide stretch assignments and leadership exposure for emerging candidates.",
            "Establish mentoring relationships with current position holders.",
            "Implement accelerated development programs for high-potential employees.",
        ],
        "risk_of_vacancy": random.choice(["low", "medium", "high", "critical"]),
    }


def _budget_forecast(department: str, current_budget: float, historical: list[dict] = None, months: int = 12) -> dict:
    now = datetime.now(timezone.utc)
    monthly = []
    running = current_budget
    for i in range(months):
        month = (now.replace(day=1) + timedelta(days=32 * i)).strftime("%Y-%m")
        spent = round(running * random.uniform(0.05, 0.12), 2)
        running -= spent
        monthly.append({"month": month, "budgeted": round(current_budget / months, 2), "projected": round(spent, 2), "remaining": round(max(running, 0), 2)})
    total_forecast = round(sum(m["projected"] for m in monthly), 2)
    return {
        "monthly_projections": monthly,
        "total_forecast": total_forecast,
        "variance_analysis": {
            "budgeted_total": current_budget,
            "projected_total": total_forecast,
            "variance": round(current_budget - total_forecast, 2),
            "variance_pct": round((current_budget - total_forecast) / current_budget * 100, 1),
        },
        "recommendations": [
            "Review discretionary spending for potential optimization.",
            "Identify departments with consistent over/under spending patterns.",
            "Consider reallocation of surplus budget to high-impact initiatives.",
            "Implement monthly budget review cadence for better tracking.",
        ],
    }


def _performance_summary(employee_id: str, period: str = "last_quarter", include_metrics: list[str] = None) -> dict:
    score = round(random.uniform(55, 98), 1)
    trend = random.choice(["improving", "stable", "declining"])
    return {
        "summary": f"Employee has demonstrated {'strong' if score > 80 else 'adequate' if score > 65 else 'needs improvement'} performance during {period}. Overall score of {score}% reflects {'consistent excellence' if score > 80 else 'solid contribution' if score > 70 else 'areas requiring attention'}.",
        "highlights": [
            "Exceeded Q2 sales targets by 15%",
            "Successfully led cross-functional project delivery",
            "Received positive peer feedback on collaboration",
            "Completed advanced certification program",
        ] if score > 70 else [
            "Met baseline performance expectations",
            "Completed required training modules",
            "Shown improvement in key metrics",
        ],
        "areas_for_improvement": [
            "Develop strategic thinking capabilities",
            "Enhance stakeholder communication",
            "Build technical expertise in emerging areas",
        ] if score < 80 else [
            "Continue current trajectory of excellence",
        ],
        "overall_score": score,
        "trend": trend,
    }


def _split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", (text or "").strip())
    return [p.strip()[:300] for p in parts if p.strip()]


def _meeting_summary(transcript: str, meeting_type: str = "", attendees: list[str] = None) -> dict:
    sentences = _split_sentences(transcript)
    people = [str(a).strip()[:80] for a in (attendees or []) if str(a).strip()][:20]
    if not sentences:
        return {
            "summary": "No transcript content was provided, so no summary could be derived.",
            "key_points": [],
            "action_items": [f"{name}: No transcript available to derive action items." for name in people],
            "decisions": [],
            "follow_ups": [],
            "sample_data": True,
        }
    key_points = sentences[:5]
    decisions = [s for s in sentences if re.search(r"\b(decid|agree|approv|resolv|conclud)", s, re.IGNORECASE)][:5]
    follow_ups = [s for s in sentences if re.search(r"\b(follow[\s-]?up|next step|action item|todo|deadline|by friday|by monday)\b", s, re.IGNORECASE)][:8]
    owners = people or ["Unassigned"]
    action_items = [f"{owners[i % len(owners)]}: {s}" for i, s in enumerate(follow_ups[:8])]
    if not action_items:
        action_items = [f"{name}: Review the meeting notes and confirm your follow-ups." for name in owners[:8]]
    kind = meeting_type or "team"
    return {
        "summary": f"The {kind} meeting transcript contains {len(sentences)} points. {len(decisions)} decision(s) and {len(follow_ups)} follow-up(s) were identified from the transcript.",
        "key_points": key_points,
        "action_items": action_items,
        "decisions": decisions,
        "follow_ups": follow_ups,
        "sample_data": False,
    }


_WORKFLOW_PHASES = [
    ("Initiate", "high", 2),
    ("Execute", "medium", 5),
    ("Review", "medium", 3),
    ("Close", "low", 2),
]

_WORKFLOW_ROLE_BY_DEPARTMENT = {
    "hr": "HR Manager",
    "human resources": "HR Manager",
    "finance": "Finance Manager",
    "payroll": "Finance Manager",
    "compliance": "Compliance Officer",
    "audit": "Compliance Officer",
    "engineering": "Department Lead",
    "it": "Department Lead",
}


def _generate_workflow(process_name: str, department: str, description: str, constraints: dict = None) -> dict:
    name = (process_name or "Unnamed process").strip()[:120]
    dept = (department or "").strip().lower()
    owner_role = _WORKFLOW_ROLE_BY_DEPARTMENT.get(dept, "Department Lead")
    text = f"{description or ''} {json.dumps(constraints or {})}".lower()
    steps = []
    for i, (phase, potential, days) in enumerate(_WORKFLOW_PHASES):
        role = owner_role if i in (0, len(_WORKFLOW_PHASES) - 1) else ("Compliance Officer" if "compliance" in text or "audit" in text else "Team Member")
        steps.append({
            "step": i + 1,
            "name": f"{phase} {name}",
            "role": role,
            "estimated_time": f"{days} days",
            "automation_potential": potential,
        })
    total_days = sum(days for _, _, days in _WORKFLOW_PHASES)
    opportunities = ["Automate notification and status updates"]
    if "approv" in text:
        opportunities.append("Implement digital approval workflows")
    if "document" in text or "form" in text:
        opportunities.append("Use AI for document classification and routing")
    if "compliance" in text or "audit" in text:
        opportunities.append("Automate compliance checks and validations")
    return {
        "workflow": steps,
        "estimated_time": f"{total_days} days (~{max(1, round(total_days / 5))} weeks, rough estimate)",
        "required_roles": sorted({s["role"] for s in steps}),
        "automation_opportunities": opportunities,
        "sample_data": True,
    }


_AUTOMATION_FIELD_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,64}$")
_AUTOMATION_CONDITION_RE = re.compile(
    r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$"
)
_AUTOMATION_FORMAT = "atlas-automation-definition/v1"
_AUTOMATION_MAX_ACTIONS = 10
_AUTOMATION_MAX_TEXT = 200


def _parse_automation_condition(raw: str) -> tuple[dict | None, str | None]:
    """Parse one 'field operator value' condition into data. Never eval'd."""
    match = _AUTOMATION_CONDITION_RE.match(raw or "")
    if not match:
        return None, raw
    field, operator, value_text = match.groups()
    if not _AUTOMATION_FIELD_RE.match(field):
        return None, raw
    try:
        value = json.loads(value_text)
    except Exception:
        return None, raw
    if isinstance(value, (dict, list)):
        return None, raw
    return {"field": field, "operator": operator, "value": value}, None


def evaluate_automation_definition(definition: dict, event: dict) -> dict:
    """Interpret an automation definition against an event.

    Data-only interpreter: conditions are compared field by field, no code
    is generated or executed. Fails closed on anything it cannot understand.
    """
    definition = definition or {}
    event = event or {}
    invalid = definition.get("invalid_conditions") or []
    if invalid:
        return {"triggered": False, "actions": [], "reason": "definition has invalid conditions"}
    for cond in definition.get("conditions") or []:
        actual = event.get(cond.get("field"))
        operator = cond.get("operator")
        expected = cond.get("value")
        try:
            if operator == "==":
                matched = actual == expected
            elif operator == "!=":
                matched = actual != expected
            elif actual is None or expected is None:
                matched = False
            elif operator == ">":
                matched = actual > expected
            elif operator == "<":
                matched = actual < expected
            elif operator == ">=":
                matched = actual >= expected
            elif operator == "<=":
                matched = actual <= expected
            else:
                matched = False
        except TypeError:
            matched = False
        if not matched:
            return {"triggered": False, "actions": [], "reason": f"condition not met: {cond.get('field')} {operator}"}
    return {"triggered": True, "actions": list(definition.get("actions") or [])}


def _build_automation(trigger: str, actions: list[str], conditions: list[str] = None, department: str = "") -> dict:
    safe_actions = [str(a).strip()[:_AUTOMATION_MAX_TEXT] for a in (actions or [])]
    safe_actions = [a for a in safe_actions if a][:_AUTOMATION_MAX_ACTIONS]
    parsed_conditions: list[dict] = []
    invalid_conditions: list[str] = []
    for raw in (conditions or ['status == "pending"']):
        parsed, invalid = _parse_automation_condition(str(raw))
        if parsed is not None:
            parsed_conditions.append(parsed)
        else:
            invalid_conditions.append(str(raw)[:_AUTOMATION_MAX_TEXT])
    definition = {
        "format": _AUTOMATION_FORMAT,
        "trigger": str(trigger or "").strip()[:_AUTOMATION_MAX_TEXT],
        "department": str(department or "").strip()[:_AUTOMATION_MAX_TEXT],
        "conditions": parsed_conditions,
        "invalid_conditions": invalid_conditions,
        "actions": safe_actions,
        "requires_review": True,
        "executable_code": False,
    }
    per_action_hours = 2
    return {
        "automation_script": json.dumps(definition, indent=2),
        "automation_definition": definition,
        "requires_review": True,
        "invalid_conditions": invalid_conditions,
        "integration_points": [
            "Workflow engine API",
            "Notification service webhook",
            "Document management system",
            "Employee database",
            "Audit logging service",
        ],
        "estimated_savings": f"~{max(1, len(safe_actions)) * per_action_hours} hours/month (rough estimate, review before use)",
        "validation_steps": [
            "Review the automation definition above before enabling it.",
            "Test automation in staging environment first.",
            "Verify all integration points are functional.",
            "Set up monitoring and alerting for automation failures.",
            "Document rollback procedures.",
            "Train team members on automation workflows.",
        ],
    }


def _agentic_workflows(goal: str, context: dict = None, autonomy: str = "semi_autonomous") -> dict:
    steps = random.randint(4, 8)
    return {
        "plan": [
            {"phase": i + 1, "name": ["Analysis", "Planning", "Resource Allocation", "Execution", "Monitoring", "Optimization", "Review", "Reporting"][i % 8], "agent": random.choice(["HR-Agent", "Analytics-Agent", "Compliance-Agent", "Communication-Agent", "Scheduling-Agent"]), "autonomous": autonomy == "fully_autonomous" or random.choice([True, False]), "human_required": random.choice([True, False])}
            for i in range(steps)
        ],
        "sub_agents": [
            {"name": "HR-Agent", "role": "Employee data and HR operations", "capabilities": ["Profile management", "Policy lookup", "Leave processing"]},
            {"name": "Analytics-Agent", "role": "Data analysis and insights", "capabilities": ["Trend analysis", "Predictive modeling", "Report generation"]},
            {"name": "Compliance-Agent", "role": "Policy compliance checking", "capabilities": ["Rule validation", "Risk assessment", "Audit trail"]},
            {"name": "Communication-Agent", "role": "Multi-channel notifications", "capabilities": ["Email", "Slack", "In-app alerts"]},
        ],
        "estimated_steps": steps,
        "estimated_duration": f"{random.randint(1, 14)} days",
        "human_touchpoints": [
            "Final approval on critical decisions",
            "Exception handling when confidence is low",
            "Strategic direction and goal setting",
            "Stakeholder communication and escalation",
        ] if autonomy == "semi_autonomous" else [
            "Initial goal definition",
            "Final review and sign-off",
        ],
    }


def _autonomous_intelligence(scope: str = "organization", metrics: list[str] = None, generate_recs: bool = True) -> dict:
    return {
        "analysis": f"Autonomous intelligence analysis for {scope} scope reveals {random.randint(5, 15)} key patterns and {random.randint(3, 8)} optimization opportunities across workforce operations.",
        "insights": [
            {"type": "pattern", "description": f"Employee {random.choice(['engagement', 'productivity', 'satisfaction'])} shows {random.choice(['cyclical', 'trending', 'seasonal'])} pattern", "confidence": round(random.uniform(0.7, 0.98), 2), "auto_actionable": random.choice([True, False])},
            {"type": "anomaly", "description": f"Detected unusual pattern in {random.choice(['attendance', 'overtime', 'leave'])} for {random.choice(['Engineering', 'Sales', 'HR'])} department", "confidence": round(random.uniform(0.6, 0.95), 2), "auto_actionable": random.choice([True, False])},
            {"type": "trend", "description": f"Emerging trend in {random.choice(['remote work adoption', 'skill development', 'cross-team collaboration'])}", "confidence": round(random.uniform(0.65, 0.9), 2), "auto_actionable": random.choice([True, False])},
            {"type": "opportunity", "description": f"Potential {random.choice(['cost savings', 'efficiency gain', 'engagement boost'])} identified in {random.choice(['recruitment', 'training', 'resource allocation'])}", "confidence": round(random.uniform(0.55, 0.85), 2), "auto_actionable": random.choice([True, False])},
        ],
        "predictions": [
            {"metric": "Headcount Growth", "current": random.randint(100, 1000), "projected_30d": random.randint(100, 1100), "projected_90d": random.randint(100, 1200)},
            {"metric": "Skill Gap Score", "current": round(random.uniform(0.2, 0.6), 2), "projected_30d": round(random.uniform(0.2, 0.7), 2), "projected_90d": round(random.uniform(0.2, 0.8), 2)},
            {"metric": "Engagement Index", "current": round(random.uniform(60, 90), 1), "projected_30d": round(random.uniform(58, 92), 1), "projected_90d": round(random.uniform(55, 95), 1)},
            {"metric": "Operational Cost", "current": random.randint(50000, 500000), "projected_30d": random.randint(48000, 520000), "projected_90d": random.randint(45000, 550000)},
        ],
        "auto_actions": [
            {"action": "Schedule team building event", "trigger": "Engagement drop detected", "priority": "medium", "auto_execute": True},
            {"action": "Send skill gap report to L&D", "trigger": "Skill gap threshold exceeded", "priority": "high", "auto_execute": True},
            {"action": "Adjust shift allocations", "trigger": "Attendance pattern anomaly", "priority": "medium", "auto_execute": False},
        ] if generate_recs else [],
        "dashboard_suggestions": [
            "AI-powered workforce health scorecard",
            "Real-time autonomous operations dashboard",
            "Predictive analytics command center",
            "Automated insight discovery console",
        ],
    }


FUNCTION_MAP = {
    "attrition": _predict_attrition,
    "burnout": _predict_burnout,
    "promotion": _predict_promotion,
    "salary": _salary_recommendation,
    "forecast": _forecast_workforce,
    "policy": _answer_policy,
    "leave": _recommend_leave,
    "recruitment": _recruitment_assistant,
    "onboarding": _onboarding_recommendation,
    "training": _training_recommendation,
    "compliance": _compliance_check,
    "knowledge": _knowledge_search,
    "org_advisor": _org_advisor,
    "risk": _detect_risks,
    "anomaly": _detect_anomalies,
    "shift": _optimize_shifts,
    "succession": _succession_plan,
    "budget": _budget_forecast,
    "performance": _performance_summary,
    "meeting": _meeting_summary,
    "workflow": _generate_workflow,
    "automation": _build_automation,
    "agentic": _agentic_workflows,
    "autonomous": _autonomous_intelligence,
}
