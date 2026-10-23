# ROADMAP — perfect-harness

Continuation guide for any agent picking this project up. Read
`docs/ARCHITECTURE.md` for internals and `docs/RECON-DSH.md` for the
empirical host truth — this file is the *where we are / what's next* map.

## Project in one paragraph

Vendor-agnostic implementation of Google's Harness² method: improve the
*harness around a fixed model* (prompts, tools, memory, skills, scripts,
presets, orchestration) — never the weights. A pure core
(`lib/core/`, no I/O, no host imports) drives propose → probe → compose →
blind-select → gate → reflect over substrates in `lib/adapters/`. The
primary substrate is DeepSeek Harness (`lib/adapters/dsh/`), verified live
on a headless profile. A desktop plugin (`plugins/ph-dsh/`) exposes the
loop to interactive sessions with a real human gate.

## Ground rules (inviolable)

1. `lib/core/` — no host imports, no I/O, no model calls. Objects in,
   decisions out.
2. `lib/adapters/` — the only host-aware layer. Returns evidence that
   passes `normalizeEvidence`.
3. Evidence never carries verdicts (`score`/`rubric`/`passed`).
4. Base is always in the selection pool; single-candidate adoption is
   banned.
5. Missing capability → honest degradation + note, never a fake.
6. Docs are orientation; the installed host is truth. Verify on the wire.
7. This is a RESEARCH project. Live runs spend real tokens on the
   deployer's provider — there is no cost cap.

## Commands

```sh
npm test          # node --test tests/**/*.test.mjs  (106 tests green)
npm run check     # node --check on every lib file
```

Node `^22.19 || >=24`. Plain ESM, no build step.

## Verified-complete milestones

| # | Milestone | Commit | Proof |
|---|-----------|--------|-------|
| M0 | DSH seam reconnaissance (7 capabilities) | — | `docs/RECON-DSH.md` |
| M1 | Vendor-agnostic core (spec/evidence/caps/lessons/selection/loop) | early | unit + mock seam-proof suite |
| M2 | Mock substrate | early | `tests/loop.test.mjs` |
| M3 | DSH in-process substrate (mount/run/dispose, preset path, seeded fork) | `7428d78`,`8d9de57` | live headless probe: PROBE-OK, restrict 25→1, fork context inheritance, registered preset rows |
| M4 | Live model channels (propose/compose/select/reflect) | `5b19096` | full live improvement step; found+fixed dot-notation patches & `UNSUPPORTED_REASONING_EFFORT` |
| M5 | First live lesson + file persistence | (M3 era) | `admitLesson` ref resolution, `file-lessons.js`, cross-process |
| M6 | scripts → `file://` preset rows | `95b0110` | live: materialized row in registered preset |
| M7 | External-process substrate (`dsh headless --json`) | `c0d5167` | NDJSON→Evidence; kills in-process teardown race |
| M8 | Multi-task campaign (`runCampaign`) | `3cb47c2` | adoptedSpec carry-forward, metrics, crash survival |
| M9 | PTC events → Evidence | `91e3ec9` | `DSH_TOOLS_MODE=ptc` live; real dispatch payloads mapped |
| M10 | Channel retries + union compose + usage→cost | `a9b3e07` | live `costUsd` on real route; deterministic disjoint-leaf merge |
| M11 | Desktop human gate + `/ph` plugin | `c34eae1` | contract-verified `userQuestions.ask` waterfall |
| M12 | Docs: ARCHITECTURE + research/token disclaimer | `9f3c2ad` | — |
| M13 | Free-route verification (`openrouter/free`, `inkling:free`) | `e96392e` | live tool-calling runs at $0; `tests/live/free.patch.yml` |

## Open threads — what remains

| Thread | State | How to continue |
|---|---|---|
| **Desktop live verification** | Plugin written, contract-tested, never run on a real desktop profile | Mount `plugins/ph-dsh/index.mjs` into `~/.dsh/profiles/desktop/cordis.patch.yml` (insert row + free-model config — see README recipe); run `/ph status`, then `/ph step <task>`; confirm the UI gate dialog appears; check `ph-lessons.json` |
| **Real user corrections** | `user/message` `source.kind:'user'` → `correction` step is mapped + tested on injected events | In an interactive desktop session, interrupt a running task mid-turn; the correction must appear as a `correction` step in that run's Evidence (inspect the session log) |
| **listener vs snapshotEvents parity** | `snapshotEvents` is authoritative; `session/event` listener is a working fallback but never diffed event-for-event | In the live probe, capture both streams for one run and diff seq sets |
| **Judge/split statistics** | Gate logic exists; no data on how often live judges split | Run a 5–10 task campaign on the free route; log `selection.confidence` distribution; tune gate thresholds if splits are noise |
| **Price book coverage** | 3 openrouter routes priced | Extend `DEFAULT_PRICE_BOOK` as new routes are used; add `:free` → `{0,0,0,0}` entries for explicit zero-cost marking |
| **Proc substrate gaps** | `liveRestrict`, `logRecords`, `userSignal`, `seededFork` all false | `tools.keep/hide` → patch-level plugin `disabled:` mapping is the natural next increment |
| **PTC as a spec axis** | Events mapped; nothing *requests* ptc mode per-mount | spec could insert `@deepseek-ai/dsh-agent-tool-presentation {mode:'ptc'}` as a preset row → candidate harnesses could flip the whole tool surface to run_code |
| **Host version drift** | Everything verified on `0.2.1-rc.2` preview | On upgrade: re-run `npm test`, then the live probe; `.d.ts`-mirroring mocks may silently stale — RECON is the checklist |

## Known hazards (learned the hard way — don't rediscover)

- **Dual-package instanceof**: host deps must import from the host's own
  `app.asar/dsh/node_modules` via `file:///`. A second copy dies on
  `Receiver must be an instance of class Session`.
- **`{{model}}` assembly**: a mounted agent with no route dies at prompt
  assembly — `spec.model` is mandatory for any probe that sends turns.
- **`UNSUPPORTED_REASONING_EFFORT`**: `model.effort` values are
  pre-validated through `llm.resolveModelInfo`; undeclared efforts
  reconcile to nearest declared.
- **Dot-notation patches**: models emit `{"prompt.systemAppend":…}` —
  channels unflatten before `applyPatch`.
- **Service timing**: `ctx.get(name)` may return nothing at `apply`/
  `agent/created` time; the substrate re-probes every mount.
- **Preset vs patch anchoring**: registered presets accept `file://` only;
  `'./rel.mjs'` is legal only in *patch* files (anchored beside the patch).
- **Patch replaces whole rows**: `config:` on an existing row id replaces
  it wholesale — never overlay-edit a provider's `models:` list via a
  second patch; edit the file in place.
- **Teardown race**: in-process probes must finish inside the main task's
  lifetime, or the agent factory is gone — this is exactly what the proc
  substrate exists to escape.
- **Committed log is lazy**: `snapshotEvents` sees more than the flushed
  file mid-run; prefer it over re-reading the session file.
- **run_code is reserved**: `tools.restrict()` cannot name it; PTC mode
  collapses the model's tool surface to run_code alone.

## File map (where things live)

```
lib/core/           evidence.js spec.js capabilities.js lessons.js
                    selection.js loop.js campaign.js          — PURE
lib/adapters/       mock.js file-lessons.js
lib/adapters/dsh/   index.js spec-mount.js evidence.js seams.js
                    channels.js proc.js pricing.js gate.js
plugins/ph-dsh/     index.mjs                                   — desktop plugin
tests/              *.test.mjs contract suite
tests/live/         probe-plugin.js base.patch.yml probe.patch.yml
                    free.patch.yml (verified $0 routes)
docs/               RECON-DSH.md (host truth) ARCHITECTURE.md (internals)
AGENTS.md           working contract for agents on this repo
README.md           user-facing intro + research warning
```

## Suggested next moves (priority order)

1. **Desktop smoke**: mount plugin on desktop profile with the free
   route → `/ph status` → `/ph step` → confirm gate dialog + lesson file.
   This is the last unverified surface.
2. **Free-route campaign**: `runCampaign` over 3–5 varied tasks on
   `openrouter/free` via the proc substrate — produces real
   split/adoption statistics and stress-tests channel JSON discipline
   on a weaker model.
3. **User-correction live proof**: one interactive session interrupt
   mapped to a `correction` step.
4. Only then: compose-strategy tuning, broader price book, PTC as a
   spec axis.
