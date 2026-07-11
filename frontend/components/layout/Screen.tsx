import React from 'react';
import {
  Platform,
  StyleProp,
  StyleSheet,
  useWindowDimensions,
  View,
  ViewStyle,
} from 'react-native';

// Desktop-web breakpoint. Below it (and on native, at any width) Screen renders a
// plain unstyled View, so phone output is untouched by construction.
export const WIDE_WEB_MIN_WIDTH = 768;

/** True only on web in a window at least WIDE_WEB_MIN_WIDTH wide. */
export function useIsWideWeb(): boolean {
  const { width } = useWindowDimensions();
  return Platform.OS === 'web' && width >= WIDE_WEB_MIN_WIDTH;
}

type ScreenVariant = 'form' | 'content' | 'wide';

interface ScreenProps {
  children: React.ReactNode;
  /** Desktop-web column width: form=480 (auth/single-column forms),
   *  content=760 (detail/reading), wide=1100 (tables/dashboards). */
  variant: ScreenVariant;
  /** Passthrough — applied at EVERY width, after the cap style. */
  style?: StyleProp<ViewStyle>;
}

// Responsive CONTENT-COLUMN wrapper — not a scroll container. Screens keep their
// own ScrollView/FlatList and place <Screen> INSIDE the scroll, so the scrollbar
// stays at the window edge and full-bleed backgrounds stay on the outer views.
// FlatList-rooted screens (later slices): don't wrap the FlatList — apply the same
// cap to its contentContainerStyle instead, e.g.
//   contentContainerStyle={[base, isWideWeb && { maxWidth: 760, width: '100%', alignSelf: 'center' }]}
export default function Screen({ children, variant, style }: ScreenProps) {
  const isWideWeb = useIsWideWeb();
  return <View style={[isWideWeb && styles[variant], style]}>{children}</View>;
}

const styles = StyleSheet.create({
  form:    { maxWidth: 480,  width: '100%', alignSelf: 'center' },
  content: { maxWidth: 760,  width: '100%', alignSelf: 'center' },
  wide:    { maxWidth: 1100, width: '100%', alignSelf: 'center' },
});
