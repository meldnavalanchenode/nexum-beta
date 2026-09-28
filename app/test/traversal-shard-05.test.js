// traversal invariant fuzz shard 5 — seeds 600001..750000. See helpers/engine-gen.js.
import { runTraversalShard } from './helpers/engine-fuzz-core.js'
runTraversalShard(600001, 750000)
