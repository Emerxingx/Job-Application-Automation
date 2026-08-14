/**
 * Connectors — pushing JobPilot events into third-party services.
 *
 * A connector differs from a webhook endpoint in who does the work. A webhook
 * says "here is a signed JSON body, you write the receiver". A connector says
 * "tell us your Slack channel and we will format the message for you". Same
 * events, different amount of work for the customer.
 *
 * WHAT IS ACTUALLY IMPLEMENTED, STATED PLAINLY
 * --------------------------------------------
 * Two of the four connectors below work end to end:
 *
 *   webhook   generic signed POST, identical signature scheme to
 *             src/lib/integrations/webhooks.ts
 *   zapier    the same POST with signing switched OFF, because Zapier catch
 *             hooks accept unauthenticated JSON and have nowhere to put a
 *             verification step
 *
 * Two are REGISTERED BUT NOT IMPLEMENTED, and say so at every point a caller
 * could ask:
 *
 *   slack             needs an OAuth app and a token store
 *   google_drive      "export to Google Sheets"; needs Google OAuth + Sheets API
 *   google_calendar   interview events; needs Google OAuth + Calendar API
 *
 * They are declared rather than deleted because the shape of the work is
 * genuinely known — the config fields below are the real fields each one needs
 * — and because a settings page that lists "Slack (coming soon)" is honest,
 * whereas a settings page that offers a Slack toggle which silently does
 * nothing is a bug report waiting to happen. `implemented: false` is checked by
 * `deliverToConnector`, so there is no path through this module where an
 * unimplemented connector reports success. Their `deliver` also returns
 * `unavailable` directly, so the honesty does not depend on one call site
 * remembering to check a flag.
 *
 * The prerequisite blocking all three is the same one the schema calls out:
 * `Integration.accessToken` is documented as encrypted at rest, and this
 * codebase has no encryption helper and no key-rotation story. Storing a
 * customer's Google refresh token in plaintext to make a demo work would be a
 * worse outcome than the feature not existing.
 */

import { z } from 'zod';
import { db } from '../db';
import { parseJson } from '../types';
import {
  WEBHOOK_API_VERSION,
  WEBHOOK_TIMEOUT_MS,
  fetchTransport,
  isSuccessStatus,
  signatureHeader,
  validateWebhookUrl,
  type WebhookTransport,
} from './webhooks';

// --- The interface ----------------------------------------------------------

/**
 * Connector identifiers. These are written to `Integration.provider`, which is
 * `@@unique([userId, provider])`, so one row per user per connector — and
 * renaming one orphans every existing row.
 */
export const CONNECTOR_IDS = ['webhook', 'zapier', 'slack', 'google_drive', 'google_calendar'] as const;

export type ConnectorId = (typeof CONNECTOR_IDS)[number];

export function isConnectorId(value: unknown): value is ConnectorId {
  return typeof value === 'string' && (CONNECTOR_IDS as readonly string[]).includes(value);
}

/** One field a customer fills in to configure a connector. */
export interface ConnectorConfigField {
  name: string;
  label: string;
  type: 'url' | 'text' | 'secret' | 'boolean';
  required: boolean;
  help: string;
}

/** What a connector is handed when asked to deliver. */
export interface ConnectorContext {
  userId: string;
  /** The parsed, validated `Integration.config` JSON. */
  config: Record<string, unknown>;
  now: Date;
  transport: WebhookTransport;
}

export interface ConnectorEvent {
  id: string;
  type: string;
  occurredAt: Date;
  data: Record<string, unknown>;
}

/**
 * Why a delivery did not happen. `unconfigured` and `unavailable` are kept
 * apart on purpose: the first is the customer's to fix, the second is ours, and
 * a UI that conflates them tells someone to go re-enter a URL that was never
 * the problem.
 */
export type ConnectorFailureKind = 'unconfigured' | 'unavailable' | 'error';

export type ConnectorResult =
  | { ok: true; detail: string; responseStatus?: number }
  | { ok: false; kind: ConnectorFailureKind; message: string; responseStatus?: number };

export type ConnectorConfigValidation =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; message: string };

export interface Connector {
  id: ConnectorId;
  label: string;
  description: string;
  /**
   * False means every `deliver` returns `unavailable`. This is a fact about the
   * deployment, surfaced to the settings UI, not a feature flag to flip on
   * without writing the code behind it.
   */
  implemented: boolean;
  /** What this connector would do with an event, in one line, for the UI. */
  capability: string;
  configFields: readonly ConnectorConfigField[];
  validateConfig(raw: unknown): ConnectorConfigValidation;
  /** Whether a stored config is complete enough to attempt a delivery. */
  isConfigured(config: Record<string, unknown>): boolean;
  deliver(context: ConnectorContext, event: ConnectorEvent): Promise<ConnectorResult>;
}

// --- Generic webhook (fully implemented) ------------------------------------

const genericWebhookSchema = z.object({
  url: z.string().min(1, 'A destination URL is required.'),
  /**
   * Optional. When present, deliveries carry a `JobPilot-Signature` header
   * built by exactly the same code as the first-class webhook endpoints, so the
   * verification recipe in webhooks.ts applies unchanged.
   */
  secret: z.string().min(16, 'A signing secret must be at least 16 characters.').optional(),
  /** Extra headers, e.g. an API token the destination expects. */
  headers: z.record(z.string()).optional(),
});

/**
 * The reference connector. Everything a third-party integration needs —
 * validation, signing, transport, response classification — happens here and
 * nowhere else, so a future Slack implementation has a worked example to copy
 * rather than a blank interface to guess at.
 */
export const genericWebhookConnector: Connector = {
  id: 'webhook',
  label: 'Custom webhook',
  description:
    'POST every subscribed event as signed JSON to a URL you control. The same signature scheme as first-class webhook endpoints.',
  implemented: true,
  capability: 'Sends a signed JSON POST per event.',
  configFields: [
    {
      name: 'url',
      label: 'Destination URL',
      type: 'url',
      required: true,
      help: 'Must be https in production and must point at a public host.',
    },
    {
      name: 'secret',
      label: 'Signing secret',
      type: 'secret',
      required: false,
      help: 'At least 16 characters. When set, deliveries carry a JobPilot-Signature header you can verify.',
    },
    {
      name: 'headers',
      label: 'Extra headers',
      type: 'text',
      required: false,
      help: 'JSON object of additional headers, e.g. an Authorization value your endpoint expects.',
    },
  ],

  validateConfig(raw) {
    const parsed = genericWebhookSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid configuration.' };
    }
    // Reuse the endpoint URL guard rather than writing a second, weaker one —
    // the SSRF surface is identical and it must not be possible to reach a
    // metadata service through the connector that the webhook form blocks.
    const url = validateWebhookUrl(parsed.data.url);
    if (!url.ok) return { ok: false, message: url.message };

    return {
      ok: true,
      config: {
        url: parsed.data.url,
        ...(parsed.data.secret ? { secret: parsed.data.secret } : {}),
        ...(parsed.data.headers ? { headers: parsed.data.headers } : {}),
      },
    };
  },

  isConfigured(config) {
    return typeof config.url === 'string' && config.url.length > 0;
  },

  async deliver(context, event) {
    const url = typeof context.config.url === 'string' ? context.config.url : '';
    if (!url) {
      return { ok: false, kind: 'unconfigured', message: 'No destination URL is configured.' };
    }

    const body = JSON.stringify({
      id: event.id,
      type: event.type,
      apiVersion: WEBHOOK_API_VERSION,
      occurredAt: event.occurredAt.toISOString(),
      data: event.data,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'JobPilot-Connectors/1.0',
      'JobPilot-Event': event.type,
      'JobPilot-Event-Id': event.id,
      'JobPilot-Api-Version': WEBHOOK_API_VERSION,
    };

    const extra = context.config.headers;
    if (extra && typeof extra === 'object') {
      for (const [name, value] of Object.entries(extra as Record<string, unknown>)) {
        // Never let configured headers overwrite the signature or content type:
        // a customer who typo'd a header name must not be able to strip the
        // authenticity of their own deliveries.
        const lower = name.toLowerCase();
        if (lower === 'content-type' || lower.startsWith('jobpilot-')) continue;
        if (typeof value === 'string') headers[name] = value;
      }
    }

    const secret = typeof context.config.secret === 'string' ? context.config.secret : '';
    if (secret) {
      const timestampSeconds = Math.floor(context.now.getTime() / 1000);
      headers['JobPilot-Signature'] = signatureHeader(secret, timestampSeconds, body);
    }

    try {
      const response = await context.transport({
        url,
        body,
        headers,
        timeoutMs: WEBHOOK_TIMEOUT_MS,
      });
      if (isSuccessStatus(response.status)) {
        return { ok: true, detail: `Delivered (${response.status}).`, responseStatus: response.status };
      }
      return {
        ok: false,
        kind: 'error',
        message: `Destination answered ${response.status}.`,
        responseStatus: response.status,
      };
    } catch (error) {
      return {
        ok: false,
        kind: 'error',
        message: error instanceof Error ? error.message : 'Delivery failed.',
      };
    }
  },
};

/**
 * Zapier catch hooks are a generic webhook with the signature turned off:
 * Zapier's "Catch Hook" trigger accepts any JSON POST and offers no place to
 * run an HMAC check, so signing it would produce a header nobody can verify and
 * imply a guarantee that does not exist.
 */
export const zapierConnector: Connector = {
  ...genericWebhookConnector,
  id: 'zapier',
  label: 'Zapier',
  description: 'POST every subscribed event to a Zapier "Catch Hook" URL. Unsigned — Zapier cannot verify signatures.',
  capability: 'Sends an unsigned JSON POST per event to a Zapier catch hook.',
  configFields: [
    {
      name: 'url',
      label: 'Catch Hook URL',
      type: 'url',
      required: true,
      help: 'From Zapier: create a Zap, choose "Webhooks by Zapier" → "Catch Hook", and copy the URL it gives you.',
    },
  ],
  validateConfig(raw) {
    const result = genericWebhookConnector.validateConfig(raw);
    if (!result.ok) return result;
    // Drop any secret: signing is meaningless here and storing a secret we
    // never use would misrepresent what the connector does.
    const { url } = result.config;
    return { ok: true, config: { url } };
  },
};

// --- Registered, not implemented --------------------------------------------

/**
 * Build a connector that is honest about not existing yet.
 *
 * The config fields are real — they are what the implementation will need — so
 * the settings UI can be built and reviewed now. `deliver` always fails with
 * `unavailable` and a message that names the missing prerequisite, so a caller
 * gets a reason rather than a silent no-op.
 */
function unimplementedConnector(spec: {
  id: ConnectorId;
  label: string;
  description: string;
  capability: string;
  blockedBy: string;
  configFields: readonly ConnectorConfigField[];
}): Connector {
  const message = `${spec.label} delivery is registered but not implemented in this deployment: ${spec.blockedBy}`;
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    implemented: false,
    capability: spec.capability,
    configFields: spec.configFields,
    // Configuration is refused rather than stored. Accepting and persisting
    // settings for a connector that cannot run would leave a row that looks
    // connected in every listing and never delivers anything.
    validateConfig: () => ({ ok: false, message }),
    isConfigured: () => false,
    deliver: async () => ({ ok: false, kind: 'unavailable', message }),
  };
}

export const slackConnector = unimplementedConnector({
  id: 'slack',
  label: 'Slack',
  description: 'Post a formatted message to a Slack channel when an application is submitted or a job matches.',
  capability: 'Would post a Block Kit message per event.',
  blockedBy:
    'no Slack OAuth app is registered, and Integration.accessToken has no encryption helper to store a bot token in.',
  configFields: [
    { name: 'channelId', label: 'Channel', type: 'text', required: true, help: 'The Slack channel to post into.' },
    {
      name: 'mentionOnOffer',
      label: 'Mention me on an offer',
      type: 'boolean',
      required: false,
      help: 'Adds an @-mention when an application reaches the offer stage.',
    },
  ],
});

export const googleSheetsConnector = unimplementedConnector({
  id: 'google_drive',
  label: 'Google Sheets',
  description: 'Append every application to a spreadsheet, so the whole search lives in one sheet you can filter.',
  capability: 'Would append one row per application to a sheet.',
  blockedBy:
    'no Google OAuth client is configured, and refresh tokens cannot be stored until Integration.refreshToken has encryption at rest.',
  configFields: [
    { name: 'spreadsheetId', label: 'Spreadsheet', type: 'text', required: true, help: 'The Google Sheets file to append to.' },
    { name: 'sheetName', label: 'Tab name', type: 'text', required: false, help: 'Defaults to the first tab.' },
  ],
});

export const calendarConnector = unimplementedConnector({
  id: 'google_calendar',
  label: 'Google Calendar',
  description: 'Create a calendar event when an application reaches the interviewing stage.',
  capability: 'Would create a calendar event per interview.',
  blockedBy:
    'no Google OAuth client is configured, and the interview date is not captured anywhere yet — Application.respondedAt records that an employer replied, not when the interview is.',
  configFields: [
    { name: 'calendarId', label: 'Calendar', type: 'text', required: true, help: 'Which calendar to write events into.' },
    {
      name: 'reminderMinutes',
      label: 'Reminder',
      type: 'text',
      required: false,
      help: 'Minutes before the interview to fire a reminder. Defaults to 60.',
    },
  ],
});

// --- Registry ---------------------------------------------------------------

export const CONNECTORS: Record<ConnectorId, Connector> = {
  webhook: genericWebhookConnector,
  zapier: zapierConnector,
  slack: slackConnector,
  google_drive: googleSheetsConnector,
  google_calendar: calendarConnector,
};

export function getConnector(id: string): Connector | null {
  return isConnectorId(id) ? CONNECTORS[id] : null;
}

/** The catalogue, in the order the settings page should list it. */
export function listConnectors(): Connector[] {
  return CONNECTOR_IDS.map((id) => CONNECTORS[id]);
}

/** The connector catalogue in a shape that is safe to serialise to a client. */
export interface ConnectorSummary {
  id: ConnectorId;
  label: string;
  description: string;
  capability: string;
  implemented: boolean;
  configFields: readonly ConnectorConfigField[];
}

export function describeConnector(connector: Connector): ConnectorSummary {
  return {
    id: connector.id,
    label: connector.label,
    description: connector.description,
    capability: connector.capability,
    implemented: connector.implemented,
    configFields: connector.configFields,
  };
}

// --- Persistence ------------------------------------------------------------

/**
 * An `Integration` row as the owner may see it.
 *
 * `accessToken`, `refreshToken` and the raw `config` are absent by
 * construction: config can hold a signing secret, and a settings page that
 * echoes secrets back turns any XSS or shoulder-surf into a credential leak.
 * `configuredFields` tells the UI which fields are set without revealing what
 * they are set to.
 */
export interface SafeIntegration {
  id: string;
  provider: string;
  label: string;
  implemented: boolean;
  status: string;
  displayName: string;
  configuredFields: string[];
  lastSyncAt: Date | null;
  lastError: string | null;
  errorCount: number;
  connectedAt: Date | null;
  revokedAt: Date | null;
}

export function toSafeIntegration(row: {
  id: string;
  provider: string;
  status: string;
  displayName: string;
  config: string;
  lastSyncAt: Date | null;
  lastError: string | null;
  errorCount: number;
  connectedAt: Date | null;
  revokedAt: Date | null;
}): SafeIntegration {
  const connector = getConnector(row.provider);
  const config = parseJson<Record<string, unknown>>(row.config, {});
  return {
    id: row.id,
    provider: row.provider,
    label: connector?.label ?? row.provider,
    implemented: connector?.implemented ?? false,
    status: row.status,
    displayName: row.displayName,
    configuredFields: Object.keys(config).filter((key) => config[key] !== undefined && config[key] !== ''),
    lastSyncAt: row.lastSyncAt,
    lastError: row.lastError,
    errorCount: row.errorCount,
    connectedAt: row.connectedAt,
    revokedAt: row.revokedAt,
  };
}

/** A user's connected integrations, safe to serialise. */
export async function listIntegrations(userId: string): Promise<SafeIntegration[]> {
  const rows = await db.integration.findMany({ where: { userId }, orderBy: { provider: 'asc' } });
  return rows.map(toSafeIntegration);
}

/**
 * Store (or replace) a connector's configuration.
 *
 * Validation happens through the connector, which is why an unimplemented one
 * cannot be configured: its `validateConfig` refuses unconditionally.
 */
export async function connectIntegration(
  userId: string,
  providerId: string,
  rawConfig: unknown,
  displayName?: string,
): Promise<{ ok: true; integration: SafeIntegration } | { ok: false; message: string }> {
  const connector = getConnector(providerId);
  if (!connector) return { ok: false, message: `Unknown connector: ${providerId}` };

  const validated = connector.validateConfig(rawConfig);
  if (!validated.ok) return { ok: false, message: validated.message };

  const now = new Date();
  const row = await db.integration.upsert({
    where: { userId_provider: { userId, provider: connector.id } },
    create: {
      userId,
      provider: connector.id,
      status: 'connected',
      displayName: displayName ?? connector.label,
      config: JSON.stringify(validated.config),
      connectedAt: now,
      errorCount: 0,
    },
    update: {
      status: 'connected',
      displayName: displayName ?? connector.label,
      config: JSON.stringify(validated.config),
      connectedAt: now,
      revokedAt: null,
      lastError: null,
      errorCount: 0,
    },
  });

  return { ok: true, integration: toSafeIntegration(row) };
}

/**
 * Disconnect. The row is kept rather than deleted so the history of "this was
 * connected, then it was not" survives, and so reconnecting does not lose the
 * error counters that explain why someone turned it off.
 */
export async function disconnectIntegration(
  userId: string,
  providerId: string,
): Promise<SafeIntegration | null> {
  const existing = await db.integration.findUnique({
    where: { userId_provider: { userId, provider: providerId } },
  });
  if (!existing) return null;

  const row = await db.integration.update({
    where: { id: existing.id },
    data: {
      status: 'disconnected',
      revokedAt: new Date(),
      // Credentials are cleared on disconnect, not retained "in case they
      // reconnect". A disconnected integration holding a live token is a
      // credential nobody is watching.
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      config: '{}',
    },
  });
  return toSafeIntegration(row);
}

/**
 * Send one event through one of a user's connected integrations.
 *
 * The `implemented` guard is here as well as inside each unimplemented
 * connector's `deliver`. That is duplication on purpose: it means adding a
 * connector by copying the interface, and forgetting to make `deliver` fail,
 * still cannot produce a false success.
 */
export async function deliverToConnector(
  userId: string,
  providerId: string,
  event: ConnectorEvent,
  options: { transport?: WebhookTransport; now?: Date } = {},
): Promise<ConnectorResult> {
  const connector = getConnector(providerId);
  if (!connector) return { ok: false, kind: 'error', message: `Unknown connector: ${providerId}` };
  if (!connector.implemented) {
    return {
      ok: false,
      kind: 'unavailable',
      message: `${connector.label} is registered but not implemented in this deployment.`,
    };
  }

  const row = await db.integration.findUnique({
    where: { userId_provider: { userId, provider: connector.id } },
  });
  if (!row || row.status !== 'connected') {
    return { ok: false, kind: 'unconfigured', message: `${connector.label} is not connected.` };
  }

  const config = parseJson<Record<string, unknown>>(row.config, {});
  if (!connector.isConfigured(config)) {
    return { ok: false, kind: 'unconfigured', message: `${connector.label} is missing required settings.` };
  }

  const now = options.now ?? new Date();
  const result = await connector.deliver(
    { userId, config, now, transport: options.transport ?? fetchTransport },
    event,
  );

  // Record the outcome so the settings page can show a failing integration
  // instead of looking healthy while dropping every event.
  await db.integration
    .update({
      where: { id: row.id },
      data: result.ok
        ? { lastSyncAt: now, lastError: null, errorCount: 0 }
        : { lastError: result.message, errorCount: { increment: 1 }, status: 'error' },
    })
    .catch((error) => console.warn('[connectors] could not record outcome:', error));

  return result;
}
