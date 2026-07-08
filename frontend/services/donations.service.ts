import { api } from './api';
import { BackendDonationStatus, DonorDonationStatus, mapDonorStatus } from './mappers';

// Backend initiate body (snake_case on the wire). campaign_slug is a SLUG (not id);
// phone "07.."/"01.." is accepted and normalized to 254.. server-side; amount >= 5.
interface InitiatePayload {
  campaign_slug: string;
  phone_number: string;
  amount: number;
  donor_name?: string;
  donor_email?: string;
}

interface BackendInitiateResponse {
  donation_id: string;
  checkout_request_id: string | null;
  status: string;                 // 'PENDING' at this point — the STK prompt was SENT
}

export interface InitiateResult {
  donationId: string;
  checkoutRequestId: string | null;
  status: string;
}

export const donationsService = {
  // PUBLIC (AllowAny; throttled 10/h per phone): POST /donations/initiate/. A 200
  // means the STK prompt was SENT (status PENDING) — NOT that money moved. The donor
  // still has to enter their PIN; the caller MUST poll getDonationStatus for the
  // verdict and NEVER treat this 200 as success. Errors PROPAGATE so the form can
  // distinguish 502 (never queued) / 429 (throttle) / 400 / 404.
  async initiate(payload: InitiatePayload): Promise<InitiateResult> {
    const { data } = await api.post<BackendInitiateResponse>('/donations/initiate/', payload);
    return {
      donationId: data.donation_id,
      checkoutRequestId: data.checkout_request_id,
      status: data.status,
    };
  },

  // PUBLIC (AllowAny; NOT throttled): GET /donations/{donationId}/status/. Lookup by
  // the donation_id returned from initiate. amount is GROSS (string → Number), receipt
  // is null until a SUCCESSFUL verdict. This is the poll the form drives to the truth.
  async getDonationStatus(donationId: string): Promise<DonorDonationStatus> {
    const { data } = await api.get<BackendDonationStatus>(`/donations/${donationId}/status/`);
    return mapDonorStatus(data);
  },
};
