import { Ionicons } from '@expo/vector-icons';
import { router, Tabs } from 'expo-router';
import React, { useState } from 'react';
import { ColorValue, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { useAuth } from '../../stores/auth.store';

type IoniconsName = React.ComponentProps<typeof Ionicons>['name'];

function tabIcon(active: IoniconsName, inactive: IoniconsName) {
  return ({ color, focused }: { color: ColorValue; focused: boolean }) => (
    <Ionicons name={focused ? active : inactive} size={22} color={color as string} />
  );
}

// ─── Top bar ──────────────────────────────────────────────────────────────────

function TreasurerTopBar() {
  const { logout, user } = useAuth();
  const insets = useSafeAreaInsets();
  const [showConfirm, setShowConfirm] = useState(false);
  // Real church name from /auth/me. Fallback keeps the bar from rendering blank
  // in the brief window before the user is hydrated.
  const churchName = user?.churchName || 'My Church';

  function handleConfirmSignOut() {
    setShowConfirm(false);
    logout();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.replace('/(auth)/login' as any);
  }

  return (
    <>
      <View style={[styles.topBar, { paddingTop: insets.top + 10 }]}>
        <Text style={styles.churchName} numberOfLines={1}>
          {churchName}
        </Text>
        <TouchableOpacity
          style={styles.signOutBtn}
          onPress={() => setShowConfirm(true)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
        >
          <Text style={styles.signOutBtnText}>Sign Out</Text>
        </TouchableOpacity>
      </View>

      <Modal
        visible={showConfirm}
        transparent
        animationType="fade"
        onRequestClose={() => setShowConfirm(false)}
      >
        <TouchableOpacity
          style={styles.overlay}
          activeOpacity={1}
          onPress={() => setShowConfirm(false)}
          accessibilityRole="none"
        >
          <View style={styles.dialogCard} onStartShouldSetResponder={() => true}>
            <Text style={styles.dialogTitle}>Sign Out</Text>
            <Text style={styles.dialogMessage}>
              Are you sure you want to sign out of your church account?
            </Text>
            <View style={styles.dialogBtns}>
              <TouchableOpacity
                style={styles.cancelDialogBtn}
                onPress={() => setShowConfirm(false)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={styles.cancelDialogBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.confirmBtn}
                onPress={handleConfirmSignOut}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Confirm sign out"
              >
                <Text style={styles.confirmBtnText}>Sign Out</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function TreasurerLayout() {
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        header: () => <TreasurerTopBar />,
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
          title: 'Overview',
          tabBarIcon: tabIcon('home', 'home-outline'),
        }}
      />
      <Tabs.Screen
        name="campaigns"
        options={{
          title: 'Campaigns',
          tabBarIcon: tabIcon('grid', 'grid-outline'),
        }}
      />
      <Tabs.Screen
        name="payouts"
        options={{
          title: 'Payouts',
          tabBarIcon: tabIcon('arrow-up-circle', 'arrow-up-circle-outline'),
        }}
      />
      <Tabs.Screen
        name="reports"
        options={{
          title: 'Reports',
          tabBarIcon: tabIcon('stats-chart', 'stats-chart-outline'),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: tabIcon('settings', 'settings-outline'),
        }}
      />
      {/* Hidden screens — navigable but not in tab bar */}
      <Tabs.Screen name="notifications" options={{ href: null }} />
      <Tabs.Screen name="groups" options={{ href: null }} />
    </Tabs>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.md,
    paddingBottom: 12,
  },
  churchName: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.white,
    flex: 1,
    marginRight: Spacing.sm,
  },
  signOutBtn: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.6)',
    borderRadius: BorderRadius.md,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  signOutBtnText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.white,
  },

  // Confirmation modal
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
  },
  dialogCard: {
    width: '100%',
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.xl,
    padding: Spacing.xl,
    gap: Spacing.md,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 10,
  },
  dialogTitle: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.text,
  },
  dialogMessage: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    lineHeight: FontSize.base * 1.6,
  },
  dialogBtns: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  cancelDialogBtn: {
    flex: 1,
    height: 48,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelDialogBtnText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.base,
    color: Colors.textSecondary,
  },
  confirmBtn: {
    flex: 1,
    height: 48,
    backgroundColor: Colors.danger,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.base,
    color: Colors.white,
  },
});
