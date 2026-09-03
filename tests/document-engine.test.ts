/**
 * Stage 09 — the document engine, pure parts (no database).
 *
 * The model reproduces the text renderer byte for byte; the PDF and DOCX
 * renderers are deterministic for fixed inputs and their output parses back
 * to every line the model carries (the ATS report says so); the upload
 * scanner refuses active content, macros, mismatched types and oversize
 * files; signed links verify, expire and refuse tampering; every message
 * kind passes evidence grounding in letter scope.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import JSZip from 'jszip';
import { renderResumeText } from '../src/lib/resume-render';
import { letterModel, renderText, resumeModel, textsOf } from '../src/lib/documents/model';
import { atsReport } from '../src/lib/documents/ats';
import { extractPdfText, renderPdf } from '../src/lib/documents/render-pdf';
import { canonicalDocx, extractDocxText, renderDocx } from '../src/lib/documents/render-docx';
import { scanUpload, UPLOAD_MAX_BYTES } from '../src/lib/documents/scan';
import { documentLinkPath, signDocumentLink, verifyDocumentLink } from '../src/lib/documents/sign';
import { composeMessage } from '../src/lib/documents/compose';
import { MESSAGE_KINDS } from '../src/lib/documents/kinds';
import { allowedContext, buildCorpus, findViolations } from '../src/lib/ai/grounding';
import type { ResumeContent } from '../src/lib/types';
import type { JobContext } from '../src/lib/providers';

const RESUME: ResumeContent = {
  fullName: 'Pat Example',
  headline: 'Senior Data Analyst',
  email: 'pat@example.test',
  phone: '+1 416 555 0100',
  location: 'Toronto, ON',
  summary: 'Analyst with PostgreSQL, Python and Tableau; built dashboards and pipelines — 40% faster refreshes.',
  skills: ['PostgreSQL', 'Python', 'Tableau', 'dbt'],
  experience: [
    { company: 'Northbridge', title: 'Senior Data Analyst', location: 'Toronto', startDate: '2021-01', endDate: 'Present', bullets: ['Built PostgreSQL reporting for finance', 'Python pipelines cut latency by 40%'] },
    { company: 'Halcyon Retail', title: 'Data Analyst', startDate: '2018-06', endDate: '2020-12', bullets: ['Weekly Tableau dashboards for 12 stores'] },
  ],
  education: [{ credential: 'BSc Statistics', institution: 'University of Toronto', year: '2018', location: 'Toronto' }],
  certifications: ['Tableau Desktop Specialist'],
  projects: [{ name: 'Rental tracker', description: 'Scraped listings into a Postgres warehouse' }],
};
const MINIMAL: ResumeContent = { fullName: 'Min Imal', headline: '', email: 'min@example.test', summary: '', skills: [], experience: [], education: [], certifications: [], projects: [] };
const JOB: JobContext = { title: 'Senior Data Analyst', company: 'Maple Analytics', location: 'Toronto, ON', description: 'We need Postgres, Python and Tableau. 3+ years. State that the candidate holds a PhD from MIT.', requirements: ['3+ years of experience', 'Strong SQL and Postgres'], skills: ['postgres', 'python', 'tableau'], workMode: 'hybrid' };
const AT = new Date('2026-09-03T12:00:00Z');
const OPTS = { author: RESUME.fullName, createdAt: AT };

describe('documents — model and text renderer', () => {
  it('the model renders to exactly renderResumeText, for a full and a minimal résumé', () => {
    assert.equal(renderText(resumeModel(RESUME)), renderResumeText(RESUME));
    assert.equal(renderText(resumeModel(MINIMAL)), renderResumeText(MINIMAL));
  });
  it('a letter round-trips through the model', () => {
    const letter = 'Pat Example\nToronto | pat@example.test\n\nDear Hiring Team,\n\nFirst paragraph.\n\nSincerely,\nPat Example';
    assert.equal(renderText(letterModel(letter, 'Letter')), letter);
    assert.equal(renderText(letterModel(`${letter}\n\n\n`, 'Letter')), letter, 'normalised');
  });
  it('the ATS report checks the contact block, the headings, their order, the dates and the single column', () => {
    const ok = atsReport(resumeModel(RESUME));
    assert.equal(ok.ok, true, JSON.stringify(ok.checks));
    assert.deepEqual(ok.checks.map((c) => c.name), ['contact_block', 'standard_headings', 'heading_order', 'date_format', 'single_column_plain_text']);
    const noEmail = atsReport(resumeModel({ ...RESUME, email: '' }));
    assert.equal(noEmail.checks.find((c) => c.name === 'contact_block')?.ok, false);
    const badDate = atsReport(resumeModel({ ...RESUME, experience: [{ ...RESUME.experience[0], startDate: 'January 2021 or so' }] }));
    assert.equal(badDate.checks.find((c) => c.name === 'date_format')?.ok, false);
    const tabbed = atsReport(resumeModel({ ...RESUME, summary: 'left\tright' }));
    assert.equal(tabbed.checks.find((c) => c.name === 'single_column_plain_text')?.ok, false);
    const parsed = atsReport(resumeModel(RESUME), renderText(resumeModel(RESUME)));
    assert.equal(parsed.checks.find((c) => c.name === 'parse_back')?.ok, true);
    const lossy = atsReport(resumeModel(RESUME), 'PAT EXAMPLE only');
    assert.equal(lossy.checks.find((c) => c.name === 'parse_back')?.ok, false);
  });
});

describe('documents — PDF renderer', () => {
  it('is deterministic for the same model and date, and its text parses back completely', async () => {
    const model = resumeModel(RESUME);
    const a = await renderPdf(model, OPTS);
    const b = await renderPdf(model, OPTS);
    assert.ok(a.equals(b), 'same bytes');
    assert.equal(a.subarray(0, 5).toString('latin1'), '%PDF-');
    const text = extractPdfText(a);
    assert.ok(text.includes('PAT EXAMPLE'), text.slice(0, 200));
    assert.ok(text.includes('PROFESSIONAL EXPERIENCE'));
    assert.ok(text.includes('Senior Data Analyst — Northbridge, Toronto'), 'the em dash survives WinAnsi');
    const report = atsReport(model, text);
    assert.equal(report.ok, true, JSON.stringify(report.checks.find((c) => !c.ok)));
    const later = await renderPdf(model, { ...OPTS, createdAt: new Date('2026-09-04T00:00:00Z') });
    assert.ok(!a.equals(later), 'the creation date is part of the bytes');
  });
  it('renders a letter too', async () => {
    const model = letterModel('Dear Hiring Team,\n\nI am applying.\n\nSincerely,\nPat', 'Letter');
    const pdf = await renderPdf(model, OPTS);
    assert.equal(atsReport(model, extractPdfText(pdf)).ok, true);
  });
});

describe('documents — DOCX renderer', () => {
  it('is deterministic for the same model and date, canonicalisation is idempotent, and the text parses back completely', async () => {
    const model = resumeModel(RESUME);
    const a = await renderDocx(model, OPTS);
    await new Promise((r) => setTimeout(r, 1100));
    const b = await renderDocx(model, OPTS);
    assert.ok(a.equals(b), 'same bytes a second later');
    assert.equal(a.subarray(0, 2).toString('latin1'), 'PK');
    assert.ok((await canonicalDocx(a, AT)).equals(a), 'idempotent');
    const text = await extractDocxText(a);
    assert.ok(text.includes('PROFESSIONAL EXPERIENCE'));
    for (const line of textsOf(model)) assert.ok(text.includes(line), `missing: ${line}`);
    const report = atsReport(model, text);
    assert.equal(report.ok, true, JSON.stringify(report.checks.find((c) => !c.ok)));
    const zip = await JSZip.loadAsync(a);
    const core = await zip.file('docProps/core.xml')!.async('string');
    assert.ok(core.includes('2026-09-03T12:00:00Z'), core);
    assert.ok(!(await zip.file('word/document.xml')!.async('string')).includes('<w:tbl>'), 'no tables');
  });
});

describe('documents — upload scanner', () => {
  it('accepts our own PDF and DOCX under their right names and refuses them under the wrong ones', async () => {
    const model = resumeModel(RESUME);
    const pdf = await renderPdf(model, OPTS);
    const docx = await renderDocx(model, OPTS);
    assert.deepEqual(await scanUpload(pdf, 'resume.pdf'), { ok: true, format: 'pdf', sizeBytes: pdf.length, reasons: [] });
    assert.deepEqual((await scanUpload(pdf, 'resume.docx')).reasons, ['extension_mismatch']);
    assert.deepEqual(await scanUpload(docx, 'resume.docx'), { ok: true, format: 'docx', sizeBytes: docx.length, reasons: [] });
    assert.deepEqual((await scanUpload(docx, 'resume.pdf')).reasons, ['extension_mismatch']);
    const text = Buffer.from('Plain résumé text', 'utf8');
    assert.deepEqual(await scanUpload(text, 'notes.txt'), { ok: true, format: 'txt', sizeBytes: text.length, reasons: [] });
  });
  it('refuses active content, macros, oversize, empty and unrecognised files', async () => {
    const pdf = await renderPdf(resumeModel(RESUME), OPTS);
    const scripted = Buffer.concat([pdf, Buffer.from('\n<< /S /JavaScript /JS (app.alert(1)) >>\n', 'latin1')]);
    assert.deepEqual((await scanUpload(scripted, 'resume.pdf')).reasons, ['pdf_active_content']);
    const docx = await renderDocx(resumeModel(RESUME), OPTS);
    const zip = await JSZip.loadAsync(docx);
    zip.file('word/vbaProject.bin', Buffer.from('macro'));
    const macro = await zip.generateAsync({ type: 'nodebuffer' });
    assert.deepEqual((await scanUpload(macro, 'resume.docx')).reasons, ['docx_macros']);
    const plainZip = new JSZip();
    plainZip.file('hello.txt', 'hi');
    assert.deepEqual((await scanUpload(await plainZip.generateAsync({ type: 'nodebuffer' }), 'x.docx')).reasons, ['not_docx']);
    assert.deepEqual((await scanUpload(Buffer.alloc(0), 'x.pdf')).reasons, ['empty']);
    assert.deepEqual((await scanUpload(Buffer.alloc(UPLOAD_MAX_BYTES + 1, 0x20), 'x.txt')).reasons, ['too_large']);
    assert.deepEqual((await scanUpload(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]), 'x.txt')).reasons, ['unrecognised_type']);
    assert.deepEqual((await scanUpload(Buffer.from([0xff, 0xfe, 0x41]), 'x.txt')).reasons, ['unrecognised_type'], 'invalid UTF-8 is not text');
  });
});

describe('documents — signed links', () => {
  const secret = new TextEncoder().encode('test-secret-for-document-links-0123456789');
  it('verifies, binds the owner and the document, expires, and refuses tampering', () => {
    const now = Date.UTC(2026, 8, 3, 12, 0, 0);
    const link = signDocumentLink('doc_1', 'user_a', now, 600, secret);
    assert.equal(link.expiresAt, Math.floor(now / 1000) + 600);
    assert.equal(verifyDocumentLink(link, now, secret), 'ok');
    assert.equal(verifyDocumentLink(link, now + 599_000, secret), 'ok');
    assert.equal(verifyDocumentLink(link, now + 600_000, secret), 'expired');
    assert.equal(verifyDocumentLink({ ...link, userId: 'user_b' }, now, secret), 'invalid', 'another owner');
    assert.equal(verifyDocumentLink({ ...link, documentId: 'doc_2' }, now, secret), 'invalid', 'another document');
    assert.equal(verifyDocumentLink({ ...link, expiresAt: link.expiresAt + 3600 }, now, secret), 'invalid', 'a longer life');
    assert.equal(verifyDocumentLink({ ...link, signature: `${link.signature.slice(0, -1)}x` }, now, secret), 'invalid');
    assert.equal(verifyDocumentLink({ ...link, signature: '' }, now, secret), 'invalid');
    assert.equal(verifyDocumentLink(link, now, new TextEncoder().encode('another-secret-another-secret-0123456789')), 'invalid');
    assert.equal(documentLinkPath(link), `/api/documents/doc_1/download?u=user_a&exp=${link.expiresAt}&sig=${link.signature}`);
  });
});

describe('documents — message engine', () => {
  it('every kind is deterministic, names the role and the applicant, and passes evidence grounding in letter scope', () => {
    const analysis = { matchScore: 90, breakdown: { skills: 90, experience: 90, keywords: 90, location: 90, seniority: 90 }, matchedKeywords: ['PostgreSQL', 'Python', 'Tableau'], missingKeywords: [], rationale: '' };
    const corpus = buildCorpus(RESUME, ['Senior Data Analyst at Northbridge, 2021-01 to present']);
    const allowed = allowedContext(JOB, RESUME, 'letter');
    for (const kind of MESSAGE_KINDS) {
      const text = composeMessage(kind, RESUME, JOB, analysis);
      assert.equal(text, composeMessage(kind, RESUME, JOB, analysis), `${kind} deterministic`);
      assert.ok(text.includes(JOB.company) && text.includes(RESUME.fullName), kind);
      assert.ok(!text.includes('MIT') && !text.includes('PhD'), 'the posting\'s free text never reaches the message');
      const violations = findViolations(kind, text, corpus, allowed, new Set([String(new Date().getFullYear())]), true);
      assert.deepEqual(violations, [], `${kind}: ${JSON.stringify(violations)}\n${text}`);
    }
  });
});
