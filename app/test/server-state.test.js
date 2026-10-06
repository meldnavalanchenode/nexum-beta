// Phase 5: the verified-state workbench endpoints — same modules as the CLI,
// tested through a real socket. Locked: /state refuses failing checks and
// appends versions; /status runs the full Phase 2-4 pipeline (changes →
// invalidation → minimum plan → recorded-result satisfaction); /overview
// serves the timeline the UI renders; and the server persists ONLY inside
// the project directory it was started from.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = 4900 + (process.pid % 90)
const BASE = `http://127.0.0.1:${PORT}`
const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url))
const DIR = mkdtempSync(join(tmpdir(), 'physync-srvstate-'))

const CONFIG = '<Robot type="FirstInspires-FTC"><LynxUsbDevice name="P" serialNumber="X" parentModuleAddress="173"><LynxModule name="Control Hub" port="173"><goBILDA5202SeriesMotor name="left_drive" port="0" /><Servo name="claw" port="1" /></LynxModule></LynxUsbDevice></Robot>'
const GOOD = [{ name: 'T.java', content: 'class T { void i(HardwareMap hardwareMap){ a = hardwareMap.get(DcMotor.class, "left_drive"); b = hardwareMap.get(Servo.class, "claw"); } }' }]
const BAD = [{ name: 'T.java', content: 'class T { void i(HardwareMap hardwareMap){ a = hardwareMap.get(DcMotor.class, "left_dirve"); } }' }]
const ROBOT = JSON.stringify({ physyncRobot: 1, hubs: [{ address: 173, parent: true, firmware: 'HW: 20, Maj: 1, Min: 8, Eng: 2', volts: 12.7 }], sensors: [], deviceCount: 2 })

let proc
test.before(async () => {
  proc = spawn(process.execPath, [SERVER], { cwd: DIR, env: { ...process.env, PHYSYNC_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] })
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

test('status with no verified state is a 409 pointing at the fix', async () => {
  const { status, data } = await call('/status', { configXml: CONFIG, files: GOOD })
  assert.equal(status, 409)
  assert.match(data.error, /No verified state/)
})

test('state refuses a FAILING check with 409 and the findings attached', async () => {
  const { status, data } = await call('/state', { configXml: CONFIG, files: BAD, robotReport: ROBOT })
  assert.equal(status, 409)
  assert.match(data.error, /Refusing/)
  assert.ok(data.findings.some((f) => f.checkId === 'code-name-missing'))
  assert.ok(!existsSync(join(DIR, '.physync/states/V1.json')))
})

test('state saves V1 into the SERVER PROJECT DIR — the same ledger the CLI reads', async () => {
  const { status, data } = await call('/state', { configXml: CONFIG, files: GOOD, robotReport: ROBOT })
  assert.equal(status, 200)
  assert.equal(data.version, 1)
  assert.equal(data.coverage.hubs, true)
  const onDisk = JSON.parse(readFileSync(join(DIR, '.physync/states/V1.json'), 'utf8'))
  assert.equal(onDisk.version, 1)
})

test('status against V1: unchanged robot is VERIFIED FOR DEFINED CHECKS', async () => {
  const { data } = await call('/status', { configXml: CONFIG, files: GOOD, robotReport: ROBOT })
  assert.equal(data.status, 'VERIFIED FOR DEFINED CHECKS')
  assert.deepEqual(data.changes, [])
})

test('status with drift: changes, invalidation, minimum plan, satisfied-this-run — the whole pipeline over HTTP', async () => {
  const drifted = CONFIG.replace('name="claw" port="1"', 'name="claw" port="4"')
  const { data } = await call('/status', { configXml: drifted, files: GOOD, robotReport: ROBOT })
  assert.equal(data.status, 'REVALIDATION REQUIRED')
  assert.ok(data.changes.some((c) => c.kind === 'device-port-moved'))
  assert.ok(data.revalidation.invalidated.some((i) => i.evidenceId === 'config-code-reconciled'))
  // The claw move invalidates check-family evidence only, so 'check' is the
  // one action in the plan — and this request's own reconciliation satisfies it.
  assert.ok(data.revalidation.satisfiedThisRun.some((r) => r.action === 'check'), 'the re-run check satisfies its own demand')
  assert.deepEqual(data.revalidation.required, [], 'nothing else is owed for a servo-port move on a state with no stimulus evidence')
})

test('status without a robot report against a hub-covered state is VERIFICATION INCOMPLETE', async () => {
  const { data } = await call('/status', { configXml: CONFIG, files: GOOD })
  assert.equal(data.status, 'VERIFICATION INCOMPLETE')
  assert.ok(data.gaps.some((g) => /hub census/.test(g)))
})

test('a second save appends V2 and never touches V1', async () => {
  const v1 = readFileSync(join(DIR, '.physync/states/V1.json'), 'utf8')
  const { data } = await call('/state', { configXml: CONFIG, files: GOOD, robotReport: ROBOT })
  assert.equal(data.version, 2)
  assert.equal(readFileSync(join(DIR, '.physync/states/V1.json'), 'utf8'), v1)
})

test('overview serves the timeline: versions, coverage, evidence, graph', async () => {
  const { data } = await call('/overview', null, 'GET')
  assert.equal(data.states.length, 2)
  assert.deepEqual(data.states.map((s) => s.version), [1, 2])
  assert.ok(data.states[0].evidence.every((e) => ['PASS', 'FAIL', 'UNKNOWN'].includes(e.result)))
  assert.ok(data.graph.builtin.length >= 10)
})

test('recorded results flow through /status: a FAIL escalates to VALIDATION FAILED', async () => {
  // define test + edge + a failing result via the ledger files directly
  // (results/tests are file-backed; the server reads the same project dir)
  mkdirSync(join(DIR, '.physync/results'), { recursive: true })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(DIR, '.physync/tests.json'), JSON.stringify({ tests: [{ id: 'grip', kind: 'robustness', label: 'Grip', threshold: { min: 0.9 }, definedBy: 'R' }] }))
  writeFileSync(join(DIR, '.physync/graph.json'), JSON.stringify({ edges: [{ id: 'g1', from: 'device:claw', to: 'test:grip', source: 'user-approved', approvedBy: 'R' }] }))
  appendFileSync(join(DIR, '.physync/results/ledger.jsonl'),
    JSON.stringify({ physyncResult: 1, testId: 'grip', kind: 'robustness', value: 0.5, threshold: { min: 0.9 }, verdict: 'FAIL', evidence: [], recordedBy: 'R', notes: null, againstState: 'V2', recordedAt: new Date(Date.now() + 1000).toISOString() }) + '\n')
  const drifted = CONFIG.replace('name="claw" port="1"', 'name="claw" port="4"')
  const { data } = await call('/status', { configXml: drifted, files: GOOD, robotReport: ROBOT })
  assert.equal(data.status, 'VALIDATION FAILED')
  assert.equal(data.resultFailures, 1)
  assert.ok(data.revalidation.required.some((r) => /LATEST RESULT IS FAIL/.test(r.label)))
})
