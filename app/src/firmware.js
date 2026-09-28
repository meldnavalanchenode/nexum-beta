// Firmware-string normalization — a BOUNDARY module, deliberately tiny.
//
// It sits between the platform adapters (which read firmware strings off
// real hardware in whatever dialect the SDK speaks) and the core engine
// (which compares them as opaque normalized values). Core modules may import
// this; it imports nothing but the language. When a second platform grows a
// real adapter, its normalization lands next to this one and the core stays
// ignorant of both dialects.

/** "HW: 20, Maj: 1, Min: 8, Eng: 2" → "1.8.2". Unparseable strings pass
 *  through trimmed with whitespace collapsed — shown raw, never guessed at.
 *  Java mirrors this exactly (PhysyncGate.normalizeFirmware), including the
 *  whitespace set: Java's \s is ASCII-only, so the twin spells out this
 *  exact JS \s character class.
 *
 *  The SDK's cannot-read-firmware sentinels normalize to "" — the same value
 *  a null read produces — because "unavailable" is ONE state, not three. The
 *  fleet found the two sides of the wire sampling different SDK methods
 *  (getFirmwareVersionString → "firmware version unavailable" vs the
 *  nullable variant → null), which made an unchanged hub disagree with its
 *  own approval forever. */
const FIRMWARE_UNAVAILABLE_SENTINELS = new Set(['firmware version unavailable', 'unknown firmware version', 'unknown'])
export function normalizeFirmware(raw) {
  const s = String(raw ?? '')
  const grab = (key) => s.match(new RegExp(`${key}:\\s*(\\d+)`))?.[1] ?? null
  const maj = grab('Maj'), min = grab('Min'), eng = grab('Eng')
  if (maj != null && min != null && eng != null) return `${maj}.${min}.${eng}`
  const collapsed = s.trim().replace(/\s+/g, ' ')
  return FIRMWARE_UNAVAILABLE_SENTINELS.has(collapsed) ? '' : collapsed
}
