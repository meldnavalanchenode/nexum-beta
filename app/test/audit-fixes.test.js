// Regression locks for the focused-loop audit (2026-10-05, 9 confirmed, 0
// refuted). Four P0s, and every one of them made Nexum assert something it
// could not support — the single failure mode the product exists to prevent.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
const winBasename = win32.basename
import { buildVerifiedState } from '../src/state.js'
import { plan } from '../src/planner.js'
import { ENGINE_VERSION } from '../src/registry.js'

const APP = fileURLToPath(new URL('..', import.meta.url))
const demo = JSON.parse(readFileSync(join(APP, 'fixtures/camera_reported_demo.json'), 'utf8'))
const run = (dir, a) => {
  const r = spawnSync(process.execPath, [join(APP, 'bin/physync.js'), ...a], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
const statusJson = (dir, extra = []) => JSON.parse(run(dir, ['status', '--config', 'robot.xml', '--code', 'code', ...extra, '--json']).out.replace(/^[^{]*/, ''))
const appOf = (j, id) => j.revalidation?.applicability?.find((a) => a.evidenceId === id)

const CONFIG = demo.configXml
const robotReport = (over = {}) => ({
  physyncRobot: 1,
  hubs: [{ address: 173, parent: true, firmware: 'HW: 20, Maj: 1, Min: 8, Eng: 2', volts: 12.7 }],
  sensors: [{ name: 'camera', type: 'HuskyLens', class: 'i2c', read: 'ok', value: 'blocks=2', livenessDeterminable: true }],
  deviceCount: 2, ...over,
})
function base(withFingerprint = false) {
  const dir = mkdtempSync(join(tmpdir(), 'physync-audit-'))
  mkdirSync(join(dir, '.physync'), { recursive: true })
  writeFileSync(join(dir, 'robot.xml'), CONFIG)
  mkdirSync(join(dir, 'code'), { recursive: true })
  for (const f of demo.files) writeFileSync(join(dir, 'code', f.name), f.content)
  if (withFingerprint) {
    writeFileSync(join(dir, '.physync/fingerprints.json'), JSON.stringify({ defs: [{ id: 'imu-gravity', tolerance: { pitchDeg: 2 }, definedBy: 'Raghu' }] }))
  }
  return dir
}

// ── P0: the identity relation ──────────────────────────────────────────────
test('a drifted fingerprint does NOT report its own measurement as still applicable', () => {
  const dir = base(true)
  const fp = (pitch) => robotReport({ fingerprints: [{ id: 'imu-gravity', method: 'imu-rest-vector', values: { pitchDeg: pitch } }] })
  writeFileSync(join(dir, 'rob.json'), JSON.stringify(fp(0.4)))
  assert.equal(run(dir, ['state', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json']).code, 0)
  writeFileSync(join(dir, 'rob.json'), JSON.stringify(fp(14.7)))   // 12.7° past Raghu's 2° tolerance
  const j = statusJson(dir, ['--robot', 'rob.json'])
  assert.ok(j.changes.some((c) => c.kind === 'fingerprint-drift'), 'the drift is detected')
  const row = appOf(j, 'fingerprint:imu-gravity')
  assert.equal(row.applicability, 'REVALIDATE', 'the measurement the robot CONTRADICTED cannot read as applicable')
  assert.deepEqual(row.reasonCodes, ['MEASURED_DRIFT'])
  assert.ok(j.revalidation.invalidated.some((i) => i.evidenceId === 'fingerprint:imu-gravity'))
})

test('a human-reported change naming an evidence row directly revalidates that row', () => {
  const state = buildVerifiedState({
    version: 1, configName: 'robot', configXml: CONFIG,
    devices: [], checkVerdict: 'PASS',
    results: [{ testId: 'localization', kind: 'validation', verdict: 'PASS', value: 0.95, recordedBy: 'R' }],
    engineVersion: ENGINE_VERSION, now: '2026-10-01T00:00:00.000Z',
  })
  const r = plan({
    state,
    changes: [{ id: 'c1', kind: 'physical-change-reported', component: 'test:localization', source: 'human', method: 'self-reported', by: 'Raghu', note: 'rebuilt the field' }],
    graph: { builtin: [], custom: [] },
  })
  const row = r.applicability.find((a) => a.evidenceId === 'test:localization')
  assert.equal(row.applicability, 'REVALIDATE')
  assert.equal(row.result, 'PASS', 'history itself is untouched')
  assert.deepEqual(row.reasonCodes, ['PHYSICAL_CHANGE_REPORTED'])
})

// ── P0: per-target re-derivation ───────────────────────────────────────────
test('a report that OMITS a sensor does not relabel its evidence RE-DERIVED, and the recheck stays owed', () => {
  const dir = base()
  writeFileSync(join(dir, 'rob.json'), JSON.stringify(robotReport()))
  assert.equal(run(dir, ['state', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json']).code, 0)
  // firmware moves (so the preflight family is demanded) AND the camera vanishes
  writeFileSync(join(dir, 'rob2.json'), JSON.stringify(robotReport({
    hubs: [{ address: 173, parent: true, firmware: 'HW: 20, Maj: 1, Min: 9, Eng: 0', volts: 12.7 }], sensors: [],
  })))
  const j = statusJson(dir, ['--robot', 'rob2.json'])
  const row = appOf(j, 'sensor-liveness:camera')
  assert.notEqual(row.applicability, 'RE-DERIVED THIS RUN', 'a report that never mentioned the sensor re-derived nothing about it')
  assert.equal(row.applicability, 'REVALIDATE')
  assert.ok(j.revalidation.required.some((r) => r.action === 'preflight'), 'and the preflight recheck is still owed')
})

test('a sensor reading error does not relabel its prior PASS as re-derived', () => {
  const dir = base()
  writeFileSync(join(dir, 'rob.json'), JSON.stringify(robotReport()))
  run(dir, ['state', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json'])
  writeFileSync(join(dir, 'rob2.json'), JSON.stringify(robotReport({
    hubs: [{ address: 173, parent: true, firmware: 'HW: 20, Maj: 1, Min: 9, Eng: 0', volts: 12.7 }],
    sensors: [{ name: 'camera', type: 'HuskyLens', class: 'i2c', read: 'error', value: '', livenessDeterminable: true }],
  })))
  const j = statusJson(dir, ['--robot', 'rob2.json'])
  assert.notEqual(appOf(j, 'sensor-liveness:camera').applicability, 'RE-DERIVED THIS RUN')
})

// ── P1: a proposed hop ANYWHERE upstream means UNKNOWN ─────────────────────
test('proposed → approved chain yields UNKNOWN, never a manufactured APPLICABLE', () => {
  const state = buildVerifiedState({
    version: 1, configName: 'robot', configXml: CONFIG, devices: [], checkVerdict: 'PASS',
    results: [{ testId: 'localization', kind: 'validation', verdict: 'PASS', value: 0.95, recordedBy: 'R' }],
    engineVersion: ENGINE_VERSION, now: '2026-10-01T00:00:00.000Z',
  })
  const graph = { builtin: [], custom: [
    { id: 'e1', from: 'camera-position', to: 'calibration:pose', status: 'proposed' },
    { id: 'e2', from: 'calibration:pose', to: 'test:localization', status: 'approved', source: 'user-approved', approvedBy: 'Raghu' },
  ] }
  const r = plan({
    state, graph,
    changes: [{ id: 'c1', kind: 'physical-change-reported', component: 'camera-position', source: 'human', method: 'self-reported', by: 'Raghu' }],
  })
  const row = r.applicability.find((a) => a.evidenceId === 'test:localization')
  assert.equal(row.applicability, 'UNKNOWN', 'an unapproved first hop cannot produce positive assurance downstream')
  assert.deepEqual(row.reasonCodes, ['INSUFFICIENT_EVIDENCE'])
  assert.ok(row.via.includes('e1'), 'the unapproved hop is named so a human can rule on it')
})

// ── P0: a baseline FAIL can never render as "verified" ─────────────────────
// The record is KEPT (a baseline that honestly says "the IMU was dead when we
// froze this" beats a refusal that makes the team save nothing) — what is
// refused is the CLAIM. This used to read VERIFIED FOR DEFINED CHECKS forever
// because the status computation had no input for failing baseline evidence.
test('a state carrying a FAILING row is recorded loudly and never reads as verified', () => {
  const dir = base()
  writeFileSync(join(dir, 'rob.json'), JSON.stringify(robotReport({
    sensors: [{ name: 'camera', type: 'HuskyLens', class: 'i2c', read: 'error', value: '', livenessDeterminable: true }],
  })))
  const saved = run(dir, ['state', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json'])
  assert.equal(saved.code, 0, 'the failure is recorded, not refused')
  assert.match(saved.out, /FAILING evidence row\(s\) recorded: sensor-liveness:camera/, 'and never silently')
  const v1 = JSON.parse(readFileSync(join(dir, '.physync/states/V1.json'), 'utf8'))
  assert.equal(v1.evidence.find((e) => e.id === 'sensor-liveness:camera').result, 'FAIL')
  // nothing changed since the save — yet the robot must NOT read as verified
  const j = statusJson(dir, ['--robot', 'rob.json'])
  assert.deepEqual(j.changes, [], 'genuinely unchanged')
  assert.equal(j.status, 'VALIDATION FAILED', 'a known defect in the baseline is never "VERIFIED FOR DEFINED CHECKS"')
  assert.equal(j.exit, 2)
})

test('all-zeros stays UNKNOWN and saveable — stated ignorance is not failure', () => {
  const s = buildVerifiedState({
    version: 1, configName: 'robot', configXml: CONFIG, devices: [], checkVerdict: 'PASS',
    robot: { hubs: [{ address: 173, firmware: '1.8.2' }], sensors: [{ name: 'imu', type: 'IMU', class: 'i2c', read: 'zeros', determinable: true }] },
    engineVersion: ENGINE_VERSION, now: '2026-10-01T00:00:00.000Z',
  })
  assert.equal(s.evidence.find((e) => e.id === 'sensor-liveness:imu').result, 'UNKNOWN')
})

// ── P0 + P1: shadow-record integrity ───────────────────────────────────────
function shadowWorkspace() {
  const dir = base()
  writeFileSync(join(dir, '.physync/tests.json'), JSON.stringify({ tests: demo.tests }, null, 2))
  run(dir, ['result', '--test', 'camera-pose', '--pass', '--by', 'Op'])
  run(dir, ['result', '--test', 'localization', '--value', '0.95', '--by', 'Op'])
  assert.equal(run(dir, ['state', '--config', 'robot.xml', '--code', 'code']).code, 0)
  run(dir, ['rules', '--pack', 'camera-pose'])
  for (const id of ['camera-pose:01', 'camera-pose:02']) run(dir, ['graph', '--approve', id, '--by', 'Mentor'])
  return dir
}
const expFile = (dir) => {
  const d = join(dir, '.physync/experiments')
  const f = readdirSync(d).sort().pop()
  return JSON.parse(readFileSync(join(d, f), 'utf8'))
}

test('the reveal records checks Nexum demanded-and-already-satisfied — not as "the human went beyond Nexum"', () => {
  const dir = shadowWorkspace()
  run(dir, ['change', '--component', 'camera-position', '--note', 're-aimed', '--by', 'Reporter'])
  run(dir, ['result', '--test', 'camera-pose', '--pass', '--by', 'Op'])   // team already redid it
  run(dir, ['predict', '--checks', 'camera-pose, localization', '--by', 'Op'])
  statusJson(dir)
  const e = expFile(dir)
  assert.ok(e.reveal.planActions.includes('calibration:camera-pose'),
    'a demand satisfied this run is still a demand Nexum made')
  run(dir, ['debrief', '--checked', 'camera-pose, localization', '--by', 'Op'])
  const d = expFile(dir).debrief
  assert.deepEqual(d.deltas.predictionBeyondNexum, [], 'no manufactured "Nexum missed it"')
})

test('a zero-change status run does not burn the reveal', () => {
  const dir = shadowWorkspace()
  run(dir, ['predict', '--checks', 'camera-pose', '--by', 'Op'])
  statusJson(dir)                                   // nothing changed yet
  assert.equal(expFile(dir).revealedAt, null, 'there was no answer to reveal')
  run(dir, ['change', '--component', 'camera-position', '--note', 're-aimed', '--by', 'Reporter'])
  statusJson(dir)                                   // the real reveal
  const e = expFile(dir)
  assert.ok(e.revealedAt, 'the reveal happens when there IS an answer')
  assert.ok(e.reveal.planActions.length > 0)
})

test('a debrief is never silently rewritten, and a verdict is never silently replaced', () => {
  const dir = shadowWorkspace()
  run(dir, ['change', '--component', 'camera-position', '--note', 're-aimed', '--by', 'Reporter'])
  run(dir, ['predict', '--checks', 'camera-pose', '--by', 'Op'])
  statusJson(dir)
  assert.equal(run(dir, ['debrief', '--checked', 'camera-pose', '--by', 'Alice']).code, 0)
  assert.equal(run(dir, ['verdict', '--verdict', 'HELPED', '--basis', 'rule 2', '--by', 'Raghu']).code, 0)
  const second = run(dir, ['debrief', '--checked', 'nothing', '--by', 'Mallory'])
  assert.equal(second.code, 1)
  assert.match(second.out, /already debriefed by Alice/)
  const e = expFile(dir)
  assert.equal(e.debrief.by, 'Alice', 'the original observation survives')
  assert.equal(e.debrief.verdict, 'HELPED', 'and so does the human verdict')
  const reverdict = run(dir, ['verdict', '--verdict', 'NO VALUE', '--basis', 'x', '--by', 'Mallory'])
  assert.equal(reverdict.code, 1)
  assert.equal(expFile(dir).debrief.verdict, 'HELPED')
})

test('saving a verified state does not make the debrief impossible', () => {
  const dir = shadowWorkspace()
  run(dir, ['change', '--component', 'camera-position', '--note', 're-aimed', '--by', 'Reporter'])
  run(dir, ['predict', '--checks', 'camera-pose', '--by', 'Op'])
  statusJson(dir)
  run(dir, ['result', '--test', 'camera-pose', '--pass', '--by', 'Op'])
  run(dir, ['result', '--test', 'localization', '--value', '0.96', '--by', 'Op'])
  assert.equal(run(dir, ['state', '--config', 'robot.xml', '--code', 'code']).code, 0)   // seals it
  const d = run(dir, ['debrief', '--checked', 'camera-pose, localization', '--by', 'Op'])
  assert.equal(d.code, 0, `a sealed-but-undebriefed experiment stays debriefable: ${d.out}`)
  assert.ok(expFile(dir).debrief, 'the comparison survives the natural command order')
})

// ── P1: basename, not split('/') ───────────────────────────────────────────
// The config NAME is compared against the Driver Station's active
// configuration name by the on-robot gate, so a path leaking into it is a
// guaranteed false refusal on a healthy robot. `split('/')` never splits a
// Windows path, making every Windows laptop fail that comparison.
test('a nested config path yields the bare config NAME', () => {
  const dir = base()
  mkdirSync(join(dir, 'FIRST'), { recursive: true })
  writeFileSync(join(dir, 'FIRST/robot.xml'), CONFIG)
  assert.equal(run(dir, ['state', '--config', 'FIRST/robot.xml', '--code', 'code']).code, 0)
  const v1 = JSON.parse(readFileSync(join(dir, '.physync/states/V1.json'), 'utf8'))
  assert.equal(v1.declared.configName, 'robot')
})

test('config naming uses path.basename — split("/") is a Windows false-refusal (source law)', () => {
  const src = readFileSync(join(APP, 'bin/physync.js'), 'utf8')
  assert.equal(src.match(/configPath\.split\('\/'\)/g), null,
    "use basename(configPath): on Windows split('/') never splits, so the whole path becomes the config NAME and the on-robot gate refuses a healthy robot")
  // and the platform-specific proof the fix is what Windows needs:
  assert.equal(winBasename('C:\\Users\\team\\FIRST\\robot.xml'), 'robot.xml')
  assert.equal('C:\\Users\\team\\FIRST\\robot.xml'.split('/').pop(), 'C:\\Users\\team\\FIRST\\robot.xml')
})
