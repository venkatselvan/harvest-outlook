import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { seedFarmAndPlan } from "./support/seed";

/*
 * Mobile and accessibility audit of the five routes at 360x740 and 390x844 against the real dev stack (SYNTHETIC mode).
 * Hard failures: horizontal overflow, axe violations of impact serious/critical, missing labels, no visible focus,
 * running transitions under prefers-reduced-motion, slider not keyboard operable, undersized targets that are not in
 * the documented exception list below. Moderate/minor axe findings and target exceptions are logged and listed in
 * docs/UI_ISSUES.md.
 */
/**
 * Known serious axe findings in files owned by other tasks (listed in docs/UI_ISSUES.md). They are logged and must still
 * be present; any OTHER serious/critical finding fails the test. Remove an entry when its fix lands.
 */
const KNOWN_AXE: Record<string, string> = {
};

const VIEWPORTS = [
  { width: 360, height: 740 },
  { width: 390, height: 844 },
];

/** Documented target-size exceptions (selector fragment -> reason). Anything else under 44 px fails the test. */
const TARGET_EXCEPTIONS: Record<string, string> = {
  "skip-link": "off-screen until focused; becomes 44px+ when shown",
  "se-range": "native range input: the thumb is the target; the input box is 44px high but the thumb is browser-sized",
  "ai-spark": "inline AI mark: 24px target (WCAG 2.5.8 AA) next to text; 44px on coarse pointers via @media (pointer: coarse)",
};

// Each test seeds its own guest workspace (the session cookie is per browser context).
const routes = (planId: string) => [
  { name: "explore", path: "/explore", ready: (p: Page) => p.getByRole("heading", { level: 1 }).first().waitFor() },
  { name: "farm", path: "/farm", ready: (p: Page) => p.getByRole("heading", { level: 1 }).first().waitFor() },
  { name: "plan", path: `/farm/plan/${planId}`, ready: (p: Page) => p.getByTestId("plan-summary").waitFor() },
  { name: "journal", path: "/journal", ready: (p: Page) => p.getByRole("heading", { name: "New journal entry" }).waitFor() },
  { name: "ask", path: "/ask", ready: (p: Page) => p.getByRole("heading", { level: 1 }).first().waitFor() },
];

async function undersized(page: Page) {
  return page.evaluate((exceptions) => {
    const out: { tag: string; text: string; w: number; h: number; cls: string }[] = [];
    const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="slider"], [tabindex]:not([tabindex="-1"])';
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      let r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      // A checkbox or radio is operated through its label: measure the label when there is one.
      const lab = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio" || el.type === "file") ? el.labels?.[0] : null;
      if (lab) r = lab.getBoundingClientRect();
      if (cs.visibility === "hidden" || cs.display === "none" || r.width === 0 || r.height === 0) continue;
      if (r.right < 0 || r.bottom < 0 || r.top < -50) continue; // off-screen (skip link)
      if (Object.keys(exceptions).some((k) => el.id === k || el.className.toString().includes(k))) continue;
      // An inline link inside running text is exempt (WCAG 2.5.8); block-level controls are not.
      if (el.tagName === "A" && cs.display === "inline" && el.closest("p, li, dd")) continue;
      if (r.width < 44 || r.height < 44) out.push({ tag: el.tagName.toLowerCase(), text: (el.getAttribute("aria-label") ?? el.textContent ?? el.id).trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height), cls: el.className.toString().slice(0, 40) });
    }
    return out.filter((o, i) => out.findIndex((x) => JSON.stringify(x) === JSON.stringify(o)) === i);
  }, TARGET_EXCEPTIONS);
}

for (const vp of VIEWPORTS) {
  test.describe(`${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    for (const name of ["explore", "farm", "plan", "journal", "ask"]) {
      test(`${name}: overflow, targets, axe, labels, focus`, async ({ page }, info) => {
        const { planId } = await seedFarmAndPlan(page);
        const r = routes(planId).find((x) => x.name === name)!;
        await page.goto(r.path);
        await r.ready(page);
        await page.waitForLoadState("networkidle");

        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal overflow").toBe(true);

        const small = await undersized(page);
        if (small.length) info.annotations.push({ type: "undersized-targets", description: JSON.stringify(small) });
        expect(small, `interactive elements under 44 px: ${JSON.stringify(small)}`).toEqual([]);

        const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
        const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        const keyOf = (v: (typeof serious)[number]) => `${v.id}|${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`;
        for (const v of serious.filter((v) => KNOWN_AXE[keyOf(v)])) console.log(`[axe KNOWN ${v.impact}] ${r.name} ${vp.width}: ${KNOWN_AXE[keyOf(v)]}`);
        const blocking = serious.filter((v) => !KNOWN_AXE[keyOf(v)]);
        for (const v of axe.violations.filter((v) => !blocking.includes(v))) console.log(`[axe ${v.impact}] ${r.name} ${vp.width}: ${v.id} (${v.nodes.length} nodes)`);
        expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);

        // Every form control has an accessible name.
        const unlabeled = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>("input:not([type=hidden]), select, textarea")]
            .filter((el) => !(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || (el as HTMLInputElement).labels?.length))
            .map((el) => el.id || el.tagName),
        );
        expect(unlabeled, "controls without a label").toEqual([]);

        // Focus is visible on Tab: the focused element has a non-zero outline or box-shadow.
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        const focus = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          const cs = getComputedStyle(el);
          return { outline: cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0, shadow: cs.boxShadow !== "none", matches: el.matches(":focus-visible") };
        });
        expect(focus, "something received focus").not.toBeNull();
        expect(focus!.matches && (focus!.outline || focus!.shadow), "focus indicator visible").toBe(true);
      });
    }

    test("plan: reduced motion leaves no running transitions or animations; slider works from the keyboard", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const { planId } = await seedFarmAndPlan(page);
      await page.goto(`/farm/plan/${planId}`);
      await page.getByTestId("plan-summary").waitFor();
      const slider = page.locator("#se-range");
      await expect(slider).toBeVisible();
      await slider.focus();
      const before = await slider.inputValue();
      await slider.press("ArrowRight");
      await slider.press("ArrowRight");
      await slider.press("PageUp");
      const after = await slider.inputValue();
      expect(Number(after)).toBeGreaterThan(Number(before));
      const label = await slider.getAttribute("aria-valuetext");
      expect(label).toMatch(/\d{4}|\w{3}/);
      await slider.press("Home");
      expect(Number(await slider.inputValue())).toBeLessThanOrEqual(Number(before));
      await slider.press("End");
      expect(Number(await slider.inputValue())).toBeGreaterThan(Number(before));
      // Let any started effects begin, then count animations that are still running on the slider and scene.
      await page.waitForTimeout(150);
      const running = await page.evaluate(() =>
        document
          .getAnimations()
          .filter((a) => a.playState === "running" && a.effect && ((a.effect as KeyframeEffect).target as Element | null)?.closest?.(".se-slider, [data-testid='panel-scene']"))
          .map((a) => `${a.constructor.name}:${(a as CSSTransition).transitionProperty ?? (a as CSSAnimation).animationName}:${a.effect?.getComputedTiming().duration}`)
          // 0.01 ms (the reduced-motion clamp in styles.css) finishes immediately and is acceptable
          .filter((s) => !/:0\.01$/.test(s)),
      );
      expect(running, "no running CSS transitions or animations with prefers-reduced-motion").toEqual([]);
      // Control: the media query is really applied.
      expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    });
  });
}
