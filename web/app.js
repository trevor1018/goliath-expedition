'use strict';

// ---------------------------------------------------------------------------
// 常數與標籤
// ---------------------------------------------------------------------------
const CAT = {
  walk: '步行', swim: '游泳', ice: '海冰上移動', deadend: '廢棄路段（不算進度）',
  sidewalk: '支線步行（不算進度）', offroute: '離開路線（不算進度）',
};
const MODE = { walk: '步行', swim: '游泳', ice: '海冰', offroute: '交通工具／離線', other: '其他（漂流、救援）' };
const BASIS = {
  gps_track: 'GPS 軌跡', named_road: '具名道路（地圖以直線示意）',
  waypoints_only: '僅知經過點（直線示意）', unknown: '路徑未知',
};
const COORD = { exact_reported: '本人回報座標', town_centroid: '城鎮中心', approximate_region: '約略區域', unknown: '未知', rejected: '日誌座標不合理，未採用' };
const ROAD_FAIL = {
  no_route: '路網找不到路（如冬季河道、凍原、叢林）', snap_far: '地點離道路太遠', detour: '道路繞行過遠，不太可能是實際路線',
  ferry: '道路路線需搭渡輪', short: '距離太短',
};
const PREC = { day: '日', month: '月', season: '季', year: '年', unknown: '未知' };
const COLORS = { walk: '#f2a541', swim: '#3fa9f5', ice: '#cfefff', deadend: '#d9534f', sidewalk: '#b48ead', offroute: '#7d8590' };
const LINE_LAYERS = ['walk', 'walk-unc', 'swim', 'ice', 'deadend', 'sidewalk', 'offroute'];
const TOGGLE_LAYERS = {
  walk: ['walk'], swim: ['swim'], ice: ['ice'], unknown: ['corridor', 'walk-unc'],
  deadend: ['deadend'], sidewalk: ['sidewalk'], offroute: ['offroute'],
  pauses: ['pauses'], waypoints: ['waypoints'],
};

let D, map, T, Tmin, Tmax, walker, playing = false, lastFrame = 0, followCam = true;
let featById = {}, chainFeatStart = {}, marks = [], tlBase = null;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------------------
// 日期（與 tools/build_web.py 的 parse_day 規則一致）
// ---------------------------------------------------------------------------
function parseDay(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!m) return null;
  const y = +m[1], mo = m[2] ? +m[2] : 7, d = m[3] ? +m[3] : (m[2] ? 15 : 1);
  return Date.UTC(y, mo - 1, d) / 86400000;
}
function fmtDay(t) {
  const d = new Date(Math.round(t) * 86400000);
  return d.toISOString().slice(0, 10);
}
function wpDate(w) {
  if (!w) return '—';
  const a = w.date_earliest, b = w.date_latest;
  let s = (a && b && a !== b) ? `${a} ～ ${b}` : (w.date || a || b || '未知');
  if (w.date_precision && w.date_precision !== 'day') s += `（精確到${PREC[w.date_precision] || w.date_precision}）`;
  return s;
}
function wpTime(w) {
  const a = parseDay(w.date_earliest), b = parseDay(w.date_latest);
  if (a != null && b != null) return (a + b) / 2;
  return parseDay(w.date) ?? a ?? b;
}
const normLon = (lon) => ((lon + 540) % 360) - 180;

// 問題回報的去處：github 填「帳號/儲存庫」會開 GitHub Issue，email 填信箱會開郵件程式；都沒填只提供複製內容
const REPORT = { github: 'trevor1018/goliath-expedition', email: '' };

// 讓比例尺（最寬 100 px）在緯度 lat 處顯示 km 公里所需的縮放等級（100 px ≈ 1.15 × km，避免跳到下一級距）
const zoomForKm = (km, lat) => Math.log2(40075016.686 / 512 * Math.cos(lat * Math.PI / 180) / (km * 11.5));
// 全覽視野：比例尺顯示 1000 km；手機（直向或橫向）畫面小，用 2000 km 才看得到整顆地球
const overviewKm = () => (window.matchMedia('(max-width: 720px), (max-height: 500px) and (orientation: landscape)').matches ? 2000 : 1000);
const overview = () => ({ center: [-40, 15], zoom: zoomForKm(overviewKm(), 15) });
// 播放跟隨鏡頭時鎖定的比例尺（km）；使用者自行縮放後解除（null）
let scaleKm = 200;

// 比例尺：內建 ScaleControl 只用 1/2/3/5 級距，這裡加入 7.5（才會出現 750 km）
class NiceScale {
  onAdd(m) {
    this.m = m;
    this.wrap = document.createElement('div');
    this.wrap.className = 'maplibregl-ctrl scale-wrap';
    this.el = document.createElement('div');
    this.el.className = 'maplibregl-ctrl-scale';
    this.btn = document.createElement('button');
    this.btn.className = 'scale-btn';
    this.btn.type = 'button';
    this.wrap.append(this.el, this.btn);
    // 在 200 km 與全覽比例尺（桌機 1000 km、手機 2000 km）之間切換
    this.btn.onclick = () => setScaleKm(this.nice <= 300000 ? overviewKm() : 200);
    this.update = () => {
      const y = m.getContainer().clientHeight / 2, x = m.getContainer().clientWidth / 2;
      const a = m.unproject([x - 50, y]), b = m.unproject([x + 50, y]);
      const full = a.distanceTo(b);
      const exp = Math.pow(10, Math.floor(Math.log10(full)));
      const nice = [7.5, 5, 3, 2, 1].map((k) => k * exp).find((v) => v <= full);
      this.el.style.width = `${Math.round(100 * nice / full)}px`;
      this.el.textContent = nice >= 1000 ? `${(nice / 1000).toLocaleString()} km` : `${Math.round(nice)} m`;
      this.nice = nice;
      const far = overviewKm().toLocaleString();
      this.btn.textContent = nice <= 300000 ? `－ ${far} km` : '＋ 200 km';
      this.btn.title = nice <= 300000 ? `縮小到比例尺 ${far} km` : '放大到比例尺 200 km';
    };
    m.on('move', this.update);
    m.on('load', this.update);
    return this.wrap;
  }
  onRemove() { this.m.off('move', this.update); this.wrap.remove(); }
}

// ---------------------------------------------------------------------------
// 啟動
// ---------------------------------------------------------------------------
// 載入畫面：依序是地圖程式（HTML 已載入）→ 路線資料 → 底圖；底圖太慢時讓使用者自行先進入
const loading = {
  msg(t) { $('#ld-msg').textContent = t; },
  extra(html) { $('#ld-extra').innerHTML = html; },
  done() {
    const el = $('#loading');
    if (!el || el.classList.contains('done')) return;
    clearTimeout(loading.slowTimer);
    el.classList.add('done');
    setTimeout(() => el.remove(), 600);
  },
  fail(what, e) {
    $('#loading').classList.add('failed');
    loading.msg(`${what}載入失敗${e ? `：${e.message || e}` : ''}`);
    loading.extra('網路可能不穩，請重新整理再試一次。<br><button type="button" onclick="location.reload()">重新整理</button>');
  },
};

async function loadData() {
  const r = await fetch('data/expedition.json');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (!r.body || !r.body.getReader) return r.json();
  // 逐段讀取以顯示已下載量（GitHub Pages 會壓縮傳輸，總量未知，只顯示解壓後的 MB 數）
  const reader = r.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    loading.msg(`下載路線資料… ${(got / 1048576).toFixed(1)} MB`);
  }
  const buf = new Uint8Array(got);
  let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.length; }
  return JSON.parse(new TextDecoder().decode(buf));
}

if (typeof maplibregl === 'undefined') loading.fail('地圖程式');
else {
  loading.msg('下載路線資料…');
  loadData().then((data) => {
    loading.msg('繪製地圖…');
    init(data);
  }).catch((e) => {
    console.error(e);
    if (D) loading.fail('網站', e);
    else loading.fail('路線資料', location.protocol === 'file:' ? '請用本機伺服器開啟（在 web/ 目錄執行 python -m http.server）' : e);
  });
}

function init(data) {
  D = data;
  for (const f of D.features.features) featById[f.properties.fid] = f;
  D.chain.forEach((c, i) => { if (chainFeatStart[c[4]] == null) chainFeatStart[c[4]] = i; });
  Tmin = D.chain[0][2] - 20;
  Tmax = D.chain[D.chain.length - 1][2] + 20;
  T = Tmax;

  map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/dark',
    ...overview(), maxPitch: 0,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new NiceScale(), 'bottom-left');
  map.on('style.load', () => map.setProjection({ type: 'globe' }));
  // 使用者自行縮放（滾輪、雙指、雙擊、縮放按鈕）就解除比例尺鎖定
  const freeScale = () => { scaleKm = null; };
  const cc = map.getCanvasContainer();
  cc.addEventListener('wheel', freeScale, { passive: true });
  cc.addEventListener('dblclick', freeScale);
  cc.addEventListener('touchstart', (e) => { if (e.touches.length > 1) freeScale(); }, { passive: true });
  map.getContainer().addEventListener('click', (e) => { if (e.target.closest('.maplibregl-ctrl-zoom-in, .maplibregl-ctrl-zoom-out')) freeScale(); });
  map.on('load', setupLayers);
  map.on('load', loading.done);
  // 底圖伺服器很慢時，15 秒後提供「先進入」，避免一直卡在載入畫面
  loading.slowTimer = setTimeout(() => {
    loading.msg('底圖下載較慢，仍在載入…');
    loading.extra('<button type="button" id="ld-skip">先進入網站</button>');
    $('#ld-skip').onclick = loading.done;
  }, 15000);
  const foldAttrib = () => document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  map.on('load', foldAttrib);
  map.on('resize', foldAttrib);

  setupUI();
  buildResearchPage();
  buildAboutPage();
  buildStory();
}

// ---------------------------------------------------------------------------
// 地圖圖層
// ---------------------------------------------------------------------------
function timeFilter() {
  // 已知路徑的進度線走完才顯示；未知路段與非進度線一開始就整段顯示
  return ['<=', ['case', ['all', ['==', ['get', 'progress'], true], ['!=', ['get', 'uncertain'], true]], ['get', 't1'], ['get', 't0']], T];
}
const CAT_FILTER = {
  corridor: ['all', ['==', ['get', 'uncertain'], true], ['!=', ['get', 'cat'], 'offroute']],
  walk: ['all', ['==', ['get', 'cat'], 'walk'], ['!=', ['get', 'uncertain'], true]],
  'walk-unc': ['all', ['==', ['get', 'cat'], 'walk'], ['==', ['get', 'uncertain'], true]],
  swim: ['==', ['get', 'cat'], 'swim'],
  ice: ['==', ['get', 'cat'], 'ice'],
  deadend: ['==', ['get', 'cat'], 'deadend'],
  sidewalk: ['==', ['get', 'cat'], 'sidewalk'],
  offroute: ['==', ['get', 'cat'], 'offroute'],
};
const PROGRESS_LAYERS = ['corridor', ...LINE_LAYERS];

function setupLayers() {
  map.addSource('route', { type: 'geojson', data: D.features });
  map.addSource('current', { type: 'geojson', data: emptyLine('walk') });

  const wpFeatures = Object.values(D.waypoints).filter((w) => w.lat != null).map((w) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [w.lon, w.lat] },
    properties: { id: w.id, t: wpTime(w) ?? -1e9, basis: w.coord_basis },
  }));
  map.addSource('waypoints', { type: 'geojson', data: { type: 'FeatureCollection', features: wpFeatures } });

  const pFeatures = D.pauses.map((p, i) => ({ p, i })).filter(({ p }) => p.lon != null).map(({ p, i }) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: { idx: i, t0: p.t0, t1: p.t1, days: Math.max(0, p.t1 - p.t0) },
  }));
  map.addSource('pauses', { type: 'geojson', data: { type: 'FeatureCollection', features: pFeatures } });

  const zw = (a, b) => ['interpolate', ['linear'], ['zoom'], 1, a, 8, b];
  map.addLayer({
    id: 'corridor', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['match', ['get', 'cat'], 'deadend', '#d9534f', 'swim', '#3fa9f5', '#8e98a5'],
      'line-width': zw(10, 60), 'line-blur': zw(8, 40), 'line-opacity': 0.32,
    },
  });
  map.addLayer({
    id: 'offroute', type: 'line', source: 'route', layout: { visibility: 'none' },
    paint: { 'line-color': COLORS.offroute, 'line-width': 1.2, 'line-dasharray': [3, 3], 'line-opacity': 0.8 },
  });
  map.addLayer({
    id: 'sidewalk', type: 'line', source: 'route', layout: { 'line-cap': 'round' },
    paint: { 'line-color': COLORS.sidewalk, 'line-width': zw(1.5, 3), 'line-dasharray': [0.5, 2] },
  });
  map.addLayer({
    id: 'deadend', type: 'line', source: 'route',
    paint: { 'line-color': COLORS.deadend, 'line-width': zw(2, 4), 'line-dasharray': [3, 2] },
  });
  map.addLayer({
    id: 'walk-unc', type: 'line', source: 'route', layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#c9d1da', 'line-width': zw(1.2, 2.5), 'line-dasharray': [0.3, 2.2], 'line-opacity': 0.8 },
  });
  map.addLayer({
    id: 'walk', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': COLORS.walk, 'line-width': zw(2, 4) },
  });
  map.addLayer({
    id: 'swim', type: 'line', source: 'route',
    paint: { 'line-color': COLORS.swim, 'line-width': zw(2.5, 5), 'line-dasharray': [2, 1.5] },
  });
  map.addLayer({
    id: 'ice', type: 'line', source: 'route', layout: { 'line-cap': 'round' },
    paint: { 'line-color': COLORS.ice, 'line-width': zw(2.5, 5), 'line-dasharray': [0.2, 1.6] },
  });
  map.addLayer({
    id: 'current', type: 'line', source: 'current', layout: { 'line-cap': 'round' },
    paint: {
      'line-color': ['match', ['get', 'cat'], 'swim', COLORS.swim, 'ice', COLORS.ice, COLORS.walk],
      'line-width': zw(2.5, 4.5),
    },
  });
  map.addLayer({
    id: 'highlight', type: 'line', source: 'route', filter: ['==', ['get', 'fid'], -1],
    paint: { 'line-color': '#ffffff', 'line-width': zw(5, 9), 'line-opacity': 0.35 },
  }, 'corridor');
  map.addLayer({
    id: 'pauses', type: 'circle', source: 'pauses',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['sqrt', ['get', 'days']], 0, 2.5, 10, 6, 40, 20],
      'circle-color': 'rgba(255,255,255,0.08)',
      'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.2, 'circle-stroke-opacity': 0.7,
    },
  });
  map.addLayer({
    id: 'waypoints', type: 'circle', source: 'waypoints', minzoom: 4,
    paint: {
      'circle-radius': 3,
      'circle-color': ['match', ['get', 'basis'], 'exact_reported', '#ffffff', 'town_centroid', '#cfd5dc', 'rgba(0,0,0,0)'],
      'circle-stroke-color': '#cfd5dc', 'circle-stroke-width': 1,
    },
  });

  // 未知與可能缺口的「?」標記
  for (const f of D.features.features) {
    const p = f.properties, c = f.geometry.coordinates;
    if (p.possible_gap) addMark(c[c.length - 1], p.fid, true);
    else if (p.uncertain && p.cat !== 'offroute' && (p.gap || p.km > 200)) {
      const mid = c.length > 2 ? c[Math.floor(c.length / 2)] : [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
      addMark(mid, p.fid, false);
    }
  }

  const el = document.createElement('div');
  el.className = 'walker';
  walker = new maplibregl.Marker({ element: el }).setLngLat([D.chain[0][0], D.chain[0][1]]).addTo(map);

  // 點擊與滑過
  const clickable = ['waypoints', 'pauses', ...LINE_LAYERS, 'corridor'];
  map.on('click', (e) => {
    if (isMobile() && !$('#legend-body').classList.contains('hidden')) {
      $('#legend-body').classList.add('hidden'); $('#legend-toggle').textContent = '+';
    }
    const r = isTouch() ? 14 : 7;
    const box = [[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]];
    const hits = map.queryRenderedFeatures(box, { layers: clickable.filter((l) => map.getLayer(l)) });
    if (!hits.length) return;
    hits.sort((a, b) => clickable.indexOf(a.layer.id) - clickable.indexOf(b.layer.id));
    const h = hits[0];
    if (h.layer.id === 'waypoints') showWaypoint(h.properties.id);
    else if (h.layer.id === 'pauses') showPause(h.properties.idx);
    else showFeature(h.properties.fid);
  });
  map.on('mousemove', (e) => {
    const box = [[e.point.x - 7, e.point.y - 7], [e.point.x + 7, e.point.y + 7]];
    const n = map.queryRenderedFeatures(box, { layers: clickable.filter((l) => map.getLayer(l)) }).length;
    map.getCanvas().style.cursor = n ? 'pointer' : '';
  });

  animateDashes();
  applyTime();
}

function addMark(lngLat, fid, isGap) {
  const el = document.createElement('div');
  el.className = 'qmark' + (isGap ? ' gap' : '');
  el.textContent = '?';
  el.title = isGap ? '可能未步行的缺口' : '此段路徑未知';
  el.addEventListener('click', (ev) => { ev.stopPropagation(); showFeature(fid); });
  const m = new maplibregl.Marker({ element: el }).setLngLat([normLon(lngLat[0]), lngLat[1]]).addTo(map);
  marks.push({ m, fid });
}

function emptyLine(cat) {
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: { cat } };
}

// 游泳線的流動虛線
function animateDashes() {
  const seq = [[0, 2, 1.5], [0.5, 2, 1], [1, 2, 0.5], [1.5, 2, 0], [0, 0.5, 2, 1], [0, 1, 2, 0.5], [0, 1.5, 2]];
  let step = 0;
  setInterval(() => {
    if (!map.getLayer('swim')) return;
    step = (step + 1) % seq.length;
    map.setPaintProperty('swim', 'line-dasharray', seq[step]);
  }, 120);
}

// ---------------------------------------------------------------------------
// 時間狀態
// ---------------------------------------------------------------------------
function chainIndex(t) {
  const C = D.chain;
  let lo = 0, hi = C.length - 1;
  if (t < C[0][2]) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (C[mid][2] <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function stateAt(t) {
  const C = D.chain, i = chainIndex(t);
  if (i < 0) return { kind: 'before', pos: [C[0][0], C[0][1]], km: 0 };
  if (i >= C.length - 1) {
    const c = C[C.length - 1];
    return { kind: 'end', pos: [c[0], c[1]], km: c[3], fid: c[4] };
  }
  const a = C[i], b = C[i + 1];
  if (a[4] === b[4] && a[0] === b[0] && a[1] === b[1] && b[2] - a[2] > 3) {
    // 路段中途的停頓（停頓地點沒有座標，位置僅示意）
    const ps = D.pauses.filter((p) => p.t0 <= t && t <= p.t1).sort((x, y) => (x.t1 - x.t0) - (y.t1 - y.t0));
    return { kind: 'pause', pos: [a[0], a[1]], km: a[3], fid: a[4], next: b[2], pause: ps[0], unknownPos: true };
  }
  if (a[4] === b[4]) {
    const r = b[2] > a[2] ? (t - a[2]) / (b[2] - a[2]) : 1;
    const pos = [a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r];
    const coords = C.slice(chainFeatStart[a[4]], i + 1).map((c) => [c[0], c[1]]).concat([pos]);
    return { kind: 'move', pos, km: a[3] + (b[3] - a[3]) * r, fid: a[4], coords };
  }
  // 兩段之間：停頓或暫離路線
  const st = { kind: 'pause', pos: [a[0], a[1]], km: a[3], fid: a[4], next: b[2] };
  const away = D.features.features.find((f) => !f.properties.progress && f.properties.t0 <= t && t <= f.properties.t1 && f.properties.t1 > f.properties.t0);
  if (away) { st.kind = 'away'; st.awayFid = away.properties.fid; }
  const ps = D.pauses.filter((p) => p.t0 <= t && t <= p.t1).sort((x, y) => (x.t1 - x.t0) - (y.t1 - y.t0));
  if (ps.length) st.pause = ps[0];
  return st;
}

function stateText(st) {
  if (st.kind === 'before') return '尚未出發';
  if (st.kind === 'end') return '抵達終點（預定 2026-11-02，待確認）';
  if (st.kind === 'move') {
    const p = featById[st.fid].properties;
    return (p.uncertain ? '路徑未知段 · ' : '') + (CAT[p.cat] || p.cat) + '中';
  }
  if (st.kind === 'away') {
    const p = featById[st.awayFid].properties;
    return `${CAT[p.cat]}${st.pause ? '：' + (st.pause.zh_reason || st.pause.reason) : ''}`;
  }
  const where = st.unknownPos ? '（位置未知）' : '';
  return st.pause ? `停頓${where}：${st.pause.zh_reason || st.pause.reason}` : `停頓${where}（原因未記錄）`;
}

function applyTime() {
  if (!map || !map.getLayer('walk')) return;
  const tf = timeFilter();
  for (const id of PROGRESS_LAYERS) map.setFilter(id, ['all', CAT_FILTER[id], tf]);
  map.setFilter('waypoints', ['<=', ['get', 't'], T]);
  map.setFilter('pauses', ['<=', ['get', 't0'], T]);

  const st = stateAt(T);
  walker.setLngLat([normLon(st.pos[0]), st.pos[1]]);
  const el = walker.getElement();
  el.classList.toggle('paused', st.kind === 'pause');
  el.classList.toggle('away', st.kind === 'away');

  const cur = st.kind === 'move' && featById[st.fid].properties.t1 > T
    ? { ...emptyLine(featById[st.fid].properties.cat), geometry: { type: 'LineString', coordinates: st.coords } }
    : emptyLine('walk');
  if (featById[st.fid]?.properties.uncertain) cur.geometry.coordinates = [];
  map.getSource('current').setData(cur);

  for (const { m, fid } of marks) m.getElement().style.display = (featById[fid].properties.t0 <= T && markVisible) ? '' : 'none';

  $('#tl-date').textContent = fmtDay(Math.min(Math.max(T, D.chain[0][2]), D.chain[D.chain.length - 1][2]));
  // 時間軸下方固定一行：放不下的文字以「…」截斷，完整內容放在滑鼠提示；停頓原因可點開停頓面板看全文
  $('#tl-km').textContent = `累計 ≈ ${Math.round(st.km).toLocaleString()} km`;
  const stTxt = stateText(st), stEl = $('#tl-state');
  stEl.textContent = stTxt;
  stEl.dataset.pause = st.pause ? D.pauses.indexOf(st.pause) : '';
  stEl.title = stTxt + (st.pause ? '（點一下看停頓詳情）' : '');
  stEl.classList.toggle('link', !!st.pause);
  if (followCam && playing) followCamera(st);
  updateHud(st);
  drawCursor();
  return st;
}

// ---------------------------------------------------------------------------
// 播放時的「身歷其境」資訊卡：目前國家國旗、地點與照片、第幾天、移動方式；
// 跨國時顯示「進入○○」，經過有 Karl 照片的地點時（桌機）彈出明信片
// ---------------------------------------------------------------------------
let wpOrder = null;
const hud = { wp: null, iso: null, landIso: null, cardAt: 0 };
const MODE_ICON = { walk: '🚶', swim: '🏊', ice: '🧊', deadend: '🚶', sidewalk: '🚶', offroute: '✈️' };
function currentWp(t) {
  if (!wpOrder) {
    wpOrder = Object.entries(D.waypoints).map(([id, w]) => [wpTime(w), id]).filter(([x]) => x != null).sort((a, b) => a[0] - b[0]);
  }
  let lo = 0, hi = wpOrder.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (wpOrder[m][0] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans < 0 ? null : wpOrder[ans][1];
}
function updateHud(st) {
  const el = $('#hud');
  const show = !tour.on && (document.body.dataset.view || 'map') === 'map' && T < Tmax - 0.5 && st.kind !== 'before';
  el.classList.toggle('hidden', !show);
  if (!show) return;
  const wid = currentWp(T), w = wid && D.waypoints[wid];
  const cat = st.kind === 'move' ? featById[st.fid].properties.cat : null;
  // 國家：海上移動時不顯示國旗
  const atSea = cat === 'swim' || cat === 'ice';
  const flags = w && !atSea ? flagList(w) : [];
  const iso = flags.length ? flags[0].iso : atSea ? cat : null;
  const country = flags.length ? flags.map((c) => c.zh).join(' ↔ ')
    : cat === 'swim' ? '海上（游泳）' : cat === 'ice' ? '海冰上' : (w && w.country && w.country.basis === 'sea' ? '海上' : '國家未知');
  if (wid !== hud.wp) {
    hud.wp = wid;
    const ph = w && w.photos && w.photos.length ? D.photos[w.photos[0]] : null;
    const img = ph ? ph.image_url : w && w.place ? w.place.img : '';
    // 新圖載好才換上，快速播放時不會一直閃空白
    if (img) preload(img).then((ok) => { if (ok && hud.wp === wid) $('#hud-img').innerHTML = `<img src="${esc(img)}" alt="">${ph ? '<span>Karl 拍攝</span>' : ''}`; });
    preloadAhead(T);
    $('#hud-place').textContent = w ? `📍 ${w.zh_name || w.name}` : '';
    $('#hud-place').title = w && w.place && !ph ? `照片：${placeName(w.place)}（附近知名地點，非 Karl 拍攝）` : '';
    if (ph && playing && !isMobile()) queuePostcard(w.photos[0], wid);
  }
  if (iso !== hud.iso) {
    hud.iso = iso;
    $('#hud-flag').innerHTML = flags.length ? flags.map((c) => `<img src="img/flags/${c.iso}.png" alt="">`).join('')
      : `<span class="hud-sea">${atSea ? MODE_ICON[cat] : '🏳️'}</span>`;
    $('#hud-country').textContent = country;
    // 只在陸地上換國家時於資訊卡提示「進入○○」（從海冰／游泳回到同一國不算）
    if (flags.length) {
      if (playing && hud.landIso && hud.landIso !== flags[0].iso) flashCountry();
      hud.landIso = flags[0].iso;
    }
  }
  const day = Math.floor(T - D.chain[0][2]) + 1;
  const mode = st.kind === 'move' ? `${MODE_ICON[cat] || ''} ${CAT[cat] || ''}中`
    : st.kind === 'away' ? '✈️ 離開路線' : st.kind === 'end' ? '🏁 終點' : `⏸ 停頓${st.unknownPos ? '（位置未知）' : ''}`;
  $('#hud-meta').textContent = `第 ${day.toLocaleString()} 天 · ${mode} · 已走 ≈ ${Math.round(st.km).toLocaleString()} km`;
}
let enterTimer = null;
function flashCountry() {
  const el = $('#hud');
  el.classList.remove('entered');
  void el.offsetWidth;   // 重新觸發動畫
  el.classList.add('entered');
  clearTimeout(enterTimer);
  enterTimer = setTimeout(() => el.classList.remove('entered'), 2500);
}
let cardTimer = null;
// 圖片預載：同一網址只下載一次；結果（成功／失敗）快取起來
const imgCache = new Map();
function preload(url) {
  if (!imgCache.has(url)) {
    imgCache.set(url, new Promise((res) => {
      const im = new Image();
      im.onload = () => res(true);
      im.onerror = () => res(false);
      im.src = url;
    }));
  }
  return imgCache.get(url);
}
// 播放時先下載前方幾個經過點的圖（HUD 小圖與 Karl 照片），到達時就能立刻顯示
let aheadOrder = null;
function preloadAhead(t) {
  if (!aheadOrder) currentWp(t);   // 建立 wpOrder
  aheadOrder = aheadOrder || wpOrder;
  let i = aheadOrder.findIndex(([x]) => x > t), karl = 0, place = 0;
  for (; i >= 0 && i < aheadOrder.length && (karl < 3 || place < 4); i++) {
    const w = D.waypoints[aheadOrder[i][1]];
    if (w.photos && w.photos.length && karl < 3) { preload(D.photos[w.photos[0]].image_url); karl++; }
    else if (w.place && w.place.img && place < 4) { preload(w.place.img); place++; }
  }
}
// 明信片：照片載好才顯示；載入失敗略過；等太久（已走遠）就放棄；前一張至少停留 4.5 秒
let cardPending = null;
function queuePostcard(i, wid) {
  const at = performance.now();
  cardPending = wid;
  preload(D.photos[i].image_url).then((ok) => {
    if (!ok || cardPending !== wid || !playing || isMobile()) return;
    const tryShow = () => {
      if (cardPending !== wid || !playing) return;
      if (performance.now() - at > 6000) return;               // 已經走遠，不再補顯示
      const wait = 4500 - (performance.now() - hud.cardAt);
      if (wait > 0 || $('#postcard').matches(':hover')) { setTimeout(tryShow, Math.max(wait, 300)); return; }
      showPostcard(i, wid);
    };
    tryShow();
  });
}
function showPostcard(i, wid) {
  const ph = D.photos[i], w = D.waypoints[wid], el = $('#postcard');
  hud.cardAt = performance.now();
  el.innerHTML = `<img src="${esc(ph.image_url)}" alt="" data-photo="${i}" data-group="${w.photos.join(',')}" onerror="this.parentNode.classList.add('hidden')">
    <div><span class="badge primary">Karl 本人照片</span>${esc(ph.caption_zh || ph.caption_en || '')}<small>${esc(w.zh_name || w.name)}</small></div>`;
  el.classList.remove('hidden', 'out');
  clearTimeout(cardTimer);
  const fade = () => {
    if (el.matches(':hover')) { cardTimer = setTimeout(fade, 500); return; }   // 滑鼠停在上面時不消失
    el.classList.add('out');
    cardTimer = setTimeout(() => el.classList.add('hidden'), 600);
  };
  cardTimer = setTimeout(fade, 4500);
}

// ---------------------------------------------------------------------------
// 播放
// ---------------------------------------------------------------------------
function tick(now) {
  if (!playing) return;
  const dt = lastFrame ? Math.min(now - lastFrame, 100) / 1000 : 0;
  lastFrame = now;
  if (!camIntro) T += dt * +$('#speed').value;   // 鏡頭飛入期間時間先不走
  if (T >= Tmax) { T = Tmax; setPlaying(false); }
  const st = applyTime();
  if ($('#skip').checked && (st.kind === 'pause' || st.kind === 'away') && st.next - T > 14) {
    T = st.next - 1;
    applyTime();
  }
  requestAnimationFrame(tick);
}
function setScaleKm(km) {
  scaleKm = km;
  const c = map.getCenter();
  map.easeTo({ zoom: zoomForKm(km, c.lat), duration: 600 });
}
// 開始跟隨時鏡頭平滑飛到目前位置與鎖定的比例尺；飛行中時間暫停，結束（或被使用者拖動打斷）後才開始走
let camIntro = false;
function flyToFollow() {
  if (!scaleKm) scaleKm = 200;
  const st = stateAt(T);
  // 鏡頭已大致在原位（例如暫停後再播放）：不飛行，按下就立刻開始走
  const center = [normLon(st.pos[0]), st.pos[1]], zoom = zoomForKm(scaleKm, st.pos[1]);
  const pt = map.project(center), cv = map.getCanvas();
  const near = Math.hypot(pt.x - cv.clientWidth / 2, pt.y - cv.clientHeight / 2) < Math.min(cv.clientWidth, cv.clientHeight) / 3;
  if (near && Math.abs(map.getZoom() - zoom) < 0.5) {
    map.stop();
    camIntro = false;
    map.jumpTo({ center, zoom });
    return;
  }
  camIntro = true;
  const done = () => { if (camIntro) { camIntro = false; lastFrame = 0; } };
  map.once('moveend', done);
  setTimeout(done, 2200);   // 保險：鏡頭已在目標位置時可能不觸發 moveend
  map.flyTo({ center, zoom, duration: 1600, essential: true });
}
function followCamera(st) {
  if (map.isEasing()) return;  // 等比例尺按鈕的縮放動畫結束，避免打斷
  const center = [normLon(st.pos[0]), st.pos[1]];
  if (scaleKm) map.jumpTo({ center, zoom: zoomForKm(scaleKm, st.pos[1]) });
  else map.setCenter(center);
}

function setPlaying(on) {
  playing = on;
  $('#play').textContent = on ? '❚❚' : '▶';
  if (on) {
    tour.anim = null;
    if (T >= Tmax - 1) T = Tmin;
    if (followCam) flyToFollow();
    preloadAhead(T);
    lastFrame = 0;
    requestAnimationFrame(tick);
  }
}

// ---------------------------------------------------------------------------
// 時間軸
// ---------------------------------------------------------------------------
const TL_PAD = 14;
function tlX(t, w) { return TL_PAD + (t - Tmin) / (Tmax - Tmin) * (w - 2 * TL_PAD); }
function tlT(x, w) { return Tmin + (x - TL_PAD) / (w - 2 * TL_PAD) * (Tmax - Tmin); }

function drawTimelineBase() {
  const cv = $('#tl-canvas'), dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;  // 時間軸隱藏中（考證頁、關於頁）
  cv.width = w * dpr; cv.height = h * dpr;
  const off = document.createElement('canvas');
  off.width = cv.width; off.height = cv.height;
  const g = off.getContext('2d');
  g.scale(dpr, dpr);

  // 停頓列
  g.fillStyle = 'rgba(255,255,255,0.13)';
  for (const p of D.pauses) {
    const x0 = tlX(p.t0, w), x1 = tlX(p.t1, w);
    g.fillRect(x0, 26, Math.max(1, x1 - x0), 8);
  }
  // 移動列
  for (const f of D.features.features) {
    const p = f.properties;
    const x0 = tlX(p.t0, w), x1 = tlX(p.t1, w);
    if (p.progress) {
      g.fillStyle = COLORS[p.cat] || COLORS.walk;
      g.globalAlpha = p.uncertain ? 0.35 : 1;
      g.fillRect(x0, 8, Math.max(1, x1 - x0), 16);
      g.globalAlpha = 1;
    } else if (p.cat !== 'offroute') {
      g.fillStyle = COLORS[p.cat];
      g.fillRect(x0, 2, Math.max(2, x1 - x0), 4);
    }
  }
  // 年份刻度
  g.fillStyle = '#9aa3ae'; g.strokeStyle = '#3a414d';
  g.font = `${h < 50 ? 10 : 11}px system-ui`; g.textAlign = 'center';
  const y0 = new Date(Tmin * 86400000).getUTCFullYear(), y1 = new Date(Tmax * 86400000).getUTCFullYear();
  for (let y = y0 + 1; y <= y1; y++) {
    const x = tlX(Date.UTC(y, 0, 1) / 86400000, w);
    g.beginPath(); g.moveTo(x, 35); g.lineTo(x, y % 5 === 0 ? (h < 50 ? 38 : 41) : (h < 50 ? 36.5 : 38)); g.stroke();
    const step = w > 900 ? 1 : w > 560 ? 2 : 5;
    if (y % step === 0) g.fillText(String(y), x, h - 2);
  }
  tlBase = off;
  drawCursor();
}

function drawCursor() {
  const cv = $('#tl-canvas');
  if (!tlBase || !tlBase.width || !cv.width) return;
  const g = cv.getContext('2d'), dpr = window.devicePixelRatio || 1, w = cv.clientWidth;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, cv.width, cv.height);
  g.drawImage(tlBase, 0, 0);
  g.scale(dpr, dpr);
  const x = tlX(T, w);
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(x, 0, w - x, 36);
  g.strokeStyle = '#ffffff'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 40); g.stroke();
}

function setupTimeline() {
  const cv = $('#tl-canvas'), tip = $('#tl-tip');
  let dragging = false;
  const setFromEvent = (e) => {
    const r = cv.getBoundingClientRect();
    T = Math.min(Tmax, Math.max(Tmin, tlT(e.clientX - r.left, r.width)));
    applyTime();
  };
  cv.addEventListener('pointerdown', (e) => { dragging = true; cv.setPointerCapture(e.pointerId); setPlaying(false); setFromEvent(e); });
  cv.addEventListener('pointermove', (e) => {
    const r = cv.getBoundingClientRect();
    if (dragging) setFromEvent(e);
    const t = tlT(e.clientX - r.left, r.width);
    tip.classList.remove('hidden');
    const half = tip.offsetWidth / 2 + 4;
    tip.style.left = Math.min(r.width - half, Math.max(half, e.clientX - r.left)) + 'px';
    tip.textContent = `${fmtDay(t)} · ${stateText(stateAt(t))}`;
  });
  cv.addEventListener('pointerup', () => { dragging = false; });
  cv.addEventListener('pointerleave', () => tip.classList.add('hidden'));
  new ResizeObserver(drawTimelineBase).observe(cv);
}

// ---------------------------------------------------------------------------
// 介面
// ---------------------------------------------------------------------------
let markVisible = true;
function setupUI() {
  $('#lb-close').onclick = closeLightbox;
  $('#lb-prev').onclick = () => stepLightbox(-1);
  $('#lb-next').onclick = () => stepLightbox(1);
  $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') closeLightbox(); });
  setupTimeline();
  $('#play').onclick = () => setPlaying(!playing);
  followCam = $('#follow').checked;
  $('#follow').onchange = (e) => {
    followCam = e.target.checked;
    if (followCam && playing) flyToFollow();
  };
  $('#legend-toggle').onclick = () => {
    const b = $('#legend-body'); b.classList.toggle('hidden');
    $('#legend-toggle').textContent = b.classList.contains('hidden') ? '+' : '–';
  };
  $('#panel-close').onclick = closePanel;
  if (isMobile()) { $('#legend-body').classList.add('hidden'); $('#legend-toggle').textContent = '+'; }
  window.addEventListener('resize', () => {
    if (!tour.on) return;
    map.setPadding(tourPadding());
    sizeStorySpacer();
  });
  $('#fit').onclick = () => map.flyTo(overview());
  $('#proj').onclick = () => {
    const globe = map.getProjection()?.type === 'globe';
    map.setProjection({ type: globe ? 'mercator' : 'globe' });
    $('#proj').textContent = globe ? '切換為 3D 地球' : '切換為平面地圖';
  };
  document.querySelectorAll('#legend input[data-layer]').forEach((cb) => {
    cb.onchange = () => {
      const key = cb.dataset.layer;
      if (key === 'marks') { markVisible = cb.checked; applyTime(); return; }
      for (const id of TOGGLE_LAYERS[key]) map.setLayoutProperty(id, 'visibility', cb.checked ? 'visible' : 'none');
    };
  });
  // 導覽進行中點「地圖」分頁，等同離開導覽回地圖（從某個點進來的會回到那個點）
  document.querySelectorAll('nav button[data-view]').forEach((b) => {
    b.onclick = () => (b.dataset.view === 'map' && tour.on ? leaveTour(true) : setView(b.dataset.view));
  });
  $('#tour-start').onclick = () => setView('story');
  initReport();
  $('#tl-state').onclick = (e) => { const i = e.currentTarget.dataset.pause; if (i !== '' && i != null) showPause(+i); };
  document.addEventListener('keydown', (e) => {
    if (!$('#report').classList.contains('hidden')) {
      if (e.key === 'Escape') closeReport();
      return;
    }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
    if (lbOpen()) {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') stepLightbox(e.key === 'ArrowLeft' ? -1 : 1);
      if (e.key.startsWith('Arrow')) e.preventDefault();
      return;
    }
    if (e.key === 'Escape') closePanel();
    if (tour.on && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      gotoChapter(tour.idx + (e.key === 'ArrowDown' ? 1 : -1));
    }
  });
}

// 目前點開的標註點：脈動圓環，面板關閉時移除
let selMarker = null;
function markSelected(lon, lat) {
  if (!selMarker) {
    const el = document.createElement('div');
    el.className = 'sel-ring';
    selMarker = new maplibregl.Marker({ element: el });
  }
  if (lon == null || lat == null) { selMarker.remove(); return; }
  selMarker.setLngLat([lon, lat]).addTo(map);
}

// 面板目前顯示的項目（從面板按鈕進導覽時記下，離開導覽時重新打開）
let panelRef = null;
function openPanel(title, html) {
  $('#panel-title').textContent = title;
  $('#panel-body').innerHTML = html;
  $('#panel-body').scrollTop = 0;
  $('#panel-exit').textContent = $('#story-exit') ? $('#story-exit').textContent : '離開導覽';
  $('#panel').classList.remove('hidden');
  $('#panel-body').querySelectorAll('[data-wp]').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); showWaypoint(a.dataset.wp, true); };
  });
  $('#panel-body').querySelectorAll('[data-tour]').forEach((b) => { b.onclick = () => openTourAt(+b.dataset.tour); });
}
function closePanel() {
  $('#panel').classList.add('hidden');
  panelRef = null;
  markSelected(null);
  if (map.getLayer('highlight')) map.setFilter('highlight', ['==', ['get', 'fid'], -1]);
}

function sourcesHtml(ids) {
  if (!ids || !ids.length) return '<p class="note">（無直接來源）</p>';
  return ids.map((id) => {
    const s = D.sources[id];
    if (!s) return `<div class="src">${esc(id)}（來源遺失）</div>`;
    const t = s.type === 'primary' ? '<span class="badge primary">一手</span>' : '<span class="badge secondary">二手</span>';
    const link = s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>` : esc(s.title);
    return `<div class="src">${t}${link}<br><small>${esc([s.publisher, s.date].filter(Boolean).join(' · '))}</small>` +
      (s.quote ? `<blockquote>${esc(s.quote)}</blockquote>` : '') + '</div>';
  }).join('');
}
const wpLink = (id) => {
  const w = D.waypoints[id];
  return w ? `<a href="#" data-wp="${esc(id)}">${esc(w.name)}</a>` : esc(id);
};

function showFeature(fid) {
  const f = featById[fid];
  if (!f) return;
  markSelected(null);
  const p = f.properties;
  panelRef = { feat: fid };
  map.setFilter('highlight', ['==', ['get', 'fid'], fid]);
  const head = `<p><span class="badge ${p.cat}">${esc(CAT[p.cat])}</span>` +
    (p.uncertain && p.cat !== 'offroute' ? '<span class="badge unknown">路徑未知</span>' : '') +
    (p.t0_interp || p.t1_interp ? '<span class="badge interp">日期推估</span>' : '') +
    `<span class="badge">第 ${esc(p.leg)} 段</span></p>` +
    `<dl class="kv"><dt>起訖</dt><dd>${wpLink(p.from)} → ${wpLink(p.to)}</dd>` +
    `<dt>期間</dt><dd>${fmtDay(p.t0)} → ${fmtDay(p.t1)}</dd>` +
    (p.cat !== 'offroute' ? `<dt>線長</dt><dd>≈ ${Math.round(p.km).toLocaleString()} km</dd>` : '') +
    `<dt>線形</dt><dd>${roadText(p)}</dd></dl>` +
    (p.gap ? '<div class="warn">此段經過沒有座標的地點（例如未知的邊境口岸），地圖只在前後兩個已知點之間畫出模糊區帶，不代表實際路線。</div>' : '') +
    (p.possible_gap ? `<div class="warn">可能缺口：${esc(p.possible_gap)}</div>` : '') +
    (p.water_note ? `<div class="warn">${esc(p.water_note)}</div>` : '');
  const members = (typeof p.members === 'string' ? JSON.parse(p.members) : p.members).map((id) => {
    const s = D.segments[id];
    return `<div class="seg"><h3>${wpLink(s.from)} → ${wpLink(s.to)}</h3>` +
      `<dl class="kv"><dt>方式</dt><dd>${esc(MODE[s.mode] || s.mode)}${s.counts_as_progress ? '' : '（不算進度）'}</dd>` +
      `<dt>日期</dt><dd>${esc(wpDate(D.waypoints[s.from]))} → ${esc(wpDate(D.waypoints[s.to]))}</dd>` +
      `<dt>路徑依據</dt><dd>${esc(BASIS[s.route_basis] || s.route_basis)}</dd>` +
      (s.route_detail ? `<dt>道路</dt><dd>${esc(s.route_detail)}</dd>` : '') +
      (s.companions && s.companions.length ? `<dt>同行者</dt><dd>${esc(s.companions.join('、'))}</dd>` : '') +
      `</dl>${s.notes ? `<p class="note">${esc(s.notes)}</p>` : ''}${sourcesHtml(s.sources)}</div>`;
  }).join('');
  openPanel(CAT[p.cat], head + members);
}

function roadText(p) {
  if (p.cat === 'offroute') return '弧線示意（交通工具，非實際航線）';
  if (p.cat === 'swim' || p.cat === 'ice') return '經過點間直線示意';
  const r = p.road;
  if (!r) return '直線（未做道路推算）';
  const fail = r.fail.length ? `；其餘為直線：${r.fail.map((f) => ROAD_FAIL[f] || f).join('、')}` : '';
  if (r.ok === 0) return `直線${fail.replace('；其餘為直線', '')}`;
  return `${r.ok === r.n ? '全部' : `${r.ok}/${r.n} 小段`}沿道路推算（OSRM 路網最短路徑，非 GPS 軌跡）${fail}` +
    (p.uncertain ? '。<b>此段實際路徑未知，道路線形僅供示意。</b>' : '');
}

function showWaypoint(id, keepHighlight, noMove) {
  const w = D.waypoints[id];
  if (!w) return;
  if (!keepHighlight) map.setFilter('highlight', ['==', ['get', 'fid'], -1]);
  const ps = D.pauses.filter((p) => p.at === id);
  openPanel(w.zh_name ? `${w.name}｜${w.zh_name}` : w.name,
    mediaHtml(w) + tourBtnHtml(tourItemFor(id, wpTime(w))) + `<dl class="kv"><dt>日期</dt><dd>${esc(wpDate(w))}</dd>` +
    `<dt>座標</dt><dd>${w.lat != null ? `${w.lat.toFixed(3)}, ${w.lon.toFixed(3)}` : '未知'}（${esc(COORD[w.coord_basis] || w.coord_basis)}）</dd>` +
    `<dt>段落</dt><dd>第 ${esc(w.leg)} 段</dd></dl>` +
    (w.coord_issue ? `<div class="warn">${esc(w.coord_issue)}（日誌原值 ${w.reported_lat}, ${w.reported_lon}）</div>` : '') +
    (w.event ? `<p class="note">${esc(w.event)}</p>` : '') +
    ps.map((p) => `<div class="warn">停頓 ${esc(p.start)} → ${esc(p.end)}：${esc(p.reason)}</div>`).join('') +
    zhBlock(w.zh_name, w.zh_summary, ps.filter((p) => p.zh_reason).map((p) => `停頓 ${p.start} → ${p.end}：${p.zh_reason}`)) +
    sourcesHtml(w.sources));
  markSelected(w.lon, w.lat);
  panelRef = { wp: id };
  if (w.lat != null && !noMove) map.easeTo({ center: [w.lon, w.lat], zoom: Math.max(map.getZoom(), 5) });
}

// ---------------------------------------------------------------------------
// 圖片：國旗、Karl 本人照片、附近知名地點照片（Wikimedia Commons）
// ---------------------------------------------------------------------------
const C_NOTE = { name: '依地名判定', neighbors: '此點無座標，前後經過點同屬此國' };
function flagList(w) {
  const c = w.country;
  return c && c.iso ? [c, ...(c.also || [])] : [];
}
const flagChip = (c) => `<span class="flag"><img src="img/flags/${c.iso}.png" alt="">${esc(c.zh)}</span>`;
function flagsHtml(w) {
  const c = w.country;
  if (!c) return '';
  if (!c.iso) return `<div class="flags"><span class="flag-none">${c.basis === 'sea' ? '海上' : '所在國家未知'}</span></div>`;
  return `<div class="flags">${flagList(w).map(flagChip).join('<span class="flag-sep">↔</span>')}` +
    `${C_NOTE[c.basis] ? `<small>（${C_NOTE[c.basis]}）</small>` : ''}</div>`;
}
// 圖片載入失敗時標記，CSS 改顯示說明文字
const imgFail = `onerror="this.closest('figure').classList.add('broken')"`;
// 照片本身沒有個別說明時（只能引用所在貼文／段落），說明文字要標示清楚
const ownCaption = (ph) => /^(figure caption|alt text)/.test(ph.caption_type || 'figure caption');
function karlCaption(ph, full = true) {
  const pre = ownCaption(ph) ? '' : '<small class="ctx">照片沒有個別說明，以下為所在貼文內容：</small>';
  return `${pre}${esc(ph.caption_zh || ph.caption_en || '')}` +
    (full ? `${ph.caption_en ? `<small class="en">原文：${esc(ph.caption_en)}</small>` : ''}
    <small>${esc([ph.date, ph.place].filter((x) => x && x.length <= 40).join(' · '))}</small>
    <small>${esc(ph.credit || '')}${ph.page_url ? ` · <a href="${esc(ph.page_url)}" target="_blank" rel="noopener">出處</a>` : ''}</small>` : '');
}
function karlPhotosHtml(w) {
  return (w.photos || []).map((i) => {
    const ph = D.photos[i];
    return `<figure class="photo karl${ph.small ? ' small' : ''}"><img loading="lazy" src="${esc(ph.image_url)}" alt="" data-photo="${i}" data-group="${w.photos.join(',')}" ${imgFail}>
    <figcaption><span class="badge primary">Karl 本人照片</span>${karlCaption(ph)}${ph.small ? '<small>存檔只留下縮圖，原圖已不存在</small>' : ''}</figcaption></figure>`;
  }).join('');
}
function placeName(p) {
  return p.label_zh && p.label_en && p.label_zh !== p.label_en ? `${p.label_zh}（${p.label_en}）` : (p.label_zh || p.label_en || p.qid);
}
const PLACE_KIND = { near: '附近知名地點', city: '所在城市', region: '所在地區', prev: '前一個已知點附近' };
function placePhotoHtml(w) {
  const p = w.place;
  if (!p) return '';
  const ref = p.ref_wp && D.waypoints[p.ref_wp];
  const where = {
    city: '此點所在的城市',
    region: '此點沒有座標；照片是地名中提到的地區，不代表確切位置',
    prev: `此點沒有座標；照片取自前一個已知經過點（${ref ? esc(ref.zh_name || ref.name) : '—'}）附近，僅供參考`,
  }[p.kind] || (p.dist_km < 1 ? '就在此點附近' : `距此點約 ${p.dist_km} km`);
  return `<figure class="photo place">
    <a href="${esc(p.file_page)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(p.img)}" alt="" ${imgFail}></a>
    <figcaption><span class="badge">${PLACE_KIND[p.kind] || '附近知名地點'}</span><b>${esc(placeName(p))}</b>${p.desc_zh || p.desc_en ? `：${esc(p.desc_zh || p.desc_en)}` : ''}
    <small>${where}。非 Karl 拍攝，不代表他經過時的景象。</small>
    <small>照片：${esc(p.artist || '不詳')} · ${esc(p.license || '授權見原頁')} · <a href="${esc(p.file_page)}" target="_blank" rel="noopener">Wikimedia Commons</a></small></figcaption></figure>`;
}
function mediaHtml(w) {
  return `<div class="media">${flagsHtml(w)}${karlPhotosHtml(w)}${placePhotoHtml(w)}</div>`;
}
// ---------------------------------------------------------------------------
// 導覽卡片的圖片分配：整個導覽中同一張圖只出現一次
// - 每張卡片的候選圖：Karl 本人照片（卡片經過點的照片；章節卡另含本章拍攝地點未標明的照片）、
//   卡片經過點的附近地點照片，以及時間落在卡片時間窗內（或最接近）的其他經過點的地點照片
// - 全域依「適合度」由高到低分配：Karl 照片 > 卡片自己列出的經過點 > 時間窗內的經過點 > 時間最近的經過點；
//   同分時節卡優先於章卡（較具體）、卡片內排序較前者優先
// - 被別張卡片用掉的圖不再使用，改用下一個候選
// ---------------------------------------------------------------------------
// 地圖標註點 → 導覽中最合適的一則：
// 列出此經過點且時間窗含其日期的節 > 列出此經過點的節 > 時間窗含其日期的節 > 列出此點或時間窗含其日期的章 > 時間最接近的節
function tourItemFor(wid, t) {
  let best = -1, bs = -Infinity;
  tour.items.forEach((it, i) => {
    if (it.type !== 'section' && it.type !== 'chapter') return;
    const wps = (it.type === 'chapter' ? STORY[it.ci].wps : it.sec.wps) || [];
    const a = parseDay(it.from), b = parseDay(it.to);
    const inWin = t != null && t >= a && t <= b;
    const listed = wid && wps.includes(wid);
    const gap = t == null ? 1e6 : t < a ? a - t : t > b ? t - b : 0;
    const sc = (it.type === 'section'
      ? (listed && inWin ? 100 : listed ? 80 : inWin ? 60 : 0)
      : (listed || inWin ? 40 : 0)) - gap / 1e4;
    if (sc > bs) { bs = sc; best = i; }
  });
  return best;
}
function tourLabel(i) {
  const it = tour.items[i];
  const c = STORY[it.ci];
  return it.type === 'section' ? `第 ${it.ci + 1} 章 · 第 ${it.si + 1} 節「${it.sec.title}」` : `第 ${it.ci + 1} 章「${c.title}」`;
}
function tourBtnHtml(i) {
  if (i < 0) return '';
  return `<button class="to-tour" data-tour="${i}">▶ 在導覽中看這段：${esc(tourLabel(i))}</button>`;
}
function openTourAt(i) {
  if (tour.on) { closePanel(); gotoChapter(i); return; }
  tour.startAt = i;
  tour.back = { view: 'map', panel: panelRef, cam: camState(), T };
  setView('story');
}
const camState = () => ({ center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() });

function planCardMedia(items) {
  const wpIds = Object.keys(D.waypoints).filter((id) => D.waypoints[id].place);
  const placeKey = (id) => 'p:' + D.waypoints[id].place.img;
  const cands = [];   // [card, key, score, rank, media]
  const cardKarl = {};
  items.forEach((it, ci) => {
    if (it.type !== 'chapter' && it.type !== 'section') return;
    const wps = (it.type === 'chapter' ? STORY[it.ci].wps : it.sec.wps) || [];
    const a = parseDay(it.from), b = parseDay(it.to);
    const sec = it.type === 'section' ? 0.5 : 0;
    let rank = 0;
    const add = (key, score, media) => cands.push([ci, key, score + sec, rank++, media]);
    const karl = [...new Set([
      ...wps.flatMap((id) => (D.waypoints[id] && D.waypoints[id].photos) || []),
      ...(it.type === 'chapter' ? D.photos.map((ph, i) => (ph.chapter === it.ci + 1 && !ph.waypoint ? i : -1)).filter((i) => i >= 0) : []),
    ])].sort((x, y) => D.photos[x].small - D.photos[y].small);
    cardKarl[ci] = karl;
    // 有座標經過點的 Karl 照片：放在時間窗含該經過點日期的卡片最適合
    karl.forEach((i) => {
      const w = D.photos[i].waypoint && D.waypoints[D.photos[i].waypoint];
      const t = w && wpTime(w);
      add('k:' + i, (D.photos[i].small ? 8 : 10) + (t != null && t >= a && t <= b ? 1 : 0), { karl: i });
    });
    const own = wps.filter((id) => D.waypoints[id] && D.waypoints[id].place);
    own.forEach((id) => {
      const pl = D.waypoints[id].place;
      add(placeKey(id), pl.kind === 'near' || pl.kind === 'city' ? 6 : 4, { wp: id });
    });
    // 節卡：本章拍攝地點未標明的 Karl 照片（說明會標「拍攝地點未標明」）
    if (it.type === 'section') {
      D.photos.forEach((ph, i) => { if (ph.chapter === it.ci + 1 && !ph.waypoint) add('k:' + i, ph.small ? 4.5 : 5, { karl: i }); });
    }
    // 時間窗內、以及時間最接近的其他經過點（依與時間窗的距離排序）
    const gap = (id) => { const t = wpTime(D.waypoints[id]); return t == null ? Infinity : t < a ? a - t : t > b ? t - b : 0; };
    wpIds.filter((id) => !own.includes(id) && gap(id) < Infinity).sort((x, y) => gap(x) - gap(y)).forEach((id) => {
      const k = D.waypoints[id].place.kind, good = k === 'near' || k === 'city';
      add(placeKey(id), gap(id) === 0 ? (good ? 3 : 2) : gap(id) < 400 ? (good ? 1 : 0.5) : 0, { wp: id });
    });
  });
  cands.sort((x, y) => y[2] - x[2] || x[3] - y[3]);
  const used = new Set(), cover = {};
  for (const [ci, key, , , media] of cands) {
    if (cover[ci] || used.has(key)) continue;
    cover[ci] = media;
    used.add(key);
  }
  // 縮圖列：本卡其餘、尚未在任何地方用過的 Karl 照片
  const thumbs = {};
  items.forEach((it, ci) => {
    thumbs[ci] = (cardKarl[ci] || []).filter((i) => !used.has('k:' + i));
    thumbs[ci].forEach((i) => used.add('k:' + i));
  });
  return { cover, thumbs };
}

function cardMediaHtml(ci) {
  const it = tour.items[ci];
  const wps = ((it.type === 'chapter' ? STORY[it.ci].wps : it.sec.wps) || []).filter((id) => D.waypoints[id]);
  const m = tour.media.cover[ci], th = tour.media.thumbs[ci];
  let fig = '';
  if (m && m.karl != null) {
    const ph = D.photos[m.karl], grp = [m.karl, ...th].join(',');
    fig = `<figure class="ch-fig${ph.small ? ' small' : ''}"><img loading="lazy" src="${esc(ph.image_url)}" alt="" data-photo="${m.karl}" data-group="${grp}" ${imgFail}>
      ${th.length ? `<div class="thumbs">${th.slice(0, 6).map((i) => `<img loading="lazy" src="${esc(D.photos[i].image_url)}" alt="" data-photo="${i}" data-group="${grp}" onerror="this.remove()">`).join('')}${th.length > 6 ? `<span>+${th.length - 6}</span>` : ''}</div>` : ''}
      <figcaption><span class="badge primary">Karl 本人照片${th.length ? ` · ${th.length + 1} 張` : ''}</span>${karlCaption(ph, false)}${ph.waypoint ? '' : '<small>拍攝地點未標明</small>'}</figcaption></figure>`;
  } else if (m && m.wp) {
    const w = D.waypoints[m.wp], p = w.place;
    const away = !wps.includes(m.wp);
    fig = `<figure class="ch-fig"><img loading="lazy" src="${esc(p.img)}" alt="" data-wp="${esc(m.wp)}" ${imgFail}>
      <figcaption>${esc(placeName(p))}<small>${PLACE_KIND[p.kind] || '附近知名地點'}${away ? `（經過點：${esc(w.zh_name || w.name)}）` : ''}，非 Karl 拍攝 · ${esc(p.artist || '')} · ${esc(p.license || '')}</small></figcaption></figure>`;
  }
  const seen = new Map();
  for (const id of wps) for (const c of flagList(D.waypoints[id])) seen.set(c.iso, c);
  return fig + (seen.size ? `<div class="flags">${[...seen.values()].map(flagChip).join('')}</div>` : '');
}

// 燈箱：點 Karl 照片放大，可在同一組照片間切換
const lb = { group: [], k: 0 };
function openLightbox(i, group) {
  lb.group = group && group.length ? group : [i];
  lb.k = Math.max(0, lb.group.indexOf(i));
  showLightbox();
  $('#lightbox').classList.remove('hidden');
}
function showLightbox() {
  const i = lb.group[lb.k], ph = D.photos[i];
  $('#lb-img').src = ph.image_url;
  $('#lightbox').classList.toggle('small', !!ph.small);
  $('#lb-cap').innerHTML = `<span class="badge primary">Karl 本人照片</span>${karlCaption(ph)}` +
    (ph.waypoint ? `<small>經過點：${wpLink(ph.waypoint)}</small>` : '<small>拍攝地點未標明</small>');
  $('#lb-count').textContent = lb.group.length > 1 ? `${lb.k + 1} / ${lb.group.length}` : '';
  $('#lb-prev').hidden = $('#lb-next').hidden = lb.group.length < 2;
  $('#lb-cap').querySelectorAll('[data-wp]').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); closeLightbox(); showWaypoint(a.dataset.wp, true); };
  });
}
function stepLightbox(d) {
  lb.k = (lb.k + d + lb.group.length) % lb.group.length;
  showLightbox();
}
function closeLightbox() { $('#lightbox').classList.add('hidden'); }
const lbOpen = () => !$('#lightbox').classList.contains('hidden');
// 事件委派：任何 data-photo 圖片都開燈箱
document.addEventListener('click', (e) => {
  const im = e.target.closest('img[data-photo]');
  if (!im) return;
  e.preventDefault();
  e.stopPropagation();
  openLightbox(+im.dataset.photo, (im.dataset.group || '').split(',').filter(Boolean).map(Number));
}, true);

function zhBlock(name, summary, extra = []) {
  if (!name && !summary && !extra.length) return '';
  return `<div class="zh"><div class="zh-label">中文簡述</div>` +
    (name ? `<div class="zh-name">${esc(name)}</div>` : '') +
    (summary ? `<p>${esc(summary)}</p>` : '') +
    extra.map((x) => `<p class="zh-extra">${esc(x)}</p>`).join('') + '</div>';
}

function showPause(idx) {
  const p = D.pauses[idx];
  const w = D.waypoints[p.at];
  const days = Math.round(p.t1 - p.t0);
  openPanel('停頓',
    tourBtnHtml(tourItemFor(p.at, p.t0)) + `<dl class="kv"><dt>地點</dt><dd>${p.at ? wpLink(p.at) : '未知'}</dd>` +
    `<dt>期間</dt><dd>${esc(p.start)} → ${esc(p.end)}（約 ${days.toLocaleString()} 天${days > 365 ? `，${(days / 365).toFixed(1)} 年` : ''}）</dd>` +
    `<dt>原因</dt><dd>${esc(p.reason)}</dd>` +
    (p.left_how ? `<dt>離開方式</dt><dd>${esc(p.left_how)}</dd>` : '') + '</dl>' +
    zhBlock(null, p.zh_reason ? `原因：${p.zh_reason}` : null) +
    (w ? `<h3 class="media-h">地點：${wpLink(p.at)}</h3>${mediaHtml(w)}` : '') + sourcesHtml(p.sources));
  markSelected(p.lon, p.lat);
  panelRef = { pause: idx };
}

// ---------------------------------------------------------------------------
// 考證頁與關於頁
// ---------------------------------------------------------------------------
function buildResearchPage() {
  const feats = D.features.features.map((f) => f.properties);
  const prog = feats.filter((p) => p.progress);
  const unc = prog.filter((p) => p.uncertain);
  const sum = (a) => Math.round(a.reduce((s, p) => s + p.km, 0)).toLocaleString();
  const srcs = Object.values(D.sources);
  let html = `<h2>考證資料</h2>
  <p>每一段路線、日期、停頓都附有來源與逐字引文；在地圖上點擊任一線段或地點即可查看。下表列出來源之間的矛盾與仍然未知的部分。</p>
  <div class="table-wrap"><table><tr><th>經過點</th><th>路段</th><th>停頓</th><th>來源</th><th>一手來源</th><th>來源矛盾</th></tr>
  <tr><td>${Object.keys(D.waypoints).length}</td><td>${Object.keys(D.segments).length}</td><td>${D.pauses.length}</td>
  <td>${srcs.length}</td><td>${srcs.filter((s) => s.type === 'primary').length}</td><td>${D.conflicts.length}</td></tr></table></div>
  <p>進度路線線長合計 ≈ ${sum(prog)} km，其中路徑未知段 ≈ ${sum(unc)} km。線長是道路推算與直線的混合估計，不是實測距離。</p>`;
  for (const leg of D.legs) {
    const cs = D.conflicts.filter((c) => c.leg === leg.leg);
    const us = D.unknowns.filter((u) => u.leg === leg.leg);
    html += `<h3>第 ${esc(leg.leg)} 段：${esc(leg.title)}</h3>`;
    if (cs.length) {
      html += '<h4>來源矛盾</h4>' + cs.map((c) => `<details><summary>${esc(c.topic)}</summary>
        <ul>${(c.claims || []).map((cl) => {
          const s = cl.source && D.sources[cl.source];
          return `<li>${esc(cl.value)}${s ? ` — <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.publisher || s.title)}</a>` : ''}</li>`;
        }).join('')}</ul><p><b>判斷：</b>${esc(c.assessment)}</p></details>`).join('');
    }
    if (us.length) html += '<h4>仍然未知</h4><ul>' + us.map((u) => `<li>${esc(u.text)}</li>`).join('') + '</ul>';
  }
  $('#research').innerHTML = html;
}

function buildAboutPage() {
  $('#about').innerHTML = `<h2>關於這張地圖</h2>
  <p>Karl Bushby，英國前傘兵，1998 年 11 月 1 日從智利蓬塔阿雷納斯出發，給自己定下規則：<b>不使用任何交通工具推進</b>。
  因簽證、資金、拘留等原因離開路線時，回來必須從原本停下的那一點繼續走。這趟被他稱為 Goliath Expedition 的旅程跨越南北美洲、白令海峽、西伯利亞、中亞、裏海與歐洲，預定於 2026 年 11 月 2 日回到英國赫爾。</p>
  <h3>如何閱讀</h3>
  <ul>
    <li><b>實線</b>：依序經過有來源的地點。兩點之間盡量沿道路推算（OSRM 開放路網的最短路徑），這只是合理的示意，<b>不是</b> GPS 軌跡；
    路網推算不出來的地方（冬季河道、凍原、叢林、離道路太遠）才以直線連接。點線段可查看每段用的是哪一種。</li>
    <li><b>模糊灰色區帶與「?」</b>：只知道兩端或大方向，實際路徑或中間的地點未知。</li>
    <li><b>紅色虛線（廢棄路段）</b>：走過、但之後不算進度的路，例如 2019 年走到伊朗邊境的土庫曼段（約 700 英里），因伊朗拒簽，2023 年改從布哈拉重新起步。</li>
    <li><b>灰色弧線（離開路線）</b>：搭機、拘留移送、救援等，預設隱藏。</li>
    <li><b>白色圓圈</b>：停頓地點，圓越大停越久。最長的停頓是 2011–2015 年俄羅斯入境禁令、2019–2023 年伊朗拒簽與疫情。</li>
    <li><b>橘色「?」</b>：可能沒有步行的缺口（目前一處：2000 年 1 月秘魯 Arequipa 附近）。</li>
    <li>時間軸上方色帶為移動期間，下方灰帶為停頓期間；勾選「跳過停頓」可略過長時間等待。</li>
  </ul>
  <h3>考證方法</h3>
  <ul>
    <li>一手來源：Karl 本人的日誌與網站（以網路檔案館存檔為主，例如 goliathexpedition.com、goliath.mail2web.com、westboundhorizons.com）、本人受訪的直接引述。其餘為二手來源。</li>
    <li>座標分為「本人回報座標」「城鎮中心」「約略區域」三級；找不到依據的地點不給座標。</li>
    <li>日期允許區間，並標出精確程度；來源互相矛盾時全部列出，見「考證」頁。</li>
    <li>尚未查閱：書《Giant Steps》（2006）、2015–2018 年的社群貼文，可能補上俄羅斯、蒙古、中國段的空白。</li>
  </ul>
  <h3>圖片</h3>
  <ul>
    <li><b>Karl 本人照片</b>：取自他的網站存檔等一手來源，說明文字譯自原文並附出處連結；版權屬原作者，本站只連結、不轉存。不是每個點都有。</li>
    <li><b>附近知名地點照片</b>：自動挑選該點附近最知名、且有照片的 Wikidata 項目（Wikimedia Commons，自由授權，作者與授權標在照片下方）。
    <b>不是 Karl 拍的</b>，也不代表他經過時的景象；面板中會註明與該點的距離。沒有座標的點不推測位置：名稱提到地區的用該地區照片，其餘用前一個已知經過點的照片，並註明。</li>
    <li><b>國旗</b>：依座標落在哪一國判定；沒有座標的點依地名或前後經過點判定，判定不了就寫「未知」。邊境口岸顯示兩國。</li>
  </ul>
  <h3>已知限制</h3>
  <ul>
    <li>終點抵達（2026-11-02）在資料產生時（${esc(D.generated)}）尚未發生，屬於預定行程。</li>
    <li>累計距離是道路推算與直線的混合估計，仍低於實際步行距離（官方說法約 36,000 英里以上）。</li>
  </ul>
  <h3>回報與授權</h3>
  <ul>
    <li>發現錯誤、來源失效或照片問題，請按右上角「⚑ 問題回報」，或資料卡、導覽卡片上的 ⚑。若照片權利人不希望在此顯示，回報後會立即移除。</li>
    <li>原始碼與考證資料公開於 <a href="https://github.com/${REPORT.github}" target="_blank" rel="noopener">GitHub</a>：程式碼採 MIT 授權，考證資料（路線、日期、說明文字）採 CC BY 4.0。
    照片不在此授權範圍內，各依原作者或 Wikimedia Commons 標示的授權。</li>
  </ul>
  <p><small>底圖 © OpenStreetMap contributors · OpenFreeMap / OpenMapTiles · 地圖引擎 MapLibre GL JS</small></p>`;
}

// ---------------------------------------------------------------------------
// 問題回報：依按鈕所在位置自動帶入回報對象，使用者只需選類型、寫說明
// ---------------------------------------------------------------------------
const repBtn = (i) => `<div class="rep-row"><button class="rep-btn" data-rep="${i}" title="回報這則的問題">⚑ 回報問題</button></div>`;
let reportRef = null;
function reportTarget(ref) {
  if (!ref) {
    const view = document.body.dataset.view || 'map';
    const v = { map: '地圖', story: '導覽', research: '考證', about: '關於' }[view] || '網站';
    return `整個網站（目前在「${v}」頁${view === 'map' && T < Tmax - 0.5 ? `，時間 ${fmtDay(T)}` : ''}）`;
  }
  if (ref.wp) {
    const w = D.waypoints[ref.wp];
    return `經過點「${w.name}${w.zh_name ? `｜${w.zh_name}` : ''}」（${ref.wp}，${wpDate(w)}）`;
  }
  if (ref.pause != null) {
    const p = D.pauses[ref.pause], w = p.at && D.waypoints[p.at];
    return `停頓 ${p.start} → ${p.end}${w ? `，${w.name}` : ''}（pause #${ref.pause}）`;
  }
  if (ref.feat != null) {
    const p = featById[ref.feat].properties, a = D.waypoints[p.from], b = D.waypoints[p.to];
    return `路段「${a ? a.name : p.from} → ${b ? b.name : p.to}」（${CAT[p.cat]}，第 ${p.leg} 段，${fmtDay(p.t0)} → ${fmtDay(p.t1)}）`;
  }
  if (ref.card != null) {
    const it = tour.items[ref.card];
    if (it.type === 'intro') return '導覽開場卡';
    if (it.type === 'outro') return '導覽結尾卡';
    return `導覽 ${tourLabel(ref.card)}（${it.from} → ${it.to}）`;
  }
  return '網站';
}
function openReport(ref) {
  reportRef = ref;
  $('#report-ctx').textContent = reportTarget(ref);
  $('#report-text').value = '';
  $('#report-type').selectedIndex = ref ? 0 : 4;
  const acts = [];
  if (REPORT.github) acts.push('<button type="button" data-via="github" class="primary">用 GitHub 回報</button>');
  if (REPORT.email) acts.push(`<button type="button" data-via="email"${REPORT.github ? '' : ' class="primary"'}>用 Email 回報</button>`);
  acts.push('<button type="button" data-via="copy">複製內容</button>');
  $('#report-actions').innerHTML = acts.join('');
  $('#report-note').textContent = REPORT.github
    ? `GitHub 回報需要登入 GitHub 帳號，內容會公開${REPORT.email ? '；沒有帳號可以改用 Email' : ''}。`
    : REPORT.email ? '會開啟你的郵件程式並帶入內容。' : '請複製內容後寄給網站維護者。';
  $('#report-actions').querySelectorAll('button').forEach((b) => { b.onclick = () => sendReport(b.dataset.via, b); });
  $('#report').classList.remove('hidden');
  setTimeout(() => $('#report-text').focus(), 50);
}
function closeReport() { $('#report').classList.add('hidden'); }
function reportContent() {
  const type = $('#report-type').value, target = reportTarget(reportRef), text = $('#report-text').value.trim();
  const short = target.replace(/（[^（]*$/, '').slice(0, 60);
  const ver = (document.querySelector('script[src^="app.js"]').getAttribute('src').split('v=')[1]) || '';
  return {
    title: `[${type.replace(/（.*$/, '')}] ${short}`,
    body: `**類型**：${type}\n**回報對象**：${target}\n**頁面**：${location.href.split('#')[0]}（網站版本 ${ver}）\n\n**說明**：\n${text || '（未填寫）'}\n`,
  };
}
function sendReport(via, btn) {
  const c = reportContent();
  if (via === 'github') {
    window.open(`https://github.com/${REPORT.github}/issues/new?title=${encodeURIComponent(c.title)}&body=${encodeURIComponent(c.body)}`, '_blank', 'noopener');
  } else if (via === 'email') {
    location.href = `mailto:${REPORT.email}?subject=${encodeURIComponent(c.title)}&body=${encodeURIComponent(c.body)}`;
  } else {
    const txt = `${c.title}\n\n${c.body}`;
    const done = () => { btn.textContent = '已複製 ✓'; setTimeout(() => { btn.textContent = '複製內容'; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(done, () => window.prompt('請複製以下內容', txt));
    else window.prompt('請複製以下內容', txt);
  }
}
function initReport() {
  $('#nav-report').onclick = () => openReport(null);
  $('#panel-report').onclick = () => openReport(panelRef);
  // 手機直向時資料卡會蓋住導覽頂端，資料卡上也放一顆離開導覽
  $('#panel-exit').onclick = () => { closePanel(); leaveTour(); };
  $('#report-close').onclick = closeReport;
  $('#report').onclick = (e) => { if (e.target.id === 'report') closeReport(); };
  $('#report-form').onsubmit = (e) => e.preventDefault();
}

// ---------------------------------------------------------------------------
// 檢視切換
// ---------------------------------------------------------------------------
function setView(v) {
  // 只記錄真正的頁面；其他（未設定、導覽本身）一律視為從地圖進來
  const from = document.body.dataset.view;
  if (v === 'story' && !tour.on && !tour.back) tour.back = { view: from === 'research' || from === 'about' ? from : 'map' };
  document.body.dataset.view = v;
  if (v === 'map' || v === 'story') requestAnimationFrame(() => { map.resize(); drawTimelineBase(); });
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x.dataset.view === v));
  $('#research').classList.toggle('hidden', v !== 'research');
  $('#about').classList.toggle('hidden', v !== 'about');
  if (v === 'story') enterTour();
  else if (tour.on && v === 'map') exitTour();
}
// 「離開導覽」：回到進入導覽前的地方
// - 從地圖上某個點的面板進來 → 回到那個點：鏡頭、時間還原，重新打開面板
// - 從考證／關於頁進來 → 回到該頁
// - 從地圖直接進來 → 留在導覽最後看到的位置與時間，可接著播放或探索
function leaveTour(toMap) {
  const back = tour.back && tour.back.view ? tour.back : { view: 'map' };
  if (back.view !== 'map' && !toMap) {
    setView(back.view);   // 導覽保持在背景，之後點「導覽」會回到原本的卡片
    return;
  }
  setView('map');
  if (back.panel) {
    T = back.T;
    applyTime();
    map.jumpTo(back.cam);
    const r = back.panel;
    if (r.wp) showWaypoint(r.wp, false, true);
    else if (r.pause != null) showPause(r.pause);
    else if (r.feat != null) showFeature(r.feat);
  }
}

// ---------------------------------------------------------------------------
// 導覽敘事模式（捲動驅動）
// ---------------------------------------------------------------------------
const tour = { on: false, idx: null, anim: null, items: [], progUntil: 0, startAt: null };
const isMobile = () => window.matchMedia('(max-width: 720px), (max-height: 500px) and (orientation: landscape)').matches;
const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

function buildStory() {
  const n = STORY.length;
  // 扁平化的導覽項目：開場、每章（章節卡 + 各節）、結尾；data-i 為 items 索引
  const items = [{ type: 'intro' }];
  STORY.forEach((c, ci) => {
    items.push({ type: 'chapter', ci, from: c.from, to: c.to });
    (D.story_sections[String(ci + 1)] || []).forEach((sec, si) => items.push({ type: 'section', ci, si, sec, from: sec.from, to: sec.to }));
  });
  items.push({ type: 'outro' });
  tour.items = items;
  tour.media = planCardMedia(items);

  const src = (wps) => (wps && wps.length ? `<div class="ch-src">出處：${wps.map(wpLink).join('、')}</div>` : '');
  const html = items.map((it, i) => {
    if (it.type === 'intro') {
      return `<article class="chapter" data-i="${i}">
        <h2>徒步回家，花了 28 年</h2>
        <p>1998 年，英國前傘兵 Karl Bushby 在智利南端給自己定了一條規則：<b>不使用任何交通工具推進</b>。
        因簽證、拘留、資金中斷而離開時，回來必須從停下的那一點繼續走。</p>
        <p>往下捲動，跟著地圖走完這條路。共 ${n} 章，每章再分成數節細看；點地名可以看來源與原文引述。
        灰色模糊區帶和「?」表示考證不到的部分。</p>
        <p class="ch-hint">按下方 ▼、鍵盤 ↓ 或捲動開始</p>${repBtn(i)}</article>`;
    }
    if (it.type === 'outro') {
      return `<article class="chapter" data-i="${i}">
        <h2>還沒寫完的結局</h2>
        <p>這張地圖的路線長約 ${Math.round(D.chain[D.chain.length - 1][3]).toLocaleString()} 公里，是道路推算加上直線的估計；官方說法超過 36,000 英里（約 58,000 公里），實際步行比地圖上更長。
        28 年裡，他真正在路上的時間遠少於等待的時間：在時間軸上，灰色的停頓帶比彩色的移動帶長得多。</p>
        <p>仍有許多空白有待補上：俄羅斯進入蒙古、戈壁到中國、羅馬尼亞、英格蘭內陸。
        各段的矛盾與未知列在「考證」頁。</p>
        <p><button id="story-free">開始自由探索</button></p>${repBtn(i)}</article>`;
    }
    const c = STORY[it.ci];
    if (it.type === 'chapter') {
      const secs = D.story_sections[String(it.ci + 1)] || [];
      return `<article class="chapter ch-head" data-i="${i}">
        <div class="ch-no">第 ${it.ci + 1} 章 / 共 ${n} 章${secs.length ? ` · ${secs.length} 節` : ''}</div>
        <h2>${esc(c.title)}</h2>
        <div class="ch-date">${esc(c.from)} → ${esc(c.to)}</div>
        <p>${c.text}</p>${cardMediaHtml(i)}${src(c.wps)}${repBtn(i)}</article>`;
    }
    const sec = it.sec;
    return `<article class="chapter section" data-i="${i}">
      <div class="ch-no">第 ${it.ci + 1} 章 · 第 ${it.si + 1} 節</div>
      <h3>${esc(sec.title)}</h3>
      <div class="ch-date">${esc(sec.from)} → ${esc(sec.to)}</div>
      <p>${sec.text}</p>${cardMediaHtml(i)}${src(sec.wps)}${repBtn(i)}</article>`;
  }).join('');

  $('#story').innerHTML = `
    <div class="sheet-grip"></div>
    <div class="card-head"><strong>導覽</strong>
      <select id="story-jump" title="跳到章節"><option value="0">開場</option>${STORY.map((c, ci) => `<option value="${items.findIndex((it) => it.type === 'chapter' && it.ci === ci)}">${ci + 1}. ${esc(c.title)}</option>`).join('')}<option value="${items.length - 1}">結尾</option></select>
      <button id="story-exit">離開導覽</button></div>
    <div class="story-scroll">${html}</div>
    <div class="story-nav">
      <button id="story-prev" title="上一則（↑）">▲<span class="lw"> 上一則</span></button>
      <span id="story-pos"></span>
      <button id="story-next" title="下一則（↓）"><span class="lw">下一則 </span>▼</button>
    </div>`;
  $('#story-prev').onclick = () => gotoChapter(tour.idx - 1);
  $('#story-next').onclick = () => gotoChapter(tour.idx + 1);
  $('#story-exit').onclick = () => leaveTour();
  $('#story-free').onclick = () => setView('map');
  $('#story-jump').onchange = (e) => gotoChapter(+e.target.value);
  $('#story').querySelectorAll('[data-rep]').forEach((b) => { b.onclick = () => openReport({ card: +b.dataset.rep }); });
  $('#story').querySelectorAll('[data-wp]').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); showWaypoint(a.dataset.wp, true); };
  });
  const scroller = $('#story .story-scroll');
  scroller.querySelectorAll('.chapter').forEach((c) => {
    c.addEventListener('click', (e) => {
      if (e.target.closest('a, button, select')) return;
      if (+c.dataset.i !== tour.idx) gotoChapter(+c.dataset.i);
    });
  });
  setupStoryScroll(scroller);
}

// 捲動控制：
// - 滑鼠滾輪／觸控板：一次手勢只前進或後退一則（慣性捲動不會連跳）；卡片比面板高時先在卡片內捲動
// - 觸控滑動：原生捲動 + scroll-snap-stop: always（一次最多滑過一張），停下後才切換地圖
// - 按鈕與鍵盤：直接跳到前後一則
function setupStoryScroll(sc) {
  let last = 0, lastAbs = 0, stepped = false, acc = 0;
  sc.addEventListener('wheel', (e) => {
    if (e.ctrlKey || !tour.on) return;
    e.preventDefault();
    const now = performance.now();
    const gap = now - last;
    last = now;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * sc.clientHeight : e.deltaY;
    // 跨過一則後，慣性捲動的事件會持續且遞減；要等停頓（>200 ms）或出現明顯加大的新手勢才再前進
    const abs = Math.abs(dy), rising = abs > lastAbs * 1.6 + 4;
    lastAbs = abs;
    if (stepped) {
      if (gap < 200 && !rising) return;
      stepped = false;
    }
    if (gap > 300) acc = 0;
    const card = sc.querySelector(`.chapter[data-i="${tour.idx}"]`);
    if (card && now > tour.progUntil) {
      const sr = sc.getBoundingClientRect(), cr = card.getBoundingClientRect();
      if ((dy > 0 && cr.bottom > sr.bottom + 4) || (dy < 0 && cr.top < sr.top - 4)) {
        sc.scrollBy({ top: Math.max(-120, Math.min(120, dy)), behavior: 'instant' });
        return;
      }
    }
    acc += dy;
    if (Math.abs(acc) >= 30) {
      gotoChapter(tour.idx + Math.sign(acc));
      acc = 0;
      stepped = true;
    }
  }, { passive: false });

  // 觸控捲動停下後，以面板中線所在的卡片為目前一則
  let settle = null;
  sc.addEventListener('scroll', () => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      if (!tour.on || performance.now() < tour.progUntil) return;
      const mid = sc.getBoundingClientRect().top + sc.clientHeight / 2;
      let best = null, bd = Infinity;
      sc.querySelectorAll('.chapter').forEach((c) => {
        const r = c.getBoundingClientRect();
        const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
        if (d < bd) { bd = d; best = c; }
      });
      if (best) activateChapter(+best.dataset.i);
    }, 160);
  }, { passive: true });
}

function enterTour() {
  if (tour.on) return;
  tour.on = true;
  document.body.classList.add('touring');
  setPlaying(false);
  closePanel();
  $('#legend').classList.add('hidden');
  $('#story').classList.remove('hidden');
  tour.idx = null;
  map.setPadding(tourPadding());
  sizeStorySpacer();
  const back = tour.back || {}, ex = $('#story-exit');
  const w = back.panel && back.panel.wp && D.waypoints[back.panel.wp];
  ex.textContent = back.panel ? '← 返回地點' : back.view === 'research' ? '← 返回考證' : back.view === 'about' ? '← 返回關於' : '離開導覽';
  ex.title = back.panel ? `回到剛才在地圖上查看的${w ? `「${w.zh_name || w.name}」` : back.panel.pause != null ? '停頓' : '路段'}` : '';
  const start = tour.startAt || 0;
  tour.startAt = null;
  $('#story .story-scroll').scrollTop = 0;
  if (start) gotoChapter(start, false);
  else activateChapter(0);
}

function exitTour() {
  tour.on = false;
  document.body.classList.remove('touring');
  tour.back = null;
  tour.anim = null;
  $('#story').classList.add('hidden');
  $('#legend').classList.remove('hidden');
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
}

function gotoChapter(i, smooth = true) {
  i = Math.max(0, Math.min(tour.items.length - 1, i));
  const el = $(`#story .chapter[data-i="${i}"]`);
  if (!el) return;
  // 跳很遠（下拉選單）時直接定位：長距離平滑捲動會超過鎖定時間，被「停下判定」改選中途的卡片
  if (tour.idx != null && Math.abs(i - tour.idx) > 3) smooth = false;
  activateChapter(i);
  // 程式捲動期間，不讓「停下判定」改選別張
  tour.progUntil = performance.now() + 900;
  const tall = el.offsetHeight > $('#story .story-scroll').clientHeight - 16;
  el.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant', block: tall ? 'start' : 'center' });
}

// 依導覽面板實際位置決定地圖留白：側邊面板留左側，底部抽屜留下方
function tourPadding() {
  const st = $('#story').getBoundingClientRect(), mp = $('#map').getBoundingClientRect();
  if (!st.width) return { top: 0, bottom: 0, left: 0, right: 0 };
  const bottomSheet = st.width > mp.width * 0.7;
  return bottomSheet
    ? { top: 30, left: 20, right: 20, bottom: Math.round(mp.bottom - st.top + 10) }
    : { top: 20, left: Math.round(st.right - mp.left + 20), right: 30, bottom: 20 };
}

// 讓第一張與最後一張卡片也能捲到面板中央
function sizeStorySpacer() {
  const sc = $('#story .story-scroll');
  const pad = Math.round(sc.clientHeight * 0.4);
  sc.style.paddingTop = pad + 'px';
  sc.style.paddingBottom = pad + 'px';
}

function activateChapter(i) {
  if (!tour.on || i === tour.idx) return;
  tour.idx = i;
  $('#story').querySelectorAll('.chapter').forEach((c) => c.classList.toggle('active', +c.dataset.i === i));
  const it = tour.items[i];
  $('#story-prev').disabled = i === 0;
  $('#story-next').disabled = i === tour.items.length - 1;
  $('#story-pos').textContent = it.type === 'intro' ? '開場' : it.type === 'outro' ? '結尾'
    : `第 ${it.ci + 1}/${STORY.length} 章${it.type === 'section' ? ` · 第 ${it.si + 1} 節` : ''}`;
  // 下拉選單跟著目前卡片：開場／結尾也有對應選項，避免停在上一次的章節
  $('#story-jump').value = it.ci != null ? tour.items.findIndex((x) => x.type === 'chapter' && x.ci === it.ci) : i;
  if (it.type === 'intro' || it.type === 'outro') {
    tour.anim = null;
    T = Tmax;
    applyTime();
    map.flyTo({ ...overview(), duration: 2000 });
    return;
  }
  const a = parseDay(it.from), b = parseDay(it.to);
  fitWindow(a, b);
  T = a;
  applyTime();
  const dur = Math.min(7000, Math.max(2500, (b - a) / 365 * 2500));
  tour.anim = { a, b, start: performance.now(), dur };
  requestAnimationFrame(tourTick);
}

function tourTick(now) {
  const an = tour.anim;
  if (!an || !tour.on) return;
  const p = Math.min(1, (now - an.start) / an.dur);
  const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  T = an.a + (an.b - an.a) * e;
  applyTime();
  if (p < 1) requestAnimationFrame(tourTick);
  else tour.anim = null;
}

// 依時間窗自動計算鏡頭範圍：窗內的動畫路徑點、與窗重疊的所有線段，以及窗開始時的位置
function fitWindow(a, b) {
  const pts = [stateAt(a).pos];
  for (const c of D.chain) if (c[2] >= a && c[2] <= b) pts.push([c[0], c[1]]);
  for (const f of D.features.features) {
    const p = f.properties;
    if (p.t0 <= b && p.t1 >= a) pts.push(...f.geometry.coordinates);
  }
  const ref = pts[0][0];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let [x, y] of pts) {
    while (x - ref > 180) x -= 360;
    while (x - ref < -180) x += 360;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const padding = isMobile() ? 20 : 40;
  if (x1 - x0 < 0.5 && y1 - y0 < 0.5) {
    map.flyTo({ center: [normLon((x0 + x1) / 2), (y0 + y1) / 2], zoom: 6, duration: 2000 });
    return;
  }
  map.fitBounds([[x0, y0], [x1, y1]], { padding, maxZoom: 6.5, duration: 2000 });
}
