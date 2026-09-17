/**
 * Exercises the discovery tool surface without calling a model.
 *
 * A scripted sequence stands in for the agent: each call goes through the
 * tool's own Zod `parse` (so schema bugs surface) and then its `run`. This
 * covers everything in the discovery path except the model's choices — which
 * means recipe assembly, credential substitution, anchor resolution, the
 * download handoff, and the recipe_finish self-check are all regression-tested
 * at zero token cost.
 *
 *   npx tsx src/toolcheck.ts
 */
import { chromium } from "playwright";
import { makeTools, type DiscoverySession } from "./tools.js";
import { credsFor } from "./creds.js";
import { describeStep } from "./recipe.js";
import { snapshot } from "./anchor.js";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const SITE = "a";

const EXPECTED_STEPS = [
  'goto http://localhost:4000/a/login',
  'fill textbox "Username" = <username>',
  'fill textbox "Password" = <password>',
  'click button "Sign in"',
  'click link "Reports"',
  'download via link "Download Monthly Statement"',
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();

const session: DiscoverySession = {
  page,
  siteId: SITE,
  goal: "Log in and download the latest monthly statement as a PDF.",
  creds: await credsFor(SITE),
  steps: [],
  log: () => {},
};

/**
 * Each tool has its own input type, so the array is a union. Looking them up by
 * name erases that, exactly as the runner does when it dispatches on the name
 * in a tool_use block.
 */
interface LooseTool {
  name: string;
  parse: (content: unknown) => unknown;
  run: (args: any) => unknown;
}

const tools = makeTools(session);
const byName = new Map<string, LooseTool>(
  tools.map((t) => [t.name, t as unknown as LooseTool]),
);

/** Invoke exactly as the runner would: validate raw input, then run. */
async function call(name: string, input: unknown): Promise<string> {
  const tool = byName.get(name);
  if (!tool) throw new Error(`no tool named ${name}`);
  const result = await tool.run(tool.parse(input));
  return typeof result === "string" ? result : JSON.stringify(result);
}

try {
  console.log("tool surface");
  check("all 7 tools registered", tools.length === 7, tools.map((t) => t.name).join(", "));

  // ---------------------------------------------------------- happy path
  console.log("\nscripted discovery of site a");
  await call("browser_goto", { url: "http://localhost:4000/a/login" });

  const snap = await call("browser_snapshot", {});
  check("snapshot exposes the login controls by role+name",
    snap.includes("Username") && snap.includes("Password") && snap.includes("Sign in"));
  check("snapshot is not recorded as a step", session.steps.length === 1);

  await call("browser_fill", {
    role: "textbox", name: "Username", credential_ref: "username",
  });
  await call("browser_fill", {
    role: "textbox", name: "Password", credential_ref: "password",
  });
  const afterLogin = await call("browser_click", { role: "button", name: "Sign in" });
  check("login succeeded (reached the dashboard)", afterLogin.includes("/a/dashboard"));

  await call("browser_click", { role: "link", name: "Reports" });
  const dl = await call("browser_download", {
    role: "link", name: "Download Monthly Statement",
  });
  check("download reports a real PDF", dl.includes("application/pdf"), dl.split("\n")[0]);

  // ------------------------------------------------- recipe_finish gating
  console.log("\nrecipe_finish self-check");
  const badPattern = await call("recipe_finish", {
    filename_pattern: "^wrong-.*\\.pdf$", min_bytes: 100,
  });
  check("rejects a pattern that misses the file just downloaded",
    badPattern.startsWith("ERROR"));
  check("no contract recorded on rejection", session.expect === undefined);

  const badSize = await call("recipe_finish", {
    filename_pattern: "^northwind-statement\\.pdf$", min_bytes: 999_999,
  });
  check("rejects a min_bytes above the observed size", badSize.startsWith("ERROR"));

  const good = await call("recipe_finish", {
    filename_pattern: "^northwind-.*\\.pdf$", min_bytes: 300,
  });
  check("accepts a valid contract", good.includes("accepted"));
  check("content_type is sniffed, not model-supplied",
    session.expect?.content_type === "application/pdf");

  // -------------------------------------------------------- recipe shape
  console.log("\nrecorded recipe");
  const recorded = session.steps.map(describeStep);
  for (const line of recorded) console.log(`    ${line}`);
  check("steps match the hand-written seed recipe",
    JSON.stringify(recorded) === JSON.stringify(EXPECTED_STEPS));

  const serialized = JSON.stringify(session.steps);
  check("no credential value leaked into the recipe",
    !serialized.includes("testa"));

  // -------------------------------------------------------- error paths
  console.log("\nerror handling");
  const missing = await call("browser_click", { role: "link", name: "Nonexistent Link" });
  check("missing anchor returns a recoverable error", missing.startsWith("ERROR"));
  check("error hands the page back to the model", missing.includes("url:"));

  const both = await call("browser_fill", {
    role: "textbox", name: "Username", credential_ref: "username", value: "literal",
  });
  check("rejects credential_ref and value together", both.startsWith("ERROR"));

  const unknownRef = await call("browser_fill", {
    role: "textbox", name: "Username", credential_ref: "not_a_real_ref",
  });
  check("rejects an unknown credential_ref", unknownRef.startsWith("ERROR"));

  let schemaRejected = false;
  try {
    byName.get("browser_click")!.parse({ role: "banana", name: "x" });
  } catch {
    schemaRejected = true;
  }
  check("tool schema rejects an invalid role", schemaRejected);

  check("failed calls recorded no extra steps", session.steps.length === 6);

  // -------------------------------- what the model actually reads, verbatim
  console.log("\nsample of the model's page input (site a, reports page):");
  console.log(
    (await snapshot(page))
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
  );
} finally {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
