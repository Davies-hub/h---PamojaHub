import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Badge from '../../components/ui/Badge';
import Toast from '../../components/ui/Toast';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { useFocusRefetch } from '../../hooks/useFocusRefetch';
import { superadminService } from '../../services/superadmin.service';
import { Church, ChurchStatus, SubscriptionTier } from '../../types';
import { fmtKes, formatDate } from '../../utils/formatters';

// Pull the DRF error `detail` string off an axios error, if present. Returns
// undefined for non-HTTP failures (network down) — the caller falls back to a
// generic message in that case. (Same shape as the Queue screen's helper.)
function extractDetail(err: unknown): string | undefined {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === 'object' && 'detail' in data) {
    const d = (data as { detail?: unknown }).detail;
    if (typeof d === 'string') return d;
  }
  return undefined;
}

// Set-tier failures are FIELD-KEYED ({"subscription_tier":["…is not a valid choice."]}),
// not the {detail} shape — check that first, then fall back to detail (e.g. a 404 race).
function extractTierError(err: unknown): string | undefined {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === 'object') {
    const st = (data as { subscription_tier?: unknown }).subscription_tier;
    if (Array.isArray(st) && typeof st[0] === 'string') return st[0];
  }
  return extractDetail(err);
}

const TIERS: SubscriptionTier[] = ['FREE', 'GROWTH', 'PARISH'];

// ─── Filter chip ──────────────────────────────────────────────────────────────

function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`Filter by ${label}`}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── Church row ───────────────────────────────────────────────────────────────

function ChurchRow({ item, onPress }: { item: Church; onPress: () => void }) {
  // S7b: the two aggregates now come straight from the backend row (mapAdminChurch),
  // not a mock-derived name lookup. `?? 0` is defensive — every super churches row
  // carries them, but the Church type marks them optional (other sources omit them).
  const campaigns = item.activeCampaignCount ?? 0;
  const raised    = item.totalRaised ?? 0;

  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={item.name}
    >
      <View style={styles.rowMain}>
        <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
        <View style={styles.badgeRow}>
          <Badge status={item.status} label={item.status} />
          <Badge status={item.subscriptionTier} label={item.subscriptionTier} />
        </View>
        <Text style={styles.rowCounty}>{item.county}</Text>
      </View>
      <View style={styles.rowStats}>
        <Text style={styles.statValue}>{campaigns}</Text>
        <Text style={styles.statLabel}>campaigns</Text>
        <Text style={styles.statValue}>{fmtKes(raised)}</Text>
        <Text style={styles.statLabel}>raised</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={Colors.textMuted} style={styles.rowChevron} />
    </TouchableOpacity>
  );
}

// ─── Detail bottom sheet ──────────────────────────────────────────────────────

function ChurchDetailSheet({
  church,
  onClose,
  onSuspend,
  onReactivate,
  onSetTier,
  actionInFlight,
  detailError,
}: {
  church: Church;
  onClose: () => void;
  onSuspend: (id: string) => void;
  onReactivate: (id: string) => void;
  onSetTier: (id: string, tier: SubscriptionTier) => void;
  actionInFlight: boolean;
  detailError: string | null;
}) {
  // Local selector state — the tier the admin has PICKED but not yet confirmed.
  // Seeded from (and re-synced to) server truth whenever the open church changes,
  // so reopening a different church / a post-flip re-render shows the live tier.
  const [pendingTier, setPendingTier] = useState<SubscriptionTier>(church.subscriptionTier);
  useEffect(() => {
    setPendingTier(church.subscriptionTier);
  }, [church.id, church.subscriptionTier]);

  return (
    <View style={styles.sheet}>
      <View style={styles.sheetHandle} />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>{church.name}</Text>
          <View style={styles.badgeRow}>
            <Badge status={church.status} label={church.status} />
            <Badge status={church.subscriptionTier} label={church.subscriptionTier} />
          </View>
        </View>

        <View style={styles.detailGrid}>
          {[
            { label: 'Email',        value: church.officialEmail },
            { label: 'Phone',        value: church.phone },
            { label: 'County',       value: church.county },
            { label: 'Denomination', value: church.denomination },
            { label: 'Address',      value: church.address },
            { label: 'Registered',   value: formatDate(church.createdAt) },
            { label: 'Description',  value: church.description ?? '—' },
          ].map(f => (
            <View key={f.label} style={styles.detailRow}>
              <Text style={styles.detailLabel}>{f.label}</Text>
              <Text style={styles.detailValue}>{f.value}</Text>
            </View>
          ))}
        </View>

        <View style={styles.sheetActions}>
          {/* Submit failure (network down, or a 400 wrong-status race). The sheet
              stays OPEN across the write, so a toast would render behind the Modal —
              surface the message INLINE here instead (same fix as the Reject slice). */}
          {detailError ? (
            <View style={styles.detailErrorBox}>
              <Ionicons name="alert-circle-outline" size={16} color={Colors.danger} />
              <Text style={styles.detailErrorText}>{detailError}</Text>
            </View>
          ) : null}

          {church.status === 'ACTIVE' ? (
            <TouchableOpacity
              style={[styles.suspendBtn, actionInFlight && styles.btnDisabled]}
              onPress={() => onSuspend(church.id)}
              disabled={actionInFlight}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Suspend church"
            >
              <Ionicons name="ban-outline" size={16} color={Colors.danger} />
              <Text style={styles.suspendBtnText}>
                {actionInFlight ? 'Suspending…' : 'Suspend Church'}
              </Text>
            </TouchableOpacity>
          ) : null}

          {church.status === 'SUSPENDED' ? (
            <TouchableOpacity
              style={[styles.reactivateBtn, actionInFlight && styles.btnDisabled]}
              onPress={() => onReactivate(church.id)}
              disabled={actionInFlight}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Reactivate church"
            >
              <Ionicons name="checkmark-circle-outline" size={16} color={Colors.primary} />
              <Text style={styles.reactivateBtnText}>
                {actionInFlight ? 'Reactivating…' : 'Reactivate Church'}
              </Text>
            </TouchableOpacity>
          ) : null}

          {/* Subscription tier — a plain choice among 3 values (NOT a money write),
              so a simple inline selector → confirm, no attestation. Inline in the
              sheet (not Alert.alert, which is a no-op on web). Picking a tier that
              differs from the current one reveals the confirm button; the badge in
              the header updates from SERVER TRUTH after the flip, never optimistically. */}
          <View style={styles.tierEditBlock}>
            <Text style={styles.tierEditLabel}>Subscription Tier</Text>
            <View style={styles.tierChipRow}>
              {TIERS.map(t => (
                <TouchableOpacity
                  key={t}
                  style={[styles.tierChip, pendingTier === t && styles.tierChipActive]}
                  onPress={() => setPendingTier(t)}
                  disabled={actionInFlight}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Select ${t} tier`}
                >
                  <Text style={[styles.tierChipText, pendingTier === t && styles.tierChipTextActive]}>
                    {t}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            {pendingTier !== church.subscriptionTier ? (
              <TouchableOpacity
                style={[styles.tierConfirmBtn, actionInFlight && styles.btnDisabled]}
                onPress={() => onSetTier(church.id, pendingTier)}
                disabled={actionInFlight}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={`Change tier to ${pendingTier}`}
              >
                <Ionicons name="swap-horizontal-outline" size={16} color={Colors.white} />
                <Text style={styles.tierConfirmText}>
                  {actionInFlight ? 'Saving…' : `Change to ${pendingTier}`}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>

          <TouchableOpacity
            style={styles.auditBtn}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="View audit log"
          >
            <Ionicons name="document-text-outline" size={16} color={Colors.textSecondary} />
            <Text style={styles.auditBtnText}>View Audit Log</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

type StatusFilter = ChurchStatus | 'ALL';
type TierFilter   = SubscriptionTier | 'ALL';

const STATUS_FILTERS: StatusFilter[] = ['ALL', 'ACTIVE', 'PENDING', 'SUSPENDED'];
const TIER_FILTERS:   TierFilter[]   = ['ALL', 'FREE', 'GROWTH', 'PARISH'];

export default function SuperChurchesScreen() {
  // S7b: background refetch-on-focus (shared hook). First focus = spinner; every
  // revisit refetches in the BACKGROUND (list stays, no blank/flash). MIRROR-class —
  // Suspend/Reinstate optimistically mutate the local `churches` (and `selected`), so
  // we keep local state and re-sync from the server on each fetch (Queue pattern).
  const { data, status: chState, retry } = useFocusRefetch(
    () => superadminService.listChurches(),
  );
  const [churches, setChurches]   = useState<Church[]>([]);
  const [total, setTotal]         = useState(0);
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    if (data) {
      setChurches(data.items);
      setTotal(data.total);
      setTruncated(data.truncated);
    }
  }, [data]);

  const [search, setSearch]       = useState('');
  const [statusF, setStatusF]     = useState<StatusFilter>('ALL');
  const [tierF, setTierF]         = useState<TierFilter>('ALL');
  const [selected, setSelected]   = useState<Church | null>(null);
  const [toast, setToast]         = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [actionInFlight, setActionInFlight] = useState(false);
  const [detailError, setDetailError]       = useState<string | null>(null);

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  // Close the detail sheet AND clear any inline error tied to it.
  function closeDetail() {
    setSelected(null);
    setDetailError(null);
  }

  const filtered = useMemo(() => {
    return churches.filter(c => {
      if (search.trim() && !c.name.toLowerCase().includes(search.toLowerCase())) return false;
      if (statusF !== 'ALL' && c.status !== statusF) return false;
      if (tierF !== 'ALL' && c.subscriptionTier !== tierF) return false;
      return true;
    });
  }, [churches, search, statusF, tierF]);

  function handleSuspend(id: string) {
    // Re-entry guard: ignore the tap if any suspend/reactivate is already in flight.
    if (actionInFlight) return;
    const church = churches.find(c => c.id === id);
    if (!church) return;
    Alert.alert(
      'Suspend Church',
      `Suspend "${church.name}"? They will lose access to the platform immediately.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Suspend',
          style: 'destructive',
          onPress: async () => {
            if (actionInFlight) return;   // belt-and-braces
            setDetailError(null);
            setActionInFlight(true);
            try {
              // No optimistic status write — the church only changes on server truth.
              const updated = await superadminService.suspendChurch(id);
              setSelected(updated);       // open sheet flips to "Reactivate" from server
              retry();                    // re-sync the list row
              showToast(`${church.name} suspended.`);
            } catch (err) {
              // Keep status unchanged everywhere; surface the reason inline in the sheet.
              // A 400 wrong-status race (someone else acted) → refetch so the list/sheet
              // self-correct, and still show why. Do NOT close the sheet on error.
              const detail = extractDetail(err);
              if (detail === 'Only ACTIVE churches can be suspended.') retry();
              setDetailError(detail ?? "Couldn't update. Try again.");
            } finally {
              setActionInFlight(false);
            }
          },
        },
      ]
    );
  }

  // Tier flip — money-INERT (no wallet, no expiry, no charge; backend enforces). Inline,
  // NOT Alert.alert (web no-op). Server-truth: the badge/filter update only from the 200
  // body (setSelected(updated) + retry() re-syncs the list so the tier filter reflects it).
  // On error keep the tier unchanged everywhere and surface the field-keyed/detail message
  // inline in the sheet (the sheet stays open, so a toast would render behind it).
  function handleSetTier(id: string, tier: SubscriptionTier) {
    if (actionInFlight) return;
    const church = churches.find(c => c.id === id);
    if (!church) return;
    void (async () => {
      setDetailError(null);
      setActionInFlight(true);
      try {
        const updated = await superadminService.setChurchTier(id, tier);
        setSelected(updated);   // header badge flips from server truth
        retry();                // re-sync the list row so the tier filter reflects it
        showToast(`${church.name} set to ${tier}.`);
      } catch (err) {
        setDetailError(extractTierError(err) ?? "Couldn't update tier. Try again.");
      } finally {
        setActionInFlight(false);
      }
    })();
  }

  function handleReactivate(id: string) {
    if (actionInFlight) return;
    const church = churches.find(c => c.id === id);
    if (!church) return;
    Alert.alert(
      'Reactivate Church',
      `Reactivate "${church.name}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reactivate',
          onPress: async () => {
            if (actionInFlight) return;
            setDetailError(null);
            setActionInFlight(true);
            try {
              const updated = await superadminService.reactivateChurch(id);
              setSelected(updated);       // open sheet flips to "Suspend" from server
              retry();
              showToast(`${church.name} reactivated.`);
            } catch (err) {
              const detail = extractDetail(err);
              if (detail === 'Only SUSPENDED churches can be reactivated.') retry();
              setDetailError(detail ?? "Couldn't update. Try again.");
            } finally {
              setActionInFlight(false);
            }
          },
        },
      ]
    );
  }

  return (
    <SafeAreaView edges={['bottom']} style={styles.root}>
      {toast ? (
        <View style={styles.toastWrap}>
          <Toast type={toast.type} message={toast.msg} visible />
        </View>
      ) : null}

      {/* Filter bar */}
      <View style={styles.filterBar}>
        <View style={styles.searchRow}>
          <Ionicons name="search-outline" size={16} color={Colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search churches…"
            placeholderTextColor={Colors.textMuted}
            value={search}
            onChangeText={setSearch}
            accessibilityLabel="Search churches"
          />
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipsScroll}
        >
          {STATUS_FILTERS.map(s => (
            <FilterChip
              key={s}
              label={s === 'ALL' ? 'All Status' : s}
              active={statusF === s}
              onPress={() => setStatusF(s)}
            />
          ))}
          <View style={styles.chipDivider} />
          {TIER_FILTERS.map(t => (
            <FilterChip
              key={t}
              label={t === 'ALL' ? 'All Tiers' : t}
              active={tierF === t}
              onPress={() => setTierF(t)}
            />
          ))}
        </ScrollView>
      </View>

      {chState === 'loading' ? (
        <View style={styles.centerBlock}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : chState === 'error' ? (
        <View style={styles.errorBlock}>
          <Ionicons name="cloud-offline-outline" size={40} color={Colors.border} />
          <Text style={styles.errorText}>Couldn’t load churches.</Text>
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
              <Text style={styles.truncText}>Showing first {churches.length} of {total}.</Text>
            </View>
          ) : null}
          <FlatList
            data={filtered}
            keyExtractor={item => item.id}
            renderItem={({ item }) => (
              <ChurchRow item={item} onPress={() => setSelected(item)} />
            )}
            contentContainerStyle={styles.listContent}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Ionicons name="business-outline" size={48} color={Colors.border} />
                <Text style={styles.emptyTitle}>No churches found</Text>
              </View>
            }
          />
        </>
      )}

      {/* Detail sheet */}
      <Modal
        visible={selected !== null}
        transparent
        animationType="slide"
        onRequestClose={() => { if (!actionInFlight) closeDetail(); }}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          onPress={() => { if (!actionInFlight) closeDetail(); }}
          activeOpacity={1}
        />
        {selected ? (
          <ChurchDetailSheet
            church={selected}
            onClose={closeDetail}
            onSuspend={handleSuspend}
            onReactivate={handleReactivate}
            onSetTier={handleSetTier}
            actionInFlight={actionInFlight}
            detailError={detailError}
          />
        ) : null}
      </Modal>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.grey },

  toastWrap: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },

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
  chipsScroll: {
    paddingHorizontal: Spacing.md,
    gap: 8,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: BorderRadius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
  },
  chipTextActive: { color: Colors.white },
  chipDivider: { width: 1, backgroundColor: Colors.border, marginHorizontal: 4 },

  listContent: { padding: Spacing.md, paddingBottom: Spacing.xl },
  separator: { height: 1, backgroundColor: Colors.border },

  // Church row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    gap: Spacing.sm,
  },
  rowMain: { flex: 1, gap: 4 },
  rowName: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.base,
    color: Colors.text,
  },
  badgeRow: { flexDirection: 'row', gap: 6 },
  rowCounty: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  rowStats: { alignItems: 'flex-end', gap: 1, flexShrink: 0 },
  statValue: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.text,
  },
  statLabel: {
    fontFamily: 'Poppins-Regular',
    fontSize: 10,
    color: Colors.textMuted,
  },
  rowChevron: { flexShrink: 0 },

  emptyState: { alignItems: 'center', paddingTop: 60, gap: Spacing.sm },
  emptyTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
    marginTop: Spacing.sm,
  },

  // Modal + sheet
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: Colors.white,
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    maxHeight: '80%',
    paddingBottom: Spacing.xxl,
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: 'center',
    marginTop: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  sheetHeader: {
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 6,
  },
  sheetTitle: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.text,
  },
  detailGrid: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    gap: 12,
  },
  detailRow: { gap: 2 },
  detailLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  detailValue: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.base,
    color: Colors.text,
  },
  sheetActions: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.lg,
    gap: Spacing.sm,
  },
  btnDisabled: { opacity: 0.6 },
  detailErrorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.dangerLight,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 8,
  },
  detailErrorText: {
    flex: 1,
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.danger,
  },
  suspendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 46,
    borderWidth: 1.5,
    borderColor: Colors.danger,
    borderRadius: BorderRadius.md,
    gap: 8,
  },
  suspendBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.danger,
  },
  reactivateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 46,
    borderWidth: 1.5,
    borderColor: Colors.primary,
    borderRadius: BorderRadius.md,
    gap: 8,
  },
  reactivateBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.primary,
  },
  auditBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 46,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    gap: 8,
    backgroundColor: Colors.grey,
  },
  auditBtnText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.md,
    color: Colors.textSecondary,
  },

  // Tier selector (inline in the sheet)
  tierEditBlock: {
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingTop: Spacing.md,
    gap: Spacing.sm,
  },
  tierEditLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tierChipRow: { flexDirection: 'row', gap: Spacing.sm },
  tierChip: {
    flex: 1,
    height: 40,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tierChipActive: { backgroundColor: Colors.primaryLight, borderColor: Colors.primary },
  tierChipText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  tierChipTextActive: { color: Colors.primary, fontFamily: 'Poppins-Bold' },
  tierConfirmBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 46,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary,
    gap: 8,
  },
  tierConfirmText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.white,
  },
});
