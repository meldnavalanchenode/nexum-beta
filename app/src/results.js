// Test definitions + results ledger + regression detection — Phase 4.
//
// PHYSYNC does not execute behavioral tests. A grasp test happens on a bench,
// run by a person; PHYSYNC's jobs are the honest ones around it:
//   define    what tests exist, which KIND they are (validation | robustness),
//             and what threshold a human chose — thresholds are engineering
//             decisions with a name attached, never invented defaults
//   demand    (Phase 3) which tests a change invalidated
//   record    outcomes with evidence and the recorder's name, append-only
//   compare   the new result against the previous one → regression detection
//   verdict   metric + configured threshold → PASS/FAIL deterministically;
//             a metric with NO threshold and no explicit verdict is UNKNOWN,
//             because missing judgment is not a pass either
//
// Ledger: .physync/results/ledger.jsonl — append-only JSONL. Corrupt lines
// fail the LOAD loudly (a ledger you can silently lose lines from is not a
// ledger). Definitions: .physync/tests.json, human-authored.

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

export const TESTS_FILE = '.physync/tests.json'
export const LEDGER_FILE = '.physync/results/ledger.jsonl'
export const TEST_KINDS = ['validation', 'robustness']

// ── definitions ────────────────────────────────────────────────────────────

export function validateTestDef(def) {
  if (def == null || typeof def !== 'object') throw new Error('test definition must be an object')
  if (typeof def.id !== 'string' || !/^[\w][\w\-.]*$/.test(def.id)) throw new Error(`illegal test id "${def.id}"`)
  if (!TEST_KINDS.includes(def.kind)) throw new Error(`test "${def.id}": kind must be ${TEST_KINDS.join(' | ')}`)
  if (typeof def.label !== 'string' || !def.label.trim()) throw new Error(`test "${def.id}" needs a label`)
  if (def.threshold != null) {
    const t = def.threshold
    if (typeof t !== 'object' || (t.min == null && t.max == null)) throw new Error(`test "${def.id}": threshold needs min and/or max`)
    for (const k of ['min', 'max']) if (t[k] != null && typeof t[k] !== 'number') throw new Error(`test "${def.id}": threshold.${k} must be a number`)
    if (typeof def.definedBy !== 'string' || !def.definedBy.trim()) {
      throw new Error(`test "${def.id}" sets a threshold but names no one — a threshold is an engineering decision, and decisions have authors`)
    }
  }
  return def
}

export function loadTests(dir = '.') {
  const path = join(dir, TESTS_FILE)
  if (!existsSync(path)) return []
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(raw.tests)) throw new Error('tests.json must be { tests: [...] }')
  const seen = new Set()
  for (const t of raw.tests) {
    validateTestDef(t)
    if (seen.has(t.id)) throw new Error(`test "${t.id}" is defined twice`)
    seen.add(t.id)
  }
  return raw.tests
}

export function saveTests(tests, dir = '.') {
  mkdirSync(join(dir, '.physync'), { recursive: true })
  writeFileSync(join(dir, TESTS_FILE), JSON.stringify({ tests }, null, 2))
}

// ── the verdict rule ───────────────────────────────────────────────────────

/** metric + configured threshold → deterministic verdict. No threshold and
 *  no explicit verdict → UNKNOWN. Never PASS by default. */
export function resultVerdict({ value, explicit, threshold }) {
  if (explicit != null) {
    if (!['PASS', 'FAIL', 'UNKNOWN'].includes(explicit)) throw new Error(`illegal explicit verdict "${explicit}"`)
    return explicit
  }
  if (value != null && threshold != null) {
    if (threshold.min != null && value < threshold.min) return 'FAIL'
    if (threshold.max != null && value > threshold.max) return 'FAIL'
    return 'PASS'
  }
  return 'UNKNOWN'
}

// ── the ledger ─────────────────────────────────────────────────────────────

export function appendResult({ testId, def, value, explicit, evidence = [], recordedBy, notes, againstState, method, simulated, now }, dir = '.') {
  if (typeof testId !== 'string' || !testId.trim()) throw new Error('a result needs a test id')
  if (typeof recordedBy !== 'string' || !recordedBy.trim()) {
    throw new Error('a result needs --by <human> — PHYSYNC does not run behavioral tests, so every result has a person behind it')
  }
  if (value != null && (typeof value !== 'number' || !Number.isFinite(value))) {
    // Infinity survives a NaN check and then serializes to null in the
    // append-only ledger — a permanent PASS with no value behind it.
    throw new Error('value must be a finite number')
  }
  if (method != null && typeof method !== 'string') throw new Error('method must be text (how the result was obtained)')
  const verdict = resultVerdict({ value, explicit, threshold: def?.threshold })
  const entry = {
    physyncResult: 1,
    testId,
    kind: def?.kind ?? 'validation',
    value: value ?? null,
    threshold: def?.threshold ?? null,
    verdict,
    evidence,
    recordedBy,
    // How the result was obtained (bench run, field trial, …) — a person's
    // description, stored verbatim. null means unspecified, never "unknown
    // therefore fine".
    method: method ?? null,
    // A simulated result exists for demonstrations and drills. It is stored,
    // listed, and NEVER satisfies a requirement — demo data cannot verify a
    // real robot, and the flag travels with the entry forever.
    simulated: simulated === true,
    notes: notes ?? null,
    againstState: againstState ?? null,
    recordedAt: now ?? new Date().toISOString(),
  }
  mkdirSync(join(dir, '.physync/results'), { recursive: true })
  appendFileSync(join(dir, LEDGER_FILE), JSON.stringify(entry) + '\n')
  return entry
}

export function loadResults(dir = '.') {
  const path = join(dir, LEDGER_FILE)
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim())
  return lines.map((line, i) => {
    let entry
    try { entry = JSON.parse(line) } catch { throw new Error(`results ledger line ${i + 1} is corrupt — a ledger that silently loses lines is not a ledger; fix or archive the file`) }
    if (entry.physyncResult !== 1) throw new Error(`results ledger line ${i + 1} is not a physync result`)
    if (!['PASS', 'FAIL', 'UNKNOWN'].includes(entry.verdict)) throw new Error(`results ledger line ${i + 1} carries an illegal verdict`)
    return entry
  })
}

/** Latest result per test id, optionally only those recorded after a cutoff
 *  (e.g. the latest verified state — results older than the baseline belong
 *  to a previous life of the robot). */
export function latestResults(results, { after } = {}) {
  const byTest = new Map()
  for (const r of results) {
    if (after != null && r.recordedAt <= after) continue
    const prev = byTest.get(r.testId)
    // >= so an equal-timestamp tie goes to the LATER ledger line — two
    // appends in the same millisecond must not let the older verdict
    // shadow the newer one (a PASS hiding the FAIL recorded right after it).
    if (!prev || r.recordedAt >= prev.recordedAt) byTest.set(r.testId, r)
  }
  return byTest
}

// ── regression detection ───────────────────────────────────────────────────

/** Compare each test's latest result against its previous one. Direction
 *  comes from the configured threshold: min-thresholds mean higher-is-better,
 *  max-thresholds mean lower-is-better. With no threshold and no direction,
 *  a delta is reported as a delta — labeled regression only when direction
 *  is knowable. No universal safety numbers are invented here. */
export function detectRegressions(results) {
  const byTest = new Map()
  for (const r of results) {
    if (!byTest.has(r.testId)) byTest.set(r.testId, [])
    byTest.get(r.testId).push(r)
  }
  const regressions = []
  for (const [testId, entries] of byTest) {
    // Ties keep ledger (append) order: the sort is stable and equal
    // timestamps compare 0, so same-millisecond entries never swap.
    const metric = entries.filter((e) => e.value != null).sort((a, b) => a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0)
    if (metric.length < 2) continue
    const prev = metric[metric.length - 2]
    const curr = metric[metric.length - 1]
    const delta = curr.value - prev.value
    if (delta === 0) continue
    const threshold = curr.threshold ?? prev.threshold
    let regression = null // unknowable without direction
    if (threshold?.min != null) regression = delta < 0
    else if (threshold?.max != null) regression = delta > 0
    regressions.push({
      testId,
      previous: { value: prev.value, at: prev.recordedAt },
      current: { value: curr.value, at: curr.recordedAt },
      delta,
      regression,
      thresholdVerdict: curr.verdict,
    })
  }
  return regressions.filter((r) => r.regression === true)
}
