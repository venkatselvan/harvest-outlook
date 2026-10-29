import { expect, test, type Page } from "@playwright/test";

// Runs against the real API in SYNTHETIC mode (see e2e/support/start-api.ts). No provider is contacted.
test.use({ viewport: { width: 360, height: 740 }, hasTouch: false });

/** Generates a JPEG in the browser (canvas) so no binary fixture is needed. */
async function makeJpeg(page: Page, w: number, h: number): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ([w, h]) => {
      const c = document.createElement("canvas");
      c.width = w!;
      c.height = h!;
      const g = c.getContext("2d")!;
      const grad = g.createLinearGradient(0, 0, w!, h!);
      grad.addColorStop(0, "#3a7d44");
      grad.addColorStop(1, "#c9a227");
      g.fillStyle = grad;
      g.fillRect(0, 0, w!, h!);
      g.fillStyle = "#fff";
      g.fillRect(w! * 0.1, h! * 0.1, w! * 0.15, h! * 0.15);
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/jpeg", 0.9));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (const x of buf) s += String.fromCharCode(x);
      return btoa(s);
    },
    [w, h],
  );
  return Buffer.from(b64, "base64");
}

async function createFarm(page: Page, district = "Wayanad") {
  await page.goto("/farm");
  await expect(page.getByRole("heading", { name: "My farm" })).toBeVisible();
  await page.getByLabel("District name").fill(district);
  await page.getByLabel("State or union territory").selectOption("KL");
  await page.getByLabel("From", { exact: true }).selectOption("6");
  await page.getByLabel("To", { exact: true }).selectOption("8");
  await page.getByLabel("How is the land watered?").selectOption("rainfed");
  await page.getByLabel("Area", { exact: true }).fill("2.5");
  await page.getByRole("button", { name: "Save farm" }).click();
  await expect(page.getByTestId("farm-summary")).toContainText(district);
  await expect(page.getByTestId("farm-summary")).toContainText("June to August");
}

async function uploadPhoto(page: Page, w: number, h: number, name = "farm.jpg") {
  const buffer = await makeJpeg(page, w, h);
  await page.getByTestId("photo-file").setInputFiles({ name, mimeType: "image/jpeg", buffer });
  await expect(page.getByTestId("region-stage")).toBeVisible();
  await expect(page.locator(".pr-img")).toHaveJSProperty("complete", true);
  await expect.poll(() => page.locator(".pr-img").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
}

/** Position inside the displayed image content (excludes letterbox bars) for normalized (nx, ny). */
async function contentPoint(page: Page, nx: number, ny: number) {
  // Put the stage just below the sticky header: mouse coordinates are viewport-relative and the header/bottom nav cover the page edges.
  await page.getByTestId("region-stage").evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 110));
  const stage = (await page.getByTestId("region-stage").boundingBox())!;
  const nat = await page.locator(".pr-img").evaluate((i: HTMLImageElement) => ({ w: i.naturalWidth, h: i.naturalHeight }));
  const k = Math.min(stage.width / nat.w, stage.height / nat.h);
  const cw = nat.w * k;
  const ch = nat.h * k;
  return { x: stage.x + (stage.width - cw) / 2 + nx * cw, y: stage.y + (stage.height - ch) / 2 + ny * ch, content: { w: cw, h: ch }, stage };
}

async function savedRegion(page: Page) {
  return page.evaluate(async () => {
    const farms = (await (await fetch("/api/v1/farms")).json()).data.farms;
    const media = (await (await fetch(`/api/v1/farms/${farms[0].id}/media`)).json()).data.media;
    return media[0].region as { polygon: [number, number][]; source: string; version: number } | null;
  });
}

test("farm, photo upload, 4-point manual polygon, save and reload at 360px", async ({ page }) => {
  await createFarm(page);
  await uploadPhoto(page, 800, 600);

  // No horizontal scroll at 360 px.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByText("A photo outline is not a surveyed field boundary.")).toBeVisible();

  const targets: [number, number][] = [[0.2, 0.25], [0.8, 0.2], [0.85, 0.8], [0.15, 0.75]];
  for (const [nx, ny] of targets) {
    const p = await contentPoint(page, nx, ny);
    await page.mouse.click(p.x, p.y);
  }
  const handles = page.getByTestId("region-handle");
  await expect(handles).toHaveCount(4);
  for (let i = 0; i < 4; i++) {
    const b = (await handles.nth(i).boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.getByTestId("region-summary")).toContainText("4 points");
  await page.getByRole("button", { name: "Save outline" }).click();
  await expect(page.getByText("Outline saved.")).toBeVisible();

  const saved = await savedRegion(page);
  expect(saved!.source).toBe("manual");
  expect(saved!.polygon).toHaveLength(4);
  saved!.polygon.forEach(([x, y], i) => {
    expect(Math.abs(x - targets[i]![0])).toBeLessThan(0.012);
    expect(Math.abs(y - targets[i]![1])).toBeLessThan(0.012);
  });

  await page.reload();
  await expect(page.getByTestId("region-handle")).toHaveCount(4);
  await expect(page.getByTestId("region-summary")).toContainText("Saved (drawn by you)");
  await expect(page.getByTestId("region-polygon")).toBeVisible();
});

test("letterboxed portrait photo maps taps to image coordinates, and keyboard drawing works", async ({ page }) => {
  await createFarm(page, "Coimbatore");
  await uploadPhoto(page, 300, 900); // 1:3 portrait: taller than the 70vh stage cap, so side bars appear
  const geo = await contentPoint(page, 0, 0);
  expect(geo.content.w).toBeLessThan(geo.stage.width - 20); // side bars exist

  // A tap in the side bar adds nothing.
  await page.mouse.click(geo.stage.x + 3, geo.stage.y + geo.stage.height / 2);
  await expect(page.getByTestId("region-handle")).toHaveCount(0);

  const targets: [number, number][] = [[0.1, 0.1], [0.9, 0.15], [0.85, 0.9], [0.15, 0.85]];
  for (const [nx, ny] of targets) {
    const p = await contentPoint(page, nx, ny);
    await page.mouse.click(p.x, p.y);
  }
  await page.getByRole("button", { name: "Save outline" }).click();
  await expect(page.getByText("Outline saved.")).toBeVisible();
  const saved = await savedRegion(page);
  saved!.polygon.forEach(([x, y], i) => {
    expect(Math.abs(x - targets[i]![0])).toBeLessThan(0.02);
    expect(Math.abs(y - targets[i]![1])).toBeLessThan(0.012);
  });

  // Keyboard alternative: clear, then Enter adds centre points that arrow keys move.
  await page.getByRole("button", { name: "Clear" }).click();
  await page.getByTestId("region-stage").focus();
  const moves: [string, number][][] = [
    [["ArrowLeft", 25], ["ArrowUp", 25]],
    [["ArrowRight", 25], ["ArrowUp", 25]],
    [["ArrowRight", 25], ["ArrowDown", 25]],
    [["ArrowLeft", 25], ["ArrowDown", 25]],
  ];
  for (const m of moves) {
    await page.keyboard.press("Enter");
    for (const [key, n] of m) for (let i = 0; i < n; i++) await page.keyboard.press(key);
    await page.getByTestId("region-stage").focus();
  }
  await expect(page.getByTestId("region-handle")).toHaveCount(4);
  await page.getByRole("button", { name: "Save outline" }).click();
  await expect(page.getByText("Outline saved.")).toBeVisible();
  const kb = await savedRegion(page);
  expect(kb!.polygon.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100])).toEqual([[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]]);
});

test("AI suggestion is reported unavailable in synthetic mode and the manual editor keeps working", async ({ page }) => {
  await createFarm(page, "Nashik");
  await uploadPhoto(page, 640, 480);
  await page.getByRole("button", { name: "Suggest region with AI" }).click();
  await expect(page.getByTestId("ai-message")).toContainText("AI suggestion is turned off in synthetic mode", { timeout: 20_000 });
  await expect(page.getByTestId("ai-message")).toContainText("Manual outline is still available");
  await expect(page.getByTestId("ai-proposal")).toHaveCount(0);
  await page.getByRole("button", { name: "Four corners" }).click();
  await expect(page.getByTestId("region-handle")).toHaveCount(4);
  await page.getByRole("button", { name: "Save outline" }).click();
  await expect(page.getByText("Outline saved.")).toBeVisible();
});

test("a mocked SAM proposal is shown dashed with its label, and accepting saves it as sam_confirmed", async ({ page }) => {
  // The segmentation and job responses are MOCKED here to exercise the proposal UI; the PUT region call is real.
  await createFarm(page, "Guntur");
  await uploadPhoto(page, 640, 480);
  const polygon = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]];
  await page.route("**/api/v1/media/*/segmentation", (r) =>
    r.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ requestId: "m", mode: "synthetic", asOf: "x", warnings: [], error: null, data: { jobId: "00000000-0000-4000-8000-000000000001", state: "queued", deduplicated: false, manualFallbackAvailable: true, label: "x" } }) }),
  );
  await page.route("**/api/v1/jobs/00000000-0000-4000-8000-000000000001", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ requestId: "m", mode: "synthetic", asOf: "x", warnings: [], error: null, data: { id: "j", type: "vision.segment", state: "succeeded", result: { status: "ok", polygon, segmentationScore: 0.81, proposals: [{ polygon }] } } }) }),
  );
  await page.getByRole("button", { name: "Suggest region with AI" }).click();
  await expect(page.getByTestId("ai-proposal")).toContainText("AI suggestion — illustrative outline, confirm or correct");
  await expect(page.locator(".pr-proposal")).toBeVisible();
  expect(await page.locator(".pr-proposal").evaluate((e) => getComputedStyle(e).strokeDasharray)).not.toBe("none");
  await page.getByRole("button", { name: "Accept and save this outline" }).click();
  await expect(page.getByText("Outline saved.")).toBeVisible();
  const saved = await savedRegion(page);
  expect(saved!.source).toBe("sam_confirmed");
  expect(saved!.polygon).toEqual(polygon);
});

test("client pre-check rejects a non-image file with a clear message and sends nothing", async ({ page }) => {
  await createFarm(page, "Madurai");
  let posts = 0;
  page.on("request", (r) => r.method() === "POST" && r.url().includes("/api/v1/media") && posts++);
  await page.getByTestId("photo-file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(page.getByTestId("upload-error")).toContainText("Only JPEG, PNG or WebP");
  expect(posts).toBe(0);
});

test("dragging a corner handle moves the point and undo restores it", async ({ page }) => {
  await createFarm(page, "Erode");
  await uploadPhoto(page, 800, 600);
  await page.getByRole("button", { name: "Four corners" }).click();
  const h0 = page.getByTestId("region-handle").first();
  await h0.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 200));
  const b = (await h0.boundingBox())!;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 20, cy + 12, { steps: 4 });
  await page.mouse.move(cx + 40, cy + 24, { steps: 4 });
  await page.mouse.up();
  const after = (await h0.boundingBox())!;
  expect(Math.abs(after.x - b.x - 40)).toBeLessThanOrEqual(2); // subpixel layout: observed 1.33 px
  expect(Math.abs(after.y - b.y - 24)).toBeLessThanOrEqual(2); // subpixel layout: observed 1.33 px
  await page.getByRole("button", { name: "Save outline" }).click();
  await expect(page.getByText("Outline saved.")).toBeVisible();
  const saved = await savedRegion(page);
  expect(saved!.polygon[0]![0]).toBeGreaterThan(0.12 + 0.05);
  await page.getByRole("button", { name: "Undo" }).click();
  const undone = (await h0.boundingBox())!;
  expect(Math.abs(undone.x - b.x)).toBeLessThanOrEqual(1);
});
