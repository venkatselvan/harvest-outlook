import { captureAiPreview } from "./support/ai-preview";
import { expect, test, type Page, type Route } from "@playwright/test";
import type {
  SoilReport,
  SoilReportExtraction,
  FarmSoilMarkers,
  SoilMarkerDraft,
} from "@harvest/contracts";
const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222",
  R = "33333333-3333-4333-8333-333333333333";
const env = (data: unknown) => ({
  requestId: "test",
  mode: "live",
  asOf: "2026-10-30T00:00:00Z",
  data,
  warnings: [],
  error: null,
});
const marker = (patch: Partial<SoilMarkerDraft> = {}): SoilMarkerDraft => ({
  id: "ec",
  parameter: "electrical_conductivity",
  rawLabel: "EC",
  rawValue: "1.2",
  rawUnit: "mS/cm",
  numericValue: 1.2,
  qualifier: "exact",
  range: null,
  analyteForm: "Water extract EC",
  method: "Conductivity meter",
  extractant: "Water",
  soilWaterRatio: "1:5",
  temperatureC: null,
  matrix: "soil",
  massBasis: null,
  reportedRating: null,
  evidence: {
    page: 1,
    quote: "EC 1.2 mS/cm, water extract 1:5",
    nativeTextCheck: "matched",
  },
  extractionConfidence: "medium",
  warnings: ["Temperature correction not reported."],
  ...patch,
});
const draft: SoilReportExtraction = {
  title: "Laboratory soil report",
  laboratory: "Source laboratory",
  reportDate: "2026-10-10",
  samples: [
    {
      id: "S1",
      sampleLabel: "S1",
      laboratory: "Source laboratory",
      collectionDate: "2026-10-01",
      reportDate: "2026-10-10",
      depth: null,
      markers: [
        marker(),
        marker({
          id: "digested",
          parameter: "unknown_other",
          rawLabel: "Iron (digested soil)",
          rawValue: "9.12",
          numericValue: 9.12,
          rawUnit: "mg/kg",
          analyteForm: "Digested iron",
          method: "Acid digestion",
          extractant: null,
          soilWaterRatio: null,
          warnings: [],
        }),
      ],
    },
  ],
  warnings: ["Repeated readings differ; verify the source page."],
};
function report(
  reference = false,
  status: SoilReport["status"] = "needs_review",
): SoilReport {
  return {
    id: R,
    farmId: A,
    kind: reference ? "reference_sample" : "field_report",
    status,
    version: 1,
    filename: reference ? "ANACON-public-sample.pdf" : "my-soil-report.pdf",
    contentType: "application/pdf",
    bytes: 100,
    sha256: "abc",
    createdAt: "2026-10-30T00:00:00Z",
    jobId: null,
    modelInvocation: null,
    originalUrl: `/api/v1/soil-reports/${R}/original`,
    referenceSource: reference
      ? {
          title: "Historical ANACON public filing · 2017",
          url: "https://example.gov/anacon.pdf",
          pages: [85, 86],
          limitations: [
            "Not a government-issued agricultural Soil Health Card.",
            "Historical report; not measurements of this farm.",
          ],
        }
      : null,
    pages: [
      {
        page: 1,
        imageUrl: `/api/v1/soil-reports/${R}/pages/1`,
        width: 800,
        height: 1000,
        nativeTextAvailable: true,
      },
    ],
    extraction: status === "needs_review" ? structuredClone(draft) : null,
    reviewed: null,
    confirmedSampleIds: [],
    warnings: [
      "Repeated readings differ; verify the source page.",
      "Check sample identifiers against the original report.",
    ],
  };
}
async function fixture(
  page: Page,
  options: {
    holdPatch?: boolean;
    referenceCooldown?: boolean;
    sourceNavigation?: boolean;
    reportCriteria?: boolean;
  } = {},
) {
  let current: SoilReport | undefined;
  if (options.sourceNavigation) {
    current = report(true);
    current.pages = [1, 2, 3, 4].map((page) => ({
      page,
      imageUrl: `/api/v1/soil-reports/${R}/pages/${page}`,
      width: 800,
      height: 1000,
      nativeTextAvailable: true,
    }));
    current.extraction!.samples[0]!.markers[0]!.evidence.page = 3;
  }
  let pending: Route | undefined;
  let pendingDetail: Route | undefined;
  let detailGets = 0;
  let posts = 0;
  const patches: any[] = [];
  const confirms: any[] = [];
  let summary: FarmSoilMarkers = { farmId: A, samples: [], limitations: [] };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    if (/\/pages\/[1-4]$/.test(path))
      return route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN6kAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    if (path.endsWith("/soil-reports/sample")) {
      posts++;
      current = report(
        true,
        options.referenceCooldown ? "pending" : "needs_review",
      );
      return route.fulfill({ json: env(current) });
    }
    if (path.endsWith("/soil-reports") && method === "POST") {
      posts++;
      current = report();
      if (options.reportCriteria) {
        current.extraction!.receivedDate = "2026-10-05";
        const sample = current.extraction!.samples[0]!;
        sample.collectionDate = null;
        sample.receivedDate = "2026-10-05";
        sample.markers[0]!.reportedReference = {
          label: "Desirable limits",
          rawText: "0.1–0.9",
          rawUnit: "mS/cm",
          qualifier: "range",
          numericValue: null,
          range: {
            low: 0.1,
            high: 0.9,
            lowInclusive: null,
            highInclusive: null,
          },
          evidence: {
            page: 1,
            quote: "Desirable limits 0.1–0.9 mS/cm",
            nativeTextCheck: "image_review_required",
          },
        };
      }
      return route.fulfill({ json: env(current) });
    }
    if (path.endsWith("/soil-reports"))
      return route.fulfill({
        json: env({ reports: current && path.includes(A) ? [current] : [] }),
      });
    if (path.endsWith("/soil-markers"))
      return route.fulfill({
        json: env(
          path.includes(A)
            ? summary
            : { farmId: B, samples: [], limitations: [] },
        ),
      });
    if (path.endsWith(`/soil-reports/${R}`) && method === "PATCH") {
      patches.push(route.request().postDataJSON());
      if (options.holdPatch) {
        pending = route;
        return;
      }
      current = {
        ...current!,
        version: 2,
        reviewed: route.request().postDataJSON().draft,
      };
      return route.fulfill({ json: env(current) });
    }
    if (path.endsWith(`/soil-reports/${R}/confirm`)) {
      const body = route.request().postDataJSON();
      confirms.push(body);
      current = {
        ...current!,
        version: 3,
        status: "confirmed",
        confirmedSampleIds: body.sampleIds,
      };
      const sample = current.reviewed!.samples[0]!;
      summary = {
        farmId: A,
        samples: [
          {
            ...sample,
            id: "44444444-4444-4444-8444-444444444444",
            reportId: R,
            sourceSampleId: sample.id,
            confirmedAt: "2026-10-30T00:00:00Z",
            markers: sample.markers
              .filter((m) => body.markerIds.includes(m.id))
              .map((m) => ({
                ...m,
                canonical: {
                  value: null,
                  unit: null,
                  conversion: null,
                  missingReason: "Censored result preserved",
                },
                reviewStatus: "confirmed",
                confirmedAt: "2026-10-30T00:00:00Z",
              })),
          },
        ],
        limitations: [],
      };
      return route.fulfill({ json: env(current) });
    }
    if (path.endsWith(`/soil-reports/${R}`)) {
      detailGets++;
      if (options.sourceNavigation && detailGets === 1) {
        pendingDetail = route;
        return;
      }
      if (options.referenceCooldown && detailGets === 1)
        return route.fulfill({
          status: 429,
          headers: { "retry-after": "30" },
          json: {
            ...env(null),
            error: {
              code: "rate_limited",
              message: "Rate limit exceeded, retry in 30 seconds",
            },
          },
        });
      if (options.referenceCooldown) {
        current = { ...report(true), version: 2 };
      }
      return route.fulfill({ json: env(current) });
    }
    const data =
      path === "/api/v1/session"
        ? { authenticated: true, csrfToken: "test" }
        : path === "/api/v1/farms"
          ? {
              farms: [A, B].map((id) => ({
                id,
                name: id === A ? "Farm Alpha" : "Farm Beta",
                location: {
                  stateCode: "IN-KA",
                  districtId: "IN-KA-hassan",
                  districtName: "Hassan",
                  precision: "district",
                },
                facts: {},
                areaHectares: 1,
              })),
            }
          : path.endsWith("/workspace")
            ? {
                farmId: path.includes(A) ? A : B,
                version: 1,
                updatedAt: null,
                boundary: null,
                previousHarvest: { status: "unknown" },
                cycles: [],
                rotationPlans: [],
              }
            : path === "/api/v1/crops"
              ? { crops: [] }
              : path === "/api/v1/ai/activity"
                ? { invocations: [] }
                : {};
    return route.fulfill({ json: env(data) });
  });
  return {
    patches,
    confirms,
    get posts() {
      return posts;
    },
    get detailGets() {
      return detailGets;
    },
    get pending() {
      return pending;
    },
    get pendingDetail() {
      return pendingDetail;
    },
    async finishDetail() {
      current = { ...current!, version: 2 };
      await pendingDetail!.fulfill({ json: env(current) });
    },
    async releasePatch() {
      current = { ...current!, version: 2, reviewed: patches[0].draft };
      await pending!.fulfill({ json: env(current) });
    },
  };
}
test("field values require explicit selection; corrected censored result and source method survive confirmation", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("/farm/settings");
  await page.getByLabel("Upload soil report").setInputFiles({
    name: "my-soil-report.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF test fixture"),
  });
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Laboratory soil report" }),
  ).toBeVisible();
  await captureAiPreview(page, "soil_extraction", dialog);
  expect(api.confirms).toHaveLength(0);
  const notes = dialog.locator(".soil-report-warning-details");
  await expect(notes.locator("summary")).toHaveText(
    "Extraction notes & review flags (2)",
  );
  await expect(
    notes.getByText("Repeated readings differ; verify the source page."),
  ).not.toBeVisible();
  await expect(
    dialog.getByText("Extracted values still need human review."),
  ).toBeVisible();
  await expect(
    dialog.getByText("Temperature correction not reported.", { exact: true }),
  ).toBeVisible();
  await notes.locator("summary").click();
  await expect(
    notes.getByText("Repeated readings differ; verify the source page."),
  ).toBeVisible();
  await notes.locator("summary").click();
  await dialog
    .getByLabel("Printed result", { exact: true })
    .first()
    .fill("<0.5");
  await dialog.getByLabel("Confirm EC for S1", { exact: true }).check();
  await dialog
    .getByRole("button", { name: "Confirm selected results" })
    .click();
  await expect.poll(() => api.confirms.length).toBe(1);
  expect(api.patches[0].draft.samples[0].markers[0]).toMatchObject({
    rawValue: "<0.5",
    numericValue: 0.5,
    qualifier: "less_than",
    rawUnit: "mS/cm",
    soilWaterRatio: "1:5",
  });
  expect(api.confirms[0]).toEqual({
    expectedVersion: 2,
    sampleIds: ["S1"],
    markerIds: ["ec"],
  });
  await dialog.getByRole("button", { name: "Close soil report" }).click();
  const cards = page.getByRole("region", { name: "Confirmed soil markers" });
  await expect(cards.getByText("<0.5", { exact: true })).toBeVisible();
  await expect(cards.getByText("mS/cm", { exact: true })).toBeVisible();
  await cards.locator('.soil-missing-markers > summary').filter({hasText:'Not reported'}).click();
  await expect(cards.getByText('Available iron · No confirmed measurement', {exact:true})).toBeVisible();
  expect(api.posts).toBe(1);
});
test("public reference retains queued preview on429, honours cooldown, and never promotes values to farm markers", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-30T09:00:00Z") });
  const api = await fixture(page, { referenceCooldown: true });
  await page.goto("/farm/settings");
  await page.getByRole("button", { name: "Load sample report" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "ANACON-public-sample.pdf" }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Original pages", exact: true })
    .click();
  await expect(
    dialog.getByRole("img", { name: "Page 1 of ANACON-public-sample.pdf" }),
  ).toBeVisible();
  await expect(dialog.getByText(/Rate limit exceeded/)).toBeVisible();
  await page.clock.fastForward(20000);
  expect(api.detailGets).toBe(1);
  await page.clock.fastForward(11000);
  await expect(
    dialog.getByRole("heading", { name: "Laboratory soil report" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Confirm selected results" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close soil report" }).click();
  await expect(page.getByRole("region", {name:"Sample marker overview"})).toHaveCount(0);
  await expect(page.getByRole("region", {name:"Sample reports"})).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Confirmed soil markers" })
      .getByText("No confirmed measurements", { exact: true }),
  ).toBeVisible();
  expect(api.confirms).toHaveLength(0);
  expect(api.posts).toBe(1);
});
test("switching farms after a draft PATCH prevents an old report confirmation from reaching the new farm", async ({
  page,
}) => {
  const api = await fixture(page, { holdPatch: true });
  await page.goto("/farm/settings");
  await page.getByLabel("Upload soil report").setInputFiles({
    name: "my-soil-report.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF test"),
  });
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Printed result", { exact: true })
    .first()
    .fill("1.3");
  await dialog.getByLabel("Confirm EC for S1", { exact: true }).check();
  await dialog
    .getByRole("button", { name: "Confirm selected results" })
    .click();
  await expect.poll(() => !!api.pending).toBe(true);
  await dialog.getByRole("button", { name: "Close soil report" }).click();
  await page.getByLabel("Selected farm").selectOption(B);
  await api.releasePatch();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(api.confirms).toHaveLength(0);
  await expect(
    page
      .getByRole("region", { name: "Confirmed soil markers" })
      .getByText("No confirmed measurements", { exact: true }),
  ).toBeVisible();
});

test("sample report review preserves source page choices through a delayed refresh", async ({page}) => {
  const api = await fixture(page, {sourceNavigation:true});
  await page.goto("/farm/settings");
  await expect(page.getByRole("region", {name:"Sample marker overview"})).toHaveCount(0);
  await page.getByRole("region", {name:"Sample reports"}).locator('.soil-report-row').click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", {name:"Original pages",exact:true}).click();
  await dialog.getByLabel("Report preview page").selectOption("3");
  await expect(dialog.getByRole("img", {name:"Page 3 of ANACON-public-sample.pdf"})).toBeVisible();
  await expect.poll(() => !!api.pendingDetail).toBe(true);
  await dialog.getByLabel("Report preview page").selectOption("4");
  await api.finishDetail();
  await expect(dialog.getByText(/version 2/)).toBeVisible();
  await expect(dialog.getByLabel("Report preview page")).toHaveValue("4");
  await expect(dialog.getByRole("img", {name:"Page 4 of ANACON-public-sample.pdf"})).toBeVisible();
  expect(api.posts).toBe(0);
});

test("report-local desirable criteria and received dates survive explicit review without becoming crop targets", async ({
  page,
}) => {
  const api = await fixture(page, { reportCriteria: true });
  await page.goto("/farm/settings");
  await page
    .getByLabel("Upload soil report")
    .setInputFiles({
      name: "criteria-fixture.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF fixture"),
    });
  const dialog = page.getByRole("dialog");
  const reference = dialog.getByRole("region", {
    name: "This report’s printed reference",
  });
  await expect(reference).toContainText("0.1–0.9");
  await expect(reference).toContainText("not a crop target");
  await expect(
    dialog.getByLabel("Collection date", { exact: true }),
  ).toHaveValue("");
  await expect(
    dialog.getByLabel("Sample received date", { exact: true }),
  ).toHaveValue("2026-10-05");
  await reference.locator("summary").click();
  await reference
    .getByLabel("Printed reference criteria", { exact: true })
    .fill("0.2–0.8");
  await dialog.getByLabel("Confirm EC for S1", { exact: true }).check();
  await dialog
    .getByRole("button", { name: "Confirm selected results" })
    .click();
  await expect.poll(() => api.confirms.length).toBe(1);
  const saved = api.patches[0].draft.samples[0];
  expect(saved).toMatchObject({
    collectionDate: null,
    receivedDate: "2026-10-05",
    reportDate: "2026-10-10",
  });
  expect(saved.markers[0]).toMatchObject({
    rawValue: "1.2",
    numericValue: 1.2,
    qualifier: "exact",
    range: null,
    reportedRating: null,
    reportedReference: {
      rawText: "0.2–0.8",
      rawUnit: "mS/cm",
      qualifier: "range",
      numericValue: null,
      range: { low: 0.2, high: 0.8, lowInclusive: null, highInclusive: null },
    },
  });
  await dialog.getByRole("button", { name: "Close soil report" }).click();
  const cards = page.getByRole("region", { name: "Confirmed soil markers" });
  await cards.locator('.soil-marker-details > summary').first().click();
  await expect(cards).toContainText("Received 5 Oct 2026");
  await expect(cards).toContainText("Collection date unreported");
  await expect(
    cards.getByRole("region", { name: "This report’s printed reference" }),
  ).toContainText("0.2–0.8");
  await expect(cards.getByText("Lab rating:", { exact: false })).toHaveCount(0);
});

test('farm soil overview shows six compact measurements and expands evidence on demand', async ({page}, testInfo) => {
  await fixture(page);
  const rows: Partial<SoilMarkerDraft>[] = [
    {parameter:'ph',rawLabel:'pH',rawValue:'7.2',rawUnit:null},
    {parameter:'electrical_conductivity',rawLabel:'EC',rawValue:'0.86',rawUnit:'ds/m'},
    {parameter:'organic_matter',rawLabel:'Total organic matter',rawValue:'2.4',rawUnit:'%'},
    {parameter:'nitrogen_unspecified',rawLabel:'Nitrogen',rawValue:'278',rawUnit:'kg/ha'},
    {parameter:'phosphorus_total',rawLabel:'Total Phosphorus',rawValue:'16',rawUnit:'kg/ha'},
    {parameter:'potassium_total',rawLabel:'Total potassium',rawValue:'186',rawUnit:'kg/ha'},
  ];
  await page.route('**/soil-markers', route => route.fulfill({json:env({farmId:A,limitations:[],samples:[{
    id:'44444444-4444-4444-8444-444444444444',reportId:R,sourceSampleId:'S1',sampleLabel:'MTLR-0337/1010/26-27',laboratory:'Micro Tech Labs & Research',
    collectionDate:null,receivedDate:'2026-10-10',reportDate:'2026-10-15',depth:null,confirmedAt:'2026-11-03T10:00:00Z',
    markers:rows.map((row,i)=>({...marker({id:`result-${i}`,method:null,extractant:null,soilWaterRatio:null,...row}),reviewStatus:'confirmed',confirmedAt:'2026-11-03T10:00:00Z',canonical:{value:null,unit:null,conversion:null,missingReason:null}})),
  }]})}));
  await page.goto('/farm/settings');
  const overview=page.getByRole('region',{name:'Confirmed soil markers'});
  await expect(overview.locator('.soil-marker-card')).toHaveCount(6);
  for (const width of [390,1440]) {
    await page.setViewportSize({width,height:1000});
    const cards=await overview.locator('.soil-marker-card').evaluateAll(elements=>elements.map(el=>{const r=el.getBoundingClientRect();return {height:r.height,right:r.right};}));
    expect(cards.every(card=>card.height<200 && card.right<=width)).toBe(true);
    await expect(overview.locator('.soil-marker-details[open]')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Load sample report'})).toBeVisible();
    await page.locator('.soil-settings-layout').screenshot({path:testInfo.outputPath(`compact-soil-${width}.png`)});
  }
  await overview.locator('.soil-marker-details > summary').first().click();
  await expect(overview.getByRole('button',{name:'p. 1',exact:true})).toBeVisible();
});
