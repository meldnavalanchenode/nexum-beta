// DURABILITY — a team must not lose their history to a sleeping laptop.
//
// `writeFileSync` truncates the target and then writes. Die in between — lid
// closed, battery dead, Ctrl-C, full disk — and the file is torn. For the
// verified state that was unrecoverable: the torn file failed JSON.parse
// before any of Nexum's integrity messaging ran, so a team saw a raw parser
// exception, AND `state` failed too, so they could not save a new baseline to
// get moving again. Their whole history, bricked, with no way forward.
//
// experiment.js and reported.js already wrote via temp-file + rename. The
// pattern was known and applied to the two least consequential files while the
// verified state, the dependency graph and the check definitions were written
// directly. These tests hold the line for all of them.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeAtomic } from '../src/io.js'

const APP = fileURLToPath(new URL('..', import.meta.url))
const demo = JSON.parse(readFileSync(join(APP, 'fixtures/camera_reported_demo.json'), 'utf8'))
const run = (dir, a) => {
  const r = spawnSync(process.execPath, [join(APP, 'bin/physync.js'), ...a], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'physync-dur-'))
  mkdirSync(join(dir, 'code'), { recursive: true })
  writeFileSync(join(dir, 'c.xml'), demo.configXml)
  for (const f of demo.files) writeFileSync(join(dir, 'code', f.name), f.content)
  run(dir, ['init', '--config', 'c.xml', '--code', 'code', '--by', 'T'])
  run(dir, ['result', '--test', 'localization', '--pass', '--by', 'T'])
  run(dir, ['state', '--config', 'c.xml', '--code', 'code'])
  return dir
}

test('writeAtomic leaves no scratch file behind, and replaces in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'physync-atomic-'))
  const target = join(dir, 'f.json')
  writeAtomic(target, '{"a":1}')
  writeAtomic(target, '{"a":2}')
  assert.equal(readFileSync(target, 'utf8'), '{"a":2}', 'the new content lands')
  assert.deepEqual(readdirSync(dir), ['f.json'], 'no .tmp-<pid> file survives')
})

test('a failed write never leaves a half-file where the real one was', () => {
  const dir = mkdtempSync(join(tmpdir(), 'physync-atomic-'))
  const target = join(dir, 'f.json')
  writeAtomic(target, '{"good":true}')
  // A directory cannot be written as a file — stands in for ENOSPC/EACCES.
  assert.throws(() => writeAtomic(join(dir, 'f.json', 'nope'), 'x'))
  assert.equal(readFileSync(target, 'utf8'), '{"good":true}', 'the previous content is untouched')
  assert.deepEqual(readdirSync(dir), ['f.json'], 'and no scratch file is left')
})

test('every core file that holds a team\'s history is written atomically', () => {
  // A direct writeFileSync in any of these is a torn-file waiting to happen.
  for (const f of ['state.js', 'graph.js', 'results.js', 'experiment.js', 'reported.js']) {
    const src = readFileSync(join(APP, 'src', f), 'utf8')
    const direct = [...src.matchAll(/^\s*writeFileSync\(/gm)]
    assert.equal(direct.length, 0,
      `${f} writes directly ${direct.length} time(s) — use writeAtomic from io.js`)
  }
})

test('a torn verified state explains itself and names the way out', () => {
  const dir = project()
  const v1 = join(dir, '.physync/states/V1.json')
  const whole = readFileSync(v1, 'utf8')
  writeFileSync(v1, whole.slice(0, Math.floor(whole.length * 2 / 3)))  // lid closed mid-write

  const r = run(dir, ['status'])
  assert.equal(r.code, 1)
  assert.match(r.out, /V1\.json is not readable JSON/, 'it names the exact file')
  assert.match(r.out, /laptop sleeping or losing power/, 'and the likely cause')
  assert.match(r.out, /Nothing else is affected/, 'and scopes the damage honestly')
  assert.match(r.out, /run `state` again/, 'and gives the way forward')
  assert.ok(!/do not delete it[\s\S]*unhandled error/.test(r.out),
    'and does NOT tell them to report their own damaged file as a Nexum bug')
})

test('the torn state does not also block recovery', () => {
  // The original failure mode: `status` AND `state` both died, so a team had
  // no way to record a new baseline and move on.
  const dir = project()
  const v1 = join(dir, '.physync/states/V1.json')
  const whole = readFileSync(v1, 'utf8')
  writeFileSync(v1, whole.slice(0, Math.floor(whole.length / 2)))

  // Following the instruction the message gives — move the file aside — must work.
  writeFileSync(join(dir, 'V1.json.broken'), readFileSync(v1))
  spawnSync('rm', [v1])
  const after = run(dir, ['state', '--config', 'c.xml', '--code', 'code'])
  assert.equal(after.code, 0, `recovery path must work:\n${after.out}`)
  assert.ok(existsSync(join(dir, '.physync/states/V1.json')), 'a fresh baseline is recorded')
})

test('a verified state is never rewritten once saved', () => {
  const dir = project()
  const v1 = join(dir, '.physync/states/V1.json')
  const before = readFileSync(v1)
  const mtime = statSync(v1).mtimeMs
  run(dir, ['change', '--component', 'camera-position', '--note', 'x', '--by', 'T'])
  run(dir, ['state', '--config', 'c.xml', '--code', 'code', '--reveal'])
  assert.ok(readFileSync(v1).equals(before), 'V1 is byte-identical')
  assert.equal(statSync(v1).mtimeMs, mtime, 'and was not even touched')
})
