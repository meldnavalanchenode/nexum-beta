// engine invariant fuzz shard 5 — seeds 600001..750000. See helpers/engine-gen.js.
import { runEngineShard } from './helpers/engine-fuzz-core.js'
runEngineShard(600001, 750000)
