// Sensor-liveness analysis. Pure: report in, findings out.
//
// The honest asymmetry this file exists to preserve:
//   I2C sensors (color, distance, IMU) genuinely answer or don't — an absent
//     one throws or reads all zeros, so liveness is REAL evidence and a
//     non-answer after 3 retries is a FAIL.
//   Digital and analog inputs are hub pins. A read always succeeds and an
//     unplugged input floats to something that looks legitimate. PHYSYNC will
//     NOT claim a touch sensor is connected when it cannot know: those are
//     reported as liveness-unavailable, with the observed value as evidence.
// Against a verified baseline the weaker signals still become useful: a value
// that was stable across verified runs and changed class is worth surfacing,
// but "the pin read differently" is never a FAIL on its own.

import { checkMeta } from './registry.js'
import { sanitizeLine } from './text.js'

const finding = (id, message, evidence, fix) => {
  const meta = checkMeta(id)
  return { checkId: id, checkVersion: meta.version, severity: meta.severity, message, evidence, fix }
}

const READS = new Set(['ok', 'error', 'zeros'])
const CLASSES = new Set(['i2c', 'digital', 'analog'])

/** Raw JSON text or object → validated robot report. Throws a human message. */
export function parseRobotReport(input) {
  const raw = typeof input === 'string' ? JSON.parse(input) : input
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a robot report object')
  if (raw.physyncRobot !== 1) {
    throw new Error('missing "physyncRobot": 1 — is this the file the PHYSYNC Preflight OpMode wrote to /sdcard/FIRST/? (an older OpMode build wrote a report without this marker; re-flash the current PhysyncPreflight.java)')
  }
  const sensors = []
  const seen = new Set()
  for (const s of raw.sensors ?? []) {
    if (!s || typeof s.name !== 'string' || !s.name) throw new Error('a sensor entry has no name')
    if (!READS.has(s.read)) throw new Error(`sensor "${s.name}" has unknown read result "${s.read}"`)
    if (!CLASSES.has(s.class)) throw new Error(`sensor "${s.name}" has unknown class "${s.class}"`)
    // livenessDeterminable must FAIL CLOSED. Coercing a missing or mistyped
    // field to false turned every dead I2C sensor into an INFO and produced a
    // green card for a robot with a dead IMU.
    if (typeof s.livenessDeterminable !== 'boolean') {
      throw new Error(`sensor "${s.name}" has no boolean livenessDeterminable — re-flash the current PhysyncPreflight.java rather than trusting this report`)
    }
    // Duplicate names make the baseline ambiguous: it recorded both entries and
    // then false-FAILed the very same report on re-run.
    if (seen.has(s.name)) throw new Error(`sensor "${s.name}" appears more than once — the configuration has duplicate names, which PHYSYNC's config check reports separately`)
    seen.add(s.name)
    // A hub pin's liveness is never determinable, whatever the report claims —
    // this is the guarantee that digital/analog can never reach FAIL.
    const determinable = s.class === 'i2c' ? s.livenessDeterminable : false
    sensors.push({
      // Robot-report strings render into terminals, reports, and prompts —
      // sanitized at this boundary like every other scanned byte.
      name: sanitizeLine(s.name),
      type: sanitizeLine(typeof s.type === 'string' ? s.type : 'unknown'),
      class: s.class,
      read: s.read,
      value: sanitizeLine(typeof s.value === 'string' ? s.value : ''),
      determinable,
    })
  }
  // Hubs get the same fail-closed treatment as sensors: an entry missing its
  // address or firmware once flowed straight into a verified state, poisoned
  // the digest (undefined serializes differently in the digest and the file),
  // and wedged the whole ledger behind a false tamper accusation.
  const hubs = []
  for (const h of Array.isArray(raw.hubs) ? raw.hubs : []) {
    if (h == null || typeof h !== 'object' || Array.isArray(h)) throw new Error('a hub entry is not an object — re-flash the current PhysyncPreflight.java rather than trusting this report')
    if (typeof h.address !== 'number' || !Number.isFinite(h.address)) throw new Error('a hub entry has no numeric address — re-flash the current PhysyncPreflight.java rather than trusting this report')
    if (typeof h.firmware !== 'string' || !h.firmware) throw new Error(`hub @${h.address} reports no firmware string — re-flash the current PhysyncPreflight.java rather than trusting this report`)
    hubs.push({ ...h, firmware: sanitizeLine(h.firmware) })
  }
  // Physical fingerprints — measured references about the PHYSICAL robot
  // (an IMU's gravity vector at rest, a camera's pose against a known
  // AprilTag). Optional, fail-closed like everything else in this report:
  // a fingerprint is a real measurement or it is refused. Absence is
  // recorded as absence, never as "unchanged".
  const FP_ID = /^[\w][\w:\-.]*$/
  const fingerprints = []
  const fpSeen = new Set()
  for (const f of Array.isArray(raw.fingerprints) ? raw.fingerprints : []) {
    if (f == null || typeof f !== 'object' || Array.isArray(f)) throw new Error('a fingerprint entry is not an object — re-flash the current PhysyncPreflight.java rather than trusting this report')
    if (typeof f.id !== 'string' || !FP_ID.test(f.id)) throw new Error(`fingerprint has an illegal id ${JSON.stringify(f.id ?? null)}`)
    if (typeof f.method !== 'string' || !f.method.trim()) throw new Error(`fingerprint "${f.id}" names no method — a measurement without a method is a rumor`)
    if (f.values == null || typeof f.values !== 'object' || Array.isArray(f.values)) throw new Error(`fingerprint "${f.id}" has no values object`)
    const keys = Object.keys(f.values)
    if (keys.length === 0) throw new Error(`fingerprint "${f.id}" measured nothing`)
    for (const k of keys) {
      if (typeof f.values[k] !== 'number' || !Number.isFinite(f.values[k])) throw new Error(`fingerprint "${f.id}" value "${k}" is not a finite number`)
    }
    if (fpSeen.has(f.id)) throw new Error(`fingerprint "${f.id}" appears more than once`)
    fpSeen.add(f.id)
    fingerprints.push({ id: f.id, method: sanitizeLine(f.method.trim()), values: { ...f.values } })
  }
  return {
    hubs,
    sensors,
    fingerprints,
    deviceCount: Number.isFinite(raw.deviceCount) ? raw.deviceCount : null,
  }
}

/** Only sensors whose liveness is meaningful AND answered are worth baselining. */
export function toSensorBaseline(report) {
  return {
    sensors: report.sensors
      .filter((s) => s.determinable && s.read === 'ok')
      .map((s) => ({ name: s.name, type: s.type, class: s.class }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/** A baseline is the yardstick every later verdict rests on — reject a
 *  malformed one loudly instead of emitting findings that name "undefined". */
export function validateSensorBaseline(baseline) {
  if (baseline == null || typeof baseline !== 'object' || Array.isArray(baseline)) throw new Error('not a baseline object')
  if (!Array.isArray(baseline.sensors)) throw new Error('missing a sensors array')
  for (const s of baseline.sensors) {
    if (!s || typeof s.name !== 'string' || !s.name) throw new Error('a baseline sensor entry has no name')
  }
  if (baseline.sensors.length === 0) throw new Error('records no sensors — every change would be invisible against it')
  return baseline
}

/** Findings from a single run, no baseline. */
export function analyzeSensors(report) {
  const findings = []
  // Same coverage floor as the stimulus pass: "ALL ANSWERING" over an empty
  // set is a green light backed by nothing.
  if (report.sensors.filter((s) => s.determinable).length === 0) {
    findings.push(finding(
      'sensor-nothing-verified',
      report.sensors.length === 0
        ? 'This preflight read no sensors at all'
        : `None of the ${report.sensors.length} sensor(s) read has determinable liveness — only hub pins were seen`,
      [],
      'Nothing here confirms a sensor is connected. If the robot has I2C sensors, check that the configuration is active and re-run the preflight OpMode.',
    ))
  }
  for (const s of report.sensors) {
    if (s.determinable && s.read === 'error') {
      findings.push(finding(
        'sensor-not-responding',
        `"${s.name}" (${s.type}) did not answer after 3 reads — ${s.value || 'read failed'}`,
        [`robot report: ${s.name}`],
        'An I2C sensor that throws on every read is not on the bus: check the I2C cable at both ends, that it is on the bus the configuration says, and that no two identical sensors share one bus.',
      ))
    }
    if (s.determinable && s.read === 'zeros') {
      findings.push(finding(
        'sensor-reads-zero',
        `"${s.name}" (${s.type}) answered but read all zeros (${s.value})`,
        [`robot report: ${s.name}`],
        'Usually an unplugged or wrong-bus I2C sensor — a live one essentially never reads zero on every channel at once. Cover it with your hand and re-run: if the numbers do not move, it is not really there.',
      ))
    }
    if (!s.determinable) {
      findings.push(finding(
        'sensor-liveness-unavailable',
        `"${s.name}" (${s.type}, ${s.class}) read ${s.value} — liveness cannot be determined for ${s.class} pins`,
        [`robot report: ${s.name}`],
        `A ${s.class} input reads a value whether or not anything is plugged in, so PHYSYNC will not claim this device is connected. To verify it by hand: press/trigger it and watch this value change between two runs.`,
      ))
    }
  }
  return findings
}

/** Baseline vs current — the high-confidence half. */
export function diffSensors(baseline, report) {
  const findings = analyzeSensors(report)
  const base = new Map((baseline.sensors ?? []).map((s) => [s.name, s]))
  const seen = new Set(report.sensors.map((s) => s.name))

  for (const s of report.sensors) {
    const was = base.get(s.name)
    if (!was) continue
    if (s.read !== 'ok') {
      findings.push(finding(
        'sensor-response-lost',
        `"${s.name}" answered on the verified baseline run and does not now (${s.read})`,
        [`baseline: answering`, `now: ${s.read}${s.value ? ` — ${s.value}` : ''}`],
        'Something changed since the robot was verified. Check that sensor cable and its port first — this is exactly the failure a preflight exists to catch.',
      ))
    }
    if (was.type !== s.type) {
      findings.push(finding(
        'sensor-response-lost',
        `"${s.name}" changed type since the verified baseline (${was.type} → ${s.type})`,
        [`baseline: ${was.type}`, `now: ${s.type}`],
        'The device was swapped for a different model, or the configuration entry was re-typed. Code written against the old sensor may read the wrong units or registers.',
      ))
    }
  }
  for (const name of base.keys()) {
    if (!seen.has(name)) {
      findings.push(finding(
        'sensor-response-lost',
        `"${name}" was in the verified baseline but is absent from this run entirely`,
        [],
        'The sensor left the active configuration — check whether the config was rebuilt or a SCAN wiped it.',
      ))
    }
  }
  return findings
}
