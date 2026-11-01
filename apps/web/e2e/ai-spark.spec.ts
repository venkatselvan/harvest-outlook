import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/*
 * The header entry point of the AI spark (workspace/ui/AiSpark.tsx), against the real dev stack: it opens the list of
 * every AI use, stays inside the viewport at phone width, keeps focus handling and passes axe. Single-use sparks are
 * mounted by other views; their click-through is checked where they appear.
 */
const VIEWPORTS = [
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];

for (const vp of VIEWPORTS) {
  test.describe(`${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    test("AI in this app: opens the list, fits the screen, restores focus", async ({ page }, info) => {
      await page.goto("/farm");
      const button = page.getByRole("button", { name: "AI in this app" });
      await expect(button).toBeVisible();
      const box = (await button.boundingBox())!;
      const minTarget = vp.width < 768 ? 44 : 32;
      expect(box.width, "target width").toBeGreaterThanOrEqual(minTarget);
      expect(box.height, "target height").toBeGreaterThanOrEqual(minTarget);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no overflow with the header button").toBe(true);

      await info.attach("topbar", { body: await page.locator("header.topbar").screenshot(), contentType: "image/png" });
      await button.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "AI in this app" });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator("li.ai-row")).toHaveCount(10);
      await expect(dialog.locator(".ui-chip", { hasText: /^Live$/ })).toHaveCount(10);
      await expect(dialog.locator(".ui-chip", { hasText: /^Planned$/ })).toHaveCount(0);
      await expect(dialog).toContainText("Meta is the only runtime AI provider in Harvest Outlook");
      await expect(dialog).toContainText("without provider-side storage (store: false)");
      // No "Claude" outside the provider note.
      expect((await dialog.locator("li.ai-row").allTextContents()).join(" ")).not.toMatch(/claude/i);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no overflow with the list open").toBe(true);

      // Let the entrance animation finish so axe measures final colours.
      await page.waitForTimeout(400);
      const axe = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(serious, JSON.stringify(serious.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })))).toEqual([]);

      await info.attach("sheet", { body: await page.screenshot(), contentType: "image/png" });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(button).toBeFocused();
    });
  });
}
