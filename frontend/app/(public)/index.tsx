import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import CampaignCard from '../../components/campaign/CampaignCard';
import BrandLogo from '../../components/ui/BrandLogo';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { campaignsService } from '../../services/campaigns.service';
import { statsService } from '../../services/stats.service';
import { PlatformTotals, PublicCampaign } from '../../types';
import { fmtKes } from '../../utils/formatters';

// ─── Top navigation bar ───────────────────────────────────────────────────────

function TopNav() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [menuOpen, setMenuOpen] = useState(false);

  function openMenu() { setMenuOpen(true); }
  function closeMenu() { setMenuOpen(false); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function nav(href: string) { closeMenu(); router.push(href as any); }

  const dropdownTop = insets.top + 56;

  return (
    <View style={styles.nav}>
      <BrandLogo />

      <View style={styles.navRight}>
        <TouchableOpacity
          style={styles.signInBtn}
          onPress={() => nav('/login')}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Sign in"
        >
          <Ionicons name="log-in-outline" size={18} color={Colors.white} />
          <Text style={styles.signInBtnText}>Sign In</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.hamburger}
          onPress={openMenu}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Open menu"
        >
          <Ionicons name="menu" size={26} color={Colors.white} />
        </TouchableOpacity>
      </View>

      <Modal
        visible={menuOpen}
        transparent
        animationType="fade"
        onRequestClose={closeMenu}
      >
        {/* Backdrop — closes menu on outside tap */}
        <TouchableOpacity
          style={styles.menuBackdrop}
          onPress={closeMenu}
          activeOpacity={1}
          accessibilityRole="button"
          accessibilityLabel="Close menu"
        />

        {/* Dropdown card */}
        <View style={[styles.menuDropdown, { top: dropdownTop }]}>
          <TouchableOpacity style={styles.menuItem} onPress={() => nav('/churches')} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Browse Churches">
            <Ionicons name="business-outline" size={20} color={Colors.primary} />
            <Text style={styles.menuItemText}>Browse Churches</Text>
            <Ionicons name="chevron-forward" size={16} color={Colors.textMuted} style={styles.menuChevron} />
          </TouchableOpacity>
          <View style={styles.menuDivider} />
          <TouchableOpacity style={styles.menuItem} onPress={() => nav('/treasurer')} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Treasurer Portal">
            <Ionicons name="person-circle-outline" size={20} color={Colors.primary} />
            <Text style={styles.menuItemText}>Treasurer Portal</Text>
            <Ionicons name="chevron-forward" size={16} color={Colors.textMuted} style={styles.menuChevron} />
          </TouchableOpacity>
        </View>
      </Modal>
    </View>
  );
}

// ─── Hero section ─────────────────────────────────────────────────────────────

function HeroSection() {
  const router = useRouter();
  return (
    <LinearGradient
      colors={[Colors.gradientStart, Colors.gradientEnd]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.hero}
    >
      <Text style={styles.heroHeadline}>
        A Paybill collects money.{'\n'}Pamoja Hub proves where it went.
      </Text>
      <Text style={styles.heroSubtext}>
        Kenya's church crowdfunding platform. Donate via M-Pesa. Every shilling on record.
      </Text>

      {/* CTA — Browse */}
      <TouchableOpacity
        style={styles.ctaButton}
        onPress={() => router.push('/campaigns')}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel="Browse campaigns"
      >
        <Text style={styles.ctaButtonText}>Browse Campaigns</Text>
      </TouchableOpacity>

      {/* Secondary — Register */}
      <TouchableOpacity
        style={styles.outlineButton}
        onPress={() => router.push('/register')}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel="Register your church"
      >
        <Text style={styles.outlineButtonText}>Register Your Church</Text>
      </TouchableOpacity>

      {/* Stats row */}
      <StatsRow />
    </LinearGradient>
  );
}

function StatsRow() {
  const [totals, setTotals] = useState<PlatformTotals | null>(null);

  // Live GET /stats/ (public, [AllowAny]) — real all-time platform figures. On
  // failure we keep totals null and render em-dashes; we NEVER show a hardcoded
  // figure on a platform that sells "every shilling on record".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t = await statsService.getPlatformTotals();
        if (!cancelled) setTotals(t);
      } catch {
        if (!cancelled) setTotals(null);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Placeholder while loading AND on error — an em-dash, never a fake number.
  const raised = totals ? fmtKes(totals.totalRaised) : '—';
  const campaigns = totals ? String(totals.campaignCount) : '—';
  const churches = totals ? String(totals.churchCount) : '—';

  return (
    <View style={styles.statsRow}>
      <StatItem value={raised} label="Raised" />
      <View style={styles.statDivider} />
      <StatItem value={campaigns} label="Campaigns" />
      <View style={styles.statDivider} />
      <StatItem value={churches} label="Churches" />
    </View>
  );
}

function StatItem({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.statItem}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ─── How it works ─────────────────────────────────────────────────────────────

const HOW_IT_WORKS_STEPS = [
  {
    number: '1',
    title: 'Find a campaign',
    description: 'Browse campaigns from churches across Kenya. Every campaign shows the goal, progress, and treasurer.',
  },
  {
    number: '2',
    title: 'Enter your M-Pesa number',
    description: 'No app download needed. Just enter your Safaricom number and the amount you want to give.',
  },
  {
    number: '3',
    title: 'Confirm your PIN — done.',
    description: 'Approve the M-Pesa prompt on your phone. Your donation is recorded and visible to the church treasurer instantly.',
  },
];

function HowItWorksSection() {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>How it works</Text>
      {HOW_IT_WORKS_STEPS.map((step) => (
        <StepCard key={step.number} {...step} />
      ))}
    </View>
  );
}

function StepCard({
  number,
  title,
  description,
}: {
  number: string;
  title: string;
  description: string;
}) {
  return (
    <View style={styles.stepCard}>
      <View style={styles.stepNumberCircle}>
        <Text style={styles.stepNumberText}>{number}</Text>
      </View>
      <View style={styles.stepContent}>
        <Text style={styles.stepTitle}>{title}</Text>
        <Text style={styles.stepDescription}>{description}</Text>
      </View>
    </View>
  );
}

// ─── Active campaigns preview ─────────────────────────────────────────────────

function ActiveCampaignsSection() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<PublicCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Live GET /campaigns/ (public, [AllowAny], already ACTIVE-only). Mirror the browse
  // screen's fetch (campaigns/index.tsx:169) but unfiltered + capped to 3 for a preview.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const res = await campaignsService.browse();
        if (!cancelled) setCampaigns(res.results.slice(0, 3));
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Empty (fetch succeeded, no active campaigns) → hide the whole section: a header
  // with no cards reads as broken on a marketing landing page.
  if (!loading && !error && campaigns.length === 0) return null;

  return (
    <View style={[styles.section, styles.campaignsSection]}>
      {/* Section header */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Active campaigns</Text>
        <TouchableOpacity
          onPress={() => router.push('/campaigns')}
          accessibilityRole="button"
          accessibilityLabel="See all campaigns"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.seeAllLink}>See all</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.campaignsCenter}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : error ? (
        <Text style={styles.campaignsError}>Couldn’t load campaigns right now.</Text>
      ) : (
        campaigns.map((campaign) => (
          <CampaignCard
            key={campaign.id}
            campaign={campaign}
            onDonate={() => router.push(`/campaigns/${campaign.slug}`)}
          />
        ))
      )}
    </View>
  );
}

// ─── Root screen ──────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    // SafeAreaView background = teal so status bar area matches the nav bar
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <TopNav />
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <HeroSection />
        <HowItWorksSection />
        <ActiveCampaignsSection />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Layout
  safeArea: {
    flex: 1,
    backgroundColor: Colors.primary,
  },
  scrollView: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  scrollContent: {
    paddingBottom: 40,
  },

  // Nav
  nav: {
    height: 56,
    backgroundColor: Colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
  },
  navRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  signInBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  signInBtnText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.white,
  },
  hamburger: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Hero
  hero: {
    paddingHorizontal: Spacing.md,
    paddingTop: 32,
    paddingBottom: 28,
  },
  heroHeadline: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxxl,
    color: Colors.primary,
    lineHeight: FontSize.xxxl * 1.4,
    marginBottom: 12,
  },
  heroSubtext: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    lineHeight: FontSize.md * 1.6,
    marginBottom: 24,
  },
  ctaButton: {
    backgroundColor: Colors.accent,
    borderRadius: BorderRadius.md,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  ctaButtonText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.white,
  },
  outlineButton: {
    backgroundColor: 'transparent',
    borderRadius: BorderRadius.md,
    borderWidth: 2,
    borderColor: Colors.primary,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 28,
  },
  outlineButtonText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.primary,
  },

  // Stats
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    paddingVertical: 14,
    paddingHorizontal: Spacing.md,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.base,
    color: Colors.primary,
    lineHeight: 22,
  },
  statLabel: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    lineHeight: 16,
  },
  statDivider: {
    width: 1,
    height: 32,
    backgroundColor: Colors.border,
  },

  // Sections
  section: {
    paddingHorizontal: Spacing.md,
    paddingTop: 28,
  },
  campaignsSection: {
    paddingTop: 20,
  },
  campaignsCenter: {
    paddingVertical: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  campaignsError: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textMuted,
    paddingVertical: Spacing.md,
  },
  sectionTitle: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.text,
    marginBottom: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  seeAllLink: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },

  // Steps
  stepCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
  },
  stepNumberCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
    flexShrink: 0,
  },
  stepNumberText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.white,
    lineHeight: 20,
  },
  stepContent: {
    flex: 1,
  },
  stepTitle: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.text,
    lineHeight: 22,
    marginBottom: 4,
  },
  stepDescription: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
  },

  // Nav dropdown menu
  menuBackdrop: {
    ...StyleSheet.absoluteFill,
  },
  menuDropdown: {
    position: 'absolute',
    right: Spacing.sm,
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 8,
    width: 260,
    overflow: 'hidden',
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: Spacing.md,
    gap: 10,
    minHeight: 48,
  },
  menuDivider: {
    height: 1,
    backgroundColor: Colors.border,
    marginHorizontal: Spacing.md,
  },
  menuItemText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.md,
    color: Colors.text,
    flex: 1,
  },
  menuChevron: {
    marginLeft: 'auto',
  },
});
