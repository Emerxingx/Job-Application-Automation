import { fail, route } from '../api';
import { ApplicationStateError } from './service';

/** Stage 10 — the shared wrapper for folder routes: a state refusal is a clean 4xx with its reason, never a 500. */
export function folderRoute<Args extends unknown[]>(handler: (...args: Args) => Promise<Response>): (...args: Args) => Promise<Response> {
  return route(async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof ApplicationStateError) return fail(error.message, error.status);
      throw error;
    }
  });
}
