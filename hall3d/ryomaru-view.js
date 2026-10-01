import * as THREE from 'three';
import { MACHINE_ROOT } from './ryomaru.js';

function textTexture(text, width, height, background, fontSize) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  // 長い機種名も横幅に収める。縦長の代替筐体では折り返す。
  const lines = width < height ? text.match(/.{1,9}/gu) || [''] : [text];
  ctx.font = `bold ${fontSize}px sans-serif`;
  lines.forEach((line, i) => ctx.fillText(line, width / 2,
    height / 2 + (i - (lines.length - 1) / 2) * fontSize * 1.4, width - 32));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createRyomaruDisplay({ container, renderer, camera, world, onOpen }) {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  const cabinetTextures = new Map();
  const machineResources = new Set();
  const signResources = new Set();
  let disposed = false, pointerStart = null;
  const track = (resources, resource) => { resources.add(resource); return resource; };
  const release = resources => { resources.forEach(resource => resource.dispose()); resources.clear(); };

  const reticle = document.createElement('div');
  reticle.className = 'ryomaru-reticle';
  reticle.textContent = '+ ';
  const hint = document.createElement('span');
  hint.textContent = 'E：新台を調べる'; reticle.append(hint);
  reticle.hidden = true;
  container.append(reticle);

  const card = document.createElement('section');
  card.className = 'ryomaru-card'; card.hidden = true;
  card.setAttribute('aria-label', '両丸水産の機種情報');
  const title = document.createElement('strong');
  const type = document.createElement('div');
  const probability = document.createElement('div');
  const actions = document.createElement('div'); actions.className = 'ryomaru-card-actions';
  const link = document.createElement('a');
  link.textContent = '機種ページを見る'; link.target = '_blank'; link.rel = 'noopener noreferrer';
  const closeButton = document.createElement('button');
  closeButton.type = 'button'; closeButton.textContent = '閉じる';
  actions.append(link, closeButton); card.append(title, type, probability, actions);
  container.append(card);

  function close() { card.hidden = true; renderer.domElement.focus({ preventScroll: true }); }
  closeButton.addEventListener('click', close);
  function isLocked() { return document.pointerLockElement === renderer.domElement; }
  function syncReticle() { reticle.hidden = !isLocked(); }
  document.addEventListener('pointerlockchange', syncReticle);

  function hitAt(clientX, clientY, centered = false) {
    if (centered) pointer.set(0, 0);
    else {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1);
    }
    camera.updateMatrixWorld(); world.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, camera);
    // 最前面だけを調べ、壁・他の島越しの選択を防ぐ。HUDはworldに含まれない。
    const hit = raycaster.intersectObject(world, true)[0];
    for (let object = hit?.object; object && object !== world; object = object.parent) {
      if (object.userData.ryomaru) return object.userData.ryomaru;
    }
    return null;
  }
  function open(entry) {
    if (!entry) return;
    onOpen();
    if (isLocked()) document.exitPointerLock();
    title.textContent = entry.name;
    type.textContent = entry.type;
    probability.textContent = '大当り確率：1/' + entry.low_prob;
    link.href = entry.url;
    card.hidden = false;
    closeButton.focus({ preventScroll: true });
  }
  function onPointerDown(event) {
    if (!event.isPrimary || event.button !== 0 || isLocked()) { pointerStart = null; return; }
    pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false,
      entry: hitAt(event.clientX, event.clientY) };
  }
  function onPointerMove(event) {
    if (pointerStart?.id === event.pointerId
      && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 8) pointerStart.moved = true;
  }
  function onPointerUp(event) {
    const start = pointerStart; pointerStart = null;
    if (start?.id !== event.pointerId || start.moved || !start.entry || isLocked()) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
    if (hitAt(event.clientX, event.clientY)?.slug === start.entry.slug) open(start.entry);
  }
  function onPointerCancel() { pointerStart = null; }
  function onKeyDown(event) {
    if (event.code === 'KeyE' && isLocked() && !event.repeat) {
      event.preventDefault(); event.stopImmediatePropagation(); open(hitAt(0, 0, true));
    } else if (event.code === 'Escape' && !card.hidden) close();
  }
  renderer.domElement.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('keydown', onKeyDown, true);

  function cabinetTexture(entry) {
    if (cabinetTextures.has(entry.slug)) return cabinetTextures.get(entry.slug).texture;
    const texture = textTexture(entry.name, 512, 1587, '#341c26', 42);
    const cached = { texture, loading: null };
    cabinetTextures.set(entry.slug, cached);
    cached.loading = loader.load(MACHINE_ROOT + entry.slug + '/images/cabinet.jpg', loaded => {
      if (!disposed) {
        // 比率を保って筐体の正面に収める。同じTextureを更新し、再構築にも追従する。
        const canvas = texture.image, ctx = canvas.getContext('2d');
        const scale = Math.min(canvas.width / loaded.image.width, canvas.height / loaded.image.height);
        const width = loaded.image.width * scale, height = loaded.image.height * scale;
        ctx.fillStyle = '#15151b'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(loaded.image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        texture.needsUpdate = true;
      }
      loaded.dispose(); cached.loading = null;
    }, undefined, () => { cached.loading?.dispose(); cached.loading = null; });
    return texture;
  }

  return {
    isMachineAt: (x, y) => !!hitAt(x, y),
    isOpen: () => !card.hidden,
    beginMachines() { card.hidden = true; pointerStart = null; release(machineResources); },
    addMachine(group, entry) {
      group.userData.ryomaru = entry;
      const texture = cabinetTexture(entry);
      const material = track(machineResources, new THREE.MeshBasicMaterial({ map: texture }));
      const geometry = track(machineResources, new THREE.PlaneGeometry(0.4, 1.24));
      const panel = new THREE.Mesh(geometry, material);
      panel.position.set(0, 1.65, 0.275); group.add(panel);
      const badgeTexture = track(machineResources, textTexture('新台', 256, 128, '#cf172b', 72));
      const badge = new THREE.Mesh(track(machineResources, new THREE.PlaneGeometry(0.42, 0.21)),
        track(machineResources, new THREE.MeshBasicMaterial({ map: badgeTexture, side: THREE.DoubleSide })));
      badge.position.set(0, 2.85, 0.27); group.add(badge);
    },
    beginSigns() { release(signResources); },
    addSign(group, layout, entry) {
      if (!entry) return;
      const entrance = layout.entrance?.[0] || { x: layout.w / 2, z: 1 };
      const texture = track(signResources, textTexture('新台入替｜両丸水産『' + entry.name + '』', 2048, 256, '#b5192b', 76));
      // 両面に別の面を置いて、外側・内側のどちらからも文字が正方向で見える。
      const geometry = track(signResources, new THREE.PlaneGeometry(7, 0.875));
      const material = track(signResources, new THREE.MeshBasicMaterial({ map: texture }));
      for (const side of [-1, 1]) {
        const sign = new THREE.Mesh(geometry, material);
        sign.position.set(entrance.x * 0.5, 4.35, entrance.z * 0.5 + side * 0.025);
        sign.rotation.y = side < 0 ? Math.PI : 0;
        group.add(sign);
      }
    },
    dispose() {
      disposed = true; release(machineResources); release(signResources);
      cabinetTextures.forEach(({ texture, loading }) => { texture.dispose(); loading?.dispose(); });
      cabinetTextures.clear();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerlockchange', syncReticle);
      card.remove(); reticle.remove();
    },
  };
}
