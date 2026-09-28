// Shard runner for the Phase 2-6 engine invariant fuzz. Each seed runs the
// full invariant battery (state build + validate + UNKNOWN safety + digest
// integrity + change detection + restoration + plan determinism + dedup +
// soundness + proposed-inertness + monotonicity + satisfied-removal +
// regression direction) or the cheaper traversal battery. One shared
// implementation so 10M seeds stay one body of logic.

import test from 'node:test'
import { runEngineInvariants, runTraversalInvariants } from './engine-gen.js'

export function runEngineShard(from, to) {
  for (let seed = from; seed <= to; seed++) {
    test(`engine-invariants seed ${seed}`, () => runEngineInvariants(seed))
  }
}

export function runTraversalShard(from, to) {
  for (let seed = from; seed <= to; seed++) {
    test(`traversal-invariants seed ${seed}`, () => runTraversalInvariants(seed))
  }
}
