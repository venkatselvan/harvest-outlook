"""Fetch a public URL, save body under data/raw, append a provenance record to data/raw/fetch_log.jsonl.

Usage: .venv/bin/python -I scripts/audit/fetch.py <id> <url> [--save NAME] [--head]
No credentials, no CAPTCHA handling, no session tricks. A failed/blocked response is recorded, not retried around.
"""
import argparse, hashlib, json, pathlib, datetime, sys
import requests, re

def redact(u):
    return re.sub(r"(api-key=)[^&]+", r"\1<REDACTED>", u) if u else u

ROOT = pathlib.Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
UA = "HarvestOutlook-data-audit/0.1 (research; contact via repository owner)"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("id"); ap.add_argument("url")
    ap.add_argument("--save", default=None)
    ap.add_argument("--head", action="store_true", help="status only (GET with stream, body discarded)")
    a = ap.parse_args()
    RAW.mkdir(parents=True, exist_ok=True)
    ts = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    rec = {"id": a.id, "url": redact(a.url), "retrievedAt": ts}
    try:
        r = requests.get(a.url, headers={"User-Agent": UA}, timeout=60, stream=a.head, allow_redirects=True)
        rec.update(status=r.status_code, finalUrl=redact(r.url), contentType=r.headers.get("content-type"))
        if not a.head:
            body = r.content
            rec.update(bytes=len(body), sha256=hashlib.sha256(body).hexdigest())
            if a.save:
                p = RAW / a.save; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(body)
                rec["savedAs"] = str(p.relative_to(ROOT))
        r.close()
    except Exception as e:
        rec.update(status=None, error=f"{type(e).__name__}: {e}")
    with open(RAW / "fetch_log.jsonl", "a") as f:
        f.write(json.dumps(rec) + "\n")
    print(json.dumps(rec))

if __name__ == "__main__":
    main()
