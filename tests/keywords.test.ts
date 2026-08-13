import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  displayKeyword,
  extractSkills,
  overlapRatio,
  requiredYears,
  seniorityOf,
  tokenize,
  yearsOfExperience,
} from '../src/lib/providers/ai/keywords';

describe('extractSkills', () => {
  it('finds skills regardless of casing and punctuation', () => {
    const skills = extractSkills('Strong SQL and Python. Experience with Power BI.');
    assert.ok(skills.includes('sql'));
    assert.ok(skills.includes('python'));
    assert.ok(skills.includes('power bi'));
  });

  it('does not match a skill embedded inside a longer word', () => {
    // "r" must not match inside "react"; "go" must not match inside "google".
    const skills = extractSkills('We use React and Google Cloud.');
    assert.ok(!skills.includes('r'), 'matched "r" inside another word');
    assert.ok(!skills.includes('go'), 'matched "go" inside another word');
  });

  it('collapses spelling variants to one canonical entry', () => {
    const skills = extractSkills('node.js Node.JS NODE.js');
    assert.equal(skills.filter((s) => s === 'node.js').length, 1);
  });

  it('returns an empty list for text with no recognisable skills', () => {
    assert.deepEqual(extractSkills('We are looking for a friendly teammate.'), []);
  });
});

describe('tokenize', () => {
  it('drops stop words and very short tokens', () => {
    const tokens = tokenize('The analyst will be responsible for the reporting');
    assert.ok(!tokens.includes('the'));
    assert.ok(!tokens.includes('be'));
    assert.ok(tokens.includes('analyst'));
  });
});

describe('overlapRatio', () => {
  it('is 1 when every token is present and 0 when none are', () => {
    assert.equal(overlapRatio(['sql', 'python'], ['sql', 'python', 'r']), 1);
    assert.equal(overlapRatio(['sql'], ['java']), 0);
  });

  it('is 0 for empty input rather than dividing by zero', () => {
    assert.equal(overlapRatio([], ['sql']), 0);
    assert.equal(overlapRatio(['sql'], []), 0);
  });

  it('reports a partial match proportionally', () => {
    assert.equal(overlapRatio(['a', 'b', 'c', 'd'], ['a', 'b']), 0.5);
  });
});

describe('seniorityOf', () => {
  it('ranks titles from entry level to executive', () => {
    assert.equal(seniorityOf('VP of Engineering'), 5);
    assert.equal(seniorityOf('Director, Analytics'), 5);
    assert.equal(seniorityOf('Staff Data Scientist'), 4);
    assert.equal(seniorityOf('Principal Engineer'), 4);
    assert.equal(seniorityOf('Senior Data Analyst'), 3);
    assert.equal(seniorityOf('Data Analyst'), 2);
    assert.equal(seniorityOf('Junior Data Analyst'), 1);
    assert.equal(seniorityOf('Analytics Engineer — New Grad Welcome'), 1);
  });
});

describe('yearsOfExperience', () => {
  it('sums role durations across a history', () => {
    const years = yearsOfExperience([
      { startDate: '2018-01', endDate: '2021-01' },
      { startDate: '2021-01', endDate: '2024-01' },
    ]);
    assert.equal(years, 6);
  });

  it('treats an open-ended role as running to today', () => {
    // Anchor to the current month so the span is exactly two years whenever
    // this runs, rather than drifting with the calendar.
    const now = new Date();
    const start = `${now.getFullYear() - 2}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const years = yearsOfExperience([{ startDate: start, endDate: 'Present' }]);
    assert.ok(years >= 1.9 && years <= 2.1, `expected about 2 years, got ${years}`);
  });

  it('ignores unparseable entries instead of returning NaN', () => {
    const years = yearsOfExperience([{ startDate: 'sometime', endDate: 'later' }]);
    assert.equal(years, 0);
    assert.ok(!Number.isNaN(years));
  });

  it('never counts a reversed date range as negative experience', () => {
    const years = yearsOfExperience([{ startDate: '2024-01', endDate: '2020-01' }]);
    assert.equal(years, 0);
  });
});

describe('requiredYears', () => {
  it('reads the requirement from natural phrasing', () => {
    assert.equal(requiredYears(['5+ years of experience in analytics']), 5);
    assert.equal(requiredYears(['Minimum 3 years experience']), 3);
  });

  it('returns 0 when no requirement is stated', () => {
    assert.equal(requiredYears(['Strong communication skills']), 0);
    assert.equal(requiredYears([]), 0);
  });
});

describe('displayKeyword', () => {
  it('upper-cases acronyms and title-cases the rest', () => {
    assert.equal(displayKeyword('sql'), 'SQL');
    assert.equal(displayKeyword('power bi'), 'Power BI');
    assert.equal(displayKeyword('python'), 'Python');
    assert.equal(displayKeyword('data modelling'), 'Data Modelling');
  });
});
