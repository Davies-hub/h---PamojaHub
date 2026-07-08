// All TypeScript interfaces for Pamoja Hub — import from here, not from model files

export type UserRole = 'SUPER_ADMIN' | 'CHURCH_TREASURER';

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  churchId?: string;
  churchName?: string;
  churchStatus?: ChurchStatus;          // from login response church_status
  churchRejectionReason?: string;       // present only when churchStatus === 'REJECTED'
}

// Backend values: churches/models.py ChurchStatus (PENDING|ACTIVE|SUSPENDED|REJECTED).
export type ChurchStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'REJECTED';
export type SubscriptionTier = 'FREE' | 'GROWTH' | 'PARISH';

export interface Church {
  id: string;
  name: string;
  officialEmail: string;
  phone: string;
  address: string;
  county: string | null;          // backend Church.county is nullable — null passes through (not '')
  denomination: string;
  logoUrl?: string;
  description?: string | null;     // backend Church.description is nullable — null passes through (not '')
  status: ChurchStatus;
  subscriptionTier: SubscriptionTier;
  subscriptionExpiresAt?: string;
  subscriptionCancelRequested?: boolean;   // auto-renew opt-out; drives the CANCELLED card state (only /churches/me/ carries it)
  createdAt: string;
  activeCampaignCount?: number;    // S7a per-row aggregate (super churches list); optional — other Church sources don't set it
  totalRaised?: number;            // S7a per-row aggregate (NET); string→Number at the mapper boundary
}

export interface GroupLabel {
  id: string;
  // OPTIONAL: GroupLabelSerializer does NOT emit `church` on the wire (the list is
  // already church-scoped server-side), so mapGroupLabel cannot populate this. Kept
  // optional only for the mock fixtures that still set it; never read from the API.
  churchId?: string;
  parentLabelId?: string;
  name: string;
  isArchived: boolean;
  activeCampaignCount: number;
  createdAt: string;
}

export type CampaignStatus = 'ACTIVE' | 'PAUSED' | 'CLOSED';
export type CampaignCategory =
  | 'Building'
  | 'Outreach'
  | 'Youth'
  | 'Education'
  | 'Medical'
  | 'Relief'
  | 'Other';

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
  walletBalance: number;
  status: CampaignStatus;
  bannerImageUrl?: string;
  documentUrl?: string;
  category: CampaignCategory;
  treasurerPhone?: string;  // NEVER shown on public screens
  treasurerName?: string;   // NEVER shown on public screens
  createdAt: string;
  closedAt?: string;
  donorCount?: number;
}

// Public campaign — no treasurer fields
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
  bannerImageUrl?: string;
  documentUrl?: string;
  category: CampaignCategory;
  createdAt: string;
}

// Public church — the strict SUBSET the public /churches/ API returns (allowlist).
// NOT the full Church type: officialEmail/phone/address/status/subscription* are
// church-internal and never in the public payload. county can be null (backend
// Church.county is nullable). activeCampaignCount comes straight from the API
// (no client-side counting).
export interface PublicChurch {
  id: string;
  name: string;
  county: string | null;
  denomination: string;
  logoUrl?: string;
  description?: string;
  activeCampaignCount: number;
}

export type DonationStatus = 'PENDING' | 'SUCCESSFUL' | 'FAILED';

export interface Donation {
  id: string;
  campaignId: string;
  campaignTitle: string;
  churchName?: string;
  phoneNumber: string;
  donorName?: string;
  donorEmail?: string;
  amount: number;
  // D2: platformFee/netAmount are NULL on PENDING/FAILED rows until the STK callback
  // computes them (backend Donation.platform_fee/net_amount are nullable). Gross
  // `amount` is always present. Super Donations renders "—" for the null case; never 0.
  platformFee: number | null;
  netAmount: number | null;
  status: DonationStatus;
  mpesaReceiptNumber?: string;
  createdAt: string;
  confirmedAt?: string;
}

export type WithdrawalStatus =
  | 'PENDING_APPROVAL'
  | 'PROCESSING'
  | 'PAID'
  | 'FAILED'
  | 'FAILED_FINAL'
  | 'REJECTED'
  | 'NEEDS_RECONCILIATION';   // backend money-in-limbo state — neutral "under review" in UI

export interface Withdrawal {
  id: string;
  campaignId: string;
  campaignTitle: string;
  churchName?: string;
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
  dispatchStatus?: string;   // runtime-injected on approve/retry; e.g. "failed_queued_for_retry"
  dispatchOutcome?: 'CLEAN_FAILURE' | 'AMBIGUOUS_FAILURE';
}

export type NotificationType =
  | 'DONATION_RECEIVED'
  | 'DONATION_NEEDS_REVIEW'
  | 'DISBURSEMENT_SUBMITTED'
  | 'DISBURSEMENT_APPROVED'
  | 'DISBURSEMENT_REJECTED'
  | 'DISBURSEMENT_PAID'
  | 'DISBURSEMENT_FAILED'
  | 'RECONCILIATION_PAYMENT_CONFIRMED'
  | 'SUBSCRIPTION_REMINDER'
  | 'SUBSCRIPTION_LAPSED'
  | 'SUBSCRIPTION_ACTIVATED'
  | 'CAMPAIGN_DESTINATION_CHANGED';

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
  amount: number;       // gross — kept for receipt matching only
  platformFee: number;
  netAmount: number;    // display value — Net per Net-Everywhere rule
  createdAt: string;
}

// ── Treasurer dashboard (authed reads) ──────────────────────────────────────
// Real types for the dashboard data (replacing the mock-file shapes). Money is
// NET and arrives as a number AFTER the mapper Number()-converts the backend's
// decimal STRINGS.

export interface RecentDonation {
  donorName?: string;
  netAmount: number;       // amount the church keeps (NET)
  mpesaReceipt: string;    // also the React key — backend feed rows have no id
  campaignTitle: string;
  createdAt: string;
}

export interface DashboardStats {
  totalRaised: number;
  walletBalance: number;
  activeCampaigns: number;
  pendingDisbursements: number;
  recentDonations: RecentDonation[];
}

// Public all-time platform totals (GET /stats/) — the landing hero figures.
export interface PlatformTotals {
  totalRaised: number;    // NET, all-time (decimal string on wire → Number)
  campaignCount: number;
  churchCount: number;
}

// The treasurer's own campaign (AdminCampaignSerializer) — richer than PublicCampaign
// (wallet_balance) but the screens read this subset.
export interface TreasurerCampaign {
  id: string;
  slug: string;
  title: string;
  status: CampaignStatus;
  description?: string;
  category?: CampaignCategory;
  goalAmount: number;
  raisedAmount: number;
  walletBalance: number;
  groupLabelName?: string;
  donorCount?: number;
  createdAt: string;
}

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

export interface AuditLog {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  notes?: string;
}

// Super Admin billing — PlatformSettings singleton (GET /super/billing/).
// Money values are kept as STRINGS: they feed EDITABLE TEXT inputs, and a READ
// must never reformat a stored money value (the WRITE slice owns parse/validate).
// Backend sends "2.50"/"999.00"/"2499.00" — acceptable to display verbatim.
// updatedAt is mapped for completeness but unused by the screen.
export interface PlatformSettings {
  feePercent: string;
  growthPrice: string;
  parishPrice: string;
  updatedAt: string;
}

// Super Admin analytics — the single pre-aggregated object from GET /super/analytics/.
// Money values are display Numbers (not editable inputs, unlike billing). totalDonations
// is GROSS over SUCCESSFUL donations (the authorized Net-Everywhere exception surface);
// totalChurches counts ACTIVE churches.
export interface AnalyticsSummary {
  totalChurches: number;
  totalActiveCampaigns: number;
  totalDonations: number;
  totalPlatformFees: number;
  donationCount: number;
  netTotal: number;
  // Chart series (money → display Numbers, decimal-string boundary in mapAnalytics).
  // donationsByMonth: fixed trailing 12 months, oldest→newest, zero-filled (GROSS).
  // topChurchesByRaised: ≤10, descending by NET raised.
  donationsByMonth: { month: string; total: number }[];
  topChurchesByRaised: { churchName: string; totalRaised: number }[];
}
