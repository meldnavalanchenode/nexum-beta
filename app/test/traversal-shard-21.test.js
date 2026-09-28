// traversal invariant fuzz shard 21 — seeds 3000001..3150000. See helpers/engine-gen.js.
import { runTraversalShard } from './helpers/engine-fuzz-core.js'
runTraversalShard(3000001, 3150000)
