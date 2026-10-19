// STRANGER-READY — the three ways the tool misled someone with no support.
//
// Each of these passed every existing test while being wrong in front of a
// user, because the suite checked what the engine computed and never checked
// what a person would conclude from reading it.
//
// 1. A team that skipped the approval step saw "REVALIDATION REQUIRED" and
//    "0 recheck(s) owed" on consecutive lines — a true pair of facts that
//    reads as broken software.
// 2. A Blocks-only team saw a green PASS from a check that is structurally
//    incapable of failing for them.
// 3. Windows was never executed at all; every claim rested on simulating
//    Windows inputs from a Mac.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deploymentStatus, statusExitCode, STATUSES } from '../src/state.js'
import { renderTerminal } from '../src/report.js'

const APP = fileURLToPath(new URL('..', import.meta.url))
const demo = JSON.parse(readFileSync(join(APP, 'fixtures/camera_reported_demo.json'), 'utf8'))
const run = (dir, a) => {
  const r = spawnSync(process.execPath, [join(APP, 'bin/physync.js'), ...a], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
function robot() {
  const dir = mkdtempSync(join(tmpdir(), 'physync-stranger-'))
  mkdirSync(join(dir, 'code'), { recursive: true })
  writeFileSync(join(dir, 'c.xml'), demo.configXml)
  for (const f of demo.files) writeFileSync(join(dir, 'code', f.name), f.content)
  return dir
}

// ── 1. the unmapped-change headline ───────────────────────────────────────

test('a change nothing maps to is NOT reported as "revalidation required"', () => {
  assert.equal(deploymentStatus({ changes: [{}], mappedOutcomes: 0 }), STATUSES.UNMAPPED)
  assert.equal(deploymentStatus({ changes: [{}], mappedOutcomes: 2 }), STATUSES.REVALIDATION)
  // Callers that compute no plan keep the old behaviour.
  assert.equal(deploymentStatus({ changes: [{}] }), STATUSES.REVALIDATION)
  // A FAIL still outranks everything.
  assert.equal(deploymentStatus({ failFindings: 1, changes: [{}], mappedOutcomes: 0 }), STATUSES.FAILED)

  // THE CASE THAT MADE THE FIRST ATTEMPT WRONG: a demand this run already
  // satisfied also leaves `required` empty. That is success, not ignorance.
  assert.equal(deploymentStatus({ changes: [{}], mappedOutcomes: 1 }), STATUSES.REVALIDATION,
    'a satisfied demand must never be reported as unmapped')
})

test('an unmapped change never exits 0 — it is ignorance, not success', () => {
  assert.equal(statusExitCode(STATUSES.UNMAPPED), 3)
  assert.equal(statusExitCode(STATUSES.VERIFIED), 0)
})

test('the stranger path explains the decision it is waiting on', () => {
  const dir = robot()
  run(dir, ['init', '--config', 'c.xml', '--code', 'code', '--by', 'Team'])
  run(dir, ['state', '--config', 'c.xml', '--code', 'code'])
  run(dir, ['predict', '--checks', 'localization', '--by', 'Team'])
  run(dir, ['change', '--component', 'camera-position', '--note', 're-aimed', '--by', 'Team'])

  const r = run(dir, ['status'])
  assert.equal(r.code, 3, 'a change nobody can account for is not a pass')
  assert.match(r.out, /IMPACT NOT MAPPED/, 'the banner names the ignorance')
  assert.ok(!/recheck\(s\) owed/.test(r.out),
    'and must not print "0 recheck(s) owed", which reads as "nothing to do"')
  assert.match(r.out, /NO approved rule connects it/, 'it says why in one line')
  assert.match(r.out, /graph --approve/, 'and prints the exact command that fixes it')
  assert.match(r.out, /honest "I do not know"/, 'and refuses to be read as a clean bill of health')

  // Once a rule IS approved the normal headline returns.
  run(dir, ['graph', '--approve', 'camera-pose:01', '--by', 'Team'])
  run(dir, ['graph', '--approve', 'camera-pose:02', '--by', 'Team'])
  const after = run(dir, ['status'])
  assert.match(after.out, /REVALIDATION REQUIRED/)
  assert.match(after.out, /recheck\(s\) owed/)
  assert.equal(after.code, 3)
})

test('machine consumers see the same distinction', () => {
  const dir = robot()
  run(dir, ['init', '--config', 'c.xml', '--code', 'code', '--by', 'T'])
  run(dir, ['state', '--config', 'c.xml', '--code', 'code'])
  run(dir, ['predict', '--checks', 'localization', '--by', 'T'])
  run(dir, ['change', '--component', 'camera-position', '--note', 'x', '--by', 'T'])
  const j = JSON.parse(run(dir, ['status', '--json']).out.replace(/^[^{]*/, ''))
  assert.equal(j.status, STATUSES.UNMAPPED)
  assert.equal(j.exit, 3)
})

// ── 2. the Blocks PASS that cannot fail ───────────────────────────────────

test('a Blocks-only project is told its PASS is advisory', () => {
  const out = renderTerminal([], { deviceCount: 2, webcamCount: 0, refCount: 0, filesScanned: 0, blkCount: 3 })
  assert.match(out, /PREFLIGHT: PASS/, 'it is still a pass')
  assert.match(out, /can never FAIL/, 'but says the check is incapable of failing here')
  assert.match(out, /advisory, not as a pass/, 'and names the correct reading')
  assert.match(out, /revalidation half of Nexum is unaffected/, 'without overstating the limit')
})

test('a Java project is NOT given the Blocks caveat', () => {
  const out = renderTerminal([], { deviceCount: 2, webcamCount: 0, refCount: 4, filesScanned: 2, blkCount: 0 })
  assert.ok(!/can never FAIL/.test(out), 'the notice must not fire for a normal project')
})

test('a mixed Java+Blocks project is NOT given the caveat either', () => {
  // Java sources were scanned, so reconciliation could have produced a FAIL.
  const out = renderTerminal([], { deviceCount: 2, webcamCount: 0, refCount: 4, filesScanned: 2, blkCount: 5 })
  assert.ok(!/can never FAIL/.test(out))
})

// ── 3. Windows is actually executed, not simulated ────────────────────────

test('CI executes the suite on Windows, macOS and Linux', () => {
  const ci = join(APP, '..', '.github/workflows/ci.yml')
  assert.ok(existsSync(ci), 'a CI workflow must exist — "never run on Windows" is fixable, not just documentable')
  const y = readFileSync(ci, 'utf8')
  for (const os of ['windows-latest', 'macos-latest', 'ubuntu-latest']) {
    assert.ok(y.includes(os), `${os} missing from the matrix`)
  }
  assert.match(y, /fail-fast: false/, 'a Windows-only failure must not hide a macOS one')
  assert.match(y, /node-version: \$\{\{ matrix\.node \}\}/, 'and it must run on more than one Node')
  assert.ok(/'20'/.test(y), 'including the oldest version the docs claim to support')
})
