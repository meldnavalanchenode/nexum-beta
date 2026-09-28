// Fuzz core — the per-seed property, shared by every fuzz shard file so a
// million seeds stays ONE implementation. Each seed builds a structurally
// distinct approval and asserts: determinism, hub-order freedom, round-trip
// validation, and one seed-chosen mutation being visible to the digest AND
// fatal to validation. See fuzz-approval.test.js for the full description.

import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalStateText, stateDigestOf, manifestDigestOf, validateApproval } from '../../src/approval.js'
import { mulberry32, genApproval, shuffle, int, pick } from './gen.js'

const MUTATIONS = [
  {
    kind: 'config-name-char',
    apply: (m, rnd) => {
      const i = int(rnd, 0, m.configName.length - 1)
      const c = m.configName[i] === 'x' ? 'y' : 'x'
      m.configName = m.configName.slice(0, i) + c + m.configName.slice(i + 1)
    },
  },
  {
    kind: 'config-sha-nibble',
    apply: (m, rnd) => {
      const i = int(rnd, 0, 63)
      const c = m.configSha256[i] === '0' ? '1' : '0'
      m.configSha256 = m.configSha256.slice(0, i) + c + m.configSha256.slice(i + 1)
    },
  },
  {
    kind: 'hub-address-shift',
    guard: (m) => m.hubs.length > 0,
    apply: (m, rnd) => {
      const h = pick(rnd, m.hubs)
      let next = h.address === 255 ? 1 : h.address + 1
      while (m.hubs.some((o) => o.address === next)) next = next === 255 ? 1 : next + 1
      h.address = next
    },
  },
  {
    kind: 'firmware-char',
    guard: (m) => m.hubs.length > 0,
    apply: (m, rnd) => {
      const h = pick(rnd, m.hubs)
      h.firmware = h.firmware.length ? (h.firmware[0] === 'Z' ? 'Q' : 'Z') + h.firmware.slice(1) : 'Z'
    },
  },
  {
    kind: 'hub-vanishes',
    guard: (m) => m.hubs.length > 0,
    apply: (m, rnd) => { m.hubs.splice(int(rnd, 0, m.hubs.length - 1), 1) },
  },
  {
    kind: 'hub-appears',
    guard: (m) => m.hubs.length < 254,
    apply: (m, rnd) => {
      let address = int(rnd, 1, 255)
      while (m.hubs.some((h) => h.address === address)) address = (address % 255) + 1
      m.hubs.push({ address, firmware: '1.8.2' })
    },
  },
  {
    kind: 'firmware-swap-between-hubs',
    guard: (m) => m.hubs.length >= 2 && m.hubs[0].firmware !== m.hubs[1].firmware,
    apply: (m) => { const t = m.hubs[0].firmware; m.hubs[0].firmware = m.hubs[1].firmware; m.hubs[1].firmware = t },
  },
]

export function runFuzzShard(from, to) {
  for (let seed = from; seed <= to; seed++) {
    test(`fuzz-approval seed ${seed}: deterministic, order-free, mutation-sensitive`, () => {
      const rnd = mulberry32(seed)
      const m = genApproval(rnd)
      assert.equal(canonicalStateText(m), canonicalStateText(m))
      assert.equal(stateDigestOf(m), m.stateDigest)
      assert.equal(manifestDigestOf(m), m.manifestDigest)
      const shuffled = { ...m, hubs: shuffle(rnd, m.hubs) }
      assert.equal(stateDigestOf(shuffled), m.stateDigest)
      validateApproval(JSON.parse(JSON.stringify(m)))
      const candidates = MUTATIONS.filter((x) => !x.guard || x.guard(m))
      const mutation = pick(rnd, candidates)
      const mutated = JSON.parse(JSON.stringify(m))
      mutation.apply(mutated, rnd)
      const before = m.stateDigest
      let after = null
      try { after = stateDigestOf(mutated) } catch { after = 'INVALID' }
      assert.notEqual(after, before, `mutation "${mutation.kind}" must change the state digest`)
      assert.throws(() => validateApproval(mutated), undefined, `mutation "${mutation.kind}" must break self-consistency`)
    })
  }
}
