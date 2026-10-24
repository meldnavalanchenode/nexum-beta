// FAIL-CLOSED — two product bugs the documentation fact-check surfaced.
//
// Both had the same shape: a guard that existed on one path and not another,
// or a filter that defaulted to "allow" when it should default to "refuse".
// Neither was caught by the existing suite because both suites tested the
// path that worked.
//
// 1. effectiveEdges used a DENYLIST (`status !== 'proposed'`), so any status
//    other than that one string activated the edge — including 'rejected'.
// 2. The HTTP /status endpoint had no shadow-mode ordering gate and called
//    markRevealed() unconditionally, so opening the web UI once in a beta
//    project destroyed the prediction window the CLI was protecting.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectiveEdges, unrecognizedEdges, EDGE_STATUSES } from '../src/graph.js'

const APP = fileURLToPath(new URL('..', import.meta.url))
const demo = JSON.parse(readFileSync(join(APP, 'fixtures/camera_reported_demo.json'), 'utf8'))
const run = (dir, a) => {
  const r = spawnSync(process.execPath, [join(APP, 'bin/physync.js'), ...a], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
function freshRobot() {
  const dir = mkdtempSync(join(tmpdir(), 'physync-fc-'))
  mkdirSync(join(dir, 'code'), { recursive: true })
  writeFileSync(join(dir, 'yourconfig.xml'), demo.configXml)
  for (const f of demo.files) writeFileSync(join(dir, 'code', f.name), f.content)
  return dir
}

// ── 1. edge status fails closed ────────────────────────────────────────────

const edge = (status) => ({ id: 'e1', from: 'a', to: 'b', status, source: 'user-approved', approvedBy: 'H' })

test('an edge with an unrecognized status is inert — it must not fail open', () => {
  const g = (status) => ({ builtin: [], custom: [edge(status)] })
  assert.equal(effectiveEdges(g('approved')).length, 1, 'approved edges decide things')
  assert.equal(effectiveEdges(g('proposed')).length, 0, 'proposed edges never did')

  // The regression: each of these used to ACTIVATE the edge, because the old
  // filter only excluded the exact string 'proposed'. 'rejected' activating a
  // rule is the precise inverse of what the word means.
  for (const bogus of ['propsed', 'rejected', 'draft', 'declined', 'APPROVED', '']) {
    assert.equal(effectiveEdges(g(bogus)).length, 0,
      `status ${JSON.stringify(bogus)} must NOT make an edge traversable`)
  }
})

test('a status-LESS edge stays active — mechanical rules need no approval', () => {
  // The over-correction this guards against: fixtures/graph.json ships seven
  // edges with deterministic-rule provenance and no status, because there is
  // no human judgment to approve. An allowlist on 'approved' would silently
  // disable all of them — a worse bug than the fail-open it fixed.
  const mech = { id: 'm1', from: 'a', to: 'b', source: 'deterministic-rule' }
  assert.equal(effectiveEdges({ builtin: [], custom: [mech] }).length, 1,
    'a validated mechanical rule with no status is active by design')

  const shipped = JSON.parse(readFileSync(join(APP, 'fixtures/graph.json'), 'utf8'))
  const edges = shipped.edges ?? shipped
  const statusless = edges.filter((e) => e.status == null)
  assert.ok(statusless.length >= 7, 'the shipped fixture still relies on this form')
  assert.equal(effectiveEdges({ builtin: [], custom: edges }).length, edges.length,
    'every shipped fixture edge remains traversable')
})

test('a status this version does not recognize is reported, not silently dropped', () => {
  // Failing closed is right, but failing closed and SAYING NOTHING would let a
  // typo disable a rule a team believes is protecting them.
  const g = { builtin: [], custom: [edge('approvd'), edge('approved'), edge('proposed')] }
  const unknown = unrecognizedEdges(g)
  assert.equal(unknown.length, 1, 'exactly the misspelled one is flagged')
  assert.equal(unknown[0].status, 'approvd')
  assert.equal(EDGE_STATUSES.APPROVED, 'approved')
})

test('the real approve command still produces a traversable edge', () => {
  // Guards the fix against over-correction: if the allowlist and the writer
  // disagree about the status string, approval silently stops working.
  const dir = freshRobot()
  run(dir, ['init', '--config', 'yourconfig.xml', '--code', 'code', '--by', 'F'])
  run(dir, ['graph', '--approve', 'camera-pose:01', '--by', 'F'])
  const graph = JSON.parse(readFileSync(join(dir, '.physync/graph.json'), 'utf8'))
  const approved = graph.edges.find((e) => e.id === 'camera-pose:01')
  assert.equal(approved.status, EDGE_STATUSES.APPROVED, 'the writer and the filter must agree')
  assert.equal(effectiveEdges({ builtin: [], custom: graph.edges }).length, 1)
})

// ── 2. the HTTP endpoint enforces the same ordering gate as the CLI ────────

test('the web UI refuses to reveal a plan before a prediction exists', async (t) => {
  const dir = freshRobot()
  run(dir, ['init', '--config', 'yourconfig.xml', '--code', 'code', '--by', 'F'])
  for (const id of ['camera-pose:01', 'camera-pose:02']) run(dir, ['graph', '--approve', id, '--by', 'F'])
  run(dir, ['result', '--test', 'localization', '--pass', '--by', 'F'])
  run(dir, ['state', '--config', 'yourconfig.xml', '--code', 'code'])
  run(dir, ['change', '--component', 'camera-position', '--note', 're-aimed', '--by', 'F'])
  assert.ok(existsSync(join(dir, '.physync/beta.json')), 'init opted this project into the experiment')

  // PHYSYNC_PORT=0 asks the OS for a free port. The previous `4700 + pid % 90`
  // shared a base with server-gate and server-record, so under
  // --test-concurrency these three races for the same number; the loser died
  // with EADDRINUSE and waited out its timeout. That is almost certainly what
  // failed on the macOS and Windows CI runners, where pid allocation differs
  // from a dev laptop — and it was intermittent, which is why ubuntu passed.
  let PORT = 0
  const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url))
  const proc = spawn(process.execPath, [SERVER], {
    cwd: dir, env: { ...process.env, PHYSYNC_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => proc.kill())
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 120000)
    proc.stdout.on('data', (b) => {
      const m = /127\.0\.0\.1:(\d+)/.exec(String(b))
      if (m) { PORT = Number(m[1]); clearTimeout(timer); resolve() }
    })
    proc.on('error', reject)
    proc.on('exit', (code) => reject(new Error(`server exited at startup (code ${code})`)))
  })

  const body = {
    configXml: demo.configXml,
    files: demo.files.map((f) => ({ name: f.name, content: f.content })),
  }
  const res = await fetch(`http://127.0.0.1:${PORT}/status`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const j = await res.json()

  assert.equal(j.predictionRequired, true, 'the web UI must withhold its answer, exactly as the CLI does')
  assert.equal(j.revalidation, undefined, 'no plan may leak through the HTTP surface')
  assert.ok(Array.isArray(j.changes) && j.changes.length, 'but WHAT CHANGED is still shown — it contaminates nothing')

  // The real damage was silent: the endpoint used to call markRevealed(), so
  // merely loading the page consumed the prediction window.
  assert.ok(!existsSync(join(dir, '.physync/experiments')),
    'and no experiment may be revealed as a side effect of opening the page')
})

test('CLI and web UI agree: neither reveals a plan unarmed, both show what changed', () => {
  // Cross-surface consistency WAS enforced by asserting the server source
  // carried the same conditions as the CLI. That only ever proved the two
  // copies looked alike — it could not stop them drifting, and they had
  // already drifted three ways (the gate, the applicability alias, the
  // baseline-FAIL accounting). Both surfaces now call one function, so the
  // invariant is structural: there is nothing left to disagree.
  const assess = readFileSync(join(APP, 'src/assess.js'), 'utf8')
  assert.match(assess, /beta\.json/, 'the shared pipeline gates on the opt-in marker')
  assert.match(assess, /openExperiment/, 'and checks whether a prediction is armed')
  assert.match(assess, /withheld: true/, 'and answers with one machine-readable fact')

  // The gate must still precede the reveal, or it protects nothing.
  const gateAt = assess.indexOf('withheld: true')
  const revealAt = assess.indexOf('markRevealed({')
  assert.ok(gateAt > -1 && revealAt > -1, 'both the gate and the reveal exist')
  assert.ok(gateAt < revealAt,
    'the ordering gate must precede markRevealed(), which is what burns the prediction window')

  // Neither surface may reimplement the orchestration it just delegated.
  for (const f of ['bin/physync.js', 'src/server.js']) {
    const src = readFileSync(join(APP, f), 'utf8')
    assert.match(src, /import \{[^}]*\bassess\b[^}]*\} from .*assess\.js/, `${f} must use the shared pipeline`)
    assert.match(src, /import \{[^}]*\bfoldResults\b[^}]*\} from .*assess\.js/, `${f} must use the shared fold rule`)
    assert.ok(!/markRevealed\(\{/.test(src),
      `${f} must not reveal an experiment itself — that decision belongs to assess()`)
    assert.ok(!/= plan\(\{/.test(src),
      `${f} must not build its own revalidation plan`)
    assert.ok(!/deploymentStatus\(\{/.test(src),
      `${f} must not grade its own status`)
  }
})

// ── test infrastructure must not race itself ──────────────────────────────

test('no suite binds a hardcoded port — the OS assigns them', () => {
  // Three suites derived their port from `pid % 90` off base 4700. Under
  // --test-concurrency they raced for the same number; the loser died with
  // EADDRINUSE and sat until its timeout. It passed on a dev laptop and failed
  // on CI runners, where pid allocation differs — the worst kind of bug,
  // because the suite looked green to the person who wrote it.
  const dir = join(APP, 'test')
  const SELF = 'failclosed.test.js'            // this file quotes the pattern it bans
  const offenders = []
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.test.js') && x !== SELF)) {
    const src = readFileSync(join(dir, f), 'utf8')
    if (!src.includes('PHYSYNC_PORT')) continue
    // The antipattern: a port computed from a numeric base, by any arithmetic.
    const pinned = [...src.matchAll(/(?:const|let)\s+PORT\s*=\s*(\d{3,})/g)].map((m) => m[1])
    for (const base of pinned) offenders.push(`${f}: PORT derived from literal ${base}`)
  }
  assert.deepEqual(offenders, [],
    `these suites pin a port and can collide under concurrency:\n  ${offenders.join('\n  ')}`)
})
