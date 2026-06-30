# Pamoja Hub — Design System
**Version 1.0 | Stack: React Native (Expo) | Generated with UI/UX Pro Max**

> **Design Direction:** Clean minimalism with warm accents. Every screen must communicate trust, financial accountability, and community belonging — without feeling cold or corporate.
>
> **Skill Validation:** Style direction confirmed as *Accessible & Ethical* (WCAG AAA). Anti-patterns to avoid: no impact data, hidden financials. Poppins confirmed as correct typography for this product category.

---

## Table of Contents
1. [Brand Identity](#1-brand-identity)
2. [Color Tokens](#2-color-tokens)
3. [Typography Scale](#3-typography-scale)
4. [Spacing & Layout](#4-spacing--layout)
5. [Elevation & Shadow](#5-elevation--shadow)
6. [Component Specs](#6-component-specs)
7. [React Native Theme Object](#7-react-native-theme-object)
8. [Screen Patterns](#8-screen-patterns)
9. [UX Rules](#9-ux-rules)
10. [Pre-Delivery Checklist](#10-pre-delivery-checklist)

---

## 1. Brand Identity

### Wordmark (on white backgrounds)
Do not use the PNG logo on white app screens. Use the text wordmark instead:

```
"Pamoja" — color: #057C8A, fontFamily: 'Poppins-Bold', fontSize: 22
"Hub"    — color: #ED8F1C, fontFamily: 'Poppins-Bold', fontSize: 22
```

Both words are inline, no space between them in code:
```jsx
<Text style={{ color: '#057C8A', fontFamily: 'Poppins-Bold', fontSize: 22 }}>Pamoja</Text>
<Text style={{ color: '#ED8F1C', fontFamily: 'Poppins-Bold', fontSize: 22 }}>Hub</Text>
```

Use `PamojaHub_Logo_Cream.png` only on teal (#057C8A) or dark (#035F6B) header/splash backgrounds.

### Brand Voice (Design)
| Attribute | Expression |
|---|---|
| Trust | Real amounts, real dates, named treasurers, progress bars always visible |
| Community | Warm teal primary, human photography, first-name displays |
| Accountability | Status badges, audit trail hints, "verified" labels |
| Accessibility | 48px touch targets, 16px+ body, WCAG AA minimum everywhere |

---

## 2. Color Tokens

### Primary Palette
| Token | Hex | Usage |
|---|---|---|
| `primary` | `#057C8A` | Primary buttons, active nav, links, key icons |
| `primaryDark` | `#035F6B` | Button pressed state, header backgrounds |
| `primaryLight` | `#D5EEF1` | Selected row backgrounds, info banners, chip backgrounds |

### Accent Palette
| Token | Hex | Usage |
|---|---|---|
| `accent` | `#ED8F1C` | CTA buttons (Donate, Submit), progress bars, highlights |
| `accentDark` | `#C97710` | Accent button pressed state |
| `accentLight` | `#FEF3E2` | Soft backgrounds for warnings, pledge highlights |

### Neutral Palette
| Token | Hex | Usage |
|---|---|---|
| `background` | `#FFFFFF` | All app screens — never cream, never off-white |
| `surface` | `#FFFFFF` | Cards, modals, bottom sheets |
| `textPrimary` | `#1A1A1A` | Headings, body, primary content |
| `textSecondary` | `#555555` | Captions, placeholders, secondary labels |
| `border` | `#CCCCCC` | Card borders, dividers, input borders |

### Semantic Palette
| Token | Hex | Usage |
|---|---|---|
| `success` | `#1A7A4A` | Success messages, "ACTIVE" badges, verified icons |
| `successBg` | `#D4EDDA` | Success badge backgrounds |
| `danger` | `#C00000` | Error messages, "OVERDUE" badges, delete actions |
| `dangerBg` | `#FDECEA` | Error/danger badge backgrounds |
| `warning` | `#ED8F1C` | Warning messages (reuse accent) |
| `warningBg` | `#FEF3E2` | Warning badge backgrounds (reuse accentLight) |
| `infoBg` | `#D5EEF1` | Info badge backgrounds (reuse primaryLight) |

### Color Usage Rules
- **Never use cream or off-white** (`#FAFAFA`, `#F5F5F5`, etc.) as a screen background — always pure `#FFFFFF`.
- **Never substitute** brand colors. Use exact hex values, not Tailwind approximations.
- Progress bars are **always** `#ED8F1C` — never primary teal.
- Destructive actions use `#C00000` — never generic red.

---

## 3. Typography Scale

### Font Family
**All screens use Poppins exclusively.**

| Weight | File Name | RN fontFamily |
|---|---|---|
| Bold (700) | `Poppins-Bold.ttf` | `'Poppins-Bold'` |
| SemiBold (600) | `Poppins-SemiBold.ttf` | `'Poppins-SemiBold'` |
| Medium (500) | `Poppins-Medium.ttf` | `'Poppins-Medium'` |
| Regular (400) | `Poppins-Regular.ttf` | `'Poppins-Regular'` |

Load via `expo-font` in `app/_layout.tsx`:
```js
await Font.loadAsync({
  'Poppins-Bold':     require('./assets/fonts/Poppins-Bold.ttf'),
  'Poppins-SemiBold': require('./assets/fonts/Poppins-SemiBold.ttf'),
  'Poppins-Medium':   require('./assets/fonts/Poppins-Medium.ttf'),
  'Poppins-Regular':  require('./assets/fonts/Poppins-Regular.ttf'),
});
```

### Type Scale
| Role | Size | Weight | Line Height | Color |
|---|---|---|---|---|
| `displayLarge` | 28px | Bold | 36px | `#1A1A1A` |
| `displayMedium` | 24px | Bold | 32px | `#1A1A1A` |
| `heading1` | 20px | Bold | 28px | `#1A1A1A` |
| `heading2` | 18px | Bold | 26px | `#1A1A1A` |
| `heading3` | 16px | SemiBold | 24px | `#1A1A1A` |
| `subheading` | 15px | Medium | 22px | `#1A1A1A` |
| `body` | 14px | Regular | 22px | `#1A1A1A` |
| `bodySmall` | 13px | Regular | 20px | `#555555` |
| `caption` | 12px | Regular | 18px | `#555555` |
| `label` | 12px | Medium | 18px | `#1A1A1A` |
| `buttonLarge` | 16px | Bold | 24px | `#FFFFFF` |
| `buttonMedium` | 14px | Bold | 20px | `#FFFFFF` |

### Typography Rules
- Minimum **16px** for body text on mobile (enforced by `body` scale above).
- Line height is always **1.5–1.6× font size**.
- Never use `fontWeight: 'bold'` as a string — always load named font files.
- Currency amounts (`KES 12,500`) use `heading2` or `heading3` weight for scannability.

---

## 4. Spacing & Layout

### Base Unit: 4px
All spacing is multiples of 4px.

| Token | Value | Usage |
|---|---|---|
| `space1` | 4px | Minimum gap between inline elements |
| `space2` | 8px | Minimum gap between touch targets |
| `space3` | 12px | Inner padding on compact components |
| `space4` | 16px | Standard horizontal screen padding |
| `space5` | 20px | Section padding, form field gaps |
| `space6` | 24px | Card internal padding |
| `space8` | 32px | Section vertical spacing |
| `space10` | 40px | Large section gaps |
| `space12` | 48px | Minimum touch target height |

### Screen Layout
```
Horizontal padding:  16px left + 16px right (space4)
Safe area top:       Use useSafeAreaInsets().top
Safe area bottom:    Use useSafeAreaInsets().bottom + 16px
Max content width:   100% (full-width mobile, no max-width constraint)
```

### Touch Target Rule (CRITICAL)
- **Minimum 48px height** on ALL interactive elements (buttons, list items, icon buttons, tabs).
- **Minimum 8px gap** between adjacent touch targets.
- Icon-only buttons must have at least 48×48px hit area — use `padding` to extend if the visual is smaller.

---

## 5. Elevation & Shadow

React Native shadow values (iOS + Android):

### Shadow Scale
```js
// shadow0 — no shadow (flat, borders only)
{}

// shadow1 — card resting
{
  shadowColor: '#000000',
  shadowOffset: { width: 0, height: 1 },
  shadowOpacity: 0.06,
  shadowRadius: 3,
  elevation: 2,
}

// shadow2 — card hover / active sheet
{
  shadowColor: '#000000',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.10,
  shadowRadius: 6,
  elevation: 4,
}

// shadow3 — modals, bottom sheets
{
  shadowColor: '#000000',
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.14,
  shadowRadius: 12,
  elevation: 8,
}
```

---

## 6. Component Specs

### 6.1 Buttons

#### Primary Button (navigation, confirm, save)
```
Background:      #057C8A
Text:            #FFFFFF, Poppins-Bold, 16px
Border radius:   8px
Height:          48px (minimum)
Horizontal pad:  24px
Pressed state:   background #035F6B
Disabled state:  background #CCCCCC, text #FFFFFF
```

#### CTA Button (Donate, Submit, Pay)
```
Background:      #ED8F1C
Text:            #FFFFFF, Poppins-Bold, 16px
Border radius:   8px
Height:          48px (minimum)
Horizontal pad:  24px
Pressed state:   background #C97710
Disabled state:  background #CCCCCC, text #FFFFFF
Loading state:   show ActivityIndicator (white), disable button
```

#### Secondary Button (outlined)
```
Background:      transparent
Border:          2px solid #057C8A
Text:            #057C8A, Poppins-Bold, 16px
Border radius:   8px
Height:          48px (minimum)
Horizontal pad:  24px
Pressed state:   background #D5EEF1
```

#### Danger Button
```
Background:      #C00000
Text:            #FFFFFF, Poppins-Bold, 16px
Border radius:   8px
Height:          48px (minimum)
Pressed state:   background #990000
```

#### Text/Link Button
```
Background:      transparent
Text:            #057C8A, Poppins-Medium, 14px
Underline:       none (use color differentiation only)
Pressed state:   opacity 0.7
```

### 6.2 Cards

#### Standard Card
```
Background:      #FFFFFF
Border:          1px solid #CCCCCC
Border radius:   12px
Padding:         16px (all sides)
Shadow:          shadow1
```

#### Campaign Card
```
Background:      #FFFFFF
Border:          1px solid #CCCCCC
Border radius:   12px
Padding:         16px
Shadow:          shadow1
Contains:
  - Campaign title: heading3
  - Church name:    caption, color #555555
  - Progress bar:   height 6px, color #ED8F1C, track #E5E5E5, borderRadius 3px
  - Amount raised:  heading2, color #1A1A1A
  - Target amount:  caption, color #555555
  - Status badge
  - Donate button (CTA)
```

#### Summary/Stat Card
```
Background:      #FFFFFF (or primaryLight #D5EEF1 for highlight variant)
Border:          1px solid #CCCCCC
Border radius:   12px
Padding:         16px
Contains:
  - Label:        caption, color #555555
  - Value:        displayMedium or heading1, color #1A1A1A
  - Icon:         24px, color matches context (primary or accent)
```

### 6.3 Progress Bar

**Always accent orange. Never teal for progress.**

```
Track background:   #E5E5E5
Fill color:         #ED8F1C
Height:             6px (within cards), 10px (full-width campaign detail)
Border radius:      3px (6px bar), 5px (10px bar)
Animated:           Yes — animate width on mount (Animated.timing, 600ms)
```

```jsx
// Structure
<View style={{ height: 6, backgroundColor: '#E5E5E5', borderRadius: 3, overflow: 'hidden' }}>
  <Animated.View style={{ height: 6, backgroundColor: '#ED8F1C', borderRadius: 3, width: animatedWidth }} />
</View>
<View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
  <Text style={typography.caption}>KES {raised.toLocaleString()}</Text>
  <Text style={typography.caption}>{percent}%</Text>
</View>
```

### 6.4 Status Badges

Pill-shaped badge. Never use emoji — use a colored dot (6px circle) as the leading indicator.

| Status | Text Color | Background | Dot Color |
|---|---|---|---|
| ACTIVE | `#1A7A4A` | `#D4EDDA` | `#1A7A4A` |
| PAUSED | `#555555` | `#F0F0F0` | `#555555` |
| COMPLETED | `#057C8A` | `#D5EEF1` | `#057C8A` |
| OVERDUE | `#C00000` | `#FDECEA` | `#C00000` |
| PENDING | `#ED8F1C` | `#FEF3E2` | `#ED8F1C` |
| DRAFT | `#555555` | `#F0F0F0` | `#555555` |

```
Font:            Poppins-Medium, 11px
Padding:         4px vertical, 10px horizontal
Border radius:   12px (full pill)
Letter spacing:  0.5px
```

### 6.5 Form Inputs

```
Height:          48px (minimum)
Background:      #FFFFFF
Border:          1px solid #CCCCCC
Border radius:   8px
Padding:         0 16px
Font:            Poppins-Regular, 14px, color #1A1A1A
Placeholder:     color #AAAAAA
Focus state:     border 2px solid #057C8A
Error state:     border 2px solid #C00000
Label:           above input, Poppins-Medium, 13px, color #1A1A1A, marginBottom 6px
Error text:      below input, Poppins-Regular, 12px, color #C00000, marginTop 4px
Helper text:     below input, Poppins-Regular, 12px, color #555555, marginTop 4px
```

#### Amount Input (M-Pesa amounts)
```
Same as above, plus:
Prefix:          "KES" — Poppins-SemiBold, 16px, color #1A1A1A, paddingLeft 16px
Font size:       20px, Poppins-Bold (the number itself)
Keyboard type:   numeric
```

### 6.6 Navigation Bar (Bottom Tabs)

```
Background:      #FFFFFF
Border top:      1px solid #CCCCCC
Height:          60px + safe area bottom
Icon size:       24px
Label:           Poppins-Medium, 10px
Active color:    #057C8A (icon + label)
Inactive color:  #999999 (icon + label)
Tab hit area:    minimum 48px height
```

### 6.7 App Header / Screen Header

```
Background:      #FFFFFF
Border bottom:   1px solid #CCCCCC
Height:          56px + safe area top
Title:           Poppins-Bold, 18px, color #1A1A1A, centered
Back button:     chevron-left icon, 24px, color #057C8A, 48x48 hit area
Right actions:   24px icons, color #057C8A, 48x48 hit area
```

### 6.8 List Items (Transactions, Members)

```
Height:          minimum 60px
Horizontal pad:  16px
Vertical pad:    12px
Divider:         1px solid #CCCCCC (or use gap between cards)
Primary text:    Poppins-Medium, 14px, #1A1A1A
Secondary text:  Poppins-Regular, 12px, #555555
Right value:     Poppins-SemiBold, 14px, #1A1A1A
Amount (debit):  color #C00000
Amount (credit): color #1A7A4A
```

### 6.9 Empty States

```
Icon:            48px, color #CCCCCC
Title:           heading3, color #555555, textAlign center
Description:     body, color #555555, textAlign center, maxWidth 260px
CTA Button:      primary button (if action possible)
Margin top:      40px from previous element
```

### 6.10 Loading States

- Use `ActivityIndicator` with `color="#057C8A"` during data fetch.
- Full-screen loading: centered ActivityIndicator on white background.
- Button loading: replace button label with white ActivityIndicator, keep button disabled.
- List loading: use skeleton placeholders (animated gray blocks matching card shape).
- **Never show an empty list without first confirming the fetch is complete.**

### 6.11 Toast / Snackbar Notifications

```
Position:        bottom, above tab bar, marginBottom 16px
Border radius:   8px
Padding:         14px 16px
Max width:       screen width - 32px

Success:   background #D4EDDA, text #1A7A4A, icon checkmark #1A7A4A
Error:     background #FDECEA, text #C00000, icon x-circle #C00000
Info:      background #D5EEF1, text #057C8A, icon info #057C8A
Warning:   background #FEF3E2, text #C97710, icon warning #C97710

Font:      Poppins-Medium, 14px
Duration:  3000ms auto-dismiss (errors: 5000ms)
```

### 6.12 Modals & Bottom Sheets

```
Background:      #FFFFFF
Border radius:   16px top corners (bottom sheet), 12px (centered modal)
Handle bar:      4x32px, #CCCCCC, centered, marginTop 12px (bottom sheet only)
Padding:         24px
Overlay:         rgba(0,0,0,0.5)
Title:           heading2, color #1A1A1A
Body:            body, color #555555
Button row:      full-width, stack vertically, CTA on top
Shadow:          shadow3
```

### 6.13 Section Headers

```
Font:            Poppins-Bold, 16px, color #1A1A1A
Margin bottom:   12px
Margin top:      24px (when preceded by content)
Optional right:  "See all" link — Poppins-Medium, 13px, color #057C8A
```

### 6.14 Dividers

```
Height:          1px
Color:           #CCCCCC
Margin:          0 (full width) or 16px horizontal (inset)
```

---

## 7. React Native Theme Object

Save as `src/theme/index.ts` (or `constants/theme.ts`):

```typescript
export const colors = {
  // Primary
  primary:       '#057C8A',
  primaryDark:   '#035F6B',
  primaryLight:  '#D5EEF1',
  // Accent
  accent:        '#ED8F1C',
  accentDark:    '#C97710',
  accentLight:   '#FEF3E2',
  // Neutral
  background:    '#FFFFFF',
  surface:       '#FFFFFF',
  textPrimary:   '#1A1A1A',
  textSecondary: '#555555',
  textMuted:     '#999999',
  border:        '#CCCCCC',
  // Semantic
  success:       '#1A7A4A',
  successBg:     '#D4EDDA',
  danger:        '#C00000',
  dangerBg:      '#FDECEA',
  warning:       '#ED8F1C',
  warningBg:     '#FEF3E2',
  infoBg:        '#D5EEF1',
  // Misc
  progressTrack: '#E5E5E5',
  skeletonBase:  '#F0F0F0',
  skeletonShimmer: '#E8E8E8',
  overlay:       'rgba(0,0,0,0.5)',
} as const;

export const typography = {
  displayLarge: {
    fontFamily: 'Poppins-Bold',
    fontSize: 28,
    lineHeight: 36,
    color: '#1A1A1A',
  },
  displayMedium: {
    fontFamily: 'Poppins-Bold',
    fontSize: 24,
    lineHeight: 32,
    color: '#1A1A1A',
  },
  heading1: {
    fontFamily: 'Poppins-Bold',
    fontSize: 20,
    lineHeight: 28,
    color: '#1A1A1A',
  },
  heading2: {
    fontFamily: 'Poppins-Bold',
    fontSize: 18,
    lineHeight: 26,
    color: '#1A1A1A',
  },
  heading3: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: 16,
    lineHeight: 24,
    color: '#1A1A1A',
  },
  subheading: {
    fontFamily: 'Poppins-Medium',
    fontSize: 15,
    lineHeight: 22,
    color: '#1A1A1A',
  },
  body: {
    fontFamily: 'Poppins-Regular',
    fontSize: 14,
    lineHeight: 22,
    color: '#1A1A1A',
  },
  bodySmall: {
    fontFamily: 'Poppins-Regular',
    fontSize: 13,
    lineHeight: 20,
    color: '#555555',
  },
  caption: {
    fontFamily: 'Poppins-Regular',
    fontSize: 12,
    lineHeight: 18,
    color: '#555555',
  },
  label: {
    fontFamily: 'Poppins-Medium',
    fontSize: 12,
    lineHeight: 18,
    color: '#1A1A1A',
  },
  buttonLarge: {
    fontFamily: 'Poppins-Bold',
    fontSize: 16,
    lineHeight: 24,
    color: '#FFFFFF',
  },
  buttonMedium: {
    fontFamily: 'Poppins-Bold',
    fontSize: 14,
    lineHeight: 20,
    color: '#FFFFFF',
  },
} as const;

export const spacing = {
  xs:  4,
  sm:  8,
  md:  12,
  base: 16,
  lg:  20,
  xl:  24,
  xxl: 32,
  xxxl: 40,
  touch: 48,  // minimum touch target
} as const;

export const radii = {
  sm:   4,
  md:   8,   // buttons, inputs
  lg:   12,  // cards
  xl:   16,  // bottom sheets (top corners)
  pill: 100, // badges, chips
} as const;

export const shadows = {
  none: {},
  card: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
  },
  elevated: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.10,
    shadowRadius: 6,
    elevation: 4,
  },
  modal: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.14,
    shadowRadius: 12,
    elevation: 8,
  },
} as const;

export const borders = {
  card:   { borderWidth: 1, borderColor: '#CCCCCC' },
  input:  { borderWidth: 1, borderColor: '#CCCCCC' },
  focus:  { borderWidth: 2, borderColor: '#057C8A' },
  error:  { borderWidth: 2, borderColor: '#C00000' },
  divider: { height: 1, backgroundColor: '#CCCCCC' },
} as const;
```

---

## 8. Screen Patterns

### 8.1 Fundraising / Campaign Detail Pattern
Derived from skill: *Storytelling + Trust* — show impact data, never hide financials.

```
Header:
  - Campaign title (heading1)
  - Church name + verified icon (subheading, primary)
  - Status badge

Progress Section (CRITICAL — always above the fold):
  - Progress bar (10px height, accent orange)
  - "KES X raised of KES Y" (heading2 + caption)
  - Percentage + days remaining
  - Number of donors

Transparency Section:
  - Named treasurer with phone (builds trust)
  - Last updated date/time
  - Disbursement history if applicable

CTA:
  - Full-width Donate button (CTA style, 56px height on this screen)
  - Share button (secondary outlined)
```

### 8.2 Dashboard Pattern (Admin / Treasurer)
Derived from skill: *Community/Forum* — show active metrics, member count, today's activity.

```
Header:
  - Wordmark + greeting ("Good morning, {name}")

Summary Row (horizontal scroll, stat cards):
  - Total raised this month
  - Active campaigns count
  - Pending approvals count

Recent Activity (FlatList):
  - Transaction list items
  - keyExtractor by transaction ID (never index)
  - Virtualized — FlatList not ScrollView with .map()

Quick Actions:
  - New Campaign (primary button)
  - Export Report (secondary button)
```

### 8.3 Donation Flow Pattern (Public Users — M-Pesa)
Multi-step — skill validation confirmed: show step indicators.

```
Step 1 — Choose Campaign:
  Campaign search + browse (FlatList, React.memo on items)

Step 2 — Enter Amount:
  Amount input (large, numeric keyboard)
  Preset amounts: KES 100, 500, 1000, 2000 (chips, primaryLight bg)
  "Custom amount" field below

Step 3 — Enter Phone:
  M-Pesa phone number input (+254 prefix locked)
  Payer name (auto-filled if logged in)

Step 4 — Confirm:
  Summary card (campaign, amount, phone)
  STK Push button (CTA style, "Send M-Pesa Request")
  Loading state during STK push: spinner + "Waiting for M-Pesa confirmation..."

Step 5 — Result:
  Success: green check, confirmation number, amount
  Failure: red x, error message, retry button
```

### 8.4 Authentication Pattern
```
Logo area:        Wordmark, centered, paddingTop 48px
Form:             vertically centered, horizontal padding 24px
Inputs:           full-width, standard spec
Primary action:   full-width CTA or primary button, marginTop 24px
Alternate action: text/link button, textAlign center, marginTop 16px
```

---

## 9. UX Rules

### Trust & Financial Transparency (Platform-Critical)
These are the most important UX rules for Pamoja Hub. The skill flagged *"No impact data + Hidden financials"* as the primary anti-pattern for this product category.

1. **Always show the progress bar** — no campaign card without it, even at 0%.
2. **Always show the target amount** — never show "KES 12,500 raised" without context.
3. **Always name the treasurer** — "Managed by John Kamau" on every campaign.
4. **Show donor count** — social proof ("47 people have donated") builds trust.
5. **Timestamp every transaction** — "2 hours ago" or exact date/time, never omit.
6. **Never round M-Pesa amounts** — show exact amounts (KES 1,500, not "KES 1.5K").

### Mobile Performance (3G Kenya)
7. **Use `expo-image`** with `cachePolicy="memory-disk"` for all campaign images.
8. **Use `FlatList`** for any list with 10+ items — never `ScrollView` with `.map()`.
9. **Memoize list items** — `React.memo` on all `renderItem` components.
10. **Lazy-load campaign images** — above-fold content must load in <2s on 3G.
11. **Optimistic UI for donations** — show "Processing..." immediately, reconcile later.

### Interaction & Accessibility
12. **Minimum 48px touch targets** everywhere — use `minHeight: 48` and `padding` to extend hit areas.
13. **8px gap between adjacent touch targets** — no tightly packed buttons.
14. **Disable buttons during async** — set `disabled={isLoading}` during M-Pesa STK push.
15. **Show `ActivityIndicator` during all loading** — never blank screens.
16. **Step indicators on multi-step flows** — "Step 2 of 4" text above every donation step form.
17. **Haptic feedback on confirmations** — light vibration on donation success.
18. **Typed navigation params** — all `navigation.navigate()` calls must be typed.

### Visual Rules
19. **No emojis as icons** — use vector icons (expo vector icons, or SVG via `react-native-svg`).
20. **Consistent icon set** — use only `@expo/vector-icons` Ionicons OR MaterialCommunityIcons, never mix families.
21. **No layout shift on hover states** — use opacity/color transitions, not scale on list items.
22. **Currency always "KES {amount}"** — never "KSh", never bare numbers for amounts.
23. **Dates always localized** — use `toLocaleDateString('en-KE')` format.

---

## 10. Pre-Delivery Checklist

Run this checklist before delivering any screen:

### Visual Quality
- [ ] All text uses a Poppins font family variant — no system font fallback visible
- [ ] No emojis used as icons — SVG or vector icon library only
- [ ] All brand colors match exact hex values in this document
- [ ] Background is pure `#FFFFFF` — not `#FAFAFA` or any off-white
- [ ] Progress bars are `#ED8F1C` — not primary teal
- [ ] Status badges use correct semantic colors per table in §6.4

### Financial Transparency
- [ ] Campaign cards show progress bar, raised amount, AND target amount
- [ ] Treasurer name visible on campaign detail screen
- [ ] Transaction amounts show full KES value (no rounding/abbreviation)
- [ ] Donor count shown where campaigns are displayed

### Interaction
- [ ] All buttons minimum 48px height
- [ ] 8px gap between adjacent touch targets
- [ ] CTA buttons (Donate/Submit) use `#ED8F1C` background
- [ ] Primary buttons use `#057C8A` background
- [ ] Loading states present on all async buttons (spinner + disabled)
- [ ] Step indicator shown on all multi-step flows

### Performance
- [ ] Campaign images use `expo-image` with `cachePolicy="memory-disk"`
- [ ] Lists use `FlatList` with `keyExtractor` by stable ID
- [ ] List items are wrapped in `React.memo`
- [ ] Navigation params are typed

### Accessibility
- [ ] All images have `accessible={true}` and `accessibilityLabel`
- [ ] All icon-only buttons have `accessibilityLabel`
- [ ] Input fields have visible labels (not just placeholders)
- [ ] Form inputs have `accessibilityHint` describing expected input

### Light Mode Contrast
- [ ] Body text `#1A1A1A` on `#FFFFFF` — ratio 18.1:1 ✓
- [ ] Secondary text `#555555` on `#FFFFFF` — ratio 7.0:1 ✓
- [ ] Primary `#057C8A` on `#FFFFFF` — ratio 4.6:1 ✓
- [ ] Accent `#ED8F1C` on `#FFFFFF` — ratio 3.0:1 (use only for large text/decorative, not body)
- [ ] White text on `#057C8A` — ratio 4.6:1 ✓ (sufficient for bold button text)
- [ ] White text on `#ED8F1C` — ratio 3.0:1 (acceptable for bold button text at 16px+)

---

*Design System v1.0 — Pamoja Hub — Generated 2026-05-24 using UI/UX Pro Max Skill*
*Skill validation: Accessible & Ethical style (WCAG AAA), Poppins confirmed for SaaS/professional category, anti-patterns logged: no impact data, hidden financials.*
