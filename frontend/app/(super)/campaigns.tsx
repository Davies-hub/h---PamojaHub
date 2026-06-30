import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ProgressBar from '../../components/ui/ProgressBar';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { useFocusRefetch } from '../../hooks/useFocusRefetch';
import { superadminService } from '../../services/superadmin.service';
import { CampaignCategory, CampaignStatus, PublicCampaign } from '../../types';
import { fmtKes } from '../../utils/formatters';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<CampaignStatus, { bg: string; text: string }> = {
  ACTIVE: { bg: Colors.successLight, text: Colors.success },
  PAUSED: { bg: Colors.warningLight, text: Colors.warning },
  CLOSED: { bg: Colors.grey,         text: Colors.textMuted },
};

const CATEGORIES: (CampaignCategory | 'All')[] = [
  'All', 'Building', 'Education', 'Outreach', 'Youth', 'Medical', 'Relief', 'Other',
];

const STATUSES: (CampaignStatus | 'ALL')[] = ['ALL', 'ACTIVE', 'PAUSED', 'CLOSED'];

function FilterChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── Campaign row ─────────────────────────────────────────────────────────────

function CampaignRow({ item }: { item: PublicCampaign }) {
  const pct = Math.min(100, Math.round((item.raisedAmount / item.goalAmount) * 100));
  const { bg, text } = STATUS_BADGE[item.status];

  return (
    <View style={styles.row}>
      <View style={styles.rowTop}>
        <View style={styles.rowLeft}>
          <Text style={styles.rowTitle} numberOfLines={2}>{item.title}</Text>
          <Text style={styles.rowChurch} numberOfLines={1}>{item.churchName}</Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: bg }]}>
          <Text style={[styles.statusText, { color: text }]}>
            {item.status.charAt(0) + item.status.slice(1).toLowerCase()}
          </Text>
        </View>
      </View>

      <View style={styles.rowMeta}>
        <View style={[styles.categoryChip]}>
          <Text style={styles.categoryText}>{item.category}</Text>
        </View>
        <Text style={styles.metaDot}>·</Text>
        <Text style={styles.metaText}>{item.donorCount} donors</Text>
      </View>

      <View style={styles.progressRow}>
        <ProgressBar raised={item.raisedAmount} goal={item.goalAmount} showLabels={false} />
        <View style={styles.progressLabels}>
          <Text style={styles.raisedText}>{fmtKes(item.raisedAmount)}</Text>
          <Text style={styles.goalText}>{pct}% of {fmtKes(item.goalAmount)}</Text>
        </View>
      </View>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function SuperCampaignsScreen() {
  const router = useRouter();
  const [search, setSearch]   = useState('');
  const [status, setStatus]   = useState<CampaignStatus | 'ALL'>('ALL');
  const [category, setCategory] = useState<CampaignCategory | 'All'>('All');

  // R2: background refetch-on-focus (shared hook). First focus = spinner; every
  // revisit refetches in the BACKGROUND (list stays, no blank/flash). DISPLAY-class
  // (no handler mutates the list) → derive the view straight from `data`, no mirror.
  // Still consumes the D5 Paginated shape; mapPublicCampaign drops sensitive keys.
  const { data, status: cState, retry } = useFocusRefetch(
    () => superadminService.listCampaigns(),
  );
  const campaigns = data?.items ?? [];
  const total     = data?.total ?? 0;
  const truncated = data?.truncated ?? false;

  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        router.navigate('/(super)/more' as any);
        return true;
      });
      return () => sub.remove();
    }, [router])
  );

  const filtered = useMemo(() => {
    return campaigns.filter(c => {
      if (search.trim() &&
        !c.title.toLowerCase().includes(search.toLowerCase()) &&
        !c.churchName.toLowerCase().includes(search.toLowerCase())
      ) return false;
      if (status !== 'ALL' && c.status !== status) return false;
      if (category !== 'All' && c.category !== category) return false;
      return true;
    });
  }, [campaigns, search, status, category]);

  return (
    <SafeAreaView edges={['bottom']} style={styles.root}>
      {/* Back bar */}
      <View style={styles.backBar}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.navigate('/(super)/more' as any)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Go back to More"
        >
          <Ionicons name="arrow-back" size={22} color={Colors.primary} />
          <Text style={styles.backBtnText}>More</Text>
        </TouchableOpacity>
        <Text style={styles.backBarTitle}>Campaigns</Text>
        <View style={styles.backBarSpacer} />
      </View>
      {/* Filter bar */}
      <View style={styles.filterBar}>
        <View style={styles.searchRow}>
          <Ionicons name="search-outline" size={16} color={Colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search campaigns or churches…"
            placeholderTextColor={Colors.textMuted}
            value={search}
            onChangeText={setSearch}
            accessibilityLabel="Search campaigns"
          />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipsScroll}
        >
          {STATUSES.map(s => (
            <FilterChip
              key={s}
              label={s === 'ALL' ? 'All Status' : s.charAt(0) + s.slice(1).toLowerCase()}
              active={status === s}
              onPress={() => setStatus(s)}
            />
          ))}
          <View style={styles.chipDivider} />
          {CATEGORIES.map(c => (
            <FilterChip
              key={c}
              label={c}
              active={category === c}
              onPress={() => setCategory(c)}
            />
          ))}
        </ScrollView>
      </View>

      {cState === 'loading' ? (
        <View style={styles.centerBlock}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : cState === 'error' ? (
        <View style={styles.errorBlock}>
          <Ionicons name="cloud-offline-outline" size={40} color={Colors.border} />
          <Text style={styles.errorText}>Couldn’t load campaigns.</Text>
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
      ) : (
        <>
          {truncated ? (
            <View style={styles.truncBanner}>
              <Ionicons name="information-circle-outline" size={15} color={Colors.warning} />
              <Text style={styles.truncText}>Showing first {campaigns.length} of {total}.</Text>
            </View>
          ) : null}
          <FlatList
            data={filtered}
            keyExtractor={item => item.id}
            renderItem={({ item }) => <CampaignRow item={item} />}
            contentContainerStyle={styles.listContent}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Ionicons name="grid-outline" size={48} color={Colors.border} />
                <Text style={styles.emptyTitle}>No campaigns found</Text>
              </View>
            }
          />
        </>
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.grey },

  // Loading / error (same pattern as S1 billing + the wired treasurer reads)
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

  // D5 truncation notice (warning tokens) — a NOTICE only, never paging controls.
  truncBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.warningLight,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
  },
  truncText: { fontFamily: 'Poppins-Medium', fontSize: FontSize.xs, color: Colors.warning },

  backBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    paddingHorizontal: Spacing.md,
    height: 48,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    width: 72,
  },
  backBtnText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.base,
    color: Colors.primary,
  },
  backBarTitle: {
    flex: 1,
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
    textAlign: 'center',
  },
  backBarSpacer: { width: 72 },

  filterBar: {
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    paddingBottom: 8,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: Spacing.md,
    marginBottom: 8,
    paddingHorizontal: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    height: 40,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.text,
    height: '100%',
  },
  chipsScroll: { paddingHorizontal: Spacing.md, gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: BorderRadius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontFamily: 'Poppins-Medium', fontSize: FontSize.xs, color: Colors.textSecondary },
  chipTextActive: { color: Colors.white },
  chipDivider: { width: 1, backgroundColor: Colors.border, marginHorizontal: 4 },

  listContent: { padding: Spacing.md, paddingBottom: Spacing.xl },
  separator: { height: Spacing.sm },

  row: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    gap: Spacing.sm,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
  },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  rowLeft: { flex: 1, gap: 2 },
  rowTitle: { fontFamily: 'Poppins-SemiBold', fontSize: FontSize.base, color: Colors.text },
  rowChurch: { fontFamily: 'Poppins-Regular', fontSize: FontSize.xs, color: Colors.primary },
  statusBadge: { borderRadius: BorderRadius.pill, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  statusText: { fontFamily: 'Poppins-Medium', fontSize: 10 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  categoryChip: {
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  categoryText: { fontFamily: 'Poppins-Medium', fontSize: FontSize.xs, color: Colors.primary },
  metaDot: { fontFamily: 'Poppins-Regular', fontSize: FontSize.xs, color: Colors.textMuted },
  metaText: { fontFamily: 'Poppins-Regular', fontSize: FontSize.xs, color: Colors.textMuted },
  progressRow: { gap: 6 },
  progressLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  raisedText: { fontFamily: 'Poppins-SemiBold', fontSize: FontSize.sm, color: Colors.text },
  goalText: { fontFamily: 'Poppins-Regular', fontSize: FontSize.xs, color: Colors.textMuted },

  emptyState: { alignItems: 'center', paddingTop: 60, gap: Spacing.sm },
  emptyTitle: { fontFamily: 'Poppins-SemiBold', fontSize: FontSize.lg, color: Colors.text, marginTop: Spacing.sm },
});
