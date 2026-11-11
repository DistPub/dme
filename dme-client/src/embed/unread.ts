import type { DmeStorage } from '../storage/db';

/**
 * Compute total unread message count across all conversations,
 * mirroring the filter logic from ChatListScreen.
 */
export async function computeTotalUnread(
  storage: DmeStorage,
  myDid: string,
  blocked: ReadonlySet<string>,
): Promise<number> {
  const groups = await storage.listGroups();
  const messagesByGroup = await Promise.all(
    groups.map(async (groupId) => ({
      groupId,
      messages: await storage.getMessages(groupId),
    })),
  );
  let total = 0;
  for (const { messages } of messagesByGroup) {
    total += messages.filter(
      (m) => m.fromDid !== myDid && !m.readAt && !blocked.has(m.fromDid),
    ).length;
  }
  return total;
}

/**
 * Compute the number of conversations that need user action (any session
 * issue: sibling-rotated / forked / desynced). Mirrors the ChatListScreen
 * issue-banner source of truth.
 */
export async function computeActionNeeded(storage: DmeStorage): Promise<number> {
  const groups = await storage.listGroups();
  let count = 0;
  for (const groupId of groups) {
    if (await storage.getSessionIssue(groupId)) count++;
  }
  return count;
}
