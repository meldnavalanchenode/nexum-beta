// The human-reported-change workflow, end to end — the design-test slice.
//
// Arc under test: verified state → a PERSON reports a physical change no file
// records → PHYSYNC stores exactly how it knows (human/self-reported, named,
// timed) → proposed camera-pose rules do NOTHING → a named approval activates
// them → calibration + localization appear as required, with the why-path →
// fresh post-report evidence satisfies them → a new state closes the loop —
// while V1's history stays byte-identical throughout.
//
// Uses fixtures/camera_reported_demo.json — SIMULATED data, marked so in the
// fixture itself; every human name in it says Demo on purpose.

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
const statusJson = (dir) => JSON.parse(run(dir, ['status', '--config', 'robot.xml', '--code', 'code', '--json']).out.replace(/^[^{]*/, ''))

/** A sandbox with the demo staged and V1 saved. prefold=true records the
 *  spec's V1 evidence (camera-pose calibration + localization PASS) first, so
 *  it folds into the state as history. */
function workspace({ prefold = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'physync-rep-'))
  mkdirSync(join(dir, '.physync'), { recursive: true })
  writeFileSync(join(dir, '.physync/tests.json'), JSON.stringify({ tests: demo.tests }, null, 2))
  writeFileSync(join(dir, 'robot.xml'), demo.configXml)
  mkdirSync(join(dir, 'code'), { recursive: true })
  for (const f of demo.files) writeFileSync(join(dir, 'code', f.name), f.content)
  if (prefold) {
    run(dir, ['result', '--test', 'camera-pose', '--pass', '--by', 'Demo Operator', '--method', 'demo bench (simulated scenario)'])
    run(dir, ['result', '--test', 'localization', '--value', '0.95', '--by', 'Demo Operator', '--method', 'demo bench (simulated scenario)'])
  }
  const saved = run(dir, ['state', '--config', 'robot.xml', '--code', 'code'])
  assert.equal(saved.code, 0, `V1 must save: ${saved.out}`)
  return dir
}
const report = (dir) => run(dir, ['change', '--component', 'camera-position', '--note', 'Camera mount was re-aimed', '--by', 'Demo Reporter'])
const loadPack = (dir) => run(dir, ['rules', '--pack', 'camera-pose'])
const approveAll = (dir) => {
  for (const id of ['camera-pose:01', 'camera-pose:02']) {
    const r = run(dir, ['graph', '--approve', id, '--by', 'Demo Mentor (simulated)'])
    assert.equal(r.code, 0, `approval of ${id} must succeed: ${r.out}`)
  }
}

// ── 1. a human-reported change is never displayed as detected ──────────────
test('reported change renders as HUMAN-REPORTED CHANGE, never as a detection', () => {
  const dir = workspace()
  const rec = report(dir)
  assert.match(rec.out, /HUMAN-REPORTED CHANGE/, 'the change command labels the record')
  const human = run(dir, ['status', '--config', 'robot.xml', '--code', 'code'])
  assert.match(human.out, /HUMAN-REPORTED CHANGE \(not detected — nothing was measured\)/)
  assert.ok(!/WHAT CHANGED \(detected[\s\S]*camera-position/.test(human.out), 'the reported change must never appear under the detected section')
  const j = statusJson(dir)
  const c = j.changes.find((x) => x.component === 'camera-position')
  assert.equal(c.source, 'human')
  assert.equal(c.method, 'self-reported')
  assert.equal(c.by, 'Demo Reporter')
  assert.equal(c.note, 'Camera mount was re-aimed')
  assert.ok(c.at, 'the report carries its timestamp')
  assert.equal(c.previous, null, 'nobody measured a before')
  assert.equal(c.current, null, 'nobody measured an after')
})

// ── 2. proposed/unapproved rules produce ZERO real requirements ────────────
test('the camera-pose pack, loaded but unapproved, changes nothing — the report surfaces for hand review instead of vanishing', () => {
  const dir = workspace()
  loadPack(dir)
  report(dir)
  const j = statusJson(dir)
  assert.equal(j.status, 'REVALIDATION REQUIRED', 'a reported change still demands human attention')
  assert.equal(j.revalidation.required.length, 0, 'proposed edges must generate NO requirements')
  assert.equal(j.revalidation.invalidated.length, 0, 'proposed edges must invalidate NOTHING')
  assert.ok(
    j.revalidation.unmappedChanges.some((u) => u.includes('camera-position') && u.includes('no approved edge')),
    'the change must surface under no-dependency-mapping, not disappear'
  )
})

// ── 3. approved rules generate exactly the affected requirements ───────────
test('after a NAMED approval, the calibration and the localization test are owed — with the why-path', () => {
  const dir = workspace()
  loadPack(dir)
  report(dir)
  approveAll(dir)
  const j = statusJson(dir)
  const actions = j.revalidation.required.map((r) => r.action)
  assert.ok(actions.includes('calibration:camera-pose'), 'camera pose calibration requires review')
  assert.ok(actions.includes('test:localization'), 'localization validation requires recheck')
  assert.equal(actions.length, 2, 'and nothing else')
  for (const r of j.revalidation.required) {
    assert.ok(r.because.some((b) => b.includes('physical-change-reported') && b.includes('camera-position')),
      `${r.action} must trace back to the human report`)
    assert.ok(Array.isArray(r.via) && r.via.length >= 1, `${r.action} must carry the edge ids it traveled (via)`)
  }
  const loc = j.revalidation.required.find((r) => r.action === 'test:localization')
  assert.ok(loc.via.includes('camera-pose:02'), 'localization was reached through the second hop')

  // and the HUMAN output renders the path and the next command — nobody
  // should have to trust an unexplained conclusion or guess how to respond
  const human = run(dir, ['status', '--config', 'robot.xml', '--code', 'code'])
  assert.match(human.out, /path: camera-position → calibration:camera-pose \(approved by Demo Mentor \(simulated\)\)/)
  assert.match(human.out, /calibration:camera-pose → test:localization \(approved by Demo Mentor \(simulated\)\)/)
  assert.match(human.out, /when done, record it: physync result --test localization/)
  assert.match(human.out, /when done, record it: physync result --test camera-pose/)
  // the why is a SENTENCE, not a trace token — and the trace stays in JSON
  assert.match(human.out, /required because: Demo Reporter reported a physical change to camera-position \("Camera mount was re-aimed"\)/)
  assert.match(human.out, /1 change\(s\) · 1 evidence item\(s\) put in question · 2 recheck\(s\) owed/)
  for (const r of j.revalidation.required) {
    assert.ok(r.becauseHuman.some((b) => b.includes('Demo Reporter reported a physical change')), `${r.action} carries the human sentence`)
    assert.ok(r.because.some((b) => b.includes('physical-change-reported')), `${r.action} keeps the machine trace`)
  }
})

// ── 4. historical evidence remains unchanged ───────────────────────────────
test('V1 stays byte-identical through the whole arc — an old PASS is never rewritten', () => {
  const dir = workspace()
  const v1Path = join(dir, '.physync/states/V1.json')
  const before = readFileSync(v1Path)
  loadPack(dir); report(dir); approveAll(dir); statusJson(dir)
  run(dir, ['result', '--test', 'localization', '--value', '0.4', '--by', 'Demo Operator']) // even a new FAIL
  statusJson(dir)
  const after = readFileSync(v1Path)
  assert.ok(before.equals(after), 'V1.json must not change by a single byte')
  const v1 = JSON.parse(after.toString())
  const passes = v1.evidence.filter((e) => e.id.startsWith('test:') && e.result === 'PASS')
  assert.equal(passes.length, 2, 'the historical PASSes are still PASS, in V1, forever')
})

// ── 5. evidence recorded BEFORE the change cannot answer it ────────────────
test('a PASS recorded after V1 but before the report does NOT satisfy the recheck the report created', () => {
  const dir = workspace()
  loadPack(dir)
  run(dir, ['result', '--test', 'localization', '--value', '0.97', '--by', 'Demo Operator']) // fresh, but pre-report
  report(dir)
  approveAll(dir)
  const j = statusJson(dir)
  const loc = j.revalidation.required.find((r) => r.action === 'test:localization')
  assert.ok(loc, 'localization must still be owed')
  assert.match(loc.label, /PREDATES/, 'and the reason says why: the result predates the change it must answer')
  assert.equal(j.revalidation.satisfiedThisRun.filter((s) => /localization.*PASS recorded/.test(s.label)).length, 0)
})

// ── 6. missing evidence is UNKNOWN, and UNKNOWN is owed ────────────────────
test('with no recorded results at all, both requirements are owed as UNKNOWN — never silently passed', () => {
  const dir = workspace({ prefold: false })
  loadPack(dir); report(dir); approveAll(dir)
  const j = statusJson(dir)
  assert.equal(j.status, 'REVALIDATION REQUIRED')
  for (const r of j.revalidation.required) {
    assert.ok(r.targets.some((t) => t.includes('no recorded result — UNKNOWN')), `${r.action} must say its evidence is missing`)
  }
})

// ── 7. multiple reports of the same component do not duplicate work ────────
test('two reports about the camera produce each requirement exactly once', () => {
  const dir = workspace()
  loadPack(dir); approveAll(dir)
  report(dir)
  run(dir, ['change', '--component', 'camera-position', '--note', 'bumped it again in the pit', '--by', 'Demo Teammate'])
  const j = statusJson(dir)
  assert.equal(j.changes.filter((c) => c.source === 'human').length, 2, 'both reports are on record')
  const actions = j.revalidation.required.map((r) => r.action)
  assert.equal(new Set(actions).size, actions.length, 'no action appears twice')
  assert.equal(actions.filter((a) => a === 'test:localization').length, 1)
})

// ── 8. a failed required check prevents completion ─────────────────────────
test('a post-report FAIL turns the status to VALIDATION FAILED — completion is impossible over a failing check', () => {
  const dir = workspace()
  loadPack(dir); report(dir); approveAll(dir)
  run(dir, ['result', '--test', 'localization', '--value', '0.5', '--by', 'Demo Operator']) // 0.5 < min 0.9 → FAIL
  const j = statusJson(dir)
  assert.equal(j.status, 'VALIDATION FAILED')
  assert.equal(j.exit, 2)
  assert.ok(j.resultFailures >= 1)
})

// ── 9. simulated evidence satisfies nothing and folds into nothing ─────────
test('a --simulated PASS is stored and labelled, satisfies no requirement, and never becomes state evidence', () => {
  const dir = workspace()
  loadPack(dir); report(dir); approveAll(dir)
  const rec = run(dir, ['result', '--test', 'localization', '--value', '0.99', '--by', 'Demo Drill', '--simulated'])
  assert.match(rec.out, /SIMULATED RESULT/, 'recording says out loud what this is')
  const j = statusJson(dir)
  const loc = j.revalidation.required.find((r) => r.action === 'test:localization')
  assert.ok(loc, 'still owed — simulated evidence cannot verify a real robot')
  assert.match(loc.label, /SIMULATED/, 'and the status says that is why')
  assert.equal(j.status, 'REVALIDATION REQUIRED')
  // and if a state is saved anyway, the simulated result must not fold in
  run(dir, ['result', '--test', 'camera-pose', '--pass', '--by', 'Demo Operator'])
  run(dir, ['result', '--test', 'localization', '--value', '0.96', '--by', 'Demo Operator'])
  assert.equal(run(dir, ['state', '--config', 'robot.xml', '--code', 'code']).code, 0)
  const v2 = JSON.parse(readFileSync(join(dir, '.physync/states/V2.json'), 'utf8'))
  const loc2 = v2.evidence.find((e) => e.id === 'test:localization')
  assert.equal(loc2.result, 'PASS')
  assert.ok(loc2.summary.includes('0.96'), 'the REAL result folded in — not the simulated 0.99')
})

// ── 10. the full controlled arc, plus the visible path ─────────────────────
test('THE ARC: V1 → human report → inert pack → approval → owed rechecks → fresh evidence → V2 → VERIFIED', () => {
  const dir = workspace()
  const v1Bytes = readFileSync(join(dir, '.physync/states/V1.json'))

  report(dir)                                                       // 1. recorded as HUMAN-REPORTED
  loadPack(dir)                                                     // 2. proposed rules…
  let j = statusJson(dir)
  assert.equal(j.revalidation.required.length, 0, '…do nothing')
  approveAll(dir)                                                   // 3. named approval activates them
  j = statusJson(dir)
  assert.deepEqual(j.revalidation.required.map((r) => r.action).sort(), ['calibration:camera-pose', 'test:localization'])
  assert.equal(j.status, 'REVALIDATION REQUIRED')                   // 5. current state demands work

  // the dependency path is visible: report → calibration → localization
  const g = JSON.parse(run(dir, ['graph', '--json']).out.replace(/^[^{]*/, ''))
  const approved = g.custom.filter((e) => e.status === 'approved')
  assert.ok(approved.some((e) => e.from === 'camera-position' && e.to === 'calibration:camera-pose'))
  assert.ok(approved.some((e) => e.from === 'calibration:camera-pose' && e.to === 'test:localization'))
  assert.ok(approved.every((e) => e.approvedBy === 'Demo Mentor (simulated)'), 'every active edge names its approver')

  // 6. record fresh revalidation evidence (post-report, named, methodical)
  run(dir, ['result', '--test', 'camera-pose', '--pass', '--by', 'Demo Operator', '--method', 'demo bench (simulated scenario)'])
  run(dir, ['result', '--test', 'localization', '--value', '0.96', '--by', 'Demo Operator', '--method', 'demo bench (simulated scenario)'])
  j = statusJson(dir)
  assert.equal(j.revalidation.required.length, 0, 'both requirements satisfied by post-report results')
  assert.equal(j.revalidation.satisfiedThisRun.filter((s) => /PASS recorded/.test(s.label)).length, 2)

  // 7. a new state closes the loop
  assert.equal(run(dir, ['state', '--config', 'robot.xml', '--code', 'code']).code, 0)
  assert.ok(existsSync(join(dir, '.physync/states/V2.json')))
  const final = statusJson(dir)
  assert.equal(final.status, 'VERIFIED FOR DEFINED CHECKS')
  assert.equal(final.against, 'V2')
  assert.equal(final.exit, 0)

  // 4. and through all of it, history never moved
  assert.ok(v1Bytes.equals(readFileSync(join(dir, '.physync/states/V1.json'))), 'V1 is immutable history')
})
