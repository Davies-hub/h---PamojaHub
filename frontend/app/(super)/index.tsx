import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Toast from '../../components/ui/Toast';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { useFocusRefetch } from '../../hooks/useFocusRefetch';
import { usePendingQueue } from '../../stores/pendingQueue.store';
import { superadminService } from '../../services/superadmin.service';
import { Church } from '../../types';
import { timeAgo } from '../../utils/formatters';

// Pull the DRF error `detail` string off an axios error, if present. Returns
// undefined for field-validation errors ({rejection_reason: [...]}) or non-HTTP
// failures — the caller falls back to a generic message in that case.
function extractDetail(err: unknown): string | undefined {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === 'object' && 'detail' in data) {
    const d = (data as { detail?: unknown }).detail;
    if (typeof d === 'string') return d;
  }
  return undefined;
}

// ─── Application card ─────────────────────────────────────────────────────────

interface CardProps {
  item: Church;
  onApprove: (church: Church) => void;
  onReject: (church: Church) => void;
}

function ApplicationCard({ item, onApprove, onReject }: CardProps) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardName}>{item.name}</Text>
      <Text style={styles.cardEmail}>{item.officialEmail}</Text>

      <View style={styles.cardMeta}>
        <Ionicons name="location-outline" size={13} color={Colors.textMuted} />
        {/* Render county + separator ONLY when a county is present — a county-less
            church shows just the denomination ("ACK"), never an orphan "· ACK".
            The dot appears only when BOTH sides exist. */}
        {item.county ? <Text style={styles.cardMetaText}>{item.county}</Text> : null}
        {item.county && item.denomination ? <Text style={styles.cardMetaDot}>·</Text> : null}
        {item.denomination ? <Text style={styles.cardMetaText}>{item.denomination}</Text> : null}
      </View>

      <Text style={styles.cardDate}>Submitted {timeAgo(item.createdAt)}</Text>

      {item.description ? (
        <Text style={styles.cardDesc} numberOfLines={2}>{item.description}</Text>
      ) : null}

      <View style={styles.cardActions}>
        <TouchableOpacity
          style={styles.approveBtn}
          onPress={() => onApprove(item)}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={`Approve ${item.name}`}
        >
          <Ionicons name="checkmark-circle-outline" size={16} color={Colors.white} />
          <Text style={styles.approveBtnText}>Approve</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.rejectBtn}
          onPress={() => onReject(item)}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={`Reject ${item.name}`}
        >
          <Ionicons name="close-circle-outline" size={16} color={Colors.danger} />
          <Text style={styles.rejectBtnText}>Reject</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function RegistrationQueueScreen() {
  // R2: background refetch-on-focus (shared hook). First focus = spinner; every
  // revisit refetches in the BACKGROUND (queue stays, no blank/flash). MIRROR-class:
  // Approve/Reject below optimistically mutate the local `queue`, so we keep local
  // state and re-sync it from the server on each fetch (R1 Withdrawals pattern).
  const { data, status: qState, retry } = useFocusRefetch(
    () => superadminService.listPendingChurches(),
  );
  const { setPendingCount }       = usePendingQueue();
  const [queue, setQueue]         = useState<Church[]>([]);
  const [total, setTotal]         = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [toast, setToast]         = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [rejectTarget, setRejectTarget] = useState<Church | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectAttempted, setRejectAttempted] = useState(false);
  const [rejectSubmitting, setRejectSubmitting] = useState(false);
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [approveSubmitting, setApproveSubmitting] = useState(false);
  const [approveTarget, setApproveTarget] = useState<Church | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [kbOffset, setKbOffset] = useState(0);

  // Local mirror: re-sync queue/total/truncated whenever a fetch lands. The PENDING
  // subset is scoped SERVER-SIDE (no client re-filter); keeping local state lets the
  // optimistic Approve/Reject handlers keep working, and a focus-revisit refetch
  // replaces the queue with fresh server data. Approve/Reject stay LOCAL — READ only.
  useEffect(() => {
    if (data) {
      setQueue(data.items);
      setTotal(data.total);
      setTruncated(data.truncated);
      // Single source of truth for the tab badge. Use data.total (the PAGINATED count),
      // NOT data.items.length — a D5-truncated list would undercount. This runs on EVERY
      // fetch, incl. the retry() after approve/reject, so the badge tracks server truth
      // without any extra wiring.
      setPendingCount(data.total);
    }
  }, [data, setPendingCount]);

  useEffect(() => {
    if (rejectTarget === null) { setKbOffset(0); return; }
    const show = Keyboard.addListener('keyboardDidShow', e => setKbOffset(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKbOffset(0));
    return () => { show.remove(); hide.remove(); };
  }, [rejectTarget]);

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  // Approve is a PLAIN confirm (PENDING→ACTIVE, safe-direction flip): no input, no
  // checkbox. It uses an in-screen bottom-sheet Modal mirroring the reject sheet on
  // this same screen (web-drivable, unlike the old RN Alert.alert it replaced). The
  // open/submit/close split mirrors handleRejectOpen / handleRejectSubmit /
  // closeRejectSheet, minus the reason input + its validation.
  function handleApproveOpen(church: Church) {
    // Re-entry guard: if an approve is already in flight (on ANY row), ignore the
    // tap so we never open a second confirm over a request that's still resolving.
    if (approveSubmitting) return;
    setApproveTarget(church);
    setApproveError(null);
  }

  function closeApproveSheet() {
    setApproveTarget(null);
    setApproveError(null);
  }

  async function handleApproveSubmit() {
    if (!approveTarget || approveSubmitting) return;

    const target = approveTarget;
    setApproveError(null);   // clear any stale inline error before the new attempt
    setApproveSubmitting(true);
    try {
      await superadminService.approveChurch(target.id);
      // SUCCESS (200): the church has left the PENDING set server-side. We never
      // mutated the local list, so just close + toast + refetch — the existing
      // data→useEffect→setQueue mirror drops the row from fresh server truth (and
      // re-syncs the D-badge count via setPendingCount on the same fetch).
      closeApproveSheet();
      showToast(`${target.name} approved.`);
      retry();
    } catch (err) {
      const detail = extractDetail(err);
      if (detail === 'Only PENDING churches can be approved.') {
        // Someone else already acted on this church → the row is stale. Close the
        // sheet, surface the reason (visible once the sheet is gone), and refetch to
        // drop the doomed row. (Mirror of reject's wrong-status race branch.)
        showToast(detail, 'error');
        closeApproveSheet();
        retry();
      } else {
        // Any other failure: KEEP the sheet + row in place so the user can retry.
        // The sheet stays OPEN, so a toast would render behind the Modal — surface
        // the message INLINE inside the sheet instead (mirror reject's inline error).
        setApproveError(detail ?? "Couldn't approve. Try again.");
      }
    } finally {
      setApproveSubmitting(false);
    }
  }

  function handleRejectOpen(church: Church) {
    setRejectTarget(church);
    setRejectReason('');
    setRejectAttempted(false);
  }

  function closeRejectSheet() {
    setRejectTarget(null);
    setRejectReason('');
    setRejectAttempted(false);
    setRejectError(null);
  }

  async function handleRejectSubmit() {
    if (!rejectReason.trim() || rejectReason.trim().length < 10) {
      setRejectAttempted(true);
      return;
    }
    if (!rejectTarget || rejectSubmitting) return;

    const target = rejectTarget;
    const reason = rejectReason.trim();
    setRejectError(null);   // clear any stale inline error before the new attempt
    setRejectSubmitting(true);
    try {
      await superadminService.rejectChurch(target.id, reason);
      // SUCCESS (200): the church has left the PENDING set server-side. We never
      // mutated the local list, so just close + toast + refetch — the existing
      // data→useEffect→setQueue mirror drops the row from fresh server truth.
      closeRejectSheet();
      showToast(`${target.name} rejected.`);
      retry();
    } catch (err) {
      const detail = extractDetail(err);
      if (detail === 'Only PENDING churches can be rejected.') {
        // Someone else already acted on this church → the row is stale. Refetch to
        // drop it, then close. (Do NOT keep a doomed sheet open.) Toast is visible
        // here because the sheet closes first — unchanged.
        showToast(detail, 'error');
        closeRejectSheet();
        retry();
      } else {
        // Any other failure: KEEP the sheet + row in place so the user can retry.
        // The sheet stays OPEN, so a toast would render behind the Modal — surface
        // the message INLINE inside the sheet instead (near the submit control).
        setRejectError(detail ?? "Couldn't reject. Try again.");
      }
    } finally {
      setRejectSubmitting(false);
    }
  }

  return (
    <SafeAreaView edges={['bottom']} style={styles.root}>
      {toast ? (
        <View style={styles.toastWrap}>
          <Toast type={toast.type} message={toast.msg} visible />
        </View>
      ) : null}

      {qState === 'loading' ? (
        <View style={styles.centerBlock}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : qState === 'error' ? (
        <View style={styles.errorBlock}>
          <Ionicons name="cloud-offline-outline" size={40} color={Colors.border} />
          <Text style={styles.errorText}>Couldn’t load the queue.</Text>
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
              <Text style={styles.truncText}>Showing first {queue.length} of {total}.</Text>
            </View>
          ) : null}
          <FlatList
            data={queue}
            keyExtractor={item => item.id}
            renderItem={({ item }) => (
              <ApplicationCard
                item={item}
                onApprove={handleApproveOpen}
                onReject={handleRejectOpen}
              />
            )}
            contentContainerStyle={styles.listContent}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            ListHeaderComponent={
              queue.length > 0 ? (
                <View style={styles.listHeader}>
                  <Text style={styles.listHeaderText}>
                    {total} pending application{total !== 1 ? 's' : ''}
                  </Text>
                </View>
              ) : null
            }
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Ionicons name="checkmark-circle-outline" size={56} color={Colors.border} />
                <Text style={styles.emptyTitle}>No pending applications</Text>
                <Text style={styles.emptySubtitle}>
                  All church registration requests have been reviewed.
                </Text>
              </View>
            }
          />
        </>
      )}

      {/* Reject bottom sheet */}
      <Modal
        visible={rejectTarget !== null}
        transparent
        animationType="slide"
        onRequestClose={() => { if (!rejectSubmitting) closeRejectSheet(); }}
      >
        <View style={styles.kavContainer}>
        <TouchableOpacity
          style={styles.modalOverlay}
          onPress={() => { if (!rejectSubmitting) closeRejectSheet(); }}
          activeOpacity={1}
        />
        <View style={[styles.rejectSheet, kbOffset > 0 ? { marginBottom: kbOffset } : null]}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>Reject Application</Text>
          {rejectTarget ? (
            <Text style={styles.sheetMeta}>{rejectTarget.name}</Text>
          ) : null}

          <Text style={styles.inputLabel}>
            Reason for rejection <Text style={styles.required}>*</Text>
          </Text>
          <TextInput
            style={[
              styles.reasonInput,
              rejectAttempted && styles.reasonInputError,
            ]}
            value={rejectReason}
            onChangeText={t => {
              setRejectReason(t);
              if (rejectAttempted) setRejectAttempted(false);
            }}
            placeholder="Explain why this application is being rejected (min 10 characters)…"
            placeholderTextColor={Colors.textMuted}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            accessibilityLabel="Rejection reason"
          />
          {rejectAttempted ? (
            <Text style={styles.inputError}>
              {rejectReason.trim().length === 0
                ? 'A reason is required.'
                : 'Reason must be at least 10 characters.'}
            </Text>
          ) : null}

          {/* Submit failure (generic-error branch). The sheet stays open, so a toast
              would render behind the Modal — show the message inline here instead. */}
          {rejectError ? (
            <View style={styles.rejectErrorBox}>
              <Ionicons name="alert-circle-outline" size={16} color={Colors.danger} />
              <Text style={styles.rejectErrorText}>{rejectError}</Text>
            </View>
          ) : null}

          <View style={styles.sheetActions}>
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={closeRejectSheet}
              disabled={rejectSubmitting}
              activeOpacity={0.8}
              accessibilityRole="button"
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.submitBtn, rejectSubmitting && styles.submitBtnDisabled]}
              onPress={handleRejectSubmit}
              disabled={rejectSubmitting}
              activeOpacity={0.8}
              accessibilityRole="button"
            >
              <Text style={styles.submitBtnText}>{rejectSubmitting ? 'Rejecting…' : 'Reject'}</Text>
            </TouchableOpacity>
          </View>
        </View>
        </View>
      </Modal>

      {/* Approve confirm sheet — PLAIN confirm (PENDING→ACTIVE). Mirrors the reject
          sheet's structure (same RN Modal + reusable sheet styles) but DROPS the
          reason TextInput entirely; just church name + consequence + Cancel/Approve. */}
      <Modal
        visible={approveTarget !== null}
        transparent
        animationType="slide"
        onRequestClose={() => { if (!approveSubmitting) closeApproveSheet(); }}
      >
        <View style={styles.kavContainer}>
          <TouchableOpacity
            style={styles.modalOverlay}
            onPress={() => { if (!approveSubmitting) closeApproveSheet(); }}
            activeOpacity={1}
          />
          <View style={styles.rejectSheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Approve Church</Text>
            {approveTarget ? (
              <Text style={styles.sheetMeta}>{approveTarget.name}</Text>
            ) : null}

            <Text style={styles.approveBody}>
              They will be notified and can immediately start creating campaigns and
              receiving donations.
            </Text>

            {/* Submit failure (generic-error branch). The sheet stays open, so a toast
                would render behind the Modal — show the message inline here instead. */}
            {approveError ? (
              <View style={styles.rejectErrorBox}>
                <Ionicons name="alert-circle-outline" size={16} color={Colors.danger} />
                <Text style={styles.rejectErrorText}>{approveError}</Text>
              </View>
            ) : null}

            <View style={styles.sheetActions}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={closeApproveSheet}
                disabled={approveSubmitting}
                activeOpacity={0.8}
                accessibilityRole="button"
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.approveConfirmBtn, approveSubmitting && styles.approveConfirmBtnDisabled]}
                onPress={handleApproveSubmit}
                disabled={approveSubmitting}
                activeOpacity={0.8}
                accessibilityRole="button"
              >
                <Text style={styles.approveConfirmBtnText}>{approveSubmitting ? 'Approving…' : 'Approve'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.grey },

  toastWrap: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
  },

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

  listContent: {
    padding: Spacing.md,
    paddingBottom: Spacing.xl,
  },
  listHeader: {
    marginBottom: Spacing.sm,
  },
  listHeaderText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  separator: { height: Spacing.sm },

  // Application card
  card: {
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
    gap: 4,
  },
  cardName: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.text,
  },
  cardEmail: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
  cardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  cardMetaText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  cardMetaDot: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
  cardDate: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 2,
  },
  cardDesc: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: FontSize.sm * 1.6,
    marginTop: 4,
  },
  cardActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.md,
    paddingTop: Spacing.md,
    borderTopWidth: 1,
    borderTopColor: Colors.grey,
  },
  approveBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 42,
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.md,
    gap: 6,
  },
  approveBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.sm,
    color: Colors.white,
  },
  rejectBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 42,
    borderWidth: 1.5,
    borderColor: Colors.danger,
    borderRadius: BorderRadius.md,
    gap: 6,
    backgroundColor: Colors.white,
  },
  rejectBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.sm,
    color: Colors.danger,
  },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingTop: 80,
    gap: Spacing.sm,
  },
  emptyTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
    marginTop: Spacing.sm,
  },
  emptySubtitle: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: Spacing.xl,
    lineHeight: FontSize.md * 1.6,
  },

  // Reject modal
  kavContainer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  rejectSheet: {
    backgroundColor: Colors.white,
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    padding: Spacing.md,
    paddingBottom: Spacing.xxl,
    gap: Spacing.sm,
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: 'center',
    marginBottom: Spacing.sm,
  },
  sheetTitle: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.text,
  },
  sheetMeta: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
  inputLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 4,
  },
  required: { color: Colors.danger },
  reasonInput: {
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    padding: Spacing.sm,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.text,
    minHeight: 100,
    textAlignVertical: 'top',
  },
  reasonInputError: { borderColor: Colors.danger },
  inputError: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.danger,
  },
  rejectErrorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.dangerLight,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 8,
  },
  rejectErrorText: {
    flex: 1,
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.danger,
  },
  sheetActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: 4,
  },
  cancelBtn: {
    flex: 1,
    height: 48,
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.textSecondary,
  },
  submitBtn: {
    flex: 1,
    height: 48,
    backgroundColor: Colors.danger,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.white,
  },

  // Approve sheet — the consequence sentence + a TEAL confirm (NOT the danger-red
  // submitBtn; approve is a safe-direction primary action, so it uses Colors.primary).
  approveBody: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    lineHeight: FontSize.md * 1.6,
    marginTop: 2,
    marginBottom: 4,
  },
  approveConfirmBtn: {
    flex: 1,
    height: 48,
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  approveConfirmBtnDisabled: { opacity: 0.6 },
  approveConfirmBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.white,
  },
});
