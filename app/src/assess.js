// The single assessment pipeline, shared by every surface.
//
// WHY THIS EXISTS. The CLI's `status` and the web UI's POST /status each
// carried their own copy of this orchestration: detect changes, merge
// self-reported ones, gate on shadow mode, plan, decide which demands recorded
// results already satisfy, then grade. Two copies of one judgment is two
// judgments, and they drifted exactly as you would expect:
//
//   · the shadow-mode ordering guard existed only on the CLI, so opening the
//     web UI once in a beta project silently burned the prediction window;
//   · the applicability/plan alias fix existed only on the CLI, so the UI
//     could show a row as REVALIDATE beside a plan line saying that same row
//     was satisfied — the table contradicting itself on one screen.
//
// Neither was caught by tests, because each surface was tested against its own
// behaviour. One implementation cannot disagree with itself.
//
// CORE module: it takes an already-parsed candidate and a FAIL count, never an
// artifact. Parsing a config XML or scanning code stays on the adapter side.

import { detectChanges, rederivedFrom, deploymentStatus, statusExitCode, assertLedgerIntact } from './state.js'
import { loadGraph } from './graph.js'
import { plan, APPLICABILITY } from './planner.js'
import { loadResults, latestResults, detectRegressions } from './results.js'
import { loadReported, reportedSince, asChange } from './reported.js'
import { markRevealed, openExperiment } from './experiment.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Is this project running the shadow-mode experiment, with no prediction
 *  armed? Reading the answer first destroys that change's datapoint and cannot
 *  be undone, so every surface asks before it answers. */
export function predictionGate(dir = '.', { reveal = false } = {}) {
  if (reveal) return { withhold: false }
  if (!existsSync(join(dir, '.physync/beta.json'))) return { withhold: false }
  const armed = (() => { try { return openExperiment(dir) } catch { return null } })()
  return armed ? { withhold: false } : {
    withhold: true,
    hint: 'Record what YOU would re-check before seeing Nexum\'s answer: physync predict --checks "a, b" --by <name>',
  }
}

/**
 * Assess a candidate robot against a verified state.
 *
 * @param base            the verified state being compared against
 * @param candidate       the candidate state (already built by the caller)
 * @param failFindings    count of FAIL findings from reconciliation (0 for
 *                        hand-declared robots, which reconcile nothing)
 * @param fingerprintDefs human-authored tolerances, already loaded
 * @param dir             project directory
 * @param inventory       true for a hand-declared robot — a clean reconciliation
 *                        cannot be claimed because none was performed
 * @param reveal          bypass the shadow-mode ordering gate
 */
export function assess({ base, candidate, failFindings = 0, fingerprintDefs = [], dir = '.', inventory = false, reveal = false }) {
  // Refuse before grading anything: if the newest state this project ever
  // reached is missing, every verdict below would be computed from a
  // baseline that may never have carried its failures.
  assertLedgerIntact(dir)
  const { changes, gaps, standing } = detectChanges(base, candidate, { fingerprintDefs })
  // Self-reported physical changes since the baseline carry their own
  // provenance (source: human / method: self-reported) and are never detections.
  changes.push(...reportedSince(loadReported(dir), base.createdAt).map(asChange))

  const gate = predictionGate(dir, { reveal })
  if (changes.length && gate.withhold) {
    // What CHANGED is still returned — it contaminates nothing. Only the plan
    // is withheld, on every surface, including machine-readable output.
    return { withheld: true, hint: gate.hint, changes, gaps, standing, base }
  }

  const allResults = loadResults(dir)
  const realResults = allResults.filter((r) => r.simulated !== true)
  const recent = latestResults(realResults, { after: base.createdAt })
  const recentSimulated = latestResults(allResults.filter((r) => r.simulated === true), { after: base.createdAt })

  // Loaded once and returned, so any surface rendering a why-path provably
  // shows the same edges the decision was made with.
  const graph = loadGraph(dir)

  let revalidation = null
  let resultFailures = 0
  const consumedTests = new Set()

  if (changes.length) {
    const satisfied = new Set()
    // A clean reconciliation re-derives the check family — but only if a
    // reconciliation actually happened. A hand-declared inventory reconciles
    // nothing, and 'no findings' must never be mistaken for 'clean'.
    if (!inventory && failFindings === 0) satisfied.add('check')
    const rederivedTargets = rederivedFrom(base, candidate, changes)
    revalidation = plan({ state: base, changes, graph, satisfiedActions: satisfied, rederivedTargets })

    // A result can only answer a change made BEFORE it was recorded. Human-
    // reported changes carry the moment the change became known; a PASS
    // recorded before that moment describes the robot as it used to be.
    // Detected changes have no knowable change time, so their cutoff stays the
    // baseline — all that can honestly be enforced.
    const reportedAt = new Map(changes.filter((c) => c.source === 'human' && c.at).map((c) => [c.id, c.at]))
    const cutoffFor = (req) => (req.becauseIds ?? []).reduce((m, id) => {
      const t = reportedAt.get(id); return t != null && t > m ? t : m
    }, base.createdAt)

    const stillRequired = []
    for (const req of revalidation.required) {
      const bareId = req.action.startsWith('test:') ? req.action.slice(5)
        : req.action.startsWith('calibration:') ? req.action.slice(12) : null
      const recorded = bareId != null ? recent.get(bareId) : null
      const simulatedOnly = bareId != null && !recorded ? recentSimulated.get(bareId) : null
      if (bareId != null) consumedTests.add(bareId)

      if (recorded && recorded.recordedAt <= cutoffFor(req)) {
        stillRequired.push({ ...req, label: `${req.label} — latest result (${recorded.verdict}, ${recorded.recordedAt}) PREDATES the reported change it must answer; re-run` })
      } else if (recorded?.verdict === 'PASS') {
        revalidation.satisfiedThisRun.push({ ...req, label: `${req.label} — PASS recorded ${recorded.recordedAt} by ${recorded.recordedBy}` })
        // A fresh PASS re-derives the evidence it covers, and the applicability
        // table must agree with the satisfaction decision or one screen
        // contradicts itself.
        for (const t of req.targets) {
          const id = t.replace(' (no recorded result — UNKNOWN)', '')
          // A folded calibration result lives under `test:X` while the graph
          // demands `calibration:X` — the same referent under two spellings.
          // Without this alias the lookup misses and the row stays REVALIDATE
          // next to a plan line saying it was satisfied.
          const alias = id.startsWith('calibration:') ? `test:${id.slice(12)}`
            : id.startsWith('test:') ? `calibration:${id.slice(5)}` : null
          const row = revalidation.applicability?.find((a) => a.evidenceId === id)
            ?? (alias ? revalidation.applicability?.find((a) => a.evidenceId === alias) : undefined)
          if (row && row.applicability === APPLICABILITY.REVALIDATE) {
            row.applicability = APPLICABILITY.REDERIVED
            row.reasonCodes = []
            row.reason = `PASS recorded ${recorded.recordedAt} by ${recorded.recordedBy}`
          }
        }
      } else if (recorded?.verdict === 'FAIL') {
        resultFailures++
        stillRequired.push({ ...req, label: `${req.label} — LATEST RESULT IS FAIL (${recorded.value ?? 'explicit'}, ${recorded.recordedAt})` })
      } else if (simulatedOnly) {
        stillRequired.push({ ...req, label: `${req.label} — only a SIMULATED result on file (${simulatedOnly.verdict}); simulated evidence satisfies nothing` })
      } else {
        stillRequired.push(req) // missing or UNKNOWN: still owed. UNKNOWN never passes.
      }
    }
    revalidation.required = stillRequired
  }

  // A recorded FAIL counts whether or not any change demanded that check.
  const standingFailures = [...recent.values()].filter((r) => r.verdict === 'FAIL' && !consumedTests.has(r.testId))
  resultFailures += standingFailures.length

  // A baseline written before FAIL evidence was refused at build time (or by
  // an older engine) must not keep reading as VERIFIED. The row is history and
  // stays history; the STATUS stops claiming the robot is fine.
  const baselineFailures = base.evidence.filter((e) => e.result === 'FAIL').map((e) => e.id)
  resultFailures += baselineFailures.length

  // The reconciliation row cannot read "still applies" while THIS run's
  // reconciliation is failing — the row's own subject is refuted on the same
  // screen. No graph edge covers it: a fresh check re-derives reconciliation
  // directly, so the honest source is the live finding count, not a path.
  if (failFindings > 0 && revalidation?.applicability) {
    for (const row of revalidation.applicability) {
      if (row.evidenceId !== 'config-code-reconciled' && row.evidenceId !== 'config-parsed') continue
      if (row.applicability === APPLICABILITY.APPLICABLE || row.applicability === APPLICABILITY.REDERIVED) {
        row.applicability = APPLICABILITY.REVALIDATE
        row.reasonCodes = ['CONFIGURATION_CHANGED']
        row.reason = `this run's config\u2194code reconciliation is FAILING (${failFindings} finding(s)) — the baseline's passing reconciliation does not describe today's robot`
      }
    }
  }

  const status = deploymentStatus({
    failFindings: failFindings + resultFailures,
    changes, gaps,
    // Everything the planner ESTABLISHED. Zero of all three, with changes
    // present, is the only case where Nexum genuinely could not say anything.
    mappedOutcomes: revalidation
      ? revalidation.invalidated.length + revalidation.required.length + revalidation.satisfiedThisRun.length
      : null,
  })

  const shadow = changes.length === 0 ? null : markRevealed({
    changes,
    planActions: revalidation ? [...revalidation.required, ...revalidation.satisfiedThisRun].map((r) => r.action) : [],
    applicabilityCounts: revalidation
      ? revalidation.applicability.reduce((m, a) => ({ ...m, [a.applicability]: (m[a.applicability] ?? 0) + 1 }), {})
      : {},
  }, dir)

  return {
    withheld: false,
    base, changes, gaps, standing, revalidation, status, graph,
    exit: statusExitCode(status),
    failFindings, resultFailures, standingFailures, baselineFailures,
    regressions: detectRegressions(realResults),
    shadow,
  }
}

/**
 * Which recorded results may be folded into a NEW verified state.
 *
 * Same duplication story as assess(): the CLI and the web UI each carried this,
 * and it enforces the rule `status` enforces — a result recorded BEFORE a
 * human-reported change that put its test in question describes a robot that no
 * longer exists, so folding it would launder the exact evidence status refuses.
 *
 * Returns the foldable results, the stale ones dropped, and any FAILs. The
 * REFUSAL is left to the caller, because a terminal dies and an HTTP endpoint
 * returns 409 — that difference is presentation, not judgment.
 */
export function foldResults({ prior, dir = '.' }) {
  // NOT guarded by assertLedgerIntact: recording a NEW baseline is exactly
  // what a team is told to do when the newest state is gone. Blocking it
  // here left them with a refusal and no way out — the same dead end the
  // torn-state message was written to escape.
  let cycleResults = [...latestResults(
    loadResults(dir).filter((r) => r.simulated !== true),
    { after: prior?.createdAt },
  ).values()]

  const absorbedReports = prior ? reportedSince(loadReported(dir), prior.createdAt).map(asChange) : []
  let staleFolds = []
  if (absorbedReports.length && cycleResults.length) {
    const foldPlan = plan({ state: prior, changes: absorbedReports, graph: loadGraph(dir) })
    const reportAt = new Map(absorbedReports.map((c) => [c.id, c.at]))
    const cutoffByTest = new Map()
    for (const req of [...foldPlan.required, ...foldPlan.satisfiedThisRun]) {
      const bare = req.action.startsWith('test:') ? req.action.slice(5)
        : req.action.startsWith('calibration:') ? req.action.slice(12) : null
      if (bare == null) continue
      const cut = (req.becauseIds ?? []).reduce((m, id) => {
        const t = reportAt.get(id); return t != null && t > m ? t : m
      }, '')
      if (cut) cutoffByTest.set(bare, cut)
    }
    staleFolds = cycleResults.filter((r) => cutoffByTest.has(r.testId) && r.recordedAt <= cutoffByTest.get(r.testId))
    cycleResults = cycleResults.filter((r) => !staleFolds.includes(r))
  }
  // A FAIL never freezes into "verified" silently — the same rule the check
  // verdict gets, applied to behavioural results.
  //
  // staleFolds MUST be included. A FAIL dropped as stale is still a FAIL that
  // nobody answered: it was recorded before the change it had to answer, so it
  // cannot be folded as evidence — but that makes it MORE unresolved, not
  // less. Counting only the surviving results let a failing check evaporate:
  // record a FAIL, report a change, save, and the new state carried no test
  // evidence at all while `status` read VERIFIED FOR DEFINED CHECKS with
  // resultFailures 0. The worst-shaped bug in the tool — a green light earned
  // by losing the evidence.
  // ...but only a stale FAIL that NOTHING newer answered. The retest in the
  // documented loop (record FAIL → fix → record PASS → save) leaves the old
  // FAIL in staleFolds, and blocking on it would refuse the very save the loop
  // ends with. A test with a surviving result has been answered; one without
  // has not.
  const answered = new Set(cycleResults.map((r) => r.testId))
  const unansweredStaleFails = staleFolds.filter((r) => r.verdict === 'FAIL' && !answered.has(r.testId))
  const failFolds = [...cycleResults.filter((r) => r.verdict === 'FAIL'), ...unansweredStaleFails]
  return { cycleResults, staleFolds, failFolds, absorbedReports }
}
