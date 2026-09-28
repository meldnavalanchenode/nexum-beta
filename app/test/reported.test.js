// Self-reported physical changes — the slice's acceptance criteria.
//
// Each test here is one of the failure modes the design is supposed to make
// impossible. They are written as claims about behaviour, not about code
// shape, so they stay meaningful if the implementation moves.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { recordReported, loadReported, reportedSince, asChange, validateReport, REPORTED_KIND } from '../src/reported.js'
import { plan, componentsOf } from '../src/planner.js'
import { buildVerifiedState } from '../src/state.js'

const ws = () => mkdtempSync(join(tmpdir(), 'physync-reported-'))

/** A verified state with two evidence items, one of them a wired-in artifact. */
const stateWith = (evidenceIds = ['config-parsed', 'config-code-reconciled']) => ({
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  evidence: evidenceIds.map((id) => ({ id, result: 'PASS', source: 'declared', method: 'test-fixture', summary: id })),
})

const graphWith = (custom = []) => ({ builtin: [], custom })

const approved = (id, from, to) => ({ id, from, to, source: 'user-approved', status: 'approved', approvedBy: 'tester' })
const proposed = (id, from, to) => ({ id, from, to, status: 'proposed' })

const reportChange = (component, id = 'rep-1') =>
  asChange({ id, component, note: 'reported in a test', by: 'tester', at: '2026-02-01T00:00:00.000Z' })

// ── provenance ──────────────────────────────────────────────────────────────

test('a reported change carries source "human" and method "self-reported"', () => {
  const c = reportChange('camera-position')
  assert.equal(c.source, 'human')
  assert.equal(c.method, 'self-reported')
  assert.equal(c.kind, REPORTED_KIND)
})

test('a configuration declaration is never labelled physical detection', () => {
  // The inverse guard: nothing in a reported change may claim measurement.
  const c = reportChange('camera-position')
  assert.equal(c.previous, null, 'a self-report has no measured "before"')
  assert.equal(c.current, null, 'a self-report has no measured "after"')
  assert.notEqual(c.source, 'observed')
})

test('a report without a named human is refused', () => {
  assert.throws(() => validateReport({ component: 'camera-position', by: '' }), /--by/)
  assert.throws(() => validateReport({ component: '', by: 'tester' }), /--component/)
})

test('reports are append-only and survive a reload', () => {
  const dir = ws()
  recordReported({ component: 'camera-position', note: 'one', by: 'a' }, dir)
  recordReported({ component: 'belt-tension', note: 'two', by: 'b' }, dir)
  const all = loadReported(dir)
  assert.equal(all.length, 2)
  assert.deepEqual(all.map((r) => r.component), ['camera-position', 'belt-tension'])
  assert.equal(all[0].note, 'one', 'the first report is not rewritten by the second')
})

// ── the approval law ────────────────────────────────────────────────────────

test('an UNAPPROVED edge does not affect verification', () => {
  const out = plan({
    state: stateWith(),
    changes: [reportChange('camera-position')],
    graph: graphWith([proposed('p1', 'camera-position', 'calibration:camera-pose')]),
  })
  assert.equal(out.required.length, 0, 'a proposed edge must demand nothing')
  assert.equal(out.invalidated.length, 0)
  assert.equal(out.unmappedChanges.length, 1, 'and the change must still be surfaced, not silently dropped')
})

test('the SAME edge, once approved, selects the recheck', () => {
  const out = plan({
    state: stateWith(),
    changes: [reportChange('camera-position')],
    graph: graphWith([approved('a1', 'camera-position', 'calibration:camera-pose')]),
  })
  assert.equal(out.required.length, 1)
  assert.match(out.required[0].action, /^calibration:/)
  assert.match(out.required[0].because.join(' '), /physical-change-reported/)
})

test('a chain reaches through an intermediate artifact', () => {
  const out = plan({
    state: stateWith(),
    changes: [reportChange('camera-position')],
    graph: graphWith([
      approved('a1', 'camera-position', 'calibration:camera-pose'),
      approved('a2', 'calibration:camera-pose', 'test:localization'),
    ]),
  })
  const actions = out.required.map((r) => r.action).sort()
  assert.deepEqual(actions, ['calibration:camera-pose', 'test:localization'])
})

// ── UNKNOWN never passes silently ───────────────────────────────────────────

test('a wired-in check with no recorded result is REQUIRED and marked UNKNOWN', () => {
  const out = plan({
    state: stateWith(),
    changes: [reportChange('camera-position')],
    graph: graphWith([approved('a1', 'camera-position', 'test:localization')]),
  })
  assert.equal(out.required.length, 1)
  assert.match(out.required[0].targets.join(' '), /UNKNOWN/)
})

test('a change that maps but reaches no evidence is surfaced, not silently ignored', () => {
  // The defect this slice exposed: componentsOf() succeeded, traversal reached
  // nothing, and the run reported "all re-derived" — which reads as "fine".
  const out = plan({
    state: stateWith(),
    changes: [reportChange('camera-position')],
    graph: graphWith([]), // no edges at all
  })
  assert.equal(out.required.length, 0)
  assert.equal(out.unmappedChanges.length, 1)
  assert.match(out.unmappedChanges[0], /no approved edge leads from it/)
})

// ── deduplication and ordering ──────────────────────────────────────────────

test('two reports hitting one calibration produce ONE requirement', () => {
  const out = plan({
    state: stateWith(),
    changes: [reportChange('camera-position', 'rep-1'), reportChange('camera-mount', 'rep-2')],
    graph: graphWith([
      approved('a1', 'camera-position', 'calibration:camera-pose'),
      approved('a2', 'camera-mount', 'calibration:camera-pose'),
    ]),
  })
  assert.equal(out.required.length, 1, 'the same calibration is owed once, not twice')
  assert.equal(out.required[0].because.length, 2, 'but both reasons are recorded')
})

test('a detected change and a reported change deduplicate against each other', () => {
  const detected = { id: 'chg-1', kind: 'device-port-moved', component: 'device "camera"', previous: '0', current: '2', source: 'declared', method: 'byte-sha256' }
  const out = plan({
    state: stateWith(),
    changes: [detected, reportChange('camera-position', 'rep-1')],
    graph: graphWith([
      approved('a1', 'device:camera', 'calibration:camera-pose'),
      approved('a2', 'camera-position', 'calibration:camera-pose'),
    ]),
  })
  assert.equal(out.required.length, 1)
})

// ── evidence binding across states ──────────────────────────────────────────

test('a report older than the baseline does not demand rechecks for a newer state', () => {
  const reports = [
    { id: 'rep-old', component: 'camera-position', by: 'a', at: '2025-12-01T00:00:00.000Z' },
    { id: 'rep-new', component: 'camera-position', by: 'a', at: '2026-06-01T00:00:00.000Z' },
  ]
  const since = reportedSince(reports, stateWith().createdAt)
  assert.deepEqual(since.map((r) => r.id), ['rep-new'],
    'a report about a robot that has since been re-verified is history, not a requirement')
})

test('historical evidence is not rewritten by a reported change', () => {
  const state = stateWith()
  const before = JSON.stringify(state.evidence)
  plan({
    state,
    changes: [reportChange('camera-position')],
    graph: graphWith([approved('a1', 'camera-position', 'config-parsed')]),
  })
  assert.equal(JSON.stringify(state.evidence), before, 'planning must not mutate the state it planned against')
})

test('invalidating evidence records it as invalidated, not as FAIL', () => {
  const out = plan({
    state: stateWith(['config-parsed']),
    changes: [reportChange('camera-position')],
    graph: graphWith([approved('a1', 'camera-position', 'config-parsed')]),
  })
  assert.equal(out.invalidated.length, 1)
  assert.equal(out.invalidated[0].evidenceId, 'config-parsed')
  assert.ok(!('result' in out.invalidated[0]), 'invalidation records applicability, it does not overwrite the old verdict')
})

// ── the state builder still refuses to paper over failures ──────────────────

test('a verified state cannot be built over a FAILING check', () => {
  assert.throws(() => buildVerifiedState({
    version: 1, configName: 'c', configXml: Buffer.from('<Robot/>'), devices: [],
    checkVerdict: 'FAIL', checkFindingCounts: { FAIL: 1 }, engineVersion: 'test',
  }), /Refusing to build a verified state/)
})

// ── the mapping itself ──────────────────────────────────────────────────────

test('componentsOf uses the reported node id verbatim and invents nothing', () => {
  assert.deepEqual(componentsOf({ kind: REPORTED_KIND, component: 'camera-position' }), ['camera-position'])
  assert.deepEqual(componentsOf({ kind: 'nonsense-kind', component: 'x' }), [],
    'an unrecognised kind still maps to nothing rather than guessing')
})
