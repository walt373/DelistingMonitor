const stocks = [
  {
    ticker: "ABCD",
    company: "Abacus Discovery Corp",
    price: 0.42,
    marketCap: 18400000,
    avgVolume: 1260000,
    shortBorrowCost: 88.5,
    optionIV: null,
    delistReason: "Minimum bid price non-compliance",
    expectedDelistingDate: "2026-04-03",
    expertMarketEligible: true,
    delistingChance: 82,
    secFilingUrl: "https://www.sec.gov/edgar/search/#/q=ABCD%2520delisting",
    notes: "Received Nasdaq deficiency notice and failed first reverse-split vote.",
  },
  {
    ticker: "QTRX",
    company: "Quatera Biopharma Inc",
    price: 0.71,
    marketCap: 29300000,
    avgVolume: 2540000,
    shortBorrowCost: 41.2,
    optionIV: 146,
    delistReason: "Shareholder equity requirement breach",
    expectedDelistingDate: "2026-03-28",
    expertMarketEligible: false,
    delistingChance: 64,
    secFilingUrl: "https://www.sec.gov/edgar/search/#/q=QTRX%2520listing%2520compliance",
    notes: "Exchange hearing pending; likely OTC transfer if extension denied.",
  },
  {
    ticker: "NRGL",
    company: "Nerogal Energy Systems",
    price: 1.18,
    marketCap: 51200000,
    avgVolume: 810000,
    shortBorrowCost: 22.1,
    optionIV: 93,
    delistReason: "Late SEC filing (10-K / 10-Q)",
    expectedDelistingDate: "2026-04-11",
    expertMarketEligible: true,
    delistingChance: 48,
    secFilingUrl: "https://www.sec.gov/edgar/search/#/q=NRGL%2520NT%252010-K",
    notes: "Auditor resignations increase risk despite active remediation plan.",
  },
  {
    ticker: "MTRN",
    company: "Metronexa Holdings",
    price: 0.29,
    marketCap: 12700000,
    avgVolume: 3930000,
    shortBorrowCost: 119.3,
    optionIV: 205,
    delistReason: "Bankruptcy / restructuring proceedings",
    expectedDelistingDate: "2026-03-22",
    expertMarketEligible: true,
    delistingChance: 91,
    secFilingUrl: "https://www.sec.gov/edgar/search/#/q=MTRN%2520chapter%252011",
    notes: "DIP financing in place but common equity cancellation risk is high.",
  },
  {
    ticker: "SVRA",
    company: "Silvera Retail Group",
    price: 0.95,
    marketCap: 68300000,
    avgVolume: 990000,
    shortBorrowCost: 17.6,
    optionIV: null,
    delistReason: "Corporate governance deficiency",
    expectedDelistingDate: "2026-04-15",
    expertMarketEligible: false,
    delistingChance: 35,
    secFilingUrl: "https://www.sec.gov/edgar/search/#/q=SVRA%2520governance%2520deficiency",
    notes: "Board composition fix proposed; timeline tight for compliance hearing.",
  },
];

const tableBody = document.querySelector("#stocksTable tbody");
const searchInput = document.getElementById("searchInput");
const reasonFilter = document.getElementById("reasonFilter");
const expertFilter = document.getElementById("expertFilter");
const chanceFilter = document.getElementById("chanceFilter");
const detailsContent = document.getElementById("detailsContent");
const headers = document.querySelectorAll("#stocksTable th");

let selectedTicker = null;
let sortKey = "delistingChance";
let sortDir = "desc";

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

function populateReasonOptions() {
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

    tr.innerHTML = `
      <td>${stock.ticker}</td>
      <td>${stock.company}</td>
      <td>${formatMoney(stock.price)}</td>
      <td>${formatCompactMoney(stock.marketCap)}</td>
      <td>${formatNumber(stock.avgVolume)}</td>
      <td>${stock.shortBorrowCost.toFixed(1)}%</td>
      <td>${stock.optionIV ? `${stock.optionIV}%` : "N/A"}</td>
      <td>${stock.delistReason}</td>
      <td>${stock.expectedDelistingDate}</td>
      <td>${stock.expertMarketEligible ? "Yes" : "No"}</td>
      <td><span class="pill ${risk.cls}">${risk.text}</span></td>
    `;

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
      <dt>Short Borrow Cost</dt><dd>${stock.shortBorrowCost.toFixed(1)}%</dd>
      <dt>Option IV</dt><dd>${stock.optionIV ? `${stock.optionIV}%` : "N/A"}</dd>
      <dt>Potential Expert Market</dt><dd>${stock.expertMarketEligible ? "Yes" : "No"}</dd>
      <dt>Notes</dt><dd>${stock.notes}</dd>
      <dt>SEC Filing</dt><dd><a href="${stock.secFilingUrl}" target="_blank" rel="noreferrer">Open SEC filing/search</a></dd>
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

populateReasonOptions();
applySortHeaderUI();
renderTable();
renderDetails(stocks[0]);
selectedTicker = stocks[0].ticker;
renderTable();
