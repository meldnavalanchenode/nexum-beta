// Stimulus-pass analysis — the behavioral half of PHYSYNC. Pure: report in,
// findings out; no I/O, same boundary rule as the config engine.
//
// The philosophy carries over exactly. PHYSYNC does not claim to know whether
// your motor direction is "correct" — only your team's convention decides
// that. It records the OBSERVED relationship on a verified run, then flags
// CHANGE. "left_drive moved + before and moves − now" is a fact; "left_drive
// is backwards" would be a guess.
//
// Confidence follows evidence:
//   first observation of no movement → WARN (ambiguous: unplugged motor,
//     unplugged encoder cable, wrong port, or a mechanism under load that a
//     0.25-power pulse can't shift — a false FAIL in a pit destroys trust)
//   a device that moved before and doesn't now → FAIL (unambiguous change)
//   a direction that flipped since the baseline → FAIL (unambiguous change)

import { checkMeta } from './registry.js'

const finding = (id, message, evidence, fix) => {
  const meta = checkMeta(id)
  return { checkId: id, checkVersion: meta.version, severity: meta.severity, message, evidence, fix }
}

const RESULTS = new Set(['moved-positive', 'moved-negative', 'no-response', 'interrupted'])

/** Raw JSON text or object → validated report. Throws with a human message. */
export function parseStimulusReport(input) {
  const raw = typeof input === 'string' ? JSON.parse(input) : input
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('not a stimulus report object')
  }
  if (raw.physyncStimulus !== 1) {
    throw new Error('missing "physyncStimulus": 1 — is this the file the Stimulus OpMode wrote to /sdcard/FIRST/?')
  }
  const motors = []
  for (const m of raw.motors ?? []) {
    if (!m || typeof m.name !== 'string' || !m.name) throw new Error('a motor entry has no name')
    if (!RESULTS.has(m.result)) throw new Error(`motor "${m.name}" has unknown result "${m.result}"`)
    if (!Number.isFinite(m.deltaTicks)) throw new Error(`motor "${m.name}" has non-numeric deltaTicks`)
    motors.push({ name: m.name, deltaTicks: m.deltaTicks, result: m.result })
  }
  const servos = []
  for (const s of raw.servos ?? []) {
    if (!s || typeof s.name !== 'string' || !s.name) throw new Error('a servo entry has no name')
    servos.push({ name: s.name, confirmed: s.confirmed === true })
  }
  return {
    aborted: raw.aborted === true,
    pulsePower: raw.pulsePower ?? null,
    pulseMs: raw.pulseMs ?? null,
    motors,
    servos,
    skipped: (raw.skipped ?? []).filter((x) => typeof x === 'string'),
  }
}

/** The recordable state — only what a later run must be compared against. */
export function toStimulusBaseline(report) {
  return {
    motors: report.motors
      .filter((m) => m.result === 'moved-positive' || m.result === 'moved-negative')
      .map((m) => ({ name: m.name, direction: m.result === 'moved-positive' ? 'positive' : 'negative' }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    servos: report.servos
      .filter((s) => s.confirmed)
      .map((s) => ({ name: s.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/** Nothing measured = nothing verified. Without this floor an empty or fully
 *  interrupted report renders a green PASS plus the affirmative sentence
 *  "every device responded" — a claim about evidence that does not exist. */
function coverageFloor(report, hasBaseline) {
  const usable = report.motors.filter((m) => m.result !== 'interrupted').length + report.servos.length
  if (usable > 0) return []
  return [finding(
    'stimulus-nothing-verified',
    `This stimulus pass verified nothing — ${report.motors.length} motor result(s), ${report.servos.length} servo result(s), none usable`,
    [],
    hasBaseline
      ? 'The verified baseline was never exercised, so nothing was compared. Re-run the stimulus pass on the robot.'
      : 'Re-run the stimulus pass and actually test devices before trusting any verdict from it.',
  )]
}

/** A result that contradicts its own evidence means a hand-edited, truncated,
 *  or version-skewed report. Trusting either half would be a guess. */
function consistency(report) {
  const out = []
  for (const m of report.motors) {
    const moved = Math.abs(m.deltaTicks) >= 20
    if ((m.result === 'moved-positive' && m.deltaTicks <= 0)
      || (m.result === 'moved-negative' && m.deltaTicks >= 0)
      || (m.result === 'no-response' && moved)) {
      out.push(finding(
        'stimulus-report-inconsistent',
        `"${m.name}" reports ${m.result} but deltaTicks is ${m.deltaTicks} — the report contradicts itself`,
        [`stimulus report: ${m.name}`],
        'This report was edited by hand, truncated, or written by a different PHYSYNC version. Re-run the pass rather than trusting either value.',
      ))
    }
  }
  return out
}

/** Findings from a single run, with no baseline to compare against. */
export function analyzeStimulus(report, hasBaseline = false) {
  const findings = [...coverageFloor(report, hasBaseline), ...consistency(report)]
  for (const m of report.motors) {
    if (m.result === 'no-response') {
      findings.push(finding(
        'stimulus-no-response',
        `"${m.name}" was commanded but the encoder did not move (${m.deltaTicks} ticks)`,
        [`stimulus report: ${m.name}`],
        'Four possible causes, in the order worth checking: motor power cable unplugged or in the wrong port · encoder cable unplugged (separate cable — a motor can run with no encoder) · the mechanism is blocked or holding weight a 0.25-power pulse cannot shift · the motor is dead. Check by hand before trusting a PASS.',
      ))
    }
    if (m.result === 'interrupted') {
      findings.push(finding(
        'stimulus-coverage',
        `"${m.name}" test was interrupted — no result recorded`,
        [`stimulus report: ${m.name}`],
        'Re-run the stimulus pass for this device.',
      ))
    }
  }
  for (const s of report.servos) {
    if (!s.confirmed) {
      findings.push(finding(
        'stimulus-servo-unconfirmed',
        `"${s.name}" was nudged but nobody confirmed it moved`,
        [`stimulus report: ${s.name}`],
        'Servos have no feedback, so this is a human observation. Watch the servo and re-run, or check the signal wire and the port number.',
      ))
    }
  }
  for (const name of report.skipped) {
    findings.push(finding('stimulus-coverage', `"${name}" was skipped — not verified`, [], 'Run the stimulus pass again and test it, or accept it as unverified.'))
  }
  if (report.aborted) {
    findings.push(finding('stimulus-coverage', 'Stimulus pass was aborted — the report is partial', [], 'Devices after the abort point were never tested.'))
  }
  return findings
}

/** A baseline is the yardstick every later verdict rests on, so a malformed
 *  one must be rejected loudly rather than silently downgrading every FAIL —
 *  and must never produce findings naming "undefined". Throws a human message. */
export function validateStimulusBaseline(baseline) {
  if (baseline == null || typeof baseline !== 'object' || Array.isArray(baseline)) throw new Error('not a baseline object')
  if (!Array.isArray(baseline.motors)) throw new Error('missing a motors array')
  for (const m of baseline.motors) {
    if (!m || typeof m.name !== 'string' || !m.name) throw new Error('a baseline motor entry has no name')
    if (m.direction !== 'positive' && m.direction !== 'negative') {
      throw new Error(`baseline motor "${m.name}" has no usable direction — direction detection would be silently disabled`)
    }
  }
  for (const s of baseline.servos ?? []) {
    if (!s || typeof s.name !== 'string' || !s.name) throw new Error('a baseline servo entry has no name')
  }
  if (baseline.motors.length === 0) throw new Error('records no motors — every change would be invisible against it')
  return baseline
}

/** Baseline vs current — the high-confidence half. */
export function diffStimulus(baseline, report) {
  const findings = analyzeStimulus(report, true)
  const baseMotors = new Map((baseline.motors ?? []).map((m) => [m.name, m.direction]))
  const baseServos = new Set((baseline.servos ?? []).map((s) => s.name))

  for (const m of report.motors) {
    const wasDirection = baseMotors.get(m.name)
    if (wasDirection === undefined) {
      if (m.result === 'moved-positive' || m.result === 'moved-negative') {
        findings.push(finding('stimulus-coverage', `"${m.name}" responded but is not in the verified baseline`, [], 'New device since the baseline — re-record with --baseline once the robot is verified.'))
      }
      continue
    }
    // A device in the baseline whose test was interrupted was NOT compared —
    // silence here would let a reversal hide behind a mid-pulse stop.
    if (m.result === 'interrupted') {
      findings.push(finding(
        'stimulus-not-compared',
        `"${m.name}" is in the verified baseline but its test was interrupted — it was NOT checked this run`,
        [`baseline: moved ${wasDirection}`],
        'A reversal or disconnection on this device would not have been detected. Re-run the stimulus pass and let the pulse finish.',
      ))
      continue
    }
    if (m.result === 'no-response') {
      findings.push(finding(
        'stimulus-response-lost',
        `"${m.name}" moved on the verified baseline run and does not respond now`,
        [`baseline: moved ${wasDirection}`, `now: ${m.deltaTicks} ticks`],
        'Something changed since the robot was verified: check that port, that motor cable, and that encoder cable first — this is the exact failure a preflight exists to catch.',
      ))
      continue
    }
    const now = m.result === 'moved-positive' ? 'positive' : m.result === 'moved-negative' ? 'negative' : null
    if (now && now !== wasDirection) {
      findings.push(finding(
        'stimulus-direction-changed',
        `"${m.name}" reversed since the verified baseline (${wasDirection} → ${now})`,
        [`baseline: ${wasDirection}`, `now: ${now} (${m.deltaTicks} ticks)`],
        'The motor was rewired, replaced with a different model, or its setDirection was edited. Autonomous paths and encoder math that assume the old direction are now wrong.',
      ))
    }
  }
  for (const name of baseMotors.keys()) {
    if (!report.motors.some((m) => m.name === name) && !report.skipped.includes(name)) {
      findings.push(finding('stimulus-response-lost', `"${name}" was in the verified baseline but is missing from this run`, [], 'The device left the configuration, or the pass ended before reaching it.'))
    }
  }
  for (const s of report.servos) {
    if (baseServos.has(s.name) && !s.confirmed) {
      findings.push(finding(
        'stimulus-response-lost',
        `"${s.name}" was confirmed moving on the baseline run and was not confirmed now`,
        [],
        'Check the servo signal wire and the port number.',
      ))
    }
  }
  // Symmetry with motors: a servo that vanished from the run is exactly as
  // meaningful as a motor that did. Omitting this silently forgave a servo
  // deleted from the config, renamed, or never reached by the pass.
  for (const name of baseServos) {
    if (!report.servos.some((s) => s.name === name) && !report.skipped.includes(name)) {
      findings.push(finding(
        'stimulus-response-lost',
        `"${name}" was confirmed on the verified baseline but is missing from this run entirely`,
        [],
        'The servo left the configuration, was renamed, or the pass ended before reaching it.',
      ))
    }
  }
  return findings
}
