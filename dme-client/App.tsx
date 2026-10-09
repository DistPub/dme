/**
 * App.tsx - DME entry point with navigation and providers.
 *
 * Provider stack:
 *   GestureHandlerRootView
 *     -> I18nProvider
 *       -> AppProvider
 *         -> SafeAreaProvider
 *           -> NavigationContainer
 *             -> Stack.Navigator
 *
 * Screens: Login, Setup, ChatList, ChatView, QrDisplay, QrScan.
 * On mount: tries session restore; routes to Setup (which routes to ChatList
 * if identity key is already declared) or stays on Login.
 */

import React, { useEffect, useRef, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { AppProvider, useApp } from './src/state/AppContext';
import { I18nProvider, useI18n } from './src/i18n/I18nContext';
import { isEmbedContext } from './src/embed/protocol';
import { theme } from './src/ui/theme';
import { LogoSpinner } from './src/ui/LogoSpinner';
import { LoginScreen } from './src/ui/LoginScreen';
import { SetupScreen } from './src/ui/SetupScreen';
import { ChatListScreen } from './src/ui/ChatListScreen';
import { ChatViewScreen } from './src/ui/ChatViewScreen';
import { QrDisplayScreen } from './src/ui/QrDisplayScreen';
import { QrScanScreen } from './src/ui/QrScanScreen';
import { SettingsScreen } from './src/ui/SettingsScreen';
import { AboutScreen } from './src/ui/AboutScreen';
import { CreateGroupScreen } from './src/ui/CreateGroupScreen';
import { GroupSettingsScreen } from './src/ui/GroupSettingsScreen';
import { DmSettingsScreen } from './src/ui/DmSettingsScreen';
import { BlockListScreen } from './src/ui/BlockListScreen';
import { ImageViewerScreen } from './src/ui/ImageViewerScreen';
import { VideoViewerScreen } from './src/ui/VideoViewerScreen';
import type { RootStackParamList } from './src/types/navigation';
import { setWebTitle } from './src/utils/web-title';

export type { RootStackParamList };

const Stack = createNativeStackNavigator<RootStackParamList>();
const navigationRef = createNavigationContainerRef<RootStackParamList>();

/**
 * Conversation-scoped routes whose document.title is managed by their own
 * screens via useWebTitle (group name / friend profile live in per-screen
 * state and resolve asynchronously), not by the centralized route mapping.
 */
const SCREEN_MANAGED_TITLES: ReadonlySet<keyof RootStackParamList> = new Set([
  'ChatView',
  'GroupSettings',
  'DmSettings',
]);

/**
 * Resolve the initial route from session-restore outcome and the optional
 * `?goto=` query param (standalone web only).
 */
function computeGotoRoute(restored: boolean): keyof RootStackParamList {
  if (!restored) return 'Login';
  const gotoParam = Platform.OS === 'web'
    ? new URLSearchParams(window.location.search).get('goto')
    : null;
  if (gotoParam === 'QrDisplay' || gotoParam === 'QrScan' || gotoParam === 'ChatList') {
    return gotoParam;
  }
  return 'Setup';
}

function NavigationRoot(): React.JSX.Element {
  const app = useApp();
  const { t } = useI18n();
  const [isReady, setIsReady] = useState(false);
  const [initialRoute, setInitialRoute] = useState<keyof RootStackParamList>('Login');
  const prevSessionRef = useRef(app.session);
  const restoredRef = useRef(false);

  // Keep latest t in a ref so onStateChange doesn't capture a stale closure.
  const tRef = useRef(t);
  tRef.current = t;

  const updateTitle = (): void => {
    if (!navigationRef.isReady()) return;
    const route = navigationRef.getCurrentRoute()?.name as keyof RootStackParamList | undefined;
    if (!route) return;
    if (SCREEN_MANAGED_TITLES.has(route)) return;
    const key = ROUTE_TITLE_KEYS[route];
    if (!key) return;
    setWebTitle(tRef.current(key));
  };

  // Re-apply title when language changes.
  useEffect(() => {
    updateTitle();
  }, [t]);

  useEffect(() => {
    let cancelled = false;

    async function init(): Promise<void> {
      const restored = await app.restoreSession();
      restoredRef.current = restored;
      if (cancelled) return;
      if (!isEmbedContext()) {
        setInitialRoute(computeGotoRoute(restored));
        setIsReady(true);
      }
    }

    init();

    return () => {
      cancelled = true;
    };
  }, []);

  // Embed: readiness is decided by the token outcome (or the timeout below).
  useEffect(() => {
    if (!isEmbedContext()) return;
    if (app.embedMismatch) { setIsReady(true); return; }
    if (app.embedTokenApplied && app.session) {
      setInitialRoute('Setup');
      setIsReady(true);
    }
  }, [app.embedTokenApplied, app.embedMismatch, app.session]);

  // Embed: fall back to the standalone entry route if no token arrives in time.
  useEffect(() => {
    if (!isEmbedContext()) return;
    const id = setTimeout(() => {
      setIsReady(prev => { if (prev) return prev; setInitialRoute(computeGotoRoute(restoredRef.current)); return true; });
    }, 8000);
    return () => clearTimeout(id);
  }, []);

  // Embed: a token applied after the app already mounted on Login still routes
  // forward to Setup. A mismatch is intentionally a no-op (the prompt stands).
  useEffect(() => {
    if (!isEmbedContext() || app.embedMismatch || !app.embedTokenApplied) return;
    if (navigationRef.isReady() && navigationRef.getCurrentRoute()?.name === 'Login') {
      navigationRef.navigate('Setup');
    }
  }, [app.embedTokenApplied, app.embedMismatch]);

  // Embed: a fatesky share intent (`DME_SHARE`) routes to the conversation
  // picker with the post pre-filled. The intent is consumed so it fires once.
  useEffect(() => {
    if (!app.shareIntent) return;
    if (!navigationRef.isReady()) return;
    navigationRef.navigate('ChatList', { forwardPost: app.shareIntent });
    app.consumeShareIntent();
  }, [app.shareIntent, app.consumeShareIntent]);

  useEffect(() => {
    const hadSession = prevSessionRef.current !== null;
    const hasSession = app.session !== null;

    if (!hadSession && hasSession && navigationRef.isReady()) {
      const gotoParam = Platform.OS === 'web'
        ? new URLSearchParams(window.location.search).get('goto')
        : null;
      if (!gotoParam) {
        navigationRef.navigate('Setup');
      }
    }

    if (hadSession && !hasSession && navigationRef.isReady()) {
      navigationRef.reset({
        index: 0,
        routes: [{ name: 'Login' }],
      });
    }

    prevSessionRef.current = app.session;
  }, [app.session]);

  if (isEmbedContext() && app.embedMismatch) {
    return (
      <View style={styles.mismatchContainer}>
        <Text style={styles.mismatchTitle}>{t('embed.mismatchTitle')}</Text>
        <Text style={styles.mismatchBody}>{t('embed.mismatchBody')}</Text>
      </View>
    );
  }

  if (!isReady) {
    return (
      <View style={styles.loading}>
        <LogoSpinner />
      </View>
    );
  }

  return (
    <NavigationContainer
      ref={navigationRef}
      onStateChange={updateTitle}
      documentTitle={{ enabled: false }}
    >
      <Stack.Navigator
        initialRouteName={initialRoute}
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      >
        <Stack.Screen name="Login" component={LoginScreen} />
        <Stack.Screen name="Setup" component={SetupScreen} />
        <Stack.Screen name="ChatList" component={ChatListScreen} />
        <Stack.Screen name="ChatView" component={ChatViewScreen} />
        <Stack.Screen name="QrDisplay" component={QrDisplayScreen} />
        <Stack.Screen name="QrScan" component={QrScanScreen} />
        <Stack.Screen name="Settings" component={SettingsScreen} />
        <Stack.Screen name="About" component={AboutScreen} />
        <Stack.Screen name="CreateGroup" component={CreateGroupScreen} />
        <Stack.Screen name="GroupSettings" component={GroupSettingsScreen} />
        <Stack.Screen name="DmSettings" component={DmSettingsScreen} />
        <Stack.Screen name="BlockList" component={BlockListScreen} />
        <Stack.Screen name="ImageViewer" component={ImageViewerScreen} />
        <Stack.Screen name="VideoViewer" component={VideoViewerScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

/**
 * Route name -> i18n key mapping for web document.title.
 */
const ROUTE_TITLE_KEYS: Record<keyof RootStackParamList, string> = {
  Login: 'login.title',
  Setup: 'setup.title',
  ChatList: 'chatlist.title',
  ChatView: 'chatview.title',
  QrDisplay: 'qrdisplay.title',
  QrScan: 'qrscan.title',
  Settings: 'settings.title',
  About: 'about.title',
  CreateGroup: 'creategroup.create',
  GroupSettings: 'groupsettings.title',
  DmSettings: 'dmsettings.title',
  BlockList: 'blocklist.title',
  ImageViewer: 'imageviewer.title',
  VideoViewer: 'videoviewer.title',
};

export default function App(): React.JSX.Element {
  return (
    <GestureHandlerRootView style={styles.root}>
      <I18nProvider>
        <AppProvider>
          <SafeAreaProvider>
            <NavigationRoot />
          </SafeAreaProvider>
        </AppProvider>
      </I18nProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  loading: {
    flex: 1,
    backgroundColor: theme.colors.background,
    justifyContent: 'center',
    alignItems: 'center',
  },
  mismatchContainer: {
    flex: 1,
    backgroundColor: theme.colors.background,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  mismatchTitle: {
    maxWidth: 480,
    color: theme.colors.textPrimary,
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 12,
  },
  mismatchBody: {
    maxWidth: 480,
    color: theme.colors.textSecondary,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
});
