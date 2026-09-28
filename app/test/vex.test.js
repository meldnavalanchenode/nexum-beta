// The hand-declared (VEX) path — acceptance criteria.
//
// The thing under test is not "does VEX work". It is: does a robot PHYSYNC
// cannot read a configuration file from get the change→revalidation workflow
// WITHOUT also getting evidence nobody produced? Every test below is one way
// that could go wrong.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseInventory, toStateDevices, INVENTORY_FORMAT } from '../src/inventory.js'
import { buildVerifiedState, detectChanges } from '../src/state.js'
import { plan, actionFor } from '../src/planner.js'
import { loadGraph, BUILTIN_EDGES, effectiveEdges } from '../src/graph.js'
import { RULE_PACKS, packEdges } from '../src/packs.js'
import { asChange } from '../src/reported.js'

const inv = (over = {}) => JSON.stringify({
  format: INVENTORY_FORMAT,
  platform: 'vex-v5',
  declaredBy: 'tester',
  devices: [
    { name: 'LeftDrive', type: 'motor', port: 1 },
    { name: 'Inertial', type: 'inertial', port: 10 },
  ],
  ...over,
})

const stateFrom = (inventory, over = {}) => buildVerifiedState({
  version: 1,
  configName: 'inv',
  configXml: Buffer.from(JSON.stringify(inventory)),
  devices: toStateDevices(inventory),
  declaredBy: 'hand',
  declaredByHuman: inventory.declaredBy,
  engineVersion: 'test',
  now: '2026-01-01T00:00:00.000Z',
  ...over,
})

const reportChange = (component, id = 'rep-1') =>
  asChange({ id, component, note: '', by: 'tester', at: '2026-02-01T00:00:00.000Z' })

const graphWith = (custom = []) => ({ builtin: BUILTIN_EDGES, custom })
const approved = (id, from, to) => ({ id, from, to, source: 'user-approved', status: 'approved', approvedBy: 'mentor' })

// ── parsing: refuse what is ambiguous, warn about what is merely unfamiliar ──

test('an inventory without a named declarer is refused', () => {
  assert.throws(() => parseInventory(inv({ declaredBy: '' })), /declaredBy/)
})

test('two devices on one port is refused, and the message names both', () => {
  assert.throws(
    () => parseInventory(inv({ devices: [{ name: 'A', type: 'motor', port: 1 }, { name: 'B', type: 'motor', port: 1 }] })),
    /"B" and "A" are both declared on V5 smart port 1/,
  )
})

test('two devices with one name is refused', () => {
  assert.throws(
    () => parseInventory(inv({ devices: [{ name: 'A', type: 'motor', port: 1 }, { name: 'A', type: 'motor', port: 2 }] })),
    /both named "A"/,
  )
})

test('the same number on a different bus is NOT a collision', () => {
  const r = parseInventory(inv({ devices: [{ name: 'A', type: 'motor', port: 1 }, { name: 'B', type: 'bumper', port: 'A', bus: 'three-wire' }] }))
  assert.equal(r.devices.length, 2)
})

test('an out-of-range port WARNS rather than refusing — our port map may be the wrong one', () => {
  const r = parseInventory(inv({ devices: [{ name: 'A', type: 'motor', port: 99 }] }))
  assert.equal(r.devices.length, 1, 'the robot is still recorded')
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0], /1–21/)
})

test('an unfamiliar device type is accepted — PHYSYNC does not own the VEX catalogue', () => {
  const r = parseInventory(inv({ devices: [{ name: 'Gizmo', type: 'something-vex-shipped-last-week', port: 4 }] }))
  assert.equal(r.devices[0].type, 'something-vex-shipped-last-week')
  assert.equal(r.warnings.length, 0)
})

test('a file that does not declare the format is refused rather than guessed at', () => {
  assert.throws(() => parseInventory('{"devices":[]}'), /must declare "format"/)
})

// ── THE CENTRAL CLAIM: a declaration never becomes reconciliation ────────────

test('a hand-declared state produces NO config-code-reconciled evidence', () => {
  const state = stateFrom(parseInventory(inv()))
  const ids = state.evidence.map((e) => e.id)
  assert.ok(!ids.includes('config-code-reconciled'), 'nothing was reconciled, so no reconciliation evidence may exist')
  assert.ok(!ids.includes('config-parsed'), 'no configuration file was parsed either')
  assert.deepEqual(ids, ['inventory-declared'])
})

test('the one evidence item it does produce is labelled as a person\'s word', () => {
  const state = stateFrom(parseInventory(inv()))
  const e = state.evidence[0]
  assert.equal(e.source, 'human')
  assert.equal(e.method, 'declared-by-hand')
  assert.notEqual(e.source, 'observed')
  assert.match(e.summary, /not read off the robot/)
})

test('the missing reconciliation is recorded as a coverage gap, not left ambiguous', () => {
  assert.equal(stateFrom(parseInventory(inv())).coverage.reconciled, false)
})

test('an FTC state still declares reconciliation covered — the old path is unchanged', () => {
  const state = buildVerifiedState({
    version: 1, configName: 'c', configXml: Buffer.from('<Robot/>'),
    devices: [{ name: 'x', type: 'motor', port: '0', bus: null }],
    checkVerdict: 'PASS', checkFindingCounts: { WARN: 0, INFO: 0 }, engineVersion: 'test',
  })
  const ids = state.evidence.map((e) => e.id)
  assert.deepEqual(ids, ['config-parsed', 'config-code-reconciled'])
  assert.equal(state.coverage.reconciled, true)
  assert.equal(state.declared.source, 'xml-parse')
})

test('a hand-declared state cannot be built anonymously', () => {
  assert.throws(() => buildVerifiedState({
    version: 1, configName: 'c', configXml: Buffer.from('{}'), devices: [],
    declaredBy: 'hand', engineVersion: 'test',
  }), /must name the person/)
})

test('a hand-declared state still cannot be built over a FAILING check', () => {
  assert.throws(() => buildVerifiedState({
    version: 1, configName: 'c', configXml: Buffer.from('{}'), devices: [],
    declaredBy: 'hand', declaredByHuman: 'tester', checkVerdict: 'FAIL', engineVersion: 'test',
  }), /Refusing to build a verified state/)
})

// ── change detection over a declaration ─────────────────────────────────────

test('editing the declaration is detected as a device change', () => {
  const before = parseInventory(inv())
  const after = parseInventory(inv({ devices: [{ name: 'LeftDrive', type: 'motor', port: 5 }, { name: 'Inertial', type: 'inertial', port: 10 }] }))
  const state = stateFrom(before)
  const { changes } = detectChanges(state, {
    configName: 'inv', configXml: Buffer.from(JSON.stringify(after)), devices: toStateDevices(after),
  })
  assert.ok(changes.some((c) => c.kind === 'device-port-moved' && /LeftDrive/.test(c.component)),
    'a port moving in the declaration is a change')
})

test('a changed declaration invalidates the inventory a person vouched for', () => {
  const state = stateFrom(parseInventory(inv()))
  const out = plan({
    state,
    changes: [{ id: 'c1', kind: 'device-port-moved', component: 'device "LeftDrive"', previous: 'port 1', current: 'port 5', source: 'declared', method: 'config-device-map' }],
    graph: graphWith(),
  })
  assert.deepEqual(out.invalidated.map((i) => i.evidenceId), ['inventory-declared'])
})

test('re-deriving a hand-declared inventory is a HUMAN action, not a command PHYSYNC runs', () => {
  const a = actionFor('inventory-declared')
  assert.equal(a.action, 'declare')
  assert.match(a.label, /confirm the declared inventory against the physical robot/)
})

// ── the workflow the whole thing exists for ─────────────────────────────────

test('a reported physical change with no approved edge demands nothing and says so', () => {
  const out = plan({ state: stateFrom(parseInventory(inv())), changes: [reportChange('wheel-size')], graph: graphWith(packEdges('vex-v5')) })
  assert.equal(out.required.length, 0, 'a whole pack of PROPOSED edges must demand nothing')
  assert.equal(out.unmappedChanges.length, 1)
})

test('the same change, once a mentor approves the edge, selects the recheck', () => {
  const out = plan({
    state: stateFrom(parseInventory(inv())),
    changes: [reportChange('wheel-size')],
    graph: graphWith([approved('a1', 'wheel-size', 'calibration:drive-distance')]),
  })
  assert.deepEqual(out.required.map((r) => r.action), ['calibration:drive-distance'])
  assert.match(out.required[0].targets.join(' '), /UNKNOWN/, 'never run = UNKNOWN, never PASS')
})

// ── rule packs are proposals, and structurally cannot be anything else ──────

test('every edge in every pack loads PROPOSED', () => {
  for (const name of Object.keys(RULE_PACKS)) {
    for (const e of packEdges(name)) assert.equal(e.status, 'proposed', `${e.id} must be proposed`)
  }
})

test('a loaded pack contributes nothing to the effective graph', () => {
  assert.deepEqual(effectiveEdges(graphWith(packEdges('vex-v5'))), BUILTIN_EDGES)
})

test('every pack edge carries a reason a mentor can agree or disagree with', () => {
  for (const name of Object.keys(RULE_PACKS)) {
    for (const e of packEdges(name)) {
      assert.ok(e.note && e.note.length > 20, `${e.id} must explain itself`)
      assert.ok(e.id.startsWith(`${name}:`), 'pack edges are namespaced so a team can tell where they came from')
    }
  }
})

test('an unknown pack is refused by name', () => {
  assert.throws(() => packEdges('vex-v9'), /unknown rule pack/)
})

test('pack edge ids are unique', () => {
  const ids = Object.keys(RULE_PACKS).flatMap((n) => packEdges(n).map((e) => e.id))
  assert.equal(new Set(ids).size, ids.length)
})

// ── the built-in additions stay true-by-construction ────────────────────────

test('the new built-in edges only ever target the declaration itself', () => {
  const generic = BUILTIN_EDGES.filter((e) => e.id.startsWith('generic:'))
  assert.ok(generic.length > 0)
  for (const e of generic) {
    assert.equal(e.to, 'inventory-declared',
      'a built-in edge is traversed without approval, so it may only assert that a declaration contains its own contents — never an engineering dependency')
    assert.equal(e.source, 'deterministic-rule')
  }
})

test('no built-in edge asserts a calibration or test dependency', () => {
  for (const e of BUILTIN_EDGES) {
    assert.ok(!e.to.startsWith('calibration:') && !e.to.startsWith('test:'),
      `${e.id} targets ${e.to} — engineering dependencies require human approval and must not ship as built-ins`)
  }
})
