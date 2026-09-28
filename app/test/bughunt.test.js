// Regression locks for the adversarial web-layer bug hunt (Sept 19).
// Every test here reproduces a CONFIRMED defect and asserts the fix:
//   P0  malformed hub entries poisoned state digests and wedged the ledger
//   P1  stale results folded into states, laundering what status refused
//   P1  simulated results entered CLI regression math and unflagged displays
//   P2  a standing recorded FAIL was invisible to status and froze into
//       the next "verified" state
//   P2  equal-timestamp ties resolved toward the OLDER ledger line
//   P2  status --json hid real regressions whenever nothing changed

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stableStringify } from '../src/state.js'
import { appendResult, latestResults, loadResults } from '../src/results.js'

const APP = new URL('..', import.meta.url).pathname
const demo = JSON.parse(readFileSync(join(APP, 'fixtures/camera_reported_demo.json'), 'utf8'))

const run = (dir, a) => {
  const r = spawnSync(process.execPath, [join(APP, 'bin/physync.js'), ...a], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'physync-hunt-'))
  mkdirSync(join(dir, '.physync'), { recursive: true })
  writeFileSync(join(dir, '.physync/tests.json'), JSON.stringify({ tests: demo.tests }, null, 2))
  writeFileSync(join(dir, 'robot.xml'), demo.configXml)
  mkdirSync(join(dir, 'code'), { recursive: true })
  for (const f of demo.files) writeFileSync(join(dir, 'code', f.name), f.content)
  return dir
}
const saveV = (dir) => run(dir, ['state', '--config', 'robot.xml', '--code', 'code'])
const status = (dir) => run(dir, ['status', '--config', 'robot.xml', '--code', 'code', '--json'])
const parse = (r) => JSON.parse(r.out.slice(r.out.indexOf('{')))

// ── P0: digest poisoning ───────────────────────────────────────────────────
test('stableStringify mirrors JSON.stringify undefined semantics exactly — digests can never diverge from the written file', () => {
  const cases = [
    { a: undefined, b: 1 },
    { hubs: [{ address: undefined, firmware: 'x' }] },
    { arr: [1, undefined, 3] },
    { nested: { deep: { gone: undefined } }, keep: 'yes' },
  ]
  for (const c of cases) {
    // same object → what stableStringify digests must equal what a
    // JSON round-trip (the file on disk) re-digests to
    assert.equal(stableStringify(c), stableStringify(JSON.parse(JSON.stringify(c))), JSON.stringify(Object.keys(c)))
  }
  assert.equal(stableStringify({ a: undefined, b: 1 }), '{"b":1}')
  assert.equal(stableStringify([1, undefined, 3]), '[1,null,3]')
})

test('a robot report with a malformed hub entry is REFUSED — it can no longer mint a state that wedges the ledger', () => {
  const dir = workspace()
  writeFileSync(join(dir, 'bad-robot.json'), JSON.stringify({ physyncRobot: 1, hubs: [{ firmware: 'HW: 20, Maj: 1, Min: 8, Eng: 2' }], sensors: [] }))
  const r = run(dir, ['state', '--config', 'robot.xml', '--code', 'code', '--robot', 'bad-robot.json'])
  assert.equal(r.code, 1)
  assert.match(r.out, /no numeric address/)
  assert.ok(!existsSync(join(dir, '.physync/states/V1.json')), 'no poisoned state may exist')
  // and a hub without firmware is refused the same way
  writeFileSync(join(dir, 'bad2.json'), JSON.stringify({ physyncRobot: 1, hubs: [{ address: 173 }], sensors: [] }))
  assert.match(run(dir, ['state', '--config', 'robot.xml', '--code', 'code', '--robot', 'bad2.json']).out, /no firmware string/)
  // the ledger still works afterwards — nothing wedged
  assert.equal(run(dir, ['states']).code, 0)
})

// ── P1: the stale-fold laundering ──────────────────────────────────────────
test('a PASS that predates a reported change is NOT folded into the next state — the save says so out loud', () => {
  const dir = workspace()
  saveV(dir)
  run(dir, ['rules', '--pack', 'camera-pose'])
  for (const id of ['camera-pose:01', 'camera-pose:02']) run(dir, ['graph', '--approve', id, '--by', 'Demo Mentor'])
  run(dir, ['result', '--test', 'localization', '--value', '0.97', '--by', 'Demo Op']) // pre-report
  run(dir, ['change', '--component', 'camera-position', '--note', 're-aimed', '--by', 'Demo Reporter'])
  const save = saveV(dir)
  assert.equal(save.code, 0)
  assert.match(save.out, /NOT folded: test:localization/, 'the exclusion is announced, not silent')
  assert.match(save.out, /human-reported change\(s\) predate this save/, 'absorbing a report is a stated decision')
  const v2 = JSON.parse(readFileSync(join(dir, '.physync/states/V2.json'), 'utf8'))
  assert.ok(!v2.evidence.some((e) => e.id === 'test:localization'), 'the stale PASS must not become V2 evidence')
})

// ── P2: standing FAIL visibility + fold refusal ────────────────────────────
test('a recorded FAIL with an UNCHANGED robot turns status to VALIDATION FAILED and blocks the next state save', () => {
  const dir = workspace()
  saveV(dir)
  run(dir, ['result', '--test', 'localization', '--value', '0.1', '--by', 'Demo Op']) // 0.1 < min 0.9 → FAIL
  const st = status(dir)
  const j = parse(st)
  assert.equal(j.status, 'VALIDATION FAILED', 'a failing robot must not read as VERIFIED just because nothing changed')
  assert.equal(st.code, 2)
  assert.ok(j.standingFailures.some((r) => r.testId === 'localization'))
  const human = run(dir, ['status', '--config', 'robot.xml', '--code', 'code'])
  assert.match(human.out, /RECORDED FAILING RESULTS/)
  const save = saveV(dir)
  assert.equal(save.code, 1)
  assert.match(save.out, /Refusing to save a verified state holding FAILING recorded results/)
  assert.ok(!existsSync(join(dir, '.physync/states/V2.json')))
})

// ── P1/P2: simulated results and regression math in the CLI ────────────────
test('a simulated drill number never manufactures a regression, and `results` flags it in the listing', () => {
  const dir = workspace()
  saveV(dir)
  run(dir, ['result', '--test', 'localization', '--value', '0.99', '--by', 'Demo Drill', '--simulated'])
  const real = run(dir, ['result', '--test', 'localization', '--value', '0.96', '--by', 'Demo Op'])
  assert.equal(real.code, 0)
  assert.ok(!/REGRESSION/.test(real.out), 'recording the real 0.96 must not warn of a phantom regression vs the drill 0.99')
  const listing = run(dir, ['results'])
  assert.match(listing.out, /SIMULATED \(satisfies nothing\)/, 'the drill row is flagged in the listing')
  assert.ok(!/REGRESSION/.test(listing.out))
  const j = parse(run(dir, ['results', '--json']))
  assert.equal(j.regressions.length, 0)
})

test('status reports real regressions even when NOTHING changed', () => {
  const dir = workspace()
  saveV(dir)
  run(dir, ['result', '--test', 'localization', '--value', '0.98', '--by', 'Demo Op'])
  run(dir, ['result', '--test', 'localization', '--value', '0.91', '--by', 'Demo Op']) // worse, still above min 0.9
  const j = parse(status(dir))
  assert.deepEqual(j.changes, [], 'genuinely unchanged robot')
  assert.ok(j.regressions.some((r) => r.testId === 'localization'), 'the 0.98→0.91 slide is reported, not hidden behind "no changes"')
})

// ── P2: equal-timestamp ties ───────────────────────────────────────────────
test('two results in the same millisecond: the LATER ledger line wins — a PASS cannot shadow the FAIL appended after it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'physync-tie-'))
  const now = '2026-09-19T12:00:00.000Z'
  const def = { id: 'grasp', kind: 'validation', label: 'g', threshold: { min: 0.9 }, definedBy: 'M' }
  appendResult({ testId: 'grasp', def, value: 0.95, recordedBy: 'Op', now }, dir)
  appendResult({ testId: 'grasp', def, value: 0.10, recordedBy: 'Op', now }, dir)
  const latest = latestResults(loadResults(dir)).get('grasp')
  assert.equal(latest.verdict, 'FAIL', 'the newer (FAIL) entry is the latest, not the older PASS')
})

// ── module guard: non-finite values ────────────────────────────────────────
test('appendResult refuses Infinity — no more valueless PASS lines in the ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'physync-inf-'))
  assert.throws(() => appendResult({ testId: 't', value: Infinity, recordedBy: 'x' }, dir), /finite/)
  assert.throws(() => appendResult({ testId: 't', value: NaN, recordedBy: 'x' }, dir), /finite/)
})
