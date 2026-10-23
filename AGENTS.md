# AGENTS.md — working contract for LLM agents on this repo

You are editing **perfect-harness**, a vendor-agnostic recursive harnessing
method core: canonical evidence model, harness-spec diffs with pins, a
capability matrix, a propose → probe → compose → gate loop, and a lessons
library. Substrates (DSH, Claude Code, mock) plug in through adapters in
`lib/adapters/`.

## Commands

```sh
npm test          # node --test tests/**/*.test.mjs
npm run check     # node --check on lib files
```

Node `^22.19 || >=24`. No build step — plain ESM (`"type": "module"`).

## Golden rules

1. **`lib/core/` never imports a host and never does I/O.** Plain objects in,
   decisions out. Async is allowed only for calling *injected* deps
   (substrate, channels, gate) — never fs/net/process directly.
2. **`lib/adapters/` is the only place that knows a host exists.** One file
   per substrate; each returns `{capabilities(), mount(spec), run(handle,
   task), dispose(handle)}` and MUST return evidence that passes
   `normalizeEvidence`.
3. **Core vocabulary is method-native**: `spec`, `rollout`/`handle`, `trace`,
   `candidate`, `lesson`, `gate`, `ref`. Do not import host terms (`agent`,
   `session`, `preset`) into core signatures.
4. **Honest degradation**: every feature checks its capability flag and
   degrades or reports — never throws for a missing host ability.
5. **No verdicts inside evidence.** `score`/`grade`/`rubric`/`passed`-style
   fields are rejected by `normalizeEvidence` at every layer.
6. **Selection always includes the base.** `trivial_selection` (adopting the
   only candidate without comparison) is a banned pattern here.

## Layout

| Path | Role |
| --- | --- |
| `lib/core/evidence.js` | Evidence contract + `formatTrajectory` + `contrastEvidences` |
| `lib/core/spec.js` | Spec model, `applyPatch` with pins, `diffSpecs`, `specHash` |
| `lib/core/capabilities.js` | Flag table + `resolveCapabilities` → mode |
| `lib/core/lessons.js` | Library, `admitLesson` (ref-resolving), prefix rule, decay |
| `lib/core/selection.js` | Blind pairwise selection, position-swap, base-in-pool |
| `lib/core/loop.js` | `runImprovementStep` — full PPC cycle over injected deps |
| `lib/adapters/mock.js` | Mock substrate + scripted channels (seam proof, no model) |
| `lib/index.js` | Exports/wiring only |

## Testing conventions

- Tests are plain `node:test` files in `tests/`, one per module.
- `tests/loop.test.mjs` runs the full improvement step against the mock
  substrate — the seam-proof suite. If it needs a real host to pass, the seam
  is drawn wrong.
