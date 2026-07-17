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
  // narrows to one campaign. The treasurer Reports → Donation History source.
  //
  // Paginated (page_size 20). Because the from/to/campaign filters are ALL applied
  // server-side, the envelope `count` IS the true total of matching rows — so we return
  // it as `total` alongside the (max-20) mapped `rows`. The screen can then show
  // "Showing 20 of {total}" when total > rows.length.
  async getMyDonations(params?: { from?: string; to?: string; campaign?: string }):
    Promise<{ total: number; rows: MyDonationRow[] }> {
    const { data } = await api.get<PaginatedResponse<BackendMyDonation>>(
      '/churches/me/donations/',
      { params },
    );
    return { total: data.count, rows: data.results.map(mapMyDonation) };
  },

  // Authed WEB download: GET /churches/me/donations/export/?format=csv — streams this
  // church's FULL SUCCESSFUL donation history as CSV (server-side, un-paginated, so the
  // >20-row cap of getMyDonations never truncates it). NET-only: gross / platform_fee /
  // phone are never emitted (same allowlist as mapMyDonation). The export takes NO date
  // filter — the backend streams the whole scoped set — so this is always the complete
  // history, independent of the on-screen date range.
  //
  // Uses the shared `api` instance (NOT raw fetch) so the Bearer token + 401
  // refresh-and-retry + baseURL apply exactly as for every other call; responseType
  // 'blob' because the body is CSV, not JSON. WEB ONLY: it triggers a browser download
  // via an object-URL anchor (document/URL are web globals) — the caller gates this off
  // on native (button disabled) until a native share-sheet slice. Errors PROPAGATE (the
  // caller shows a retry note). Filename honours the server Content-Disposition when that
  // header is CORS-exposed, else falls back to donations-<today>.csv.
  async downloadMyDonationsCsv(): Promise<void> {
    const response = await api.get('/churches/me/donations/export/', {
      params: { format: 'csv' },
      responseType: 'blob',
    });
    const blob = response.data as Blob;
    const disposition = (response.headers?.['content-disposition'] as string | undefined) ?? '';
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    const filename = match?.[1] ?? `donations-${new Date().toISOString().slice(0, 10)}.csv`;

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  },

  // Authed READ: GET /churches/me/donations/export/?format=pdf — the SAME full,
  // un-paginated, NET-only SUCCESSFUL-donation set as downloadMyDonationsCsv, but
  // rendered server-side as a PDF (reportlab). Identical mechanics: shared `api`
  // instance (Bearer + 401 refresh-and-retry + baseURL), responseType 'blob' (the
  // body is PDF bytes, not JSON), WEB ONLY (object-URL anchor). Errors PROPAGATE.
  // Filename honours Content-Disposition when CORS-exposed, else donations-<today>.pdf.
  async downloadMyDonationsPdf(): Promise<void> {
    const response = await api.get('/churches/me/donations/export/', {
      params: { format: 'pdf' },
      responseType: 'blob',
    });
    const blob = response.data as Blob;
    const disposition = (response.headers?.['content-disposition'] as string | undefined) ?? '';
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    const filename = match?.[1] ?? `donations-${new Date().toISOString().slice(0, 10)}.pdf`;

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
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
      // Platform-split: web MUST stay undefined so the browser sets the multipart
      // boundary; native MUST be explicit — RN's networking errors ERR_NETWORK
      // (request never sent) without it, and appends the boundary itself.
      headers: { 'Content-Type': Platform.OS === 'web' ? undefined : 'multipart/form-data' },
      transformRequest: (d) => d,                // don't let axios JSON-stringify the FormData
    });
    return mapMyChurch(data);
  },
};
