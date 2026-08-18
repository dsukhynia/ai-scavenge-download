/**
 * The agent's tool surface.
 *
 * Every mutating tool here corresponds to exactly one recipe step type, and
 * records that step on success. A discovery run that reaches the document has,
 * as a side effect, produced a replayable recipe — there is no second pass that
 * could translate the transcript incorrectly.
 *
 * The tools are also the security boundary: `browser_fill` accepts a
 * `credential_ref`, never a secret. The model can name a credential; it cannot
 * read one.
 */
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Page } from "playwright";
import { resolveAnchor, snapshot } from "./anchor.js";
import { performDownload } from "./replay.js";
import type { DownloadInfo } from "./verify.js";
import { resolveRef, type SiteCreds } from "./creds.js";
import type { Anchor, Expect, Step } from "./recipe.js";

/** Bounds per-turn cost; these pages are small, real portals need chunking. */
const MAX_SNAPSHOT_CHARS = 8000;

export interface DiscoverySession {
  page: Page;
  siteId: string;
  goal: string;
  creds: SiteCreds;
  /** Steps recorded so far — becomes `recipe.steps`. */
  steps: Step[];
  download?: DownloadInfo;
  expect?: Expect;
  log: (line: string) => void;
}

const ROLES = ["textbox", "button", "link", "combobox", "checkbox"] as const;

const anchorFields = {
  role: z.enum(ROLES).describe("ARIA role of the target element"),
  name: z
    .string()
    .min(1)
    .describe(
      "Accessible name exactly as it appears in the snapshot. Matched " +
        "case-insensitively as a substring, so prefer the shortest stable wording.",
    ),
};

async function view(session: DiscoverySession, note: string): Promise<string> {
  const tree = await snapshot(session.page);
  const clipped =
    tree.length > MAX_SNAPSHOT_CHARS
      ? `${tree.slice(0, MAX_SNAPSHOT_CHARS)}\n…(snapshot truncated)`
      : tree;
  return `${note}\n\n${clipped}`;
}

/** Tool failures are recoverable context, not exceptions — hand the model the page back. */
async function fail(session: DiscoverySession, err: unknown): Promise<string> {
  const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
  return view(session, `ERROR: ${message}`);
}

export function makeTools(session: DiscoverySession) {
  const record = (step: Step): void => {
    session.steps.push(step);
  };

  const browser_snapshot = betaZodTool({
    name: "browser_snapshot",
    description:
      "Read the current page as an accessibility tree (roles and names). " +
      "Use this to orient yourself before acting. Does not change the page " +
      "and is not recorded as a recipe step.",
    inputSchema: z.object({}),
    run: async () => view(session, "current page:"),
  });

  const browser_goto = betaZodTool({
    name: "browser_goto",
    description: "Navigate directly to a URL. Recorded as a `goto` step.",
    inputSchema: z.object({ url: z.string().url() }),
    run: async ({ url }) => {
      try {
        await session.page.goto(url, { waitUntil: "load", timeout: 15_000 });
        record({ action: "goto", url });
        session.log(`goto ${url}`);
        return view(session, `navigated to ${url}`);
      } catch (err) {
        return fail(session, err);
      }
    },
  });

  const browser_fill = betaZodTool({
    name: "browser_fill",
    description:
      "Type into a text field. For usernames, passwords, and any other secret, " +
      "pass `credential_ref` naming the stored credential — the value is " +
      "substituted host-side and is never shown to you. Use `value` only for " +
      "non-secret input such as a date or a search term. Recorded as a `fill` step.",
    inputSchema: z.object({
      ...anchorFields,
      credential_ref: z
        .string()
        .optional()
        .describe("Name of a stored credential, e.g. \"username\" or \"password\""),
      value: z.string().optional().describe("Literal non-secret text"),
    }),
    run: async ({ role, name, credential_ref, value }) => {
      const anchor: Anchor = { role, name };
      try {
        if ((credential_ref === undefined) === (value === undefined)) {
          return "ERROR: pass exactly one of credential_ref or value.";
        }
        const text =
          credential_ref !== undefined
            ? resolveRef(session.creds, credential_ref)
            : value!;
        await resolveAnchor(session.page, anchor).fill(text, { timeout: 10_000 });
        record({ action: "fill", anchor, credential_ref, value });
        session.log(
          `fill ${role} "${name}" = ${credential_ref ? `<${credential_ref}>` : JSON.stringify(value)}`,
        );
        return view(session, `filled ${role} "${name}"`);
      } catch (err) {
        return fail(session, err);
      }
    },
  });

  const browser_select = betaZodTool({
    name: "browser_select",
    description:
      "Choose an option in a dropdown by its option value. Recorded as a `select` step.",
    inputSchema: z.object({
      name: z.string().min(1).describe("Accessible name of the dropdown"),
      value: z.string().describe("The option's value attribute, not its label"),
    }),
    run: async ({ name, value }) => {
      const anchor: Anchor = { role: "combobox", name };
      try {
        await resolveAnchor(session.page, anchor).selectOption(value, {
          timeout: 10_000,
        });
        record({ action: "select", anchor, value });
        session.log(`select "${name}" = ${value}`);
        return view(session, `selected ${JSON.stringify(value)} in "${name}"`);
      } catch (err) {
        return fail(session, err);
      }
    },
  });

  const browser_click = betaZodTool({
    name: "browser_click",
    description:
      "Click a button or link that does NOT produce a file download. " +
      "Recorded as a `click` step.",
    inputSchema: z.object(anchorFields),
    run: async ({ role, name }) => {
      const anchor: Anchor = { role, name };
      try {
        await resolveAnchor(session.page, anchor).click({ timeout: 10_000 });
        await session.page
          .waitForLoadState("load", { timeout: 10_000 })
          .catch(() => {});
        record({ action: "click", anchor });
        session.log(`click ${role} "${name}"`);
        return view(session, `clicked ${role} "${name}"`);
      } catch (err) {
        return fail(session, err);
      }
    },
  });

  const browser_download = betaZodTool({
    name: "browser_download",
    description:
      "Click the control that produces the target document. Saves the file and " +
      "reports its real type, size, and filename. Recorded as a `download` step. " +
      "Call recipe_finish after this succeeds.",
    inputSchema: z.object(anchorFields),
    run: async ({ role, name }) => {
      const anchor: Anchor = { role, name };
      try {
        const info = await performDownload(session.page, anchor, session.siteId);
        record({ action: "download", anchor });
        session.download = info;
        session.log(
          `download ${role} "${name}" -> ${info.suggestedFilename} ` +
            `(${info.bytes} bytes, ${info.contentType})`,
        );
        if (info.contentType === "text/html") {
          return (
            `Downloaded "${info.suggestedFilename}" but it sniffs as text/html — ` +
            `that is usually an error or login page, not the document. ` +
            `Do not call recipe_finish; go back and find the real document.`
          );
        }
        return (
          `Downloaded "${info.suggestedFilename}"\n` +
          `  type:  ${info.contentType}\n` +
          `  bytes: ${info.bytes}\n\n` +
          `Now call recipe_finish with a filename_pattern that will still match ` +
          `next month's file, and a min_bytes floor.`
        );
      } catch (err) {
        return fail(session, err);
      }
    },
  });

  const recipe_finish = betaZodTool({
    name: "recipe_finish",
    description:
      "Record the verification contract and end the task. Only valid after a " +
      "successful browser_download.",
    inputSchema: z.object({
      filename_pattern: z
        .string()
        .describe(
          "JavaScript regex the downloaded filename must match on future runs. " +
            "Generalize anything that varies by period — e.g. a file named " +
            "\"filing-2026-Q2.pdf\" should give ^filing-\\\\d{4}-Q\\\\d\\\\.pdf$.",
        ),
      min_bytes: z
        .number()
        .int()
        .positive()
        .describe("Reject anything smaller. Set it well below the observed size."),
    }),
    run: async ({ filename_pattern, min_bytes }) => {
      const info = session.download;
      if (!info) return "ERROR: no download has succeeded yet.";

      let pattern: RegExp;
      try {
        pattern = new RegExp(filename_pattern);
      } catch {
        return `ERROR: ${filename_pattern} is not a valid regex. Try again.`;
      }
      // Self-check: the contract must accept the file we actually just got.
      if (!pattern.test(info.suggestedFilename)) {
        return (
          `ERROR: /${filename_pattern}/ does not match the file you just ` +
          `downloaded ("${info.suggestedFilename}"). Fix the pattern and retry.`
        );
      }
      if (min_bytes > info.bytes) {
        return (
          `ERROR: min_bytes ${min_bytes} exceeds the observed size ${info.bytes}. ` +
          `Lower it and retry.`
        );
      }

      session.expect = {
        // Taken from the sniff, not from the model: the real type is a fact,
        // not a judgement call, so there is nothing for the model to get wrong.
        content_type: info.contentType,
        filename_pattern,
        min_bytes,
      };
      session.log(`finish: /${filename_pattern}/, min ${min_bytes} bytes`);
      return "Recipe accepted. Task complete — stop here.";
    },
  });

  return [
    browser_snapshot,
    browser_goto,
    browser_fill,
    browser_select,
    browser_click,
    browser_download,
    recipe_finish,
  ];
}
