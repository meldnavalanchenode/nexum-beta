// traversal invariant fuzz shard 1 — seeds 1..150000. See helpers/engine-gen.js.
import { runTraversalShard } from './helpers/engine-fuzz-core.js'
runTraversalShard(1, 150000)
