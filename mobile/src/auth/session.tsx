/**
 * The session: the device key, the profile it belongs to, and the one API
 * client every screen uses. Sign-in mints the key (POST /v1/auth/sessions),
 * sign-out revokes it (DELETE /v1/auth/sessions/current) and wipes the
 * device - key and cache - whether or not the server could be reached.
 *
 * A 401 from any call ends the session on the spot: the server has said the
 * key is gone (revoked from another device, expired, password changed) and
 * the app never argues with that.
 */
import Constants from 'expo-constants';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { ApiClient, PATHS, type DeviceSignIn, type Me } from '@/api/client';
import { OfflineCache } from '@/api/cache';
import { defaultStore } from '@/api/file-store';
import { ApiError } from '@/api/errors';
import { apiBaseUrl, assertTransportSecure } from '@/config';
import { describeDevice } from './device';
import { defaultTokenStorage, type TokenStorage } from './storage';

export type SessionStatus = 'loading' | 'signed_out' | 'signed_in';

export interface Session {
  status: SessionStatus;
  me: Me | null;
  /** False until the applicant completed onboarding on the web; the app shows what is left. */
  onboarded: boolean;
  client: ApiClient;
  cache: OfflineCache;
  storage: TokenStorage;
  signIn(input: { email: string; password: string }): Promise<void>;
  signOut(): Promise<void>;
  refreshMe(): Promise<void>;
  setMe(me: Me): void;
  /** The last reason the session ended, for the sign-in screen to explain. */
  endedBecause: string | null;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children, storage: storageOverride, client: clientOverride, cache: cacheOverride }: { children: React.ReactNode; storage?: TokenStorage; client?: ApiClient; cache?: OfflineCache }) {
  const storage = useMemo(() => storageOverride ?? defaultTokenStorage(), [storageOverride]);
  const cache = useMemo(() => cacheOverride ?? new OfflineCache(defaultStore(Platform.OS)), [cacheOverride]);
  const tokenRef = useRef<string | null>(null);
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [me, setMeState] = useState<Me | null>(null);
  const [onboarded, setOnboarded] = useState(true);
  const [endedBecause, setEndedBecause] = useState<string | null>(null);

  const endSession = useCallback(
    async (reason: string | null) => {
      tokenRef.current = null;
      setMeState(null);
      setStatus('signed_out');
      setEndedBecause(reason);
      await Promise.allSettled([storage.clear(), cache.clear()]);
    },
    [storage, cache],
  );

  const client = useMemo(() => {
    if (clientOverride) return clientOverride;
    const baseUrl = apiBaseUrl();
    assertTransportSecure(baseUrl, __DEV__);
    return new ApiClient({
      baseUrl,
      token: () => tokenRef.current,
      onUnauthorized: (error: ApiError) => {
        if (tokenRef.current) void endSession(error.message === 'Not signed in.' ? null : 'Your session ended: the device key was revoked or expired.');
      },
    });
  }, [clientOverride, endSession]);

  const refreshMe = useCallback(async () => {
    const next = await client.me();
    setMeState(next);
  }, [client]);

  // Restore on launch: the key from secure storage, then the profile. If the
  // server is unreachable the session still opens (offline read-only); if
  // the server refuses the key, onUnauthorized ends it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await storage.get().catch(() => null);
      if (cancelled) return;
      if (!token) {
        setStatus('signed_out');
        return;
      }
      tokenRef.current = token;
      setStatus('signed_in');
      try {
        await refreshMe();
      } catch (error) {
        if (error instanceof ApiError && error.unauthorized) return; // ended by onUnauthorized
        const cached = await cache.read<Me>(PATHS.me);
        if (cached && !cancelled) setMeState(cached.body);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storage, cache, refreshMe]);

  const signIn = useCallback(
    async ({ email, password }: { email: string; password: string }) => {
      const body: DeviceSignIn = { method: 'password', email: email.trim(), password, device: describeDevice(Platform.OS, Constants.deviceName) };
      const issued = await client.signIn(body);
      tokenRef.current = issued.token;
      await storage.set(issued.token);
      setMeState(issued.me);
      setOnboarded(issued.onboarded);
      setEndedBecause(null);
      setStatus('signed_in');
    },
    [client, storage],
  );

  const signOut = useCallback(async () => {
    try {
      if (tokenRef.current) await client.signOut();
    } catch {
      // Offline or already revoked: the device is wiped regardless; the server
      // side is revoked by expiry, by the next password change, or from the web.
    } finally {
      await endSession(null);
    }
  }, [client, endSession]);

  const value = useMemo<Session>(
    () => ({ status, me, onboarded, client, cache, storage, signIn, signOut, refreshMe, setMe: setMeState, endedBecause }),
    [status, me, onboarded, client, cache, storage, signIn, signOut, refreshMe, endedBecause],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside SessionProvider');
  return session;
}
