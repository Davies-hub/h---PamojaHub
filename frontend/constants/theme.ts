// Pamoja Hub design tokens — import from here, never hardcode colors or sizes

export const Colors = {
  // Brand — sampled from PamojaHub_Logo_Cream.png
  primary:       '#057C8A',
  primaryDark:   '#035F6B',
  primaryLight:  '#D5EEF1',
  accent:        '#ED8F1C',
  accentDark:    '#C97710',
  accentLight:   '#FEF3E2',

  // App screen neutrals
  text:           '#1A1A1A',
  textSecondary:  '#555555',
  textMuted:      '#888888',
  border:         '#CCCCCC',
  background:     '#FFFFFF',  // All app screens — always white, never cream
  grey:           '#F2F2F2',
  white:          '#FFFFFF',

  // Semantic
  success:        '#1A7A4A',
  successLight:   '#D4EDDA',
  danger:         '#C00000',
  dangerLight:    '#FDECEA',
  warning:        '#C97710',
  warningLight:   '#FEF3E2',

  // Progress / skeleton
  progressTrack:  '#E5E5E5',

  // Extended tints — surfaces that couldn't use the above tokens
  primaryLightest: '#F7FCFC',  // Lightest teal tint — unread notification backgrounds
  gradientStart:   '#F0FAFB',  // Hero card gradient start — light teal
  gradientEnd:     '#FEF8F0',  // Hero card gradient end — light warm

  // Neutral tints (ui-redesign) — brand palette above is LOCKED and unchanged
  borderLight:    '#E4E9EA',  // hairline strokes on white cards (softer than border)
  surfaceSubtle:  '#F6F9F9',  // cool full-bleed section bands behind card groups
  shadowInk:      '#053B42',  // shadow base color — deep teal-ink, never pure black
};

export const Spacing = {
  xs:    4,
  sm:    8,
  md:    16,
  lg:    24,
  xl:    32,
  xxl:   48,
  touch: 48,  // minimum touch target height
};

export const FontSize = {
  xs:    12,
  sm:    13,
  md:    14,
  base:  15,
  lg:    16,
  xl:    18,
  xxl:   20,
  xxxl:  22,
  title: 28,
  display: 40,  // marketing hero headlines on wide web only
};

export const BorderRadius = {
  sm:   4,
  md:   8,
  lg:   12,
  xl:   16,
  pill: 999,
};

// Soft layered shadows (iOS/web: shadow*, Android: elevation). Use on white
// surfaces, usually paired with a Colors.borderLight hairline stroke.
export const Shadows = {
  sm: {
    shadowColor: Colors.shadowInk,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 1,
  },
  md: {
    shadowColor: Colors.shadowInk,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 14,
    elevation: 3,
  },
  lg: {
    shadowColor: Colors.shadowInk,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.12,
    shadowRadius: 28,
    elevation: 7,
  },
};
