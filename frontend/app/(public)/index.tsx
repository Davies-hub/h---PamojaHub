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
import Screen, { useIsWideWeb } from '../../components/layout/Screen';
import BrandLogo from '../../components/ui/BrandLogo';
import { BorderRadius, Colors, FontSize, Shadows, Spacing } from '../../constants/theme';
import { campaignsService } from '../../services/campaigns.service';
import { statsService } from '../../services/stats.service';
import { PlatformTotals, PublicCampaign } from '../../types';
import { fmtKes } from '../../utils/formatters';

// ─── Top navigation bar ───────────────────────────────────────────────────────

function NavLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={styles.navLink}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.navLinkText}>{label}</Text>
    </TouchableOpacity>
  );
}

function TopNav() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isWideWeb = useIsWideWeb();
  const [menuOpen, setMenuOpen] = useState(false);

  function openMenu() { setMenuOpen(true); }
  function closeMenu() { setMenuOpen(false); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function nav(href: string) { closeMenu(); router.push(href as any); }

  const dropdownTop = insets.top + 60;

  return (
    <View style={styles.nav}>
      {/* Bar stays full-bleed teal; inner row shares the 1100 content cap */}
      <Screen variant="wide" style={styles.navInner}>
        <BrandLogo />

        <View style={styles.navRight}>
          {isWideWeb && (
            <View style={styles.navLinks}>
              <NavLink label="Campaigns" onPress={() => nav('/campaigns')} />
              <NavLink label="Churches" onPress={() => nav('/churches')} />
              <NavLink label="Treasurer Portal" onPress={() => nav('/treasurer')} />
            </View>
          )}
          <TouchableOpacity
            style={styles.signInBtn}
            onPress={() => nav('/login')}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Sign in"
            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
          >
            <Ionicons name="log-in-outline" size={17} color={Colors.primary} />
            <Text style={styles.signInBtnText}>Sign In</Text>
          </TouchableOpacity>
          {!isWideWeb && (
            <TouchableOpacity
              style={styles.hamburger}
              onPress={openMenu}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Open menu"
            >
              <Ionicons name="menu" size={26} color={Colors.white} />
            </TouchableOpacity>
          )}
        </View>
      </Screen>

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
  const isWideWeb = useIsWideWeb();
  return (
    <LinearGradient
      colors={[Colors.primaryDark, Colors.primary]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.hero, isWideWeb && styles.heroWide]}
    >
      {/* Decorative — soft brand circles behind the content */}
      <View pointerEvents="none" style={styles.heroOrnamentA} />
      <View pointerEvents="none" style={styles.heroOrnamentB} />

      <Screen variant="wide" style={styles.heroContent}>
        <View style={styles.heroEyebrow}>
          <Text style={styles.heroEyebrowText}>KENYA’S CHURCH FUNDRAISING PLATFORM</Text>
        </View>

        <Text style={[styles.heroHeadline, isWideWeb && styles.heroHeadlineWide]}>
          A Paybill collects money.{'\n'}Pamoja Hub proves where it went.
        </Text>
        <View style={styles.heroUnderline} />
        <Text style={styles.heroSubtext}>
          Give to church campaigns over M-Pesa — every shilling recorded, every
          payout approved by the church treasurer.
        </Text>

        <View style={[styles.ctaGroup, isWideWeb && styles.ctaGroupWide]}>
          {/* CTA — Browse */}
          <TouchableOpacity
            style={[styles.ctaButton, isWideWeb && styles.ctaButtonWide]}
            onPress={() => router.push('/campaigns')}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Browse campaigns"
          >
            <Text style={styles.ctaButtonText}>Browse Campaigns</Text>
          </TouchableOpacity>

          {/* Secondary — Register */}
          <TouchableOpacity
            style={[styles.outlineButton, isWideWeb && styles.ctaButtonWide]}
            onPress={() => router.push('/register')}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Register your church"
          >
            <Text style={styles.outlineButtonText}>Register Your Church</Text>
          </TouchableOpacity>
        </View>
      </Screen>
    </LinearGradient>
  );
}

// ─── Platform stats (floating card under the hero) ────────────────────────────

function StatsBand() {
  const isWideWeb = useIsWideWeb();
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
    <View style={styles.statsFloatWrap}>
      <Screen variant="wide">
        <View style={[styles.statsCard, isWideWeb && styles.statsCardWide]}>
          <StatItem icon="cash-outline" value={raised} label="Raised on record" />
          <View style={styles.statDivider} />
          <StatItem icon="megaphone-outline" value={campaigns} label="Campaigns" />
          <View style={styles.statDivider} />
          <StatItem icon="business-outline" value={churches} label="Churches" />
        </View>
      </Screen>
    </View>
  );
}

function StatItem({
  icon,
  value,
  label,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  value: string;
  label: string;
}) {
  const isWideWeb = useIsWideWeb();
  return (
    <View style={styles.statItem}>
      <View style={styles.statIconCircle}>
        <Ionicons name={icon} size={17} color={Colors.primary} />
      </View>
      <Text style={[styles.statValue, isWideWeb && styles.statValueWide]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ─── Shared section header ────────────────────────────────────────────────────

function SectionHeader({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
}) {
  const isWideWeb = useIsWideWeb();
  return (
    <View style={styles.sectionHeaderBlock}>
      <View style={styles.eyebrowPill}>
        <Text style={styles.eyebrowText}>{eyebrow}</Text>
      </View>
      <Text style={[styles.sectionTitle, styles.textCenter, isWideWeb && styles.sectionTitleWide]}>
        {title}
      </Text>
      {subtitle ? (
        <Text style={[styles.sectionSubtitle, styles.textCenter]}>{subtitle}</Text>
      ) : null}
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
  const isWideWeb = useIsWideWeb();
  return (
    <View style={[styles.section, isWideWeb && styles.sectionWide]}>
      <Screen variant="wide">
        <SectionHeader
          eyebrow="SIMPLE & TRANSPARENT"
          title="How it works"
          subtitle="From finding a campaign to an M-Pesa receipt in under a minute."
        />
        <View style={[styles.stepsColumn, isWideWeb && styles.stepsRowWide]}>
          {HOW_IT_WORKS_STEPS.map((step) => (
            <StepCard key={step.number} {...step} />
          ))}
        </View>
      </Screen>
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
  const isWideWeb = useIsWideWeb();
  return (
    <View style={[styles.stepItem, isWideWeb && styles.stepItemWide]}>
      <View style={styles.stepNumberCircle}>
        <Text style={styles.stepNumberText}>{number}</Text>
      </View>
      <View style={[styles.stepContent, isWideWeb && styles.stepContentWide]}>
        <Text style={[styles.stepTitle, isWideWeb && styles.textCenter]}>{title}</Text>
        <Text style={[styles.stepDescription, isWideWeb && styles.textCenter]}>{description}</Text>
      </View>
    </View>
  );
}

// ─── Active campaigns preview ─────────────────────────────────────────────────

function ActiveCampaignsSection() {
  const router = useRouter();
  const isWideWeb = useIsWideWeb();
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
    <View style={[styles.campaignsBand, isWideWeb && styles.campaignsBandWide]}>
      <Screen variant="wide">
        {/* Section header */}
        <View style={styles.campaignsHeader}>
          <View style={styles.campaignsHeaderLeft}>
            <View style={styles.eyebrowPill}>
              <Text style={styles.eyebrowText}>LIVE RIGHT NOW</Text>
            </View>
            <Text style={[styles.sectionTitle, isWideWeb && styles.sectionTitleWide]}>
              Active campaigns
            </Text>
          </View>
          <TouchableOpacity
            style={styles.seeAllBtn}
            onPress={() => router.push('/campaigns')}
            accessibilityRole="button"
            accessibilityLabel="See all campaigns"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.seeAllLink}>See all</Text>
            <Ionicons name="arrow-forward" size={15} color={Colors.primary} />
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.campaignsCenter}>
            <ActivityIndicator size="large" color={Colors.primary} />
          </View>
        ) : error ? (
          <View style={styles.campaignsCenter}>
            <Ionicons name="cloud-offline-outline" size={28} color={Colors.textMuted} />
            <Text style={styles.campaignsError}>Couldn’t load campaigns right now.</Text>
          </View>
        ) : (
          <View style={isWideWeb && styles.campaignsGrid}>
            {campaigns.map((campaign) => (
              <View key={campaign.id} style={isWideWeb && styles.campaignsGridItem}>
                <CampaignCard
                  campaign={campaign}
                  onDonate={() => router.push(`/campaigns/${campaign.slug}`)}
                />
              </View>
            ))}
          </View>
        )}
      </Screen>
    </View>
  );
}

// ─── Trust section ────────────────────────────────────────────────────────────

const TRUST_POINTS: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  description: string;
}[] = [
  {
    icon: 'shield-checkmark-outline',
    title: 'Treasurer-approved payouts',
    description: 'Money leaves a campaign only after the church treasurer approves the payout request.',
  },
  {
    icon: 'receipt-outline',
    title: 'Every shilling on record',
    description: 'Donations and payouts are logged the moment they happen, so the books are always current.',
  },
  {
    icon: 'phone-portrait-outline',
    title: 'M-Pesa native, no app',
    description: 'Give from any Safaricom line. Enter your number, confirm the PIN prompt — done.',
  },
];

function TrustSection() {
  const isWideWeb = useIsWideWeb();
  return (
    <View style={[styles.section, isWideWeb && styles.sectionWide]}>
      <Screen variant="wide">
        <SectionHeader
          eyebrow="BUILT FOR ACCOUNTABILITY"
          title="Giving you can verify"
        />
        <View style={[styles.trustColumn, isWideWeb && styles.trustRowWide]}>
          {TRUST_POINTS.map((point) => (
            <View key={point.title} style={[styles.trustCard, isWideWeb && styles.trustCardWide]}>
              <View style={styles.trustIconSquircle}>
                <Ionicons name={point.icon} size={22} color={Colors.primary} />
              </View>
              <Text style={styles.trustTitle}>{point.title}</Text>
              <Text style={styles.trustDescription}>{point.description}</Text>
            </View>
          ))}
        </View>
      </Screen>
    </View>
  );
}

// ─── Register call-to-action band ─────────────────────────────────────────────

function RegisterBand() {
  const router = useRouter();
  const isWideWeb = useIsWideWeb();
  return (
    <View style={[styles.registerSection, isWideWeb && styles.registerSectionWide]}>
      <Screen variant="wide">
        <View style={[styles.registerCard, isWideWeb && styles.registerCardWide]}>
          <Text style={[styles.registerTitle, isWideWeb && styles.registerTitleWide]}>
            Raising funds for your church?
          </Text>
          <Text style={styles.registerSubtitle}>
            Create campaigns, receive M-Pesa donations, and manage payouts with a
            clean record. Free to start.
          </Text>
          <TouchableOpacity
            style={styles.registerButton}
            onPress={() => router.push('/register')}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Register your church"
          >
            <Text style={styles.registerButtonText}>Register Your Church</Text>
          </TouchableOpacity>
        </View>
      </Screen>
    </View>
  );
}

// ─── Footer ───────────────────────────────────────────────────────────────────

function FooterLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={styles.footerLink}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.footerLinkText}>{label}</Text>
    </TouchableOpacity>
  );
}

function Footer() {
  const router = useRouter();
  const isWideWeb = useIsWideWeb();
  return (
    <View style={styles.footer}>
      <Screen variant="wide">
        <View style={[styles.footerTop, isWideWeb && styles.footerTopWide]}>
          <View style={styles.footerBrandBlock}>
            <BrandLogo />
            <Text style={styles.footerTagline}>
              Kenya’s church crowdfunding platform.{'\n'}Every shilling on record.
            </Text>
          </View>
          <View style={[styles.footerLinks, isWideWeb && styles.footerLinksWide]}>
            <FooterLink label="Browse Campaigns" onPress={() => router.push('/campaigns')} />
            <FooterLink label="Browse Churches" onPress={() => router.push('/churches')} />
            <FooterLink label="Treasurer Portal" onPress={() => router.push('/treasurer')} />
            <FooterLink label="Sign In" onPress={() => router.push('/login')} />
            <FooterLink label="Register Your Church" onPress={() => router.push('/register')} />
          </View>
        </View>
        <View style={styles.footerDivider} />
        <Text style={styles.footerCopyright}>
          © 2026 Pamoja Hub · Donations move via M-Pesa STK push
        </Text>
      </Screen>
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
        showsVerticalScrollIndicator={false}
      >
        <HeroSection />
        <StatsBand />
        <HowItWorksSection />
        <ActiveCampaignsSection />
        <TrustSection />
        <RegisterBand />
        <Footer />
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
  textCenter: {
    textAlign: 'center',
  },

  // Nav
  nav: {
    backgroundColor: Colors.primary,
  },
  navInner: {
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
  },
  navRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  navLinks: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  navLink: {
    paddingHorizontal: Spacing.sm + 4,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navLinkText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: 'rgba(255,255,255,0.92)',
  },
  signInBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: Spacing.md,
    height: 38,
    borderRadius: BorderRadius.pill,
    backgroundColor: Colors.white,
  },
  signInBtnText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.primary,
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
    paddingTop: 44,
    paddingBottom: 92,
    overflow: 'hidden',
  },
  heroWide: {
    paddingTop: 76,
    paddingBottom: 116,
  },
  heroOrnamentA: {
    position: 'absolute',
    top: -110,
    right: -70,
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: 'rgba(255,255,255,0.055)',
  },
  heroOrnamentB: {
    position: 'absolute',
    bottom: -120,
    left: -90,
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: 'rgba(255,255,255,0.045)',
  },
  heroContent: {
    alignItems: 'center',
  },
  heroEyebrow: {
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginBottom: Spacing.lg,
  },
  heroEyebrowText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: 11,
    letterSpacing: 1.4,
    color: Colors.white,
  },
  heroHeadline: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.title,
    color: Colors.white,
    lineHeight: FontSize.title * 1.25,
    textAlign: 'center',
  },
  heroHeadlineWide: {
    fontSize: FontSize.display,
    lineHeight: FontSize.display * 1.2,
  },
  heroUnderline: {
    width: 64,
    height: 4,
    borderRadius: BorderRadius.pill,
    backgroundColor: Colors.accent,
    marginTop: Spacing.md + 2,
    marginBottom: Spacing.md + 2,
  },
  heroSubtext: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.base,
    color: 'rgba(255,255,255,0.88)',
    lineHeight: FontSize.base * 1.65,
    textAlign: 'center',
    maxWidth: 560,
    marginBottom: Spacing.xl,
  },
  ctaGroup: {
    alignSelf: 'stretch',
    gap: Spacing.sm + 4,
  },
  ctaGroupWide: {
    alignSelf: 'center',
    flexDirection: 'row',
    gap: Spacing.md,
  },
  ctaButton: {
    backgroundColor: Colors.accent,
    borderRadius: BorderRadius.pill,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaButtonWide: {
    paddingHorizontal: 36,
  },
  ctaButtonText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.white,
  },
  outlineButton: {
    backgroundColor: 'transparent',
    borderRadius: BorderRadius.pill,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.75)',
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outlineButtonText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.white,
  },

  // Stats — white card floating over the hero's bottom edge
  statsFloatWrap: {
    paddingHorizontal: Spacing.md,
    marginTop: -56,
    zIndex: 2,
  },
  statsCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    paddingVertical: Spacing.md + 2,
    paddingHorizontal: Spacing.md,
    ...Shadows.lg,
  },
  statsCardWide: {
    maxWidth: 760,
    width: '100%',
    alignSelf: 'center',
    paddingVertical: Spacing.lg,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statIconCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  statValue: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.primary,
    lineHeight: 24,
  },
  statValueWide: {
    fontSize: FontSize.xxl,
    lineHeight: 28,
  },
  statLabel: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    lineHeight: 16,
    textAlign: 'center',
  },
  statDivider: {
    width: 1,
    height: 56,
    backgroundColor: Colors.borderLight,
  },

  // Sections — shared rhythm
  section: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 44,
  },
  sectionWide: {
    paddingVertical: 68,
  },
  sectionHeaderBlock: {
    alignItems: 'center',
    marginBottom: Spacing.xl,
  },
  eyebrowPill: {
    alignSelf: 'center',
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginBottom: Spacing.sm + 4,
  },
  eyebrowText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: 11,
    letterSpacing: 1.4,
    color: Colors.primaryDark,
  },
  sectionTitle: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxxl,
    color: Colors.text,
    lineHeight: FontSize.xxxl * 1.3,
  },
  sectionTitleWide: {
    fontSize: FontSize.title,
    lineHeight: FontSize.title * 1.25,
  },
  sectionSubtitle: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    lineHeight: FontSize.base * 1.6,
    maxWidth: 560,
    marginTop: Spacing.sm,
  },

  // Steps
  stepsColumn: {
    gap: Spacing.lg,
  },
  stepsRowWide: {
    flexDirection: 'row',
    gap: Spacing.xl,
  },
  stepItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  stepItemWide: {
    flex: 1,
    flexDirection: 'column',
    alignItems: 'center',
  },
  stepNumberCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  stepNumberText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.primary,
    lineHeight: 24,
  },
  stepContent: {
    flex: 1,
    marginLeft: Spacing.md,
  },
  stepContentWide: {
    flex: 0,
    marginLeft: 0,
    marginTop: Spacing.md,
    alignItems: 'center',
  },
  stepTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
    lineHeight: 24,
    marginBottom: Spacing.xs,
  },
  stepDescription: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    lineHeight: FontSize.md * 1.55,
    maxWidth: 300,
  },

  // Campaigns band
  campaignsBand: {
    backgroundColor: Colors.surfaceSubtle,
    paddingHorizontal: Spacing.md,
    paddingVertical: 44,
  },
  campaignsBandWide: {
    paddingVertical: 68,
  },
  campaignsHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginBottom: Spacing.lg,
  },
  campaignsHeaderLeft: {
    flexShrink: 1,
  },
  campaignsCenter: {
    paddingVertical: 48,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
  },
  campaignsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.lg,
  },
  campaignsGridItem: {
    flexBasis: '31%',
    flexGrow: 1,
    maxWidth: '32%',
  },
  campaignsError: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textMuted,
  },
  seeAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingBottom: 2,
  },
  seeAllLink: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },

  // Trust
  trustColumn: {
    gap: Spacing.md,
  },
  trustRowWide: {
    flexDirection: 'row',
    gap: Spacing.lg,
  },
  trustCard: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    padding: Spacing.lg,
    ...Shadows.sm,
  },
  trustCardWide: {
    flex: 1,
  },
  trustIconSquircle: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  trustTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
    lineHeight: 24,
    marginBottom: Spacing.xs,
  },
  trustDescription: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    lineHeight: FontSize.md * 1.55,
  },

  // Register CTA band
  registerSection: {
    paddingHorizontal: Spacing.md,
    paddingTop: 4,
    paddingBottom: 44,
  },
  registerSectionWide: {
    paddingTop: 4,
    paddingBottom: 68,
  },
  registerCard: {
    backgroundColor: Colors.accentLight,
    borderRadius: BorderRadius.xl,
    paddingVertical: Spacing.xl,
    paddingHorizontal: Spacing.lg,
    alignItems: 'center',
  },
  registerCardWide: {
    paddingVertical: Spacing.xxl,
    paddingHorizontal: Spacing.xl,
  },
  registerTitle: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxl,
    color: Colors.text,
    lineHeight: FontSize.xxl * 1.3,
    textAlign: 'center',
  },
  registerTitleWide: {
    fontSize: FontSize.title,
    lineHeight: FontSize.title * 1.25,
  },
  registerSubtitle: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    lineHeight: FontSize.md * 1.6,
    textAlign: 'center',
    maxWidth: 480,
    marginTop: Spacing.sm,
    marginBottom: Spacing.lg,
  },
  registerButton: {
    backgroundColor: Colors.accent,
    borderRadius: BorderRadius.pill,
    height: 52,
    paddingHorizontal: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  registerButtonText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.white,
  },

  // Footer
  footer: {
    backgroundColor: Colors.primaryDark,
    paddingHorizontal: Spacing.md,
    paddingTop: 44,
    paddingBottom: Spacing.xl,
  },
  footerTop: {
    gap: Spacing.lg,
  },
  footerTopWide: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Spacing.xl,
  },
  footerBrandBlock: {
    gap: Spacing.md,
    alignItems: 'flex-start',
  },
  footerTagline: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: 'rgba(255,255,255,0.75)',
    lineHeight: FontSize.sm * 1.6,
  },
  footerLinks: {
    gap: 2,
  },
  footerLinksWide: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: Spacing.lg,
    alignItems: 'center',
  },
  footerLink: {
    height: 40,
    justifyContent: 'center',
  },
  footerLinkText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: 'rgba(255,255,255,0.92)',
  },
  footerDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.16)',
    marginVertical: Spacing.lg,
  },
  footerCopyright: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: 'rgba(255,255,255,0.6)',
  },

  // Nav dropdown menu
  menuBackdrop: {
    ...StyleSheet.absoluteFill,
  },
  menuDropdown: {
    position: 'absolute',
    right: Spacing.md,
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    width: 260,
    overflow: 'hidden',
    ...Shadows.lg,
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
    backgroundColor: Colors.borderLight,
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
