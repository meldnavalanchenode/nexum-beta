// Approval fuzz — 470,000 seeded, structurally distinct approvals across the
// shard files (this one runs seeds 1..100,000; fuzz-shard-{b..e}.test.js
// continue the range to 470,000). Per seed: determinism, hub-order freedom,
// round-trip validation, and one seed-chosen mutation that MUST be visible
// to the digest and fatal to validation — a mutation the digest cannot see
// would be drift the gate cannot see. The property lives once, in
// helpers/fuzz-core.js, so half a million seeds stays ONE implementation.

import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalStateText } from '../src/approval.js'
import { mulberry32, genApproval, int } from './helpers/gen.js'
import { runFuzzShard } from './helpers/fuzz-core.js'

runFuzzShard(1, 100000)

// Collision probe: two INDEPENDENT random states almost never collide. Not a
// cryptographic claim — a wiring check that the digest depends on the
// generated fields rather than a constant.
for (let seed = 1; seed <= 40000; seed++) {
  test(`fuzz-approval collision probe ${seed}: distinct states digest distinctly`, () => {
    const rnd = mulberry32(seed * 7919)
    const a = genApproval(rnd)
    const b = genApproval(rnd)
    if (canonicalStateText(a) !== canonicalStateText(b)) {
      assert.notEqual(a.stateDigest, b.stateDigest)
    } else {
      assert.equal(a.stateDigest, b.stateDigest)
    }
  })
}

// Firmware normalization equivalence classes, swept: every REV spelling of
// the same Maj/Min/Eng triple must land in one digest bucket per triple.
for (let seed = 1; seed <= 30000; seed++) {
  test(`fuzz-approval firmware-equivalence ${seed}: spelling is not state`, () => {
    const rnd = mulberry32(seed * 104729)
    const maj = int(rnd, 0, 9), min = int(rnd, 0, 20), eng = int(rnd, 0, 30)
    const spellings = [
      `HW: ${int(rnd, 1, 99)}, Maj: ${maj}, Min: ${min}, Eng: ${eng}`,
      `Maj: ${maj}, Min: ${min}, Eng: ${eng}`,
      `Maj:${maj},Min:${min},Eng:${eng}`,
      `Eng: ${eng}, Maj: ${maj}, Min: ${min}`, // order of keys must not matter either
    ]
    const rnd2 = mulberry32(seed)
    const template = genApproval(rnd2, { hubs: [{ address: 10, firmware: spellings[0] }] })
    for (const spelling of spellings.slice(1)) {
      const rnd3 = mulberry32(seed)
      const other = genApproval(rnd3, { hubs: [{ address: 10, firmware: spelling }] })
      assert.equal(other.stateDigest, template.stateDigest, `"${spelling}" must digest like "${spellings[0]}"`)
    }
    const rnd4 = mulberry32(seed)
    const different = genApproval(rnd4, { hubs: [{ address: 10, firmware: `Maj: ${maj}, Min: ${min}, Eng: ${eng + 1}` }] })
    assert.notEqual(different.stateDigest, template.stateDigest)
  })
}
