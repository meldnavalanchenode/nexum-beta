// Sensor-liveness tests. The property these lock is the honest asymmetry:
// I2C non-answers are evidence (FAIL), digital/analog pins are NOT (INFO,
// never a claim of connectedness) — because a floating hub pin reads like a
// legitimate value and a tool that pretends otherwise is lying quietly.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRobotReport, toSensorBaseline, analyzeSensors, diffSensors } from '../src/sensors.js'
import { verdict } from '../src/engine.js'
import { CHECKS } from '../src/registry.js'

const APP = new URL('..', import.meta.url).pathname
const KNOWN = new Set(CHECKS.map((c) => c.id))
const sensor = (over = {}) => ({ name: 's', type: 'RevColorSensorV3', class: 'i2c', read: 'ok', value: 'r=12 g=30 b=8 a=48', livenessDeterminable: true, ...over })
const robot = (sensors) => JSON.stringify({
  physyncRobot: 1,
  hubs: [{ address: 173, parent: true, firmware: 'Maj: 1, Min: 8, Eng: 2', volts: 12.8 }],
  sensors: sensors ?? [
    sensor({ name: 'pixel_color' }),
    sensor({ name: 'front_dist', type: 'Rev2mDistanceSensor', value: '412mm' }),
    sensor({ name: 'imu', type: 'IMU', value: 'yaw=0.3' }),
    sensor({ name: 'arm_limit', type: 'RevTouchSensor', class: 'digital', value: 'released', livenessDeterminable: false }),
  ],
  deviceCount: 9,
})
const ids = (fs) => fs.map((f) => f.checkId).sort()

// ── parsing ────────────────────────────────────────────────────────────────
test('sensors parse: accepts a well-formed robot report', () => {
  const r = parseRobotReport(robot())
  assert.equal(r.sensors.length, 4)
  assert.equal(r.sensors[0].determinable, true)
})
test('sensors parse: rejects a file without the physyncRobot marker, and says why', () => {
  assert.throws(() => parseRobotReport('{"hubs":[]}'), /physyncRobot/)
  assert.throws(() => parseRobotReport('{"hubs":[]}'), /re-flash/)
})
test('sensors parse: rejects an unknown read result rather than guessing', () => {
  assert.throws(() => parseRobotReport(robot([sensor({ read: 'maybe' })])), /unknown read result/)
})
test('sensors parse: rejects an unknown device class', () => {
  assert.throws(() => parseRobotReport(robot([sensor({ class: 'telepathy' })])), /unknown class/)
})
test('sensors parse: a missing livenessDeterminable FAILS CLOSED (it used to silently become false, turning a dead IMU into an INFO)', () => {
  assert.throws(() => parseRobotReport(JSON.stringify({ physyncRobot: 1, sensors: [{ name: 'x', class: 'i2c', read: 'ok' }] })), /boolean livenessDeterminable/)
  assert.throws(() => parseRobotReport(JSON.stringify({ physyncRobot: 1, sensors: [{ name: 'x', class: 'i2c', read: 'ok', livenessDeterminable: 'true' }] })), /boolean livenessDeterminable/)
})

test('sensors parse: a hub pin is never determinable, whatever the report claims', () => {
  const r = parseRobotReport(JSON.stringify({ physyncRobot: 1, sensors: [{ name: 't', class: 'digital', read: 'error', livenessDeterminable: true }] }))
  assert.equal(r.sensors[0].determinable, false, 'a digital pin must never reach a FAIL path')
})

test('sensors parse: duplicate sensor names are rejected (they made the baseline false-FAIL its own report)', () => {
  assert.throws(() => parseRobotReport(JSON.stringify({ physyncRobot: 1, sensors: [
    { name: 'd', class: 'i2c', read: 'ok', livenessDeterminable: true },
    { name: 'd', class: 'i2c', read: 'ok', livenessDeterminable: true }] })), /more than once/)
})

// ── the honest asymmetry ───────────────────────────────────────────────────
test('sensors: an I2C sensor that never answered FAILs the run', () => {
  const f = analyzeSensors(parseRobotReport(robot([sensor({ name: 'front_dist', read: 'error', value: 'RuntimeException: no response' })])))
  assert.deepEqual(ids(f), ['sensor-not-responding'])
  assert.equal(verdict(f), 'FAIL')
  assert.match(f[0].fix, /I2C cable/)
})
test('sensors: an I2C sensor reading all zeros WARNs, with a way to confirm by hand', () => {
  const f = analyzeSensors(parseRobotReport(robot([sensor({ read: 'zeros', value: 'r=0 g=0 b=0 a=0' })])))
  assert.deepEqual(ids(f), ['sensor-reads-zero'])
  assert.equal(verdict(f), 'PASS', 'weaker inference than a bus error must not red-light a pit')
  assert.match(f[0].fix, /Cover it with your hand/)
})
test('sensors: a digital pin is reported as liveness-unavailable, never as connected', () => {
  const f = analyzeSensors(parseRobotReport(robot([sensor({ name: 'arm_limit', type: 'RevTouchSensor', class: 'digital', value: 'released', livenessDeterminable: false })])))
  assert.deepEqual(ids(f), ['sensor-liveness-unavailable', 'sensor-nothing-verified'])
  assert.equal(f.find((x) => x.checkId === 'sensor-liveness-unavailable').severity, 'INFO')
  assert.equal(verdict(f), 'PASS')
  assert.match(f.find((x) => x.checkId === 'sensor-liveness-unavailable').message, /liveness cannot be determined/)
})
test('sensors: an analog pin gets the same treatment as digital', () => {
  const f = analyzeSensors(parseRobotReport(robot([sensor({ name: 'pot', type: 'AnalogInput', class: 'analog', value: '1.62V', livenessDeterminable: false })])))
  assert.ok(f.some((x) => x.checkId === 'sensor-liveness-unavailable'))
  assert.match(f.find((x) => x.checkId === 'sensor-liveness-unavailable').fix, /analog input reads a value whether or not/)
  assert.equal(verdict(f), 'PASS', 'a robot with only hub pins is legitimate and must never FAIL')
})
test('sensors: a fully healthy I2C-only robot produces no findings', () => {
  const f = analyzeSensors(parseRobotReport(robot([sensor({ name: 'a' }), sensor({ name: 'b', type: 'IMU', value: 'yaw=1.0' })])))
  assert.deepEqual(f, [])
})

// ── baseline ───────────────────────────────────────────────────────────────
test('sensors baseline: records only determinable, answering sensors', () => {
  const b = toSensorBaseline(parseRobotReport(robot()))
  assert.deepEqual(b.sensors.map((s) => s.name), ['front_dist', 'imu', 'pixel_color'])
  assert.ok(!b.sensors.some((s) => s.name === 'arm_limit'), 'a digital pin must never enter the baseline')
})
test('sensors baseline: excludes sensors that were already failing', () => {
  const b = toSensorBaseline(parseRobotReport(robot([sensor({ name: 'ok_one' }), sensor({ name: 'dead', read: 'error' })])))
  assert.deepEqual(b.sensors.map((s) => s.name), ['ok_one'])
})

// ── diff ───────────────────────────────────────────────────────────────────
const baseline = toSensorBaseline(parseRobotReport(robot()))

test('sensors diff: an unchanged run only reports the undeterminable pin', () => {
  const f = diffSensors(baseline, parseRobotReport(robot()))
  assert.deepEqual(ids(f), ['sensor-liveness-unavailable'])
  assert.equal(verdict(f), 'PASS')
})
test('sensors diff: a sensor that answered before and does not now FAILs', () => {
  const f = diffSensors(baseline, parseRobotReport(robot([
    sensor({ name: 'pixel_color' }),
    sensor({ name: 'front_dist', type: 'Rev2mDistanceSensor', read: 'error', value: 'timeout' }),
    sensor({ name: 'imu', type: 'IMU', value: 'yaw=0.3' }),
  ])))
  assert.ok(f.some((x) => x.checkId === 'sensor-response-lost' && /front_dist/.test(x.message)))
  assert.equal(verdict(f), 'FAIL')
})
test('sensors diff: a swapped sensor model FAILs and names both types', () => {
  const f = diffSensors(baseline, parseRobotReport(robot([
    sensor({ name: 'pixel_color', type: 'RevColorSensorV2' }),
    sensor({ name: 'front_dist', type: 'Rev2mDistanceSensor', value: '400mm' }),
    sensor({ name: 'imu', type: 'IMU', value: 'yaw=0.3' }),
  ])))
  const swap = f.find((x) => x.checkId === 'sensor-response-lost' && /changed type/.test(x.message))
  assert.ok(swap)
  assert.match(swap.message, /RevColorSensorV3 → RevColorSensorV2/)
  assert.match(swap.fix, /wrong units or registers/)
})
test('sensors diff: a sensor missing from the run entirely FAILs', () => {
  const f = diffSensors(baseline, parseRobotReport(robot([sensor({ name: 'pixel_color' })])))
  assert.equal(f.filter((x) => x.checkId === 'sensor-response-lost').length, 2, 'front_dist and imu both vanished')
  assert.equal(verdict(f), 'FAIL')
})
test('sensors diff: a sensor new since the baseline is not a failure', () => {
  const f = diffSensors(baseline, parseRobotReport(robot([
    sensor({ name: 'pixel_color' }), sensor({ name: 'front_dist', type: 'Rev2mDistanceSensor', value: '412mm' }),
    sensor({ name: 'imu', type: 'IMU', value: 'yaw=0.3' }), sensor({ name: 'new_color', value: 'r=5 g=5 b=5 a=20' }),
  ])))
  assert.equal(verdict(f), 'PASS')
})
test('sensors: every emitted finding uses a registered check with full shape', () => {
  const all = [
    ...analyzeSensors(parseRobotReport(robot([sensor({ read: 'error' }), sensor({ name: 'z', read: 'zeros' }), sensor({ name: 'd', class: 'digital', livenessDeterminable: false })]))),
    ...diffSensors(baseline, parseRobotReport(robot([sensor({ name: 'pixel_color', read: 'error' })]))),
  ]
  for (const f of all) {
    assert.ok(KNOWN.has(f.checkId), `unregistered check ${f.checkId}`)
    assert.ok(['FAIL', 'WARN', 'INFO'].includes(f.severity))
    assert.ok(Array.isArray(f.evidence) && typeof f.fix === 'string' && f.message)
  }
})

// ── CLI ────────────────────────────────────────────────────────────────────
const cli = (cliArgs, cwd) => {
  const r = spawnSync(process.execPath, [join(APP, 'bin/physync.js'), ...cliArgs], { cwd, encoding: 'utf8' })
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
}
const dir = mkdtempSync(join(tmpdir(), 'physync-sensors-'))
writeFileSync(join(dir, 'good.json'), robot())
writeFileSync(join(dir, 'dead.json'), robot([
  sensor({ name: 'pixel_color' }),
  sensor({ name: 'front_dist', type: 'Rev2mDistanceSensor', read: 'error', value: 'timeout' }),
  sensor({ name: 'imu', type: 'IMU', value: 'yaw=0.3' }),
]))
writeFileSync(join(dir, 'pins-only.json'), robot([sensor({ name: 'arm_limit', class: 'digital', livenessDeterminable: false })]))

test('cli sensors: refuses a baseline where no I2C sensor answered, and explains the exclusion', () => {
  const r = cli(['sensors', '--file', 'pins-only.json', '--baseline'], dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no I2C sensor answered/)
  assert.match(r.stderr, /liveness cannot be determined/)
  assert.ok(!existsSync(join(dir, '.physync/sensor-baseline.json')))
})
test('cli sensors: records a baseline, then passes an identical run', () => {
  assert.equal(cli(['sensors', '--file', 'good.json', '--baseline'], dir).status, 0)
  const saved = JSON.parse(readFileSync(join(dir, '.physync/sensor-baseline.json'), 'utf8'))
  assert.equal(saved.sensors.length, 3, 'the digital pin is excluded from the baseline')
  assert.equal(cli(['sensors', '--file', 'good.json'], dir).status, 0)
})
test('cli sensors: a dead sensor fails with exit 2 and names it', () => {
  const r = cli(['sensors', '--file', 'dead.json', '--json'], dir)
  assert.equal(r.status, 2)
  const parsed = JSON.parse(r.stdout)
  assert.equal(parsed.verdict, 'FAIL')
  assert.ok(parsed.findings.some((f) => /front_dist/.test(f.message)))
})
test('cli sensors: a corrupt report dies cleanly with exit 1 and no stack trace', () => {
  writeFileSync(join(dir, 'corrupt.json'), '{"physyncRobot":1,"sensors":[{bro')
  const r = cli(['sensors', '--file', 'corrupt.json'], dir)
  assert.equal(r.status, 1)
  assert.ok(!/at .*\.js:\d/.test(r.stderr))
})
test('cli sensors: missing --file dies with usage', () => {
  assert.equal(cli(['sensors'], dir).status, 1)
})
test('cli sensors: without a baseline it still reports, and says so', () => {
  const fresh = mkdtempSync(join(tmpdir(), 'physync-sensors2-'))
  writeFileSync(join(fresh, 'good.json'), robot())
  const r = cli(['sensors', '--file', 'good.json'], fresh)
  assert.equal(r.status, 0)
  assert.match(r.stderr, /No sensor baseline yet/)
})
