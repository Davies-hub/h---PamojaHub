import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BorderRadius, Colors, FontSize, Shadows, Spacing } from '../../constants/theme';
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
  // Display-only percent — mirrors ProgressBar's own clamp math
  const percent = campaign.goalAmount > 0
    ? Math.min(Math.round((campaign.raisedAmount / campaign.goalAmount) * 100), 100)
    : 0;

  return (
    <View style={styles.card}>
      {/* Banner — real image if uploaded, teal placeholder + initial otherwise */}
      <RemoteImage
        uri={campaign.bannerImageUrl}
        style={styles.banner}
        resizeMode="cover"
        fallback={
          <View
            style={[styles.banner, styles.bannerFallback]}
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
        <View style={styles.churchRow}>
          <Ionicons name="business-outline" size={12} color={Colors.textMuted} />
          <Text style={styles.churchName} numberOfLines={1}>
            {campaign.churchName}
          </Text>
        </View>

        {/* Progress bar — compact variant, no labels (we show our own below) */}
        <View style={styles.progressWrapper}>
          <ProgressBar raised={campaign.raisedAmount} goal={campaign.goalAmount} height={6} showLabels={false} />
        </View>

        {/* Amount row */}
        <View style={styles.amountRow}>
          <Text style={styles.amountText} numberOfLines={1}>
            <Text style={styles.amountRaised}>
              KES {campaign.raisedAmount.toLocaleString()}
            </Text>
            <Text style={styles.amountGoal}> of KES {goalFormatted}</Text>
          </Text>
          <Text style={styles.percentText}>{percent}%</Text>
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
    borderColor: Colors.borderLight,
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
    marginBottom: Spacing.md,
    ...Shadows.md,
  },
  banner: {
    height: 168,
    backgroundColor: Colors.primaryLight,
  },
  bannerFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadows.sm,
  },
  bannerIconText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxl,
    color: Colors.primary,
  },
  body: {
    padding: Spacing.md,
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: Spacing.sm + 2,
  },
  pill: {
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pillText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.primaryDark,
  },
  categoryPill: {
    backgroundColor: Colors.accentLight,
  },
  categoryPillText: {
    color: Colors.accentDark,
  },
  title: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.base,
    color: Colors.text,
    lineHeight: 21,
    minHeight: 42,
    marginBottom: 2,
  },
  churchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: Spacing.sm + 4,
  },
  churchName: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    flexShrink: 1,
  },
  progressWrapper: {
    marginBottom: Spacing.sm,
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  amountText: {
    flexShrink: 1,
  },
  amountRaised: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.base,
    color: Colors.primary,
  },
  amountGoal: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  percentText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.accentDark,
  },
  donateButton: {
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.pill,
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
