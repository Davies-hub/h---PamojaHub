import * as Font from 'expo-font';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useRef, useState } from 'react';
import { Animated, Image, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../stores/auth.store';
import { NotificationsProvider } from '../stores/notifications.store';
import { PendingQueueProvider } from '../stores/pendingQueue.store';
import { OfflineScreen } from '../components/OfflineScreen';
import { resolveAuthDestination } from '../utils/authRouting';

SplashScreen.preventAutoHideAsync();

const FONTS = [
  { name: 'Poppins-Bold',     source: require('../assets/fonts/Poppins-Bold.ttf') },
  { name: 'Poppins-SemiBold', source: require('../assets/fonts/Poppins-SemiBold.ttf') },
  { name: 'Poppins-Medium',   source: require('../assets/fonts/Poppins-Medium.ttf') },
  { name: 'Poppins-Regular',  source: require('../assets/fonts/Poppins-Regular.ttf') },
];

// ─── Loading Screen ────────────────────────────────────────────────────────────

function LoadingScreen({ progress }: { progress: number }) {
  const insets = useSafeAreaInsets();
  const animated = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(animated, {
      toValue: progress,
      duration: 280,
      useNativeDriver: false,
    }).start();
  }, [progress]);

  const barWidth = animated.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <View style={[styles.splash, { paddingBottom: insets.bottom + 40 }]}>
      {/* Logo with softened (rounded) edges */}
      <View style={styles.logoContainer}>
        <Image
          source={require('../assets/images/favicon.png')}
          style={styles.logoImage}
          resizeMode="contain"
        />
      </View>

      <Text style={styles.wordmarkPamoja}>
        Pamoja <Text style={styles.wordmarkHub}>Hub</Text>
      </Text>

      {/* Progress bar */}
      <View style={styles.progressTrack}>
        <Animated.View style={[styles.progressFill, { width: barWidth }]} />
      </View>
    </View>
  );
}

// ─── Auth-aware navigator ────────────────────────────────────────────────────
// Renders the Stack and enforces the session-restore routing. The router WAITS for
// hydration (auth.isLoading) and for any pending redirect to settle before letting
// the underlying screen show — so a reload never flashes the public landing before
// /auth/me resolves. The redirect decision is the SHARED resolveAuthDestination,
// identical to the login screen's.

function RootNavigator() {
  const { user, isLoading, restoreFailed, restoreOffline, retryRestore } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  const group = segments[0]; // '(public)' | '(auth)' | '(treasurer)' | '(super)' | undefined
  const dest = resolveAuthDestination(user);

  // Where SHOULD we be? null = no forced move (leave public/auth as-is).
  let target: string | null = null;
  if (dest === '/(super)/' && group !== '(super)') target = '/(super)/';
  else if (dest === '/(treasurer)/' && group !== '(treasurer)') target = '/(treasurer)/';
  else if (dest === '/login' && group !== '(auth)') target = '/login';
  else if (!dest && restoreFailed && group !== '(auth)') target = '/login'; // dead-token reload → login

  useEffect(() => {
    // While restoreOffline, HOLD: a kept-token-but-no-user network blip must show the
    // OFFLINE screen, never route to login. restoreOffline therefore takes precedence
    // over the "no user → login" branch above (the trace's target-6 trap).
    if (isLoading || restoreOffline || !target) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.replace(target as any);
  }, [isLoading, restoreOffline, target, router]);

  // Guard precedence: isLoading → splash; restoreOffline → OFFLINE screen; user present
  // → app (target routes there); restoreFailed / no user → login. The splash is held
  // while hydrating OR while a redirect is pending, but NOT while offline (the offline
  // overlay wins instead, so a blip never flashes the splash-then-login).
  const showSplash = isLoading || (!restoreOffline && !!target);

  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(public)" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(treasurer)" />
        <Stack.Screen name="(super)" />
      </Stack>
      {restoreOffline ? (
        <View style={StyleSheet.absoluteFill}>
          <OfflineScreen onRetry={retryRestore} />
        </View>
      ) : showSplash ? (
        <View style={StyleSheet.absoluteFill}>
          <LoadingScreen progress={1} />
        </View>
      ) : null}
    </>
  );
}

// ─── Root Layout ───────────────────────────────────────────────────────────────

export default function RootLayout() {
  const [fontsLoaded, setFontsLoaded] = useState(false);
  const [loadProgress, setLoadProgress] = useState(0);

  useEffect(() => {
    SplashScreen.hideAsync();

    async function loadAll() {
      try {
        for (let i = 0; i < FONTS.length; i++) {
          await Font.loadAsync({ [FONTS[i].name]: FONTS[i].source });
          setLoadProgress((i + 1) / FONTS.length);
        }
      } catch {
        // proceed even if a font fails — app should still be usable
      } finally {
        setFontsLoaded(true);
      }
    }
    loadAll();
  }, []);

  if (!fontsLoaded) {
    return (
      <SafeAreaProvider>
        <LoadingScreen progress={loadProgress} />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <NotificationsProvider>
          <PendingQueueProvider>
            <RootNavigator />
          </PendingQueueProvider>
        </NotificationsProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const PRIMARY = '#057C8A';
const ACCENT  = '#ED8F1C';
const WHITE   = '#FFFFFF';

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: PRIMARY,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },

  logoContainer: {
    width: 160,
    height: 160,
    borderRadius: 32,
    backgroundColor: WHITE,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 20,
    elevation: 12,
  },
  logoImage: {
    width: 130,
    height: 130,
  },

  wordmarkPamoja: {
    fontFamily: 'System',
    fontSize: 28,
    fontWeight: '700',
    color: WHITE,
    letterSpacing: 0.5,
  },
  wordmarkHub: {
    color: ACCENT,
  },

  progressTrack: {
    width: 200,
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderRadius: 2,
    overflow: 'hidden',
    marginTop: 8,
  },
  progressFill: {
    height: '100%',
    backgroundColor: ACCENT,
    borderRadius: 2,
  },
});
