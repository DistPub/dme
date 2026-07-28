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
