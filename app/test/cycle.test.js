// CHANGE-EVENT REPORTS — the document a team hands to someone else.
//
// The report's only job is to say what is on record. The failure mode worth
// testing is not a formatting bug, it is a document that reads BETTER than the
// records justify: an UNKNOWN rounded up to fine, a self-reported change
// printed as a measurement, a result shown as anonymous when a human put their
// name on it, or a missing prediction quietly omitted instead of named.
//
// Every test here is one of those.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderCycle, diffStates } from '../src/cycle.js'

const APP = fileURLToPath(new URL('..', import.meta.url))
const demo = JSON.parse(readFileSync(join(APP, 'fixtures/camera_reported_demo.json'), 'utf8'))

function project() {
  const root = mkdtempSync(join(tmpdir(), 'physync-cycle-'))
  const dir = join(root, 'robot'), home = join(root, 'home')
  mkdirSync(join(dir, 'code'), { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(dir, 'c.xml'), demo.configXml)
  for (const f of demo.files) writeFileSync(join(dir, 'code', f.name), f.content)
  return { dir, home }
}
const run = (p, a) => {
  const r = spawnSync(process.execPath, [join(APP, 'bin/physync.js'), ...a], {
    cwd: p.dir, encoding: 'utf8',
    env: { ...process.env, HOME: p.home, USERPROFILE: p.home },
  })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '' }
}

/** A project with one complete cycle on record: V1, a change, V2. */
function cycled() {
  const p = project()
  run(p, ['init', '--config', 'c.xml', '--code', 'code', '--by', 'Ada'])
  run(p, ['tests', '--define', '--id', 'drive', '--kind', 'validation', '--label', 'drive', '--by', 'Ada'])
  run(p, ['result', '--test', 'drive', '--pass', '--by', 'Ada'])
  run(p, ['state', '--config', 'c.xml', '--code', 'code'])
  run(p, ['predict', '--checks', 'drive', '--by', 'Ada'])
  run(p, ['change', '--component', 'camera-position', '--note', 're-aimed the mount', '--by', 'Ada'])
  // a file-visible change too, so the diff has something structural to find
  const xml = readFileSync(join(p.dir, 'c.xml'), 'utf8')
  writeFileSync(join(p.dir, 'c.xml'), xml.replace(/port="0"/, 'port="2"'))
  run(p, ['status'])
  run(p, ['result', '--test', 'drive', '--pass', '--by', 'Ada'])
  run(p, ['debrief', '--checked', 'drive', '--by', 'Ada'])
  run(p, ['state', '--config', 'c.xml', '--code', 'code'])
  return p
}

test('it writes a document covering the whole cycle', () => {
  const p = cycled()
  const r = run(p, ['report', '--out', 'event.md'])
  assert.equal(r.code, 0, r.out)
  const md = readFileSync(join(p.dir, 'event.md'), 'utf8')
  for (const section of ['# Change event', 'What changed', 'Reported by a person',
                         'What stopped counting', 'What was actually checked',
                         'Team plan vs Nexum plan', 'What is still unknown', 'Record']) {
    assert.ok(md.includes(section), `missing section: ${section}`)
  }
})

test('a result keeps the name of whoever recorded it', () => {
  // The ledger spells this `recordedBy`. Reading `by` printed "unnamed" over
  // results that carried a real name, which for a provenance-first tool is the
  // worst available field-name slip.
  const p = cycled()
  run(p, ['report', '--out', 'event.md'])
  const md = readFileSync(join(p.dir, 'event.md'), 'utf8')
  const table = md.slice(md.indexOf('What was actually checked'), md.indexOf('Team plan'))
  assert.match(table, /\bAda\b/, 'the recorder must be named')
  assert.ok(!/unnamed/.test(table), 'and must never be rendered anonymous')
  assert.ok(!/\|\s*—\s*\|\s*$/m.test(table), 'nor the timestamp dropped')
})

test('a self-reported change is never printed as a measurement', () => {
  const p = cycled()
  run(p, ['report', '--out', 'event.md'])
  const md = readFileSync(join(p.dir, 'event.md'), 'utf8')
  const human = md.slice(md.indexOf('Reported by a person'), md.indexOf('What stopped counting'))
  assert.match(human, /camera-position/, 'the reported change belongs in the human section')
  assert.match(human, /Ada/, 'with the reporter named')
  assert.match(human, /Nothing was measured/, 'and said plainly to be unmeasured')
  const detected = md.slice(md.indexOf('## What changed'), md.indexOf('Reported by a person'))
  assert.ok(!/camera-position/.test(detected),
    'a person\'s word must not appear in the detected-changes list')
})

test('a missing prediction is NAMED, not omitted', () => {
  // The tempting failure: a cycle with no prediction renders a clean document
  // that simply has no comparison section, and the gap disappears.
  const p = project()
  run(p, ['init', '--config', 'c.xml', '--code', 'code', '--by', 'Ada'])
  run(p, ['state', '--config', 'c.xml', '--code', 'code'])
  const xml = readFileSync(join(p.dir, 'c.xml'), 'utf8')
  writeFileSync(join(p.dir, 'c.xml'), xml.replace(/port="0"/, 'port="2"'))
  run(p, ['status', '--reveal'])
  run(p, ['state', '--config', 'c.xml', '--code', 'code'])
  const r = run(p, ['report', '--out', 'event.md'])
  assert.equal(r.code, 0, r.out)
  const md = readFileSync(join(p.dir, 'event.md'), 'utf8')
  assert.match(md, /no prediction was recorded/i, 'the absence has to be stated')
  assert.match(md, /no way to tell whether Nexum/i, 'and its consequence explained')
})

test('an unassigned verdict says so instead of implying success', () => {
  const p = cycled()
  run(p, ['report', '--out', 'event.md'])
  const md = readFileSync(join(p.dir, 'event.md'), 'utf8')
  assert.match(md, /Verdict: not yet assigned/i)
  assert.match(md, /does not grade itself/i)
})

test('coverage gaps are reported as stated absence', () => {
  const p = cycled()
  run(p, ['report', '--out', 'event.md'])
  const md = readFileSync(join(p.dir, 'event.md'), 'utf8')
  const unknown = md.slice(md.indexOf('What is still unknown'))
  assert.match(unknown, /hubs|sensors|stimulus/, 'a layer with no data must be listed')
  assert.match(unknown, /nothing was established either way/i,
    'and described as absence rather than as a pass')
})

test('the report never modifies the records it describes', () => {
  const p = cycled()
  const v1 = join(p.dir, '.physync/states/V1.json')
  const before = readFileSync(v1, 'utf8')
  run(p, ['report', '--out', 'event.md'])
  assert.equal(readFileSync(v1, 'utf8'), before, 'V1 must be byte-identical')
})

test('with no states at all it refuses instead of writing an empty document', () => {
  const p = project()
  const r = run(p, ['report', '--out', 'event.md'])
  assert.notEqual(r.code, 0)
  assert.match(r.out, /no cycle to report on|No verified states/i)
  assert.ok(!existsSync(join(p.dir, 'event.md')), 'and writes nothing')
})

test('--json carries the markdown and keeps stdout parseable', () => {
  const p = cycled()
  const r = run(p, ['report', '--json'])
  const j = JSON.parse(r.stdout)
  assert.equal(j.physync, 1)
  assert.match(j.markdown, /# Change event/)
  assert.equal(typeof j.changes, 'number')
})

test('diffStates reads only fields a saved state actually stores', () => {
  // It must not need raw config XML: a saved state keeps the digest, and
  // synthesizing the XML to reuse detectChanges would have fabricated a
  // config-changed row out of nothing.
  const from = {
    version: 1, createdAt: 'x', coverage: {},
    declared: { configName: 'r', configSha256: 'aaa', codeDigest: 'c1',
      devices: [{ name: 'claw', type: 'Servo', port: 0, bus: null },
                { name: 'lift', type: 'Motor', port: 1, bus: null }] },
  }
  const to = {
    version: 2, createdAt: 'y', coverage: {},
    declared: { configName: 'r', configSha256: 'bbb', codeDigest: 'c2',
      devices: [{ name: 'claw', type: 'ContinuousRotationServo', port: 0, bus: null },
                { name: 'climb', type: 'Motor', port: 2, bus: null }] },
  }
  const kinds = diffStates(from, to).map((c) => c.kind).sort()
  assert.deepEqual(kinds, ['config-changed', 'device-added', 'device-removed',
                           'device-type-changed', 'software-changed'])
  assert.deepEqual(diffStates(null, to), [], 'no baseline means no claims')
})

test('renderCycle on empty input states its own emptiness', () => {
  const md = renderCycle({})
  assert.match(md, /# Change event/)
  assert.match(md, /no file-detectable change/i)
  assert.match(md, /none reported/i)
  assert.ok(!/undefined|NaN|\[object/.test(md), 'and never leaks a placeholder')
})
