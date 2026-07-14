# Cache, queue, and retry patterns

A process-local cache helps repeated immutable reads when its key, lifetime, bound, and invalidation rule are explicit. A durable queue helps when producers and workers are independent, jobs must survive process failure, or work is concurrent and remotely coordinated; it is unnecessary for a bounded synchronous batch that can be rerun from its input.

Retries belong only around transient operations. Bound attempts, expose exhaustion, and do not retry permanent validation failures. Before proposing any pattern, check whether the target already satisfies it and adapt only the missing behavior or proof.
