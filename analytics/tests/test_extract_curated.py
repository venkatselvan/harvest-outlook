"""T05b: curated ginger evidence/stages/rules - schema, grounding, chain and review checks."""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path

import pytest
from jsonschema import Draft7Validator, FormatChecker

from harvest_analytics.extract import curate
from harvest_analytics.extract.evaluate import evaluate, field_in_excerpt
from harvest_analytics.extract.ginger_facts import SOURCES
from harvest_analytics.extract.ginger_rules import SOURCE_TOTAL_DURATION_DAYS
from harvest_analytics.extract.pdf_text import repo_root
from harvest_analytics.extract.verify import excerpt_on_page

ROOT = repo_root()
SCHEMAS = ROOT / "packages" / "contracts" / "schema"
RAW_PRESENT = all((ROOT / s["path"]).is_file() for s in SOURCES.values())
needs_raw = pytest.mark.skipif(not RAW_PRESENT, reason="private source PDFs under data/raw/ not present (gitignored)")


def _load(rel: str):
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))


EVIDENCE = _load(curate.EVIDENCE_FILE)
STAGES = _load(curate.STAGES_FILE)
CANDIDATES = _load(curate.CANDIDATES_FILE)
REVIEWED = _load(curate.REVIEWED_FILE)
CASES = _load(curate.CASES_FILE)
RULE_LABELS = _load(curate.RULE_LABELS_FILE)
FACT_LABELS = _load("evals/labels/extraction/ginger-facts-labels.json")
EVIDENCE_IDS = {e["id"] for e in EVIDENCE}


def _validator(name: str) -> Draft7Validator:
    return Draft7Validator(json.loads((SCHEMAS / f"{name}.json").read_text(encoding="utf-8")), format_checker=FormatChecker())


def _rule_field_types() -> dict[str, str]:
    """Allowlist parsed from the TS contract so Python cannot drift from it."""
    src = (ROOT / "packages" / "contracts" / "src" / "rules.ts").read_text(encoding="utf-8")
    block = src[src.index("RULE_FIELD_TYPES = {"): src.index("} as const")]
    pairs = re.findall(r"'?([A-Za-z.]+)'?:\s*'(string|number|date)'", block)
    assert len(pairs) >= 10
    return dict(pairs)


# ---------------- schema validation ----------------
@pytest.mark.parametrize(
    "rel,schema",
    [
        (curate.EVIDENCE_FILE, "EvidenceRecord"),
        (curate.STAGES_FILE, "StageDefinition"),
        (curate.CANDIDATES_FILE, "CropRule"),
        (curate.REVIEWED_FILE, "CropRule"),
    ],
)
def test_curated_files_validate_against_exported_json_schema(rel, schema):
    v = _validator(schema)
    records = _load(rel)
    assert isinstance(records, list) and records
    errors = [(r.get("id"), e.message) for r in records for e in v.iter_errors(r)]
    assert errors == []


def test_every_curated_json_file_is_covered_by_schema_test():
    owned = sorted(p.relative_to(ROOT).as_posix() for d in ["evidence", "stages", "rules"] for p in (ROOT / "data/curated" / d).glob("ginger.*.json"))
    assert owned == sorted([curate.EVIDENCE_FILE, curate.STAGES_FILE, curate.CANDIDATES_FILE, curate.REVIEWED_FILE])


def test_evidence_contract_refinements_and_policy():
    for e in EVIDENCE:
        assert e["locator"].get("page"), e["id"]
        assert e["sourceUrl"].startswith("https://")
        assert e["mode"] == "live" and e["validationStatus"] == "pending"
        assert e["extraction"]["method"] == "native_text"
        assert e["contentHash"] in {s["sha256"] for s in SOURCES.values()}
        assert len(e["content"]["text"].split()) <= curate.MAX_EXCERPT_WORDS
        assert e["licence"]["redistributable"] is False
        # dry ginger only where the source says so
        if "ginger.dry" in e["productIds"]:
            assert re.search(r"dr(y|ied) ginger|dry recovery|\b\d+(\.\d+)? \d+(-\d+)? \d+(\.\d+)?", e["content"]["text"], re.I), e["id"]
    assert len(EVIDENCE_IDS) == len(EVIDENCE)


# ---------------- excerpt grounding ----------------
@needs_raw
def test_every_excerpt_is_on_its_cited_page():
    pages = curate.load_source_pages()
    by_hash = {s["sha256"]: k for k, s in SOURCES.items()}
    failures = [
        e["id"]
        for e in EVIDENCE
        if not excerpt_on_page(e["content"]["text"], pages[by_hash[e["contentHash"]]][e["locator"]["page"] - 1]["text"])
    ]
    assert failures == []


@needs_raw
def test_corrupted_evidence_fixture_fails_grounding():
    pages = curate.load_source_pages()
    rec = next(e for e in EVIDENCE if e["id"].endswith("p14.water-requirement"))
    page_text = pages["iisr"][rec["locator"]["page"] - 1]["text"]
    assert excerpt_on_page(rec["content"]["text"], page_text)
    corrupted = rec["content"]["text"].replace("1300", "1100")
    assert not excerpt_on_page(corrupted, page_text)
    wrong_page = pages["iisr"][rec["locator"]["page"]]["text"]  # next page
    assert not excerpt_on_page(rec["content"]["text"], wrong_page)


@needs_raw
def test_curation_is_deterministic():
    pages = curate.load_source_pages()
    assert curate.build_evidence(pages) == EVIDENCE
    assert curate.build_cases() == CASES


@needs_raw
def test_curation_refuses_unverifiable_excerpt(monkeypatch):
    from harvest_analytics.extract import ginger_facts

    bad = copy.deepcopy(ginger_facts.FACTS)
    bad[0]["excerpt"] = bad[0]["excerpt"].replace("65 percent", "75 percent")
    monkeypatch.setattr(curate, "FACTS", bad)
    with pytest.raises(curate.CurationError, match="not found on page"):
        curate.build_evidence(curate.load_source_pages())


# ---------------- stages ----------------
def test_stage_ranges_and_chain_within_source_total():
    by_id = {s["stageId"]: s for s in STAGES}
    assert len(by_id) == len(STAGES)
    assert sorted(s["order"] for s in STAGES) == list(range(len(STAGES)))
    for s in STAGES:
        assert s["durationDays"]["min"] <= s["durationDays"]["max"], s["stageId"]
        assert s["method"] == "calendar_days" and s["thermal"] is None
        assert s["startsAfter"] is None or s["startsAfter"] in by_id
        assert s["evidenceIds"] and s["limitations"]
        assert s["seasons"] == ["kharif"] and s["scope"]["ids"] == ["IN-KA-hassan"]
    harvest = [s for s in STAGES if s["isHarvest"]]
    assert len(harvest) == 1
    # walk the chain from harvest back to planting
    lo = hi = 0
    cur = by_id[harvest[0]["startsAfter"]]
    while cur is not None:
        lo += cur["durationDays"]["min"]
        hi += cur["durationDays"]["max"]
        cur = by_id[cur["startsAfter"]] if cur["startsAfter"] else None
    # Harvest opens at the source's full-maturity range (210-240 DAP).
    assert SOURCE_TOTAL_DURATION_DAYS["min"] <= lo <= hi <= SOURCE_TOTAL_DURATION_DAYS["max"]
    assert (lo, hi) == (SOURCE_TOTAL_DURATION_DAYS["min"], SOURCE_TOTAL_DURATION_DAYS["max"])
    assert SOURCE_TOTAL_DURATION_DAYS["evidenceId"] in EVIDENCE_IDS


# ---------------- rules ----------------
def _leaves(c):
    if "all" in c:
        for x in c["all"]:
            yield from _leaves(x)
    elif "any" in c:
        for x in c["any"]:
            yield from _leaves(x)
    elif "not" in c:
        yield from _leaves(c["not"])
    else:
        yield c


def test_rules_use_only_allowlisted_fields_with_matching_types():
    types = _rule_field_types()
    for r in CANDIDATES:
        conds = [r["when"]] + [x["when"] for x in r["exceptions"]]
        for c in conds:
            for leaf in _leaves(c):
                t = types[leaf["field"]]  # KeyError = non-allowlisted field
                op, v = leaf["op"], leaf["value"]
                if op == "known":
                    assert isinstance(v, bool)
                elif op in ("gte", "lte", "between"):
                    assert t != "string", (r["id"], leaf)
                vals = v if op in ("in", "between") else [v]
                if op != "known":
                    for x in vals:
                        assert isinstance(x, (int, float)) if t == "number" else isinstance(x, str), (r["id"], leaf)


def test_no_rule_or_stage_references_missing_evidence():
    assert curate.check_rule_evidence(CANDIDATES, STAGES, EVIDENCE_IDS) == []
    assert curate.check_rule_evidence(REVIEWED, [], EVIDENCE_IDS) == []


def test_candidates_are_live_candidates_and_count_in_range():
    assert 8 <= len(CANDIDATES) <= 15
    assert all(r["reviewStatus"] == "candidate" and r["mode"] == "live" for r in CANDIDATES)
    assert any(r["exceptions"] for r in CANDIDATES)


def test_review_workflow_approved_only_if_labelled_correct():
    labels = {lab["ruleId"]: lab["label"] for lab in RULE_LABELS["labels"]}
    assert set(labels) == {r["id"] for r in CANDIDATES}, "every candidate must be labelled"
    for r in REVIEWED:
        if r["reviewStatus"] == "approved":
            assert labels[r["id"]] == "correct" and r["evidenceIds"]
        if labels[r["id"]] != "correct":
            assert r["reviewStatus"] != "approved"
        if labels[r["id"]] == "incorrect":
            assert r["reviewStatus"] == "disabled"
    assert REVIEWED == curate.apply_rule_labels(CANDIDATES, RULE_LABELS)
    # reviewed rules differ from candidates only by reviewStatus
    for a, b in zip(CANDIDATES, REVIEWED):
        assert {k: v for k, v in a.items() if k != "reviewStatus"} == {k: v for k, v in b.items() if k != "reviewStatus"}


def test_unlabelled_rule_stays_candidate():
    labels = {**RULE_LABELS, "labels": RULE_LABELS["labels"][1:]}
    out = curate.apply_rule_labels(CANDIDATES, labels)
    assert out[0]["reviewStatus"] == "candidate"


# ---------------- evaluation set ----------------
def test_cases_match_evidence_and_are_labelled():
    ev = {e["id"]: e for e in EVIDENCE}
    assert len(CASES["cases"]) == len(EVIDENCE)
    flabels = {lab["evidenceId"] for lab in FACT_LABELS["labels"]}
    for c in CASES["cases"]:
        e = ev[c["evidenceId"]]
        assert c["expectedExcerpt"] == e["content"]["text"] and c["page"] == e["locator"]["page"]
        assert c["fields"], c["evidenceId"]
        assert c["evidenceId"] in flabels


def test_field_match_rejects_partial_numbers():
    assert field_in_excerpt(1300, "requires 1300 -1500 mm")
    assert not field_in_excerpt(130, "requires 1300 -1500 mm")
    assert not field_in_excerpt(1.5, "1500 mm")
    assert field_in_excerpt("pre-monsoon showers", "receipt of pre -monsoon showers")


@needs_raw
def test_evaluation_report_has_denominators():
    rep = evaluate(CASES, curate.load_source_pages(), FACT_LABELS, RULE_LABELS, CANDIDATES, REVIEWED)
    f = rep["facts"]
    assert f["excerptOnCitedPage"]["denominator"] == len(EVIDENCE)
    assert f["excerptOnCitedPage"]["numerator"] == len(EVIDENCE)
    assert f["claimFieldValuesInExcerpt"]["numerator"] == f["claimFieldValuesInExcerpt"]["denominator"]
    assert rep["rules"]["fullRuleCorrectness"]["denominator"] == len(CANDIDATES)
    assert rep["rules"]["approvedWithoutCorrectLabel"] == []
    assert rep["facts"]["recall"] is None
