// Corruption sweep — proves every byte of every covered field is load-bearing.
// Five structurally different manifests; for each, EVERY character of every
// covered field is substituted one at a time, and validateApproval must throw
// every single time. A position where corruption validates silently would be
// a byte the gate cannot see — which is exactly a wrong PASS.
//
// This is the same claim `terraform plan` and a checksum make, tested the
// hard way: not "corruption is usually caught" but "there exists no covered
// byte whose corruption is missed."

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApproval, validateApproval, verifyManifestHmac } from '../src/approval.js'
import { ENGINE_VERSION } from '../src/registry.js'

const KEY = 'cd'.repeat(32)

const MANIFESTS = {
  'declaration-only (zero hubs)': buildApproval({
    configName: 'robot', configXml: '<Robot type="FirstInspires-FTC"><Motor name="m" port="0" /></Robot>',
    hubs: [], hubsVerified: false, devices: [{ name: 'm', type: 'Motor', port: 0, bus: null }],
    codeGitSha: null, codeGitDirty: null, engineVersion: ENGINE_VERSION, key: KEY, now: '2026-09-03T04:00:00.000Z',
  }),
  'single control hub': buildApproval({
    configName: 'CompBot', configXml: '<Robot type="FirstInspires-FTC"><Servo name="claw" port="0" /><Motor name="lift" port="1" /></Robot>',
    hubs: [{ address: 173, firmware: 'HW: 20, Maj: 1, Min: 8, Eng: 2' }], hubsVerified: true,
    devices: [{ name: 'claw', type: 'Servo', port: 0, bus: null }, { name: 'lift', type: 'Motor', port: 1, bus: null }],
    codeGitSha: 'e'.repeat(40), codeGitDirty: false, engineVersion: ENGINE_VERSION, key: KEY, now: '2026-01-14T17:00:00.000Z',
  }),
  'four hubs, unicode firmware': buildApproval({
    configName: 'práctica ローバー', configXml: '<Robot type="FirstInspires-FTC">' + '<Motor name="m" port="0" />'.repeat(3) + '</Robot>',
    hubs: [
      { address: 1, firmware: '1.8.2' }, { address: 2, firmware: 'Maj: 1, Min: 9, Eng: 0' },
      { address: 173, firmware: 'fw-β rev 7' }, { address: 254, firmware: 'x' },
    ],
    hubsVerified: true, devices: [], codeGitSha: '0123456789abcdef0123456789abcdef01234567', codeGitDirty: true,
    engineVersion: ENGINE_VERSION, key: KEY, now: '2026-10-24T09:30:00.000Z',
  }),
  'dirty working tree': buildApproval({
    configName: 'v2.final.FINAL', configXml: '<Robot type="FirstInspires-FTC"><RevColorSensorV3 name="c" port="0" bus="2" /></Robot>',
    hubs: [{ address: 2, firmware: 'Maj: 1, Min: 8, Eng: 2' }, { address: 3, firmware: 'Maj: 1, Min: 8, Eng: 3' }],
    hubsVerified: true, devices: [{ name: 'c', type: 'RevColorSensorV3', port: 0, bus: 2 }],
    codeGitSha: 'a'.repeat(40), codeGitDirty: true, engineVersion: ENGINE_VERSION, key: KEY, now: '2026-11-16T12:00:00.000Z',
  }),
  'long name, no git': buildApproval({
    configName: 'the twenty-sixth revision of the robot configuration we swore was final',
    configXml: '<Robot type="FirstInspires-FTC"><Motor name="a" port="0" /><Motor name="b" port="1" /><Motor name="c" port="2" /><Motor name="d" port="3" /></Robot>',
    hubs: [{ address: 100, firmware: 'HW: 20, Maj: 2, Min: 0, Eng: 1' }], hubsVerified: true,
    devices: [{ name: 'a', type: 'Motor', port: 0, bus: null }], codeGitSha: null, codeGitDirty: null,
    engineVersion: ENGINE_VERSION, key: KEY, now: '2026-12-01T08:15:00.000Z',
  }),
}

// A substitution that always yields a DIFFERENT character of the same broad
// class, so the mutation is corruption rather than a type error.
const substitute = (s, i) => {
  const c = s[i]
  const replacement = /[0-9a-f]/.test(c) ? (c === '0' ? '1' : '0') : (c === 'x' ? 'y' : 'x')
  return s.slice(0, i) + replacement + s.slice(i + 1)
}

const clone = (m) => JSON.parse(JSON.stringify(m))

for (const [label, manifest] of Object.entries(MANIFESTS)) {
  // Sanity anchor per manifest: the uncorrupted original validates and verifies.
  test(`corruption[${label}]: pristine manifest validates and its signature verifies`, () => {
    validateApproval(clone(manifest))
    assert.equal(verifyManifestHmac(clone(manifest), KEY), true)
  })

  const stringFieldTargets = [
    ['configName', (m) => m.configName, (m, v) => { m.configName = v }],
    ['configSha256', (m) => m.configSha256, (m, v) => { m.configSha256 = v }],
    ['stateDigest', (m) => m.stateDigest, (m, v) => { m.stateDigest = v }],
    ['manifestDigest', (m) => m.manifestDigest, (m, v) => { m.manifestDigest = v }],
    ['createdAt', (m) => m.createdAt, (m, v) => { m.createdAt = v }],
    ['engineVersion', (m) => m.engineVersion, (m, v) => { m.engineVersion = v }],
  ]
  if (manifest.codeGitSha) stringFieldTargets.push(['codeGitSha', (m) => m.codeGitSha, (m, v) => { m.codeGitSha = v }])

  for (const [field, get, set] of stringFieldTargets) {
    const value = get(manifest)
    for (let i = 0; i < value.length; i++) {
      test(`corruption[${label}]: ${field}[${i}] '${value[i]}' flipped → validation must throw`, () => {
        const m = clone(manifest)
        set(m, substitute(value, i))
        assert.throws(() => validateApproval(m), undefined, `a silent pass here means byte ${i} of ${field} is not covered`)
      })
    }
  }

  // Per-hub corruption: every firmware character and every address digit.
  manifest.hubs.forEach((hub, hubIndex) => {
    for (let i = 0; i < hub.firmware.length; i++) {
      test(`corruption[${label}]: hub@${hub.address} firmware[${i}] flipped → validation must throw`, () => {
        const m = clone(manifest)
        m.hubs[hubIndex].firmware = substitute(m.hubs[hubIndex].firmware, i)
        assert.throws(() => validateApproval(m))
      })
    }
    test(`corruption[${label}]: hub@${hub.address} address nudged → validation must throw`, () => {
      const m = clone(manifest)
      let next = hub.address === 255 ? 1 : hub.address + 1
      while (m.hubs.some((h) => h.address === next)) next = next === 255 ? 1 : next + 1
      m.hubs[hubIndex].address = next
      assert.throws(() => validateApproval(m))
    })
    test(`corruption[${label}]: hub@${hub.address} address made non-integer → validation must throw`, () => {
      const m = clone(manifest)
      m.hubs[hubIndex].address = hub.address + 0.5
      assert.throws(() => validateApproval(m))
    })
  })

  // Device-list corruption: informational for the robot, but covered by the
  // manifest digest — a tampered device list must not validate.
  manifest.devices.forEach((device, deviceIndex) => {
    for (const prop of ['name', 'type']) {
      const value = String(device[prop])
      for (let i = 0; i < value.length; i++) {
        test(`corruption[${label}]: devices[${deviceIndex}].${prop}[${i}] flipped → validation must throw`, () => {
          const m = clone(manifest)
          m.devices[deviceIndex][prop] = substitute(value, i)
          assert.throws(() => validateApproval(m))
        })
      }
    }
    test(`corruption[${label}]: devices[${deviceIndex}].port nudged → validation must throw`, () => {
      const m = clone(manifest)
      m.devices[deviceIndex].port = (m.devices[deviceIndex].port ?? 0) + 1
      assert.throws(() => validateApproval(m))
    })
  })

  // Boolean and null flips on covered metadata.
  test(`corruption[${label}]: hubsVerified flipped → validation must throw`, () => {
    const m = clone(manifest)
    m.hubsVerified = !m.hubsVerified
    assert.throws(() => validateApproval(m))
  })
  test(`corruption[${label}]: codeGitDirty flipped → validation must throw`, () => {
    const m = clone(manifest)
    m.codeGitDirty = m.codeGitDirty === true ? false : true
    assert.throws(() => validateApproval(m))
  })

  // HMAC corruption: every hex character of the signature individually.
  for (let i = 0; i < manifest.hmac.length; i++) {
    test(`corruption[${label}]: hmac[${i}] flipped → signature must not verify`, () => {
      const m = clone(manifest)
      m.hmac = substitute(m.hmac, i)
      assert.equal(verifyManifestHmac(m, KEY), false)
      validateApproval(m) // digests untouched — corruption of ONLY the hmac is a signature failure, not a digest one
    })
  }

  // Whole-file rot: the serialized JSON truncated at every 16th byte must
  // never parse-and-validate. (Truncations that still parse — e.g. cutting
  // inside a value that happens to close — must still fail validation.)
  const serialized = JSON.stringify(manifest, null, 2)
  for (let cut = 16; cut < serialized.length; cut += 16) {
    test(`corruption[${label}]: file truncated at byte ${cut} → must not validate`, () => {
      let parsed
      try {
        parsed = JSON.parse(serialized.slice(0, cut))
      } catch {
        return // unparseable is the good outcome — the CLI treats it as approval-missing
      }
      assert.throws(() => validateApproval(parsed), undefined, 'a truncation that parses must still fail validation')
    })
  }
}

// ── Key-deletion sweep (fleet: the truncation family mostly exercises the
//    parse-fail path by design — JSON.parse rejects every strict prefix of a
//    pretty-printed object, which is itself the fail-closed behavior wanted).
//    Deletions are the corruption family that PARSES: every top-level key is
//    removed one at a time and the validation outcome is pinned per key. ──
const DELETION_SPEC = {
  physyncApproval: 'throws',
  createdAt: 'throws',
  engineVersion: 'throws',
  configName: 'throws',
  configSha256: 'throws',
  hubs: 'throws',
  hubsVerified: 'throws',
  devices: 'throws',
  stateDigest: 'throws',
  manifestDigest: 'throws',
  codeGitSha: 'throws-iff-set',   // null → 'none' either way: deletion is a no-op
  codeGitDirty: 'throws-iff-set',
  hmac: 'never',                  // validate does not check hmac; the signature layer does
}

for (const [label, manifest] of Object.entries(MANIFESTS)) {
  for (const [key, expectation] of Object.entries(DELETION_SPEC)) {
    test(`corruption[${label}]: key "${key}" deleted → ${expectation}`, () => {
      const m = clone(manifest)
      const wasSet = m[key] != null
      delete m[key]
      const mustThrow = expectation === 'throws' || (expectation === 'throws-iff-set' && wasSet)
      if (mustThrow) {
        assert.throws(() => validateApproval(m), undefined, `deleting ${key} must not validate`)
      } else {
        validateApproval(m)
        if (key === 'hmac') assert.equal(verifyManifestHmac(m, KEY), false, 'but the signature layer must reject it')
      }
    })
  }
}
