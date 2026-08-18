/**
 * Deterministic replay. No model in this path — this is what runs on every
 * scheduled download, and it must stay cheap, fast, and auditable.
 *
 * On failure it captures the step index, the live URL, and an accessibility
 * snapshot. That triple is exactly what the heal loop needs to attempt a
 * localized re-location before falling back to full re-discovery.
 */
import { chromium, type Browser, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type Anchor, type Recipe, type Step, describeStep } from "./recipe.js";
import { resolveAnchor, snapshot } from "./anchor.js";
import { credsFor, resolveRef, redact, type SiteCreds } from "./creds.js";
import { inspect, type DownloadInfo } from "./verify.js";

const STEP_TIMEOUT_MS = 10_000;

export interface ReplayOptions {
  headless?: boolean;
  downloadRoot?: string;
  traceDir?: string;
}

export type ReplayOutcome =
  | { ok: true; download: DownloadInfo; steps: number }
  | {
      ok: false;
      stepIndex: number;
      step: Step | null;
      error: string;
      url: string;
      snapshot: string;
      trace?: string;
    };

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Shared by replay and by the discovery agent's `browser_download` tool, so a
 * file obtained during discovery is obtained exactly the way replay will do it.
 */
export async function performDownload(
  page: Page,
  anchor: Anchor,
  siteId: string,
  downloadRoot = "downloads",
): Promise<DownloadInfo> {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: STEP_TIMEOUT_MS }),
    resolveAnchor(page, anchor).click({ timeout: STEP_TIMEOUT_MS }),
  ]);
  const dir = path.join(downloadRoot, siteId, dateStamp());
  await mkdir(dir, { recursive: true });
  const suggested = download.suggestedFilename();
  const target = path.join(dir, suggested);
  await download.saveAs(target);
  return inspect(target, suggested);
}

async function runStep(
  page: Page,
  step: Step,
  creds: SiteCreds,
  siteId: string,
  downloadRoot: string,
): Promise<DownloadInfo | undefined> {
  switch (step.action) {
    case "goto": {
      await page.goto(step.url, { waitUntil: "load", timeout: STEP_TIMEOUT_MS });
      return;
    }

    case "fill": {
      // The one place a secret becomes a real string, immediately before use.
      const value =
        step.credential_ref !== undefined
          ? resolveRef(creds, step.credential_ref)
          : step.value;
      if (value === undefined) {
        throw new Error("fill step has neither credential_ref nor value");
      }
      await resolveAnchor(page, step.anchor).fill(value, { timeout: STEP_TIMEOUT_MS });
      return;
    }

    case "select": {
      await resolveAnchor(page, step.anchor).selectOption(step.value, {
        timeout: STEP_TIMEOUT_MS,
      });
      return;
    }

    case "click": {
      await resolveAnchor(page, step.anchor).click({ timeout: STEP_TIMEOUT_MS });
      // Most clicks here navigate; some don't. Either is fine.
      await page.waitForLoadState("load", { timeout: STEP_TIMEOUT_MS }).catch(() => {});
      return;
    }

    case "download":
      return performDownload(page, step.anchor, siteId, downloadRoot);
  }
}

export async function replay(
  recipe: Recipe,
  options: ReplayOptions = {},
): Promise<ReplayOutcome> {
  const {
    headless = true,
    downloadRoot = "downloads",
    traceDir = "traces",
  } = options;

  const creds = await credsFor(recipe.site_id).catch(() => ({}) as SiteCreds);
  const browser: Browser = await chromium.launch({ headless });
  const context = await browser.newContext({ acceptDownloads: true });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();

  let download: DownloadInfo | undefined;
  let failure: Omit<Extract<ReplayOutcome, { ok: false }>, "ok" | "trace"> | undefined;

  try {
    for (const [index, step] of recipe.steps.entries()) {
      try {
        const produced = await runStep(page, step, creds, recipe.site_id, downloadRoot);
        if (produced) download = produced;
      } catch (err) {
        failure = {
          stepIndex: index,
          step,
          // First line only: Playwright appends a long call log that adds
          // nothing the snapshot and trace don't already carry.
          error: redact(
            (err instanceof Error ? err.message : String(err)).split("\n")[0]!,
            creds,
          ),
          url: page.url(),
          snapshot: await snapshot(page).catch(() => "(snapshot unavailable)"),
        };
        break;
      }
    }

    if (!failure && !download) {
      failure = {
        stepIndex: recipe.steps.length,
        step: null,
        error: "recipe completed without producing a download",
        url: page.url(),
        snapshot: await snapshot(page).catch(() => "(snapshot unavailable)"),
      };
    }

    if (failure) {
      // Keep a trace only when something went wrong — traces are big.
      await mkdir(traceDir, { recursive: true });
      const trace = path.join(
        traceDir,
        `${recipe.site_id}-${Date.now()}.zip`,
      );
      await context.tracing.stop({ path: trace });
      return { ok: false, ...failure, trace };
    }

    await context.tracing.stop();
    return { ok: true, download: download!, steps: recipe.steps.length };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ CLI

if (import.meta.url === `file://${process.argv[1]}`) {
  const siteId = process.argv[2];
  if (!siteId) {
    console.error("usage: npm run replay -- <site-id> [--headed]");
    process.exit(2);
  }
  const { loadRecipe } = await import("./recipe.js");
  const { verify } = await import("./verify.js");
  const recipe = await loadRecipe(siteId);

  console.log(`replaying ${siteId}: ${recipe.goal}`);
  for (const [i, s] of recipe.steps.entries()) {
    console.log(`  ${String(i + 1).padStart(2)}. ${describeStep(s)}`);
  }

  const outcome = await replay(recipe, { headless: !process.argv.includes("--headed") });

  if (!outcome.ok) {
    console.error(`\nFAILED at step ${outcome.stepIndex + 1}: ${outcome.error}`);
    console.error(`  url:   ${outcome.url}`);
    if (outcome.trace) console.error(`  trace: npx playwright show-trace ${outcome.trace}`);
    process.exit(1);
  }

  const result = verify(outcome.download, recipe.expect);
  console.log(`\ndownloaded ${outcome.download.path}`);
  console.log(
    `  ${outcome.download.bytes} bytes, ${outcome.download.contentType}, ` +
      `sha256 ${outcome.download.sha256.slice(0, 12)}…`,
  );
  if (!result.ok) {
    console.error(`\nQUARANTINED — verification failed:`);
    for (const f of result.failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`  verification passed`);
}
