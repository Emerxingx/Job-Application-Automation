# JobPilot candidate mobile app

Stage 14 (ADR-0013, ADR-0028). An Expo / React Native / TypeScript client for
candidates that consumes **only** the frozen candidate API contract in
`../docs/api/openapi.candidate.v1.json` (version 1.1.0). It is a separate npm
package with its own lockfile and toolchain; the root project's lint,
typecheck and build exclude it, and CI runs its gates in their own job.

## What it does

Sign in with the account's email and password (a device key is minted and kept
in the platform's secure storage), then:

| Screen | Contract operations |
| --- | --- |
| Jobs (recommendations), saved jobs | `listRecommendations`, `listSavedJobs`, `saveJob`, `unsaveJob` |
| Job detail with the eligibility verdict rule by rule | `getJob` |
| Why this match: dimensions, matched / missing, cited evidence | `getMatchAnalysis` |
| Applications: waiting for review first, then every folder | `listApplications` |
| Folder: prepared fields and answers for review, documents (signed link), history, contacts, interviews, follow-ups; **confirm** ("I submitted it on the employer's form") and **submit** (instructed, Review & submit mode, authorised board only) | `getApplication`, `confirmApplication`, `submitApplication`, `createDocumentLink` |
| Interviews | `listInterviews` |
| Activity (notifications, pull to refresh) | `listNotifications` |
| You: profile summary, edit (name, city, headline, application mode), career evidence read-only, your numbers, privacy & consent, signed-in devices, sign out | `getMe`, `updateMe`, `listEvidence`, `getAnalyticsSummary`, `listConsents`, `setConsent`, `listDeviceSessions`, `revokeDeviceSession`, `revokeCurrentDeviceSession` |

The one contract path the app does not call is the ATS ruleset lookup (it is
for the automation engine, not a phone); `tests/contract-parity.test.ts`
asserts exactly that.

## What it deliberately does not do

- **No automatic submission of any kind.** The two writes that reach an
  employer are the applicant's own confirmation and their instructed
  submission after review (ADR-0016, Stage 12). Nothing is queued offline.
- **No document editing, billing, agents, employer or admin surfaces**
  (ADR-0013 keeps them on the web).
- **No push notifications** (ADR-0011 is pending; the Activity tab is pull).
- **No biometric unlock and no certificate pinning yet** - both need a config
  plugin / a native module and a device to prove them on; listed as NOT
  IMPLEMENTED in the Stage 14 evidence rather than claimed.
- **No identity-provider sign-in in the UI.** The contract supports the
  Supabase method; no deployment has a provider configured, so the screen
  offers password sign-in only and says so.
- **Web is a build gate, not a product**: in a browser the key is kept in
  memory only (no secure storage in a tab).

## Security posture

- The device key is an `ApiKey` of kind `device`, scope `write` (read +
  apply:write, never admin), expiring after 90 days; it is revocable from the
  app, from the web sessions page, by a password change and by "sign out
  everywhere else". At most 10 devices; the least recently used is recycled.
- Stored with `expo-secure-store` (Keychain / Keystore, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`).
  Never AsyncStorage (a test refuses the import).
- A 401 ends the session immediately and wipes the key and the cache.
- Release builds refuse a plain-http API base URL.
- The offline cache holds only allow-listed GET bodies (`src/api/cache.ts`),
  never a write, a device list or a signed link; it is labelled on screen with
  its age and cleared on sign-out.
- No secret is in the bundle; `EXPO_PUBLIC_API_BASE_URL` is the only setting
  and it is public by definition.

## Accessibility

Every control has a role and a label, touch targets are at least 44 points,
font scaling is left on, list rows are single accessible elements, alerts and
the offline banner are live regions, and the colour tokens meet WCAG 2.2 AA
contrast in light and dark themes - computed by `tests/theme.test.ts`, not
asserted by hand. Screen-reader and device-level checks are NOT VERIFIED in
this environment (no device or emulator); see the Stage 14 evidence.

## Deterministic build and test

```bash
cd mobile
npm ci                       # from mobile/package-lock.json
npm run api:types            # regenerate src/api/schema.d.ts from the contract (committed; CI diffs it)
npm run typecheck            # tsc --noEmit, strict
npm test                     # node:test via tsx: client, cache policy, contract parity, format, contrast
npm run export:web           # Metro bundles the whole app for web into dist/ - the compile gate
npm run verify               # all of the above
```

Running on a device or simulator (not possible in the build environment):

```bash
EXPO_PUBLIC_API_BASE_URL=https://your-deployment.example npm start   # then press i / a, or scan with Expo Go
```

Expo Go supports every module used here (expo-router, expo-secure-store,
expo-file-system, expo-constants, expo-linking). A store build needs
`npx expo prebuild` / EAS, which is a founder action with Apple and Google
accounts and is outside this repository.

## Layout

```
app/                      expo-router screens (file = route)
  _layout.tsx             SessionProvider + root stack
  index.tsx               launch redirect
  sign-in.tsx, onboarding.tsx
  (app)/_layout.tsx       signed-in stack (guard)
  (app)/(tabs)/           Jobs · Applications · Interviews · Activity · You
  (app)/jobs/[jobId]      (app)/matches/[matchId]   (app)/applications/[applicationId]
  (app)/saved             (app)/profile/{edit,privacy,devices,evidence,analytics}
src/api/                  schema.d.ts (generated), client.ts, errors.ts, cache.ts, file-store.ts
src/auth/                 session.tsx, storage.ts (secure store / memory), device.ts
src/hooks/use-query.ts    fetch → cache fallback, one behaviour for every screen
src/ui/                   tokens.ts (contrast-checked), theme.ts, components.tsx
tests/                    node:test suites (no device needed)
```
