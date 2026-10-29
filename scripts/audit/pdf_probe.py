"""Measure downloaded PDFs: pages, SHA-256, bytes, pypdf text-extractability. Writes data/raw/pdf_probe.json."""
import json, hashlib, pathlib, sys
from pypdf import PdfReader
ROOT = pathlib.Path(__file__).resolve().parents[2]
out = {}
for p in sorted((ROOT / "data/raw").rglob("*.pdf")):
    b = p.read_bytes(); r = PdfReader(str(p))
    chars = [len((pg.extract_text() or "").strip()) for pg in r.pages]
    out[str(p.relative_to(ROOT))] = {"bytes": len(b), "sha256": hashlib.sha256(b).hexdigest(), "pages": len(r.pages),
        "pypdfVersion": __import__("pypdf").__version__, "pagesWithText": sum(c > 50 for c in chars), "totalChars": sum(chars)}
(ROOT / "data/raw/pdf_probe.json").write_text(json.dumps(out, indent=1)); print(json.dumps(out, indent=1))
