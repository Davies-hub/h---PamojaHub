import React, { createContext, useContext, useState } from 'react';

// Single source of truth for the (super) Queue tab badge — the count of PENDING
// church registration applications (NOT the NEEDS_RECONCILIATION withdrawal queue).
//
// SHAPE (anti-drift): the count lives in ONE place both the always-mounted (super)
// tab layout (the badge READER) and the on-visit Queue screen (the sole WRITER) can
// read. The Queue screen writes data.total on every fetch (incl. post-approve/reject
// retries); the badge reads it. There is NO second fetch — the badge never fetches.
//
// `pendingCount` is `number | null`: null = not yet known (no fetch has landed). The
// badge renders nothing until the first real count arrives — it is NEVER seeded from
// mock, so a stale/fake number can't flash before live truth.
interface PendingQueueState {
  pendingCount: number | null;
  setPendingCount: (count: number) => void;
}

const PendingQueueContext = createContext<PendingQueueState | null>(null);

export function PendingQueueProvider({ children }: { children: React.ReactNode }) {
  // Raw useState setter is referentially stable across renders, so the Queue screen
  // can safely list it in its effect deps without re-subscribing every render.
  const [pendingCount, setPendingCount] = useState<number | null>(null);

  return React.createElement(
    PendingQueueContext.Provider,
    { value: { pendingCount, setPendingCount } },
    children
  );
}

export function usePendingQueue() {
  const ctx = useContext(PendingQueueContext);
  if (!ctx) throw new Error('usePendingQueue must be inside PendingQueueProvider');
  return ctx;
}
