import React from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { PublicCampaign } from '../../types';
import ProgressBar from '../ui/ProgressBar';
import RemoteImage from '../ui/RemoteImage';

// Category icon letters used as visual placeholder until real images are loaded
const CATEGORY_INITIALS: Record<string, string> = {
  Building:  'B',
  Outreach:  'O',
  Youth:     'Y',
  Education: 'E',
  Medical:   'M',
  Relief:    'R',
  Other:     '?',
};

interface CampaignCardProps {
  campaign: PublicCampaign;
  onDonate?: () => void;
}

function CampaignCard({ campaign, onDonate }: CampaignCardProps) {
  const handleDonate = onDonate ?? (() => Alert.alert('Donate', `Donate to: ${campaign.title}`));
  const initial = CATEGORY_INITIALS[campaign.category] ?? '?';
  const goalFormatted = campaign.goalAmount.toLocaleString();

  return (
    <View style={styles.card}>
      {/* Banner — real image if uploaded, teal placeholder + initial otherwise */}
      <RemoteImage
        uri={campaign.bannerImageUrl}
        style={styles.banner}
        resizeMode="cover"
        fallback={
          <View
            style={styles.banner}
            accessible={false}
          >
            <View style={styles.bannerIconCircle}>
              <Text style={styles.bannerIconText}>{initial}</Text>
            </View>
          </View>
        }
      />

      <View style={styles.body}>
        {/* Pills row */}
        <View style={styles.pillRow}>
          {campaign.groupLabelName && (
            <View style={styles.pill}>
              <Text style={styles.pillText}>{campaign.groupLabelName}</Text>
            </View>
          )}
          <View style={[styles.pill, styles.categoryPill]}>
            <Text style={[styles.pillText, styles.categoryPillText]}>{campaign.category}</Text>
          </View>
        </View>

        {/* Title */}
        <Text style={styles.title} numberOfLines={2}>
          {campaign.title}
        </Text>

        {/* Church name */}
        <Text style={styles.churchName} numberOfLines={1}>
          {campaign.churchName}
        </Text>

        {/* Progress bar — 4px compact variant, no labels (we show our own below) */}
        <View style={styles.progressWrapper}>
          <ProgressBar raised={campaign.raisedAmount} goal={campaign.goalAmount} height={4} showLabels={false} />
        </View>

        {/* Amount row */}
        <View style={styles.amountRow}>
          <Text style={styles.amountRaised}>
            KES {campaign.raisedAmount.toLocaleString()}
          </Text>
          <Text style={styles.amountGoal}> raised of KES {goalFormatted}</Text>
        </View>

        {/* Donate button */}
        <TouchableOpacity
          style={styles.donateButton}
          onPress={handleDonate}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={`Donate via M-Pesa to ${campaign.title}`}
        >
          <Text style={styles.donateButtonText}>Donate via M-Pesa</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
    marginBottom: Spacing.md,
  },
  banner: {
    height: 160,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerIconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerIconText: {
    fontFamily: 'Poppins-Bold',
    fontSize: 22,
    color: Colors.white,
  },
  body: {
    padding: Spacing.md,
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  pill: {
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  pillText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.primary,
  },
  categoryPill: {
    backgroundColor: Colors.accentLight,
  },
  categoryPillText: {
    color: Colors.accentDark,
  },
  title: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.text,
    lineHeight: 20,
    marginBottom: 4,
  },
  churchName: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginBottom: 10,
  },
  progressWrapper: {
    marginBottom: 6,
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: 12,
    flexWrap: 'wrap',
  },
  amountRaised: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.primary,
  },
  amountGoal: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  donateButton: {
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.md,
    height: Spacing.touch,
    alignItems: 'center',
    justifyContent: 'center',
  },
  donateButtonText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.white,
  },
});

export default React.memo(CampaignCard);
