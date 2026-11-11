/* M25 traffic volume predictor - frontend (plain JavaScript, Leaflet, Chart.js) */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat("en-GB");
  const state = {
    meta: null, sites: [], byId: new Map(), preds: null, date: null, hour: 8,
    road: "", direction: "", selected: null, markers: new Map(), chart: null,
    detailCache: new Map(), placeMarker: null,
  };
  const CLASS_COLOURS = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281", "#0a2a54"];

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hourRange = (h) => `${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00`;
  const shortVol = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(v));
  const fmtDate = (iso, opts) => new Date(iso + "T12:00:00").toLocaleDateString("en-GB", opts || { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const volClass = (v) => { const b = state.meta.volume_bins; let i = 0; while (i < b.length && v >= b[i]) i++; return i; };

  async function getJson(path) {
    const res = await fetch(path, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      let msg = `Request failed (${res.status})`;
      try { const j = await res.json(); if (j.detail) msg = j.detail; } catch (_) { /* keep default */ }
      throw new Error(msg);
    }
    return res.json();
  }

  // Static build (no server): the same calls are answered from pre-computed JSON files.
  const STATIC = !!window.TP_STATIC;
  const dayFiles = new Map();
  const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  async function dayFile(date) {
    if (!dayFiles.has(date)) dayFiles.set(date, await getJson(`data/pred/${date}.json`));
    return dayFiles.get(date);
  }
  async function staticApi(path) {
    const u = new URL(path, "http://x");
    const date = u.searchParams.get("date");
    if (u.pathname === "/api/meta") {
      const m = await getJson("data/meta.json");
      const today = isoLocal(new Date());
      const horizon = new Date(); horizon.setDate(horizon.getDate() + m.horizon_days);
      m.min_date = today > m.first_date ? today : m.first_date;
      m.max_date = isoLocal(horizon) < m.last_date ? isoLocal(horizon) : m.last_date;
      if (m.min_date > m.max_date) m.min_date = m.max_date;
      m.data_age_days = Math.round((new Date(today) - new Date(m.latest_data_day)) / 864e5);
      return m;
    }
    if (u.pathname === "/api/sites") return getJson("data/sites.json");
    if (u.pathname === "/api/validation") return getJson("data/validation.json");
    if (u.pathname === "/api/predictions") return dayFile(date);
    if (u.pathname === "/api/geocode") {
      const q = u.searchParams.get("q");
      const r = await getJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=gb&limit=5&q=${encodeURIComponent(q)}`);
      return { results: r.map((x) => ({ name: x.display_name, lat: +x.lat, lon: +x.lon })) };
    }
    const m = u.pathname.match(/^\/api\/sites\/(\d+)$/);
    if (m) {
      const id = +m[1], day = await dayFile(date), p = day.sites[id], site = state.byId.get(id);
      const base = { site, latest_data_day: state.meta.latest_data_day, data_source: state.meta.data_source };
      if (p.status !== "ok") return { ...base, prediction: { status: p.status, reason: p.reason, day_type: day.day_type, hours: [] } };
      const hours = p.volume.map((v, h) => ({ hour: h, volume: v, low: p.low[h], high: p.high[h], n: p.n[h], level: p.level[h], reliability: p.reliability[h], reliability_note: p.notes[p.note_idx[h]] }));
      return { ...base,
        prediction: { status: "ok", method: p.method, method_label: p.method_label, day_type: day.day_type, hours },
        historical_median: { hours: p.hist }, recent_similar_days: p.recent, peaks: p.peaks, daily_total: p.daily_total,
        history_used: p.history_used, validation: p.validation };
    }
    throw new Error("Not available in the static build");
  }
  const api = (path) => (STATIC ? staticApi(path) : getJson(path));

  function csvFor(d) {
    const s = d.site, rows = [["site_id", "site_name", "road", "direction", "date", "hour_beginning", "predicted_vehicles_per_hour", "range_low", "range_high", "historical_median_similar_days", "method", "comparable_observations", "reliability", "data_source", "latest_data_day", "note"]];
    const src = state.meta.is_demo ? "DEMO - synthetic, not observations" : "WebTRIS historical counts";
    for (const h of d.prediction.hours) rows.push([s.site_id, s.name, s.road, s.direction, state.date, String(h.hour).padStart(2, "0") + ":00", h.volume ?? "", h.low ?? "", h.high ?? "", d.historical_median.hours[h.hour] ?? "", d.prediction.method, h.n || "", h.reliability || "", src, d.latest_data_day, "Estimate from historical patterns; vehicle volume, not congestion"]);
    return rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(",")).join("\r\n");
  }

  function showStatus(text, { error = false, retry = null, sticky = false } = {}) {
    const el = $("status");
    el.className = "status" + (error ? " error" : "");
    el.innerHTML = `<span>${esc(text)}</span>`;
    if (retry) {
      const b = document.createElement("button");
      b.textContent = "Try again";
      b.onclick = () => { hideStatus(); retry(); };
      el.appendChild(b);
    }
    el.hidden = false;
    clearTimeout(showStatus.t);
    if (!sticky && !error) showStatus.t = setTimeout(hideStatus, 2500);
  }
  function hideStatus() { $("status").hidden = true; }

  // ---------- map ----------
  const map = L.map("map", { zoomControl: false, minZoom: 6, maxZoom: 17 }).setView([52.6, -1.6], 7); // England
  L.control.zoom({ position: "bottomright" }).addTo(map);
  const HomeControl = L.Control.extend({
    options: { position: "bottomright" },
    onAdd() {
      const wrap = L.DomUtil.create("div", "leaflet-bar");
      const mk = (label, title, fn) => {
        const a = L.DomUtil.create("a", "view-btn", wrap);
        a.href = "#"; a.textContent = label; a.title = title; a.setAttribute("role", "button");
        L.DomEvent.on(a, "click", (e) => { L.DomEvent.stop(e); fn(); });
      };
      mk("M25", "Show the pilot area", () => fitToVisible());
      mk("ENG", "Show the whole of England", () => map.flyTo([52.6, -1.6], 7, { duration: 0.6 }));
      return wrap;
    },
  });
  map.addControl(new HomeControl());
  L.control.scale({ imperial: true, metric: true, position: "bottomright" }).addTo(map);

  function pinIcon(site, pred) {
    const h = site.heading_deg;
    const arrow = h == null ? "" : `<span class="arr" style="transform:rotate(${Math.round(h)}deg)">↑</span>`;
    let cls = "nodata", label = "no data";
    if (pred && pred.status === "ok" && pred.volume[state.hour] != null) {
      const v = pred.volume[state.hour];
      cls = "c" + volClass(v);
      label = shortVol(v);
    }
    const sel = state.selected === site.site_id ? " selected" : "";
    // Shift the pin to the left of the direction of travel so the two carriageways do not overlap.
    let ax = 0, ay = 0;
    if (h != null) { const r = ((h - 90) * Math.PI) / 180; ax = 34 * Math.sin(r); ay = -16 * Math.cos(r); }
    return L.divIcon({
      className: "pin-wrap", iconSize: [64, 28], iconAnchor: [32 - ax, 14 - ay],
      html: `<div class="pin ${cls}${sel}">${arrow}<span>${label}</span></div>`,
    });
  }

  function tipHtml(site, pred) {
    const where = [site.road, site.direction].filter(Boolean).join(" · ");
    let line;
    if (pred && pred.status === "ok" && pred.volume[state.hour] != null) {
      line = `<b>${nf.format(pred.volume[state.hour])}</b> vehicles/hour predicted, ${hourRange(state.hour)}`;
    } else {
      line = "Not enough data for a prediction";
    }
    return `<b>${esc(site.name)}</b><span class="sub">${esc(where)}</span>${line}`;
  }

  function visible(site) {
    return (!state.road || site.road === state.road) && (!state.direction || site.direction === state.direction);
  }

  function renderMarkers() {
    for (const site of state.sites) {
      const pred = state.preds ? state.preds.sites[site.site_id] : null;
      let m = state.markers.get(site.site_id);
      if (!m) {
        m = L.marker([site.latitude, site.longitude], { icon: pinIcon(site, pred), keyboard: true, title: site.name, riseOnHover: true });
        m.on("click", () => selectSite(site.site_id));
        m.bindTooltip("", { className: "site-tip", direction: "top", offset: [0, -16] });
        state.markers.set(site.site_id, m);
      }
      m.setIcon(pinIcon(site, pred));
      m.setTooltipContent(tipHtml(site, pred));
      m.setZIndexOffset(state.selected === site.site_id ? 1000 : 0);
      if (visible(site)) { if (!map.hasLayer(m)) m.addTo(map); } else if (map.hasLayer(m)) map.removeLayer(m);
    }
  }

  function fitToVisible() {
    const pts = state.sites.filter(visible).map((s) => [s.latitude, s.longitude]);
    if (!pts.length) return;
    const wide = window.innerWidth > 1100;
    map.fitBounds(L.latLngBounds(pts), {
      maxZoom: 13,
      paddingTopLeft: wide ? [380, 40] : [30, 230],
      paddingBottomRight: wide ? [state.selected != null ? 440 : 60, 110] : [30, 150],
    });
  }

  // ---------- legend ----------
  function renderLegend() {
    const b = state.meta.volume_bins;
    const rows = CLASS_COLOURS.map((c, i) => {
      const lo = i === 0 ? 0 : b[i - 1];
      const text = i === b.length ? `${nf.format(lo)} or more` : `${nf.format(lo)} – ${nf.format(b[i] - 1)}`;
      return `<li><span class="swatch" style="background:${c}"></span>${text}</li>`;
    });
    rows.push('<li><span class="swatch nodata"></span>Not enough data</li>');
    $("legend-list").innerHTML = rows.join("");
  }

  // ---------- data loading ----------
  async function loadPredictions() {
    showStatus("Loading predictions…", { sticky: true });
    try {
      state.preds = await api(`/api/predictions?date=${state.date}`);
      hideStatus();
      const hol = state.preds.is_bank_holiday ? " (bank holiday)" : "";
      $("day-note").textContent = `${fmtDate(state.date)}${hol}: compared with past ${state.preds.day_type}.`;
      renderMarkers();
      if (state.selected != null) renderPanel();
    } catch (e) {
      showStatus(`Could not load predictions. ${e.message}`, { error: true, retry: loadPredictions });
    }
  }

  function setHour(h) {
    state.hour = Math.max(0, Math.min(23, h));
    $("hour-slider").value = state.hour;
    $("hour-select").value = state.hour;
    $("hour-label").textContent = hourRange(state.hour);
    renderMarkers();
    if (state.selected != null) updatePanelHour();
  }

  // ---------- side panel ----------
  async function selectSite(id, { pan = false } = {}) {
    state.selected = id;
    const site = state.byId.get(id);
    if (pan && site) map.flyTo([site.latitude, site.longitude], Math.max(map.getZoom(), 11), { duration: 0.6 });
    renderMarkers();
    $("panel").hidden = false;
    await renderPanel();
  }

  function closePanel() {
    state.selected = null;
    $("panel").hidden = true;
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    renderMarkers();
  }

  async function getDetail(id) {
    const key = `${id}|${state.date}`;
    if (!state.detailCache.has(key)) state.detailCache.set(key, await api(`/api/sites/${id}?date=${state.date}`));
    return state.detailCache.get(key);
  }

  function chip(kind, label, value) {
    return `<span class="chip ${esc(String(value).toLowerCase())}" title="${esc(kind)}"><span class="dot"></span>${esc(label)}: <b>${esc(value)}</b></span>`;
  }

  async function renderPanel() {
    const id = state.selected;
    const body = $("panel-body");
    const site = state.byId.get(id);
    body.innerHTML = `<h2>${esc(site.name)}</h2><p class="sub">${esc([site.road, site.direction].filter(Boolean).join(" · "))}</p>
      <div class="skeleton" style="width:60%;margin-top:18px"></div><div class="skeleton"></div><div class="skeleton" style="width:80%"></div>`;
    let d;
    try { d = await getDetail(id); } catch (e) {
      if (state.selected !== id) return;
      body.innerHTML = `<h2>${esc(site.name)}</h2><div class="nodata-box"><strong>Could not load this site</strong>${esc(e.message)}</div>
        <p style="margin-top:12px"><button class="btn" id="retry-panel" type="button">Try again</button></p>`;
      $("retry-panel").onclick = renderPanel;
      return;
    }
    if (state.selected !== id) return;
    const s = d.site, p = d.prediction, q = s.data_quality || {};
    const where = [s.road || "Road not stated", s.direction || "Direction not stated"].join(" · ");
    const head = `<h2>${esc(s.name)}</h2><p class="sub">${esc(where)} · ${esc(s.site_type || "WebTRIS")} site ${s.site_id}</p>`;
    const demo = state.meta.is_demo ? '<p class="note"><b>Demo data.</b> Synthetic values, not WebTRIS observations.</p>' : "";

    if (p.status !== "ok") {
      body.innerHTML = `${head}${demo}
        <div class="nodata-box"><strong>No prediction for this site</strong>${esc(p.reason || "Not enough data.")}</div>
        <section><h3>Data</h3><dl class="kv">
          <dt>Data quality</dt><dd>${esc(q.label || "No data")}</dd>
          <dt>Complete hours, last 12 months of data</dt><dd>${q.complete_hours_pct_last_12_months ?? 0}%</dd>
          <dt>Latest data in the dataset</dt><dd>${fmtDate(d.latest_data_day)}</dd></dl></section>
        <p class="note">A number is only shown when there is enough reliable history behind it.</p>`;
      if (state.chart) { state.chart.destroy(); state.chart = null; }
      return;
    }

    const used = d.history_used, v = d.validation || {};
    const mae = p.method === "gbm" ? v.gbm_mae : v.baseline_mae;
    const wape = p.method === "gbm" ? v.gbm_wape_pct : v.baseline_wape_pct;
    const peak = (x) => (x ? `${hourRange(x.hour)} · ${nf.format(x.volume)}` : "n/a");
    const recent = d.recent_similar_days.map((r) => fmtDate(r.date, { day: "numeric", month: "short", year: "numeric" })).join(", ");
    body.innerHTML = `${head}${demo}
      <div class="headline">
        <div class="when" id="p-when"></div>
        <div class="value"><span id="p-value"></span> <small>vehicles/hour</small></div>
        <div class="range" id="p-range"></div>
      </div>
      <div class="chips" id="p-chips"></div>
      <p class="note" id="p-rel-note"></p>

      <section>
        <h3>Predicted traffic through the day</h3>
        <div class="chart-box"><canvas id="day-chart" role="img" aria-label="Predicted hourly traffic volume across the selected day with indicative range and recent observed days"></canvas></div>
        <p class="note" id="p-compare"></p>
        <details><summary>Hourly table</summary><div id="p-table"></div></details>
      </section>

      <section>
        <h3>Typical peaks on this day</h3>
        <dl class="kv">
          <dt>Morning peak hour</dt><dd>${peak(d.peaks.am)}</dd>
          <dt>Evening peak hour</dt><dd>${peak(d.peaks.pm)}</dd>
          <dt>Predicted daily total</dt><dd>${d.daily_total != null ? nf.format(d.daily_total) + " vehicles" : "n/a"}</dd>
        </dl>
      </section>

      <section>
        <h3>Data behind this prediction</h3>
        <dl class="kv">
          <dt>Method</dt><dd>${esc(p.method_label)}</dd>
          <dt>History used</dt><dd>${fmtDate(used.first_day, { day: "numeric", month: "short", year: "numeric" })} – ${fmtDate(used.last_day, { day: "numeric", month: "short", year: "numeric" })}</dd>
          <dt>Latest observation at this site</dt><dd>${fmtDate(used.last_day)}</dd>
          <dt>Complete hours, last 12 months of data</dt><dd>${q.complete_hours_pct_last_12_months}%</dd>
          <dt>Recent days shown in the chart</dt><dd>${esc(recent || "none")}</dd>
          ${mae != null ? `<dt>Typical error on held-out data</dt><dd>${nf.format(Math.round(mae))} veh/h (${wape}%)</dd>` : ""}
        </dl>
        <p class="note">Estimate from historical patterns up to ${fmtDate(d.latest_data_day)}. It shows vehicle volume, not congestion or journey times, and cannot foresee incidents, roadworks or events.</p>
      </section>

      <section class="actions">
        <a class="btn primary" href="/api/sites/${s.site_id}/prediction.csv?date=${state.date}" download>Download CSV</a>
        <button class="btn" type="button" id="zoom-site">Zoom to site</button>
      </section>`;
    $("zoom-site").onclick = () => map.flyTo([s.latitude, s.longitude], 14, { duration: 0.6 });
    if (STATIC) {
      const a = body.querySelector(".actions a");
      a.href = URL.createObjectURL(new Blob([csvFor(d)], { type: "text/csv" }));
      a.download = `prediction_${s.name.replace("/", "-")}_${state.date}.csv`;
    }
    drawChart(d);
    updatePanelHour();
  }

  function updatePanelHour() {
    const id = state.selected;
    const d = state.detailCache.get(`${id}|${state.date}`);
    if (!d || d.prediction.status !== "ok" || !$("p-value")) return;
    const h = d.prediction.hours[state.hour], q = d.site.data_quality || {};
    $("p-when").textContent = `${fmtDate(state.date)}, ${hourRange(state.hour)}`;
    if (h.volume == null) {
      $("p-value").textContent = "No estimate";
      $("p-range").textContent = "Not enough comparable hours for this time.";
      $("p-chips").innerHTML = chip("Data quality", "Data quality", q.label);
      $("p-rel-note").textContent = "";
    } else {
      $("p-value").textContent = nf.format(h.volume);
      $("p-range").textContent = h.low != null ? `Indicative range ${nf.format(h.low)} – ${nf.format(h.high)} (estimate)` : "No range available";
      $("p-chips").innerHTML = chip("Prediction reliability", "Reliability", h.reliability) + chip("Data quality", "Data quality", q.label);
      const basis = h.level ? ` Based on ${h.n} comparable past hours (${state.meta.level_labels[h.level]}).` : "";
      $("p-rel-note").textContent = `${h.reliability_note}${basis}`;
      const hist = d.historical_median.hours[state.hour];
      if (hist != null && hist > 0) {
        const diff = Math.round((100 * (h.volume - hist)) / hist);
        const rel = diff === 0 ? "in line with" : `${Math.abs(diff)}% ${diff > 0 ? "above" : "below"}`;
        $("p-compare").textContent = `At ${hourRange(state.hour)} the prediction is ${rel} the historical median for similar days (${nf.format(hist)} vehicles/hour). Grey lines are the most recent similar days as counted.`;
      } else {
        $("p-compare").textContent = "Grey lines are the most recent similar days as counted.";
      }
    }
    const rows = d.prediction.hours.map((r) => `<tr class="${r.hour === state.hour ? "current" : ""}"><td>${hourRange(r.hour)}</td><td>${r.volume == null ? "–" : nf.format(r.volume)}</td><td>${r.low == null ? "–" : nf.format(r.low) + " – " + nf.format(r.high)}</td><td>${d.historical_median.hours[r.hour] == null ? "–" : nf.format(d.historical_median.hours[r.hour])}</td></tr>`).join("");
    $("p-table").innerHTML = `<table class="hours"><thead><tr><th>Hour</th><th>Predicted</th><th>Indicative range</th><th>Historical median</th></tr></thead><tbody>${rows}</tbody></table>`;
    if (state.chart) state.chart.update("none");
  }

  // Vertical guide at the selected hour
  const hourGuide = {
    id: "hourGuide",
    afterDatasetsDraw(chart) {
      const x = chart.scales.x.getPixelForValue(state.hour);
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = "#14181d"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.restore();
    },
  };

  function drawChart(d) {
    if (state.chart) state.chart.destroy();
    const hrs = d.prediction.hours;
    const labels = hrs.map((h) => String(h.hour).padStart(2, "0"));
    const recent = d.recent_similar_days.map((r, i) => ({
      label: i === 0 ? "Recent similar days (observed)" : "_recent" + i,
      data: r.hours, borderColor: "#b4bcc7", borderWidth: 1, pointRadius: 0, tension: 0.3, spanGaps: false, order: 5,
    }));
    const datasets = [
      { label: "_low", data: hrs.map((h) => h.low), borderWidth: 0, pointRadius: 0, fill: false, tension: 0.3, order: 4 },
      { label: "Indicative range (estimate)", data: hrs.map((h) => h.high), borderWidth: 0, pointRadius: 0, backgroundColor: "rgba(42,120,214,.16)", fill: "-1", tension: 0.3, order: 4 },
      ...recent,
      { label: "Historical median, similar days", data: d.historical_median.hours, borderColor: "#4a5360", borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, tension: 0.3, order: 2 },
      { label: "Predicted", data: hrs.map((h) => h.volume), borderColor: "#2a78d6", backgroundColor: "#2a78d6", borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 5, tension: 0.3, order: 1 },
    ];
    state.chart = new Chart($("day-chart"), {
      type: "line",
      data: { labels, datasets },
      plugins: [hourGuide],
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        onClick: (evt, _els, chart) => {
          const pts = chart.getElementsAtEventForMode(evt, "index", { intersect: false }, true);
          if (pts.length) setHour(pts[0].index);
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 8, color: "#7a8494" }, title: { display: true, text: "Hour beginning", color: "#7a8494", font: { size: 11 } } },
          y: { beginAtZero: true, grid: { color: "#eef0f3" }, border: { display: false }, ticks: { color: "#7a8494", callback: (v) => nf.format(v) }, title: { display: true, text: "Vehicles per hour", color: "#7a8494", font: { size: 11 } } },
        },
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 18, boxHeight: 2, font: { size: 11 }, color: "#4a5360", filter: (item) => !item.text.startsWith("_") } },
          tooltip: {
            filter: (item) => !item.dataset.label.startsWith("_") && !item.dataset.label.startsWith("Recent") && !item.dataset.label.startsWith("Indicative"),
            callbacks: {
              title: (items) => (items.length ? hourRange(items[0].dataIndex) : ""),
              label: (item) => `${item.dataset.label}: ${item.parsed.y == null ? "n/a" : nf.format(item.parsed.y)}`,
              afterBody: (items) => {
                if (!items.length) return "";
                const h = hrs[items[0].dataIndex];
                return h.low != null ? `Indicative range: ${nf.format(h.low)} – ${nf.format(h.high)}` : "";
              },
            },
          },
        },
      },
    });
  }

  // ---------- search ----------
  let searchTimer = null, searchSeq = 0;
  function renderResults(items) {
    const ul = $("search-results");
    if (!items.length) { ul.hidden = true; ul.innerHTML = ""; return; }
    ul.innerHTML = items.map((it, i) => it.empty
      ? `<li class="empty">${esc(it.title)}</li>`
      : `<li role="option" data-i="${i}"><span class="kind">${esc(it.kind)}</span><span>${esc(it.title)}${it.sub ? ` <span class="sub">${esc(it.sub)}</span>` : ""}</span></li>`).join("");
    ul.hidden = false;
    ul.querySelectorAll("li[data-i]").forEach((li) => { li.onclick = () => { items[+li.dataset.i].go(); ul.hidden = true; }; });
    renderResults.items = items;
  }

  function localMatches(q) {
    const out = [];
    const ql = q.toLowerCase();
    for (const road of state.roads) {
      if (road.toLowerCase().startsWith(ql)) {
        out.push({ kind: "Road", title: road, sub: `${state.sites.filter((s) => s.road === road).length} sites`, go: () => { state.road = road; $("road-filter").value = road; renderMarkers(); fitToVisible(); } });
      }
    }
    for (const s of state.sites) {
      const hay = `${s.name} ${s.site_id} ${s.road || ""} ${s.direction || ""} ${s.description || ""}`.toLowerCase();
      if (hay.includes(ql)) out.push({ kind: "Site", title: s.name, sub: [s.road, s.direction].filter(Boolean).join(" · "), go: () => selectSite(s.site_id, { pan: true }) });
      if (out.length >= 8) break;
    }
    return out;
  }

  function onSearchInput() {
    const q = $("search").value.trim();
    clearTimeout(searchTimer);
    if (q.length < 2) { renderResults([]); return; }
    const local = localMatches(q);
    renderResults(local.length ? local : [{ empty: true, title: "Searching places…" }]);
    if (q.length < 3) return;
    const seq = ++searchSeq;
    searchTimer = setTimeout(async () => {
      let places = [];
      try {
        const r = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
        places = r.results.map((p) => ({ kind: "Place", title: p.name.split(",").slice(0, 2).join(","), sub: p.name.split(",").slice(2, 4).join(","), go: () => goToPlace(p) }));
      } catch (_) {
        if (seq === searchSeq && !local.length) renderResults([{ empty: true, title: "Place search is unavailable. Try a road or site name." }]);
        return;
      }
      if (seq !== searchSeq) return;
      const all = [...local, ...places];
      renderResults(all.length ? all : [{ empty: true, title: "No matching road, site or place" }]);
    }, 500);
  }

  function goToPlace(p) {
    if (state.placeMarker) map.removeLayer(state.placeMarker);
    state.placeMarker = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: "", html: '<div class="place-dot"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }), interactive: false }).addTo(map);
    map.flyTo([p.lat, p.lon], 12, { duration: 0.7 });
  }

  // ---------- about dialog ----------
  async function openAbout() {
    const dlg = $("about");
    $("about-body").innerHTML = '<h2>About the predictions</h2><div class="skeleton"></div><div class="skeleton" style="width:70%"></div>';
    dlg.showModal();
    let v;
    try { v = await api("/api/validation"); } catch (e) { $("about-body").innerHTML = `<h2>About the predictions</h2><p>${esc(e.message)}</p>`; return; }
    const fresh = v.experiments.fresh, stale = v.experiments.stale_3_months, o = fresh.overall, so = stale.overall;
    const rows = Object.entries(fresh.sites).map(([id, m]) => {
      if (!m.n_hours) return `<tr><td>${esc(m.name)}</td><td colspan="5" style="text-align:left">Not enough data to predict</td></tr>`;
      const used = (v.chosen_method[id] || m.better) === "gbm" ? "Gradient boosting" : "Baseline";
      return `<tr><td>${esc(m.name)}</td><td>${nf.format(Math.round(m.mean_volume))}</td><td>${nf.format(Math.round(m.baseline_mae))}</td><td>${nf.format(Math.round(m.gbm_mae))}</td><td>${m.gbm_wape_pct < m.baseline_wape_pct ? m.gbm_wape_pct : m.baseline_wape_pct}%</td><td>${used}</td></tr>`;
    }).join("");
    const m = state.meta;
    const fd = (iso) => fmtDate(iso, { day: "numeric", month: "short", year: "numeric" });
    $("about-body").innerHTML = `
      <h2>About the predictions</h2>
      <p>${esc(m.notice)}</p>
      <h3>What you are looking at</h3>
      <ul>
        <li>Each marker is a National Highways traffic counting site. The number is the predicted count of vehicles passing in the selected hour, in one direction.</li>
        <li>Colours show volume only. A high volume can flow freely and a low volume can be queuing, so this is not a congestion or journey-time map.</li>
        <li>The latest WebTRIS record in this app is <b>${fd(v.latest_data_day)}</b> (${m.data_age_days} days ago). WebTRIS updates are paused, so every prediction is built from patterns up to that date.</li>
      </ul>
      <h3>How a prediction is made</h3>
      <ul>
        <li><b>Baseline:</b> the median volume at the same site for comparable past days (same day of week or bank holiday, same hour, same time of year where there is enough data).</li>
        <li><b>Gradient boosting:</b> a machine-learning model on calendar features (hour, day of week, month, bank holidays), trained across all sites.</li>
        <li>${esc(v.selection_rule)}</li>
        <li>15-minute counts are added into hours only when all four records are present. Missing records are never treated as zero.</li>
      </ul>
      <h3>How accurate it was on unseen data</h3>
      <p>Both methods were trained on data up to ${fd(fresh.train_end)} and tested on ${fd(v.test_period[0])} to ${fd(v.test_period[1])} (${nf.format(o.n_hours)} site-hours neither had seen).</p>
      <div class="stat-row">
        <div class="stat"><b>${nf.format(Math.round(o.baseline_mae))}</b><span>Baseline mean absolute error, vehicles/hour (${o.baseline_wape_pct}% of average volume)</span></div>
        <div class="stat"><b>${nf.format(Math.round(o.gbm_mae))}</b><span>Gradient boosting mean absolute error, vehicles/hour (${o.gbm_wape_pct}%)</span></div>
        <div class="stat"><b>${v.baseline_range_coverage_pct}%</b><span>of observed hours fell inside the baseline's indicative range</span></div>
      </div>
      <p style="margin-top:10px">Staleness check: with the training data cut off three months earlier (${fd(stale.train_end)}), the errors on the same test period were ${nf.format(Math.round(so.baseline_mae))} (baseline) and ${nf.format(Math.round(so.gbm_mae))} (gradient boosting) vehicles/hour, against ${nf.format(Math.round(stale.fresh_same_sites.baseline_mae))} and ${nf.format(Math.round(stale.fresh_same_sites.gbm_mae))} for the same sites with fresh data.</p>
      <table><thead><tr><th>Site</th><th>Average volume</th><th>Baseline MAE</th><th>Boosting MAE</th><th>Best error</th><th>Method in use</th></tr></thead><tbody>${rows}</tbody></table>
      <h3>Limitations</h3>
      <ul>
        <li>The history ends on ${fd(v.latest_data_day)}. Changes since then (new road layouts, long-term roadworks, shifts in demand) are not reflected.</li>
        <li>Incidents, closures, weather and one-off events cannot be predicted from calendar patterns. They are the main reason an hour falls outside the indicative range.</li>
        <li>Counter faults leave gaps. Sites with little or old data are marked "not enough data" instead of being given a number.</li>
        <li>The indicative range is an estimate from past variation, not a guarantee.</li>
      </ul>
      <p style="margin-top:12px;font-size:12px">${esc(m.data_attribution)}. Model version ${esc(v.model_version)}.</p>`;
  }

  // ---------- start-up ----------
  async function init() {
    showStatus("Loading…", { sticky: true });
    try {
      const [meta, sites] = await Promise.all([api("/api/meta"), api("/api/sites")]);
      state.meta = meta; state.sites = sites.sites; state.roads = sites.roads;
      state.sites.forEach((s) => state.byId.set(s.site_id, s));
      L.tileLayer(meta.tiles.url, { attribution: `${meta.tiles.attribution} | ${meta.data_attribution}`, maxZoom: 19 }).addTo(map);

      $("demo-banner").hidden = !meta.is_demo;
      $("data-note").innerHTML = meta.is_demo
        ? "<strong>Demo data</strong> · synthetic values, not WebTRIS observations"
        : `Based on historical WebTRIS counts up to <strong>${fmtDate(meta.latest_data_day, { day: "numeric", month: "long", year: "numeric" })}</strong> · estimates from past patterns, not live traffic · ${meta.sites_predictable} of ${meta.sites_total} pilot sites have enough data`;

      const dateEl = $("date");
      dateEl.min = meta.min_date; dateEl.max = meta.max_date;
      const tomorrow = new Date(meta.min_date + "T12:00:00"); tomorrow.setDate(tomorrow.getDate() + 1);
      state.date = tomorrow.toISOString().slice(0, 10);
      if (state.date > meta.max_date) state.date = meta.max_date;
      dateEl.value = state.date;
      dateEl.onchange = () => {
        if (!dateEl.value || dateEl.value < meta.min_date || dateEl.value > meta.max_date) {
          showStatus(`Choose a date between ${fmtDate(meta.min_date)} and ${fmtDate(meta.max_date)}.`, { error: true });
          dateEl.value = state.date;
          return;
        }
        state.date = dateEl.value;
        loadPredictions();
      };

      $("hour-select").innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${hourRange(h)}</option>`).join("");
      $("hour-select").onchange = (e) => setHour(+e.target.value);
      $("hour-slider").oninput = (e) => setHour(+e.target.value);
      $("hour-prev").onclick = () => setHour((state.hour + 23) % 24);
      $("hour-next").onclick = () => setHour((state.hour + 1) % 24);

      $("road-filter").innerHTML += sites.roads.map((r) => `<option>${esc(r)}</option>`).join("");
      $("direction-filter").innerHTML += sites.directions.map((r) => `<option>${esc(r)}</option>`).join("");
      $("road-filter").onchange = (e) => { state.road = e.target.value; renderMarkers(); fitToVisible(); };
      $("direction-filter").onchange = (e) => { state.direction = e.target.value; renderMarkers(); };

      $("search").oninput = onSearchInput;
      $("search").onkeydown = (e) => {
        if (e.key === "Enter" && renderResults.items && renderResults.items[0] && renderResults.items[0].go) { renderResults.items[0].go(); $("search-results").hidden = true; }
        if (e.key === "Escape") $("search-results").hidden = true;
      };
      document.addEventListener("click", (e) => { if (!e.target.closest(".controls")) $("search-results").hidden = true; });

      $("panel-close").onclick = closePanel;
      $("about-btn").onclick = openAbout;
      map.on("click", () => { $("search-results").hidden = true; });

      renderLegend();
      setHour(8);
      renderMarkers();
      fitToVisible();           // start on the pilot area; zoom out to see the rest of England
      await loadPredictions();
    } catch (e) {
      showStatus(`The app could not start. ${e.message}`, { error: true, retry: init });
    }
  }

  init();
})();
