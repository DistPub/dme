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
