const DATA_URL = "data/stocks.json";
const LIVE_QUOTE_REFRESH_MS = 60_000;
const DATA_REFRESH_MS = 900_000;
const SEC_MAX_ENTRIES_PER_QUERY = 40;
const SEC_CORS_PROXIES = [
  (url) => `/api/sec-proxy?url=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];
const MARKET_DATA_PROXY = (url) => `/api/market-proxy?url=${encodeURIComponent(url)}`;
const NASDAQ_SUMMARY_URL = (symbol) => `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/summary?assetclass=stocks`;

const {
  computeOptionIvFromChain,
  firstFinite,
  parseNasdaqQuoteSummary,
  readRawValue,
} = window.MarketDataUtils;

const SEC_DISCOVERY_QUERIES = [
  {
    label: "Exchange delisting notices",
    forms: "25-NSE,25,8-K",
    keywords: ["notice of delisting", "delisting", "suspended from trading"],
    reason: "Notice of delisting"
  },
  {
    label: "Late filing notices",
    forms: "NT 10-K,NT 10-Q,8-K",
    keywords: ["unable to file", "late filing", "notification of late filing"],
    reason: "Late SEC filing (10-K / 10-Q)"
  },
  {
    label: "Bankruptcy/restructuring events",
    forms: "8-K",
    keywords: ["bankruptcy", "chapter 11", "restructuring support agreement"],
    reason: "Bankruptcy / restructuring proceedings"
  },
  {
    label: "Bid-price / compliance notices",
    forms: "8-K",
    keywords: ["minimum bid price", "non-compliance", "listing standards"],
    reason: "Minimum bid price non-compliance"
  }
];

const tableBody = document.querySelector("#stocksTable tbody");
const searchInput = document.getElementById("searchInput");
const reasonFilter = document.getElementById("reasonFilter");
const expertFilter = document.getElementById("expertFilter");
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

  for (const query of SEC_DISCOVERY_QUERIES) {
    if (query.keywords.some((keyword) => normalized.includes(keyword))) {
      return query.reason;
    }
  }

  return "Elevated listing-compliance risk";
}

function shouldIncludeFilingForQuery(query, filing) {
  const haystack = `${filing.title} ${filing.summary}`.toLowerCase();
  const keywordMatch = query.keywords.some((keyword) => haystack.includes(keyword));
  if (keywordMatch) return true;

  const formType = (filing.formType || "").toUpperCase();

  // Some form types are intrinsically delisting-risk signals even without keyword matches.
  if (query.reason === "Notice of delisting" && ["25", "25-NSE"].includes(formType)) {
    return true;
  }
  if (query.reason === "Late SEC filing (10-K / 10-Q)" && ["NT 10-K", "NT 10-Q"].includes(formType)) {
    return true;
  }

  return false;
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
    shortBorrowCost: Number.NaN,
    optionIV: Number.NaN,
    expertMarketEligible: false,
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

  for (const query of SEC_DISCOVERY_QUERIES) {
    const filings = await fetchSecRecentFilingsForQuery(query);
    for (const filing of filings) {
      const stock = await buildStockFromFiling(filing);
      if (stock) byTicker.set(stock.ticker, stock);
    }
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
  const expert = expertFilter.value;
  const minChance = Number(chanceFilter.value || 0);

  return stocks
    .filter((stock) => {
      const matchesSearch =
        stock.ticker.toLowerCase().includes(search) || stock.company.toLowerCase().includes(search);
      const matchesReason = reason === "all" || stock.delistReason === reason;
      const matchesExpert =
        expert === "all" || (expert === "yes" ? stock.expertMarketEligible : !stock.expertMarketEligible);
      const matchesChance = stock.delistingChance >= minChance;

      return matchesSearch && matchesReason && matchesExpert && matchesChance;
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
    appendCell(tr, formatPct(stock.shortBorrowCost));
    appendCell(tr, Number.isFinite(stock.optionIV) ? `${stock.optionIV}%` : "N/A");
    appendCell(tr, stock.delistReason);
    appendCell(tr, stock.expectedDelistingDate);
    appendCell(tr, stock.expertMarketEligible ? "Yes" : "No");

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
    tr.innerHTML = '<td colspan="11">No stocks match current filters.</td>';
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
      <dt>Short Borrow Cost</dt><dd>${formatPct(stock.shortBorrowCost)}</dd>
      <dt>Option IV</dt><dd>${Number.isFinite(stock.optionIV) ? `${stock.optionIV}%` : "N/A"}</dd>
      <dt>Potential Expert Market</dt><dd>${stock.expertMarketEligible ? "Yes" : "No"}</dd>
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

  try {
    const { stocks: discoveredStocks, warnings } = await discoverStocksFromSecFilings();
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
    updateStatus(`SEC filing scan failed (${error.message}). Using local dataset values.`);
  }

  populateReasonOptions();

  if (!selectedTicker || !stocks.some((stock) => stock.ticker === selectedTicker)) {
    selectedTicker = stocks[0]?.ticker || null;
  }

  const selectedStock = stocks.find((stock) => stock.ticker === selectedTicker);
  renderTable();
  renderDetails(selectedStock);
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
        !Number.isFinite(stock.shortBorrowCost) ||
        !Number.isFinite(stock.optionIV)
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
        shortBorrowCost: Number.isFinite(result.value.shortBorrowCost)
          ? result.value.shortBorrowCost
          : stock.shortBorrowCost,
        optionIV: Number.isFinite(result.value.optionIV) ? result.value.optionIV : stock.optionIV,
        dataAsOf: result.value.dataAsOf || stock.dataAsOf,
      };
    });

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

async function fetchJsonFromMarketProxy(url, timeoutMs = 8000) {
  const response = await fetchWithTimeout(MARKET_DATA_PROXY(url), { cache: "no-store" }, timeoutMs);
  if (!response.ok) {
    throw new Error(`Market data request failed (${response.status})`);
  }
  return response.json();
}

async function fetchYahooBatchQuotes(symbols) {
  const payload = await fetchJsonFromMarketProxy(
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}`
  );
  const quotes = payload?.quoteResponse?.result || [];
  return new Map(quotes.map((quote) => [quote.symbol, quote]));
}

async function fetchNasdaqQuote(symbol) {
  const payload = await fetchJsonFromMarketProxy(NASDAQ_SUMMARY_URL(symbol));
  return parseNasdaqQuoteSummary(payload);
}

async function fetchMarketDetails(symbol) {
  const quoteSummaryUrl =
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
    "?modules=price,summaryDetail,defaultKeyStatistics,financialData";
  const optionsUrl = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;

  const [summaryPayload, optionsPayload, nasdaqPayload] = await Promise.all([
    fetchJsonFromMarketProxy(quoteSummaryUrl).catch(() => null),
    fetchJsonFromMarketProxy(optionsUrl).catch(() => null),
    fetchJsonFromMarketProxy(NASDAQ_SUMMARY_URL(symbol)).catch(() => null),
  ]);

  const result = summaryPayload?.quoteSummary?.result?.[0] || {};
  const price = result.price || {};
  const summaryDetail = result.summaryDetail || {};
  const defaultKeyStatistics = result.defaultKeyStatistics || {};
  const financialData = result.financialData || {};
  const nasdaqFallback = parseNasdaqQuoteSummary(nasdaqPayload);

  return {
    price: firstFinite(
      readRawValue(price.regularMarketPrice),
      readRawValue(financialData.currentPrice),
      nasdaqFallback.price
    ),
    marketCap: firstFinite(readRawValue(price.marketCap), nasdaqFallback.marketCap),
    avgVolume: firstFinite(
      readRawValue(summaryDetail.averageVolume),
      readRawValue(summaryDetail.averageVolume10days),
      readRawValue(summaryDetail.volume),
      nasdaqFallback.avgVolume
    ),
    shortBorrowCost: firstFinite(
      readRawValue(summaryDetail.borrowFee),
      readRawValue(defaultKeyStatistics.borrowFee),
      readRawValue(defaultKeyStatistics.shortPercentOfFloat)
    ),
    optionIV: computeOptionIvFromChain(optionsPayload),
    dataAsOf: nasdaqFallback.dataAsOf || new Date().toISOString(),
  };
}

async function init() {
  try {
    await loadDataset();
    if (!stocks.length) {
      updateStatus("Dataset loaded with no tracked symbols. Add symbols to data/stocks.json to enable live quotes.");
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
expertFilter.addEventListener("change", renderTable);
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
