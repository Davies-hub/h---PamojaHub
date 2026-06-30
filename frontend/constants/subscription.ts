// Subscription-lifecycle thresholds (days), shared by the treasurer subscription card.
//
// SOURCE OF TRUTH IS THE BACKEND. These mirror the Django settings/jobs:
//   SUBSCRIPTION_GRACE_DAYS         ← settings.SUBSCRIPTION_GRACE_DAYS (config/settings/base.py)
//   SUBSCRIPTION_EXPIRING_SOON_DAYS ← the 7-day renewal-reminder milestone (churches/tasks.py)
// If either changes on the backend, update it here too (and vice-versa) — the two MUST
// agree, or the card will claim a standing the backend is about to revoke.

// A paid church whose subscription_expires_at is older than now − GRACE_DAYS is lapsed
// to FREE by the backend lapse job. Inside that window the card shows IN_GRACE.
export const SUBSCRIPTION_GRACE_DAYS = 7;

// A paid subscription within this many days of expiry is flagged EXPIRING_SOON (reuses
// the backend's 7-day renewal-reminder window).
export const SUBSCRIPTION_EXPIRING_SOON_DAYS = 7;

// Renew pay-and-watch poll bound — clone of the donation poll (DonationForm.tsx). After a
// 200 from /subscriptions/initiate/ the card polls /subscriptions/{id}/status/ for the
// M-Pesa PIN verdict: every INTERVAL ms, up to MAX_ATTEMPTS (~30s ceiling) before falling
// back to the honest 'unconfirmed' terminal rather than spinning forever on a PENDING.
export const SUBSCRIPTION_POLL_INTERVAL_MS = 3000;
export const SUBSCRIPTION_POLL_MAX_ATTEMPTS = 10;
