import { Ionicons } from '@expo/vector-icons';
import { router, Tabs } from 'expo-router';
import React, { useEffect } from 'react';
import { ColorValue, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, FontSize, Spacing } from '../../constants/theme';
import { useAuth } from '../../stores/auth.store';
import { usePendingQueue } from '../../stores/pendingQueue.store';

type IoniconsName = React.ComponentProps<typeof Ionicons>['name'];

function tabIcon(active: IoniconsName, inactive: IoniconsName) {
  return ({ color, focused }: { color: ColorValue; focused: boolean }) => (
    <Ionicons name={focused ? active : inactive} size={22} color={color as string} />
  );
}

// ─── Top bar ──────────────────────────────────────────────────────────────────

function SuperAdminTopBar() {
  const insets = useSafeAreaInsets();
  const { logout } = useAuth();

  function handleSignOut() {
    logout();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.replace('/(auth)/login' as any);
  }

  return (
    <View style={[styles.topBar, { paddingTop: insets.top + 10 }]}>
      <Text style={styles.topBarTitle}>Super Admin</Text>
      <View style={styles.topBarActions}>
        <TouchableOpacity
          style={styles.topBarBtn}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Platform notifications"
        >
          <Ionicons name="notifications-outline" size={24} color={Colors.white} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.topBarBtn}
          onPress={handleSignOut}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
        >
          <Ionicons name="log-out-outline" size={24} color={Colors.white} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function SuperAdminLayout() {
  const insets = useSafeAreaInsets();
  const { user, isLoading, restoreOffline } = useAuth();
  // Live PENDING-church count, written by the Queue screen on every fetch. READ ONLY
  // here — the badge never fetches (single source of truth, no drift). null = not yet
  // known → no badge; 0 → no badge; >0 → the live number.
  const { pendingCount } = usePendingQueue();

  useEffect(() => {
    // Don't bounce to login while a transient restore is offline (tokens kept, retrying)
    // — the root guard shows the offline screen; redirecting here would race it to /login
    // and defeat the offline precedence.
    if (!isLoading && !restoreOffline && user?.role !== 'SUPER_ADMIN') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      router.replace('/(auth)/login' as any);
    }
  }, [isLoading, restoreOffline, user]);

  return (
    <Tabs
      screenOptions={{
        header: () => <SuperAdminTopBar />,
        tabBarStyle: {
          backgroundColor: Colors.white,
          borderTopWidth: 1,
          borderTopColor: Colors.border,
          height: 60 + insets.bottom,
          paddingBottom: insets.bottom + 4,
          paddingTop: 6,
          elevation: 12,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: -3 },
          shadowOpacity: 0.08,
          shadowRadius: 8,
        },
        tabBarActiveTintColor: Colors.primary,
        tabBarInactiveTintColor: Colors.textMuted,
        tabBarLabelStyle: {
          fontFamily: 'Poppins-Medium',
          fontSize: 11,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Queue',
          tabBarBadge: pendingCount != null && pendingCount > 0 ? pendingCount : undefined,
          tabBarBadgeStyle: { backgroundColor: Colors.danger },
          tabBarIcon: tabIcon('person-add', 'person-add-outline'),
        }}
      />
      <Tabs.Screen
        name="churches"
        options={{
          title: 'Churches',
          tabBarIcon: tabIcon('business', 'business-outline'),
        }}
      />
      <Tabs.Screen
        name="withdrawals"
        options={{
          title: 'Withdrawals',
          tabBarIcon: tabIcon('arrow-up-circle', 'arrow-up-circle-outline'),
        }}
      />
      <Tabs.Screen
        name="analytics"
        options={{
          title: 'Analytics',
          tabBarIcon: tabIcon('stats-chart', 'stats-chart-outline'),
        }}
      />
      <Tabs.Screen
        name="billing"
        options={{
          title: 'Billing',
          tabBarIcon: tabIcon('card', 'card-outline'),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: tabIcon('ellipsis-horizontal', 'ellipsis-horizontal-outline'),
        }}
      />
      {/* Hidden screens — navigable from More screen */}
      <Tabs.Screen name="campaigns"  options={{ href: null }} />
      <Tabs.Screen name="donations"  options={{ href: null }} />
      <Tabs.Screen name="audit-log"  options={{ href: null }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.md,
    paddingBottom: 12,
  },
  topBarTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.white,
    flex: 1,
  },
  topBarActions: {
    flexDirection: 'row',
    gap: 4,
  },
  topBarBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
