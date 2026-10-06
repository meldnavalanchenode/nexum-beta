// The three recording endpoints — /change, /rule/approve, /result — the same
// actions the CLI offers, through a real socket, persisting to the same
// project-directory .physync/ the CLI reads. Locked here: provenance rules
// survive the transport (a change needs a name, an approval needs a name, a
// proposed edge stays inert, simulated results satisfy nothing), and the UI
// can drive the entire human-reported arc without a terminal.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = 4700 + (process.pid % 90)
const BASE = `http://127.0.0.1:${PORT}`
const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url))
const APP = fileURLToPath(new URL('..', import.meta.url))
const DIR = mkdtempSync(join(tmpdir(), 'physync-srvrec-'))

const demo = JSON.parse(readFileSync(join(APP, 'fixtures/camera_reported_demo.json'), 'utf8'))
const FILES = demo.files

let proc
test.before(async () => {
  mkdirSync(join(DIR, '.physync'), { recursive: true })
  writeFileSync(join(DIR, '.physync/tests.json'), JSON.stringify({ tests: demo.tests }, null, 2))
  proc = spawn(process.execPath, [SERVER], { cwd: DIR, env: { ...process.env, PHYSYNC_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('PHYSYNC ui')) resolve() })
    proc.on('exit', () => reject(new Error('server died at startup')))
    setTimeout(() => reject(new Error('server startup timeout')), 8000)
  })
})
test.after(() => { proc?.kill() })

const call = async (path, body, method = 'POST') => {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, data: await res.json() }
}
const status = () => call('/status', { configXml: demo.configXml, files: FILES })

test('an anonymous change is refused — a self-reported change is somebody\'s word', async () => {
  const { status: s, data } = await call('/change', { component: 'camera-position', note: 'no name attached' })
  assert.equal(s, 400)
  assert.match(data.error, /somebody's word/)
})

test('a named change records as HUMAN-REPORTED and says whether anything approved leads out', async () => {
  // baseline first, so the report has a state to be measured against
  const saved = await call('/state', { configXml: demo.configXml, files: FILES })
  assert.equal(saved.status, 200)
  const { status: s, data } = await call('/change', { component: 'camera-position', note: 'Camera mount was re-aimed', by: 'Demo Reporter' })
  assert.equal(s, 200)
  assert.equal(data.label, 'HUMAN-REPORTED CHANGE')
  assert.equal(data.recorded.by, 'Demo Reporter')
  assert.equal(data.approvedEdgesOut, 0)
  assert.match(data.note, /NO DEPENDENCY MAPPING/)
  const onDisk = JSON.parse(readFileSync(join(DIR, '.physync/reported.json'), 'utf8'))
  assert.equal(onDisk.reports[0].component, 'camera-position')
  // and /status renders it as human, with zero requirements (no approved edges)
  const st = await status()
  const c = st.data.changes.find((x) => x.component === 'camera-position')
  assert.equal(c.source, 'human')
  assert.equal(st.data.revalidation.required.length, 0)
})

test('approving a proposed edge needs a name, an existing edge, and only works once', async () => {
  // seed two proposed edges the way the CLI's rules --pack would
  writeFileSync(join(DIR, '.physync/graph.json'), JSON.stringify({ edges: [
    { id: 'camera-pose:01', from: 'camera-position', to: 'calibration:camera-pose', status: 'proposed', pack: 'camera-pose', proposedAt: '2026-09-17T00:00:00Z' },
    { id: 'camera-pose:02', from: 'calibration:camera-pose', to: 'test:localization', status: 'proposed', pack: 'camera-pose', proposedAt: '2026-09-17T00:00:00Z' },
  ] }, null, 2))
  assert.equal((await call('/rule/approve', { id: 'camera-pose:01' })).status, 400)          // no name
  assert.equal((await call('/rule/approve', { id: 'nope:99', by: 'Demo Mentor' })).status, 404) // no edge
  // proposed edges are still inert: the earlier report demands nothing yet
  assert.equal((await status()).data.revalidation.required.length, 0)
  const ok = await call('/rule/approve', { id: 'camera-pose:01', by: 'Demo Mentor (simulated)' })
  assert.equal(ok.status, 200)
  assert.equal(ok.data.approved.approvedBy, 'Demo Mentor (simulated)')
  assert.equal((await call('/rule/approve', { id: 'camera-pose:01', by: 'Demo Mentor (simulated)' })).status, 409) // once
  await call('/rule/approve', { id: 'camera-pose:02', by: 'Demo Mentor (simulated)' })
  // NOW the chain is live: the standing report demands the calibration and the test
  const st = await status()
  assert.deepEqual(st.data.revalidation.required.map((r) => r.action).sort(), ['calibration:camera-pose', 'test:localization'])
})

test('recording a result: anonymous refused; simulated stored but satisfies nothing; real PASS satisfies', async () => {
  assert.equal((await call('/result', { testId: 'localization', value: '0.95' })).status, 400) // no name
  const sim = await call('/result', { testId: 'localization', value: '0.99', by: 'Demo Drill', simulated: true })
  assert.equal(sim.status, 200)
  assert.equal(sim.data.entry.simulated, true)
  assert.match(sim.data.note, /satisfies NOTHING/)
  let st = await status()
  const owedLoc = st.data.revalidation.required.find((r) => r.action === 'test:localization')
  assert.ok(owedLoc, 'localization still owed over a simulated PASS')
  assert.match(owedLoc.label, /SIMULATED/)
  // real, post-report results — threshold verdict computed server-side
  const real = await call('/result', { testId: 'localization', value: '0.96', by: 'Demo Operator', method: 'demo bench (simulated scenario)' })
  assert.equal(real.data.entry.verdict, 'PASS')
  assert.equal(real.data.entry.method, 'demo bench (simulated scenario)')
  const cal = await call('/result', { testId: 'camera-pose', verdict: 'PASS', by: 'Demo Operator' })
  assert.equal(cal.data.entry.verdict, 'PASS')
  st = await status()
  assert.equal(st.data.revalidation.required.length, 0, 'both requirements satisfied by real post-report results')
  assert.equal(st.data.revalidation.satisfiedThisRun.filter((r) => /PASS recorded/.test(r.label)).length, 2)
  // the simulated 0.99 must NOT manufacture a phantom regression against the
  // real 0.96 — drill data stays out of regression math, in /status and /overview
  assert.equal(st.data.regressions.length, 0, 'no regression from simulated vs real')
  const ov = await call('/overview', null, 'GET')
  assert.equal(ov.data.regressions.length, 0, 'overview agrees')
  assert.ok(ov.data.results.some((r) => r.simulated === true), 'the drill row is still listed — flagged, not hidden')
  // a value with no threshold and no explicit verdict is UNKNOWN, even via HTTP
  const unk = await call('/result', { testId: 'camera-pose', value: '3', by: 'Demo Operator' })
  assert.equal(unk.data.entry.verdict, 'UNKNOWN')
})

test('malformed result bodies are refused — no coerced or valueless verdicts reach the ledger', async () => {
  for (const bad of [true, [], '   ', '1e999', 'Infinity', {}]) {
    const { status: s } = await call('/result', { testId: 'localization', value: bad, by: 'x' })
    assert.equal(s, 400, `value ${JSON.stringify(bad)} must be refused`)
  }
  // an explicit verdict the module wouldn't accept is rejected, never
  // silently dropped — {verdict:"fail"} must not become a threshold PASS
  const typo = await call('/result', { testId: 'localization', value: 0.95, verdict: 'fail', by: 'x' })
  assert.equal(typo.status, 400)
  assert.match(typo.data.error, /illegal explicit verdict/)
})

test('/change counts exact-match approved edges — matchNode\'s empty-string match is a match', async () => {
  // camera-pose:01/02 were approved by name earlier in this file
  const { status: s, data } = await call('/change', { component: 'camera-position', note: 'bumped again', by: 'Demo Reporter' })
  assert.equal(s, 200)
  assert.equal(data.approvedEdgesOut, 1, 'the exact-from approved edge must be counted')
  assert.match(data.note, /approved edge\(s\) lead out/)
})

test('/status refuses a hand-declared baseline the way the CLI does', async () => {
  writeFileSync(join(DIR, 'inv.json'), JSON.stringify({
    format: 'physync-inventory-v1', platform: 'vex-v5', declaredBy: 'Demo Declarer',
    devices: [{ name: 'drive', type: 'motor', port: 1 }],
  }))
  const cli = spawnSync(process.execPath, [join(APP, 'bin/physync.js'), 'state', '--declare', 'inv.json'], { cwd: DIR, encoding: 'utf8' })
  assert.equal(cli.status, 0, `hand-declared state must save: ${cli.stdout}${cli.stderr}`)
  const { status: s, data } = await status()
  assert.equal(s, 409)
  assert.match(data.error, /declared by hand/)
})

test('a corrupt results ledger surfaces its authored message through /overview — never a silent stale panel', async () => {
  writeFileSync(join(DIR, '.physync/results/ledger.jsonl'), '{"physyncResult":1,"testId":"x","verdict":"PASS","evidence":[],"recordedBy":"a","recordedAt":"2026-01-01T00:00:00Z"}\nnot json at all\n')
  const { status: s, data } = await call('/overview', null, 'GET')
  assert.equal(s, 500)
  assert.match(data.error, /ledger line 2/)
})
