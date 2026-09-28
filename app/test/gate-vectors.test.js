// Cross-language contract lock. test/fixtures/gate-vectors.json is the file
// PhysyncGate.java must reproduce on real hardware before the gate may be
// trusted — 60 states, their canonical text, and their digests. This suite
// pins the Node side of the contract: if an edit to approval.js changes any
// vector, the committed fixture fails loudly instead of silently orphaning
// the Java twin. That failure is CORRECT — it means "you changed the wire
// format; bump physync-gate-v1 in BOTH implementations and regenerate."

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { canonicalStateText, stateDigestOf, GATE_FORMAT } from '../src/approval.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/gate-vectors.json', import.meta.url), 'utf8'))

test('vectors: fixture declares the same format version the implementation speaks', () => {
  assert.equal(fixture.format, GATE_FORMAT)
})

test('vectors: fixture holds exactly 60 vectors', () => {
  assert.equal(fixture.vectors.length, 60)
})

fixture.vectors.forEach((v, i) => {
  test(`vector ${i}: "${v.state.configName}" (${v.state.hubs.length} hub(s)) renders and digests exactly as committed`, () => {
    assert.equal(canonicalStateText(v.state), v.canonicalText)
    assert.equal(stateDigestOf(v.state), v.stateDigest)
    assert.match(v.stateDigest, /^[0-9a-f]{64}$/)
    assert.ok(v.canonicalText.startsWith(GATE_FORMAT + '\n'))
  })
})

// Firmware-normalization half of the contract: the exact pairs the Java twin
// must reproduce, including the cases where Java's regex defaults (ASCII \s,
// ASCII trim) silently diverge from JavaScript unless spelled out.
import { normalizeFirmware } from '../src/approval.js'
const norm = JSON.parse(readFileSync(new URL('./fixtures/gate-vectors.json', import.meta.url), 'utf8')).firmwareNormalization
test('vectors: the normalization section exists for the Java twin', () => {
  assert.ok(norm.pairs.length >= 16)
})
norm.pairs.forEach((p, i) => {
  test(`normalization vector ${i}: ${JSON.stringify(p.raw).slice(0, 50)} → ${JSON.stringify(p.expected)}`, () => {
    assert.equal(normalizeFirmware(p.raw), p.expected)
  })
})
