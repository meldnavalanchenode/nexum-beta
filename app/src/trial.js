// The 30-day beta window. CORE module, no platform knowledge.
//
// WHAT THIS IS. Nexum's beta is time-limited: 30 days from the first run, after
// which every command refuses until the window is extended.
//
// WHAT IT IS NOT. It is not a licence check and it cannot be one. The source
// ships to every team in plain JavaScript and there is no server behind it, so
// anyone who wants to keep using it past the window can delete three lines.
// That is a deliberate limit, not an oversight: obfuscation or a phone-home
// would cost the thing the product is actually selling — that it runs offline,
// stores nothing, and tells you the truth about what it does.
//
// So this is an HONEST deadline, not a lock. It is stated in the docs, printed
// with a countdown on every command, and names the person to contact. A team
// that hits it knows exactly what happened and why.
//
// THE CLOCK STARTS AT FIRST RUN, not at download. A team that downloads today
// and starts in December gets their full window — which matters, because at
// least one beta team deferred to December on purpose.
//
// TWO MARKERS, EARLIEST WINS. The start is recorded in two places:
//
//   .physync/trial.json     in the project
//   ~/.nexum/trial.json     in the user's home directory
//
// The home marker is what makes the window mean "one window per download"
// rather than "one window per folder": deleting .physync/, unzipping a fresh
// copy, or starting a second project does not hand out another 30 days. It
// holds a single ISO timestamp and nothing else — no machine name, no user
// name, no project path, no identifiers of any kind — and it is the only thing
// Nexum ever writes outside your project. That is disclosed in START_HERE.md,
// README.md and both PDFs, because "Nexum only writes inside .physync/" was a
// promise we made and this is the one exception to it.
//
// If the home directory is unwritable (locked-down school images, roaming
// profiles), the project marker alone governs. Degrading to a shorter leash is
// never worth refusing to run.

import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeAtomic } from './io.js'

export const TRIAL_FILE = '.physync/trial.json'
export const HOME_TRIAL_DIR = '.nexum'
export const HOME_TRIAL_FILE = 'trial.json'
export const TRIAL_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

const homePath = (home = homedir()) => join(home, HOME_TRIAL_DIR, HOME_TRIAL_FILE)

function readMarker(path) {
  if (!existsSync(path)) return null
  try {
    const t = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof t?.startedAt !== 'string') return null
    return Number.isFinite(new Date(t.startedAt).getTime()) ? t : null
  } catch {
    // An unreadable marker must not brick a project. Treat it as absent and let
    // the next write re-establish it — refusing to run because a bookkeeping
    // file got corrupted would punish a team for our file format.
    return null
  }
}

/** The project marker, or null if this project has never run. */
export function readTrial(dir = '.') {
  return readMarker(join(dir, TRIAL_FILE))
}

/** The home marker, or null. Survives re-downloads and deleted projects. */
export function readHomeTrial(home = homedir()) {
  return readMarker(homePath(home))
}

/**
 * The start that actually governs: the EARLIEST of the two markers.
 *
 * Earliest, not latest, is the whole point. A fresh unzip writes a new project
 * marker; taking the minimum means the home marker still holds the real start
 * and the window does not restart.
 */
export function effectiveStart(dir = '.', home = homedir()) {
  const times = [readTrial(dir), readHomeTrial(home)]
    .filter(Boolean)
    .map(t => new Date(t.startedAt).getTime())
  return times.length ? new Date(Math.min(...times)) : null
}

/**
 * Start the clock if it has not started, in both places. Returns the record
 * that governs. Writing the home marker is best-effort by design — see the
 * note at the top of this file about locked-down machines.
 */
export function startTrial(dir = '.', now = new Date(), home = homedir()) {
  const existing = effectiveStart(dir, home)
  const startedAt = (existing ?? now).toISOString()
  const rec = { format: 'physync-trial-v1', startedAt, days: TRIAL_DAYS }

  if (!readTrial(dir)) {
    try { writeAtomic(join(dir, TRIAL_FILE), JSON.stringify(rec, null, 2)) } catch { /* governed by home */ }
  }
  if (!readHomeTrial(home)) {
    // A timestamp and nothing else. Anything identifying in here would make
    // "no telemetry, nothing about your machine" false.
    try {
      mkdirSync(join(home, HOME_TRIAL_DIR), { recursive: true })
      writeAtomic(homePath(home), JSON.stringify({ format: 'physync-trial-v1', startedAt, days: TRIAL_DAYS }, null, 2))
    } catch { /* unwritable home: the project marker governs */ }
  }
  return rec
}

/** Days left, or null when no clock has started yet. Negative when expired. */
export function daysRemaining(dir = '.', now = new Date(), home = homedir()) {
  const start = effectiveStart(dir, home)
  if (!start) return null
  return Math.ceil((TRIAL_DAYS * DAY_MS - (now.getTime() - start.getTime())) / DAY_MS)
}

/**
 * Throws when the window has closed. Every command calls this.
 *
 * The message has to do real work: a team hitting this is mid-season and the
 * tool just stopped. It names what happened, confirms their data is intact and
 * where it lives, and gives one way forward.
 */
export function assertTrialActive(dir = '.', now = new Date(), home = homedir()) {
  const left = daysRemaining(dir, now, home)
  if (left === null || left > 0) return
  const start = effectiveStart(dir, home)
  throw Object.assign(new Error(
    `This Nexum beta window closed ${Math.abs(left)} day(s) ago (it ran ${TRIAL_DAYS} days from ${start.toISOString().slice(0, 10)}).\n` +
    `Your records are untouched and still yours: verified states, results, rules and experiments are plain JSON in .physync/ (the result ledger is one JSON object per line) and you can read them all with any text editor.\n` +
    `To keep using Nexum, email ashrith.kora@gmail.com — if you are a beta team, say so and I will extend it.`),
    { physyncDiagnosed: true, trialExpired: true })
}

/** The countdown line, shown on every command so nothing is a surprise. */
export function trialNotice(dir = '.', now = new Date(), home = homedir()) {
  const left = daysRemaining(dir, now, home)
  if (left === null) return null
  if (left <= 0) return null                      // assertTrialActive handles it
  if (left > 7) return `  Beta window: ${left} days left.`
  return `  Beta window: ${left} day(s) left — email ashrith.kora@gmail.com to extend.`
}
