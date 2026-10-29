"""HTTP status check (GET, body discarded) of candidate agronomy sources for the 25 PRD crops.
Writes data/raw/crop_url_checks.json. Status only: this does NOT qualify content (scope, date, region)."""
import json, datetime, pathlib, requests, subprocess
ROOT = pathlib.Path(__file__).resolve().parents[2]
T = "https://agritech.tnau.ac.in/agriculture/"
H = "https://agritech.tnau.ac.in/horticulture/"
CANDIDATES = {
 "paddy": [T+"agri_seasonandvarieties_rice.html", "https://www.icar-iirr.org/"],
 "wheat": ["https://iiwbr.org.in/", "https://iiwbr.icar.gov.in/", "https://vikaspedia.in/agriculture/crop-production/package-of-practices/cereals/wheat"],
 "maize": [T+"millets_maize.html", T+"agri_seasonandvarieties_maize.html", "https://iimr.icar.gov.in/"],
 "sorghum": [T+"millets_sorghum.html", T+"agri_seasonandvarieties_sorghum.html", "https://www.millets.res.in/"],
 "pearl_millet": [T+"millets_cumbu.html", T+"agri_seasonandvarieties_cumbu.html"],
 "finger_millet": [T+"millets_ragi.html", T+"agri_seasonandvarieties_ragi.html"],
 "chickpea": [T+"CropProduction/Pulses/pulses_bengalgram.html", T+"agri_seasonandvarieties_bengalgram.html", "https://iipr.icar.gov.in/"],
 "pigeon_pea": [T+"CropProduction/Pulses/pulses_redgram.html", T+"agri_seasonandvarieties_redgram.html"],
 "green_gram": [T+"agri_seasonandvarieties_greengram.html", T+"CropProduction/Pulses/agri_cropproduction_pulses%20_%20index_green%20gram.html", "https://vikaspedia.in/agriculture/crop-production/package-of-practices/pulses/green-gram"],
 "black_gram": [T+"agri_seasonandvarieties_blackgram1.html", T+"CropProduction/Pulses/agri_cropproduction_pluses_blackgram_index.html", "https://vikaspedia.in/agriculture/crop-production/package-of-practices/pulses/black-gram"],
 "lentil": ["https://iipr.icar.gov.in/", "https://vikaspedia.in/agriculture/crop-production/package-of-practices/pulses/lentil"],
 "groundnut": [T+"agri_cropproduction_oilseeds%20index%20ground%20nut.html", "https://vikaspedia.in/agriculture/crop-production/package-of-practices/oilseeds/groundnut", T+"CropProduction/Oilseeds/oilseeds_groundnut.html", T+"agri_seasonandvarieties_groundnut.html", "https://dgr.icar.gov.in/"],
 "soybean": [T+"CropProduction/Pulses/pulses_soybean.html", T+"agri_seasonandvarieties_soybean.html", "https://iisrindore.icar.gov.in/"],
 "mustard": ["https://www.drmr.res.in/", "https://vikaspedia.in/agriculture/crop-production/package-of-practices/oilseeds/rapeseed-mustard"],
 "sesame": [T+"CropProduction/Oilseeds/oilseeds_gingelly.html", T+"agri_seasonandvarieties_gingelly.html"],
 "sunflower": [T+"oilseeds_sunflower.html", T+"agri_seasonandvarieties_sunflower.html", "https://www.icar-iior.org.in/"],
 "potato": [H+"horti_vegetables_potato.html", "https://cpri.icar.gov.in/"],
 "onion": [H+"horti_vegetables_bellaryonion.html", H+"horti_vegetables_small%20onion.html", "https://dogr.icar.gov.in/"],
 "tomato": [H+"horti_vegetables_tomato_index.html", "https://iivr.icar.gov.in/"],
 "brinjal": [H+"horti_vegetables_brinjal_index.html"],
 "okra": [H+"horti_vegetables_bhendi_index.html"],
 "chilli": [H+"horti_vegetables_chilli_Yield_new.html", "https://www.indianspices.com/sites/default/files/cultivation_practices-Chillli-1.pdf"],
 "ginger": ["https://spices.res.in/products/spices/ginger.html", "https://spices.res.in/storage/app/public/pdfs/GINGER/3ENG.pdf", "https://www.indianspices.com/sites/default/files/cultivation_practices-ginger.pdf"],
 "turmeric": ["https://spices.res.in/products/spices/turmeric.html", "https://www.indianspices.com/sites/default/files/cultivation_practices-TURMERIC-1.pdf"],
 "cotton": [T+"agri_seasonandvarieties_cotton.html", T+"agri_cropproduction_fibre_irrigatedcotton.html", "https://cicr.org.in/"],
}
def status(url):
    ts = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    try:
        r = requests.get(url, timeout=40, stream=True, headers={"User-Agent": "HarvestOutlook-data-audit/0.1"})
        out = {"url": url, "checkedAt": ts, "status": r.status_code, "finalUrl": r.url, "contentType": r.headers.get("content-type"), "via": "requests"}
        r.close(); return out
    except requests.exceptions.SSLError as e:
        # incomplete server chain: fall back to system curl WITH verification (no -k)
        p = subprocess.run(["curl", "-s", "-o", "/dev/null", "-L", "--max-time", "40", "-w", "%{http_code}\t%{content_type}\t%{url_effective}", url], capture_output=True, text=True)
        code, ct, fu = (p.stdout.split("\t") + ["", "", ""])[:3]
        return {"url": url, "checkedAt": ts, "status": int(code) if code.isdigit() and code != "000" else None, "finalUrl": fu, "contentType": ct, "via": "curl-after-python-SSLError", "pythonError": str(e)[:160]}
    except Exception as e:
        return {"url": url, "checkedAt": ts, "status": None, "error": f"{type(e).__name__}: {str(e)[:160]}"}
SOFT200 = "vikaspedia.in"  # JS shell: nonexistent paths also return HTTP 200 (tested 2026-10-29), so 200 does not prove content
res = {c: [status(u) for u in us] for c, us in CANDIDATES.items()}
for rs in res.values():
    for r in rs:
        r["soft200"] = SOFT200 in r["url"]
(ROOT / "data/raw/crop_url_checks.json").write_text(json.dumps(res, indent=1))
for c, rs in res.items():
    print(f"{c:14s}", " | ".join(f"{r['status']}{'*' if r.get('via','').startswith('curl') else ''} {r['url'].split('//')[1][:70]}" for r in rs))
