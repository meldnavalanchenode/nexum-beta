// Differential suite — approval.js vs an INDEPENDENT reference implementation
// (helpers/oracle.js), written on purpose in a different style. If the two
// ever disagree on any of 151,500 generated cases across this file and
// differential-shard-b.test.js, one of them has a canonicalization bug — and
// since PhysyncGate.java is a THIRD implementation of this format, every
// divergence caught here is a divergence the robot would have hit.

import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeFirmware, signManifest, verifyManifestHmac } from '../src/approval.js'
import { mulberry32, genApproval, genFirmware, int } from './helpers/gen.js'
import { refNormalizeFirmware, refSign } from './helpers/oracle.js'

// ── firmware normalization: seeds 1..50,000 through both parsers ───────────
for (let seed = 1; seed <= 50000; seed++) {
  test(`differential firmware ${seed}: regex parser and indexOf oracle agree`, () => {
    const rnd = mulberry32(seed * 13)
    for (let i = 0; i < 4; i++) {
      const fw = genFirmware(rnd)
      assert.equal(normalizeFirmware(fw), refNormalizeFirmware(fw), `divergence on ${JSON.stringify(fw)}`)
    }
  })
}

// ── HMAC round trips against the reference signer ──────────────────────────
for (let seed = 1; seed <= 1500; seed++) {
  test(`differential hmac ${seed}: sign/verify agrees with the reference and rejects tampering`, () => {
    const rnd = mulberry32(seed * 23)
    const key = Array.from({ length: 64 }, () => '0123456789abcdef'[int(rnd, 0, 15)]).join('')
    const m = genApproval(rnd, { key })
    assert.equal(m.hmac, refSign(m.manifestDigest, key), 'the signature must match an independent HMAC')
    assert.equal(verifyManifestHmac(m, key), true)
    const wrongKey = key.slice(0, 63) + (key[63] === '0' ? '1' : '0')
    assert.equal(verifyManifestHmac(m, wrongKey), false)
    assert.equal(signManifest(m.manifestDigest, key), m.hmac, 'signing is deterministic')
  })
}
