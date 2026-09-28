// traversal invariant fuzz shard 10 — seeds 1350001..1500000. See helpers/engine-gen.js.
import { runTraversalShard } from './helpers/engine-fuzz-core.js'
runTraversalShard(1350001, 1500000)
