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
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { useFocusRefetch } from '../../hooks/useFocusRefetch';
import { superadminService } from '../../services/superadmin.service';
import { AuditLog } from '../../types';
import { formatDateTime } from '../../utils/formatters';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Drift fix: 'Auth' dropped (no endpoint emits it); 'PlatformSettings' added
// (billing/settings-change rows emit it). 'Donation' added (DONATION_FAILED rows
// emit it) so those rows are independently filterable, not only under "All".
type EntityFilter = 'ALL' | 'Church' | 'Campaign' | 'Withdrawal' | 'PlatformSettings' | 'Donation';
type DateFilter   = 'ALL_TIME' | 'TODAY' | 'THIS_WEEK' | 'THIS_MONTH';

const ENTITY_FILTERS: EntityFilter[] = ['ALL', 'Church', 'Campaign', 'Withdrawal', 'PlatformSettings', 'Donation'];

const DATE_OPTIONS: { key: DateFilter; label: string }[] = [
  { key: 'ALL_TIME',   label: 'All Time' },
  { key: 'TODAY',      label: 'Today' },
  { key: 'THIS_WEEK',  label: 'This Week' },
  { key: 'THIS_MONTH', label: 'This Month' },
];

function getActionStyle(action: string): { text: string; bg: string } {
  if (action.includes('REJECTED') || action.includes('FAILED') || action.includes('SUSPENDED')) {
    return { text: Colors.danger, bg: Colors.dangerLight };
  }
  // PAID added → WITHDRAWAL_PAID + WITHDRAWAL_RESOLVED_PAID (money delivered) colour
  // as success (PAID is checked before the warning branch so RESOLVED_PAID wins here).
  if (action.includes('APPROVED') || action.includes('SUCCESS') || action.includes('VERIFIED') || action.includes('PAID')) {
    return { text: Colors.success, bg: Colors.successLight };
  }
  // RETRIED/RETRY/FORCE/RESOLVED added → WITHDRAWAL_RETRIED, WITHDRAWAL_FORCE_RETRIED,
  // WITHDRAWAL_RESOLVED_RETRY (interventions / in-progress) colour as warning instead
  // of falling through to neutral.
  if (
    action.includes('PAUSED') || action.includes('CHANGED') || action.includes('CLOSED') ||
    action.includes('RETRIED') || action.includes('RETRY') || action.includes('FORCE') ||
    action.includes('RESOLVED')
  ) {
    return { text: Colors.warning, bg: Colors.warningLight };
  }
  return { text: Colors.primary, bg: Colors.primaryLight };
}

const ENTITY_ICON: Record<string, React.ComponentProps<typeof Ionicons>['name']> = {
  Church:     'business-outline',
  Campaign:   'grid-outline',
  Withdrawal: 'arrow-up-circle-outline',
  Auth:       'shield-checkmark-outline',
};

function truncateId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8).toUpperCase();
}

function isInDateRange(dateStr: string, filter: DateFilter): boolean {
  const ts = new Date(dateStr).getTime();
  if (filter === 'ALL_TIME') return true;
  if (filter === 'TODAY') {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return ts >= start.getTime();
  }
  if (filter === 'THIS_WEEK') return ts >= Date.now() - 7 * 24 * 60 * 60 * 1000;
  if (filter === 'THIS_MONTH') {
    const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
    return ts >= start.getTime();
  }
  return true;
}

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

// ─── Audit row ────────────────────────────────────────────────────────────────

function AuditRow({ item }: { item: AuditLog }) {
  const actionStyle = getActionStyle(item.action);
  const isDanger    = actionStyle.text === Colors.danger;
  const iconName    = ENTITY_ICON[item.entityType] ?? 'document-text-outline';

  return (
    <View style={[styles.row, isDanger && styles.rowDanger]}>
      <View style={styles.rowTop}>
        <View style={[styles.actionBadge, { backgroundColor: actionStyle.bg }]}>
          <Text style={[styles.actionText, { color: actionStyle.text }]}>{item.action}</Text>
        </View>
        <Text style={styles.timestamp}>{formatDateTime(item.timestamp)}</Text>
      </View>

      <View style={styles.metaRow}>
        <View style={styles.entityGroup}>
          <Ionicons name={iconName} size={11} color={Colors.textMuted} />
          <Text style={styles.entityType}>{item.entityType}</Text>
          <View style={styles.idPill}>
            <Text style={styles.entityId}>#{truncateId(item.entityId)}</Text>
          </View>
        </View>
        <Text style={styles.actor} numberOfLines={1}>{item.actor}</Text>
      </View>

      {item.notes ? (
        <Text style={styles.notes} numberOfLines={2}>{item.notes}</Text>
      ) : null}
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function AuditLogScreen() {
  const router = useRouter();
  const [entityFilter, setEntityFilter] = useState<EntityFilter>('ALL');
  const [dateFilter, setDateFilter]     = useState<DateFilter>('ALL_TIME');

  // DISPLAY-class: this screen only filters/renders — no handler mutates the list —
  // so read `data` straight from the hook, NO mirror. Background refetch-on-focus:
  // first focus = spinner; every revisit refetches in the BACKGROUND (list stays).
  const { data, status: alState, retry } = useFocusRefetch(
    () => superadminService.listAuditLog(),
  );
  const logs      = data?.items ?? [];
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
    return logs.filter(log => {
      if (entityFilter !== 'ALL' && log.entityType !== entityFilter) return false;
      if (!isInDateRange(log.timestamp, dateFilter)) return false;
      return true;
    });
  }, [logs, entityFilter, dateFilter]);

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
        <Text style={styles.backBarTitle}>Audit Log</Text>
        <View style={styles.backBarSpacer} />
      </View>
      <View style={styles.filterBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipsScroll}
        >
          {ENTITY_FILTERS.map(e => (
            <FilterChip
              key={e}
              label={e === 'ALL' ? 'All Entities' : e}
              active={entityFilter === e}
              onPress={() => setEntityFilter(e)}
            />
          ))}
          <View style={styles.chipDivider} />
          {DATE_OPTIONS.map(d => (
            <FilterChip
              key={d.key}
              label={d.label}
              active={dateFilter === d.key}
              onPress={() => setDateFilter(d.key)}
            />
          ))}
        </ScrollView>
      </View>

      {alState === 'loading' ? (
        <View style={styles.centerBlock}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : alState === 'error' ? (
        <View style={styles.errorBlock}>
          <Ionicons name="cloud-offline-outline" size={40} color={Colors.border} />
          <Text style={styles.errorText}>Couldn’t load the audit log.</Text>
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
              <Text style={styles.truncText}>Showing first {logs.length} of {total}.</Text>
            </View>
          ) : null}
          <FlatList
            data={filtered}
            keyExtractor={item => item.id}
            renderItem={({ item }) => <AuditRow item={item} />}
            contentContainerStyle={styles.listContent}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Ionicons name="document-text-outline" size={48} color={Colors.border} />
                <Text style={styles.emptyTitle}>No events found</Text>
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

  // Loading / error (same pattern as the other wired super reads)
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
    paddingVertical: 10,
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
  separator: { height: 6 },

  row: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 10,
    gap: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.03,
    shadowRadius: 1,
    elevation: 1,
  },
  rowDanger: { borderColor: Colors.danger, borderLeftWidth: 3 },

  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  actionBadge: {
    borderRadius: BorderRadius.sm,
    paddingHorizontal: 7,
    paddingVertical: 3,
    flexShrink: 1,
  },
  actionText: {
    fontFamily: 'Poppins-Bold',
    fontSize: 10,
    letterSpacing: 0.4,
  },
  timestamp: {
    fontFamily: 'Poppins-Regular',
    fontSize: 10,
    color: Colors.textMuted,
    flexShrink: 0,
  },

  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  entityGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  entityType: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
  },
  idPill: {
    backgroundColor: Colors.grey,
    borderRadius: BorderRadius.sm,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  entityId: {
    fontFamily: 'Poppins-Regular',
    fontSize: 10,
    color: Colors.textMuted,
  },
  actor: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    flexShrink: 1,
    textAlign: 'right',
  },

  notes: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    lineHeight: FontSize.xs * 1.5,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingTop: 6,
    marginTop: 2,
  },

  emptyState: { alignItems: 'center', paddingTop: 60, gap: Spacing.sm },
  emptyTitle: { fontFamily: 'Poppins-SemiBold', fontSize: FontSize.lg, color: Colors.text, marginTop: Spacing.sm },
});
