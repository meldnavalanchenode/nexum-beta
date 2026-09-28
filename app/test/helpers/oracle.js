// The independent reference implementation ("oracle") for the differential
// suites. Deliberately written in a DIFFERENT style from src/approval.js —
// indexOf-scanning instead of regex, object-keyed sort instead of array
// sort, char-walk whitespace collapse instead of replace — so a bug in one
// implementation cannot hide in the other. Do not "clean this up" to match
// approval.js: its value is precisely that it is written differently.
//
// It must replicate the TWINS' semantics exactly (Node regex and Java
// Pattern agree on these inputs). Its first version had semantics neither
// twin had, stayed green only because the generator never produced the
// divergent inputs, and was caught by the adversarial fleet. The generator
// now produces those inputs on purpose.

import { createHash, createHmac } from 'node:crypto'

const jsWs = (ch) => /[\t\n\v\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/.test(ch)

export function refNormalizeFirmware(raw) {
  const s = String(raw ?? '')
  const firstNumberAfter = (key) => {
    let from = 0
    while (true) {
      const at = s.indexOf(key + ':', from)
      if (at === -1) return null
      let i = at + key.length + 1
      while (i < s.length && jsWs(s[i])) i++
      let digits = ''
      while (i < s.length && s[i] >= '0' && s[i] <= '9') digits += s[i++]
      if (digits.length) return digits
      from = at + 1
    }
  }
  const maj = firstNumberAfter('Maj'), min = firstNumberAfter('Min'), eng = firstNumberAfter('Eng')
  if (maj != null && min != null && eng != null) return `${maj}.${min}.${eng}`
  let out = ''
  let pendingSpace = false
  for (const ch of s) {
    if (jsWs(ch)) { pendingSpace = out.length > 0; continue }
    if (pendingSpace) out += ' '
    pendingSpace = false
    out += ch
  }
  return ['firmware version unavailable', 'unknown firmware version', 'unknown'].includes(out) ? '' : out
}

export function refCanonicalState(configName, configSha256, hubs) {
  const byAddress = {}
  for (const h of hubs) byAddress[h.address] = h.firmware
  const parts = ['physync-gate-v1']
  parts.push('config-name:' + configName.normalize('NFC'))
  parts.push('config-sha256:' + configSha256)
  const addresses = Object.keys(byAddress).map(Number).sort((a, b) => a - b)
  for (const address of addresses) parts.push('hub:' + address + ':' + byAddress[address])
  return parts.join('\n')
}

export const refDigest = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
export const refSign = (digestHex, keyHex) => createHmac('sha256', Buffer.from(keyHex, 'hex')).update(digestHex).digest('hex')
