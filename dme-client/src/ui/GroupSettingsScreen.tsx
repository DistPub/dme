/**
 * ui/GroupSettingsScreen.tsx - Group management UI.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { Canvas, Fill } from '@shopify/react-native-skia';
import { useRoute, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';

import { theme } from './theme';
import { Button } from './Button';
import { useApp } from '../state/AppContext';
import { sharedDidResolver } from '../atproto/did';
import type { GroupMember } from '../protocol/group-message';
import type { RootStackParamList } from '../types/navigation';

type GroupSettingsRouteProp = NativeStackScreenProps<RootStackParamList, 'GroupSettings'>['route'];
type Navigation = NativeStackNavigationProp<RootStackParamList>;

interface MemberProfile {
  handle: string;
  displayName: string;
  avatar: string | null;
}

export function GroupSettingsScreen(): React.JSX.Element {
  const app = useApp();
  const route = useRoute<GroupSettingsRouteProp>();
  const navigation = useNavigation<Navigation>();
  const { groupId } = route.params;

  const [groupName, setGroupName] = useState('');
  const [members, setMembers] = useState<readonly GroupMember[]>([]);
  const [memberProfiles, setMemberProfiles] = useState<Record<string, MemberProfile>>({});
  const [dissolved, setDissolved] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [left, setLeft] = useState(false);
  const [loading, setLoading] = useState(true);
  const [blockTarget, setBlockTarget] = useState<
    { did: string; displayName: string; handle: string } | null
  >(null);
  const profileCacheRef = useRef<Record<string, MemberProfile>>({});

  const resolveProfiles = useCallback(async (
    dids: string[],
  ): Promise<Record<string, MemberProfile>> => {
    const result: Record<string, MemberProfile> = {};
    const missing = dids.filter((did) => !profileCacheRef.current[did]);

    if (missing.length > 0 && app.session) {
      try {
        const response = await app.session.agent.app.bsky.actor.getProfiles({ actors: missing });
        for (const profile of response.data.profiles) {
          const entry: MemberProfile = {
            handle: profile.handle ?? profile.did,
            displayName: profile.displayName ?? '',
            avatar: profile.avatar ?? null,
          };
          profileCacheRef.current[profile.did] = entry;
        }
      } catch (err) {
        console.error('resolveProfiles: getProfiles failed', missing, err);
      }
    }

    const stillMissing = dids.filter((did) => !profileCacheRef.current[did]);
    if (stillMissing.length > 0) {
      await Promise.all(
        stillMissing.map(async (did) => {
          try {
            const doc = (await sharedDidResolver.resolve(did)) as { alsoKnownAs?: string[] } | null;
            const handle = doc?.alsoKnownAs?.[0]?.replace(/^at:\/\//, '') ?? did;
            profileCacheRef.current[did] = { handle, displayName: '', avatar: null };
          } catch {
            profileCacheRef.current[did] = { handle: did, displayName: '', avatar: null };
          }
        }),
      );
    }

    for (const did of dids) {
      result[did] = profileCacheRef.current[did];
    }
    return result;
  }, [app.session]);

  useEffect(() => {
    const loadGroupInfo = async (): Promise<void> => {
      if (!app.storage) return;
      const info = await app.storage.getGroupInfo(groupId);
      if (info) {
        setGroupName(info.groupName);
        setMembers(info.members);
        setDissolved(info.dissolved ?? false);
        setRemoved(info.removed ?? false);
        setLeft(info.left ?? false);

        const cached: Record<string, MemberProfile> = {};
        for (const m of info.members) {
          const entry = profileCacheRef.current[m.did];
          if (entry) cached[m.did] = entry;
        }
        setMemberProfiles(cached);
      }
      setLoading(false);

      if (info) {
        const memberDids = info.members.map((m) => m.did);
        const missing = memberDids.filter((did) => !profileCacheRef.current[did]);
        if (missing.length === 0) return;
        void (async () => {
          const resolved = await resolveProfiles(memberDids);
          setMemberProfiles(resolved);
        })();
      }
    };
    loadGroupInfo().catch((err: unknown) => console.error('loadGroupInfo failed:', err));
  }, [app.storage, groupId, app.chatListVersion, resolveProfiles]);

  const isCreator = members.some(
    (m) => m.did === app.session?.did && m.role === 'creator',
  );

  const handleRemoveMember = useCallback(async (memberDid: string): Promise<void> => {
    await app.removeMemberFromGroup(groupId, memberDid);
  }, [app, groupId]);

  const handleBlockMember = useCallback(
    (memberDid: string, displayName: string, handle: string): void => {
      setBlockTarget({ did: memberDid, displayName, handle });
    },
    [],
  );

  const confirmBlock = useCallback((): void => {
    if (blockTarget) {
      app.blockMember(blockTarget.did).catch((err: unknown) =>
        console.error('blockMember failed:', err),
      );
    }
    setBlockTarget(null);
  }, [app, blockTarget]);

  if (loading) {
    return (
      <View style={styles.container}>
        <Canvas style={StyleSheet.absoluteFill}>
          <Fill color={theme.colors.background} />
        </Canvas>
        <Text style={styles.statusText}>Loading...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Fill color={theme.colors.background} />
      </Canvas>

      <View style={styles.content}>
        <View style={styles.header}>
          <Button
            label="Back"
            onPress={() => navigation.goBack()}
            variant="secondary"
            style={styles.backBtn}
          />
          <Text style={styles.title} numberOfLines={1}>{groupName}</Text>
        </View>

        {dissolved || removed || left ? (
          <>
            <Text style={styles.dissolvedHint}>
              {dissolved ? '群聊已解散' : removed ? '你已被移出群聊' : '你已离开群聊'}
            </Text>
            <Button
              label="Delete Conversation"
              onPress={() => {
                app.deleteFriend(groupId);
                navigation.navigate('ChatList');
              }}
              variant="secondary"
              style={styles.fullButton}
            />
          </>
        ) : (
          <>
            <Text style={styles.sectionLabel}>Members ({members.length})</Text>

            <FlatList
              style={styles.list}
              data={[...members]}
              keyExtractor={(item) => item.did}
              renderItem={({ item }) => {
                const profile = memberProfiles[item.did];
                const displayName = profile?.displayName || profile?.handle || item.displayName;
                const handle = profile?.handle ?? '';
                const avatarUrl = profile?.avatar ?? null;
                const canBlock = item.did !== app.session?.did;
                const isBlocked = app.blockList.includes(item.did);
                return (
                  <View style={styles.memberRow}>
                    <View style={styles.memberInfo}>
                      {avatarUrl ? (
                        <Image
                          source={{ uri: avatarUrl }}
                          style={styles.memberAvatar}
                          contentFit="cover"
                          transition={300}
                        />
                      ) : (
                        <View style={[styles.memberAvatar, styles.memberAvatarFallback]}>
                          <Text style={styles.memberAvatarFallbackText}>
                            {(displayName[0] ?? '?').toUpperCase()}
                          </Text>
                        </View>
                      )}
                      <View style={styles.memberTextStack}>
                        <View style={styles.memberNameRow}>
                          <Text style={styles.memberDisplayName} numberOfLines={1}>
                            {displayName}
                          </Text>
                          {item.role === 'creator' && (
                            <Text style={styles.creatorTag}> (Creator)</Text>
                          )}
                        </View>
                        {handle ? (
                          <Text style={styles.memberHandle} numberOfLines={1}>
                            @{handle}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                    <View style={styles.memberActions}>
                      {canBlock && !isBlocked && (
                        <Button
                          label="Block"
                          onPress={() => handleBlockMember(item.did, displayName, handle)}
                          variant="secondary"
                          style={styles.blockBtn}
                        />
                      )}
                      {canBlock && isBlocked && (
                        <Button
                          label="Unblock"
                          onPress={() => app.unblockMember(item.did)}
                          variant="secondary"
                          style={styles.blockBtn}
                        />
                      )}
                      {isCreator && item.role !== 'creator' && (
                        <Button
                          label="Remove"
                          onPress={() => handleRemoveMember(item.did)}
                          variant="secondary"
                          style={styles.removeBtn}
                        />
                      )}
                    </View>
                  </View>
                );
              }}
            />

            {isCreator && (
              <Button
                label="Invite New Member"
                onPress={() => navigation.navigate('CreateGroup', { groupId })}
                variant="primary"
                style={styles.fullButton}
              />
            )}

            {isCreator ? (
              <Button
                label="Dissolve Group"
                onPress={() => {
                  app.dissolveGroup(groupId);
                  navigation.goBack();
                }}
                variant="secondary"
                style={styles.fullButton}
              />
            ) : (
              <Button
                label="Leave Group"
                onPress={() => {
                  app.leaveGroup(groupId);
                  navigation.goBack();
                }}
                variant="secondary"
                style={styles.fullButton}
              />
            )}
          </>
        )}
      </View>

      <Modal
        visible={blockTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setBlockTarget(null)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setBlockTarget(null)}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>屏蔽成员</Text>
            <Text style={styles.modalMessage}>
              屏蔽 {blockTarget?.handle
                ? blockTarget.handle === blockTarget.displayName
                  ? `@${blockTarget.handle}`
                  : `${blockTarget.displayName}（@${blockTarget.handle}）`
                : blockTarget?.displayName
              }? 屏蔽后将不再接收该成员的消息。
            </Text>
            <View style={styles.modalButtons}>
              <Button
                label="取消"
                onPress={() => setBlockTarget(null)}
                variant="secondary"
                style={styles.modalBtn}
              />
              <Button
                label="屏蔽"
                onPress={confirmBlock}
                variant="primary"
                style={styles.modalBtn}
              />
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    flex: 1,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: theme.spacing.md,
  },
  backBtn: {
    width: 60,
    height: 40,
  },
  title: {
    flex: 1,
    color: theme.colors.textPrimary,
    fontSize: theme.typography.heading,
    fontWeight: '700',
    marginLeft: theme.spacing.sm,
  },
  sectionLabel: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
    marginBottom: theme.spacing.sm,
  },
  list: {
    flex: 1,
    marginBottom: theme.spacing.md,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  memberInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  memberAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    overflow: 'hidden',
  },
  memberAvatarFallback: {
    backgroundColor: theme.colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  memberAvatarFallbackText: {
    color: '#FFFFFF',
    fontSize: theme.typography.body,
    fontWeight: '700',
  },
  memberTextStack: {
    flex: 1,
  },
  memberNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  memberDisplayName: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    fontWeight: '600',
    flexShrink: 1,
  },
  creatorTag: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
  },
  memberHandle: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.small,
    marginTop: 1,
  },
  memberActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  removeBtn: {
    width: 80,
    height: 36,
    marginLeft: theme.spacing.xs,
  },
  blockBtn: {
    width: 70,
    height: 36,
    marginLeft: theme.spacing.xs,
  },
  fullButton: {
    width: '100%',
    height: 48,
    marginBottom: theme.spacing.sm,
  },
  dissolvedHint: {
    color: theme.colors.error,
    fontSize: theme.typography.body,
    textAlign: 'center',
    paddingVertical: theme.spacing.md,
  },
  statusText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.body,
    textAlign: 'center',
    marginTop: theme.spacing.xl,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  modalCard: {
    width: 300,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing.md,
  },
  modalTitle: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.heading,
    fontWeight: '700',
    marginBottom: theme.spacing.sm,
  },
  modalMessage: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.body,
    marginBottom: theme.spacing.md,
    lineHeight: 22,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  modalBtn: {
    flex: 1,
    height: 44,
  },
});
