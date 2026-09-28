// traversal invariant fuzz shard 25 — seeds 3600001..3750000. See helpers/engine-gen.js.
import { runTraversalShard } from './helpers/engine-fuzz-core.js'
runTraversalShard(3600001, 3750000)
