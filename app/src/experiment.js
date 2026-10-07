// Shadow Mode — the customer experiment, built into the product.
//
// The pre-registered protocol (ledger/SHADOW-PROTOCOL.md) made a paper
// promise: capture the team's prediction BEFORE Nexum's plan is revealed,
// then compare TEAM PLAN vs NEXUM PLAN vs WHAT ACTUALLY HAPPENED, honestly.
// This module makes the promise mechanical:
//
//   predict  → the team's checks, recorded verbatim, timestamped, IMMUTABLE
//   reveal   → the first status render after a prediction stamps the moment
//              Nexum's answer became visible, and snapshots that answer
//   debrief  → what was actually checked; set-difference deltas computed
//              deterministically — never a success verdict
//   close    → the next verified state seals the record
//
// HONESTY RULES, enforced here:
//   · a prediction can never be edited after reveal — it is the experiment
//   · deltas are SET FACTS (added/omitted/performed/unperformed); the human
//     verdict (HELPED / NO VALUE / EXTRA WORK / MISSED) is assigned by a
//     person against the protocol's definitions, never auto-assigned
//   · unmatched free-text prediction items are kept raw, not fuzzy-matched —
//     a guessed equivalence would manufacture agreement
//   · one experiment open at a time; abandonment is recorded, not deleted

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const EXPERIMENTS_DIR = '.physync/experiments'
export const EXPERIMENT_FORMAT = 'physync-experiment-v1'

const norm = (s) => String(s).trim().toLowerCase()
const parseChecks = (raw) => String(raw).split(',').map((s) => s.trim()).filter(Boolean)

const fileFor = (dir, id) => join(dir, EXPERIMENTS_DIR, `${id}.json`)

export function listExperiments(dir = '.') {
  const d = join(dir, EXPERIMENTS_DIR)
  if (!existsSync(d)) return []
  return readdirSync(d).filter((f) => /^exp-\d+\.json$/.test(f))
    .map((f) => {
      const e = JSON.parse(readFileSync(join(d, f), 'utf8'))
      if (e.physyncExperiment !== 1) throw new Error(`${f} is not a physync experiment record`)
      return e
    })
    .sort((a, b) => a.seq - b.seq)
}

export function openExperiment(dir = '.') {
  return listExperiments(dir).find((e) => e.closedAt == null) ?? null
}

const save = (e, dir) => {
  mkdirSync(join(dir, EXPERIMENTS_DIR), { recursive: true })
  // atomic — a torn experiment record is a corrupted experiment
  const tmp = fileFor(dir, e.id) + `.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(e, null, 2))
  renameSync(tmp, fileFor(dir, e.id))
  return e
}

/** Record the team's pre-reveal prediction. Refuses while another experiment
 *  is open — two live experiments would contaminate each other's deltas. */
export function predict({ checks, note = '', by, baseline, now }, dir = '.') {
  if (typeof by !== 'string' || !by.trim()) throw new Error('a prediction needs --by <name> — it is somebody\'s judgment, so the record says whose')
  const items = parseChecks(checks ?? '')
  if (!items.length && !note.trim()) throw new Error('a prediction needs --checks "a, b, c" (what you would re-check) and/or --note (free text) — an empty prediction is not a prediction')
  const existing = openExperiment(dir)
  if (existing) throw new Error(`experiment ${existing.id} is still open (predicted ${existing.predictedAt}) — close it with a state save, or --abandon it first`)
  const seq = listExperiments(dir).length + 1
  return save({
    physyncExperiment: 1, format: EXPERIMENT_FORMAT,
    id: `exp-${seq}`, seq,
    baseline: baseline ?? null,
    predictedAt: now ?? new Date().toISOString(),
    predictedBy: by.trim(),
    prediction: { checks: items, note: note.trim() },
    revealedAt: null, reveal: null,
    debriefedAt: null, debrief: null,
    closedAt: null, newState: null, abandoned: false,
  }, dir)
}

/** Stamp the moment Nexum's answer became visible, and snapshot that answer.
 *  Called by the status pipeline; first reveal wins, later runs never
 *  overwrite it (the experiment measures the FIRST exposure). */
export function markRevealed({ changes, planActions, applicabilityCounts, now }, dir = '.') {
  const e = openExperiment(dir)
  if (!e || e.revealedAt != null) return e
  e.revealedAt = now ?? new Date().toISOString()
  e.reveal = {
    changes: (changes ?? []).map((c) => `${c.kind} (${c.component})`),
    planActions: planActions ?? [],
    applicabilityCounts: applicabilityCounts ?? {},
  }
  return save(e, dir)
}

/** The bare check id an action corresponds to, for honest set comparison. */
const bareAction = (a) => a.startsWith('test:') ? a.slice(5) : a.startsWith('calibration:') ? a.slice(12) : a

/** Record what actually happened and compute the set-fact deltas. */
export function debrief({ checked, notes = '', by, now }, dir = '.') {
  if (typeof by !== 'string' || !by.trim()) throw new Error('a debrief needs --by <name>')
  // A sealed-but-never-debriefed experiment is still debriefable: saving a
  // verified state is the NATURAL next step after re-verifying a robot, and
  // sealing used to make the debrief permanently impossible — destroying the
  // comparison the experiment existed to produce.
  const e = openExperiment(dir) ?? listExperiments(dir).filter((x) => x.revealedAt != null && !x.debrief).pop()
  if (!e) {
    const pending = listExperiments(dir).filter((x) => x.revealedAt == null && x.closedAt == null)
    throw new Error(pending.length
      ? `experiment ${pending[pending.length - 1].id} has a prediction but was never revealed — run \`physync status\` first, then debrief`
      : 'no experiment awaiting a debrief — start one with `physync predict --checks "…" --by <name>`')
  }
  if (e.debrief) {
    throw new Error(`experiment ${e.id} was already debriefed by ${e.debrief.by} at ${e.debriefedAt}${e.debrief.verdict ? ` (verdict ${e.debrief.verdict})` : ''}. A debrief records what happened — it is never silently rewritten. Start a new experiment for the next change.`)
  }
  if (e.revealedAt == null) throw new Error(`experiment ${e.id} was never revealed — run status first (the comparison needs Nexum's answer on record)`)
  const actual = parseChecks(checked ?? '').map(norm)
  const predicted = e.prediction.checks.map(norm)
  const plan = (e.reveal.planActions ?? []).map(bareAction).map(norm)
  const inSet = (s) => (x) => s.includes(x)
  const notIn = (s) => (x) => !s.includes(x)
  e.debriefedAt = now ?? new Date().toISOString()
  e.debrief = {
    by: by.trim(), notes: notes.trim(),
    actualChecks: parseChecks(checked ?? ''),
    // SET FACTS — deterministic, no judgment embedded:
    deltas: {
      agreed: plan.filter(inSet(predicted)),                       // both human and Nexum named it
      nexumAddedBeyondPrediction: plan.filter(notIn(predicted)),   // Nexum named it, human didn't
      predictionBeyondNexum: predicted.filter(notIn(plan)),        // human named it, Nexum didn't
      usefulAdditions: plan.filter(notIn(predicted)).filter(inSet(actual)), // Nexum-only AND actually performed
      recommendedNotPerformed: plan.filter(notIn(actual)),         // candidates for EXTRA WORK — only the human verdict decides
      performedUnrecommended: actual.filter(notIn(plan)),          // candidates for NEXUM MISSED — ditto
    },
    // The verdict is HUMAN-assigned per ledger/SHADOW-PROTOCOL.md, later and
    // deliberately: auto-classifying our own success would be the exact
    // dishonesty the protocol exists to prevent.
    verdict: null, verdictBasis: null,
  }
  return save(e, dir)
}

/** A human verdict, assigned against the pre-registered definitions. */
export function assignVerdict({ verdict, basis, by }, dir = '.') {
  const LEGAL = ['HELPED', 'NO VALUE', 'EXTRA WORK', 'MISSED', 'AMBIGUOUS']
  if (!LEGAL.includes(verdict)) throw new Error(`verdict must be one of: ${LEGAL.join(' | ')}`)
  if (typeof basis !== 'string' || !basis.trim()) throw new Error('a verdict needs --basis "<one sentence saying why>" — the judgment is yours, so the reasoning is recorded with it')
  if (typeof by !== 'string' || !by.trim()) throw new Error('a verdict needs --by <name>')
  const e = openExperiment(dir) ?? listExperiments(dir).filter((x) => x.debrief && !x.debrief.verdict).pop()
  if (!e || !e.debrief) throw new Error('no debriefed experiment awaiting a verdict')
  if (e.debrief.verdict) {
    throw new Error(`experiment ${e.id} already carries the verdict ${e.debrief.verdict} (${e.debrief.verdictBasis}). A pre-registered judgment is not revised in place — if it was wrong, say so in the next experiment's basis rather than erasing the original.`)
  }
  e.debrief.verdict = verdict
  e.debrief.verdictBasis = `${basis.trim()} — assigned by ${by.trim()}`
  return save(e, dir)
}

/** Seal the record when the workflow ends (a new verified state, or abandonment). */
export function closeExperiment({ newStateVersion = null, abandoned = false, now }, dir = '.') {
  const e = openExperiment(dir)
  if (!e) return null
  e.closedAt = now ?? new Date().toISOString()
  e.newState = newStateVersion != null ? `V${newStateVersion}` : null
  e.abandoned = abandoned === true
  return save(e, dir)
}
