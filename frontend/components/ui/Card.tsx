import React from 'react';
import { StyleSheet, View, ViewProps } from 'react-native';
import { BorderRadius, Colors, Shadows, Spacing } from '../../constants/theme';

interface CardProps extends ViewProps {
  children: React.ReactNode;
  padding?: number;
}

export default function Card({ children, padding = Spacing.md, style, ...props }: CardProps) {
  return (
    <View style={[styles.card, { padding }, style]} {...props}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    ...Shadows.sm,
  },
});
