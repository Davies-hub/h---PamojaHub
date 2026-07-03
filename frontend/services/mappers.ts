// Backend (snake_case) → frontend (camelCase) mappers.
//
// Decision A (Phase 4): the frontend maps on receive. These mappers are EXPLICIT
// per-field — NOT a generic deep snake→camel convert — so every rename is greppable
// and a field can never silently mis-map. This is the PATTERN for all later slices:
// add a typed Backend<X> shape + a map<X>() here, one per resource.

import {
  AnalyticsSummary,
  AuditLog,
  AuthUser,
  CampaignCategory,
  CampaignStatus,
  Church,
  ChurchStatus,
  DashboardStats,
  Donation,
  DonationStatus,
  GroupLabel,
  PlatformSettings,
  PlatformTotals,
  PortalCampaign,
  PublicCampaign,
  PublicChurch,
  RecentDonation,
  SubscriptionTier,
  TreasurerCampaign,
  UserRole,
  Withdrawal,
  WithdrawalStatus,
} from '../types';
import type { SubscriptionPollVerdict } from '../utils/subscription';

// The shape the backend's UserSerializer returns (accounts/serializers.py).
export interface BackendUser {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: UserRole;
  church: string | null;       // FK id — RENAMED to churchId below (not just casing)
  church_name: string | null;
}

// `churchStatus` is a SIBLING of `user` in the login response (church_status),
// not nested inside the user object — so it is passed in explicitly here.
export function mapUser(b: BackendUser, churchStatus?: ChurchStatus | null): AuthUser {
  return {
    id: b.id,
    email: b.email,
    firstName: b.first_name,
    lastName: b.last_name,
    role: b.role,
    churchId: b.church ?? undefined,        // church → churchId (rename, not casing)
    churchName: b.church_name ?? undefined,
    churchStatus: churchStatus ?? undefined,
  };
}

// ── SEND mapper (camelCase → snake_case) — the inverse of mapUser's RECEIVE. ──
// Registration SENDS the form to the backend, so the request body must use the
// backend's field names. Explicit per-field (same discipline as mapUser).
// county / first_name / last_name are intentionally NOT sent (B3 — not collected;
// the backend treats them as optional). phone is sent AS TYPED (0712…) — the
// backend canonicalizes it to 254… (validate_safaricom_phone); we do not
// double-normalize here.
export interface RegisterForm {
  churchName: string;
  email: string;
  phone: string;
  address: string;
  denomination: string;
  password: string;
}
export interface BackendRegisterBody {
  name: string;
  official_email: string;
  phone: string;
  address: string;
  denomination: string;
  password: string;
}
export function mapRegisterPayload(f: RegisterForm): BackendRegisterBody {
  return {
    name: f.churchName,        // churchName → name
    official_email: f.email,   // email → official_email
    phone: f.phone,            // sent as typed; backend normalizes to 254…
    address: f.address,
    denomination: f.denomination,
    password: f.password,
  };
}

// ── PUBLIC READ mappers (RECEIVE, snake → camel) — public campaign/church lists. ──
// Same discipline as mapUser: explicit per-field, no generic deep-convert.
// CRITICAL: the backend serializes DecimalField as a STRING ("80000.00"), so
// goal_amount/raised_amount must be Number()-converted — never passed straight into
// a numeric field. A non-numeric value is a DATA bug we want VISIBLE, so we log a
// warning and fall back to 0 for safe rendering (and the checkpoint reports if any
// real row tripped it).

// Shape returned by PublicCampaignSerializer (campaigns/serializers.py).
export interface BackendPublicCampaign {
  id: string;
  slug: string;
  church_name: string;
  group_label_name: string | null;
  title: string;
  description: string;
  goal_amount: string;        // DecimalField → STRING
  raised_amount: string;      // DecimalField → STRING
  donor_count: number;
  status: string;
  banner_image_url: string | null;
  document_url: string | null;
  category: string;
  created_at: string;
}

function toMoneyNumber(field: string, raw: string): number {
  const n = Number(raw);
  if (Number.isNaN(n)) {
    // eslint-disable-next-line no-console
    console.warn(`[mapPublicCampaign] non-numeric ${field}:`, raw);
    return 0; // safe render; a NaN here would mean the backend sent a bad decimal
  }
  return n;
}

export function mapPublicCampaign(b: BackendPublicCampaign): PublicCampaign {
  return {
    id: b.id,
    slug: b.slug,
    churchName: b.church_name,
    groupLabelName: b.group_label_name ?? undefined,   // null → undefined
    title: b.title,
    description: b.description,
    goalAmount: toMoneyNumber('goal_amount', b.goal_amount),     // "80000.00" → 80000
    raisedAmount: toMoneyNumber('raised_amount', b.raised_amount),
    donorCount: b.donor_count,
    status: b.status as CampaignStatus,        // enum values match 1:1 (verified)
    category: b.category as CampaignCategory,  // enum values match 1:1 (verified)
    bannerImageUrl: b.banner_image_url ?? undefined,   // null (pre-upload rows) → undefined
    documentUrl: b.document_url ?? undefined,  // null → undefined
    createdAt: b.created_at,
  };
}

// Shape returned by PublicChurchSerializer (churches/serializers.py) — the strict
// public allowlist; official_email/phone/address/status/subscription* are NOT here.
export interface BackendPublicChurch {
  id: string;
  name: string;
  county: string | null;
  denomination: string;
  logo_url: string | null;
  description: string | null;
  active_campaign_count: number;
}

export function mapPublicChurch(b: BackendPublicChurch): PublicChurch {
  return {
    id: b.id,
    name: b.name,
    county: b.county,                          // may be null (backend county is nullable)
    denomination: b.denomination,
    logoUrl: b.logo_url ?? undefined,          // null → undefined
    description: b.description ?? undefined,    // null → undefined
    activeCampaignCount: b.active_campaign_count,
  };
}

// ── TREASURER DASHBOARD mappers (authed reads, RECEIVE) ──────────────────────
// All money arrives as decimal STRINGS → toMoneyNumber (same guard as campaigns).
// All NET (Net-Everywhere). Explicit per-field.

// GET /churches/me/stats/
export interface BackendRecentDonation {
  donor_name: string | null;
  amount: string;              // = net_amount (NET), decimal STRING
  mpesa_receipt_number: string;
  campaign_title: string;
  created_at: string;
}
export interface BackendDashboardStats {
  total_raised: string;        // NET, STRING
  wallet_balance: string;      // NET, STRING
  active_campaigns: number;
  pending_disbursements: number;
  recent_donations: BackendRecentDonation[];
}

export function mapRecentDonation(b: BackendRecentDonation): RecentDonation {
  return {
    donorName: b.donor_name ?? undefined,
    netAmount: toMoneyNumber('recent_donation.amount', b.amount),  // amount IS net
    mpesaReceipt: b.mpesa_receipt_number,                          // React key (no id)
    campaignTitle: b.campaign_title,
    createdAt: b.created_at,
  };
}

export function mapDashboardStats(b: BackendDashboardStats): DashboardStats {
  return {
    totalRaised: toMoneyNumber('total_raised', b.total_raised),
    walletBalance: toMoneyNumber('wallet_balance', b.wallet_balance),
    activeCampaigns: b.active_campaigns,
    pendingDisbursements: b.pending_disbursements,
    recentDonations: (b.recent_donations ?? []).map(mapRecentDonation),
  };
}

// GET /stats/ (PlatformStatsSerializer) — public all-time platform totals.
export interface BackendPlatformTotals {
  total_raised: string;        // NET, all-time, STRING (DecimalField)
  campaign_count: number;
  church_count: number;
}

export function mapPlatformTotals(b: BackendPlatformTotals): PlatformTotals {
  return {
    totalRaised: toMoneyNumber('total_raised', b.total_raised),
    campaignCount: b.campaign_count,
    churchCount: b.church_count,
  };
}

// GET /campaigns/mine/ (AdminCampaignSerializer — '__all__' + group_label_name)
export interface BackendTreasurerCampaign {
  id: string;
  slug: string;
  title: string;
  status: string;
  description: string;
  category: string;
  goal_amount: string;
  raised_amount: string;
  wallet_balance: string;
  group_label_name: string | null;
  donor_count: number;            // SerializerMethodField — plain int (SUCCESSFUL donations), NOT money
  created_at: string;
  // (other __all__ fields exist on the wire — treasurer_phone, etc. — unused here)
}

export function mapTreasurerCampaign(b: BackendTreasurerCampaign): TreasurerCampaign {
  return {
    id: b.id,
    slug: b.slug,                              // slug-keyed: drives pause/resume/close
    title: b.title,
    status: b.status as CampaignStatus,
    description: b.description,
    category: b.category as CampaignCategory,
    goalAmount: toMoneyNumber('goal_amount', b.goal_amount),
    raisedAmount: toMoneyNumber('raised_amount', b.raised_amount),
    walletBalance: toMoneyNumber('wallet_balance', b.wallet_balance),
    groupLabelName: b.group_label_name ?? undefined,   // now provided by the backend
    donorCount: b.donor_count,                 // plain int — NO toMoneyNumber (count, not money)
    createdAt: b.created_at,
  };
}

// GET /withdrawals/ (WithdrawalSerializer — note BE key `campaign` = title string)
export interface BackendWithdrawal {
  id: string;
  campaign: string;            // = campaign.title
  church_name: string | null;  // = campaign.church.name
  amount: string;              // NET payout, STRING
  destination_phone: string;
  destination_name: string;
  requested_by_phone: string;
  reason: string;
  rejection_reason: string | null;
  status: string;              // may be NEEDS_RECONCILIATION (now in the FE union)
  payout_reference: string | null;
  failure_reason: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
  // Runtime-injected by the approve/retry actions ONLY (not a model field) — present
  // only when a synchronous B2C dispatch failure occurred (value "failed_queued_for_retry").
  dispatch_status?: string;
  // Failure-class marker (CLEAN_FAILURE / AMBIGUOUS_FAILURE / null). Gates the Retry
  // button — AMBIGUOUS_FAILURE means the dispatch may have been queued and must be
  // reconciled by Super Admin, never blind-retried.
  dispatch_outcome: string | null;
}

export function mapWithdrawal(b: BackendWithdrawal): Withdrawal {
  return {
    id: b.id,
    campaignId: '',                       // not exposed by WithdrawalSerializer (unused on payouts)
    campaignTitle: b.campaign,            // BE key is `campaign`
    churchName: b.church_name ?? undefined,
    requestedByPhone: b.requested_by_phone,
    amount: toMoneyNumber('withdrawal.amount', b.amount),
    destinationPhone: b.destination_phone,
    destinationName: b.destination_name,
    reason: b.reason,
    rejectionReason: b.rejection_reason ?? undefined,
    status: b.status as WithdrawalStatus,
    payoutReference: b.payout_reference ?? undefined,
    failureReason: b.failure_reason ?? undefined,
    retryCount: b.retry_count,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
    dispatchStatus: b.dispatch_status,   // passthrough; undefined when absent
    dispatchOutcome: (b.dispatch_outcome ?? undefined) as Withdrawal['dispatchOutcome'],
  };
}

// GET/POST/PATCH /group-labels/ (GroupLabelSerializer — campaigns/serializers.py:190).
// The treasurer Group Labels CRUD surface. Explicit per-field (same discipline as the
// rest). Two renames, NOT just casing: parent_label → parentLabelId (and null → undefined,
// which is also how the screen derives "hierarchical" = parentLabelId present), and
// is_archived → isArchived. active_campaign_count is a plain int (NOT a money string), so
// NO toMoneyNumber. CRITICAL: the serializer does NOT emit `church`, so churchId is
// intentionally NOT populated here (the type marks it optional) — the list is already
// church-scoped server-side, so no client-side church filter is needed or possible.
export interface BackendGroupLabel {
  id: string;
  name: string;
  parent_label: string | null;   // FK id → parentLabelId (rename); null = flat
  is_archived: boolean;
  active_campaign_count: number;  // plain int — NOT a money string
  created_at: string;
}

export function mapGroupLabel(b: BackendGroupLabel): GroupLabel {
  return {
    id: b.id,
    name: b.name,
    parentLabelId: b.parent_label ?? undefined,   // null → undefined (drives the badge)
    isArchived: b.is_archived,
    activeCampaignCount: b.active_campaign_count,
    createdAt: b.created_at,
    // churchId deliberately omitted — not on the wire (see BackendGroupLabel note).
  };
}

// GET /super/billing/ (_PlatformSettingsSerializer — superadmin/views.py:803-806).
// CRITICAL: the three money values are STRINGS on the wire ("2.50"/"999.00"/
// "2499.00") and STAY strings — they feed editable text inputs, and a READ must
// never alter a stored money value. So NO toMoneyNumber here: pass through verbatim
// (no Number()-then-re-stringify, no round, no reformat). The WRITE slice owns
// parsing/validation. Explicit per-field, same discipline as mapUser.
export interface BackendPlatformSettings {
  fee_percent: string;        // DecimalField → STRING (kept as-is)
  growth_price: string;       // DecimalField → STRING (kept as-is)
  parish_price: string;       // DecimalField → STRING (kept as-is)
  updated_at: string;
}

export function mapPlatformSettings(b: BackendPlatformSettings): PlatformSettings {
  return {
    feePercent: b.fee_percent,       // passthrough verbatim — NO Number()/round/reformat
    growthPrice: b.growth_price,     // passthrough verbatim
    parishPrice: b.parish_price,     // passthrough verbatim
    updatedAt: b.updated_at,         // mapped for completeness; unused by the screen
  };
}

// Shape returned by AdminDonationSerializer (donations/serializers.py) for the Super
// Admin donations table. STRICT FE-BOUNDARY ALLOWLIST: the wire ALSO carries
// phone_number / donor_email / checkout_request_id (all sensitive; checkout_request_id
// is Coding Rule 3) — they are deliberately ABSENT from this interface and NEVER read,
// so the mapped object cannot surface them (same property proven on mapPublicCampaign).
export interface BackendDonation {
  id: string;
  campaign_title: string;
  church_name: string;
  mpesa_receipt_number: string | null;
  donor_name: string | null;
  status: string;
  created_at: string;
  amount: string;               // GROSS, always present, DecimalField → STRING
  platform_fee: string | null;  // NULL until the STK callback computes it (D2)
  net_amount: string | null;    // NULL until the STK callback computes it (D2)
}

// Shape returned by AdminChurchSerializer (churches/serializers.py, fields='__all__')
// for the Super Admin surfaces. STRICT FE-BOUNDARY ALLOWLIST, sized to the FULLER
// Churches-screen read (also serves the Queue). The wire ALSO carries rejection_reason
// (sensitive), subscription_expires_at, and logo_url — all DROPPED here (absent from
// BackendAdminChurch / never assigned), same boundary property proven on S3/S4.
// county/description are nullable and pass THROUGH as null (never coerced to '').
// S7a/S7b: the serializer now also emits two per-row aggregates for the Churches
// screen — active_campaign_count (int) and total_raised (DecimalField → STRING, NET).
export interface BackendAdminChurch {
  id: string;
  name: string;
  official_email: string;
  phone: string;
  address: string;
  county: string | null;
  denomination: string;
  description: string | null;
  status: string;
  subscription_tier: string;
  created_at: string;
  active_campaign_count: number;   // S7a annotation; pending/zero-campaign rows → 0
  total_raised: string;            // S7a annotation; money → STRING ("0.00" / "84825.00")
}

export function mapAdminChurch(b: BackendAdminChurch): Church {
  return {
    id: b.id,
    name: b.name,
    officialEmail: b.official_email,
    phone: b.phone,
    address: b.address,
    county: b.county,                 // nullable — null passes THROUGH (not '')
    denomination: b.denomination,
    description: b.description,        // nullable — null passes THROUGH (not '')
    status: b.status as ChurchStatus,
    subscriptionTier: b.subscription_tier as SubscriptionTier,
    createdAt: b.created_at,
    activeCampaignCount: Number(b.active_campaign_count),
    totalRaised: toMoneyNumber('church.total_raised', b.total_raised),  // string → Number (NET)
  };
}

// Shape returned by AdminChurchSerializer for GET /churches/me/ — the authenticated
// treasurer's OWN church (gated IsChurchTreasurer, scoped server-side to
// request.user.church). Same serializer the super screens use, but consumed via a
// SEPARATE mapper on purpose: mapMyChurch DELIBERATELY KEEPS subscription_expires_at,
// whereas mapAdminChurch DROPS it (the super-admin Churches/Queue surface has no use
// for expiry — the treasurer settings subscription card is the whole reason expiry is
// on the wire). Allowlist sized to what the settings screen reads: the profile fields
// + tier + expiry. rejection_reason / active_campaign_count / total_raised are not
// read here (absent from the interface → can never surface).
export interface BackendMyChurch {
  id: string;
  name: string;
  denomination: string;
  official_email: string;
  phone: string;
  address: string;
  county: string | null;
  description: string | null;
  status: string;
  subscription_tier: string;
  subscription_expires_at: string | null;   // KEPT here (mapAdminChurch drops this)
  subscription_cancel_requested: boolean;    // auto-renew opt-out; read-only on /churches/me/
  logo_url: string | null;
  created_at: string;
}

export function mapMyChurch(b: BackendMyChurch): Church {
  return {
    id: b.id,
    name: b.name,
    denomination: b.denomination,
    officialEmail: b.official_email,
    phone: b.phone,
    address: b.address,
    county: b.county,                  // nullable — null passes THROUGH (not '')
    description: b.description,         // nullable — null passes THROUGH (not '')
    status: b.status as ChurchStatus,
    subscriptionTier: b.subscription_tier as SubscriptionTier,
    // The whole point of this mapper: KEEP expiry. mapAdminChurch deliberately drops it
    // for the super-admin surface; the treasurer card derives its state from it.
    subscriptionExpiresAt: b.subscription_expires_at ?? undefined,   // null → undefined
    subscriptionCancelRequested: b.subscription_cancel_requested,    // drives the CANCELLED card state
    logoUrl: b.logo_url ?? undefined,  // null → undefined
    createdAt: b.created_at,
  };
}

// ── REQUEST mapper: treasurer profile edit (camel → snake) ───────────────────────
// PATCH /churches/me/ accepts ONLY these 6 WRITABLE fields (AdminChurchSerializer).
// READ-ONLY fields (official_email, status, subscription_tier, subscription_expires_at,
// subscription_cancel_requested, id, created_at) are DELIBERATELY ABSENT — the form
// cannot submit them. The backend normalizes phone (07→254, parity with registration)
// and re-validates; the mapped response (mapMyChurch) is server truth.
export interface MyChurchUpdatePayload {
  name: string;
  denomination: string;
  phone: string;
  address: string;
  county: string;
  description: string;
}

export function toMyChurchUpdateRequest(p: MyChurchUpdatePayload): Record<string, string> {
  return {
    name: p.name,
    denomination: p.denomination,
    phone: p.phone,
    address: p.address,
    county: p.county,
    description: p.description,
  };
}

// ── CAMPAIGN-TREASURER PORTAL mappers (post-OTP, RECEIVE) ────────────────────────
// PortalCampaignSerializer (treasurer_portal/serializers.py) — the scoped campaign
// picker returned by verify-otp. raised_amount/wallet_balance are NET decimal STRINGS
// → toMoneyNumber. NOTE: goal_amount is NOT on the wire (the serializer omits it), so
// PortalCampaign carries no goal — the picker shows wallet, not progress-to-goal.
// treasurer_phone/treasurer_name are not emitted → can never surface here.
export interface BackendPortalCampaign {
  id: string;
  title: string;
  church_name: string;
  status: string;
  raised_amount: string;       // NET, DecimalField → STRING
  wallet_balance: string;      // NET, DecimalField → STRING
}

export function mapPortalCampaign(b: BackendPortalCampaign): PortalCampaign {
  return {
    id: b.id,
    title: b.title,
    churchName: b.church_name,
    status: b.status as CampaignStatus,
    raisedAmount: toMoneyNumber('portal_campaign.raised_amount', b.raised_amount),
    walletBalance: toMoneyNumber('portal_campaign.wallet_balance', b.wallet_balance),
  };
}

// PortalDonationReportSerializer (donations/serializers.py) — one scoped campaign's
// donation feed. NET-ONLY by design: `amount` IS net_amount; the serializer deliberately
// omits gross / platform_fee / phone_number (donor privacy + Net-Everywhere). The mapped
// row is intentionally LEANER than the (aspirational) PortalDonation type in types/index.ts,
// which still carries platformFee/gross the backend must never expose here.
export interface BackendPortalDonation {
  mpesa_receipt_number: string;
  donor_name: string | null;
  amount: string;              // = net_amount (NET), DecimalField → STRING
  campaign_title: string;
  created_at: string;
}
export interface PortalDonationRow {
  mpesaReceipt: string;        // unique → React key
  donorName?: string;
  netAmount: number;
  createdAt: string;
}
export function mapPortalDonation(b: BackendPortalDonation): PortalDonationRow {
  return {
    mpesaReceipt: b.mpesa_receipt_number,
    donorName: b.donor_name ?? undefined,
    netAmount: toMoneyNumber('portal_donation.amount', b.amount),  // amount IS net
    createdAt: b.created_at,
  };
}

// GET /churches/me/donations/ (ChurchMeDonationsView → reuses PortalDonationReportSerializer).
// SAME wire shape as BackendPortalDonation, but this list is CHURCH-WIDE (across every
// campaign), so unlike the per-campaign PortalDonationRow we KEEP campaign_title to label
// each row. NET-only by serializer contract: `amount` IS net_amount; gross / platform_fee /
// phone_number / donor_email are never emitted. The treasurer Reports → Donation History source.
export interface BackendMyDonation {
  mpesa_receipt_number: string;
  donor_name: string | null;
  amount: string;              // = net_amount (NET), DecimalField → STRING
  campaign_title: string;
  created_at: string;
}
export interface MyDonationRow {
  receipt: string;             // unique → React key
  donorName?: string;          // undefined → render "Anonymous"
  netAmount: number;
  campaignTitle: string;
  createdAt: string;
}
export function mapMyDonation(b: BackendMyDonation): MyDonationRow {
  return {
    receipt: b.mpesa_receipt_number,
    donorName: b.donor_name ?? undefined,
    netAmount: toMoneyNumber('my_donation.amount', b.amount),  // amount IS net
    campaignTitle: b.campaign_title,
    createdAt: b.created_at,
  };
}

export function mapDonation(b: BackendDonation): Donation {
  return {
    id: b.id,
    campaignId: '',                       // not exposed by AdminDonationSerializer for the table; unused
    campaignTitle: b.campaign_title,
    churchName: b.church_name,
    phoneNumber: '',                      // ALLOWLIST: phone_number is sensitive — never surfaced (placeholder, same as mapWithdrawal.campaignId)
    donorName: b.donor_name ?? undefined,
    amount: toMoneyNumber('donation.amount', b.amount),   // gross — always present
    // D2: a null money value STAYS null. Number(null) === 0 would fabricate a KES 0
    // fee/net on a PENDING/FAILED row, so only Number()-convert when actually present.
    platformFee: b.platform_fee == null ? null : toMoneyNumber('donation.platform_fee', b.platform_fee),
    netAmount: b.net_amount == null ? null : toMoneyNumber('donation.net_amount', b.net_amount),
    status: b.status as DonationStatus,
    mpesaReceiptNumber: b.mpesa_receipt_number ?? undefined,
    createdAt: b.created_at,
  };
}

// ── Donor-facing STK poll shape ────────────────────────────────────────────────
// DonationStatusSerializer (donations/serializers.py) — the PUBLIC poll response a
// donor sees while/after the STK push: { id, status, mpesa_receipt_number, amount }.
// This is DELIBERATELY NOT mapDonation: there is NO platform_fee / net_amount here
// (the donor-success screen shows GROSS — the Net-Everywhere exception), and
// `amount` is the callback-confirmed GROSS that matches the donor's M-Pesa SMS.
// receipt is null until a SUCCESSFUL verdict; we keep null as null (no '' coercion).
export interface BackendDonationStatus {
  id: string;
  status: string;                         // 'PENDING' | 'SUCCESSFUL' | 'FAILED'
  mpesa_receipt_number: string | null;
  amount: string;                         // decimal STRING → Number (GROSS)
}

export interface DonorDonationStatus {
  status: DonationStatus;
  mpesaReceiptNumber: string | null;
  amount: number;
}

export function mapDonorStatus(b: BackendDonationStatus): DonorDonationStatus {
  return {
    status: b.status as DonationStatus,
    mpesaReceiptNumber: b.mpesa_receipt_number,   // null stays null (no receipt yet)
    amount: toMoneyNumber('donation_status.amount', b.amount),  // string → Number (GROSS)
  };
}

// Shape returned by SubscriptionStatusView (churches/views.py:580-588) — the renew
// pay-and-watch poll target. `stale` is backend-DERIVED (a PENDING row older than the
// STK timeout); it never mutates the row's status, so a late callback can still confirm.
// subscription_expires_at is the church's CURRENT expiry (already advanced on a SUCCESSFUL
// verdict). The mapped shape is SubscriptionPollVerdict — the input to the pure pollReducer.
export interface BackendSubscriptionStatus {
  id: string;
  status: string;                            // 'PENDING' | 'SUCCESSFUL' | 'FAILED'
  tier: string;                              // SubscriptionTier
  subscription_expires_at: string | null;
  stale: boolean;
}

export function mapSubscriptionStatus(b: BackendSubscriptionStatus): SubscriptionPollVerdict {
  return {
    status: b.status as SubscriptionPollVerdict['status'],
    tier: b.tier as SubscriptionTier,
    subscriptionExpiresAt: b.subscription_expires_at,   // null stays null
    stale: b.stale,
  };
}

// Shape returned by SuperAnalyticsView (superadmin/views.py:284-298) — a SINGLE
// pre-aggregated object (NOT a list). The donations aggregate is SUCCESSFUL-only
// (views.py:263), so gross_total/platform_fees_collected are collected-money totals.
// Money values are decimal STRINGS on the wire → Number() (display numbers, not
// editable inputs). Per-field, same discipline as mapUser.
export interface BackendAnalytics {
  churches_by_status: { PENDING: number; ACTIVE: number; SUSPENDED: number; REJECTED: number };
  active_campaigns: number;
  donations: { count: number; gross_total: string; net_total: string };
  platform_fees_collected: string;
}

export function mapAnalytics(b: BackendAnalytics): AnalyticsSummary {
  return {
    totalChurches: b.churches_by_status.ACTIVE,             // "Total Churches" card = ACTIVE count
    totalActiveCampaigns: b.active_campaigns,
    totalDonations: toMoneyNumber('analytics.gross_total', b.donations.gross_total),  // GROSS (Net-Everywhere exception)
    totalPlatformFees: toMoneyNumber('analytics.platform_fees_collected', b.platform_fees_collected),
    donationCount: b.donations.count,
    netTotal: toMoneyNumber('analytics.net_total', b.donations.net_total),
  };
}

// Shape returned by AuditLogSerializer (audit/serializers.py) for GET /super/audit-log/.
// ip_address is DELIBERATELY ABSENT from this interface (unused on the screen + an IP is
// itself PII) → it can never be read or surfaced, same allowlist-drop property proven on
// mapDonation. `details` is a JSONField — in pamoja_dev every row is a FLAT object
// {key: scalar}, but it is typed `unknown` and flattened shape-safely (see flattenDetails).
export interface BackendAuditLog {
  id: string;
  actor_email: string | null;   // null unless actor is a FK User (SerializerMethodField)
  actor_phone: string | null;   // bare string for portal/SMS-initiated actions; pre-masked at write-time
  action: string;
  entity_type: string;
  entity_id: string;
  details: unknown;             // JSONField; flat {key: scalar} today, flattened defensively
  created_at: string;
}

// D3 (shape-safe details flatten): render the audit `details` JSON as a compact
// "key: value, key: value" string for the row's notes line. Scalars (string/number/
// boolean/null) print via String(); nested objects/arrays are JSON.stringify'd so they
// show as compact JSON, NEVER "[object Object]"; a null / non-object / empty details
// yields '' (the row then renders no notes line). Values print VERBATIM — phones in
// audit details are ALREADY masked at write-time (e.g. "*********149"); never unmask.
function flattenDetails(details: unknown): string {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return '';
  const entries = Object.entries(details as Record<string, unknown>);
  if (entries.length === 0) return '';
  return entries
    .map(([k, v]) => {
      const val = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
      return `${k}: ${val}`;
    })
    .join(', ');
}

export function mapAuditLog(b: BackendAuditLog): AuditLog {
  return {
    id: b.id,
    timestamp: b.created_at,
    entityType: b.entity_type,
    entityId: b.entity_id,
    action: b.action,
    // One display string: actor email, else the (masked) actor phone, else 'System'
    // for a no-actor event (e.g. an M-Pesa callback writing WITHDRAWAL_PAID).
    actor: b.actor_email ?? b.actor_phone ?? 'System',
    notes: flattenDetails(b.details),
  };
}
