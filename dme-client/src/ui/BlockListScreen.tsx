/**
 * ui/BlockListScreen.tsx - Shows all DIDs the user has blocked.
 *
 * Two-phase rendering: builds rows from profileCacheRef immediately (fallback
 * to DID) so the list renders without blocking on network, then async-fetches
 * profiles via getProfilesCached + resolveHandleCached and updates rows via
 * functional setRows. Each row exposes an Unblock button that calls app.unblockMember; the
 * context's blockList state auto-updates, which re-renders this screen via the
 * focus effect.
 */

import React, { useCallback, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { theme } from './theme';
import { Button } from './Button';
import { ScreenBackground } from './ScreenBackground';
import { useApp } from '../state/AppContext';
import { getProfilesCached, resolveHandleCached } from '../atproto/profile-cache';
import type { RootStackParamList } from '../types/navigation';

type Navigation = NativeStackNavigationProp<RootStackParamList>;

interface BlockedRow {
  did: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

interface ProfileEntry {
  handle: string;
  displayName: string;
  avatar: string | null;
}

export function BlockListScreen(): React.JSX.Element {
  const app = useApp();
  const navigation = useNavigation<Navigation>();
  const [rows, setRows] = useState<readonly BlockedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const profileCacheRef = useRef<Record<string, ProfileEntry>>({});

  const resolveProfiles = useCallback(async (
    dids: string[],
  ): Promise<Record<string, ProfileEntry>> => {
    const result: Record<string, ProfileEntry> = {};
    const missing = dids.filter((did) => !profileCacheRef.current[did]);

    if (missing.length > 0 && app.session) {
      try {
        const profiles = await getProfilesCached(app.session.agent, missing);
        for (const [did, profile] of Object.entries(profiles)) {
          const entry: ProfileEntry = {
            handle: profile.handle ?? did,
            displayName: profile.displayName ?? '',
            avatar: profile.avatar ?? null,
          };
          profileCacheRef.current[did] = entry;
        }
      } catch (err) {
        console.error('resolveProfiles: getProfilesCached failed', missing, err);
      }
    }

    const stillMissing = dids.filter((did) => !profileCacheRef.current[did]);
    if (stillMissing.length > 0) {
      await Promise.all(
        stillMissing.map(async (did) => {
          try {
            const handle = await resolveHandleCached(did);
            profileCacheRef.current[did] = { handle, displayName: '', avatar: null };
          } catch (err) {
            console.error('resolveProfiles: resolveHandleCached failed for', did, err);
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

  useFocusEffect(
    useCallback(() => {
      const list = [...app.blockList];

      const initialRows = list.map((did) => {
        const cached = profileCacheRef.current[did];
        return {
          did,
          handle: cached?.handle ?? did,
          displayName: cached?.displayName ?? '',
          avatarUrl: cached?.avatar ?? null,
        };
      });
      setRows(initialRows);
      setLoading(false);

      if (list.length === 0) return;
      let cancelled = false;
      (async () => {
        const profiles = await resolveProfiles(list);
        if (cancelled) return;
        setRows((prev) =>
          prev.map((row) => {
            const p = profiles[row.did];
            if (!p) return row;
            const handle = p.handle ?? row.handle;
            const displayName = p.displayName || row.displayName;
            const avatarUrl = p.avatar ?? row.avatarUrl;
            if (
              handle === row.handle &&
              displayName === row.displayName &&
              avatarUrl === row.avatarUrl
            ) {
              return row;
            }
            return { did: row.did, handle, displayName, avatarUrl };
          }),
        );
      })().catch((err: unknown) => {
        console.error('load block list failed:', err);
      });
      return () => {
        cancelled = true;
      };
    }, [app.blockList, resolveProfiles]),
  );

  const handleUnblock = useCallback((did: string): void => {
    app.unblockMember(did).catch((err: unknown) => console.error('unblock failed:', err));
  }, [app]);

  return (
    <View style={styles.container}>
      <ScreenBackground />

      <View style={styles.content}>
        <View style={styles.header}>
          <Button
            label="Back"
            onPress={() => navigation.goBack()}
            variant="secondary"
            style={styles.backBtn}
          />
          <Text style={styles.title} numberOfLines={1}>Block List</Text>
        </View>

        {loading ? (
          <Text style={styles.statusText}>Loading...</Text>
        ) : (
          <FlatList
            style={styles.list}
            data={[...rows]}
            keyExtractor={(item) => item.did}
            ListEmptyComponent={
              <Text style={styles.emptyText}>No blocked users</Text>
            }
            renderItem={({ item }) => (
              <View style={styles.row}>
                {item.avatarUrl ? (
                  <Image
                    source={{ uri: item.avatarUrl }}
                    style={styles.avatar}
                    contentFit="cover"
                    transition={300}
                  />
                ) : (
                  <View style={[styles.avatar, styles.avatarFallback]}>
                    <Text style={styles.avatarFallbackText}>
                      {(item.displayName[0] ?? item.handle[0] ?? '?').toUpperCase()}
                    </Text>
                  </View>
                )}
                <View style={styles.textStack}>
                  <Text style={styles.displayName} numberOfLines={1}>
                    {item.displayName || item.handle || item.did}
                  </Text>
                  {item.handle ? (
                    <Text style={styles.handle} numberOfLines={1}>
                      @{item.handle}
                    </Text>
                  ) : null}
                </View>
                <Button
                  label="Unblock"
                  onPress={() => handleUnblock(item.did)}
                  variant="secondary"
                  style={styles.unblockBtn}
                />
              </View>
            )}
          />
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
  list: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
  },
  avatarFallback: {
    backgroundColor: theme.colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarFallbackText: {
    color: '#FFFFFF',
    fontSize: theme.typography.body,
    fontWeight: '700',
  },
  textStack: {
    flex: 1,
    marginLeft: theme.spacing.sm,
    marginRight: theme.spacing.sm,
  },
  displayName: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    fontWeight: '600',
  },
  handle: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.small,
    marginTop: 1,
  },
  unblockBtn: {
    width: 90,
    height: 36,
  },
  emptyText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.body,
    textAlign: 'center',
    marginTop: theme.spacing.xl,
  },
  statusText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.body,
    textAlign: 'center',
    marginTop: theme.spacing.xl,
  },
});
