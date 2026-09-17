# ai-scavenge-download

Prototype of hybrid self-healing browser automation for document retrieval from
sites with no API.

An agent **discovers** how to reach a document once and writes a durable
**recipe**. A plain Playwright script **replays** that recipe on every scheduled
run — no model, no per-run token cost. When a site changes and replay breaks,
the agent **heals** the recipe. Nobody hand-writes or hand-maintains a script
per site.

```
discover (rare, agent)  ─┐
                         ├─→  recipe.json  ──→  replay (every run, deterministic)
heal     (on breakage)  ─┘                          │
                    ▲                               ▼
                    └────────── failure ───────  verify  ──→ deliver / quarantine
```

## Quickstart

```bash
npm install
npx playwright install chromium

# terminal 1 — the fake portals
npm run sites

# terminal 2 — replay the seeded recipes and verify the downloads
npm run cycle
```

That runs with no API key: the three recipes in `recipes/` are hand-written
seeds, and replay never calls a model. Run `npm run cycle` twice and the second
pass reports `DUPLICATE` — the files are byte-identical, so there is nothing new
to deliver.

To regenerate a recipe with the agent instead, set `ANTHROPIC_API_KEY` and:

```bash
npm run discover -- a          # rewrites recipes/a.json from the goal alone
npm run cycle                  # heals automatically when replay breaks
```

## Operator console

```bash
npm run console
```

Serves a local UI at [http://localhost:4100](http://localhost:4100) for
viewing registry state and recipes, and triggering discover/replay/heal/cycle
on demand with live log streaming. No auth, and only one run at a time — it
drives real browsers and real logins with real credentials, so treat it as a
privileged local tool, not a public endpoint.

## The mock portals

Three deliberately different navigation shapes, served by `mock-sites/server.ts`:

| id  | portal               | shape                                                      |
| --- | -------------------- | ---------------------------------------------------------- |
| `a` | Northwind Statements | login → dashboard → reports → download                      |
| `b` | Contoso Docs         | login on the landing page → download                        |
| `c` | Acme Filings         | login → portal → documents → set a filter → download the row |

`BREAK=a npm run sites` renames portal A's download link, which is how the heal
demo is triggered.

## Commands

| Command                          | What it does                                        |
| -------------------------------- | --------------------------------------------------- |
| `npm run sites`                  | Serve the mock portals on :4000                     |
| `npm run cycle`                  | Run every due site: replay → verify → heal → replay |
| `npm run cycle -- a --force`     | Run one site regardless of its due date             |
| `npm run cycle -- --no-heal`     | Never call the model; fail instead of healing       |
| `npm run cycle -- --headed`      | Watch the browser                                   |
| `npm run replay -- a`            | Replay one recipe, no registry writes               |
| `npm run discover -- a`          | Re-derive a recipe from the goal                    |
| `npx tsx src/heal.ts a`          | Force a heal and print the recipe diff              |
| `npm run toolcheck`              | Exercise the agent's tool surface with no model     |
| `npm run console`                | Serve the operator console on :4100                 |

`toolcheck` drives the discovery tools with a scripted sequence instead of a
model, through each tool's own schema validation. It covers recipe assembly,
credential substitution, anchor resolution, the download handoff, and the
`recipe_finish` self-check — everything in the discovery path except the model's
choices — at zero token cost, so it works as a CI regression test.

## Design decisions worth knowing

**Tools are isomorphic to recipe steps.** Every mutating tool in `src/tools.ts`
maps to exactly one step type in `src/recipe.ts` and records that step on
success. A discovery run that reaches the document has *already* produced the
recipe — there is no second pass that could translate the transcript wrongly.

**Semantic anchors, not selectors.** Elements are addressed by accessibility
role + accessible name. `src/anchor.ts` is the only place that resolves them, so
discovery and replay cannot drift apart in how they interpret a recipe.

**The model never sees a credential.** It emits `{"credential_ref": "password"}`;
`src/creds.ts` substitutes the real value immediately before Playwright types
it, and redacts any secret that would otherwise reach a log line.

**Accessibility tree, not screenshots.** The agent reads `ariaSnapshot()` output.
It is cheaper than vision, and — more importantly — it is already role+name
shaped, so what the model can perceive is exactly what a recipe can express.

**Verification is the safety net, not replay.** The dangerous failure is the run
that completes and hands over an HTML session-expired page. Content type is
sniffed from magic bytes rather than trusted from the header, and anything
failing the contract is quarantined rather than delivered.

**`next_due_at` advances only on outcomes that mean the automation worked**
(`verified`, `duplicate`, `healed`). Quarantines and failures leave the site
due, which makes the scheduler self-correcting.

**Healing is discovery with a hint.** `src/heal.ts` re-runs discovery with the
broken recipe and the failure supplied as context, rather than patching in
place. One code path for "never seen this site" and "the button moved".

## Model configuration

`claude-opus-5` at `effort: "xhigh"` for discovery and heal, `max_tokens: 32000`
(thinking is on by default on Opus 5 and shares that budget), and top-level
`cache_control` so the system prompt and tool schemas are cached across the
20–40 turns a discovery run takes. Replay and verification use no model at all.

## Layout

```
mock-sites/server.ts   three fake portals
src/recipe.ts          Zod recipe schema + the expect contract
src/anchor.ts          role+name resolution, shared by discovery and replay
src/creds.ts           host-side credential substitution and redaction
src/tools.ts           the agent's tool surface (one tool per recipe step)
src/discover.ts        Tool Runner driver; writes recipes/<id>.json
src/replay.ts          deterministic executor
src/verify.ts          magic-byte sniff, size, filename, hash dedupe
src/heal.ts            re-discovery with a hint + recipe diff
src/cycle.ts           the scheduler tick
src/registry.ts        site records and due-date arithmetic
src/console.ts         operator console server (see "Operator console" above)
public/                operator console frontend (static, served by console.ts)
registry.json          the registry (a Postgres table in disguise)
recipes/               one recipe per site
```

## What this prototype deliberately isn't

Swapped out for local equivalents, each behind a single module:

- **Secrets** — `creds.json` instead of Secrets Manager / Vault (`src/creds.ts`)
- **Registry and queue** — a JSON file and a sequential loop instead of Postgres
  with `SKIP LOCKED` (`src/registry.ts`, `src/cycle.ts`)
- **Storage** — `./downloads` instead of S3 (`src/replay.ts`)
- **API endpoint** — first-party Anthropic API instead of Claude Platform on AWS
  (one client constructor in `src/discover.ts`)

Not built: template/cluster inheritance so sites share a base recipe, the
proactive canary that replays up to but not including the download for
soon-due sites, MFA/CAPTCHA, and the optional LLM verification pass.
