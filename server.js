const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "brand-radar-data.json");
const CORRECT_SYNC_SCRIPT = path.join(ROOT, "work", "fetch-feigua-brand-rank.js");
const WEBBRIDGE = "http://127.0.0.1:10086/command";
const SESSION = "brand-radar-scout";

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function webbridge(action, args) {
  const response = await fetch(WEBBRIDGE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, args, session: SESSION })
  });
  const json = await response.json();
  if (!json.ok) throw new Error(json.error?.message || "WebBridge request failed");
  return json.data;
}

function monthRange(start, end, alignedDay = null) {
  const out = [];
  let [year, month] = start.split("-").map(Number);
  const [endYear, endMonth] = end.split("-").map(Number);
  while (year < endYear || (year === endYear && month <= endMonth)) {
    const lastDay = new Date(year, month, 0).getDate();
    const isCappedEndMonth = alignedDay && year === endYear && month === endMonth;
    const toDay = isCappedEndMonth ? Math.min(lastDay, alignedDay) : lastDay;
    out.push({
      key: `${year}-${String(month).padStart(2, "0")}`,
      from: `${year}${String(month).padStart(2, "0")}01`,
      to: `${year}${String(month).padStart(2, "0")}${String(toDay).padStart(2, "0")}`
    });
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

function normalizeUrl(url) {
  return url ? url.replace(/^http:\/\//, "https://") : "";
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value) && value > 0);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function sumGmv(months) {
  return months.reduce((sum, item) => sum + Number(item.gmv || 0), 0);
}

function normalizeFeiguaMoney(value) {
  const number = Number(value || 0);
  return number / 100;
}

function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function parseMonth(month) {
  const [year, value] = month.split("-").map(Number);
  return { year, month: value };
}

function shiftMonth(month, delta) {
  const parsed = parseMonth(month);
  const date = new Date(parsed.year, parsed.month - 1 + delta, 1);
  return monthKey(date.getFullYear(), date.getMonth() + 1);
}

function monthsBetween(start, end) {
  return monthRange(start, end).map((item) => item.key);
}

function scoreBrand(brand) {
  const growthPart = Math.min(42, Math.max(0, (brand.growthRate || 0) * 28));
  const rankPart = Math.min(22, Math.max(0, (brand.rankLift || 0) * 3));
  const burstPart = Math.min(18, Math.max(0, (brand.lateVsEarly || 0) * 9));
  const basePart = brand.baseAnnualized > 0 && brand.baseAnnualized < brand.categoryMedianBase ? 18 : 0;
  const coveragePenalty = brand.coverageRate < 0.55 ? -12 : 0;
  return Math.max(0, growthPart + rankPart + burstPart + basePart + coveragePenalty);
}

function categoryName(raw, categoryId, fallback) {
  return raw.categories?.find((c) => c.id === categoryId)?.name || fallback || categoryId;
}

function computeRadar(raw) {
  const byBrand = new Map();
  for (const point of raw.points || []) {
    const key = `${point.categoryId}:${point.brandId}`;
    if (!byBrand.has(key)) {
      byBrand.set(key, {
        id: key,
        brandId: point.brandId,
        name: point.name,
        logo: normalizeUrl(point.logo),
        category: categoryName(raw, point.categoryId, point.category),
        categoryId: point.categoryId,
        monthly: []
      });
    }
    byBrand.get(key).monthly.push({
      ...point,
      category: categoryName(raw, point.categoryId, point.category),
      gmv: normalizeFeiguaMoney(point.gmv),
      lastGmv: normalizeFeiguaMoney(point.lastGmv)
    });
  }

  const allMonths = raw.months || [];
  const currentEnd = raw.period.end;
  const splitMonth = shiftMonth(currentEnd, -12);
  const baseStart = shiftMonth(currentEnd, -24);
  const baseWindow = monthsBetween(baseStart, splitMonth).filter((month) => allMonths.includes(month));
  const currentWindow = monthsBetween(splitMonth, currentEnd).filter((month) => allMonths.includes(month));
  const baseWindowSet = new Set(baseWindow);
  const currentWindowSet = new Set(currentWindow);
  const basePeriodMonths = baseWindow.length;
  const currentPeriodMonths = currentWindow.length;
  const baseLabel = `${baseStart}-${splitMonth}`;
  const currentLabel = `${splitMonth}-${currentEnd}`;

  const brands = [...byBrand.values()].map((brand) => {
    brand.monthly.sort((a, b) => a.month.localeCompare(b.month));
    const baseMonths = brand.monthly.filter((m) => baseWindowSet.has(m.month));
    const currentMonths = brand.monthly.filter((m) => currentWindowSet.has(m.month));
    const first = brand.monthly[0];
    const last = brand.monthly.at(-1);
    const earlyAvg = average(brand.monthly.slice(0, 3).map((m) => m.gmv)) || 0;
    const lateAvg = average(brand.monthly.slice(-3).map((m) => m.gmv)) || 0;
    const baseTotal = sumGmv(baseMonths);
    const currentTotal = sumGmv(currentMonths);
    const baseAnnualized = basePeriodMonths ? (baseTotal / basePeriodMonths) * 12 : 0;
    const currentAnnualized = currentPeriodMonths ? (currentTotal / currentPeriodMonths) * 12 : 0;
    const growthAbs = currentAnnualized - baseAnnualized;
    const growthRate = baseAnnualized > 0 ? growthAbs / baseAnnualized : null;
    const baseAvgRank = average(baseMonths.map((m) => m.rank));
    const currentAvgRank = average(currentMonths.map((m) => m.rank));
    const rankLift = baseAvgRank && currentAvgRank ? baseAvgRank - currentAvgRank : null;
    const maxGmv = Math.max(...brand.monthly.map((m) => m.gmv || 0), 0);
    const positiveGmv = brand.monthly.map((m) => m.gmv || 0).filter(Boolean);
    const observedMonths = brand.monthly.length;
    const coverageRate = allMonths.length ? observedMonths / allMonths.length : 0;
    return {
      ...brand,
      baseYear: baseStart.slice(0, 4),
      currentYear: currentEnd.slice(0, 4),
      baseLabel,
      currentLabel,
      baseStart,
      splitMonth,
      currentEnd,
      baseMonths: baseMonths.length,
      currentMonths: currentMonths.length,
      basePeriodMonths,
      currentPeriodMonths,
      observedMonths,
      expectedMonths: allMonths.length,
      coverageRate,
      baseTotal,
      currentTotal,
      baseAnnualized,
      currentAnnualized,
      growthAbs,
      growthRate,
      baseAvgRank,
      currentAvgRank,
      rankLift,
      startMonthGmv: first?.gmv || 0,
      endMonthGmv: last?.gmv || 0,
      startRank: first?.rank || null,
      endRank: last?.rank || null,
      maxGmv,
      minGmv: positiveGmv.length ? Math.min(...positiveGmv) : 0,
      lateVsEarly: earlyAvg > 0 ? lateAvg / earlyAvg - 1 : 0
    };
  });

  const medians = new Map();
  for (const category of raw.categories || []) {
    const values = brands
      .filter((b) => b.categoryId === category.id && b.baseAnnualized > 0)
      .map((b) => b.baseAnnualized)
      .sort((a, b) => a - b);
    medians.set(category.id, values.length ? values[Math.floor(values.length / 2)] : 0);
  }

  for (const brand of brands) {
    brand.categoryMedianBase = medians.get(brand.categoryId) || 0;
    brand.blackHorseScore = scoreBrand(brand);
  }

  const growthBrands = brands
    .filter((b) => b.baseAnnualized > 0 && b.currentAnnualized > 0 && b.growthAbs > 0)
    .sort((a, b) => {
      const scoreA = a.growthAbs + (a.growthRate || 0) * 80_000_000 + (a.rankLift || 0) * 2_000_000;
      const scoreB = b.growthAbs + (b.growthRate || 0) * 80_000_000 + (b.rankLift || 0) * 2_000_000;
      return scoreB - scoreA;
    });

  const blackHorseBrands = brands
    .filter((b) => {
      const smallBase = b.baseAnnualized > 0 && b.baseAnnualized <= Math.max(b.categoryMedianBase, 120_000_000);
      return smallBase && b.currentAnnualized > 0 && (b.growthRate || 0) > 0.15;
    })
    .sort((a, b) => b.blackHorseScore - a.blackHorseScore);

  return {
    ...raw,
    basis: {
      label: "按榜内年度累计折算年化对比",
      baseLabel,
      currentLabel,
      splitMonth,
      note: `上一年度窗口为${baseLabel}，本年度窗口为${currentLabel}。两个窗口各按榜内累计销售额折算年化，缺失月份不再按有数据月份放大。`
    },
    brands,
    growthBrands,
    blackHorseBrands
  };
}

async function syncFeigua(options) {
  await webbridge("find_tab", { url: "dy.feigua.cn", active: true }).catch(async () => {
    await webbridge("navigate", {
      url: "https://dy.feigua.cn/app/#/data-overview/index?tab=brand",
      newTab: true,
      group_title: "Brand Radar Scout"
    });
  });

  const start = options.start || "2024-08";
  const end = options.end || "2026-08";
  const size = Number(options.size || 140);
  const categories = [
    { id: "115", name: "美妆", level: 0 },
    { id: "1000005791", name: "婴童洗护", level: 2 }
  ];
  const now = new Date();
  const endParts = end.split("-").map(Number);
  const isCurrentMonth = now.getFullYear() === endParts[0] && now.getMonth() + 1 === endParts[1];
  const alignedDay = isCurrentMonth ? Math.max(1, now.getDate() - 1) : null;
  const months = monthRange(start, end, alignedDay);
  const script = `
    (async () => {
      const categories = ${JSON.stringify(categories)};
      const months = ${JSON.stringify(months)};
      const size = ${JSON.stringify(size)};
      const points = [];
      for (const category of categories) {
        for (const month of months) {
          const url = "/api/v3/brand/industryrank/getBrandIndustryRankTopBrands"
            + "?fromDateCode=" + month.from
            + "&toDateCode=" + month.to
            + "&periodType=0"
            + "&dyCateId=" + encodeURIComponent(category.id)
            + "&cateLevel=" + category.level
            + "&promotionType=0"
            + "&size=" + size
            + "&_=" + Date.now();
          const response = await fetch(url, { credentials: "include" });
          const json = await response.json();
          if (!json.Status) throw new Error((json.Msg || "飞瓜接口返回异常") + " | " + category.name + " | " + month.key + " | " + url);
          (json.Data || []).forEach((item, index) => {
            const base = item.BaseBrand || {};
            points.push({
              source: "feigua",
              category: category.name,
              categoryId: category.id,
              month: month.key,
              fromDateCode: month.from,
              toDateCode: month.to,
              rank: index + 1,
              brandId: String(item.BrandId || base.BrandId || ""),
              name: base.BrandName || "",
              logo: base.BrandLogo || "",
              mainCate: base.BrandMainCate || "",
              gmv: Number(item.Gmv || 0),
              lastGmv: Number(item.LastGmv || 0),
              gmvText: item.GmvStr || "",
              ratioText: item.RatioStr || ""
            });
          });
          await new Promise((resolve) => setTimeout(resolve, 180));
        }
      }
      return JSON.stringify({
        generatedAt: new Date().toISOString(),
        period: { start: ${JSON.stringify(start)}, end: ${JSON.stringify(end)}, alignedDay: ${JSON.stringify(alignedDay)} },
        categories,
        months: months.map(m => m.key),
        points
      });
    })()
  `;

  const result = await webbridge("evaluate", { code: script });
  const raw = JSON.parse(result.value);
  const computed = computeRadar(raw);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(computed, null, 2), "utf8");
  return computed;
}

function syncFeiguaBrandRank() {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CORRECT_SYNC_SCRIPT], { cwd: ROOT, timeout: 240000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stderr || stdout}`));
        return;
      }
      const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      resolve(data);
    });
  });
}

function formatMoney(n) {
  if (!Number.isFinite(n)) return "暂无";
  return n >= 100_000_000 ? `${(n / 100_000_000).toFixed(2)}亿` : `${Math.round(n / 10_000)}万`;
}

function formatPct(n) {
  return n == null ? "暂无" : `${(n * 100).toFixed(1)}%`;
}

function generateAnalysis(brand, mode) {
  const pathText = brand.lateVsEarly > 0.8
    ? "后段加速明显，建议重点核查最近3个月是否出现新品、直播排期、达人合作或投流放量。"
    : "增长路径相对连续，建议重点关注稳定投放、货品结构和自播承接能力。";
  const coverageText = `当前抓到${brand.observedMonths}/${brand.expectedMonths}个月榜内数据，缺失月份需用完整排行榜继续校验。`;

  if (mode === "blackHorse") {
    return {
      title: "黑马判断",
      body: `该品牌在${brand.category}类目中，上一年度窗口${brand.baseLabel}榜内累计销售额为${formatMoney(brand.baseTotal)}，年化约${formatMoney(brand.baseAnnualized)}；本年度窗口${brand.currentLabel}榜内累计销售额为${formatMoney(brand.currentTotal)}，年化约${formatMoney(brand.currentAnnualized)}，年化增长${formatPct(brand.growthRate)}。平均排名由${brand.baseAvgRank?.toFixed(1) || "暂无"}提升至${brand.currentAvgRank?.toFixed(1) || "暂无"}。${pathText}${coverageText}`,
      bullets: [
        "上一年榜内销售基数相对较小，今年榜内销售规模明显放大。",
        "销售增长与平均排名提升同时出现，具备新锐黑马特征。",
        "下一步应核查完整月度榜单、TOP商品、直播销售额、达人带货和新品变化。"
      ],
      attention: brand.blackHorseScore >= 65 ? "高" : brand.blackHorseScore >= 45 ? "中" : "低"
    };
  }

  return {
    title: "增长判断",
    body: `该品牌在${brand.category}类目中，上一年度窗口${brand.baseLabel}榜内累计销售额为${formatMoney(brand.baseTotal)}，年化约${formatMoney(brand.baseAnnualized)}；本年度窗口${brand.currentLabel}榜内累计销售额为${formatMoney(brand.currentTotal)}，年化约${formatMoney(brand.currentAnnualized)}，年化增长${formatPct(brand.growthRate)}。平均排名由${brand.baseAvgRank?.toFixed(1) || "暂无"}变化至${brand.currentAvgRank?.toFixed(1) || "暂无"}。${pathText}${coverageText}`,
    bullets: [
      "榜内年度口径下销售额增长明显，是关键增长品牌候选。",
      "13个月趋势可用于判断是持续增长，还是近期阶段性爆发。",
      "若要作为报告定稿，应继续抓完整排行榜或品牌详情接口补齐缺失月份。"
    ],
    attention: (brand.growthRate || 0) > 0.6 || (brand.rankLift || 0) > 2 ? "高" : "中"
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/sync" && req.method === "POST") {
      await readJson(req);
      const data = await syncFeiguaBrandRank();
      return send(res, 200, JSON.stringify({ ok: true, data }));
    }
    if (url.pathname === "/api/data") {
      if (!fs.existsSync(DATA_FILE)) return send(res, 200, JSON.stringify({ ok: true, data: null }));
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      const data = raw.source === "feigua-brand-rank-custom" ? raw : raw.points ? computeRadar(raw) : raw;
      return send(res, 200, JSON.stringify({ ok: true, data }));
    }
    if (url.pathname === "/api/analyze" && req.method === "POST") {
      const body = await readJson(req);
      const data = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) : null;
      const ready = data?.source === "feigua-brand-rank-custom" ? data : data?.points ? computeRadar(data) : data;
      const brand = ready?.brands?.find((b) => b.id === body.id);
      if (!brand) return send(res, 404, JSON.stringify({ ok: false, error: "品牌不存在" }));
      return send(res, 200, JSON.stringify({ ok: true, analysis: generateAnalysis(brand, body.mode) }));
    }
    const filePath = url.pathname === "/" ? path.join(PUBLIC, "index.html") : path.join(PUBLIC, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(PUBLIC) || !fs.existsSync(filePath)) return send(res, 404, "Not found", "text/plain");
    const ext = path.extname(filePath);
    const type = ext === ".css" ? "text/css; charset=utf-8" : ext === ".js" ? "application/javascript; charset=utf-8" : "text/html; charset=utf-8";
    send(res, 200, fs.readFileSync(filePath), type);
  } catch (error) {
    send(res, 500, JSON.stringify({ ok: false, error: error.message }));
  }
});

server.listen(5177, () => {
  console.log("Brand Radar running at http://localhost:5177");
});
