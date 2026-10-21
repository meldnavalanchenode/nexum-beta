// THE 30-DAY BETA WINDOW.
//
// A deliberate product decision, with three properties that are not negotiable
// if the rest of Nexum's claims are to stay true:
//
//  1. It is DISCLOSED. A countdown prints on every command and it is stated in
//     the docs. The source ships in plain JavaScript to every team, so a
//     student will find this file; what they find has to match what they were
//     told. A tool whose pitch is "it never overclaims" cannot hide a switch.
//  2. A team's RECORDS are never held hostage. The window stops Nexum from
//     running; it does not encrypt, move, or damage anything. States, results,
//     rules and experiments stay plain JSON in .physync/ and are readable with
//     any text editor, forever, by anyone.
//  3. It is ONE WINDOW PER DOWNLOAD, not one per folder. A marker in the home
//     directory survives a deleted .physync/ and a fresh unzip. That marker is
//     the only thing Nexum writes outside the project, it holds a timestamp
//     and nothing else, and it is disclosed for exactly that reason.
//
// `demo` is exempt. It reads a bundled sample, writes nothing, and is how a
// team finds out whether Nexum runs on their machine at all.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs'
import { tmpdir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  startTrial, readTrial, readHomeTrial, effectiveStart, daysRemaining,
  assertTrialActive, trialNotice, TRIAL_DAYS,
} from '../src/trial.js'

const APP = fileURLToPath(new URL('..', import.meta.url))
const demo = JSON.parse(readFileSync(join(APP, 'fixtures/camera_reported_demo.json'), 'utf8'))

// Every test gets its own HOME. Without this the suite would write to the real
// home directory and tests would see each other's clocks.
function project() {
  const root = mkdtempSync(join(tmpdir(), 'physync-trial-'))
  const dir = join(root, 'robot')
  const home = join(root, 'home')
  mkdirSync(join(dir, 'code'), { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(dir, 'c.xml'), demo.configXml)
  for (const f of demo.files) writeFileSync(join(dir, 'code', f.name), f.content)
  return { dir, home, root }
}

function spawn(p, a) {
  return spawnSync(process.execPath, [join(APP, 'bin/physync.js'), ...a], {
    cwd: p.dir, encoding: 'utf8',
    env: { ...process.env, HOME: p.home, USERPROFILE: p.home },
  })
}
const run = (p, a) => {
  const r = spawn(p, a)
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
const init = p => run(p, ['init', '--config', 'c.xml', '--code', 'code', '--by', 'T'])

// Wind BOTH markers back, because the earliest is the one that governs.
const age = (p, days) => {
  const at = new Date(Date.now() - days * 86400_000).toISOString()
  for (const f of [join(p.dir, '.physync/trial.json'), join(p.home, '.nexum/trial.json')]) {
    if (!existsSync(f)) continue
    const t = JSON.parse(readFileSync(f, 'utf8'))
    t.startedAt = at
    writeFileSync(f, JSON.stringify(t, null, 2))
  }
}

test('the clock starts at FIRST RUN, not at download', () => {
  // A team that downloads today and starts in December must get their whole
  // window — one beta team deferred to December on purpose.
  const p = project()
  assert.equal(readTrial(p.dir), null, 'a fresh project has no clock')
  assert.equal(readHomeTrial(p.home), null, 'and neither does a fresh machine')
  init(p)
  assert.ok(readTrial(p.dir)?.startedAt, 'init starts it')
  assert.equal(daysRemaining(p.dir, new Date(), p.home), TRIAL_DAYS)
})

test('restarting does not reset the clock', () => {
  const p = project()
  init(p)
  age(p, 10)
  init(p)
  assert.equal(daysRemaining(p.dir, new Date(), p.home), TRIAL_DAYS - 10, 'the countdown reflects the original start')
})

test('ONE WINDOW PER DOWNLOAD: deleting .physync does not hand out another 30 days', () => {
  // The obvious reset. A team 20 days in deletes the folder the docs tell them
  // to delete to "start over" and expects a fresh clock; the home marker is
  // what makes the window mean what we said it means.
  const p = project()
  init(p)
  age(p, 20)
  rmSync(join(p.dir, '.physync'), { recursive: true, force: true })
  assert.equal(readTrial(p.dir), null, 'the project marker is gone')
  assert.equal(daysRemaining(p.dir, new Date(), p.home), TRIAL_DAYS - 20, 'the clock is not')
  init(p)
  assert.equal(daysRemaining(p.dir, new Date(), p.home), TRIAL_DAYS - 20, 're-init does not restart it either')
})

test('ONE WINDOW PER DOWNLOAD: a fresh unzip in a new folder inherits the clock', () => {
  const p = project()
  init(p)
  age(p, 25)
  // Same machine, brand-new project directory — the "I'll just re-download it"
  // path, which is the one a student actually tries.
  const fresh = { dir: join(p.root, 'robot2'), home: p.home, root: p.root }
  mkdirSync(join(fresh.dir, 'code'), { recursive: true })
  cpSync(join(p.dir, 'c.xml'), join(fresh.dir, 'c.xml'))
  cpSync(join(p.dir, 'code'), join(fresh.dir, 'code'), { recursive: true })
  init(fresh)
  assert.equal(daysRemaining(fresh.dir, new Date(), fresh.home), TRIAL_DAYS - 25,
    'a new folder on the same machine continues the original window')
})

test('the home marker holds a timestamp and NOTHING identifying', () => {
  // "No telemetry, nothing about your machine" has to survive this file
  // existing. A team will open it; there must be nothing in it to resent.
  const p = project()
  init(p)
  const raw = readFileSync(join(p.home, '.nexum/trial.json'), 'utf8')
  const rec = JSON.parse(raw)
  assert.deepEqual(Object.keys(rec).sort(), ['days', 'format', 'startedAt'])
  const identifying = [p.dir, p.root, 'robot', 'code', hostname(), userInfo().username].filter(Boolean)
  assert.ok(identifying.length >= 4, 'this assertion is only worth anything if it has real values to look for')
  for (const leak of identifying) {
    assert.ok(!raw.includes(leak), `the home marker must not record ${JSON.stringify(leak)}`)
  }
})

test('an unwritable home degrades to the project clock instead of refusing to run', () => {
  // Locked-down school images and roaming profiles are real. A shorter leash is
  // always better than a tool that will not start. Here the home path's parent
  // is a FILE, so creating ~/.nexum fails with ENOTDIR.
  const p = project()
  writeFileSync(join(p.root, 'blocker'), 'not a directory')
  const blocked = { ...p, home: join(p.root, 'blocker', 'home') }
  const r = run(blocked, ['init', '--config', 'c.xml', '--code', 'code', '--by', 'T'])
  assert.equal(r.code, 0, `init must still succeed; got: ${r.out.slice(0, 300)}`)
  assert.ok(readTrial(blocked.dir)?.startedAt, 'and the project marker governs')
  assert.equal(daysRemaining(blocked.dir, new Date(), blocked.home), TRIAL_DAYS)
  assert.equal(readHomeTrial(blocked.home), null, 'no home marker was written')
})

test('the EARLIEST marker governs, never the newest', () => {
  const p = project()
  mkdirSync(join(p.home, '.nexum'), { recursive: true })
  const old = new Date(Date.now() - 29 * 86400_000).toISOString()
  writeFileSync(join(p.home, '.nexum/trial.json'),
    JSON.stringify({ format: 'physync-trial-v1', startedAt: old, days: TRIAL_DAYS }))
  startTrial(p.dir, new Date(), p.home)                   // writes a fresh project marker
  assert.equal(effectiveStart(p.dir, p.home).toISOString(), old, 'the older start wins')
  assert.equal(daysRemaining(p.dir, new Date(), p.home), 1)
})

test('it is disclosed from the first run, not sprung at the end', () => {
  const p = project()
  const r = init(p)
  assert.match(r.out, /Beta window: \d+ days? left/, 'the countdown prints immediately')
  assert.match(r.out, /records stay yours/, 'and says the data is not held hostage')
})

test('the countdown prints on EVERY command, which is what the docs promise', () => {
  // "It prints a countdown from day one" is a claim in START_HERE.md. A notice
  // shown only at `init` would make that claim false four weeks later, which is
  // exactly when a team needs it.
  const p = project()
  init(p)
  age(p, 20)
  for (const cmd of [['states'], ['graph'], ['status'], ['tests']]) {
    const r = run(p, cmd)
    assert.match(r.stderr, /Beta window: 10 days? left/, `${cmd[0]} must show the countdown`)
  }
})

test('--json is machine mode: the countdown appears on NEITHER stream', () => {
  // Machine-readable output is a documented interface. A human-facing notice
  // leaking into it breaks any team that scripts against Nexum — including the
  // obvious `2>&1 | jq`, which is how three of our own suites read the CLI.
  const p = project()
  init(p)
  run(p, ['state', '--config', 'c.xml', '--code', 'code'])   // so status has an answer to give
  for (const cmd of [['states', '--json'], ['graph', '--json'], ['status', '--json']]) {
    const r = run(p, cmd)
    assert.doesNotThrow(() => JSON.parse(r.stdout.replace(/^[^[{]*/, '')), `${cmd[0]} --json stdout must parse`)
    assert.ok(!/Beta window/.test(r.out), `${cmd[0]} --json must stay free of human chrome`)
    // ...and the same command without --json still shows it.
    assert.match(run(p, cmd.filter(a => a !== '--json')).out, /Beta window/,
      `${cmd[0]} must still warn a human`)
  }
})

test('the last week warns harder and names who to contact', () => {
  const p = project()
  init(p)
  age(p, TRIAL_DAYS - 3)
  const notice = trialNotice(p.dir, new Date(), p.home)
  assert.match(notice, /3 day/)
  assert.match(notice, /ashrith\.kora@gmail\.com/, 'a deadline with no way out is a trap')
})

test('every working command stops at the window, as specified', () => {
  const p = project()
  init(p)
  run(p, ['state', '--config', 'c.xml', '--code', 'code'])
  age(p, TRIAL_DAYS + 1)
  for (const cmd of [['status'], ['state', '--config', 'c.xml', '--code', 'code'],
                     ['result', '--test', 'localization', '--pass', '--by', 'T'],
                     ['graph', '--json'], ['states'], ['predict', '--checks', 'x', '--by', 'T'],
                     ['change', '--component', 'camera-position', '--note', 'n', '--by', 'T'],
                     ['check', '--config', 'c.xml', '--code', 'code']]) {
    const r = run(p, cmd)
    assert.notEqual(r.code, 0, `${cmd[0]} must refuse past the window`)
    assert.match(r.out, /beta window closed/i, `${cmd[0]} must say why`)
  }
})

test('demo keeps working — it is how a team learns whether Nexum runs at all', () => {
  const p = project()
  init(p)
  age(p, TRIAL_DAYS + 30)
  assert.equal(run(p, ['demo']).code, 0, 'demo reads a bundled sample and writes nothing')
})

test('the expiry message tells a team their records are intact and where they are', () => {
  const p = project()
  init(p)
  run(p, ['state', '--config', 'c.xml', '--code', 'code'])
  age(p, TRIAL_DAYS + 1)
  const r = run(p, ['status'])
  assert.match(r.out, /untouched and still yours/)
  assert.match(r.out, /plain JSON in \.physync/, 'and names where to read them')
  assert.match(r.out, /ashrith\.kora@gmail\.com/, 'and one way forward')
  // The files really are still there and really are readable.
  const v1 = join(p.dir, '.physync/states/V1.json')
  assert.ok(existsSync(v1))
  assert.equal(JSON.parse(readFileSync(v1, 'utf8')).version, 1,
    'an expired window must never make a team\'s own history unreadable')
  const ledger = join(p.dir, '.physync/results/ledger.jsonl')
  if (existsSync(ledger)) {
    for (const line of readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean)) {
      assert.doesNotThrow(() => JSON.parse(line), 'every result line stays parseable')
    }
  }
})

test('a corrupted trial marker does not brick the project', () => {
  // Punishing a team because our own bookkeeping file got damaged would be the
  // worst possible reason to stop their season.
  const p = project()
  init(p)
  writeFileSync(join(p.dir, '.physync/trial.json'), '{ truncated')
  writeFileSync(join(p.home, '.nexum/trial.json'), '{ truncated')
  assert.equal(readTrial(p.dir), null)
  assert.equal(readHomeTrial(p.home), null)
  assert.doesNotThrow(() => assertTrialActive(p.dir, new Date(), p.home))
  assert.equal(run(p, ['states']).code, 0, 'the project keeps working')
})

test('a marker with a nonsense date is treated as absent, not as expired', () => {
  const p = project()
  init(p)
  for (const f of [join(p.dir, '.physync/trial.json'), join(p.home, '.nexum/trial.json')]) {
    writeFileSync(f, JSON.stringify({ format: 'physync-trial-v1', startedAt: 'yesterday-ish', days: 30 }))
  }
  assert.equal(daysRemaining(p.dir, new Date(), p.home), null)
  assert.doesNotThrow(() => assertTrialActive(p.dir, new Date(), p.home))
  assert.equal(run(p, ['states']).code, 0)
})

test('the docs disclose the window AND the one file written outside the project', () => {
  for (const doc of ['START_HERE.md', 'README.md']) {
    const text = readFileSync(join(APP, '..', doc), 'utf8')
    assert.match(text, /30 days|30-day/, `${doc} must state the window`)
    assert.match(text, /\.nexum/, `${doc} must disclose the home-directory marker`)
  }
})
