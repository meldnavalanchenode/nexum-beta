// CONCURRENCY AND TORN FILES — losing a team's work while telling them it saved.
//
// Three defects, all of which reported success for something that did not
// happen. That shape is the worst one available: a team has no reason to look.
//
//  1. Two `state` runs at once BOTH printed "V2 saved" and exited 0, and only
//     one V2 existed. `existsSync` then rename is check-then-act — both runs
//     saw "no V2", both wrote, one silently lost.
//  2. `result` appended to a ledger whose last line was torn, printed
//     "Recorded: … PASS", exited 0 — and every later read of that ledger threw.
//  3. The web UI rendered the shadow-mode gate as a literal "██ undefined"
//     banner with no hint, because the withheld response carries no `status`.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, appendFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeAtomicExclusive } from '../src/io.js'

const APP = fileURLToPath(new URL('..', import.meta.url))
const demo = JSON.parse(readFileSync(join(APP, 'fixtures/camera_reported_demo.json'), 'utf8'))
const CLI = join(APP, 'bin/physync.js')
const run = (dir, a) => {
  const r = spawnSync(process.execPath, [CLI, ...a], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'physync-conc-'))
  mkdirSync(join(dir, 'code'), { recursive: true })
  writeFileSync(join(dir, 'c.xml'), demo.configXml)
  for (const f of demo.files) writeFileSync(join(dir, 'code', f.name), f.content)
  run(dir, ['init', '--config', 'c.xml', '--code', 'code', '--by', 'T'])
  return dir
}

test('writeAtomicExclusive refuses an existing target and cleans up after itself', () => {
  const dir = mkdtempSync(join(tmpdir(), 'physync-excl-'))
  const target = join(dir, 'v.json')
  writeAtomicExclusive(target, '{"first":true}')
  assert.throws(() => writeAtomicExclusive(target, '{"second":true}'), (e) => e.code === 'EEXIST')
  assert.equal(readFileSync(target, 'utf8'), '{"first":true}', 'the first writer keeps the file')
  assert.deepEqual(readdirSync(dir), ['v.json'], 'and the loser leaves no scratch file')
})

test('two concurrent saves never claim the same version, and nothing is lost', async () => {
  const dir = project()
  run(dir, ['state', '--config', 'c.xml', '--code', 'code'])   // V1

  const go = () => new Promise((res) => {
    const p = spawn(process.execPath, [CLI, 'state', '--config', 'c.xml', '--code', 'code'],
      { cwd: dir, encoding: 'utf8' })
    let out = ''
    p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { out += d })
    p.on('close', (code) => res({ code, out }))
  })
  const runs = await Promise.all([go(), go()])

  // THE INVARIANT, and it is narrower than "exactly one wins". Two runs that
  // genuinely overlap both compute version 2, and only one may have it — the
  // loser must be told. Two runs that SERIALIZE (which is what a loaded
  // machine does) legitimately produce V2 and V3: both saved, nothing lost,
  // nothing overwritten. An earlier version of this test demanded the first
  // shape and failed under load on the second, which is correct behaviour.
  const claimed = runs.flatMap((r) => [...r.out.matchAll(/V(\d+) saved/g)].map((m) => m[1]))
  assert.equal(new Set(claimed).size, claimed.length,
    `two runs claimed the same version: ${claimed.join(', ')} — one of those saves was lost`)

  for (const r of runs) {
    if (!/V\d+ saved/.test(r.out)) {
      assert.notEqual(r.code, 0, 'a run that saved nothing must not exit 0')
      assert.match(r.out, /created by another run|already exists/,
        'and must say why, rather than failing silently')
    }
  }

  // Every version a run CLAIMED must actually be on disk.
  const onDisk = new Set(readdirSync(join(dir, '.physync/states'))
    .filter((f) => /^V\d+\.json$/.test(f)).map((f) => f.match(/\d+/)[0]))
  for (const v of claimed) {
    assert.ok(onDisk.has(v), `a run reported "V${v} saved" but V${v}.json is not on disk`)
  }
})

test('a torn results ledger refuses the next write instead of swallowing it', () => {
  const dir = project()
  run(dir, ['result', '--test', 'localization', '--pass', '--by', 'T'])
  // A write cut short by a laptop sleeping: a half-written final line.
  appendFileSync(join(dir, '.physync/results/ledger.jsonl'), '{"physyncResult":1,"testId":"brok')

  const r = run(dir, ['result', '--test', 'localization', '--pass', '--by', 'T'])
  assert.notEqual(r.code, 0, 'it must not report success over an unreadable ledger')
  assert.match(r.out, /Refusing to record/)
  assert.match(r.out, /cannot be read back/, 'it names the real problem')
  assert.match(r.out, /LAST line/, 'and tells them which line is almost certainly damaged')
  assert.ok(!/^Recorded:/m.test(r.out), 'and must never print "Recorded" for a write it refused')
})

test('a healthy ledger still records normally', () => {
  const dir = project()
  const r = run(dir, ['result', '--test', 'localization', '--pass', '--by', 'T'])
  assert.equal(r.code, 0)
  assert.match(r.out, /Recorded/)
})

test('the web UI renders the prediction gate, never "undefined"', () => {
  const ui = readFileSync(join(APP, 'ui/index.html'), 'utf8')
  assert.match(ui, /d\.predictionRequired/, 'the withheld response carries no status field and must be handled first')
  assert.match(ui, /PREDICTION NOT YET RECORDED/, 'the banner says what is actually happening')
  assert.match(ui, /d\.hint/, 'and the hint reaches the student instead of being dropped')
  // The gate branch must come BEFORE the normal render, or it never runs.
  assert.ok(ui.indexOf('d.predictionRequired') < ui.indexOf('STATUS_CLASS[d.status]'),
    'the gate must be checked before the banner that would print undefined')
})
