import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatPrice,
  intervalMonths,
  monthlyEquivalent,
  priceFor,
} from '../src/lib/subscription';

// Mirrors the seeded Professional tier.
const plan = {
  monthlyPriceCents: 5900,
  quarterlyPriceCents: 15930, // 10% off three months
  annualPriceCents: 56640, // 20% off twelve months
};

describe('intervalMonths', () => {
  it('maps each interval to its length', () => {
    assert.equal(intervalMonths('monthly'), 1);
    assert.equal(intervalMonths('quarterly'), 3);
    assert.equal(intervalMonths('annual'), 12);
  });
});

describe('priceFor', () => {
  it('selects the price for the chosen commitment', () => {
    assert.equal(priceFor(plan, 'monthly'), 5900);
    assert.equal(priceFor(plan, 'quarterly'), 15930);
    assert.equal(priceFor(plan, 'annual'), 56640);
  });
});

describe('monthlyEquivalent', () => {
  it('is the monthly price itself on a monthly plan', () => {
    assert.equal(monthlyEquivalent(plan, 'monthly'), 5900);
  });

  it('shows the real saving on longer commitments', () => {
    assert.equal(monthlyEquivalent(plan, 'quarterly'), 5310);
    assert.equal(monthlyEquivalent(plan, 'annual'), 4720);
  });

  it('never presents a longer commitment as more expensive per month', () => {
    const monthly = monthlyEquivalent(plan, 'monthly');
    assert.ok(monthlyEquivalent(plan, 'quarterly') <= monthly);
    assert.ok(monthlyEquivalent(plan, 'annual') <= monthlyEquivalent(plan, 'quarterly'));
  });
});

describe('formatPrice', () => {
  it('renders cents as whole dollars', () => {
    assert.equal(formatPrice(5900), '$59');
    assert.equal(formatPrice(0), '$0');
    assert.equal(formatPrice(2900), '$29');
  });
});
