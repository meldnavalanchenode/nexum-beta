// EVIDENCE APPLICABILITY — the sprint's core distinction, locked:
// a check RESULT is history and never changes; APPLICABILITY is whether that
// history still describes TODAY'S robot. Classified per evidence row as
// APPLICABLE / REVALIDATE / UNKNOWN / RE-DERIVED, each with a deterministic
// reason and a machine-readable code. UNKNOWN (proposed-but-unruled
// dependency) is a first-class honest answer, not an error.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = new URL('..', import.meta.url).pathname
const demo = JSON.parse(readFileSync(join(APP, 'fixtures/camera_reported_demo.json'), 'utf8'))

const run = (dir, a) => {
  const r = spawnSync(process.execPath, [join(APP, 'bin/physync.js'), ...a], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
const statusJson = (dir) => JSON.parse(run(dir, ['status', '--config', 'robot.xml', '--code', 'code', '--json']).out.replace(/^[^{]*/, ''))
const appOf = (j, id) => j.revalidation.applicability.find((a) => a.evidenceId === id)

/** The STEP-6 scenario workspace: V1 holds camera-chain evidence (camera-pose
 *  calibration + localization PASS), an UNRELATED drive test PASS, and an
 *  autonomous test linked to the camera only by a PROPOSED (unruled) edge. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'physync-appl-'))
  mkdirSync(join(dir, '.physync'), { recursive: true })
  const tests = [...demo.tests,
    { id: 'drive-test', kind: 'validation', label: 'drivetrain sanity (DEMO)', definedBy: 'Demo Mentor (simulated)' },
    { id: 'autonomous', kind: 'validation', label: 'autonomous run (DEMO)', definedBy: 'Demo Mentor (simulated)' }]
  writeFileSync(join(dir, '.physync/tests.json'), JSON.stringify({ tests }, null, 2))
  writeFileSync(join(dir, 'robot.xml'), demo.configXml)
  mkdirSync(join(dir, 'code'), { recursive: true })
  for (const f of demo.files) writeFileSync(join(dir, 'code', f.name), f.content)
  // V1 evidence: the camera chain + the unrelated drive test + autonomous
  run(dir, ['result', '--test', 'camera-pose', '--pass', '--by', 'Demo Operator'])
  run(dir, ['result', '--test', 'localization', '--value', '0.95', '--by', 'Demo Operator'])
  run(dir, ['result', '--test', 'drive-test', '--pass', '--by', 'Demo Operator'])
  run(dir, ['result', '--test', 'autonomous', '--pass', '--by', 'Demo Operator'])
  assert.equal(run(dir, ['state', '--config', 'robot.xml', '--code', 'code']).code, 0)
  // camera chain ACTIVE (approved by name); autonomous link stays PROPOSED
  run(dir, ['rules', '--pack', 'camera-pose'])
  for (const id of ['camera-pose:01', 'camera-pose:02']) run(dir, ['graph', '--approve', id, '--by', 'Demo Mentor'])
  run(dir, ['graph', '--propose', '--from', 'test:localization', '--to', 'test:autonomous', '--note', 'auton consumes localization — unruled'])
  return dir
}
const report = (dir) => run(dir, ['change', '--component', 'camera-position', '--note', 're-aimed the mount', '--by', 'Demo Reporter'])

// ── the three-way split, plus RE-DERIVED ───────────────────────────────────
test('STEP-6 scenario: camera change → chain REVALIDATE, unrelated APPLICABLE, proposed-only UNKNOWN', () => {
  const dir = workspace()
  report(dir)
  const j = statusJson(dir)
  const loc = appOf(j, 'test:localization')
  assert.equal(loc.applicability, 'REVALIDATE')
  assert.ok(loc.reasonCodes.includes('CALIBRATION_STALE') || loc.reasonCodes.includes('PHYSICAL_CHANGE_REPORTED') || loc.reasonCodes.includes('DEPENDENCY_CHANGED'), `code present: ${loc.reasonCodes}`)
  assert.match(loc.reason, /Demo Reporter reported a physical change/)
  const calEvidence = appOf(j, 'test:camera-pose')
  assert.equal(calEvidence.applicability, 'REVALIDATE', 'folded calibration evidence classifies with its calibration node — same referent, one verdict')
  const drive = appOf(j, 'test:drive-test')
  assert.equal(drive.applicability, 'APPLICABLE', 'unrelated evidence is explicitly STILL VALID')
  assert.equal(drive.result, 'PASS', 'and its historical result rides along unmodified')
  const auto = appOf(j, 'test:autonomous')
  assert.equal(auto.applicability, 'UNKNOWN', 'a proposed-but-unruled dependency is honest ignorance')
  assert.deepEqual(auto.reasonCodes, ['INSUFFICIENT_EVIDENCE'])
  assert.match(auto.reason, /PROPOSED \(unapproved\) dependency/)
  assert.match(auto.reason, /approve or reject/)
  // historical results in V1 are byte-identical afterwards
  const v1 = JSON.parse(readFileSync(join(dir, '.physync/states/V1.json'), 'utf8'))
  for (const id of ['test:localization', 'test:drive-test', 'test:autonomous']) {
    assert.equal(v1.evidence.find((e) => e.id === id).result, 'PASS', `${id} stays PASS in history, forever`)
  }
})

test('human output renders the full classification with marks and codes', () => {
  const dir = workspace()
  report(dir)
  const r = run(dir, ['status', '--config', 'robot.xml', '--code', 'code'])
  assert.match(r.out, /EVIDENCE APPLICABILITY \(historical results never change/)
  assert.match(r.out, /! REVALIDATE +test:localization \(PASS @V1\)/)
  assert.match(r.out, /✓ APPLICABLE +test:drive-test \(PASS @V1\) — no known dependency/)
  assert.match(r.out, /\? UNKNOWN +test:autonomous \(PASS @V1\)/)
  assert.match(r.out, /\[INSUFFICIENT_EVIDENCE\]/)
})

// ── ordering: upstream before downstream ───────────────────────────────────
test('the plan is ordered upstream-first: calibration before the test that consumes it', () => {
  const dir = workspace()
  report(dir)
  const j = statusJson(dir)
  const cal = j.revalidation.required.find((r) => r.action === 'calibration:camera-pose')
  const loc = j.revalidation.required.find((r) => r.action === 'test:localization')
  assert.ok(cal.order < loc.order, `calibration (${cal.order}) must come before localization (${loc.order})`)
  const human = run(dir, ['status', '--config', 'robot.xml', '--code', 'code'])
  assert.match(human.out, /ordered upstream-first/)
  assert.match(human.out, new RegExp(`${cal.order}\\. redo calibration "camera-pose"`))
})

// ── RE-DERIVED: by this run's inputs, and by recorded results ──────────────
test('a config change re-derived by this very run shows RE-DERIVED, not REVALIDATE', () => {
  const dir = workspace()
  writeFileSync(join(dir, 'robot.xml'), demo.configXml.replace('port="0" />', 'port="1" />'))
  const j = statusJson(dir)
  const parsed = appOf(j, 'config-parsed')
  assert.equal(parsed.applicability, 'RE-DERIVED', 'the run itself re-parsed the config')
})

test('a fresh recorded PASS flips the covered evidence to RE-DERIVED', () => {
  const dir = workspace()
  report(dir)
  run(dir, ['result', '--test', 'localization', '--value', '0.96', '--by', 'Demo Operator'])
  const j = statusJson(dir)
  assert.equal(appOf(j, 'test:localization').applicability, 'RE-DERIVED')
  assert.match(appOf(j, 'test:localization').reason, /PASS recorded/)
})

// ── software state via git ─────────────────────────────────────────────────
test('a moved git commit in the code dir is a detected change with SOFTWARE_CHANGED available', () => {
  const dir = workspace()
  const git = (...a) => execFileSync('git', ['-C', join(dir, 'code'), ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'T')
  git('add', '-A'); git('commit', '-qm', 'v1')
  // re-save a baseline that KNOWS the git state (V2)
  assert.equal(run(dir, ['state', '--config', 'robot.xml', '--code', 'code']).code, 0)
  writeFileSync(join(dir, 'code', 'DemoAuto.java'), readFileSync(join(dir, 'code', 'DemoAuto.java'), 'utf8') + '\n// tweak\n')
  git('add', '-A'); git('commit', '-qm', 'v2')
  const j = statusJson(dir)
  const sw = j.changes.find((c) => c.kind === 'software-changed')
  assert.ok(sw, `software change detected: ${JSON.stringify(j.changes.map((c) => c.kind))}`)
  assert.equal(sw.component, 'software')
  assert.match(sw.previous + sw.current, /[0-9a-f]{12}/)
})

// ── the invariant wall, re-locked at this layer ────────────────────────────
test('applicability NEVER mutates results, and absence of evidence never becomes PASS', () => {
  const dir = workspace()
  report(dir)
  const j = statusJson(dir)
  for (const a of j.revalidation.applicability) {
    assert.ok(['PASS', 'FAIL', 'UNKNOWN'].includes(a.result), 'result stays a result')
  }
  // calibration:camera-pose has NO recorded evidence row — it must appear as
  // an owed requirement (UNKNOWN never silently passes), not as applicability
  assert.ok(!j.revalidation.applicability.some((a) => a.evidenceId === 'calibration:camera-pose'))
  assert.ok(j.revalidation.required.some((r) => r.action === 'calibration:camera-pose'))
})
