(function () {
  "use strict";

  // 탭 순서: S&P500, 나스닥, 코스피. overheat/caution/cooldown은 지수별 실측 분포 기준 임계값(%).
  const INDICES = [
    { key: "sp500", short: "S&P500", name: "S&P500 선물", overheat: 110, caution: 105, cooldown: 95, gmin: 88, gmax: 116 },
    { key: "nasdaq", short: "나스닥", name: "나스닥 선물", overheat: 110, caution: 105, cooldown: 95, gmin: 88, gmax: 116 },
    { key: "kospi", short: "코스피", name: "코스피종합지수", overheat: 130, caution: 120, cooldown: 105, gmin: 95, gmax: 140 },
  ];

  const TELEGRAM_URL = (window.SITE_CONFIG && window.SITE_CONFIG.telegramUrl) || "";

  const track = (name, params) => {
    if (typeof window.gtag === "function") window.gtag("event", name, params || {});
  };

  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 2) =>
    n == null || isNaN(n) ? "—" : Number(n).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });

  function zoneOf(meta, v) {
    if (v >= meta.overheat) return ["overheat", "과열권 (Panic Buying 자제)"];
    if (v >= meta.caution) return ["caution", "과열 경계 (관심)"];
    if (v <= meta.cooldown) return ["cooldown", "과열 해소 (Panic Selling 자제)"];
    return ["normal", "정상 범위"];
  }
  const ZONE_SHORT = { overheat: "과열", caution: "경계", normal: "정상", cooldown: "과열해소" };

  let priceChart, dispChart, HISTORY = [];
  let currentKey = INDICES[0].key;
  const currentMeta = () => INDICES.find((i) => i.key === currentKey);

  function buildTabs() {
    const box = $("indexTabs");
    box.innerHTML = INDICES.map((idx, i) =>
      `<button class="tab-btn${i === 0 ? " on" : ""}" data-key="${idx.key}">${idx.short}</button>`
    ).join("");
    box.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const key = b.dataset.key;
      if (key === currentKey) return;
      [...box.children].forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      track("tab_change", { index: key });
      loadIndex(key);
    });
  }

  function renderGaugeShell() {
    const meta = currentMeta();
    const { gmin, gmax, cooldown, caution, overheat } = meta;
    const total = gmax - gmin;
    const pct = (v) => Math.max(0, Math.min(100, ((v - gmin) / total) * 100));

    const segs = [
      { cls: "cooldown", w: pct(cooldown) - pct(gmin) },
      { cls: "normal", w: pct(caution) - pct(cooldown) },
      { cls: "caution", w: pct(overheat) - pct(caution) },
      { cls: "overheat", w: pct(gmax) - pct(overheat) },
    ];
    $("gaugeTrack").innerHTML = segs.map((s) => `<div class="seg ${s.cls}" style="flex:0 0 ${s.w}%"></div>`).join("");

    $("gaugeTicks").innerHTML = [
      { v: cooldown, l: pct(cooldown) },
      { v: caution, l: pct(caution) },
      { v: overheat, l: pct(overheat) },
    ].map((t) => `<span class="tick" style="left:${t.l}%">${fmt(t.v, 0)}</span>`).join("");

    $("gaugeLegend").innerHTML = `
      <span class="lg cooldown"><i></i>과열해소 <b>≤${fmt(cooldown, 0)}</b></span>
      <span class="lg normal"><i></i>정상 <b>${fmt(cooldown, 0)}–${fmt(caution, 0)}</b></span>
      <span class="lg caution"><i></i>경계 <b>${fmt(caution, 0)}–${fmt(overheat, 0)}</b></span>
      <span class="lg overheat"><i></i>과열 <b>≥${fmt(overheat, 0)}</b></span>`;

    $("dispLegendHint").textContent = `🔴 ${fmt(overheat, 0)} 과열 · 🔵 ${fmt(cooldown, 0)} 과열해소`;

    $("thOverheat").textContent = `≥ ${fmt(overheat, 0)}%`;
    $("thCaution").textContent = `${fmt(caution, 0)}–${fmt(overheat, 0)}%`;
    $("thNormal").textContent = `${fmt(cooldown, 0)}–${fmt(caution, 0)}%`;
    $("thCooldown").textContent = `≤ ${fmt(cooldown, 0)}%`;
    $("thNote").textContent = meta.key === "kospi"
      ? "코스피는 이그전 원안의 임계값(과열 130% / 해소 105%)을 그대로 사용합니다."
      : `${meta.short}는 최근 10년 50일 이격도 실측 분포(표준편차 기준)를 바탕으로 임계값을 재산정했습니다 — 코스피보다 변동성이 작아 더 좁은 범위를 사용합니다.`;
  }

  async function loadIndex(key) {
    currentKey = key;
    const meta = currentMeta();
    document.querySelectorAll("[data-label-index]").forEach((el) => { el.textContent = meta.short; });
    document.querySelectorAll("[data-label-name]").forEach((el) => { el.textContent = meta.name; });
    document.documentElement.style.setProperty("--index-label", `"${meta.short} "`);
    renderGaugeShell();
    emptyState();
    const [hist, latest] = await Promise.all([
      fetchJSON(`./data/${key}/history.json`),
      fetchJSON(`./data/${key}/latest.json`),
    ]);
    HISTORY = (hist || []).filter((d) => d && d.disparity != null);
    renderHero(latest);
    if (HISTORY.length) {
      registerZoom();
      buildPriceChart(250);
      buildDispChart(250);
      renderTable();
      wireRangeButtons("rangeBtns", (n) => buildPriceChart(n));
      wireRangeButtons("rangeBtnsDisp", (n) => buildDispChart(n));
    }
  }

  async function load() {
    if (TELEGRAM_URL) {
      const l = $("tgLink");
      l.href = TELEGRAM_URL;
      l.hidden = false;
      l.addEventListener("click", () => track("telegram_click", { url: TELEGRAM_URL }));
    }
    buildTabs();
    await loadIndex(currentKey);
  }

  function registerZoom() {
    if (!window.Chart) return;
    const z = window.ChartZoom || window.chartjsPluginZoom || window["chartjs-plugin-zoom"];
    if (z && (z.id === "zoom" || z.default)) {
      try { window.Chart.register(z.default || z); } catch (e) { }
    }
  }
  function zoomOpts() {
    return {
      pan: { enabled: true, mode: "x" },
      zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" },
    };
  }

  async function fetchJSON(url) {
    try {
      const r = await fetch(url + "?v=" + Date.now());
      if (!r.ok) return null;
      const t = (await r.text()).trim();
      return t ? JSON.parse(t) : null;
    } catch (e) { return null; }
  }

  function emptyState() {
    $("zoneLabel").textContent = "첫 데이터 갱신 대기 중";
    $("note").textContent = "GitHub Actions의 첫 실행이 완료되면 차트와 기록이 표시됩니다.";
  }

  function renderHero(s) {
    if (!s || s.disparity == null) { emptyState(); return; }
    const meta = currentMeta();
    const [zk] = zoneOf(meta, s.disparity);

    const badge = $("typeBadge");
    badge.textContent = "updated";
    badge.className = "type-badge " + (s.type || "");

    $("updatedAt").textContent = `${s.date} ${s.time} 기준`;
    $("dispBig").innerHTML = `${fmt(s.disparity, 1)}<span class="pct">%</span>`;

    const zl = $("zoneLabel");
    zl.textContent = s.zone_label || zoneOf(meta, s.disparity)[1];
    zl.className = "zone z-" + (s.zone || zk);

    $("dispDelta").textContent = "";
    if (s.prev_disparity != null) {
      const d = +(s.disparity - s.prev_disparity).toFixed(2);
      $("dispDelta").textContent = `직전 대비 ${d > 0 ? "+" : ""}${d}p`;
    }

    $("kospiVal").textContent = fmt(s.index);
    $("ma50Val").textContent = fmt(s.ma50);

    const chg = $("kospiChg");
    chg.textContent = "";
    if (s.change != null) {
      const up = s.change > 0, dn = s.change < 0;
      chg.textContent = `${up ? "▲" : dn ? "▼" : "—"} ${fmt(Math.abs(s.change))} (${s.change_pct > 0 ? "+" : ""}${fmt(s.change_pct)}%)`;
      chg.className = "chg " + (up ? "up" : dn ? "down" : "");
    }
    $("note").textContent = s.note || "";

    const m = $("gaugeMarker");
    const pos = Math.max(0, Math.min(100, ((s.disparity - meta.gmin) / (meta.gmax - meta.gmin)) * 100));
    m.style.left = pos + "%";
    m.hidden = false;
    $("gaugeLabel").textContent = `${fmt(s.disparity, 1)}%`;
  }

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  function slice(n) { return n && n > 0 ? HISTORY.slice(-n) : HISTORY; }

  function buildPriceChart(n) {
    const data = slice(n);
    const labels = data.map((d) => d.date);
    const meta = currentMeta();
    const ctx = $("priceChart");
    if (priceChart) priceChart.destroy();
    priceChart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: meta.short, data: data.map((d) => d.close), borderColor: css("--txt"), borderWidth: 1.6, pointRadius: 0, tension: 0.1 },
          { label: "50일 이평", data: data.map((d) => d.ma50), borderColor: css("--accent"), borderWidth: 1.6, pointRadius: 0, borderDash: [5, 4], tension: 0.1, spanGaps: true },
          { label: "100일 이평", data: data.map((d) => d.ma100), borderColor: css("--ma100"), borderWidth: 1.4, pointRadius: 0, borderDash: [3, 3], tension: 0.1, spanGaps: true },
          { label: "200일 이평", data: data.map((d) => d.ma200), borderColor: css("--ma200"), borderWidth: 1.4, pointRadius: 0, borderDash: [2, 2], tension: 0.1, spanGaps: true },
        ],
      },
      options: baseOpts(),
    });
    ctx.ondblclick = () => priceChart.resetZoom();
  }

  function buildDispChart(n) {
    const data = slice(n);
    const labels = data.map((d) => d.date);
    const vals = data.map((d) => d.disparity);
    const meta = currentMeta();
    const ctx = $("dispChart");
    if (dispChart) dispChart.destroy();

    const seg = (hi, color) => ({
      label: "", data: labels.map(() => hi), fill: false, borderColor: color,
      borderWidth: 1, borderDash: [4, 4], pointRadius: 0,
    });

    dispChart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "이격도", data: vals, borderColor: css("--caution"),
            borderWidth: 1.8, pointRadius: 0, tension: 0.15,
            segment: { borderColor: (c) => segColor(meta, c) }, fill: false },
          seg(meta.overheat, css("--overheat")),
          seg(meta.cooldown, css("--cooldown")),
        ],
      },
      options: Object.assign(baseOpts(), {
        plugins: { legend: { display: false }, tooltip: tip(), zoom: zoomOpts() },
        scales: scales({
          suggestedMin: Math.min(meta.cooldown - 2, Math.min(...vals) - 3),
          suggestedMax: Math.max(meta.overheat + 2, Math.max(...vals) + 3),
        }),
      }),
    });
    ctx.ondblclick = () => dispChart.resetZoom();
  }

  function segColor(meta, ctx) {
    const v = ctx.p1.parsed.y;
    if (v >= meta.overheat) return css("--overheat");
    if (v >= meta.caution) return css("--caution");
    if (v <= meta.cooldown) return css("--cooldown");
    return css("--normal");
  }

  function baseOpts() {
    return {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: css("--muted"), boxWidth: 14, font: { size: 11 } } },
        tooltip: tip(),
        zoom: zoomOpts(),
      },
      scales: scales({}),
    };
  }
  function scales(yExtra) {
    return {
      x: { ticks: { color: css("--muted"), maxTicksLimit: 6, font: { size: 10 } }, grid: { color: "#1c2535" } },
      y: Object.assign({ position: "right", ticks: { color: css("--muted"), font: { size: 10 } }, grid: { color: "#1c2535" } }, yExtra),
    };
  }
  function tip() {
    return {
      backgroundColor: "#0b0f17", borderColor: "#222c3d", borderWidth: 1,
      titleColor: "#e7edf6", bodyColor: "#e7edf6", padding: 10,
      callbacks: { label: (c) => `${c.dataset.label || "이격도"}: ${fmt(c.parsed.y, 2)}` },
    };
  }

  function wireRangeButtons(boxId, onPick) {
    const box = $(boxId);
    if (!box) return;
    box.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      [...box.children].forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      onPick(+b.dataset.r);
      track("range_change", { chart: boxId, range: b.dataset.r });
    });
  }

  function renderTable() {
    const meta = currentMeta();
    const tb = $("histTable").querySelector("tbody");
    const rows = HISTORY.slice(-30).reverse();
    tb.innerHTML = rows.map((d) => {
      const [zk] = zoneOf(meta, d.disparity);
      return `<tr>
        <td class="c-date">${d.date}</td>
        <td class="c-kospi">${fmt(d.close)}</td>
        <td class="c-ma50">${fmt(d.ma50)}</td>
        <td class="c-disp"><b>${fmt(d.disparity, 1)}%</b></td>
        <td class="c-zone"><span class="pill ${zk}">${ZONE_SHORT[zk]}</span></td>
      </tr>`;
    }).join("");
  }

  load();
})();
