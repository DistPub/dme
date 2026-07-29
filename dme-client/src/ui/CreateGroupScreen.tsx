/**
 * ui/CreateGroupScreen.tsx - Group creation UI with friend selection.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Canvas, Fill } from '@shopify/react-native-skia';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';

import { theme } from './theme';
import { Button } from './Button';
import { useApp } from '../state/AppContext';
import { sharedDidResolver } from '../atproto/did';
import type { RootStackParamList } from '../types/navigation';

type Navigation = NativeStackNavigationProp<RootStackParamList>;

type Phase = 'select' | 'sending' | 'done';

interface FriendRow {
  readonly did: string;
  readonly handle: string;
  readonly selected: boolean;
}

export function CreateGroupScreen(): React.JSX.Element {
  const app = useApp();
  const navigation = useNavigation<Navigation>();
  const route = useRoute<NativeStackScreenProps<RootStackParamList, 'CreateGroup'>['route']>();

  const existingGroupId = route.params?.groupId;

  const [groupName, setGroupName] = useState('');
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [phase, setPhase] = useState<Phase>('select');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const loadFriends = async (): Promise<void> => {
      if (!app.storage) return;
      const allGroups = await app.storage.listGroups();
      const groupInfos = await app.storage.listGroupInfos();

      const existingMemberDids = new Set<string>();
      if (existingGroupId) {
        const info = groupInfos.find((g) => g.groupId === existingGroupId);
        if (info) {
          setGroupName(info.groupName);
          info.members.forEach((m) => existingMemberDids.add(m.did));
        }
      }

      const groupIds = new Set(groupInfos.map((g) => g.groupId));
      const friendDids = allGroups.filter(
        (id) => !groupIds.has(id) && id.startsWith('did:') && !existingMemberDids.has(id),
      );

      const results = await Promise.all(
        friendDids.map(async (did) => {
          try {
            const doc = (await sharedDidResolver.resolve(did)) as { alsoKnownAs?: string[] } | null;
            if (doc?.alsoKnownAs?.[0]) {
              return { did, handle: doc.alsoKnownAs[0].replace(/^at:\/\//, '') };
            }
          } catch {
          }
          return { did, handle: did };
        }),
      );
      const rows: FriendRow[] = results.map(({ did, handle }) => ({
        did,
        handle,
        selected: false,
      }));
      setFriends(rows);
    };
    loadFriends().catch((err: unknown) => console.error('loadFriends failed:', err));
  }, [app.storage]);

  const toggleFriend = useCallback((did: string) => {
    setFriends((prev) =>
      prev.map((f) => f.did === did ? { ...f, selected: !f.selected } : f),
    );
  }, []);

  const onCreate = useCallback(async (): Promise<void> => {
    const selectedFriends = friends.filter((f) => f.selected);
    if (selectedFriends.length === 0) return;
    if (!existingGroupId && !groupName.trim()) return;

    setPhase('sending');
    setErrorMsg('');

    try {
      if (existingGroupId) {
        for (const friend of selectedFriends) {
          await app.addMemberToGroup(existingGroupId, friend.did);
        }
      } else {
        await app.sendGroupInvites(
          groupName.trim(),
          selectedFriends.map((f) => f.did),
        );
      }
      setPhase('done');
      setTimeout(() => navigation.goBack(), 1500);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed');
      setPhase('select');
    }
  }, [groupName, friends, app, navigation, existingGroupId]);

  const selectedCount = friends.filter((f) => f.selected).length;

  const renderFriend = useCallback(
    ({ item }: { item: FriendRow }): React.JSX.Element => (
      <TouchableOpacity
        style={[styles.friendRow, item.selected && styles.friendRowSelected]}
        onPress={() => toggleFriend(item.did)}
        activeOpacity={0.7}
      >
        <Text style={styles.friendHandle} numberOfLines={1}>{item.handle}</Text>
        <Text style={[styles.checkmark, item.selected && styles.checkmarkActive]}>
          {item.selected ? '✓' : '○'}
        </Text>
      </TouchableOpacity>
    ),
    [toggleFriend],
  );

  const canCreate = existingGroupId ? selectedCount > 0 : (groupName.trim().length > 0 && selectedCount > 0);

  return (
    <View style={styles.container}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Fill color={theme.colors.background} />
      </Canvas>

      <View style={styles.content}>

        {phase === 'select' && (
          <>
            <Text style={styles.title}>
              {existingGroupId ? 'Invite Members' : 'Create Group'}
            </Text>

            {!existingGroupId && (
              <TextInput
                style={styles.input}
                value={groupName}
                onChangeText={setGroupName}
                placeholder="Group name"
                placeholderTextColor={theme.colors.placeholder}
                autoCapitalize="none"
                autoCorrect={false}
              />
            )}

            <Text style={styles.sectionLabel}>
              Select friends ({selectedCount} selected)
            </Text>

            <FlatList
              style={styles.list}
              data={friends}
              keyExtractor={(item) => item.did}
              renderItem={renderFriend}
              ListEmptyComponent={
                <Text style={styles.emptyText}>No friends to invite</Text>
              }
            />

            {errorMsg ? (
              <Text style={styles.errorText}>{errorMsg}</Text>
            ) : null}

            <Button
              label={`Send Invites (${selectedCount})`}
              onPress={onCreate}
              variant="primary"
              disabled={!canCreate}
              style={styles.fullButton}
            />
            <Button
              label="Cancel"
              onPress={() => navigation.goBack()}
              variant="secondary"
              style={styles.fullButton}
            />
          </>
        )}

        {phase === 'sending' && (
          <Text style={styles.statusText}>Sending invites...</Text>
        )}

        {phase === 'done' && (
          <Text style={styles.statusText}>Invites sent!</Text>
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
  title: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.heading,
    fontWeight: '700',
    marginBottom: theme.spacing.md,
  },
  input: {
    height: 48,
    backgroundColor: theme.colors.inputBackground,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    paddingHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.md,
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
  friendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.sm,
    marginBottom: theme.spacing.xs,
  },
  friendRowSelected: {
    backgroundColor: theme.colors.accent,
  },
  friendHandle: {
    flex: 1,
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
  },
  checkmark: {
    color: theme.colors.textSecondary,
    fontSize: 20,
    fontWeight: '700',
  },
  checkmarkActive: {
    color: '#FFFFFF',
  },
  emptyText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.body,
    textAlign: 'center',
    marginTop: theme.spacing.lg,
  },
  fullButton: {
    width: '100%',
    height: 48,
    marginBottom: theme.spacing.sm,
  },
  statusText: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    textAlign: 'center',
    marginTop: theme.spacing.xl,
  },
  errorText: {
    color: theme.colors.error,
    fontSize: theme.typography.caption,
    textAlign: 'center',
    marginBottom: theme.spacing.sm,
  },
});
