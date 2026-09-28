// Verified-state layer (Phase 2 of the new direction). Properties locked:
// states are immutable and self-proving; UNKNOWN is a first-class result and
// missing evidence NEVER becomes PASS; history is append-only; legacy
// artifacts migrate without loss or destruction; change records always say
// which layer (declared/observed) the knowledge came from; and the four
// deployment statuses claim exactly what the evidence supports.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildVerifiedState, validateState, saveState, listStates, latestState, nextVersion,
  migrateLegacy, detectChanges, deploymentStatus, statusExitCode, stableStringify,
  STATUSES, STATE_FORMAT,
} from '../src/state.js'
import { buildApproval } from '../src/approval.js'
import { ENGINE_VERSION } from '../src/registry.js'

const APP = new URL('..', import.meta.url).pathname
const CONFIG_XML = '<Robot type="FirstInspires-FTC"><Motor name="m" port="0" /></Robot>'
const ROBOT = {
  hubs: [{ address: 173, firmware: 'HW: 20, Maj: 1, Min: 8, Eng: 2' }],
  sensors: [
    { name: 'imu', type: 'IMU', class: 'i2c', read: 'ok', determinable: true },
    { name: 'limit', type: 'RevTouchSensor', class: 'digital', read: 'ok', determinable: false },
    { name: 'dist', type: 'Rev2mDistanceSensor', class: 'i2c', read: 'zeros', determinable: true },
    { name: 'dead', type: 'RevColorSensorV3', class: 'i2c', read: 'error', determinable: true },
  ],
}
const STIM = {
  motors: [{ name: 'm', result: 'moved-positive', deltaTicks: 90 }, { name: 'quiet', result: 'no-response', deltaTicks: 0 }],
  servos: [{ name: 'claw', confirmed: true }, { name: 'wrist', confirmed: false }],
}
const mk = (over = {}) => buildVerifiedState({
  version: 1, configName: 'robot', configXml: CONFIG_XML,
  devices: [{ name: 'm', type: 'Motor', port: 0, bus: null }],
  checkVerdict: 'PASS', robot: ROBOT, stimulus: STIM,
  engineVersion: ENGINE_VERSION, now: '2026-09-09T12:00:00.000Z', ...over,
})
const resOf = (state, id) => state.evidence.find((e) => e.id === id)?.result

// ── stableStringify: the digest's foundation ───────────────────────────────
test('stableStringify: key order never changes the serialization', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), stableStringify({ a: { c: 3, d: 2 }, b: 1 }))
})
test('stableStringify: arrays keep order (order IS data there)', () => {
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]))
})

// ── UNKNOWN is a first-class result, mapped by evidence rules ──────────────
test('UNKNOWN: a hub pin that reads clean is UNKNOWN, never PASS', () => {
  assert.equal(resOf(mk(), 'sensor-liveness:limit'), 'UNKNOWN')
})
test('UNKNOWN: an all-zeros I2C read is UNKNOWN — confirm by hand, not assume', () => {
  assert.equal(resOf(mk(), 'sensor-liveness:dist'), 'UNKNOWN')
})
test('FAIL: an I2C non-answer is FAIL — evidence conflicts, not absence of it', () => {
  assert.equal(resOf(mk(), 'sensor-liveness:dead'), 'FAIL')
})
test('PASS: an answering I2C sensor is PASS', () => {
  assert.equal(resOf(mk(), 'sensor-liveness:imu'), 'PASS')
})
test('UNKNOWN: a motor with no encoder response is UNKNOWN — load and unplugged look identical', () => {
  assert.equal(resOf(mk(), 'motor-response:quiet'), 'UNKNOWN')
})
test('PASS: a moved motor is PASS with the delta as evidence', () => {
  assert.equal(resOf(mk(), 'motor-response:m'), 'PASS')
})
test('human source: a confirmed servo is PASS credited to a human, an unconfirmed one is UNKNOWN', () => {
  const s = mk()
  const confirmed = s.evidence.find((e) => e.id === 'servo-response:claw')
  assert.equal(confirmed.result, 'PASS')
  assert.equal(confirmed.source, 'human')
  assert.equal(resOf(s, 'servo-response:wrist'), 'UNKNOWN')
})
test('absence is coverage, not evidence: no robot report → no fabricated hub items', () => {
  const s = mk({ robot: undefined, stimulus: undefined })
  assert.equal(s.coverage.hubs, false)
  assert.ok(!s.evidence.some((e) => e.id === 'hub-census'), 'no census evidence may exist without a census')
})
test('a FAILING check cannot become a verified state', () => {
  assert.throws(() => mk({ checkVerdict: 'FAIL' }), /Refusing/)
})
test('illegal evidence results are unrepresentable', () => {
  const s = JSON.parse(JSON.stringify(mk()))
  s.evidence[0].result = 'MAYBE'
  assert.throws(() => validateState({ ...s }), /illegal|integrity/)
})

// ── integrity: states are self-proving, corruption fails closed ────────────
test('a state validates after a JSON round trip', () => {
  validateState(JSON.parse(JSON.stringify(mk())))
})
test('any edited field breaks the digest', () => {
  for (const mutate of [
    (s) => { s.declared.configSha256 = 'b'.repeat(64) },
    (s) => { s.evidence.find((e) => e.result === 'UNKNOWN').result = 'PASS' }, // laundering an UNKNOWN into PASS must be caught
    (s) => { s.version = 9 },
    (s) => { s.observed.hubs[0].address = 3 },
  ]) {
    const s = JSON.parse(JSON.stringify(mk()))
    mutate(s)
    assert.throws(() => validateState(s), /integrity/, 'every covered field must be load-bearing')
  }
})

// ── append-only history ────────────────────────────────────────────────────
test('saveState appends and REFUSES to overwrite any existing version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'physync-state-'))
  saveState(mk(), dir)
  assert.throws(() => saveState(mk(), dir), /never overwritten/)
  saveState(mk({ version: 2, now: '2026-09-10T12:00:00.000Z' }), dir)
  const all = listStates(dir)
  assert.deepEqual(all.map((s) => s.version), [1, 2])
  assert.equal(latestState(dir).version, 2)
  assert.equal(nextVersion(dir), 3)
})
test('a corrupted file in the ledger fails the LOAD loudly instead of skipping quietly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'physync-state-'))
  saveState(mk(), dir)
  const path = join(dir, '.physync/states/V1.json')
  writeFileSync(path, readFileSync(path, 'utf8').replace('"robot"', '"tampered"'))
  assert.throws(() => listStates(dir), /integrity/)
})

// ── legacy migration ───────────────────────────────────────────────────────
const legacyDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'physync-legacy-'))
  mkdirSync(join(dir, '.physync'), { recursive: true })
  const approval = buildApproval({
    configName: 'oldbot', configXml: CONFIG_XML,
    hubs: [{ address: 173, firmware: 'HW: 20, Maj: 1, Min: 8, Eng: 2' }], hubsVerified: true,
    devices: [{ name: 'm', type: 'Motor', port: 0, bus: null }],
    engineVersion: ENGINE_VERSION, now: '2026-09-01T00:00:00.000Z',
  })
  writeFileSync(join(dir, '.physync/approved.json'), JSON.stringify(approval, null, 2))
  return dir
}
test('migration: a legacy approval becomes V1 with origin marked and hubs carried', () => {
  const dir = legacyDir()
  const v1 = migrateLegacy(dir, { engineVersion: ENGINE_VERSION })
  assert.equal(v1.version, 1)
  assert.equal(v1.origin, 'legacy-approval')
  assert.equal(v1.declared.configName, 'oldbot')
  assert.deepEqual(v1.observed.hubs, [{ address: 173, firmware: '1.8.2' }])
  assert.equal(v1.coverage.sensors, false, 'what the legacy layer never established stays absent')
  validateState(JSON.parse(readFileSync(join(dir, '.physync/states/V1.json'), 'utf8')))
})
test('migration: never destroys the legacy file, never runs twice, no-ops cleanly with nothing to migrate', () => {
  const dir = legacyDir()
  migrateLegacy(dir, { engineVersion: ENGINE_VERSION })
  assert.ok(existsSync(join(dir, '.physync/approved.json')), 'legacy artifact must survive')
  assert.equal(migrateLegacy(dir, { engineVersion: ENGINE_VERSION }), null, 'second call is a no-op')
  const empty = mkdtempSync(join(tmpdir(), 'physync-empty-'))
  assert.equal(migrateLegacy(empty, { engineVersion: ENGINE_VERSION }), null)
})

// ── change detection: every record says which layer knew ──────────────────
const cand = (over = {}) => ({ configName: 'robot', configXml: CONFIG_XML, hubs: ROBOT.hubs, sensors: ROBOT.sensors, ...over })

test('changes: identical candidate → no changes, no gaps, stimulus standing', () => {
  const { changes, gaps, standing } = detectChanges(mk(), cand())
  assert.deepEqual(changes, [])
  assert.deepEqual(gaps, [])
  assert.equal(standing.length, 1, 'stimulus evidence stands until invalidated')
})
test('changes: config byte change is DECLARED knowledge via byte-sha256', () => {
  const { changes } = detectChanges(mk(), cand({ configXml: CONFIG_XML + ' ' }))
  assert.equal(changes.length, 1)
  assert.equal(changes[0].kind, 'config-changed')
  assert.equal(changes[0].source, 'declared')
  assert.equal(changes[0].method, 'byte-sha256')
})
test('changes: a re-addressed hub is a missing+added PAIR, both OBSERVED', () => {
  const { changes } = detectChanges(mk(), cand({ hubs: [{ address: 3, firmware: 'HW: 20, Maj: 1, Min: 8, Eng: 2' }] }))
  assert.deepEqual(changes.map((c) => c.kind).sort(), ['hub-added', 'hub-missing'])
  assert.ok(changes.every((c) => c.source === 'observed' && c.method === 'lynx-census'))
})
test('changes: firmware compares NORMALIZED — a spelling change is not a change', () => {
  const { changes } = detectChanges(mk(), cand({ hubs: [{ address: 173, firmware: 'Maj: 1, Min: 8, Eng: 2' }] }))
  assert.deepEqual(changes, [])
  const real = detectChanges(mk(), cand({ hubs: [{ address: 173, firmware: 'Maj: 1, Min: 9, Eng: 0' }] }))
  assert.equal(real.changes[0].kind, 'firmware-changed')
  assert.equal(real.changes[0].previous, '1.8.2')
  assert.equal(real.changes[0].current, '1.9.0')
})
test('changes: sensor vanish / type-swap / response-lost each carry the right kind', () => {
  const gone = detectChanges(mk(), cand({ sensors: ROBOT.sensors.filter((s) => s.name !== 'imu') }))
  assert.ok(gone.changes.some((c) => c.kind === 'sensor-missing' && /imu/.test(c.component)))
  const swapped = detectChanges(mk(), cand({ sensors: ROBOT.sensors.map((s) => s.name === 'imu' ? { ...s, type: 'BNO055' } : s) }))
  assert.ok(swapped.changes.some((c) => c.kind === 'sensor-type-changed'))
  const lost = detectChanges(mk(), cand({ sensors: ROBOT.sensors.map((s) => s.name === 'imu' ? { ...s, read: 'error' } : s) }))
  assert.ok(lost.changes.some((c) => c.kind === 'sensor-response-lost'))
})
test('gaps: omitting a covered layer is a GAP, never assumed unchanged', () => {
  const { gaps } = detectChanges(mk(), { configName: 'robot', configXml: CONFIG_XML })
  assert.equal(gaps.length, 2, 'hub census and sensor liveness both uncomparable')
})
test('gaps: layers the state never covered produce no gap (nothing to compare against)', () => {
  const bare = mk({ robot: undefined, stimulus: undefined })
  const { gaps, standing } = detectChanges(bare, { configName: 'robot', configXml: CONFIG_XML })
  assert.deepEqual(gaps, [])
  assert.deepEqual(standing, [])
})

// ── deployment status: exactly four claims, priority-ordered ───────────────
test('status: FAIL outranks change outranks gap outranks verified', () => {
  assert.equal(deploymentStatus({ failFindings: 1, changes: [{}], gaps: ['x'] }), STATUSES.FAILED)
  assert.equal(deploymentStatus({ failFindings: 0, changes: [{}], gaps: ['x'] }), STATUSES.REVALIDATION)
  assert.equal(deploymentStatus({ failFindings: 0, changes: [], gaps: ['x'] }), STATUSES.INCOMPLETE)
  assert.equal(deploymentStatus({ failFindings: 0, changes: [], gaps: [] }), STATUSES.VERIFIED)
})
test('status: UNKNOWN in required checks drives INCOMPLETE — missing evidence is never a pass', () => {
  assert.equal(deploymentStatus({ failFindings: 0, changes: [], gaps: [], unknownRequired: 1 }), STATUSES.INCOMPLETE)
})
test('exit codes: 0 verified · 2 failed · 3 anything requiring action', () => {
  assert.equal(statusExitCode(STATUSES.VERIFIED), 0)
  assert.equal(statusExitCode(STATUSES.FAILED), 2)
  assert.equal(statusExitCode(STATUSES.REVALIDATION), 3)
  assert.equal(statusExitCode(STATUSES.INCOMPLETE), 3)
})

// ── the CLI, end to end ────────────────────────────────────────────────────
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'physync-statecli-'))
  writeFileSync(join(dir, 'robot.xml'), '<Robot type="FirstInspires-FTC"><LynxUsbDevice name="P" serialNumber="X" parentModuleAddress="173"><LynxModule name="Control Hub" port="173"><goBILDA5202SeriesMotor name="left_drive" port="0" /></LynxModule></LynxUsbDevice></Robot>')
  mkdirSync(join(dir, 'code'))
  writeFileSync(join(dir, 'code/T.java'), 'class T { void i(HardwareMap hardwareMap){ a = hardwareMap.get(DcMotor.class, "left_drive"); } }')
  writeFileSync(join(dir, 'rob.json'), JSON.stringify({ physyncRobot: 1, hubs: [{ address: 173, parent: true, firmware: 'HW: 20, Maj: 1, Min: 8, Eng: 2', volts: 12.7 }], sensors: [], deviceCount: 1 }))
  return dir
}
const run = (dir, a) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [join(APP, 'bin/physync.js'), ...a], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }) }
  } catch (e) { return { code: e.status, out: String(e.stdout ?? '') + String(e.stderr ?? '') } }
}

test('CLI: state → states → status → drift → status exits 3 with named changes', () => {
  const dir = workspace()
  assert.equal(run(dir, ['state', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json']).code, 0)
  const list = run(dir, ['states'])
  assert.match(list.out, /V1 · /)
  const clean = run(dir, ['status', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json'])
  assert.equal(clean.code, 0)
  assert.match(clean.out, /VERIFIED FOR DEFINED CHECKS/)
  writeFileSync(join(dir, 'rob.json'), JSON.stringify({ physyncRobot: 1, hubs: [{ address: 3, parent: true, firmware: 'HW: 20, Maj: 1, Min: 8, Eng: 2', volts: 12.7 }], sensors: [], deviceCount: 1 }))
  const drift = run(dir, ['status', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json'])
  assert.equal(drift.code, 3)
  assert.match(drift.out, /REVALIDATION REQUIRED/)
  assert.match(drift.out, /hub @173.*→ \(absent\)/)
  assert.match(drift.out, /hub @3.*\(absent\) →/)
})
test('CLI: status without the robot report is INCOMPLETE when the state covers hubs', () => {
  const dir = workspace()
  run(dir, ['state', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json'])
  const r = run(dir, ['status', '--config', 'robot.xml', '--code', 'code'])
  assert.equal(r.code, 3)
  assert.match(r.out, /VERIFICATION INCOMPLETE/)
  assert.match(r.out, /hub census/)
})
test('CLI: a second `state` saves V2 and never touches V1', () => {
  const dir = workspace()
  run(dir, ['state', '--config', 'robot.xml', '--code', 'code'])
  const v1 = readFileSync(join(dir, '.physync/states/V1.json'), 'utf8')
  run(dir, ['state', '--config', 'robot.xml', '--code', 'code'])
  assert.equal(readFileSync(join(dir, '.physync/states/V1.json'), 'utf8'), v1)
  assert.ok(existsSync(join(dir, '.physync/states/V2.json')))
})
test('CLI: a FAILING check cannot be saved as a state', () => {
  const dir = workspace()
  writeFileSync(join(dir, 'code/T.java'), 'class T { void i(HardwareMap hardwareMap){ a = hardwareMap.get(DcMotor.class, "left_dirve"); } }')
  const r = run(dir, ['state', '--config', 'robot.xml', '--code', 'code'])
  assert.equal(r.code, 1)
  assert.match(r.out, /Refusing to save a verified state/)
  assert.ok(!existsSync(join(dir, '.physync/states')))
})
test('CLI: legacy approve → status auto-migrates to V1 without destroying approved.json', () => {
  const dir = workspace()
  run(dir, ['approve', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json'])
  const r = run(dir, ['status', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json'])
  assert.equal(r.code, 0)
  assert.match(r.out, /vs verified state V1/)
  assert.ok(existsSync(join(dir, '.physync/approved.json')), 'legacy file must survive migration')
  assert.match(run(dir, ['states']).out, /legacy-approval/)
})
test('CLI: --json status carries changes, gaps, standing, and the exit code', () => {
  const dir = workspace()
  run(dir, ['state', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json'])
  writeFileSync(join(dir, 'robot.xml'), readFileSync(join(dir, 'robot.xml'), 'utf8') + ' ')
  const r = run(dir, ['status', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json', '--json'])
  const j = JSON.parse(r.out)
  assert.equal(j.status, 'REVALIDATION REQUIRED')
  assert.equal(j.exit, 3)
  assert.ok(j.changes.some((c) => c.kind === 'config-changed' && c.source === 'declared'))
})
