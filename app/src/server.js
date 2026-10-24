// Nexum web UI server — local-first (loopback ONLY), nothing persisted,
// nothing leaves the machine. Route layer only; logic stays in the pure
// modules. Same hardening lessons as our previous audit server: clean 413 on
// oversized bodies (no socket-reset races), query-string-safe routing,
// no internal exception text to clients, no-store everywhere.

import { createServer } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseConfigXml } from './configXml.js'
import { scanSources } from './codeScan.js'
import { reconcile, verdict } from './engine.js'
import { renderMarkdown } from './report.js'
import { ENGINE_VERSION, checkMeta } from './registry.js'
import { buildApproval, validateApproval, compareApproval } from './approval.js'
import { parseRobotReport, analyzeSensors } from './sensors.js'
import { buildVerifiedState, saveState, listStates, latestState, nextVersion, migrateLegacy } from './state.js'
import { loadGraph, saveGraph, validateEdge, effectiveEdges, matchNode } from './graph.js'
import { plan } from './planner.js'
import { closeExperiment } from './experiment.js'
import { assess, foldResults } from './assess.js'
import { recordReported } from './reported.js'
import { loadTests, loadResults, detectRegressions, appendResult } from './results.js'
import { loadFingerprintDefs } from './fingerprints.js'
import { assertTrialActive, trialNotice } from './trial.js'

// NEXUM_PORT is the name going forward; PHYSYNC_PORT still works because it
// is an interface someone may already have scripted, and silently breaking
// it to tidy a name would be the wrong trade.
const PORT = Number(process.env.NEXUM_PORT ?? process.env.PHYSYNC_PORT ?? 4620)
const UI = new URL('../ui/index.html', import.meta.url)
// fileURLToPath, never url.pathname: on Windows .pathname yields "/C:/…",
// whose leading slash makes every readFileSync built from it fail. School
// laptops are Windows, and no beta team should meet that as their first
// impression.
const SAMPLES = fileURLToPath(new URL('../samples/', import.meta.url))
const BODY_CAP = 5_000_000 // config + a season of OpModes fits well under 5MB

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

const readBody = (req, res) => new Promise((resolve) => {
  let size = 0
  let overflowed = false
  const chunks = []
  req.on('data', (c) => {
    if (overflowed) return
    size += c.length
    if (size > BODY_CAP) {
      overflowed = true
      json(res, 413, { error: 'Payload too large (5MB cap) — send the config XML and TeamCode sources, not build outputs.' })
      res.on('finish', () => req.destroy())
    } else chunks.push(c)
  })
  req.on('end', () => resolve(overflowed ? null : Buffer.concat(chunks).toString('utf8')))
  req.on('error', () => resolve(null))
})

// The UI's approval lives IN MEMORY, per server process — deliberately (the
// disk-backed, signed approval belongs to the CLI + adb push workflow).
//
// The Phase-5 state endpoints are DIFFERENT: verified states, the results
// ledger, and the graph persist in the PROJECT DIRECTORY the server was
// started from — the same .physync/ the CLI uses, so the UI and the terminal
// can never disagree. Still loopback-only; nothing leaves the machine.
let uiApproval = null

const mkFinding = (id, message, evidence, fix) => {
  const meta = checkMeta(id)
  return { checkId: id, checkVersion: meta.version, severity: meta.severity, message, evidence, fix }
}

/** Shared parse+scan+reconcile used by /check and /approve. Returns either
 *  { error, status } or the full result. */
function runCheck(payload) {
  if (payload == null || typeof payload !== 'object') return { status: 400, error: 'Body must be { configXml, files: [{name, content}] }.' }
  const { configXml, files = [] } = payload
  if (typeof configXml !== 'string' || !configXml.trim()) return { status: 400, error: 'No configuration XML.' }
  if (!Array.isArray(files) || files.some((f) => !f || typeof f.name !== 'string' || typeof f.content !== 'string')) {
    return { status: 400, error: 'files must be an array of { name, content }.' }
  }
  let config
  try { config = parseConfigXml(configXml) } catch (e) { return { status: 400, error: `Cannot parse config: ${e.message}` } }
  if (!config.isFtcConfig) return { status: 422, error: 'That XML has no <Robot> root — paste the active configuration from /sdcard/FIRST/.' }
  if (config.devices.length === 0 && config.webcams.length === 0) return { status: 422, error: 'No devices found in that configuration.' }
  if (files.length > 500) return { status: 413, error: `${files.length} files is more than the 500-file limit — send TeamCode sources only, not build outputs.` }
  const configNames = new Set([...config.devices.map((d) => d.name), ...config.webcams.map((w) => w.name)])
  const spaceByName = new Map(config.devices.map((d) => [d.name, d.space]))
  const code = scanSources(files, configNames, spaceByName)
  const findings = reconcile(config, code)
  const context = {
    deviceCount: config.devices.length,
    webcamCount: config.webcams.length,
    refCount: code.refs.length,
    filesScanned: code.filesScanned,
    blkCount: code.blkCount,
    engineVersion: ENGINE_VERSION,
  }
  return { config, findings, context }
}

/** Optional robot report from the UI: string or object → { hubs, sensors } or error. */
function parseReport(raw) {
  if (raw == null || raw === '') return { hubs: null, sensors: null }
  try {
    const report = parseRobotReport(typeof raw === 'string' ? raw : JSON.stringify(raw))
    // fingerprints must surface here too — dropping them made the UI's
    // /status blind to physical drift the CLI catches on the same data.
    return { report, hubs: report.hubs.map((h) => ({ address: h.address, firmware: String(h.firmware ?? '') })), sensors: report.sensors, fingerprints: report.fingerprints }
  } catch (e) {
    return { error: `Cannot read robot report: ${e.message}` }
  }
}

/** The shared Phase-2→4 pipeline behind POST /status and POST /state. */
function collectCandidate(payload, r) {
  const rep = parseReport(payload.robotReport)
  if (rep.error) return { error: rep.error, status: 400 }
  const configName = typeof payload.configName === 'string' && payload.configName.trim() ? payload.configName.trim() : 'robot'
  return {
    rep,
    candidate: {
      configName,
      configXml: payload.configXml,
      devices: r.config.devices.map((d) => ({ name: d.name, type: d.type, port: d.port, bus: d.bus ?? null })),
      ...(rep.hubs != null ? { hubs: rep.hubs, sensors: rep.sensors, fingerprints: rep.fingerprints } : {}),
    },
  }
}

// Loopback-only is not CSRF-proof: any web page the operator has open can
// fire "simple request" POSTs at 127.0.0.1 from JavaScript (text/plain needs
// no CORS preflight), silently forging results/changes/approvals into the
// project ledger. Two cheap gates close it: a mutating request must carry a
// same-machine Origin (or none — curl and the CLI send none), and POST bodies
// must be application/json, which forces a preflight no cross-origin page can
// pass since we never send CORS headers.
const SAME_MACHINE_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  try {
    if (req.method === 'POST' || req.method === 'DELETE') {
      const origin = req.headers.origin
      if (origin != null && !SAME_MACHINE_ORIGIN.test(origin)) {
        return json(res, 403, { error: 'Cross-origin writes are refused — this server only accepts requests from this machine.' })
      }
      if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').includes('application/json')) {
        return json(res, 415, { error: 'POST bodies must be application/json.' })
      }
    }
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(readFileSync(UI, 'utf8'))
    }
    // THE 30-DAY BETA WINDOW, enforced here too. The CLI gate is not enough:
    // this server writes to the same .physync/ the CLI does, so `npm run ui`
    // would have been a way around a stop we told teams was absolute. Checked
    // per request, not just at startup, because a server left running must not
    // keep working across the boundary. `/` and `/sample` stay open — one is
    // the page that has to render to explain the refusal, the other reads a
    // bundled sample and writes nothing, the same reason `demo` is exempt.
    if (path !== '/sample') {
      try { assertTrialActive('.') } catch (e) { return json(res, 403, { error: e.message }) }
    }
    if (req.method === 'GET' && path === '/sample') {
      const configXml = readFileSync(join(SAMPLES, 'config.xml'), 'utf8')
      const files = []
      for (const f of readdirSync(join(SAMPLES, 'TeamCode'))) {
        if (/\.(java|kt|blk)$/.test(f)) files.push({ name: f, content: readFileSync(join(SAMPLES, 'TeamCode', f), 'utf8') })
      }
      return json(res, 200, { configXml, files })
    }
    if (req.method === 'POST' && path === '/check') {
      const body = await readBody(req, res)
      if (body == null) return // 413 already sent
      let payload
      try { payload = JSON.parse(body) } catch { return json(res, 400, { error: 'Body is not valid JSON.' }) }
      const r = runCheck(payload)
      if (r.error) return json(res, r.status, { error: r.error })
      return json(res, 200, { verdict: verdict(r.findings), findings: r.findings, context: r.context, markdown: renderMarkdown(r.findings, r.context) })
    }

    if (req.method === 'POST' && path === '/approve') {
      const body = await readBody(req, res)
      if (body == null) return
      let payload
      try { payload = JSON.parse(body) } catch { return json(res, 400, { error: 'Body is not valid JSON.' }) }
      const r = runCheck(payload)
      if (r.error) return json(res, r.status, { error: r.error })
      // Approval means "tested and approved" — a FAILING state cannot be frozen.
      if (verdict(r.findings) === 'FAIL') {
        return json(res, 409, { error: 'Refusing to approve a FAILING state — fix the findings first. Approval records that a human verified this robot; it is not a way to silence the check.', findings: r.findings, context: r.context })
      }
      const rep = parseReport(payload.robotReport)
      if (rep.error) return json(res, 400, { error: rep.error })
      if (rep.hubs != null && rep.hubs.length === 0) {
        return json(res, 422, { error: 'That robot report contains no hub census — re-run the Nexum Preflight OpMode and pull a fresh physync-robot.json.' })
      }
      if (rep.report) {
        const health = analyzeSensors(rep.report)
        if (verdict(health) === 'FAIL') {
          return json(res, 409, { error: `Refusing to approve: the robot report shows failures — ${health.filter((f) => f.severity === 'FAIL').map((f) => f.message).join(' · ')}` })
        }
      }
      const configName = typeof payload.configName === 'string' && payload.configName.trim() ? payload.configName.trim() : 'robot'
      try {
        uiApproval = buildApproval({
          configName,
          configXml: payload.configXml,
          hubs: rep.hubs ?? [],
          hubsVerified: rep.hubs != null,
          devices: r.config.devices.map((d) => ({ name: d.name, type: d.type, port: d.port, bus: d.bus ?? null })),
          engineVersion: ENGINE_VERSION,
        })
        validateApproval(JSON.parse(JSON.stringify(uiApproval)))
      } catch (e) {
        uiApproval = null
        return json(res, 400, { error: `Could not build the approval: ${e.message}` })
      }
      return json(res, 200, {
        approved: true, approvedAt: uiApproval.createdAt, configName: uiApproval.configName,
        hubsVerified: uiApproval.hubsVerified, hubs: uiApproval.hubs, deviceCount: uiApproval.devices.length,
        stateDigest: uiApproval.stateDigest,
        note: 'UI approvals live in memory for this server session. The durable, signed workflow is `physync approve` + adb push.',
      })
    }

    if (req.method === 'POST' && path === '/gate') {
      const body = await readBody(req, res)
      if (body == null) return
      let payload
      try { payload = JSON.parse(body) } catch { return json(res, 400, { error: 'Body is not valid JSON.' }) }
      if (payload == null || typeof payload !== 'object' || typeof payload.configXml !== 'string' || !payload.configXml.trim()) {
        return json(res, 400, { error: 'Body must be { configXml, configName?, robotReport? }.' })
      }
      const context = { mode: 'gate', approvedAt: uiApproval?.createdAt ?? 'never', hubsVerified: uiApproval?.hubsVerified ?? false, deviceCount: uiApproval?.devices?.length ?? 0, engineVersion: ENGINE_VERSION }
      if (!uiApproval) {
        const findings = [mkFinding('approval-missing', 'No approval on record for this UI session', [],
          'Verify the robot by hand, then press "Approve current state". The gate fails closed: nothing to compare is not a PASS.')]
        return json(res, 200, { verdict: verdict(findings), findings, context })
      }
      let approval
      try {
        approval = validateApproval(JSON.parse(JSON.stringify(uiApproval)))
      } catch (e) {
        uiApproval = null
        const findings = [mkFinding('approval-missing', `The stored approval failed its own integrity check: ${e.message}`, [], 'The gate fails closed. Re-verify and approve again.')]
        return json(res, 200, { verdict: verdict(findings), findings, context: { ...context, approvedAt: 'never' } })
      }
      const rep = parseReport(payload.robotReport)
      if (rep.error) return json(res, 400, { error: rep.error })
      if (approval.hubsVerified && rep.hubs == null) {
        return json(res, 422, { error: 'This approval covers the hub layer — paste a fresh physync-robot.json so the gate can actually check it. Checking half an approval and rendering a verdict would be a green light over a gap.' })
      }
      const configName = typeof payload.configName === 'string' && payload.configName.trim() ? payload.configName.trim() : 'robot'
      const findings = compareApproval(approval, { configName, configXml: payload.configXml, hubs: rep.hubs }, checkMeta)
      return json(res, 200, { verdict: verdict(findings), findings, context })
    }

    if (req.method === 'DELETE' && path === '/approve') {
      uiApproval = null
      return json(res, 200, { cleared: true })
    }

    // ── Phase 5: the verified-state workbench ──────────────────────────────

    if (req.method === 'GET' && path === '/overview') {
      // Load errors here carry authored, human-facing messages (a corrupt
      // ledger line, a tampered state) — surface them as a 500 the UI can
      // show, instead of the generic 400 that reads as "you sent bad input".
      try {
        migrateLegacy('.', { engineVersion: ENGINE_VERSION })
        const states = listStates('.')
        const results = loadResults('.')
        return json(res, 200, {
          robotId: states[0]?.robotId ?? 'robot',
          states: states.map((s) => ({
            version: s.version, createdAt: s.createdAt, origin: s.origin ?? 'native',
            configName: s.declared.configName, coverage: s.coverage,
            evidence: s.evidence,
            unknown: s.evidence.filter((e) => e.result === 'UNKNOWN').length,
          })),
          tests: loadTests('.'),
          results,
          // Simulated results are listed (flagged) but never enter regression
          // math — a drill number must not manufacture a phantom regression
          // against a real one.
          regressions: detectRegressions(results.filter((r2) => r2.simulated !== true)),
          graph: loadGraph('.'),
        })
      } catch (e) {
        return json(res, 500, { error: e.message })
      }
    }

    if (req.method === 'POST' && path === '/status') {
      const body = await readBody(req, res)
      if (body == null) return
      let payload
      try { payload = JSON.parse(body) } catch { return json(res, 400, { error: 'Body is not valid JSON.' }) }
      const r = runCheck(payload)
      if (r.error) return json(res, r.status, { error: r.error })
      migrateLegacy('.', { engineVersion: ENGINE_VERSION })
      const base = latestState('.')
      if (!base) return json(res, 409, { error: 'No verified state on record — save one first ("Save verified state").' })
      // Same kind-of-claim guard as the CLI: comparing a parsed hub config
      // against a hand-written inventory reports every device as changed.
      if (base.declared?.source === 'hand') {
        return json(res, 409, { error: `V${base.version} was declared by hand — the UI compares parsed configurations. Compare hand-declared baselines in the terminal: physync status --declare <inventory.json>.` })
      }
      const c = collectCandidate(payload, r)
      if (c.error) return json(res, c.status, { error: c.error })
      const failFindings = r.findings.filter((f) => f.severity === 'FAIL').length
      let fingerprintDefs = []
      try { fingerprintDefs = loadFingerprintDefs('.') } catch (e) { return json(res, 500, { error: e.message }) }

      // ONE assessment pipeline, shared with the CLI. This endpoint used to
      // carry its own copy, which is how it ended up without the shadow-mode
      // ordering guard and without the applicability/plan alias fix.
      const a = assess({
        base, candidate: c.candidate, failFindings, fingerprintDefs, dir: '.',
        reveal: payload.reveal === true,
      })
      if (a.withheld) {
        return json(res, 200, {
          predictionRequired: true,
          against: `V${base.version}`, baseCreatedAt: base.createdAt,
          changes: a.changes, gaps: a.gaps, hint: a.hint,
        })
      }
      const { changes, gaps, standing, revalidation, status, resultFailures, standingFailures, shadow } = a

      return json(res, 200, {
        status, against: `V${base.version}`, baseCreatedAt: base.createdAt,
        experiment: shadow ? { id: shadow.id, predictedAt: shadow.predictedAt, revealedAt: shadow.revealedAt } : null,
        failFindings, resultFailures, standingFailures, changes, gaps, standing, revalidation,
        regressions: a.regressions,
        findings: r.findings, context: r.context, exit: a.exit,
      })
    }

    if (req.method === 'POST' && path === '/state') {
      const body = await readBody(req, res)
      if (body == null) return
      let payload
      try { payload = JSON.parse(body) } catch { return json(res, 400, { error: 'Body is not valid JSON.' }) }
      const r = runCheck(payload)
      if (r.error) return json(res, r.status, { error: r.error })
      if (verdict(r.findings) === 'FAIL') {
        return json(res, 409, { error: 'Refusing to save a verified state over a FAILING check — fix the findings, re-verify, then save.', findings: r.findings, context: r.context })
      }
      migrateLegacy('.', { engineVersion: ENGINE_VERSION })
      const c = collectCandidate(payload, r)
      if (c.error) return json(res, c.status, { error: c.error })
      const prior = latestState('.')
      // Simulated results never fold into a verified state — demo data cannot
      // become evidence about a real robot by being saved.
      // Shared with the CLI (src/assess.js). Only the refusal differs: a
      // terminal dies, an endpoint returns 409.
      const { cycleResults, staleFolds, failFolds, absorbedReports } = foldResults({ prior, dir: '.' })
      if (failFolds.length) {
        return json(res, 409, { error: `Refusing to save a verified state holding FAILING recorded results — ${failFolds.map((r2) => `test:${r2.testId}`).join(', ')}. Verification means a human vouched for a working robot; record a passing re-run first.` })
      }
      try {
        const state = buildVerifiedState({
          version: nextVersion('.'), configName: c.candidate.configName, configXml: payload.configXml,
          devices: c.candidate.devices, checkVerdict: verdict(r.findings),
          checkFindingCounts: { WARN: r.findings.filter((f) => f.severity === 'WARN').length, INFO: r.findings.filter((f) => f.severity === 'INFO').length },
          robot: c.rep.report ?? undefined, results: cycleResults, engineVersion: ENGINE_VERSION,
        })
        saveState(state, '.')
        const sealed = closeExperiment({ newStateVersion: state.version }, '.')
        return json(res, 200, { saved: true, version: state.version, evidence: state.evidence.length, unknown: state.evidence.filter((e) => e.result === 'UNKNOWN').length, coverage: state.coverage, staleResultsNotFolded: staleFolds.map((r2) => r2.testId), absorbedReports: absorbedReports.length, experimentClosed: sealed?.id ?? null })
      } catch (e) {
        return json(res, 409, { error: e.message })
      }
    }

    // ── the recording endpoints — the same three actions the CLI offers, so a
    // design-test user can drive the whole workflow without a terminal. Each
    // persists to the project directory's .physync/, exactly like the CLI, and
    // each surfaces the module's own validation message: those are authored
    // for humans (a change needs a name attached, a threshold needs an
    // author), not internal exception text.

    if (req.method === 'POST' && path === '/change') {
      const body = await readBody(req, res)
      if (body == null) return
      let p
      try { p = JSON.parse(body) } catch { return json(res, 400, { error: 'Body is not valid JSON.' }) }
      let record
      try { record = recordReported({ component: p.component, note: p.note ?? '', by: p.by }) } catch (e) { return json(res, 400, { error: e.message }) }
      // Tell them immediately whether anything approved leads out of this
      // node — same courtesy the CLI extends.
      const g = loadGraph('.')
      // matchNode returns '' (falsy!) for exact and glob matches, null only
      // for no-match — a truthiness filter here told users their exact-named
      // approved edges did not exist.
      const out = effectiveEdges(g).filter((e) => matchNode(e.from, record.component) != null)
      const proposed = g.custom.filter((e) => e.status === 'proposed' && matchNode(e.from, record.component) != null)
      return json(res, 200, {
        recorded: record, label: 'HUMAN-REPORTED CHANGE',
        approvedEdgesOut: out.length, proposedEdgesOut: proposed.map((e) => ({ id: e.id, to: e.to })),
        note: out.length === 0
          ? 'No approved dependency leads out of this component — the report will surface under NO DEPENDENCY MAPPING for hand review, and invalidates nothing automatically.'
          : `${out.length} approved edge(s) lead out of "${record.component}" — run status to see the required rechecks.`,
      })
    }

    if (req.method === 'POST' && path === '/rule/approve') {
      const body = await readBody(req, res)
      if (body == null) return
      let p
      try { p = JSON.parse(body) } catch { return json(res, 400, { error: 'Body is not valid JSON.' }) }
      if (typeof p.by !== 'string' || !p.by.trim()) return json(res, 400, { error: 'Approval needs a name — a human signature is what makes an edge real.' })
      const g = loadGraph('.')
      const edge = g.custom.find((e) => e.id === p.id)
      if (!edge) return json(res, 404, { error: `No proposed edge "${p.id ?? ''}".` })
      if (edge.status !== 'proposed') return json(res, 409, { error: `Edge "${p.id}" is already approved.` })
      edge.status = 'approved'
      edge.source = 'user-approved'
      edge.approvedBy = p.by.trim()
      edge.approvedAt = new Date().toISOString()
      try { validateEdge(edge) } catch (e) { return json(res, 400, { error: e.message }) }
      saveGraph(g.custom)
      return json(res, 200, { approved: { id: edge.id, from: edge.from, to: edge.to, approvedBy: edge.approvedBy, approvedAt: edge.approvedAt }, note: 'This edge now affects invalidation and planning.' })
    }

    if (req.method === 'POST' && path === '/result') {
      const body = await readBody(req, res)
      if (body == null) return
      let p
      try { p = JSON.parse(body) } catch { return json(res, 400, { error: 'Body is not valid JSON.' }) }
      const testId = typeof p.testId === 'string' ? p.testId.trim() : ''
      const def = loadTests('.').find((t) => t.id === testId) ?? null
      // An explicit verdict the module wouldn't accept is REJECTED, never
      // silently dropped — {verdict:"fail"} must not quietly become a
      // threshold PASS, inverting the human's explicit claim.
      if (p.verdict != null && p.verdict !== '' && !['PASS', 'FAIL', 'UNKNOWN'].includes(p.verdict)) {
        return json(res, 400, { error: `illegal explicit verdict "${String(p.verdict)}" — use PASS, FAIL, UNKNOWN, or leave it empty for the threshold verdict` })
      }
      const explicit = ['PASS', 'FAIL', 'UNKNOWN'].includes(p.verdict) ? p.verdict : null
      // Values are numbers or numeric strings, nothing else: JSON true/[]/" "
      // coerce to 0 or 1 and would mint a PASS the human never claimed, and
      // "1e999" is Infinity, which the ledger would store as a valueless PASS.
      let value = null
      if (p.value != null && p.value !== '') {
        if (typeof p.value === 'number') value = p.value
        else if (typeof p.value === 'string' && p.value.trim() !== '') value = Number(p.value)
        else return json(res, 400, { error: 'value must be a number' })
        if (!Number.isFinite(value)) return json(res, 400, { error: 'value must be a finite number' })
      }
      let entry
      try {
        entry = appendResult({
          testId, def, value, explicit,
          evidence: p.evidence ? [String(p.evidence)] : [],
          notes: p.notes || null, recordedBy: p.by,
          method: p.method || null, simulated: p.simulated === true,
          againstState: latestState('.') ? `V${latestState('.').version}` : null,
        })
      } catch (e) { return json(res, 400, { error: e.message }) }
      return json(res, 200, {
        entry, definedTest: !!def,
        note: entry.simulated
          ? 'SIMULATED RESULT — stored and listed, satisfies NOTHING: simulated evidence cannot verify a real robot.'
          : entry.verdict === 'UNKNOWN' && value != null
            ? 'No threshold and no explicit verdict → UNKNOWN. A number without a bar to clear proves nothing yet.'
            : null,
      })
    }

    json(res, 404, { error: 'not found' })
  } catch {
    json(res, 400, { error: 'Could not process that input.' })
  }
})

// Refuse to start at all past the window, so a team gets the message once and
// clearly rather than a UI that loads and then 403s on every action.
try {
  assertTrialActive('.')
} catch (e) {
  console.error(`\n  ${e.message}\n`)
  process.exit(1)
}
const uiNotice = trialNotice('.')
if (uiNotice) console.error(uiNotice)

server.listen(PORT, '127.0.0.1', () => {
  // Report the port actually BOUND, not the one requested. PHYSYNC_PORT=0 asks
  // the OS for any free port, which is the only way concurrent test processes
  // each get a server without racing for a fixed number. Three suites derived
  // their port from `pid % 90` off the same base 4700 and collided on CI,
  // where pid allocation differs from a dev laptop — the loser died with
  // EADDRINUSE and its suite sat until an 8-second timeout.
  const bound = server.address()?.port ?? PORT
  console.log(`Nexum ui → http://127.0.0.1:${bound} (loopback only; nothing leaves this machine)`)
})
