/**
 * Session engineering constants (SPEC §05). Centralized — screens never
 * hard-code countdowns. Tests may inject smaller values via ConnectionOptions.
 */
export const SESSION_CONSTANTS = {
  /** Approval wait follows the host-issued request deadline (30 s). */
  connectTimeoutMs: 30_000,
  /** Bounded reconnect: up to 3 attempts with 1/2/4-second delays. */
  reconnectDelaysMs: [1_000, 2_000, 4_000],
  /** Requester-side status polling while awaiting approval. */
  approvalPollMs: 1_000,
} as const
