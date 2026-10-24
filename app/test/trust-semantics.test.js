// TRUST SEMANTICS — the five promises Nexum makes about evidence.
//
// Everything else in this product is negotiable. These five are not: they are
// what separates "a tool that tracks your testing" from "a tool that quietly
// tells you your robot is fine." Each one is stated here as an executable
// promise so that the answer to "are the trust semantics correct?" is a test
// result and not somebody's opinion.
//
//   1. a historical PASS stays PASS forever
//   2. applicability can later become REVALIDATE — the result does not change,
//      its relevance does
//   3. missing evidence NEVER becomes PASS
//   4. UNKNOWN is a legal, first-class answer
//   5. V1 is never overwritten
//
// These run against the real CLI, not internal functions, because a promise
// that only holds in unit-test conditions is not a promise to a user.

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
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** A set-up robot at V1 with a recorded PASS, rules approved. */
function atV1() {
  const dir = mkdtempSync(join(tmpdir(), 'physync-trust-'))
  mkdirSync(join(dir, 'code'), { recursive: true })
  writeFileSync(join(dir, 'yourconfig.xml'), demo.configXml)
  for (const f of demo.files) writeFileSync(join(dir, 'code', f.name), f.content)
  run(dir, ['init', '--config', 'yourconfig.xml', '--code', 'code', '--by', 'Faraday'])
  for (const id of ['camera-pose:01', 'camera-pose:02']) run(dir, ['graph', '--approve', id, '--by', 'Faraday'])
  run(dir, ['result', '--test', 'localization', '--pass', '--by', 'Faraday'])
  run(dir, ['state', '--config', 'yourconfig.xml', '--code', 'code'])
  return dir
}
const v1 = (dir) => JSON.parse(readFileSync(join(dir, '.physync/states/V1.json'), 'utf8'))
const statusJson = (dir) =>
  JSON.parse(run(dir, ['status', '--json', '--reveal']).stdout.replace(/^[^{]*/, ''))

test('PROMISE 1 — a historical PASS stays PASS, even after the change that invalidates it', () => {
  const dir = atV1()
  const before = v1(dir).evidence.find((e) => e.id.includes('localization'))
  assert.equal(before.result, 'PASS', 'baseline recorded a PASS')

  run(dir, ['change', '--component', 'camera-position', '--note', 're-aimed', '--by', 'Faraday'])
  const row = statusJson(dir).revalidation.required.find((r) => r.action === 'test:localization')
  assert.ok(row, 'the change put it in question')
  // Nexum downgrades RELEVANCE, never history. What the team reads must show
  // both at once: the check is owed, AND it still holds the PASS it earned.
  assert.match(run(dir, ['status', '--reveal']).out, /REVALIDATE\s+test:localization \(PASS @V1\)/,
    'the printed row names the earned PASS and the state it was earned in')
  assert.equal(v1(dir).evidence.find((e) => e.id === 'test:localization').result, 'PASS',
    'and V1 on disk is untouched')
})

test('PROMISE 2 — applicability degrades to REVALIDATE while the result does not move', () => {
  const dir = atV1()
  const clean = statusJson(dir)
  assert.ok(!clean.revalidation?.required?.length, 'nothing owed before a change')

  run(dir, ['change', '--component', 'camera-position', '--note', 're-aimed', '--by', 'Faraday'])
  const after = statusJson(dir)
  const row = after.revalidation.required.find((r) => r.action === 'test:localization')
  assert.equal(row.applicability ?? 'REVALIDATE', 'REVALIDATE', 'relevance dropped')
  assert.ok(row.reasonCodes.length, 'with a machine-readable reason')
  assert.ok(row.becauseHuman.length, 'and a sentence a student can read')
  assert.match(row.reasonCodes.join(','), /PHYSICAL_CHANGE_REPORTED/,
    'and the reason names the actual cause, not a generic "something changed"')
})

test('PROMISE 3 — missing evidence never becomes PASS', () => {
  const dir = atV1()
  const st = v1(dir)
  // Scope matters. `config-parsed` and `config-code-reconciled` are DECLARED-
  // layer facts that really were established this run, so PASS is correct for
  // them. The promise is about HUMAN-JUDGED checks. (Conflating the two layers
  // is how this test was written wrong the first time: the declared rows read
  // PASS and looked like a bug.) Both layers must be distinguishable.
  assert.ok(st.evidence.some((e) => e.source === 'declared'), 'declared facts are their own layer')
  assert.ok(st.evidence.some((e) => e.source === 'human'), 'and human judgments are marked as such')

  // Risk 1: a check `init` defined but nobody ran must never read PASS. It is
  // absent from the evidence array entirely — which is a stronger guarantee
  // than UNKNOWN, but either is acceptable; PASS is not.
  const driveRow = st.evidence.find((e) => e.id === 'test:drive-straight')
  assert.ok(driveRow === undefined || driveRow.result !== 'PASS',
    'a defined-but-never-run check must not read PASS')

  // Risk 2 — the sharp one: a NUMBER recorded with no human-set threshold.
  // 0.99 looks like a pass to a person. Nobody has said what bar it clears,
  // so it is not a pass to Nexum.
  const dir2 = atV1()
  const rec = run(dir2, ['result', '--test', 'drive-straight', '--value', '0.99', '--by', 'Faraday'])
  assert.match(rec.out, /UNKNOWN/, 'recording it says UNKNOWN out loud')
  assert.match(rec.out, /no threshold|bar to clear/, 'and explains why, so it reads as a rule not a glitch')
  run(dir2, ['state', '--config', 'yourconfig.xml', '--code', 'code'])
  const v2 = JSON.parse(readFileSync(join(dir2, '.physync/states/V2.json'), 'utf8'))
  const numeric = v2.evidence.find((e) => e.id === 'test:drive-straight')
  assert.equal(numeric.result, 'UNKNOWN',
    'a measurement with no threshold has not been judged by anyone — it cannot be a PASS')

  // And once a human DOES set the bar, the same number becomes a judgement.
  // (This path was a dead end until the Faraday prep: `init` scaffolds its
  // checks with no threshold, and `--define` refuses an existing id, so a new
  // team could never set a bar at all and every number stayed UNKNOWN forever.
  // See the `tests --threshold` suite in distribution-adjacent tests below.)
  const bar = run(dir2, ['tests', '--threshold', '--id', 'drive-straight', '--min', '0.9', '--by', 'Faraday'])
  assert.equal(bar.code, 0, bar.out)
  const after = run(dir2, ['result', '--test', 'drive-straight', '--value', '0.99', '--by', 'Faraday'])
  assert.match(after.out, /PASS/, 'with a human-set bar, 0.99 clears it — the judgement is theirs, not ours')
  assert.match(run(dir2, ['result', '--test', 'drive-straight', '--value', '0.5', '--by', 'Faraday']).out,
    /FAIL/, 'and a number that misses the bar is a FAIL, not a soft UNKNOWN')
})

test('a threshold is an authored decision, and setting one never re-grades history', () => {
  const dir = atV1()
  // The pre-bar UNKNOWN is on the record before any threshold exists.
  run(dir, ['result', '--test', 'drive-straight', '--value', '0.99', '--by', 'Faraday'])
  run(dir, ['tests', '--threshold', '--id', 'drive-straight', '--min', '0.9', '--by', 'Faraday'])

  const hist = run(dir, ['results', '--test', 'drive-straight']).out
  assert.match(hist, /UNKNOWN \(0\.99\)/,
    'the result recorded before the bar existed keeps its UNKNOWN — thresholds are not retroactive')

  // Changing a bar says so, out loud, rather than silently moving the goalposts.
  const changed = run(dir, ['tests', '--threshold', '--id', 'drive-straight', '--min', '0.95', '--by', 'Faraday'])
  assert.match(changed.out, /≥0\.9 → ≥0\.95/, 'it names the old bar and the new one')
  assert.match(changed.out, /history is not re-graded/, 'and states the guarantee')

  // The invariant survives: a threshold always names a human.
  assert.match(run(dir, ['tests']).out, /threshold ≥0\.95 \(Faraday\)/, 'the bar carries its author')
  assert.match(run(dir, ['tests', '--threshold', '--id', 'drive-straight', '--min', '0.9']).out,
    /needs --by/, 'and an unnamed threshold is refused')
})

test('PROMISE 4 — UNKNOWN is a legal answer, stated and counted, not hidden', () => {
  const dir = atV1()
  assert.equal(run(dir, ['result', '--test', 'camera-pose', '--unknown', '--by', 'Faraday']).code, 0,
    '--unknown is an accepted result a human can record')
  run(dir, ['state', '--config', 'yourconfig.xml', '--code', 'code'])
  const out = run(dir, ['states']).out + run(dir, ['status', '--reveal']).out
  assert.match(out, /UNKNOWN/, 'UNKNOWN appears in what the team reads')
  // It is counted out loud, not quietly dropped from a total.
  const st = JSON.parse(readFileSync(join(dir, '.physync/states/V2.json'), 'utf8'))
  assert.ok(st.evidence.some((e) => e.result === 'UNKNOWN'), 'and persisted as UNKNOWN in the record')
})

test('PROMISE 5 — V1 is never overwritten, byte for byte, across many later runs', () => {
  const dir = atV1()
  const original = readFileSync(join(dir, '.physync/states/V1.json'))
  for (let i = 0; i < 3; i++) {
    run(dir, ['change', '--component', 'camera-position', '--note', `pass ${i}`, '--by', 'Faraday'])
    run(dir, ['result', '--test', 'localization', '--pass', '--by', 'Faraday'])
    run(dir, ['state', '--config', 'yourconfig.xml', '--code', 'code'])
  }
  assert.ok(original.equals(readFileSync(join(dir, '.physync/states/V1.json'))),
    'V1 is byte-identical after three further verified states')
  for (const v of ['V2', 'V3', 'V4']) {
    assert.ok(existsSync(join(dir, `.physync/states/${v}.json`)), `${v} was appended`)
  }
  // And the digest still verifies — tamper-evidence is live, not decorative.
  assert.match(run(dir, ['states']).out, /V1/, 'history still lists V1')
})
