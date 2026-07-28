/**
 * ui/GroupSettingsScreen.tsx - Group management UI.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Canvas, Fill } from '@shopify/react-native-skia';
import { useRoute, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';

import { theme } from './theme';
import { Button } from './Button';
import { useApp } from '../state/AppContext';
import type { GroupMember } from '../protocol/group-message';
import type { RootStackParamList } from '../types/navigation';

type GroupSettingsRouteProp = NativeStackScreenProps<RootStackParamList, 'GroupSettings'>['route'];
type Navigation = NativeStackNavigationProp<RootStackParamList>;

export function GroupSettingsScreen(): React.JSX.Element {
  const app = useApp();
  const route = useRoute<GroupSettingsRouteProp>();
  const navigation = useNavigation<Navigation>();
  const { groupId } = route.params;

  const [groupName, setGroupName] = useState('');
  const [members, setMembers] = useState<readonly GroupMember[]>([]);
  const [memberHandles, setMemberHandles] = useState<Record<string, string>>({});
  const [dissolved, setDissolved] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [left, setLeft] = useState(false);
  const [loading, setLoading] = useState(true);

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

        const { DidResolver } = await import('@atproto/identity');
        const resolver = new DidResolver({});
        const resolved: Record<string, string> = {};
        for (const m of info.members) {
          try {
            const doc = (await resolver.resolve(m.did)) as { alsoKnownAs?: string[] } | null;
            if (doc?.alsoKnownAs?.[0]) {
              resolved[m.did] = doc.alsoKnownAs[0].replace(/^at:\/\//, '');
            } else {
              resolved[m.did] = m.did;
            }
          } catch {
            resolved[m.did] = m.did;
          }
        }
        setMemberHandles(resolved);
      }
      setLoading(false);
    };
    loadGroupInfo().catch((err: unknown) => console.error('loadGroupInfo failed:', err));
  }, [app.storage, groupId, app.chatListVersion]);

  const isCreator = members.some(
    (m) => m.did === app.session?.did && m.role === 'creator',
  );

  const handleRemoveMember = useCallback(async (memberDid: string): Promise<void> => {
    await app.removeMemberFromGroup(groupId, memberDid);
  }, [app, groupId]);

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
              renderItem={({ item }) => (
                <View style={styles.memberRow}>
                  <Text style={styles.memberName} numberOfLines={1}>
                    {memberHandles[item.did] ?? item.displayName}
                    {item.role === 'creator' ? ' (Creator)' : ''}
                  </Text>
                  {isCreator && item.role !== 'creator' && (
                    <Button
                      label="Remove"
                      onPress={() => handleRemoveMember(item.did)}
                      variant="secondary"
                      style={styles.removeBtn}
                    />
                  )}
                </View>
              )}
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
    justifyContent: 'space-between',
    paddingVertical: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  memberName: {
    flex: 1,
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
  },
  removeBtn: {
    width: 80,
    height: 36,
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
});
