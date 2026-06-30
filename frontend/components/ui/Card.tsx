import React from 'react';
import { StyleSheet, View, ViewProps } from 'react-native';
import { BorderRadius, Colors, Spacing } from '../../constants/theme';

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
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
  },
});
