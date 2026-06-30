import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BorderRadius, Colors, FontSize, Spacing } from '../constants/theme';

// Shown by the root guard while session restore is blocked by a NETWORK/transient
// error (NOT a real auth failure). The stored tokens are KEPT and restore auto-retries
// with capped backoff. This screen deliberately offers ONLY "Retry now" — never a
// logout that would wipe a session that is probably still valid.
export function OfflineScreen({ onRetry }: { onRetry: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[styles.root, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}
      accessibilityLabel="Can't reach the server, reconnecting"
    >
      <Ionicons name="cloud-offline-outline" size={56} color={Colors.textMuted} />
      <Text style={styles.title}>Can’t reach the server</Text>
      <Text style={styles.body}>
        You’re still signed in. We’ll reconnect automatically as soon as your connection is back.
      </Text>
      <View style={styles.reconnectRow}>
        <ActivityIndicator size="small" color={Colors.primary} />
        <Text style={styles.reconnectText}>Reconnecting…</Text>
      </View>
      <TouchableOpacity
        style={styles.retryBtn}
        onPress={onRetry}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="Retry now"
      >
        <Ionicons name="refresh-outline" size={16} color={Colors.white} />
        <Text style={styles.retryBtnText}>Retry now</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background, // #FFFFFF — all screen backgrounds are white
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 14,
  },
  title: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.xl,
    color: Colors.text,
    textAlign: 'center',
  },
  body: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  reconnectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  reconnectText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 12,
    paddingHorizontal: 24,
    height: Spacing.touch,
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.md,
  },
  retryBtnText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.base,
    color: Colors.white,
  },
});
