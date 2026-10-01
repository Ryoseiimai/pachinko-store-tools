// 両丸水産の公開一覧と入口の新台コーナー。DOM・three.jsに依存しない。
export const MACHINE_ROOT = 'https://ryoseiimai.github.io/ai-pachinko-maker/machines/';
export const INDEX_URL = MACHINE_ROOT + 'index.json';
export const BACKUP_URL = new URL('./ryomaru-machines.json', import.meta.url).href;
export const MAX_NEW_MACHINES = 8;

export function normalizeMachines(data) {
  if (!Array.isArray(data)) throw new Error('機種一覧は配列が必要です');
  const rows = data.flatMap((row, index) => {
    if (!row || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.slug)
      || typeof row.name !== 'string' || !row.name.trim()
      || typeof row.type !== 'string' || !row.type.trim()
      || typeof row.low_prob !== 'number' || !Number.isFinite(row.low_prob) || row.low_prob <= 0) return [];
    let url;
    try { url = new URL(row.url); } catch { return []; }
    // 公開機種のURLだけをリンクに使う（外部データはHTMLに埋め込まない）。
    if (url.origin !== new URL(MACHINE_ROOT).origin || url.username || url.password
      || !url.pathname.startsWith(new URL(MACHINE_ROOT).pathname + row.slug + '/')) return [];
    const published = [row.published, row.published_at, row.publishedAt, row.date, row.created_at]
      .map(value => typeof value === 'string' ? Date.parse(value) : NaN).find(Number.isFinite) ?? null;
    return [{ slug: row.slug, name: row.name.trim(), type: row.type.trim(),
      low_prob: row.low_prob, url: url.href, published, index }];
  });
  // 日付のある項目を降順、日付なし・同日付は配列の後ろを優先する。
  rows.sort((a, b) => (b.published ?? -Infinity) - (a.published ?? -Infinity) || b.index - a.index);
  const seen = new Set();
  return rows.filter(row => !seen.has(row.slug) && seen.add(row.slug))
    .slice(0, MAX_NEW_MACHINES).map(({ index, ...row }) => row);
}

export async function loadRyomaruMachines(fetcher = globalThis.fetch, timeoutMs = 5000) {
  for (const url of [INDEX_URL, BACKUP_URL]) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('機種一覧を取得できません');
      const machines = normalizeMachines(await response.json());
      if (!machines.length) throw new Error('有効な機種がありません');
      return { machines, source: url === INDEX_URL ? 'remote' : 'backup' };
    } catch { /* 次に同梱の控えを読む。両方失敗した場合も既存ホールは利用可能。 */ }
    finally { clearTimeout(timeout); }
  }
  return { machines: [], source: 'unavailable' };
}

export function ryomaruCatalog(entries, baseMachines) {
  // 既存のP新台の値をそのまま継承し、営業モデルの係数・既存機種は変更しない。
  const base = baseMachines.filter(m => m.kind === 'P').reduce((a, b) => a.popularity >= b.popularity ? a : b);
  return entries.map(entry => ({ ...base, id: 'ryomaru-' + entry.slug, name: entry.name,
    genre: entry.type, ryomaru: entry }));
}

// view3dの既存の描画座標（グリッド単位）に合わせて、入口側の面を優先する。
export function displaySlotPosition(island, slot) {
  const perSide = Math.max(1, Math.ceil(island.slots.length / 2));
  const offset = (island.slots.indexOf(slot) % perSide + 0.5) / perSide;
  const sign = slot.side === 'A' ? -1 : 1;
  return island.dir === 'h'
    ? { x: island.x + island.w * offset, z: island.z + island.d / 2 + 1.1 * sign }
    : { x: island.x + island.w / 2 + 1.1 * sign, z: island.z + island.d * offset };
}

// entries === null は一覧の取得中。編集の記録だけ行い、導入・復元は取得後に行う。
export function installRyomaruCorner(layout, entries, { reason = 'load' } = {}) {
  let changed = false;
  const oldIsland = layout.islands.find(island => island.id === layout.ryomaruCorner?.islandId);
  if (reason === 'template' && layout.ryomaruCornerDisabled) {
    delete layout.ryomaruCornerDisabled;
    changed = true;
  }
  if (reason === 'edit' && ((layout.ryomaruCorner && !oldIsland) || !layout.islands.length)) {
    delete layout.ryomaruCorner;
    layout.ryomaruCornerDisabled = true;
    changed = true;
  }
  const restore = entries !== null && (reason !== 'edit' || !entries.length || layout.ryomaruCornerDisabled);
  for (const island of layout.islands) for (const slot of island.slots) {
    if (slot.ryomaru) {
      if (slot.machineId !== slot.ryomaru.machineId) {
        slot.ryomaruOptOut = true;
        delete slot.ryomaru;
        changed = true;
      } else if (restore) {
        slot.machineId = slot.ryomaru.originalMachineId;
        delete slot.ryomaru;
        changed = true;
      }
    }
  }
  // 編集では自動導入しない。移動・回転を維持し、削除したコーナーを別の島へ移さない。
  if (entries === null || (reason === 'edit' && entries.length && !layout.ryomaruCornerDisabled)) return changed;
  if (layout.ryomaruCorner) {
    delete layout.ryomaruCorner;
    changed = true;
  }
  if (!entries.length || layout.ryomaruCornerDisabled || reason === 'edit') return changed;
  const entrance = layout.entrance?.[0] || { x: layout.w / 2, z: 1 };
  const distance = island => {
    const x = Math.max(island.x, Math.min(entrance.x, island.x + island.w));
    const z = Math.max(island.z, Math.min(entrance.z, island.z + island.d));
    return Math.hypot(x - entrance.x, z - entrance.z);
  };
  let island = layout.islands.filter(i => i.slots.length).sort((a, b) => distance(a) - distance(b))[0];
  if (!island) {
    const w = Math.min(10, layout.w - 2), d = Math.min(4, layout.d - 2);
    if (w <= 0 || d <= 0) return changed;
    let id = 'ryomaru-entrance', suffix = 1;
    while (layout.islands.some(i => i.id === id)) id = 'ryomaru-entrance-' + suffix++;
    island = { id, x: Math.max(1, Math.min(layout.w - w - 1, entrance.x - w / 2)),
      z: Math.max(1, Math.min(layout.d - d - 1, entrance.z + 5)), w, d, dir: 'h', slots: [] };
    for (let i = 0; i < 5; i++) for (const side of ['A', 'B']) island.slots.push({ i, side, machineId: null });
    layout.islands.push(island);
  }
  const horizontal = island.dir === 'h';
  const nearSide = (horizontal ? entrance.z < island.z + island.d / 2 : entrance.x < island.x + island.w / 2) ? 'A' : 'B';
  const slots = island.slots.filter(slot => !slot.ryomaruOptOut).sort((a, b) => {
    const pa = displaySlotPosition(island, a), pb = displaySlotPosition(island, b);
    return Number(b.side === nearSide) - Number(a.side === nearSide)
      || (horizontal ? pa.x - pb.x : pa.z - pb.z);
  });
  if (!slots.length) return changed;
  entries.slice(0, Math.min(MAX_NEW_MACHINES, slots.length)).forEach((entry, index) => {
    const slot = slots[index], machineId = 'ryomaru-' + entry.slug;
    slot.ryomaru = { originalMachineId: slot.machineId, machineId };
    slot.machineId = machineId;
  });
  layout.ryomaruCorner = { islandId: island.id };
  return true;
}
