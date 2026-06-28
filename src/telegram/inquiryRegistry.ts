/**
 * Correlation registry for Telegram human-in-the-loop replies.
 *
 * Telegram delivers a single global update stream per bot, with no built-in link between a
 * reply and the question it answers. We bridge that by remembering the message id of each
 * question we send (with force_reply) and resolving the matching pending promise when a reply
 * arrives carrying `reply_to_message.message_id`. This lets many questions be in flight at once
 * — even in the same chat — and still route each answer to the right waiter.
 */

export type PendingResolver = (answer: string) => void;

export class InquiryRegistry {
  private readonly byQuestionMessageId = new Map<number, PendingResolver>();

  /** Remember that a reply to `questionMessageId` should resolve `resolve`. */
  register(questionMessageId: number, resolve: PendingResolver): void {
    this.byQuestionMessageId.set(questionMessageId, resolve);
  }

  /** Forget a pending question without resolving it (e.g. on timeout). */
  unregister(questionMessageId: number): void {
    this.byQuestionMessageId.delete(questionMessageId);
  }

  /**
   * Route an inbound reply to the question it replied to. Returns true if a pending question
   * matched (and was resolved + forgotten), false otherwise.
   */
  resolveReply(replyToMessageId: number, answer: string): boolean {
    const resolve = this.byQuestionMessageId.get(replyToMessageId);
    if (!resolve) return false;
    this.byQuestionMessageId.delete(replyToMessageId);
    resolve(answer);
    return true;
  }

  get pendingCount(): number {
    return this.byQuestionMessageId.size;
  }
}
