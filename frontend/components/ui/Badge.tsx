import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { BorderRadius, Colors } from '../../constants/theme';

type BadgeStatus =
  | 'ACTIVE' | 'PAUSED' | 'CLOSED'
  | 'PENDING' | 'PENDING_APPROVAL' | 'PROCESSING'
  | 'PAID' | 'FAILED' | 'FAILED_FINAL' | 'REJECTED'
  | 'SUCCESSFUL' | 'SUSPENDED'
  | 'FREE' | 'GROWTH' | 'PARISH';

const STATUS_CONFIG: Record<BadgeStatus, { text: string; bg: string; dot: string }> = {
  ACTIVE:           { text: Colors.success,       bg: Colors.successLight,  dot: Colors.success },
  PAUSED:           { text: Colors.textSecondary, bg: Colors.grey,          dot: Colors.textSecondary },
  CLOSED:           { text: Colors.primary,       bg: Colors.primaryLight,  dot: Colors.primary },
  PENDING:          { text: Colors.accent,        bg: Colors.accentLight,   dot: Colors.accent },
  PENDING_APPROVAL: { text: Colors.accent,        bg: Colors.accentLight,   dot: Colors.accent },
  PROCESSING:       { text: Colors.primary,       bg: Colors.primaryLight,  dot: Colors.primary },
  PAID:             { text: Colors.success,       bg: Colors.successLight,  dot: Colors.success },
  SUCCESSFUL:       { text: Colors.success,       bg: Colors.successLight,  dot: Colors.success },
  FAILED:           { text: Colors.danger,        bg: Colors.dangerLight,   dot: Colors.danger },
  FAILED_FINAL:     { text: Colors.danger,        bg: Colors.dangerLight,   dot: Colors.danger },
  REJECTED:         { text: Colors.danger,        bg: Colors.dangerLight,   dot: Colors.danger },
  SUSPENDED:        { text: Colors.danger,        bg: Colors.dangerLight,   dot: Colors.danger },
  FREE:             { text: Colors.textMuted,     bg: Colors.grey,          dot: Colors.textMuted },
  GROWTH:           { text: Colors.primary,       bg: Colors.primaryLight,  dot: Colors.primary },
  PARISH:           { text: Colors.accent,        bg: Colors.accentLight,   dot: Colors.accent },
};

interface BadgeProps {
  status: BadgeStatus;
  label?: string;
}

export default function Badge({ status, label }: BadgeProps) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.PAUSED;
  return (
    <View style={[styles.pill, { backgroundColor: config.bg }]}>
      <View style={[styles.dot, { backgroundColor: config.dot }]} />
      <Text style={[styles.text, { color: config.text }]}>
        {label ?? status.replace('_', ' ')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: BorderRadius.pill,
    paddingVertical: 4,
    paddingHorizontal: 10,
    gap: 5,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: {
    fontFamily: 'Poppins-Medium',
    fontSize: 11,
    letterSpacing: 0.5,
  },
});
