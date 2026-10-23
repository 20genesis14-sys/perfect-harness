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
- `tools/ptc-dispatch[-start]` events exist under PTC mode — evidence must
  merge them into steps or PTC runs look tool-less.
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
  only) — preset-row mounting degrades with the honest note.
