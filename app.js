const SEC_SEARCH_URL = "https://efts.sec.gov/LATEST/search-index";
const LIVE_QUOTE_REFRESH_MS = 60_000;
const SEC_SCAN_REFRESH_MS = 15 * 60_000;
const MAX_STOCKS = 15;

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

const DELISTING_QUERIES = [
  { text: '"minimum bid price"', label: "Minimum bid price non-compliance", weight: 28 },
  { text: '"listing standards" deficiency', label: "Exchange listing standards deficiency", weight: 24 },
  { text: '"delisting" "notice"', label: "Delisting notice / warning", weight: 26 },
  { text: '"non-compliance" "Nasdaq"', label: "Nasdaq non-compliance", weight: 22 },
  { text: '"item 3.01" "8-k"', label: "8-K listing-compliance disclosure", weight: 18 },
  { text: '"form 25" "withdrawal from listing"', label: "Exchange withdrawal filing", weight: 32 },
];

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
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "N/A";
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

function scoreFromSignals(rawScore) {
  return Math.max(15, Math.min(97, Math.round(rawScore)));
}

function expectedDelistingDateFrom(dateStr) {
  const base = dateStr ? new Date(dateStr) : new Date();
  const date = Number.isNaN(base.getTime()) ? new Date() : base;
  date.setDate(date.getDate() + 30);
  return date.toISOString().slice(0, 10);
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
      <dt>SEC Filing</dt><dd><a href="${safeSecUrl}" target="_blank" rel="noreferrer">Open filing details</a></dd>
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

function parseSecHit(hit, queryMeta) {
  const source = hit?._source || {};
  const ticker = Array.isArray(source.tickers) ? source.tickers[0] : null;
  if (!ticker || !/^[A-Z.]{1,6}$/.test(ticker)) return null;

  const filedAt = source.filedAt || source.period_ending || null;
  const filedMs = filedAt ? Date.parse(filedAt) : Date.now();
  const ageDays = Math.max(0, (Date.now() - filedMs) / (1000 * 60 * 60 * 24));
  const recencyBonus = Math.max(0, 18 - ageDays * 0.6);

  const filingUrl = source.linkToHtml || source.linkToFilingDetails || source.linkToTxt || "";

  return {
    ticker,
    company: source.display_names?.[0] || source.companyName || ticker,
    filedAt,
    filingUrl,
    baseReason: queryMeta.label,
    score: queryMeta.weight + recencyBonus,
  };
}

async function searchSecForQuery(queryMeta) {
  const body = {
    q: queryMeta.text,
    from: 0,
    size: 25,
    sort: [{ filedAt: { order: "desc" } }],
  };

  const response = await fetch(SEC_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`SEC search failed (${response.status})`);
  }

  const payload = await response.json();
  const hits = payload?.hits?.hits || [];
  return hits.map((hit) => parseSecHit(hit, queryMeta)).filter(Boolean);
}

async function loadStocksFromSec() {
  updateStatus("Loading stocks from latest SEC filings...");

  const allHits = [];
  for (const queryMeta of DELISTING_QUERIES) {
    try {
      const hits = await searchSecForQuery(queryMeta);
      allHits.push(...hits);
    } catch (_error) {
      // keep trying remaining queries
    }
  }

  const aggregate = new Map();
  allHits.forEach((hit) => {
    const current = aggregate.get(hit.ticker) || {
      ticker: hit.ticker,
      company: hit.company,
      score: 0,
      reasons: new Set(),
      latestFiledAt: hit.filedAt,
      secFilingUrl: hit.filingUrl,
      matchCount: 0,
    };

    current.score += hit.score;
    current.matchCount += 1;
    current.reasons.add(hit.baseReason);

    if (!current.latestFiledAt || (hit.filedAt && Date.parse(hit.filedAt) > Date.parse(current.latestFiledAt))) {
      current.latestFiledAt = hit.filedAt;
      current.secFilingUrl = hit.filingUrl || current.secFilingUrl;
    }

    aggregate.set(hit.ticker, current);
  });

  const ranked = [...aggregate.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_STOCKS)
    .map((item) => {
      const riskScore = scoreFromSignals(25 + item.score * 0.8 + item.matchCount * 3);
      const primaryReason = [...item.reasons][0] || "Elevated listing-compliance risk";
      return {
        ticker: item.ticker,
        company: item.company,
        price: null,
        marketCap: null,
        avgVolume: null,
        shortBorrowCost: null,
        optionIV: null,
        delistReason: primaryReason,
        expectedDelistingDate: expectedDelistingDateFrom(item.latestFiledAt),
        expertMarketEligible: riskScore >= 70,
        delistingChance: riskScore,
        secFilingUrl: item.secFilingUrl || `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(item.ticker)}`,
        notes: `Derived from ${item.matchCount} recent SEC filing match(es): ${[...item.reasons].join(", ")}.`,
        dataAsOf: item.latestFiledAt,
      };
    });

  if (!ranked.length) {
    throw new Error("No delisting candidates returned from SEC search.");
  }

  stocks = ranked;
  dataGeneratedAt = new Date().toISOString();

  populateReasonOptions();
  selectedTicker = stocks[0]?.ticker || null;
  renderTable();
  renderDetails(stocks[0] || null);
}

async function refreshLiveQuotes() {
  if (!stocks.length) return;
  const symbols = stocks.map((stock) => stock.ticker).join(",");

  try {
    const response = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}`);
    if (!response.ok) {
      throw new Error(`Quote API returned ${response.status}`);
    }

    const payload = await response.json();
    const quotes = payload?.quoteResponse?.result || [];
    const bySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));

    let updated = 0;
    stocks = stocks.map((stock) => {
      const quote = bySymbol.get(stock.ticker);
      if (!quote) return stock;

      updated += 1;
      return {
        ...stock,
        price: Number.isFinite(quote.regularMarketPrice) ? quote.regularMarketPrice : stock.price,
        marketCap: Number.isFinite(quote.marketCap) ? quote.marketCap : stock.marketCap,
        avgVolume: Number.isFinite(quote.regularMarketVolume) ? quote.regularMarketVolume : stock.avgVolume,
        dataAsOf: quote.regularMarketTime
          ? new Date(quote.regularMarketTime * 1000).toISOString()
          : stock.dataAsOf,
      };
    });

    renderTable();
    renderDetails(stocks.find((stock) => stock.ticker === selectedTicker));
    updateStatus(`Live quotes synced: ${updated}/${stocks.length} symbols at ${new Date().toLocaleTimeString()}.`);
  } catch (error) {
    updateStatus(`Live quote sync failed (${error.message}). Retrying automatically.`);
  }
}

async function refreshAllData() {
  await loadStocksFromSec();
  updateStatus("Stocks loaded from SEC filings. Syncing live quotes...");
  await refreshLiveQuotes();
}

async function init() {
  updateStatus("Loading stocks...");
  try {
    await refreshAllData();
  } catch (error) {
    updateStatus(`Unable to load stocks from SEC filings: ${error.message}`);
  }

  window.setInterval(() => {
    refreshAllData().catch((error) => {
      updateStatus(`SEC filing refresh failed (${error.message}).`);
    });
  }, SEC_SCAN_REFRESH_MS);

  window.setInterval(() => {
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
