// hall3d/editor.js — 2Dレイアウト編集UI（canvas）
// 島の追加/削除/移動/回転、スロットへの機種割当、入口/カウンター移動、
// 稼働率ヒートマップ表示、テンプレ3種の読み込みを提供する。
import { MACHINES } from './machines.js';

const GRID = 0.5; // 1マス=0.5m
const SCALE = 12; // 1マスあたりの描画px

// ---- テンプレ3種 ----
// 島=横向き10連(5台×両面)を基本単位とし、行×列で敷き詰める。
// 新台(popularity高)は先頭側(=入口寄り)の島から順に割り当てる。
function buildTemplateLayout(seatTarget){
  const perIsland = 10; // 1島=5マス×両面2列=10台
  const islandsNeeded = Math.ceil(seatTarget / perIsland);
  const cols = Math.max(1, Math.round(Math.sqrt(islandsNeeded * 1.4)));
  const rows = Math.ceil(islandsNeeded / cols);
  const islandW = 10, islandD = 4; // グリッド単位
  const gapX = 6, gapY = 6;
  const marginX = 6, marginY = 10; // 入口側に余白
  const w = marginX * 2 + cols * islandW + (cols - 1) * gapX;
  const d = marginY * 2 + rows * (islandD + gapY);

  const sortedMachines = [...MACHINES].sort((a, b) => b.popularity - a.popularity);
  const islands = [];
  let id = 0;
  let placed = 0;
  for (let r = 0; r < rows && placed < islandsNeeded; r++) {
    for (let c = 0; c < cols && placed < islandsNeeded; c++) {
      const x = marginX + c * (islandW + gapX) + islandW / 2;
      const z = marginY + r * (islandD + gapY) + islandD / 2;
      const slots = [];
      const seatsInThisIsland = Math.min(perIsland, seatTarget - placed * perIsland);
      const perSide = perIsland / 2;
      for (let i = 0; i < perSide; i++) {
        const machineA = sortedMachines[(id * perIsland + i * 2) % sortedMachines.length];
        const machineB = sortedMachines[(id * perIsland + i * 2 + 1) % sortedMachines.length];
        slots.push({ i, machineId: machineA.id, side: 'A' });
        slots.push({ i, machineId: machineB.id, side: 'B' });
      }
      islands.push({ id: 'isl' + (id++), x, z, w: islandW, d: islandD, dir: 'h', slots });
      placed++;
    }
  }

  return {
    w, d,
    entrance: [{ x: w / 2, z: 1 }],
    counter: { x: w - 6, z: 2, w: 8, d: 3 },
    islands,
    decor: { wallColor: '#1a1a22', floorPattern: 'tile', lighting: 'bright', banners: [], signboard: { text: 'AIホール', color: '#ff2d55' }, ceilingPops: false },
  };
}

export const TEMPLATES = {
  small120: { label: '駅前小型120台', build: () => buildTemplateLayout(120) },
  mid320: { label: '郊外中型320台', build: () => buildTemplateLayout(320) },
  large500: { label: '大型500台', build: () => buildTemplateLayout(500) },
};

function emptyLayout(){
  return buildTemplateLayout(120);
}

export function createEditor(canvas, opts = {}){
  const ctx = canvas.getContext('2d');
  let layout = opts.layout || emptyLayout();
  let heatmap = null; // Map<key, {heat,out,sales,visits}>
  let selectedIslandId = null;
  let drag = null; // {type:'island'|'entrance'|'counter', startX, startZ, origX, origZ}
  const onChange = opts.onChange || (() => {});
  const onHover = opts.onHover || (() => {});

  const picker = document.createElement('select');
  picker.style.position = 'absolute';
  picker.style.display = 'none';
  picker.style.zIndex = '50';
  picker.style.fontSize = '13px';
  (canvas.parentElement || document.body).style.position = (canvas.parentElement && getComputedStyle(canvas.parentElement).position !== 'static') ? undefined : 'relative';
  (canvas.parentElement || document.body).appendChild(picker);

  function toPx(v){ return v * SCALE; }
  function toGrid(px){ return px / SCALE; }

  function slotPosition(island, slot){
    const count = island.slots.length;
    const along = count > 1 ? (slot.i / (count - 1) - 0.5) : 0;
    if (island.dir === 'h') {
      return { x: island.x + along * island.w, z: island.z + (slot.side === 'A' ? -island.d / 2 : island.d / 2) };
    }
    return { x: island.x + (slot.side === 'A' ? -island.w / 2 : island.w / 2), z: island.z + along * island.d };
  }

  function heatColor(heat){
    // 寒色(未稼働)→暖色(高稼働)のグラデーション
    const r = Math.round(60 + heat * (255 - 60));
    const g = Math.round(60 + (1 - heat) * 40);
    const b = Math.round(120 * (1 - heat) + 30);
    return `rgb(${r},${g},${b})`;
  }

  function render(){
    canvas.width = toPx(layout.w);
    canvas.height = toPx(layout.d);
    ctx.fillStyle = '#111116';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#22222c';
    ctx.lineWidth = 1;
    for (let x = 0; x <= layout.w; x += 2) { ctx.beginPath(); ctx.moveTo(toPx(x), 0); ctx.lineTo(toPx(x), canvas.height); ctx.stroke(); }
    for (let z = 0; z <= layout.d; z += 2) { ctx.beginPath(); ctx.moveTo(0, toPx(z)); ctx.lineTo(canvas.width, toPx(z)); ctx.stroke(); }

    // 入口
    for (const en of (layout.entrance || [])) {
      ctx.fillStyle = '#3ddc84';
      ctx.fillRect(toPx(en.x) - 10, toPx(en.z) - 6, 20, 12);
      ctx.fillStyle = '#0c0c10';
      ctx.font = '10px sans-serif';
      ctx.fillText('入口', toPx(en.x) - 12, toPx(en.z) + 22);
    }
    // カウンター
    if (layout.counter) {
      const c = layout.counter;
      ctx.fillStyle = '#ffd60a';
      ctx.fillRect(toPx(c.x - c.w / 2), toPx(c.z - c.d / 2), toPx(c.w), toPx(c.d));
      ctx.fillStyle = '#0c0c10';
      ctx.fillText('受付', toPx(c.x - c.w / 2) + 4, toPx(c.z));
    }

    // 島
    for (const island of layout.islands) {
      const x0 = toPx(island.x - island.w / 2), z0 = toPx(island.z - island.d / 2);
      ctx.fillStyle = island.id === selectedIslandId ? '#2a2a38' : '#1c1c24';
      ctx.strokeStyle = island.id === selectedIslandId ? '#ff2d55' : '#2a2a33';
      ctx.lineWidth = island.id === selectedIslandId ? 2 : 1;
      ctx.fillRect(x0, z0, toPx(island.w), toPx(island.d));
      ctx.strokeRect(x0, z0, toPx(island.w), toPx(island.d));

      for (const slot of island.slots) {
        const p = slotPosition(island, slot);
        const key = island.id + '#' + slot.i + '#' + slot.side;
        const hm = heatmap && heatmap.get(key);
        const m = MACHINES.find(mm => mm.id === slot.machineId);
        let color = '#3a3a46';
        if (hm) color = heatColor(hm.heat);
        else if (m) color = m.kind === 'P' ? '#3d5ddc' : '#dc7a3d';
        ctx.fillStyle = slot.machineId ? color : '#232329';
        const size = 5;
        ctx.fillRect(toPx(p.x) - size, toPx(p.z) - size, size * 2, size * 2);
      }
    }
  }

  function findSlotAt(px, pz){
    const gx = toGrid(px), gz = toGrid(pz);
    for (const island of layout.islands) {
      for (const slot of island.slots) {
        const p = slotPosition(island, slot);
        if (Math.hypot(p.x - gx, p.z - gz) < 1.0) return { island, slot };
      }
    }
    return null;
  }

  function findIslandAt(px, pz){
    const gx = toGrid(px), gz = toGrid(pz);
    for (const island of layout.islands) {
      if (gx >= island.x - island.w / 2 && gx <= island.x + island.w / 2 && gz >= island.z - island.d / 2 && gz <= island.z + island.d / 2) return island;
    }
    return null;
  }

  function openPicker(clientX, clientY, applyFn){
    picker.innerHTML = '<option value="">(空き)</option>' +
      '<optgroup label="P機">' + MACHINES.filter(m => m.kind === 'P').map(m => `<option value="${m.id}">${m.name}</option>`).join('') + '</optgroup>' +
      '<optgroup label="S機">' + MACHINES.filter(m => m.kind === 'S').map(m => `<option value="${m.id}">${m.name}</option>`).join('') + '</optgroup>';
    const rect = canvas.getBoundingClientRect();
    picker.style.left = (clientX - rect.left) + 'px';
    picker.style.top = (clientY - rect.top) + 'px';
    picker.style.display = 'block';
    picker.focus();
    const onChangeOnce = () => {
      applyFn(picker.value || null);
      picker.style.display = 'none';
      picker.removeEventListener('change', onChangeOnce);
      picker.removeEventListener('blur', onBlur);
      render();
      onChange(layout);
    };
    const onBlur = () => { picker.style.display = 'none'; picker.removeEventListener('change', onChangeOnce); picker.removeEventListener('blur', onBlur); };
    picker.addEventListener('change', onChangeOnce);
    picker.addEventListener('blur', onBlur);
  }

  canvas.addEventListener('mousedown', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left, pz = ev.clientY - rect.top;
    const slotHit = findSlotAt(px, pz);
    if (slotHit && ev.shiftKey) {
      // shift+クリック: 島ごと一括で機種を割り当て
      openPicker(ev.clientX, ev.clientY, (machineId) => {
        for (const s of slotHit.island.slots) s.machineId = machineId;
      });
      return;
    }
    if (slotHit) {
      openPicker(ev.clientX, ev.clientY, (machineId) => { slotHit.slot.machineId = machineId; });
      return;
    }
    const island = findIslandAt(px, pz);
    if (island) {
      selectedIslandId = island.id;
      drag = { type: 'island', island, startX: toGrid(px), startZ: toGrid(pz), origX: island.x, origZ: island.z };
      render();
      return;
    }
    for (const en of (layout.entrance || [])) {
      if (Math.hypot(toGrid(px) - en.x, toGrid(pz) - en.z) < 1.5) { drag = { type: 'entrance', target: en, startX: toGrid(px), startZ: toGrid(pz), origX: en.x, origZ: en.z }; return; }
    }
    if (layout.counter) {
      const c = layout.counter;
      if (Math.abs(toGrid(px) - c.x) < c.w / 2 && Math.abs(toGrid(pz) - c.z) < c.d / 2) { drag = { type: 'counter', target: c, startX: toGrid(px), startZ: toGrid(pz), origX: c.x, origZ: c.z }; return; }
    }
    selectedIslandId = null;
    render();
  });

  window.addEventListener('mousemove', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left, pz = ev.clientY - rect.top;
    if (drag) {
      const dx = toGrid(px) - drag.startX, dz = toGrid(pz) - drag.startZ;
      const nx = Math.round((drag.origX + dx) / GRID) * GRID;
      const nz = Math.round((drag.origZ + dz) / GRID) * GRID;
      if (drag.type === 'island') { drag.island.x = Math.max(0, nx); drag.island.z = Math.max(0, nz); }
      else { drag.target.x = Math.max(0, nx); drag.target.z = Math.max(0, nz); }
      render();
      return;
    }
    if (heatmap) {
      const hit = findSlotAt(px, pz);
      if (hit) {
        const key = hit.island.id + '#' + hit.slot.i + '#' + hit.slot.side;
        const hm = heatmap.get(key);
        onHover(hm ? { island: hit.island, slot: hit.slot, ...hm } : null, ev.clientX, ev.clientY);
        return;
      }
    }
    onHover(null, ev.clientX, ev.clientY);
  });

  window.addEventListener('mouseup', () => {
    if (drag) { drag = null; onChange(layout); }
  });

  return {
    render,
    getLayout(){ return layout; },
    loadLayout(l){ layout = l; selectedIslandId = null; heatmap = null; render(); },
    loadTemplate(name){
      const t = TEMPLATES[name];
      if (!t) return;
      layout = t.build();
      selectedIslandId = null; heatmap = null;
      render();
      onChange(layout);
    },
    addIsland(){
      const id = 'isl' + Date.now().toString(36);
      const slots = [];
      for (let i = 0; i < 5; i++) { slots.push({ i, machineId: null, side: 'A' }); slots.push({ i, machineId: null, side: 'B' }); }
      layout.islands.push({ id, x: 8, z: 8, w: 10, d: 4, dir: 'h', slots });
      selectedIslandId = id;
      render();
      onChange(layout);
    },
    removeSelected(){
      if (!selectedIslandId) return;
      layout.islands = layout.islands.filter(i => i.id !== selectedIslandId);
      selectedIslandId = null;
      render();
      onChange(layout);
    },
    rotateSelected(){
      const island = layout.islands.find(i => i.id === selectedIslandId);
      if (!island) return;
      island.dir = island.dir === 'h' ? 'v' : 'h';
      const tmp = island.w; island.w = island.d; island.d = tmp;
      render();
      onChange(layout);
    },
    setHeatmap(perSlot){
      if (!perSlot) { heatmap = null; render(); return; }
      heatmap = new Map(perSlot.map(s => [s.islandId + '#' + s.i + '#' + s.side, s]));
      render();
    },
  };
}
