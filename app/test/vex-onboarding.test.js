// VEX ONBOARDING — the second platform gets the same guarantee as the first.
//
// The FTC P0 was: following the documented path produced "0 recheck(s) owed",
// because a new team had no checks defined and no rules approved, so there was
// nothing to reason about. `init` fixed it — for FTC only. A VEX team had no
// onboarding command at all (`init` rejected --declare), and even after
// approving every rule in the vex-v5 pack, every calibration was a terminal
// node: swapping a wheel demanded a new distance calibration and never
// questioned the autonomous run tuned against the old one.
//
// These tests assert the hand-declared path reaches the product's actual
// value, and that the pack propagates past its calibrations.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packEdges, RULE_PACKS } from '../src/packs.js'

const APP = fileURLToPath(new URL('..', import.meta.url))
const run = (dir, a) => {
  const r = spawnSync(process.execPath, [join(APP, 'bin/physync.js'), ...a], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
const INVENTORY = {
  format: 'physync-inventory-v1', declaredBy: 'Pranav', platform: 'vex-v5',
  devices: [
    { name: 'leftDrive', type: 'Motor', port: 1 },
    { name: 'rightDrive', type: 'Motor', port: 10 },
    { name: 'imu', type: 'Inertial', port: 21 },
  ],
}
function freshVex({ withInventory = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'physync-vex-'))
  if (withInventory) writeFileSync(join(dir, 'inventory.json'), JSON.stringify(INVENTORY, null, 2))
  return dir
}

test('init accepts a hand-declared robot — VEX is not a second-class path', () => {
  const dir = freshVex()
  const r = run(dir, ['init', '--declare', 'inventory.json', '--by', 'Pranav'])
  assert.equal(r.code, 0, r.out)
  assert.ok(existsSync(join(dir, '.physync/tests.json')), 'starter checks defined')
  assert.ok(existsSync(join(dir, '.physync/beta.json')), 'the shadow-mode marker is set, same as FTC')
  assert.match(r.out, /vex-v5/, 'the VEX pack is the default for a declared robot')
  assert.match(r.out, /ONE DECISION IS YOURS/, 'the human judgment is named, not hidden')
  // The printed next step must use the flag THIS team will type.
  assert.match(r.out, /state --declare inventory\.json/, 'next steps use --declare, not --config/--code')
  assert.ok(!/--config yourconfig/.test(r.out), 'and never tell a VEX team to pass an FTC config')
})

test('the starter checks are ones the VEX pack actually points at', () => {
  // If the starters and the pack target different ids, a team can approve
  // every rule and still get a plan that demands nothing — the original P0
  // wearing a different hat.
  const dir = freshVex()
  run(dir, ['init', '--declare', 'inventory.json', '--by', 'Pranav'])
  const ids = JSON.parse(readFileSync(join(dir, '.physync/tests.json'), 'utf8')).tests.map((t) => t.id)
  const targets = new Set(packEdges('vex-v5').map((e) => e.to))
  const reachable = ids.filter((id) => targets.has(`test:${id}`))
  assert.ok(reachable.length >= 2,
    `starters ${ids.join(', ')} must be reachable from the pack; only ${reachable.length} are`)
})

test('a missing inventory hands the team the shape instead of a dead end', () => {
  const dir = freshVex({ withInventory: false })
  const r = run(dir, ['init', '--declare', 'inventory.json', '--by', 'Pranav'])
  assert.notEqual(r.code, 0, 'it still fails — it must not invent a robot')
  assert.match(r.out, /physync-inventory-v1/, 'but it prints a usable starting file')
  assert.match(r.out, /declaredBy/, 'including the field that makes it a human declaration')
  assert.match(r.out, /run init again/, 'and says what to do next')
})

test('a malformed inventory is refused during SETUP, not at first use', () => {
  const dir = freshVex({ withInventory: false })
  writeFileSync(join(dir, 'inventory.json'), JSON.stringify({ devices: [] }))
  const r = run(dir, ['init', '--declare', 'inventory.json', '--by', 'Pranav'])
  assert.notEqual(r.code, 0, 'a declaration with no format tag is not usable')
  assert.match(r.out, /not usable/, 'and says so while someone is still paying attention')
})

test('every vex-v5 calibration feeds something downstream', () => {
  // The gap this closes: the pack targeted five calibrations and none of them
  // were ever a `from`, so a calibration was a terminal node and nothing that
  // consumed it was questioned.
  const edges = packEdges('vex-v5')
  const targeted = new Set(edges.filter((e) => e.to.startsWith('calibration:')).map((e) => e.to))
  const sources = new Set(edges.filter((e) => e.from.startsWith('calibration:')).map((e) => e.from))
  const terminal = [...targeted].filter((c) => !sources.has(c))
  assert.deepEqual(terminal, [],
    `these calibrations are demanded but feed nothing: ${terminal.join(', ')}`)
})

test('THE DOCUMENTED VEX PATH puts real evidence in question', () => {
  const dir = freshVex()
  run(dir, ['init', '--declare', 'inventory.json', '--by', 'Pranav'])
  // Approve the full chain a team would plausibly agree with: wheel size
  // drives the distance calibration, and the calibration drives the test.
  const graph = JSON.parse(readFileSync(join(dir, '.physync/graph.json'), 'utf8')).edges
  const want = graph.filter((e) =>
    (e.from === 'wheel-size' && e.to === 'calibration:drive-distance') ||
    (e.from === 'calibration:drive-distance' && e.to === 'test:drive-straight'))
  assert.equal(want.length, 2, 'the pack ships both halves of the chain')
  for (const e of want) run(dir, ['graph', '--approve', e.id, '--by', 'Pranav'])

  run(dir, ['result', '--test', 'drive-straight', '--pass', '--by', 'Pranav'])
  run(dir, ['state', '--declare', 'inventory.json'])
  run(dir, ['predict', '--checks', 'drive-straight', '--by', 'Pranav'])
  run(dir, ['change', '--component', 'wheel-size', '--note', 'swapped to 4in omnis', '--by', 'Pranav'])

  const j = JSON.parse(run(dir, ['status', '--declare', 'inventory.json', '--json', '--reveal']).stdout.replace(/^[^{]*/, ''))
  const actions = j.revalidation.required.map((r) => r.action)
  assert.ok(actions.includes('calibration:drive-distance'), `expected the calibration, got ${actions.join(', ')}`)
  assert.ok(actions.includes('test:drive-straight'), 'AND the test that consumed it — the propagation this fixes')
  const questioned = (j.revalidation.applicability ?? []).filter((a) => a.applicability === 'REVALIDATE')
  assert.ok(questioned.length >= 1, 'the recorded PASS is put in question, not left alone')
  assert.ok(j.revalidation.required.every((r) => r.reasonCodes.length && r.becauseHuman.length),
    'every demand carries a machine code AND a human sentence, same as FTC')
})

test('a declared baseline never claims to be reconciled', () => {
  // The labelling rule: an inventory is evidence that somebody wrote a list.
  const dir = freshVex()
  run(dir, ['init', '--declare', 'inventory.json', '--by', 'Pranav'])
  const out = run(dir, ['state', '--declare', 'inventory.json']).out
  assert.match(out, /DECLARED BY HAND/, 'the provenance is stated, loudly')
  assert.match(out, /nothing was reconciled/i, 'and it refuses to imply reconciliation it did not do')
  const v1 = JSON.parse(readFileSync(join(dir, '.physync/states/V1.json'), 'utf8'))
  assert.equal(v1.declared.source, 'hand', 'the state records the declaration as hand-sourced')
})

test('both packs are structurally comparable — VEX is not a stub', () => {
  for (const name of ['vex-v5', 'camera-pose']) {
    assert.ok(RULE_PACKS[name], `${name} exists`)
    const edges = packEdges(name)
    assert.ok(edges.length >= 3, `${name} has real content`)
    assert.ok(edges.every((e) => e.note && e.note.length > 20),
      `${name}: every edge explains WHY, because a team is being asked to rule on it`)
  }
})
