import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MissingPromptVariablesError,
  extractPlaceholders,
  interpolate,
  missingVariables,
  renderTemplate,
} from '../src/lib/prompt-interpolate';

describe('interpolate', () => {
  it('substitutes a declared variable', () => {
    assert.equal(
      interpolate('Tailor this for {{job_description}}.', { job_description: 'Data Analyst' }),
      'Tailor this for Data Analyst.',
    );
  });

  it('tolerates whitespace inside the braces', () => {
    assert.equal(interpolate('{{ name }} and {{name}}', { name: 'Alex' }), 'Alex and Alex');
  });

  it('leaves an unsupplied placeholder intact rather than blanking it', () => {
    // Surfacing the gap is safer than silently sending an empty value.
    assert.equal(interpolate('Hi {{missing}}', {}), 'Hi {{missing}}');
  });

  it('is non-recursive: a value containing a placeholder is inserted verbatim', () => {
    // The résumé literally mentions "{{job_description}}" — it must NOT be
    // expanded again into the actual job description.
    const out = interpolate('Resume: {{resume}} | JD: {{job_description}}', {
      resume: 'I once wrote a template using {{job_description}} syntax.',
      job_description: 'SECRET JD',
    });
    assert.equal(out, 'Resume: I once wrote a template using {{job_description}} syntax. | JD: SECRET JD');
    // The injected placeholder was not resolved to "SECRET JD" a second time.
    assert.ok(out.includes('using {{job_description}} syntax'));
  });

  it('does not let one variable inject another variable’s value', () => {
    // Classic prompt-injection shape: user value tries to pull in a system var.
    const out = interpolate('{{user_note}}', { user_note: '{{system_secret}}', system_secret: 'LEAK' });
    assert.equal(out, '{{system_secret}}');
    assert.ok(!out.includes('LEAK'));
  });

  it('treats an empty string as a legitimate supplied value', () => {
    assert.equal(interpolate('[{{note}}]', { note: '' }), '[]');
  });

  it('substitutes adjacent placeholders each exactly once', () => {
    assert.equal(interpolate('{{a}}{{b}}{{a}}', { a: 'X', b: 'Y' }), 'XYX');
  });
});

describe('missingVariables', () => {
  it('reports declared variables that were not supplied', () => {
    assert.deepEqual(missingVariables(['a', 'b', 'c'], { a: '1', c: '3' }), ['b']);
  });

  it('treats an empty string as supplied but null/undefined as missing', () => {
    assert.deepEqual(missingVariables(['a', 'b'], { a: '', b: undefined as unknown as string }), ['b']);
  });

  it('is empty when everything is supplied', () => {
    assert.deepEqual(missingVariables(['a'], { a: 'x' }), []);
  });
});

describe('extractPlaceholders', () => {
  it('returns the distinct variable names in a template', () => {
    assert.deepEqual(
      extractPlaceholders('{{a}} {{b}} {{a}}').sort(),
      ['a', 'b'],
    );
  });

  it('returns an empty list when there are no placeholders', () => {
    assert.deepEqual(extractPlaceholders('no variables here'), []);
  });
});

describe('renderTemplate', () => {
  it('validates then substitutes', () => {
    const out = renderTemplate(
      'resume-tailor',
      'JD: {{job_description}}',
      ['job_description'],
      { job_description: 'Data Analyst' },
    );
    assert.equal(out, 'JD: Data Analyst');
  });

  it('throws with the missing names when a declared variable is absent', () => {
    assert.throws(
      () => renderTemplate('resume-tailor', 'JD: {{job_description}}', ['job_description', 'user_profile'], {}),
      (err: unknown) => {
        assert.ok(err instanceof MissingPromptVariablesError);
        assert.deepEqual((err as MissingPromptVariablesError).missing, ['job_description', 'user_profile']);
        return true;
      },
    );
  });

  it('does not throw when a used-but-undeclared placeholder is absent', () => {
    // Only DECLARED variables are required; an extra placeholder in the text
    // that nobody declared is left intact, not treated as missing.
    const out = renderTemplate('x', 'A {{declared}} B {{stray}}', ['declared'], { declared: '1' });
    assert.equal(out, 'A 1 B {{stray}}');
  });
});
