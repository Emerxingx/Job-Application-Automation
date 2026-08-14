/**
 * Thin client for the first-party integrations API.
 *
 * The page talks to the routes under `/api/integrations` rather than to Server
 * Actions of its own. Those routes already exist, already rate-limit the two
 * operations that make outbound requests, and are the same surface a
 * command-line user hits — a second implementation living in this folder would
 * be one more place for "test a webhook" to mean something slightly different.
 *
 * Every route in the codebase is built on `route()` from src/lib/api.ts, so a
 * failure always arrives as `{ error: string }` with a real HTTP status. This
 * helper turns that into a value instead of an exception, so callers render the
 * server's own message rather than a generic one.
 */

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function callApi<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers:
        init?.body === undefined
          ? init?.headers
          : { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
  }

  // A 204 or an empty body is a success with nothing to read.
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `Something went wrong (HTTP ${response.status}).`;
    return { ok: false, error: message };
  }

  return { ok: true, data: (payload ?? {}) as T };
}
