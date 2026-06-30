import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { useFocusRefetch } from '../../hooks/useFocusRefetch';
import { superadminService } from '../../services/superadmin.service';
import { fmtKes } from '../../utils/formatters';

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon,
  iconColor,
}: {
  label: string;
  value: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  iconColor: string;
}) {
  return (
    <View style={styles.statCard}>
      <View style={[styles.statIconWrap, { backgroundColor: iconColor + '20' }]}>
        <Ionicons name={icon} size={22} color={iconColor} />
      </View>
      <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ─── Chart placeholder ────────────────────────────────────────────────────────

function ChartPlaceholder({ label }: { label: string }) {
  return (
    <View style={styles.chartCard}>
      <Text style={styles.chartCardLabel}>{label}</Text>
      <View style={styles.chartBox}>
        <Ionicons name="bar-chart-outline" size={36} color={Colors.primaryLight} />
        <Text style={styles.chartBoxText}>Chart available after backend connection</Text>
      </View>
    </View>
  );
}

// ─── Time range chip ──────────────────────────────────────────────────────────

type TimeRange = 'This Month' | 'Last 30 Days' | 'This Year' | 'All Time';
const TIME_RANGES: TimeRange[] = ['This Month', 'Last 30 Days', 'This Year', 'All Time'];

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function SuperAnalyticsScreen() {
  // timeRange stays INERT this slice — the endpoint accepts from/to params but
  // wiring date-filtering is its own later slice. Cosmetic UI only.
  const [timeRange, setTimeRange] = useState<TimeRange>('All Time');

  // R2: background refetch-on-focus (shared hook). First focus shows the spinner;
  // every revisit refetches in the BACKGROUND (cards stay, no blank/flash). DISPLAY-
  // class — no local handler mutates this data, so we read the server's pre-aggregated
  // object straight from `data` (no mirror). The old client-side mock .reduce() is gone.
  const { data, status: aState, retry } = useFocusRefetch(
    () => superadminService.getAnalytics(),
  );

  return (
    <SafeAreaView edges={['bottom']} style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Time range filter */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.rangeScroll}
        >
          {TIME_RANGES.map(r => (
            <TouchableOpacity
              key={r}
              style={[styles.rangeChip, timeRange === r && styles.rangeChipActive]}
              onPress={() => setTimeRange(r)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={r}
            >
              <Text style={[styles.rangeChipText, timeRange === r && styles.rangeChipTextActive]}>
                {r}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {aState === 'loading' ? (
          <View style={styles.centerBlock}>
            <ActivityIndicator size="large" color={Colors.primary} />
          </View>
        ) : aState === 'error' ? (
          <View style={styles.errorBlock}>
            <Ionicons name="cloud-offline-outline" size={40} color={Colors.border} />
            <Text style={styles.errorText}>Couldn’t load analytics.</Text>
            <TouchableOpacity
              style={styles.retryBtn}
              onPress={retry}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Try again"
            >
              <Text style={styles.retryBtnText}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : data ? (
          <>
            {/* 2×2 stat grid — server aggregates */}
            <View style={styles.grid}>
              <StatCard
                label="Total Churches"
                value={String(data.totalChurches)}
                icon="business-outline"
                iconColor={Colors.primary}
              />
              <StatCard
                label="Active Campaigns"
                value={String(data.totalActiveCampaigns)}
                icon="grid-outline"
                iconColor={Colors.success}
              />
              <StatCard
                label="Total Donations"
                value={fmtKes(data.totalDonations)}
                icon="cash-outline"
                iconColor={Colors.accent}
              />
              <StatCard
                label="Platform Fees"
                value={fmtKes(data.totalPlatformFees)}
                icon="trending-up-outline"
                iconColor={Colors.primary}
              />
            </View>

            {/* Chart placeholders */}
            <ChartPlaceholder label="Donations by Month" />
            <ChartPlaceholder label="Top 10 Churches by Raised" />
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.grey },
  content: {
    padding: Spacing.md,
    paddingBottom: Spacing.xl,
    gap: Spacing.md,
  },

  // Loading / error (same pattern as S1–S5)
  centerBlock: { paddingVertical: 48, alignItems: 'center', justifyContent: 'center' },
  errorBlock: { paddingVertical: 40, alignItems: 'center', gap: Spacing.sm },
  errorText: { fontFamily: 'Poppins-Regular', fontSize: FontSize.md, color: Colors.textMuted, textAlign: 'center' },
  retryBtn: {
    marginTop: 4,
    paddingHorizontal: Spacing.lg,
    height: Spacing.touch,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryBtnText: { fontFamily: 'Poppins-SemiBold', fontSize: FontSize.md, color: Colors.white },

  rangeScroll: { gap: 8, paddingBottom: 4 },
  rangeChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: BorderRadius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
  },
  rangeChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  rangeChipText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  rangeChipTextActive: { color: Colors.white },

  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  statCard: {
    width: '48%',
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    gap: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
  },
  statIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statValue: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.text,
  },
  statLabel: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },

  chartCard: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.primaryLight,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
  },
  chartCardLabel: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.base,
    color: Colors.text,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.primaryLight,
  },
  chartBox: {
    height: 200,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
  },
  chartBoxText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: Spacing.xl,
  },
});
