"""T05b: PDF extraction cache, sha verification, CLI confinement, excerpt check."""

from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path

import pytest

from harvest_analytics import cli
from harvest_analytics.extract import pdf_text as pt
from harvest_analytics.extract.verify import excerpt_on_page, normalize_text


def _minimal_pdf(lines: list[str]) -> bytes:
    """Hand-built one-page PDF with Helvetica text (valid xref offsets)."""
    ops = ["BT", "/F1 12 Tf", "72 720 Td", "14 TL"]
    for ln in lines:
        esc = ln.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        ops.append(f"({esc}) Tj T*")
    ops.append("ET")
    stream = "\n".join(ops).encode("latin-1")
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(out.tell())
        out.write(f"{i} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode())
    for off in offsets:
        out.write(f"{off:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return out.getvalue()


@pytest.fixture()
def sample_pdf(tmp_path: Path) -> tuple[Path, str]:
    data = _minimal_pdf(["Ginger thrives best in well drained soils.", "Ginger requires 1300 -1500 mm of water."])
    p = tmp_path / "src" / "sample.pdf"
    p.parent.mkdir()
    p.write_bytes(data)
    return p, hashlib.sha256(data).hexdigest()


def test_extracts_pages_and_caches_by_hash_and_version(sample_pdf, tmp_path):
    path, sha = sample_pdf
    cache = tmp_path / "cache"
    first = pt.extract_pdf_text(path, sha, cache)
    assert first["cached"] is False
    assert first["sha256"] == sha and first["pageCount"] == 1
    page = first["pages"][0]
    assert page["page"] == 1 and page["extractable"] is True
    assert page["charCount"] == len(page["text"])
    assert "well drained" in page["text"]
    files = list(cache.iterdir())
    assert len(files) == 1 and files[0].name.startswith(sha + ".pypdf-native-text-")
    second = pt.extract_pdf_text(path, sha, cache)
    assert second["cached"] is True
    assert {k: v for k, v in second.items() if k != "cached"} == {k: v for k, v in first.items() if k != "cached"}


def test_stale_or_corrupt_cache_is_regenerated(sample_pdf, tmp_path):
    path, sha = sample_pdf
    cache = tmp_path / "cache"
    pt.extract_pdf_text(path, sha, cache)
    cfile = next(cache.iterdir())
    cfile.write_text("{not json", encoding="utf-8")
    assert pt.extract_pdf_text(path, sha, cache)["cached"] is False
    doc = json.loads(cfile.read_text(encoding="utf-8"))
    doc["extractorVersion"] = "older-version"
    cfile.write_text(json.dumps(doc), encoding="utf-8")
    assert pt.extract_pdf_text(path, sha, cache)["cached"] is False


def test_sha_mismatch_is_an_error_and_writes_no_cache(sample_pdf, tmp_path):
    path, sha = sample_pdf
    cache = tmp_path / "cache"
    wrong = ("0" if sha[0] != "0" else "1") + sha[1:]
    with pytest.raises(pt.ExtractionError, match="sha256 mismatch"):
        pt.extract_pdf_text(path, wrong, cache)
    assert not cache.exists()
    with pytest.raises(pt.ExtractionError, match="64 lowercase hex"):
        pt.extract_pdf_text(path, sha.upper(), cache)


def test_modified_file_with_old_hash_is_rejected_even_if_cached(sample_pdf, tmp_path):
    path, sha = sample_pdf
    cache = tmp_path / "cache"
    pt.extract_pdf_text(path, sha, cache)
    path.write_bytes(path.read_bytes() + b"\n% tampered\n")
    with pytest.raises(pt.ExtractionError, match="sha256 mismatch"):
        pt.extract_pdf_text(path, sha, cache)


def test_cli_entrypoint_registered_and_confined(sample_pdf, monkeypatch, tmp_path):
    path, sha = sample_pdf
    assert "extract.pdf_text" in cli.ENTRYPOINTS
    monkeypatch.setattr(pt, "default_cache_dir", lambda: tmp_path / "cache")
    # Outside the allowed root -> exit 4
    out, err = io.StringIO(), io.StringIO()
    monkeypatch.setattr("sys.stderr", err)
    rc = cli.main(["extract.pdf_text"], io.StringIO(json.dumps({"path": str(path), "sha256": sha})), out)
    assert rc == 4 and "outside the allowed" in err.getvalue()
    # Inside an allowed root -> ok
    monkeypatch.setattr(pt, "allowed_roots", lambda: [path.parent])
    out = io.StringIO()
    rc = cli.main(["extract.pdf_text"], io.StringIO(json.dumps({"path": str(path), "sha256": sha})), out)
    assert rc == 0
    res = json.loads(out.getvalue())
    assert res["pageCount"] == 1 and res["sha256"] == sha


def test_normalisation_is_narrow():
    assert normalize_text("1300 -1500  mm") == normalize_text("1300-1500 mm")
    assert normalize_text("inter-\nspace") == "inter-space"
    assert normalize_text("‘000 ha") == "'000 ha"
    # no fuzzy repair of intra-word spaces
    assert normalize_text("pla nting") != normalize_text("planting")


def test_excerpt_check_passes_and_fails_on_corrupted_fixture():
    page = "Ginger requires 1300 -1500 mm of water during its crop cycle. The critical sta ges for irrigation"
    good = "Ginger requires 1300-1500 mm of water during its crop cycle."
    assert excerpt_on_page(good, page)
    for corrupted in [
        good.replace("1300", "1200"),  # altered number
        good.replace("water", "rain"),  # altered word
        "The critical stages for irrigation",  # artifact silently repaired
        "",
    ]:
        assert not excerpt_on_page(corrupted, page), corrupted
