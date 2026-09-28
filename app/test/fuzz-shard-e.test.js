// Fuzz shard e — seeds 400001..470000 of the approval fuzz corpus.
// The property lives in helpers/fuzz-core.js; see fuzz-approval.test.js.
import { runFuzzShard } from './helpers/fuzz-core.js'
runFuzzShard(400001, 470000)
