import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';

type IoniconsName = React.ComponentProps<typeof Ionicons>['name'];

const ITEMS: { label: string; subtitle: string; icon: IoniconsName; route: string }[] = [
  {
    label: 'Campaigns',
    subtitle: 'Platform-wide campaign list',
    icon: 'grid-outline',
    route: '/(super)/campaigns',
  },
  {
    label: 'Donations',
    subtitle: 'All M-Pesa transactions',
    icon: 'cash-outline',
    route: '/(super)/donations',
  },
  {
    label: 'Audit Log',
    subtitle: 'Full action history',
    icon: 'document-text-outline',
    route: '/(super)/audit-log',
  },
];

export default function MoreScreen() {
  const router = useRouter();

  return (
    <SafeAreaView edges={['bottom']} style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>More</Text>
      </View>

      <View style={styles.list}>
        {ITEMS.map((item, idx) => (
          <React.Fragment key={item.route}>
            <TouchableOpacity
              style={styles.row}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onPress={() => router.push(item.route as any)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={item.label}
            >
              <View style={styles.iconWrap}>
                <Ionicons name={item.icon} size={22} color={Colors.primary} />
              </View>
              <View style={styles.rowBody}>
                <Text style={styles.rowLabel}>{item.label}</Text>
                <Text style={styles.rowSubtitle}>{item.subtitle}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={Colors.textMuted} />
            </TouchableOpacity>
            {idx < ITEMS.length - 1
              ? <View style={styles.divider} />
              : null}
          </React.Fragment>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.grey },

  header: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  headerTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },

  list: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    marginHorizontal: Spacing.md,
    overflow: 'hidden',
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: 14,
    gap: Spacing.md,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: { flex: 1 },
  rowLabel: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.base,
    color: Colors.text,
  },
  rowSubtitle: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    marginTop: 1,
  },

  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginLeft: 72,
  },
});
