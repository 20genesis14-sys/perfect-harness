// Shared builders for tests — valid evidence/spec shapes in one place.

let n = 0

export function ev(over = {}) {
  const i = ++n
  return {
    runId: `r_${i}`,
    specHash: 'h_base',
    task: { id: 't1', domain: 'code', prompt: 'fix the bug' },
    steps: [
      { seq: 1, kind: 'action', tool: 'fs_read', input: 'a.js' },
      { seq: 2, kind: 'observation', text: 'file contents' },
    ],
    deliverable: { delivered: true, finalText: 'done', files: {} },
    outcome: 'ok',
    stats: { steps: 2, toolCalls: 1, tokens: 100, wallS: 1, costUsd: 0.001 },
    ...over,
  }
}

export function spec(over = {}) {
  return { prompt: { systemAppend: 'be careful' }, tools: { keep: ['fs_read'] }, ...over }
}
