const test = require('node:test');
const assert = require('node:assert/strict');
const {
  containsDelistingLanguage,
  parseLooseNumber,
  parseNasdaqQuoteSummary,
  computeOptionIvFromChain,
} = require('../marketData.js');
const https = require('https');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'DelistingMonitorTest/1.0 (local)',
        'Accept': 'application/json',
      },
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode || 0, json: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

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

test('containsDelistingLanguage recognizes common listing-deficiency terms', () => {
  assert.equal(containsDelistingLanguage('Received Notice of Delisting from Nasdaq'), true);
  assert.equal(containsDelistingLanguage('Company reported strong quarterly sales growth'), false);
});

test('live upstreams provide SEC ticker map and Yahoo quote payloads', async (t) => {
  let secPayload;
  let yahooPayload;
  try {
    [secPayload, yahooPayload] = await Promise.all([
      fetchJson('https://www.sec.gov/files/company_tickers.json'),
      fetchJson('https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL'),
    ]);
  } catch (error) {
    const code = error?.code || error?.cause?.code || '';
    if (['ENETUNREACH', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT'].includes(code)) {
      t.skip(`network unavailable for live integration test (${code})`);
      return;
    }
    throw error;
  }

  assert.equal(secPayload.status, 200);
  const firstEntry = secPayload.json?.['0'];
  assert.ok(firstEntry?.ticker);
  assert.ok(firstEntry?.cik_str);

  assert.equal(yahooPayload.status, 200);
  const quote = yahooPayload.json?.quoteResponse?.result?.[0];
  assert.equal(quote?.symbol, 'AAPL');
  assert.ok(Number.isFinite(quote?.marketCap));
});
