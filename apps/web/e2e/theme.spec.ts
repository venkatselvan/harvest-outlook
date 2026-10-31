import { expect, test, type Page } from "@playwright/test";

// UI-only fixtures: no user records, live data or provider requests are touched.
const farmId = "11111111-1111-4111-8111-111111111111";
const reportId = "22222222-2222-4222-8222-222222222222";
const env = (data: unknown) => ({
  requestId: "theme-test",
  mode: "live",
  asOf: "2026-10-31T00:00:00Z",
  data,
  warnings: [],
  error: null,
});
const soilReport = {
  id: reportId,
  farmId,
  kind: "field_report",
  status: "needs_review",
  version: 1,
  filename: "theme-report.pdf",
  contentType: "application/pdf",
  bytes: 100,
  sha256: "test",
  createdAt: "2026-10-31T00:00:00Z",
  jobId: null,
  modelInvocation: null,
  originalUrl: `/api/v1/soil-reports/${reportId}/original`,
  referenceSource: null,
  pages: [],
  extraction: {
    title: "Theme soil report",
    laboratory: "Report laboratory",
    reportDate: "2026-10-30",
    samples: [],
    warnings: ["Check the original report before confirming."],
  },
  reviewed: null,
  confirmedSampleIds: [],
  warnings: [],
};
async function fixture(page: Page) {
  await page.route("https://**", (route) => route.abort());
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data =
      path === "/api/v1/session"
        ? { authenticated: true, csrfToken: "test" }
        : path === "/api/v1/farms"
          ? {
              farms: [
                {
                  id: farmId,
                  name: "Theme farm",
                  areaHectares: 1,
                  location: {
                    stateCode: "IN-KA",
                    districtId: "IN-KA-hassan",
                    districtName: "Hassan",
                    precision: "district",
                  },
                  facts: {},
                },
              ],
            }
          : path.endsWith("/workspace")
            ? {
                farmId,
                version: 1,
                updatedAt: null,
                boundary: null,
                previousHarvest: { status: "none" },
                cycles: [],
                rotationPlans: [
                  {
                    id: "ginger-season",
                    year: 2026,
                    season: "Kharif",
                    cropId: "ginger",
                    cropName: "Ginger",
                    plannedSowingDate: "2026-06-01",
                    plannedHarvestDate: "2026-12-01",
                  },
                  {
                    id: "next-season",
                    year: 2026,
                    season: "Rabi",
                    cropId: "ginger",
                    cropName: "Ginger",
                    plannedSowingDate: "2026-11-01",
                  },
                ],
              }
            : path === "/api/v1/crops"
              ? { crops: [{ cropId: "ginger", name: "Ginger", products: [] }] }
              : path.endsWith("/soil-reports")
                ? { reports: [soilReport] }
                : path.endsWith(`/soil-reports/${reportId}`)
                  ? soilReport
                  : path.endsWith("/soil-markers")
                    ? { farmId, samples: [], limitations: [] }
                    : path.endsWith("/monitoring")
                      ? {
                          farmId,
                          checkedAt: "2026-10-31T00:00:00Z",
                          weather: {
                            status: "fresh",
                            reason: null,
                            issuedAt: "2026-10-31T00:00:00Z",
                            attribution: "Weather source",
                            point: null,
                            days: [
                              {
                                date: "2026-10-31",
                                rainMm: 3,
                                tMinC: 20,
                                tMaxC: 29,
                                et0Mm: 4,
                              },
                              {
                                date: "2026-11-01",
                                rainMm: 12,
                                tMinC: 19,
                                tMaxC: 27,
                                et0Mm: 3,
                              },
                            ],
                          },
                          market: {
                            status: "unavailable",
                            reason: "No dated quotes available",
                            products: [],
                          },
                          meta: {
                            status: "unavailable",
                            reason: "No review available",
                            automatic: false,
                          },
                        }
                      : path === "/api/v1/commodities"
                        ? {
                            snapshot: null,
                            total: 0,
                            offset: 0,
                            limit: 300,
                            items: [],
                          }
                        : path === "/api/v1/districts"
                          ? {
                              areas: [],
                              districts: [],
                              districtListAvailable: false,
                              note: null,
                            }
                          : path === "/api/v1/ai/activity"
                            ? { invocations: [] }
                            : {};
    await route.fulfill({ json: env(data) });
  });
}

async function contrastIssues(page: Page, scope = "body") {
  return page.locator(scope).evaluate((root) => {
    const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = (c: number[]) =>
      c
        .slice(0, 3)
        .map((v) => v / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    const background = (el: Element | null): number[] => {
      if (!el) return [255, 255, 255];
      const c = rgb(getComputedStyle(el).backgroundColor);
      const alpha = c[3] ?? 1;
      if (alpha >= 1) return c;
      return background(el.parentElement).map(
        (v, i) => (c[i] ?? 0) * alpha + v * (1 - alpha),
      );
    };
    return [...root.querySelectorAll<HTMLElement>("*")].flatMap((el) => {
      if (
        !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
        el.closest(
          "button:disabled, input:disabled, select:disabled, textarea:disabled, .leaflet-container, svg",
        )
      )
        return [];
      const text = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent?.trim())
        .filter(Boolean)
        .join(" ");
      if (
        !text ||
        el.tagName === "OPTION" ||
        el.tagName === "SCRIPT" ||
        el.tagName === "STYLE"
      )
        return [];
      const cs = getComputedStyle(el),
        fg = rgb(cs.color),
        bg = background(el);
      const a = luminance(fg),
        b = luminance(bg),
        ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const large =
        parseFloat(cs.fontSize) >= 24 ||
        (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
      return ratio + 0.01 < (large ? 3 : 4.5)
        ? [
            {
              text: text.slice(0, 100),
              selector: el.className,
              color: cs.color,
              background: bg,
              ratio,
            },
          ]
        : [];
    });
  });
}

test("system theme initializes in the head even before the application module loads", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.route("**/*", (route) =>
    route.request().resourceType() === "script" ||
    route.request().url().includes("/api/")
      ? route.abort()
      : route.continue(),
  );
  await page.goto("/farm");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(17, 20, 23)",
  );
  await expect(page.locator("#root")).toBeEmpty();
});

test("theme follows system until chosen, supports keyboard toggle, and persists across routes and reload", async ({
  page,
}) => {
  await fixture(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/farm/settings");
  const toggle = page.getByRole("button", { name: "Dark mode", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("ho.theme")))
    .toBe("light");
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page
    .getByRole("navigation", { name: "Farm views" })
    .getByRole("link", { name: "Plan", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(17, 20, 23)",
  );
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme} theme keeps workspace routes, season form, report modal and assistant readable`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fixture(page);
    await page.emulateMedia({ colorScheme: theme });
    for (const path of [
      "/farm",
      "/planner",
      "/explore",
      "/catalogue",
      "/outlook",
      "/journal",
      "/farm/settings",
    ]) {
      await page.goto(path);
      await expect(
        page.getByRole("button", { name: "Dark mode", exact: true }),
      ).toBeVisible();
      await expect(page.locator("h1").first()).toBeVisible();
      expect(await contrastIssues(page), `Text contrast on ${path}`).toEqual(
        [],
      );
    }
    await page.getByRole("button", { name: /Theme soil report/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(
      await contrastIssues(page, '[role="dialog"]'),
      "Report modal text contrast",
    ).toEqual([]);
    await page.getByRole("button", { name: "Close soil report" }).click();
    await page.goto("/planner");
    await page
      .getByRole("button", { name: "Add a season", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const formSelect = page
      .getByRole("dialog")
      .getByRole("combobox", { name: "Crop", exact: true });
    await expect(formSelect).toHaveCSS(
      "background-color",
      theme === "light" ? "rgb(255, 255, 255)" : "rgb(27, 31, 36)",
    );
    expect(
      await contrastIssues(page, '[role="dialog"]'),
      "Season form text contrast",
    ).toEqual([]);
    await page.getByRole("button", { name: "Close season editor" }).click();
    await page
      .getByRole("button", { name: "Open Evara", exact: true })
      .first()
      .click();
    await expect(
      page.getByLabel("Evara farm assistant", { exact: true }),
    ).toBeVisible();
    expect(
      await contrastIssues(page, ".assistant-panel"),
      "Assistant text contrast",
    ).toEqual([]);
    await page.setViewportSize({ width: 360, height: 740 });
    const toggle = page.getByRole("button", { name: "Dark mode", exact: true });
    await expect(toggle).toBeInViewport();
    expect(await toggle.boundingBox()).toMatchObject({ width: 40, height: 40 });
  });
}
