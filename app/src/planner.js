// Invalidation engine + minimum-revalidation planner — Phase 3's payoff.
//
// Input: Phase-2 Change records, the verified state they were measured
// against, and the dependency graph. Output, in order:
//   1. INVALIDATED — which of the state's evidence items these changes
//      killed, each with its why-trace (change ids + edge ids)
//   2. REQUIRED   — the MINIMUM set of revalidation actions: overlapping
//      requirements from multiple changes are deduplicated (camera→{1,2,3}
//      + software→{2,3,4} ⇒ run {1,2,3,4}, not seven runs), and evidence
//      re-derived by THIS run's inputs is marked satisfied, not demanded
//   3. Reached graph nodes with no recorded evidence (a test: or
//      calibration: node someone wired in) become requirements too — being
//      in the graph makes them a defined check; having no result makes them
//      UNKNOWN, and UNKNOWN never passes silently.

import { traverse, matchNode, expandTarget, effectiveEdges } from './graph.js'

// ── Machine-readable reason codes ───────────────────────────────────────────
// The smallest taxonomy that covers every path a demand can actually travel in
// this system. Each code is DERIVED from the why-trace the planner already
// computes — never asserted independently of it — so a code can always be
// expanded back into its edges and changes. Do not add codes speculatively:
// a new code is justified only by a new kind of edge or change.
export const REASON_CODES = {
  DIRECT_COMPONENT_CHANGE: 'the changed component is what this evidence measured',
  DEPENDENCY_CHANGED: 'a dependency of this evidence changed (via human-approved edges)',
  CONFIGURATION_CHANGED: 'the declared configuration this evidence was derived from changed',
  FIRMWARE_CHANGED: 'firmware changed after this evidence was collected',
  SOFTWARE_CHANGED: 'the code\'s git commit moved after this evidence was collected',
  PHYSICAL_CHANGE_REPORTED: 'a named person reported a physical change touching this evidence\'s dependencies',
  MEASURED_DRIFT: 'a physical fingerprint drifted past its human-authored tolerance',
  CALIBRATION_STALE: 'a calibration this evidence was validated through needs review',
  INSUFFICIENT_EVIDENCE: 'a relationship has been proposed but no human has ruled on it',
}

/** Evidence ids whose re-derivation is the reconciliation itself. */
const CONFIG_EVIDENCE = /^(config-parsed|config-code-reconciled|inventory-declared)$/

/** Derive the single most specific reason code for one (evidence, trace)
 *  pair. Precedence is from most to least physically specific; every branch
 *  reads only facts already present in the trace. */
export function reasonCodeFor(evidenceId, trace, changeById) {
  const causes = [...trace.because].map((id) => changeById.get(id)).filter(Boolean)
  // Most physically specific first; each branch reads only trace facts.
  if (causes.some((c) => c.kind === 'fingerprint-drift')) return 'MEASURED_DRIFT'
  if (causes.some((c) => c.kind === 'firmware-changed')) return 'FIRMWARE_CHANGED'
  if (causes.some((c) => c.kind === 'physical-change-reported')) return 'PHYSICAL_CHANGE_REPORTED'
  if (causes.some((c) => c.kind === 'software-changed')) return 'SOFTWARE_CHANGED'
  // Demand that arrived FROM a calibration node: this evidence was validated
  // through a calibration that is itself in doubt — the stale middleman is
  // the useful fact. Nodes deeper down a chain get DEPENDENCY_CHANGED, which
  // is also true and less specific.
  if (!evidenceId.startsWith('calibration:') &&
      [...(trace.fromNodes ?? [])].some((n) => n.startsWith('calibration:'))) {
    return 'CALIBRATION_STALE'
  }
  if (CONFIG_EVIDENCE.test(evidenceId)) return 'CONFIGURATION_CHANGED'
  // A built-in per-component family edge means the evidence IS about the
  // changed component (motor entry → that motor's response).
  if ([...trace.via].some((edgeId) => edgeId.startsWith('ftc:device-') || edgeId.startsWith('ftc:sensor-') ||
      edgeId.startsWith('ftc:hub-') || edgeId.startsWith('generic:device-'))) {
    return 'DIRECT_COMPONENT_CHANGE'
  }
  return 'DEPENDENCY_CHANGED'
}

/** Map a Phase-2 Change record to the component node ids it touches. */
export function componentsOf(change) {
  switch (change.kind) {
    case 'config-changed':
    case 'config-renamed':
      return ['configuration']
    case 'device-added':
    case 'device-removed':
    case 'device-type-changed':
    case 'device-port-moved':
      return [`device:${change.component.match(/"([^"]+)"/)?.[1] ?? change.component}`]
    case 'hub-missing':
    case 'hub-added':
      return [`hub:${change.component.replace('hub ', '')}`]
    case 'firmware-changed':
      return [`firmware:${change.component.replace('hub ', '')}`, `hub:${change.component.replace('hub ', '')}`]
    case 'sensor-missing':
    case 'sensor-added':
    case 'sensor-type-changed':
    case 'sensor-response-lost':
      return [`sensor:${change.component.match(/"([^"]+)"/)?.[1] ?? change.component}`]
    // A person reported a physical change no file records (a re-aimed camera
    // mount, a re-tensioned belt). They named the graph node themselves, so it
    // is used verbatim — and like every other change it can only reach evidence
    // through APPROVED edges. Naming a node invents no dependency: if nothing
    // approved leads out of it, this produces no requirements and surfaces as
    // an unmapped change for a human to judge.
    case 'physical-change-reported':
      return [change.component]
    // The code's git commit moved. 'software' is a graph node like any other:
    // no built-in edges lead out of it (a fresh check re-derives the
    // reconciliation anyway), but teams can approve edges like
    // software → test:autonomous-run when their judgment says so.
    case 'software-changed':
      return ['software']
    // A physical fingerprint drifted past its AUTHORED tolerance — a MEASURED
    // physical change (gravity vector, tag pose). The component is already
    // the fingerprint node id; like every change, it reaches evidence only
    // through approved edges, else it surfaces for hand review.
    case 'fingerprint-drift':
      return [change.component]
    default:
      // An unrecognized change kind still deserves a conservative mapping:
      // it maps to nothing (no invented edges), but the caller surfaces it.
      return []
  }
}

/** A Change record as one plain sentence — for humans reading a plan, so
 *  nobody has to decode `physical-change-reported (camera-position)` to learn
 *  that a person re-aimed the camera. The machine trace (`kind (component)`)
 *  stays untouched in `because` for JSON consumers; this feeds
 *  `becauseHuman`. Facts only — every clause comes from the record. */
export function describeChange(c) {
  if (!c) return null
  const delta = c.previous != null && c.current != null ? `${c.previous} → ${c.current}` : null
  switch (c.kind) {
    case 'physical-change-reported':
      return `${c.by ?? 'someone'} reported a physical change to ${c.component}${c.note ? ` ("${c.note}")` : ''}`
    case 'config-changed': return 'the configuration file\'s contents changed'
    case 'config-renamed': return `the active configuration was renamed (${delta})`
    case 'device-added': return `${c.component} was added to the configuration (${c.current})`
    case 'device-removed': return `${c.component} was removed from the configuration (was ${c.previous})`
    case 'device-type-changed': return `${c.component} changed type: ${delta}`
    case 'device-port-moved': return `${c.component} moved: ${delta}`
    case 'hub-missing': return `${c.component} stopped answering the census (was firmware ${c.previous})`
    case 'hub-added': return `${c.component} appeared on the census (firmware ${c.current})`
    case 'firmware-changed': return `${c.component} firmware changed: ${delta}`
    case 'sensor-missing': return `${c.component} vanished from the robot report (was ${c.previous})`
    case 'sensor-added': return `${c.component} appeared on the robot report (${c.current})`
    case 'sensor-type-changed': return `${c.component} changed type: ${delta}`
    case 'sensor-response-lost': return `${c.component} stopped answering (was ${c.previous}, now reads ${c.current})`
    case 'fingerprint-drift': return `measured physical drift on ${c.component}${c.detail ? ` — ${c.detail}` : delta ? ` (${delta})` : ''}`
    case 'software-changed': return `the code's git commit moved: ${delta}`
    default: return `${c.kind} (${c.component})`
  }
}

// ── Applicability + machine-readable reasons ────────────────────────────────
// A check RESULT (PASS/FAIL/UNKNOWN) is what happened when the check ran — it
// is historical and never changes. APPLICABILITY is whether that historical
// result still describes TODAY'S robot, and it changes every time the robot
// does. The two must never blur: yesterday's PASS stays PASS forever; what a
// change touches is its applicability.
export const APPLICABILITY = Object.freeze({
  APPLICABLE: 'APPLICABLE',    // no known dependency connects it to any change
  REVALIDATE: 'REVALIDATE',    // an ACTIVE dependency connects it to a change
  UNKNOWN: 'UNKNOWN',          // only a PROPOSED (unapproved) dependency connects it — insufficient information, and saying so is the honest output
  REDERIVED: 'RE-DERIVED',     // this very run's inputs re-established it
})

/** Group an evidence/artifact node id into the action that re-derives it.
 *
 *  EXTRACTION POINT (adapter labels): the action IDS here are generic
 *  re-derivation categories — reconcile declared-vs-code ('check'), re-census
 *  the buses/sensors ('preflight'), re-measure actuator response
 *  ('stimulus'), re-confirm a hand declaration ('declare'), redo a
 *  calibration or test. The LABEL strings, however, name FTC tooling
 *  ("Preflight OpMode", a bench with wheels off the ground). When a second
 *  platform grows a real adapter, the labels move to an adapter-supplied
 *  table keyed by these action ids; the ids and this grouping stay. Not done
 *  now on purpose — one platform, no benefit, dozens of label assertions. */
export function actionFor(nodeId) {
  if (nodeId === 'config-parsed' || nodeId === 'config-code-reconciled') {
    return { action: 'check', label: 'physync check (config↔code reconciliation)' }
  }
  if (nodeId === 'inventory-declared') {
    // Nothing PHYSYNC runs re-derives this. A person wrote the list; a person
    // has to walk the robot and confirm the list still matches it.
    return { action: 'declare', label: 'confirm the declared inventory against the physical robot, then save a new state with --declare' }
  }
  if (nodeId === 'hub-census' || nodeId.startsWith('sensor-liveness:')) {
    return { action: 'preflight', label: 'PHYSYNC Preflight OpMode → fresh physync-robot.json' }
  }
  if (nodeId.startsWith('motor-response:') || nodeId.startsWith('servo-response:')) {
    return { action: 'stimulus', label: 'PHYSYNC Stimulus pass (bench, wheels off the ground)' }
  }
  if (nodeId.startsWith('calibration:')) {
    return { action: `calibration:${nodeId.slice('calibration:'.length)}`, label: `redo calibration "${nodeId.slice('calibration:'.length)}"` }
  }
  if (nodeId.startsWith('test:')) {
    return { action: `test:${nodeId.slice('test:'.length)}`, label: `re-run test "${nodeId.slice('test:'.length)}"` }
  }
  return { action: `rederive:${nodeId}`, label: `re-derive "${nodeId}"` }
}

/**
 * The whole Phase-3 computation.
 *   state      the verified state changes were measured against
 *   changes    Phase-2 Change records
 *   graph      loadGraph() result (provenance already enforced)
 *   satisfiedActions  actions whose evidence THIS run's inputs re-derive
 *                     (e.g. status ran check → 'check'; --robot supplied →
 *                     'preflight'). The planner marks, never silently drops.
 */
export function plan({ state, changes, graph, satisfiedActions = new Set() }) {
  const evidenceIds = new Set(state.evidence.map((e) => e.id))
  // The id universe for wildcard expansion: real evidence plus every node
  // mentioned by an effective edge (so custom test:/calibration: chains
  // resolve even before any result was ever recorded).
  const universe = new Set(evidenceIds)
  for (const e of [...graph.builtin, ...graph.custom]) {
    if (!e.to.includes('*') && !e.to.includes('$n')) universe.add(e.to)
    if (!e.from.includes('*') && !e.from.includes('$n')) universe.add(e.from)
  }

  const changedComponents = changes.flatMap((c) => componentsOf(c).map((componentId) => ({ componentId, changeId: c.id })))
  const unmapped = changes.filter((c) => componentsOf(c).length === 0)
  const reached = traverse(graph, changedComponents, universe)
  // A change can map to a component and still reach no evidence at all — the
  // node has no approved edge out of it, or every edge it follows lands on a
  // built-in family this device never belonged to. That change invalidated
  // nothing, and saying nothing about it reads as "nothing to do here". It is
  // the same silence `unmapped` exists to prevent, one step further along.
  const productive = new Set()

  const changeById = new Map(changes.map((c) => [c.id, c]))
  const invalidated = []
  const requirements = new Map() // action → { label, targets: [], because: Set }

  // Built-in evidence families are typed by what the robot actually recorded:
  // a device:$n template fans out to motor/servo/sensor targets blindly, so a
  // reached family node with NO recorded evidence means "this device was
  // never that kind of thing" — it invalidates nothing and demands nothing.
  // Custom test:/calibration: nodes are the opposite: being wired into the
  // graph makes them defined checks, so no recorded result = UNKNOWN =
  // REQUIRED. (A servo never owes a motor test; a wired-in low-light test is
  // owed even before its first run.)
  const BUILTIN_FAMILY = /^(motor-response|servo-response|sensor-liveness):|^(config-parsed|config-code-reconciled|hub-census|inventory-declared)$/

  for (const [nodeId, trace] of reached) {
    const isComponent = nodeId === 'configuration' || /^(device|hub|firmware|sensor):/.test(nodeId)
    if (isComponent) continue // components change; they aren't evidence to kill
    const hasEvidence = evidenceIds.has(nodeId)
    if (!hasEvidence && BUILTIN_FAMILY.test(nodeId)) continue
    const because = [...trace.because].map((id) => {
      const c = changeById.get(id)
      return c ? `${c.kind} (${c.component})` : id
    })
    const becauseHuman = [...trace.because].map((id) => describeChange(changeById.get(id)) ?? id)
    if (hasEvidence) {
      invalidated.push({ evidenceId: nodeId, via: [...trace.via], because, becauseHuman })
    }
    const { action, label } = actionFor(nodeId)
    if (!requirements.has(action)) requirements.set(action, { action, label, targets: [], because: new Set(), becauseHuman: new Set(), becauseIds: new Set(), via: new Set(), reasonCodes: new Set(), satisfied: satisfiedActions.has(action), rank: Infinity })
    const req = requirements.get(action)
    req.reasonCodes.add(reasonCodeFor(nodeId, trace, changeById))
    req.targets.push(nodeId + (hasEvidence ? '' : ' (no recorded result — UNKNOWN)'))
    // BFS insertion order in `reached` approximates dependency depth from the
    // changed components — the earliest-reached target orders its action
    // upstream of later ones (calibration before the test that consumes it).
    req.rank = Math.min(req.rank, [...reached.keys()].indexOf(nodeId))
    for (const b of because) req.because.add(b)
    for (const b of becauseHuman) req.becauseHuman.add(b)
    for (const v of trace.via) req.via.add(v)
    for (const id of trace.because) { req.becauseIds.add(id); productive.add(id) }
  }

  const reachedNothing = changes.filter((c) => componentsOf(c).length > 0 && !productive.has(c.id))

  const edgeById = new Map([...graph.builtin, ...graph.custom].map((e) => [e.id, e]))

  // becauseIds carries the raw change ids behind each requirement so callers
  // can ask time questions (was this result recorded AFTER the change it
  // answers?) without parsing the human-readable why-trace. via carries the
  // edge ids the demand traveled through, so renderers can show the PATH —
  // "camera-position → calibration → localization (approved by X)" — instead
  // of asking users to trust an unexplained conclusion. rank orders the plan
  // upstream-first (run the calibration before the test that consumes it).
  const required = [...requirements.values()]
    .map((r) => ({ ...r, because: [...r.because], becauseHuman: [...r.becauseHuman], becauseIds: [...r.becauseIds], via: [...r.via], reasonCodes: [...r.reasonCodes] }))
    .sort((a, b) => a.rank - b.rank)
    .map((r, i) => ({ ...r, order: i + 1 }))

  // ── EVIDENCE APPLICABILITY — the honest classification of every piece of
  // the baseline's historical evidence against today's changes. Results are
  // history and never move; applicability is derived fresh every run:
  //   REVALIDATE  reached through ACTIVE edges (builtin or human-approved)
  //   RE-DERIVED  reached, but this very run's inputs re-established it
  //   UNKNOWN     reached ONLY through PROPOSED (unapproved) edges — the
  //               dependency question exists but no human has answered it;
  //               claiming either APPLICABLE or REVALIDATE would be invented
  //   APPLICABLE  no known dependency of any status connects it to a change
  const reachedAll = changes.length ? traverse(graph, changedComponents, universe, { includeProposed: true }) : new Map()
  // Folded calibration results live under `test:X` while graph demands name
  // `calibration:X` — the same physical referent must classify together, or
  // the table says "your calibration evidence is fine" beside a plan that
  // says "redo that calibration".
  const reachedFor = (map, id) => map.get(id) ?? (id.startsWith('test:') ? map.get(`calibration:${id.slice(5)}`) : undefined)
  const applicability = state.evidence.map((e) => {
    const active = reachedFor(reached, e.id)
    const any = reachedFor(reachedAll, e.id)
    if (active) {
      const { action } = actionFor(e.id)
      const rederived = satisfiedActions.has(action)
      return {
        evidenceId: e.id, result: e.result,
        applicability: rederived ? APPLICABILITY.REDERIVED : APPLICABILITY.REVALIDATE,
        reasonCodes: rederived ? [] : [reasonCodeFor(e.id, active, changeById)],
        reason: rederived
          ? 'reached by a change, but re-derived by the inputs this run supplied'
          : [...active.because].map((id) => describeChange(changeById.get(id)) ?? id).join('; '),
        via: [...active.via],
      }
    }
    if (any) {
      const proposedVia = [...any.via].filter((id) => edgeById.get(id)?.status === 'proposed')
      if (proposedVia.length) {
        return {
          evidenceId: e.id, result: e.result,
          applicability: APPLICABILITY.UNKNOWN,
          reasonCodes: ['INSUFFICIENT_EVIDENCE'],
          reason: `a PROPOSED (unapproved) dependency links it to ${[...any.because].map((id) => describeChange(changeById.get(id)) ?? id).join('; ')} — approve or reject the edge to resolve (physync graph --approve ${proposedVia[0]} --by <name>)`,
          via: proposedVia,
        }
      }
    }
    return {
      evidenceId: e.id, result: e.result,
      applicability: APPLICABILITY.APPLICABLE,
      reasonCodes: [],
      reason: changes.length ? 'no known dependency connects it to any change' : 'nothing changed',
      via: [],
    }
  })

  return {
    invalidated,
    applicability,
    required: required.filter((r) => !r.satisfied),
    satisfiedThisRun: required.filter((r) => r.satisfied),
    unmappedChanges: [
      ...unmapped.map((c) => `${c.kind} (${c.component}) — no dependency mapping; nothing invalidated automatically, review by hand`),
      ...reachedNothing.map((c) => `${c.kind} (${c.component}) — mapped to a component, but no approved edge leads from it to any evidence; nothing invalidated automatically, review by hand`),
    ],
  }
}
