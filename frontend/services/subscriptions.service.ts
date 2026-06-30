import { SubscriptionTier } from '../types';
import { SubscriptionPollVerdict } from '../utils/subscription';
import { api } from './api';
import { BackendSubscriptionStatus, mapSubscriptionStatus } from './mappers';

// Backend initiate body (snake_case on the wire). tier ∈ {GROWTH, PARISH} (FREE rejected
// server-side). phone_number is REQUIRED — the M-Pesa number to charge (07xx/01xx or a
// 254XXXXXXXXX form; the backend normalizes). There is NO User.phone fallback, so the
// renew flow always collects+sends it. Clones donations.service.ts initiate.
interface InitiatePayload {
  tier: SubscriptionTier;
  phone_number: string;
}

interface BackendInitiateResponse {
  subscription_payment_id: string;
  checkout_request_id: string | null;
  status: string;                 // 'PENDING' at this point — the STK prompt was SENT
}

export interface SubscriptionInitiateResult {
  subscriptionPaymentId: string;
  checkoutRequestId: string | null;
  status: string;
}

export const subscriptionsService = {
  // AUTHED (IsChurchTreasurer): POST /subscriptions/initiate/. A 200 means the STK prompt
  // was SENT (status PENDING) — NOT that the subscription is active. The callback (a later
  // slice) confirms it; the poll is NOT built yet, so the caller just shows "check your
  // phone" on 200. Errors PROPAGATE so the card can classify 502 (never queued) / 429
  // (throttle) / 400 (validation — incl. phone required/invalid — or the Parish→Growth
  // down-pay block).
  async initiate(payload: InitiatePayload): Promise<SubscriptionInitiateResult> {
    const { data } = await api.post<BackendInitiateResponse>('/subscriptions/initiate/', payload);
    return {
      subscriptionPaymentId: data.subscription_payment_id,
      checkoutRequestId: data.checkout_request_id,
      status: data.status,
    };
  },

  // AUTHED (IsChurchTreasurer, own church only): GET /subscriptions/{id}/status/. The
  // renew pay-and-watch poll target (clone of donationsService.getDonationStatus). Returns
  // the payment status + tier + the church's CURRENT expiry + a backend-derived `stale`
  // flag. The card polls this for the M-Pesa PIN verdict; a 404 (someone else's payment /
  // gone) propagates and is treated as a non-terminal blip by the poll loop.
  async getStatus(paymentId: string): Promise<SubscriptionPollVerdict> {
    const { data } = await api.get<BackendSubscriptionStatus>(`/subscriptions/${paymentId}/status/`);
    return mapSubscriptionStatus(data);
  },

  // AUTHED (IsChurchTreasurer): POST /subscriptions/cancel/. Flag-only opt-out from
  // auto-renew — keeps paid time, suppresses reminders, lapses normally at grace end.
  // Idempotent server-side (already-cancelled → 200 no-op). Errors PROPAGATE.
  async cancel(): Promise<void> {
    await api.post('/subscriptions/cancel/', {});
  },
};
