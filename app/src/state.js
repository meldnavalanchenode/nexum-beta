// Versioned Verified Robot States — the Phase-2 core of the new direction.
//
// A verified state is an immutable, digest-protected snapshot of everything
// Nexum knew about a robot at a moment a human vouched for it: the DECLARED
// layer (config bytes, device map, code reconciliation) and the OBSERVED
// layer (hub census, sensor liveness, stimulus results), each carried as
// EVIDENCE items with a three-valued result:
//
//   PASS     sufficient evidence, matches expectation
//   FAIL     evidence conflicts with expectation
//   UNKNOWN  not enough independent evidence — a REAL engineering state,
//            never silently converted to PASS (the rule this module exists
//            to enforce: a hub pin that reads clean is UNKNOWN, not
//            connected; an unconfirmed servo is UNKNOWN, not fine)
//
// States are append-only: V1, V2, V3… — never overwritten, never edited.
// Re-verifying a robot creates the next version. History is the product.
//
// The legacy single-slot artifacts (approved.json, snapshot.json, the two
// baselines) are absorbed by migrateLegacy() into a V1 on first use and left
// on disk untouched — the Java gate keeps reading approved.json's
// physync-gate-v1 format, which this module does not change.

import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { writeAtomic, writeAtomicExclusive } from './io.js'
import { join, dirname, resolve } from 'node:path'
import { normalizeFirmware } from './firmware.js'
import { compareFingerprints } from './fingerprints.js'

export const STATE_FORMAT = 'physync-state-v1'
export const STATES_DIR = '.physync/states'

export const RESULTS = ['PASS', 'FAIL', 'UNKNOWN']
export const STATUSES = {
  VERIFIED: 'VERIFIED FOR DEFINED CHECKS',
  REVALIDATION: 'REVALIDATION REQUIRED',
  FAILED: 'VALIDATION FAILED',
  INCOMPLETE: 'VERIFICATION INCOMPLETE',
  // The robot changed and Nexum cannot say what it affected — no approved
  // dependency reaches anything. Printing "REVALIDATION REQUIRED · 0 recheck(s)
  // owed" for this case was self-contradictory on its face and read, to anyone
  // who had not read the manual, as broken software. The honest headline names
  // the ignorance instead of implying a demand that does not exist.
  UNMAPPED: 'CHANGED — IMPACT NOT MAPPED',
}

const sha256 = (data) => createHash('sha256').update(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')).digest('hex')

/** Deterministic serialization — sorted keys, no whitespace variance — so a
 *  state's digest is stable across writes and platforms. States are
 *  laptop-side only (the robot reads the unchanged approval manifest), so
 *  JSON canonicalization here does not create a cross-language twin burden. */
export function stableStringify(value) {
  // Mirrors JSON.stringify's undefined semantics EXACTLY: undefined object
  // values are dropped, undefined array items become null. The digest is
  // computed over this while the file is written by JSON.stringify — if the
  // two ever disagree (they once did, on {address: undefined}), a state is
  // corrupt at birth and every later load rejects it as tampered.
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((v) => stableStringify(v) ?? 'null').join(',') + ']'
  const parts = []
  for (const k of Object.keys(value).sort()) {
    const s = stableStringify(value[k])
    if (s !== undefined) parts.push(JSON.stringify(k) + ':' + s)
  }
  return '{' + parts.join(',') + '}'
}

const digestOfState = (state) => {
  const { stateDigest, ...rest } = state
  return sha256(stableStringify(rest))
}

const evidence = (id, result, source, method, summary) => {
  if (!RESULTS.includes(result)) throw new Error(`illegal evidence result "${result}"`)
  if (source !== 'declared' && source !== 'observed' && source !== 'human') throw new Error(`illegal evidence source "${source}"`)
  return { id, result, source, method, summary }
}

/** Build a verified state from what was actually collected. Refuses to build
 *  over a FAILING check — verification means a human vouched for a working
 *  robot, not a frozen pile of known defects. Absence of a section is
 *  recorded as absence (coverage), never faked as evidence.
 *
 *  EXTRACTION POINT (adapter observations): this signature is shaped like
 *  the FTC inputs (configXml bytes, a Preflight robot report, a stimulus
 *  report). The state it BUILDS is already platform-neutral — a declared
 *  layer (source: xml-parse | hand), an observed layer, and evidence rows
 *  with source/method/result. The VEX --declare path already enters through
 *  the same door with no config file at all. When a second platform grows a
 *  real adapter, these parameters become an adapter-built observation
 *  bundle; the state format, digesting, and change detection do not move. */
export function buildVerifiedState({ robotId = 'robot', version, configName, configXml, devices, checkVerdict, checkFindingCounts, robot, stimulus, results, engineVersion, now, declaredBy = 'xml-parse', declaredByHuman = null, codeGit = null, codeDigest = null, filesScanned = null, reportDigests = null, carriedOver = null }) {
  if (!Number.isInteger(version) || version < 1) throw new Error('state version must be a positive integer')
  if (checkVerdict === 'FAIL') throw new Error('Refusing to build a verified state over a FAILING check — fix the findings, re-verify, then save the state.')
  if (declaredBy !== 'xml-parse' && declaredBy !== 'hand') throw new Error(`illegal declared-layer source "${declaredBy}"`)
  if (declaredBy === 'hand' && !declaredByHuman) throw new Error('a hand-declared inventory must name the person who declared it')
  const ev = []

  // ── DECLARED layer
  // Two ways in, and they are NOT interchangeable. An FTC config XML was read
  // off a real hub and reconciled against real source; a hand-written inventory
  // is a person's list. The second never borrows the first's provenance, and
  // never claims a reconciliation that did not happen.
  if (declaredBy === 'hand') {
    ev.push(evidence('inventory-declared', 'PASS', 'human', 'declared-by-hand',
      `inventory "${configName}" declared by ${declaredByHuman}: ${devices.length} devices — a person's list, not read off the robot`))
  } else {
    ev.push(evidence('config-parsed', 'PASS', 'declared', 'xml-parse', `configuration "${configName}" parsed: ${devices.length} devices`))
    // Reconciling against ZERO source files is not a pass — it is a
    // reconciliation that never happened. It used to be recorded as PASS with
    // coverage.reconciled ✓, so a baseline built over an empty or wrong
    // --code folder looked identical to one built over real code.
    const nothingScanned = filesScanned === 0
    ev.push(evidence('config-code-reconciled', nothingScanned ? 'UNKNOWN' : 'PASS', 'declared', 'static-reconciliation',
      nothingScanned
        ? 'NO source files were scanned — nothing was reconciled against the configuration (check the --code path)'
        : `code↔config reconciliation ${checkVerdict}${checkFindingCounts ? ` (${checkFindingCounts.WARN ?? 0} WARN, ${checkFindingCounts.INFO ?? 0} INFO)` : ''}${filesScanned != null ? ` over ${filesScanned} source file(s)` : ''}`))
  }

  // ── OBSERVED layer — only what a robot report actually established.
  //
  // A report that is byte-identical to the one already folded into the
  // previous state is a RE-SUBMISSION, not a new measurement. Its rows are
  // still recorded (dropping them would make the hardware appear to vanish
  // and then reappear), but nothing it says can be a PASS: a resubmitted
  // file must never satisfy a recheck that was owed.
  const carried = new Set(carriedOver ?? [])
  const downgradeFrom = (startIdx, flag) => {
    if (!carried.has(flag)) return
    for (let i = startIdx; i < ev.length; i++) {
      if (ev[i].result !== 'PASS') continue
      ev[i] = { ...ev[i], result: 'UNKNOWN', summary: `${ev[i].summary} — CARRIED OVER from the previous state's ${flag} report, not re-measured` }
    }
  }
  const observed = {}
  const robotEvStart = ev.length
  if (robot) {
    observed.hubs = robot.hubs.map((h) => ({ address: h.address, firmware: normalizeFirmware(h.firmware) }))
    ev.push(evidence('hub-census', 'PASS', 'observed', 'lynx-census', `${observed.hubs.length} hub(s) answered: ${observed.hubs.map((h) => '@' + h.address).join(', ')}`))
    observed.sensors = []
    for (const s of robot.sensors ?? []) {
      const entry = { name: s.name, type: s.type, class: s.class, determinable: s.determinable, read: s.read }
      observed.sensors.push(entry)
      if (!s.determinable) {
        ev.push(evidence(`sensor-liveness:${s.name}`, 'UNKNOWN', 'observed', 'pin-read',
          `"${s.name}" (${s.class}) reads a value but liveness is NOT determinable — a floating pin looks identical`))
      } else if (s.read === 'ok') {
        ev.push(evidence(`sensor-liveness:${s.name}`, 'PASS', 'observed', 'i2c-read', `"${s.name}" answered`))
      } else if (s.read === 'zeros') {
        ev.push(evidence(`sensor-liveness:${s.name}`, 'UNKNOWN', 'observed', 'i2c-read', `"${s.name}" answered all zeros — confirm by hand`))
      } else {
        ev.push(evidence(`sensor-liveness:${s.name}`, 'FAIL', 'observed', 'i2c-read', `"${s.name}" did not answer`))
      }
    }
    // Physical fingerprints — measured references (gravity vector, tag pose).
    // The measurement is the evidence; whether a LATER measurement agrees is
    // detectChanges' question, judged only against an authored tolerance.
    if (robot.fingerprints?.length) {
      observed.fingerprints = robot.fingerprints.map((f) => ({ id: f.id, method: f.method, values: { ...f.values } }))
      for (const f of observed.fingerprints) {
        ev.push(evidence(`fingerprint:${f.id}`, 'PASS', 'observed', f.method,
          `physical reference captured: ${Object.entries(f.values).map(([k, v]) => `${k}=${+v.toFixed(4)}`).join(' ')}`))
      }
    }
  }
  downgradeFrom(robotEvStart, 'robot')
  const stimEvStart = ev.length
  if (stimulus) {
    observed.stimulus = { motors: [], servos: [] }
    for (const m of stimulus.motors ?? []) {
      observed.stimulus.motors.push({ name: m.name, result: m.result, deltaTicks: m.deltaTicks })
      if (m.result.startsWith('moved')) {
        ev.push(evidence(`motor-response:${m.name}`, 'PASS', 'observed', 'encoder-delta', `"${m.name}" ${m.result} (${m.deltaTicks} ticks)`))
      } else {
        // no-response is AMBIGUOUS (load vs unplugged) and interrupted was
        // never measured — both are UNKNOWN, and neither may become PASS.
        ev.push(evidence(`motor-response:${m.name}`, 'UNKNOWN', 'observed', 'encoder-delta', `"${m.name}" ${m.result} — not established`))
      }
    }
    for (const s of stimulus.servos ?? []) {
      observed.stimulus.servos.push({ name: s.name, confirmed: !!s.confirmed })
      ev.push(s.confirmed
        ? evidence(`servo-response:${s.name}`, 'PASS', 'human', 'visual-confirmation', `"${s.name}" movement confirmed by a human`)
        : evidence(`servo-response:${s.name}`, 'UNKNOWN', 'observed', 'none', `"${s.name}" has no feedback and was not confirmed`))
    }
  }

  downgradeFrom(stimEvStart, 'stimulus')

  // Recorded behavioral results (validation/robustness) fold in as evidence
  // with their human recorder — Nexum never ran them, and the state says so.
  if (results) {
    for (const r of results) {
      ev.push(evidence(`test:${r.testId}`, r.verdict, 'human', 'recorded-result',
        `${r.kind} test "${r.testId}"${r.value != null ? ` = ${r.value}` : ''}${r.threshold ? ` (threshold ${r.threshold.min != null ? '≥' + r.threshold.min : '≤' + r.threshold.max})` : ''} — recorded by ${r.recordedBy}`))
    }
  }

  // A FAIL row is RECORDED, never hidden — a baseline that honestly says "the
  // IMU was dead when we froze this" is worth more than a refusal that makes
  // the team save nothing. What must never happen is the SECOND half: such a
  // state used to render "VERIFIED FOR DEFINED CHECKS" forever, because the
  // status computation had no input for failing baseline evidence. The claim
  // is what gets refused (see `baselineFailures` in the status pipeline), not
  // the record.
  const state = {
    physyncState: 1,
    format: STATE_FORMAT,
    version,
    robotId,
    createdAt: now ?? new Date().toISOString(),
    engineVersion,
    // codeGit records the SOFTWARE state the verification happened against —
    // {sha, dirty} when the code dir is a git repo, absent otherwise (absence
    // is honest ignorance, never a claim the code didn't change).
    // codeDigest is a CONTENT hash of every source file scanned, so an
    // uncommitted edit (or a TeamCode folder that is not a git repo at all) is
    // still a detectable change. filesScanned records HOW MUCH was read, so a
    // state can never silently claim "reconciled" over an empty folder.
    declared: { configName, configSha256: sha256(configXml), devices, source: declaredBy, ...(declaredByHuman ? { declaredBy: declaredByHuman } : {}), ...(codeGit?.sha ? { codeGit: { sha: codeGit.sha, dirty: codeGit.dirty === true } } : {}), ...(codeDigest ? { codeDigest } : {}), ...(filesScanned != null ? { filesScanned } : {}), ...(reportDigests && Object.keys(reportDigests).length ? { reportDigests } : {}) },
    observed,
    coverage: {
      hubs: !!robot,
      sensors: !!robot,
      stimulus: !!stimulus,
      // A hand-declared inventory was never reconciled against source, and a
      // missing reconciliation is recorded as a coverage gap rather than left
      // to be mistaken for a passing one.
      reconciled: declaredBy === 'xml-parse',
    },
    evidence: ev,
  }
  state.stateDigest = digestOfState(state)
  return state
}

/** Fail-closed load: a state whose digest does not match its own contents is
 *  corruption, and corruption is treated as absence plus a loud error. */
export function validateState(raw) {
  if (raw == null || typeof raw !== 'object' || raw.physyncState !== 1) throw new Error('not a physync state file')
  if (raw.format !== STATE_FORMAT) throw new Error(`unsupported state format "${raw.format}"`)
  if (digestOfState(raw) !== raw.stateDigest) throw new Error(`state V${raw.version} failed its own integrity check — the file was edited or corrupted`)
  for (const e of raw.evidence ?? []) {
    if (!RESULTS.includes(e.result)) throw new Error(`state V${raw.version} carries an illegal evidence result "${e.result}"`)
  }
  return raw
}

export function listStates(dir = '.') {
  const statesDir = join(dir, STATES_DIR)
  if (!existsSync(statesDir)) return []
  const files = readdirSync(statesDir).filter((f) => /^V\d+\.json$/.test(f))
  return files
    .map((f) => {
      // A raw SyntaxError here told a team nothing and left them stuck: the
      // same unreadable file also blocked `state`, so they could not save a
      // new baseline to get moving again. Name the file and the way out.
      const raw = readFileSync(join(statesDir, f), 'utf8')
      let parsed
      try { parsed = JSON.parse(raw) } catch (e) {
        throw Object.assign(new Error(
          `${STATES_DIR}/${f} is not readable JSON (${e.message}).\n` +
          `A verified state is never edited by Nexum, so this is damage from outside — most often a write cut short by a laptop sleeping or losing power.\n` +
          `Nothing else is affected: your results, rules and checks are separate files.\n` +
          `To continue: move ${STATES_DIR}/${f} somewhere safe (do not delete it — it may be recoverable by hand), then run \`state\` again to record a fresh baseline from the robot you have now — Nexum will refuse to grade from an older state until you do, so you cannot be given a greener verdict by accident.`),
          // Diagnosed, not a crash: the handler must not tell a team to report
          // their own damaged file as a Nexum bug.
          { physyncDiagnosed: true })
      }
      return validateState(parsed)
    })
    .sort((a, b) => a.version - b.version)
}

export function latestState(dir = '.') {
  const all = listStates(dir)
  return all.length ? all[all.length - 1] : null
}

/** Coverage a state actually established, as a comparable set. */
const coveredLayers = (st) => Object.entries(st?.coverage ?? {}).filter(([, v]) => v === true).map(([k]) => k)

/** A new baseline must not quietly establish LESS than the one it replaces.
 *  A robot with a FAILING sensor row reads VALIDATION FAILED; one bare `state`
 *  with no --robot rebuilt the baseline from the declared layer alone, dropped
 *  the observed layer entirely, and the failure vanished — leaving VERIFIED and
 *  exit 0 on a robot with a dead sensor, permanently, because the new state is
 *  now the baseline. The project already refuses this for the legacy stimulus
 *  baseline; the state ledger that superseded it did not. */
export function assertNoCoverageRegression(prior, next) {
  if (!prior) return
  // Coverage is only comparable within one KIND of declared layer. A
  // hand-declared inventory has no hub or sensor census by nature, so a
  // parsed-config baseline followed by a hand-declared one is not a
  // regression — it is a different kind of baseline, which the tool already
  // refuses to COMPARE against the other (status rejects a cross-kind
  // comparison outright). Treating that switch as evidence loss blocked a
  // legitimate `state --declare` entirely.
  if ((prior.declared?.source ?? null) !== (next.declared?.source ?? null)) return
  // KNOWN GAP (not fixed): evidence ROWS can still vanish between states when
  // coverage is unchanged — a state carrying owed grasp-test rows, saved after
  // a run that re-derived none of them, drops them silently and status flips
  // from REVALIDATION REQUIRED to VERIFIED. A plain set-difference on row ids
  // over-fires, because a differing census legitimately changes which rows
  // exist; distinguishing "owed recheck lost" from "different coverage"
  // needs the planner's view, not this function's. Left open deliberately
  // rather than shipped half-right.
  const lost = coveredLayers(prior).filter((l) => !coveredLayers(next).includes(l))
  if (!lost.length) return

  // Narrower than "any coverage loss". Teams legitimately skip a layer between
  // cycles — not re-running the stimulus pass does not deserve a refusal, and
  // blocking it broke the documented loop. What must never happen is coverage
  // loss that takes a FAILING row with it: that is the case where a robot with
  // a dead sensor reads VALIDATION FAILED, one bare `state` drops the observed
  // layer, and the failure is erased into VERIFIED, permanently, because the
  // new state becomes the baseline.
  const nextIds = new Set((next.evidence ?? []).map((e) => e.id))
  const erasedFailures = (prior.evidence ?? [])
    .filter((e) => e.result === 'FAIL' && !nextIds.has(e.id))
    .map((e) => e.id)
  if (!erasedFailures.length) return
  const failing = erasedFailures
  throw Object.assign(new Error(
    `Refusing to save V${next.version}: it would establish LESS than V${prior.version}.\n` +
    (lost.length
      ? `V${prior.version} verified ${coveredLayers(prior).join(', ')}; this run covers ${coveredLayers(next).join(', ') || 'none of those'} — ${lost.join(' and ')} would stop being checked.\n`
      : '') +
    (failing.length
      ? `V${prior.version} also recorded FAILING evidence (${failing.join(', ')}). Saving this state would erase that failure and report the robot as verified.\n`
      : '') +
    `A measurement is never remembered between runs, so re-supply it: \`state --config <xml> --code <dir> --robot <physync-robot.json>\`.\n` +
    `If that coverage is genuinely gone for good, say so explicitly with \`state --accept-coverage-loss\`, which records the reduction instead of hiding it.`),
    { physyncDiagnosed: true })
}

/** Append-only save: refuses to overwrite ANY existing version file, ever. */
export function saveState(state, dir = '.', { acceptCoverageLoss = false } = {}) {
  if (!acceptCoverageLoss) assertNoCoverageRegression(latestState(dir), state)
  // A state must be able to pass its own integrity check BEFORE it is
  // written. Discovering corruption at the next load wedges the whole
  // ledger behind a false "the file was edited" accusation.
  validateState(JSON.parse(JSON.stringify(state)))
  const statesDir = join(dir, STATES_DIR)
  mkdirSync(statesDir, { recursive: true })
  const path = join(statesDir, `V${state.version}.json`)
  if (existsSync(path)) throw new Error(`V${state.version} already exists — verified states are never overwritten. The next version is V${nextVersion(dir)}.`)
  try {
    writeAtomicExclusive(path, JSON.stringify(state, null, 2))
  } catch (e) {
    if (e?.code === 'EEXIST') {
      throw Object.assign(new Error(
        `V${state.version} was created by another run while this one was working — nothing here was saved.\n` +
        `Two Nexum commands writing the same project at once can each believe they produced V${state.version}, and only one can.\n` +
        `Run \`states\` to see what is actually on record, then re-run if your change still needs saving.`),
        { physyncDiagnosed: true })
    }
    throw e
  }
  bumpHighWater(state.version, dir)
  return path
}

/** Refuse to start a SECOND ledger inside a project that already has one.
 *
 *  A team that `cd`s into their TeamCode folder to look at the source and then
 *  runs `state` creates a fresh `.physync` right there, saves its own V1, and
 *  `status` reports VERIFIED FOR DEFINED CHECKS against that empty fork — while
 *  the real history, with its changes and owed rechecks, sits one directory up
 *  being ignored. Two ledgers for one robot, and the newer one is always green
 *  because it has never seen anything. */
export function assertNotNestedProject(dir = '.') {
  if (existsSync(join(dir, '.physync'))) return   // this IS the project
  let cur = resolve(dir)
  for (let hops = 0; hops < 12; hops++) {
    const parent = dirname(cur)
    if (parent === cur) return                     // filesystem root
    cur = parent
    if (existsSync(join(cur, STATES_DIR))) {
      throw Object.assign(new Error(
        `This folder is inside a project that already has a Nexum history (${cur}).\n` +
        `Starting a second one here would give you two ledgers for one robot — and the new one reports VERIFIED simply because it has never seen anything.\n` +
        `Run the command from ${cur} instead. Your config and code can live anywhere; just point --config and --code at them from there.`),
        { physyncDiagnosed: true })
    }
  }
}

export const LEDGER_MARKER = '.physync/ledger.json'

// THE HIGH-WATER MARK. listStates reads whatever V<n>.json files happen to be
// on disk, so a missing newest state is indistinguishable from one that never
// existed. That is not a cosmetic gap: a robot whose V2 recorded a FAILING
// sensor reads VALIDATION FAILED (exit 2); move V2.json aside and the very
// same robot reads VERIFIED FOR DEFINED CHECKS (exit 0), because the
// comparison silently rebases onto V1. The worse the damage to the record,
// the greener the verdict — the exact inversion this tool exists to prevent.
//
// Reachable without any tampering: a sync tool restoring an older folder, a
// student tidying files, a crash — and, worst of all, Nexum's own torn-state
// message, which tells a team to move the unreadable state aside.
export function readHighWater(dir = '.') {
  const path = join(dir, LEDGER_MARKER)
  if (!existsSync(path)) return null          // pre-marker project: behave as before
  try {
    const m = JSON.parse(readFileSync(path, 'utf8'))
    return Number.isInteger(m?.highWaterVersion) ? m.highWaterVersion : null
  } catch { return null }                      // an unreadable marker must not block work
}

function bumpHighWater(version, dir = '.') {
  const path = join(dir, LEDGER_MARKER)
  const current = readHighWater(dir) ?? 0
  if (version <= current) return
  mkdirSync(join(dir, '.physync'), { recursive: true })
  writeAtomic(path, JSON.stringify({ format: 'physync-ledger-v1', highWaterVersion: version, updatedAt: new Date().toISOString() }, null, 2))
}

/** Throws if the newest verified state this project ever reached is no longer
 *  on disk. Every surface that grades a robot calls this first. */
export function assertLedgerIntact(dir = '.') {
  const high = readHighWater(dir)
  if (high == null) return
  const present = latestState(dir)?.version ?? 0
  if (present >= high) return
  throw Object.assign(new Error(
    `This project reached verified state V${high}, but the newest one on disk is ${present ? `V${present}` : 'none'}.\n` +
    `Nexum will NOT compare against an older baseline: V${high} may have recorded failures or coverage that V${present || 0} never had, so answering from V${present || 0} could report a damaged robot as verified.\n` +
    `Either restore ${STATES_DIR}/V${high}.json (a backup, your sync tool's history, or wherever it was moved), or — if it is genuinely gone — run \`state\` to record a NEW baseline from the robot you have now, which will become V${high + 1}.`),
    { physyncDiagnosed: true })
}

export const nextVersion = (dir = '.') => (latestState(dir)?.version ?? 0) + 1

/** Absorb the legacy single-slot artifacts into V1 — files left untouched.
 *  Anything the legacy layer never established is honest coverage-absence,
 *  not invented evidence. */
export function migrateLegacy(dir = '.', { engineVersion } = {}) {
  if (listStates(dir).length > 0) return null // already on the ledger
  const approvedPath = join(dir, '.physync/approved.json')
  if (!existsSync(approvedPath)) return null
  let approval
  try { approval = JSON.parse(readFileSync(approvedPath, 'utf8')) } catch { return null }
  if (approval?.physyncApproval !== 1) return null

  const state = {
    physyncState: 1,
    format: STATE_FORMAT,
    version: 1,
    robotId: 'robot',
    createdAt: approval.createdAt ?? new Date().toISOString(),
    engineVersion: engineVersion ?? approval.engineVersion,
    origin: 'legacy-approval',
    declared: { configName: approval.configName, configSha256: approval.configSha256, devices: approval.devices ?? [] },
    observed: approval.hubsVerified ? { hubs: approval.hubs } : {},
    coverage: { hubs: !!approval.hubsVerified, sensors: false, stimulus: false },
    evidence: [
      evidence('config-parsed', 'PASS', 'declared', 'legacy-approval', `absorbed from approved.json (${approval.configName})`),
      evidence('config-code-reconciled', 'PASS', 'declared', 'legacy-approval', 'approval required a passing check at the time it was recorded'),
      ...(approval.hubsVerified
        ? [evidence('hub-census', 'PASS', 'observed', 'legacy-approval', `${approval.hubs.length} hub(s) recorded at approval`)]
        : []),
    ],
  }
  state.stateDigest = digestOfState(state)
  saveState(state, dir)
  return state
}

// ── CHANGE DETECTION ────────────────────────────────────────────────────────
// Unified Change records: what moved, both values, which layer the knowledge
// came from, and by what method. Declared changes are read from files;
// observed changes come from a robot report — the record says which, always.

let changeSeq = 0
const change = (kind, component, previous, current, source, method, at) => ({
  id: `chg-${++changeSeq}`,
  kind, component, previous, current, source, method,
  at: at ?? new Date().toISOString(),
})

/** Compare the latest verified state against a candidate collection.
 *  candidate = { configName?, configXml?, hubs?, sensors? } — anything absent
 *  is reported as a coverage gap, never assumed unchanged. */
/**
 * Which baseline evidence ids did THIS run's inputs genuinely re-establish?
 *
 * Deliberately conservative: a row counts as re-derived only when the fresh
 * observation produces the same PASSING fact again. A report that omits a
 * sensor, shows it erroring, reads all-zeros, or that re-measured a
 * fingerprint and found it drifted re-derives NOTHING about that row — the
 * baseline's PASS stays in doubt and its recheck stays owed. (Supplying a
 * robot report used to satisfy the whole preflight family wholesale, which
 * relabelled refuted and missing evidence as "re-derived by this run".)
 */
export function rederivedFrom(state, candidate, changes = []) {
  const out = new Set()
  if (candidate.hubs == null) return out
  // The census is re-derived only when nothing about the hubs moved: a
  // vanished hub or changed firmware means the fresh census CONTRADICTS the
  // row rather than confirming it.
  const hubsDisturbed = changes.some((c) => /^(hub-missing|hub-added|firmware-changed)$/.test(c.kind))
  if (!hubsDisturbed && candidate.hubs.length) out.add('hub-census')
  const priorSensors = new Map((state.observed?.sensors ?? []).map((s) => [s.name, s]))
  const declaredType = new Map((candidate.devices ?? []).map((d) => [d.name, d.type]))
  for (const s of candidate.sensors ?? []) {
    // determinable + answered = a fresh PASS for that sensor. Anything else
    // (zeros, error, a hub pin whose liveness is never determinable) is a
    // fresh UNKNOWN or FAIL, which re-derives no prior PASS.
    if (!(s.determinable && s.read === 'ok')) continue
    // IDENTITY: "the same fact again" requires the same DEVICE. A different
    // part answering at the same name re-derives nothing — it contradicts the
    // row. (This let a report saying "camera is a RevColorSensorV3" mark the
    // HuskyLens evidence RE-DERIVED, then freeze it as a verified PASS.)
    const prior = priorSensors.get(s.name)
    if (prior && prior.type && s.type && prior.type !== s.type) continue
    // And it must still be the device the CONFIG declares at that name.
    const dt = declaredType.get(s.name)
    if (dt && s.type && dt !== s.type) continue
    out.add(`sensor-liveness:${s.name}`)
  }
  const drifted = new Set(changes.filter((c) => c.kind === 'fingerprint-drift').map((c) => c.component))
  for (const f of candidate.fingerprints ?? []) {
    const id = `fingerprint:${f.id}`
    if (!drifted.has(id)) out.add(id)
  }
  return out
}

export function detectChanges(state, candidate, { now, fingerprintDefs = [] } = {}) {
  const changes = []
  const gaps = []

  if (candidate.configXml != null) {
    const candSha = sha256(candidate.configXml)
    if (candidate.configName != null && candidate.configName !== state.declared.configName) {
      changes.push(change('config-renamed', 'configuration', state.declared.configName, candidate.configName, 'declared', 'filename', now))
    } else if (candSha !== state.declared.configSha256) {
      changes.push(change('config-changed', 'configuration', state.declared.configSha256.slice(0, 12) + '…', candSha.slice(0, 12) + '…', 'declared', 'byte-sha256', now))
    }
    // Device-level localization — the minimum-revalidation planner is only
    // "minimum" if a moved servo port invalidates THAT servo's evidence, not
    // the whole robot. Byte-sha proves change happened; this names where.
    if (candidate.devices != null) {
      const prior = new Map(state.declared.devices.map((d) => [d.name, d]))
      const seen = new Map(candidate.devices.map((d) => [d.name, d]))
      for (const [name, d] of prior) {
        const c = seen.get(name)
        if (!c) changes.push(change('device-removed', `device "${name}"`, `${d.type} port ${d.port}`, null, 'declared', 'config-device-map', now))
        else {
          if (c.type !== d.type) changes.push(change('device-type-changed', `device "${name}"`, d.type, c.type, 'declared', 'config-device-map', now))
          if (c.port !== d.port || (c.bus ?? null) !== (d.bus ?? null)) {
            changes.push(change('device-port-moved', `device "${name}"`,
              `port ${d.port}${d.bus != null ? ` bus ${d.bus}` : ''}`, `port ${c.port}${c.bus != null ? ` bus ${c.bus}` : ''}`, 'declared', 'config-device-map', now))
          }
        }
      }
      for (const [name, c] of seen) {
        if (!prior.has(name)) changes.push(change('device-added', `device "${name}"`, null, `${c.type} port ${c.port}`, 'declared', 'config-device-map', now))
      }
    }
  } else {
    gaps.push('configuration (no config supplied)')
  }

  // Software state. The CONTENT digest is authoritative because it needs no
  // git: an uncommitted edit, or a TeamCode folder that was never a repo,
  // changes it. (Before this, a code-only change — the single most common
  // real change an FTC team makes — was reported as "0 change(s)".) The git
  // sha is kept as a second, more legible signal when both sides have one.
  if (candidate.codeDigest && state.declared.codeDigest && candidate.codeDigest !== state.declared.codeDigest) {
    const gitNote = candidate.codeGit?.sha && state.declared.codeGit?.sha
      ? ` (git ${state.declared.codeGit.sha.slice(0, 8)} → ${candidate.codeGit.sha.slice(0, 8)}${candidate.codeGit.dirty ? ', uncommitted edits' : ''})`
      : candidate.codeGit?.dirty ? ' (uncommitted edits)' : ''
    changes.push(change('software-changed', 'software',
      state.declared.codeDigest.slice(0, 12) + '…',
      candidate.codeDigest.slice(0, 12) + '…' + gitNote,
      'declared', 'source-content-sha256', now))
  } else if (candidate.codeGit?.sha && state.declared.codeGit?.sha && candidate.codeGit.sha !== state.declared.codeGit.sha) {
    changes.push(change('software-changed', 'software',
      state.declared.codeGit.sha.slice(0, 12) + (state.declared.codeGit.dirty ? ' (dirty)' : ''),
      candidate.codeGit.sha.slice(0, 12) + (candidate.codeGit.dirty ? ' (dirty)' : ''),
      'declared', 'git', now))
  }

  if (candidate.hubs != null) {
    const prior = new Map((state.observed.hubs ?? []).map((h) => [h.address, h.firmware]))
    const seen = new Map(candidate.hubs.map((h) => [h.address, normalizeFirmware(h.firmware)]))
    for (const [address, fw] of prior) {
      if (!seen.has(address)) changes.push(change('hub-missing', `hub @${address}`, fw, null, 'observed', 'lynx-census', now))
      else if (seen.get(address) !== fw) changes.push(change('firmware-changed', `hub @${address}`, fw, seen.get(address), 'observed', 'lynx-census', now))
    }
    for (const [address, fw] of seen) {
      if (!prior.has(address)) changes.push(change('hub-added', `hub @${address}`, null, fw, 'observed', 'lynx-census', now))
    }
  } else if (state.coverage.hubs) {
    gaps.push('hub census (state has hub evidence; no robot report supplied)')
  }

  if (candidate.sensors != null) {
    const prior = new Map((state.observed.sensors ?? []).map((s) => [s.name, s]))
    const seen = new Map(candidate.sensors.map((s) => [s.name, s]))
    for (const [name, s] of prior) {
      const c = seen.get(name)
      if (!c) changes.push(change('sensor-missing', `sensor "${name}"`, s.type, null, 'observed', 'liveness-read', now))
      else if (c.type !== s.type) changes.push(change('sensor-type-changed', `sensor "${name}"`, s.type, c.type, 'observed', 'liveness-read', now))
      else if (s.determinable && s.read === 'ok' && c.determinable && c.read !== 'ok') {
        changes.push(change('sensor-response-lost', `sensor "${name}"`, 'answering', c.read, 'observed', 'liveness-read', now))
      }
    }
    for (const [name, c] of seen) {
      if (!prior.has(name)) changes.push(change('sensor-added', `sensor "${name}"`, null, c.type, 'observed', 'liveness-read', now))
    }
    // DECLARED ↔ OBSERVED. Until now the two layers were only ever compared
    // against their own past, never against each other — so the config could
    // declare a sensor the robot has never reported and nothing said a word,
    // or the robot could answer with a different PART than the config names
    // and the state recorded both contradictory facts as fine. This is the
    // product's own tagline ("the robot you built is the robot your software
    // thinks you built") and it was the one comparison nobody ran.
    // Only when the report ACTUALLY carried a census. An empty sensors list
    // means "no census was taken" (a hub- or fingerprint-only report), not
    // "the census found nothing" — the format cannot distinguish them, and
    // claiming a gap for every declared sensor on every such run is noise
    // that teaches a team to ignore the one time it matters.
    const I2C_SENSOR = /Color|Distance|Husky|Imu|Gyro|2m|OTOS|Navx|Potentiometer|Touch|Limit/i
    for (const d of (candidate.sensors.length ? candidate.devices ?? [] : [])) {
      if (!I2C_SENSOR.test(d.type ?? '')) continue // motors/servos never appear in a liveness report
      const obs = seen.get(d.name)
      if (!obs) {
        gaps.push(`device "${d.name}" (${d.type}) is DECLARED in the configuration but does not appear in the robot report — nothing was established about it`)
      } else if (obs.type && d.type && obs.type !== d.type) {
        changes.push(change('declared-observed-mismatch', `device "${d.name}"`,
          `configuration declares ${d.type}`, `robot reports ${obs.type}`, 'observed', 'declared-vs-observed', now))
      }
    }
  } else if (state.coverage.sensors) {
    gaps.push('sensor liveness (state has sensor evidence; no robot report supplied)')
  }

  // Stimulus evidence is NEVER statically comparable — a fresh run is the
  // only comparison. But under the invalidation model, standing evidence
  // persists until a change invalidates it: an unchanged robot does not lose
  // its behavioral evidence just because today's inputs cannot re-derive it.
  // So this is STANDING (informational), not a status-driving gap. Phase 3's
  // invalidation engine is what converts a relevant change into "stimulus
  // re-run REQUIRED".
  const standing = []
  if (state.coverage.stimulus) {
    standing.push('stimulus responses from V' + state.version + ' (persist until a change invalidates them; only a fresh stimulus run re-derives them)')
  }

  // Physical fingerprints: drift beyond an AUTHORED tolerance is a change,
  // agreement is standing, and anything unmeasured or unjudgeable is a
  // stated gap — never silently "unchanged". candidate.fingerprints is null
  // when no robot report was supplied, [] when a report had none.
  const fp = compareFingerprints({
    prior: state.observed.fingerprints ?? [],
    current: candidate.fingerprints ?? null,
    defs: fingerprintDefs,
    now,
  })
  changes.push(...fp.changes)
  gaps.push(...fp.gaps)
  standing.push(...fp.standing)

  return { changes, gaps, standing }
}

// ── DEPLOYMENT STATUS ───────────────────────────────────────────────────────
// Deliberately NOT "safe/unsafe" — these four statuses claim exactly what the
// evidence supports and nothing more. Priority: a hard FAIL outranks change,
// change outranks a coverage gap, and only a clean, covered, unchanged robot
// is VERIFIED FOR DEFINED CHECKS.

export function deploymentStatus({ failFindings = 0, changes = [], gaps = [], unknownRequired = 0, mappedOutcomes = null }) {
  if (failFindings > 0) return STATUSES.FAILED
  // `mappedOutcomes` counts everything the planner ESTABLISHED: evidence put in
  // question, checks demanded, and checks this run already satisfied. Zero of
  // all three, with changes present, is the only case where Nexum genuinely
  // could not say anything.
  //
  // It deliberately is NOT "required is empty". A demand that this very run
  // satisfied also leaves `required` empty, and reporting that as "impact not
  // mapped" would tell a team "I cannot tell you anything" when the truth is
  // "I checked, and it is fine" — a worse lie than the one being fixed.
  // Null means the caller computed no plan, so the old behaviour stands.
  if (changes.length > 0 && mappedOutcomes === 0) return STATUSES.UNMAPPED
  if (changes.length > 0) return STATUSES.REVALIDATION
  if (gaps.length > 0 || unknownRequired > 0) return STATUSES.INCOMPLETE
  return STATUSES.VERIFIED
}

// UNMAPPED exits 3 like the other non-clean states: the robot changed and
// nothing established that it was safe, which is not success.
export const statusExitCode = (status) =>
  status === STATUSES.VERIFIED ? 0 : status === STATUSES.FAILED ? 2 : 3
