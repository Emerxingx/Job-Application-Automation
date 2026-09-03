# ADR-0023 — Every document is a hashed, versioned file; a submitted version is immutable by the database and byte-reproducible or refused

**Status:** Accepted (Stage 09, 2026-09-03) · **Implements:** `MASTER_BUILD_PLAN.md` Stage 09 · **Closes:** G-16

## Context

Before Stage 09 a tailored résumé and cover letter existed as text columns
on the `Application` row and as text files in an application folder. There
was no DOCX, no PDF of the tailored documents, no version history, no hash,
and nothing that made "the exact submitted version is retained immutably"
true rather than intended. Uploads did not exist; downloads were session
routes over plain text.

## Decision

1. **One ATS-safe model, three renderers.** `DocumentModel` (header lines,
   upper-case headings in a fixed order, dated entries, bullets — single
   column, no tables, no graphics) renders to text (byte-identical to the
   existing `renderResumeText`), PDF and DOCX. The PDF and DOCX renderers are
   deterministic for a given model and date: standard fonts, uncompressed
   streams and caller-supplied dates for PDF; canonical re-packing (sorted
   entries, fixed entry timestamp, pinned core dates) for DOCX. Determinism
   is what makes a stored hash meaningful.
2. **Every document is a `DocumentVersion`.** Bytes in the object store
   under owner / scope / kind / version; the row carries the SHA-256, the
   size, the evidence ids, the AiRun id and the ATS report. Every read
   recomputes the hash and refuses a mismatch or a missing object: a
   document is byte-reproducible from storage or it is not served.
3. **A submitted version is immutable, and the database enforces it.** The
   service offers no mutation; a trigger refuses any UPDATE of a submitted
   row and any direct DELETE of one. The one exit is the referential
   cascade from the owner's `User` row (account erasure), which the guard
   lets through by trigger depth, because a person's right to erasure
   outranks our record-keeping. Sealing happens at submission — immediately
   for a programmatic submission, at the applicant's confirmation for an
   assisted one.
4. **Private by default; one signed path to a file.** The owner's session
   route mints an HMAC-signed link (document id, owner id, ten-minute
   expiry, keyed by the session secret) and redirects to the download
   route, which serves the hash-verified bytes to a valid link with no
   session and still filters the row by the owner the link names.
5. **Uploads are scanned structurally before they are stored**: sniffed
   type versus extension, size caps, PDF active content, DOCX macros and
   external references, decompression bombs, traversal paths, valid UTF-8
   for text. No antivirus engine exists in this environment; the register
   says NOT AVAILABLE and the UI describes exactly what the scan is.
6. **Messages go through the gateway** as a `compose` task with a
   deterministic template engine as the baseline and letter-scope grounding
   on any model draft; each result is a versioned document. Nothing is sent
   by the platform.

## Consequences

- Six versions per application (résumé and letter × three formats), each
  hashed and ATS-checked; storage grows with applications and is never
  rewritten — a correction is a new version.
- The object store becomes load-bearing for the immutability guarantee
  across deploys: the local filesystem is the only REAL provider today and
  the S3 provider (now with binary put/get) must be validated before
  production (INTEGRATION_REGISTER).
- Rendering happens at apply time on the request path; a renderer failure
  is logged and the application still completes with its folder and
  database copies (the folder is not removed by this ADR).
