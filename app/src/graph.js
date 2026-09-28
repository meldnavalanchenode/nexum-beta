// The dependency graph — Phase 3's foundation. Directed edges between node
// ids: components (what can change) on one side, evidence and engineering
// artifacts (what a change can kill) on the other, with chains through
// intermediate nodes (camera-position → camera-calibration → test:low-light).
//
// THE PROVENANCE LAW (the graph's version of "agents can ask, never attest"):
// an edge affects deployment decisions ONLY if its provenance is one of
//   deterministic-rule   shipped in code, defensible from platform facts
//   manufacturer-doc     cites a document a human read
//   user-approved        proposed by anyone (a person, an AI, a script) and
//                        then APPROVED by a named human
// Proposed-but-unapproved edges are stored, listed, and NEVER traversed.
// An LLM may suggest dependencies; only a human signature makes them real.
//
// NODE ID CONVENTIONS (data, not code — the engine never hard-codes names):
//   components: configuration · device:<name> · hub:@<addr> · firmware:@<addr>
//               · sensor:<name> · <anything-you-define>
//   evidence:   config-parsed · config-code-reconciled · hub-census
//               · sensor-liveness:<n> · motor-response:<n> · servo-response:<n>
//               · inventory-declared  (hand-declared robots — see inventory.js)
//   artifacts:  calibration:<id> · test:<name> · <anything-you-define>
//
// MATCHING (deterministic, three forms, nothing cleverer):
//   exact        'hub-census'
//   prefix glob  'motor-response:*'   (trailing * only)
//   same-suffix  from 'device:$n' to 'motor-response:$n' — $n carries the
//                matched name across the edge, so one rule covers every device

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const GRAPH_FILE = '.physync/graph.json'
export const EDGE_SOURCES = ['deterministic-rule', 'manufacturer-doc', 'user-approved']

// ── The built-in FTC rule pack. Each edge is a fact we can defend without a
//    manufacturer PDF in hand; anything less certain belongs in graph.json
//    with human approval. ──────────────────────────────────────────────────
export const BUILTIN_EDGES = [
  { id: 'ftc:config-parse', from: 'configuration', to: 'config-parsed', source: 'deterministic-rule', note: 'changed config bytes must be re-parsed' },
  { id: 'ftc:config-reconcile', from: 'configuration', to: 'config-code-reconciled', source: 'deterministic-rule', note: 'code↔config reconciliation is derived from the config bytes' },
  { id: 'ftc:device-reconcile', from: 'device:$n', to: 'config-code-reconciled', source: 'deterministic-rule', note: 'any device entry change re-derives the reconciliation' },
  // Platform-neutral. A hand-declared inventory (`state --declare`) is one
  // person's list of what is on the robot; change the list, or any entry in it,
  // and the thing that person vouched for is not the thing on the bench. This
  // asserts no ENGINEERING dependency — only that a declaration cannot outlive
  // its own contents. Engineering dependencies stay where they belong: proposed,
  // and inert until a human approves them.
  { id: 'generic:inventory-declare', from: 'configuration', to: 'inventory-declared', source: 'deterministic-rule', note: 'the declaration changed, so it no longer describes the robot a person vouched for' },
  { id: 'generic:device-inventory', from: 'device:$n', to: 'inventory-declared', source: 'deterministic-rule', note: 'a changed device entry invalidates the inventory that contained the old one' },
  { id: 'ftc:device-motor', from: 'device:$n', to: 'motor-response:$n', source: 'deterministic-rule', note: 'a changed motor entry (port/type) invalidates that motor\'s measured response' },
  { id: 'ftc:device-servo', from: 'device:$n', to: 'servo-response:$n', source: 'deterministic-rule', note: 'a changed servo entry invalidates that servo\'s confirmed response' },
  { id: 'ftc:device-sensor', from: 'device:$n', to: 'sensor-liveness:$n', source: 'deterministic-rule', note: 'a changed sensor entry invalidates that sensor\'s liveness evidence' },
  { id: 'ftc:hub-census', from: 'hub:$n', to: 'hub-census', source: 'deterministic-rule', note: 'a hub appearing/vanishing invalidates the recorded census' },
  { id: 'ftc:firmware-census', from: 'firmware:$n', to: 'hub-census', source: 'deterministic-rule', note: 'the census recorded the old firmware string' },
  { id: 'ftc:firmware-motors', from: 'firmware:$n', to: 'motor-response:*', source: 'deterministic-rule', note: 'REV firmware revisions change motor control behavior; measured responses predate the new firmware' },
  { id: 'ftc:firmware-servos', from: 'firmware:$n', to: 'servo-response:*', source: 'deterministic-rule', note: 'same rationale as motors' },
  { id: 'ftc:sensor-liveness', from: 'sensor:$n', to: 'sensor-liveness:$n', source: 'deterministic-rule', note: 'an observed sensor change invalidates its liveness evidence' },
]

const ID_RE = /^[A-Za-z0-9_@$*][\w@:\-.$* ]*$/

export function validateEdge(edge, { requireApproved = true } = {}) {
  if (edge == null || typeof edge !== 'object') throw new Error('edge must be an object')
  for (const f of ['id', 'from', 'to']) {
    if (typeof edge[f] !== 'string' || !edge[f].trim()) throw new Error(`edge is missing "${f}"`)
    if (!ID_RE.test(edge[f])) throw new Error(`edge ${f} "${edge[f]}" contains illegal characters`)
  }
  if (edge.status === 'proposed') return edge // stored, listed, never traversed
  if (!EDGE_SOURCES.includes(edge.source)) {
    throw new Error(`edge "${edge.id}" has provenance "${edge.source}" — an edge may only affect decisions with provenance ${EDGE_SOURCES.join(' | ')}`)
  }
  if (requireApproved && edge.source === 'user-approved' && (!edge.approvedBy || typeof edge.approvedBy !== 'string')) {
    throw new Error(`edge "${edge.id}" is user-approved but names no approver — a human signature is what makes an edge real`)
  }
  return edge
}

export function loadGraph(dir = '.') {
  const custom = []
  const path = join(dir, GRAPH_FILE)
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(raw.edges)) throw new Error('graph.json must be { edges: [...] }')
    for (const e of raw.edges) custom.push(validateEdge(e))
  }
  return { builtin: BUILTIN_EDGES, custom }
}

export function saveGraph(custom, dir = '.') {
  mkdirSync(join(dir, '.physync'), { recursive: true })
  writeFileSync(join(dir, GRAPH_FILE), JSON.stringify({ edges: custom }, null, 2))
}

/** Only edges allowed to affect decisions: built-ins plus approved customs. */
export const effectiveEdges = (graph) =>
  [...graph.builtin, ...graph.custom.filter((e) => e.status !== 'proposed')]

// ── matching ───────────────────────────────────────────────────────────────

/** Does `pattern` match `id`? Returns null for no match, or the captured
 *  suffix for a $n pattern (empty string for plain matches). */
export function matchNode(pattern, id) {
  if (pattern === id) return ''
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1) // keep the colon
    return id.startsWith(prefix) ? '' : null
  }
  if (pattern.includes('$n')) {
    const [head, tail] = pattern.split('$n')
    if (id.startsWith(head) && id.endsWith(tail) && id.length > head.length + tail.length - (tail ? 0 : 1)) {
      return id.slice(head.length, id.length - tail.length)
    }
    return null
  }
  return null
}

/** Expand an edge target for a given source match: substitute $n, and expand
 *  trailing-* patterns against the known-id universe. */
export function expandTarget(to, capture, universe) {
  const concrete = to.includes('$n') ? to.replaceAll('$n', capture) : to
  if (concrete.endsWith(':*')) {
    const prefix = concrete.slice(0, -1)
    return [...universe].filter((u) => u.startsWith(prefix))
  }
  return [concrete]
}

/** Reachability: from a set of changed component ids, traverse effective
 *  edges (chains included, cycles safe) and return every reached node with
 *  its why-trace: which change ids started the path, via which edges. */
export function traverse(graph, changedComponents, universe) {
  const edges = effectiveEdges(graph)
  const reached = new Map() // nodeId → { via: Set<edgeId>, because: Set<changeId> }
  const queue = []
  for (const { componentId, changeId } of changedComponents) {
    queue.push({ nodeId: componentId, changeId, path: [] })
  }
  const seen = new Set()
  while (queue.length) {
    const { nodeId, changeId, path } = queue.shift()
    const key = `${changeId}|${nodeId}`
    if (seen.has(key)) continue
    seen.add(key)
    for (const edge of edges) {
      const capture = matchNode(edge.from, nodeId)
      if (capture === null) continue
      for (const target of expandTarget(edge.to, capture, universe)) {
        if (!reached.has(target)) reached.set(target, { via: new Set(), because: new Set() })
        const r = reached.get(target)
        r.via.add(edge.id)
        r.because.add(changeId)
        queue.push({ nodeId: target, changeId, path: [...path, edge.id] })
      }
    }
  }
  return reached
}
