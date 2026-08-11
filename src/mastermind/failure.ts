import type { MastermindStore } from "./store/store.js";

export async function resolveMastermindFailureReasons(
  store: MastermindStore,
  workId: string,
): Promise<string[]> {
  const review = await store.getLatestReview(workId);
  if (review?.validation?.reasons.length) {
    return review.validation.reasons;
  }
  const events = await store.listEvents(workId);
  let failure: Record<string, unknown> | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.eventType === "FAIL") {
      failure = events[index];
      break;
    }
  }
  const metadata =
    failure?.metadata && typeof failure.metadata === "object" && !Array.isArray(failure.metadata)
      ? (failure.metadata as Record<string, unknown>)
      : undefined;
  const reviewFailureReasons = Array.isArray(metadata?.reviewFailureReasons)
    ? metadata.reviewFailureReasons.filter(
        (reason): reason is string => typeof reason === "string" && Boolean(reason.trim()),
      )
    : [];
  if (reviewFailureReasons.length > 0) {
    return reviewFailureReasons;
  }
  return typeof metadata?.reviewError === "string" && metadata.reviewError.trim()
    ? [metadata.reviewError]
    : [];
}
