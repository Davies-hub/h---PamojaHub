import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import {
  Image,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Colors, FontSize, Spacing } from '../../constants/theme';

interface ImageViewerProps {
  visible: boolean;
  /** Absolute media URL (already minted server-side). Falsy → unavailable state. */
  uri?: string;
  /** Header caption over the scrim — the church name at the logo call site. */
  title?: string;
  onRequestClose: () => void;
}

// Full-bleed image viewer: tap a thumbnail, see the whole frame uncropped.
//
// The DISMISS contract is copied from ResponsiveSheet (transparent Modal +
// onRequestClose for Android hardware back / web ESC, plus a pressable backdrop);
// only the VISUALS differ, which is why this is a sibling component and not a
// ResponsiveSheet consumer — that wrapper is a white max-480 card, bottom-anchored
// on phones, and every one of those is wrong for a fit-to-screen image.
//
// animationType is 'fade' on BOTH platforms with no useIsWideWeb() branch: the
// image is sized from the live window, so "fit the window" is already responsive.
export default function ImageViewer({ visible, uri, title, onRequestClose }: ImageViewerProps) {
  const { width, height } = useWindowDimensions();

  // Load failure must NOT latch across uri changes (same idiom as RemoteImage:21-26
  // — a once-failed viewer would refuse every later valid image). Keying the failure
  // to the uri it happened for makes a changed uri a fresh attempt by construction.
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const unavailable = !uri || uri === failedUri;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onRequestClose}>
      <View style={styles.backdrop}>
        {/* Tap-to-dismiss layer. The image rides ON it rather than beside it: a
            window-sized contain-fitted Image covers the whole scrim, so a sibling
            backdrop underneath would never receive a tap. Letterbox bars and the
            image itself both dismiss; the header sits above and keeps its own taps. */}
        <TouchableOpacity
          style={styles.scrim}
          onPress={onRequestClose}
          activeOpacity={1}
          accessibilityRole="button"
          accessibilityLabel="Close image"
        >
          {unavailable ? (
            // A dead or absent url renders THIS, never a blank black void — the
            // back arrow and tap-to-dismiss stay live underneath it.
            <Text style={styles.unavailable}>Image unavailable</Text>
          ) : (
            <Image
              source={{ uri }}
              style={{ width, height }}
              resizeMode="contain"
              onError={() => setFailedUri(uri ?? null)}
              accessibilityLabel={title ? `${title} logo, full size` : 'Image, full size'}
            />
          )}
        </TouchableOpacity>

        {/* Header LAST so it paints above the scrim; box-none lets the empty
            stretch beside the arrow fall through to the dismiss layer. */}
        <View style={styles.header} pointerEvents="box-none">
          <TouchableOpacity
            style={styles.backBtn}
            onPress={onRequestClose}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Close image"
          >
            <Ionicons name="arrow-back" size={24} color={Colors.white} />
          </TouchableOpacity>
          {title ? (
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgb(0,0,0)',
  },
  scrim: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unavailable: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.base,
    color: Colors.white,
    opacity: 0.85,
  },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.xl,
    paddingBottom: Spacing.sm,
  },
  backBtn: {
    width: Spacing.touch,
    height: Spacing.touch,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -Spacing.sm,
  },
  title: {
    flex: 1,
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.white,
  },
});
