// Differential shard b — firmware oracle seeds 50,001..100,000 and the full
// 50,000-state canonicalization sweep. The oracle lives in helpers/oracle.js;
// see differential-approval.test.js for the property description.

import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalStateText, stateDigestOf, normalizeFirmware } from '../src/approval.js'
import { mulberry32, genApproval, genFirmware } from './helpers/gen.js'
import { refNormalizeFirmware, refCanonicalState, refDigest } from './helpers/oracle.js'

for (let seed = 50001; seed <= 100000; seed++) {
  test(`differential firmware ${seed}: regex parser and indexOf oracle agree`, () => {
    const rnd = mulberry32(seed * 13)
    for (let i = 0; i < 4; i++) {
      const fw = genFirmware(rnd)
      assert.equal(normalizeFirmware(fw), refNormalizeFirmware(fw), `divergence on ${JSON.stringify(fw)}`)
    }
  })
}

for (let seed = 1; seed <= 50000; seed++) {
  test(`differential state ${seed}: both implementations render and digest identically`, () => {
    const rnd = mulberry32(seed * 17)
    const m = genApproval(rnd)
    const reference = refCanonicalState(m.configName, m.configSha256, m.hubs)
    assert.equal(canonicalStateText(m), reference)
    assert.equal(m.stateDigest, refDigest(reference))
  })
}
