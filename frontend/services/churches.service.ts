import { Church, PaginatedResponse, PublicChurch } from '../types';
import { api } from './api';
import {
  BackendMyChurch,
  BackendMyDonation,
  BackendPublicChurch,
  MyChurchUpdatePayload,
  MyDonationRow,
  mapMyChurch,
  mapMyDonation,
  mapPublicChurch,
  toMyChurchUpdateRequest,
} from './mappers';

export type { MyChurchUpdatePayload } from './mappers';

export const churchesService = {
  // PARAMS: search (name), county (iexact), denomination (iexact) — all supported
  // by the backend list. Returns PublicChurch (the public allowlist subset).
  async browse(params?: { search?: string; county?: string; denomination?: string; page?: number }):
    Promise<PaginatedResponse<PublicChurch>> {
    const { data } = await api.get<PaginatedResponse<BackendPublicChurch>>('/churches/', { params });
    return {
      count: data.count,
      next: data.next,
      previous: data.previous,
      results: data.results.map(mapPublicChurch),
    };
  },

  async getById(id: string): Promise<PublicChurch> {
    // Public detail = the PublicChurch allowlist subset (NO address/phone/email/status).
    // A 404 (nonexistent OR non-ACTIVE church) propagates so the screen shows a
    // distinct not-found state.
    const { data } = await api.get<BackendPublicChurch>(`/churches/${id}/`);
    return mapPublicChurch(data);
  },

  // Authed: GET /churches/me/ — the requesting treasurer's OWN church (gated
  // IsChurchTreasurer; the api interceptor attaches the Bearer token + 401 refresh-and-
  // retry, and the backend scopes to request.user.church — no church-id in the URL).
  // Clones the dashboardService.getStats /churches/me/stats/ pattern. Returns a Church
  // that KEEPS subscriptionExpiresAt (via mapMyChurch, not mapAdminChurch) so the
  // settings subscription card can derive its lifecycle state. Errors PROPAGATE.
  async getMyChurch(): Promise<Church> {
    const { data } = await api.get<BackendMyChurch>('/churches/me/');
    return mapMyChurch(data);
  },

  // Authed: PATCH /churches/me/ — partial-update the treasurer's OWN church profile.
  // Sends ONLY the 6 writable fields (toMyChurchUpdateRequest); read-only fields
  // (email/status/tier/expiry/cancel-flag) are never in the body. The backend
  // normalizes phone (07→254) and re-validates — the mapped response (mapMyChurch) is
  // server truth, so the screen reflects exactly what was stored. Errors PROPAGATE:
  // a 400 carries field-keyed messages (e.g. {"phone": [...]}) the form surfaces, and
  // a 403 (ChurchNotSuspended, a suspended church) becomes a general error.
  async updateMyChurch(payload: MyChurchUpdatePayload): Promise<Church> {
    const { data } = await api.patch<BackendMyChurch>(
      '/churches/me/',
      toMyChurchUpdateRequest(payload),
    );
    return mapMyChurch(data);
  },

  // Authed: GET /churches/me/donations/ — this church's full SUCCESSFUL donation history
  // (church-scoped server-side; cross-church rows never leak). NET-only rows (mapMyDonation:
  // gross / platform_fee / phone are dropped by the serializer). Optional from/to are
  // YYYY-MM-DD and applied server-side with a date-INCLUSIVE end (a 23:30 donation on `to`
  // is returned); a malformed date → backend 400 (propagates). Optional campaign (UUID)
  // narrows to one campaign. Paginated; returns the mapped results array. The treasurer
  // Reports → Donation History source.
  async getMyDonations(params?: { from?: string; to?: string; campaign?: string }):
    Promise<MyDonationRow[]> {
    const { data } = await api.get<PaginatedResponse<BackendMyDonation>>(
      '/churches/me/donations/',
      { params },
    );
    return data.results.map(mapMyDonation);
  },
};
