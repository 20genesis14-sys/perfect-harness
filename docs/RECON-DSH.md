# DSH reconnaissance — capability seam map for the adapter

Verified against three sources (2026-10-23, DSH `0.2.1-rc.2`):

1. **Types** — `.d.ts` in `dsh-max-compact/node_modules/@deepseek-ai/*`
2. **Production code** — `dsh-tier-router/lib/dsh/*`, `dsh-max-compact/lib/dsh/*`
   (real working call shapes, not just declarations)
3. **Live evidence** — `~/.dsh/sessions/*/session.v4.jsonl.zstd` (real session
   logs, zstd frames — decompress frame-by-frame), `dsh --dump-config`
   profile tree, `.agent-presets/custom/agent.cordis.yml`

Everything below is confirmed by at least type + one of {code, log, config}.
Preview APIs — probe at mount, degrade honestly.

## Verdict up front

**DSH is an unusually good substrate.** Of the 7 capability flags, 6 are
confirmed YES and the 7th (`isolatedMount`) is YES through two independent
paths (`agents.create` and `subagents.startActivation`). Nothing needs
emulation; the adapter is mostly mapping.

## Capability matrix → real seams

| Flag | Status | Seam(s) | Notes |
|---|---|---|---|
| `isolatedMount` | ✅ YES | `ctx.agents.create(options)` → `AgentHandle` | Full control: `sessionId`, `meta.agentPreset`, `seed`, `agentOptions`, `setup` callback. Alt: `subagents.startActivation({provider,label,request,signal,delivery})` → `{childId,result,dispose}` |
| `seededFork` | ✅ YES | `buildForkSeed(events, boundary)` + `agents.create({seed, inheritedEventCount, meta:{isSeeded:true,parentSession}})` | `ctx.sessions.fork(source,boundary?,childId?)` exists for store-level forks; agent path = `agents.create` with seed |
| `modelRouting` | ✅ YES | `agentOptions:{provider,model,reasoningEffort,maxTokens}` at create; `installModelSelection(agentCtx, ref)` live; `agent/request` waterfall replaces `LlmCallConfig` per request | `model/selection` durable event logged |
| `liveRestrict` | ✅ YES | `agentCtx.tools.restrict({allow,deny})` / `.register` / `.guard` / `.presentAs('ptc')` | Scoped = calling agent only; own-layer registrations exempt |
| `structuredLog` | ✅ YES | `SessionEvent` vocabulary: turn/step boundaries, tool/call+result, assistant/message+usage, request/header+context | seq contiguous; `session/event` emit scoped to agent; `snapshotEvents()` exists but deprecated → prefer live `session/event` + `ownEvents` |
| `logRecords` | ✅ YES (experimental) | `appendPluginRecord(session, 'plugin:name', data)` → `SessionSeq`; `pluginRecordOf(event)` reads back | Ignorable marker — survives fork/resume; repo-internal callers gate is a build rule, not runtime |
| `userSignal` | ✅ YES | `user/message` `source.kind==='user'` vs injected kinds; `turn/end` reason `aborted{kind:'user'}`; `agent/inbox/spliced` | Empirically: sources seen = `user`, `agent-instructions`, `runtime-context`, `skill-catalog`, `time-context`, `compact-checkpoint` |

## Spec → host materialization

| `HarnessSpec` field | DSH realization |
|---|---|
| `prompt` (persona/instructions/suffix) | `agentCtx.systemPrompt.section({name,order,text,interpolate})` inside `setup` — orders: persona-prefix `0`, deployment sections up to `10200`; or preset persona row |
| `tools.keep`/`hide`/`add` | `restrict({deny})` (keep = deny all others); `tools.register` in agent's own layer for additions; `guard` for policy rows |
| `skills`/`agents`/`scripts`/`memory` | preset composition document → `agentPresets.register` → `agents.create({meta:{agentPreset}})` — real rows seen: `tool-*`, `skill-*`, `command-*`, `group`/`isolate` realms |
| `model` | `agentOptions` at create or `installModelSelection` |
| `extensions` | escape hatch for host-only rows (e.g. `planMode` isolate) |

The preset path is the full-fidelity mount: `.agent-presets/*/agent.cordis.yml`
rows carry `!!js` conditions, `group`/`isolate` realms, per-row `disabled`
and `config`. `setup` path covers prompt+tools+model without a preset.

## Evidence ← session events (empirically verified shapes)

| `Evidence` field | Source events |
|---|---|
| `steps[].kind:'action'` | `tool/call` {turn,step,callId,name,arguments} |
| `steps[].kind:'observation'` | `tool/result` {message:{content,isError},error?,meta?} — `error` carries `{name,code,reason}` e.g. `{WebError,WEB_PROVIDER_CONFIGURED_MISSING}` |
| `steps[].kind:'error'` | `tool/result` isError + `assistant/attempt` (failed/stream-error attempts) + `turn/end` reason `error` |
| `steps[].kind:'correction'` | `user/message` with `source.kind==='user'` mid-turn (injected kinds excluded); `agent/inbox/spliced` steering |
| `deliverable.finalText` | last `assistant/message` content text blocks (also `reasoning` blocks present) |
| `deliverable.files` | `tool/result` meta diffs (fs tools) / `workspace/changes` marker |
| `outcome` | `turn/end` reason: `completed`→ok, `aborted`→aborted, `error`/`max-tokens`/`interrupted`→error |
| `stats` | `assistant/message.usage` {input,output,**cacheRead**Tokens}; `step/start|end` counts; `job/registered|settled` `startedAt/finishedAt` for wall time |
| `specHash` | `request/header` {config,tools[]} + `request/context` {provider,model,contextWindow} — the ACTUAL harness state that ran |

Bonus vocab beyond base types (plugin-merged events): `job/*`, `compaction/*`,
`model/selection`, `subagent/catalog`, `plan/mode`, `todo/write`,
`workspace/changes`, `permission/preset`, `sandbox/mode`, `command/*`,
`session/title*` — all merge into `SessionEventMap` via declaration merging.

## Session storage (for offline evidence reads)

- `~/.dsh/sessions/<mangled-cwd>/<session-id>/session.v4.jsonl.zstd`
- Header line = `SessionHeader` (version 4): `{id,createdAt,cwd,parentSession?,
  isSeeded,origin?,delegationDepth?,agentPreset?}`
- File = **concatenated zstd frames** (one per flush) — decompress
  frame-by-frame at magic `28 B5 2F FD`; each frame is one+ JSONL records
- `session/end-seed` marker separates inherited/closed lifecycle prefixes

## Runtime facts from `--dump-config` (headless profile)

- `ctx.agents` (`dsh-agent`), `ctx.sessions` (`dsh-session`),
  `ctx.systemPrompt` (`dsh-system-prompt`), `ctx.tools` (`dsh-tools`),
  `ctx.subagents` (`dsh-subagent` + `-spawn-in-process` + `-fork-in-process`),
  `ctx.agentPresets`, `ctx.commands`, `ctx.settings`, `ctx.jobs` (jobs.start
  owner=SessionId), `ctx.llm` (`resolveModelInfo`), `ctx.sessionPersistence`
- Desktop profile is Electron-exclusive — CLI cannot boot it; headless
  profile is the testable path (`dsh headless "task"`)

## Caveats the adapter must respect

- `snapshotEvents()`/`ownEvents()`/`eventAt()` are `@deprecated` upstream —
  usable but flagged; the clean read path is scoped `session/event` listeners
  during `run()` + `deriveMessages()`/`requestHeader()`/`toolHistory()` folds.
- `agents.create` needs a registered factory (`dsh-agent-loop` provides it);
  absent → `isolatedMount` must probe down, not assume.
- `restrict` throws naming the offender on unknown/scope-local names — the
  mount plan must distinguish "tool didn't exist" from "tool can't hide".
- `appendPluginRecord` is experimental API (gate lives in their build) —
  usable, but keep the file-lesson fallback wired behind the flag.
- `tool/ptc-dispatch[-start]` events — VERIFIED LIVE under PTC mode:
  activation = `tools.config.mode` (`native`|`ptc`), in headless driven by
  env `DSH_TOOLS_MODE=ptc` (dsh-headless cordis.patch.yml) or per-preset
  via `@deepseek-ai/dsh-agent-tool-presentation` `{mode:'ptc'}` (the
  `preset-ptc` preset in dsh-web-app/presets). Requires `ptcRuntime`
  service — `@deepseek-ai/dsh-ptc-runtime-node` row already sits in
  dsh-base, so headless needs only the env var. Under ptc, `run_code` is
  the ONLY model-visible tool (native schemas omitted from the request);
  `tools.restrict()` may not name it (reserved). Real seq order observed:
  `tool/call run_code` → `ptc-dispatch-start` → `ptc-dispatch` →
  `tool/result`. Payloads (dsh-tools/types/ptc.js + live log):
  start = `{rootCallId,parentCallId,subCallId,name,arguments(object!)}`;
  dispatch adds `{isError,error?:{code,reason},content:ContentBlock[],
  meta?}` — arguments arrive as OBJECTS (unlike `tool/call` JSON strings).
  Evidence mapping: start → `action` (inner tool+args, counts toolCalls),
  dispatch → `observation`|`error` by `isError` (text from `content`
  blocks + `[CODE: reason]` suffix). The outer `tool/result` on run_code
  still arrives normally — model-visible program output.
- `tools/ptc-dispatch-log` waterfall exists for host-side redaction of
  logged dispatch content (listener may replace the durable copy).
- `setup` is trusted same-process code: mount everything there; drive only
  after `agents.create` resolves (queued input is held until then).

## Live verification (headless profile, real OpenRouter run)

Executed `tests/live/probe-plugin.js` through
`dsh headless --patch tests/live/probe.patch.yml` on the installed host.
`probe.patch.yml` also demonstrates the minimal headless-model recipe:

- `credentials` (`dsh-credentials-local`) is **disabled by default in the
  headless bundle** — re-enable it or `apiKeyEnv` refs never resolve.
- `llm-pi-ai` openrouter provider needs `api: openai-completions` set
  explicitly; the installed model catalog does not cover custom model ids.
- `agent-default-model` config patch must name `{provider, model}` — patch
  configs replace wholesale, they do not merge.
- Windows: invoke via Node `spawn` (argv array) — `dsh.cmd` breaks on
  non-ASCII home paths through shell quoting.

Verified on the wire (probe-result.json + committed session log):

- `isolatedMount` — `agents.create({sessionId, meta, agentOptions, setup})`
  built a sibling agent with its own session; `meta.cwd` placed the session
  under the cwd-keyed store dir.
- `modelRouting` — `request/header` carries
  `config:{provider:'openrouter', model:…}` = the spec's route, confirmed
  byte-for-byte.
- `liveRestrict` — spec `tools.keep:['read']` → the emitted
  `request/header.header.tools` list shrank from 25 names to exactly
  `['read']` (whitelist on the wire, not a polite request).
- `structuredLog` — `snapshotEvents()` returned 19 events seq 0–18 with the
  documented SessionEventMap shapes (`agent/inbox/spliced`, `request/header`,
  `request/context`, `assistant/message{usage}`, `turn/end{reason.kind}`).
- `userSignal` — injected context (`system-reminder`, `runtime-context`,
  `skill-catalog`) arrives as `user/message` with `source.kind` ≠ `user`;
  the correction discriminator holds on real payloads.
- Evidence: `delivered:true, finalText:'PROBE-OK', outcome:'ok',
  tokens:7120–7295` for a tool-free turn (`steps:[]` is correct — no tool
  calls, errors, or corrections occurred).
- Committed log flushes lazily — `snapshotEvents` is authoritative during
  the run; the on-disk zstd log lagged at seq 15 while memory held seq 18.
- Host-shutdown race: a probe agent still running when the headless task
  finishes gets `turn/end{kind:'aborted'}` — keep probe work inside the
  main task's lifetime or it is torn down mid-flight.
- `{{model}}` prompt variables: a mount with no `spec.model` dies at prompt
  assembly ("prompt variable {{model}} has no value") — the adapter now
  notes this at mount time.
- `agentPresets` service is absent in the headless bundle (desktop profile
  only) — preset-row mounting degrades with the honest note. BUT the service
  CAN be injected into headless: adding
  `{id: agent-preset-registry, name: "@deepseek-ai/dsh-agent-preset-registry",
    config: {default: standard, selectedDefault: tiered}}` to the patch loads
  it live — `list()` then returns [] (no presets shipped in headless), while
  `register`/`readDocument` work fully. Verified live: registering a
  structured definition parsed from a real desktop-generated
  `.agent-presets/custom/agent.cordis.yml` (23 rows incl. `!!js` exprs via
  `parseRowsYaml`), then `readDocument('ph-base')` serving it back (registry
  serves REGISTERED docs, not only file-backed ones), then the normal
  clone→overlay→`meta.agentPreset` mount → 24 rows accepted by
  `agents.create`. Preset disposal left the agent factory alive (both the
  substrate's preset-dispose and a manual base dispose).
- **Host-teardown race (the real headless limit)**: the agent factory is
  unregistered when the main task's turn ends — ANY subsequent
  `agents.create` throws `no agent factory registered`. In-process probes
  must finish every mount before the main task ends; long main tasks only
  reduce the odds. The structural fix is external isolation: spawn
  `dsh headless --json` per roll-out (NDJSON stream: `session` /
  `status{phase}` / `text` / `final` — enough to rebuild canonical
  Evidence). Verified live 2026-10: one full `runImprovementStep` completed
  in-process only when teardown landed late; identical runs died at random
  mount counts (2–26).
- First REAL lesson admitted (same run): base spec carried a greeting-flaw
  → `candidate:0` won the blind pool 3-1 (confidence inconsistent →
  `gate.confirm` approved) → reflect produced a step-grounded lesson with
  real `runId+seq` refs (cited the read-tool call seqs). `admitLesson`
  correctly REJECTED two earlier drafts: label-refs (`"base"`/`"adopted"`
  — model couldn't see runIds until they were printed in the reflect
  prompt) and `seq=0` refs on step-free runs (no steps exist to cite → the
  prompt now prints `Citable refs:` enumerating valid runId+seq pairs; a
  step-free run legitimately cannot ground a seq-ref lesson).
- `seededFork` — a second mount with `seed: buildForkSeed(raw, 18)` replayed
  the prefix verbatim (seq 0–19 incl. inherited `session/title`), committed
  `session/end-seed{inherited:true}` at seq 20, and continued **turn 2**
  (numbering does not reset). Asked "what was the exact text?" it answered
  `PROBE-OK` — context inheritance proven semantically.
- `logRecords` — `appendPluginRecord(session, 'plugin:perfect-harness', …)`
  committed an `ignorable` event at seq 19/20 with that exact type.
- **Dual-package hazard (important)**: deps injected from a different
  package copy fail identity checks — MaxCompact's copy of
  `dsh-session` threw `Receiver must be an instance of class Session`.
  Working resolution: `file:///` imports against the host's own
  `resources/app.asar/dsh/node_modules/...` (Electron resolves asar paths
  under `ELECTRON_RUN_AS_NODE`; plain Node cannot). Production plugins
  installed into the profile's `node_modules` resolve the same copies the
  host loads, so this only bites out-of-profile mounts like this probe.

## Live improvement loop (full Harness² step on the wire)

`runImprovementStep` ran end-to-end with `createDshChannels` (fresh mounted
agent per call): 3 real model proposals → 3 candidate probes → 6 pairwise
blind judgments → gate kept base (tally 2/2/2/0, confidence low — identical
deliverables honestly tie). Loop cost ≈ 8 routed calls.

Findings the live run exposed, now encoded:

- **Dot-notation patches**: models emit `{"prompt.systemAppend": "…"}`;
  `normalizeSpec` correctly rejects the dotted top-level key, so channels
  unflatten patches before returning (real keys win over expanded ones).
- **UNSUPPORTED_REASONING_EFFORT**: a proposal lowering `model.effort`
  failed the whole probe at dispatch (`turn/end{kind:'error'}`). mount()
  now reconciles effort against `llm.resolveModelInfo(provider, model)
  .reasoning` — undeclared positive requests move to the nearest declared
  positive level, reasoning-less routes get the field omitted, unreachable
  metadata leaves the spec untouched (tier-router's rule: never guess).
- Proposals were semantically sensible harness edits (verbatim-output
  guard, tool-surface removal for a single-token task, effort reduction)
  — the channel prompts elicit real harness reasoning, not noise.
- A full step with all-identical deliverables selects nothing and keeps
  the base — the gate's honest "no separation" outcome, not a failure.
- **scripts semantics (empirically settled)**: DSH's native "script" is the
  `workflow` tool's model-authored JS body (`dsh-workflow` — agent()/
  parallel()/pipeline()/phase() hooks, ephemeral per call). A Harness²
  "script" (a harness-CARRIED helper) materializes differently: as a cordis
  `.mjs` plugin row in the preset — exactly how the real
  `.agent-presets/custom/` preset carries `prompt-reader.mjs`/`prompt-tool.mjs`.
  Rule measured by dsh-custom-mode: registered presets reject RELATIVE
  specifiers (`broken: never started`) — the adapter resolves `scripts.x`
  source strings to scratch `.mjs` files under the mount cwd
  (`.ph-scripts/x.mjs`) and ANY row `name: './rel.mjs'` to an absolute
  `file://` URL before `register()`. Live-verified: `scripts.ph-echo`
  materialized + landed as row 25 in the registered temp preset.
- **Service-registration timing**: `ctx.get('agentPresets')` may return
  nothing at `agent/created` time yet be present minutes later — cordis
  services register as plugins load. The substrate now re-probes seams at
  EVERY mount (`capabilities()` remains the create-time snapshot — honest
  "what we knew when asked").
- **`dsh headless --json` output verified**: one JSON object per line —
  `{type:session,sessionId,cwd}`, `{type:status,phase:turn_start|
  step_start|step_end|turn_end,turn,step,usage,reason}`,
  `{type:text,text}`, `{type:final,text}` — sufficient to rebuild canonical
  Evidence for external process isolation. `dsh headless` is single-shot
  by design ("answer one task and exit"); no interactive stdin mode.
- **External-process substrate** (`lib/adapters/dsh/proc.js`): each roll-out
  spawns `dsh headless --patch <base> --patch <generated> --json <task>` —
  REAL OS-process isolation, immune to the in-process teardown race. spec→
  patch: model→`agent-default-model` config (provider/model/reasoningEffort
  all verified volatile fields), prompt.*→generated `ph-sections.mjs`
  plugin (patch-anchored relative names are legal HERE — unlike registered
  presets), skills/agents/scripts→`insert:` rows. NDJSON→Evidence maps
  tool_call/tool_result/status/final (seqs are stream-order, not host seqs
  — documented limit). A full `runImprovementStep` ran entirely on spawned
  processes: 5 roll-outs + live select + admitted lesson.
- **Lesson-library suppression observed live**: with 4 exact-output lessons
  served, `propose` returned `[]` verbatim — the library correctly
  suppresses redundant proposals on a "solved" domain (recursion working,
  arguably too well: campaigns need domain diversity to keep proposing).
- **Campaign runner** (`lib/core/campaign.js`): N tasks, adoptedSpec carries
  forward, prefix-rule lesson accumulation, crash survival, metrics
  {improved, baseKept, adoptionRate, lessonsWritten, wallMs}. Live on proc
  substrate: 3 tasks × ~10 spawned processes each — all steps completed,
  base kept honestly every time.
- **Usage→cost pricing** (`lib/adapters/dsh/pricing.js`): OpenRouter rates
  read live from `/api/v1/models` (deepseek-v4.1-flash-1017 base $0.30 in /
  $1.20 out / $0.006 cacheRead per Mtok; time-windowed overrides exist —
  stored rate is the BASE, costUsd is an upper bound). Token split is REAL:
  `usage.inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens` are
  disjoint counts in both session-log `assistant/message` and NDJSON
  `status step_end` (cumulative — last record wins). Unpriced route →
  costUsd 0, never guessed. Live-verified: 7272 tok → $0.0004156.
- **Channel retry**: `createDshChannels({retries})` re-asks on unparseable
  JSON (propose/compose/reflect); reflect's `NONE` is a legitimate null —
  no retry burned.
- **composeStrategy** (`runImprovementStep` opt): `'model'` (channel merge),
  `'union'` (deterministic disjoint-leaf merge — a leaf adopted iff every
  candidate that touches it agrees; conflicts reported, stay on base),
  `'model-else-union'` (fallback when channel absent/fails/{}). Union has
  NO verdict input — ranking disagreement defers to selection.
- **Instruction-dominance finding**: injected spec-level flaws (forced
  greeting, French-only, no-tools) did NOT degrade live outcomes — the
  model prioritized the task prompt over `ph:guidance` sections every
  time. Harness prompt flaws must be positioned strongly to matter;
  blind selection correctly refused adoption on outcome parity.
