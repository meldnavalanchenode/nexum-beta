// THE WINDOW APPLIES TO THE WEB UI TOO.
//
// The CLI gate alone was a hole. `app/package.json` exposes `npm run ui`, the
// server writes verified states, results and graph edges into the same
// .physync/ the CLI uses, and it shipped inside the beta artifact — so a team
// who found it could have kept working past a stop we described as absolute.
// "Hard stop, all commands" has to mean the product, not one entry point.
//
// Two layers, because they fail differently:
//   startup   — refuse to listen at all, so a team gets one clear message
//   per request — a server left running overnight must not cross the boundary
//                 and keep serving

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRIAL_DAYS } from '../src/trial.js'

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url))

/** A project directory whose beta clock started `daysAgo` days ago. */
function projectAged(daysAgo) {
  const root = mkdtempSync(join(tmpdir(), 'physync-ui-trial-'))
  const dir = join(root, 'robot')
  const home = join(root, 'home')
  mkdirSync(join(dir, '.physync'), { recursive: true })
  mkdirSync(join(home, '.nexum'), { recursive: true })
  writeMarkers({ dir, home }, daysAgo)
  return { dir, home, root }
}
function writeMarkers(p, daysAgo) {
  const rec = JSON.stringify({
    format: 'physync-trial-v1',
    startedAt: new Date(Date.now() - daysAgo * 86400_000).toISOString(),
    days: TRIAL_DAYS,
  }, null, 2)
  writeFileSync(join(p.dir, '.physync/trial.json'), rec)
  writeFileSync(join(p.home, '.nexum/trial.json'), rec)
}

function boot(p) {
  const proc = spawn(process.execPath, [SERVER], {
    cwd: p.dir,
    env: { ...process.env, PHYSYNC_PORT: '0', HOME: p.home, USERPROFILE: p.home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  proc.stdout.on('data', d => { out += d })
  proc.stderr.on('data', d => { out += d })
  return {
    proc,
    /** Resolves to the bound port, or rejects if the process exits first. */
    port: new Promise((resolve, reject) => {
      proc.stdout.on('data', d => { const m = /127\.0\.0\.1:(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])) })
      proc.on('exit', code => reject(Object.assign(new Error(`exited ${code}`), { code, out })))
      // 120s, not 30: this guards against a HANG, it does not assert startup
    // speed. Under --test-concurrency=4 with millions of generated tests
    // saturating every core, node's own boot has exceeded 30s — and because
    // this runs in a `before` hook, one slow boot failed all 9 tests in this
    // file, none of which are about timing.
    setTimeout(() => reject(new Error('startup timeout')), 120000)
    }),
    text: () => out,
  }
}

test('past the window the UI server REFUSES TO START, and says why', async () => {
  const p = projectAged(TRIAL_DAYS + 2)
  const s = boot(p)
  const err = await s.port.then(
    port => { s.proc.kill(); throw new Error(`server listened on ${port} past the window`) },
    e => e,
  )
  assert.equal(err.code, 1, 'it exits non-zero rather than serving')
  assert.match(err.out, /beta window closed/i, 'and names what happened')
  assert.match(err.out, /ashrith\.kora@gmail\.com/, 'and gives one way forward')
  assert.match(err.out, /untouched and still yours/, 'and confirms their records are intact')
})

test('a server already running when the window closes stops serving', async () => {
  // The overnight case. The startup check cannot cover it, so every request
  // re-reads the clock.
  const p = projectAged(1)
  const s = boot(p)
  const port = await s.port
  try {
    const before = await fetch(`http://127.0.0.1:${port}/overview`)
    assert.equal(before.status, 200, 'in-window requests work')

    writeMarkers(p, TRIAL_DAYS + 1)                    // the window closes under it

    const after = await fetch(`http://127.0.0.1:${port}/overview`)
    assert.equal(after.status, 403)
    const body = await after.json()
    assert.match(body.error, /beta window closed/i)
    assert.match(body.error, /untouched and still yours/)

    // Writes are refused too — this is the half that would have mattered.
    const write = await fetch(`http://127.0.0.1:${port}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ test: 'localization', verdict: 'PASS', by: 'T' }),
    })
    assert.equal(write.status, 403, 'no recording past the window')

    // The page itself still loads, so the refusal can be read in the browser.
    const page = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(page.status, 200, 'the UI must render to explain the stop')

    // `/sample` is exempt for the same reason `demo` is: bundled data, no writes.
    const sample = await fetch(`http://127.0.0.1:${port}/sample`)
    assert.equal(sample.status, 200)
  } finally {
    s.proc.kill()
  }
})

test('inside the window the UI prints the countdown and serves normally', async () => {
  const p = projectAged(TRIAL_DAYS - 5)
  const s = boot(p)
  const port = await s.port
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/overview`)).status, 200)
    assert.match(s.text(), /Beta window: 5 day\(s\) left/, 'the countdown reaches whoever started it')
  } finally {
    s.proc.kill()
  }
})
