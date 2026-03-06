const DATA_URL = "data/stocks.json";
const LIVE_QUOTE_REFRESH_MS = 60_000;
const DATA_REFRESH_MS = 180_000;

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
  if (signals.lateFilingsCount > 0) return "Late SEC filing (10-K / 10-Q)";
  if (signals.equityDeficiency) return "Shareholder equity requirement breach";
  if (signals.governanceDeficiency) return "Corporate governance deficiency";
  if (signals.bidBelowOneDollarDays > 30) return "Minimum bid price non-compliance";
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

async function init() {
  try {
    await loadDataset();
    updateStatus("Dataset loaded. Waiting for live quote sync...");
    await refreshLiveQuotes();
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
