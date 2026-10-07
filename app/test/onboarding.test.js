// BETA ONBOARDING — locks the fix for the Faraday audit's P0: following the
// README produced "0 recheck(s) owed" because a new team had no tests defined
// and no dependency rules approved, so there was nothing to reason about. The
// product worked; the documented path led somewhere useless.
//
// These tests assert the DOCUMENTED path (init → approve → state → predict →
// status) produces the product's actual value, and that init refuses to make
// the engineering judgment that belongs to a human.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = fileURLToPath(new URL('..', import.meta.url))
const demo = JSON.parse(readFileSync(join(APP, 'fixtures/camera_reported_demo.json'), 'utf8'))
const run = (dir, a) => {
  const r = spawnSync(process.execPath, [join(APP, 'bin/physync.js'), ...a], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
function freshRobot() {
  const dir = mkdtempSync(join(tmpdir(), 'physync-onb-'))
  mkdirSync(join(dir, 'code'), { recursive: true })
  writeFileSync(join(dir, 'yourconfig.xml'), demo.configXml)
  for (const f of demo.files) writeFileSync(join(dir, 'code', f.name), f.content)
  return dir
}

test('init scaffolds checks and PROPOSED rules — and approves nothing on the team\'s behalf', () => {
  const dir = freshRobot()
  const r = run(dir, ['init', '--config', 'yourconfig.xml', '--code', 'code', '--by', 'Faraday'])
  assert.equal(r.code, 0, r.out)
  assert.ok(existsSync(join(dir, '.physync/tests.json')), 'starter checks defined')
  const graph = JSON.parse(readFileSync(join(dir, '.physync/graph.json'), 'utf8'))
  assert.ok(graph.edges.length >= 2, 'candidate rules loaded')
  assert.ok(graph.edges.every((e) => e.status === 'proposed'), 'EVERY rule is inert until a named human approves it')
  assert.match(r.out, /ONE DECISION IS YOURS/, 'the human judgment is named, not hidden')
  assert.match(r.out, /graph --approve/, 'and the exact command is printed')
  assert.match(r.out, /BEFORE step 3/, 'the predict-before-status ordering is stated — the experiment depends on it')
})

test('init needs a name and real paths — no silent setup', () => {
  const dir = freshRobot()
  assert.match(run(dir, ['init', '--config', 'yourconfig.xml', '--code', 'code']).out, /--by/)
  assert.match(run(dir, ['init', '--config', 'nope.xml', '--code', 'code', '--by', 'F']).out, /not found/)
  assert.match(run(dir, ['init', '--config', 'yourconfig.xml', '--code', 'nope', '--by', 'F']).out, /not found/)
})

test('init is safe to re-run — it never clobbers a team\'s own definitions', () => {
  const dir = freshRobot()
  run(dir, ['init', '--config', 'yourconfig.xml', '--code', 'code', '--by', 'Faraday'])
  writeFileSync(join(dir, '.physync/tests.json'), JSON.stringify({ tests: [{ id: 'mine', kind: 'validation', label: 'my own check' }] }, null, 2))
  run(dir, ['graph', '--approve', 'camera-pose:01', '--by', 'Faraday'])
  const again = run(dir, ['init', '--config', 'yourconfig.xml', '--code', 'code', '--by', 'Faraday'])
  assert.equal(again.code, 0)
  assert.match(again.out, /already defined/)
  const tests = JSON.parse(readFileSync(join(dir, '.physync/tests.json'), 'utf8')).tests
  assert.deepEqual(tests.map((t) => t.id), ['mine'], 'their definitions survive')
  const graph = JSON.parse(readFileSync(join(dir, '.physync/graph.json'), 'utf8'))
  assert.equal(graph.edges.find((e) => e.id === 'camera-pose:01').status, 'approved', 'and so does their approval')
})

test('THE DOCUMENTED PATH produces real rechecks — the P0 this fixes', () => {
  const dir = freshRobot()
  run(dir, ['init', '--config', 'yourconfig.xml', '--code', 'code', '--by', 'Faraday'])
  // before approval: an honest refusal to guess, not a silent nothing
  run(dir, ['state', '--config', 'yourconfig.xml', '--code', 'code'])
  run(dir, ['change', '--component', 'camera-position', '--note', 're-aimed', '--by', 'Faraday'])
  const unapproved = run(dir, ['status', '--reveal'])
  assert.match(unapproved.out, /NO DEPENDENCY MAPPING|UNKNOWN/, 'unapproved rules produce honest ignorance')

  // after the human decision the README asks for: the product's actual value.
  // (--reveal because THIS test is about plan content, not the experiment
  // ordering — the gate that would otherwise withhold it has its own test.)
  for (const id of ['camera-pose:01', 'camera-pose:02']) run(dir, ['graph', '--approve', id, '--by', 'Faraday'])
  const j = JSON.parse(run(dir, ['status', '--json', '--reveal']).out.replace(/^[^{]*/, ''))
  const actions = j.revalidation.required.map((r) => r.action)
  assert.ok(actions.includes('calibration:camera-pose'), `expected the calibration recheck, got ${actions.join(', ')}`)
  assert.ok(actions.includes('test:localization'), 'and the test that depends on it')
  assert.ok(j.revalidation.required.every((r) => r.reasonCodes.length && r.becauseHuman.length),
    'every demand carries a machine code AND a human sentence')
})

test('the full beta loop closes: predict → status → results → debrief → V2, history intact', () => {
  const dir = freshRobot()
  run(dir, ['init', '--config', 'yourconfig.xml', '--code', 'code', '--by', 'Faraday'])
  for (const id of ['camera-pose:01', 'camera-pose:02']) run(dir, ['graph', '--approve', id, '--by', 'Faraday'])
  run(dir, ['result', '--test', 'localization', '--value', '0.95', '--by', 'Faraday'])
  run(dir, ['state', '--config', 'yourconfig.xml', '--code', 'code'])
  const v1 = readFileSync(join(dir, '.physync/states/V1.json'))

  run(dir, ['predict', '--checks', 'localization', '--by', 'Faraday'])
  run(dir, ['change', '--component', 'camera-position', '--note', 're-aimed', '--by', 'Faraday'])
  assert.equal(run(dir, ['status']).code, 3, 'revalidation required')
  run(dir, ['result', '--test', 'localization', '--value', '0.96', '--by', 'Faraday'])
  run(dir, ['result', '--test', 'camera-pose', '--pass', '--by', 'Faraday'])
  const d = run(dir, ['debrief', '--checked', 'localization, camera-pose', '--by', 'Faraday'])
  assert.equal(d.code, 0, d.out)
  assert.match(d.out, /agreed \(both named it\):\s+localization/)
  assert.match(d.out, /Nexum added beyond prediction:\s+camera-pose/)
  // The debrief PROMPTS for a verdict (correct — it hands the judgment to a
  // human) but must never ASSIGN one. The record is the proof, not the prose.
  const expId = readFileSync(join(dir, '.physync/experiments/exp-1.json'), 'utf8')
  assert.equal(JSON.parse(expId).debrief.verdict, null, 'the debrief records facts and assigns NO verdict')
  assert.match(d.out, /physync verdict/, 'and it asks the human to make that call')

  assert.equal(run(dir, ['state', '--config', 'yourconfig.xml', '--code', 'code']).code, 0)
  assert.ok(existsSync(join(dir, '.physync/states/V2.json')))
  assert.ok(v1.equals(readFileSync(join(dir, '.physync/states/V1.json'))), 'V1 is byte-identical history')
})

test('the data folder a team sends us holds no source code, and reset is total', () => {
  const dir = freshRobot()
  run(dir, ['init', '--config', 'yourconfig.xml', '--code', 'code', '--by', 'Faraday'])
  run(dir, ['state', '--config', 'yourconfig.xml', '--code', 'code'])
  const blob = ['states/V1.json', 'graph.json', 'tests.json', 'inputs.json']
    .map((f) => { try { return readFileSync(join(dir, '.physync', f), 'utf8') } catch { return '' } }).join('\n')
  assert.ok(!blob.includes('hardwareMap'), 'no TeamCode source is copied into the data folder')
  assert.ok(!blob.includes('class DemoAuto'), 'really, none')
  assert.ok(!/\/Users\/|\/home\//.test(blob), 'no absolute paths naming a person\'s machine')
})

test('user-facing banners say NEXUM — the name the team was given', () => {
  const dir = freshRobot()
  const out = run(dir, ['check', '--config', 'yourconfig.xml', '--code', 'code']).out
  assert.match(out, /██ NEXUM PREFLIGHT/)
  assert.ok(!/██ PHYSYNC/.test(out), 'no second product name in front of a beta tester')
})

// ── remote self-service: the experiment protects itself ────────────────────
// Reading Nexum's answer before writing your own prediction destroys that
// change's datapoint permanently — the one mistake in this tool that cannot
// be undone. A supervised session prevents it with a human; remote beta has
// to prevent it in the product.
test('status withholds its ANSWER until a prediction is on record — but still shows what changed', () => {
  const dir = freshRobot()
  run(dir, ['init', '--config', 'yourconfig.xml', '--code', 'code', '--by', 'F'])
  for (const id of ['camera-pose:01', 'camera-pose:02']) run(dir, ['graph', '--approve', id, '--by', 'F'])
  run(dir, ['result', '--test', 'localization', '--pass', '--by', 'F'])
  run(dir, ['state', '--config', 'yourconfig.xml', '--code', 'code'])
  run(dir, ['change', '--component', 'camera-position', '--note', 're-aimed', '--by', 'F'])

  const gated = run(dir, ['status'])
  assert.match(gated.out, /PREDICTION NOT YET RECORDED/)
  assert.match(gated.out, /camera-position/, 'what CHANGED is still shown — it contaminates nothing')
  assert.ok(!/REVALIDATE|REQUIRED REVALIDATION/.test(gated.out), 'but the answer is withheld')

  const j = JSON.parse(run(dir, ['status', '--json']).out.replace(/^[^{]*/, ''))
  assert.equal(j.predictionRequired, true, 'machine consumers get the gate as a fact')
  assert.ok(!j.revalidation, 'and no plan leaks through --json either')

  // the escape hatch, for anyone not running the experiment
  assert.match(run(dir, ['status', '--reveal']).out, /REQUIRED REVALIDATION/)

  // and once armed, the full answer
  run(dir, ['predict', '--checks', 'localization', '--by', 'F'])
  const revealed = run(dir, ['status'])
  assert.match(revealed.out, /REVALIDATE {2}test:localization/)
  assert.match(revealed.out, /prediction locked/)
})

test('an unsupported Node says so in words a student can act on', () => {
  const src = readFileSync(join(APP, 'bin/physync.js'), 'utf8')
  assert.match(src, /Nexum needs Node 20 or newer/, 'the version gate exists')
  assert.match(src, /nodejs\.org/, 'and points at the fix')
})
