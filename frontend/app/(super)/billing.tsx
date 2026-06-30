import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Card from '../../components/ui/Card';
import Toast from '../../components/ui/Toast';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { superadminService } from '../../services/superadmin.service';

// Extract a billing save error. The backend's bound failures are FIELD-KEYED
// ({"fee_percent":[…]} / {"growth_price":[…]} / {"parish_price":[…]}), not the
// {detail} shape — so check the named field first, then detail, then a generic
// fallback. Shared by all three rows (fee + the two tier prices) so each surfaces
// its own bound 400 inline.
function extractFieldError(err: unknown, field: string, fallback: string): string {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === 'object') {
    const fieldErr = (data as Record<string, unknown>)[field];
    if (Array.isArray(fieldErr) && typeof fieldErr[0] === 'string') return fieldErr[0];
    const detail = (data as { detail?: unknown }).detail;
    if (typeof detail === 'string') return detail;
  }
  return fallback;
}

// ─── Editable rate row ────────────────────────────────────────────────────────

function EditableRow({
  label,
  value,
  suffix,
  onSave,
  warningText,
  saving,
  error,
  onClearError,
}: {
  label: string;
  value: string;
  suffix: string;
  // Sync rows (growth/parish) return void and close immediately. The fee row returns
  // Promise<boolean>: the editor stays OPEN until the server responds, then closes on
  // success (true) or stays open on failure (false) so the error + bad value persist.
  onSave: (newValue: string) => void | Promise<boolean>;
  warningText?: string;
  saving?: boolean;
  error?: string | null;
  onClearError?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(value);

  async function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed || isNaN(Number(trimmed))) {
      setDraft(value);
      setEditing(false);
      return;
    }
    const result = onSave(trimmed);
    if (result instanceof Promise) {
      const ok = await result;           // async (fee) — close only on server success
      if (ok) setEditing(false);
    } else {
      setEditing(false);                 // sync (growth/parish) — close immediately
    }
  }

  function handleCancel() {
    setDraft(value);
    setEditing(false);
    onClearError?.();
  }

  return (
    <View style={styles.editRow}>
      <View style={styles.editRowTop}>
        <Text style={styles.editLabel}>{label}</Text>

        {editing ? (
          <View style={styles.editField}>
            <TextInput
              style={styles.editInput}
              value={draft}
              onChangeText={setDraft}
              keyboardType="decimal-pad"
              autoFocus
              selectTextOnFocus
              accessibilityLabel={`Edit ${label}`}
            />
            <Text style={styles.editSuffix}>{suffix}</Text>
          </View>
        ) : (
          <View style={styles.valueRow}>
            <Text style={styles.editValue}>{value}{suffix}</Text>
            <TouchableOpacity
              style={styles.pencilBtn}
              onPress={() => { setDraft(value); setEditing(true); onClearError?.(); }}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${label}`}
            >
              <Ionicons name="pencil-outline" size={18} color={Colors.primary} />
            </TouchableOpacity>
          </View>
        )}
      </View>

      {editing ? (
        <View style={styles.editActions}>
          {warningText ? (
            <Text style={styles.warningText}>{warningText}</Text>
          ) : null}
          {error ? (
            <View style={styles.rowErrorBox}>
              <Ionicons name="alert-circle-outline" size={15} color={Colors.danger} />
              <Text style={styles.rowErrorText}>{error}</Text>
            </View>
          ) : null}
          <View style={styles.editBtns}>
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={handleCancel}
              disabled={saving}
              activeOpacity={0.8}
              accessibilityRole="button"
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
              onPress={handleSave}
              disabled={saving}
              activeOpacity={0.8}
              accessibilityRole="button"
            >
              <Text style={styles.saveBtnText}>{saving ? 'Saving…' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function SuperBillingScreen() {
  const [platformFee, setPlatformFee]   = useState('');
  const [growthPrice, setGrowthPrice]   = useState('');
  const [parishPrice, setParishPrice]   = useState('');
  const [toast, setToast]               = useState<{ msg: string } | null>(null);
  const [billingState, setBillingState] = useState<'loading' | 'error' | 'ok'>('loading');
  const [reload, setReload]             = useState(0);
  const [feeSaving, setFeeSaving]       = useState(false);
  const [feeError, setFeeError]         = useState<string | null>(null);
  const [growthSaving, setGrowthSaving] = useState(false);
  const [growthError, setGrowthError]   = useState<string | null>(null);
  const [parishSaving, setParishSaving] = useState(false);
  const [parishError, setParishError]   = useState<string | null>(null);

  // On mount: authed GET /super/billing/. Same loading / error / reload-counter
  // pattern as the wired treasurer Overview read (app/(treasurer)/index.tsx). The
  // money values arrive as STRINGS and seed the editable inputs VERBATIM — reading
  // never reformats a stored money value (see mapPlatformSettings). All three Save
  // actions (fee + Growth/Parish prices) are now wired to PATCH /super/billing/ and
  // re-seed from server truth on success (handleFeeChange / handleGrowthChange /
  // handleParishChange).
  useEffect(() => {
    let cancelled = false;
    setBillingState('loading');
    (async () => {
      try {
        const data = await superadminService.getBilling();
        if (!cancelled) {
          setPlatformFee(data.feePercent);
          setGrowthPrice(data.growthPrice);
          setParishPrice(data.parishPrice);
          setBillingState('ok');
        }
      } catch {
        if (!cancelled) setBillingState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [reload]);

  function showToast(msg: string) {
    setToast({ msg });
    setTimeout(() => setToast(null), 3500);
  }

  // WIRED: PATCH /super/billing/ fee_percent (the LIVE money-math rate). Returns a
  // boolean so EditableRow keeps the editor open on failure (bad value + inline error
  // stay visible) and closes only on server success. NO optimistic display change —
  // the shown fee updates only after the 200, from server truth.
  async function handleFeeChange(v: string): Promise<boolean> {
    if (feeSaving) return false;            // re-entry guard while a save is pending
    setFeeError(null);
    setFeeSaving(true);
    try {
      const updated = await superadminService.saveFeePercent(v);
      setPlatformFee(updated.feePercent);   // re-seed ONLY the fee from server truth
      showToast('Fee saved. Existing donations are not recalculated.');
      return true;
    } catch (err) {
      // Do NOT change the displayed fee. Surface the backend's field-keyed 0..10 bound
      // 400 (or a generic fallback) inline next to the fee row.
      setFeeError(extractFieldError(err, 'fee_percent', "Couldn't save fee. Try again."));
      return false;
    } finally {
      setFeeSaving(false);
    }
  }

  // WIRED: PATCH /super/billing/ growth_price. MIRRORS handleFeeChange — async, returns
  // a boolean so EditableRow keeps the editor open on failure (bad value + inline error
  // persist) and closes only on the 200. NO optimistic display change — the shown price
  // updates from SERVER TRUTH (so a reload shows it stuck; the old local-only setState
  // lost the change on reload). Price kept as a STRING (billing-input convention).
  async function handleGrowthChange(v: string): Promise<boolean> {
    if (growthSaving) return false;
    setGrowthError(null);
    setGrowthSaving(true);
    try {
      const updated = await superadminService.saveGrowthPrice(v);
      setGrowthPrice(updated.growthPrice);   // re-seed from server truth
      showToast('Growth tier price saved.');
      return true;
    } catch (err) {
      setGrowthError(extractFieldError(err, 'growth_price', "Couldn't save price. Try again."));
      return false;
    } finally {
      setGrowthSaving(false);
    }
  }

  async function handleParishChange(v: string): Promise<boolean> {
    if (parishSaving) return false;
    setParishError(null);
    setParishSaving(true);
    try {
      const updated = await superadminService.saveParishPrice(v);
      setParishPrice(updated.parishPrice);   // re-seed from server truth
      showToast('Parish tier price saved.');
      return true;
    } catch (err) {
      setParishError(extractFieldError(err, 'parish_price', "Couldn't save price. Try again."));
      return false;
    } finally {
      setParishSaving(false);
    }
  }

  return (
    <SafeAreaView edges={['bottom']} style={styles.root}>
      {toast ? (
        <View style={styles.toastWrap}>
          <Toast type="warning" message={toast.msg} visible />
        </View>
      ) : null}

      {billingState === 'loading' ? (
        <View style={styles.centerBlock}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : billingState === 'error' ? (
        <View style={styles.errorBlock}>
          <Ionicons name="cloud-offline-outline" size={40} color={Colors.border} />
          <Text style={styles.errorText}>Couldn’t load billing settings.</Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => setReload(k => k + 1)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Text style={styles.retryBtnText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : (
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
        {/* ── Platform fee ────────────────────────────────────────────────── */}
        <Text style={styles.sectionHeader}>Platform Fee</Text>
        <Card style={styles.card}>
          <Text style={styles.cardNote}>
            Applied to every successful M-Pesa donation. Changes apply to future donations only.
          </Text>
          <EditableRow
            label="Platform fee rate"
            value={platformFee}
            suffix="%"
            onSave={handleFeeChange}
            warningText="Changes apply to future donations only."
            saving={feeSaving}
            error={feeError}
            onClearError={() => setFeeError(null)}
          />
        </Card>

        {/* ── Subscription tier prices ─────────────────────────────────────── */}
        <Text style={styles.sectionHeader}>Subscription Tier Prices</Text>
        <Card style={styles.card} padding={0}>
          <View style={styles.tierRow}>
            <View style={styles.tierLabel}>
              <View style={[styles.tierDot, { backgroundColor: Colors.primary }]} />
              <Text style={styles.tierName}>Growth</Text>
            </View>
            <EditableRow
              label="Monthly price"
              value={growthPrice}
              suffix=" KES/mo"
              onSave={handleGrowthChange}
              saving={growthSaving}
              error={growthError}
              onClearError={() => setGrowthError(null)}
            />
          </View>
          <View style={styles.tierDivider} />
          <View style={styles.tierRow}>
            <View style={styles.tierLabel}>
              <View style={[styles.tierDot, { backgroundColor: Colors.accent }]} />
              <Text style={styles.tierName}>Parish</Text>
            </View>
            <EditableRow
              label="Monthly price"
              value={parishPrice}
              suffix=" KES/mo"
              onSave={handleParishChange}
              saving={parishSaving}
              error={parishError}
              onClearError={() => setParishError(null)}
            />
          </View>
        </Card>
        </ScrollView>
      </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.grey },
  toastWrap: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  content: {
    padding: Spacing.md,
    paddingBottom: Spacing.xl,
  },

  // Loading / error (copied from the wired treasurer Overview read)
  centerBlock: {
    paddingVertical: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorBlock: {
    paddingVertical: 40,
    alignItems: 'center',
    gap: Spacing.sm,
  },
  errorText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 4,
    paddingHorizontal: Spacing.lg,
    height: Spacing.touch,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryBtnText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.white,
  },

  sectionHeader: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: Spacing.md,
    marginBottom: Spacing.sm,
    paddingHorizontal: 2,
  },

  card: { marginBottom: 0 },

  cardNote: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: FontSize.sm * 1.6,
    marginBottom: Spacing.md,
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.sm,
    padding: Spacing.sm,
  },

  // Editable row
  editRow: {
    gap: Spacing.sm,
  },
  editRowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  editLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.base,
    color: Colors.text,
    flex: 1,
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  editValue: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.primary,
  },
  pencilBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editField: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: Colors.primary,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm,
    height: 44,
    gap: 4,
  },
  editInput: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.primary,
    flex: 1,
    height: 44,
    padding: 0,
    textAlignVertical: 'center',
  },
  editSuffix: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.base,
    color: Colors.textMuted,
  },
  editActions: { gap: Spacing.sm },
  warningText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.warning,
    backgroundColor: Colors.warningLight,
    borderRadius: BorderRadius.sm,
    padding: Spacing.sm,
  },
  editBtns: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  cancelBtn: {
    flex: 1,
    height: 40,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  saveBtn: {
    flex: 1,
    height: 40,
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.sm,
    color: Colors.white,
  },
  saveBtnDisabled: { opacity: 0.6 },
  rowErrorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.dangerLight,
    borderRadius: BorderRadius.sm,
    padding: Spacing.sm,
  },
  rowErrorText: {
    flex: 1,
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.danger,
  },

  // Tier rows
  tierRow: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    gap: Spacing.sm,
  },
  tierDivider: { height: 1, backgroundColor: Colors.border },
  tierLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  tierDot: { width: 10, height: 10, borderRadius: 5 },
  tierName: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.base,
    color: Colors.text,
  },
});
