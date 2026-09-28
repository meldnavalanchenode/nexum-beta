// Fuzz shard d — seeds 300001..400000 of the approval fuzz corpus.
// The property lives in helpers/fuzz-core.js; see fuzz-approval.test.js.
import { runFuzzShard } from './helpers/fuzz-core.js'
runFuzzShard(300001, 400000)
