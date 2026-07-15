import React from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableOpacityProps,
} from 'react-native';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';

type ButtonVariant = 'primary' | 'cta' | 'secondary' | 'danger' | 'ghost';

interface ButtonProps extends Omit<TouchableOpacityProps, 'style'> {
  label: string;
  variant?: ButtonVariant;
  loading?: boolean;
  fullWidth?: boolean;
}

const VARIANT_STYLES: Record<ButtonVariant, { bg: string; text: string; border?: string }> = {
  primary:   { bg: Colors.primary,     text: Colors.white },
  cta:       { bg: Colors.accent,      text: Colors.white },
  secondary: { bg: 'transparent',      text: Colors.primary, border: Colors.primary },
  danger:    { bg: Colors.danger,      text: Colors.white },
  ghost:     { bg: 'transparent',      text: Colors.primary },
};

export default function Button({
  label,
  variant = 'primary',
  loading = false,
  fullWidth = true,
  disabled,
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;
  const vs = VARIANT_STYLES[variant];

  return (
    <TouchableOpacity
      style={[
        styles.base,
        { backgroundColor: isDisabled ? Colors.border : vs.bg },
        vs.border ? { borderWidth: 2, borderColor: vs.border } : null,
        fullWidth && styles.fullWidth,
      ]}
      disabled={isDisabled}
      activeOpacity={0.85}
      accessibilityRole="button"
      {...props}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'secondary' ? Colors.primary : Colors.white} />
      ) : (
        <Text style={[styles.label, { color: vs.text }]}>{label}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: {
    height: 48,
    borderRadius: BorderRadius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
  },
  fullWidth: { width: '100%' },
  label: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
  },
});
