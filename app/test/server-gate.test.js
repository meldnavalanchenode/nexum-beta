// Web-UI approval gate endpoints — the same fail-closed semantics as the CLI,
// tested through a real server process on a real socket. UI approvals are
// in-memory by design (the server promises "nothing persisted"), so the suite
// also proves the lifetime: approve → gate → forget → gate fails closed again.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const PORT = 4700 + (process.pid % 200)
const BASE = `http://127.0.0.1:${PORT}`
const SERVER = new URL('../src/server.js', import.meta.url).pathname

const CONFIG = '<Robot type="FirstInspires-FTC"><LynxUsbDevice name="P" serialNumber="X" parentModuleAddress="173"><LynxModule name="Control Hub" port="173"><goBILDA5202SeriesMotor name="left_drive" port="0" /><Servo name="claw" port="1" /></LynxModule></LynxUsbDevice></Robot>'
const GOOD_CODE = [{ name: 'T.java', content: 'class T { void i(HardwareMap hardwareMap){ a = hardwareMap.get(DcMotor.class, "left_drive"); b = hardwareMap.get(Servo.class, "claw"); } }' }]
const BAD_CODE = [{ name: 'T.java', content: 'class T { void i(HardwareMap hardwareMap){ a = hardwareMap.get(DcMotor.class, "left_dirve"); } }' }]
const ROBOT = JSON.stringify({ physyncRobot: 1, hubs: [{ address: 173, parent: true, firmware: 'HW: 20, Maj: 1, Min: 8, Eng: 2', volts: 12.7 }], sensors: [], deviceCount: 2 })

let proc
test.before(async () => {
  proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PHYSYNC_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('PHYSYNC ui')) resolve() })
    proc.on('exit', () => reject(new Error('server died at startup')))
    setTimeout(() => reject(new Error('server startup timeout')), 8000)
  })
})
test.after(() => { proc?.kill() })

const call = async (path, body, method = 'POST') => {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, data: await res.json() }
}

test('gate with no approval fails CLOSED: verdict FAIL, approval-missing named', async () => {
  const { status, data } = await call('/gate', { configXml: CONFIG })
  assert.equal(status, 200)
  assert.equal(data.verdict, 'FAIL')
  assert.equal(data.findings[0].checkId, 'approval-missing')
  assert.equal(data.context.approvedAt, 'never')
})

test('approve REFUSES a failing state with 409 and shows why', async () => {
  const { status, data } = await call('/approve', { configXml: CONFIG, files: BAD_CODE })
  assert.equal(status, 409)
  assert.match(data.error, /Refusing to approve a FAILING state/)
  assert.ok(data.findings.some((f) => f.checkId === 'code-name-missing'))
})

test('approve accepts a passing state; declaration-only when no robot report', async () => {
  const { status, data } = await call('/approve', { configXml: CONFIG, files: GOOD_CODE })
  assert.equal(status, 200)
  assert.equal(data.approved, true)
  assert.equal(data.hubsVerified, false)
  assert.match(data.stateDigest, /^[0-9a-f]{64}$/)
})

test('gate on the unchanged config passes, with the hub coverage gap stated as INFO', async () => {
  const { data } = await call('/gate', { configXml: CONFIG })
  assert.equal(data.verdict, 'PASS')
  assert.ok(data.findings.some((f) => f.checkId === 'approval-hubs-not-covered'))
})

test('gate on an EDITED config fails with named config drift', async () => {
  const { data } = await call('/gate', { configXml: CONFIG.replace('port="0"', 'port="2"') })
  assert.equal(data.verdict, 'FAIL')
  assert.ok(data.findings.some((f) => f.checkId === 'approval-config-drift' && /changed since it was approved/.test(f.message)))
})

test('re-approve WITH a robot report covers the hub layer', async () => {
  const { data } = await call('/approve', { configXml: CONFIG, files: GOOD_CODE, robotReport: ROBOT })
  assert.equal(data.hubsVerified, true)
  assert.deepEqual(data.hubs, [{ address: 173, firmware: '1.8.2' }])
})

test('hub-covering approval REQUIRES a report at gate time — 422, never a half-checked verdict', async () => {
  const { status, data } = await call('/gate', { configXml: CONFIG })
  assert.equal(status, 422)
  assert.match(data.error, /covers the hub layer/)
})

test('gate with a matching report passes clean; re-addressed hub fails with the vanish+appear pair', async () => {
  const clean = await call('/gate', { configXml: CONFIG, robotReport: ROBOT })
  assert.equal(clean.data.verdict, 'PASS')
  assert.deepEqual(clean.data.findings, [])
  const moved = await call('/gate', { configXml: CONFIG, robotReport: ROBOT.replace('173', '172').replace('"parentModuleAddress":"172"', '"parentModuleAddress":"173"') })
  assert.equal(moved.data.verdict, 'FAIL')
  const drift = moved.data.findings.filter((f) => f.checkId === 'approval-hub-drift')
  assert.equal(drift.length, 2, 're-addressing must surface as both a disappearance and an apparition')
})

test('a robot report with a failing sensor blocks approval with 409', async () => {
  const sick = JSON.stringify({ physyncRobot: 1, hubs: [{ address: 173, parent: true, firmware: '1.8.2', volts: 12.7 }], sensors: [{ name: 'imu', type: 'IMU', class: 'i2c', read: 'error', value: 'no response', livenessDeterminable: true }], deviceCount: 3 })
  const { status, data } = await call('/approve', { configXml: CONFIG, files: GOOD_CODE, robotReport: sick })
  assert.equal(status, 409)
  assert.match(data.error, /shows failures/)
})

test('a garbage robot report is a clean 400, not a crash', async () => {
  const { status, data } = await call('/gate', { configXml: CONFIG, robotReport: '{"not":"a report"}' })
  assert.equal(status, 400)
  assert.match(data.error, /Cannot read robot report/)
})

test('forget approval → gate fails closed again', async () => {
  const del = await call('/approve', null, 'DELETE')
  assert.equal(del.data.cleared, true)
  const { data } = await call('/gate', { configXml: CONFIG })
  assert.equal(data.verdict, 'FAIL')
  assert.equal(data.findings[0].checkId, 'approval-missing')
})

test('the /check route still behaves after the refactor (regression guard)', async () => {
  const fail = await call('/check', { configXml: CONFIG, files: BAD_CODE })
  assert.equal(fail.data.verdict, 'FAIL')
  assert.ok(fail.data.findings.some((f) => /did you mean "left_drive"/.test(f.message)))
  const pass = await call('/check', { configXml: CONFIG, files: GOOD_CODE })
  assert.equal(pass.data.verdict, 'PASS')
  assert.equal(typeof pass.data.markdown, 'string')
})
