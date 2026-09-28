// Approval/gate unit suite — the hand-written boundary cases. The property
// these lock: an approval is a self-proving artifact. Every covered field is
// load-bearing, everything unverifiable fails closed, and the comparison
// names exactly what moved.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeFirmware, canonicalStateText, stateDigestOf, canonicalManifestText,
  manifestDigestOf, signManifest, verifyManifestHmac, newGateKey,
  buildApproval, validateApproval, compareApproval, GATE_FORMAT,
} from '../src/approval.js'
import { checkMeta, CHECKS, ENGINE_VERSION } from '../src/registry.js'
import { verdict } from '../src/engine.js'

const KEY = 'ab'.repeat(32)
const base = (over = {}) => buildApproval({
  configName: 'robot', configXml: '<Robot type="FirstInspires-FTC"><Motor name="m" port="0" /></Robot>',
  hubs: [{ address: 173, firmware: 'HW: 20, Maj: 1, Min: 8, Eng: 2' }, { address: 2, firmware: 'Maj: 1, Min: 8, Eng: 2' }],
  hubsVerified: true, devices: [{ name: 'm', type: 'Motor', port: 0, bus: null }],
  codeGitSha: 'f'.repeat(40), codeGitDirty: false, engineVersion: ENGINE_VERSION, key: KEY,
  now: '2026-09-03T04:00:00.000Z', ...over,
})
const observedFor = (m, over = {}) => ({
  configName: over.configName ?? m.configName,
  configXml: over.configXml ?? '<Robot type="FirstInspires-FTC"><Motor name="m" port="0" /></Robot>',
  hubs: over.hubs !== undefined ? over.hubs : m.hubs.map((h) => ({ ...h })),
})
const ids = (fs) => fs.map((f) => f.checkId).sort()

// ── registry wiring ────────────────────────────────────────────────────────
test('all five approval checks are registered with severity and why', () => {
  for (const id of ['approval-missing', 'approval-config-drift', 'approval-hub-drift', 'approval-bad-signature', 'approval-hubs-not-covered']) {
    const meta = checkMeta(id)
    assert.ok(meta, `${id} must be in the registry`)
    assert.ok(meta.why.length > 40, `${id} needs a real rationale, not a stub`)
  }
  assert.equal(checkMeta('approval-hubs-not-covered').severity, 'INFO', 'a coverage gap is honesty, not an alarm')
  assert.equal(checkMeta('approval-missing').severity, 'FAIL', 'no approval must fail closed')
})

test('registry ids are still unique after the approval additions', () => {
  const all = CHECKS.map((c) => c.id)
  assert.equal(new Set(all).size, all.length)
})

// ── normalizeFirmware ──────────────────────────────────────────────────────
test('firmware: REV verbose form normalizes to the bare triple', () => {
  assert.equal(normalizeFirmware('HW: 20, Maj: 1, Min: 8, Eng: 2'), '1.8.2')
})
test('firmware: bare Maj/Min/Eng with and without spaces both normalize', () => {
  assert.equal(normalizeFirmware('Maj: 1, Min: 8, Eng: 2'), '1.8.2')
  assert.equal(normalizeFirmware('Maj:1,Min:8,Eng:2'), '1.8.2')
})
test('firmware: a partial triple is passed through, never guessed to zero', () => {
  assert.equal(normalizeFirmware('Maj: 1, Min: 8'), 'Maj: 1, Min: 8')
})
test('firmware: unparseable strings pass through with whitespace collapsed', () => {
  assert.equal(normalizeFirmware('  weird\t fw   string '), 'weird fw string')
})
test('firmware: null and undefined become the empty string, not "null"', () => {
  assert.equal(normalizeFirmware(null), '')
  assert.equal(normalizeFirmware(undefined), '')
})
test('firmware: normalization is idempotent', () => {
  for (const s of ['HW: 20, Maj: 1, Min: 8, Eng: 2', '1.8.2', 'junk fw']) {
    assert.equal(normalizeFirmware(normalizeFirmware(s)), normalizeFirmware(s))
  }
})
test('firmware: two spellings of the same version digest identically after normalization', () => {
  const a = base({ hubs: [{ address: 173, firmware: 'HW: 20, Maj: 1, Min: 8, Eng: 2' }] })
  const b = base({ hubs: [{ address: 173, firmware: 'Maj: 1, Min: 8, Eng: 2' }] })
  assert.equal(a.stateDigest, b.stateDigest, 'the HW prefix is presentation, not state')
})

// ── canonical text ─────────────────────────────────────────────────────────
test('canonical: begins with the versioned format marker', () => {
  assert.ok(canonicalStateText({ configName: 'r', configSha256: 'a'.repeat(64), hubs: [] }).startsWith(GATE_FORMAT + '\n'))
})
test('canonical: hubs render sorted by address regardless of input order', () => {
  const fwd = canonicalStateText({ configName: 'r', configSha256: 'a'.repeat(64), hubs: [{ address: 2, firmware: 'x' }, { address: 173, firmware: 'y' }] })
  const rev = canonicalStateText({ configName: 'r', configSha256: 'a'.repeat(64), hubs: [{ address: 173, firmware: 'y' }, { address: 2, firmware: 'x' }] })
  assert.equal(fwd, rev)
})
test('canonical: a newline in a config name is an injection, not a name', () => {
  assert.throws(() => canonicalStateText({ configName: 'r\nhub:9:fake', configSha256: 'a'.repeat(64), hubs: [] }), /newline/)
})
test('canonical: a newline in a firmware string is rejected the same way', () => {
  assert.throws(() => canonicalStateText({ configName: 'r', configSha256: 'a'.repeat(64), hubs: [{ address: 1, firmware: 'ok\nhub:9:fake' }] }), /newline/)
})
test('canonical: a carriage return is as illegal as a newline', () => {
  assert.throws(() => canonicalStateText({ configName: 'r\rx', configSha256: 'a'.repeat(64), hubs: [] }), /newline/)
})
test('canonical: colons inside names and firmware are data, not structure', () => {
  const text = canonicalStateText({ configName: 'my:config', configSha256: 'a'.repeat(64), hubs: [{ address: 1, firmware: 'v: 1: 2' }] })
  assert.ok(text.includes('config-name:my:config'))
  assert.ok(text.includes('hub:1:v: 1: 2'))
})
test('canonical: uppercase or short config sha is rejected — hex is a contract', () => {
  assert.throws(() => canonicalStateText({ configName: 'r', configSha256: 'A'.repeat(64), hubs: [] }), /64 lowercase hex/)
  assert.throws(() => canonicalStateText({ configName: 'r', configSha256: 'a'.repeat(63), hubs: [] }), /64 lowercase hex/)
})
test('canonical: hub address 0, 256, 1.5, and "173" are all rejected', () => {
  for (const address of [0, 256, 1.5, '173']) {
    assert.throws(() => canonicalStateText({ configName: 'r', configSha256: 'a'.repeat(64), hubs: [{ address, firmware: 'x' }] }), /1\.\.255|integer/)
  }
})
test('canonical: duplicate hub addresses are rejected — one address, one hub', () => {
  assert.throws(() => canonicalStateText({ configName: 'r', configSha256: 'a'.repeat(64), hubs: [{ address: 2, firmware: 'x' }, { address: 2, firmware: 'y' }] }), /twice/)
})
test('canonical: empty config name is rejected', () => {
  assert.throws(() => canonicalStateText({ configName: '', configSha256: 'a'.repeat(64), hubs: [] }), /non-empty/)
})
test('canonical: zero hubs is a legal state (declaration-only approvals exist)', () => {
  const text = canonicalStateText({ configName: 'r', configSha256: 'a'.repeat(64), hubs: [] })
  assert.equal(text.split('\n').length, 3)
})

// ── build + validate round trip ────────────────────────────────────────────
test('build: manifest validates against itself after a JSON round trip', () => {
  const m = JSON.parse(JSON.stringify(base()))
  assert.deepEqual(validateApproval(m), m)
})
test('build: hubs are stored normalized and sorted', () => {
  const m = base()
  assert.deepEqual(m.hubs.map((h) => h.address), [2, 173])
  assert.equal(m.hubs[1].firmware, '1.8.2')
})
test('build: stateDigest and manifestDigest are distinct digests over distinct scopes', () => {
  const m = base()
  assert.notEqual(m.stateDigest, m.manifestDigest)
  const m2 = base({ codeGitDirty: true })
  assert.equal(m2.stateDigest, m.stateDigest, 'git metadata is not robot state')
  assert.notEqual(m2.manifestDigest, m.manifestDigest, 'but it IS covered by the manifest digest')
})
test('build: without a key the manifest is unsigned, never pretend-signed', () => {
  assert.equal(base({ key: null }).hmac, null)
})
test('validate: rejects null, arrays, strings, and numbers', () => {
  for (const bad of [null, [], 'approval', 42, undefined]) {
    assert.throws(() => validateApproval(bad), /not an approval object/)
  }
})
test('validate: rejects a manifest without the physyncApproval marker', () => {
  const m = { ...base() }
  delete m.physyncApproval
  assert.throws(() => validateApproval(m), /physyncApproval/)
})
test('validate: a changed covered field breaks self-consistency and throws', () => {
  for (const mutate of [
    (m) => { m.configName = 'other' },
    (m) => { m.hubs = m.hubs.slice(1) },
    (m) => { m.hubs[0].firmware = '9.9.9' },
    (m) => { m.hubsVerified = !m.hubsVerified },
    (m) => { m.createdAt = '2026-09-04T04:00:00.000Z' },
    (m) => { m.codeGitSha = null },
    (m) => { m.devices = [] },
  ]) {
    const m = JSON.parse(JSON.stringify(base()))
    mutate(m)
    assert.throws(() => validateApproval(m), /does not match|malformed|not a shape/, 'every covered field must be load-bearing')
  }
})
test('validate: a forged stateDigest cannot be laundered by also forging manifestDigest honestly', () => {
  const m = JSON.parse(JSON.stringify(base()))
  m.stateDigest = 'b'.repeat(64)
  assert.throws(() => validateApproval(m))
})
test('validate: malformed digest fields are rejected before any recomputation', () => {
  for (const field of ['stateDigest', 'manifestDigest']) {
    const m = JSON.parse(JSON.stringify(base()))
    m[field] = 'not-hex'
    assert.throws(() => validateApproval(m), /malformed/)
  }
})
test('validate: devices must be an array — an object smuggled in throws', () => {
  const m = JSON.parse(JSON.stringify(base()))
  m.devices = { name: 'm' }
  assert.throws(() => validateApproval(m), /array/)
})

// ── signatures ─────────────────────────────────────────────────────────────
test('hmac: signs and verifies with the right key', () => {
  assert.equal(verifyManifestHmac(base(), KEY), true)
})
test('hmac: a different key fails verification', () => {
  assert.equal(verifyManifestHmac(base(), 'cd'.repeat(32)), false)
})
test('hmac: a single flipped hex character fails verification', () => {
  const m = JSON.parse(JSON.stringify(base()))
  m.hmac = (m.hmac[0] === 'a' ? 'b' : 'a') + m.hmac.slice(1)
  assert.equal(verifyManifestHmac(m, KEY), false)
})
test('hmac: a missing or truncated hmac fails without throwing', () => {
  for (const hmac of [null, undefined, '', 'abc']) {
    const m = { ...JSON.parse(JSON.stringify(base())), hmac }
    assert.equal(verifyManifestHmac(m, KEY), false)
  }
})
test('hmac: signing with a too-short key is refused, not weakened', () => {
  assert.throws(() => signManifest('a'.repeat(64), 'short'), /too short/)
})
test('key: newGateKey is 64 hex chars and two calls differ', () => {
  const a = newGateKey(), b = newGateKey()
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.notEqual(a, b)
})

// ── compareApproval semantics ──────────────────────────────────────────────
test('compare: identical observation produces zero findings', () => {
  const m = base()
  assert.deepEqual(compareApproval(m, observedFor(m), checkMeta), [])
})
test('compare: a renamed active config is config-drift naming both names', () => {
  const m = base()
  const f = compareApproval(m, observedFor(m, { configName: 'backupBot' }), checkMeta)
  assert.deepEqual(ids(f), ['approval-config-drift'])
  assert.match(f[0].message, /backupBot/)
  assert.match(f[0].message, /robot/)
})
test('compare: changed config bytes under the same name is config-drift with both shas in evidence', () => {
  const m = base()
  const f = compareApproval(m, observedFor(m, { configXml: '<Robot type="FirstInspires-FTC"><Motor name="m2" port="1" /></Robot>' }), checkMeta)
  assert.deepEqual(ids(f), ['approval-config-drift'])
  assert.match(f[0].evidence[0], /approved sha .+ current sha/)
})
test('compare: a rename is reported as a rename, not additionally as a byte change', () => {
  const m = base()
  const f = compareApproval(m, observedFor(m, { configName: 'other', configXml: 'different bytes entirely' }), checkMeta)
  assert.equal(f.filter((x) => x.checkId === 'approval-config-drift').length, 1, 'one cause, one finding')
})
test('compare: a hub missing now is hub-drift naming the address', () => {
  const m = base()
  const f = compareApproval(m, observedFor(m, { hubs: m.hubs.filter((h) => h.address !== 2) }), checkMeta)
  assert.deepEqual(ids(f), ['approval-hub-drift'])
  assert.match(f[0].message, /@2/)
  assert.match(f[0].message, /not answering/)
})
test('compare: a firmware change is hub-drift naming both versions', () => {
  const m = base()
  const hubs = m.hubs.map((h) => h.address === 173 ? { ...h, firmware: 'HW: 20, Maj: 1, Min: 9, Eng: 0' } : h)
  const f = compareApproval(m, observedFor(m, { hubs }), checkMeta)
  assert.deepEqual(ids(f), ['approval-hub-drift'])
  assert.match(f[0].message, /1\.9\.0/)
  assert.match(f[0].message, /1\.8\.2/)
})
test('compare: an extra hub now is hub-drift too — additions are drift, not upgrades', () => {
  const m = base()
  const f = compareApproval(m, observedFor(m, { hubs: [...m.hubs, { address: 3, firmware: 'x' }] }), checkMeta)
  assert.deepEqual(ids(f), ['approval-hub-drift'])
  assert.match(f[0].message, /@3/)
  assert.match(f[0].message, /was not part of the approved robot/)
})
test('compare: a re-addressed hub produces exactly the vanish+appear pair', () => {
  const m = base()
  const hubs = m.hubs.map((h) => h.address === 2 ? { ...h, address: 4 } : h)
  const f = compareApproval(m, observedFor(m, { hubs }), checkMeta)
  assert.deepEqual(ids(f), ['approval-hub-drift', 'approval-hub-drift'])
  assert.ok(f.some((x) => /@2/.test(x.message)) && f.some((x) => /@4/.test(x.message)))
})
test('compare: observed firmware is normalized before comparison — format change is not drift', () => {
  const m = base()
  const hubs = m.hubs.map((h) => h.address === 173 ? { ...h, firmware: 'Maj: 1, Min: 8, Eng: 2' } : h)
  assert.deepEqual(compareApproval(m, observedFor(m, { hubs }), checkMeta), [])
})
test('compare: declaration-only approval reports the hub coverage gap as INFO and ignores hubs', () => {
  const m = base({ hubs: [], hubsVerified: false })
  const f = compareApproval(m, { configName: 'robot', configXml: '<Robot type="FirstInspires-FTC"><Motor name="m" port="0" /></Robot>', hubs: [{ address: 9, firmware: 'x' }] }, checkMeta)
  assert.deepEqual(ids(f), ['approval-hubs-not-covered'])
  assert.equal(verdict(f), 'PASS', 'a stated gap is not a failure — an unstated one would be')
})
test('compare: hub findings and config findings compose — two causes, both named', () => {
  const m = base()
  const f = compareApproval(m, observedFor(m, { configXml: 'changed', hubs: m.hubs.slice(0, 1) }), checkMeta)
  assert.deepEqual(ids(f), ['approval-config-drift', 'approval-hub-drift'])
  assert.equal(verdict(f), 'FAIL')
})
test('compare: every finding carries version, severity, evidence array, and a fix', () => {
  const m = base()
  const f = compareApproval(m, observedFor(m, { configXml: 'x', hubs: [] }), checkMeta)
  for (const x of f) {
    assert.match(x.checkVersion, /^\d+\.\d+\.\d+$/)
    assert.ok(['FAIL', 'WARN', 'INFO'].includes(x.severity))
    assert.ok(Array.isArray(x.evidence))
    assert.ok(x.fix.length > 20, 'a fix is a sentence, not a shrug')
  }
})

test('canonical: an EMPTY firmware string is legal state — a real hub can return null firmware, and "unknown" must be representable', () => {
  const text = canonicalStateText({ configName: 'r', configSha256: 'a'.repeat(64), hubs: [{ address: 254, firmware: '' }] })
  assert.ok(text.endsWith('hub:254:'))
  const a = base({ hubs: [{ address: 254, firmware: '' }] })
  validateApproval(JSON.parse(JSON.stringify(a)))
  const b = base({ hubs: [{ address: 254, firmware: 'x' }] })
  assert.notEqual(a.stateDigest, b.stateDigest, 'empty and "x" are different states')
})

test('canonical: non-string firmware (number, null) is rejected — coerced types hide bugs', () => {
  for (const firmware of [null, 182, undefined]) {
    assert.throws(() => canonicalStateText({ configName: 'r', configSha256: 'a'.repeat(64), hubs: [{ address: 1, firmware }] }), /must be a string/)
  }
})

// ── Fleet round 5: the adversarial review of the gate itself ────────────────
test('R5-P0: the hubsVerified shape invariant — a one-word edit cannot un-gate the hub layer', () => {
  // The attack: flip hubsVerified to false, keep the census, recompute the
  // manifest digest HONESTLY (which a keyless attacker can). The state digest
  // does not cover the flag, so only the shape invariant stands in the way.
  const m = JSON.parse(JSON.stringify(base()))
  m.hubsVerified = false
  m.manifestDigest = manifestDigestOf(m)
  assert.throws(() => validateApproval(m), /hub census but hubsVerified is false/)
  // And the inverse shape: verified with nothing to verify.
  const d = JSON.parse(JSON.stringify(base({ hubs: [], hubsVerified: false })))
  d.hubsVerified = true
  d.manifestDigest = manifestDigestOf(d)
  assert.throws(() => validateApproval(d), /no hub census/)
})

test('R5-P1: config hashing is over BYTES — invalid UTF-8 differences are drift, not identity', () => {
  const a = buildApproval({ configName: 'r', configXml: Buffer.from([0x3c, 0x52, 0xe9, 0x3e]), hubs: [], hubsVerified: false, devices: [], engineVersion: ENGINE_VERSION, now: '2026-09-04T00:00:00.000Z' })
  const b = buildApproval({ configName: 'r', configXml: Buffer.from([0x3c, 0x52, 0xea, 0x3e]), hubs: [], hubsVerified: false, devices: [], engineVersion: ENGINE_VERSION, now: '2026-09-04T00:00:00.000Z' })
  assert.notEqual(a.configSha256, b.configSha256, 'both bytes decode to U+FFFD — hashing the decoded string called them identical')
  const f = compareApproval(a, { configName: 'r', configXml: Buffer.from([0x3c, 0x52, 0xea, 0x3e]), hubs: null }, checkMeta)
  assert.ok(f.some((x) => x.checkId === 'approval-config-drift'), 'the byte flip must be drift')
})

test('R5-P1: the SDK cannot-read-firmware sentinels and a null read are ONE state', () => {
  for (const sentinel of ['firmware version unavailable', 'unknown firmware version', 'unknown']) {
    assert.equal(normalizeFirmware(sentinel), '', `"${sentinel}" must normalize like a null read`)
  }
  // The false-FAIL loop the fleet found: approved via the non-nullable API,
  // observed via the nullable one — same hub, must not disagree.
  const m = base({ hubs: [{ address: 173, firmware: 'firmware version unavailable' }] })
  const f = compareApproval(m, observedFor(m, { hubs: [{ address: 173, firmware: '' }] }), checkMeta)
  assert.deepEqual(f.filter((x) => x.severity === 'FAIL'), [], 'an unavailable firmware string approved one way and observed the other is NOT drift')
})

test('R5-P1: config names compare NFC-normalized — a macOS NFD filename equals its NFC self', () => {
  const nfd = 'práctica'
  const nfc = 'práctica'
  assert.notEqual(nfd, nfc, 'precondition: the two spellings differ byte-wise')
  const a = base({ configName: nfd })
  const b = base({ configName: nfc })
  assert.equal(a.stateDigest, b.stateDigest, 'same visible name, same digest')
  assert.deepEqual(compareApproval(a, observedFor(a, { configName: nfc }), checkMeta).filter((x) => x.checkId === 'approval-config-drift'), [])
})

test('R5: all six approval checks are registered', () => {
  for (const id of ['approval-missing', 'approval-config-drift', 'approval-hub-drift', 'approval-bad-signature', 'approval-signature-unverified', 'approval-hubs-not-covered']) {
    assert.ok(checkMeta(id), `${id} must be in the registry`)
  }
  assert.equal(checkMeta('approval-signature-unverified').severity, 'WARN')
})

test('R5-P1: NBSP and ideographic spaces collapse exactly like ASCII spaces', () => {
  assert.equal(normalizeFirmware('1.8.2 final'), '1.8.2 final')
  assert.equal(normalizeFirmware('v1　rev　7'), 'v1 rev 7')
})
