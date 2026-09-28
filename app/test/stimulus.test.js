// Stimulus-pass tests. The behavioral half has the same trust asymmetry as
// the config half — a false FAIL in a pit is worse than a missed WARN — so
// the boundary these lock is: ambiguous evidence WARNs, changed evidence FAILs.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseStimulusReport, toStimulusBaseline, analyzeStimulus, diffStimulus } from '../src/stimulus.js'
import { verdict } from '../src/engine.js'
import { CHECKS } from '../src/registry.js'

const APP = new URL('..', import.meta.url).pathname
const KNOWN = new Set(CHECKS.map((c) => c.id))
const report = (over = {}) => ({
  physyncStimulus: 1,
  aborted: false,
  motors: [
    { name: 'left_drive', deltaTicks: 180, result: 'moved-positive' },
    { name: 'right_drive', deltaTicks: -175, result: 'moved-negative' },
  ],
  servos: [{ name: 'claw', confirmed: true }],
  skipped: [],
  ...over,
})
const ids = (fs) => fs.map((f) => f.checkId).sort()

// ── parsing / validation ────────────────────────────────────────────────────
test('stimulus parse: accepts a well-formed report from JSON text', () => {
  const r = parseStimulusReport(JSON.stringify(report()))
  assert.equal(r.motors.length, 2)
  assert.equal(r.servos[0].confirmed, true)
})
test('stimulus parse: rejects a file that is not a stimulus report', () => {
  assert.throws(() => parseStimulusReport('{"hubs":[]}'), /physyncStimulus/)
})
test('stimulus parse: rejects an unknown motor result rather than guessing', () => {
  assert.throws(() => parseStimulusReport(JSON.stringify(report({ motors: [{ name: 'm', deltaTicks: 5, result: 'wobbled' }] }))), /unknown result/)
})
test('stimulus parse: rejects non-numeric deltaTicks', () => {
  assert.throws(() => parseStimulusReport(JSON.stringify(report({ motors: [{ name: 'm', deltaTicks: 'lots', result: 'moved-positive' }] }))), /non-numeric/)
})
test('stimulus parse: rejects a nameless device', () => {
  assert.throws(() => parseStimulusReport(JSON.stringify(report({ motors: [{ deltaTicks: 1, result: 'moved-positive' }] }))), /no name/)
})
test('stimulus parse: a servo without explicit confirmation is NOT confirmed', () => {
  const r = parseStimulusReport(JSON.stringify(report({ servos: [{ name: 'claw' }] })))
  assert.equal(r.servos[0].confirmed, false)
})

// ── baseline shape ──────────────────────────────────────────────────────────
test('stimulus baseline: records only responsive devices, sorted and directional', () => {
  const b = toStimulusBaseline(parseStimulusReport(JSON.stringify(report({
    motors: [
      { name: 'z_motor', deltaTicks: 100, result: 'moved-positive' },
      { name: 'a_motor', deltaTicks: -100, result: 'moved-negative' },
      { name: 'dead_motor', deltaTicks: 2, result: 'no-response' },
    ],
    servos: [{ name: 'claw', confirmed: true }, { name: 'wrist', confirmed: false }],
  }))))
  assert.deepEqual(b.motors, [{ name: 'a_motor', direction: 'negative' }, { name: 'z_motor', direction: 'positive' }])
  assert.deepEqual(b.servos, [{ name: 'claw' }])
})

// ── single-run analysis: ambiguous evidence must WARN, never FAIL ───────────
test('stimulus analyze: no-response WARNs (ambiguous) and never fails the run', () => {
  const f = analyzeStimulus(parseStimulusReport(JSON.stringify(report({
    motors: [{ name: 'arm', deltaTicks: 3, result: 'no-response' }],
  }))))
  assert.deepEqual(ids(f), ['stimulus-no-response'])
  assert.equal(verdict(f), 'PASS', 'a first-observation no-response must not red-light a pit')
  assert.match(f[0].fix, /encoder cable/)
  assert.match(f[0].fix, /blocked or holding weight/)
})
test('stimulus analyze: unconfirmed servo WARNs and is described as a human observation', () => {
  const f = analyzeStimulus(parseStimulusReport(JSON.stringify(report({ servos: [{ name: 'wrist', confirmed: false }] }))))
  assert.ok(f.some((x) => x.checkId === 'stimulus-servo-unconfirmed'))
  assert.equal(verdict(f), 'PASS')
})
test('stimulus analyze: skipped, interrupted, and aborted are all surfaced as coverage gaps', () => {
  const f = analyzeStimulus(parseStimulusReport(JSON.stringify(report({
    aborted: true,
    motors: [{ name: 'lift', deltaTicks: 0, result: 'interrupted' }],
    skipped: ['hang_motor'],
  }))))
  assert.equal(f.filter((x) => x.checkId === 'stimulus-coverage').length, 3)
})
test('stimulus analyze: a fully clean run produces no findings', () => {
  assert.deepEqual(analyzeStimulus(parseStimulusReport(JSON.stringify(report()))), [])
})

// ── baseline diff: changed evidence FAILs ──────────────────────────────────
const baseline = toStimulusBaseline(parseStimulusReport(JSON.stringify(report())))

test('stimulus diff: identical run against its own baseline is clean', () => {
  assert.deepEqual(diffStimulus(baseline, parseStimulusReport(JSON.stringify(report()))), [])
})
test('stimulus diff: a device that responded before and does not now FAILs', () => {
  const f = diffStimulus(baseline, parseStimulusReport(JSON.stringify(report({
    motors: [{ name: 'left_drive', deltaTicks: 1, result: 'no-response' }, { name: 'right_drive', deltaTicks: -170, result: 'moved-negative' }],
  }))))
  const lost = f.find((x) => x.checkId === 'stimulus-response-lost')
  assert.ok(lost && /left_drive/.test(lost.message))
  assert.equal(verdict(f), 'FAIL')
})
test('stimulus diff: a reversed motor FAILs and names both directions', () => {
  const f = diffStimulus(baseline, parseStimulusReport(JSON.stringify(report({
    motors: [{ name: 'left_drive', deltaTicks: -180, result: 'moved-negative' }, { name: 'right_drive', deltaTicks: -175, result: 'moved-negative' }],
  }))))
  const flip = f.find((x) => x.checkId === 'stimulus-direction-changed')
  assert.ok(flip)
  assert.match(flip.message, /positive → negative/)
  assert.equal(verdict(f), 'FAIL')
})
test('stimulus diff: a device missing from the run entirely FAILs, unless skipped', () => {
  const missing = diffStimulus(baseline, parseStimulusReport(JSON.stringify(report({
    motors: [{ name: 'left_drive', deltaTicks: 180, result: 'moved-positive' }],
  }))))
  assert.ok(missing.some((x) => x.checkId === 'stimulus-response-lost' && /right_drive/.test(x.message)))
  const skipped = diffStimulus(baseline, parseStimulusReport(JSON.stringify(report({
    motors: [{ name: 'left_drive', deltaTicks: 180, result: 'moved-positive' }],
    skipped: ['right_drive'],
  }))))
  assert.ok(!skipped.some((x) => x.checkId === 'stimulus-response-lost'), 'an explicitly skipped device is a coverage gap, not a failure')
  assert.equal(verdict(skipped), 'PASS')
})
test('stimulus diff: a servo confirmed on baseline but not now FAILs', () => {
  const f = diffStimulus(baseline, parseStimulusReport(JSON.stringify(report({ servos: [{ name: 'claw', confirmed: false }] }))))
  assert.ok(f.some((x) => x.checkId === 'stimulus-response-lost' && /claw/.test(x.message)))
})
test('stimulus diff: a device new since the baseline is INFO, not a failure', () => {
  const f = diffStimulus(baseline, parseStimulusReport(JSON.stringify(report({
    motors: [...report().motors, { name: 'new_intake', deltaTicks: 90, result: 'moved-positive' }],
  }))))
  assert.ok(f.some((x) => x.checkId === 'stimulus-coverage' && /new_intake/.test(x.message)))
  assert.equal(verdict(f), 'PASS')
})
test('stimulus: every emitted finding uses a registered check with full shape', () => {
  const all = [
    ...analyzeStimulus(parseStimulusReport(JSON.stringify(report({ aborted: true, motors: [{ name: 'a', deltaTicks: 0, result: 'no-response' }, { name: 'b', deltaTicks: 0, result: 'interrupted' }], servos: [{ name: 'c', confirmed: false }], skipped: ['d'] })))),
    ...diffStimulus(baseline, parseStimulusReport(JSON.stringify(report({ motors: [{ name: 'left_drive', deltaTicks: -5, result: 'moved-negative' }] })))),
  ]
  for (const f of all) {
    assert.ok(KNOWN.has(f.checkId), `unregistered check ${f.checkId}`)
    assert.ok(['FAIL', 'WARN', 'INFO'].includes(f.severity))
    assert.ok(Array.isArray(f.evidence) && typeof f.fix === 'string' && f.message)
  }
})

// ── CLI contract ────────────────────────────────────────────────────────────
// spawnSync, not execFileSync: stderr must be readable on SUCCESS too (the
// no-baseline notice is written there on an exit-0 run).
const cli = (cliArgs, cwd) => {
  const r = spawnSync(process.execPath, [join(APP, 'bin/physync.js'), ...cliArgs], { cwd, encoding: 'utf8' })
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
}
const dir = mkdtempSync(join(tmpdir(), 'physync-stim-'))
writeFileSync(join(dir, 'good.json'), JSON.stringify(report()))
writeFileSync(join(dir, 'reversed.json'), JSON.stringify(report({ motors: [{ name: 'left_drive', deltaTicks: -180, result: 'moved-negative' }, { name: 'right_drive', deltaTicks: -175, result: 'moved-negative' }] })))
writeFileSync(join(dir, 'aborted.json'), JSON.stringify(report({ aborted: true })))
writeFileSync(join(dir, 'dead.json'), JSON.stringify(report({ motors: [{ name: 'left_drive', deltaTicks: 0, result: 'no-response' }] })))

test('cli stimulus: refuses to record a baseline from an aborted pass', () => {
  const r = cli(['stimulus', '--file', 'aborted.json', '--baseline'], dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /aborted/)
  assert.ok(!existsSync(join(dir, '.physync/stimulus-baseline.json')))
})
test('cli stimulus: refuses a baseline in which nothing responded', () => {
  const r = cli(['stimulus', '--file', 'dead.json', '--baseline'], dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no motor responded/)
})
test('cli stimulus: records a baseline, then passes an identical run', () => {
  assert.equal(cli(['stimulus', '--file', 'good.json', '--baseline'], dir).status, 0)
  const saved = JSON.parse(readFileSync(join(dir, '.physync/stimulus-baseline.json'), 'utf8'))
  assert.equal(saved.motors.length, 2)
  assert.equal(cli(['stimulus', '--file', 'good.json'], dir).status, 0)
})
test('cli stimulus: a reversed motor fails the run with exit 2 and names the device', () => {
  const r = cli(['stimulus', '--file', 'reversed.json', '--json'], dir)
  assert.equal(r.status, 2)
  const parsed = JSON.parse(r.stdout)
  assert.equal(parsed.verdict, 'FAIL')
  assert.ok(parsed.findings.some((f) => f.checkId === 'stimulus-direction-changed' && /left_drive/.test(f.message)))
})
test('cli stimulus: a corrupt report dies cleanly with exit 1 and no stack trace', () => {
  writeFileSync(join(dir, 'corrupt.json'), '{"physyncStimulus":1,"motors":[{tru')
  const r = cli(['stimulus', '--file', 'corrupt.json'], dir)
  assert.equal(r.status, 1)
  assert.ok(!/at .*\.js:\d/.test(r.stderr), 'no stack trace')
})
test('cli stimulus: missing --file dies with usage', () => {
  assert.equal(cli(['stimulus'], dir).status, 1)
})
test('cli stimulus: without a baseline it still reports, and says so', () => {
  const fresh = mkdtempSync(join(tmpdir(), 'physync-stim2-'))
  writeFileSync(join(fresh, 'good.json'), JSON.stringify(report()))
  const r = cli(['stimulus', '--file', 'good.json'], fresh)
  assert.equal(r.status, 0)
  assert.match(r.stderr ?? '', /No stimulus baseline yet/)
})
