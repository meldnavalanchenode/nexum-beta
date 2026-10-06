// Shadow Mode — the customer experiment as code, honesty rules enforced:
// prediction before reveal, immutable after; deltas are set facts; verdicts
// are human-assigned against the pre-registered protocol, never automatic.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = fileURLToPath(new URL('..', import.meta.url))
const demo = JSON.parse(readFileSync(join(APP, 'fixtures/camera_reported_demo.json'), 'utf8'))

const run = (dir, a) => {
  const r = spawnSync(process.execPath, [join(APP, 'bin/physync.js'), ...a], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
const expOf = (dir, n = 1) => JSON.parse(readFileSync(join(dir, `.physync/experiments/exp-${n}.json`), 'utf8'))

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'physync-shadow-'))
  mkdirSync(join(dir, '.physync'), { recursive: true })
  writeFileSync(join(dir, '.physync/tests.json'), JSON.stringify({ tests: demo.tests }, null, 2))
  writeFileSync(join(dir, 'robot.xml'), demo.configXml)
  mkdirSync(join(dir, 'code'), { recursive: true })
  for (const f of demo.files) writeFileSync(join(dir, 'code', f.name), f.content)
  run(dir, ['state', '--config', 'robot.xml', '--code', 'code'])
  run(dir, ['rules', '--pack', 'camera-pose'])
  for (const id of ['camera-pose:01', 'camera-pose:02']) run(dir, ['graph', '--approve', id, '--by', 'Demo Mentor'])
  run(dir, ['change', '--component', 'camera-position', '--note', 're-aimed', '--by', 'Demo Reporter'])
  return dir
}

test('the full arc: predict → reveal (stamped once) → debrief deltas → verdict → sealed by V2', () => {
  const dir = workspace()
  // SPEC EXAMPLE 1: team predicts calibration + localization + autonomous;
  // Nexum's plan is calibration + localization; both plan items performed
  const p = run(dir, ['predict', '--checks', 'camera-pose, localization, autonomous', '--by', 'Demo Programmer'])
  assert.equal(p.code, 0)
  assert.match(p.out, /SHADOW MODE armed/)
  assert.equal(expOf(dir).revealedAt, null, 'not revealed until a status runs')

  const st = run(dir, ['status', '--config', 'robot.xml', '--code', 'code'])
  assert.match(st.out, /SHADOW MODE — Demo Programmer's prediction locked/)
  const afterReveal = expOf(dir)
  assert.ok(afterReveal.revealedAt, 'first status stamps the reveal')
  assert.deepEqual(afterReveal.reveal.planActions.sort(), ['calibration:camera-pose', 'test:localization'])
  // a second status must NOT move the reveal stamp — first exposure is the experiment
  run(dir, ['status', '--config', 'robot.xml', '--code', 'code'])
  assert.equal(expOf(dir).revealedAt, afterReveal.revealedAt)

  run(dir, ['result', '--test', 'camera-pose', '--pass', '--by', 'Demo Programmer'])
  run(dir, ['result', '--test', 'localization', '--value', '0.96', '--by', 'Demo Programmer'])
  const d = run(dir, ['debrief', '--checked', 'camera-pose, localization', '--by', 'Demo Programmer'])
  assert.equal(d.code, 0)
  const rec = expOf(dir)
  assert.deepEqual(rec.debrief.deltas.agreed.sort(), ['camera-pose', 'localization'])
  assert.deepEqual(rec.debrief.deltas.nexumAddedBeyondPrediction, [])
  assert.deepEqual(rec.debrief.deltas.predictionBeyondNexum, ['autonomous'], 'the unnecessary check Nexum avoided — as a FACT, not a boast')
  assert.deepEqual(rec.debrief.deltas.performedUnrecommended, [])
  assert.equal(rec.debrief.verdict, null, 'NO automatic success — the verdict is a human job')

  const v = run(dir, ['verdict', '--verdict', 'HELPED', '--basis', 'Nexum omitted a check the team would have run; protocol rule 2', '--by', 'Raghu'])
  assert.equal(v.code, 0)
  assert.equal(expOf(dir).debrief.verdict, 'HELPED')

  const save = run(dir, ['state', '--config', 'robot.xml', '--code', 'code'])
  assert.match(save.out, /Shadow experiment exp-1 closed → V2/)
  assert.equal(expOf(dir).newState, 'V2')
  assert.ok(expOf(dir).closedAt)
})

test('SPEC EXAMPLE 2: Nexum surfaces a check the team missed — recorded as usefulAdditions, still no auto-verdict', () => {
  const dir = workspace()
  run(dir, ['predict', '--checks', 'camera-pose', '--by', 'Demo Programmer']) // team only thought of the calibration
  run(dir, ['status', '--config', 'robot.xml', '--code', 'code'])
  run(dir, ['debrief', '--checked', 'camera-pose, localization', '--by', 'Demo Programmer']) // both proved needed
  const rec = expOf(dir)
  assert.deepEqual(rec.debrief.deltas.nexumAddedBeyondPrediction, ['localization'])
  assert.deepEqual(rec.debrief.deltas.usefulAdditions, ['localization'], '+1 useful check surfaced — a set fact')
  assert.equal(rec.debrief.verdict, null)
})

test('honesty rails: one open experiment at a time; debrief requires reveal; abandonment is recorded, not deleted', () => {
  const dir = workspace()
  run(dir, ['predict', '--checks', 'camera-pose', '--by', 'A'])
  const second = run(dir, ['predict', '--checks', 'localization', '--by', 'B'])
  assert.equal(second.code, 1)
  assert.match(second.out, /still open/)
  const early = run(dir, ['debrief', '--checked', 'camera-pose', '--by', 'A'])
  assert.equal(early.code, 1)
  assert.match(early.out, /never revealed/)
  const ab = run(dir, ['predict', '--abandon'])
  assert.match(ab.out, /abandoned \(recorded, not deleted/)
  assert.equal(expOf(dir).abandoned, true)
  // after abandonment a fresh prediction opens cleanly
  assert.equal(run(dir, ['predict', '--checks', 'localization', '--by', 'B']).code, 0)
})

test('a state save with no debrief still seals the record and says the data is incomplete', () => {
  const dir = workspace()
  run(dir, ['predict', '--checks', 'camera-pose', '--by', 'A'])
  run(dir, ['status', '--config', 'robot.xml', '--code', 'code'])
  run(dir, ['result', '--test', 'camera-pose', '--pass', '--by', 'A'])
  run(dir, ['result', '--test', 'localization', '--value', '0.96', '--by', 'A'])
  const save = run(dir, ['state', '--config', 'robot.xml', '--code', 'code'])
  assert.match(save.out, /NO DEBRIEF was recorded/)
  assert.equal(expOf(dir).debrief, null)
  assert.ok(expOf(dir).closedAt)
})

test('an anonymous prediction is refused — it is somebody\'s judgment', () => {
  const dir = workspace()
  const r = run(dir, ['predict', '--checks', 'camera-pose'])
  assert.equal(r.code, 1)
  assert.match(r.out, /somebody's judgment/)
})
