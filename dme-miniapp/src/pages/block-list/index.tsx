/**
 * pages/block-list/index.tsx
 *
 * 对照 dme-client/src/ui/BlockListScreen.tsx 原样复刻。
 * 两阶段渲染：先用 profile 缓存立即出列表行，再异步拉资料更新。
 */

import { useCallback, useRef, useState } from 'react';
import { View, Text, ScrollView, Button, Image } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';

import { useApp } from '../../state/AppContext';
import { useI18n } from '../../i18n/I18nContext';
import { getProfilesCached, resolveHandleCached } from '../../atproto/profile-cache';
import { useWebTitle } from '../../utils/web-title';
import './index.scss';

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

export default function BlockListPage(): React.JSX.Element {
  const { t } = useI18n();
  const { session, pds, blockList, unblockMember } = useApp();

  const [rows, setRows] = useState<BlockedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const profileCacheRef = useRef<Record<string, ProfileEntry>>({});

  useWebTitle(t('blocklist.title'));

  const resolveProfiles = useCallback(
    async (dids: string[]): Promise<Record<string, ProfileEntry>> => {
      const missing = [...new Set(dids.filter((did) => !profileCacheRef.current[did]))];

      if (missing.length > 0 && pds) {
        try {
          const profiles = await getProfilesCached(pds, missing);
          for (const did of missing) {
            const profile = profiles[did];
            if (!profile) continue;
            profileCacheRef.current[did] = {
              handle: profile.handle || did,
              displayName: profile.displayName ?? '',
              avatar: profile.avatar ?? null,
            };
          }
        } catch (err) {
          console.warn('block-list: getProfilesCached 失败', err);
        }
      }

      const stillMissing = missing.filter((did) => !profileCacheRef.current[did]);
      if (stillMissing.length > 0) {
        await Promise.all(
          stillMissing.map(async (did) => {
            try {
              const handle = await resolveHandleCached(did);
              profileCacheRef.current[did] = { handle, displayName: '', avatar: null };
            } catch {
              profileCacheRef.current[did] = { handle: did, displayName: '', avatar: null };
            }
          }),
        );
      }

      const result: Record<string, ProfileEntry> = {};
      for (const did of dids) {
        if (profileCacheRef.current[did]) result[did] = profileCacheRef.current[did];
      }
      return result;
    },
    [pds],
  );

  useDidShow(
    useCallback((): void => {
      const list = [...blockList];

      const initialRows: BlockedRow[] = list.map((did) => {
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

      void (async () => {
        const profiles = await resolveProfiles(list);
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
      })();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [blockList, resolveProfiles, session?.did]),
  );

  return (
    <View className="blocklist">
      <View className="blocklist__header">
        <Text className="blocklist__title">{t('blocklist.title')}</Text>
      </View>

      <ScrollView className="blocklist__list" scrollY>
        {loading ? (
          <Text className="blocklist__hint">{t('common.loading')}</Text>
        ) : rows.length === 0 ? (
          <Text className="blocklist__empty">{t('blocklist.empty')}</Text>
        ) : (
          rows.map((row) => {
            const displayName = row.displayName || row.handle;
            return (
              <View key={row.did} className="blocklist__row">
                {row.avatarUrl ? (
                  <Image className="blocklist__avatar" src={row.avatarUrl} mode="aspectFill" />
                ) : (
                  <View className="blocklist__avatar blocklist__avatar--fallback">
                    <Text className="blocklist__avatarText">
                      {(displayName || '?').slice(0, 1).toUpperCase()}
                    </Text>
                  </View>
                )}

                <View className="blocklist__text">
                  <Text className="blocklist__name">{displayName}</Text>
                  <Text className="blocklist__handle">@{row.handle}</Text>
                </View>

                <Button
                  className="blocklist__unblockBtn"
                  onClick={() => void unblockMember(row.did)}
                >
                  {t('common.unblock')}
                </Button>
              </View>
            );
          })
        )}
      </ScrollView>

      <View className="blocklist__footer">
        <Button
          className="blocklist__backBtn"
          onClick={async () => {
            await Taro.navigateBack();
          }}
        >
          {t('common.back')}
        </Button>
      </View>
    </View>
  );
}
