/**
 * protocol/group-message.ts - Group chat message type definitions.
 *
 * Group-related messages are sent through existing 1:1 MLS sessions.
 * Each message is a JSON envelope with a discriminant `type` field.
 *
 * Message flow:
 *   1. Alice sends group_invite_request to Bob via 1:1 MLS session
 *   2. Bob responds with group_invite_response (accept/reject)
 *   3. Alice creates MLS group, addMember(Bob), sends Welcome via 1:1
 *   4. Alice broadcasts group_metadata to all group members
 */

// ---------------------------------------------------------------------------
// Member
// ---------------------------------------------------------------------------

/** A group member's public info. */
export type GroupMember = {
  readonly did: string;
  readonly displayName: string;
  readonly role: 'creator' | 'member';
};

// ---------------------------------------------------------------------------
// Invitation
// ---------------------------------------------------------------------------

/** Status of a pending group invitation. */
export type InviteStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';

/** A single pending invitation record (stored locally). */
export type PendingInvite = {
  readonly inviteId: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly inviterDid: string;
  readonly inviteeDid: string;
  readonly status: InviteStatus;
  readonly createdAt: string;
  readonly keyPackageSerialized?: string;
  /**
   * 接受方自己的 KP pair 池条目 id（2026-10-14 起）。点接受时从
   * keyPackagePool 取未消费 pair（池随备份走），welcome 解密依赖其私钥——
   * 池化让「welcome 未到达」的中间态天然闭环：pair 留在池里随备份，
   * 恢复后 welcome（TTL 内重放）可直接 join。join 成功后标记 consumed。
   */
  readonly ownKeyPackagePoolId?: string;
  /** @deprecated 旧格式：pair 本体序列化（池化前的历史记录兼容读取） */
  readonly ownKeyPackagePairSerialized?: string;
};

// ---------------------------------------------------------------------------
// Group info
// ---------------------------------------------------------------------------

/** Stored group metadata. */
export type GroupInfo = {
  readonly groupId: string;
  readonly groupName: string;
  readonly creatorDid: string;
  readonly members: readonly GroupMember[];
  readonly createdAt: string;
  readonly dissolved?: boolean;
  readonly removed?: boolean;
  readonly left?: boolean;
};

// ---------------------------------------------------------------------------
// Wire messages (sent via 1:1 MLS session)
// ---------------------------------------------------------------------------

/** Invitation request: Alice → Bob. */
export type GroupInviteRequest = {
  readonly type: 'group_invite_request';
  readonly inviteId: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly members: readonly GroupMember[];
};

/** Invitation response: Bob → Alice. */
export type GroupInviteResponse = {
  readonly type: 'group_invite_response';
  readonly inviteId: string;
  readonly groupId: string;
  readonly accepted: boolean;
  readonly keyPackageSerialized?: string;
};

/** Welcome delivery: Alice → Bob (after Bob accepts). */
export type GroupWelcome = {
  readonly type: 'group_welcome';
  readonly groupId: string;
  readonly groupName: string;
  readonly welcomePayload: string;
  readonly members: readonly GroupMember[];
};

/** Metadata update: broadcast to all group members. */
export type GroupMetadataUpdate = {
  readonly type: 'group_metadata_update';
  readonly groupId: string;
  readonly groupName: string;
  readonly members: readonly GroupMember[];
};

/** Commit delivery: Alice -> existing member, process with group MLS session. */
export type GroupCommit = {
  readonly type: 'group_commit';
  readonly groupId: string;
  readonly commitPayload: string;
};

/** Group dissolved: creator -> all members, delete locally. */
export type GroupDissolved = {
  readonly type: 'group_dissolved';
  readonly groupId: string;
  readonly groupName: string;
};

/** Member removed: creator -> removed member, mark group read-only. */
export type GroupMemberRemoved = {
  readonly type: 'group_member_removed';
  readonly groupId: string;
  readonly groupName: string;
  /**
   * 被踢成员的 DID（2026-10-14 新增）。旧版本消息无此字段——
   * 该消息只经 1v1 会话单发给被踢者，缺失时按「发给自己」宽松兼容，
   * 重放防护依赖接收端 queueId 去重 + GroupInfo 新鲜度比较。
   */
  readonly memberDid?: string;
};

/** Member left: leaving member -> all other members, update member list. */
export type GroupMemberLeft = {
  readonly type: 'group_member_left';
  readonly groupId: string;
  readonly memberDid: string;
  readonly groupName: string;
};

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

/** All possible group-related messages sent through 1:1 channels. */
export type GroupMessage =
  | GroupInviteRequest
  | GroupInviteResponse
  | GroupWelcome
  | GroupMetadataUpdate
  | GroupCommit
  | GroupDissolved
  | GroupMemberRemoved
  | GroupMemberLeft;

/** Discriminant type field for exhaustive matching. */
export type GroupMessageType = GroupMessage['type'];
