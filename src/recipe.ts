/**
 * The recipe format.
 *
 * Two rules make the rest of the system work:
 *
 *  1. Elements are addressed by accessibility role + accessible name, never by
 *     CSS or XPath. A "Sign in" button stays findable when its class names,
 *     DOM position, or framework change.
 *
 *  2. Every step type here has exactly one corresponding agent tool (src/tools.ts).
 *     Discovery therefore *emits* a recipe as a by-product of succeeding — there
 *     is no separate translation step that could disagree with what the agent did.
 */
import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

/** An accessibility anchor: what the element *is*, not where it sits. */
export const Anchor = z.object({
  role: z.enum(["textbox", "button", "link", "combobox", "checkbox"]),
  name: z.string().min(1).describe("Accessible name, matched case-insensitively"),
});
export type Anchor = z.infer<typeof Anchor>;

export const Step = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("goto"),
    url: z.string().url(),
  }),
  z.object({
    action: z.literal("fill"),
    anchor: Anchor,
    /**
     * Exactly one of these. `credential_ref` names a secret the runner
     * substitutes host-side — the model never sees the value.
     */
    credential_ref: z.string().optional(),
    value: z.string().optional(),
  }),
  z.object({
    action: z.literal("select"),
    anchor: Anchor,
    value: z.string(),
  }),
  z.object({
    action: z.literal("click"),
    anchor: Anchor,
  }),
  /** A click that is expected to produce a file. Terminates the recipe. */
  z.object({
    action: z.literal("download"),
    anchor: Anchor,
  }),
]);
export type Step = z.infer<typeof Step>;

/**
 * The verification contract. A recipe that "succeeds" but produces the wrong
 * artifact is the dangerous failure mode, so replay is not trusted on its own —
 * the download has to satisfy all of these or the run is quarantined.
 */
export const Expect = z.object({
  content_type: z
    .string()
    .describe("Sniffed from magic bytes, not from the HTTP header"),
  filename_pattern: z.string().describe("JS regex the suggested filename must match"),
  min_bytes: z.number().int().positive(),
});
export type Expect = z.infer<typeof Expect>;

export const Recipe = z.object({
  version: z.literal(1),
  site_id: z.string().min(1),
  goal: z.string().min(1).describe("Natural-language task this recipe fulfils"),
  steps: z.array(Step).min(1),
  expect: Expect,
  generated_at: z.string().optional(),
  generated_by: z.string().optional().describe("Model id that produced it"),
});
export type Recipe = z.infer<typeof Recipe>;

const RECIPE_DIR = "recipes";

export function recipePath(siteId: string): string {
  return path.join(RECIPE_DIR, `${siteId}.json`);
}

export async function loadRecipe(siteId: string): Promise<Recipe> {
  const raw = await readFile(recipePath(siteId), "utf8");
  return Recipe.parse(JSON.parse(raw));
}

export async function saveRecipe(recipe: Recipe): Promise<string> {
  const parsed = Recipe.parse(recipe);
  await mkdir(RECIPE_DIR, { recursive: true });
  const target = recipePath(parsed.site_id);
  await writeFile(target, JSON.stringify(parsed, null, 2) + "\n");
  return target;
}

/** Human-readable one-liner, used in heal diffs and logs. */
export function describeStep(step: Step): string {
  switch (step.action) {
    case "goto":
      return `goto ${step.url}`;
    case "fill":
      return `fill ${step.anchor.role} "${step.anchor.name}" = ${
        step.credential_ref ? `<${step.credential_ref}>` : JSON.stringify(step.value)
      }`;
    case "select":
      return `select ${step.anchor.role} "${step.anchor.name}" = ${JSON.stringify(step.value)}`;
    case "click":
      return `click ${step.anchor.role} "${step.anchor.name}"`;
    case "download":
      return `download via ${step.anchor.role} "${step.anchor.name}"`;
  }
}
