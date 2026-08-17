const fs = require("fs");
const http = require("http");
const path = require("path");

const OUT = path.join(__dirname, "..", "data", "brand-radar-data.json");
const CDP = "http://127.0.0.1:9222";

const categories = [
  { id: "115", name: "美妆", level: 0 },
  { id: "1000005791", name: "婴童洗护", level: 2 }
];

const period = {
  start: "2024-08",
  split: "2025-08",
  end: "2026-08",
  baseLabel: "2024.08-2025.08",
  currentLabel: "2025.08-2026.08"
};

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => {
        const json = JSON.parse(body);
        resolve(json.value || json);
      });
    }).on("error", reject);
  });
}

async function openCdp() {
  const tabs = await getJson(`${CDP}/json`);
  const tab = tabs.find((item) => item.type === "page" && item.url.includes("bigdatavoice.com"))
    || tabs.find((item) => item.type === "page" && item.url.includes("feigua.cn"))
    || tabs.find((item) => item.type === "page");
  if (!tab) throw new Error("No controllable browser tab found on port 9222");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  await new Promise((resolve) => ws.onopen = resolve);
  return {
    async eval(expression) {
      const message = { id: ++id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } };
      return new Promise((resolve) => {
        pending.set(message.id, resolve);
        ws.send(JSON.stringify(message));
      });
    },
    close() {
      ws.close();
    }
  };
}

async function pageFetch(cdp, url, options = {}) {
  const expression = `(async()=> {
    const response = await fetch(${JSON.stringify(url)}, ${JSON.stringify(options)});
    const text = await response.text();
    try { return JSON.stringify({ status: response.status, json: JSON.parse(text) }); }
    catch (error) { return JSON.stringify({ status: response.status, text }); }
  })()`;
  const result = await cdp.eval(expression);
  if (result.result.exceptionDetails) throw new Error(result.result.exceptionDetails.text);
  return JSON.parse(result.result.result.value);
}

function parseSales(text) {
  const raw = String(text || "").trim();
  if (!raw || raw === "-") return 0;
  const value = Number(raw.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(value)) return 0;
  if (raw.includes("亿")) return value * 100000000;
  if (raw.includes("w") || raw.includes("万")) return value * 10000;
  return value;
}

function monthKey(datecode) {
  return `${datecode.slice(0, 4)}-${datecode.slice(4, 6)}`;
}

function inRange(month, start, end) {
  return month >= start && month <= end;
}

async function getMonthList(cdp) {
  const result = await pageFetch(cdp, `/api/v3/brandrank/brandRankSearchItem?_=${Date.now()}`, { credentials: "include" });
  if (result.json?.Code !== 200) throw new Error(`brandRankSearchItem failed: ${JSON.stringify(result.json)}`);
  return (result.json.Data.MonthList || [])
    .map((item) => ({ text: item.Text, value: item.Value, month: monthKey(item.Value.split("-")[0]) }))
    .filter((item) => inRange(item.month, period.start, period.end))
    .sort((a, b) => a.month.localeCompare(b.month));
}

async function fetchRankPage(cdp, month, category, pageIndex) {
  const qs = new URLSearchParams({
    period: "month",
    brandMapType: "0",
    sort: "0",
    dyCateId: String(category.id),
    cateLevel: String(category.level),
    datecode: month.value,
    pageIndex: String(pageIndex),
    pageSize: "100",
    pageType: "1",
    _: String(Date.now())
  });
  const result = await pageFetch(cdp, `/api/v3/brandrank/brandRankMain?${qs}`, { credentials: "include" });
  if (result.json?.Code !== 200) throw new Error(`brandRankMain failed: ${category.name} ${month.month} ${JSON.stringify(result.json)}`);
  return result.json.Data || {};
}

async function fetchMonthCategory(cdp, month, category) {
  const rows = [];
  for (let page = 1; page <= 10; page += 1) {
    const data = await fetchRankPage(cdp, month, category, page);
    const list = data.List || [];
    if (!list.length) break;
    for (const item of list) {
      const brand = item.BaseBrandDto || {};
      rows.push({
        source: "feigua-brand-rank-monthly",
        month: month.month,
        monthText: month.text,
        datecode: month.value,
        category: category.name,
        categoryId: category.id,
        brandId: String(brand.BrandId || item.UniqueId || ""),
        name: String(brand.BrandName || "").trim(),
        logo: brand.BrandLogo || "",
        mainCate: brand.BrandMainCate || "",
        rank: Number(item.RankNum || 0),
        totalSalesText: item.TotalSales || "",
        salesValue: parseSales(item.TotalSales),
        saleCount: item.SaleCount || "",
        avgPrice: item.AvgPrice || "",
        promotionCount: item.PromotionCount || "",
        liveCount: item.LiveCount || "",
        awemeCount: item.AwemeCount || "",
        shopCount: item.ShopCount || "",
        bloggerCount: item.BloggerCount || "",
        liveSalesText: item.LiveSalesGmv || "",
        awemeSalesText: item.AwemeSalesGmv || "",
        brandSalesText: item.BrandSalesGmv || "",
        noneBrandSalesText: item.NoneBrandSalesGmv || ""
      });
    }
    if (list.length < 100) break;
  }
  return rows;
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value) && value > 0);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function sum(rows) {
  return rows.reduce((total, row) => total + Number(row.gmv || 0), 0);
}

function scoreBrand(brand, medianBase) {
  const growthPart = Math.min(45, Math.max(0, (brand.growthRate || 0) * 25));
  const rankPart = Math.min(25, Math.max(0, (brand.rankLift || 0) * 2.5));
  const basePart = brand.baseTotal > 0 && brand.baseTotal <= medianBase ? 20 : 0;
  const coveragePart = Math.min(10, (brand.coverageRate || 0) * 10);
  return growthPart + rankPart + basePart + coveragePart;
}

function compute(raw) {
  const byBrand = new Map();
  for (const point of raw.points) {
    const key = `${point.categoryId}:${point.brandId || point.name}`;
    if (!byBrand.has(key)) {
      byBrand.set(key, {
        id: key,
        brandId: point.brandId,
        name: point.name,
        logo: point.logo ? point.logo.replace(/^http:\/\//, "https://") : "",
        category: point.category,
        categoryId: point.categoryId,
        monthly: []
      });
    }
    byBrand.get(key).monthly.push({
      month: point.month,
      rank: point.rank,
      gmv: point.salesValue,
      gmvText: point.totalSalesText,
      datecode: point.datecode,
      liveSalesText: point.liveSalesText,
      awemeSalesText: point.awemeSalesText,
      mainCate: point.mainCate
    });
  }

  const baseMonths = raw.months.filter((month) => inRange(month, raw.period.start, raw.period.split));
  const currentMonths = raw.months.filter((month) => inRange(month, raw.period.split, raw.period.end));
  const baseSet = new Set(baseMonths);
  const currentSet = new Set(currentMonths);

  const brands = [...byBrand.values()].map((brand) => {
    brand.monthly.sort((a, b) => a.month.localeCompare(b.month));
    const baseRows = brand.monthly.filter((row) => baseSet.has(row.month));
    const currentRows = brand.monthly.filter((row) => currentSet.has(row.month));
    const firstThree = brand.monthly.slice(0, 3);
    const lastThree = brand.monthly.slice(-3);
    const baseTotal = sum(baseRows);
    const currentTotal = sum(currentRows);
    const growthAbs = currentTotal - baseTotal;
    const growthRate = baseTotal > 0 ? growthAbs / baseTotal : null;
    const baseAvgRank = average(baseRows.map((row) => row.rank));
    const currentAvgRank = average(currentRows.map((row) => row.rank));
    const rankLift = baseAvgRank && currentAvgRank ? baseAvgRank - currentAvgRank : null;
    const values = brand.monthly.map((row) => row.gmv).filter(Boolean);
    const earlyAvg = average(firstThree.map((row) => row.gmv)) || 0;
    const lateAvg = average(lastThree.map((row) => row.gmv)) || 0;
    return {
      ...brand,
      baseLabel: raw.period.baseLabel,
      currentLabel: raw.period.currentLabel,
      baseStart: raw.period.start,
      splitMonth: raw.period.split,
      currentEnd: raw.period.end,
      baseMonths: baseRows.length,
      currentMonths: currentRows.length,
      basePeriodMonths: baseMonths.length,
      currentPeriodMonths: currentMonths.length,
      observedMonths: brand.monthly.length,
      expectedMonths: raw.months.length,
      coverageRate: raw.months.length ? brand.monthly.length / raw.months.length : 0,
      baseTotal,
      currentTotal,
      baseAnnualized: baseMonths.length ? (baseTotal / baseMonths.length) * 12 : 0,
      currentAnnualized: currentMonths.length ? (currentTotal / currentMonths.length) * 12 : 0,
      growthAbs,
      growthRate,
      baseAvgRank,
      currentAvgRank,
      rankLift,
      maxGmv: values.length ? Math.max(...values) : 0,
      minGmv: values.length ? Math.min(...values) : 0,
      lateVsEarly: earlyAvg > 0 ? lateAvg / earlyAvg - 1 : 0
    };
  });

  const medians = new Map();
  for (const category of raw.categories) {
    const values = brands
      .filter((brand) => brand.categoryId === category.id && brand.baseTotal > 0)
      .map((brand) => brand.baseTotal)
      .sort((a, b) => a - b);
    medians.set(category.id, values.length ? values[Math.floor(values.length / 2)] : 0);
  }
  for (const brand of brands) {
    brand.categoryMedianBase = medians.get(brand.categoryId) || 0;
    brand.blackHorseScore = scoreBrand(brand, brand.categoryMedianBase);
  }

  const growthBrands = brands
    .filter((brand) => brand.baseTotal > 0 && brand.currentTotal > 0 && brand.growthAbs > 0)
    .sort((a, b) => {
      const scoreA = a.growthAbs + (a.growthRate || 0) * 80000000 + (a.rankLift || 0) * 2000000;
      const scoreB = b.growthAbs + (b.growthRate || 0) * 80000000 + (b.rankLift || 0) * 2000000;
      return scoreB - scoreA;
    });
  const blackHorseBrands = brands
    .filter((brand) => brand.baseTotal > 0 && brand.currentTotal > 0 && (brand.growthRate || 0) > 0.3 && brand.baseTotal <= Math.max(brand.categoryMedianBase, 80000000))
    .sort((a, b) => b.blackHorseScore - a.blackHorseScore);

  return {
    ...raw,
    brands,
    growthBrands,
    blackHorseBrands
  };
}

async function main() {
  const cdp = await openCdp();
  try {
    const months = await getMonthList(cdp);
    const points = [];
    for (const month of months) {
      for (const category of categories) {
        const rows = await fetchMonthCategory(cdp, month, category);
        points.push(...rows);
        console.log(`${month.month} ${category.name}: ${rows.length}`);
      }
    }
    const raw = {
      generatedAt: new Date().toISOString(),
      source: "feigua-brand-rank-monthly",
      basis: {
        label: "飞瓜品牌销售榜月榜逐月汇总",
        source: "飞瓜实数 /api/v3/brandrank/brandRankMain",
        baseLabel: period.baseLabel,
        currentLabel: period.currentLabel,
        note: "通过飞瓜实数品牌销售榜月榜逐月拉取。上一年度为2024.08-2025.08，本年度为2025.08-2026.08；2025.08按需求同时计入两个窗口，2026.08为当月截至后台更新日的非完整月。"
      },
      period,
      categories,
      months: months.map((item) => item.month),
      monthRanges: months,
      points
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(compute(raw), null, 2), "utf8");
    console.log(`Wrote ${OUT}`);
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
