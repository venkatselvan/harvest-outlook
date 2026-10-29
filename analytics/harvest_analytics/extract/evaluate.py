"""Extraction and rule-review evaluation for the ginger evidence set.

    analytics/.venv/bin/python -m harvest_analytics.extract.evaluate --run-id <id>

Writes evals/results/extraction/<runId>/report.json. Every rate is reported with
its numerator and denominator. Recall is NOT measured (no independent gold set of
all facts in the documents exists).
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

from .curate import CASES_FILE, CANDIDATES_FILE, REVIEWED_FILE, RULE_LABELS_FILE, load_source_pages
from .ginger_facts import SOURCES
from .pdf_text import EXTRACTOR_VERSION, repo_root
from .verify import excerpt_on_page, normalize_text

FACT_LABELS_FILE = "evals/labels/extraction/ginger-facts-labels.json"


def _num_token(v: int | float) -> str:
    return str(v)


def field_in_excerpt(value: Any, excerpt: str) -> bool:
    norm = normalize_text(excerpt)
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        tok = re.escape(_num_token(value))
        return re.search(rf"(?<![\d.]){tok}(?![\d])", norm) is not None
    return normalize_text(str(value)) in norm


def rate(n: int, d: int) -> dict[str, Any]:
    return {"numerator": n, "denominator": d, "rate": (round(n / d, 4) if d else None)}


def evaluate(cases_doc: dict[str, Any], pages: dict[str, list[dict[str, Any]]], fact_labels: dict[str, Any],
             rule_labels: dict[str, Any], candidates: list[dict[str, Any]], reviewed: list[dict[str, Any]]) -> dict[str, Any]:
    cases = cases_doc["cases"]
    grounding_fail, field_fail = [], []
    fields_total = fields_ok = cases_all_fields_ok = 0
    for c in cases:
        text = pages[c["source"]][c["page"] - 1]["text"]
        if not excerpt_on_page(c["expectedExcerpt"], text):
            grounding_fail.append(c["evidenceId"])
        bad = [k for k, v in c["fields"].items() if not field_in_excerpt(v, c["expectedExcerpt"])]
        fields_total += len(c["fields"])
        fields_ok += len(c["fields"]) - len(bad)
        if bad:
            field_fail.append({"evidenceId": c["evidenceId"], "fields": bad})
        else:
            cases_all_fields_ok += 1

    flabs = {lab["evidenceId"]: lab for lab in fact_labels["labels"]}
    labelled = [flabs[c["evidenceId"]] for c in cases if c["evidenceId"] in flabs]
    unlabelled = [c["evidenceId"] for c in cases if c["evidenceId"] not in flabs]
    final_counts = Counter(lab["label"] for lab in labelled)
    first_counts = Counter(lab.get("firstPassLabel", lab["label"]) for lab in labelled)

    rlabs = {lab["ruleId"]: lab for lab in rule_labels["labels"]}
    rule_counts = Counter(rlabs[r["id"]]["label"] for r in candidates if r["id"] in rlabs)
    status_counts = Counter(r["reviewStatus"] for r in reviewed)
    approved_not_correct = [r["id"] for r in reviewed if r["reviewStatus"] == "approved" and rlabs.get(r["id"], {}).get("label") != "correct"]

    extractable = {k: {"pageCount": len(p), "nonExtractablePages": [x["page"] for x in p if not x["extractable"]]} for k, p in pages.items()}

    return {
        "schemaVersion": "1.0",
        "extractorVersion": EXTRACTOR_VERSION,
        "casesExtractorVersion": cases_doc.get("extractorVersion"),
        "sources": {k: {"sha256": v["sha256"], "url": v["sourceUrl"], "documentVersion": v["documentVersion"], **extractable[k]} for k, v in SOURCES.items()},
        "facts": {
            "cases": len(cases),
            "excerptOnCitedPage": rate(len(cases) - len(grounding_fail), len(cases)),
            "excerptOnCitedPageFailures": grounding_fail,
            "claimFieldValuesInExcerpt": rate(fields_ok, fields_total),
            "casesWithAllClaimFieldsInExcerpt": rate(cases_all_fields_ok, len(cases)),
            "claimFieldFailures": field_fail,
            "claimLabelPrecisionFinal": rate(final_counts.get("correct", 0), len(labelled)),
            "claimLabelPrecisionFirstPass": rate(first_counts.get("correct", 0), len(labelled)),
            "claimLabelCountsFinal": dict(final_counts),
            "claimLabelCountsFirstPass": dict(first_counts),
            "unlabelledCases": unlabelled,
            "recall": None,
            "recallNote": "Not measured: no independent gold list of all relevant facts in the two documents.",
        },
        "rules": {
            "candidates": len(candidates),
            "labelled": sum(rule_counts.values()),
            "labelCounts": dict(rule_counts),
            "fullRuleCorrectness": rate(rule_counts.get("correct", 0), len(candidates)),
            "reviewStatusCounts": dict(status_counts),
            "approvedWithoutCorrectLabel": approved_not_correct,
        },
        "labelProvenance": {
            "factLabeller": fact_labels.get("labeller"),
            "ruleLabeller": rule_labels.get("labeller"),
            "independentHumanReview": "pending",
            "caveat": "Labels were produced by the same model that extracted the facts and wrote the rules; they are not an independent human-labelled evaluation (PRD 14 gate not yet met).",
        },
        "exclusions": [
            {"what": "Chemical control measures, doses and spray schedules (IISR pp. 10-22, 24, 29; CRIDA pp. 29-34)", "reason": "PRD 9.2: pesticide selection and prescriptions out of release scope; diseases/pests recorded as inspection cues only."},
            {"what": "Fertilizer schedules other than the Karnataka row of IISR Table 3, and soil-test fertilizer table (IISR pp. 12-14)", "reason": "Numeric nutrient advice gated by PRD 9.2; Karnataka row kept only as scope evidence."},
            {"what": "Variety tables for other states (IISR pp. 5-7) and photo pages (pp. 8-9)", "reason": "Not relevant to Hassan; no Karnataka-notified variety listed."},
            {"what": "Organic certification, processing and FSSAI standards (IISR pp. 22-29)", "reason": "Outside growing-plan scope; dry-ginger recovery and moisture retained."},
            {"what": "CRIDA livestock, poultry, fisheries and field-crop contingency measures (pp. 7-42)", "reason": "Ginger is not named outside the page-7 horticulture area table."},
            {"what": "Regional ginger yield (t/ha) for Hassan or Karnataka", "reason": "Not present in either source; only variety-release means (IISR Table 1) exist."},
        ],
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--run-date", default=None, help="ISO date recorded in the report (default: today, UTC)")
    a = ap.parse_args(argv)
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$", a.run_id):
        raise SystemExit("invalid run id")
    root = repo_root()
    load = lambda p: json.loads((root / p).read_text(encoding="utf-8"))  # noqa: E731
    report = evaluate(load(CASES_FILE), load_source_pages(), load(FACT_LABELS_FILE), load(RULE_LABELS_FILE),
                      load(CANDIDATES_FILE), load(REVIEWED_FILE))
    import datetime as _dt
    report = {"runId": a.run_id, "runDate": a.run_date or _dt.datetime.now(_dt.timezone.utc).date().isoformat(), **report}
    out = root / "evals" / "results" / "extraction" / a.run_id / "report.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(out.relative_to(root)), "facts": report["facts"]["excerptOnCitedPage"],
                      "rules": report["rules"]["reviewStatusCounts"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
