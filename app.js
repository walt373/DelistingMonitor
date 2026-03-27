const DATA_URL = "data/stocks.json";
const LIVE_QUOTE_REFRESH_MS = 60_000;
const DATA_REFRESH_MS = 900_000;
const SEC_MAX_ENTRIES_PER_QUERY = 100;
const SEC_LOOKBACK_DAYS = 30;
const SEC_CORS_PROXIES = [
  (url) => `api/sec-proxy?url=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];
const MARKET_DATA_PROXIES = [
  (url) => `api/market-proxy?url=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];
const NASDAQ_SUMMARY_URL = (symbol) => `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/summary?assetclass=stocks`;

const {
  firstFinite,
  parseNasdaqQuoteSummary,
  readRawValue,
} = window.MarketDataUtils;

const SEC_DISCOVERY_QUERY = {
  label: "8-K notice of delisting",
  forms: "8-K",
  keywords: ["notice of delisting"],
  reason: "Notice of delisting",
};

const tableBody = document.querySelector("#stocksTable tbody");
const searchInput = document.getElementById("searchInput");
const reasonFilter = document.getElementById("reasonFilter");
const chanceFilter = document.getElementById("chanceFilter");
const detailsContent = document.getElementById("detailsContent");
const headers = document.querySelectorAll("#stocksTable th");
const lastUpdatedEl = document.getElementById("lastUpdated");
const liveStatusEl = document.getElementById("liveStatus");

let stocks = [];
let selectedTicker = null;
let sortKey = "delistingChance";
let sortDir = "desc";
let dataGeneratedAt = null;
let liveQuoteSyncEnabled = true;
let liveQuoteTimerId = null;
const cikTickerCache = new Map();
const tickerCikCache = new Map();


async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function isSafeExternalUrl(value) {
  try {
    const parsed = new URL(value, window.location.origin);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch (_error) {
    return false;
  }
}

function appendCell(row, text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  row.appendChild(cell);
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return "N/A";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1 ? 2 : 4,
  }).format(value);
}

function formatCompactMoney(value) {
  if (!Number.isFinite(value)) return "N/A";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "N/A";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function formatPct(value) {
  if (!Number.isFinite(value)) return "N/A";
  return `${value.toFixed(2)}%`;
}

function formatTimestamp(value) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return date.toLocaleString();
}

function riskLabel(chance) {
  if (chance >= 70) return { text: `${chance}% (High)`, cls: "high" };
  if (chance >= 40) return { text: `${chance}% (Medium)`, cls: "medium" };
  return { text: `${chance}% (Low)`, cls: "low" };
}

function computeDelistReason(signals = {}) {
  if (signals.bankruptcyProceeding) return "Bankruptcy / restructuring proceedings";
  if (signals.lateFilingsCount > 0) return "Late SEC filing notice (10-K / 10-Q overdue)";
  if (signals.equityDeficiency) return "Notice of delisting: shareholder equity requirement breach";
  if (signals.governanceDeficiency) return "Corporate governance deficiency";
  if (signals.bidBelowOneDollarDays > 30) return "Notice of delisting: minimum bid price below $1.00";
  return "Elevated listing-compliance risk";
}

function computeExpectedDelistingDate(signals = {}) {
  if (signals.complianceDeadline) return signals.complianceDeadline;
  if (signals.hearingDate) return signals.hearingDate;

  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date.toISOString().slice(0, 10);
}

function computeDelistingChance(signals = {}) {
  let score = 20;
  score += Math.min(35, (signals.bidBelowOneDollarDays || 0) * 0.4);
  score += Math.min(18, (signals.lateFilingsCount || 0) * 9);
  score += signals.equityDeficiency ? 12 : 0;
  score += signals.governanceDeficiency ? 8 : 0;
  score += signals.bankruptcyProceeding ? 30 : 0;
  score += signals.reverseSplitPlanned ? 6 : 0;
  return Math.max(5, Math.min(98, Math.round(score)));
}

function normalizeStock(rawStock) {
  const signals = rawStock.signals || {};
  return {
    ...rawStock,
    delistReason: rawStock.delistReason || computeDelistReason(signals),
    expectedDelistingDate: rawStock.expectedDelistingDate || computeExpectedDelistingDate(signals),
    delistingChance: rawStock.delistingChance || computeDelistingChance(signals),
  };
}


function inferReasonFromText(text) {
  const normalized = text.toLowerCase();
  const includesItem301 =
    normalized.includes("item 3.01")
    || normalized.includes("failure to satisfy a continued listing rule or standard");

  if (includesItem301) {
    return "Notice of delisting: Item 3.01 (failure to satisfy continued listing standard)";
  }

  if (
    normalized.includes("minimum bid price") ||
    normalized.includes("bid price below $1") ||
    normalized.includes("below the minimum $1.00 bid price") ||
    normalized.includes("closing bid price of below $1.00")
  ) {
    return "Notice of delisting: minimum bid price below $1.00";
  }

  if (
    normalized.includes("market value of publicly held shares") ||
    normalized.includes("publicly held shares requirement") ||
    normalized.includes("market value of listed securities") ||
    normalized.includes("public float")
  ) {
    return "Notice of delisting: market value / public float below exchange minimum";
  }

  if (
    normalized.includes("stockholders' equity") ||
    normalized.includes("shareholders' equity") ||
    normalized.includes("equity deficiency")
  ) {
    return "Notice of delisting: shareholder equity below listing standard";
  }

  if (
    normalized.includes("late filing") ||
    normalized.includes("unable to file") ||
    normalized.includes("notification of late filing") ||
    normalized.includes("delinquent in filing")
  ) {
    if (normalized.includes("10-k")) return "Late SEC filing notice: Form 10-K overdue";
    if (normalized.includes("10-q")) return "Late SEC filing notice: Form 10-Q overdue";
    return "Late SEC filing notice (10-K / 10-Q overdue)";
  }

  if (
    normalized.includes("bankruptcy") ||
    normalized.includes("chapter 11") ||
    normalized.includes("chapter 7") ||
    normalized.includes("restructuring support agreement")
  ) {
    return "Bankruptcy / restructuring proceedings";
  }

  if (
    normalized.includes("corporate governance") ||
    normalized.includes("audit committee") ||
    normalized.includes("board independence")
  ) {
    return "Notice of delisting: corporate governance deficiency";
  }

  if (normalized.includes("notice of delisting")) {
    return "Notice of delisting: exchange deficiency cited in filing";
  }

  return normalized.includes("notice of delisting")
    ? "Notice of delisting: exchange deficiency cited in filing"
    : "Notice of delisting";
}

function shouldIncludeFilingForQuery(query, filing) {
  const haystack = `${filing.title} ${filing.summary}`.toLowerCase();
  const requiredKeyword = query.keywords?.[0]?.toLowerCase() || "notice of delisting";
  const isEightK = String(filing.formType || "").toUpperCase().startsWith("8-K");
  return isEightK
    && haystack.includes(requiredKeyword)
    && isWithinLookbackWindow(filing.filedDate, SEC_LOOKBACK_DAYS);
}

function isWithinLookbackWindow(dateText, days) {
  const parsed = new Date(dateText);
  if (Number.isNaN(parsed.getTime())) return false;
  const threshold = new Date();
  threshold.setDate(threshold.getDate() - days);
  return parsed >= threshold;
}

function isListedOnMajorExchange(exchangeCodeOrName) {
  const exchange = String(exchangeCodeOrName || "").toUpperCase();
  if (!exchange) return false;
  return exchange.includes("NASDAQ") || exchange.includes("NMS") || exchange.includes("NCM") || exchange.includes("NGM") || exchange.includes("NMS")
    || exchange.includes("NYSE") || exchange.includes("NYQ") || exchange.includes("NYS") || exchange.includes("NYE");
}

function extractTickerFromText(text) {
  if (!text) return null;

  const parentheticalMatches = text.match(/\(([A-Z][A-Z0-9.-]{0,5})\)/g) || [];
  for (const match of parentheticalMatches) {
    const candidate = match.slice(1, -1).toUpperCase();
    if (/^[A-Z][A-Z0-9.-]{0,5}$/.test(candidate) && !candidate.includes(" ")) return candidate;
  }

  const symbolMatch = text.toUpperCase().match(/\b(?:SYMBOL|TICKER)\s*[:=-]\s*([A-Z][A-Z0-9.-]{0,5})\b/);
  if (symbolMatch) return symbolMatch[1];

  return null;
}

function extractCikFromSecLink(link) {
  if (!link) return null;
  const match = link.match(/\/data\/(\d{1,10})\//);
  return match ? match[1].padStart(10, "0") : null;
}

async function fetchTickerForCik(cik) {
  if (!cik) return null;
  if (cikTickerCache.has(cik)) return cikTickerCache.get(cik);

  const dataUrl = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const candidateUrls = [...SEC_CORS_PROXIES.map((buildProxyUrl) => buildProxyUrl(dataUrl)), dataUrl];

  for (const candidateUrl of candidateUrls) {
    try {
      const response = await fetchWithTimeout(candidateUrl);
      if (!response.ok) continue;
      const payload = await response.json();
      const ticker = (payload?.tickers || [])[0] || null;
      if (ticker) {
        cikTickerCache.set(cik, ticker.toUpperCase());
        return ticker.toUpperCase();
      }
    } catch (_error) {
      // Continue trying alternate URLs/proxies.
    }
  }

  cikTickerCache.set(cik, null);
  return null;
}

async function fetchCikForTicker(ticker) {
  const normalizedTicker = String(ticker || "").toUpperCase();
  if (!normalizedTicker) return null;
  if (tickerCikCache.has(normalizedTicker)) return tickerCikCache.get(normalizedTicker);

  const mappingUrl = "https://www.sec.gov/files/company_tickers.json";
  const candidateUrls = [...SEC_CORS_PROXIES.map((buildProxyUrl) => buildProxyUrl(mappingUrl)), mappingUrl];

  for (const candidateUrl of candidateUrls) {
    try {
      const response = await fetchWithTimeout(candidateUrl, {}, 12_000);
      if (!response.ok) continue;
      const payload = await response.json();
      const match = Object.values(payload || {}).find((item) => String(item?.ticker || "").toUpperCase() === normalizedTicker);
      if (!match?.cik_str) continue;
      const cik = String(match.cik_str).padStart(10, "0");
      tickerCikCache.set(normalizedTicker, cik);
      cikTickerCache.set(cik, normalizedTicker);
      return cik;
    } catch (_error) {
      // Continue trying alternate URLs/proxies.
    }
  }

  tickerCikCache.set(normalizedTicker, null);
  return null;
}

async function fetchSecFilingCurrencyStatus(ticker) {
  const cik = await fetchCikForTicker(ticker);
  if (!cik) return null;

  const dataUrl = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const candidateUrls = [...SEC_CORS_PROXIES.map((buildProxyUrl) => buildProxyUrl(dataUrl)), dataUrl];

  for (const candidateUrl of candidateUrls) {
    try {
      const response = await fetchWithTimeout(candidateUrl, {}, 12_000);
      if (!response.ok) continue;
      const payload = await response.json();
      const forms = payload?.filings?.recent?.form || [];
      const dates = payload?.filings?.recent?.filingDate || [];

      let latestPeriodic = null;
      let latestNt = null;
      for (let index = 0; index < forms.length; index += 1) {
        const form = String(forms[index] || "").toUpperCase();
        const date = dates[index] || null;
        if (!date) continue;
        if (!latestPeriodic && (form === "10-Q" || form === "10-K")) {
          latestPeriodic = date;
        }
        if (!latestNt && (form === "NT 10-Q" || form === "NT 10-K")) {
          latestNt = date;
        }
        if (latestPeriodic && latestNt) break;
      }

      const isCurrent = latestNt
        ? (latestPeriodic ? new Date(latestPeriodic) >= new Date(latestNt) : false)
        : true;
      return { isCurrent, latestPeriodic, latestNt };
    } catch (_error) {
      // Continue trying alternate URLs/proxies.
    }
  }

  return null;
}

async function buildStockFromFiling(filing) {
  const filingText = `${filing.title} ${filing.summary}`;
  let ticker = extractTickerFromText(filingText);
  if (!ticker) {
    const cik = extractCikFromSecLink(filing.link);
    ticker = await fetchTickerForCik(cik);
  }
  if (!ticker) return null;

  return normalizeStock({
    ticker,
    company: filing.company || `${ticker} (from SEC filing scan)`,
    price: Number.NaN,
    marketCap: Number.NaN,
    avgVolume: Number.NaN,
    avgPrice30d: Number.NaN,
    avgMarketCap30d: Number.NaN,
    reverseSplitPastYear: false,
    filingsCurrent: null,
    delistReason: inferReasonFromText(filingText),
    expectedDelistingDate: filing.filedDate || undefined,
    secFilingUrl: filing.link || `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(ticker)}`,
    notes: `Auto-discovered from SEC recent filings: ${filing.title}`.slice(0, 400),
    signals: {},
    dataAsOf: new Date().toISOString()
  });
}

async function fetchSecRecentFilingsForQuery(query) {
  const formTypes = query.forms.split(",").map((form) => form.trim()).filter(Boolean);
  const allEntries = [];

  for (const formType of formTypes) {
    const url = new URL("https://www.sec.gov/cgi-bin/browse-edgar");
    url.searchParams.set("action", "getcurrent");
    url.searchParams.set("owner", "include");
    url.searchParams.set("count", String(SEC_MAX_ENTRIES_PER_QUERY));
    url.searchParams.set("output", "atom");
    url.searchParams.set("type", formType);

    const targetUrl = url.toString();
    const candidateUrls = [...SEC_CORS_PROXIES.map((buildProxyUrl) => buildProxyUrl(targetUrl)), targetUrl];

    let xmlText = "";
    let lastError = null;

    for (const candidateUrl of candidateUrls) {
      try {
        const response = await fetchWithTimeout(candidateUrl);
        if (!response.ok) {
          lastError = new Error(`status ${response.status}`);
          continue;
        }
        xmlText = await response.text();
        if (xmlText.trim()) {
          break;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (!xmlText.trim()) {
      const detail = lastError instanceof Error ? lastError.message : "unknown error";
      throw new Error(`SEC feed request failed for ${query.label} (${formType}): ${detail}`);
    }

    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlText, "application/xml");
    const parseError = xml.querySelector("parsererror");
    if (parseError) {
      throw new Error(`SEC feed parse error for ${query.label} (${formType})`);
    }

    const entries = Array.from(xml.querySelectorAll("entry"));
    allEntries.push(...entries);
  }

  return allEntries
    .map((entry) => {
      const title = entry.querySelector("title")?.textContent?.trim() || "";
      const summary = entry.querySelector("summary")?.textContent?.trim() || "";
      const company = entry.querySelector("conformed-name")?.textContent?.trim() || "";
      const filedDate = entry.querySelector("filing-date")?.textContent?.trim() || "";
      const link = entry.querySelector("link")?.getAttribute("href") || "";
      const formType = entry.querySelector("category")?.getAttribute("term")?.trim() || "";

      return { title, summary, company, filedDate, link, formType };
    })
    .filter((filing) => shouldIncludeFilingForQuery(query, filing));
}

async function discoverStocksFromSecFilings() {
  const byTicker = new Map();
  const warnings = [];

  const filings = await fetchSecRecentFilingsForQuery(SEC_DISCOVERY_QUERY);
  for (const filing of filings) {
    const stock = await buildStockFromFiling(filing);
    if (stock) byTicker.set(stock.ticker, stock);
  }

  return { stocks: Array.from(byTicker.values()), warnings };
}

function populateReasonOptions() {
  const selected = reasonFilter.value;
  const reasons = [...new Set(stocks.map((stock) => stock.delistReason))].sort();
  reasonFilter.innerHTML = '<option value="all">All reasons</option>';

  reasons.forEach((reason) => {
    const option = document.createElement("option");
    option.value = reason;
    option.textContent = reason;
    reasonFilter.appendChild(option);
  });

  reasonFilter.value = reasons.includes(selected) ? selected : "all";
}

function getVisibleStocks() {
  const search = searchInput.value.trim().toLowerCase();
  const reason = reasonFilter.value;
  const minChance = Number(chanceFilter.value || 0);

  return stocks
    .filter((stock) => {
      const matchesSearch =
        stock.ticker.toLowerCase().includes(search) || stock.company.toLowerCase().includes(search);
      const matchesReason = reason === "all" || stock.delistReason === reason;
      const matchesChance = stock.delistingChance >= minChance;

      return matchesSearch && matchesReason && matchesChance;
    })
    .sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];

      const normalize = (value) => {
        if (value === null || value === undefined) return -Infinity;
        if (typeof value === "boolean") return value ? 1 : 0;
        if (sortKey === "expectedDelistingDate") return new Date(value).getTime();
        return value;
      };

      const aa = normalize(aVal);
      const bb = normalize(bVal);

      if (typeof aa === "string" && typeof bb === "string") {
        return sortDir === "asc" ? aa.localeCompare(bb) : bb.localeCompare(aa);
      }
      return sortDir === "asc" ? aa - bb : bb - aa;
    });
}

function renderTable() {
  const visibleStocks = getVisibleStocks();
  tableBody.innerHTML = "";

  visibleStocks.forEach((stock) => {
    const tr = document.createElement("tr");
    tr.dataset.ticker = stock.ticker;

    if (stock.ticker === selectedTicker) {
      tr.classList.add("selected");
    }

    const risk = riskLabel(stock.delistingChance);

    appendCell(tr, stock.ticker);
    appendCell(tr, stock.company);
    appendCell(tr, formatMoney(stock.price));
    appendCell(tr, formatCompactMoney(stock.marketCap));
    appendCell(tr, formatNumber(stock.avgVolume));
    appendCell(tr, formatMoney(stock.avgPrice30d));
    appendCell(tr, formatCompactMoney(stock.avgMarketCap30d));
    appendCell(tr, stock.reverseSplitPastYear ? "Yes" : "No");
    appendCell(tr, stock.filingsCurrent === null ? "Unknown" : stock.filingsCurrent ? "Yes" : "No");
    appendCell(tr, stock.delistReason);
    appendCell(tr, stock.expectedDelistingDate);

    const riskCell = document.createElement("td");
    const riskPill = document.createElement("span");
    riskPill.className = `pill ${risk.cls}`;
    riskPill.textContent = risk.text;
    riskCell.appendChild(riskPill);
    tr.appendChild(riskCell);

    tr.addEventListener("click", () => {
      selectedTicker = stock.ticker;
      renderTable();
      renderDetails(stock);
    });

    tableBody.appendChild(tr);
  });

  if (!visibleStocks.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="12">No stocks match current filters.</td>';
    tableBody.appendChild(tr);
    detailsContent.innerHTML = "";
  }
}

function renderDetails(stock) {
  if (!stock) {
    detailsContent.innerHTML = "";
    return;
  }

  const risk = riskLabel(stock.delistingChance);
  const safeSecUrl = isSafeExternalUrl(stock.secFilingUrl) ? stock.secFilingUrl : "#";

  detailsContent.innerHTML = `
    <dl>
      <dt>Ticker</dt><dd>${stock.ticker}</dd>
      <dt>Company</dt><dd>${stock.company}</dd>
      <dt>Delist Reason</dt><dd>${stock.delistReason}</dd>
      <dt>Expected Delisting Date</dt><dd>${stock.expectedDelistingDate}</dd>
      <dt>Estimated Delisting Chance</dt><dd><span class="pill ${risk.cls}">${risk.text}</span></dd>
      <dt>Price</dt><dd>${formatMoney(stock.price)}</dd>
      <dt>Market Cap</dt><dd>${formatCompactMoney(stock.marketCap)}</dd>
      <dt>Average Volume</dt><dd>${formatNumber(stock.avgVolume)}</dd>
      <dt>30-Day Avg Price</dt><dd>${formatMoney(stock.avgPrice30d)}</dd>
      <dt>30-Day Avg Market Cap</dt><dd>${formatCompactMoney(stock.avgMarketCap30d)}</dd>
      <dt>Reverse Split (Past Year)</dt><dd>${stock.reverseSplitPastYear ? "Yes" : "No"}</dd>
      <dt>Current on 10-K/10-Q Filings</dt><dd>${stock.filingsCurrent === null ? "Unknown" : stock.filingsCurrent ? "Yes" : "No"}</dd>
      <dt>Data as of</dt><dd>${formatTimestamp(stock.dataAsOf)}</dd>
      <dt>Notes</dt><dd>${stock.notes}</dd>
      <dt>SEC Filing</dt><dd><a href="${safeSecUrl}" target="_blank" rel="noreferrer">Open SEC filing/search</a></dd>
    </dl>
  `;
}

function applySortHeaderUI() {
  headers.forEach((header) => {
    header.classList.remove("sort-asc", "sort-desc");
    if (header.dataset.key === sortKey) {
      header.classList.add(sortDir === "asc" ? "sort-asc" : "sort-desc");
    }
  });
}

function updateStatus(message) {
  if (liveStatusEl) {
    liveStatusEl.textContent = message;
  }
  if (lastUpdatedEl) {
    lastUpdatedEl.textContent = dataGeneratedAt ? `Dataset: ${formatTimestamp(dataGeneratedAt)}` : "Dataset: n/a";
  }
}

async function loadDataset() {
  const response = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load stock dataset (${response.status})`);
  }

  const payload = await response.json();
  dataGeneratedAt = payload.generatedAt || new Date().toISOString();
  stocks = (payload.stocks || []).map(normalizeStock);

  let secScanSummary = {
    discoveredCount: 0,
    warnings: [],
    failed: false,
    errorMessage: null,
  };

  try {
    const { stocks: discoveredStocks, warnings } = await discoverStocksFromSecFilings();
    secScanSummary = {
      discoveredCount: discoveredStocks.length,
      warnings,
      failed: false,
      errorMessage: null,
    };
    if (discoveredStocks.length) {
      const seeded = new Map(stocks.map((stock) => [stock.ticker, stock]));
      for (const stock of discoveredStocks) {
        seeded.set(stock.ticker, { ...stock, ...(seeded.get(stock.ticker) || {}) });
      }
      stocks = Array.from(seeded.values());
      const warningSuffix = warnings.length ? ` (${warnings.length} SEC sub-query failures ignored).` : "";
      updateStatus(`SEC scan found ${discoveredStocks.length} symbols from recent filing queries.${warningSuffix}`);
    } else if (warnings.length) {
      updateStatus(`SEC scan found 0 symbols (${warnings[0]}). Using dataset values.`);
    }
  } catch (error) {
    secScanSummary = {
      discoveredCount: 0,
      warnings: [],
      failed: true,
      errorMessage: error.message,
    };
    updateStatus(`SEC filing scan failed (${error.message}). Using local dataset values.`);
  }

  populateReasonOptions();

  if (!selectedTicker || !stocks.some((stock) => stock.ticker === selectedTicker)) {
    selectedTicker = stocks[0]?.ticker || null;
  }

  const selectedStock = stocks.find((stock) => stock.ticker === selectedTicker);
  renderTable();
  renderDetails(selectedStock);

  return secScanSummary;
}

async function refreshLiveQuotes() {
  if (!stocks.length || !liveQuoteSyncEnabled) return;
  const symbols = stocks.map((stock) => stock.ticker);

  try {
    let yahooError = null;
    let yahooQuotes = new Map();

    try {
      yahooQuotes = await fetchYahooBatchQuotes(symbols);
    } catch (error) {
      yahooError = error;
    }

    const missingSymbols = [];
    let updated = 0;

    stocks = stocks.map((stock) => {
      const quote = yahooQuotes.get(stock.ticker);
      if (!quote) {
        missingSymbols.push(stock.ticker);
        return stock;
      }

      updated += 1;
      const avgVolume = Number.isFinite(quote.averageDailyVolume3Month)
        ? quote.averageDailyVolume3Month
        : quote.regularMarketVolume;

      const nextStock = {
        ...stock,
        price: Number.isFinite(quote.regularMarketPrice) ? quote.regularMarketPrice : stock.price,
        marketCap: Number.isFinite(quote.marketCap) ? quote.marketCap : stock.marketCap,
        avgVolume: Number.isFinite(avgVolume) ? avgVolume : stock.avgVolume,
        dataAsOf: quote.regularMarketTime
          ? new Date(quote.regularMarketTime * 1000).toISOString()
          : stock.dataAsOf,
      };

      if (!Number.isFinite(nextStock.price) || !Number.isFinite(nextStock.marketCap)) {
        missingSymbols.push(stock.ticker);
      }

      return nextStock;
    });

    let nasdaqUpdated = 0;
    if (missingSymbols.length) {
      const uniqueMissingSymbols = [...new Set(missingSymbols)];
      const fallbackResults = await Promise.allSettled(uniqueMissingSymbols.map((symbol) => fetchNasdaqQuote(symbol)));
      const fallbackBySymbol = new Map(
        uniqueMissingSymbols.map((symbol, index) => [symbol, fallbackResults[index]])
      );

      stocks = stocks.map((stock) => {
        const result = fallbackBySymbol.get(stock.ticker);
        if (!result || result.status !== "fulfilled" || !result.value) return stock;

        const nextStock = {
          ...stock,
          price: Number.isFinite(stock.price) ? stock.price : result.value.price,
          marketCap: Number.isFinite(stock.marketCap) ? stock.marketCap : result.value.marketCap,
          avgVolume: Number.isFinite(stock.avgVolume) ? stock.avgVolume : result.value.avgVolume,
          dataAsOf: stock.dataAsOf || result.value.dataAsOf || stock.dataAsOf,
        };

        if (
          nextStock.price !== stock.price ||
          nextStock.marketCap !== stock.marketCap ||
          nextStock.avgVolume !== stock.avgVolume
        ) {
          nasdaqUpdated += 1;
        }

        return nextStock;
      });
    }

    const enrichmentTargets = stocks.filter(
      (stock) =>
        stock.ticker === selectedTicker ||
        !Number.isFinite(stock.avgPrice30d) ||
        !Number.isFinite(stock.avgMarketCap30d) ||
        stock.filingsCurrent === null
    );
    const enrichmentResults = await Promise.allSettled(
      enrichmentTargets.map((stock) => fetchMarketDetails(stock.ticker))
    );
    const enrichmentByTicker = new Map(
      enrichmentTargets.map((stock, index) => [stock.ticker, enrichmentResults[index]])
    );

    stocks = stocks.map((stock) => {
      const result = enrichmentByTicker.get(stock.ticker);
      if (!result || result.status !== "fulfilled" || !result.value) return stock;

      return {
        ...stock,
        ...result.value,
        price: Number.isFinite(result.value.price) ? result.value.price : stock.price,
        marketCap: Number.isFinite(result.value.marketCap) ? result.value.marketCap : stock.marketCap,
        avgVolume: Number.isFinite(result.value.avgVolume) ? result.value.avgVolume : stock.avgVolume,
        avgPrice30d: Number.isFinite(result.value.avgPrice30d) ? result.value.avgPrice30d : stock.avgPrice30d,
        avgMarketCap30d: Number.isFinite(result.value.avgMarketCap30d)
          ? result.value.avgMarketCap30d
          : stock.avgMarketCap30d,
        reverseSplitPastYear: Boolean(result.value.reverseSplitPastYear || stock.reverseSplitPastYear),
        filingsCurrent: result.value.filingsCurrent === null || result.value.filingsCurrent === undefined
          ? stock.filingsCurrent
          : result.value.filingsCurrent,
        exchange: result.value.exchange || stock.exchange,
        dataAsOf: result.value.dataAsOf || stock.dataAsOf,
      };
    });

    stocks = stocks.filter((stock) => isListedOnMajorExchange(stock.exchange));

    if (!stocks.some((stock) => stock.ticker === selectedTicker)) {
      selectedTicker = stocks[0]?.ticker || null;
    }
    renderTable();
    renderDetails(stocks.find((stock) => stock.ticker === selectedTicker));

    if (!updated && !nasdaqUpdated && yahooError) {
      throw yahooError;
    }

    const sourceSummary = nasdaqUpdated
      ? ` Yahoo updated ${updated}/${stocks.length}; Nasdaq fallback filled ${nasdaqUpdated}.`
      : ` Yahoo updated ${updated}/${stocks.length}.`;
    updateStatus(`Live quotes synced at ${new Date().toLocaleTimeString()}.${sourceSummary}`);
  } catch (error) {
    const isNetworkOrCorsIssue = error instanceof TypeError;
    if (isNetworkOrCorsIssue) {
      liveQuoteSyncEnabled = false;
      if (liveQuoteTimerId) {
        window.clearInterval(liveQuoteTimerId);
        liveQuoteTimerId = null;
      }
      updateStatus(
        "Live quote sync is unavailable in this browser/session (network or CORS restriction). Using dataset values only."
      );
      return;
    }

    updateStatus(`Live quote sync failed (${error.message}). Retrying automatically.`);
  }
}

async function fetchJsonWithFallback(url, proxyBuilders, timeoutMs = 8000) {
  const candidateUrls = [...proxyBuilders.map((buildProxyUrl) => buildProxyUrl(url)), url];
  let lastError = null;

  for (const candidateUrl of candidateUrls) {
    try {
      const response = await fetchWithTimeout(candidateUrl, { cache: "no-store" }, timeoutMs);
      if (!response.ok) {
        lastError = new Error(`status ${response.status}`);
        continue;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : "unknown error";
  throw new Error(`Market data request failed: ${detail}`);
}

async function fetchJsonFromMarketSource(url, timeoutMs = 8000) {
  return fetchJsonWithFallback(url, MARKET_DATA_PROXIES, timeoutMs);
}

async function fetchYahooBatchQuotes(symbols) {
  const payload = await fetchJsonFromMarketSource(
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}`
  );
  const quotes = payload?.quoteResponse?.result || [];
  return new Map(quotes.map((quote) => [quote.symbol, quote]));
}

async function fetchNasdaqQuote(symbol) {
  const payload = await fetchJsonFromMarketSource(NASDAQ_SUMMARY_URL(symbol));
  return parseNasdaqQuoteSummary(payload);
}

async function fetchYahooChart(symbol) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - (366 * 24 * 60 * 60);
  return fetchJsonFromMarketSource(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${start}&period2=${end}&interval=1d&events=split`
  );
}

async function fetchMarketDetails(symbol) {
  const quoteSummaryUrl =
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
    "?modules=price,summaryDetail,defaultKeyStatistics,financialData";

  const [summaryPayload, nasdaqPayload, chartPayload, filingStatus] = await Promise.all([
    fetchJsonFromMarketSource(quoteSummaryUrl).catch(() => null),
    fetchJsonFromMarketSource(NASDAQ_SUMMARY_URL(symbol)).catch(() => null),
    fetchYahooChart(symbol).catch(() => null),
    fetchSecFilingCurrencyStatus(symbol).catch(() => null),
  ]);

  const result = summaryPayload?.quoteSummary?.result?.[0] || {};
  const price = result.price || {};
  const summaryDetail = result.summaryDetail || {};
  const financialData = result.financialData || {};
  const defaultKeyStatistics = result.defaultKeyStatistics || {};
  const nasdaqFallback = parseNasdaqQuoteSummary(nasdaqPayload);
  const chartResult = chartPayload?.chart?.result?.[0];
  const closes = (chartResult?.indicators?.quote?.[0]?.close || []).filter((value) => Number.isFinite(value));
  const recent30Closes = closes.slice(-30);
  const avgPrice30d = recent30Closes.length
    ? recent30Closes.reduce((sum, value) => sum + value, 0) / recent30Closes.length
    : Number.NaN;
  const sharesOutstanding = firstFinite(
    readRawValue(defaultKeyStatistics.sharesOutstanding),
    readRawValue(price.sharesOutstanding)
  );
  const marketCapFromShares = Number.isFinite(sharesOutstanding) && Number.isFinite(avgPrice30d)
    ? sharesOutstanding * avgPrice30d
    : Number.NaN;

  const splitEvents = chartResult?.events?.splits || {};
  const oneYearAgoEpoch = Math.floor(Date.now() / 1000) - (365 * 24 * 60 * 60);
  const reverseSplitPastYear = Object.values(splitEvents).some((event) => {
    const splitDate = Number(event?.date);
    const numerator = Number(event?.numerator);
    const denominator = Number(event?.denominator);
    if (!Number.isFinite(splitDate) || splitDate < oneYearAgoEpoch) return false;
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return false;
    return numerator < denominator;
  });

  return {
    price: firstFinite(
      readRawValue(price.regularMarketPrice),
      readRawValue(financialData.currentPrice),
      readRawValue(summaryDetail.previousClose),
      nasdaqFallback.price
    ),
    marketCap: firstFinite(
      readRawValue(price.marketCap),
      readRawValue(defaultKeyStatistics.marketCap),
      nasdaqFallback.marketCap,
      marketCapFromShares
    ),
    avgVolume: firstFinite(
      readRawValue(summaryDetail.averageVolume),
      readRawValue(summaryDetail.averageVolume10days),
      readRawValue(summaryDetail.volume),
      readRawValue(price.regularMarketVolume),
      nasdaqFallback.avgVolume
    ),
    avgPrice30d,
    avgMarketCap30d: firstFinite(marketCapFromShares, Number.NaN),
    reverseSplitPastYear,
    filingsCurrent: filingStatus?.isCurrent ?? null,
    exchange: price.exchangeName || price.fullExchangeName || price.exchange || null,
    dataAsOf: nasdaqFallback.dataAsOf || new Date().toISOString(),
  };
}

async function init() {
  try {
    const secScanSummary = await loadDataset();
    if (!stocks.length) {
      if (secScanSummary.failed) {
        updateStatus(
          `Dataset has 0 tracked symbols and SEC scan failed (${secScanSummary.errorMessage}). ` +
          "For best reliability in static hosting environments (e.g., GitHub Pages), run with `node server.js` when possible."
        );
      } else {
        updateStatus("Dataset loaded with no tracked symbols. Add symbols to data/stocks.json to enable live quotes.");
      }
    } else {
      updateStatus("Dataset loaded. Waiting for live quote sync...");
      await refreshLiveQuotes();
    }
  } catch (error) {
    updateStatus(`Unable to initialize data: ${error.message}`);
  }

  window.setInterval(() => {
    loadDataset().catch((error) => {
      updateStatus(`Dataset refresh failed (${error.message}).`);
    });
  }, DATA_REFRESH_MS);

  liveQuoteTimerId = window.setInterval(() => {
    refreshLiveQuotes();
  }, LIVE_QUOTE_REFRESH_MS);
}

searchInput.addEventListener("input", renderTable);
reasonFilter.addEventListener("change", renderTable);
chanceFilter.addEventListener("input", renderTable);

headers.forEach((header) => {
  header.addEventListener("click", () => {
    const { key } = header.dataset;
    if (sortKey === key) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDir = "asc";
    }
    applySortHeaderUI();
    renderTable();
  });
});

applySortHeaderUI();
init();
