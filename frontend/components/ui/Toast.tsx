import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastProps {
  type: ToastType;
  message: string;
  visible: boolean;
}

const TYPE_STYLES: Record<ToastType, { bg: string; text: string }> = {
  success: { bg: Colors.successLight, text: Colors.success },
  error:   { bg: Colors.dangerLight,  text: Colors.danger },
  info:    { bg: Colors.primaryLight, text: Colors.primary },
  warning: { bg: Colors.accentLight,  text: Colors.accentDark },
};

export default function Toast({ type, message, visible }: ToastProps) {
  if (!visible) return null;
  const ts = TYPE_STYLES[type];
  return (
    <View style={[styles.toast, { backgroundColor: ts.bg }]}>
      <Text style={[styles.text, { color: ts.text }]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  toast: {
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  text: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.md,
  },
});
