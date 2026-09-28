// Physical fingerprints — measured references, authored tolerances, honest
// absences. Locked here:
//   - malformed fingerprints are refused at the report door (fail-closed)
//   - captures fold into verified states as observed evidence
//   - drift beyond an AUTHORED tolerance is a Change that flows through the
//     graph like any other; within tolerance is standing; no tolerance is a
//     stated gap (VERIFICATION INCOMPLETE), never a silent "unchanged"
//   - a fingerprint not re-measured is a gap, never "unchanged"
//   - exact keys (tolerance 0) catch a different reference target (tag id)
//   - the angle mode compares gravity-style vectors as a 3D angle

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareFingerprints, validateFingerprintDef } from '../src/fingerprints.js'
import { parseRobotReport } from '../src/sensors.js'

const APP = new URL('..', import.meta.url).pathname
const demo = JSON.parse(readFileSync(join(APP, 'fixtures/camera_reported_demo.json'), 'utf8'))

const run = (dir, a) => {
  const r = spawnSync(process.execPath, [join(APP, 'bin/physync.js'), ...a], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
const HUB = { address: 173, parent: true, firmware: 'HW: 20, Maj: 1, Min: 8, Eng: 2', volts: 12.8 }
const FP_IMU = { id: 'imu-gravity', method: 'imu-gravity-rest', values: { pitchDeg: 0.5, rollDeg: -0.3 } }
const FP_CAM = { id: 'camera-pose:cam', method: 'apriltag-pose-reference', values: { tagId: 5, rangeIn: 24.1, bearingDeg: -1.2, yawDeg: 0.4 } }
const report = (fps) => JSON.stringify({ physyncRobot: 1, hubs: [HUB], sensors: [], fingerprints: fps })
const DEFS = {
  defs: [
    { id: 'imu-gravity', tolerance: { pitchDeg: 2, rollDeg: 2 }, definedBy: 'Demo Mentor (simulated)' },
    { id: 'camera-pose:cam', tolerance: { tagId: 0, rangeIn: 2, bearingDeg: 2, yawDeg: 2 }, definedBy: 'Demo Mentor (simulated)' },
  ],
}

function workspace({ defs = DEFS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'physync-fp-'))
  mkdirSync(join(dir, '.physync'), { recursive: true })
  if (defs) writeFileSync(join(dir, '.physync/fingerprints.json'), JSON.stringify(defs, null, 2))
  writeFileSync(join(dir, 'robot.xml'), demo.configXml)
  mkdirSync(join(dir, 'code'), { recursive: true })
  for (const f of demo.files) writeFileSync(join(dir, 'code', f.name), f.content)
  writeFileSync(join(dir, 'rob.json'), report([FP_IMU, FP_CAM]))
  const saved = run(dir, ['state', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json'])
  assert.equal(saved.code, 0, `V1 must save: ${saved.out}`)
  return dir
}
const statusJson = (dir) => JSON.parse(run(dir, ['status', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json', '--json']).out.replace(/^[^{]*/, ''))

// ── the report door ────────────────────────────────────────────────────────
test('malformed fingerprints are refused: non-finite values, empty values, bad ids, duplicates', () => {
  const bad = (fps) => () => parseRobotReport(report(fps))
  assert.throws(bad([{ id: 'x', method: 'm', values: { a: Infinity } }]), /finite/)
  assert.throws(bad([{ id: 'x', method: 'm', values: {} }]), /measured nothing/)
  assert.throws(bad([{ id: 'has space', method: 'm', values: { a: 1 } }]), /illegal id/)
  assert.throws(bad([{ id: 'x', values: { a: 1 } }]), /names no method/)
  assert.throws(bad([FP_IMU, FP_IMU]), /more than once/)
  const ok = parseRobotReport(report([FP_IMU]))
  assert.equal(ok.fingerprints.length, 1)
})

test('a tolerance def without an author is refused — thresholds have owners', () => {
  assert.throws(() => validateFingerprintDef({ id: 'x', tolerance: { a: 1 } }), /decisions have authors/)
  assert.throws(() => validateFingerprintDef({ id: 'x', tolerance: {}, definedBy: 'me' }), /tolerates nothing/)
  assert.throws(() => validateFingerprintDef({ id: 'x', tolerance: { a: -1 }, definedBy: 'me' }), /≥ 0/)
})

// ── capture → verified state ───────────────────────────────────────────────
test('fingerprints fold into the verified state as observed evidence with their method', () => {
  const dir = workspace()
  const v1 = JSON.parse(readFileSync(join(dir, '.physync/states/V1.json'), 'utf8'))
  const imu = v1.evidence.find((e) => e.id === 'fingerprint:imu-gravity')
  assert.equal(imu.result, 'PASS')
  assert.equal(imu.source, 'observed')
  assert.equal(imu.method, 'imu-gravity-rest')
  assert.ok(v1.observed.fingerprints.some((f) => f.id === 'camera-pose:cam'))
})

// ── the comparison laws ────────────────────────────────────────────────────
test('within authored tolerance → standing; unchanged robot stays VERIFIED', () => {
  const dir = workspace()
  const j = statusJson(dir)
  assert.equal(j.status, 'VERIFIED FOR DEFINED CHECKS')
  assert.ok(j.standing.some((s) => s.includes('fingerprint:imu-gravity') && s.includes('within the tolerance')))
})

test('drift beyond the authored tolerance is a MEASURED change and flows through approved edges', () => {
  const dir = workspace()
  writeFileSync(join(dir, 'rob.json'), report([FP_IMU, { ...FP_CAM, values: { ...FP_CAM.values, yawDeg: 6.4 } }]))
  const j = statusJson(dir)
  assert.equal(j.status, 'REVALIDATION REQUIRED')
  const drift = j.changes.find((c) => c.kind === 'fingerprint-drift')
  assert.equal(drift.component, 'fingerprint:camera-pose:cam')
  assert.equal(drift.source, 'observed')
  assert.match(drift.detail, /yawDeg Δ6 > 2/)
  assert.match(drift.detail, /tolerance by Demo Mentor/)
  // with nothing approved, the drift surfaces for hand review — never vanishes
  assert.ok(j.revalidation.unmappedChanges.some((u) => u.includes('fingerprint:camera-pose:cam')))
  // approve the pack chain: measured drift now demands the calibration + test
  run(dir, ['rules', '--pack', 'camera-pose'])
  for (const id of ['camera-pose:02', 'camera-pose:03']) {
    assert.equal(run(dir, ['graph', '--approve', id, '--by', 'Demo Mentor (simulated)']).code, 0)
  }
  const j2 = statusJson(dir)
  const actions = j2.revalidation.required.map((r) => r.action)
  assert.ok(actions.includes('calibration:camera-pose'))
  assert.ok(actions.includes('test:localization'))
  assert.ok(j2.revalidation.required.every((r) => r.because.some((b) => b.includes('fingerprint-drift'))))
})

test('a DIFFERENT AprilTag (exact key, tolerance 0) is a drift — a new reference target is not comparable silently', () => {
  const dir = workspace()
  writeFileSync(join(dir, 'rob.json'), report([FP_IMU, { ...FP_CAM, values: { ...FP_CAM.values, tagId: 9 } }]))
  const j = statusJson(dir)
  const drift = j.changes.find((c) => c.kind === 'fingerprint-drift')
  assert.ok(drift, 'tag change must register')
  assert.match(drift.detail, /tagId/)
})

test('no authored tolerance → measured twice, NOT compared, stated as a gap → VERIFICATION INCOMPLETE', () => {
  const dir = workspace({ defs: null })
  const j = statusJson(dir)
  assert.equal(j.status, 'VERIFICATION INCOMPLETE')
  assert.ok(j.gaps.some((g) => g.includes('NO AUTHORED TOLERANCE')))
  assert.equal(j.changes.filter((c) => c.kind === 'fingerprint-drift').length, 0, 'no invented judgment')
})

test('a fingerprint not re-measured is a stated gap, never "unchanged"', () => {
  const dir = workspace()
  writeFileSync(join(dir, 'rob.json'), report([FP_IMU])) // camera fingerprint absent this run
  const j = statusJson(dir)
  assert.ok(j.gaps.some((g) => g.includes('fingerprint:camera-pose:cam') && g.includes('not re-measured')))
})

test('imu drift beyond per-key tolerance registers with the imu-mount pack chain (proposed stays inert first)', () => {
  const dir = workspace()
  writeFileSync(join(dir, 'rob.json'), report([{ ...FP_IMU, values: { pitchDeg: 4.2, rollDeg: -0.3 } }, FP_CAM]))
  let j = statusJson(dir)
  const drift = j.changes.find((c) => c.kind === 'fingerprint-drift' && c.component === 'fingerprint:imu-gravity')
  assert.ok(drift)
  assert.equal(j.revalidation.required.length, 0, 'proposed imu-mount edges must do nothing yet')
  run(dir, ['rules', '--pack', 'imu-mount'])
  for (const id of ['imu-mount:01', 'imu-mount:02']) run(dir, ['graph', '--approve', id, '--by', 'Demo Mentor (simulated)'])
  j = statusJson(dir)
  const actions = j.revalidation.required.map((r) => r.action)
  assert.ok(actions.includes('calibration:imu-heading'))
  assert.ok(actions.includes('test:localization'))
})

// ── the angle mode (vector fingerprints) ───────────────────────────────────
test('angleDeg mode: 3D vector drift judged as an angle; zero vectors are invalid, never silently fine', () => {
  const defs = [{ id: 'g', tolerance: { angleDeg: 2 }, definedBy: 'M' }]
  const prior = [{ id: 'g', method: 'm', values: { x: 0, y: 0, z: 1 } }]
  const same = compareFingerprints({ prior, current: [{ id: 'g', method: 'm', values: { x: 0.01, y: 0, z: 1 } }], defs })
  assert.equal(same.changes.length, 0)
  assert.equal(same.standing.length, 1)
  const tilted = compareFingerprints({ prior, current: [{ id: 'g', method: 'm', values: { x: 0.1, y: 0, z: 1 } }], defs })
  assert.equal(tilted.changes.length, 1)
  assert.match(tilted.changes[0].detail, /vector angle/)
  const zero = compareFingerprints({ prior, current: [{ id: 'g', method: 'm', values: { x: 0, y: 0, z: 0 } }], defs })
  assert.equal(zero.changes.length, 1)
  assert.match(zero.changes[0].detail, /zero-length/)
})

test('a first-ever measurement is standing (joins the baseline next save), and no robot report means every stored fingerprint is a gap', () => {
  const firstEver = compareFingerprints({ prior: [], current: [FP_IMU], defs: [] })
  assert.equal(firstEver.changes.length, 0)
  assert.ok(firstEver.standing.some((s) => s.includes('first measurement')))
  const noReport = compareFingerprints({ prior: [FP_IMU], current: null, defs: [] })
  assert.ok(noReport.gaps.some((g) => g.includes('no robot report supplied')))
})
