import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';

const WHATSAPP_GREEN = '#25D366';

interface Props {
  campaignTitle: string;
  campaignUrl: string;
}

export default function WhatsAppShareButton({ campaignTitle, campaignUrl }: Props) {
  async function handleShare() {
    const msg = `Support our campaign: ${campaignTitle}\n${campaignUrl}`;
    const waUrl = `whatsapp://send?text=${encodeURIComponent(msg)}`;
    const canOpen = await Linking.canOpenURL(waUrl).catch(() => false);
    Linking.openURL(canOpen ? waUrl : `https://wa.me/?text=${encodeURIComponent(msg)}`);
  }

  return (
    <TouchableOpacity
      style={styles.btn}
      onPress={handleShare}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel="Share on WhatsApp"
    >
      <Ionicons name="logo-whatsapp" size={20} color={Colors.white} />
      <Text style={styles.label}>Share on WhatsApp</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: WHATSAPP_GREEN,
    borderRadius: BorderRadius.pill,
    height: 52,
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
  },
  label: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.white,
  },
});
