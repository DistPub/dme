/**
 * App.tsx - DME entry point with navigation and providers.
 *
 * Provider stack:
 *   GestureHandlerRootView
 *     -> AppProvider
 *       -> SafeAreaProvider
 *         -> NavigationContainer
 *           -> Stack.Navigator
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
import { Platform, StyleSheet, View, ActivityIndicator } from 'react-native';

import { AppProvider, useApp } from './src/state/AppContext';
import { theme } from './src/ui/theme';
import { FontProvider } from './src/ui/FontProvider';
import { LoginScreen } from './src/ui/LoginScreen';
import { SetupScreen } from './src/ui/SetupScreen';
import { ChatListScreen } from './src/ui/ChatListScreen';
import { ChatViewScreen } from './src/ui/ChatViewScreen';
import { QrDisplayScreen } from './src/ui/QrDisplayScreen';
import { QrScanScreen } from './src/ui/QrScanScreen';
import type { RootStackParamList } from './src/types/navigation';

export type { RootStackParamList };

const Stack = createNativeStackNavigator<RootStackParamList>();
const navigationRef = createNavigationContainerRef<RootStackParamList>();

function NavigationRoot(): React.JSX.Element {
  const app = useApp();
  const [isReady, setIsReady] = useState(false);
  const [initialRoute, setInitialRoute] = useState<keyof RootStackParamList>('Login');
  const prevSessionRef = useRef(app.session);

  useEffect(() => {
    let cancelled = false;

    async function init(): Promise<void> {
      const restored = await app.restoreSession();
      if (!cancelled) {
        let route: keyof RootStackParamList = 'Login';
        if (restored) {
          const gotoParam = Platform.OS === 'web'
            ? new URLSearchParams(window.location.search).get('goto')
            : null;
          if (gotoParam === 'QrDisplay' || gotoParam === 'QrScan' || gotoParam === 'ChatList') {
            route = gotoParam;
          } else {
            route = 'Setup';
          }
        }
        setInitialRoute(route);
        setIsReady(true);
      }
    }

    init();

    return () => {
      cancelled = true;
    };
  }, []);

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

  if (!isReady) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={theme.colors.accent} />
      </View>
    );
  }

  return (
    <NavigationContainer ref={navigationRef}>
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
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App(): React.JSX.Element {
  return (
    <GestureHandlerRootView style={styles.root}>
      <AppProvider>
        <FontProvider>
          <SafeAreaProvider>
            <NavigationRoot />
          </SafeAreaProvider>
        </FontProvider>
      </AppProvider>
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
});
