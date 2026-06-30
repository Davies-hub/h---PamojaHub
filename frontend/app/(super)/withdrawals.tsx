import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Modal from '../../components/ui/Modal';
import Toast from '../../components/ui/Toast';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { useFocusRefetch } from '../../hooks/useFocusRefetch';
import { superadminService } from '../../services/superadmin.service';
import { Withdrawal, WithdrawalStatus } from '../../types';
import { fmtKes, timeAgo } from '../../utils/formatters';

// Verdict-poll bound for a force-retried (PROCESSING) payout — same harness as the
// treasurer payouts screen's startApprovalPoll, ported here since this screen has no
// poller today (it's focus-refetch only). ~30s ceiling before the honest "still
// confirming" PROCESSING terminal rather than spinning forever.
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 10;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function maskPhone(phone: string): string {
  if (phone.length < 4) return '****';
  return `0*** ***${phone.slice(-4)}`;
}

type FilterStatus = WithdrawalStatus | 'ALL';

const STATUS_LABELS: Record<FilterStatus, string> = {
  ALL:                  'All',
  PENDING_APPROVAL:     'Pending',
  PROCESSING:           'Processing',
  PAID:                 'Paid',
  FAILED:               'Failed',
  FAILED_FINAL:         'Failed Final',
  REJECTED:             'Rejected',
  NEEDS_RECONCILIATION: 'Under Review',
};

const STATUS_BADGE: Record<WithdrawalStatus, { bg: string; text: string }> = {
  PENDING_APPROVAL:     { bg: Colors.warningLight, text: Colors.warning },
  PROCESSING:           { bg: Colors.primaryLight, text: Colors.primary },
  PAID:                 { bg: Colors.successLight, text: Colors.success },
  FAILED:               { bg: Colors.dangerLight,  text: Colors.danger },
  FAILED_FINAL:         { bg: Colors.danger,        text: Colors.white },
  REJECTED:             { bg: Colors.grey,          text: Colors.textMuted },
  // Neutral "under review" — money in limbo, being checked; NOT success/error.
  NEEDS_RECONCILIATION: { bg: Colors.accentLight,   text: Colors.accentDark },
};

function StatusBadge({ status }: { status: WithdrawalStatus }) {
  const c = STATUS_BADGE[status];
  return (
    <View style={[styles.statusBadge, { backgroundColor: c.bg }]}>
      <Text style={[styles.statusBadgeText, { color: c.text }]}>
        {STATUS_LABELS[status]}
      </Text>
    </View>
  );
}

function FilterChip({
  label, active, onPress,
}: { label: string; active: boolean; onPress: () => void }) {
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

// ─── Withdrawal row ───────────────────────────────────────────────────────────

function WithdrawalRow({
  item,
  onForceRetry,
  onResolveRetry,
  onResolvePaid,
  stillConfirming,
}: {
  item: Withdrawal;
  onForceRetry: (id: string) => void;
  onResolveRetry: (id: string) => void;
  onResolvePaid: (id: string) => void;
  stillConfirming: boolean;
}) {
  const isFinalFail = item.status === 'FAILED_FINAL';

  return (
    <View style={[styles.row, isFinalFail && styles.rowDanger]}>
      {isFinalFail ? (
        <View style={styles.investigationBanner}>
          <Ionicons name="alert-circle" size={14} color={Colors.danger} />
          <Text style={styles.investigationText}>Requires PamojaHub investigation</Text>
        </View>
      ) : null}

      <View style={styles.rowTop}>
        <View style={styles.rowLeft}>
          <Text style={styles.campaignTitle} numberOfLines={1}>{item.campaignTitle}</Text>
          {item.churchName ? (
            <Text style={styles.churchName} numberOfLines={1}>{item.churchName}</Text>
          ) : null}
          <Text style={styles.rowReason} numberOfLines={2}>{item.reason}</Text>
          <View style={styles.rowMeta}>
            <Text style={styles.rowPhone}>{maskPhone(item.requestedByPhone)}</Text>
            <Text style={styles.rowDot}>·</Text>
            <Text style={styles.rowDate}>{timeAgo(item.createdAt)}</Text>
          </View>
        </View>
        <View style={styles.rowRight}>
          <Text style={styles.amount}>{fmtKes(item.amount)}</Text>
          <StatusBadge status={item.status} />
        </View>
      </View>

      {item.status === 'PROCESSING' && stillConfirming ? (
        <View style={styles.confirmingNote}>
          <Ionicons name="time-outline" size={14} color={Colors.primary} />
          <Text style={styles.confirmingNoteText}>Dispatched — still confirming, check back shortly</Text>
        </View>
      ) : null}

      {item.status === 'REJECTED' && item.rejectionReason ? (
        <View style={styles.noteBox}>
          <Text style={styles.noteLabel}>Rejection reason</Text>
          <Text style={styles.noteText}>{item.rejectionReason}</Text>
        </View>
      ) : null}

      {(item.status === 'FAILED' || item.status === 'FAILED_FINAL') && item.failureReason ? (
        <View style={styles.failureBox}>
          <Text style={styles.failureText}>{item.failureReason}</Text>
          {item.retryCount > 0 ? (
            <Text style={styles.retryCount}>Attempts: {item.retryCount}</Text>
          ) : null}
        </View>
      ) : null}

      {isFinalFail ? (
        <View style={styles.actionsRow}>
          <TouchableOpacity
            style={styles.forceRetryBtn}
            onPress={() => onForceRetry(item.id)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Force retry payout"
          >
            <Ionicons name="refresh-outline" size={15} color={Colors.danger} />
            <Text style={styles.forceRetryBtnText}>Force Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {item.status === 'NEEDS_RECONCILIATION' ? (
        <View style={styles.actionsRow}>
          <TouchableOpacity
            style={styles.resolveRetryBtn}
            onPress={() => onResolveRetry(item.id)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Resolve payout for retry"
          >
            <Ionicons name="checkmark-done-outline" size={15} color={Colors.accentDark} />
            <Text style={styles.resolveRetryBtnText}>Resolve — Mark for Retry</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.resolvePaidBtn}
            onPress={() => onResolvePaid(item.id)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Resolve payout as paid"
          >
            <Ionicons name="checkmark-circle-outline" size={15} color={Colors.success} />
            <Text style={styles.resolvePaidBtnText}>Resolve — Mark as Paid</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

const FILTER_ORDER: FilterStatus[] = [
  'ALL', 'PENDING_APPROVAL', 'PROCESSING', 'PAID', 'FAILED', 'FAILED_FINAL', 'REJECTED',
  'NEEDS_RECONCILIATION',
];

export default function SuperWithdrawalsScreen() {
  // Background refetch-on-focus (shared hook). FIRST focus shows the spinner; every
  // REVISIT refetches in the BACKGROUND — the list stays on screen and a background
  // failure keeps the last-good data (never blanks). `status`/`retry` drive the SAME
  // spinner/error/list JSX as before; first-load behaviour is unchanged. R1 fix:
  // revisiting a tab now re-GETs /super/withdrawals/ instead of showing stale state.
  const { data, status: wState, retry } = useFocusRefetch(
    () => superadminService.listWithdrawals(),
  );

  // Local mirror of the fetched page so the (mock/local) action handlers below can
  // keep doing optimistic updates. Re-synced from the server whenever a fetch lands,
  // so a focus-revisit refetch replaces the list with fresh data.
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);

  // RACE GUARD (focus-refetch landing mid force-retry-poll): a focus-refetch's GET
  // can be in flight concurrently with a poll tick's GET, with no guaranteed response
  // ordering. Once the poll settles a row to a terminal status, we PIN it here so a
  // late/stale focus-refetch response can't resurrect a stale PROCESSING. Cleared only
  // when a NEW force-retry starts on that same id.
  const settledRowsRef = useRef<Map<string, Withdrawal>>(new Map());
  // The id currently being polled (single in-flight poll at a time, mirrors the
  // treasurer harness). Lets an incoming focus-refetch settle the poll EARLY if its
  // fresh snapshot already shows a terminal status, instead of waiting for the next tick.
  const activePollIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (data) {
      const merged = data.items.map(item => {
        const pinned = settledRowsRef.current.get(item.id);
        if (pinned) return pinned;
        if (
          activePollIdRef.current === item.id &&
          item.status !== 'PROCESSING' &&
          !pollSettledRef.current
        ) {
          // The focus-refetch beat the poller to the verdict — settle now.
          pollSettledRef.current = true;
          activePollIdRef.current = null;
          settledRowsRef.current.set(item.id, item);
          clearPollTimer();
          setConfirmingIds(prev => {
            const next = new Set(prev);
            next.delete(item.id);
            return next;
          });
        }
        return item;
      });
      setWithdrawals(merged);
      setTotal(data.total);
      setTruncated(data.truncated);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const [statusFilter, setStatusFilter] = useState<FilterStatus>('ALL');
  const [churchSearch, setChurchSearch] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  const [resolveTarget, setResolveTarget] = useState<Withdrawal | null>(null);
  const [attested, setAttested] = useState(false);
  const [resolveSubmitting, setResolveSubmitting] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const [paidTarget, setPaidTarget] = useState<Withdrawal | null>(null);
  const [paidReference, setPaidReference] = useState('');
  const [paidSubmitting, setPaidSubmitting] = useState(false);
  const [paidError, setPaidError] = useState<string | null>(null);

  const [forceRetryTarget, setForceRetryTarget] = useState<Withdrawal | null>(null);
  const [forceRetrySubmitting, setForceRetrySubmitting] = useState(false);
  const [forceRetryError, setForceRetryError] = useState<string | null>(null);

  // Verdict-poll bookkeeping for a force-retried row — ported from the treasurer
  // payouts screen's startApprovalPoll. pollSettledRef stops a late tick (or a
  // focus-refetch landing mid-poll) from resurrecting a row that already reached a
  // terminal status; mountedRef + clearPollTimer guard against setState-after-unmount.
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollAttemptsRef = useRef(0);
  const pollSettledRef = useRef(false);
  const mountedRef = useRef(true);
  // Ids currently showing the "still confirming" hint on a PROCESSING row.
  const [confirmingIds, setConfirmingIds] = useState<Set<string>>(new Set());

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPollTimer();
    };
  }, [clearPollTimer]);

  // Silent verdict poll: calls listWithdrawals() DIRECTLY (never the focus-refetch's
  // loading/spinner) and updates ONLY the polled row in the mirror by id — server
  // truth either way, so a focus-refetch landing mid-poll cannot desync this row.
  // Stops on PAID / FAILED / FAILED_FINAL / NEEDS_RECONCILIATION; exhausting attempts
  // while still PROCESSING is an honest terminal too (row stays PROCESSING, never
  // marked failed/paid, "still confirming" hint persists, no force-retry-again button
  // — Force Retry is gated on FAILED_FINAL only, which this row no longer is).
  const startForceRetryPoll = useCallback((id: string) => {
    pollAttemptsRef.current = 0;
    pollSettledRef.current = false;
    setConfirmingIds(prev => new Set(prev).add(id));
    const tick = async () => {
      pollAttemptsRef.current += 1;
      let page: Awaited<ReturnType<typeof superadminService.listWithdrawals>> | null = null;
      try {
        page = await superadminService.listWithdrawals();
      } catch {
        page = null; // transient blip — non-terminal attempt, keep polling
      }
      if (!mountedRef.current || pollSettledRef.current) return;

      if (page) {
        const row = page.items.find(w => w.id === id);
        if (row) {
          setWithdrawals(prev => prev.map(w => (w.id === id ? row : w)));
          if (row.status !== 'PROCESSING') {
            pollSettledRef.current = true;
            activePollIdRef.current = null;
            settledRowsRef.current.set(id, row);
            clearPollTimer();
            setConfirmingIds(prev => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
            return;
          }
        }
      }

      if (pollAttemptsRef.current >= POLL_MAX_ATTEMPTS) {
        pollSettledRef.current = true;
        activePollIdRef.current = null;
        clearPollTimer();
        return;
      }
      pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
  }, [clearPollTimer]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  const filtered = useMemo(() => {
    return withdrawals.filter(w => {
      if (statusFilter !== 'ALL' && w.status !== statusFilter) return false;
      if (
        churchSearch.trim() &&
        !(w.churchName ?? '').toLowerCase().includes(churchSearch.toLowerCase())
      ) return false;
      return true;
    });
  }, [withdrawals, statusFilter, churchSearch]);

  function handleResolvePaidOpen(id: string) {
    const item = withdrawals.find(w => w.id === id);
    if (!item) return;
    setPaidTarget(item);
    setPaidReference('');
    setPaidError(null);
  }

  function handleResolvePaidClose() {
    if (paidSubmitting) return;
    setPaidTarget(null);
    setPaidReference('');
    setPaidError(null);
  }

  async function handleResolvePaidSubmit() {
    if (paidReference.trim() === '' || paidSubmitting || !paidTarget) return;
    setPaidSubmitting(true);
    setPaidError(null);
    try {
      const updated = await superadminService.resolvePaid(paidTarget.id, paidReference.trim());
      setWithdrawals(prev => prev.map(w => w.id === updated.id ? updated : w));
      setPaidTarget(null);
      setPaidReference('');
      setPaidError(null);
      showToast('Payout marked as paid.');
    } catch (e: unknown) {
      const errData = (e as { response?: { data?: Record<string, unknown> } })?.response?.data;
      if (Array.isArray(errData?.['payout_reference']) && typeof (errData['payout_reference'] as unknown[])[0] === 'string') {
        setPaidError((errData['payout_reference'] as string[])[0]);
      } else if (typeof errData?.['detail'] === 'string') {
        const detail = errData['detail'] as string;
        setPaidError(detail);
        if (detail === 'This payout is not awaiting reconciliation.') {
          retry();
        }
      } else {
        setPaidError("Couldn't mark as paid. Try again.");
      }
    } finally {
      setPaidSubmitting(false);
    }
  }

  function handleForceRetryOpen(id: string) {
    const w = withdrawals.find(x => x.id === id);
    if (!w) return;
    setForceRetryTarget(w);
    setForceRetryError(null);
  }

  function handleForceRetryClose() {
    if (forceRetrySubmitting) return;
    setForceRetryTarget(null);
    setForceRetryError(null);
  }

  async function handleForceRetrySubmit() {
    if (!forceRetryTarget || forceRetrySubmitting) return;
    setForceRetryError(null);
    setForceRetrySubmitting(true);
    // A fresh force-retry on this id invalidates any earlier pin — this row is no
    // longer the terminal state that was pinned.
    settledRowsRef.current.delete(forceRetryTarget.id);
    try {
      const updated = await superadminService.forceRetry(forceRetryTarget.id);
      setWithdrawals(prev => prev.map(w => (w.id === updated.id ? updated : w)));
      setForceRetryTarget(null);
      if (updated.status === 'PROCESSING' && updated.dispatchStatus !== 'failed_queued_for_retry') {
        // Happy path: Daraja accepted the re-dispatch — verdict comes async via
        // callback. NEVER show Paid here; start the silent verdict poll.
        activePollIdRef.current = updated.id;
        startForceRetryPoll(updated.id);
        showToast('Force retry dispatched — confirming with M-Pesa.');
      } else {
        // status === 'FAILED' (dispatch_status 'failed_queued_for_retry'): synchronous
        // dispatch failure — the row already shows Failed from server-truth, no poll.
        // Pin it too — this is fresh server truth from the write itself.
        settledRowsRef.current.set(updated.id, updated);
        showToast('Force retry failed to dispatch — payout queued for retry.');
      }
    } catch (e: unknown) {
      const data = (e as { response?: { data?: Record<string, unknown> } })?.response?.data;
      const detail = typeof data?.['detail'] === 'string' ? (data['detail'] as string) : null;
      setForceRetryError(detail ?? "Couldn't force-retry. Try again.");
      if (
        detail === 'Only FAILED_FINAL withdrawals can be force-retried.' ||
        detail?.toLowerCase().includes('insufficient')
      ) {
        // Wrong-status race or balance change — close, refetch so the row re-renders
        // correctly (the Force Retry button may now correctly disappear).
        setForceRetryTarget(null);
        retry();
      }
    } finally {
      setForceRetrySubmitting(false);
    }
  }

  function handleResolveRetryOpen(id: string) {
    const item = withdrawals.find(w => w.id === id);
    if (!item) return;
    setResolveTarget(item);
    setAttested(false);
    setResolveError(null);
  }

  function handleResolveRetryClose() {
    if (resolveSubmitting) return;
    setResolveTarget(null);
    setAttested(false);
    setResolveError(null);
  }

  async function handleResolveRetrySubmit() {
    if (!attested || resolveSubmitting || !resolveTarget) return;
    setResolveSubmitting(true);
    setResolveError(null);
    try {
      const updated = await superadminService.resolveRetry(resolveTarget.id);
      setWithdrawals(prev => prev.map(w => w.id === updated.id ? updated : w));
      setResolveTarget(null);
      setAttested(false);
      setResolveError(null);
      showToast('Payout marked for retry.');
    } catch (e: unknown) {
      const data = (e as { response?: { data?: Record<string, unknown> } })?.response?.data;
      const detail = typeof data?.['detail'] === 'string' ? data['detail'] as string : null;
      setResolveError(detail ?? "Couldn't resolve. Try again.");
      if (detail === 'This payout is not awaiting reconciliation.') {
        retry();
      }
    } finally {
      setResolveSubmitting(false);
    }
  }

  return (
    <SafeAreaView edges={['bottom']} style={styles.root}>
      {toast ? (
        <View style={styles.toastWrap}>
          <Toast type="success" message={toast} visible />
        </View>
      ) : null}

      {/* Filter bar */}
      <View style={styles.filterBar}>
        <View style={styles.churchSearchRow}>
          <Ionicons name="business-outline" size={14} color={Colors.textMuted} />
          <TextInput
            style={styles.churchSearchInput}
            placeholder="Filter by church…"
            placeholderTextColor={Colors.textMuted}
            value={churchSearch}
            onChangeText={setChurchSearch}
            accessibilityLabel="Filter by church name"
          />
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipsScroll}
        >
          {FILTER_ORDER.map(s => (
            <FilterChip
              key={s}
              label={STATUS_LABELS[s]}
              active={statusFilter === s}
              onPress={() => setStatusFilter(s)}
            />
          ))}
        </ScrollView>
      </View>

      {wState === 'loading' ? (
        <View style={styles.centerBlock}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : wState === 'error' ? (
        <View style={styles.errorBlock}>
          <Ionicons name="cloud-offline-outline" size={40} color={Colors.border} />
          <Text style={styles.errorText}>Couldn’t load payouts.</Text>
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
              <Text style={styles.truncText}>Showing first {withdrawals.length} of {total}.</Text>
            </View>
          ) : null}
          <FlatList
            data={filtered}
            keyExtractor={item => item.id}
            renderItem={({ item }) => (
              <WithdrawalRow
                item={item}
                onForceRetry={handleForceRetryOpen}
                onResolveRetry={handleResolveRetryOpen}
                onResolvePaid={handleResolvePaidOpen}
                stillConfirming={confirmingIds.has(item.id)}
              />
            )}
            contentContainerStyle={styles.listContent}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Ionicons name="arrow-up-circle-outline" size={48} color={Colors.border} />
                <Text style={styles.emptyTitle}>No withdrawals found</Text>
              </View>
            }
          />
        </>
      )}

      {/* Resolve-Retry attestation modal */}
      <Modal
        visible={resolveTarget !== null}
        title="Resolve payout for retry"
        confirmLabel="Mark for Retry"
        confirmVariant="danger"
        confirmDisabled={!attested || resolveSubmitting}
        onConfirm={handleResolveRetrySubmit}
        onCancel={handleResolveRetryClose}
        cancelLabel="Cancel"
      >
        {resolveTarget ? (
          <>
            <Text style={styles.resolveContext}>
              <Text style={styles.resolveContextBold}>{resolveTarget.campaignTitle}</Text>
              {' — '}{fmtKes(resolveTarget.amount)}{' → '}{resolveTarget.destinationPhone}
            </Text>

            <TouchableOpacity
              style={styles.attestRow}
              onPress={() => setAttested(v => !v)}
              activeOpacity={0.7}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: attested }}
              accessibilityLabel="I have verified in M-Pesa that no payout was sent for this withdrawal"
            >
              <Ionicons
                name={attested ? 'checkbox' : 'square-outline'}
                size={22}
                color={attested ? Colors.accentDark : Colors.textMuted}
              />
              <Text style={styles.attestLabel}>
                I have verified in M-Pesa that no payout was sent for this withdrawal.
              </Text>
            </TouchableOpacity>

            {resolveError ? (
              <View style={styles.resolveErrorBox}>
                <Text style={styles.resolveErrorText}>{resolveError}</Text>
              </View>
            ) : null}
          </>
        ) : null}
      </Modal>

      {/* Resolve-Paid modal — text input for the M-Pesa reference the admin verified
          off the statement. confirmDisabled gates on a non-empty trimmed input (mirrors
          the resolve-retry checkbox gate). Field-keyed 400 + data.detail errors render
          INSIDE the modal body — never occluded behind it. */}
      <Modal
        visible={paidTarget !== null}
        title="Mark payout as paid"
        confirmLabel={paidSubmitting ? 'Saving…' : 'Mark as Paid'}
        confirmVariant="danger"
        confirmDisabled={paidReference.trim() === '' || paidSubmitting}
        onConfirm={handleResolvePaidSubmit}
        onCancel={handleResolvePaidClose}
        cancelLabel="Cancel"
      >
        {paidTarget ? (
          <>
            <Text style={styles.resolveContext}>
              <Text style={styles.resolveContextBold}>{paidTarget.campaignTitle}</Text>
              {' — '}{fmtKes(paidTarget.amount)}{' → '}{paidTarget.destinationPhone}
            </Text>
            <Text style={styles.paidReferenceLabel}>
              M-Pesa transaction code <Text style={styles.paidReferenceRequired}>*</Text>
            </Text>
            <TextInput
              style={[styles.paidReferenceInput, paidError ? styles.paidReferenceInputError : null]}
              value={paidReference}
              onChangeText={t => {
                setPaidReference(t);
                if (paidError) setPaidError(null);
              }}
              placeholder="e.g. RFG7XYZ123"
              placeholderTextColor={Colors.textMuted}
              numberOfLines={1}
              autoCapitalize="characters"
              editable={!paidSubmitting}
              accessibilityLabel="M-Pesa transaction code"
            />
            {paidError ? (
              <View style={styles.resolveErrorBox}>
                <Text style={styles.resolveErrorText}>{paidError}</Text>
              </View>
            ) : null}
          </>
        ) : null}
      </Modal>

      {/* Force-retry confirm modal — SIMPLE confirm, no attestation checkbox.
          FAILED_FINAL is proven never-sent (the backend trace), so there is no
          out-of-band M-Pesa fact to attest; a checkbox here would be fake friction. */}
      <Modal
        visible={forceRetryTarget !== null}
        title="Force-retry payout"
        confirmLabel={forceRetrySubmitting ? 'Dispatching…' : 'Re-send payout'}
        confirmVariant="danger"
        confirmDisabled={forceRetrySubmitting}
        onConfirm={handleForceRetrySubmit}
        onCancel={handleForceRetryClose}
        cancelLabel="Cancel"
      >
        {forceRetryTarget ? (
          <>
            <Text style={styles.resolveContext}>
              <Text style={styles.resolveContextBold}>{forceRetryTarget.campaignTitle}</Text>
              {' — '}{fmtKes(forceRetryTarget.amount)}{' → '}{forceRetryTarget.destinationPhone}
            </Text>
            <Text style={styles.forceRetryWarning}>
              This RE-SENDS a real M-Pesa payout that previously failed at the retry ceiling.
            </Text>
            {forceRetryError ? (
              <View style={styles.resolveErrorBox}>
                <Text style={styles.resolveErrorText}>{forceRetryError}</Text>
              </View>
            ) : null}
          </>
        ) : null}
      </Modal>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.grey },
  toastWrap: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },

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

  filterBar: {
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    paddingBottom: 8,
  },
  churchSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: Spacing.md,
    marginBottom: 8,
    paddingHorizontal: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    height: 36,
    gap: 8,
  },
  churchSearchInput: {
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

  listContent: { padding: Spacing.md, paddingBottom: Spacing.xl },
  separator: { height: Spacing.sm },

  row: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
  },
  rowDanger: { borderColor: Colors.danger, backgroundColor: Colors.dangerLight },
  investigationBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.dangerLight,
    borderRadius: BorderRadius.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 10,
  },
  investigationText: { fontFamily: 'Poppins-SemiBold', fontSize: FontSize.xs, color: Colors.danger },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  rowLeft: { flex: 1, gap: 3 },
  campaignTitle: { fontFamily: 'Poppins-SemiBold', fontSize: FontSize.md, color: Colors.text },
  churchName: { fontFamily: 'Poppins-Regular', fontSize: FontSize.xs, color: Colors.primary },
  rowReason: { fontFamily: 'Poppins-Regular', fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 18 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  rowPhone: { fontFamily: 'Poppins-Regular', fontSize: FontSize.xs, color: Colors.textMuted },
  rowDot:   { fontFamily: 'Poppins-Regular', fontSize: FontSize.xs, color: Colors.textMuted },
  rowDate:  { fontFamily: 'Poppins-Regular', fontSize: FontSize.xs, color: Colors.textMuted },
  rowRight: { alignItems: 'flex-end', gap: 6, flexShrink: 0 },
  amount: { fontFamily: 'Poppins-Bold', fontSize: FontSize.lg, color: Colors.text },
  statusBadge: { borderRadius: BorderRadius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  statusBadgeText: { fontFamily: 'Poppins-Medium', fontSize: 10 },
  confirmingNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.sm,
    padding: Spacing.sm,
  },
  confirmingNoteText: { fontFamily: 'Poppins-Medium', fontSize: FontSize.xs, color: Colors.primary },
  noteBox: {
    marginTop: 10,
    backgroundColor: Colors.grey,
    borderRadius: BorderRadius.sm,
    padding: Spacing.sm,
  },
  noteLabel: { fontFamily: 'Poppins-Medium', fontSize: FontSize.xs, color: Colors.textMuted, marginBottom: 2 },
  noteText: { fontFamily: 'Poppins-Regular', fontSize: FontSize.sm, color: Colors.textSecondary },
  failureBox: {
    marginTop: 10,
    backgroundColor: Colors.dangerLight,
    borderRadius: BorderRadius.sm,
    padding: Spacing.sm,
    gap: 2,
  },
  failureText: { fontFamily: 'Poppins-Regular', fontSize: FontSize.sm, color: Colors.danger },
  retryCount: { fontFamily: 'Poppins-Medium', fontSize: FontSize.xs, color: Colors.danger },
  actionsRow: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: Colors.dangerLight,
  },
  forceRetryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 38,
    borderWidth: 1.5,
    borderColor: Colors.danger,
    borderRadius: BorderRadius.md,
    gap: 6,
    backgroundColor: Colors.white,
  },
  forceRetryBtnText: { fontFamily: 'Poppins-Bold', fontSize: FontSize.sm, color: Colors.danger },

  emptyState: { alignItems: 'center', paddingTop: 60, gap: Spacing.sm },
  emptyTitle: { fontFamily: 'Poppins-SemiBold', fontSize: FontSize.lg, color: Colors.text, marginTop: Spacing.sm },

  resolveRetryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 38,
    borderWidth: 1.5,
    borderColor: Colors.accentDark,
    borderRadius: BorderRadius.md,
    gap: 6,
    backgroundColor: Colors.white,
  },
  resolveRetryBtnText: { fontFamily: 'Poppins-Bold', fontSize: FontSize.sm, color: Colors.accentDark },

  resolveContext: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
    lineHeight: 20,
  },
  resolveContextBold: { fontFamily: 'Poppins-SemiBold', color: Colors.text },
  resolvePaidBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 38,
    borderWidth: 1.5,
    borderColor: Colors.success,
    borderRadius: BorderRadius.md,
    gap: 6,
    backgroundColor: Colors.white,
    marginTop: 8,
  },
  resolvePaidBtnText: { fontFamily: 'Poppins-Bold', fontSize: FontSize.sm, color: Colors.success },
  paidReferenceLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: 6,
  },
  paidReferenceRequired: { color: Colors.danger },
  paidReferenceInput: {
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 10,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.text,
    marginBottom: 8,
  },
  paidReferenceInputError: { borderColor: Colors.danger },
  forceRetryWarning: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.danger,
    marginBottom: Spacing.sm,
  },
  attestRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 4,
    marginBottom: Spacing.sm,
  },
  attestLabel: {
    flex: 1,
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.text,
    lineHeight: 20,
  },
  resolveErrorBox: {
    backgroundColor: Colors.dangerLight,
    borderRadius: BorderRadius.sm,
    padding: Spacing.sm,
    marginTop: 4,
  },
  resolveErrorText: { fontFamily: 'Poppins-Regular', fontSize: FontSize.sm, color: Colors.danger },
});
