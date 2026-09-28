// Exhaustive boundary enumeration — where the fuzz suites SAMPLE the state
// space, this suite WALKS it. Random sampling is weakest exactly at
// boundaries (address 255, the last hex nibble, the character the generator
// never happens to pick), so everything small enough to enumerate completely
// is enumerated completely. No seed can get lucky here: every case runs,
// every time.

import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalStateText, stateDigestOf, normalizeFirmware, buildApproval, validateApproval, compareApproval } from '../src/approval.js'
import { parseConfigXml } from '../src/configXml.js'
import { reconcile, verdict } from '../src/engine.js'
import { checkMeta, CHECKS, ENGINE_VERSION } from '../src/registry.js'

const SHA = 'a'.repeat(64)
const KNOWN = new Set(CHECKS.map((c) => c.id))

// ── 1. Every legal hub address, and both illegal neighbors ─────────────────
const addressDigests = new Map()
for (let address = 1; address <= 255; address++) {
  test(`exhaustive address ${address}: renders on its own line and digests uniquely`, () => {
    const state = { configName: 'r', configSha256: SHA, hubs: [{ address, firmware: '1.8.2' }] }
    const text = canonicalStateText(state)
    assert.ok(text.endsWith(`hub:${address}:1.8.2`), 'the address must appear verbatim')
    const digest = stateDigestOf(state)
    for (const [other, otherDigest] of addressDigests) {
      if (otherDigest === digest) assert.fail(`address ${address} collides with address ${other}`)
    }
    addressDigests.set(address, digest)
  })
}
for (const illegal of [0, 256, -1, 1000]) {
  test(`exhaustive address ${illegal}: rejected as out of range`, () => {
    assert.throws(() => canonicalStateText({ configName: 'r', configSha256: SHA, hubs: [{ address: illegal, firmware: 'x' }] }))
  })
}

// ── 2. Every printable ASCII character in a config name ────────────────────
for (let code = 0x20; code <= 0x7e; code++) {
  const ch = String.fromCharCode(code)
  test(`exhaustive name char 0x${code.toString(16)} ${JSON.stringify(ch)}: legal in a name and load-bearing in the digest`, () => {
    const name = `a${ch}b`
    const withCh = stateDigestOf({ configName: name, configSha256: SHA, hubs: [] })
    const without = stateDigestOf({ configName: 'ab', configSha256: SHA, hubs: [] })
    assert.notEqual(withCh, without, 'the character must be visible to the digest')
  })
}
for (const [label, ch] of [['newline', '\n'], ['carriage return', '\r']]) {
  test(`exhaustive name char ${label}: rejected as line injection`, () => {
    assert.throws(() => canonicalStateText({ configName: `a${ch}b`, configSha256: SHA, hubs: [] }), /newline/)
  })
}

// ── 3. Every printable ASCII character in a firmware string ────────────────
for (let code = 0x20; code <= 0x7e; code++) {
  const ch = String.fromCharCode(code)
  test(`exhaustive firmware char 0x${code.toString(16)}: survives the canonical line and changes the digest`, () => {
    const fw = `v${ch}1`
    const state = { configName: 'r', configSha256: SHA, hubs: [{ address: 1, firmware: fw }] }
    assert.ok(canonicalStateText(state).includes(`hub:1:${fw}`))
    assert.notEqual(stateDigestOf(state), stateDigestOf({ configName: 'r', configSha256: SHA, hubs: [{ address: 1, firmware: 'v1' }] }))
  })
}

// ── 4. Every hex nibble of the config sha, positionally ────────────────────
for (let i = 0; i < 64; i++) {
  test(`exhaustive sha nibble ${i}: flipping exactly this position changes the digest`, () => {
    const flipped = SHA.slice(0, i) + 'b' + SHA.slice(i + 1)
    assert.notEqual(
      stateDigestOf({ configName: 'r', configSha256: flipped, hubs: [] }),
      stateDigestOf({ configName: 'r', configSha256: SHA, hubs: [] }),
    )
  })
}

// ── 5. All hub-count × boundary-address combinations, exhaustively ─────────
const BOUNDARY_ADDRESSES = [1, 2, 3, 172, 173, 254, 255]
const combos = []
for (let bits = 1; bits < (1 << BOUNDARY_ADDRESSES.length); bits++) {
  combos.push(BOUNDARY_ADDRESSES.filter((_, i) => bits & (1 << i)))
}
combos.forEach((addresses) => {
  test(`exhaustive hub set {${addresses.join(',')}}: order-free, self-consistent, every member visible`, () => {
    const hubs = addresses.map((address) => ({ address, firmware: `${address}.0.0` }))
    const state = { configName: 'r', configSha256: SHA, hubs }
    const digest = stateDigestOf(state)
    assert.equal(stateDigestOf({ ...state, hubs: [...hubs].reverse() }), digest, 'reversal must not matter')
    for (const removed of addresses) {
      const smaller = { ...state, hubs: hubs.filter((h) => h.address !== removed) }
      assert.notEqual(stateDigestOf(smaller), digest, `removing @${removed} must be visible`)
    }
  })
})

// ── 6. Firmware normalization: the full Maj/Min/Eng grid 0..9 × 0..9 × 0..9 ─
for (let maj = 0; maj <= 9; maj++) {
  for (let min = 0; min <= 9; min++) {
    for (let eng = 0; eng <= 9; eng++) {
      test(`exhaustive firmware grid ${maj}.${min}.${eng}: all spellings converge, neighbors diverge`, () => {
        const expected = `${maj}.${min}.${eng}`
        assert.equal(normalizeFirmware(`HW: 20, Maj: ${maj}, Min: ${min}, Eng: ${eng}`), expected)
        assert.equal(normalizeFirmware(`Maj:${maj},Min:${min},Eng:${eng}`), expected)
        assert.notEqual(normalizeFirmware(`Maj: ${maj}, Min: ${min}, Eng: ${(eng + 1) % 10}`), expected)
      })
    }
  }
}

// ── 7. The engine's port-collision truth table, walked completely ──────────
// Every device-tag pair × same/different port on one hub. The expectation is
// derived from the tags' port SPACES: same space + same port = collision,
// anything else = none. This re-derives the engine's core rule independently
// and checks every cell — the matrix suite samples this table; this walks it.
import { portSpace } from '../src/configXml.js'
const wrap = (devices) => `<Robot type="FirstInspires-FTC"><LynxUsbDevice name="P" serialNumber="X" parentModuleAddress="173"><LynxModule name="Control Hub" port="173">${devices}</LynxModule></LynxUsbDevice></Robot>`
const TAGS = ['Motor', 'goBILDA5202SeriesMotor', 'Servo', 'ContinuousRotationServo', 'RevBlinkinLedDriver', 'RevTouchSensor', 'AnalogInput']
for (const a of TAGS) {
  for (const b of TAGS) {
    for (const samePort of [true, false]) {
      test(`exhaustive collision table: ${a}@0 vs ${b}@${samePort ? 0 : 1} → ${portSpace(a, {}) === portSpace(b, {}) && samePort ? 'collision' : 'clear'}`, () => {
        const xml = wrap(`<${a} name="one" port="0" /><${b} name="two" port="${samePort ? 0 : 1}" />`)
        const findings = reconcile(parseConfigXml(xml), { refs: [], dynamic: [], filesScanned: 0 })
        const collided = findings.some((f) => f.checkId === 'port-collision')
        const expected = portSpace(a, {}) === portSpace(b, {}) && samePort
        assert.equal(collided, expected, `spaces: ${portSpace(a, {})} vs ${portSpace(b, {})}`)
        for (const f of findings) assert.ok(KNOWN.has(f.checkId), 'no unregistered finding may escape')
      })
    }
  }
}

// ── 8. Approve→gate round trip across the full boundary grid ───────────────
BOUNDARY_ADDRESSES.forEach((address) => {
  for (const fw of ['1.8.2', '', 'HW: 20, Maj: 1, Min: 8, Eng: 2']) {
    test(`exhaustive round trip @${address} fw=${JSON.stringify(fw).slice(0, 24)}: identical observation is clean, any delta fires`, () => {
      const m = buildApproval({
        configName: 'r', configXml: '<Robot />', hubs: [{ address, firmware: fw }], hubsVerified: true,
        devices: [], engineVersion: ENGINE_VERSION, now: '2026-09-04T00:00:00.000Z',
      })
      validateApproval(JSON.parse(JSON.stringify(m)))
      const clean = compareApproval(m, { configName: 'r', configXml: '<Robot />', hubs: [{ address, firmware: fw }] }, checkMeta)
      assert.deepEqual(clean.filter((f) => f.severity === 'FAIL'), [])
      const gone = compareApproval(m, { configName: 'r', configXml: '<Robot />', hubs: [] }, checkMeta)
      assert.ok(gone.some((f) => f.checkId === 'approval-hub-drift' && f.message.includes(`@${address}`)))
      assert.equal(verdict(gone), 'FAIL')
    })
  }
})
