// hall3d/app.js — 結線
import { createEditor, TEMPLATES } from './editor.js';
import { simulate } from './engine.js';
import { MACHINES } from './machines.js';

const $ = (id) => document.getElementById(id);

const canvas = $('editorCanvas');
const editor = createEditor(canvas, {
  onChange: (layout) => { lastResult = null; saveToLocalStorage(); },
  onHover: (info, clientX, clientY) => showTooltip(info, clientX, clientY),
});

let lastResult = null;
let compareResult = null; // A/B比較用
let view3d = null;

function fmt(n){ return Math.round(n).toLocaleString('ja-JP'); }

// ---- 装飾パネル ----
function refreshDecorForm(){
  const layout = editor.getLayout();
  const decor = layout.decor || {};
  $('inFloor').value = decor.floorPattern || 'tile';
  $('inWallColor').value = decor.wallColor || '#1a1a22';
  $('inLighting').value = decor.lighting || 'bright';
  $('inSignText').value = (decor.signboard && decor.signboard.text) || 'AIホール';
  $('inBannerText').value = (decor.banners && decor.banners[0] && decor.banners[0].text) || '';
  $('inBannerColor').value = (decor.banners && decor.banners[0] && decor.banners[0].color) || '#ff2d55';
  $('inCeilingPops').checked = !!decor.ceilingPops;
}

function applyDecorFromForm(){
  const layout = editor.getLayout();
  const bannerText = $('inBannerText').value.trim();
  const bannerColor = $('inBannerColor').value;
  layout.decor = {
    wallColor: $('inWallColor').value,
    floorPattern: $('inFloor').value,
    lighting: $('inLighting').value,
    signboard: { text: $('inSignText').value, color: '#ff2d55' },
    banners: bannerText ? layout.islands.map(isl => ({ islandId: isl.id, text: bannerText, color: bannerColor })) : [],
    ceilingPops: $('inCeilingPops').checked,
  };
  if (view3d) view3d.setDecor(layout.decor);
  saveToLocalStorage();
}

['inFloor', 'inWallColor', 'inLighting', 'inSignText', 'inBannerText', 'inBannerColor', 'inCeilingPops'].forEach(id => {
  $(id).addEventListener('input', applyDecorFromForm);
  $(id).addEventListener('change', applyDecorFromForm);
});

function showTooltip(info, clientX, clientY){
  const tip = $('tooltip');
  if (!info) { tip.style.display = 'none'; return; }
  const m = MACHINES.find(mm => mm.id === info.machineId);
  tip.style.display = 'block';
  tip.style.left = (clientX + 12) + 'px';
  tip.style.top = (clientY + 12) + 'px';
  tip.innerHTML = `<b>${m ? m.name : '(空き)'}</b><br>稼働率 ${(info.heat * 100).toFixed(0)}%<br>OUT ${fmt(info.out)}<br>売上 ¥${fmt(info.sales)}<br>来店 ${info.visits}人`;
}

function readDayParams(){
  return {
    tradeAreaPop: parseInt($('inPop').value, 10) || 50000,
    rivals: Math.max(0, parseInt($('inRivals').value, 10) || 0),
    weekday: parseInt($('inDow').value, 10),
    event: $('inEvent').value,
    openHour: 10, closeHour: 23,
    seed: parseInt($('inSeed').value, 10) || 42,
    baseUtilization: (parseInt($('inBaseUtil').value, 10) || 35) / 100,
    salesRatio: (parseInt($('inSalesRatio').value, 10) || 24) / 100,
  };
}

$('inBaseUtil').addEventListener('input', (e) => { $('baseUtilLabel').textContent = e.target.value + '%'; });
$('inSalesRatio').addEventListener('input', (e) => { $('salesRatioLabel').textContent = e.target.value + '%'; });

function renderSummary(res){
  const s = res.summary;
  $('kpiVisitors').textContent = fmt(s.visitors);
  $('kpiPeak').textContent = fmt(s.peakInStore) + '人 (' + s.peakHour + '時台)';
  $('kpiOut').textContent = fmt(s.totalOut);
  $('kpiSales').textContent = '¥' + fmt(s.totalSales);
  $('kpiProfit').textContent = '¥' + fmt(s.grossProfit);
  $('kpiStay').textContent = fmt(s.avgStayMin) + '分';
  $('kpiUtil').textContent = (s.utilization * 100).toFixed(1) + '%';
}

async function runSimulation(){
  const layout = editor.getLayout();
  const dayParams = readDayParams();
  const t0 = performance.now();
  const res = simulate({ layout, machines: MACHINES, dayParams });
  const t1 = performance.now();
  lastResult = res;
  renderSummary(res);
  editor.setHeatmap(res.perSlot);
  $('perfNote').textContent = `計算時間: ${(t1 - t0).toFixed(0)}ms（${layout.islands.reduce((a, i) => a + i.slots.filter(s => s.machineId).length, 0)}台 / ${res.minutes}分）`;
  if (view3d) {
    view3d.setLayout(layout);
    view3d.setDecor(layout.decor);
    view3d.setResult(res, { openHour: dayParams.openHour });
  }
}

function runCompare(){
  if (!lastResult) return;
  const layoutB = JSON.parse(JSON.stringify(editor.getLayout()));
  compareResult = simulate({ layout: layoutB, machines: MACHINES, dayParams: readDayParams() });
  const a = lastResult.summary, b = compareResult.summary;
  const rows = [
    ['来店客数', a.visitors, b.visitors],
    ['総OUT', a.totalOut, b.totalOut],
    ['総売上', a.totalSales, b.totalSales],
    ['粗利', a.grossProfit, b.grossProfit],
    ['稼働率', (a.utilization * 100).toFixed(1) + '%', (b.utilization * 100).toFixed(1) + '%'],
  ];
  $('compareTable').innerHTML = '<tr><th>指標</th><th>A(現在)</th><th>B(再計算)</th><th>差分</th></tr>' +
    rows.map(([label, av, bv]) => {
      const diff = (typeof av === 'number' && typeof bv === 'number') ? fmt(bv - av) : '-';
      return `<tr><td>${label}</td><td>${typeof av === 'number' ? fmt(av) : av}</td><td>${typeof bv === 'number' ? fmt(bv) : bv}</td><td>${diff}</td></tr>`;
    }).join('');
}

function saveToLocalStorage(){
  try { localStorage.setItem('hall3d_layout', JSON.stringify(editor.getLayout())); } catch (e) { /* noop */ }
}

function loadFromLocalStorage(){
  try {
    const raw = localStorage.getItem('hall3d_layout');
    if (raw) { editor.loadLayout(JSON.parse(raw)); return true; }
  } catch (e) { /* noop */ }
  return false;
}

function exportJSON(){
  const blob = new Blob([JSON.stringify(editor.getLayout(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'hall3d-layout.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importJSON(file){
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const layout = JSON.parse(reader.result);
      editor.loadLayout(layout);
      lastResult = null;
      refreshDecorForm();
      if (view3d) { view3d.setLayout(editor.getLayout()); view3d.setDecor(editor.getLayout().decor); }
      saveToLocalStorage();
    } catch (e) { alert('JSONの読み込みに失敗しました'); }
  };
  reader.readAsText(file);
}

// ---- 3Dビュー読み込み(未完成でも2D部分は動くようにする) ----
async function initView3D(){
  const el = $('view3dContainer');
  try {
    const mod = await import('./view3d.js');
    view3d = mod.createView3D(el, { layout: editor.getLayout(), machines: MACHINES });
    view3d.setDecor(editor.getLayout().decor);
    $('view3dStatus').style.display = 'none';
    window.addEventListener('resize', () => view3d && view3d.resize());
  } catch (e) {
    console.warn('view3d.js not ready:', e);
    $('view3dStatus').style.display = 'block';
    $('view3dStatus').textContent = '3Dビュー準備中…（2Dエディタとシミュレーションは利用できます）';
  }
}

// ---- UIイベント配線 ----
$('btnAddIsland').addEventListener('click', () => editor.addIsland());
$('btnRemoveIsland').addEventListener('click', () => editor.removeSelected());
$('btnRotateIsland').addEventListener('click', () => editor.rotateSelected());
$('btnRun').addEventListener('click', runSimulation);
$('btnCompare').addEventListener('click', runCompare);
$('btnExport').addEventListener('click', exportJSON);
$('btnImport').addEventListener('click', () => $('fileImport').click());
$('fileImport').addEventListener('change', (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); });

document.querySelectorAll('.templateBtn').forEach(btn => {
  btn.addEventListener('click', () => {
    editor.loadTemplate(btn.dataset.template);
    lastResult = null;
    refreshDecorForm();
    if (view3d) { view3d.setLayout(editor.getLayout()); view3d.setDecor(editor.getLayout().decor); }
  });
});

// 3D再生コントロール（view3d未接続時は何もしない）
$('btnPlay').addEventListener('click', () => view3d && lastResult && view3d.play(parseFloat($('inSpeed').value)));
$('btnPause').addEventListener('click', () => view3d && view3d.pause());
$('inTimeline').addEventListener('input', (e) => {
  if (view3d && lastResult) view3d.setTime(Math.round(parseFloat(e.target.value) * (lastResult.minutes - 1)));
});
$('btnModeOrbit').addEventListener('click', () => view3d && view3d.setMode('orbit'));
$('btnModeFP').addEventListener('click', () => view3d && view3d.setMode('fp'));
$('btnTour').addEventListener('click', () => {
  if (!view3d) return;
  if (view3d.isTouring && view3d.isTouring()) view3d.stopTour();
  else view3d.startTour();
});
$('btnFullscreen').addEventListener('click', () => view3d && view3d.toggleFullscreen());
$('btnRecord').addEventListener('click', async () => {
  if (!view3d) return;
  $('recordStatus').textContent = '録画準備中…';
  try {
    const blob = await view3d.recordVideo({ speed: parseFloat($('inSpeed').value), cameraTour: true, onProgress: (p) => { $('recordStatus').textContent = `録画中… ${(p * 100).toFixed(0)}%`; } });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'hall3d.webm'; a.click();
    URL.revokeObjectURL(url);
    $('recordStatus').textContent = '完了しました';
  } catch (e) {
    $('recordStatus').textContent = '録画に失敗しました（3Dビュー準備中の可能性）';
  }
});

// ---- 初期化 ----
if (!loadFromLocalStorage()) {
  editor.loadTemplate('mid320');
}
editor.render();
refreshDecorForm();
initView3D();
