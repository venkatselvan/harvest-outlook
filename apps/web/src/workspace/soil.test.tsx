import { describe, it, expect } from "vitest";
import { renderToString } from "solid-js/web";
import { ApiError } from "../lib/api";
import { printedResult, soilPollDelay } from "./soil";
import { SoilMarkerCards, SoilReferenceCards } from "./SoilMarkerCards";
import type {
  FarmSoilMarkers,
  SoilReport,
  SoilMarkerDraft,
} from "@harvest/contracts";
const marker = (patch: Partial<SoilMarkerDraft> = {}): SoilMarkerDraft => ({
  id: "iron-digested",
  parameter: "unknown_other",
  rawLabel: "Iron (digested soil)",
  rawValue: "9.12",
  rawUnit: "mg/kg",
  numericValue: 9.12,
  qualifier: "exact",
  range: null,
  analyteForm: "Digested soil iron",
  method: "Acid digestion",
  extractant: null,
  soilWaterRatio: null,
  temperatureC: null,
  matrix: "soil",
  massBasis: null,
  reportedRating: null,
  evidence: {
    page: 2,
    quote: "Iron 9.12 mg/kg, digested soil",
    nativeTextCheck: "matched",
  },
  extractionConfidence: "high",
  warnings: [],
  ...patch,
});
const confirmed = (markers: SoilMarkerDraft[]): FarmSoilMarkers => ({
  farmId: "11111111-1111-4111-8111-111111111111",
  samples: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      reportId: "33333333-3333-4333-8333-333333333333",
      sourceSampleId: "S1",
      sampleLabel: "S1",
      laboratory: "Laboratory",
      collectionDate: "2017-10-23",
      reportDate: "2017-10-31",
      depth: null,
      confirmedAt: "2026-10-30T00:00:00Z",
      markers: markers.map((m) => ({
        ...m,
        canonical: {
          value: null,
          unit: null,
          conversion: null,
          missingReason: "Method-specific value retained",
        },
        reviewStatus: "confirmed",
        confirmedAt: "2026-10-30T00:00:00Z",
      })),
    },
  ],
  limitations: [],
});
describe("printed laboratory results stay literal", () => {
  it("retains censored values, ranges, and zero without inventing absent values", () => {
    expect(printedResult("<0.5")).toMatchObject({
      numericValue: 0.5,
      qualifier: "less_than",
      range: null,
    });
    expect(printedResult("1.2–3.4")).toMatchObject({
      numericValue: null,
      qualifier: "range",
      range: { low: 1.2, high: 3.4 },
    });
    expect(printedResult("0")).toMatchObject({
      numericValue: 0,
      qualifier: "exact",
    });
    expect(printedResult("Absent")).toMatchObject({
      numericValue: null,
      qualifier: "text",
    });
    expect(printedResult("BDL")).toMatchObject({
      numericValue: null,
      qualifier: "below_detection",
    });
    expect(printedResult("")).toMatchObject({
      numericValue: null,
      qualifier: "text",
    });
  });
  it("honours HTTP429 backoff rather than repeatedly polling", () => {
    expect(
      soilPollDelay(
        new ApiError("rate_limited", "Retry in 28 seconds", 429, "qa", 28000),
      ),
    ).toBe(28000);
    expect(
      soilPollDelay(new ApiError("rate_limited", "Rate limited", 429)),
    ).toBe(60000);
    expect(soilPollDelay(undefined)).toBe(2500);
  });
});
describe("method and purpose boundaries in marker cards", () => {
  it("does not substitute digested iron for an available-iron SHC measurement", () => {
    const html = renderToString(() => (
      <SoilMarkerCards data={confirmed([marker()])} />
    ));
    expect(html).toContain("Iron (digested soil)");
    expect(html).toContain("9.12");
    expect(html).toContain("Acid digestion");
    expect(html).toMatch(/Available iron[\s\S]*?No confirmed measurement/);
    expect(html).not.toContain("soil-health score");
  });
  it("keeps two measurement methods separate instead of averaging", () => {
    const html = renderToString(() => (
      <SoilMarkerCards
        data={confirmed([
          marker({
            id: "iron-a",
            parameter: "iron_available",
            rawLabel: "Iron by DTPA",
            method: "DTPA",
            rawValue: "4.2",
          }),
          marker({
            id: "iron-b",
            parameter: "iron_available",
            rawLabel: "Iron by Mehlich",
            method: "Mehlich",
            rawValue: "8.6",
          }),
        ])}
      />
    ));
    expect(html).toContain("Iron by DTPA");
    expect(html).toContain("Iron by Mehlich");
    expect(html).toContain("4.2");
    expect(html).toContain("8.6");
    expect(html).not.toContain("6.4");
  });
  it("reference values remain visibly draft and outside farm measurements", () => {
    const report = {
      id: "33333333-3333-4333-8333-333333333333",
      kind: "reference_sample",
      filename: "ANACON2017.pdf",
      reviewed: null,
      extraction: {
        title: "Public lab report",
        laboratory: "ANACON",
        reportDate: "2017-10-31",
        samples: [
          {
            id: "S1",
            sampleLabel: "S1",
            laboratory: "ANACON",
            collectionDate: "2017-10-23",
            reportDate: "2017-10-31",
            depth: null,
            markers: [marker()],
          },
        ],
        warnings: [],
      },
      referenceSource: {
        title: "ANACON2017",
        url: "https://example.gov/report.pdf",
        limitations: [],
      },
      originalUrl: "/api/v1/soil-reports/id/original",
      modelInvocation: null,
    } as unknown as SoilReport;
    const html = renderToString(() => (
      <SoilReferenceCards
        report={report}
        farmName="Demo boundary"
        onReview={() => {}}
      />
    ));
    expect(html.replace(/<!--.*?-->/g, "")).toContain(
      "not added to Demo boundary",
    );
    expect(html).toContain("Draft extraction");
    expect(html).toContain("9.12");
    expect(html).not.toContain("Confirmed from report");
  });
});

describe("printed report criteria stay separate from results", () => {
  it("retains the lab band, result, dates and analyte identity without inventing a rating", () => {
    const data = confirmed([
      marker({
        id: "total-p",
        parameter: "phosphorus_total",
        rawLabel: "Phosphorus, total",
        analyteForm: null,
        method: null,
        extractant: null,
        rawValue: "2.5",
        rawUnit: "%",
        numericValue: 2.5,
        reportedReference: {
          label: "Desirable limits",
          rawText: "1.0–3.0",
          rawUnit: "%",
          qualifier: "range",
          numericValue: null,
          range: { low: 1, high: 3, lowInclusive: null, highInclusive: null },
          evidence: {
            page: 2,
            quote: "Desirable limits 1.0–3.0 %",
            nativeTextCheck: "image_review_required",
          },
        },
      }),
    ]);
    data.samples[0]!.collectionDate = null;
    data.samples[0]!.receivedDate = "2026-10-20";
    data.samples[0]!.reportDate = "2026-10-24";
    const html = renderToString(() => <SoilMarkerCards data={data} />);
    expect(html).toContain("2.5");
    expect(html).toContain("Desirable limits");
    expect(html).toContain("1.0–3.0");
    expect(html).toContain("THIS REPORT’S PRINTED REFERENCE");
    expect(html).toContain("not a crop target");
    expect(html).toContain("Collection date unreported");
    expect(html).toContain("Received");
    expect(html).toContain("Report");
    expect(html).toContain("Total phosphorus");
    expect(html).not.toContain("Lab rating:");
    expect(html).not.toContain("Within this");
  });
});
