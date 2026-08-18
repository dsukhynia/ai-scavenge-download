/**
 * Anchor resolution lives in exactly one place.
 *
 * Both the discovery agent's tools and the deterministic replay engine call
 * this. If they resolved anchors differently, a recipe could be "discovered"
 * against one interpretation and replayed against another — the recipes would
 * drift from the transcripts that produced them.
 */
import type { Locator, Page } from "playwright";
import type { Anchor } from "./recipe.js";

/**
 * Playwright's default name matching is case-insensitive, whitespace-normalized,
 * and substring-based — which is the resilience we want. `.first()` keeps a
 * page with several plausible matches from throwing a strict-mode error;
 * discovery sees the same first-match behaviour, so what it verified is what
 * replay gets.
 */
export function resolveAnchor(page: Page, anchor: Anchor): Locator {
  return page.getByRole(anchor.role, { name: anchor.name }).first();
}

/**
 * A compact accessibility snapshot of the page — this is what the model reads
 * instead of a screenshot or raw HTML. It is already role+name shaped, so the
 * anchors the model picks are directly expressible as recipe steps.
 */
export async function snapshot(page: Page): Promise<string> {
  const tree = await page.locator("body").ariaSnapshot();
  return `url: ${page.url()}\ntitle: ${await page.title()}\n\n${tree}`;
}
