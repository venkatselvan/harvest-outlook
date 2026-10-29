"""Build curated ginger evidence, stages, rule candidates and reviewed rules.

    analytics/.venv/bin/python -m harvest_analytics.extract.curate

Deterministic: identical inputs (source PDFs pinned by sha256, fact table, rule
labels) produce byte-identical outputs. Refuses to write if any excerpt is not
found on its cited page, exceeds 60 words, or if a rule cites a missing evidence ID.
Requires the private source PDFs under data/raw/ (gitignored).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .ginger_facts import FACTS, SOURCES
from .ginger_rules import CANDIDATE_RULES, STAGES
from .pdf_text import EXTRACTOR_VERSION, extract_pdf_text, repo_root
from .verify import excerpt_on_page

# Curation timestamp (fixed so outputs are reproducible; date of curation run).
INGESTED_AT = "2026-10-30T00:00:00+00:00"
MAX_EXCERPT_WORDS = 60

EVIDENCE_FILE = "data/curated/evidence/ginger.hassan.evidence.json"
STAGES_FILE = "data/curated/stages/ginger.hassan-kharif.stages.json"
CANDIDATES_FILE = "data/curated/rules/ginger.rules.candidates.json"
REVIEWED_FILE = "data/curated/rules/ginger.rules.json"
CASES_FILE = "evals/cases/extraction/ginger-facts.json"
RULE_LABELS_FILE = "evals/labels/extraction/ginger-rules-labels.json"

LABEL_TO_STATUS = {"correct": "approved", "incorrect": "disabled", "unsupported": "candidate"}


class CurationError(ValueError):
    pass


def _dump(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def load_source_pages() -> dict[str, list[dict[str, Any]]]:
    return {k: extract_pdf_text(v["path"], v["sha256"])["pages"] for k, v in SOURCES.items()}


def build_evidence(pages: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    out = []
    seen: set[str] = set()
    for f in FACTS:
        if f["id"] in seen:
            raise CurationError(f"duplicate evidence id {f['id']}")
        seen.add(f["id"])
        src = SOURCES[f["source"]]
        page_text = pages[f["source"]][f["page"] - 1]["text"]
        if len(f["excerpt"].split()) > MAX_EXCERPT_WORDS:
            raise CurationError(f"{f['id']}: excerpt exceeds {MAX_EXCERPT_WORDS} words")
        if not excerpt_on_page(f["excerpt"], page_text):
            raise CurationError(f"{f['id']}: excerpt not found on page {f['page']}")
        locator: dict[str, Any] = {"page": f["page"]}
        if f.get("section"):
            locator["section"] = f["section"]
        out.append(
            {
                "schemaVersion": "1.0",
                "id": f["id"],
                "mode": "live",
                "sourceUrl": src["sourceUrl"],
                "publisher": src["publisher"],
                "documentTitle": src["documentTitle"],
                "documentVersion": src["documentVersion"],
                "contentHash": src["sha256"],
                "locator": locator,
                "content": {"kind": "excerpt", "text": f["excerpt"], "language": "en"},
                "publishedAt": None,
                "availability": {"effectiveAvailableAt": src["retrievedAt"], "basis": "conservative_upper_bound"},
                "ingestedAt": INGESTED_AT,
                "revisedAt": None,
                "geography": f["geography"],
                "cropIds": f.get("cropIds", ["ginger"]),
                "productIds": f["productIds"],
                "units": f["units"],
                "sourceUnits": f["sourceUnits"],
                "licence": src["licence"],
                "extraction": {"method": "native_text", "version": EXTRACTOR_VERSION, "reviewedBy": "rule_check"},
                "validationStatus": "pending",
            }
        )
    return out


def build_cases() -> dict[str, Any]:
    return {
        "schemaVersion": "1.0",
        "description": "Ginger (Hassan) extracted facts. Each case: excerpt must occur on the cited page; each claim field value must occur in the excerpt.",
        "extractorVersion": EXTRACTOR_VERSION,
        "sources": {k: {"sha256": v["sha256"], "path": v["path"], "url": v["sourceUrl"]} for k, v in SOURCES.items()},
        "cases": [
            {
                "evidenceId": f["id"],
                "source": f["source"],
                "page": f["page"],
                "claim": f["claim"],
                "fields": f["fields"],
                "expectedExcerpt": f["excerpt"],
                **({"notes": f["notes"]} if f.get("notes") else {}),
            }
            for f in FACTS
        ],
    }


def check_rule_evidence(rules: list[dict[str, Any]], stages: list[dict[str, Any]], evidence_ids: set[str]) -> list[str]:
    missing = []
    for r in rules:
        for e in r["evidenceIds"]:
            if e not in evidence_ids:
                missing.append(f"{r['id']}: {e}")
        for x in r["exceptions"]:
            for e in x["evidenceIds"]:
                if e not in evidence_ids:
                    missing.append(f"{r['id']}/{x['id']}: {e}")
    for s in stages:
        for e in s["evidenceIds"]:
            if e not in evidence_ids:
                missing.append(f"{s['id']}: {e}")
    return missing


def apply_rule_labels(candidates: list[dict[str, Any]], labels: dict[str, Any]) -> list[dict[str, Any]]:
    by_id = {lab["ruleId"]: lab for lab in labels["labels"]}
    reviewed = []
    for r in candidates:
        lab = by_id.get(r["id"])
        status = "candidate" if lab is None else LABEL_TO_STATUS[lab["label"]]
        if status == "approved" and not r["evidenceIds"]:
            status = "candidate"
        reviewed.append({**r, "reviewStatus": status})
    return reviewed


def main() -> int:
    root = repo_root()
    pages = load_source_pages()
    evidence = build_evidence(pages)
    ids = {e["id"] for e in evidence}
    missing = check_rule_evidence(CANDIDATE_RULES, STAGES, ids)
    if missing:
        raise CurationError("missing evidence ids: " + "; ".join(missing))
    _dump(root / EVIDENCE_FILE, evidence)
    _dump(root / STAGES_FILE, STAGES)
    _dump(root / CANDIDATES_FILE, CANDIDATE_RULES)
    _dump(root / CASES_FILE, build_cases())
    labels_path = root / RULE_LABELS_FILE
    if labels_path.is_file():
        reviewed = apply_rule_labels(CANDIDATE_RULES, json.loads(labels_path.read_text(encoding="utf-8")))
        _dump(root / REVIEWED_FILE, reviewed)
    print(json.dumps({"evidence": len(evidence), "stages": len(STAGES), "candidateRules": len(CANDIDATE_RULES),
                      "reviewedWritten": labels_path.is_file()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
