/**
 * protocol/reaction.ts - Reaction message type for E2E encrypted emoji reactions.
 */

export type ReactionAction = 'add' | 'remove';

export interface ReactionMessage {
  readonly type: 'reaction';
  readonly conversationId: string;
  readonly targetMessageId: string;
  readonly emoji: string;
  readonly action: ReactionAction;
  readonly createdAt: string;
}
