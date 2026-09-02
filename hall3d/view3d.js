// hall3d/view3d.js
// three.js r160 の 3Dホールビュー。ビルド工程なし・ES modules前提。
//
// hall3d.html には以下の importmap を <script type="importmap"> で先に置くこと:
// {
//   "imports": {
//     "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
//     "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
//   }
// }
// このファイル自体は <script type="module" src="hall3d/view3d.js"></script> または
// app.js から `import { createView3D } from './view3d.js'` で読み込む。
//
// 意図的簡略化: 客の歩行経路は「島の外周を通るナビメッシュ」ではなく単純AABB回避+直線補間。
// 込み合った通路での重なりは許容している（見た目優先の簡易演出のため）。本格対応する場合は
// navmesh(例: three-pathfinding)を導入する。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const GRID = 0.5; // 1マス=0.5m
const CUSTOMER_COLORS = [0xffb703, 0x8ecae6, 0xfb8500, 0x219ebc, 0xffafcc, 0xa8dadc];

function seededRand(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 4294967295;
  };
}

function makeTextSprite(text, { fontSize = 48, color = '#ffffff', bg = 'rgba(0,0,0,0.55)', w = 512, h = 128 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = color;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.6, 0.4, 1);
  sprite.userData.canvas = canvas;
  sprite.userData.ctx = ctx;
  sprite.userData.tex = tex;
  return sprite;
}

function heatColor(heat) {
  // 0=青系(暇) -> 1=赤系(にぎわい)。色相のみ、数値表示なし。
  const h = THREE.MathUtils.lerp(0.58, 0.0, THREE.MathUtils.clamp(heat, 0, 1));
  const c = new THREE.Color();
  c.setHSL(h, 0.75, 0.5);
  return c;
}

export function createView3D(container, opts = {}) {
  const state = {
    layout: opts.layout || null,
    machines: opts.machines || [],
    decor: (opts.layout && opts.layout.decor) || {},
    simResult: null,
    minuteIndex: 0,
    playing: false,
    playSpeed: 1,
    mode: 'orbit',
    disposed: false,
    openHour: 10, // simResult.timelineのtは開店からの相対分。HUD表示用に絶対時刻へ変換する基準
    tour: { active: false, waypoints: [], idx: 0, travelled: 0 },
    recording: false, // 録画中はrecordVideoのtick()がカメラ/HUDを単独で駆動する(rAFループの二重更新を防ぐ)
  };

  const machineById = new Map();
  (state.machines || []).forEach(m => machineById.set(m.id, m));

  // --- renderer / scene / camera ---
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  // 一人称視点は光量不足だと真っ暗に見えるため、フィルム的トーンマッピング+露出強めで底上げする
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.5;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.display = 'block';
  renderer.domElement.tabIndex = 0;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101018);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
  camera.position.set(10, 14, 16);

  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.target.set(0, 0, 0);
  orbit.enableDamping = true;

  // 環境光を強めにベース確保し、lightingごとの係数で上乗せする(暗すぎ対策)
  const ambient = new THREE.AmbientLight(0xffffff, 0.9);
  scene.add(ambient);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x555566, 0.7);
  scene.add(hemi);
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
  dirLight.position.set(20, 30, 10);
  dirLight.castShadow = true;
  scene.add(dirLight);
  // 一人称でプレイヤーの周囲を確実に照らす追従ライト(店内灯だけでは死角が暗くなるため)
  const playerLight = new THREE.PointLight(0xfff2dd, 0.9, 14, 2);
  scene.add(playerLight);

  const worldGroup = new THREE.Group();
  scene.add(worldGroup);
  const floorGroup = new THREE.Group();
  const wallsGroup = new THREE.Group();
  const islandsGroup = new THREE.Group();
  const decorGroup = new THREE.Group();
  const customersGroup = new THREE.Group();
  const ceilingLightsGroup = new THREE.Group();
  worldGroup.add(floorGroup, wallsGroup, islandsGroup, decorGroup, customersGroup, ceilingLightsGroup);

  const slotMeshIndex = new Map(); // key "islandId:i" -> {screenMat, group}
  const islandAABBs = []; // {minX,maxX,minZ,maxZ}
  let counterAABB = null;
  let floorW = 20, floorD = 20, floorCX = 0, floorCZ = 0;

  // --- HUD overlay canvas (rendered onto a plane so it's included in captureStream) ---
  const hudCanvas = document.createElement('canvas');
  hudCanvas.width = 1024; hudCanvas.height = 128;
  const hudCtx = hudCanvas.getContext('2d');
  const hudTex = new THREE.CanvasTexture(hudCanvas);
  function drawHud() {
    const ctx = hudCtx;
    ctx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, hudCanvas.width, hudCanvas.height);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 34px sans-serif';
    ctx.textBaseline = 'middle';
    const tl = getCurrentTimeline();
    const timeStr = tl ? minutesToClock(tl.t) : '--:--';
    const inStore = tl ? tl.kpi.inStore : 0;
    const out = tl ? tl.kpi.out : 0;
    const sales = tl ? tl.kpi.sales : 0;
    ctx.fillText(`時刻 ${timeStr}   在店 ${inStore}人   累計アウト ${out.toLocaleString()}   累計売上 ¥${sales.toLocaleString()}`, 24, hudCanvas.height / 2);
    hudTex.needsUpdate = true;
  }
  const hudPlaneGeo = new THREE.PlaneGeometry(1, 1);
  const hudPlaneMat = new THREE.MeshBasicMaterial({ map: hudTex, transparent: true, depthTest: false, depthWrite: false });
  const hudMesh = new THREE.Mesh(hudPlaneGeo, hudPlaneMat);
  hudMesh.renderOrder = 999;
  scene.add(hudMesh);
  function positionHudInScreenSpace() {
    // HUDをカメラに追従させ、右上に固定表示する（近平面付近に置く簡易実装）
    const dist = 2.2;
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const heightAtDist = 2 * Math.tan(vFov / 2) * dist;
    const widthAtDist = heightAtDist * camera.aspect;
    const w = widthAtDist * 0.9;
    const h = w * (hudCanvas.height / hudCanvas.width);
    hudMesh.scale.set(w, h, 1);
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const right = new THREE.Vector3().crossVectors(camDir, camera.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, camDir).normalize();
    const center = camera.position.clone()
      .add(camDir.multiplyScalar(dist))
      .add(right.multiplyScalar(widthAtDist * 0.5 - w * 0.5 - widthAtDist * 0.03))
      .add(up.multiplyScalar(heightAtDist * 0.5 - h * 0.5 - heightAtDist * 0.03));
    hudMesh.position.copy(center);
    hudMesh.quaternion.copy(camera.quaternion);
  }

  // --- minimap (右下・DOM上のCanvas。録画には映らないが操作の目安として常時表示) ---
  const minimapCanvas = document.createElement('canvas');
  minimapCanvas.width = 140; minimapCanvas.height = 140;
  Object.assign(minimapCanvas.style, {
    position: 'absolute', right: '12px', bottom: '12px', borderRadius: '8px',
    border: '1px solid rgba(255,255,255,0.25)', background: 'rgba(10,10,14,0.6)', pointerEvents: 'none',
  });
  container.style.position = container.style.position || 'relative';
  container.appendChild(minimapCanvas);
  const mmCtx = minimapCanvas.getContext('2d');
  function drawMinimap() {
    if (!state.layout) return;
    const w = minimapCanvas.width, h = minimapCanvas.height;
    mmCtx.clearRect(0, 0, w, h);
    mmCtx.fillStyle = 'rgba(10,10,14,0.75)';
    mmCtx.fillRect(0, 0, w, h);
    const pad = 6;
    const scale = Math.min((w - pad * 2) / Math.max(floorW, 1), (h - pad * 2) / Math.max(floorD, 1));
    const ox = pad, oy = pad;
    mmCtx.fillStyle = '#3a3a44';
    mmCtx.fillRect(ox, oy, floorW * scale, floorD * scale);
    mmCtx.fillStyle = '#7a7a86';
    islandAABBs.forEach(ab => {
      mmCtx.fillRect(ox + ab.minX * scale, oy + ab.minZ * scale, (ab.maxX - ab.minX) * scale, (ab.maxZ - ab.minZ) * scale);
    });
    const dirV = new THREE.Vector3();
    camera.getWorldDirection(dirV);
    const yaw = Math.atan2(dirV.x, dirV.z);
    const cx = ox + THREE.MathUtils.clamp(camera.position.x, 0, floorW) * scale;
    const cz = oy + THREE.MathUtils.clamp(camera.position.z, 0, floorD) * scale;
    mmCtx.save();
    mmCtx.translate(cx, cz);
    mmCtx.rotate(yaw);
    mmCtx.fillStyle = '#ffcc00';
    mmCtx.beginPath();
    mmCtx.moveTo(0, -7); mmCtx.lineTo(5, 6); mmCtx.lineTo(-5, 6); mmCtx.closePath();
    mmCtx.fill();
    mmCtx.restore();
  }

  function minutesToClock(t) {
    // t はsimResult.timeline上の開店からの相対分。openHourを足して実時刻表示にする。
    const abs = (state.openHour * 60) + t;
    const h = Math.floor(abs / 60);
    const m = Math.floor(abs % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function getCurrentTimeline() {
    if (!state.simResult || !state.simResult.timeline) return null;
    const idx = THREE.MathUtils.clamp(state.minuteIndex, 0, state.simResult.timeline.length - 1);
    return state.simResult.timeline[idx];
  }

  // --- building layout ---
  function clearGroup(g) {
    while (g.children.length) {
      const c = g.children.pop();
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
        else c.material.dispose();
      }
    }
  }

  function buildFloorAndWalls() {
    clearGroup(floorGroup);
    clearGroup(wallsGroup);
    const layout = state.layout;
    if (!layout) return;
    floorW = layout.w * GRID;
    floorD = layout.d * GRID;
    floorCX = floorW / 2;
    floorCZ = floorD / 2;

    const decor = state.decor || {};
    const floorColors = { tile: 0xcfd6dd, 'carpet-red': 0x5a1b1b, 'carpet-blue': 0x1b2c5a, wood: 0x8a6240 };
    const floorColor = floorColors[decor.floorPattern] || floorColors.tile;
    const floorMat = new THREE.MeshStandardMaterial({ color: floorColor, roughness: 0.9 });
    const floorGeo = new THREE.PlaneGeometry(floorW, floorD);
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.set(floorCX, 0, floorCZ);
    floorMesh.receiveShadow = true;
    floorGroup.add(floorMesh);

    // tile grid lines for visual texture
    if (decor.floorPattern === 'tile' || !decor.floorPattern) {
      const grid = new THREE.GridHelper(Math.max(floorW, floorD), Math.max(floorW, floorD) / 2, 0x9aa4ad, 0x9aa4ad);
      grid.position.set(floorCX, 0.01, floorCZ);
      floorGroup.add(grid);
    }

    const wallColor = decor.wallColor ? new THREE.Color(decor.wallColor) : new THREE.Color(0xe8e2d6);
    const wallMat = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.8 });
    const wallH = 3.2, wallT = 0.2;
    const wallDefs = [
      { w: floorW + wallT, d: wallT, x: floorCX, z: -wallT / 2 },
      { w: floorW + wallT, d: wallT, x: floorCX, z: floorD + wallT / 2 },
      { w: wallT, d: floorD + wallT, x: -wallT / 2, z: floorCZ },
      { w: wallT, d: floorD + wallT, x: floorW + wallT / 2, z: floorCZ },
    ];
    wallDefs.forEach(w => {
      const geo = new THREE.BoxGeometry(w.w, wallH, w.d);
      const mesh = new THREE.Mesh(geo, wallMat);
      mesh.position.set(w.x, wallH / 2, w.z);
      mesh.receiveShadow = true;
      wallsGroup.add(mesh);
    });

    // counter
    counterAABB = null;
    if (layout.counter) {
      const c = layout.counter;
      const cx = c.x * GRID, cz = c.z * GRID, cw = c.w * GRID, cd = c.d * GRID;
      const geo = new THREE.BoxGeometry(cw, 1.1, cd);
      const mat = new THREE.MeshStandardMaterial({ color: 0x3a3f55 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(cx + cw / 2, 0.55, cz + cd / 2);
      mesh.castShadow = true; mesh.receiveShadow = true;
      wallsGroup.add(mesh);
      counterAABB = { minX: cx, maxX: cx + cw, minZ: cz, maxZ: cz + cd };
    }

    // entrance auto door marker
    (layout.entrance || []).forEach(e => {
      const geo = new THREE.BoxGeometry(1.6, 2.4, 0.1);
      const mat = new THREE.MeshStandardMaterial({ color: 0x7fd7ff, transparent: true, opacity: 0.35, emissive: 0x2288aa, emissiveIntensity: 0.4 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(e.x * GRID, 1.2, e.z * GRID);
      wallsGroup.add(mesh);
    });

    // lighting per decor.lighting (台の液晶・機種名が一人称でも視認できる明るさを底上げ)
    const lightingMap = {
      bright: { color: 0xffffff, intensity: 1.3, ambientMul: 1.0 },
      warm: { color: 0xffd9a0, intensity: 1.05, ambientMul: 0.85 },
      dim: { color: 0x8899cc, intensity: 0.6, ambientMul: 0.6 },
    };
    const lp = lightingMap[decor.lighting] || lightingMap.bright;
    dirLight.color.setHex(lp.color);
    dirLight.intensity = lp.intensity;
    ambient.color.setHex(lp.color);
    ambient.intensity = 0.9 * lp.ambientMul;
    hemi.intensity = 0.7 * lp.ambientMul;
    playerLight.intensity = 0.9 * lp.ambientMul;
    scene.background.setHex(decor.lighting === 'dim' ? 0x14141a : 0x1c1c26);

    // ceiling lights（視覚上の発光パネル＋実際に床面を照らす点光源）
    clearGroup(ceilingLightsGroup);
    const ceilLightMat = new THREE.MeshStandardMaterial({ color: lp.color, emissive: lp.color, emissiveIntensity: lp.intensity });
    for (let x = 2; x < floorW; x += 4) {
      for (let z = 2; z < floorD; z += 4) {
        const geo = new THREE.BoxGeometry(0.8, 0.08, 0.8);
        const mesh = new THREE.Mesh(geo, ceilLightMat);
        mesh.position.set(x, wallH - 0.05, z);
        wallsGroup.add(mesh);
        const point = new THREE.PointLight(lp.color, lp.intensity * 1.4, 7, 2);
        point.position.set(x, wallH - 0.3, z);
        ceilingLightsGroup.add(point);
      }
    }
  }

  function buildIslands() {
    clearGroup(islandsGroup);
    slotMeshIndex.clear();
    islandAABBs.length = 0;
    const layout = state.layout;
    if (!layout) return;
    const chairMat = new THREE.MeshStandardMaterial({ color: 0x2b2b33 });
    const cabinetMat = new THREE.MeshStandardMaterial({ color: 0x22242c, roughness: 0.5, metalness: 0.2 });

    (layout.islands || []).forEach(island => {
      const ix = island.x * GRID, iz = island.z * GRID;
      const iw = island.w * GRID, id = island.d * GRID;
      islandAABBs.push({ minX: ix, maxX: ix + iw, minZ: iz, maxZ: iz + id, islandId: island.id });

      const bodyGeo = new THREE.BoxGeometry(iw, 1.0, id);
      const bodyMat = new THREE.MeshStandardMaterial({ color: 0x40434f });
      const body = new THREE.Mesh(bodyGeo, bodyMat);
      body.position.set(ix + iw / 2, 0.5, iz + id / 2);
      body.castShadow = true; body.receiveShadow = true;
      islandsGroup.add(body);

      const horizontal = island.dir === 'h';
      const count = (island.slots || []).length;
      const perSide = Math.max(1, Math.ceil(count / 2));
      const span = horizontal ? iw : id;
      const step = span / perSide;

      (island.slots || []).forEach((slot, idx) => {
        const sideIdx = idx % perSide;
        const offset = step * (sideIdx + 0.5);
        const sign = slot.side === 'A' ? -1 : 1;
        const faceOffset = 0.55 * sign;
        let px, pz, ry;
        if (horizontal) {
          px = ix + offset;
          pz = iz + id / 2 + faceOffset;
          ry = slot.side === 'A' ? Math.PI : 0;
        } else {
          px = ix + iw / 2 + faceOffset;
          pz = iz + offset;
          ry = slot.side === 'A' ? -Math.PI / 2 : Math.PI / 2;
        }

        const group = new THREE.Group();
        group.position.set(px, 0, pz);
        group.rotation.y = ry;

        const cabinet = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.3, 0.5), cabinetMat);
        cabinet.position.y = 1.65;
        cabinet.castShadow = true;
        group.add(cabinet);

        const machine = slot.machineId ? machineById.get(slot.machineId) : null;

        // 貸玉種別の帯(4円=赤/1円=青/20円=黄/5円=緑)。台の識別性を上げるための帯なので数値は出さない。
        const rateColorMap = { 4: 0xd63b3b, 1: 0x2f6fd6, 20: 0xd6b52f, 5: 0x3fae5a };
        const rateColor = machine ? (rateColorMap[machine.rate] || 0x888888) : 0x3a3a42;
        const rateBand = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.06, 0.52), new THREE.MeshStandardMaterial({ color: rateColor, emissive: rateColor, emissiveIntensity: 0.3 }));
        rateBand.position.set(0, 1.02, 0);
        group.add(rateBand);

        const screenMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x000000, emissiveIntensity: 0 });
        const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.4), screenMat);
        screen.position.set(0, 1.9, 0.26);
        group.add(screen);

        // 液晶上部に機種名+稼働状態を表示するテキストスプライト(近距離でも一人称で読める大きさ)
        const label = makeTextSprite(machine ? machine.name : '空台', { fontSize: 46, w: 512, h: 160 });
        label.position.set(0, 2.5, 0.22);
        label.scale.set(1.1, 0.34, 1);
        group.add(label);

        const chair = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.4), chairMat);
        chair.position.set(0, 0.25, 0.55);
        group.add(chair);

        islandsGroup.add(group);
        slotMeshIndex.set(`${island.id}:${slot.i}`, { screenMat, group, machine });
      });

      // island end banner
      const banner = (layout.decor && layout.decor.banners || []).find(b => b.islandId === island.id);
      if (banner) {
        const sprite = makeTextSprite(banner.text, { color: '#fff', bg: banner.color || 'rgba(200,30,30,0.8)', fontSize: 52 });
        sprite.position.set(ix - 0.1, 2.15, iz + id / 2);
        sprite.scale.set(1.6, 0.4, 1);
        islandsGroup.add(sprite);
      }
    });
  }

  function buildDecorExtras() {
    clearGroup(decorGroup);
    const layout = state.layout;
    const decor = state.decor || {};
    if (!layout) return;

    if (decor.signboard && decor.signboard.text) {
      const sprite = makeTextSprite(decor.signboard.text, { fontSize: 56, bg: decor.signboard.color || 'rgba(20,20,40,0.85)' });
      sprite.position.set(floorCX, 3.4, -0.3);
      sprite.scale.set(3, 0.75, 1);
      decorGroup.add(sprite);
    }
    if (decor.ceilingPops) {
      const popTexts = ['本日開催', 'ようこそ', '新台入替'];
      let i = 0;
      islandAABBs.forEach(ab => {
        const sprite = makeTextSprite(popTexts[i % popTexts.length], { fontSize: 34, bg: 'rgba(255,150,0,0.75)' });
        sprite.position.set((ab.minX + ab.maxX) / 2, 2.9, (ab.minZ + ab.maxZ) / 2);
        sprite.scale.set(0.9, 0.35, 1);
        decorGroup.add(sprite);
        i++;
      });
    }
  }

  // --- customers ---
  const customerMeshes = new Map(); // id -> mesh

  function makeCustomer(colorIdx) {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: CUSTOMER_COLORS[colorIdx % CUSTOMER_COLORS.length] });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.7, 4, 8), bodyMat);
    body.position.y = 0.65;
    body.castShadow = true;
    g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), new THREE.MeshStandardMaterial({ color: 0xf1c27d }));
    head.position.y = 1.15;
    g.add(head);
    return g;
  }

  function syncCustomers(frac = 0) {
    const tl = getCurrentTimeline();
    const seen = new Set();
    if (tl && tl.customers) {
      // state:'walk'の客は次の分のx,zへ向けて分内を線形補間し、歩行らしい上下動を足す。
      // 'sit'は着席位置に固定、'leave'は非表示にする(将来的にengine側で完全に配列から消える想定)。
      const nextTl = state.simResult && state.simResult.timeline[state.minuteIndex + 1];
      const nextById = nextTl ? new Map(nextTl.customers.map(c => [c.id, c])) : null;
      tl.customers.forEach((c, idx) => {
        seen.add(c.id);
        let mesh = customerMeshes.get(c.id);
        if (!mesh) {
          mesh = makeCustomer(idx);
          customersGroup.add(mesh);
          customerMeshes.set(c.id, mesh);
        }
        let x = c.x, z = c.z;
        if (c.state === 'walk' && nextById) {
          const nextC = nextById.get(c.id);
          if (nextC && nextC.state !== 'leave') {
            x = THREE.MathUtils.lerp(c.x, nextC.x, frac);
            z = THREE.MathUtils.lerp(c.z, nextC.z, frac);
          }
        }
        const bob = c.state === 'walk' ? Math.abs(Math.sin(performance.now() * 0.008 + idx)) * 0.05 : 0;
        mesh.position.set(x * GRID, bob, z * GRID);
        mesh.visible = c.state !== 'leave';
        mesh.scale.y = c.state === 'sit' ? 0.7 : 1;
      });
    }
    for (const [id, mesh] of customerMeshes) {
      if (!seen.has(id)) {
        customersGroup.remove(mesh);
        customerMeshes.delete(id);
      }
    }
  }

  function syncScreens() {
    const result = state.simResult;
    if (!result || !result.perSlot) return;
    result.perSlot.forEach(slot => {
      const entry = slotMeshIndex.get(`${slot.islandId}:${slot.i}`);
      if (!entry) return;
      const active = slot.occupiedMin > 0;
      const color = heatColor(slot.heat || 0);
      entry.screenMat.emissive = color;
      entry.screenMat.emissiveIntensity = active ? 0.9 : 0.05;
      entry.screenMat.color = active ? color.clone().multiplyScalar(0.4) : new THREE.Color(0x111111);
    });
  }

  // --- first-person movement ---
  const WALK_SPEED = 3;   // m/s
  const RUN_SPEED = 6;    // m/s (Shift)
  const ACCEL = 10;       // 速度がターゲットへ収束する速さ(大きいほどキビキビ)
  const TOUR_SPEED = 2;   // m/s 自動ツアーの歩行速度
  const fp = {
    active: false,
    yaw: Math.PI, pitch: -0.05,
    pos: new THREE.Vector3(1, 1.6, 1),
    vel: new THREE.Vector3(), // 現在の水平速度(m/s)。目標速度へなめらかに収束させる
    keys: new Set(),
    dragging: false,
    lastX: 0, lastY: 0,
    stick: { active: false, dx: 0, dy: 0, id: null },
    forwardHeld: false, // スマホの「▲進む」ボタン
  };

  function collidesWithObstacles(x, z) {
    // 島とカウンターだけ衝突対象(壁はfloorW/floorDの範囲クランプで別途止める)
    const r = 0.3;
    for (const ab of islandAABBs) {
      if (x + r > ab.minX && x - r < ab.maxX && z + r > ab.minZ && z - r < ab.maxZ) return true;
    }
    if (counterAABB) {
      const ab = counterAABB;
      if (x + r > ab.minX && x - r < ab.maxX && z + r > ab.minZ && z - r < ab.maxZ) return true;
    }
    return false;
  }

  // 意図的簡略化: 通路経路はナビメッシュではなく「各島の外周を1.2mのオフセットで通る折れ線」の
  // 簡易導出。島同士が近接する複雑な配置では通路が重なる場合がある(safePointで軽い回避のみ)。
  // 本格対応する場合はnavmesh(例: three-pathfinding)でグラフ探索する。
  function safeTourPoint(x, z) {
    x = THREE.MathUtils.clamp(x, 0.4, floorW - 0.4);
    z = THREE.MathUtils.clamp(z, 0.4, floorD - 0.4);
    if (!collidesWithObstacles(x, z)) return { x, z };
    for (let i = 1; i <= 8; i++) {
      const nx = THREE.MathUtils.clamp(x + (x >= floorCX ? i * 0.3 : -i * 0.3), 0.4, floorW - 0.4);
      if (!collidesWithObstacles(nx, z)) return { x: nx, z };
    }
    return { x, z };
  }

  function buildTourWaypoints() {
    const layout = state.layout;
    if (!layout) return [];
    const entrance = layout.entrance && layout.entrance[0];
    const ex = entrance ? entrance.x * GRID : 1;
    const ez = entrance ? entrance.z * GRID : 1;
    const startDx = floorCX - ex, startDz = floorCZ - ez;
    const startYaw = Math.atan2(startDx, startDz);
    const inward = new THREE.Vector3(Math.sin(startYaw), 0, Math.cos(startYaw)).multiplyScalar(1.0);
    const start = safeTourPoint(ex + inward.x, ez + inward.z);

    const pts = [start];
    const sorted = islandAABBs.slice().sort((a, b) => (a.minX - b.minX) || (a.minZ - b.minZ));
    let dir = 1;
    sorted.forEach(ab => {
      const laneX = ab.minX - 0.9;
      const zTop = ab.minZ - 0.6;
      const zBot = ab.maxZ + 0.6;
      const p1 = safeTourPoint(laneX, dir > 0 ? zTop : zBot);
      const p2 = safeTourPoint(laneX, dir > 0 ? zBot : zTop);
      pts.push(p1, p2);
      dir *= -1;
    });
    pts.push(start);
    return pts;
  }

  function startTourInternal() {
    state.tour.waypoints = buildTourWaypoints();
    state.tour.idx = 0;
    state.tour.travelled = 0;
    state.tour.active = state.tour.waypoints.length >= 2;
    orbit.enabled = false;
  }

  function updateTour(dt) {
    const tour = state.tour;
    if (!tour.active || tour.waypoints.length < 2) return false;
    if (tour.idx >= tour.waypoints.length - 1) { tour.active = false; return false; }
    const a = tour.waypoints[tour.idx], b = tour.waypoints[tour.idx + 1];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z) || 0.001;
    tour.travelled += TOUR_SPEED * Math.min(dt, 0.1);
    let t = tour.travelled / segLen;
    if (t >= 1) {
      tour.idx++;
      tour.travelled = 0;
      t = 0;
      if (tour.idx >= tour.waypoints.length - 1) { tour.active = false; }
    }
    const cx = THREE.MathUtils.lerp(a.x, b.x, THREE.MathUtils.clamp(t, 0, 1));
    const cz = THREE.MathUtils.lerp(a.z, b.z, THREE.MathUtils.clamp(t, 0, 1));
    const baseYaw = Math.atan2(b.x - a.x, b.z - a.z);
    const wobble = Math.sin(performance.now() * 0.0015) * 0.3; // 歩きながら軽く首を振る演出
    const dirVec = new THREE.Vector3(Math.sin(baseYaw + wobble), 0, Math.cos(baseYaw + wobble));
    camera.position.set(cx, 1.5, cz);
    camera.lookAt(cx + dirVec.x, 1.5, cz + dirVec.z);
    return true;
  }

  function onKeyDown(e) { fp.keys.add(e.code); }
  function onKeyUp(e) { fp.keys.delete(e.code); }
  function isPointerLocked() { return document.pointerLockElement === renderer.domElement; }
  function onPointerDown(e) {
    if (state.mode !== 'fp') return;
    // PCはクリックでPointer Lockに入る(ドラッグ操作はロック不可環境へのフォールバック)
    if (renderer.domElement.requestPointerLock && !isPointerLocked() && e.pointerType !== 'touch') {
      Promise.resolve(renderer.domElement.requestPointerLock()).catch(()=>{});
    }
    fp.dragging = true; fp.lastX = e.clientX; fp.lastY = e.clientY;
  }
  function onPointerMove(e) {
    if (state.mode !== 'fp') return;
    if (isPointerLocked()) {
      fp.yaw -= (e.movementX || 0) * 0.0028;
      fp.pitch = THREE.MathUtils.clamp(fp.pitch - (e.movementY || 0) * 0.0028, -1.2, 1.2);
      return;
    }
    if (!fp.dragging) return;
    const dx = e.clientX - fp.lastX, dy = e.clientY - fp.lastY;
    fp.lastX = e.clientX; fp.lastY = e.clientY;
    fp.yaw -= dx * 0.004;
    fp.pitch = THREE.MathUtils.clamp(fp.pitch - dy * 0.004, -1.2, 1.2);
  }
  function onPointerUp() { fp.dragging = false; }

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // touch virtual stick (bottom-left) + swipe look (right side)
  let stickBase = null, stickKnob = null, touchLookId = null, touchLookLast = null;
  function buildTouchUI() {
    stickBase = document.createElement('div');
    Object.assign(stickBase.style, {
      position: 'absolute', left: '20px', bottom: '20px', width: '110px', height: '110px',
      borderRadius: '50%', background: 'rgba(255,255,255,0.15)', touchAction: 'none', display: 'none',
    });
    stickKnob = document.createElement('div');
    Object.assign(stickKnob.style, {
      position: 'absolute', left: '35px', top: '35px', width: '40px', height: '40px',
      borderRadius: '50%', background: 'rgba(255,255,255,0.5)',
    });
    stickBase.appendChild(stickKnob);
    container.style.position = container.style.position || 'relative';
    container.appendChild(stickBase);

    // 画面下中央「▲進む」ボタン(押し続けで前進。左スティック/矢印キーと併用可)
    forwardBtn = document.createElement('button');
    forwardBtn.textContent = '▲進む';
    Object.assign(forwardBtn.style, {
      position: 'absolute', left: '50%', bottom: '20px', transform: 'translateX(-50%)',
      width: '84px', height: '54px', borderRadius: '10px', border: 'none',
      background: 'rgba(255,255,255,0.25)', color: '#fff', fontSize: '13px', fontWeight: '700',
      touchAction: 'none', display: 'none', userSelect: 'none',
    });
    const setForward = (v) => { fp.forwardHeld = v; };
    forwardBtn.addEventListener('touchstart', (e) => { e.preventDefault(); setForward(true); }, { passive: false });
    forwardBtn.addEventListener('touchend', (e) => { e.preventDefault(); setForward(false); }, { passive: false });
    forwardBtn.addEventListener('touchcancel', () => setForward(false));
    forwardBtn.addEventListener('pointerdown', () => setForward(true));
    forwardBtn.addEventListener('pointerup', () => setForward(false));
    forwardBtn.addEventListener('pointerleave', () => setForward(false));
    container.appendChild(forwardBtn);
  }
  let forwardBtn = null;
  buildTouchUI();

  function handleTouchStart(e) {
    if (state.mode !== 'fp') return;
    for (const t of e.changedTouches) {
      const rect = container.getBoundingClientRect();
      const localX = t.clientX - rect.left;
      if (localX < rect.width * 0.4 && fp.stick.id === null) {
        fp.stick.active = true; fp.stick.id = t.identifier;
        fp.stick.originX = t.clientX; fp.stick.originY = t.clientY;
        fp.stick.dx = 0; fp.stick.dy = 0;
      } else if (touchLookId === null) {
        touchLookId = t.identifier;
        touchLookLast = { x: t.clientX, y: t.clientY };
      }
    }
  }
  function handleTouchMove(e) {
    if (state.mode !== 'fp') return;
    for (const t of e.changedTouches) {
      if (t.identifier === fp.stick.id) {
        const dx = t.clientX - fp.stick.originX, dy = t.clientY - fp.stick.originY;
        const max = 50;
        fp.stick.dx = THREE.MathUtils.clamp(dx / max, -1, 1);
        fp.stick.dy = THREE.MathUtils.clamp(dy / max, -1, 1);
        if (stickKnob) stickKnob.style.transform = `translate(${fp.stick.dx * 25}px, ${fp.stick.dy * 25}px)`;
      } else if (t.identifier === touchLookId && touchLookLast) {
        const dx = t.clientX - touchLookLast.x, dy = t.clientY - touchLookLast.y;
        touchLookLast = { x: t.clientX, y: t.clientY };
        fp.yaw -= dx * 0.005;
        fp.pitch = THREE.MathUtils.clamp(fp.pitch - dy * 0.005, -1.2, 1.2);
      }
    }
  }
  function handleTouchEnd(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === fp.stick.id) { fp.stick.active = false; fp.stick.id = null; fp.stick.dx = 0; fp.stick.dy = 0; if (stickKnob) stickKnob.style.transform = ''; }
      if (t.identifier === touchLookId) { touchLookId = null; touchLookLast = null; }
    }
  }
  renderer.domElement.addEventListener('touchstart', handleTouchStart, { passive: true });
  renderer.domElement.addEventListener('touchmove', handleTouchMove, { passive: true });
  renderer.domElement.addEventListener('touchend', handleTouchEnd, { passive: true });

  function updateFP(dt) {
    let mx = 0, mz = 0;
    if (fp.keys.has('KeyW') || fp.keys.has('ArrowUp')) mz -= 1;
    if (fp.keys.has('KeyS') || fp.keys.has('ArrowDown')) mz += 1;
    if (fp.keys.has('KeyA') || fp.keys.has('ArrowLeft')) mx -= 1;
    if (fp.keys.has('KeyD') || fp.keys.has('ArrowRight')) mx += 1;
    if (fp.stick.active) { mx += fp.stick.dx; mz += fp.stick.dy; }
    if (fp.forwardHeld) mz -= 1;
    const len = Math.hypot(mx, mz);
    if (len > 0.001) { mx /= len; mz /= len; }

    const running = fp.keys.has('ShiftLeft') || fp.keys.has('ShiftRight');
    const targetSpeed = (mx !== 0 || mz !== 0) ? (running ? RUN_SPEED : WALK_SPEED) : 0;
    const forward = new THREE.Vector3(Math.sin(fp.yaw), 0, Math.cos(fp.yaw));
    const right = new THREE.Vector3(Math.cos(fp.yaw), 0, -Math.sin(fp.yaw));
    const targetVel = new THREE.Vector3()
      .addScaledVector(forward, -mz * targetSpeed)
      .addScaledVector(right, mx * targetSpeed);

    // 目標速度へ指数的に収束させ、発進・停止をなめらかにする
    const accelT = 1 - Math.exp(-ACCEL * dt);
    fp.vel.lerp(targetVel, accelT);

    const nx = fp.pos.x + fp.vel.x * dt, nz = fp.pos.z + fp.vel.z * dt;
    if (!collidesWithObstacles(nx, fp.pos.z)) fp.pos.x = THREE.MathUtils.clamp(nx, 0.3, floorW - 0.3);
    else fp.vel.x = 0;
    if (!collidesWithObstacles(fp.pos.x, nz)) fp.pos.z = THREE.MathUtils.clamp(nz, 0.3, floorD - 0.3);
    else fp.vel.z = 0;

    camera.position.set(fp.pos.x, fp.pos.y, fp.pos.z);
    const dir = new THREE.Vector3(Math.sin(fp.yaw) * Math.cos(fp.pitch), Math.sin(fp.pitch), Math.cos(fp.yaw) * Math.cos(fp.pitch));
    camera.lookAt(fp.pos.x + dir.x, fp.pos.y + dir.y, fp.pos.z + dir.z);
  }

  function enterFPMode() {
    const entrance = state.layout && state.layout.entrance && state.layout.entrance[0];
    const ex = entrance ? entrance.x * GRID : 1;
    const ez = entrance ? entrance.z * GRID : 1;
    // 店内奥(フロア中心)へ向くyawを算出し、入口から1m内側に進んだ位置からスタートする
    const dx = floorCX - ex, dz = floorCZ - ez;
    const yaw = Math.atan2(dx, dz);
    const inward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(1.0);
    fp.pos.set(
      THREE.MathUtils.clamp(ex + inward.x, 0.3, floorW - 0.3),
      1.5,
      THREE.MathUtils.clamp(ez + inward.z, 0.3, floorD - 0.3)
    );
    fp.yaw = yaw;
    fp.pitch = -0.05;
    fp.vel.set(0, 0, 0);
    orbit.enabled = false;
    if (stickBase) stickBase.style.display = 'block';
    if (forwardBtn) forwardBtn.style.display = 'block';
  }
  function enterOrbitMode() {
    orbit.enabled = true;
    if (stickBase) stickBase.style.display = 'none';
    if (forwardBtn) forwardBtn.style.display = 'none';
    fp.forwardHeld = false;
    if (isPointerLocked()) document.exitPointerLock();
  }

  // --- resize ---
  function doResize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => doResize()) : null;
  if (resizeObserver) resizeObserver.observe(container);
  window.addEventListener('resize', doResize);

  // --- fullscreen ---
  function toggleFullscreen() {
    const isFull = document.fullscreenElement === container || container.classList.contains('pseudo-fullscreen');
    if (isFull) {
      if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); }
      container.classList.remove('pseudo-fullscreen');
    } else if (container.requestFullscreen) {
      container.requestFullscreen().catch(() => { container.classList.add('pseudo-fullscreen'); });
    } else {
      container.classList.add('pseudo-fullscreen'); // requestFullscreen非対応環境(一部スマホ)向けの疑似全画面
    }
    setTimeout(doResize, 60);
  }
  function onFullscreenChange() { setTimeout(doResize, 60); }
  document.addEventListener('fullscreenchange', onFullscreenChange);

  // --- animation loop ---
  let lastTime = performance.now();
  let playAccum = 0;
  function animate() {
    if (state.disposed) return;
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    if (state.playing && state.simResult) {
      playAccum += dt * state.playSpeed * 6; // 6 sim-minutes/sec base at speed=1
      while (playAccum >= 1) {
        playAccum -= 1;
        state.minuteIndex = Math.min(state.minuteIndex + 1, state.simResult.timeline.length - 1);
      }
      syncCustomers(playAccum);
      syncScreens();
      if (state.minuteIndex >= state.simResult.timeline.length - 1) state.playing = false;
    }

    if (!state.recording) {
      const touring = updateTour(dt);
      if (!touring) {
        if (state.mode === 'fp') {
          updateFP(dt);
        } else {
          orbit.update();
        }
      }
      playerLight.position.set(camera.position.x, camera.position.y + 0.5, camera.position.z);
      drawHud();
      positionHudInScreenSpace();
    }
    drawMinimap();
    renderer.render(scene, camera);
  }

  function rebuildAll() {
    buildFloorAndWalls();
    buildIslands();
    buildDecorExtras();
    syncScreens();
    syncCustomers();
    if (state.layout) {
      orbit.target.set(floorCX, 0, floorCZ);
      camera.position.set(floorCX + floorW * 0.4, Math.max(floorW, floorD) * 0.5, floorCZ + floorD * 0.6);
    }
  }

  doResize();
  if (state.layout) rebuildAll();
  animate();

  // --- video recording ---
  function pickMimeType() {
    const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (const c of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  }

  function recordVideo({ speed = 10, cameraTour = false, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      if (!state.simResult) { reject(new Error('simResult not set')); return; }
      if (!renderer.domElement.captureStream) { reject(new Error('captureStream unsupported')); return; }
      const stream = renderer.domElement.captureStream(30);
      const mimeType = pickMimeType();
      let recorder;
      try {
        recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      } catch (err) { reject(err); return; }
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      recorder.onerror = (e) => { state.recording = false; reject(e.error || new Error('recorder error')); };
      recorder.onstop = () => {
        state.playing = false;
        state.recording = false;
        resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
      };

      const prevMode = state.mode;
      const totalMinutes = state.simResult.timeline.length;
      state.minuteIndex = 0;
      state.playing = false;
      state.recording = true;

      if (cameraTour) startTourInternal();
      let elapsed = 0;
      const frameDt = 1 / 30;
      recorder.start();

      const tick = () => {
        if (state.disposed) { try { recorder.stop(); } catch (e) {} return; }
        elapsed += frameDt;
        const simMinutesPerSec = 6 * speed;
        const simMinuteFloat = Math.min(totalMinutes - 1, elapsed * simMinutesPerSec);
        state.minuteIndex = Math.floor(simMinuteFloat);
        syncCustomers(simMinuteFloat - state.minuteIndex);
        syncScreens();

        if (cameraTour) {
          if (!state.tour.active) startTourInternal(); // 一周し終えたらループして最後まで動き続ける
          updateTour(frameDt);
        } else if (state.mode !== 'fp') {
          orbit.update();
        }
        playerLight.position.set(camera.position.x, camera.position.y + 0.5, camera.position.z);
        drawHud();
        positionHudInScreenSpace();

        if (typeof onProgress === 'function') {
          onProgress(state.minuteIndex / (totalMinutes - 1));
        }

        if (state.minuteIndex >= totalMinutes - 1) {
          setTimeout(() => {
            try { recorder.stop(); } catch (e) {}
            state.mode = prevMode;
            state.tour.active = false;
          }, 200);
          return;
        }
        setTimeout(tick, 1000 / 30);
      };
      tick();
    });
  }

  const view = {
    setLayout(layout) {
      state.layout = layout;
      if (layout && layout.decor) state.decor = layout.decor;
      machineById.clear();
      (state.machines || []).forEach(m => machineById.set(m.id, m));
      rebuildAll();
    },
    setDecor(decor) {
      state.decor = decor || {};
      if (state.layout) state.layout.decor = state.decor;
      buildFloorAndWalls();
      buildDecorExtras();
    },
    setResult(simResult, meta) {
      state.simResult = simResult;
      state.minuteIndex = 0;
      // openHourはsimResult.dayParams.openHour / meta.openHour / layout.dayParams / 既定10 の優先順で解決
      const oh = (meta && meta.openHour) ?? (simResult && simResult.dayParams && simResult.dayParams.openHour) ?? state.openHour ?? 10;
      state.openHour = oh;
      syncScreens();
      syncCustomers();
    },
    setTime(minuteIndex) {
      if (!state.simResult) return;
      state.minuteIndex = THREE.MathUtils.clamp(minuteIndex, 0, state.simResult.timeline.length - 1);
      syncCustomers();
      syncScreens();
    },
    play(speed = 1) {
      state.playSpeed = speed;
      state.playing = true;
    },
    pause() {
      state.playing = false;
    },
    setMode(mode) {
      if (mode === state.mode) return;
      state.mode = mode;
      if (mode === 'fp') enterFPMode();
      else enterOrbitMode();
    },
    recordVideo,
    resize() { doResize(); },
    startTour() { startTourInternal(); },
    stopTour() { state.tour.active = false; },
    isTouring() { return state.tour.active; },
    toggleFullscreen,
    dispose() {
      state.disposed = true;
      if (resizeObserver) resizeObserver.disconnect();
      window.removeEventListener('resize', doResize);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('touchstart', handleTouchStart);
      renderer.domElement.removeEventListener('touchmove', handleTouchMove);
      renderer.domElement.removeEventListener('touchend', handleTouchEnd);
      clearGroup(floorGroup); clearGroup(wallsGroup); clearGroup(islandsGroup); clearGroup(decorGroup); clearGroup(customersGroup); clearGroup(ceilingLightsGroup);
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      if (stickBase && stickBase.parentNode) stickBase.parentNode.removeChild(stickBase);
      if (forwardBtn && forwardBtn.parentNode) forwardBtn.parentNode.removeChild(forwardBtn);
      if (minimapCanvas && minimapCanvas.parentNode) minimapCanvas.parentNode.removeChild(minimapCanvas);
    },
  };

  if (state.layout) rebuildAll();

  return view;
}
