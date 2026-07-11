import React from 'react';
import {
  Modal as RNModal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { useIsWideWeb } from '../layout/Screen';
import Button from './Button';

interface ModalProps {
  visible: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void;
  onCancel: () => void;
  confirmVariant?: 'primary' | 'cta' | 'danger';
  confirmDisabled?: boolean;
}

export default function Modal({
  visible,
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  confirmVariant = 'primary',
  confirmDisabled = false,
}: ModalProps) {
  const isWideWeb = useIsWideWeb();
  return (
    <RNModal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <TouchableOpacity style={styles.overlay} onPress={onCancel} activeOpacity={1}>
        <TouchableOpacity
          activeOpacity={1}
          style={[styles.card, isWideWeb && styles.cardWide]}
          onPress={() => {}}
        >
          <Text style={styles.title}>{title}</Text>
          <View style={styles.body}>{children}</View>
          {onConfirm ? (
            <>
              <Button label={confirmLabel} variant={confirmVariant} onPress={onConfirm} disabled={confirmDisabled} />
              <View style={{ height: Spacing.sm }} />
            </>
          ) : null}
          <Button label={cancelLabel} variant="secondary" onPress={onCancel} />
        </TouchableOpacity>
      </TouchableOpacity>
    </RNModal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.md,
  },
  card: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    width: '100%',
  },
  // Web ≥768px only — narrower windows (512–767px) and phone landscape render a
  // card wider than 480 today and must keep doing so (pixel-identical below 768).
  cardWide: {
    maxWidth: 480,
    alignSelf: 'center',
  },
  title: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.text,
    marginBottom: Spacing.md,
  },
  body: {
    marginBottom: Spacing.lg,
  },
});
