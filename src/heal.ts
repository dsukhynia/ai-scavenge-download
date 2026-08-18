/**
 * Healing. A broken recipe is not repaired in place — it is re-discovered with
 * the broken version handed to the agent as a hint, which keeps one code path
 * for "never seen this site" and "this site moved a button".
 *
 * The diff exists for humans: at ~1000 sites you want to see at a glance
 * whether a heal changed one anchor or rewrote the whole path, because the
 * latter is worth a look.
 */
import { discover, type DiscoverResult } from "./discover.js";
import { loadRecipe, describeStep, type Recipe } from "./recipe.js";

export interface RecipeDiff {
  removed: string[];
  added: string[];
  unchanged: number;
}

export function diffRecipes(before: Recipe, after: Recipe): RecipeDiff {
  const b = before.steps.map(describeStep);
  const a = after.steps.map(describeStep);
  const inA = new Set(a);
  const inB = new Set(b);
  return {
    removed: b.filter((s) => !inA.has(s)),
    added: a.filter((s) => !inB.has(s)),
    unchanged: b.filter((s) => inA.has(s)).length,
  };
}

export function formatDiff(diff: RecipeDiff): string {
  const lines = [...diff.removed.map((s) => `  - ${s}`), ...diff.added.map((s) => `  + ${s}`)];
  if (lines.length === 0) return "  (steps identical — the change was in the expect contract)";
  return `${lines.join("\n")}\n  (${diff.unchanged} steps unchanged)`;
}

export interface HealResult extends DiscoverResult {
  before: Recipe;
  diff: RecipeDiff;
}

export async function heal(
  siteId: string,
  failureNote: string,
  options: { headless?: boolean } = {},
): Promise<HealResult> {
  const before = await loadRecipe(siteId);
  const result = await discover(siteId, {
    headless: options.headless ?? true,
    brokenRecipe: before,
    failureNote,
  });
  return { ...result, before, diff: diffRecipes(before, result.recipe) };
}

// ------------------------------------------------------------------ CLI

if (import.meta.url === `file://${process.argv[1]}`) {
  const siteId = process.argv[2];
  if (!siteId) {
    console.error("usage: npx tsx src/heal.ts <site-id> [--headed]");
    process.exit(2);
  }
  const result = await heal(siteId, "manual heal requested", {
    headless: !process.argv.includes("--headed"),
  });
  console.log(`\nhealed ${siteId} in ${result.turns} turns:`);
  console.log(formatDiff(result.diff));
}
