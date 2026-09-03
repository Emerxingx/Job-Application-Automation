# Stage 09 — Resume, cover letter and document engine — evidence

Recorded 2026-09-03 on branch `claude/stage-09-document-engine` ([PR #21](https://github.com/Emerxingx/Job-Application-Automation/pull/21), draft), stacked on
Stage 08 (PR #20) → 07 (#19) → 06 (#18) → 05 (#17) → 04 (#16) → 03 (#15) →
02 (#14) → 01 (#13, PARTIAL). Every line was run or read; nothing is PASS on
the strength of a mock, a skipped test or a document. This stage's honest
centre: **every document is a hashed, versioned file in three formats; a
submitted version is immutable by the database and byte-reproducible or
refused; messages are grounded like every other generated text; uploads are
scanned structurally — and no antivirus engine exists in this environment,
which the register says.**

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 09: truthful, ATS-safe, versioned documents
with immutable submitted copies. DOCX alongside PDF; `document_versions`
with content hashing; cover letters, application messages, recruiter
introductions, outreach, follow-ups, thank-you notes — all evidence-
grounded; the exact submitted version retained immutably. Security:
documents private by default, access via signed expiring URLs, server-side
scanning for uploads. Testing: regression goldens, ATS-parse validation, a
test proving a submitted version can never be mutated. Acceptance: any
submitted document is byte-reproducible from storage. Exit gate: DOCX + PDF
live; versions immutable. Gap G-16.

## 2. Schema and migrations — `PASS` locally; `NOT VERIFIED` on Supabase (R-34, inherited)

| Migration | Content | Rehearsal |
| --- | --- | --- |
| `20260903170000_document_versions` | `DocumentVersion` (owner, scope — an application, `job:<id>` or `general` —, kind, format, version, status, SHA-256 content hash, size, storage key, evidence ids, AiRun id, ATS report, scan report, sealed-at; unique per owner × scope × kind × format × version); `User.documentVersions`, `Application.documents`; the **immutability trigger** `document_version_guard_immutable` (BEFORE UPDATE: any change to a submitted row raises; BEFORE DELETE: a direct delete of a submitted row raises — `pg_trigger_depth() <= 1` — while a referential cascade from the owner's `User` row passes) | applied fresh and incrementally; drift clean |
| `20260903170100_rls_document_table` | Generated (manifest `RLS_MANIFESTS[8]`): `DocumentVersion` user-owned (`userId`) | determinism test; a tenant reads and writes their own rows only (tested); **104/104** public tables forced |
| `20260903170200_document_versions_truncate_guard` | Review (LOW): a statement-level `BEFORE TRUNCATE` guard — the table cannot be truncated while it holds a submitted version (row triggers do not fire on TRUNCATE) | applied fresh and incrementally; tested |

`docx@9.7.1` (MIT) is the one new dependency; `jszip` was already a
transitive dependency and is imported directly for canonical re-packing and
the upload scan.

## 3. Renderers and ATS validation — `PASS`

`src/lib/documents/model.ts` is one ATS-safe model — header lines, upper-
case section headings in a fixed order, entries with dates, bullets; single
column, no tables, no graphics — with three renderers:

| Renderer | What it guarantees | Proof (`tests/document-engine.test.ts`) |
| --- | --- | --- |
| text (`renderText`) | byte-identical to the existing `renderResumeText`, so the model is not a second opinion about the résumé's shape; a letter round-trips | asserted for a full and a minimal résumé, and for a letter |
| PDF (`render-pdf.ts`, pdfkit standalone, standard Helvetica, uncompressed streams, caller-supplied dates) | the same model and date render the same bytes; the text is readable back (`extractPdfText`, our own parse-back over WinAnsi hex strings — not a general extractor) | two renders equal; a different date differs; parse-back recovers every model line including the em dash |
| DOCX (`render-docx.ts`, `docx` library, paragraphs and bullets only, then **canonical re-packing**: entries sorted, fixed entry timestamp, `dcterms:created/modified` pinned to the version's date) | the same model and date render the same bytes even a second apart; canonicalisation is idempotent; no tables | two renders 1.1 s apart equal; `canonicalDocx(canonicalDocx(x)) = canonicalDocx(x)`; `core.xml` carries the pinned date; parse-back recovers every model line |

`src/lib/documents/ats.ts` produces the stored ATS report: contact block
(an email), standard headings, heading order, date format, single column,
and — with the renderer's output — **parse-back** (every header line,
heading, paragraph, entry and bullet recoverable from the rendered file).
The report is stored on the version with its check version; the UI shows
"ATS checks passed" or "flagged" from it, nothing else.

**Goldens, honestly:** the regression goldens are the exact-equivalence
assertion against `renderResumeText` and the byte-level determinism
assertions; no binary golden files are committed (a PDF or DOCX golden would
differ only by its pinned date and would have to be regenerated on every
renderer change, which is a checklist, not a test).

## 4. Versions, hashing and immutability — `PASS`

`src/lib/documents/versions.ts`: `recordDocumentVersion` stores the bytes
under `<owner>/documents/<scope>/<kind>-v<n>.<format>`, takes the next
version number in the scope (a race is settled by the unique index and one
retry) and writes the row with the SHA-256; `readDocumentBytes` recomputes
the hash and **refuses** a missing or altered object; `sealApplicationDocuments`
marks an application's résumé and cover-letter drafts `submitted`
(idempotent) — never a drafted message under the same application, which
the platform does not send and must not record as sent (review MEDIUM). The
applicator
writes the set — résumé and cover letter × TXT/PDF/DOCX, six versions with
ATS reports — for every application and seals it at submission; an
assisted application is sealed when the applicant confirms
(`confirmAssistedSubmission`).

| Assertion (`tests/document-versions.test.ts`, real PostgreSQL + a temporary local store) | Result |
| --- | --- |
| A version carries the hash of its bytes, the next one is numbered, the bytes come back equal and verified | PASS |
| An altered object is refused (`DocumentIntegrityError`, "does not match"); a missing one is refused ("missing") — byte-reproducible or nothing | PASS |
| The application set is six sealed versions, every ATS report `ok` with parse-back `ok`, and re-rendering the résumé with the same date reproduces every stored hash; the TXT version is exactly `renderResumeText` | PASS |
| A submitted version is immutable BY THE DATABASE: raw `UPDATE` of the hash, of the status back to draft, a Prisma update of the key, a raw and a Prisma `DELETE`, and `TRUNCATE` of the table (statement-level guard, migration `20260903170200`) — all refused; the row survives; a thank-you draft under the same application is not sealed | PASS |
| Account erasure (deleting the owner's `User` row) cascades through the guard and removes the rows | PASS |
| Confirming an assisted application seals what was prepared | PASS |
| A tenant lists their own versions and writes on the tenant path; another tenant sees none and cannot insert a row for them (RLS) | PASS |

**Acceptance — "any submitted document is byte-reproducible from storage":
MET** in the sense tested: the stored bytes come back hash-verified or are
refused, and the renderers reproduce the same bytes from the same inputs.
Caveat: on a serverless or ephemeral filesystem the *local* store does not
survive a deploy; the S3 provider (binary put/get added this stage) remains
IMPLEMENTED-NOT-VALIDATED, and production needs it validated for the
guarantee to hold across deploys (§10).

## 5. Private by default; signed, expiring links — `PASS`

`src/lib/documents/sign.ts`: an HMAC-SHA256 over the document id, the
owner's id and an expiry (10 minutes), keyed by a key DERIVED from the
session secret (`documentLinkKey`), never the secret itself — the posture
of the CMS and API-key modules (review MEDIUM; tested: a link does not
verify under the root secret).
`GET /api/documents/:id` (session, tenant path, owner filter) mints a link
and redirects to it (`?link=1` returns it as JSON for "copy link"); `GET
/api/documents/:id/download?u&exp&sig` serves the bytes to a valid,
unexpired link with no session — the signature is the authorisation and it
binds the owner, so the row lookup still filters by that owner; the bytes
are hash-verified before they leave (a failure is a 409, logged by id, never
served); `Content-Disposition: attachment`, `no-store`, `nosniff`. There is
exactly one path to a file.

Tested (pure): verify ok; ok one second before expiry; expired at expiry;
another owner, another document, a longer life, a flipped signature byte,
an empty signature and another secret are all `invalid` (constant-time
compare; expiry is checked after the signature so a forged link learns
nothing from "expired").

## 6. Upload scanning — `PASS` (structural); antivirus `NOT AVAILABLE`

`src/lib/documents/scan.ts`, `POST /api/documents/upload`: the type is
sniffed from the bytes and must agree with the extension; 5 MB cap; a PDF
carrying JavaScript, open/launch actions, embedded files, rich media or XFA
is refused — and every FlateDecode stream (object streams included) is
inflated under a 32 MB cap and scanned too, because a dictionary inside a
compressed object stream never appears in the raw bytes (review HIGH); a
DOCX carrying VBA, a macro-enabled content type, external OLE or template
references is refused; the entry count, a traversal path and the declared
uncompressed size are checked from the central directory BEFORE any entry
is inflated, and a declared size that turns out to be a lie is refused as
a bomb too (review HIGH); text must be valid UTF-8 without NUL. A refused
file is never stored; the reasons are stable codes the UI explains.
Tested with our own PDF and DOCX under right and wrong names, a scripted
PDF, a PDF whose `/OpenAction /Launch` lives only inside a Flate-compressed
object stream, a 60 MB zero blob compressed to under a megabyte (refused in
well under a second, i.e. from the directory), 205 entries, a `../` entry, an
external OLE relationship, a macro-enabled content type, a DOCX with
`vbaProject.bin`, a plain zip, empty, oversize, binary noise and invalid
UTF-8. Not tested: a central directory that under-declares a size (JSZip
raises on the mismatch and the scan reports `zip_bomb`); a zip64 archive.

**No antivirus signature scanning exists in this environment** (no ClamAV,
no managed scanner). The register records it as NOT AVAILABLE; the UI copy
says "scanned on the server" and lists exactly what that means.

## 7. Messages — `PASS`

`src/lib/documents/compose.ts` (deterministic templates for application
message, recruiter introduction, outreach, follow-up, thank-you — built
only from the résumé, the match analysis and the posting's title and
company; nothing from its free text) behind a new gateway task `compose`
(`src/lib/ai/gateway.ts`): policy resolved before dispatch, `AiRun`
recorded, the baseline always computed, a model's draft grounded in letter
scope and replaced by the baseline on any unevidenced claim. Prompt slug
`compose`; no version is `default`, so every message is served
`deterministic` and says so. `POST /api/applications/:id/messages { kind }`
stores the result as a versioned TXT document in the application's scope.
The UI states that nothing is sent on the applicant's behalf.

Tested (pure): every kind is deterministic, names the role and the
applicant, never carries the posting's free text ("PhD from MIT" in the
description does not appear), and passes `findViolations` in letter scope
with zero violations.

## 8. Surfaces

- Application page: "Files" (every version with format, size, hash prefix,
  sealed lock, ATS result, download and copy-link) and "Messages" (draft any
  kind; the saved versions listed).
- Documents library: versioned files (PDF/DOCX/TXT), messages and uploads as
  rows with signed downloads; an upload card that explains the scan.

## 9. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 8 warnings (baseline) |
| Typecheck | 0 |
| Tests | **1002 / 1002**, 0 skipped (Stage 08: 982) — new: `document-engine` 13, `document-versions` 6 |
| Build | passes; `/api/documents/[id]`, `/api/documents/[id]/download`, `/api/documents/upload`, `/api/applications/[id]/messages` present |
| Migrations | twenty-six applied fresh; drift clean; 104/104 forced; RLS migration equals the generator output |

Run with the documented command only (the two test URLs; `DATABASE_URL` /
`DIRECT_URL` unset).

## 10. Exit gate — verdict

| Condition | State |
| --- | --- |
| DOCX + PDF live | **MET** — rendered for every application, deterministic, parse-back checked |
| Versions immutable | **MET** — service offers no mutation; the trigger refuses UPDATE and direct DELETE (tested) |
| Any submitted document byte-reproducible from storage | **MET as tested** (hash-verified reads; renderer determinism); **NOT VERIFIED across deploys** until the S3 provider is validated (local filesystem is the only real store) |
| Evidence-grounded messages | **MET** — through the gateway, letter-scope grounding, deterministic today |
| Signed, expiring access; private by default | **MET** |
| Server-side scanning for uploads | **PARTIAL** — structural scan MET; antivirus engine NOT AVAILABLE (EXTERNAL_SERVICE) |
| ATS-parse validation | **MET** for our own renderers (parse-back); no third-party ATS parser was consulted |

**Verdict: Stage 09 passes every engineering gate; its exit is PARTIAL** on
the absence of an antivirus engine and of a validated durable object store,
stated rather than approximated, and on the inherited cause (no real
traffic). Merge posture inherited from the stack.

## 11. What a founder or operator has to do

1. Validate the S3-compatible store (`STORAGE_PROVIDER=s3`, a Canadian
   region) against a real bucket, so sealed bytes survive deploys.
2. Decide on an antivirus engine for uploads (ClamAV sidecar or a managed
   scanner) — until then the structural scan is the whole story.
3. Staging — unchanged (R-34).

## 12. Independent review — findings and what was done

An adversarial review of `git diff 9852e64..4ad09af` returned **2 HIGH · 3
MEDIUM · 2 LOW · 2 INFO**. Every HIGH, MEDIUM and LOW is closed in the
review commit with a test; the INFO items are recorded.

| # | Sev | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | HIGH | The decompression-bomb guard collected a reason but did not stop: the content-types and `.rels` entries were inflated regardless, and a directory that under-declared a size surfaced as an uncaught JSZip error | Entry count, traversal and declared size are checked from the central directory and REFUSE before any entry is read; a size mismatch on read is caught as `zip_bomb`. Tested: a 60 MB blob under 1 MB on the wire is refused in well under a second |
| 2 | HIGH | The PDF active-content scan ran only over the raw bytes; `/OpenAction /Launch` inside a FlateDecode object stream passed | Every Flate stream is inflated under a 32 MB total cap and scanned; exceeding the cap is a refusal (`pdf_stream_too_large`). Tested with a hand-built compressed object stream |
| 3 | MEDIUM | `sealApplicationDocuments` sealed every draft under the application, so a thank-you note drafted before confirmation would be recorded as submitted | Sealing is limited to `SUBMITTED_KINDS` (résumé, cover letter). Tested |
| 4 | MEDIUM | The link key was the session secret itself | `documentLinkKey` derives a separate key (HMAC over a fixed label); a link does not verify under the root secret. Tested |
| 5 | MEDIUM | §6 claimed test coverage for reason codes no test exercised | Tests added for every reason code except the two stated as untested; §6 corrected |
| 6 | LOW | Row triggers do not fire on TRUNCATE | Statement-level guard, migration `20260903170200`; tested |
| 7 | LOW/INFO | `docx` uses `Math.random` ids for hyperlinks, comments and text boxes, none of which the renderer emits today | Recorded in CLAUDE.md item 20 as a determinism trap: never add a hyperlink run without extending the determinism test |
| 8 | INFO | Cascade depth, `updateMany` and the applicator's system-client posture verified correct | Recorded |
