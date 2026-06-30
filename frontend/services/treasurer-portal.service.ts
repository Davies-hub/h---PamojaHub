import { PortalCampaign, Withdrawal } from '../types';
import { api } from './api';
import { portalClient } from './portalClient';
import {
  BackendPortalCampaign,
  BackendPortalDonation,
  BackendWithdrawal,
  mapPortalCampaign,
  mapPortalDonation,
  mapWithdrawal,
  PortalDonationRow,
} from './mappers';

interface VerifyOtpResponse {
  portal_token: string;
  campaigns: BackendPortalCampaign[];
}

export const treasurerPortalService = {
  // PUBLIC (AllowAny) — safe on the SHARED `api`: returns 200/400/429/502, never a
  // hijackable 401. Uniform 200 for known AND unknown phones (anti-enumeration) — the
  // caller must NOT branch on known/unknown. Throws on non-2xx so the screen maps
  // status → message.
  async requestOtp(phone: string): Promise<void> {
    await api.post('/treasurer/request-otp/', { phone_number: phone });
  },

  // PUBLIC (AllowAny) — also safe on `api`. Body key is otp_code (NOT otp). Maps the
  // verify response: portal_token (raw string — held in screen memory only) + the scoped
  // campaigns (snake→camel, strict per-field via mapPortalCampaign).
  async verifyOtp(
    phone: string,
    otpCode: string,
  ): Promise<{ portalToken: string; campaigns: PortalCampaign[] }> {
    const { data } = await api.post<VerifyOtpResponse>('/treasurer/verify-otp/', {
      phone_number: phone,
      otp_code: otpCode,
    });
    return {
      portalToken: data.portal_token,
      campaigns: (data.campaigns ?? []).map(mapPortalCampaign),
    };
  },

  // PORTAL-TOKEN call → MUST use portalClient (no JWT interceptor) so a dead-token 401
  // reaches the screen's auth-loss chokepoint untouched. Report is paginated server-side
  // ({ results }); we return the mapped (NET-only) rows.
  //
  // TOKEN HEADER: we send `Authorization: Portal <raw>` (a scheme HasValidPortalToken
  // supports and tests — test_authorization_portal_scheme_also_accepted) RATHER than the
  // X-Portal-Token header. WHY: on web, X-Portal-Token is a non-default header that the
  // backend's CORS allowlist does not include, so the browser BLOCKS it at preflight
  // ("x-portal-token is not allowed by Access-Control-Allow-Headers"). `authorization` IS
  // in django-cors-headers' default allowlist, so the Portal scheme passes preflight with
  // zero backend change. It does NOT collide with the JWT `Authorization: Bearer` — this is
  // the no-interceptor portalClient, which attaches no Bearer.
  async getCampaignReport(
    campaignId: string,
    portalToken: string,
    params?: { from?: string; to?: string },
  ): Promise<PortalDonationRow[]> {
    const { data } = await portalClient.get<{ results: BackendPortalDonation[] }>(
      `/treasurer/campaigns/${campaignId}/report/`,
      { params, headers: { Authorization: `Portal ${portalToken}` } },
    );
    return (data.results ?? []).map(mapPortalDonation);
  },

  // PORTAL-TOKEN call → portalClient (same reason + same Authorization: Portal scheme as
  // getCampaignReport) so a dead-token 401 reaches the screen's auth-loss chokepoint.
  // The 201 body is a WithdrawalSerializer row — map it (snake→camel, money via Number())
  // and return it so the screen can append the REAL pending row (id/createdAt/amount) with
  // no refetch (a PENDING_APPROVAL request moves no money — wallet unchanged until PAID).
  async requestDisbursement(
    campaignId: string,
    portalToken: string,
    data: { amount: number; reason: string },
  ): Promise<Withdrawal> {
    const { data: created } = await portalClient.post<BackendWithdrawal>(
      `/treasurer/campaigns/${campaignId}/request-disbursement/`,
      data,
      { headers: { Authorization: `Portal ${portalToken}` } },
    );
    return mapWithdrawal(created);
  },
};
