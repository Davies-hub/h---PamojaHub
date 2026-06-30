import { AnalyticsSummary, AuditLog, Church, Donation, PaginatedResponse, PlatformSettings, PublicCampaign, SubscriptionTier, Withdrawal } from '../types';
import { api } from './api';
import {
  BackendAdminChurch,
  BackendAnalytics,
  BackendAuditLog,
  BackendDonation,
  BackendPlatformSettings,
  BackendPublicCampaign,
  BackendWithdrawal,
  mapAdminChurch,
  mapAnalytics,
  mapAuditLog,
  mapDonation,
  mapPlatformSettings,
  mapPublicCampaign,
  mapWithdrawal,
} from './mappers';

// D5 pagination guard — the standard shape for ALL super list reads. DRF returns
// { count, next, previous, results }. We surface:
//   items     = mapped rows for THIS page
//   total     = data.count (full server-side total)
//   truncated = data.next != null (there ARE more rows beyond this page)
// `truncated` drives a NOTICE banner on the screen, NEVER paging controls — real
// pagination (next/prev) is a later slice.
export interface Paginated<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

export const superadminService = {
  // Authed: GET /super/billing/ — the PlatformSettings singleton (platform fee % +
  // Growth/Parish tier prices). Uses the SHARED `api` instance (services/api.ts), so
  // it inherits the Bearer Authorization header AND the transparent 401
  // refresh-and-retry already proven on the treasurer reads — no new axios instance.
  //
  // The fee_percent / growth_price / parish_price SAVEs are the careful writes below
  // (saveFeePercent / saveGrowthPrice / saveParishPrice) — each a PARTIAL PATCH to
  // /super/billing/ that preserves the other two fields.
  async getBilling(): Promise<PlatformSettings> {
    const { data } = await api.get<BackendPlatformSettings>('/super/billing/');
    return mapPlatformSettings(data);
  },

  // Authed WRITE: PATCH /super/billing/ — persist fee_percent, the LIVE money-math
  // rate the STK callback reads at donation confirmation. fee_percent is a PERCENT
  // (send "2.5" for 2.5%), kept as a STRING end-to-end (no Number()). PARTIAL update:
  // sending ONLY fee_percent preserves growth_price/parish_price server-side. The 200
  // body is the full settings object — we map + return it so the screen re-seeds the
  // saved fee from server truth. Errors PROPAGATE (the screen surfaces the backend's
  // 0..10 bound 400, field-keyed under `fee_percent`).
  async saveFeePercent(feePercent: string): Promise<PlatformSettings> {
    const { data } = await api.patch<BackendPlatformSettings>(
      '/super/billing/', { fee_percent: feePercent });
    return mapPlatformSettings(data);
  },

  // Authed WRITE: PATCH /super/billing/ — persist growth_price. MIRRORS saveFeePercent
  // exactly: same endpoint, PARTIAL update (sending only growth_price preserves
  // fee_percent/parish_price server-side), money kept as a STRING end-to-end (NO
  // Number()). The 200 body is the full settings object — mapped + returned so the
  // screen re-seeds the saved price from SERVER TRUTH (the row sticks across reload).
  // Errors PROPAGATE: the screen surfaces the backend's field-keyed bound 400
  // ({"growth_price":[...]}, >0 and <=1,000,000) inline on the field. Unlike fee_percent
  // this rate is NOT read by donation processing — there is no subscription-charging
  // code yet, so changing it re-prices nobody (forward-only is moot until charging exists).
  async saveGrowthPrice(growthPrice: string): Promise<PlatformSettings> {
    const { data } = await api.patch<BackendPlatformSettings>(
      '/super/billing/', { growth_price: growthPrice });
    return mapPlatformSettings(data);
  },

  // Authed WRITE: PATCH /super/billing/ — persist parish_price. Same shape as
  // saveGrowthPrice; partial update preserves the other two fields; field-keyed 400
  // is {"parish_price":[...]}.
  async saveParishPrice(parishPrice: string): Promise<PlatformSettings> {
    const { data } = await api.patch<BackendPlatformSettings>(
      '/super/billing/', { parish_price: parishPrice });
    return mapPlatformSettings(data);
  },

  // Authed: GET /super/withdrawals/ — the platform-wide payouts list (ALL churches,
  // ALL statuses; cross-church by design, NOT church-scoped). Same shared `api`
  // instance. Returns the D5 Paginated shape. Reuses the EXISTING mapWithdrawal —
  // the very same mapper the treasurer payouts read uses (services/mappers.ts).
  //
  // READ ONLY: Force Retry / resolve-paid / resolve-retry are the money tier and are
  // NOT wired here — the screen's action controls stay local.
  async listWithdrawals(): Promise<Paginated<Withdrawal>> {
    const { data } = await api.get<PaginatedResponse<BackendWithdrawal>>('/super/withdrawals/');
    return {
      items: data.results.map(mapWithdrawal),
      total: data.count,
      truncated: data.next != null,
    };
  },

  // Authed: GET /super/campaigns/ — the platform-wide campaigns list (ALL churches,
  // ALL statuses; cross-church). Same shared `api`. Returns the D5 Paginated shape.
  // Reuses the EXISTING mapPublicCampaign, which reads only the public-allowlist keys
  // and therefore DROPS wallet_balance / treasurer_phone / treasurer_name at the FE
  // boundary even though AdminCampaignSerializer over-emits them (D1).
  //
  // READ ONLY: create / pause / resume / close are NOT wired here.
  async listCampaigns(): Promise<Paginated<PublicCampaign>> {
    const { data } = await api.get<PaginatedResponse<BackendPublicCampaign>>('/super/campaigns/');
    return {
      items: data.results.map(mapPublicCampaign),
      total: data.count,
      truncated: data.next != null,
    };
  },

  // Authed: GET /super/donations/ — the platform-wide donations table (ALL churches;
  // the authorized gross/fee/net surface, PRD §8.6). Same shared `api`. Returns the
  // D5 Paginated shape. Uses the NEW mapDonation strict allowlist, which drops
  // phone_number / donor_email / checkout_request_id at the FE boundary and keeps
  // null fee/net as null (D2).
  //
  // READ ONLY: there are no write actions on this surface.
  async listDonations(): Promise<Paginated<Donation>> {
    const { data } = await api.get<PaginatedResponse<BackendDonation>>('/super/donations/');
    return {
      items: data.results.map(mapDonation),
      total: data.count,
      truncated: data.next != null,
    };
  },

  // Authed: GET /super/churches/pending/ — the registration QUEUE (the PENDING
  // subset only; the backend already scopes to status=PENDING, so the screen must
  // NOT re-filter). Same shared `api`, D5 Paginated shape. Uses the shared
  // mapAdminChurch allowlist (drops rejection_reason / subscription_expires_at /
  // logo_url at the FE boundary).
  //
  // READ ONLY here. Approve (flips a church to ACTIVE) is still the write tier — NOT
  // wired. Reject IS wired — see rejectChurch() below (the first write helper).
  async listPendingChurches(): Promise<Paginated<Church>> {
    const { data } = await api.get<PaginatedResponse<BackendAdminChurch>>('/super/churches/pending/');
    return {
      items: data.results.map(mapAdminChurch),
      total: data.count,
      truncated: data.next != null,
    };
  },

  // Authed: GET /super/churches/ — the platform-wide Churches list (ALL churches,
  // every status; cross-church by design, NOT scoped). Same shared `api`, D5
  // Paginated shape. Reuses the shared mapAdminChurch allowlist, which now also
  // carries the S7a per-row aggregates (activeCampaignCount + totalRaised, NET) so
  // the row no longer derives them from mocks. Drops rejection_reason /
  // subscription_expires_at / logo_url at the FE boundary.
  //
  // READ ONLY: Suspend / Reinstate / tier-edit are the write tier — NOT wired here.
  async listChurches(): Promise<Paginated<Church>> {
    const { data } = await api.get<PaginatedResponse<BackendAdminChurch>>('/super/churches/');
    return {
      items: data.results.map(mapAdminChurch),
      total: data.count,
      truncated: data.next != null,
    };
  },

  // Authed: GET /super/analytics/ — a SINGLE pre-aggregated platform-totals object
  // (NO pagination, NO Paginated<T>). Same shared `api`. Returns the mapped summary
  // (4 headline numbers + count/net). The from/to date params the endpoint accepts
  // are NOT sent here — date-filtering is its own later slice.
  async getAnalytics(): Promise<AnalyticsSummary> {
    const { data } = await api.get<BackendAnalytics>('/super/analytics/');
    return mapAnalytics(data);
  },

  // Authed: GET /super/audit-log/ — the forensic action history (READ-ONLY surface;
  // the AuditLog model is immutable, no write endpoint). Same shared `api`, D5
  // Paginated shape. mapAuditLog drops ip_address at the FE boundary and flattens the
  // details JSON into the row's notes string (phones in details are pre-masked).
  async listAuditLog(): Promise<Paginated<AuditLog>> {
    const { data } = await api.get<PaginatedResponse<BackendAuditLog>>('/super/audit-log/');
    return {
      items: data.results.map(mapAuditLog),
      total: data.count,
      truncated: data.next != null,
    };
  },

  // Authed WRITE: POST /super/withdrawals/{id}/resolve-retry/ — NEEDS_RECONCILIATION
  // → FAILED (money-safe flip; no wallet, no Daraja). The 200 body is the SAME
  // WithdrawalSerializer used by listWithdrawals — we MAP and RETURN it so the screen
  // can do a server-truth row update (status now FAILED, retry_count 0, failure_reason
  // set, dispatch_outcome CLEAN_FAILURE). No body. Errors PROPAGATE: the screen handles
  // 400 "This payout is not awaiting reconciliation." as a stale-race + refetch.
  async resolveRetry(id: string): Promise<Withdrawal> {
    const { data } = await api.post<BackendWithdrawal>(
      `/super/withdrawals/${id}/resolve-retry/`,
    );
    return mapWithdrawal(data);
  },

  // Authed WRITE: POST /super/withdrawals/{id}/resolve-paid/ — NEEDS_RECONCILIATION
  // → PAID (pure ledger write; no Daraja dispatch, no poll). Body REQUIRES
  // `payout_reference` (the M-Pesa transaction code the admin verified off the
  // statement). The 200 body is the SAME WithdrawalSerializer — we MAP and RETURN it
  // so the screen can do a server-truth row update (status PAID, reference stored,
  // wallet decremented). Errors PROPAGATE: field-keyed 400 {"payout_reference":[...]}
  // for a bad/over-length reference; data.detail 400 for the wrong-status race.
  async resolvePaid(id: string, payoutReference: string): Promise<Withdrawal> {
    const { data } = await api.post<BackendWithdrawal>(
      `/super/withdrawals/${id}/resolve-paid/`,
      { payout_reference: payoutReference },
    );
    return mapWithdrawal(data);
  },

  // Authed WRITE: POST /super/withdrawals/{id}/force-retry/ — FAILED_FINAL →
  // re-dispatch (no body). FAILED_FINAL is provably never-sent (no dispatch_outcome
  // guard needed — confirmed by trace), so this is safe by construction. The 200 body
  // is the SAME WithdrawalSerializer used by listWithdrawals/resolveRetry: status
  // 'PROCESSING' (dispatch accepted — the screen must poll for the verdict) OR
  // 'FAILED' + dispatch_status 'failed_queued_for_retry' (synchronous dispatch
  // failure — no poll). We map + return it so the screen can do a server-truth row
  // update. Errors PROPAGATE (400 wrong-status / insufficient balance; the screen
  // decides).
  async forceRetry(id: string): Promise<Withdrawal> {
    const { data } = await api.post<BackendWithdrawal>(
      `/super/withdrawals/${id}/force-retry/`,
    );
    return mapWithdrawal(data);
  },

  // Authed WRITE: POST /super/churches/{id}/reject/ — PENDING → REJECTED (the FIRST
  // super write helper; the pattern for the writes to come). Body field is
  // `rejection_reason` (NOT `reason`); backend requires >=5 chars. Same shared `api`
  // instance → inherits the Bearer header AND the 401 refresh-and-retry.
  //
  // The 200 body is the over-emitting AdminChurchSerializer, but the rejected church
  // LEAVES the pending list, so the response has no consumer — we return void and do
  // NOT map it. Errors PROPAGATE (no catch here): the screen catches and decides
  // (400 "Only PENDING…" = someone else acted → refetch; field error = bad reason).
  async rejectChurch(id: string, reason: string): Promise<void> {
    await api.post(`/super/churches/${id}/reject/`, { rejection_reason: reason });
  },

  // Authed WRITE: POST /super/churches/{id}/approve/ — PENDING → ACTIVE (the second
  // super write helper; same shape as rejectChurch). This is a NO-BODY POST — the
  // backend reads nothing from the request body (no serializer, no fields), only the
  // {id} in the URL. Same shared `api` instance → inherits the Bearer header AND the
  // 401 refresh-and-retry.
  //
  // The 200 body is the over-emitting AdminChurchSerializer, but the approved church
  // LEAVES the pending list, so the response has no consumer — we return void and do
  // NOT map it. Errors PROPAGATE (no catch here): the screen catches and decides
  // (400 "Only PENDING…" = someone else acted → refetch).
  async approveChurch(id: string): Promise<void> {
    await api.post(`/super/churches/${id}/approve/`);
  },

  // Authed WRITE: POST /super/churches/{id}/suspend/ — ACTIVE → SUSPENDED. UNLIKE
  // approve/reject (where the row LEAVES the list and the response has no consumer),
  // the suspended church STAYS in the churches list and the open detail sheet must
  // reflect the new status — so we MAP and RETURN the 200 body. The backend accepts
  // an OPTIONAL {reason} body; this FE sends NONE (backend defaults reason to '').
  // mapAdminChurch drops the over-emitted D1 fields. Errors PROPAGATE (no catch).
  async suspendChurch(id: string): Promise<Church> {
    const { data } = await api.post<BackendAdminChurch>(`/super/churches/${id}/suspend/`);
    return mapAdminChurch(data);
  },

  // Authed WRITE: POST /super/churches/{id}/reactivate/ — SUSPENDED → ACTIVE. No-body
  // POST. Same as suspend: the church stays in the list and the open sheet flips, so
  // we MAP and RETURN the 200 body. Errors PROPAGATE.
  async reactivateChurch(id: string): Promise<Church> {
    const { data } = await api.post<BackendAdminChurch>(`/super/churches/${id}/reactivate/`);
    return mapAdminChurch(data);
  },

  // Authed WRITE: POST /super/churches/{id}/set-tier/ — assign the church's subscription
  // tier. Body { subscription_tier: '<FREE|GROWTH|PARISH>' } (same body-POST shape as
  // resolvePaid). MONEY-INERT: this flips ONLY the tier — no expiry/proration/refund/
  // charge exists yet (backend comment marks it as the pre-charging gate). The church
  // STAYS in the list and the open detail sheet must reflect the new tier, so we MAP and
  // RETURN the 200 body (mapAdminChurch drops the over-emitted D1 fields). Idempotent on
  // the backend (re-sending the current tier → 200 no-op). Errors PROPAGATE: field-keyed
  // 400 {"subscription_tier":[...]} for an invalid choice; data.detail 404 for a vanished
  // church. The screen surfaces them inline in the sheet.
  async setChurchTier(id: string, tier: SubscriptionTier): Promise<Church> {
    const { data } = await api.post<BackendAdminChurch>(
      `/super/churches/${id}/set-tier/`,
      { subscription_tier: tier },
    );
    return mapAdminChurch(data);
  },
};
