/**
 * Discovery: the expensive, rare path. An agent drives a real browser from a
 * natural-language goal and leaves behind a recipe that replay can run for
 * free thereafter.
 *
 * This is also the heal path — healing is just discovery re-run with the broken
 * recipe supplied as a hint (see src/heal.ts).
 */
import Anthropic from "@anthropic-ai/sdk";
import { chromium } from "playwright";
import { makeTools, type DiscoverySession } from "./tools.js";
import { credsFor } from "./creds.js";
import { saveRecipe, describeStep, type Recipe } from "./recipe.js";
import { getSite } from "./registry.js";

export const MODEL = "claude-opus-5";

const SYSTEM = `You automate document retrieval on websites you have not seen before.

Your tools are the recording surface for a durable, replayable recipe: every
browser action you take is written down as a step, and that recipe will later be
replayed by a plain script with no model involved. Two consequences:

- Choose anchors that will still be correct weeks from now. Prefer the shortest
  stable accessible name over a long one that includes volatile text such as a
  date, a count, or a user's name.
- Take only the actions the task needs. Exploratory clicks are recorded too, and
  a recipe with detours is a recipe with more ways to break. If you land
  somewhere unhelpful, navigate back deliberately rather than leaving the detour
  in the path.

You cannot see credential values, and you do not need them: pass a
credential_ref to browser_fill and the runner substitutes the secret before
typing it.

Work the page from its accessibility tree. When you reach the document, call
browser_download, then recipe_finish with a filename pattern that will still
match the next period's file. Stop after recipe_finish.`;

export interface DiscoverOptions {
  headless?: boolean;
  /** A previously working recipe whose replay just broke — the heal hint. */
  brokenRecipe?: Recipe;
  failureNote?: string;
  maxIterations?: number;
}

export interface DiscoverResult {
  recipe: Recipe;
  turns: number;
  usage: { input: number; output: number; cacheRead: number };
}

export async function discover(
  siteId: string,
  options: DiscoverOptions = {},
): Promise<DiscoverResult> {
  const { headless = true, maxIterations = 40 } = options;
  const site = await getSite(siteId);
  const creds = await credsFor(siteId);

  const client = new Anthropic();
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const session: DiscoverySession = {
    page,
    siteId,
    goal: site.goal,
    creds,
    steps: [],
    log: (line) => console.log(`    · ${line}`),
  };

  let task =
    `Site: ${site.name}\n` +
    `Start URL: ${site.start_url}\n` +
    `Available credential refs: ${Object.keys(creds).join(", ")}\n\n` +
    `Task: ${site.goal}`;

  if (options.brokenRecipe) {
    task +=
      `\n\nThis site previously worked with the recipe below, which has now ` +
      `stopped replaying. Treat it as a strong hint about the intended path — ` +
      `the site has probably changed in one place, not everywhere.\n\n` +
      options.brokenRecipe.steps
        .map((s, i) => `  ${i + 1}. ${describeStep(s)}`)
        .join("\n");
    if (options.failureNote) task += `\n\nReplay failed with: ${options.failureNote}`;
  }

  const usage = { input: 0, output: 0, cacheRead: 0 };
  let turns = 0;

  try {
    const runner = client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 32_000,
      stream: true,
      // Agentic browser work is exactly what xhigh is for.
      output_config: { effort: "xhigh" },
      // Stable prefix (system + tool schemas) is worth caching across the
      // 20-40 turns a discovery run takes.
      cache_control: { type: "ephemeral" },
      system: SYSTEM,
      tools: makeTools(session),
      messages: [{ role: "user", content: task }],
      max_iterations: maxIterations,
    });

    for await (const stream of runner) {
      turns += 1;
      const message = await stream.finalMessage();
      usage.input += message.usage.input_tokens;
      usage.output += message.usage.output_tokens;
      usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
      if (session.expect) break; // recipe_finish succeeded
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (!session.expect || session.steps.length === 0) {
    throw new Error(
      `discovery did not produce a recipe for "${siteId}" after ${turns} turns`,
    );
  }

  const recipe: Recipe = {
    version: 1,
    site_id: siteId,
    goal: site.goal,
    steps: session.steps,
    expect: session.expect,
    generated_at: new Date().toISOString(),
    generated_by: MODEL,
  };
  await saveRecipe(recipe);
  return { recipe, turns, usage };
}

// ------------------------------------------------------------------ CLI

if (import.meta.url === `file://${process.argv[1]}`) {
  const siteId = process.argv[2];
  if (!siteId) {
    console.error("usage: npm run discover -- <site-id> [--headed]");
    process.exit(2);
  }
  const site = await getSite(siteId);
  console.log(`discovering ${siteId} (${site.name})`);
  console.log(`  goal: ${site.goal}\n`);

  const { recipe, turns, usage } = await discover(siteId, {
    headless: !process.argv.includes("--headed"),
  });

  console.log(`\nrecipe written to recipes/${siteId}.json (${turns} turns)`);
  for (const [i, s] of recipe.steps.entries()) {
    console.log(`  ${String(i + 1).padStart(2)}. ${describeStep(s)}`);
  }
  console.log(
    `  expect: ${recipe.expect.content_type}, ` +
      `/${recipe.expect.filename_pattern}/, min ${recipe.expect.min_bytes} bytes`,
  );
  console.log(
    `  tokens: ${usage.input} in (+${usage.cacheRead} cached) / ${usage.output} out`,
  );
}
