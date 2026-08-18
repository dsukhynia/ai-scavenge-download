/**
 * The site registry. A JSON file for the prototype; the shape is deliberately
 * the one a Postgres table would have, so moving it later is a driver swap.
 *
 * `next_due_at` advances only on a *verified* download — a run that fails
 * verification stays due, which is what makes the scheduler self-correcting.
 */
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

export const SiteRecord = z.object({
  id: z.string().min(1),
  name: z.string(),
  start_url: z.string().url(),
  goal: z.string().min(1),
  interval_days: z.number().int().positive().default(10),
  next_due_at: z.string().describe("YYYY-MM-DD; run when today >= this"),
  last_sha256: z.string().nullable().default(null),
  last_run: z
    .object({
      at: z.string(),
      status: z.enum(["verified", "duplicate", "quarantined", "failed", "healed"]),
      detail: z.string().default(""),
    })
    .nullable()
    .default(null),
});
export type SiteRecord = z.infer<typeof SiteRecord>;

export const Registry = z.object({ sites: z.array(SiteRecord) });
export type Registry = z.infer<typeof Registry>;

const FILE = "registry.json";

export async function loadRegistry(): Promise<Registry> {
  return Registry.parse(JSON.parse(await readFile(FILE, "utf8")));
}

export async function saveRegistry(registry: Registry): Promise<void> {
  await writeFile(FILE, JSON.stringify(Registry.parse(registry), null, 2) + "\n");
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isDue(site: SiteRecord, asOf = today()): boolean {
  return site.next_due_at <= asOf;
}

export async function getSite(id: string): Promise<SiteRecord> {
  const registry = await loadRegistry();
  const site = registry.sites.find((s) => s.id === id);
  if (!site) throw new Error(`site "${id}" is not in ${FILE}`);
  return site;
}

/** Read-modify-write a single site record. */
export async function updateSite(
  id: string,
  patch: Partial<SiteRecord>,
): Promise<void> {
  const registry = await loadRegistry();
  const index = registry.sites.findIndex((s) => s.id === id);
  if (index === -1) throw new Error(`site "${id}" is not in ${FILE}`);
  registry.sites[index] = { ...registry.sites[index]!, ...patch };
  await saveRegistry(registry);
}
