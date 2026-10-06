// Versioned Verified Robot States — the Phase-2 core of the new direction.
//
// A verified state is an immutable, digest-protected snapshot of everything
// PHYSYNC knew about a robot at a moment a human vouched for it: the DECLARED
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
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
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
export function buildVerifiedState({ robotId = 'robot', version, configName, configXml, devices, checkVerdict, checkFindingCounts, robot, stimulus, results, engineVersion, now, declaredBy = 'xml-parse', declaredByHuman = null, codeGit = null }) {
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
    ev.push(evidence('config-code-reconciled', 'PASS', 'declared', 'static-reconciliation',
      `code↔config reconciliation ${checkVerdict}${checkFindingCounts ? ` (${checkFindingCounts.WARN ?? 0} WARN, ${checkFindingCounts.INFO ?? 0} INFO)` : ''}`))
  }

  // ── OBSERVED layer — only what a robot report actually established.
  const observed = {}
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

  // Recorded behavioral results (validation/robustness) fold in as evidence
  // with their human recorder — PHYSYNC never ran them, and the state says so.
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
    declared: { configName, configSha256: sha256(configXml), devices, source: declaredBy, ...(declaredByHuman ? { declaredBy: declaredByHuman } : {}), ...(codeGit?.sha ? { codeGit: { sha: codeGit.sha, dirty: codeGit.dirty === true } } : {}) },
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
    .map((f) => validateState(JSON.parse(readFileSync(join(statesDir, f), 'utf8'))))
    .sort((a, b) => a.version - b.version)
}

export function latestState(dir = '.') {
  const all = listStates(dir)
  return all.length ? all[all.length - 1] : null
}

/** Append-only save: refuses to overwrite ANY existing version file, ever. */
export function saveState(state, dir = '.') {
  // A state must be able to pass its own integrity check BEFORE it is
  // written. Discovering corruption at the next load wedges the whole
  // ledger behind a false "the file was edited" accusation.
  validateState(JSON.parse(JSON.stringify(state)))
  const statesDir = join(dir, STATES_DIR)
  mkdirSync(statesDir, { recursive: true })
  const path = join(statesDir, `V${state.version}.json`)
  if (existsSync(path)) throw new Error(`V${state.version} already exists — verified states are never overwritten. The next version is V${nextVersion(dir)}.`)
  writeFileSync(path, JSON.stringify(state, null, 2))
  return path
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
  for (const s of candidate.sensors ?? []) {
    // determinable + answered = a fresh PASS for that sensor. Anything else
    // (zeros, error, a hub pin whose liveness is never determinable) is a
    // fresh UNKNOWN or FAIL, which re-derives no prior PASS.
    if (s.determinable && s.read === 'ok') out.add(`sensor-liveness:${s.name}`)
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

  // Software state — compared only when BOTH sides recorded a git sha (the
  // UI can't know the code's repo; a missing side is ignorance, not a change).
  if (candidate.codeGit?.sha && state.declared.codeGit?.sha && candidate.codeGit.sha !== state.declared.codeGit.sha) {
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

export function deploymentStatus({ failFindings = 0, changes = [], gaps = [], unknownRequired = 0 }) {
  if (failFindings > 0) return STATUSES.FAILED
  if (changes.length > 0) return STATUSES.REVALIDATION
  if (gaps.length > 0 || unknownRequired > 0) return STATUSES.INCOMPLETE
  return STATUSES.VERIFIED
}

export const statusExitCode = (status) =>
  status === STATUSES.VERIFIED ? 0 : status === STATUSES.FAILED ? 2 : 3
