import assert from 'node:assert/strict';
import test from 'node:test';
import { installRyomaruCorner, loadRyomaruMachines, ryomaruCatalog } from '../ryomaru.js';
import { TEMPLATES } from '../editor.js';
import { MACHINES } from '../machines.js';
import { simulate } from '../engine.js';

const entries = Array.from({ length: 8 }, (_, i) => ({ slug: `new-${i}`, name: `新台${i}`, type: 'P' }));
const savedCopy = layout => JSON.parse(JSON.stringify(layout));
const allSlots = layout => layout.islands.flatMap(island => island.slots);
const corner = layout => layout.islands.find(island => island.id === layout.ryomaruCorner?.islandId);
const installed = layout => allSlots(layout).filter(slot => slot.ryomaru);

test('① 一覧0件・両方の取得失敗でも元の機種に戻り、コーナー情報が消える', async () => {
  let requests = 0;
  const data = await loadRyomaruMachines(async () => { requests++; throw new Error('offline'); });
  assert.equal(requests, 2);
  assert.deepEqual(data, { machines: [], source: 'unavailable' });
  const invalid = await loadRyomaruMachines(async () => ({ ok: true, json: async () => [{}] }));
  assert.deepEqual(invalid.machines, []);

  for (const reason of ['load', 'import', 'edit']) {
    const layout = TEMPLATES.small120.build();
    const original = savedCopy(layout);
    installRyomaruCorner(layout, entries);
    assert.equal(installed(layout).length, 8);
    assert.equal(installRyomaruCorner(layout, data.machines, { reason }), true);
    assert.deepEqual(layout, original);
    assert.equal(installRyomaruCorner(layout, [], { reason }), false);
  }
  const empty = { w: 40, d: 30, islands: [], ryomaruCorner: { islandId: 'missing' } };
  installRyomaruCorner(empty, []);
  assert.equal(empty.ryomaruCorner, undefined);
  assert.deepEqual(empty.islands, []);
});

test('② 利用者が変えた台と対象外の印は保存・再読み込み後も残り、残りの台で埋める', () => {
  // 旧版の保存データ（印なし）と、編集時に印を付けたデータの両方を確認。
  for (const recordEdit of [false, true]) {
    let layout = TEMPLATES.small120.build();
    installRyomaruCorner(layout, entries);
    const islandId = corner(layout).id;
    const changes = installed(layout).slice(0, 3).map((slot, i) => {
      slot.machineId = ['s01', null, 'p02'][i];
      return { i: slot.i, side: slot.side, machineId: slot.machineId };
    });
    if (recordEdit) installRyomaruCorner(layout, entries, { reason: 'edit' });
    for (const reason of ['load', 'import', 'load']) {
      layout = savedCopy(layout);
      installRyomaruCorner(layout, entries, { reason });
      assert.equal(corner(layout).id, islandId);
      assert.equal(installed(layout).length, 7); // 10台中3台を対象外にしたので8台未満。
      for (const change of changes) {
        const slot = corner(layout).slots.find(s => s.i === change.i && s.side === change.side);
        assert.equal(slot.machineId, change.machineId);
        assert.equal(slot.ryomaruOptOut, true);
        assert.equal(slot.ryomaru, undefined);
      }
    }
    // 対象外の台が増えても別の島にはみ出して埋めない。
    for (const slot of installed(layout)) slot.machineId = 's02';
    installRyomaruCorner(layout, entries);
    assert.equal(installed(layout).length, 0);
    assert.equal(layout.ryomaruCorner, undefined);
    assert.equal(allSlots(layout).filter(s => s.ryomaruOptOut).length, 10);
  }
  const layout = TEMPLATES.small120.build();
  installRyomaruCorner(layout, entries);
  const changed = installed(layout)[0];
  changed.machineId = null;
  installRyomaruCorner(layout, []);
  assert.equal(changed.machineId, null);
  assert.equal(changed.ryomaruOptOut, true);
});

test('③ 編集による島の削除はコーナーを無効にし、他の島・空の配置を変えない', () => {
  for (const available of [entries, null]) {
    const layout = TEMPLATES.small120.build();
    installRyomaruCorner(layout, entries);
    const islandId = corner(layout).id;
    layout.islands = layout.islands.filter(island => island.id !== islandId);
    const remaining = savedCopy(layout.islands);
    installRyomaruCorner(layout, available, { reason: 'edit' });
    assert.equal(layout.ryomaruCornerDisabled, true);
    assert.equal(layout.ryomaruCorner, undefined);
    assert.deepEqual(layout.islands, remaining);
    for (const reason of ['load', 'import']) {
      const reloaded = savedCopy(layout);
      installRyomaruCorner(reloaded, entries, { reason });
      assert.deepEqual(reloaded, layout);
    }
    layout.islands = [];
    installRyomaruCorner(layout, available, { reason: 'edit' });
    installRyomaruCorner(layout, entries, { reason: 'load' });
    assert.deepEqual(layout.islands, []);
  }
  // 一覧取得前の新規配置でも、全島削除を尊重する。
  const empty = { w: 40, d: 30, islands: [] };
  installRyomaruCorner(empty, null, { reason: 'edit' });
  installRyomaruCorner(empty, entries);
  assert.deepEqual(empty.islands, []);
  assert.equal(empty.ryomaruCornerDisabled, true);

  const layout = TEMPLATES.small120.build();
  const original = savedCopy(layout);
  assert.equal(installRyomaruCorner(layout, entries, { reason: 'edit' }), false);
  assert.deepEqual(layout, original); // 通常の編集を新規導入の契機にしない。
  installRyomaruCorner(layout, entries);
  corner(layout).z += 30;
  corner(layout).dir = 'v';
  const moved = savedCopy(layout);
  installRyomaruCorner(layout, entries, { reason: 'edit' });
  assert.deepEqual(layout, moved);
});

test('④ テンプレート切替は無効の旗を下ろし、入口寄りに再導入する', () => {
  for (const template of Object.values(TEMPLATES)) {
    const layout = template.build();
    layout.ryomaruCornerDisabled = true;
    installRyomaruCorner(layout, entries, { reason: 'template' });
    assert.equal(layout.ryomaruCornerDisabled, undefined);
    assert.equal(installed(layout).length, 8);
    const entrance = layout.entrance[0];
    const distance = island => Math.hypot(
      Math.max(island.x - entrance.x, 0, entrance.x - island.x - island.w),
      Math.max(island.z - entrance.z, 0, entrance.z - island.z - island.d));
    assert.equal(distance(corner(layout)), Math.min(...layout.islands.map(distance)));
    assert.equal(installed(layout).filter(slot => slot.side === 'A').length, 5);
    // 登録した新台がシミュレーションでも着席対象になることを確認。
    const result = simulate({ layout, machines: [...MACHINES, ...ryomaruCatalog(entries, MACHINES)], dayParams: { seed: 42 } });
    const newSlots = result.perSlot.filter(slot => slot.machineId.startsWith('ryomaru-'));
    assert.equal(newSlots.length, 8);
    assert.ok(newSlots.every(slot => slot.visits > 0));
  }
  const pending = TEMPLATES.small120.build();
  pending.ryomaruCornerDisabled = true;
  installRyomaruCorner(pending, null, { reason: 'template' });
  assert.equal(pending.ryomaruCornerDisabled, undefined);
  installRyomaruCorner(pending, entries);
  assert.equal(installed(pending).length, 8);
});
