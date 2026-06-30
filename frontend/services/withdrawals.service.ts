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
  async list(params?: { campaign?: string }): Promise<Withdrawal[]> {
    const { data } = await api.get<PaginatedResponse<BackendWithdrawal>>('/withdrawals/', { params });
    return data.results.map(mapWithdrawal);
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
