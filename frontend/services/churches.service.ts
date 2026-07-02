import { Platform } from 'react-native';
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

  // Authed WRITE: POST /churches/me/logo/ (multipart) — upload the treasurer's OWN
  // church logo. Self-scoped server-side (church = request.user.church; no id in the
  // URL/body). The wire field name is 'file' (churches/views.py request.FILES.get('file')).
  // The 200 body is AdminChurchSerializer ('__all__') with the server-set logo_url, so we
  // map it via mapMyChurch and the caller reflects server truth. Errors PROPAGATE (axios
  // throws): a 400 carries {"detail": ...} from the DoS/content gate (too large / bad
  // format / re-encode reject) the screen surfaces; a 403 = suspended church.
  //
  // Cross-platform FormData: on WEB the picker uri is a blob/data URL — it MUST be
  // fetched into a real Blob or the multipart body is empty; on NATIVE RN's FormData
  // uploads the {uri,name,type} triple directly. The instance default Content-Type is
  // JSON, so we blank it here to let the platform set the multipart boundary, and
  // pass-through transformRequest so axios doesn't JSON-stringify the FormData.
  async uploadLogo(asset: { uri: string; fileName?: string; mimeType?: string }): Promise<Church> {
    const form = new FormData();
    const name = asset.fileName || 'logo.jpg';
    const type = asset.mimeType || 'image/jpeg';
    if (Platform.OS === 'web') {
      const blob = await (await fetch(asset.uri)).blob();
      form.append('file', blob, name);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      form.append('file', { uri: asset.uri, name, type } as any);
    }
    const { data } = await api.post<BackendMyChurch>('/churches/me/logo/', form, {
      headers: { 'Content-Type': undefined },   // CRITICAL: platform sets the multipart boundary
      transformRequest: (d) => d,                // don't let axios JSON-stringify the FormData
    });
    return mapMyChurch(data);
  },
};
