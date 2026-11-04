import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Locator, Page } from '@playwright/test';

/** Explicit capture mode writes example screens from real components, never live farmer data. */
export async function captureAiPreview(page: Page, key: string, locator: Locator) {
  if (!process.env.CAPTURE_AI_PREVIEWS) return;
  const destination = resolve('public/ai-previews');
  await mkdir(destination, {recursive: true});
  const viewport = page.viewportSize()!;
  await page.setViewportSize({width: 1280, height: 1000});
  await locator.scrollIntoViewIfNeeded();
  await locator.screenshot({path: resolve(destination, `${key}.png`), animations: 'disabled', style: '.sidebar,.farm-bottom-tabs,.topbar,.assistant-launcher,.model-activity-toast,.farm-command-heading,.farm-context-tabs,.farm-subnav,.skip-link { visibility:hidden!important; }'});
  await page.setViewportSize(viewport);
}
