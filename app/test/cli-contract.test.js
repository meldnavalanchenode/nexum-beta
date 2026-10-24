// CLI CONTRACT — flags must mean what a team typed, or say they didn't.
//
// Two defects here were silent and both produced a confident wrong answer:
//
//  1. `--config=other.xml` passed the unknown-flag validator (which strips
//     `=value` before checking the name) and was then never read, because
//     `opt()` only looked for the space-separated form. A team asking about
//     one robot was answered about whichever config was remembered from last
//     time, and told nothing. `=` is the form most people type.
//
//  2. `--value ""` became the number 0, because Number('') === 0. A fabricated
//     measurement was recorded as evidence under a human's name, and against a
//     `--max` bar a zero PASSES a check the real reading would have failed.

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
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'physync-cli-'))
  mkdirSync(join(dir, 'code'), { recursive: true })
  writeFileSync(join(dir, 'right.xml'), demo.configXml)
  writeFileSync(join(dir, 'wrong.xml'), demo.configXml.replace(/name="camera"/, 'name="DIFFERENT"'))
  for (const f of demo.files) writeFileSync(join(dir, 'code', f.name), f.content)
  run(dir, ['init', '--config', 'right.xml', '--code', 'code', '--by', 'T'])
  run(dir, ['state', '--config', 'right.xml', '--code', 'code'])
  return dir
}

test('--flag=value is honoured, not silently discarded', () => {
  const dir = project()
  const r = run(dir, ['status', '--config=wrong.xml', '--code=code', '--reveal'])
  assert.match(r.out, /DIFFERENT/, 'the config the team actually named must be the one read')
  assert.match(r.out, /change\(s\)/, 'and the different robot produces changes')
})

test('the two flag forms give identical answers', () => {
  const a = run(project(), ['status', '--config', 'wrong.xml', '--code', 'code', '--json', '--reveal'])
  const b = run(project(), ['status', '--config=wrong.xml', '--code=code', '--json', '--reveal'])
  // stdout ONLY: --json's payload is stdout, and human-facing lines (the beta
  // countdown among them) go to stderr precisely so this stays parseable.
  const strip = (s) => JSON.parse(s.replace(/^[^{]*/, ''))
  const ja = strip(a.stdout), jb = strip(b.stdout)
  assert.equal(ja.status, jb.status, 'space form and = form must agree on the verdict')
  assert.equal(ja.changes.length, jb.changes.length, 'and on what changed')
})

test('an empty --flag= is refused rather than read as empty', () => {
  const dir = project()
  const r = run(dir, ['status', '--config=', '--reveal'])
  assert.notEqual(r.code, 0)
  assert.match(r.out, /needs a value after the "="/)
})

test('recall fills only the half you omitted, and says which', () => {
  const dir = project()
  const r = run(dir, ['status', '--config=wrong.xml', '--reveal'])
  assert.match(r.out, /remembered inputs: --code code/, 'it names exactly what it reused')
  assert.ok(!/remembered inputs:.*--config/.test(r.out), 'and never silently overrides a config the team gave')
  assert.match(r.out, /DIFFERENT/, 'the supplied config still wins')
})

test('an empty or blank --value is refused — a measurement is never invented', () => {
  const dir = project()
  run(dir, ['tests', '--define', '--id', 'grip', '--kind', 'validation', '--label', 'G', '--min', '0.9', '--by', 'T'])
  for (const bad of ['', '   ', 'abc', 'NaN']) {
    const r = run(dir, ['result', '--test', 'grip', '--value', bad, '--by', 'T'])
    assert.notEqual(r.code, 0, `--value ${JSON.stringify(bad)} must be refused`)
    assert.match(r.out, /needs a number/, 'and say so plainly')
    assert.match(r.out, /will not invent a measurement/, 'naming why it refuses')
  }
  const good = run(dir, ['result', '--test', 'grip', '--value', '0.95', '--by', 'T'])
  assert.equal(good.code, 0, 'a real number still records')
  assert.match(good.out, /PASS/)
})

test('a fabricated 0 can never clear a --max threshold', () => {
  // The dangerous direction: against `--max 5`, a coerced 0 PASSES a check the
  // real reading might have failed.
  const dir = project()
  run(dir, ['tests', '--define', '--id', 'drift', '--kind', 'validation', '--label', 'D', '--max', '5', '--by', 'T'])
  const r = run(dir, ['result', '--test', 'drift', '--value', '', '--by', 'T'])
  assert.notEqual(r.code, 0, 'an empty value must not become a passing 0')
  assert.ok(!/PASS/.test(r.out), 'and must never print PASS')
})

test('a non-numeric threshold is refused instead of stored as null', () => {
  const dir = project()
  const r = run(dir, ['tests', '--define', '--id', 'x', '--kind', 'validation', '--label', 'X', '--min', 'abc', '--by', 'T'])
  assert.notEqual(r.code, 0)
  assert.match(r.out, /needs a number/)
})

// --json IS A MACHINE CONTRACT: stdout carries the payload and nothing else.
//
// This was a real defect, found while dumping data shapes for a technical
// write-up. `reuseRememberedInputs` printed "(using remembered inputs: …)" to
// STDOUT, so `status --json` with no flags returned something that is not
// JSON — and no-flags is the most natural way to script Nexum, because recall
// exists precisely so a team needs no flags at the moment a robot changed.
//
// The earlier --json test missed it by always passing explicit flags, which
// suppresses the recall notice. That is the lesson: test the invocation a
// person actually types, not the one that is convenient to write.
test('--json stdout is pure JSON even when paths come from recall', () => {
  const dir = project()
  const r = run(dir, ['status', '--json'])            // no flags: recall fires
  assert.match(r.stderr, /using remembered inputs/, 'the courtesy still reaches a human')
  assert.doesNotThrow(() => JSON.parse(r.stdout),
    `status --json stdout must parse; got: ${r.stdout.slice(0, 120)}`)
  assert.ok(!/remembered inputs/.test(r.stdout), 'and must not leak into the payload')
})

test('every --json surface returns parseable stdout', () => {
  const dir = project()
  run(dir, ['result', '--test', 'localization', '--pass', '--by', 'T'])
  for (const cmd of [['status', '--json'], ['states', '--json'], ['graph', '--json'],
                     ['tests', '--json'], ['results', '--json'], ['experiment', '--json'],
                     ['check', '--config', 'right.xml', '--code', 'code', '--json']]) {
    const r = run(dir, cmd)
    assert.doesNotThrow(() => JSON.parse(r.stdout),
      `${cmd.join(' ')} → stdout must be JSON; got: ${r.stdout.slice(0, 120)}`)
  }
})
