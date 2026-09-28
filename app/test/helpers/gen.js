// Shared generators for the gate/approval test campaign. Every suite that
// mass-generates cases imports from here so "diverse" means one rich
// generator, not seven copies of a weak one.

import { buildApproval } from '../../src/approval.js'
import { ENGINE_VERSION } from '../../src/registry.js'

/** Deterministic PRNG — same as the fuzz suite. Seed in, stream out. */
export const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)]
export const int = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))

/** Firmware strings across the real spectrum: REV verbose, bare triples,
 *  partials that must NOT normalize, unicode garbage, whitespace soup. */
export function genFirmware(rnd) {
  const maj = int(rnd, 0, 9), min = int(rnd, 0, 20), eng = int(rnd, 0, 30)
  return pick(rnd, [
    () => `HW: 20, Maj: ${maj}, Min: ${min}, Eng: ${eng}`,
    () => `Maj: ${maj}, Min: ${min}, Eng: ${eng}`,
    () => `Maj:${maj},Min:${min},Eng:${eng}`,
    () => `${maj}.${min}.${eng}`,                                  // no Maj/Min/Eng keys → passthrough
    () => `Maj: ${maj}, Min: ${min}`,                              // partial → passthrough
    () => `fw-${maj}${'β'.repeat(int(rnd, 0, 3))} rev ${eng}`,     // unicode + spaces
    () => `  spaced   out\tfw ${maj} `,                            // whitespace collapse path
    // The messy family the fleet proved was ungenerated — these are exactly
    // where a naive reference parser and the regex twins disagree:
    () => `xMaj: ${maj}, Min: ${min}, Eng: ${eng}`,                // key matched mid-word by the regex
    () => `Maj: ${maj}, Min: ${min}, Eng: ${eng}, Maj: 9`,         // duplicate key → FIRST occurrence wins
    () => `Maj: ${maj}${pick(rnd, ['abc', 'x'])}, Min: ${min}, Eng: ${eng}`, // digit-prefix capture
    () => `${maj}.${min}.${eng}\u00A0final`,                    // NBSP — JS \\s vs Java \\s divergence bait
    () => `v${maj}\u3000rev\u3000${eng}`,                       // ideographic spaces
    () => 'firmware version unavailable',                          // SDK sentinel → ""
    () => 'unknown',                                               // Preflight's old fallback → ""
  ])()
}

/** Config names across alphabets — everything legal except newlines. */
export function genConfigName(rnd) {
  const base = pick(rnd, ['robot', 'CompBot', 'práctica', 'bot 2', 'v2.final.FINAL', 'ローバー', 'a', 'my:config', '2026_biobuzz'])
  return int(rnd, 0, 2) === 0 ? `${base}${int(rnd, 0, 99)}` : base
}

const DEVICE_TAGS = ['goBILDA5202SeriesMotor', 'Motor', 'Servo', 'ContinuousRotationServo', 'RevColorSensorV3', 'RevTouchSensor', 'RevBlinkinLedDriver', 'AnalogInput', 'Rev2mDistanceSensor']

/** A structurally valid FTC config XML with randomized devices — real parser
 *  food, not lorem ipsum, so config-byte mutations change meaningful bytes. */
export function genConfigXml(rnd) {
  const deviceCount = int(rnd, 1, 8)
  const devices = []
  for (let i = 0; i < deviceCount; i++) {
    const tag = pick(rnd, DEVICE_TAGS)
    const bus = /Color|Distance/.test(tag) ? ` bus="${int(rnd, 0, 3)}"` : ''
    devices.push(`<${tag} name="dev_${i}_${int(rnd, 0, 999)}" port="${int(rnd, 0, 5)}"${bus} />`)
  }
  const pad = ' '.repeat(int(rnd, 0, 200))                          // size variance without breaking XML
  return `<Robot type="FirstInspires-FTC">${pad}<LynxUsbDevice name="P" serialNumber="X${int(rnd, 1, 9999)}" parentModuleAddress="173"><LynxModule name="Control Hub" port="173">${devices.join('')}</LynxModule></LynxUsbDevice></Robot>`
}

export function genHubs(rnd, count = null) {
  const n = count ?? int(rnd, 0, 6)
  const addresses = new Set()
  while (addresses.size < n) addresses.add(int(rnd, 1, 255))
  return [...addresses].map((address) => ({ address, firmware: genFirmware(rnd) }))
}

/** A full randomized approval — the common input for fuzz, metamorphic,
 *  corruption, and differential suites. */
export function genApproval(rnd, over = {}) {
  const hubs = over.hubs ?? genHubs(rnd)
  return buildApproval({
    configName: over.configName ?? genConfigName(rnd),
    configXml: over.configXml ?? genConfigXml(rnd),
    hubs,
    hubsVerified: over.hubsVerified ?? hubs.length > 0,
    devices: over.devices ?? [{ name: `d${int(rnd, 0, 99)}`, type: pick(rnd, DEVICE_TAGS), port: int(rnd, 0, 5), bus: null }],
    codeGitSha: over.codeGitSha !== undefined ? over.codeGitSha : (int(rnd, 0, 1) ? 'a'.repeat(20) + int(rnd, 10000000, 99999999).toString(16).padStart(20, '0') : null),
    codeGitDirty: over.codeGitDirty !== undefined ? over.codeGitDirty : pick(rnd, [true, false, null]),
    engineVersion: ENGINE_VERSION,
    key: over.key ?? null,
    now: over.now ?? `2026-09-${String(int(rnd, 1, 28)).padStart(2, '0')}T0${int(rnd, 0, 9)}:${String(int(rnd, 0, 59)).padStart(2, '0')}:00.000Z`,
  })
}

/** Fisher–Yates with the suite PRNG — for order-invariance assertions. */
export function shuffle(rnd, arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
