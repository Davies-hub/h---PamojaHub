import React from 'react';
import { Modal, StyleSheet, TouchableOpacity, View } from 'react-native';
import { BorderRadius, Colors, Spacing } from '../../constants/theme';
import { useIsWideWeb } from '../layout/Screen';

interface ResponsiveSheetProps {
  visible: boolean;
  onRequestClose: () => void;
  /** false while a submit is in flight — overlay press and back/ESC are ignored. */
  dismissable?: boolean;
  /** Narrow mode only: lifts the sheet above the soft keyboard (marginBottom). */
  keyboardOffset?: number;
  children: React.ReactNode;
}

// Dialog wrapper with two renderings: a bottom sheet on phones/narrow windows
// (values copied verbatim from the Queue's hand-rolled kavContainer/modalOverlay/
// rejectSheet so converted screens stay pixel-identical below 768), and a
// centered max-480 card on web ≥768.
export default function ResponsiveSheet({
  visible,
  onRequestClose,
  dismissable = true,
  keyboardOffset = 0,
  children,
}: ResponsiveSheetProps) {
  const isWideWeb = useIsWideWeb();

  function handleClose() {
    if (dismissable) onRequestClose();
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType={isWideWeb ? 'fade' : 'slide'}
      onRequestClose={handleClose}
    >
      <View style={isWideWeb ? styles.containerWide : styles.containerNarrow}>
        <TouchableOpacity style={styles.overlay} onPress={handleClose} activeOpacity={1} />
        <View
          style={[
            isWideWeb ? styles.cardWide : styles.sheetNarrow,
            !isWideWeb && keyboardOffset > 0 ? { marginBottom: keyboardOffset } : null,
          ]}
        >
          {children}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  containerNarrow: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  containerWide: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.md,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheetNarrow: {
    backgroundColor: Colors.white,
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    padding: Spacing.md,
    paddingBottom: Spacing.xxl,
    gap: Spacing.sm,
  },
  cardWide: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    maxWidth: 480,
    width: '100%',
    padding: Spacing.md,
    paddingBottom: Spacing.xxl,
    gap: Spacing.sm,
  },
});
