// Phase 4: test definitions, the results ledger, and regression detection.
// Properties locked: thresholds are authored engineering decisions (no
// universal safety numbers exist anywhere in this module); a metric with no
// threshold and no explicit verdict is UNKNOWN, never PASS; the ledger is
// append-only and fails its load loudly on corruption; regression direction
// comes only from the configured threshold; results demand a named human;
// and the status pipeline escalates a FAIL result to VALIDATION FAILED.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateTestDef, loadTests, saveTests, resultVerdict, appendResult, loadResults,
  latestResults, detectRegressions, LEDGER_FILE,
} from '../src/results.js'

const APP = fileURLToPath(new URL('..', import.meta.url))

// ── definitions ────────────────────────────────────────────────────────────
test('definitions: a threshold without an author is rejected — decisions have names', () => {
  assert.throws(() => validateTestDef({ id: 'x', kind: 'robustness', label: 'X', threshold: { min: 0.9 } }), /authors/)
  validateTestDef({ id: 'x', kind: 'robustness', label: 'X', threshold: { min: 0.9 }, definedBy: 'Raghu' })
})
test('definitions: kind must be validation or robustness; ids are word-shaped; duplicates rejected', () => {
  assert.throws(() => validateTestDef({ id: 'x', kind: 'benchmark', label: 'X' }), /kind/)
  assert.throws(() => validateTestDef({ id: 'a b', kind: 'validation', label: 'X' }), /illegal test id/)
  const dir = mkdtempSync(join(tmpdir(), 'r-'))
  saveTests([{ id: 'a', kind: 'validation', label: 'A' }, { id: 'a', kind: 'validation', label: 'A2' }], dir)
  assert.throws(() => loadTests(dir), /twice/)
})

// ── the verdict rule ───────────────────────────────────────────────────────
test('verdict: metric vs min-threshold is deterministic — the spec example (68 vs ≥90) FAILs', () => {
  assert.equal(resultVerdict({ value: 0.68, threshold: { min: 0.9 } }), 'FAIL')
  assert.equal(resultVerdict({ value: 0.92, threshold: { min: 0.9 } }), 'PASS')
  assert.equal(resultVerdict({ value: 0.9, threshold: { min: 0.9 } }), 'PASS', 'meeting the bar clears the bar')
})
test('verdict: max-thresholds run the other way (lower is better)', () => {
  assert.equal(resultVerdict({ value: 12, threshold: { max: 10 } }), 'FAIL')
  assert.equal(resultVerdict({ value: 8, threshold: { max: 10 } }), 'PASS')
})
test('verdict: a metric with NO threshold and no explicit verdict is UNKNOWN — never PASS by default', () => {
  assert.equal(resultVerdict({ value: 0.99 }), 'UNKNOWN')
  assert.equal(resultVerdict({}), 'UNKNOWN')
})
test('verdict: explicit verdicts pass through; illegal ones are rejected', () => {
  assert.equal(resultVerdict({ explicit: 'FAIL', value: 1.0, threshold: { min: 0.1 } }), 'FAIL', 'a human explicit verdict outranks the metric')
  assert.throws(() => resultVerdict({ explicit: 'MEH' }), /illegal/)
})

// ── the ledger ─────────────────────────────────────────────────────────────
test('ledger: a result without a named recorder is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r-'))
  assert.throws(() => appendResult({ testId: 't', value: 1 }, dir), /person behind it/)
})
test('ledger: append → load round-trips, appends never rewrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r-'))
  appendResult({ testId: 't', value: 0.5, recordedBy: 'R', now: '2026-09-11T01:00:00.000Z' }, dir)
  const before = readFileSync(join(dir, LEDGER_FILE), 'utf8')
  appendResult({ testId: 't', value: 0.6, recordedBy: 'R', now: '2026-09-11T02:00:00.000Z' }, dir)
  const after = readFileSync(join(dir, LEDGER_FILE), 'utf8')
  assert.ok(after.startsWith(before), 'the ledger only grows')
  assert.equal(loadResults(dir).length, 2)
})
test('ledger: a corrupt line fails the LOAD loudly — no silent loss', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r-'))
  appendResult({ testId: 't', value: 0.5, recordedBy: 'R' }, dir)
  appendFileSync(join(dir, LEDGER_FILE), '{corrupted\n')
  assert.throws(() => loadResults(dir), /not a ledger|corrupt/)
})
test('ledger: latestResults respects the cutoff — results older than the baseline belong to a previous life', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r-'))
  appendResult({ testId: 't', value: 0.5, recordedBy: 'R', now: '2026-09-01T00:00:00.000Z' }, dir)
  appendResult({ testId: 't', value: 0.9, recordedBy: 'R', now: '2026-09-11T00:00:00.000Z' }, dir)
  const all = loadResults(dir)
  assert.equal(latestResults(all).get('t').value, 0.9)
  assert.equal(latestResults(all, { after: '2026-09-12T00:00:00.000Z' }).size, 0)
})

// ── regression detection ───────────────────────────────────────────────────
const entry = (testId, value, at, threshold = { min: 0.9 }) => ({ physyncResult: 1, testId, kind: 'robustness', value, threshold, verdict: resultVerdict({ value, threshold }), evidence: [], recordedBy: 'R', notes: null, againstState: null, recordedAt: at })

test('regression: the spec example — 0.92 → 0.68 is a regression of -0.24 with threshold verdict FAIL', () => {
  const regs = detectRegressions([entry('reflective', 0.92, '2026-09-10T00:00:00.000Z'), entry('reflective', 0.68, '2026-09-11T00:00:00.000Z')])
  assert.equal(regs.length, 1)
  assert.equal(+regs[0].delta.toFixed(2), -0.24)
  assert.equal(regs[0].thresholdVerdict, 'FAIL')
})
test('regression: improvement is not a regression; direction flips for max-thresholds', () => {
  assert.equal(detectRegressions([entry('t', 0.68, '2026-09-10T00:00:00.000Z'), entry('t', 0.92, '2026-09-11T00:00:00.000Z')]).length, 0)
  const worse = detectRegressions([entry('lat', 8, '2026-09-10T00:00:00.000Z', { max: 10 }), entry('lat', 12, '2026-09-11T00:00:00.000Z', { max: 10 })])
  assert.equal(worse.length, 1, 'rising latency against a max-threshold IS a regression')
})
test('regression: without a threshold there is no direction, so no regression label is invented', () => {
  const regs = detectRegressions([entry('t', 0.9, '2026-09-10T00:00:00.000Z', null), entry('t', 0.5, '2026-09-11T00:00:00.000Z', null)])
  assert.equal(regs.length, 0, 'a delta without a knowable direction is not called a regression')
})
test('regression: only the two most recent metric results are compared', () => {
  const regs = detectRegressions([
    entry('t', 0.99, '2026-09-09T00:00:00.000Z'),
    entry('t', 0.91, '2026-09-10T00:00:00.000Z'),
    entry('t', 0.93, '2026-09-11T00:00:00.000Z'),
  ])
  assert.equal(regs.length, 0, '0.91→0.93 improved; ancient 0.99 does not haunt the comparison')
})

// ── CLI: the change-triggered robustness loop, end to end ──────────────────
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'physync-p4-'))
  writeFileSync(join(dir, 'robot.xml'), '<Robot type="FirstInspires-FTC"><LynxUsbDevice name="P" serialNumber="X" parentModuleAddress="173"><LynxModule name="Control Hub" port="173"><Servo name="claw" port="1" /><RevColorSensorV3 name="pixel" port="0" bus="0" /></LynxModule></LynxUsbDevice></Robot>')
  mkdirSync(join(dir, 'code'))
  writeFileSync(join(dir, 'code/T.java'), 'class T { void i(HardwareMap hardwareMap){ b = hardwareMap.get(Servo.class, "claw"); c = hardwareMap.get(ColorSensor.class, "pixel"); } }')
  writeFileSync(join(dir, 'rob.json'), JSON.stringify({ physyncRobot: 1, hubs: [{ address: 173, parent: true, firmware: 'HW: 20, Maj: 1, Min: 8, Eng: 2', volts: 12.7 }], sensors: [{ name: 'pixel', type: 'RevColorSensorV3', class: 'i2c', read: 'ok', value: 'r=9', livenessDeterminable: true }], deviceCount: 3 }))
  return dir
}
const run = (dir, a) => {
  // spawnSync, not execFileSync: warnings land on stderr even when exit is 0.
  const r = spawnSync(process.execPath, [join(APP, 'bin/physync.js'), ...a], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
const wire = (dir) => {
  run(dir, ['tests', '--define', '--id', 'low-light', '--kind', 'robustness', '--label', 'Low-light', '--min', '0.9', '--by', 'R'])
  const p = run(dir, ['graph', '--propose', '--from', 'device:pixel', '--to', 'test:low-light'])
  run(dir, ['graph', '--approve', p.out.match(/Proposed edge (\S+):/)[1], '--by', 'R'])
}

test('CLI: results without --by are refused; a threshold FAIL exits 2 at record time', () => {
  const dir = workspace()
  wire(dir)
  assert.equal(run(dir, ['result', '--test', 'low-light', '--value', '0.95']).code, 1)
  assert.equal(run(dir, ['result', '--test', 'low-light', '--value', '0.5', '--by', 'R']).code, 2)
})
test('CLI: change-triggered demand → PASS result satisfies → clean state saved with the result as evidence', () => {
  const dir = workspace()
  wire(dir)
  run(dir, ['result', '--test', 'low-light', '--value', '0.92', '--by', 'R'])
  run(dir, ['state', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json'])
  const v1 = JSON.parse(readFileSync(join(dir, '.physync/states/V1.json'), 'utf8'))
  assert.ok(v1.evidence.some((e) => e.id === 'test:low-light' && e.result === 'PASS' && e.source === 'human'), 'the recorded result folds into the state as human evidence')

  writeFileSync(join(dir, 'robot.xml'), readFileSync(join(dir, 'robot.xml'), 'utf8').replace('name="pixel" port="0" bus="0"', 'name="pixel" port="2" bus="1"'))
  const demanded = run(dir, ['status', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json'])
  assert.equal(demanded.code, 3)
  assert.match(demanded.out, /re-run test "low-light"/)
  // human output renders the change as a SENTENCE; the machine trace
  // (device-port-moved) stays in --json, asserted elsewhere
  assert.match(demanded.out, /test:low-light — because device "pixel" moved/)

  run(dir, ['result', '--test', 'low-light', '--value', '0.94', '--by', 'R'])
  const satisfied = run(dir, ['status', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json'])
  assert.equal(satisfied.code, 3, 'still REVALIDATION REQUIRED — changes exist until a new state is saved')
  assert.match(satisfied.out, /PASS recorded .* by R/)
  assert.ok(!/REQUIRED REVALIDATION/.test(satisfied.out) || !/re-run test "low-light"\n/.test(satisfied.out), 'the satisfied test is no longer demanded')
})
test('CLI: a FAIL result escalates status to VALIDATION FAILED with exit 2 and shows the regression', () => {
  const dir = workspace()
  wire(dir)
  run(dir, ['result', '--test', 'low-light', '--value', '0.92', '--by', 'R'])
  run(dir, ['state', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json'])
  writeFileSync(join(dir, 'robot.xml'), readFileSync(join(dir, 'robot.xml'), 'utf8').replace('name="pixel" port="0" bus="0"', 'name="pixel" port="2" bus="1"'))
  run(dir, ['result', '--test', 'low-light', '--value', '0.68', '--by', 'R'])
  const r = run(dir, ['status', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json'])
  assert.equal(r.code, 2)
  assert.match(r.out, /VALIDATION FAILED/)
  assert.match(r.out, /LATEST RECORDED RESULT IS FAIL/)
  assert.match(r.out, /REGRESSION: low-light 0\.92 → 0\.68/)
})
test('CLI: an UNKNOWN result never satisfies — the demand stays open', () => {
  const dir = workspace()
  wire(dir)
  run(dir, ['state', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json'])
  writeFileSync(join(dir, 'robot.xml'), readFileSync(join(dir, 'robot.xml'), 'utf8').replace('name="pixel" port="0" bus="0"', 'name="pixel" port="2" bus="1"'))
  run(dir, ['result', '--test', 'low-light', '--unknown', '--notes', 'rig unavailable', '--by', 'R'])
  const r = run(dir, ['status', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json'])
  assert.equal(r.code, 3)
  assert.match(r.out, /re-run test "low-light"/)
})
test('CLI: defining a test with a threshold requires --by; undefined-test results warn but record', () => {
  const dir = workspace()
  const noBy = run(dir, ['tests', '--define', '--id', 'x', '--kind', 'validation', '--label', 'X', '--min', '0.5'])
  assert.equal(noBy.code, 1)
  const undef = run(dir, ['result', '--test', 'mystery', '--value', '3', '--by', 'R'])
  assert.equal(undef.code, 0)
  assert.match(undef.out, /no definition/)
  assert.match(undef.out, /UNKNOWN/)
})
