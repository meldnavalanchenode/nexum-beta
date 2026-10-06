// Phase 6: the controlled-mode fixtures driven through the REAL pipeline,
// plus the spec's ten-step workflow, automated. The eight required
// scenarios: no change · one change · multiple changes · unknown state ·
// dependency propagation · duplicate-test elimination · regression
// detection · restoration to verified state.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = fileURLToPath(new URL('..', import.meta.url))
const FIX = join(APP, 'fixtures')
const fixture = (name) => JSON.parse(readFileSync(join(FIX, name), 'utf8'))

/** Materialize a fixture payload into CLI-consumable files in a workspace. */
function stage(dir, fx) {
  writeFileSync(join(dir, 'robot.xml'), fx.configXml)
  mkdirSync(join(dir, 'code'), { recursive: true })
  for (const f of fx.files) writeFileSync(join(dir, 'code', f.name), f.content)
  if (fx.robotReport) writeFileSync(join(dir, 'rob.json'), JSON.stringify(fx.robotReport))
  if (fx.stimulusReport) writeFileSync(join(dir, 'stim.json'), JSON.stringify(fx.stimulusReport))
}
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'physync-p6-'))
  mkdirSync(join(dir, '.physync'), { recursive: true })
  cpSync(join(FIX, 'graph.json'), join(dir, '.physync/graph.json'))
  cpSync(join(FIX, 'tests.json'), join(dir, '.physync/tests.json'))
  stage(dir, fixture('baseline_robot.json'))
  run(dir, ['state', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json', '--stimulus', 'stim.json'])
  return dir
}
const run = (dir, a) => {
  const r = spawnSync(process.execPath, [join(APP, 'bin/physync.js'), ...a], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
const statusWith = (dir, fx) => {
  stage(dir, fx)
  return run(dir, ['status', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json', '--json'])
}
const parse = (r) => JSON.parse(r.out.slice(r.out.indexOf('{')))

// ── scenario 1: no change ──────────────────────────────────────────────────
test('fixtures: baseline against itself is VERIFIED FOR DEFINED CHECKS, exit 0', () => {
  const dir = workspace()
  const r = statusWith(dir, fixture('baseline_robot.json'))
  assert.equal(r.code, 0)
  const j = parse(r)
  assert.equal(j.status, 'VERIFIED FOR DEFINED CHECKS')
  assert.deepEqual(j.changes, [])
})

// ── scenario 2: one change + dependency propagation + chaos-test targeting ─
test('fixtures: camera_changed demands the perception chain and NEVER the grasp tests', () => {
  const dir = workspace()
  const j = parse(statusWith(dir, fixture('camera_changed.json')))
  assert.equal(j.status, 'REVALIDATION REQUIRED')
  const actions = j.revalidation.required.map((r) => r.action)
  for (const t of ['test:object-detection', 'test:low-light', 'test:reflective', 'calibration:C7']) {
    assert.ok(actions.includes(t), `${t} must be demanded`)
  }
  assert.ok(!actions.some((a) => /grasp/.test(a)), 'gripper tests must NOT be demanded by a camera change')
  // dependency propagation: the leaf test's why-trace names the camera change
  const lowLight = j.revalidation.required.find((r) => r.action === 'test:low-light')
  assert.match(lowLight.because.join(';'), /device-port-moved \(device "camera"\)/)
})

test('fixtures: gripper_changed demands the grasp tests and NEVER the perception chain', () => {
  const dir = workspace()
  const j = parse(statusWith(dir, fixture('gripper_changed.json')))
  const actions = j.revalidation.required.map((r) => r.action)
  for (const t of ['test:grasp-standard', 'test:grasp-slippery', 'test:grasp-heavy']) assert.ok(actions.includes(t), `${t} must be demanded`)
  assert.ok(!actions.some((a) => /object-detection|low-light|reflective|calibration/.test(a)), 'camera chain must NOT fire for a gripper change')
  assert.ok(actions.includes('stimulus'), 'the gripper servo-response evidence died too')
})

test('fixtures: firmware_changed invalidates every measured response and demands one stimulus run', () => {
  const dir = workspace()
  const j = parse(statusWith(dir, fixture('firmware_changed.json')))
  const dead = j.revalidation.invalidated.map((i) => i.evidenceId)
  assert.ok(dead.includes('motor-response:drive'))
  assert.ok(dead.includes('servo-response:gripper'))
  assert.ok(dead.includes('hub-census'))
  assert.equal(j.revalidation.required.filter((r) => r.action === 'stimulus').length, 1, 'ONE stimulus run covers both dead responses')
})

// ── scenario 3: multiple changes + duplicate elimination ───────────────────
test('fixtures: multiple_changes produces the deduplicated UNION plan', () => {
  const dir = workspace()
  const j = parse(statusWith(dir, fixture('multiple_changes.json')))
  const actions = j.revalidation.required.map((r) => r.action)
  assert.equal(new Set(actions).size, actions.length, 'no action may appear twice')
  for (const t of ['calibration:C7', 'test:object-detection', 'test:low-light', 'test:reflective', 'test:grasp-standard', 'test:grasp-slippery', 'test:grasp-heavy']) {
    assert.ok(actions.includes(t), `${t} must appear exactly once in the union`)
  }
  assert.equal(actions.filter((a) => a === 'stimulus').length, 1, 'firmware + gripper changes share ONE stimulus run')
})

// ── scenario 4: unknown state ──────────────────────────────────────────────
test('fixtures: unknown_state (camera reads zeros) is a change, and UNKNOWN never becomes PASS', () => {
  const dir = workspace()
  const j = parse(statusWith(dir, fixture('unknown_state.json')))
  assert.ok(j.changes.some((c) => c.kind === 'sensor-response-lost' && /camera/.test(c.component)))
  // Save a state FROM the unknown report: its camera evidence must be UNKNOWN.
  const save = run(dir, ['state', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json'])
  assert.equal(save.code, 0)
  const v2 = JSON.parse(readFileSync(join(dir, '.physync/states/V2.json'), 'utf8'))
  const cam = v2.evidence.find((e) => e.id === 'sensor-liveness:camera')
  assert.equal(cam.result, 'UNKNOWN', 'all-zeros is UNKNOWN — confirm by hand, never assume')
})

// ── scenario 5: regression detection through the fixture flow ──────────────
test('fixtures: a recorded regression (0.92 → 0.68) FAILs validation after the gripper change', () => {
  const dir = workspace()
  run(dir, ['result', '--test', 'grasp-slippery', '--value', '0.92', '--by', 'Demo'])
  statusWith(dir, fixture('gripper_changed.json'))
  run(dir, ['result', '--test', 'grasp-slippery', '--value', '0.68', '--by', 'Demo'])
  const j = parse(run(dir, ['status', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json', '--json']))
  assert.equal(j.status, 'VALIDATION FAILED')
  assert.ok(j.regressions.some((r) => r.testId === 'grasp-slippery' && +r.delta.toFixed(2) === -0.24))
})

// ── scenario 6: restoration to the verified state ──────────────────────────
test('fixtures: restoring the baseline restores VERIFIED — drift is not a life sentence', () => {
  const dir = workspace()
  assert.equal(statusWith(dir, fixture('multiple_changes.json')).code, 3)
  const restored = statusWith(dir, fixture('baseline_robot.json'))
  assert.equal(restored.code, 0)
  assert.equal(parse(restored).status, 'VERIFIED FOR DEFINED CHECKS')
})

// ── the spec's ten-step workflow, end to end ───────────────────────────────
test('THE WORKFLOW: verify → change → detect → propagate → invalidate → plan → retest → status → new version', () => {
  const dir = workspace()                                         // 1. verified state V1 exists (baseline)
  const drift = statusWith(dir, fixture('camera_changed.json'))   // 2-3. current state + introduced change
  assert.equal(drift.code, 3)
  const j = parse(drift)
  assert.ok(j.changes.length >= 1)                                // 4. change detected
  assert.ok(j.revalidation.invalidated.length >= 1)               // 5-6. propagated + invalidated
  const owed = j.revalidation.required.filter((r) => r.action.startsWith('test:') || r.action.startsWith('calibration:'))
  assert.ok(owed.length === 4)                                    // 7. required list generated (3 tests + calibration)

  for (const t of ['object-detection', 'low-light', 'reflective']) {
    assert.equal(run(dir, ['result', '--test', t, '--value', '0.97', '--by', 'Demo']).code, 0)  // 8. tests run + recorded
  }
  const after = parse(run(dir, ['status', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json', '--json']))
  assert.equal(after.status, 'REVALIDATION REQUIRED')             // 9. status: calibration:C7 still owed
  assert.deepEqual(after.revalidation.required.map((r) => r.action), ['calibration:C7'], 'only the un-redone calibration remains')
  assert.equal(after.revalidation.satisfiedThisRun.filter((r) => /PASS recorded/.test(r.label)).length, 3)

  const v2 = run(dir, ['state', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json'])  // 10. new verified version
  assert.equal(v2.code, 0)
  const state2 = JSON.parse(readFileSync(join(dir, '.physync/states/V2.json'), 'utf8'))
  assert.equal(state2.version, 2)
  assert.equal(state2.evidence.filter((e) => e.id.startsWith('test:')).length, 3, 'the three recorded results folded into V2')
  const final = parse(run(dir, ['status', '--config', 'robot.xml', '--code', 'code', '--robot', 'rob.json', '--json']))
  assert.equal(final.status, 'VERIFIED FOR DEFINED CHECKS')
  assert.equal(final.against, 'V2')
})
