let state = { data: null, tab: "growth", categoryId: "115" };

const $ = (id) => document.getElementById(id);

function fmtMoney(n) {
  if (!Number.isFinite(n)) return "-";
  return n >= 100000000 ? `${(n / 100000000).toFixed(2)}亿` : `${Math.round(n / 10000)}万`;
}

function fmtPct(n) {
  return n == null ? "-" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
}

function fmtRank(n) {
  return n == null ? "-" : Number(n).toFixed(1);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function spark(points, width = 132, height = 36, key = "gmv") {
  const values = points.map((p) => Number(p[key] || 0));
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const span = Math.max(max - min, 1);
  const d = values.map((v, i) => {
    const x = (i / Math.max(values.length - 1, 1)) * width;
    const y = height - ((v - min) / span) * (height - 6) - 3;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const lastY = height - (((values.at(-1) || 0) - min) / span) * (height - 6) - 3;
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" aria-hidden="true"><path d="${d}" fill="none" stroke="#0f8a64" stroke-width="2"/><circle cx="${width - 1}" cy="${lastY}" r="2.5" fill="#0f8a64"/></svg>`;
}

function rankSpark(points, width = 456, height = 104) {
  const ranks = points.map((p) => Number(p.rank || 0)).filter(Boolean);
  if (!ranks.length) return `<p>暂无排名趋势</p>`;
  const max = Math.max(...ranks);
  const min = Math.min(...ranks);
  const span = Math.max(max - min, 1);
  const d = points.map((p, i) => {
    const rank = Number(p.rank || max);
    const x = (i / Math.max(points.length - 1, 1)) * width;
    const y = ((rank - min) / span) * (height - 10) + 5;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<svg class="detailChart" viewBox="0 0 ${width} ${height}" aria-hidden="true"><path d="${d}" fill="none" stroke="#2457d6" stroke-width="2"/></svg>`;
}

function rankChangeText(b) {
  const lift = b.rankLift || 0;
  const symbol = lift > 0 ? "↑" : lift < 0 ? "↓" : "";
  const cls = lift >= 0 ? "up" : "down";
  return `${fmtRank(b.baseAvgRank)} → ${fmtRank(b.currentAvgRank)} ${symbol ? `<span class="${cls}">${symbol}${Math.abs(lift).toFixed(1)}</span>` : ""}`;
}

function monthRows(brand) {
  const byMonth = new Map(brand.monthly.map((m) => [m.month, m]));
  return (state.data.months || brand.monthly.map((m) => m.month)).map((month, index, months) => {
    const m = byMonth.get(month);
    if (!m) {
      return `
        <tr class="missingRow">
          <td>${escapeHtml(month)}</td>
          <td colspan="5">未进入本次Top榜 / 当前接口未抓到该月品牌数据</td>
        </tr>
      `;
    }
    const prevMonth = months.slice(0, index).reverse().find((item) => byMonth.has(item));
    const prev = prevMonth ? byMonth.get(prevMonth) : null;
    const mom = prev && prev.gmv > 0 ? (m.gmv - prev.gmv) / prev.gmv : null;
    const rankMove = prev && prev.rank ? prev.rank - m.rank : null;
    return `
      <tr>
        <td>${escapeHtml(m.month)}<small>${escapeHtml(m.datecode || "")}</small></td>
        <td><strong>${fmtMoney(Number(m.gmv || 0))}</strong><small>${escapeHtml(m.gmvText || "")}</small></td>
        <td>第${escapeHtml(m.rank)}名</td>
        <td class="${mom == null || mom >= 0 ? "up" : "down"}">${fmtPct(mom)}</td>
        <td>${rankMove == null ? "-" : rankMove > 0 ? `<span class="up">↑${rankMove}</span>` : rankMove < 0 ? `<span class="down">↓${Math.abs(rankMove)}</span>` : "持平"}</td>
        <td>${escapeHtml(m.ratioText || "-")}</td>
      </tr>
    `;
  }).join("");
}

async function loadData() {
  try {
    const res = await fetch("/api/data");
    if (!res.ok) throw new Error("API unavailable");
    const json = await res.json();
    state.data = json.data;
    $("status").textContent = "已加载本地服务数据";
  } catch {
    const res = await fetch("data/brand-radar-data.json");
    const json = await res.json();
    state.data = json.data || json;
    $("status").textContent = "已加载静态数据";
  }
  render();
}

async function syncData() {
  $("status").textContent = "同步中...";
  $("syncBtn").disabled = true;
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start: $("startMonth").value, end: $("endMonth").value, size: 140 })
    });
    const json = await res.json();
    $("syncBtn").disabled = false;
    if (!json.ok) throw new Error(json.error || "同步失败，请确认飞瓜页面仍处于登录状态。");
    state.data = json.data;
    $("status").textContent = "已同步";
    render();
  } catch (error) {
    $("syncBtn").disabled = false;
    $("status").textContent = "同步失败";
    alert(error.message || "在线静态版本不能直接同步，请在本地运行后重新抓取数据。");
  }
}

function categoryBrands() {
  return state.data?.brands?.filter((b) => b.categoryId === state.categoryId) || [];
}

function currentList() {
  if (!state.data) return [];
  const list = state.tab === "growth" ? state.data.growthBrands : state.data.blackHorseBrands;
  return list.filter((b) => b.categoryId === state.categoryId);
}

function renderMetrics() {
  const brands = categoryBrands();
  const horses = (state.data?.blackHorseBrands || []).filter((b) => b.categoryId === state.categoryId && b.blackHorseScore >= 35);
  $("metricBrands").textContent = brands.length || "-";
  $("metricGrowth").textContent = brands.length ? fmtPct(Math.max(...brands.map((b) => b.growthRate || 0))) : "-";
  const rankLift = Math.max(...brands.map((b) => b.rankLift || 0), 0);
  $("metricRank").textContent = rankLift > 0 ? `↑${rankLift.toFixed(1)}` : "-";
  $("metricHorse").textContent = horses.length || "-";
}

function renderRows(list) {
  if (!list.length) {
    $("brandRows").innerHTML = `<tr><td colspan="7">当前类目暂无符合条件的品牌。可以先同步数据，或切换另一个榜单。</td></tr>`;
    return;
  }
  $("brandRows").innerHTML = list.map((b) => `
    <tr data-id="${escapeHtml(b.id)}">
      <td><div class="brandCell"><img src="${escapeHtml(b.logo)}" onerror="this.style.visibility='hidden'"><div class="brandMeta"><strong>${escapeHtml(b.name)}</strong><small>${escapeHtml(b.category)}</small></div></div></td>
      <td><strong>${fmtMoney(b.baseTotal)}</strong><small>年化 ${fmtMoney(b.baseAnnualized)}</small></td>
      <td><strong>${fmtMoney(b.currentTotal)}</strong><small>年化 ${fmtMoney(b.currentAnnualized)}</small></td>
      <td class="${(b.growthRate || 0) >= 0 ? "up" : "down"}">${fmtPct(b.growthRate)}</td>
      <td>${rankChangeText(b)}</td>
      <td>${spark(b.monthly)}</td>
      <td><span class="tag">${state.tab === "growth" ? "关键增长" : "新锐黑马"}</span></td>
    </tr>
  `).join("");
  document.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", () => openDrawer(tr.dataset.id)));
}

function renderBasis() {
  if (!state.data?.basis) return "";
  return `<p class="basis">${escapeHtml(state.data.basis.note)} 当前V1使用飞瓜品牌Top榜接口，若某品牌未进入当月Top榜，该月可能缺失，需要结合完整排行榜进一步校验。</p>`;
}

function render() {
  if (!state.data) {
    $("brandRows").innerHTML = `<tr><td colspan="7">请先点击“同步飞瓜数据”。</td></tr>`;
    renderMetrics();
    return;
  }
  renderMetrics();
  renderRows(currentList());
  maybeAutoOpen();
}

function maybeAutoOpen() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("openFirst") !== "1" || state.autoOpened) return;
  const first = currentList()[0];
  if (!first) return;
  state.autoOpened = true;
  setTimeout(() => {
    openDrawer(first.id).then(() => {
      const scroll = Number(params.get("drawerScroll") || 0);
      if (scroll) $("drawer").scrollTop = scroll;
    });
  }, 100);
}

async function openDrawer(id) {
  const brand = state.data.brands.find((b) => b.id === id);
  if (!brand) return;
  const mode = state.tab === "blackHorse" ? "blackHorse" : "growth";
  $("drawerContent").innerHTML = `
    <div class="detailHead"><img src="${escapeHtml(brand.logo)}" onerror="this.style.visibility='hidden'"><div><h2>${escapeHtml(brand.name)}</h2><p>${escapeHtml(brand.category)} · ${state.data.period.start} 至 ${state.data.period.end}</p></div></div>
    ${renderBasis()}
    <div class="detailGrid">
      <article><span>上一年度榜内累计</span><strong>${fmtMoney(brand.baseTotal)}</strong><small>${escapeHtml(brand.baseLabel)} · ${brand.baseMonths}/${brand.basePeriodMonths}个月有榜内数据</small></article>
      <article><span>本年度榜内累计</span><strong>${fmtMoney(brand.currentTotal)}</strong><small>${escapeHtml(brand.currentLabel)} · ${brand.currentMonths}/${brand.currentPeriodMonths}个月有榜内数据</small></article>
      <article><span>上一年度榜内年化</span><strong>${fmtMoney(brand.baseAnnualized)}</strong></article>
      <article><span>本年度榜内年化</span><strong>${fmtMoney(brand.currentAnnualized)}</strong></article>
      <article><span>年化增长率</span><strong>${fmtPct(brand.growthRate)}</strong></article>
      <article><span>平均排名变化</span><strong>${rankChangeText(brand)}</strong></article>
      <article><span>月度最高估算销售额</span><strong>${fmtMoney(brand.maxGmv)}</strong></article>
      <article><span>月度最低估算销售额</span><strong>${fmtMoney(brand.minGmv)}</strong></article>
      <article><span>月度覆盖</span><strong>${brand.observedMonths}/${brand.expectedMonths}</strong><small>${Math.round((brand.coverageRate || 0) * 100)}% 有榜内数据</small></article>
    </div>
    <div class="chartBox"><h3>月度销售趋势</h3>${spark(brand.monthly, 456, 120)}</div>
    <div class="chartBox"><h3>行业排名趋势</h3>${rankSpark(brand.monthly)}<p>${brand.monthly.map((m) => `${m.month}: 第${m.rank}名`).join(" ｜ ")}</p></div>
    <div class="chartBox monthlyBox">
      <h3>月度数据明细</h3>
      <table class="monthlyTable">
        <thead>
          <tr>
            <th>月份</th>
            <th>销售额</th>
            <th>排名</th>
            <th>环比</th>
            <th>排名变动</th>
            <th>后台增长</th>
          </tr>
        </thead>
        <tbody>${monthRows(brand)}</tbody>
      </table>
    </div>
    <button id="analyzeBtn">生成分析</button>
    <div id="analysis" class="analysis" style="margin-top:12px;">等待生成</div>
  `;
  $("drawer").classList.add("open");
  $("analyzeBtn").addEventListener("click", async () => {
    $("analysis").textContent = "生成中...";
    let a;
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, mode })
      });
      if (!res.ok) throw new Error("API unavailable");
      const json = await res.json();
      a = json.analysis;
    } catch {
      a = localAnalysis(brand, mode);
    }
    $("analysis").textContent = `### ${a.title}\n${a.body}\n\n### 增长驱动因素\n1. ${a.bullets[0]}\n2. ${a.bullets[1]}\n3. ${a.bullets[2]}\n\n### 是否值得关注\n${a.attention}`;
  });
}

function localAnalysis(brand, mode) {
  const lift = (brand.rankLift || 0).toFixed(1);
  const growth = fmtPct(brand.growthRate);
  const title = mode === "blackHorse" ? "黑马判断" : "增长判断";
  const body = mode === "blackHorse"
    ? `${brand.name} 从上一年度平均第${fmtRank(brand.baseAvgRank)}名提升至本年度平均第${fmtRank(brand.currentAvgRank)}名，年化销售规模增长${growth}，属于需要重点复核的新锐候选。`
    : `${brand.name} 在${brand.baseLabel}至${brand.currentLabel}的对比中，榜内年化销售额由${fmtMoney(brand.baseAnnualized)}增长至${fmtMoney(brand.currentAnnualized)}，增长${growth}，平均排名提升${lift}名。`;
  return {
    title,
    body,
    bullets: [
      `销售规模提升明显，本年度榜内累计达到${fmtMoney(brand.currentTotal)}。`,
      `排名从${fmtRank(brand.baseAvgRank)}变化到${fmtRank(brand.currentAvgRank)}，说明行业相对位置同步改善。`,
      `月度趋势覆盖${brand.observedMonths}/${brand.expectedMonths}个观测点，建议继续点开月度明细核对爆发月份和缺失月份。`
    ],
    attention: (brand.growthRate || 0) >= 1 || (brand.rankLift || 0) >= 30 ? "高" : "中"
  };
}

document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.tab = btn.dataset.tab;
    render();
  });
});

document.querySelectorAll(".categoryTabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".categoryTabs button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.categoryId = btn.dataset.categoryId;
    render();
  });
});

$("syncBtn").addEventListener("click", syncData);
$("closeDrawer").addEventListener("click", () => $("drawer").classList.remove("open"));
loadData();
