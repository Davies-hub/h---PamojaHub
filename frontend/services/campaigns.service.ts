import { Platform } from 'react-native';
import { PaginatedResponse, PublicCampaign, TreasurerCampaign } from '../types';
import { api } from './api';
import {
  BackendPublicCampaign,
  BackendTreasurerCampaign,
  mapPublicCampaign,
  mapTreasurerCampaign,
} from './mappers';

// Writable-fields-only create input (camelCase). The backend SERVER-FORCES
// church / created_by / status=ACTIVE / raised=0 / wallet=0 and auto-generates the
// slug — those are never sent. group_label / document_url are optional and
// OMITTED when empty ("no group" is church-wide). banner_image_url is NOT here:
// it is server-set-only (read_only at the serializer) — banners are added via
// uploadBanner() on the campaign detail screen AFTER creation.
// goal_amount stays a STRING on the wire (DRF DecimalField).
export interface CreateCampaignInput {
  title: string;
  description: string;
  goalAmount: string;
  category: string;
  treasurerName: string;
  treasurerPhone: string;
  groupLabelId?: string | null;
  documentUrl?: string;
}

export const campaignsService = {
  // PARAMS: search (title), category (exact), church (by id). NOT county — the
  // backend campaign list ignores it (only churches filter by county).
  async browse(params?: { search?: string; category?: string; church?: string; page?: number }):
    Promise<PaginatedResponse<PublicCampaign>> {
    const { data } = await api.get<PaginatedResponse<BackendPublicCampaign>>('/campaigns/', { params });
    // Map snake→camel + decimal-string→number; keep the pagination envelope.
    return {
      count: data.count,
      next: data.next,
      previous: data.previous,
      results: data.results.map(mapPublicCampaign),
    };
  },

  // Authed: GET /campaigns/mine/ — the treasurer's own campaigns (church-scoped
  // server-side). Paginated; we return the mapped results array.
  // PARAMS: from/to are inclusive YYYY-MM-DD created_at bounds (server-side, so
  // the date filter is correct past page 1). group_label is the GroupLabel FK id
  // (server-side exact filter) — the caller sources the id from groupsService.list()
  // ({id,name}); the FE campaign model still doesn't surface the id, so the filter
  // is driven by the groups list, not the campaign rows.
  async listMine(params?: { from?: string; to?: string; group_label?: string }): Promise<TreasurerCampaign[]> {
    const { data } = await api.get<PaginatedResponse<BackendTreasurerCampaign>>(
      '/campaigns/mine/', { params });
    return data.results.map(mapTreasurerCampaign);
  },

  // Authed: GET /campaigns/mine/ — same endpoint as listMine(), but returns the
  // paginated TOTAL alongside the mapped page rows ({ total, rows }), mirroring
  // withdrawalsService.listWithTotal / churchesService.getMyDonations. `total` is
  // data.count = the post-filter, church-scoped total: the backend applies from/to
  // AND group_label (and search/status) to the queryset BEFORE paginating, so the
  // count is honest for whatever filters are passed. Only the Reports screen needs
  // the total (for a "Showing N of M" banner); listMine() keeps its bare-array shape
  // for its three callers (reports list, overview index, campaigns/index).
  async listMineWithTotal(params?: { from?: string; to?: string; group_label?: string }):
    Promise<{ total: number; rows: TreasurerCampaign[] }> {
    const { data } = await api.get<PaginatedResponse<BackendTreasurerCampaign>>(
      '/campaigns/mine/', { params });
    return { total: data.count, rows: data.results.map(mapTreasurerCampaign) };
  },

  // Authed: GET /campaigns/mine/{slug}/ — the treasurer's own SINGLE campaign,
  // SLUG-keyed (AdminCampaignSerializer '__all__' → has wallet_balance + goal_amount
  // + donor_count, all NET). Church-scoped server-side (cross-church slug → 403 via
  // ChurchScopedPermission; non-existent → 404). A 4xx PROPAGATES (axios throws) so
  // the detail screen can show a distinct not-found state. Single object, not paginated.
  async getMine(slug: string): Promise<TreasurerCampaign> {
    const { data } = await api.get<BackendTreasurerCampaign>(`/campaigns/mine/${slug}/`);
    return mapTreasurerCampaign(data);
  },

  // Authed WRITE: POST /campaigns/mine/create/ — create a campaign for the
  // treasurer's own church. Body is the camel→snake of the WRITABLE fields only.
  // The 201 is AdminCampaignSerializer ('__all__') incl. the server-allocated slug;
  // we map it via mapTreasurerCampaign (the slug drives navigation to the detail).
  // 400s PROPAGATE (axios throws) so the screen surfaces them — both DRF field-error
  // shapes ({"goal_amount":[...]}, {"treasurer_phone":[...]}, ...) AND business-rule
  // {"detail": ...} (FREE-tier cap, cross-church group label).
  async create(input: CreateCampaignInput): Promise<TreasurerCampaign> {
    const body: Record<string, unknown> = {
      title: input.title,
      description: input.description,
      goal_amount: input.goalAmount,   // STRING on the wire (DecimalField)
      category: input.category,
      treasurer_name: input.treasurerName,
      treasurer_phone: input.treasurerPhone,
    };
    // group_label: send the id, or OMIT entirely for "no group / church-wide".
    if (input.groupLabelId) body.group_label = input.groupLabelId;
    // document: optional; OMIT when empty (no URL collected yet).
    if (input.documentUrl) body.document_url = input.documentUrl;

    const { data } = await api.post<BackendTreasurerCampaign>('/campaigns/mine/create/', body);
    return mapTreasurerCampaign(data);
  },

  // Authed WEB download: GET /campaigns/mine/export/?format=csv — streams this
  // church's FULL campaign list as CSV (server-side, un-paginated, so the 20-row
  // page cap of listMine() never truncates it). PII-safe: treasurer_phone /
  // treasurer_name are never emitted; columns are Title / Group / Goal (KES) /
  // Raised (KES) / Wallet Balance (KES) / Status / Created (all amounts NET). The
  // export takes NO date/group filter — the backend streams the whole scoped set —
  // so it is always the complete list, independent of the on-screen filters.
  //
  // Mirrors withdrawalsService.downloadPayoutsCsv EXACTLY: uses the shared `api`
  // instance (Bearer token + 401 refresh-and-retry + baseURL apply), responseType
  // 'blob' because the body is CSV. WEB ONLY: triggers a browser download via an
  // object-URL anchor (document/URL are web globals) — the caller gates this off on
  // native. Errors PROPAGATE. Filename honours the server Content-Disposition when
  // that header is CORS-exposed, else falls back to campaigns-<today>.csv.
  async downloadCampaignsCsv(): Promise<void> {
    const response = await api.get('/campaigns/mine/export/', {
      params: { format: 'csv' },
      responseType: 'blob',
    });
    const blob = response.data as Blob;
    const disposition = (response.headers?.['content-disposition'] as string | undefined) ?? '';
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    const filename = match?.[1] ?? `campaigns-${new Date().toISOString().slice(0, 10)}.csv`;

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  },

  // Authed WEB download: GET /campaigns/mine/export/?format=pdf — the SAME full,
  // un-paginated, PII-safe campaign set as downloadCampaignsCsv, but rendered
  // server-side as a PDF (reportlab). Identical mechanics: shared `api` instance
  // (Bearer + 401 refresh-and-retry + baseURL), responseType 'blob' (the body is PDF
  // bytes, not JSON), WEB ONLY (object-URL anchor). Errors PROPAGATE. Filename honours
  // Content-Disposition when CORS-exposed, else falls back to campaigns-<today>.pdf.
  async downloadCampaignsPdf(): Promise<void> {
    const response = await api.get('/campaigns/mine/export/', {
      params: { format: 'pdf' },
      responseType: 'blob',
    });
    const blob = response.data as Blob;
    const disposition = (response.headers?.['content-disposition'] as string | undefined) ?? '';
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    const filename = match?.[1] ?? `campaigns-${new Date().toISOString().slice(0, 10)}.pdf`;

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  },

  async getBySlug(slug: string): Promise<PublicCampaign> {
    // The detail response carries an extra `updates` key; the screen doesn't render
    // updates, so mapPublicCampaign simply ignores it. A 404 propagates (axios throws)
    // so the screen can show a distinct not-found state.
    const { data } = await api.get<BackendPublicCampaign>(`/campaigns/${slug}/`);
    return mapPublicCampaign(data);
  },

  // Authed WRITE: POST /campaigns/mine/{slug}/banner/ (multipart) — upload/replace
  // the banner for an OWNED campaign. Mirrors churchesService.uploadLogo EXACTLY.
  // The wire field name is 'file' (campaigns/views.py request.FILES.get('file')).
  // The 200 body is AdminCampaignSerializer with the server-set banner_image_url,
  // so we map via mapTreasurerCampaign and the caller reflects server truth.
  // Errors PROPAGATE (axios throws): a 400 carries {"detail": ...} from the
  // DoS/content gate (too large / bad format / re-encode reject / closed campaign);
  // a 403 = suspended church or cross-church slug.
  //
  // Cross-platform FormData: on WEB the picker uri is a blob/data URL — it MUST be
  // fetched into a real Blob or the multipart body is empty; on NATIVE RN's FormData
  // uploads the {uri,name,type} triple directly. The instance default Content-Type is
  // JSON, so we blank it here to let the platform set the multipart boundary, and
  // pass-through transformRequest so axios doesn't JSON-stringify the FormData.
  async uploadBanner(
    slug: string,
    asset: { uri: string; fileName?: string; mimeType?: string },
  ): Promise<TreasurerCampaign> {
    const form = new FormData();
    const name = asset.fileName || 'banner.jpg';
    const type = asset.mimeType || 'image/jpeg';
    if (Platform.OS === 'web') {
      const blob = await (await fetch(asset.uri)).blob();
      form.append('file', blob, name);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      form.append('file', { uri: asset.uri, name, type } as any);
    }
    const { data } = await api.post<BackendTreasurerCampaign>(
      `/campaigns/mine/${slug}/banner/`, form, {
        headers: { 'Content-Type': undefined },   // CRITICAL: platform sets the multipart boundary
        transformRequest: (d) => d,                // don't let axios JSON-stringify the FormData
      });
    return mapTreasurerCampaign(data);
  },

  // Authed WRITE: POST /campaigns/mine/{slug}/pause/ — ACTIVE → PAUSED. No-body POST,
  // SLUG-keyed. The 200 body is AdminCampaignSerializer but the screen re-syncs from a
  // list refetch rather than the single response, so we return void and don't map it.
  // Errors PROPAGATE (no catch): the screen catches and decides (400 wrong-status =
  // someone else acted → refetch).
  async pauseCampaign(slug: string): Promise<void> {
    await api.post(`/campaigns/mine/${slug}/pause/`);
  },

  // Authed WRITE: POST /campaigns/mine/{slug}/resume/ — PAUSED → ACTIVE. Same shape.
  async resumeCampaign(slug: string): Promise<void> {
    await api.post(`/campaigns/mine/${slug}/resume/`);
  },

  // Authed WRITE: POST /campaigns/mine/{slug}/close/ — ACTIVE|PAUSED → CLOSED
  // (terminal). No-body, slug-keyed. The backend's in-flight-money guard may return
  // 400 ("…withdrawal in progress…"); that detail propagates like any other and the
  // screen surfaces it. Response not mapped; the list re-syncs via refetch.
  async closeCampaign(slug: string): Promise<void> {
    await api.post(`/campaigns/mine/${slug}/close/`);
  },
};
