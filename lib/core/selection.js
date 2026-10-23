// Blind pairwise selection — choosing what to adopt without a verdict.
//
// Rules enforced here (each is a documented Harness² weak point, hardened):
//   - the BASE is always in the candidate pool: "improvement" is a claim the
//     evidence must win, not a default — trivial adoption is banned;
//   - the judge sees deliverable/trace TEXT only — no labels, no spec hashes;
//   - every pair is judged TWICE with swapped positions: a verdict that
//     flips with presentation order is a style preference, not a quality
//     signal, and counts as 'split' (half), not a win.
//
// judge signature: async (textA, textB) => 'A' | 'B' | 'tie'

const isStr = (v) => typeof v === 'string'

/**
 * One blind pair with position swap.
 * @returns {'a'|'b'|'tie'|'split'}
 */
async function judgePair(judge, textA, textB) {
  const fwd = await judge(textA, textB)
  const rev = await judge(textB, textA)
  const norm = (v) => (isStr(v) ? v.trim().toUpperCase() : '')
  const fwdWin = norm(fwd) === 'A' ? 'a' : norm(fwd) === 'B' ? 'b' : 'tie'
  const revWin = norm(rev) === 'A' ? 'b' : norm(rev) === 'B' ? 'a' : 'tie' // reversed seats
  if (fwdWin === 'tie' && revWin === 'tie') return 'tie'
  if (fwdWin === revWin) return fwdWin // consistent across both orders
  if (fwdWin === 'tie') return revWin
  if (revWin === 'tie') return fwdWin
  return 'split' // order-dependent — not a quality signal
}

/**
 * Round-robin blind tournament over entries.
 * @param {object} opts
 * @param {{label:string, text:string}[]} opts.entries first entry MUST be the base
 * @param {(a:string,b:string)=>Promise<string>|string} opts.judge
 * @returns {Promise<{winnerIndex:number, adoptIndex:number, tally:number[],
 *   pairs:object[], confidence:string, reason:string}>}
 *   adoptIndex === -1 means "keep the base" (no candidate earned adoption).
 */
export async function selectAdoption({ entries, judge }) {
  if (!Array.isArray(entries) || entries.length < 2) {
    throw new Error('selectAdoption needs base + at least one candidate — trivial adoption is not supported')
  }
  if (typeof judge !== 'function') {
    return {
      winnerIndex: 0, adoptIndex: -1, tally: entries.map(() => 0), pairs: [],
      confidence: 'none', reason: 'no judge channel — human must decide',
    }
  }
  const n = entries.length
  const tally = Array(n).fill(0)
  const pairs = []
  let splits = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const r = await judgePair(judge, entries[i].text, entries[j].text)
      pairs.push({ i, j, result: r })
      if (r === 'a') tally[i] += 1
      else if (r === 'b') tally[j] += 1
      else if (r === 'split') { tally[i] += 0.5; tally[j] += 0.5; splits++ }
      else { tally[i] += 0.5; tally[j] += 0.5 }
    }
  }
  let winnerIndex = 0
  for (let i = 1; i < n; i++) if (tally[i] > tally[winnerIndex]) winnerIndex = i
  const adoptIndex = winnerIndex === 0 ? -1 : winnerIndex
  const confidence =
    splits > 0 ? 'inconsistent'
    : tally[winnerIndex] - tally[0] >= 1 ? 'high'
    : 'low'
  const reason =
    adoptIndex === -1
      ? 'no candidate outscored the base — keeping the current harness'
      : `${entries[winnerIndex].label} wins ${tally[winnerIndex]} vs base ${tally[0]}`
  return { winnerIndex, adoptIndex, tally, pairs, confidence, reason }
}
