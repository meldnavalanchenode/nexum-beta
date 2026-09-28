// Approval manifests — the artifact that makes "the version you tested and
// approved" refer to something real instead of a sentence in a pitch.
//
// `physync approve` freezes a PASSING state into physync-approved.json:
// the active config (name + sha256 of its bytes), the hub census (address +
// normalized firmware), and the TeamCode git SHA at approval time. The robot-
// side gate (PhysyncGate.java) recomputes the same canonical text from what it
// actually observes and refuses to initialize when the digests disagree.
//
// Two integrity layers, deliberately separate:
//   stateDigest    sha256 over the canonical STATE text — the part the robot
//                  can recompute from observation. This is the gate.
//   manifestDigest sha256 over the FULL canonical manifest text — catches
//                  accidental corruption of any field, key not required.
//   hmac           HMAC-SHA256(manifestDigest) with .physync/gate.key —
//                  provenance: this laptop wrote it. NOT a security boundary
//                  against someone with the key or the robot in their hands,
//                  and the docs must never claim otherwise.
//
// CANONICAL TEXT IS A WIRE FORMAT. Java renders the same lines byte-for-byte
// (see PhysyncGate.java and test/fixtures/gate-vectors.json). Any change here
// is a breaking format change: bump physync-gate-v1 → v2 in BOTH places.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { normalizeFirmware } from './firmware.js'
// Re-exported from firmware.js (its long-time home was here) so existing
// import sites keep working. The move lets the CORE import firmware
// normalization without importing this adapter module.
export { normalizeFirmware }

export const GATE_FORMAT = 'physync-gate-v1'
export const APPROVAL_FORMAT = 'physync-approval-v1'

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const HEX64 = /^[0-9a-f]{64}$/

const assertLineSafe = (value, what) => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${what} must be a non-empty string`)
  if (/[\n\r]/.test(value)) throw new Error(`${what} must not contain newlines — a newline in a name is a canonical-line injection, not a name`)
  return value
}

const assertHubs = (hubs) => {
  if (!Array.isArray(hubs)) throw new Error('hubs must be an array')
  const seen = new Set()
  for (const h of hubs) {
    if (!Number.isInteger(h.address) || h.address < 1 || h.address > 255) {
      throw new Error(`hub address ${h.address} is not an integer in 1..255`)
    }
    if (seen.has(h.address)) throw new Error(`hub address ${h.address} appears twice`)
    seen.add(h.address)
    // Firmware MAY be empty — getNullableFirmwareVersionString() returns null
    // on a real hub sometimes, and "unknown" is representable state, not an
    // error. Only newlines are structural.
    if (typeof h.firmware !== 'string') throw new Error(`firmware for hub @${h.address} must be a string`)
    if (/[\n\r]/.test(h.firmware)) throw new Error(`firmware for hub @${h.address} must not contain newlines — a newline in a name is a canonical-line injection, not a name`)
  }
  return hubs
}

/** The state the robot can observe and recompute. Hubs sorted by address so
 *  enumeration order can never change the digest. No trailing newline.
 *  Names are NFC-normalized: macOS hands out NFD filenames, the hub stores
 *  what was typed on the Driver Station, and the same visible name must be
 *  the same bytes on both sides of the wire. */
export function canonicalStateText({ configName, configSha256, hubs }) {
  assertLineSafe(configName, 'configName')
  if (typeof configSha256 !== 'string' || !HEX64.test(configSha256)) {
    throw new Error('configSha256 must be 64 lowercase hex characters')
  }
  assertHubs(hubs)
  const lines = [GATE_FORMAT, `config-name:${configName.normalize('NFC')}`, `config-sha256:${configSha256}`]
  for (const h of [...hubs].sort((a, b) => a.address - b.address)) {
    lines.push(`hub:${h.address}:${h.firmware}`)
  }
  return lines.join('\n')
}

export const stateDigestOf = (state) => sha256(canonicalStateText(state))

/** The full manifest rendering — every field that matters is a line here, so
 *  a single flipped character anywhere covered is a validation failure. */
export function canonicalManifestText(m) {
  const git = m.codeGitSha == null ? 'none' : assertLineSafe(m.codeGitSha, 'codeGitSha')
  // Strict tri-state — truthiness would render {} or 42 as 'dirty', letting
  // a corrupted field validate as if it were true (found by the adversarial
  // suite). Coerced types hide bugs; only true/false/null are states.
  if (m.codeGitDirty !== null && m.codeGitDirty !== undefined && m.codeGitDirty !== true && m.codeGitDirty !== false) {
    throw new Error('codeGitDirty must be true, false, or null')
  }
  const dirty = m.codeGitDirty == null ? 'unknown' : (m.codeGitDirty ? 'dirty' : 'clean')
  if (typeof m.hubsVerified !== 'boolean') throw new Error('hubsVerified must be a boolean')
  return [
    APPROVAL_FORMAT,
    `created:${assertLineSafe(m.createdAt, 'createdAt')}`,
    `engine:${assertLineSafe(m.engineVersion, 'engineVersion')}`,
    `git:${git}:${dirty}`,
    `hubs-verified:${m.hubsVerified}`,
    `devices-sha256:${sha256(JSON.stringify(m.devices ?? []))}`,
    canonicalStateText(m),
  ].join('\n')
}

export const manifestDigestOf = (m) => sha256(canonicalManifestText(m))

export const signManifest = (manifestDigest, keyHex) => {
  if (typeof keyHex !== 'string' || keyHex.length < 32) throw new Error('gate key is too short to sign with')
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(manifestDigest).digest('hex')
}

export const verifyManifestHmac = (manifest, keyHex) => {
  const expected = signManifest(manifestDigestOf(manifest), keyHex)
  const got = String(manifest.hmac ?? '')
  if (got.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(got))
}

export const newGateKey = () => randomBytes(32).toString('hex')

/** Assemble a manifest from a verified-PASS state. `now` is injectable so
 *  tests are deterministic; product code omits it. */
export function buildApproval({ configName, configXml, hubs, hubsVerified, devices, codeGitSha, codeGitDirty, engineVersion, key, now }) {
  // configXml may be a Buffer — and SHOULD be, from file-reading callers.
  // Hashing the utf8-DECODED string collapsed every invalid byte to U+FFFD,
  // so two configs differing only in undecodable bytes digested identically:
  // a demonstrated wrong PASS. Bytes in, bytes hashed.
  const m = {
    physyncApproval: 1,
    createdAt: now ?? new Date().toISOString(),
    engineVersion,
    configName: String(configName).normalize('NFC'),
    configSha256: sha256(Buffer.isBuffer(configXml) ? configXml : Buffer.from(String(configXml), 'utf8')),
    hubs: [...(hubs ?? [])].map((h) => ({ address: h.address, firmware: normalizeFirmware(h.firmware) })).sort((a, b) => a.address - b.address),
    hubsVerified: Boolean(hubsVerified),
    devices: devices ?? [],
    codeGitSha: codeGitSha ?? null,
    codeGitDirty: codeGitDirty ?? null,
  }
  m.stateDigest = stateDigestOf(m)
  m.manifestDigest = manifestDigestOf(m)
  m.hmac = key ? signManifest(m.manifestDigest, key) : null
  return m
}

/** Fail-closed validation: the manifest's own digests are recomputed from its
 *  fields and must match what is stored. A manifest that cannot prove its own
 *  internal consistency is not an approval — it is a corrupted file, and the
 *  gate treats it exactly like no approval at all. */
export function validateApproval(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an approval object')
  if (raw.physyncApproval !== 1) throw new Error('missing "physyncApproval": 1 — is this the file `physync approve` wrote?')
  for (const field of ['stateDigest', 'manifestDigest']) {
    if (typeof raw[field] !== 'string' || !HEX64.test(raw[field])) throw new Error(`${field} is missing or malformed`)
  }
  if (!Array.isArray(raw.devices)) throw new Error('devices must be an array')
  // Shape invariant: hubsVerified ⟺ a non-empty hub census. `approve` can
  // produce no other combination, so any other shape is corruption or a
  // hand edit — and because hubsVerified sits OUTSIDE the state digest, this
  // check is what stops a one-word edit from silently un-gating the entire
  // hub layer (fleet P0). PhysyncGate.java enforces the same invariant.
  if (raw.hubsVerified === true && (!Array.isArray(raw.hubs) || raw.hubs.length === 0)) {
    throw new Error('hubsVerified is true but the manifest holds no hub census — not a shape `physync approve` produces; re-approve')
  }
  if (raw.hubsVerified === false && Array.isArray(raw.hubs) && raw.hubs.length > 0) {
    throw new Error('the manifest holds a hub census but hubsVerified is false — not a shape `physync approve` produces; the file was edited or corrupted, re-approve')
  }
  const state = stateDigestOf(raw)           // throws on malformed name/sha/hubs
  const manifest = manifestDigestOf(raw)     // throws on malformed metadata
  if (state !== raw.stateDigest) throw new Error('stateDigest does not match the manifest\'s own contents — the file was corrupted or edited; re-approve')
  if (manifest !== raw.manifestDigest) throw new Error('manifestDigest does not match the manifest\'s own contents — the file was corrupted or edited; re-approve')
  return raw
}

const finding = (id, meta, message, evidence, fix) => ({ checkId: id, checkVersion: meta.version, severity: meta.severity, message, evidence, fix })

/** Compare an approval against what is observed NOW. Pure — the CLI supplies
 *  observed config bytes and (optionally) a robot report's hub census. */
export function compareApproval(approval, observed, checkMeta) {
  const findings = []
  const meta = (id) => checkMeta(id)

  const observedSha = sha256(Buffer.isBuffer(observed.configXml) ? observed.configXml : Buffer.from(String(observed.configXml), 'utf8'))
  if (String(observed.configName).normalize('NFC') !== approval.configName) {
    findings.push(finding('approval-config-drift', meta('approval-config-drift'),
      `Active configuration is "${observed.configName}" but "${approval.configName}" was approved`,
      [`approved ${approval.createdAt}`],
      'Either activate the approved configuration on the Driver Station, or re-verify the robot and run `physync approve` again.'))
  } else if (observedSha !== approval.configSha256) {
    findings.push(finding('approval-config-drift', meta('approval-config-drift'),
      `Configuration "${approval.configName}" changed since it was approved`,
      [`approved sha ${approval.configSha256.slice(0, 12)}… · current sha ${observedSha.slice(0, 12)}…`, `approved ${approval.createdAt}`],
      'Run `physync diff` to see exactly what moved, re-verify the robot by hand, then `physync approve` again.'))
  }

  if (!approval.hubsVerified) {
    findings.push(finding('approval-hubs-not-covered', meta('approval-hubs-not-covered'),
      'This approval was recorded without a robot report — hub census and firmware are NOT covered by the gate',
      [],
      'Run the PHYSYNC Preflight OpMode, pull physync-robot.json, and approve with --robot to extend the gate to the physical layer.'))
  } else if (observed.hubs != null) {
    // Fail closed with a NAMED cause on malformed observation — a TypeError
    // deep in a Map constructor is indistinguishable from a tool bug, and a
    // gate that dies uglily invites "just skip the gate."
    if (!Array.isArray(observed.hubs)) throw new Error('observed hubs must be an array (or null when the approval does not cover hubs)')
    for (const h of observed.hubs) {
      if (h == null || typeof h !== 'object' || !Number.isInteger(h.address)) {
        throw new Error('an observed hub entry is malformed (no integer address) — the robot report is corrupt; pull a fresh physync-robot.json')
      }
    }
    const seen = new Map(observed.hubs.map((h) => [h.address, normalizeFirmware(h.firmware)]))
    for (const h of approval.hubs) {
      if (!seen.has(h.address)) {
        findings.push(finding('approval-hub-drift', meta('approval-hub-drift'),
          `Hub @${h.address} was present at approval and is not answering now`,
          [`approved ${approval.createdAt}`],
          'Check the RS-485/USB chain and hub power, then re-run the preflight OpMode.'))
      } else if (seen.get(h.address) !== h.firmware) {
        findings.push(finding('approval-hub-drift', meta('approval-hub-drift'),
          `Hub @${h.address} firmware is ${seen.get(h.address)} but ${h.firmware} was approved`,
          [`approved ${approval.createdAt}`],
          'Firmware changed since approval. If the update was intentional, re-verify and `physync approve` again.'))
      }
    }
    for (const [address] of seen) {
      if (!approval.hubs.some((h) => h.address === address)) {
        findings.push(finding('approval-hub-drift', meta('approval-hub-drift'),
          `Hub @${address} is present now but was not part of the approved robot`,
          [`approved ${approval.createdAt}`],
          'A hub was added or re-addressed since approval. Re-verify and `physync approve` again.'))
      }
    }
  }
  return findings
}
