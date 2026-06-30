# Pamoja Hub — Build Guide
**Version 1.0 | May 2026**
*Read this file in full before writing a single line of code.*

---

> **⚠ STATUS BANNER (updated 2026-06-26): this guide is the original build spec, not a live tracker.**
> The build is far past it. **Phase 1 (frontend)** ✅ complete; **Phase 2 (backend)** ✅ complete (**422 tests**, live count); **Phase 3 (DB hardening)** 🟡 partial (dev only — prod `REVOKE` pending); **Phase 4 (connect FE↔BE)** ✅ functionally complete (all reads + all writes wired — campaign-create + auth password-reset were closed 2026-06-26; only a cosmetic mock greeting + the dead `listForCampaign` remain). For the **live state** read `CLAUDE.md` → `PamojaHub_Compressed_v2.md` §0/§18 → `HANDOFF.md` → the persistent memory index. Keep this file as the historical step-by-step record.

---

## How to Use This File

This file is the instruction set for building Pamoja Hub. It is written for use with Claude Code (VS Code extension) and assumes the PRD v5.0 FINAL is also loaded as context.

**Rules before every coding session:**
1. Upload both this file and the PRD to the Claude Code context
2. Tell Claude which step you are on
3. Do not skip steps — each step creates the foundation the next step depends on
4. After each step, run the verification command listed at the end of that step before moving on
5. If something breaks, fix it before proceeding — never build on top of broken code

**Build order is non-negotiable:**
Frontend (UI shells with mock data) → Backend (API + logic) → Database (indexes + constraints) → Connect (wire frontend to backend)

This order means you can see and interact with the UI early, which helps you spot design problems before the backend is built. The backend is then built to exactly match what the frontend expects.

---

## Prerequisites & Tools

Install these before starting. Verify each one works.

```bash
# Verify Node.js (need v18+)
node --version

# Verify Python (need 3.11+)
python --version

# Verify PostgreSQL (need 14+)
psql --version

# Verify Expo CLI
npx expo --version

# Verify ngrok (create free account at ngrok.com)
ngrok --version

# Install global tools
npm install -g docx
pip install --break-system-packages django djangorestframework
```

**Accounts to create before starting:**
- [ ] Africa's Talking account (africastalking.com) — get sandbox API key
- [ ] Resend account (resend.com) — get API key, verify a sender email
- [ ] Safaricom Daraja account (developer.safaricom.co.ke) — get sandbox credentials
- [ ] GitHub account — for repository (set up before first commit)

---

## Repository Structure

Create two folders inside one project root. Keep them separate — do not mix frontend and backend code.

```
pamoja-hub/
├── frontend/          ← React Native Expo project
├── backend/           ← Django project
├── .gitignore         ← Created first, before anything else
└── README.md
```

**Create .gitignore first — before any other file:**

```gitignore
# Environment files — NEVER commit these
.env
.env.local
.env.production
*.env

# Python
__pycache__/
*.pyc
*.pyo
.venv/
venv/
dist/
*.egg-info/

# Node
node_modules/
.expo/
dist/
web-build/

# OS
.DS_Store
Thumbs.db

# IDE
.vscode/settings.json
.idea/

# Database
*.sqlite3
```

**Verify .gitignore works before first commit:**
```bash
git init
git check-ignore -v .env
# Must return a result. If it returns nothing, .env is NOT ignored. Fix before proceeding.
```

---

## Phase 1: Frontend (React Native Expo)

### Step 1.1 — Initialize Expo Project

```bash
cd pamoja-hub
npx create-expo-app frontend --template blank-typescript
cd frontend
```

**Install all frontend dependencies at once:**
```bash
npx expo install expo-router expo-constants expo-linking expo-status-bar expo-image-picker expo-document-picker expo-file-system expo-sharing react-native-safe-area-context react-native-screens react-native-gesture-handler react-native-reanimated
npm install @react-navigation/native axios react-native-paper react-hook-form @hookform/resolvers zod react-native-toast-message react-native-modal dayjs
```

**Verification:** `npx expo start` — press `w`. A blank page loads in the browser.

---

### Step 1.2 — Folder Structure

Create this exact folder structure inside `/frontend/`:

```
frontend/
├── app/                        ← Expo Router screens (file-based routing)
│   ├── (public)/               ← No auth required
│   │   ├── index.tsx           ← Home/Landing
│   │   ├── campaigns/
│   │   │   ├── index.tsx       ← Browse Campaigns
│   │   │   └── [slug].tsx      ← Campaign Public Page
│   │   ├── churches/
│   │   │   ├── index.tsx       ← Browse Churches
│   │   │   └── [id].tsx        ← Church Public Profile
│   │   └── treasurer/
│   │       └── index.tsx       ← Campaign Treasurer Portal
│   ├── (auth)/                 ← Auth screens
│   │   ├── login.tsx
│   │   ├── register.tsx
│   │   └── reset-password.tsx
│   ├── (treasurer)/            ← Church Treasurer dashboard (authenticated)
│   │   ├── _layout.tsx         ← Dashboard layout with sidebar
│   │   ├── index.tsx           ← Overview
│   │   ├── campaigns/
│   │   │   ├── index.tsx       ← Campaigns list
│   │   │   ├── new.tsx         ← Create campaign
│   │   │   └── [slug].tsx      ← Campaign detail
│   │   ├── groups.tsx          ← Group Labels panel
│   │   ├── disbursements.tsx   ← Disbursements panel
│   │   ├── reports.tsx         ← Reports panel
│   │   ├── notifications.tsx   ← Notifications page
│   │   └── settings.tsx        ← Church settings
│   ├── (super)/                ← Super Admin portal (authenticated)
│   │   ├── _layout.tsx
│   │   ├── index.tsx           ← Overview/Queue
│   │   ├── churches.tsx
│   │   ├── campaigns.tsx
│   │   ├── donations.tsx
│   │   ├── withdrawals.tsx
│   │   ├── analytics.tsx
│   │   ├── billing.tsx
│   │   └── audit-log.tsx
│   └── _layout.tsx             ← Root layout
├── components/
│   ├── ui/                     ← Atomic UI components
│   │   ├── Button.tsx
│   │   ├── Input.tsx
│   │   ├── Badge.tsx
│   │   ├── Card.tsx
│   │   ├── Modal.tsx
│   │   ├── ProgressBar.tsx
│   │   ├── Spinner.tsx
│   │   └── Toast.tsx
│   ├── campaign/
│   │   ├── CampaignCard.tsx
│   │   ├── DonationForm.tsx
│   │   ├── CampaignCreationForm.tsx
│   │   └── WhatsAppShareButton.tsx
│   ├── layout/
│   │   ├── TreasurerSidebar.tsx
│   │   ├── SuperAdminSidebar.tsx
│   │   ├── TopNav.tsx
│   │   └── NotificationBell.tsx
│   └── disbursement/
│       ├── DisbursementRequestForm.tsx
│       └── DisbursementApprovalDialog.tsx
├── services/
│   ├── api.ts                  ← Axios instance + base config
│   ├── auth.service.ts
│   ├── campaigns.service.ts
│   ├── donations.service.ts
│   ├── withdrawals.service.ts
│   ├── notifications.service.ts
│   ├── groups.service.ts
│   └── treasurer-portal.service.ts
├── stores/
│   ├── auth.store.ts           ← Auth state (user, token, role)
│   └── notifications.store.ts  ← Notification count + list
├── mock/
│   ├── campaigns.mock.ts
│   ├── churches.mock.ts
│   ├── donations.mock.ts
│   └── notifications.mock.ts
├── types/
│   └── index.ts                ← All TypeScript interfaces
├── constants/
│   └── theme.ts                ← Colors, spacing, fonts
└── utils/
    ├── formatters.ts           ← KES formatting, date formatting
    └── validators.ts           ← Phone number, amount validators
```

**Verification:** All folders exist. `npx expo start` still works.

---

### Step 1.3 — Theme & Design Tokens

Create `/frontend/constants/theme.ts` **first**. Every component imports from here — never hardcode colors or sizes.

**Logo asset decision (final):**
- `PamojaHub_Logo_Cream.png` — canonical brand asset. Use on: splash screen, email headers, marketing materials, any surface with a warm cream background.
- `PamojaHub_Logo_White.png` — use only where a white background is mandatory (browser favicon source, some email clients). Not preferred.
- App screens (dashboard, campaign pages, donation form) use **white backgrounds** — cream is a brand-only surface, never an app screen color.
- Never place the cream-background logo directly on a white app screen. Use the white-background logo version, or crop to the icon (teal circle only) at small sizes like app icon and favicon.

```typescript
export const Colors = {
  // ── Brand colors — sampled directly from PamojaHub_Logo_Cream.png ──
  primary: '#057C8A',        // Teal — nav bars, headings, primary buttons, "Pamoja" wordmark
  primaryDark: '#035F6B',    // Darker teal — hover/pressed states
  primaryLight: '#D5EEF1',   // Light teal — card backgrounds, badge fills, highlights
  accent: '#ED8F1C',         // Orange — CTAs, "Hub" wordmark, progress bars, accent icons
  accentDark: '#C97710',     // Darker orange — hover on orange elements
  accentLight: '#FEF3E2',    // Light orange — notification backgrounds, accent surfaces

  // ── App screen neutrals ──
  text: '#1A1A1A',
  textSecondary: '#555555',
  border: '#CCCCCC',
  background: '#FFFFFF',     // All app screens — always white, never cream
  grey: '#F2F2F2',
  white: '#FFFFFF',

  // ── Semantic ──
  success: '#1A7A4A',
  successLight: '#D4EDDA',
  danger: '#C00000',
  dangerLight: '#FFEAEA',
  warning: '#856404',
  warningLight: '#FFF3CD',
};

export const Spacing = {
  xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48,
};

export const FontSize = {
  xs: 12, sm: 14, md: 16, lg: 18, xl: 22, xxl: 28, title: 36,
};

export const BorderRadius = {
  sm: 4, md: 8, lg: 12, xl: 20, full: 999,
};
```

---

### Step 1.4 — TypeScript Interfaces

Create `/frontend/types/index.ts`. Define all types here before building any screen. Every service and component imports from here.

```typescript
// Auth
export type UserRole = 'SUPER_ADMIN' | 'CHURCH_TREASURER';

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  churchId?: string;
  churchName?: string;
}

// Church
export type ChurchStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED';
export type SubscriptionTier = 'FREE' | 'GROWTH' | 'PARISH';

export interface Church {
  id: string;
  name: string;
  officialEmail: string;
  phone: string;
  address: string;
  county: string;
  denomination: string;
  logoUrl?: string;
  description?: string;
  status: ChurchStatus;
  subscriptionTier: SubscriptionTier;
  subscriptionExpiresAt?: string;
  createdAt: string;
}

// Group Labels
export interface GroupLabel {
  id: string;
  churchId: string;
  parentLabelId?: string;
  name: string;
  isArchived: boolean;
  activeCampaignCount: number;
  createdAt: string;
}

// Campaigns
export type CampaignStatus = 'ACTIVE' | 'PAUSED' | 'CLOSED';
export type CampaignCategory = 'Building' | 'Outreach' | 'Youth' | 'Education' | 'Medical' | 'Relief' | 'Other';

export interface Campaign {
  id: string;
  slug: string;
  churchId: string;
  churchName: string;
  groupLabelId?: string;
  groupLabelName?: string;
  title: string;
  description: string;
  goalAmount: number;
  raisedAmount: number;
  walletBalance: number;       // Only in admin serializer
  status: CampaignStatus;
  bannerImageUrl: string;
  documentUrl?: string;
  category: CampaignCategory;
  treasurerPhone?: string;     // Only in admin serializer — NEVER public
  treasurerName?: string;      // Only in admin serializer — NEVER public
  createdAt: string;
  closedAt?: string;
}

// Public campaign (no wallet, no treasurer fields)
export interface PublicCampaign {
  id: string;
  slug: string;
  churchName: string;
  groupLabelName?: string;
  title: string;
  description: string;
  goalAmount: number;
  raisedAmount: number;
  donorCount: number;
  status: CampaignStatus;
  bannerImageUrl: string;
  documentUrl?: string;
  category: CampaignCategory;
  createdAt: string;
}

// Donations
export type DonationStatus = 'PENDING' | 'SUCCESSFUL' | 'FAILED';

export interface Donation {
  id: string;
  campaignId: string;
  campaignTitle: string;
  phoneNumber: string;
  donorName?: string;
  donorEmail?: string;
  amount: number;
  platformFee: number;
  netAmount: number;
  status: DonationStatus;
  mpesaReceiptNumber?: string;
  createdAt: string;
  confirmedAt?: string;
}

// Withdrawals
export type WithdrawalStatus = 'PENDING_APPROVAL' | 'PROCESSING' | 'PAID' | 'FAILED' | 'FAILED_FINAL' | 'REJECTED';

export interface Withdrawal {
  id: string;
  campaignId: string;
  campaignTitle: string;
  requestedByPhone: string;
  approvedBy?: string;
  amount: number;
  destinationPhone: string;
  destinationName: string;
  reason: string;
  rejectionReason?: string;
  status: WithdrawalStatus;
  payoutReference?: string;
  failureReason?: string;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}

// Notifications
export type NotificationType =
  | 'DONATION_RECEIVED'
  | 'DISBURSEMENT_SUBMITTED'
  | 'DISBURSEMENT_APPROVED'
  | 'DISBURSEMENT_REJECTED'
  | 'DISBURSEMENT_PAID'
  | 'DISBURSEMENT_FAILED'
  | 'SUBSCRIPTION_REMINDER'
  | 'SUBSCRIPTION_LAPSED';

export interface Notification {
  id: string;
  notificationType: NotificationType;
  title: string;
  message: string;
  relatedCampaignId?: string;
  relatedWithdrawalId?: string;
  isRead: boolean;
  createdAt: string;
}

// Campaign Treasurer Portal
export interface PortalCampaign {
  id: string;
  title: string;
  churchName: string;
  status: CampaignStatus;
  raisedAmount: number;
  walletBalance: number;
}

export interface PortalDonation {
  mpesaReceiptNumber: string;
  donorName?: string;
  amount: number;
  createdAt: string;
}

// API responses
export interface PaginatedResponse<T> {
  count: number;
  next?: string;
  previous?: string;
  results: T[];
}

export interface ApiError {
  detail?: string;
  [field: string]: string | string[] | undefined;
}
```

---

### Step 1.5 — Mock Data

Create mock data in `/frontend/mock/` before building any screens. Screens use this data until the backend is ready.

**`/frontend/mock/campaigns.mock.ts`**
```typescript
import { PublicCampaign, Campaign } from '../types';

export const mockPublicCampaigns: PublicCampaign[] = [
  {
    id: '1', slug: 'district-5-desks-fund',
    churchName: 'PCEA Bahati Martyrs', groupLabelName: 'District 5',
    title: 'District 5 Classroom Desks Fund', description: '<p>We are raising funds to purchase 40 new classroom desks for our district school.</p>',
    goalAmount: 80000, raisedAmount: 52000, donorCount: 34,
    status: 'ACTIVE', bannerImageUrl: 'https://picsum.photos/seed/desks/800/400',
    category: 'Education', createdAt: '2026-04-01T10:00:00Z',
  },
  {
    id: '2', slug: 'womens-guild-hall',
    churchName: 'PCEA Bahati Martyrs', groupLabelName: "Women's Guild",
    title: "Women's Guild Meeting Hall Roof", description: '<p>The roof of our meeting hall needs urgent repair before the long rains.</p>',
    goalAmount: 150000, raisedAmount: 98000, donorCount: 71,
    status: 'ACTIVE', bannerImageUrl: 'https://picsum.photos/seed/roof/800/400',
    category: 'Building', createdAt: '2026-03-15T08:00:00Z',
  },
];

export const mockAdminCampaign: Campaign = {
  ...mockPublicCampaigns[0],
  churchId: 'church-1',
  walletBalance: 52000,
  treasurerPhone: '0712345678',
  treasurerName: 'Mwangi Joseph',
};
```

Create similar mock files for churches, donations, and notifications following the same pattern.

---

### Step 1.6 — API Service Layer (Stubs)

Create `/frontend/services/api.ts` — the Axios base instance. During Phase 1, all service methods return mock data. In Phase 4, replace mock returns with real Axios calls.

```typescript
import axios from 'axios';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8000/api/v1';

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

// Add auth token to every request
api.interceptors.request.use((config) => {
  const token = getStoredAccessToken(); // implement with SecureStore
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Handle 401 — refresh token or redirect to login
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      // attempt token refresh, then retry, else redirect to login
    }
    return Promise.reject(error);
  }
);
```

Create stub implementations for each service file. Example `/frontend/services/campaigns.service.ts`:

```typescript
import { mockPublicCampaigns } from '../mock/campaigns.mock';
import { PublicCampaign, PaginatedResponse } from '../types';

// STUB — replace with real API call in Phase 4
export const campaignsService = {
  async browse(params?: { search?: string; category?: string; county?: string; page?: number }):
    Promise<PaginatedResponse<PublicCampaign>> {
    // Phase 1: return mock data
    return { count: mockPublicCampaigns.length, results: mockPublicCampaigns };
    // Phase 4: return (await api.get('/campaigns/', { params })).data;
  },

  async getBySlug(slug: string): Promise<PublicCampaign> {
    return mockPublicCampaigns.find(c => c.slug === slug)!;
    // Phase 4: return (await api.get(`/campaigns/${slug}/`)).data;
  },
};
```

Repeat this pattern for all service files. Keep the Phase 4 commented line in place — you will uncomment it in Phase 4.

---

### Step 1.7 — Auth Store

Create `/frontend/stores/auth.store.ts` using React Context (no external library needed):

```typescript
import React, { createContext, useContext, useState, useEffect } from 'react';
import { AuthUser } from '../types';

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // On mount: check for stored token
  useEffect(() => {
    // Load from SecureStore in Phase 4
    setIsLoading(false);
  }, []);

  const login = async (email: string, password: string) => {
    // Phase 1: mock login
    // Phase 4: call authService.login(), store tokens
  };

  const logout = () => {
    setUser(null);
    setAccessToken(null);
    // Phase 4: call authService.logout(), clear SecureStore
  };

  return (
    <AuthContext.Provider value={{ user, accessToken, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
};
```

---

### Step 1.8 — Build Public Screens

Build each screen with mock data. Do not connect to the backend yet. Build in this order:

**1. Home/Landing Page** (`/app/(public)/index.tsx`)
- Hero section: logo placeholder, tagline "A Paybill collects money. Pamoja Hub proves where it went.", two CTAs: "Browse Campaigns" and "Register Your Church"
- "How It Works" section: 3 steps with icons
- Platform stats strip: total raised, active campaigns, churches (use hardcoded numbers for now)
- Top navigation: logo left, "Browse Campaigns", "Browse Churches", "Register Your Church", "Treasurer Portal" links right

**2. Browse Campaigns** (`/app/(public)/campaigns/index.tsx`)
- Grid of CampaignCard components from mock data
- Search bar (filter mock data client-side for now)
- Category filter dropdown
- County filter dropdown
- Pagination controls (mock: show all)

**3. Campaign Public Page** (`/app/(public)/campaigns/[slug].tsx`)
- Full-width banner image
- Breadcrumb: Church Name > Group Label
- ProgressBar component showing raised/goal/percentage/donor count
- Campaign description (render HTML with a WebView or dangerouslySetInnerHTML for web)
- WhatsApp share button
- Donation form (see below)
- Campaign updates list

**DonationForm component** (`/components/campaign/DonationForm.tsx`)
- Fields: M-Pesa phone (required), Amount in KES (required, min 5), Donor name (optional), Email (optional)
- Validate phone client-side: must match 07xx or 01xx Safaricom format
- "Donate" button: on press, disable button, show "Sending request..." spinner
- Mock result: after 2 second delay, show success state with fake receipt number
- Success state: green box, "Thank you! M-Pesa Receipt: QHE7FG123Z"
- Failure state: red box, "Payment not completed. Please try again." + Retry button

**4. Browse Churches** (`/app/(public)/churches/index.tsx`)
- List of church cards: name, county, denomination, active campaign count

**5. Church Public Profile** (`/app/(public)/churches/[id].tsx`)
- Church name, logo placeholder, description, county, denomination
- Grid of active campaigns for that church

**Verification:** All 5 public screens render without errors. Navigation between them works. Donation form mock flow works.

---

### Step 1.9 — Build Campaign Treasurer Portal

**`/app/(public)/treasurer/index.tsx`**

This screen has three states. Render one state at a time controlled by local state:

**State 1: Phone Entry**
```
Title: "Campaign Treasurer Portal"
Subtitle: "Enter your registered M-Pesa number to access your campaign reports"
Input: Phone number (M-Pesa format)
Button: "Send OTP"
On press: validate phone format → switch to State 2 (mock: always succeeds)
```

**State 2: OTP Entry**
```
Title: "Enter OTP"
Subtitle: "A 6-digit code was sent to [phone]"
Input: 6-digit OTP (numeric keyboard)
Button: "Verify"
Link: "Resend OTP" (disabled for 60 seconds after send)
On verify: mock success → if one campaign found go to State 3 directly, if multiple go to campaign picker
```

**State 3a: Campaign Picker** (when multiple campaigns found)
```
Title: "Select Campaign"
List of campaign cards with: title, church name, wallet balance
On select: go to State 3b
```

**State 3b: Campaign Scoped View**
```
Header: Campaign title + status badge
Stats row: Total Raised [KES xx], Wallet Balance [KES xx]
Section: Donation Report
  - Table: Receipt Code | Donor Name | Amount | Date
  - Date range filter (from/to)
  - "Download Report" button (mock: show toast "Report downloading...")
Section: Disbursement Request
  - Amount field (KES, max = wallet balance)
  - Reason field (text, required)
  - "Submit Request" button → confirmation modal
  - On confirm: mock success, show "Request submitted. Your church treasurer will review it."
Section: Pending Requests
  - List of submitted requests with status badges
```

**Verification:** All three states render. Flow from phone entry → OTP → campaign view works with mock data.

---

### Step 1.10 — Build Auth Screens

**`/app/(auth)/login.tsx`**
- Email + password fields
- "Sign In" button
- "Forgot password?" link
- Mock login: any email/password combination succeeds, sets mock user with role CHURCH_TREASURER, redirects to /(treasurer)/

**`/app/(auth)/register.tsx`**
- Fields: Church name, Official email, Phone, Physical address, County (dropdown of all 47 Kenya counties), Denomination
- "Register Church" button
- Mock: show success message "Application submitted. We will review and contact you within 2 business days."

**`/app/(auth)/reset-password.tsx`**
- Step 1: email input → "Send OTP"
- Step 2: OTP input + new password + confirm password → "Reset Password"
- Mock: always succeeds

**Verification:** Login mock works and redirects to treasurer dashboard. Register form submits.

---

### Step 1.11 — Build Church Treasurer Dashboard

**Layout** (`/app/(treasurer)/_layout.tsx`)
- Sidebar navigation (collapsible on mobile):
  - Overview
  - Campaigns
  - Group Labels
  - Disbursements
  - Reports
  - Notifications (with unread badge)
  - Settings
- Top bar: church name, notification bell, avatar/logout
- Main content area renders child routes

**Overview Panel** (`/app/(treasurer)/index.tsx`)
- Stats row: Total Raised | Total Disbursed | Current Balance | Active Campaigns
- Pending disbursements alert (red badge if > 0)
- Live donation feed: last 10 donations, auto-refresh every 20s (mock: static list)

**Group Labels Panel** (`/app/(treasurer)/groups.tsx`)
- List of group labels: name, type badge (flat/hierarchical), active campaign count
- "Add Group" button → inline form: name, type toggle
- Rename inline on click
- Archive button (greyed if has active campaigns)
- Hierarchical groups: expandable to show sub-labels

**Campaigns Panel** (`/app/(treasurer)/campaigns/index.tsx`)
- Table columns: Thumbnail | Title | Group Label | Status | Goal | Raised | Balance | % | Share | Edit | Actions
- "New Campaign" button → `/campaigns/new`
- Filter bar: search title, filter by group, filter by status
- Share button: opens WhatsApp deep link directly
- Pause/Resume/Close action buttons per row
- Clicking title: navigates to campaign detail

**Campaign Creation Form** (`/app/(treasurer)/campaigns/new.tsx`)
- All fields from PRD Section 8.5.4
- Campaign Treasurer Phone and Name fields: clearly labelled with helper text explaining dual purpose
- Banner image upload (mock: just show file picker, store locally for now)
- Rich text editor for description (use a simple markdown input or basic HTML editor)
- "Save Campaign" button
- On success: redirect to Campaign Creation Success Screen showing: campaign URL, large WhatsApp share button, Copy Link button

**Disbursements Panel** (`/app/(treasurer)/disbursements.tsx`)
- Table: Campaign | Amount | Requested By (phone masked) | Status | Date | Actions
- PENDING_APPROVAL rows: Approve button + Reject button
- Approve action: open ApprovalDialog component
  - Show: campaign name, amount, destination phone (full, not masked), destination name
  - Warning text: "Verify the destination number carefully. This action sends money immediately."
  - Confirm button (primary) + Cancel button
- Reject action: open modal with required reason text input
- FAILED rows: "Retry Payout" button → opens form allowing phone number correction

**Reports Panel** (`/app/(treasurer)/reports.tsx`)
- Report type selector: Campaign Summary | Donation History | Disbursement History | Audit Log
- Date range picker
- Group label filter
- Format selector: CSV | PDF
- "Download Report" button (mock: show toast)

**Notifications Panel** (`/app/(treasurer)/notifications.tsx`)
- List of all notifications, newest first
- Each item: type icon, title, message, relative timestamp, read/unread indicator
- Click to mark as read
- "Mark all as read" button

**Notification Bell** (`/components/layout/NotificationBell.tsx`)
- Bell icon with red badge showing unread count
- Dropdown showing last 5 notifications on click
- "View All" link → notifications page
- Poll /notifications/unread-count/ every 20 seconds (mock: static count of 3)

**Verification:** All dashboard screens render. Mock data displays. Approval dialog shows correctly with destination phone prominent.

---

### Step 1.12 — Build Super Admin Portal

**Layout** (`/app/(super)/_layout.tsx`)
- Sidebar: Registration Queue (with badge for pending count) | Churches | Campaigns | Donations | Withdrawals | Paybill Monitor | Analytics | Billing | Audit Log
- Super Admin can only reach this layout if role == SUPER_ADMIN

**Registration Queue** (`/app/(super)/index.tsx`)
- List of pending church applications
- Each row: church name, email, county, denomination, submitted date, Approve + Reject buttons
- Approve: confirmation dialog
- Reject: required reason input

**Churches** (`/app/(super)/churches.tsx`)
- Full table: name, status badge, tier, expiry, campaigns count, total raised, fees earned
- Status actions: Suspend | Reactivate per row

**Donations** (`/app/(super)/donations.tsx`)
- Platform-wide donation table: church, campaign, donor, gross, fee, net, receipt, date
- Filters: church, campaign, date range, status

**Withdrawals** (`/app/(super)/withdrawals.tsx`)
- Platform-wide withdrawal table
- FAILED_FINAL rows highlighted in red with "Force Retry" button

**Billing Settings** (`/app/(super)/billing.tsx`)
- Current fee rate display + edit field
- Subscription tier prices (Growth, Parish) + edit fields
- Save button

**Verification:** Super Admin portal renders. Mock data shows in all tables.

---

### Step 1.13 — Shared Components Checklist

Before moving to Phase 2, verify these components exist and work:

- [ ] `Button.tsx` — variants: primary, secondary, danger, ghost. States: default, loading, disabled
- [ ] `Input.tsx` — label, value, error message, helper text, numeric keyboard type prop
- [ ] `Badge.tsx` — status badges with appropriate colors for each status enum
- [ ] `ProgressBar.tsx` — raised/goal with percentage label
- [ ] `CampaignCard.tsx` — used on Browse Campaigns, church profile
- [ ] `WhatsAppShareButton.tsx` — takes campaign slug, builds wa.me URL, opens natively
- [ ] `Modal.tsx` — reusable modal with title, content, confirm/cancel buttons
- [ ] `Spinner.tsx` — loading indicator
- [ ] `NotificationBell.tsx` — with badge and dropdown

---

### Phase 1 Complete Checklist

Before starting Phase 2, every item here must be true:

- [ ] All public screens render with mock data
- [ ] Campaign Treasurer portal 3-state flow works
- [ ] Church Treasurer dashboard all panels render
- [ ] Approval dialog shows full destination phone prominently
- [ ] Super Admin portal all screens render
- [ ] Auth screens (login, register, reset) render
- [ ] Navigation between all screens works
- [ ] TypeScript shows no errors: `npx tsc --noEmit`
- [ ] No hardcoded colors or spacing — all from theme.ts
- [ ] No sensitive fields (treasurer_phone) shown on any public screen

---

## Phase 2: Backend (Django)

### Step 2.1 — Initialize Django Project

```bash
cd pamoja-hub/backend

# Create virtual environment
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# Install all backend dependencies at once
pip install django djangorestframework djangorestframework-simplejwt django-cors-headers django-environ django-ratelimit psycopg2-binary pillow bleach requests celery django-celery-beat redis africastalking resend python-decouple

# Save dependencies
pip freeze > requirements.txt

# Create Django project
django-admin startproject config .
```

**Verification:** `python manage.py check` — no errors.

---

### Step 2.2 — Django Apps Structure

Create these apps. One app per domain area.

```bash
python manage.py startapp accounts      # User model, auth, JWT
python manage.py startapp churches      # Church model, registration
python manage.py startapp campaigns     # Campaign, GroupLabel, CampaignUpdate
python manage.py startapp donations     # Donation, Daraja STK Push
python manage.py startapp withdrawals   # Withdrawal, Daraja B2C
python manage.py startapp notifications # Notification model + events
python manage.py startapp treasurer_portal  # OTP flow, portal access
python manage.py startapp audit         # AuditLog model
python manage.py startapp superadmin    # Super Admin views
```

Final backend folder structure:
```
backend/
├── config/
│   ├── settings/
│   │   ├── __init__.py
│   │   ├── base.py        ← Shared settings
│   │   ├── development.py ← Dev overrides
│   │   └── production.py  ← Prod overrides
│   ├── urls.py
│   ├── wsgi.py
│   └── asgi.py
├── accounts/
├── churches/
├── campaigns/
├── donations/
├── withdrawals/
├── notifications/
├── treasurer_portal/
├── audit/
├── superadmin/
├── common/
│   ├── permissions.py     ← ChurchScopedPermission + other shared permissions
│   ├── validators.py      ← Phone number validator, amount validator
│   ├── pagination.py      ← Standard pagination class
│   └── exceptions.py      ← Custom exception handler
├── integrations/
│   ├── daraja.py          ← Daraja API client
│   ├── africastalking.py  ← Africa's Talking SMS client
│   └── resend_email.py    ← Resend email client
├── manage.py
├── requirements.txt
└── .env.example
```

---

### Step 2.3 — Settings Configuration

Split settings into base/development/production. Create `config/settings/base.py`:

```python
import os
from pathlib import Path
import environ

BASE_DIR = Path(__file__).resolve().parent.parent.parent
env = environ.Env()
environ.Env.read_env(BASE_DIR / '.env')

SECRET_KEY = env('SECRET_KEY')
DEBUG = env.bool('DEBUG', default=False)

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    # Third party
    'rest_framework',
    'rest_framework_simplejwt',
    'corsheaders',
    # Internal apps
    'accounts',
    'churches',
    'campaigns',
    'donations',
    'withdrawals',
    'notifications',
    'treasurer_portal',
    'audit',
    'superadmin',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'corsheaders.middleware.CorsMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

AUTH_USER_MODEL = 'accounts.User'

REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.IsAuthenticated',
    ],
    'DEFAULT_PAGINATION_CLASS': 'common.pagination.StandardPagination',
    'PAGE_SIZE': 20,
    'EXCEPTION_HANDLER': 'common.exceptions.custom_exception_handler',
}

from datetime import timedelta
SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(minutes=60),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=7),
    'ROTATE_REFRESH_TOKENS': True,
    'BLACKLIST_AFTER_ROTATION': True,
}

DATABASES = {
    'default': env.db('DATABASE_URL', default='postgresql://localhost/pamoja_dev')
}

# M-Pesa / Daraja
MPESA_CONSUMER_KEY = env('MPESA_CONSUMER_KEY')
MPESA_CONSUMER_SECRET = env('MPESA_CONSUMER_SECRET')
MPESA_SHORTCODE = env('MPESA_SHORTCODE')
MPESA_PASSKEY = env('MPESA_PASSKEY')
MPESA_CALLBACK_URL = env('MPESA_CALLBACK_URL')
MPESA_ENVIRONMENT = env('MPESA_ENVIRONMENT', default='sandbox')
MPESA_B2C_INITIATOR_NAME = env('MPESA_B2C_INITIATOR_NAME')
MPESA_B2C_SECURITY_CREDENTIAL = env('MPESA_B2C_SECURITY_CREDENTIAL')
MPESA_B2C_QUEUE_URL = env('MPESA_B2C_QUEUE_URL')
MPESA_B2C_RESULT_URL = env('MPESA_B2C_RESULT_URL')
MPESA_FLOAT_ALERT_THRESHOLD = env.int('MPESA_FLOAT_ALERT_THRESHOLD', default=50000)

# Africa's Talking
AT_API_KEY = env('AT_API_KEY')
AT_USERNAME = env('AT_USERNAME')

# Resend
RESEND_API_KEY = env('RESEND_API_KEY')
RESEND_FROM_EMAIL = env('RESEND_FROM_EMAIL')

# Frontend
FRONTEND_URL = env('FRONTEND_URL')
PLATFORM_FEE_PERCENT = env.float('PLATFORM_FEE_PERCENT', default=2.5)
```

**Startup validation** — add to `config/settings/base.py`:

```python
def validate_env():
    required = [
        'SECRET_KEY', 'DATABASE_URL', 'MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET',
        'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_CALLBACK_URL',
        'MPESA_B2C_INITIATOR_NAME', 'MPESA_B2C_SECURITY_CREDENTIAL',
        'MPESA_B2C_QUEUE_URL', 'MPESA_B2C_RESULT_URL',
        'AT_API_KEY', 'AT_USERNAME', 'RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'FRONTEND_URL',
    ]
    missing = [v for v in required if not os.environ.get(v)]
    if missing:
        from django.core.exceptions import ImproperlyConfigured
        raise ImproperlyConfigured(f"Missing required environment variables: {', '.join(missing)}")

    if os.environ.get('MPESA_ENVIRONMENT') == 'production':
        if os.environ.get('DEBUG', 'False') == 'True':
            from django.core.exceptions import ImproperlyConfigured
            raise ImproperlyConfigured("DEBUG must be False in production.")
        callback = os.environ.get('MPESA_CALLBACK_URL', '')
        result = os.environ.get('MPESA_B2C_RESULT_URL', '')
        if 'ngrok' in callback or 'ngrok' in result:
            from django.core.exceptions import ImproperlyConfigured
            raise ImproperlyConfigured("ngrok URLs cannot be used in production.")

validate_env()
```

---

### Step 2.4 — Build Models (in dependency order)

Build models in this exact order. Each model depends on the ones before it.

**Order:**
1. `audit.AuditLog` (no dependencies)
2. `accounts.User` (no FK to other app models)
3. `churches.Church` (no dependencies)
4. `accounts.RefreshToken` (FK to User)
5. `campaigns.GroupLabel` (FK to Church)
6. `campaigns.Campaign` (FK to Church, GroupLabel, User)
7. `campaigns.CampaignUpdate` (FK to Campaign, User)
8. `donations.Donation` (FK to Campaign)
9. `withdrawals.Withdrawal` (FK to Campaign, User)
10. `notifications.Notification` (FK to User, Campaign, Withdrawal)
11. `treasurer_portal.CampaignTreasurerOTP` (no FK — phone-based)
12. `treasurer_portal.PortalToken` (FK to CampaignTreasurerOTP)

**Key model notes:**

`audit/models.py`:
```python
import uuid
from django.db import models

class AuditLog(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    actor = models.ForeignKey('accounts.User', null=True, blank=True, on_delete=models.SET_NULL, related_name='audit_logs')
    actor_phone = models.CharField(max_length=20, null=True, blank=True)  # For Campaign Treasurer actions
    action = models.CharField(max_length=100)
    entity_type = models.CharField(max_length=50)
    entity_id = models.UUIDField()
    details = models.JSONField(default=dict)
    ip_address = models.CharField(max_length=45, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def save(self, *args, **kwargs):
        if self.pk:  # Block any update
            raise ValueError("AuditLog records are immutable and cannot be updated.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValueError("AuditLog records cannot be deleted.")
```

`accounts/models.py`:
```python
import uuid
from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models

class UserRole(models.TextChoices):
    SUPER_ADMIN = 'SUPER_ADMIN', 'Super Admin'
    CHURCH_TREASURER = 'CHURCH_TREASURER', 'Church Treasurer'

class UserManager(BaseUserManager):
    def create_user(self, email, password=None, **extra_fields):
        email = self.normalize_email(email)
        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save()
        return user

    def create_superuser(self, email, password, **extra_fields):
        extra_fields['role'] = UserRole.SUPER_ADMIN
        return self.create_user(email, password, **extra_fields)

class User(AbstractBaseUser, PermissionsMixin):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(unique=True)
    first_name = models.CharField(max_length=100)
    last_name = models.CharField(max_length=100)
    phone = models.CharField(max_length=20, blank=True)
    role = models.CharField(max_length=20, choices=UserRole.choices)
    church = models.ForeignKey('churches.Church', null=True, blank=True, on_delete=models.SET_NULL)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    USERNAME_FIELD = 'email'
    REQUIRED_FIELDS = ['first_name', 'last_name', 'role']
    objects = UserManager()

class RefreshToken(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='refresh_tokens')
    token_hash = models.CharField(max_length=64, unique=True)  # SHA-256 of the actual token
    is_revoked = models.BooleanField(default=False)
    ip_address = models.CharField(max_length=45, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
```

Write all remaining models following the field definitions in PRD Section 9. Each model file should be complete before running migrations.

**Run migrations after all models are written:**
```bash
python manage.py makemigrations
python manage.py migrate
```

**Verification:** `python manage.py migrate` completes with no errors. `python manage.py shell` → `from accounts.models import User; User.objects.count()` returns 0.

---

### Step 2.5 — Build Serializers

For each model, create two serializers where applicable: one public (minimal fields) and one admin (full fields).

**Critical serializer rules:**
1. `PublicCampaignSerializer` MUST NOT include `treasurer_phone`, `treasurer_name`, `wallet_balance`, `platform_fee` details
2. `AdminCampaignSerializer` includes all fields — used only on authenticated Church Treasurer endpoints
3. HTML sanitization happens in the serializer's `validate_description()` method — not in the view

Example pattern for Campaign:
```python
# campaigns/serializers.py
import bleach
from rest_framework import serializers
from .models import Campaign

ALLOWED_TAGS = ['p', 'b', 'i', 'strong', 'em', 'ul', 'ol', 'li', 'a', 'h2', 'h3', 'br']
ALLOWED_ATTRS = {'a': ['href']}
ALLOWED_PROTOCOLS = ['http', 'https']

class PublicCampaignSerializer(serializers.ModelSerializer):
    church_name = serializers.CharField(source='church.name', read_only=True)
    group_label_name = serializers.CharField(source='group_label.name', read_only=True, allow_null=True)
    donor_count = serializers.SerializerMethodField()

    def get_donor_count(self, obj):
        return obj.donations.filter(status='SUCCESSFUL').count()

    class Meta:
        model = Campaign
        fields = [
            'id', 'slug', 'church_name', 'group_label_name', 'title', 'description',
            'goal_amount', 'raised_amount', 'donor_count', 'status', 'banner_image_url',
            'document_url', 'category', 'created_at',
        ]
        # NEVER include: treasurer_phone, treasurer_name, wallet_balance

class AdminCampaignSerializer(serializers.ModelSerializer):
    church_name = serializers.CharField(source='church.name', read_only=True)
    group_label_name = serializers.CharField(source='group_label.name', read_only=True, allow_null=True)

    def validate_description(self, value):
        return bleach.clean(value, tags=ALLOWED_TAGS, attributes=ALLOWED_ATTRS,
                           protocols=ALLOWED_PROTOCOLS, strip=True)

    def validate_treasurer_phone(self, value):
        from common.validators import validate_safaricom_phone
        return validate_safaricom_phone(value)

    class Meta:
        model = Campaign
        fields = '__all__'  # All fields visible to authenticated treasurer
```

---

### Step 2.6 — Build Common Utilities

**`common/permissions.py`**:
```python
from rest_framework.permissions import BasePermission

class IsChurchTreasurer(BasePermission):
    def has_permission(self, request, view):
        return request.user.is_authenticated and request.user.role == 'CHURCH_TREASURER'

class IsSuperAdmin(BasePermission):
    def has_permission(self, request, view):
        return request.user.is_authenticated and request.user.role == 'SUPER_ADMIN'

class ChurchScopedPermission(BasePermission):
    """Verifies object belongs to request.user.church. Apply to all church-scoped object views."""
    def has_object_permission(self, request, view, obj):
        church = getattr(obj, 'church', None) or getattr(getattr(obj, 'campaign', None), 'church', None)
        return church == request.user.church
```

**`common/validators.py`**:
```python
import re
from rest_framework.exceptions import ValidationError

SAFARICOM_PATTERN = re.compile(
    r'^(?:254|\+254|0)'
    r'(?:7(?:[0-2][0-9]|[4][0-3]|[4][5]|[4][8]|[5][7-9]|[6][8-9]|[9][0-9])'
    r'|1(?:[0][0-9]|[1][0-9]))\d{6}$'
)

def validate_safaricom_phone(value: str) -> str:
    """Validates and normalizes to 254XXXXXXXXX format."""
    clean = value.strip().replace(' ', '').replace('-', '')
    if not SAFARICOM_PATTERN.match(clean):
        raise ValidationError("Only Safaricom M-Pesa numbers are accepted (07xx or 01xx format).")
    # Normalize to 254XXXXXXXXX
    if clean.startswith('0'):
        clean = '254' + clean[1:]
    elif clean.startswith('+'):
        clean = clean[1:]
    return clean

def validate_positive_amount(value):
    if value <= 0:
        raise ValidationError("Amount must be greater than zero.")
    if value < 5:
        raise ValidationError("Minimum donation amount is KES 5.")
    return value
```

---

### Step 2.7 — Build Authentication Endpoints

Build in this order within the `accounts` app:

1. `POST /api/v1/auth/register/` — create Church record (PENDING) + User (CHURCH_TREASURER role). No email invite needed — church is PENDING until Super Admin approves.
2. `POST /api/v1/auth/login/` — validate email/password, return JWT access + refresh tokens. Store refresh token in RefreshToken table.
3. `POST /api/v1/auth/token/refresh/` — validate refresh token against RefreshToken table (check is_revoked), return new access token.
4. `POST /api/v1/auth/logout/` — revoke refresh token (set is_revoked = True in RefreshToken table).
5. `POST /api/v1/auth/password-reset/request/` — rate limited. Send OTP via Resend email.
6. `POST /api/v1/auth/password-reset/confirm/` — verify OTP, set new password, revoke all refresh tokens for user, send Resend confirmation email.

**Verification:** Use Postman or curl to:
- Register a church → get 201
- Login → get access + refresh tokens
- Call a protected endpoint with the access token → get 200
- Call a protected endpoint without a token → get 401

---

### Step 2.8 — Build Campaign Treasurer Portal Endpoints

This is the most unique part of the backend. Build it carefully.

**`POST /api/v1/treasurer/request-otp/`** (no auth required):
```python
# Rate limited: 3/10min per phone, 3/10min per IP
# 1. Validate phone is Safaricom format
# 2. Find all campaigns where treasurer_phone == phone AND status in [ACTIVE, PAUSED]
# 3. If none found: return 404 "No campaigns found for this number"
# 4. Generate 6-digit OTP
# 5. Hash OTP with SHA-256, store in CampaignTreasurerOTP with campaign_ids list and expires_at = now + 10min
# 6. Send plaintext OTP via Africa's Talking SMS
# 7. Return 200 {"message": "OTP sent", "campaign_count": N}
# NEVER return the OTP in the response
```

**`POST /api/v1/treasurer/verify-otp/`** (no auth required):
```python
# Rate limited: 5 attempts per phone before 1-hour lockout
# 1. Find CampaignTreasurerOTP by phone_number where is_used=False and expires_at > now
# 2. Hash submitted OTP and compare to stored hash
# 3. On mismatch: increment failure count, lock if >= 5, return 400
# 4. On match: mark is_used=True, create PortalToken (bound to request IP, expires 30min)
# 5. Return 200 {"portal_token": "...", "campaigns": [...campaign list...]}
```

**`GET /api/v1/treasurer/campaigns/{id}/report/`** (portal token auth):
```python
# 1. Validate portal token: exists, not expired, IP matches request IP, campaign in token scope
# 2. If campaign_id not in portal token's campaign_ids: return 403
# 3. Return paginated donations for this campaign (status=SUCCESSFUL)
# Fields: mpesa_receipt_number, donor_name, amount, created_at
# Supports ?from=&to= date range, ?format=csv|pdf
```

**`POST /api/v1/treasurer/campaigns/{id}/request-disbursement/`** (portal token auth):
```python
# 1. Validate portal token + campaign scope
# 2. Check no existing PENDING_APPROVAL or PROCESSING withdrawal for this campaign
# 3. Use SELECT FOR UPDATE on Campaign to lock row
# 4. Validate amount <= campaign.wallet_balance
# 5. Create Withdrawal: requested_by_phone = phone from token, destination_phone = campaign.treasurer_phone
# 6. Create Notification for Church Treasurer
# 7. Write AuditLog entry (actor=None, actor_phone=phone)
# 8. Return 201
```

---

### Step 2.9 — Build All Remaining API Endpoints

Build endpoint groups in this order. Each group maps to one app.

**Order:**
1. `churches/` — public list, church profile, me (dashboard), me/stats
2. `campaigns/` — public browse, create, detail, edit, pause, resume, close, updates, donations, share
3. `group-labels/` — CRUD, archive, unarchive
4. `donations/` — initiate (STK Push), callback (Daraja webhook), status poll
5. `withdrawals/` — list, approve, reject, retry
6. `notifications/` — list, unread-count, read, read-all
7. `super/` — all Super Admin endpoints

For each endpoint group, build in this sequence:
1. URL pattern in app's `urls.py`
2. Serializer
3. Permission class
4. View (use APIView for complex logic, ModelViewSet for simple CRUD)
5. Manual test with curl/Postman

**Critical endpoint: `POST /api/v1/withdrawals/{id}/approve/`**
```python
# This endpoint moves money. Every check is mandatory.
# 1. Verify request.user.role == CHURCH_TREASURER
# 2. Verify withdrawal.campaign.church == request.user.church  ← CRITICAL CHECK
# 3. Verify withdrawal.status == PENDING_APPROVAL
# 4. Use SELECT FOR UPDATE on Campaign, verify withdrawal.amount <= campaign.wallet_balance
# 5. Set withdrawal.status = PROCESSING
# 6. Save withdrawal
# 7. Call Daraja B2C (see Step 2.11)
# 8. Write AuditLog entry
# 9. Create notifications
# 10. Return 200
```

---

### Step 2.10 — Build Daraja Integration

Create `integrations/daraja.py`. This is the most critical integration. Build and test each method separately in the Daraja sandbox before wiring to views.

**Methods to implement:**
```python
class DarajaClient:
    def get_access_token(self) -> str: ...
    def stk_push(self, phone: str, amount: int, campaign_slug: str) -> dict: ...
    def b2c_payout(self, phone: str, amount: int, withdrawal_id: str) -> dict: ...
    def check_transaction_status(self, conversation_id: str) -> dict: ...
    def get_account_balance(self) -> dict: ...
```

**STK Push callback handler** (`POST /api/v1/donations/callback/`):
```python
# This endpoint is called by Safaricom, not by the frontend.
# 1. Extract CheckoutRequestID from callback body
# 2. Verify idempotency: if Donation with this CheckoutRequestID already has status SUCCESSFUL or FAILED → return HTTP 200 immediately
# 3. Read ResultCode from callback
# 4. SUCCESS (ResultCode == 0):
#    a. Set donation.status = SUCCESSFUL
#    b. Set donation.mpesa_receipt_number
#    c. Calculate platform_fee = amount * (settings.PLATFORM_FEE_PERCENT / 100)
#    d. Set donation.platform_fee, donation.net_amount = amount - platform_fee
#    e. Use atomic transaction: increment campaign.raised_amount by amount, increment campaign.wallet_balance by net_amount
#    f. Create Notification for Church Treasurer
#    g. Write AuditLog entry
# 5. FAILURE (ResultCode != 0): set donation.status = FAILED
# 6. Return HTTP 200 always (Safaricom retries on non-200)
```

**B2C callback handler** (`POST /api/v1/withdrawals/b2c-callback/`):
```python
# 1. Extract ConversationID and ResultCode
# 2. Find Withdrawal by b2c_conversation_id
# 3. SUCCESS (ResultCode == 0):
#    a. Set withdrawal.status = PAID
#    b. Set withdrawal.payout_reference
#    c. Use atomic transaction: decrement campaign.wallet_balance by withdrawal.amount
#    d. Create notifications, write AuditLog
# 4. FAILURE: set withdrawal.status = FAILED, set withdrawal.failure_reason
#    a. If withdrawal.retry_count < 5: keep as FAILED (retriable)
#    b. If withdrawal.retry_count >= 5: set FAILED_FINAL, alert Super Admin
# 5. Return HTTP 200 always
```

---

### Step 2.11 — Build Africa's Talking Integration

Create `integrations/africastalking.py`:

```python
import africastalking
import hashlib
import secrets
import django.conf as conf

class ATClient:
    def __init__(self):
        africastalking.initialize(conf.settings.AT_USERNAME, conf.settings.AT_API_KEY)
        self.sms = africastalking.SMS

    def send_otp(self, phone: str) -> tuple[str, str]:
        """
        Generates OTP, sends via SMS, returns (otp_hash, plaintext_otp).
        Caller stores otp_hash. Plaintext is discarded after this function.
        """
        otp = str(secrets.randbelow(900000) + 100000)  # 6-digit OTP
        otp_hash = hashlib.sha256(otp.encode()).hexdigest()
        message = f"Your Pamoja Hub verification code is: {otp}. It expires in 10 minutes. Do not share this code."
        self.sms.send(message, [f'+{phone}'])
        return otp_hash, otp  # Caller must discard otp after sending

    def send_rejection_sms(self, phone: str, campaign_title: str, reason: str):
        message = f"Pamoja Hub: Your disbursement request for '{campaign_title}' was rejected. Reason: {reason}"
        self.sms.send(message, [f'+{phone}'])
```

---

### Step 2.12 — Build Resend Integration

Create `integrations/resend_email.py`:

```python
import resend
from django.conf import settings

resend.api_key = settings.RESEND_API_KEY

class ResendClient:
    FROM = settings.RESEND_FROM_EMAIL

    def send_registration_approved(self, to_email: str, church_name: str): ...
    def send_registration_rejected(self, to_email: str, church_name: str, reason: str): ...
    def send_password_reset_otp(self, to_email: str, otp: str): ...
    def send_password_changed_notice(self, to_email: str): ...
    def send_subscription_invoice(self, to_email: str, amount: int, tier: str): ...
    def send_campaign_update_to_donor(self, to_email: str, campaign_title: str, update_body: str): ...
```

---

### Step 2.13 — Build Rate Limiting

Apply `django-ratelimit` decorators to views. Example:

```python
from django_ratelimit.decorators import ratelimit
from django_ratelimit.exceptions import Ratelimited
from django.utils.decorators import method_decorator

@method_decorator(ratelimit(key='post:phone_number', rate='3/10m', method='POST', block=True), name='dispatch')
@method_decorator(ratelimit(key='ip', rate='3/10m', method='POST', block=True), name='dispatch')
class RequestOTPView(APIView):
    permission_classes = []
    ...
```

Add to `config/settings/base.py`:
```python
RATELIMIT_USE_CACHE = 'default'
CACHES = {
    'default': {
        'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',  # dev
        # Production: use Redis
    }
}
```

---

### Step 2.14 — Build Notification System

The notification system has two parts: creating notifications and delivering them to the frontend.

**Creating notifications** — write a `notifications/events.py` file with named functions:

```python
def notify_new_donation(campaign, donation): ...
def notify_disbursement_submitted(withdrawal): ...
def notify_disbursement_approved(withdrawal): ...
def notify_disbursement_rejected(withdrawal): ...
def notify_disbursement_paid(withdrawal): ...
def notify_disbursement_failed(withdrawal): ...
def notify_float_low(balance): ...
```

Each function creates `Notification` model instances with the correct `recipient`, `notification_type`, `title`, `message`, and related FKs.

**Delivering to frontend** — the frontend polls `/api/v1/notifications/unread-count/` every 20 seconds. No WebSocket needed. The endpoint returns `{"count": N}` which updates the bell badge.

---

### Step 2.15 — Build Background Tasks (Celery)

Configure Celery for background jobs. Install Redis locally for the broker.

```bash
# Install Redis locally
# macOS: brew install redis && redis-server
# Ubuntu: sudo apt install redis-server

# In requirements.txt (already added in Step 2.1):
# celery, django-celery-beat, redis
```

**Tasks to create in `tasks.py` files:**

```python
# withdrawals/tasks.py
@shared_task
def check_b2c_timeout(withdrawal_id):
    """Called if no B2C callback received within 5 minutes. Queries Daraja Transaction Status API."""
    ...

@shared_task
def retry_b2c_after_midnight(withdrawal_id):
    """Scheduled for 00:05 next day for daily-limit-exceeded failures."""
    ...

@shared_task
def auto_retry_b2c(withdrawal_id, retry_count):
    """Called 3 times at 5-minute intervals for Safaricom downtime failures."""
    ...

# notifications/tasks.py
@shared_task
def send_subscription_reminders():
    """Runs daily. Sends 7-day and 1-day renewal reminder notifications."""
    ...

@shared_task
def pause_lapsed_church_campaigns(church_id):
    """Called when grace period expires. Pauses all ACTIVE campaigns."""
    ...
```

**Verification:** `celery -A config worker --loglevel=info` starts without errors.

---

### Phase 2 Complete Checklist

- [ ] All models created, migrated, no migration errors
- [ ] `python manage.py check` passes with 0 issues
- [ ] Auth flow: register → login → get token → access protected endpoint
- [ ] Campaign Treasurer OTP flow: request-otp → verify-otp → get campaigns → request disbursement
- [ ] STK Push initiation returns checkout_request_id
- [ ] Daraja sandbox callback can be simulated and donation status updates
- [ ] B2C approval triggers payout, callback updates withdrawal status
- [ ] Public campaign endpoints return NO sensitive fields
- [ ] Church scoped permission blocks cross-church data access
- [ ] Rate limiting returns 429 when exceeded
- [ ] AuditLog cannot be updated or deleted (test in Django shell)
- [ ] All environment variable guards trigger correctly

---

## Phase 3: Database

### Step 3.1 — Performance Indexes

After all migrations run, add these indexes. Create a new migration:

```bash
python manage.py makemigrations campaigns --empty --name="add_performance_indexes"
```

```python
# In the new migration
operations = [
    migrations.AddIndex(model_name='campaign', index=models.Index(fields=['church', 'status'], name='idx_campaign_church_status')),
    migrations.AddIndex(model_name='campaign', index=models.Index(fields=['status', 'category'], name='idx_campaign_status_category')),
    migrations.AddIndex(model_name='campaign', index=models.Index(fields=['treasurer_phone'], name='idx_campaign_treasurer_phone')),
    migrations.AddIndex(model_name='donation', index=models.Index(fields=['campaign', 'status'], name='idx_donation_campaign_status')),
    migrations.AddIndex(model_name='donation', index=models.Index(fields=['checkout_request_id'], name='idx_donation_checkout_id')),
    migrations.AddIndex(model_name='withdrawal', index=models.Index(fields=['campaign', 'status'], name='idx_withdrawal_campaign_status')),
    migrations.AddIndex(model_name='notification', index=models.Index(fields=['recipient', 'is_read'], name='idx_notification_recipient_read')),
    migrations.AddIndex(model_name='auditlog', index=models.Index(fields=['entity_type', 'entity_id'], name='idx_auditlog_entity')),
    migrations.AddIndex(model_name='auditlog', index=models.Index(fields=['created_at'], name='idx_auditlog_created')),
    migrations.AddIndex(model_name='campaigntreasurerOTP', index=models.Index(fields=['phone_number', 'is_used', 'expires_at'], name='idx_otp_phone_active')),
]
```

---

### Step 3.2 — Database Constraints

Add database-level constraints for business rules:

```python
# In campaign model Meta:
constraints = [
    models.CheckConstraint(check=models.Q(goal_amount__gt=0), name='campaign_goal_positive'),
    models.CheckConstraint(check=models.Q(raised_amount__gte=0), name='campaign_raised_non_negative'),
    models.CheckConstraint(check=models.Q(wallet_balance__gte=0), name='campaign_wallet_non_negative'),
]

# In donation model Meta:
constraints = [
    models.CheckConstraint(check=models.Q(amount__gte=5), name='donation_min_amount'),
    models.CheckConstraint(check=models.Q(platform_fee__gte=0), name='donation_fee_non_negative'),
]

# In withdrawal model Meta:
constraints = [
    models.CheckConstraint(check=models.Q(amount__gt=0), name='withdrawal_amount_positive'),
    models.CheckConstraint(check=models.Q(retry_count__lte=5), name='withdrawal_max_retries'),
]
```

---

### Step 3.3 — AuditLog Database Protection

After deploying to PostgreSQL, run these SQL commands to restrict the application database user:

```sql
-- Create application role (run as PostgreSQL superuser)
CREATE ROLE pamoja_app WITH LOGIN PASSWORD 'your_app_password';

-- Grant standard permissions on all tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pamoja_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pamoja_app;

-- REVOKE UPDATE and DELETE on AuditLog — database-level enforcement
REVOKE UPDATE, DELETE ON audit_auditlog FROM pamoja_app;

-- Verify: test that the app user cannot update AuditLog
-- SET ROLE pamoja_app;
-- UPDATE audit_auditlog SET action = 'TAMPERED' WHERE id = '...'; -- Must fail with permission denied
```

---

### Phase 3 Complete Checklist

- [ ] All indexes created, migration applied
- [ ] All check constraints prevent invalid data at DB level
- [ ] AuditLog UPDATE and DELETE blocked at PostgreSQL role level
- [ ] `python manage.py migrate` runs cleanly with no errors
- [ ] Django shell: attempt to update an AuditLog record → Python-level ValueError raised
- [ ] PostgreSQL shell: attempt UPDATE on audit_auditlog as pamoja_app role → Permission denied

---

## Phase 4: Connecting Frontend & Backend

### Step 4.1 — Configure CORS

In `config/settings/base.py`:
```python
CORS_ALLOWED_ORIGINS = env.list('CORS_ALLOWED_ORIGINS')
CORS_ALLOW_CREDENTIALS = True
```

In `.env`:
```
CORS_ALLOWED_ORIGINS=http://localhost:19006,http://localhost:8081
```

---

### Step 4.2 — Create .env Files

**Backend `.env`** (never commit this):
```env
SECRET_KEY=generate-a-long-random-string-here
DEBUG=True
DATABASE_URL=postgresql://your_user:your_password@localhost/pamoja_dev
MPESA_CONSUMER_KEY=your_sandbox_key
MPESA_CONSUMER_SECRET=your_sandbox_secret
MPESA_SHORTCODE=174379
MPESA_PASSKEY=your_sandbox_passkey
MPESA_CALLBACK_URL=https://REPLACE-WITH-NGROK-URL.ngrok.io/api/v1/donations/callback/
MPESA_ENVIRONMENT=sandbox
MPESA_B2C_INITIATOR_NAME=testapi
MPESA_B2C_SECURITY_CREDENTIAL=your_credential
MPESA_B2C_QUEUE_URL=https://REPLACE-WITH-NGROK-URL.ngrok.io/api/v1/withdrawals/b2c-queue/
MPESA_B2C_RESULT_URL=https://REPLACE-WITH-NGROK-URL.ngrok.io/api/v1/withdrawals/b2c-callback/
MPESA_FLOAT_ALERT_THRESHOLD=50000
AT_API_KEY=your_sandbox_key
AT_USERNAME=sandbox
RESEND_API_KEY=your_resend_key
RESEND_FROM_EMAIL=noreply@yourdomain.com
FRONTEND_URL=http://localhost:19006
ALLOWED_HOSTS=localhost,127.0.0.1
CORS_ALLOWED_ORIGINS=http://localhost:19006,http://localhost:8081
PLATFORM_FEE_PERCENT=2.5
```

**Frontend `.env`** (never commit this):
```env
EXPO_PUBLIC_API_URL=http://localhost:8000/api/v1
```

---

### Step 4.3 — Set Up ngrok

```bash
# In a separate terminal — keep this running during development
ngrok http 8000

# Copy the HTTPS URL (e.g. https://abc123.ngrok.io)
# Update MPESA_CALLBACK_URL, MPESA_B2C_RESULT_URL, MPESA_B2C_QUEUE_URL in .env
# Restart Django server after updating .env
```

**Note:** ngrok URL changes every time you restart it on the free plan. Update your .env every time.

---

### Step 4.4 — Replace Frontend Mock Data with Real API Calls

Go through each service file in `/frontend/services/` and replace the mock returns with real Axios calls. Do this in the same order as Phase 1 screens were built.

**Replacement pattern** (campaigns.service.ts example):
```typescript
export const campaignsService = {
  async browse(params?) {
    // REMOVE: return { count: mockPublicCampaigns.length, results: mockPublicCampaigns };
    // ADD:
    return (await api.get('/campaigns/', { params })).data;
  },
  async getBySlug(slug: string) {
    // REMOVE: return mockPublicCampaigns.find(c => c.slug === slug)!;
    // ADD:
    return (await api.get(`/campaigns/${slug}/`)).data;
  },
};
```

Do this for every service file. Test each screen immediately after replacing its service.

---

### Step 4.5 — Test Each Flow End-to-End

Test these flows in order. Fix any issues before moving to the next flow.

**Flow 1: Public Donation**
1. Browse campaigns page loads from real API
2. Click campaign → campaign page loads
3. Enter valid Safaricom number and KES amount
4. Click Donate → STK Push triggers in Daraja sandbox
5. Daraja sandbox simulates payment confirmation → callback fires to ngrok
6. Donation status updates to SUCCESSFUL
7. Campaign raised amount increments
8. Church Treasurer dashboard notification appears

**Flow 2: Church Registration & Approval**
1. Register a new church via the registration form
2. Super Admin portal shows the pending application
3. Super Admin approves → church status becomes ACTIVE
4. Church Treasurer logs in successfully

**Flow 3: Campaign Creation**
1. Church Treasurer logs in
2. Creates a group label
3. Creates a campaign with group label and Campaign Treasurer phone
4. Campaign Creation Success Screen shows WhatsApp share button
5. Campaign appears in public Browse Campaigns

**Flow 4: Campaign Treasurer OTP**
1. Open /treasurer in a browser
2. Enter the Campaign Treasurer phone number
3. Africa's Talking sandbox sends OTP SMS (check sandbox dashboard)
4. Enter OTP
5. Campaign scoped view loads
6. Donation report shows real donations
7. Submit disbursement request
8. Church Treasurer dashboard shows pending request notification

**Flow 5: Disbursement Approval**
1. Church Treasurer sees pending disbursement in dashboard
2. Opens approval dialog — destination phone shown prominently
3. Clicks Approve
4. Daraja B2C fires in sandbox
5. B2C callback fires → withdrawal status becomes PAID
6. wallet_balance decrements
7. Church Treasurer sees PAID notification

**Flow 6: Notification Polling**
1. While Church Treasurer dashboard is open, trigger a donation from another browser tab
2. Within 20 seconds, bell badge increments without page refresh

---

### Step 4.6 — Pre-Launch Checklist

Complete all of these before going live:

**Security**
- [ ] `.env` is in `.gitignore` and not tracked by git
- [ ] `git log --all -- .env` returns nothing
- [ ] Daraja callback IP whitelist configured at nginx level
- [ ] Rate limiting verified: hit /auth/login/ 6 times → 429 on 6th
- [ ] OTP brute force verified: 5 failed verifications → phone locked
- [ ] Cross-church access verified: Church A's token cannot access Church B's campaigns
- [ ] `treasurer_phone` absent from public campaign API response
- [ ] AuditLog UPDATE blocked at database level
- [ ] Startup guards verified: set DEBUG=True + MPESA_ENVIRONMENT=production → server refuses to start

**Functionality**
- [ ] Full donation flow works end-to-end in Daraja sandbox
- [ ] Full disbursement flow works end-to-end including B2C
- [ ] OTP flow works with real Africa's Talking sandbox SMS
- [ ] Email delivery works via Resend (registration approved, password reset)
- [ ] Subscription tier limits enforced (Free tier: 4th campaign creation blocked)
- [ ] Campaign closure blocked when wallet_balance > 0
- [ ] Duplicate OTP blocked after first use
- [ ] Concurrent withdrawal race condition: submit two disbursement requests simultaneously → only one succeeds

**Code Quality**
- [ ] `npx tsc --noEmit` in frontend — zero TypeScript errors
- [ ] `python manage.py check` — zero Django errors
- [ ] No `console.log` or `print()` statements with sensitive data
- [ ] No hardcoded credentials anywhere in codebase
- [ ] All API error responses have consistent format (from custom exception handler)

---

## Coding Rules for Claude

When resuming a coding session, Claude must follow these rules without exception:

1. **Read context first.** Before writing any code, confirm which step from this guide is being executed.
2. **Never skip a step.** If a step has prerequisites, complete the prerequisites first.
3. **Sensitive fields.** The following fields must NEVER appear in public serializers or API responses: `treasurer_phone`, `treasurer_name`, `wallet_balance` (public campaign), `platform_fee` breakdown, `checkout_request_id`, `b2c_conversation_id`.
4. **Money-moving endpoints.** Every endpoint that triggers Daraja B2C must have these three checks in this order: (a) role check, (b) church ownership check, (c) wallet balance check with SELECT FOR UPDATE. Never skip any of these.
5. **OTP codes.** OTP codes are hashed before storage. Never store, log, or return a plaintext OTP.
6. **AuditLog.** Every state change to Donation, Withdrawal, Campaign, Church, or User must create an AuditLog entry. No exceptions.
7. **HTML sanitization.** Any endpoint that accepts rich text HTML must sanitize with bleach in the serializer's validate method. Never store unsanitized HTML.
8. **Error consistency.** Use the custom exception handler. Never return raw Django error pages.
9. **Return HTTP 200 from Daraja callbacks.** Even on failure. Daraja retries on non-200 responses.
10. **Environment guards.** Never remove or bypass the startup validation functions.

---

*Pamoja Hub Build Guide v1.0 — May 2026*
*Use alongside PRD v5.0 FINAL*
