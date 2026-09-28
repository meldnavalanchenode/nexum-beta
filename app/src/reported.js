// Human-reported physical changes — the one kind of change no file can reveal.
//
// detectChanges() finds everything that leaves a trace: config bytes, device
// entries, hub census, sensor reports. A camera mount re-aimed by hand leaves
// none of those. The config is byte-identical, the census is unchanged, every
// sensor still answers — and the calibration that pointed that camera at the
// field is now worth nothing.
//
// So a person says so, and PHYSYNC records THAT, with its provenance intact:
//
//   source: 'human'          never 'observed' — nothing observed this
//   method: 'self-reported'  the method IS a person's word, and it says so
//
// THE LABELLING RULE this module exists to enforce: a self-reported change is
// never rendered as a detection. It is a person's statement about the robot,
// carrying exactly the weight of a person's statement. It selects rechecks
// through the same approved-edge graph as any other change; it does not
// manufacture evidence, and it never satisfies a requirement by itself.
//
// STORAGE: .physync/reported.json, append-only, created on first use. Nothing
// else reads it, no existing file changes shape, and deleting the file returns
// the tool to its previous behaviour exactly.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const REPORTED_FILE = '.physync/reported.json'
export const REPORTED_FORMAT = 'physync-reported-v1'
export const REPORTED_KIND = 'physical-change-reported'

/** A node id a person can name. Deliberately permissive — the graph's node
 *  vocabulary is data, not code, so this refuses only what would break a
 *  lookup, not what is unfamiliar. */
const COMPONENT_RE = /^[A-Za-z0-9_@$][\w@:\-.$ ]*$/

export function validateReport({ component, note, by }) {
  if (typeof component !== 'string' || !component.trim()) {
    throw new Error('a reported change needs --component <node-id> (for example: camera-position)')
  }
  if (!COMPONENT_RE.test(component)) {
    throw new Error(`component "${component}" contains illegal characters`)
  }
  if (typeof by !== 'string' || !by.trim()) {
    // The same rule the graph applies to approved edges: a human claim needs a
    // human attached to it, or it is an anonymous assertion in a verification
    // record.
    throw new Error('a reported change needs --by <yourName> — a self-reported change is somebody\'s word, so the record says whose')
  }
  if (note != null && typeof note !== 'string') throw new Error('--note must be text')
  return true
}

export function loadReported(dir = '.') {
  const path = join(dir, REPORTED_FILE)
  if (!existsSync(path)) return []
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(raw.reports)) throw new Error(`${REPORTED_FILE} must be { reports: [...] }`)
  return raw.reports
}

/** Append one report. Returns the stored record. */
export function recordReported({ component, note = '', by, at }, dir = '.') {
  validateReport({ component, note, by })
  const existing = loadReported(dir)
  const record = {
    id: `rep-${existing.length + 1}`,
    kind: REPORTED_KIND,
    component: component.trim(),
    note: note.trim(),
    by: by.trim(),
    at: at ?? new Date().toISOString(),
  }
  mkdirSync(join(dir, '.physync'), { recursive: true })
  // Atomic write (temp + rename): a crash or a concurrent reader mid-write
  // must never leave a half-written reported.json — a torn record of a human
  // claim is worse than no record, because it fails every later load.
  const path = join(dir, REPORTED_FILE)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify({ format: REPORTED_FORMAT, reports: [...existing, record] }, null, 2))
  renameSync(tmp, path)
  return record
}

/** Reports made after a verified state was saved — i.e. those the state does
 *  not already account for. A report older than the baseline was true of a
 *  robot that has since been re-verified, so it is history, not a requirement. */
export function reportedSince(reports, isoTime) {
  if (!isoTime) return reports
  return reports.filter((r) => r.at > isoTime)
}

/** Shape a report as a Change record the existing planner already understands.
 *  previous/current stay null on purpose: nobody measured anything, and
 *  inventing a before/after would be the exact dishonesty this module avoids. */
export function asChange(report) {
  return {
    id: report.id,
    kind: REPORTED_KIND,
    component: report.component,
    previous: null,
    current: null,
    source: 'human',
    method: 'self-reported',
    at: report.at,
    note: report.note,
    by: report.by,
  }
}
