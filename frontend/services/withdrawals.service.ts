import { PaginatedResponse, Withdrawal } from '../types';
import { api } from './api';
import { BackendWithdrawal, mapWithdrawal } from './mappers';

export const withdrawalsService = {
  // Authed: GET /withdrawals/ — the treasurer's payouts across their campaigns
  // (church-scoped server-side). Paginated; returns the mapped results array.
  //
  // Optional `campaign` filter (UUID, NOT slug) narrows to ONE campaign's payout
  // history server-side (?campaign={id}). The base queryset is already
  // campaign__church=request.user.church, so passing a FOREIGN campaign id returns
  // empty, never a leak. Used by the treasurer campaign-detail history section.
  //
  // Optional `from`/`to` (YYYY-MM-DD, date-INCLUSIVE) filter by created date
  // server-side (?from=&to=), mirroring getMyDonations — used by the Reports screen
  // so the date range is applied by the backend, not re-filtered client-side.
  async list(params?: { campaign?: string; from?: string; to?: string }): Promise<Withdrawal[]> {
    const { data } = await api.get<PaginatedResponse<BackendWithdrawal>>('/withdrawals/', { params });
    return data.results.map(mapWithdrawal);
  },

  // Authed: GET /withdrawals/ — same endpoint as list(), but returns the paginated
  // TOTAL alongside the mapped page rows ({ total, rows }), mirroring
  // churchesService.getMyDonations. `total` is data.count = the post-filter,
  // church-scoped total (confirmed backend-honest), so the Reports screen can render
  // an honest "Showing N of M" truncation banner. list() keeps its bare-array shape
  // for its three non-reports callers; only Reports needs the total.
  async listWithTotal(params?: { campaign?: string; from?: string; to?: string }):
    Promise<{ total: number; rows: Withdrawal[] }> {
    const { data } = await api.get<PaginatedResponse<BackendWithdrawal>>('/withdrawals/', { params });
    return { total: data.count, rows: data.results.map(mapWithdrawal) };
  },

  // Authed WEB download: GET /withdrawals/export/?format=csv — streams this church's
  // FULL payout history as CSV (server-side, un-paginated, so the 20-row page cap of
  // list() never truncates it). Phone-safe: destination/requested phone are never
  // emitted; columns are Date / Amount (KES) / Status / Reference. The export takes
  // NO date filter — the backend streams the whole scoped set — so it is always the
  // complete history, independent of the on-screen date range.
  //
  // Mirrors churchesService.downloadMyDonationsCsv EXACTLY: uses the shared `api`
  // instance (Bearer token + 401 refresh-and-retry + baseURL apply), responseType
  // 'blob' because the body is CSV. WEB ONLY: triggers a browser download via an
  // object-URL anchor (document/URL are web globals) — the caller gates this off on
  // native. Errors PROPAGATE. Filename honours the server Content-Disposition when
  // that header is CORS-exposed, else falls back to payouts-<today>.csv.
  async downloadPayoutsCsv(): Promise<void> {
    const response = await api.get('/withdrawals/export/', {
      params: { format: 'csv' },
      responseType: 'blob',
    });
    const blob = response.data as Blob;
    const disposition = (response.headers?.['content-disposition'] as string | undefined) ?? '';
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    const filename = match?.[1] ?? `payouts-${new Date().toISOString().slice(0, 10)}.csv`;

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  },

  // Authed WEB download: GET /withdrawals/export/?format=pdf — the SAME full,
  // un-paginated, phone-safe payout set as downloadPayoutsCsv, but rendered
  // server-side as a PDF (reportlab). Identical mechanics: shared `api` instance
  // (Bearer + 401 refresh-and-retry + baseURL), responseType 'blob' (the body is PDF
  // bytes, not JSON), WEB ONLY (object-URL anchor). Errors PROPAGATE. Filename honours
  // Content-Disposition when CORS-exposed, else falls back to payouts-<today>.pdf.
  async downloadPayoutsPdf(): Promise<void> {
    const response = await api.get('/withdrawals/export/', {
      params: { format: 'pdf' },
      responseType: 'blob',
    });
    const blob = response.data as Blob;
    const disposition = (response.headers?.['content-disposition'] as string | undefined) ?? '';
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    const filename = match?.[1] ?? `payouts-${new Date().toISOString().slice(0, 10)}.pdf`;

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  },

  // Authed: POST /withdrawals/{id}/approve/ — NO body (the backend pays the phone/
  // amount STORED on the row; nothing client-supplied is honored). The 200 carries
  // EITHER status "PROCESSING" (B2C dispatch accepted; verdict comes async via the
  // callback) or status "FAILED" + dispatch_status "failed_queued_for_retry" (the
  // dispatch failed synchronously). Never PAID on this response.
  async approve(id: string): Promise<Withdrawal> {
    const { data } = await api.post<BackendWithdrawal>(`/withdrawals/${id}/approve/`);
    return mapWithdrawal(data);
  },

  async reject(id: string, reason: string): Promise<Withdrawal> {
    const { data } = await api.post<BackendWithdrawal>(
      `/withdrawals/${id}/reject/`,
      { rejection_reason: reason },
    );
    return mapWithdrawal(data);
  },

  // Authed: POST /withdrawals/{id}/retry/ — NO body. Same response shape as approve:
  // status "PROCESSING" (dispatch accepted, verdict comes async via callback) or
  // status "FAILED" + dispatch_status "failed_queued_for_retry" (synchronous dispatch
  // failure). Never PAID on this response.
  async retry(id: string): Promise<Withdrawal> {
    const { data } = await api.post<BackendWithdrawal>(`/withdrawals/${id}/retry/`);
    return mapWithdrawal(data);
  },
};
