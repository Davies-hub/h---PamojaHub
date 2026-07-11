import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import ResponsiveSheet from '../ui/ResponsiveSheet';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { fmtKes } from '../../utils/formatters';

interface Props {
  visible: boolean;
  withdrawalId: string;
  amount: number;
  destinationPhone: string;
  destinationName: string;
  campaignTitle: string;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// DISPLAY-ONLY by design: the approve endpoint takes NO body and pays the
// phone/amount STORED on the row, so an editable field here would be a money
// hazard (it could lie about what's actually being dispatched). Confirming
// here is a destination-verification step, not a value-entry step.
export default function DisbursementApprovalDialog({
  visible,
  amount,
  destinationPhone,
  destinationName,
  campaignTitle,
  submitting,
  onConfirm,
  onCancel,
}: Props) {
  function formatPhone(raw: string): string {
    const d = raw.replace(/\D/g, '');
    if (d.length <= 4) return d;
    if (d.length <= 7) return `${d.slice(0, 4)} ${d.slice(4)}`;
    return `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  }

  return (
    <ResponsiveSheet
      visible={visible}
      onRequestClose={onCancel}
      dismissable={!submitting}
    >
          <View style={styles.handle} />

          <Text style={styles.title}>Approve Payout</Text>
          <Text style={styles.meta} numberOfLines={1}>{campaignTitle}</Text>

          <View style={styles.divider} />

          <Text style={styles.fieldLabel}>Payout amount (KES)</Text>
          <Text style={styles.amountDisplay}>{fmtKes(amount)}</Text>

          <Text style={[styles.fieldLabel, { marginTop: Spacing.md }]}>
            M-Pesa destination
          </Text>
          <Text style={styles.phoneDisplay}>{formatPhone(destinationPhone)}</Text>
          <Text style={styles.nameRow}>
            <Ionicons name="person-outline" size={13} color={Colors.textMuted} />
            {'  '}{destinationName}
          </Text>

          <View style={styles.warning}>
            <Ionicons name="warning-outline" size={16} color={Colors.danger} />
            <Text style={styles.warningText}>
              This dispatches a real M-Pesa payout to the number above. Verify it's
              correct — if not, cancel and reject the request instead.
            </Text>
          </View>

          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.cancelBtn, submitting && styles.btnDisabled]}
              onPress={onCancel}
              activeOpacity={0.8}
              disabled={submitting}
              accessibilityRole="button"
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.confirmBtn, submitting && styles.btnDisabled]}
              onPress={onConfirm}
              activeOpacity={0.85}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel="Confirm payout"
              accessibilityState={{ busy: submitting, disabled: submitting }}
            >
              {submitting ? (
                <>
                  <ActivityIndicator size="small" color={Colors.white} />
                  <Text style={styles.confirmText}>Dispatching…</Text>
                </>
              ) : (
                <>
                  <Ionicons name="checkmark-circle-outline" size={18} color={Colors.white} />
                  <Text style={styles.confirmText}>Confirm Payout</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
    </ResponsiveSheet>
  );
}

const styles = StyleSheet.create({
  // Container/overlay/sheet now come from ResponsiveSheet.
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: 'center',
    marginBottom: Spacing.sm,
  },
  title: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.text,
  },
  meta: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    marginBottom: 4,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: Spacing.sm,
  },
  fieldLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: 4,
  },
  amountDisplay: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.title,
    color: Colors.text,
  },
  nameRow: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    marginTop: 6,
  },
  phoneDisplay: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.title,
    color: Colors.text,
    letterSpacing: 1,
    marginBottom: 2,
  },
  warning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: Colors.dangerLight,
    borderRadius: BorderRadius.md,
    padding: Spacing.sm,
    gap: 8,
    marginTop: Spacing.sm,
  },
  warningText: {
    flex: 1,
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.danger,
    lineHeight: 20,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
  cancelBtn: {
    flex: 1,
    height: 50,
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.textSecondary,
  },
  confirmBtn: {
    flex: 2,
    height: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.success,
    borderRadius: BorderRadius.md,
    gap: 6,
  },
  confirmText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.white,
  },
  btnDisabled: {
    opacity: 0.6,
  },
});
