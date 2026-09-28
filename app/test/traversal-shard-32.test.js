// traversal invariant fuzz shard 32 — seeds 4650001..4800000. See helpers/engine-gen.js.
import { runTraversalShard } from './helpers/engine-fuzz-core.js'
runTraversalShard(4650001, 4800000)
