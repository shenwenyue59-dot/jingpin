const fs = require("fs");
const http = require("http");
const path = require("path");

const OUT = path.join(__dirname, "..", "data", "brand-radar-data.json");
const CDP = "http://127.0.0.1:9222";

const windows = [
  { key: "base", label: "2024-08-14~2025-08-13", start: "20240814", end: "20250813" },
  { key: "current", label: "2025-08-14~2026-08-13", start: "20250814", end: "20260813" }
];

const categories = [
  { id: "115", name: "美妆", level: 0 },
  { id: "1000005791", name: "婴童洗护", level: 2 }
];

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => resolve(JSON.parse(body)));
    }).on("error", reject);
  });
}

async function openCdp() {
  const tabs = await getJson(`${CDP}/json`);
  const tab = tabs.find((item) => item.type === "page" && item.url.includes("dy.feigua.cn")) || tabs.find((item) => item.type === "page");
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

function ymdToDate(ymd) {
  return new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
}

function dateToYmd(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(ymd, days) {
  const date = ymdToDate(ymd);
  date.setDate(date.getDate() + days);
  return dateToYmd(date);
}

function splitRange(start, end) {
  const segments = [];
  let cursor = start;
  while (cursor <= end) {
    const segmentEnd = addDays(cursor, 179);
    const to = segmentEnd > end ? end : segmentEnd;
    segments.push({ start: cursor, end: to, key: `${cursor}_${to}` });
    cursor = addDays(to, 1);
  }
  return segments;
}

function parseSalesRange(text) {
  const raw = String(text || "").trim();
  if (!raw || raw === "-") return { low: 0, high: 0, value: 0, raw };
  const convert = (part) => {
    const value = Number(String(part).replace(/[^\d.]/g, ""));
    if (!Number.isFinite(value)) return 0;
    if (String(part).includes("亿")) return value * 100000000;
    if (String(part).includes("w") || String(part).includes("万")) return value * 10000;
    return value;
  };
  if (raw.includes("+")) {
    const low = convert(raw);
    return { low, high: null, value: low, raw };
  }
  if (raw.includes("-")) {
    const [a, b] = raw.split("-");
    const low = convert(a);
    const high = convert(b);
    return { low, high, value: (low + high) / 2, raw };
  }
  const value = convert(raw);
  return { low: value, high: value, value, raw };
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

async function customRankList(cdp) {
  const result = await pageFetch(cdp, `/api/v3/customrank/list?rankType=4&_=${Date.now()}`, { credentials: "include" });
  if (!result.json?.Data) throw new Error(`customrank/list failed: ${JSON.stringify(result).slice(0, 500)}`);
  return result.json.Data;
}

async function ensureCustomRank(cdp, segment) {
  const name = `CodexRadar_${segment.key}`;
  let list = await customRankList(cdp);
  let existing = list.find((item) => item.CustomName === name);
  if (existing) return existing.AutoId;
  const payload = { CustomName: name, RankType: 4, FromDateCode: segment.start, ToDateCode: segment.end };
  const add = await pageFetch(cdp, `/api/v3/customrank/add?_=${Date.now()}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (add.json?.Code !== 200) throw new Error(`customrank/add failed for ${name}: ${JSON.stringify(add.json)}`);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    list = await customRankList(cdp);
    existing = list.find((item) => item.CustomName === name);
    if (existing && existing.State === 2) return existing.AutoId;
    if (existing) return existing.AutoId;
  }
  throw new Error(`custom rank not found after create: ${name}`);
}

async function fetchRankPage(cdp, customId, category, pageIndex) {
  const qs = new URLSearchParams({
    sort: "0",
    brandMapType: "0",
    customId: String(customId),
    dyCateId: String(category.id),
    cateLevel: String(category.level),
    pageIndex: String(pageIndex),
    pageSize: "100",
    pageType: "1",
    _: String(Date.now())
  });
  const result = await pageFetch(cdp, `/api/v3/brandrank/brandRankMain?${qs}`, { credentials: "include" });
  if (result.json?.Code && result.json.Code !== 200) throw new Error(`brandRankMain failed: ${JSON.stringify(result.json)}`);
  return result.json?.Data || {};
}

async function fetchSegmentCategory(cdp, customId, segment, windowKey, category) {
  const rows = [];
  for (let page = 1; page <= 5; page += 1) {
    const data = await fetchRankPage(cdp, customId, category, page);
    const list = data.List || [];
    if (!list.length) break;
    for (const item of list) {
      const brand = item.BaseBrandDto || {};
      const parsed = parseSalesRange(item.TotalSales);
      rows.push({
        source: "feigua-brand-rank",
        window: windowKey,
        segment: segment.key,
        fromDateCode: segment.start,
        toDateCode: segment.end,
        category: category.name,
        categoryId: category.id,
        brandId: String(brand.BrandId || item.UniqueId || ""),
        name: brand.BrandName || "",
        logo: brand.BrandLogo || "",
        mainCate: brand.BrandMainCate || "",
        rank: Number(item.RankNum || 0),
        totalSalesText: item.TotalSales || "",
        salesValue: parsed.value,
        salesLow: parsed.low,
        salesHigh: parsed.high,
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

function compute(raw) {
  const byBrand = new Map();
  for (const point of raw.points) {
    const key = `${point.categoryId}:${point.brandId}`;
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
      month: point.segment,
      rank: point.rank,
      gmv: point.salesValue,
      gmvText: point.totalSalesText,
      fromDateCode: point.fromDateCode,
      toDateCode: point.toDateCode,
      window: point.window,
      liveSalesText: point.liveSalesText,
      awemeSalesText: point.awemeSalesText
    });
  }
  const brands = [...byBrand.values()].map((brand) => {
    const baseRows = brand.monthly.filter((row) => row.window === "base");
    const currentRows = brand.monthly.filter((row) => row.window === "current");
    const baseTotal = baseRows.reduce((sum, row) => sum + row.gmv, 0);
    const currentTotal = currentRows.reduce((sum, row) => sum + row.gmv, 0);
    const growthAbs = currentTotal - baseTotal;
    const growthRate = baseTotal > 0 ? growthAbs / baseTotal : null;
    const avg = (rows) => rows.length ? rows.reduce((sum, row) => sum + row.rank, 0) / rows.length : null;
    const baseAvgRank = avg(baseRows);
    const currentAvgRank = avg(currentRows);
    return {
      ...brand,
      baseLabel: raw.basis.baseLabel,
      currentLabel: raw.basis.currentLabel,
      baseTotal,
      currentTotal,
      baseAnnualized: baseTotal,
      currentAnnualized: currentTotal,
      growthAbs,
      growthRate,
      baseAvgRank,
      currentAvgRank,
      rankLift: baseAvgRank && currentAvgRank ? baseAvgRank - currentAvgRank : null,
      baseMonths: baseRows.length,
      currentMonths: currentRows.length,
      basePeriodMonths: raw.segments.filter((s) => s.window === "base").length,
      currentPeriodMonths: raw.segments.filter((s) => s.window === "current").length,
      observedMonths: brand.monthly.length,
      expectedMonths: raw.segments.length,
      coverageRate: raw.segments.length ? brand.monthly.length / raw.segments.length : 0,
      maxGmv: Math.max(...brand.monthly.map((row) => row.gmv), 0),
      minGmv: Math.min(...brand.monthly.map((row) => row.gmv).filter(Boolean), 0)
    };
  });
  return {
    ...raw,
    brands,
    growthBrands: brands.filter((b) => b.baseTotal > 0 && b.currentTotal > 0 && b.growthAbs > 0)
      .sort((a, b) => (b.growthAbs + (b.growthRate || 0) * 1000000) - (a.growthAbs + (a.growthRate || 0) * 1000000)),
    blackHorseBrands: brands.filter((b) => b.baseTotal > 0 && b.currentTotal > 0 && (b.growthRate || 0) > 0.5)
      .sort((a, b) => (b.growthRate || 0) - (a.growthRate || 0))
  };
}

async function main() {
  const cdp = await openCdp();
  try {
    const segments = [];
    for (const win of windows) {
      for (const segment of splitRange(win.start, win.end)) {
        segments.push({ ...segment, window: win.key, windowLabel: win.label });
      }
    }
    const points = [];
    for (const segment of segments) {
      const customId = await ensureCustomRank(cdp, segment);
      segment.customId = customId;
      for (const category of categories) {
        const rows = await fetchSegmentCategory(cdp, customId, segment, segment.window, category);
        points.push(...rows);
        console.log(`${segment.key} ${category.name}: ${rows.length}`);
      }
    }
    const raw = {
      generatedAt: new Date().toISOString(),
      source: "feigua-brand-rank-custom",
      basis: {
        label: "飞瓜品牌销售榜自定义榜单分段汇总",
        baseLabel: windows[0].label,
        currentLabel: windows[1].label,
        note: "通过飞瓜实数 /api/v3/customrank/add 按180天内分段创建自定义榜单，再用 /api/v3/brandrank/brandRankMain 分页拉取。销售额按页面返回的实数文本解析，原始文本保留在详情中。"
      },
      period: { start: "2024-08-14", end: "2026-08-13" },
      categories,
      segments,
      months: segments.map((item) => item.key),
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
