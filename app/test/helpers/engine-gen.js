// Generators + invariant battery for the Phase 2-6 engine (states, change
// detection, dependency graph, invalidation planner, results). This surface
// had ~130 hand-written tests and no generative campaign; the 10M run fuzzes
// it against the invariants that must hold for EVERY input, because a
// verification tool whose own invalidation logic is wrong is worse than none.

import assert from 'node:assert/strict'
import { mulberry32, int, pick } from './gen.js'
import { buildVerifiedState, validateState, detectChanges } from '../../src/state.js'
import { BUILTIN_EDGES, validateEdge, effectiveEdges, traverse } from '../../src/graph.js'
import { plan, componentsOf } from '../../src/planner.js'
import { resultVerdict, detectRegressions } from '../../src/results.js'
import { ENGINE_VERSION } from '../../src/registry.js'

export { mulberry32 }

const DEVICE_TYPES = ['Motor', 'goBILDA5202SeriesMotor', 'Servo', 'ContinuousRotationServo', 'RevColorSensorV3', 'RevTouchSensor', 'HuskyLens', 'Rev2mDistanceSensor']
const READS = ['ok', 'zeros', 'error']
const MOTOR_RESULTS = ['moved-positive', 'moved-negative', 'no-response', 'interrupted']

function genConfigXml(rnd, devices) {
  const body = devices.map((d) => `<${d.type} name="${d.name}" port="${d.port}"${d.bus != null ? ` bus="${d.bus}"` : ''} />`).join('')
  return `<Robot type="FirstInspires-FTC"><LynxUsbDevice name="P" serialNumber="X${int(rnd, 1, 999)}" parentModuleAddress="173"><LynxModule name="Control Hub" port="173">${body}</LynxModule></LynxUsbDevice></Robot>`
}

function genDevices(rnd) {
  const n = int(rnd, 1, 6)
  const out = []
  for (let i = 0; i < n; i++) {
    const type = pick(rnd, DEVICE_TYPES)
    out.push({ name: `dev${i}`, type, port: int(rnd, 0, 5), bus: /Color|Distance|Husky/.test(type) ? int(rnd, 0, 3) : null })
  }
  return out
}

function genRobotReport(rnd, devices) {
  const hubCount = int(rnd, 1, 3)
  const addrs = new Set([173])
  while (addrs.size < hubCount) addrs.add(int(rnd, 1, 255))
  const hubs = [...addrs].map((address) => ({ address, firmware: `HW: 20, Maj: ${int(rnd, 1, 2)}, Min: ${int(rnd, 0, 9)}, Eng: ${int(rnd, 0, 9)}` }))
  const sensors = devices.filter((d) => /Color|Distance|Husky|Touch/.test(d.type)).map((d) => {
    const isI2c = /Color|Distance|Husky/.test(d.type)
    const read = isI2c ? pick(rnd, READS) : 'ok'
    return { name: d.name, type: d.type, class: isI2c ? 'i2c' : 'digital', read, value: 'v', determinable: isI2c, livenessDeterminable: isI2c }
  })
  return { hubs, sensors }
}

function genStimulus(rnd, devices) {
  const motors = devices.filter((d) => /Motor/.test(d.type)).map((d) => ({ name: d.name, result: pick(rnd, MOTOR_RESULTS), deltaTicks: int(rnd, -200, 200) }))
  const servos = devices.filter((d) => /Servo/.test(d.type)).map((d) => ({ name: d.name, confirmed: int(rnd, 0, 1) === 1 }))
  return { motors, servos }
}

/** A random verified state that is itself valid (checkVerdict never FAIL). */
export function genState(rnd, over = {}) {
  const devices = over.devices ?? genDevices(rnd)
  const cfg = genConfigXml(rnd, devices)
  const withRobot = int(rnd, 0, 3) > 0
  const withStim = int(rnd, 0, 2) > 0
  return {
    state: buildVerifiedState({
      version: 1, configName: 'robot', configXml: cfg,
      devices: devices.map((d) => ({ name: d.name, type: d.type, port: d.port, bus: d.bus })),
      checkVerdict: 'PASS', robot: withRobot ? genRobotReport(rnd, devices) : undefined,
      stimulus: withStim ? genStimulus(rnd, devices) : undefined,
      engineVersion: ENGINE_VERSION, now: `2026-09-${String(int(rnd, 1, 28)).padStart(2, '0')}T12:00:00.000Z`,
    }),
    devices, cfg,
  }
}

/** A random candidate = a perturbation of the state's declared/observed layer. */
export function genCandidate(rnd, state, devices, cfg) {
  const cand = { configName: 'robot', configXml: cfg, devices: devices.map((d) => ({ ...d })) }
  // apply 0..3 mutations
  const nMut = int(rnd, 0, 3)
  for (let i = 0; i < nMut; i++) {
    const kind = int(rnd, 0, 4)
    if (kind === 0 && cand.devices.length) { const d = pick(rnd, cand.devices); d.port = (d.port + 1) % 6 }        // port move
    else if (kind === 1 && cand.devices.length) { const d = pick(rnd, cand.devices); d.type = pick(rnd, DEVICE_TYPES) } // type change
    else if (kind === 2 && cand.devices.length > 1) { cand.devices.splice(int(rnd, 0, cand.devices.length - 1), 1) }   // removal
    else if (kind === 3) { cand.devices.push({ name: `new${i}`, type: pick(rnd, DEVICE_TYPES), port: int(rnd, 0, 5), bus: null }) } // add
    else { cand.configXml = cand.configXml + ' ' }                                                                     // byte change only
  }
  cand.configXml = genConfigXml(rnd, cand.devices) + (cand.configXml.endsWith(' ') ? ' ' : '')
  // optionally supply observed layers
  if (state.coverage.hubs && int(rnd, 0, 2) > 0) {
    cand.hubs = (state.observed.hubs ?? []).map((h) => int(rnd, 0, 3) === 0 ? { ...h, address: (h.address % 255) + 1 } : { ...h })
  }
  if (state.coverage.sensors && int(rnd, 0, 2) > 0) {
    cand.sensors = (state.observed.sensors ?? []).map((s) => ({ ...s }))
  }
  return cand
}

/** A random graph over the state's node universe, mixing provenances,
 *  including proposed (inert) edges and some illegal ones we won't add. */
export function genGraph(rnd, state) {
  const evIds = state.evidence.map((e) => e.id)
  const components = ['configuration', ...state.declared.devices.map((d) => `device:${d.name}`), ...(state.observed.hubs ?? []).map((h) => `hub:@${h.address}`)]
  const targets = [...evIds, `test:t${int(rnd, 0, 9)}`, `calibration:c${int(rnd, 0, 9)}`]
  const custom = []
  const n = int(rnd, 0, 6)
  for (let i = 0; i < n; i++) {
    const from = pick(rnd, [...components, ...targets]) // chains allowed
    const to = pick(rnd, targets)
    const roll = int(rnd, 0, 3)
    const edge = roll === 0
      ? { id: `p${i}`, from, to, status: 'proposed' }
      : roll === 1
        ? { id: `u${i}`, from, to, source: 'user-approved', approvedBy: 'fuzz' }
        : { id: `d${i}`, from, to, source: 'deterministic-rule' }
    try { custom.push(validateEdge(edge)) } catch { /* skip malformed combos */ }
  }
  return { builtin: BUILTIN_EDGES, custom }
}

const actionIds = (p) => p.required.map((r) => r.action)

/** The per-seed invariant battery. Every property here must hold for EVERY
 *  input; a single seed that breaks one is a real engine bug. */
export function runEngineInvariants(seed) {
  const rnd = mulberry32(seed)
  const { state, devices, cfg } = genState(rnd)

  // I1 — a freshly built state is self-consistent and re-validates.
  validateState(JSON.parse(JSON.stringify(state)))

  // I2 — UNKNOWN safety: no evidence item claims PASS for a condition that
  // cannot earn it. Undeterminable pins and unconfirmed servos are UNKNOWN.
  for (const e of state.evidence) {
    if (e.id.startsWith('sensor-liveness:')) {
      const s = (state.observed.sensors ?? []).find((x) => `sensor-liveness:${x.name}` === e.id)
      if (s && !s.determinable) assert.equal(e.result, 'UNKNOWN', 'an undeterminable pin must never be PASS')
    }
    if (e.id.startsWith('servo-response:')) {
      const s = (state.observed.stimulus?.servos ?? []).find((x) => `servo-response:${x.name}` === e.id)
      if (s && !s.confirmed) assert.equal(e.result, 'UNKNOWN', 'an unconfirmed servo must never be PASS')
    }
    if (e.id.startsWith('motor-response:')) {
      const m = (state.observed.stimulus?.motors ?? []).find((x) => `motor-response:${x.name}` === e.id)
      if (m && !m.result.startsWith('moved')) assert.equal(e.result, 'UNKNOWN', 'a non-moving motor must never be PASS')
    }
  }

  // I3 — single-field corruption always breaks the state digest.
  {
    const m = JSON.parse(JSON.stringify(state))
    m.declared.configSha256 = m.declared.configSha256 === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64)
    assert.throws(() => validateState(m), /integrity/)
  }

  const graph = genGraph(rnd, state)
  const cand = genCandidate(rnd, state, devices, cfg)
  const { changes, gaps } = detectChanges(state, cand)

  // I4 — restoration: comparing the state against a candidate that IS its own
  // declared+observed layer yields no changes.
  {
    const self = { configName: state.declared.configName, configXml: cfg, devices: state.declared.devices }
    if (state.coverage.hubs) self.hubs = state.observed.hubs
    if (state.coverage.sensors) self.sensors = state.observed.sensors
    const r = detectChanges(state, self)
    assert.deepEqual(r.changes, [], 'a state must not drift from its own recorded layers')
  }

  const p = plan({ state, changes, graph, satisfiedActions: new Set() })

  // I5 — determinism: same inputs → identical plan.
  const p2 = plan({ state, changes, graph, satisfiedActions: new Set() })
  assert.deepEqual(p2.invalidated, p.invalidated)
  assert.deepEqual(actionIds(p2), actionIds(p))

  // I6 — dedup: no action id appears twice in the minimum plan.
  const acts = actionIds(p)
  assert.equal(new Set(acts).size, acts.length, 'the minimum plan must be deduplicated')

  // I7 — soundness: every invalidated id is a real evidence id of the state.
  const evSet = new Set(state.evidence.map((e) => e.id))
  for (const inv of p.invalidated) assert.ok(evSet.has(inv.evidenceId), 'invalidation must name real evidence')

  // I8 — proposed inertness: dropping proposed edges cannot change the plan.
  const active = { builtin: graph.builtin, custom: graph.custom.filter((e) => e.status !== 'proposed') }
  const pActive = plan({ state, changes, graph: active, satisfiedActions: new Set() })
  assert.deepEqual(pActive.invalidated.map((i) => i.evidenceId).sort(), p.invalidated.map((i) => i.evidenceId).sort(), 'proposed edges must be inert')

  // I9 — monotonicity: adding one more change never REMOVES an invalidation.
  if (changes.length) {
    const extra = [...changes, { id: 'x-extra', kind: 'firmware-changed', component: 'hub @173' }]
    const pMore = plan({ state, changes: extra, graph, satisfiedActions: new Set() })
    const before = new Set(p.invalidated.map((i) => i.evidenceId))
    const after = new Set(pMore.invalidated.map((i) => i.evidenceId))
    for (const id of before) assert.ok(after.has(id), 'more changes must never un-invalidate evidence')
  }

  // I10 — satisfied set removes exactly its actions from `required`.
  if (acts.length) {
    const one = acts[0]
    const pSat = plan({ state, changes, graph, satisfiedActions: new Set([one]) })
    assert.ok(!actionIds(pSat).includes(one), 'a satisfied action must leave the required list')
  }

  // I11 — regression direction is threshold-driven and never invented.
  {
    const th = { min: 0.9 }
    const results = [
      { physyncResult: 1, testId: 't', kind: 'robustness', value: 0.9, threshold: th, verdict: resultVerdict({ value: 0.9, threshold: th }), evidence: [], recordedBy: 'f', notes: null, againstState: null, recordedAt: '2026-09-10T00:00:00.000Z' },
      { physyncResult: 1, testId: 't', kind: 'robustness', value: 0.9 - int(rnd, 1, 40) / 100, threshold: th, verdict: 'FAIL', evidence: [], recordedBy: 'f', notes: null, againstState: null, recordedAt: '2026-09-11T00:00:00.000Z' },
    ]
    const regs = detectRegressions(results)
    assert.equal(regs.length, 1, 'a drop below a min-threshold is a regression')
    const noThresh = results.map((r) => ({ ...r, threshold: null }))
    assert.equal(detectRegressions(noThresh).length, 0, 'no threshold → no invented direction')
  }
}

/** A second family: pure graph-traversal invariants over random DAGs+cycles,
 *  cheaper per seed so it drives high volume. */
export function runTraversalInvariants(seed) {
  const rnd = mulberry32(seed * 2654435761 % 4294967296)
  const nodes = Array.from({ length: int(rnd, 2, 12) }, (_, i) => `n${i}`)
  const custom = []
  const m = int(rnd, 0, 20)
  for (let i = 0; i < m; i++) {
    const from = pick(rnd, nodes), to = pick(rnd, nodes)
    const proposed = int(rnd, 0, 4) === 0
    custom.push(validateEdge(proposed ? { id: `e${i}`, from, to, status: 'proposed' } : { id: `e${i}`, from, to, source: 'deterministic-rule' }))
  }
  const graph = { builtin: [], custom }
  const start = [{ componentId: pick(rnd, nodes), changeId: 'c1' }]
  const universe = new Set(nodes)

  // T1 — termination + determinism (no throw, stable output).
  const r1 = traverse(graph, start, universe)
  const r2 = traverse(graph, start, universe)
  assert.deepEqual([...r1.keys()].sort(), [...r2.keys()].sort())

  // T2 — proposed edges never contribute a reached node the active graph lacks.
  const active = { builtin: [], custom: custom.filter((e) => e.status !== 'proposed') }
  const rA = traverse(active, start, universe)
  for (const k of rA.keys()) assert.ok(r1.has(k))
  // every extra node in r1 vs rA must be reachable ONLY via... no: proposed are
  // excluded from effectiveEdges, so r1 and rA are identical.
  assert.deepEqual([...r1.keys()].sort(), [...rA.keys()].sort(), 'proposed edges add no reachability')

  // T3 — reachability is monotone: adding a start seed never removes reached.
  const start2 = [...start, { componentId: pick(rnd, nodes), changeId: 'c2' }]
  const r3 = traverse(graph, start2, universe)
  for (const k of r1.keys()) assert.ok(r3.has(k), 'more starts never un-reach a node')
}
