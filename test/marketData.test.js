const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseLooseNumber,
  parseNasdaqQuoteSummary,
  computeOptionIvFromChain,
} = require('../marketData.js');

test('parseLooseNumber handles currency, commas, and compact suffixes', () => {
  assert.equal(parseLooseNumber('$12.34'), 12.34);
  assert.equal(parseLooseNumber('1.5B'), 1_500_000_000);
  assert.equal(parseLooseNumber('2,345,678'), 2_345_678);
  assert.ok(Number.isNaN(parseLooseNumber('N/A')));
});

test('parseNasdaqQuoteSummary extracts price, market cap, and volume from Nasdaq summary payload', () => {
  const parsed = parseNasdaqQuoteSummary({
    data: {
      summaryData: {
        MarketCap: { value: '$1.23B' },
        AverageVolume: { value: '4.56M' },
      },
      primaryData: {
        lastSalePrice: '$7.89',
        lastTradeTimestamp: '2026-03-19 15:59:59',
      },
    },
  });

  assert.equal(parsed.price, 7.89);
  assert.equal(parsed.marketCap, 1_230_000_000);
  assert.equal(parsed.avgVolume, 4_560_000);
  assert.equal(parsed.dataAsOf, '2026-03-19 15:59:59');
});

test('computeOptionIvFromChain averages valid implied volatilities', () => {
  const optionIv = computeOptionIvFromChain({
    optionChain: {
      result: [{
        options: [{
          calls: [{ impliedVolatility: { raw: 0.45 } }, { impliedVolatility: { raw: 0.55 } }],
          puts: [{ impliedVolatility: { raw: 0.65 } }],
        }],
      }],
    },
  });

  assert.ok(Math.abs(optionIv - 55) < 1e-9);
});
