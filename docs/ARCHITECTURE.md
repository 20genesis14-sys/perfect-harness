# Architecture — how perfect-harness works inside

Read this before non-trivial changes. The README describes *what* the
library does; this file explains *how it is arranged*, what each piece is
responsible for, and which rules keep the method honest.

> **Research status.** This is an experimental implementation of the
> Harness² method, built and verified against a developer-preview host
> (DSH `0.2.1-rc.2`). It is not production software. It makes real model
> calls — every probe, candidate rollout, judge pair, and reflect pass
> spends tokens on whatever provider route the host is configured with.
> Running it against your own DSH profile spends *your* tokens.

## The 30-second version

A model is fixed; everything around it — prompt, tools, memory, skills,
scripts, presets, orchestration — is a serializable **spec**. The library
proposes patches to the spec, mounts each candidate in an isolated
rollout, compares deliverables with a blind pairwise judge, gates adoption
on a human when confidence is insufficient, and distills each step's
outcome into a **lesson** whose references resolve against the real run
log. Three files deep:

```
lib/core/        pure method — no host imports, no I/O, no model calls
lib/adapters/    the only code that knows a host exists
plugins/         mountable host plugins (desktop profile surface)
tests/           contract suite (mock host) + live probes (real host)
```

## The one rule that matters

**`lib/core/` never imports a host and never does I/O.** Objects in,
decisions out; async exists only to call *injected* dependencies
(substrate, channels, gate). If you write `fs`, `fetch`, `spawn`, or
`@deepseek-ai/*` inside `core/`, stop — that code belongs in an adapter.
The inverse rule holds too: adapters may not leak host vocabulary
(`agent`, `session`, `preset`) into core signatures — the core speaks
`spec`, `rollout`, `trace`, `candidate`, `lesson`, `gate`, `ref`.

## Data flow — one improvement step

`lib/core/loop.js` `runImprovementStep(deps)` is the whole method:

```
1. base rollout         substrate.mount(baseSpec) → run(task) → Evidence
2. lessons read         library.forTask(task) — prefix rule serves only
                        same-domain entries from earlier tasks
3. propose              channels.propose({task, spec, baseTrajectory,
                        lessons}) → [{description, patch, kind?}]
                        → each patch applied to base via applyPatch
                        (pins enforced — violations listed verbatim)
4. probe                one rollout per candidate spec (parallel-ish;
                        the substrate decides real isolation)
5. compose              channels.compose({entries:[label,diff,contrast,
                        trajectory]}) → {patch} | null
                        OR composeUnionDisjoint — deterministic leaf
                        merge, no model, no verdicts
6. refined rollout      one rollout of the merged spec (skipped if the
                        merge produced no net diff)
7. blind selection      selectAdoption: pairwise tournament over
                        [base, candidates…, refined] — judge sees
                        formatDeliverable(text) only; every pair judged
                        twice with swapped seats; flips → split →
                        confidence 'inconsistent'
8. gate                 auto-adopt on routed+consistent, else
                        human-required → gate.confirm(summary) →
                        truthy adopts; missing gate keeps base
9. reflect              channels.reflect({runIds, trajectories, diffs,
                        gateResult, citeable seqs}) → lesson draft →
                        admitLesson validates EVERY {runId,seq} ref
                        resolves → lesson enters library
10. return              {ok, improved, adoptedSpec, adoptedLabel,
                        lesson, notes, trail, mode}
```

Nothing in those ten steps knows what a model is. `channels.propose`,
`channels.compose`, `channels.select`, `channels.reflect` are async
functions you inject — they can be a model, a regex, a spreadsheet.

## Canonical Evidence — the contract adapters must satisfy

`lib/core/evidence.js`. One per rollout:

```js
{ runId, specHash,
  task: { id, domain, prompt },          // work only, never criteria
  steps: [{ seq, kind, tool?, input?, text? }],
  deliverable: { delivered, finalText, files },
  outcome: 'ok'|'error'|'timeout'|'aborted',
  stats: { steps, toolCalls, tokens, wallS, costUsd } }
```

Hard rules enforced by `normalizeEvidence` — violations throw, not warn:

- **no verdicts**: `score`, `rubric`, `passed`, `grade`, `judge` style
  fields are rejected at every layer. Evidence narrates what happened;
  deciding what *counts as good* is selection's job, downstream.
- **seq integrity**: strictly increasing unique `seq`s — they are the
  lesson reference target (`runId`+`seq`), so they must match the host's
  committed log, not a renumbered copy.
- **prompt is work**: `task.prompt` describes the job; success criteria
  must not leak in (a leaked rubric contaminates every judge and lesson).

Step kinds: `action` (tool call), `observation` (result), `error`,
`correction` (a real human message mid-run — `source.kind:'user'` in DSH,
agent-injected runtime context does NOT count).

## Spec model — the editable surface

`lib/core/spec.js`. A spec is the serializable harness: `prompt`,
`tools`, `skills`, `agents`, `scripts`, `memory`, `model`, `extensions`
(host escape hatch — never interpreted by core).

- `applyPatch(base, patch, {pins})`: absent = inherited, present = merge
  (objects deep-merge, arrays replace wholesale), `null` = delete.
  `pins` are deployer-owned dot paths the patch may not touch —
  violations throw listing *every* offender (that message is designed
  as retry feedback for the proposer).
- `diffSpecs` → leaf-level `added|removed|changed` — what compose and
  reflect narrate.
- `composeUnionDisjoint(base, candidates, {pins})` → `{patch, adopted,
  conflicts}`: a leaf is adopted iff every candidate that touches it
  sets the same value (untouched = consent). Conflicts are reported and
  stay on base — ranking disagreement is the selector's job, never the
  composer's. Note the subtle case this catches: a candidate whose spec
  *omits* a section votes to *remove* its leaves.
- `specHash` → stable content hash (spec identity for evidence).

## Capability matrix — honest degradation

`lib/core/capabilities.js` `resolveCapabilities(flags)` → `{flags, mode}`.
Seven booleans describe what the host can actually do:

| flag | unlocks | degradation when false |
| --- | --- | --- |
| `isolatedMount` | live candidate probes | retrospective analysis only |
| `seededFork` | probes forked from a shared prefix | rerun from scratch |
| `modelRouting` | a selector on a different route | same model + human-required gate |
| `liveRestrict` | live tool-policy edits per mount | apply to new sessions only |
| `structuredLog` | `runId#seq` lesson refs | `runId`-only refs |
| `logRecords` | lessons inside the run log | file beside the runs |
| `userSignal` | auto `correction` steps | manual marking |

All-false still works: collect evidence → propose → human decides. A
substrate that claims a flag it cannot back is the worst possible bug —
capability probing (`seams.js`) checks function presence on the live ctx,
and the substrate re-probes at *every* mount because cordis services
register lazily (`capabilities()` stays the create-time snapshot —
honest "what we knew when asked").

## Selection — why it is blind

`lib/core/selection.js` `selectAdoption({entries, judge})`:

- Judge input = `formatDeliverable` text only. No labels, no spec, no
  hashes, no provenance — the judge cannot see which candidate is which.
- Every pair is judged **twice, seats swapped**. A verdict that flips
  with seat order is position bias, not preference → recorded `split`.
- Any `split` in the tally → `confidence: 'inconsistent'` → human gate.
- Base is always in the pool; `trivial_selection` (adopting the only
  candidate without comparison) is a banned pattern — see AGENTS.md.

## Lessons — provenance is code, not prose

`lib/core/lessons.js`. A lesson is
`{id, domain, cue, lesson, refs/evidence:[{runId,seq}], confidence,
status, counts:{confirmed,refuted}}`.

- `admitLesson(draft, {lookupRun, seqRefs})` resolves **every** evidence
  ref against real Evidence objects — a lesson citing `runId:'base'` or
  a `seq` that rollout never emitted is refused. (This is the failure we
  hit live: the model cited labels 'base'/'adopted'; the fix was to pass
  actual runIds + the real seq list into the reflect prompt, see
  RECON-DSH.md.)
- Prefix rule: task *i* is served only same-domain lessons from tasks
  *< i* — the library cannot leak knowledge from the future.
- `recordOutcome` → confirmed/refuted counts; refuted stops being served.
  `decay` marks unrevalidated entries `stale`.
- Persistence is an adapter concern: `lib/adapters/file-lessons.js`
  (`createFileLessonStore`) serializes `library.toJSON()` —
  cross-process verified. A `logRecords`-capable host could alternatively
  keep lessons inside run logs (`appendPluginRecord` seam exists; the
  file fallback stays wired regardless).

## Campaign — harnessing-level recursion

`lib/core/campaign.js` `runCampaign({tasks, baseSpec, substrate, channels,
…})`: runs `runImprovementStep` sequentially; the adopted spec of task *i*
becomes the base spec of task *i+1*; the lesson library accumulates
across tasks; per-task crashes are recorded and the campaign continues.
Metrics: `{total, improved, baseKept, adoptionRate, lessonsWritten,
wallMs}`.

## DSH adapter — `lib/adapters/dsh/`

All host knowledge lives here. Verified against DSH `0.2.1-rc.2` — full
empirical detail is in `docs/RECON-DSH.md` (it is the source of truth;
this is the map).

| file | responsibility |
| --- | --- |
| `seams.js` | `probeSeams(ctx, deps)` → the 7 flags from live service presence |
| `spec-mount.js` | `planMount(spec)` — pure spec → mount plan (sections, restrict, model route, preset rows) |
| `index.js` | `createDshSubstrate({ctx, deps, opts})` — mount/run/dispose |
| `evidence.js` | `evidenceFromEvents(events, meta)` — pure SessionEvent → Evidence |
| `channels.js` | `createDshChannels` — propose/compose/select/reflect as fresh mounts |
| `proc.js` | `createDshProcSubstrate` — external `dsh headless --json` per rollout |
| `pricing.js` | route → USD rate book; `costOf` on the real token split |
| `gate.js` | `createDshHumanGate` — `userQuestions.ask` waterfall |

### mount (`index.js`)

`agents.create(options)` with a `setup(agentCtx)` callback — everything
registered inside setup exists before the agent's first assembly:

- `prompt.*` → scoped `systemPrompt.section({name:'ph:*', order, text})`
- `tools.keep/hide` → `agentCtx.tools.restrict({allow|deny})` — failure
  *throws* (a tool policy that silently half-applies is unsafe); unknown
  names are noted separately from real failures
- `model` → `options.agentOptions {provider,model,reasoningEffort}` —
  effort is pre-validated through `llm.resolveModelInfo`; unsupported
  values reconcile to the nearest declared effort (live finding:
  `UNSUPPORTED_REASONING_EFFORT` kills the turn otherwise)
- `skills`/`agents`/`scripts` + `meta.agentPreset` → the preset path:
  `agentPresets.register` a temp preset = cloned base rows + spec rows;
  `scripts.x` source strings materialize as `.ph-scripts/*.mjs` files and
  any `'./rel.mjs'` row resolves to an absolute `file://` URL (registered
  presets accept `file://` only — verified)
- `meta.cwd` scopes the session log directory

### run

`agent.send(userMessage,'next-turn',true)` → `whenIdle()` bounded by
`wallMs` → events from `session.snapshotEvents(inheritedEventCount)`
(committed log is authoritative; a `session/event` listener collects in
parallel as fallback) → `evidenceFromEvents`.

Event mapping (all field names verified against committed logs, not
docs): `tool/call {callId,name,arguments:JSON-string}` → action;
`tool/result {message:{toolCallId,content,isError},error?}` →
observation|error; `tool/ptc-dispatch-start`/`tool/ptc-dispatch`
(`arguments` arrive as *objects*, `isError`+`content` on the result) →
action|observation|error; `assistant/attempt` → error step (settled
without a message); `assistant/message.usage` → token split
(in/out/cacheRead/cacheWrite are disjoint counts); `user/message` with
`source.kind!=='user'` is skipped — the rest are `correction` steps;
`turn/end {reason:{kind}}` → outcome.

### seededFork

`deps.buildForkSeed` + `session/end-seed` replay the prefix into a new
agent; turn numbering *continues* (verified: turn 2 answered with the
inherited context). Formats its seed from the mounted agent's own events.

### channels

Each channel call = a fresh `mount → run → dispose` on the substrate —
structural blindness (the judge agent literally has no access to labels).
Replies parse by `parseJson` (fence, then outermost span); model
dot-notation patches (`{"prompt.systemAppend":…}`) unflatten into real
nesting (live finding); `retries` re-asks once on unparseable JSON —
reflect's literal `NONE` is a legitimate null and never burns a retry.

### proc substrate — real OS isolation

`createDshProcSubstrate({exe, cli, basePatches, workdir})` spawns
`dsh headless --patch … --patch <generated> --json <task>` per rollout —
immune to the in-process teardown race. spec→patch: `model` →
`agent-default-model` config row, `prompt.*` → generated `ph-sections.mjs`
plugin (relative names anchor at the patch file — legal for patches),
skills/agents/scripts → `insert:` rows. NDJSON → Evidence; seqs are
stream-order, not host seqs (documented limit). No seededFork,
liveRestrict, logRecords, userSignal — the flags say so.

### pricing

`DEFAULT_PRICE_BOOK` — OpenRouter rates read live (`/api/v1/models`),
USD per 1M tokens, base rate only (off-peak overrides exist — costUsd is
an upper bound). `priceFor(book, provider, model)`: `provider/model`
key wins over bare `model`; unpriced → `costUsd: 0` — zero means
*unknown*, never a guess. Wired through both substrates from the real
token split.

### gate

`createDshHumanGate({ctx})` → `confirm(summary)` calls
`ctx.userQuestions.ask({questions:[…]})` **without** an agent — the
unscoped waterfall reaches the desktop UI answerer; passing a mounted
probe agent would throw `DELEGATED_CALLER` (only the exact live runtime
root may carry agent). `NO_PROVIDER`/missing service/aborts → `false` —
a gate the human can't see always keeps base.

## The desktop plugin — `plugins/ph-dsh/index.mjs`

A Cordis plugin for a desktop profile (mount via patch `insert:` row —
relative names anchor at the patch file). Registers `/ph` through
`ctx.inject(['commands'])` (deferred injection — services may not exist
at apply time; `ctx.on('ready')` is not a documented cordis event).

- `/ph status` — live seam probe + gate reachability + lesson count
- `/ph step <task>` — one `runImprovementStep` with `requireHuman: true`,
  real channels, the UI gate, file-persisted lessons; the adopted spec
  becomes the new base for the next step
- `/ph lessons` — library tail

## Host-dep injection — the instanceof rule

DSH host functions (`buildForkSeed`, `appendPluginRecord`,
`createUserMessage`, `resolveModelInfo`, `parsePresetYaml`) arrive through
`deps` — never imported inside `lib/`. They **must** come from the host's
own `node_modules` (`app.asar/dsh/node_modules`): a second package copy
fails `instanceof` checks (`Receiver must be an instance of class
Session`). Electron resolves asar paths under `ELECTRON_RUN_AS_NODE`.
`tests/live/probe-plugin.js` shows the verified `file:///` loading
pattern; the desktop plugin repeats it.

## Testing topology

- `tests/*.test.mjs` — contract suite. `loop.test.mjs` runs the whole
  step against the mock substrate (if it needed a real host, the seam
  would be drawn wrong); `dsh-contract.test.mjs` mocks the ctx against
  the real `.d.ts` shapes **and the verified event payloads** (including
  the real PTC dispatch records captured live).
- `tests/live/` — `probe-plugin.js` + `base.patch.yml`/`probe.patch.yml`
  mount a real probe inside `dsh headless`; scratch assets
  (`lessons.json`, `probe-result.json`, `a/b/c.txt`) are gitignored.
- `npm test` / `npm run check` — the whole suite is plain `node:test`;
  nothing builds.

## Reading order for a change

1. `docs/RECON-DSH.md` — what the host actually does (empirical truth).
2. `lib/core/loop.js` — the method spine.
3. `lib/adapters/dsh/index.js` + `spec-mount.js` — how specs materialize.
4. `tests/live/probe-plugin.js` — how the whole thing was verified end
   to end.
