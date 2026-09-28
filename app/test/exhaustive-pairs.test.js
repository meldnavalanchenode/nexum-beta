// Exhaustive pair/grid enumeration — the second exhaustive suite (see
// exhaustive-boundary.test.js). These domains are small enough to WALK
// COMPLETELY, converting sampled claims into proven-for-every-case claims:
//
//   1. ALL 32,385 unordered hub-address pairs (a<b from 1..255): the 2-hub
//      digest differs from both singletons, is order-free, and each member's
//      removal is visible. After this suite, "hub pairs digest correctly" is
//      not a probabilistic statement — there are no unchecked pairs.
//   2. ALL 9,025 two-character printable-ASCII config names: character
//      transposition is always visible (aＢ ≠ Ｂa unless equal), truncation
//      is always visible.
//   3. The full 20×20×20 Maj/Min/Eng normalization grid — 8,000 cells, every
//      spelling convergent, every neighbor divergent.

import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalStateText, stateDigestOf, normalizeFirmware } from '../src/approval.js'

const SHA = 'a'.repeat(64)

// ── 1. Every unordered pair of hub addresses ───────────────────────────────
const singleton = new Map()
for (let a = 1; a <= 255; a++) {
  singleton.set(a, stateDigestOf({ configName: 'r', configSha256: SHA, hubs: [{ address: a, firmware: 'f' }] }))
}
for (let a = 1; a <= 255; a++) {
  for (let b = a + 1; b <= 255; b++) {
    test(`exhaustive pair @${a}+@${b}: distinct from both singletons, order-free, member-removal visible`, () => {
      const pair = stateDigestOf({ configName: 'r', configSha256: SHA, hubs: [{ address: a, firmware: 'f' }, { address: b, firmware: 'f' }] })
      const reversed = stateDigestOf({ configName: 'r', configSha256: SHA, hubs: [{ address: b, firmware: 'f' }, { address: a, firmware: 'f' }] })
      assert.equal(pair, reversed, 'order must never matter')
      assert.notEqual(pair, singleton.get(a), `dropping @${b} must be visible`)
      assert.notEqual(pair, singleton.get(b), `dropping @${a} must be visible`)
    })
  }
}

// ── 2. Every two-character printable-ASCII config name ─────────────────────
for (let c1 = 0x20; c1 <= 0x7e; c1++) {
  for (let c2 = 0x20; c2 <= 0x7e; c2++) {
    const name = String.fromCharCode(c1) + String.fromCharCode(c2)
    test(`exhaustive 2-char name ${JSON.stringify(name)}: transposition and truncation both visible`, () => {
      const digest = stateDigestOf({ configName: name, configSha256: SHA, hubs: [] })
      const swapped = stateDigestOf({ configName: name[1] + name[0], configSha256: SHA, hubs: [] })
      if (c1 === c2) assert.equal(digest, swapped)
      else assert.notEqual(digest, swapped, 'transposed characters are a different name')
      assert.notEqual(digest, stateDigestOf({ configName: name[0], configSha256: SHA, hubs: [] }), 'truncation is a different name')
    })
  }
}

// ── 3. The full Maj/Min/Eng grid, 0..19 on every axis ──────────────────────
for (let maj = 0; maj <= 19; maj++) {
  for (let min = 0; min <= 19; min++) {
    for (let eng = 0; eng <= 19; eng++) {
      test(`exhaustive grid ${maj}.${min}.${eng}: spellings converge, every axis-neighbor diverges`, () => {
        const expected = `${maj}.${min}.${eng}`
        assert.equal(normalizeFirmware(`HW: 20, Maj: ${maj}, Min: ${min}, Eng: ${eng}`), expected)
        assert.equal(normalizeFirmware(`Maj:${maj},Min:${min},Eng:${eng}`), expected)
        assert.notEqual(normalizeFirmware(`Maj: ${maj + 1}, Min: ${min}, Eng: ${eng}`), expected)
        assert.notEqual(normalizeFirmware(`Maj: ${maj}, Min: ${min + 1}, Eng: ${eng}`), expected)
        assert.notEqual(normalizeFirmware(`Maj: ${maj}, Min: ${min}, Eng: ${eng + 1}`), expected)
      })
    }
  }
}
