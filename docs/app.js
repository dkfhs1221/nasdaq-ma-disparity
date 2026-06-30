(function () {
  "use strict";

  const OVERHEAT = 130, COOLDOWN = 105, CAUTION = 120;
  const GMIN = 95, GMAX = 140;

  // 탭 순서: S&P500, 나스닥, 코스피
  const INDICES = [
    { key: "sp500", short: "S&P500", name: "S&P500 선물" },
    { key: "nasdaq", short: "나스닥", name: "나스닥 선물" },
    { key: "kospi", short: "코스피", name: "코스피종합지수" },
  ];

  const TELEGRAM_URL = (window.SITE_CONFIG && window.SITE_CONFIG.telegramUrl) || "";

  const track = (name, params) => {
    if (typeof window.gtag === "function") window.gtag("event", name, params || {});
  };

  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 2) =>
    n == null || isNaN(n) ? "—" : Number(n).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });

  function zoneOf(v) {
    if (v >= OVERHEAT) return ["overheat", "과열권 (Panic Buying 자제)"];
    if (v >= CAUTION) return ["caution", "과열 경계 (관심)"];
    if (v <= COOLDOWN) return ["cooldown", "과열 해소 (Panic Selling 자제)"];
    return ["normal", "정상 범위"];
  }
  const ZONE_SHORT = { overheat: "과열", caution: "경계", normal: "정상", cooldown: "과열해소" };

  let priceChart, dispChart, HISTORY = [];
  let currentKey = INDICES[0].key;

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

  async function loadIndex(key) {
    currentKey = key;
    const meta = INDICES.find((i) => i.key === key);
    document.querySelectorAll("[data-label-index]").forEach((el) => {
      el.textContent = meta.short;
    });
    document.querySelectorAll("[data-label-name]").forEach((el) => {
      el.textContent = meta.name;
    });
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
    const [zk] = zoneOf(s.disparity);

    const badge = $("typeBadge");
    badge.textContent = "updated";
    badge.className = "type-badge " + (s.type || "");

    $("updatedAt").textContent = `${s.date} ${s.time} 기준`;
    $("dispBig").innerHTML = `${fmt(s.disparity, 1)}<span class="pct">%</span>`;

    const zl = $("zoneLabel");
    zl.textContent = s.zone_label || zoneOf(s.disparity)[1];
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
    const pos = Math.max(0, Math.min(100, ((s.disparity - GMIN) / (GMAX - GMIN)) * 100));
    m.style.left = pos + "%";
    m.hidden = false;
    $("gaugeLabel").textContent = `${fmt(s.disparity, 1)}%`;
  }

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  function slice(n) { return n && n > 0 ? HISTORY.slice(-n) : HISTORY; }

  function buildPriceChart(n) {
    const data = slice(n);
    const labels = data.map((d) => d.date);
    const meta = INDICES.find((i) => i.key === currentKey);
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
    const ctx = $("dispChart");
    if (dispChart) dispChart.destroy();

    const seg = (lo, hi, color) => ({
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
            segment: { borderColor: (c) => segColor(c) }, fill: false },
          seg(0, OVERHEAT, css("--overheat")),
          seg(0, COOLDOWN, css("--cooldown")),
        ],
      },
      options: Object.assign(baseOpts(), {
        plugins: { legend: { display: false }, tooltip: tip(), zoom: zoomOpts() },
        scales: scales({ suggestedMin: Math.min(100, Math.min(...vals) - 3), suggestedMax: Math.max(132, Math.max(...vals) + 3) }),
      }),
    });
    ctx.ondblclick = () => dispChart.resetZoom();
  }

  function segColor(ctx) {
    const v = ctx.p1.parsed.y;
    if (v >= OVERHEAT) return css("--overheat");
    if (v >= CAUTION) return css("--caution");
    if (v <= COOLDOWN) return css("--cooldown");
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
    const tb = $("histTable").querySelector("tbody");
    const rows = HISTORY.slice(-30).reverse();
    tb.innerHTML = rows.map((d) => {
      const [zk] = zoneOf(d.disparity);
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
