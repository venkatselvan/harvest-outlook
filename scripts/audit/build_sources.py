"""Build data/manifests/sources.json from curated audit records + data/raw/fetch_log.jsonl (retrievedAt/sha256 taken from the log,
never typed by hand). Re-run after re-fetching. Records without a log entry keep retrievedAt/sha256 = null."""
import json, pathlib
ROOT = pathlib.Path(__file__).resolve().parents[2]
log = {}
for line in (ROOT / "data/raw/fetch_log.jsonl").read_text().splitlines():
    r = json.loads(line); log[r["id"]] = r          # last attempt wins
probe = json.loads((ROOT / "data/raw/pdf_probe.json").read_text())
GODL = "unstated on retrieved artifacts; portal states GODL-India but licence page returned HTTP 403 to automated fetch (not verified verbatim)"
def cov(tf=None, tt=None, geo=None, prod=None): return {"timeFrom": tf, "timeTo": tt, "geography": geo, "products": prod or []}
R = [
 dict(id="MKT02-dgi-mandi-current", logId="dgi-api-probe-nokey", url="https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070",
  publisher="Open Government Data Platform India / Directorate of Marketing and Inspection (AGMARKNET)", title="Current Daily Price of Various Commodities from Various Markets (Mandi)",
  accessRoute="api_key_required_free", licence=GODL, rowOrPageCount=None, coverage=cov(None, None, "All India (catalog metadata)", ["all AGMARKNET commodities (unverified)"]),
  availabilityPolicy="Daily; title says 'Current' - history depth NOT verified. Resource UUID taken from portal backend metadata for catalog nid 86944 (data/raw/datagovin/catalog_86944_resources.json).",
  validation="retrieval_failed", notes="Keyless request returns HTTP 400 {\"error\": \"Authorization field missing\"}. Catalog metadata embeds a portal-published sample key in datafile_url; use of that key was denied by the session permission policy and was not attempted. Registration for a personal free key was not performed (out of scope). Field names, units (INR/quintal is typical but unverified here) and ginger rows NOT observed."),
 dict(id="MKT02-dgi-mandi-variety", logId="dgi-catalog-resources", url="https://api.data.gov.in/resource/35985678-0d79-46b4-9ed6-6f13308a1d24",
  publisher="Open Government Data Platform India / DMI", title="Variety-wise Daily Market Prices Data of Commodity",
  accessRoute="api_key_required_free", licence=GODL, rowOrPageCount=None, coverage=cov("2024-05-21", None, "All India (catalog metadata)", ["variety-wise commodity prices (unverified)"]),
  availabilityPolicy="Catalog metadata: created 2024-05-21, data_time_period_from=to=2024-05-21, changed 2026-10-28. Whether the API holds accumulated history since 2024-05-21 is NOT verified.",
  validation="not_attempted", notes="Same key gate as 9ef84268. Most promising candidate for >1 season of history; must be measured once a key is available. sha256/retrievedAt refer to the metadata listing, not to price rows."),
 dict(id="MKT02-dgi-catalog-86944", logId="dgi-catalog-resources", url="https://www.data.gov.in/backend/dmspublic/v1/resources?filters[catalog_reference]=86944&offset=0&limit=10",
  publisher="Open Government Data Platform India", title="Resource listing for catalog 'Current daily price of various commodities from various markets (Mandi)' (nid 86944, uuid 6141ea17-a69d-4713-b600-0a43c8fd9a6c)",
  accessRoute="open_download", licence=GODL, rowOrPageCount=2, coverage=cov(None, None, "All India", []),
  availabilityPolicy="Unauthenticated JSON endpoint used by the public catalog page itself.", validation="retrieved_ok",
  notes="2 resources listed. Response contains datafile_url strings embedding the portal's published sample API key; stored only in gitignored data/raw."),
 dict(id="MKT02-dgi-xml-datafile", logId="dgi-xml-datafile", url="https://www.data.gov.in/files/ogdpv2dms/s3fs-public/Date-Wise-Prices-all-Commodity.xml",
  publisher="Open Government Data Platform India", title="Date-Wise-Prices-all-Commodity.xml (legacy datafile of 9ef84268)", accessRoute="interactive_only", licence=GODL,
  rowOrPageCount=None, coverage=cov(None, None, None, []), availabilityPolicy="unknown", validation="retrieval_failed",
  notes="Scripted GET -> HTTP 403; HEAD -> 405. Static data.gov.in datafiles (also tested: TN ginger production CSV) return 403 to scripted requests; likely require interactive download. Not bypassed."),
 dict(id="AGR-dgi-tn-ginger-district", logId="dgi-tn-ginger-prod-csv", url="https://data.gov.in/files/ogd20/ogdpv2dms/s3fs-public/datafile/production_of_ginger_in_2018_19.csv",
  publisher="Open Government Data Platform India / Govt of Tamil Nadu", title="Production of Ginger by Districts in Tamil Nadu 2018-19 (one of 15 TN ginger APY resources 2011-12..2018-19)",
  accessRoute="interactive_only", licence=GODL, rowOrPageCount=None, coverage=cov("2011-04-01", "2019-03-31", "Tamil Nadu districts", ["ginger"]),
  availabilityPolicy="Static yearly files per catalog search (data/raw/datagovin/search_ginger.json)", validation="retrieval_failed", notes="HTTP 403 to scripted GET. Tamil Nadu is a minor ginger state; low priority."),
 dict(id="MKT01-agmarknet2", logId="agm-home", url="https://agmarknet.gov.in/",
  publisher="Directorate of Marketing and Inspection, MoA&FW", title="Agmarknet 2.0 (React single-page app; legacy SearchCmmMkt.aspx now serves the same shell)",
  accessRoute="interactive_only", licence="unstated", rowOrPageCount=None, coverage=cov(None, None, "All India", []),
  availabilityPolicy="Report queries go to https://api.agmarknet.gov.in/v1/ ; the shipped JS attaches captcha/captcha_key to report requests (/captcha/generator, /captcha/verify; '/prices-and-a...' report calls).",
  validation="not_attempted", notes="CAPTCHA-gated interactive reports. Internal API not called; no CAPTCHA bypass. Manual human export by the user may be possible but its terms were not verified."),
 dict(id="MKT01-ceda-ashoka", logId="agm-ceda", url="https://agmarknet.ceda.ashoka.edu.in/",
  publisher="Centre for Economic Data and Analysis, Ashoka University (third party; source DMI)", title="CEDA Agmarknet portal",
  accessRoute="not_checked", licence="unstated", rowOrPageCount=None, coverage=cov(None, None, "All India; district aggregates shown", []),
  availabilityPolicy="Page shows 'Download Data' buttons; login/terms not stated on the page.", validation="not_attempted",
  notes="HTTP 200 to page request only. Third-party aggregation (district/monthly); not market-level primary data. Terms must be checked before any use."),
 dict(id="MKT01-acrop-thirdparty", logId=None, url="https://acrop.app/prices/ginger/karnataka",
  publisher="acrop.app (third party, states source data.gov.in/AGMARKNET)", title="Ginger prices Karnataka (web search snippets only)",
  accessRoute="not_checked", licence="unstated", rowOrPageCount=None, coverage=cov("2026-05", "2026-08", "Karnataka APMCs", ["Ginger (product not stated)"]),
  availabilityPolicy="n/a", validation="not_attempted",
  notes="Only used as weak evidence that Karnataka APMCs (Hassan, Belur, Holenarasipura, Mysore-Bandipalya, Bangalore, Ramanagara, Doddaballapur, Somvarpet, Chikkamagaluru) have reported ginger in 2026; levels inconsistent (INR 2,000 vs 10,000/quintal within one district) -> product/grade identity problem. Not a data source for the product."),
 dict(id="AGR01-des-apy-report", logId="des-apy-report", url="https://data.desagri.gov.in/website/crops-apy-report-web",
  publisher="Directorate of Economics and Statistics, MoA&FW", title="Crops APY report", accessRoute="interactive_only", licence="unstated",
  rowOrPageCount=None, coverage=cov(None, None, "State/district (form options)", []), availabilityPolicy="unknown", validation="retrieved_ok",
  notes="HTML form page retrieved (curl; Python requests fails: server sends incomplete certificate chain). Data via jQuery POST with session CSRF _token returning an HTML table; 'Excel' is client-side conversion. No documented export/API; no CAPTCHA seen. No APY rows retrieved."),
 dict(id="AGR01-des-apy-query", logId="des-apy-query", url="https://data.desagri.gov.in/website/apy-query-report-web",
  publisher="Directorate of Economics and Statistics, MoA&FW", title="APY query report", accessRoute="interactive_only", licence="unstated",
  rowOrPageCount=None, coverage=cov(None, None, "State/district/crop/season/year form", []), availabilityPolicy="unknown", validation="retrieved_ok",
  notes="As above: form fields fltrstates[], fltrdistricts, crop, season, year range, report format scrview|exl; session token required. Manual export by a user is the lawful route; not automated."),
 dict(id="AGR02-upag-calendar", logId="upag-calendar", url="https://upag.gov.in/national-calendar", publisher="UPAg, MoA&FW", title="UPAg national crop calendar",
  accessRoute="interactive_only", licence="unstated", rowOrPageCount=None, coverage=cov(None, None, None, []), availabilityPolicy="unknown", validation="retrieved_ok",
  notes="7 KB JS-only shell ('You need to enable JavaScript'); no calendar data in HTML. Content not inspected."),
 dict(id="AGR02-upag-api", logId="upag-openapi", url="https://data.upag.gov.in/api/v1/openapi.json", publisher="UPAg, MoA&FW", title="UPAg API Data Share OpenAPI 1.0.0",
  accessRoute="blocked", licence="unstated", rowOrPageCount=9, coverage=cov(None, None, None, ["APY statewise/districtwise", "crop production", "crop master"]),
  availabilityPolicy="All data endpoints require OAuth2PasswordBearer (tokenUrl v1/upag/api-data-share/login). Credential issuance process unknown.", validation="retrieved_ok",
  notes="Spec retrieved (9 operations). No crop-calendar endpoint in the spec. Treated as blocked: credentials not available and not requested."),
 dict(id="AGR03-crida-index", logId="crida-index", url="https://www.icar-crida.res.in/Crop_Contingency_Plan.html", publisher="ICAR-CRIDA", title="District agriculture contingency plans index",
  accessRoute="open_download", licence="unstated", rowOrPageCount=648, coverage=cov("2011", None, "India districts (2011-2016 plan dates seen)", []),
  availabilityPolicy="Static PDF links", validation="retrieved_ok", notes="648 PDF links on index. Karnataka: 29 links incl. Hassan, Shimoga, Kodagu, Mysore, Chikmagalur. Kerala plans dated 30-06-2011."),
 dict(id="AGR03-crida-hassan", logId="crida-hassan", url="https://www.icar-crida.res.in/CP-2012/statewiseplans/Karnataka%20(Pdf)/GKVK,%20Bangalore/KA28-Hassan%20%2004.10.2011.pdf",
  publisher="ICAR-CRIDA / UAS GKVK Bangalore", title="Agriculture contingency plan: Hassan (KA28), 04.10.2011", accessRoute="open_download", licence="unstated",
  rowOrPageCount=42, coverage=cov("2011-10-04", "2011-10-04", "Hassan district, Karnataka", ["ginger listed under spices"]),
  availabilityPolicy="Static PDF; plan date 2011 - currency must be reviewed", validation="retrieved_ok",
  notes="pypdf: 40/42 pages with text. Ginger appears in the horticulture spices table ('Ginger 13.8' under 'Total Area'; table header reads Area (`000 ha) -> 13.8 thousand ha; plausibility vs state totals is questionable (column alignment from pdftotext -layout); verify manually before use)."),
 dict(id="AGR04-iisr-ginger-page", logId="iisr-ginger-page", url="https://spices.res.in/products/spices/ginger.html", publisher="ICAR-IISR Kozhikode", title="Ginger resources page",
  accessRoute="open_download", licence="unstated", rowOrPageCount=None, coverage=cov(None, None, "India", ["ginger"]), availabilityPolicy="static", validation="retrieved_ok", notes=""),
 dict(id="AGR04-iisr-ginger-guide", logId="iisr-ginger-guide", url="https://spices.res.in/storage/app/public/pdfs/GINGER/3ENG.pdf", publisher="ICAR-IISR Kozhikode",
  title="Ginger (extension pamphlet, February 2025; Thankamani et al.)", accessRoute="open_download", licence="unstated", rowOrPageCount=32,
  coverage=cov("2025-02", "2025-02", "India (general; IISR Kerala perspective)", ["fresh ginger", "dry ginger"]), availabilityPolicy="static", validation="retrieved_ok",
  notes="pypdf: 28/32 pages with text, 42,193 chars; pdftotext also works. States 2022-23 national production 22.01 lakh t from 190,000 ha; MP, Karnataka, Orissa, Assam, Meghalaya, Arunachal, Gujarat = 65%. Do not redistribute (licence unstated)."),
 dict(id="AGR-spicesboard-statewise", logId="spicesboard-statewise-2024-25", url="https://www.indianspices.com/sites/default/files/Major%20spice%20state%20wise%20area%20production%202024-25%20web.pdf",
  publisher="Spices Board India", title="Major spice / state-wise area and production of spices 2021-22..2025-26*", accessRoute="open_download", licence="unstated", rowOrPageCount=4,
  coverage=cov("2021-22", "2025-26 (provisional *)", "Major states", ["ginger (form not stated in extracted text)", "chilli", "turmeric", "pepper", "cardamom"]),
  availabilityPolicy="Annual; 2024-25 marked 'f', 2025-26 '*'", validation="retrieved_ok",
  notes="Area ha, production tonnes. Ginger block (row-order inferred, needs manual check): 2024-25f MP 38,023 ha / 624,138 t; Karnataka 33,756 ha / 379,151 t; Odisha 20,925 ha / 269,513 t. Production basis (fresh vs dry) not stated in extracted text."),
 dict(id="WEA-openmeteo-archive", logId="om-archive-hassan", url="https://archive-api.open-meteo.com/v1/archive", publisher="Open-Meteo", title="Historical Weather API (ERA5/ERA5-Land/IFS)",
  accessRoute="open_download", licence="CC BY 4.0 ('The data obtained through the API is provided under the terms of the CC-BY 4.0 licence'); free tier non-commercial only",
  rowOrPageCount=30, coverage=cov("1940-01-01", "present minus ~5 days (ERA5)", "Global; sample Hassan 12.97N 76.09E, elev 954 m", ["precipitation_sum", "temperature_2m_max/min", "et0_fao_evapotranspiration"]),
  availabilityPolicy="ERA5 daily update with 5-day delay; reanalysis is not a forecast available at the time", validation="retrieved_ok",
  notes="Sample 2026-09-01..30 daily, 30/30 non-null, rain 74.0 mm. Free tier: <10,000 calls/day, 5,000/h, 600/min; commercial use requires subscription."),
 dict(id="WEA-openmeteo-forecast", logId="om-forecast-hassan", url="https://api.open-meteo.com/v1/forecast", publisher="Open-Meteo", title="Forecast API",
  accessRoute="open_download", licence="CC BY 4.0; free tier non-commercial", rowOrPageCount=16, coverage=cov("2026-10-30", "2026-11-14", "Hassan sample", ["precipitation_sum", "temperature_2m_max/min"]),
  availabilityPolicy="Live; forecast_days=16 accepted", validation="retrieved_ok", notes="16 days returned, day 16 null (15/16 non-null)."),
 dict(id="WEA-openmeteo-historical-forecast", logId="om-histfc-hassan", url="https://historical-forecast-api.open-meteo.com/v1/forecast", publisher="Open-Meteo", title="Historical Forecast API",
  accessRoute="open_download", licence="CC BY 4.0; free tier non-commercial", rowOrPageCount=30, coverage=cov("~2022 (model dependent, some 2021)", None, "Hassan sample 2024-05", ["precipitation_sum"]),
  availabilityPolicy="Stitched series of each run's first hours - NOT an archive of what was forecast weeks ahead; unsuitable as a planting-time multi-week forecast", validation="retrieved_ok", notes="Sample 2024-05-01..30, rain 239.4 mm."),
 dict(id="WEA-openmeteo-previous-runs", logId="om-prevruns-hassan", url="https://previous-runs-api.open-meteo.com/v1/forecast", publisher="Open-Meteo", title="Previous Runs API",
  accessRoute="open_download", licence="CC BY 4.0; free tier non-commercial", rowOrPageCount=72, coverage=cov("2024-01 (GFS from 2021-03, JMA from 2018)", None, "Hassan sample 2024-06-01..03 hourly", ["precipitation", "precipitation_previous_day1", "precipitation_previous_day5"]),
  availabilityPolicy="Fixed lead times 1..7 days only", validation="retrieved_ok", notes="Leakage-free forecasts at <=7 day lead can be reconstructed from 2024; nothing for seasonal (harvest-horizon) lead."),
 dict(id="WEA01-imd-agromet", logId="imd-agromet", url="https://mausam.imd.gov.in/responsive/agromet_adv_ser_national_past_en.php", publisher="India Meteorological Department",
  title="Agromet advisory national (past)", accessRoute="open_download", licence="unstated", rowOrPageCount=31, coverage=cov(None, None, "National bulletins (PDF links)", []),
  availabilityPolicy="Bulletins; 31 PDF references on page", validation="retrieved_ok", notes="Advisory bulletins (PDF), not a gridded/station series API. No machine-readable district forecast endpoint identified."),
 dict(id="WEA01-imd-gkms-sop", logId="imd-gkms-sop", url="https://mausam.imd.gov.in/imd_latest/contents/pdf/gkms_sop.pdf", publisher="India Meteorological Department", title="GKMS standard operating procedure",
  accessRoute="open_download", licence="unstated", rowOrPageCount=26, coverage=cov("2021-08-31", None, "India", []), availabilityPolicy="static", validation="retrieved_ok",
  notes="District/block quantitative forecast up to 5 days; advisories issued Tuesday and Friday; ERFS extended range exists."),
]
for r in R:
    lid = r.pop("logId"); L = log.get(lid) if lid else None
    r["retrievedAt"] = L.get("retrievedAt") if L and L.get("status") else None
    r["sha256"] = L.get("sha256") if L and L.get("status") == 200 and L.get("bytes") else None
    r["httpStatus"] = L.get("status") if L else None
    r["rawArtifact"] = L.get("savedAs") if L else None
    if L and L.get("savedAs","").endswith(".pdf") and L["savedAs"] in probe: assert probe[L["savedAs"]]["sha256"] == r["sha256"]
ORDER = ["id","url","publisher","title","accessRoute","licence","retrievedAt","sha256","rowOrPageCount","coverage","availabilityPolicy","validation","notes","httpStatus","rawArtifact"]
out = {"schemaVersion": 1, "auditTask": "T01", "generatedBy": "scripts/audit/build_sources.py", "records": [{k: r.get(k) for k in ORDER} for r in R]}
crop = json.loads((ROOT / "data/raw/crop_url_checks.json").read_text())
for c, rs in crop.items():
    for i, x in enumerate(rs):
        ok = x["status"] == 200 and not x.get("soft200")
        out["records"].append({"id": f"AGRO-{c}-{i+1}", "url": x["url"], "publisher": x["url"].split("/")[2], "title": f"Candidate agronomy source for {c} (status check only)",
          "accessRoute": "open_download" if ok else "not_checked", "licence": "unstated", "retrievedAt": x["checkedAt"], "sha256": None,
          "rowOrPageCount": None, "coverage": cov(None, None, "unverified", [c]), "availabilityPolicy": "unknown",
          "validation": "retrieved_ok" if ok else "retrieval_failed", "httpStatus": x["status"], "rawArtifact": None,
          "notes": ("HTTP 200 status only; content/scope not reviewed" if ok else ("soft-200 JS shell (nonexistent paths also 200); content unverified" if x["status"] == 200 else f"unreachable: {x.get('error') or x['status']}"))})
(ROOT / "data/manifests/sources.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
print(len(out["records"]), "records")
