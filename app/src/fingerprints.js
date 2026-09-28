// Physical fingerprints — the honest basis for detecting PHYSICAL change.
//
// A fingerprint is a measured reference about the physical robot, captured
// under a stated procedure: the IMU's gravity vector with the robot at rest
// (a re-mounted hub or bent chassis drifts it), or the camera's pose against
// a known AprilTag from a marked reference spot (a re-aimed mount drifts it).
//
// THE LAW THIS MODULE EXISTS TO KEEP:
//   detect = measure and compare. Never infer. A fingerprint that was not
//   re-measured is a GAP (stated absence), never "unchanged". A drift can
//   only be judged against a tolerance A NAMED HUMAN authored — sensors have
//   noise, and PHYSYNC does not invent engineering thresholds. With no
//   authored tolerance, two measurements are recorded and honestly reported
//   as NOT COMPARED.
//
// Tolerances: .physync/fingerprints.json → { "defs": [ { "id", "tolerance",
// "definedBy" } ] }. tolerance is per-value-key max |delta| (0 = exact
// match required — right for discrete keys like an AprilTag id), or
// { "angleDeg": n } to compare {x,y,z} vector entries as a 3D angle —
// the natural metric for a gravity vector.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const FINGERPRINTS_FILE = '.physync/fingerprints.json'

export function validateFingerprintDef(def) {
  if (def == null || typeof def !== 'object') throw new Error('fingerprint def must be an object')
  if (typeof def.id !== 'string' || !/^[\w][\w:\-.]*$/.test(def.id)) throw new Error(`illegal fingerprint def id ${JSON.stringify(def.id ?? null)}`)
  if (def.tolerance == null || typeof def.tolerance !== 'object' || Array.isArray(def.tolerance)) throw new Error(`fingerprint def "${def.id}" needs a tolerance object`)
  const keys = Object.keys(def.tolerance)
  if (keys.length === 0) throw new Error(`fingerprint def "${def.id}" tolerates nothing — name at least one judged key`)
  for (const k of keys) {
    const v = def.tolerance[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`fingerprint def "${def.id}" tolerance.${k} must be a number ≥ 0`)
  }
  if (typeof def.definedBy !== 'string' || !def.definedBy.trim()) {
    throw new Error(`fingerprint def "${def.id}" sets a tolerance but names no one — a tolerance is an engineering decision, and decisions have authors`)
  }
  return def
}

export function loadFingerprintDefs(dir = '.') {
  const path = join(dir, FINGERPRINTS_FILE)
  if (!existsSync(path)) return []
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(raw.defs)) throw new Error('fingerprints.json must be { defs: [...] }')
  const seen = new Set()
  for (const d of raw.defs) {
    validateFingerprintDef(d)
    if (seen.has(d.id)) throw new Error(`fingerprint def "${d.id}" is defined twice`)
    seen.add(d.id)
  }
  return raw.defs
}

const angleDeg = (a, b) => {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z
  const la = Math.hypot(a.x, a.y, a.z)
  const lb = Math.hypot(b.x, b.y, b.z)
  if (la === 0 || lb === 0) return null // a zero vector measures nothing
  const c = Math.min(1, Math.max(-1, dot / (la * lb)))
  return (Math.acos(c) * 180) / Math.PI
}
const hasXYZ = (v) => ['x', 'y', 'z'].every((k) => typeof v[k] === 'number')
const compact = (values) => Object.entries(values).map(([k, v]) => `${k}=${+v.toFixed(4)}`).join(' ')

/**
 * Compare a state's stored fingerprints against a fresh report's.
 *   prior      [{id, method, values}] from the verified state (may be [])
 *   current    [{id, method, values}] from the candidate report, or null
 *              when no robot report was supplied at all
 *   defs       loadFingerprintDefs() result
 * Returns { changes, gaps, standing } in the exact vocabulary detectChanges
 * already emits — drift is a Change, absence is a gap, agreement is standing.
 */
export function compareFingerprints({ prior = [], current = null, defs = [], now = null }) {
  const changes = []
  const gaps = []
  const standing = []
  if (current == null) {
    // No robot report this run: every stored fingerprint is a stated absence.
    for (const p of prior) gaps.push(`fingerprint:${p.id} (in the verified state, no robot report supplied now)`)
    return { changes, gaps, standing }
  }
  const defById = new Map(defs.map((d) => [d.id, d]))
  const curById = new Map(current.map((f) => [f.id, f]))
  for (const p of prior) {
    const c = curById.get(p.id)
    if (!c) { gaps.push(`fingerprint:${p.id} (in the verified state, not re-measured in this report)`); continue }
    const def = defById.get(p.id)
    if (!def) {
      gaps.push(`fingerprint:${p.id} (measured both times but NO AUTHORED TOLERANCE in ${FINGERPRINTS_FILE} — not compared; a tolerance is an engineering decision someone must own)`)
      continue
    }
    const exceeded = []
    if (def.tolerance.angleDeg != null && hasXYZ(p.values) && hasXYZ(c.values)) {
      const a = angleDeg(p.values, c.values)
      if (a == null) exceeded.push('zero-length vector — measurement invalid')
      else if (a > def.tolerance.angleDeg) exceeded.push(`vector angle ${+a.toFixed(2)}° > ${def.tolerance.angleDeg}°`)
    } else {
      for (const [k, tol] of Object.entries(def.tolerance)) {
        if (k === 'angleDeg') continue
        if (!(k in p.values) || !(k in c.values)) { exceeded.push(`judged key "${k}" missing from a measurement`); continue }
        const d = Math.abs(c.values[k] - p.values[k])
        if (d > tol) exceeded.push(`${k} Δ${+d.toFixed(4)} > ${tol}`)
      }
    }
    if (exceeded.length) {
      changes.push({
        id: `fp-${p.id}`,
        kind: 'fingerprint-drift',
        component: `fingerprint:${p.id}`,
        previous: compact(p.values),
        current: compact(c.values),
        source: 'observed',
        method: c.method,
        at: now,
        detail: `${exceeded.join('; ')} (tolerance by ${def.definedBy})`,
      })
    } else {
      standing.push(`fingerprint:${p.id} — re-measured, within the tolerance ${def.definedBy} authored`)
    }
  }
  for (const c of current) {
    if (!prior.some((p) => p.id === c.id)) {
      standing.push(`fingerprint:${c.id} — first measurement (${c.method}); joins the baseline at the next verified state`)
    }
  }
  return { changes, gaps, standing }
}
