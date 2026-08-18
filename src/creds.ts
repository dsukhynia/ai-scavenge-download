/**
 * Credentials are resolved host-side and never reach the model.
 *
 * The agent emits `{"credential_ref": "password"}`; this module turns that into
 * the actual string immediately before Playwright types it. Prototype storage is
 * a local JSON file — swapping it for Secrets Manager or Vault is a change to
 * `loadCreds` alone, because nothing else in the codebase ever holds a secret.
 */
import { readFile } from "node:fs/promises";

export type SiteCreds = Record<string, string>;
export type CredStore = Record<string, SiteCreds>;

let cache: CredStore | undefined;

export async function loadCreds(file = "creds.json"): Promise<CredStore> {
  if (cache) return cache;
  const raw = await readFile(file, "utf8");
  cache = JSON.parse(raw) as CredStore;
  return cache;
}

export async function credsFor(siteId: string): Promise<SiteCreds> {
  const store = await loadCreds();
  const creds = store[siteId];
  if (!creds) throw new Error(`no credentials configured for site "${siteId}"`);
  return creds;
}

export function resolveRef(creds: SiteCreds, ref: string): string {
  const value = creds[ref];
  if (value === undefined) {
    throw new Error(
      `recipe references credential "${ref}" which is not in the store ` +
        `(available: ${Object.keys(creds).join(", ") || "none"})`,
    );
  }
  return value;
}

/** Guard against a secret leaking into a log line or a model prompt. */
export function redact(text: string, creds: SiteCreds): string {
  let out = text;
  for (const [ref, value] of Object.entries(creds)) {
    if (value.length >= 3) out = out.split(value).join(`<${ref}>`);
  }
  return out;
}
