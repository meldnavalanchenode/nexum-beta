// Gate CLI behavioral suite — the approve/gate commands end to end through
// real process spawns: exit-code contract, fail-closed paths, --force
// semantics, key handling, JSON output. Slow tests, so hand-picked; the
// mass coverage lives in the in-process suites.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateApproval } from '../src/approval.js'

const APP = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(APP, 'bin/physync.js')

const CONFIG = `<Robot type="FirstInspires-FTC"><LynxUsbDevice name="P" serialNumber="X" parentModuleAddress="173"><LynxModule name="Control Hub" port="173"><goBILDA5202SeriesMotor name="left_drive" port="0" /><Servo name="claw" port="0" /></LynxModule></LynxUsbDevice></Robot>`
const CODE = 'public class T { void init(HardwareMap hardwareMap) { m = hardwareMap.get(DcMotorEx.class, "left_drive"); s = hardwareMap.get(Servo.class, "claw"); } }'
const ROBOT = JSON.stringify({ physyncRobot: 1, hubs: [{ address: 173, parent: true, firmware: 'HW: 20, Maj: 1, Min: 8, Eng: 2', volts: 12.7 }], sensors: [], deviceCount: 2 })

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'physync-gate-'))
  writeFileSync(join(dir, 'robot.xml'), CONFIG)
  mkdirSync(join(dir, 'code'))
  writeFileSync(join(dir, 'code/T.java'), CODE)
  writeFileSync(join(dir, 'rob.json'), ROBOT)
  return dir
}

function run(dir, cliArgs) {
  // spawnSync, not execFileSync: stderr must be observable on SUCCESS too —
  // several gate behaviors are warnings printed on the way to exit 0.
  const r = spawnSync(process.execPath, [SCRIPT, ...cliArgs], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const approve = (dir, extra = []) => run(dir, ['approve', '--config', 'robot.xml', '--code', 'code', ...extra])
const gate = (dir, extra = []) => run(dir, ['gate', '--config', 'robot.xml', ...extra])

// ── approve ────────────────────────────────────────────────────────────────
test('approve: a passing state approves with exit 0 and writes a valid manifest', () => {
  const dir = workspace()
  const r = approve(dir, ['--robot', 'rob.json'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /Approved: config "robot"/)
  assert.match(r.stdout, /adb push/)
  validateApproval(JSON.parse(readFileSync(join(dir, '.physync/approved.json'), 'utf8')))
})

test('approve: REFUSES a failing state — approval can never silence the check', () => {
  const dir = workspace()
  writeFileSync(join(dir, 'code/T.java'), CODE.replace('left_drive', 'left_dirve'))
  const r = approve(dir)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /Refusing to approve a FAILING state/)
  assert.ok(!existsSync(join(dir, '.physync/approved.json')), 'no manifest may exist after a refusal')
})

test('approve: a WARN-only state is approvable — warnings are caution, not blockage', () => {
  const dir = workspace()
  // An unused configured device is a WARN (config-name-unused), not a FAIL.
  writeFileSync(join(dir, 'code/T.java'), 'public class T { void init(HardwareMap hardwareMap) { m = hardwareMap.get(DcMotorEx.class, "left_drive"); } }')
  const r = approve(dir)
  assert.equal(r.code, 0)
})

test('approve: without --robot the manifest is declaration-only and says so', () => {
  const dir = workspace()
  const r = approve(dir)
  assert.equal(r.code, 0)
  assert.match(r.stdout, /declaration layer only/)
  const m = JSON.parse(readFileSync(join(dir, '.physync/approved.json'), 'utf8'))
  assert.equal(m.hubsVerified, false)
  assert.deepEqual(m.hubs, [])
})

test('approve: with --robot the hub census is frozen with normalized firmware', () => {
  const dir = workspace()
  approve(dir, ['--robot', 'rob.json'])
  const m = JSON.parse(readFileSync(join(dir, '.physync/approved.json'), 'utf8'))
  assert.deepEqual(m.hubs, [{ address: 173, firmware: '1.8.2' }])
  assert.equal(m.hubsVerified, true)
})

test('approve: a robot report with no hubs is rejected — nothing physical to freeze', () => {
  const dir = workspace()
  writeFileSync(join(dir, 'rob.json'), JSON.stringify({ physyncRobot: 1, hubs: [], sensors: [], deviceCount: 0 }))
  const r = approve(dir, ['--robot', 'rob.json'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /no hub census/)
})

test('approve: a second approve without --force is refused and names the prior date', () => {
  const dir = workspace()
  approve(dir)
  const r = approve(dir)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /already exists/)
  assert.match(r.stderr, /--force/)
  assert.match(r.stderr, /recorded 20/)
})

test('approve: --force replaces the approval', () => {
  const dir = workspace()
  approve(dir)
  const first = JSON.parse(readFileSync(join(dir, '.physync/approved.json'), 'utf8'))
  const r = approve(dir, ['--force', '--robot', 'rob.json'])
  assert.equal(r.code, 0)
  const second = JSON.parse(readFileSync(join(dir, '.physync/approved.json'), 'utf8'))
  assert.notEqual(second.manifestDigest, first.manifestDigest)
  assert.equal(second.hubsVerified, true)
})

test('approve: an unreadable existing approval still requires --force', () => {
  const dir = workspace()
  mkdirSync(join(dir, '.physync'), { recursive: true })
  writeFileSync(join(dir, '.physync/approved.json'), '{corrupted')
  const r = approve(dir)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /already exists/)
})

test('approve: generates the gate key once at mode 600 and reuses it', () => {
  const dir = workspace()
  approve(dir)
  const keyPath = join(dir, '.physync/gate.key')
  const key = readFileSync(keyPath, 'utf8')
  assert.match(key.trim(), /^[0-9a-f]{64}$/)
  assert.equal(statSync(keyPath).mode & 0o777, 0o600)
  approve(dir, ['--force'])
  assert.equal(readFileSync(keyPath, 'utf8'), key, 'the key survives re-approval')
})

test('approve: --json emits machine-readable output with the state digest', () => {
  const dir = workspace()
  const r = approve(dir, ['--robot', 'rob.json', '--json'])
  const j = JSON.parse(r.stdout)
  assert.equal(j.action, 'approved')
  assert.match(j.stateDigest, /^[0-9a-f]{64}$/)
  assert.equal(j.hubsVerified, true)
})

test('approve: unknown flags are rejected, not ignored', () => {
  const dir = workspace()
  const r = run(dir, ['approve', '--config', 'robot.xml', '--code', 'code', '--frce'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /Unknown flag/)
})

test('approve: git provenance is recorded when the code dir is a repo', () => {
  const dir = workspace()
  const git = (...a) => execFileSync('git', ['-C', join(dir, 'code'), ...a], { stdio: 'pipe', encoding: 'utf8' })
  git('init', '-q')
  git('add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x')
  approve(dir)
  const m = JSON.parse(readFileSync(join(dir, '.physync/approved.json'), 'utf8'))
  assert.match(m.codeGitSha, /^[0-9a-f]{40}$/)
  assert.equal(m.codeGitDirty, false)
  writeFileSync(join(dir, 'code/extra.java'), '// uncommitted')
  approve(dir, ['--force'])
  const m2 = JSON.parse(readFileSync(join(dir, '.physync/approved.json'), 'utf8'))
  assert.equal(m2.codeGitDirty, true, 'a dirty tree must be recorded as dirty')
})

test('approve: outside a git repo, provenance is null — recorded as unknown, never guessed', () => {
  const dir = workspace()
  approve(dir)
  const m = JSON.parse(readFileSync(join(dir, '.physync/approved.json'), 'utf8'))
  assert.equal(m.codeGitSha, null)
  assert.equal(m.codeGitDirty, null)
})

// ── gate ───────────────────────────────────────────────────────────────────
test('gate: intact robot exits 0 with the APPROVED banner', () => {
  const dir = workspace()
  approve(dir, ['--robot', 'rob.json'])
  const r = gate(dir, ['--file', 'rob.json'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /STILL THE ROBOT YOU APPROVED/)
  assert.match(r.stdout, /Configuration and hub census both match/)
})

test('gate: no approval on record is FAIL exit 2, not a tool error', () => {
  const dir = workspace()
  const r = gate(dir)
  assert.equal(r.code, 2)
  assert.match(r.stdout, /No approval on record/)
  assert.match(r.stdout, /NOT THE ROBOT YOU APPROVED/)
})

test('gate: a corrupted approval is FAIL exit 2 — fails closed, never open', () => {
  const dir = workspace()
  approve(dir)
  const path = join(dir, '.physync/approved.json')
  const m = JSON.parse(readFileSync(path, 'utf8'))
  m.configName = 'tampered'
  writeFileSync(path, JSON.stringify(m))
  const r = gate(dir)
  assert.equal(r.code, 2)
  assert.match(r.stdout, /unreadable or corrupted/)
})

test('gate: unparseable approval JSON is also FAIL exit 2', () => {
  const dir = workspace()
  mkdirSync(join(dir, '.physync'), { recursive: true })
  writeFileSync(join(dir, '.physync/approved.json'), 'not json at all')
  const r = gate(dir)
  assert.equal(r.code, 2)
})

test('gate: config drift is FAIL exit 2 naming the change', () => {
  const dir = workspace()
  approve(dir, ['--robot', 'rob.json'])
  writeFileSync(join(dir, 'robot.xml'), CONFIG.replace('left_drive', 'right_drive'))
  const r = gate(dir, ['--file', 'rob.json'])
  assert.equal(r.code, 2)
  assert.match(r.stdout, /changed since it was approved/)
})

test('gate: hub firmware drift is FAIL exit 2 naming hub and both versions', () => {
  const dir = workspace()
  approve(dir, ['--robot', 'rob.json'])
  writeFileSync(join(dir, 'rob.json'), ROBOT.replace('Eng: 2', 'Eng: 3'))
  const r = gate(dir, ['--file', 'rob.json'])
  assert.equal(r.code, 2)
  assert.match(r.stdout, /@173/)
  assert.match(r.stdout, /1\.8\.3/)
  assert.match(r.stdout, /1\.8\.2/)
})

test('gate: an approval covering hubs REQUIRES a robot report — half a check is no check', () => {
  const dir = workspace()
  approve(dir, ['--robot', 'rob.json'])
  const r = gate(dir)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /covers the hub layer/)
})

test('gate: a declaration-only approval gates without a robot report, INFO states the gap', () => {
  const dir = workspace()
  approve(dir)
  const r = gate(dir)
  assert.equal(r.code, 0)
  assert.match(r.stdout, /hub census and firmware are NOT covered/)
  assert.match(r.stdout, /declaration layer only/, 'the header must state the coverage boundary')
})

test('gate: a manifest signed by a DIFFERENT key fails signature verification', () => {
  const dir = workspace()
  approve(dir, ['--robot', 'rob.json'])
  writeFileSync(join(dir, '.physync/gate.key'), 'ef'.repeat(32))
  const r = gate(dir, ['--file', 'rob.json'])
  assert.equal(r.code, 2)
  assert.match(r.stdout, /signature does not verify/)
})

test('gate: with no key, the unverified provenance is a WARN finding IN the verdict, not a buried stderr note', () => {
  const dir = workspace()
  approve(dir, ['--robot', 'rob.json'])
  rmSync(join(dir, '.physync/gate.key'))
  const r = gate(dir, ['--file', 'rob.json'])
  assert.equal(r.code, 0, 'WARN passes — but visibly')
  assert.match(r.stdout, /provenance NOT verified/)
  const j = JSON.parse(gate(dir, ['--file', 'rob.json', '--json']).stdout)
  assert.ok(j.findings.some((f) => f.checkId === 'approval-signature-unverified'), 'the gap must be machine-readable too')
})

test('R5: a corrupt gate key stops BOTH commands loudly instead of silently unsigning', () => {
  const dir = workspace()
  approve(dir, ['--robot', 'rob.json'])
  writeFileSync(join(dir, '.physync/gate.key'), 'not-a-key')
  const a = approve(dir, ['--force'])
  assert.equal(a.code, 1)
  assert.match(a.stderr, /corrupt/)
  const g = gate(dir, ['--file', 'rob.json'])
  assert.equal(g.code, 1)
  assert.match(g.stderr, /corrupt/)
})

test('R5: approve REFUSES a robot report with a failing sensor — "tested and approved" cannot hold a report that proves the robot broken', () => {
  const dir = workspace()
  writeFileSync(join(dir, 'rob.json'), JSON.stringify({
    physyncRobot: 1,
    hubs: [{ address: 173, parent: true, firmware: 'HW: 20, Maj: 1, Min: 8, Eng: 2', volts: 12.7 }],
    sensors: [{ name: 'imu', type: 'IMU', class: 'i2c', read: 'error', value: 'no response', livenessDeterminable: true }],
    deviceCount: 3,
  }))
  const r = approve(dir, ['--robot', 'rob.json'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /shows failures/)
  assert.match(r.stderr, /imu/)
  assert.ok(!existsSync(join(dir, '.physync/approved.json')))
})

test('R5: a suspicious duplicated-download basename warns, and --name overrides it', () => {
  const dir = workspace()
  writeFileSync(join(dir, 'robot (1).xml'), CONFIG)
  const warned = run(dir, ['approve', '--config', 'robot (1).xml', '--code', 'code'])
  assert.equal(warned.code, 0)
  assert.match(warned.stderr, /duplicated download/)
  rmSync(join(dir, '.physync/approved.json'))
  const named = run(dir, ['approve', '--config', 'robot (1).xml', '--code', 'code', '--name', 'robot'])
  assert.equal(named.code, 0)
  const m = JSON.parse(readFileSync(join(dir, '.physync/approved.json'), 'utf8'))
  assert.equal(m.configName, 'robot', 'the recorded name is what the ROBOT will enforce')
})

test('R5: gate with --file states the freshness boundary out loud', () => {
  const dir = workspace()
  approve(dir, ['--robot', 'rob.json'])
  const r = gate(dir, ['--file', 'rob.json'])
  assert.match(r.stderr, /as of the moment that robot report was written/)
  assert.match(r.stdout, /as of the robot report you supplied/)
})

test('gate: --approval points at a manifest elsewhere (the adb-pulled copy)', () => {
  const dir = workspace()
  approve(dir, ['--robot', 'rob.json'])
  writeFileSync(join(dir, 'pulled-approval.json'), readFileSync(join(dir, '.physync/approved.json')))
  const r = gate(dir, ['--file', 'rob.json', '--approval', 'pulled-approval.json'])
  assert.equal(r.code, 0)
})

test('gate: --json output is valid, carries verdict, context, and findings', () => {
  const dir = workspace()
  approve(dir, ['--robot', 'rob.json'])
  writeFileSync(join(dir, 'robot.xml'), CONFIG + ' ')
  const r = gate(dir, ['--file', 'rob.json', '--json'])
  assert.equal(r.code, 2)
  const j = JSON.parse(r.stdout)
  assert.equal(j.verdict, 'FAIL')
  assert.equal(j.context.mode, 'gate')
  assert.ok(j.findings.some((f) => f.checkId === 'approval-config-drift'))
})

test('gate: missing --config when an approval exists is a usage error, exit 1', () => {
  const dir = workspace()
  approve(dir)
  const r = run(dir, ['gate'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /gate needs --config/)
})

test('gate: unknown flags are rejected', () => {
  const dir = workspace()
  const r = run(dir, ['gate', '--config', 'robot.xml', '--fil', 'rob.json'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /Unknown flag/)
})

test('gate: exit-code contract holds across the whole matrix — 0 intact, 2 any drift, 1 tool error', () => {
  const dir = workspace()
  approve(dir, ['--robot', 'rob.json'])
  assert.equal(gate(dir, ['--file', 'rob.json']).code, 0)
  writeFileSync(join(dir, 'rob.json'), ROBOT.replace('173', '172'))
  assert.equal(gate(dir, ['--file', 'rob.json']).code, 2)
  assert.equal(run(dir, ['gate', '--config', 'missing.xml', '--file', 'rob.json']).code, 1)
})

test('gate + approve: the full pit workflow — approve, verify, drift, re-approve', () => {
  const dir = workspace()
  assert.equal(approve(dir, ['--robot', 'rob.json']).code, 0)
  assert.equal(gate(dir, ['--file', 'rob.json']).code, 0)
  writeFileSync(join(dir, 'robot.xml'), CONFIG.replace('port="0" /><Servo', 'port="1" /><Servo'))
  assert.equal(gate(dir, ['--file', 'rob.json']).code, 2, 'the rewire must be caught')
  assert.equal(approve(dir, ['--force', '--robot', 'rob.json']).code, 0, 're-verified by hand → re-approved')
  assert.equal(gate(dir, ['--file', 'rob.json']).code, 0, 'the new state is the approved state now')
})
