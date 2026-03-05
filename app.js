const tableBody = document.querySelector("#stocksTable tbody");
const searchInput = document.getElementById("searchInput");
const reasonFilter = document.getElementById("reasonFilter");
const expertFilter = document.getElementById("expertFilter");
const chanceFilter = document.getElementById("chanceFilter");
const detailsContent = document.getElementById("detailsContent");
const headers = document.querySelectorAll("#stocksTable th");
const dataStatus = document.getElementById("dataStatus");

let stocks = [];
let selectedTicker = null;
let sortKey = "delistingChance";
let sortDir = "desc";

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
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1 ? 2 : 4,
  }).format(value);
}

function formatCompactMoney(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function riskLabel(chance) {
  if (chance >= 70) return { text: `${chance}% (High)`, cls: "high" };
  if (chance >= 40) return { text: `${chance}% (Medium)`, cls: "medium" };
  return { text: `${chance}% (Low)`, cls: "low" };
}

function calculateDelistingScore(signals, row) {
  let score = 8;
  const reasonParts = [];

  if (signals.bidBelowOneDollarDays >= 30) {
    score += 24;
    reasonParts.push("extended period under $1 bid requirement");
  }
  if (signals.bidBelowOneDollarDays >= 60) {
    score += 10;
    reasonParts.push("sub-$1 condition persisted >60 days");
  }
  if (signals.equityDeficiency) {
    score += 18;
    reasonParts.push("shareholder equity deficiency notice");
  }
  if (signals.lateFilingsCount > 0) {
    const lateFilingPoints = Math.min(18, signals.lateFilingsCount * 8);
    score += lateFilingPoints;
    reasonParts.push(`late SEC filings (${signals.lateFilingsCount})`);
  }
  if (signals.bankruptcyProceeding) {
    score += 30;
    reasonParts.push("bankruptcy/restructuring proceedings active");
  }
  if (signals.governanceDeficiency) {
    score += 12;
    reasonParts.push("corporate governance deficiency");
  }
  if (signals.reverseSplitPlanned) {
    score -= 7;
    reasonParts.push("reverse split plan may restore compliance");
  }
  if (row.shortBorrowCost >= 80) {
    score += 8;
    reasonParts.push("very high borrow cost indicates stress");
  }
  if (row.price < 0.5) {
    score += 8;
    reasonParts.push("deeply sub-$1 trading level");
  }

  const delistingChance = Math.max(5, Math.min(97, Math.round(score)));

  return {
    delistingChance,
    rationale: reasonParts.length ? reasonParts : ["baseline listing risk profile"],
  };
}

function deriveDelistReason(signals) {
  if (signals.bankruptcyProceeding) return "Bankruptcy / restructuring proceedings";
  if (signals.equityDeficiency) return "Shareholder equity requirement breach";
  if (signals.lateFilingsCount > 0) return "Late SEC filing (10-K / 10-Q)";
  if (signals.governanceDeficiency) return "Corporate governance deficiency";
  if (signals.bidBelowOneDollarDays >= 30) return "Minimum bid price non-compliance";
  return "At-risk listing compliance profile";
}

function deriveExpectedDelistingDate(signals) {
  const dates = [signals.hearingDate, signals.complianceDeadline].filter(Boolean).map((d) => new Date(d));
  if (!dates.length) {
    const defaultDate = new Date();
    defaultDate.setDate(defaultDate.getDate() + 30);
    return defaultDate.toISOString().slice(0, 10);
  }
  return new Date(Math.min(...dates.map((d) => d.getTime()))).toISOString().slice(0, 10);
}

function enrichStocks(rawStocks) {
  return rawStocks.map((row) => {
    const scored = calculateDelistingScore(row.signals, row);
    return {
      ...row,
      delistingChance: scored.delistingChance,
      delistReason: deriveDelistReason(row.signals),
      expectedDelistingDate: deriveExpectedDelistingDate(row.signals),
      scoreRationale: scored.rationale,
    };
  });
}

function populateReasonOptions() {
  reasonFilter.innerHTML = '<option value="all">All reasons</option>';
  const reasons = [...new Set(stocks.map((stock) => stock.delistReason))].sort();
  reasons.forEach((reason) => {
    const option = document.createElement("option");
    option.value = reason;
    option.textContent = reason;
    reasonFilter.appendChild(option);
  });
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
    appendCell(tr, `${stock.shortBorrowCost.toFixed(1)}%`);
    appendCell(tr, stock.optionIV ? `${stock.optionIV}%` : "N/A");
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
  const risk = riskLabel(stock.delistingChance);
  detailsContent.textContent = "";

  const dl = document.createElement("dl");
  const appendDetail = (label, valueNodeOrText) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    if (valueNodeOrText instanceof Node) {
      dd.appendChild(valueNodeOrText);
    } else {
      dd.textContent = valueNodeOrText;
    }
    dl.append(dt, dd);
  };

  appendDetail("Ticker", stock.ticker);
  appendDetail("Company", stock.company);
  appendDetail("Delist Reason", stock.delistReason);
  appendDetail("Expected Delisting Date", stock.expectedDelistingDate);

  const riskPill = document.createElement("span");
  riskPill.className = `pill ${risk.cls}`;
  riskPill.textContent = risk.text;
  appendDetail("Estimated Delisting Chance", riskPill);

  appendDetail("Price", formatMoney(stock.price));
  appendDetail("Market Cap", formatCompactMoney(stock.marketCap));
  appendDetail("Average Volume", formatNumber(stock.avgVolume));
  appendDetail("Short Borrow Cost", `${stock.shortBorrowCost.toFixed(1)}%`);
  appendDetail("Option IV", stock.optionIV ? `${stock.optionIV}%` : "N/A");
  appendDetail("Potential Expert Market", stock.expertMarketEligible ? "Yes" : "No");
  appendDetail("Data As Of", stock.dataAsOf);

  const rationaleList = document.createElement("ul");
  rationaleList.className = "rationale-list";
  stock.scoreRationale.forEach((reason) => {
    const item = document.createElement("li");
    item.textContent = reason;
    rationaleList.appendChild(item);
  });
  appendDetail("Scoring rationale", rationaleList);

  appendDetail("Notes", stock.notes);

  const filingLink = document.createElement("a");
  filingLink.textContent = "Open SEC filing/search";
  filingLink.target = "_blank";
  filingLink.rel = "noreferrer";
  if (isSafeExternalUrl(stock.secFilingUrl)) {
    filingLink.href = stock.secFilingUrl;
  } else {
    filingLink.removeAttribute("href");
    filingLink.setAttribute("aria-disabled", "true");
  }
  appendDetail("SEC Filing", filingLink);

  detailsContent.appendChild(dl);
}

function applySortHeaderUI() {
  headers.forEach((header) => {
    header.classList.remove("sort-asc", "sort-desc");
    if (header.dataset.key === sortKey) {
      header.classList.add(sortDir === "asc" ? "sort-asc" : "sort-desc");
    }
  });
}

async function loadData() {
  dataStatus.textContent = "Loading dataset…";
  const response = await fetch("data/stocks.json");
  if (!response.ok) {
    throw new Error(`Dataset request failed (${response.status})`);
  }

  const payload = await response.json();
  stocks = enrichStocks(payload.stocks);
  stocks.sort((a, b) => b.delistingChance - a.delistingChance);
  dataStatus.textContent = `Dataset as of ${payload.generatedAt}. ${payload.sourceSummary}`;
}

function bindEvents() {
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
}

async function init() {
  bindEvents();
  applySortHeaderUI();

  try {
    await loadData();
    populateReasonOptions();
    selectedTicker = stocks[0]?.ticker || null;
    renderTable();
    if (stocks[0]) {
      renderDetails(stocks[0]);
    }
  } catch (error) {
    dataStatus.textContent = `Failed to load data: ${error.message}`;
    tableBody.innerHTML = '<tr><td colspan="11">Could not load dataset.</td></tr>';
  }
}

init();
