/**
 * Local operator console: view registry state and recipes, trigger
 * discover/replay/heal/cycle on demand, and watch console.log output stream
 * live over SSE while a run is in progress.
 *
 * No auth, and only one run at a time (a global lock, not per-site) — this
 * drives real browsers and real logins with real credentials, so treat it
 * like a privileged local tool, not a public endpoint.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { loadRecipe, recipePath } from "./recipe.js";
import { discover } from "./discover.js";
import { heal, formatDiff } from "./heal.js";
import { cycle } from "./cycle.js";
import { loadRegistry, saveRegistry, today } from "./registry.js";

const PORT = Number(process.env.CONSOLE_PORT ?? 4100);

// ------------------------------------------------------------- run tracking

interface RunState {
  kind: string;
  siteId?: string;
  emitter: EventEmitter;
  logs: string[];
  status: "running" | "done" | "error";
  result?: unknown;
  error?: string;
}

const runs = new Map<string, RunState>();
let busyRunId: string | null = null;

class BusyError extends Error {}

function startRun(kind: string, siteId: string | undefined, fn: () => Promise<unknown>): string {
  if (busyRunId) throw new BusyError(`run "${busyRunId}" is still in progress`);

  const runId = randomUUID();
  const state: RunState = { kind, siteId, emitter: new EventEmitter(), logs: [], status: "running" };
  runs.set(runId, state);
  busyRunId = runId;

  // Every module in this codebase logs with plain console.log rather than an
  // injectable logger, and only one run is ever active at a time (the lock
  // above), so a temporary global patch is enough to capture output live.
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
    state.logs.push(line);
    state.emitter.emit("line", line);
    originalLog(...args);
  };

  fn()
    .then((result) => {
      state.status = "done";
      state.result = result;
    })
    .catch((err) => {
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      console.log = originalLog;
      busyRunId = null;
      state.emitter.emit("end");
    });

  return runId;
}

// ------------------------------------------------------------------- app

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

app.get("/api/state", async (_req, res) => {
  const registry = await loadRegistry();
  res.json({
    busy: busyRunId ? { runId: busyRunId, ...runs.get(busyRunId) } : null,
    sites: registry.sites.map((s) => ({ ...s, hasRecipe: existsSync(recipePath(s.id)) })),
  });
});

app.get("/api/recipe/:siteId", async (req, res) => {
  try {
    res.json(await loadRecipe(req.params.siteId));
  } catch {
    res.status(404).json({ error: `no recipe for "${req.params.siteId}"` });
  }
});

app.post("/api/run", (req, res) => {
  const { action, siteId, force, note } = req.body ?? {};
  try {
    let runId: string;
    switch (action) {
      case "cycle":
        runId = startRun("cycle", undefined, () => cycle({ force: Boolean(force) }));
        break;
      case "replay":
        if (!siteId) return void res.status(400).json({ error: "siteId required" });
        runId = startRun("replay", siteId, () =>
          cycle({ siteIds: [siteId], force: true, allowHeal: false }),
        );
        break;
      case "discover":
        if (!siteId) return void res.status(400).json({ error: "siteId required" });
        runId = startRun("discover", siteId, () => discover(siteId, { headless: true }));
        break;
      case "heal":
        if (!siteId) return void res.status(400).json({ error: "siteId required" });
        runId = startRun("heal", siteId, async () => {
          const result = await heal(siteId, note || "manual heal requested via console", {
            headless: true,
          });
          console.log(formatDiff(result.diff));
          return result;
        });
        break;
      default:
        return void res.status(400).json({ error: `unknown action "${action}"` });
    }
    res.json({ runId });
  } catch (err) {
    if (err instanceof BusyError) {
      return void res.status(409).json({ error: err.message, runId: busyRunId });
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Puts every site back to a true never-run state: registry due-dates/last-run/
 * hash reset, recipes deleted, and the scratch downloads/traces dirs emptied.
 * Creds are untouched. The next run for any site must re-discover from
 * scratch — a real browser session and a real Claude API call.
 */
app.post("/api/reset", async (_req, res) => {
  if (busyRunId) {
    return void res.status(409).json({ error: `run "${busyRunId}" is still in progress` });
  }
  try {
    const registry = await loadRegistry();
    const dueToday = today();
    registry.sites = registry.sites.map((s) => ({
      ...s,
      next_due_at: dueToday,
      last_sha256: null,
      last_run: null,
    }));
    await saveRegistry(registry);
    await Promise.all(registry.sites.map((s) => rm(recipePath(s.id), { force: true })));
    await rm("downloads", { recursive: true, force: true });
    await rm("traces", { recursive: true, force: true });
    res.json({ ok: true, sitesReset: registry.sites.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/stream/:runId", (req, res) => {
  const state = runs.get(req.params.runId);
  if (!state) return void res.status(404).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  for (const line of state.logs) send({ line });

  if (state.status !== "running") {
    send({ done: true, status: state.status, result: state.result, error: state.error });
    return void res.end();
  }

  const onLine = (line: string) => send({ line });
  const onEnd = () => {
    send({ done: true, status: state.status, result: state.result, error: state.error });
    res.end();
  };
  state.emitter.on("line", onLine);
  state.emitter.on("end", onEnd);
  req.on("close", () => {
    state.emitter.off("line", onLine);
    state.emitter.off("end", onEnd);
  });
});

app.listen(PORT, () => {
  console.log(`console listening on http://localhost:${PORT}`);
});
