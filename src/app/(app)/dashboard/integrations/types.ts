/**
 * The serialisable shapes that cross from the /dashboard/integrations server
 * page into its client islands.
 *
 * Dates arrive pre-formatted as strings. That is not laziness — a client
 * component renders once on the server and again in the browser, and
 * `toLocaleDateString` in the second pass can disagree with the first when the
 * two run in different timezones. Formatting once, on the server, removes the
 * whole class of hydration mismatch.
 *
 * Secrets never appear in any type here. An API key's raw value and a webhook's
 * signing secret exist only in the response body of the request that created
 * them, are shown once, and are never re-fetched.
 */

export interface ApiKeyView {
  id: string;
  name: string;
  /** `jp_live_8f3a2b1c…` — the prefix, which is all we can ever show again. */
  masked: string;
  environment: string;
  scopes: string[];
  rateLimitPerMinute: number;
  requestCount: number;
  createdLabel: string;
  lastUsedLabel: string;
  expiresLabel: string | null;
  revoked: boolean;
  revokedLabel: string | null;
}

export interface DeliveryView {
  id: string;
  eventType: string;
  /** pending | succeeded | failed | exhausted | skipped */
  status: string;
  responseStatus: number | null;
  durationMs: number;
  whenLabel: string;
  errorMessage: string | null;
}

export interface WebhookView {
  id: string;
  url: string;
  description: string;
  events: string[];
  /** active | paused | disabled */
  status: string;
  apiVersion: string;
  consecutiveFailures: number;
  disabledReason: string | null;
  createdLabel: string;
  lastSuccessLabel: string | null;
  lastFailureLabel: string | null;
  /** Attempts still waiting for the sender. */
  pendingDeliveries: number;
  /** Most recent attempts, newest first. */
  deliveries: DeliveryView[];
}

export interface EventOption {
  type: string;
  description: string;
}

export interface ScopeOption {
  value: string;
  label: string;
  description: string;
}
