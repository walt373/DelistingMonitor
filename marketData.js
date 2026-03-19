(function (globalScope) {
  function readRawValue(value) {
    if (typeof value === "number") return value;
    if (value && typeof value.raw === "number") return value.raw;
    return Number.NaN;
  }

  function firstFinite(...values) {
    return values.find((value) => Number.isFinite(value)) ?? Number.NaN;
  }

  function parseLooseNumber(value) {
    if (typeof value === "number") return value;
    if (value && typeof value === "object") {
      return parseLooseNumber(value.raw ?? value.value ?? value.amount ?? value.display);
    }
    if (typeof value !== "string") return Number.NaN;

    const trimmed = value.trim();
    if (!trimmed || ["N/A", "NA", "--"].includes(trimmed.toUpperCase())) {
      return Number.NaN;
    }

    const normalized = trimmed.replace(/[$,%]/g, "").replace(/,/g, "");
    const match = normalized.match(/^(-?\d+(?:\.\d+)?)([KMBT])?$/i);
    if (!match) return Number.NaN;

    const numeric = Number(match[1]);
    if (!Number.isFinite(numeric)) return Number.NaN;

    const multipliers = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
    const suffix = match[2] ? match[2].toUpperCase() : null;
    return suffix ? numeric * multipliers[suffix] : numeric;
  }

  function computeOptionIvFromChain(chain) {
    const options = chain?.optionChain?.result?.[0]?.options?.[0];
    if (!options) return Number.NaN;

    const ivValues = [...(options.calls || []), ...(options.puts || [])]
      .map((contract) => readRawValue(contract.impliedVolatility))
      .filter((value) => Number.isFinite(value) && value > 0 && value < 10);

    if (!ivValues.length) return Number.NaN;
    const average = ivValues.reduce((sum, value) => sum + value, 0) / ivValues.length;
    return average * 100;
  }

  function parseNasdaqQuoteSummary(payload) {
    const data = payload?.data || {};
    const summaryData = data.summaryData || {};
    const keyStats = data.keyStats || {};
    const primaryData = data.primaryData || {};

    return {
      price: firstFinite(
        parseLooseNumber(primaryData.lastSalePrice),
        parseLooseNumber(summaryData.LastSalePrice),
        parseLooseNumber(summaryData.LastSale)
      ),
      marketCap: firstFinite(
        parseLooseNumber(summaryData.MarketCap),
        parseLooseNumber(keyStats.MarketCap),
        parseLooseNumber(summaryData.marketCap)
      ),
      avgVolume: firstFinite(
        parseLooseNumber(summaryData.AverageVolume),
        parseLooseNumber(keyStats.AverageVolume),
        parseLooseNumber(summaryData.ShareVolume),
        parseLooseNumber(primaryData.volume)
      ),
      dataAsOf:
        data.lastTradeTimestamp ||
        primaryData.lastTradeTimestamp ||
        primaryData.lastTradeDate ||
        null,
    };
  }

  const api = {
    computeOptionIvFromChain,
    firstFinite,
    parseLooseNumber,
    parseNasdaqQuoteSummary,
    readRawValue,
  };

  globalScope.MarketDataUtils = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
