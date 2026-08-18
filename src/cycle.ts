/**
 * The scheduler tick: for every due site, replay → verify → heal → replay.
 *
 * At prototype scale this is a sequential loop over a JSON file. At 1000 sites
 * the loop body is unchanged; only the "which sites are due" query and the
 * concurrency around it grow into a real queue.
 *
 * `next_due_at` is the only thing that decides whether work repeats, so it is
 * advanced deliberately and only on outcomes that mean the automation worked.
 */
import { existsSync } from "node:fs";
import { loadRecipe, recipePath, describeStep } from "./recipe.js";
import { replay } from "./replay.js";
import { verify } from "./verify.js";
import { heal, formatDiff } from "./heal.js";
import { discover } from "./discover.js";
import {
  addDays,
  isDue,
  loadRegistry,
  today,
  updateSite,
  type SiteRecord,
} from "./registry.js";

export type Outcome = "verified" | "duplicate" | "quarantined" | "failed" | "healed";

/** Outcomes that mean the automation is working, so the site can go back to sleep. */
const ADVANCES: ReadonlySet<Outcome> = new Set<Outcome>(["verified", "duplicate", "healed"]);

export function credentialsAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

interface RunOptions {
  allowHeal: boolean;
  headless: boolean;
}

async function runSite(site: SiteRecord, options: RunOptions): Promise<{
  outcome: Outcome;
  detail: string;
  sha256?: string;
}> {
  // No recipe yet: this site has never been discovered.
  if (!existsSync(recipePath(site.id))) {
    if (!options.allowHeal) {
      return { outcome: "failed", detail: "no recipe, and discovery is disabled" };
    }
    console.log(`  no recipe yet — discovering`);
    const { turns } = await discover(site.id, { headless: options.headless });
    console.log(`  discovered in ${turns} turns`);
  }

  let recipe = await loadRecipe(site.id);
  let outcome = await replay(recipe, { headless: options.headless });
  let healed = false;

  if (!outcome.ok) {
    const note = `step ${outcome.stepIndex + 1} (${
      outcome.step ? describeStep(outcome.step) : "end of recipe"
    }): ${outcome.error}`;
    console.log(`  replay failed — ${note}`);
    if (!options.allowHeal) {
      return { outcome: "failed", detail: `${note}; healing disabled` };
    }

    console.log(`  healing`);
    const result = await heal(site.id, note, { headless: options.headless });
    console.log(formatDiff(result.diff).replace(/^/gm, "  "));

    recipe = result.recipe;
    outcome = await replay(recipe, { headless: options.headless });
    if (!outcome.ok) {
      return {
        outcome: "failed",
        detail: `still failing after heal: ${outcome.error}`,
      };
    }
    healed = true;
  }

  const result = verify(outcome.download, recipe.expect, site.last_sha256 ?? undefined);
  if (!result.ok) {
    // A wrong-but-plausible document must never be delivered silently.
    return {
      outcome: "quarantined",
      detail: result.failures.join("; "),
      sha256: outcome.download.sha256,
    };
  }

  const detail = `${outcome.download.path} (${outcome.download.bytes} bytes)`;
  if (result.duplicate) {
    return { outcome: "duplicate", detail, sha256: outcome.download.sha256 };
  }
  return {
    outcome: healed ? "healed" : "verified",
    detail,
    sha256: outcome.download.sha256,
  };
}

export async function cycle(options: {
  siteIds?: string[];
  allowHeal?: boolean;
  headless?: boolean;
  force?: boolean;
}): Promise<Record<Outcome, number>> {
  const allowHeal = options.allowHeal ?? credentialsAvailable();
  const headless = options.headless ?? true;
  const registry = await loadRegistry();

  const targets = registry.sites.filter((s) =>
    options.siteIds?.length ? options.siteIds.includes(s.id) : options.force || isDue(s),
  );

  const tally: Record<Outcome, number> = {
    verified: 0,
    duplicate: 0,
    quarantined: 0,
    failed: 0,
    healed: 0,
  };

  if (targets.length === 0) {
    console.log(`nothing due as of ${today()}`);
    return tally;
  }

  console.log(
    `cycle ${today()} — ${targets.length} site(s), healing ${allowHeal ? "on" : "OFF"}\n`,
  );

  for (const site of targets) {
    console.log(`[${site.id}] ${site.name}`);
    let result: Awaited<ReturnType<typeof runSite>>;
    try {
      result = await runSite(site, { allowHeal, headless });
    } catch (err) {
      result = {
        outcome: "failed",
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    tally[result.outcome] += 1;
    const advance = ADVANCES.has(result.outcome);
    await updateSite(site.id, {
      last_run: { at: new Date().toISOString(), status: result.outcome, detail: result.detail },
      ...(result.sha256 ? { last_sha256: result.sha256 } : {}),
      ...(advance ? { next_due_at: addDays(today(), site.interval_days) } : {}),
    });

    console.log(`  ${result.outcome.toUpperCase()}: ${result.detail}`);
    console.log(
      advance
        ? `  next due ${addDays(today(), site.interval_days)}\n`
        : `  stays due (${site.next_due_at})\n`,
    );
  }

  console.log(
    `summary: ` +
      Object.entries(tally)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${k}`)
        .join(", "),
  );
  return tally;
}

// ------------------------------------------------------------------ CLI

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const siteIds = args.filter((a) => !a.startsWith("--"));
  const tally = await cycle({
    siteIds,
    force: args.includes("--force"),
    headless: !args.includes("--headed"),
    allowHeal: args.includes("--no-heal") ? false : undefined,
  });
  if (tally.failed > 0 || tally.quarantined > 0) process.exit(1);
}
