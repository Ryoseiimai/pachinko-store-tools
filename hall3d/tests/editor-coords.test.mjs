import assert from 'node:assert/strict';
import test from 'node:test';
import { clientToGrid, createEditor, TEMPLATES } from '../editor.js';

const fixtures = [
  { name: 'small120', width: 420, height: 300, clickX: 360, expected: { x: 60, z: 40 } },
  { name: 'mid320', width: 472, height: 280, clickX: 432, expected: { x: 108, z: 60 } },
  // 縦横で異なる縮小率もそれぞれ換算する。
  { name: 'large500', width: 536, height: 270, clickX: 496, expected: { x: 124, z: 80 } },
];

for (const { name, width, height, clickX, expected } of fixtures) {
  test(`${TEMPLATES[name].label}: 表示サイズと内部解像度が違ってもグリッド位置が一致する`, () => {
    const layout = TEMPLATES[name].build();
    const rect = { left: 53.5, top: 121.25, width, height };
    const convert = (x, y) => clientToGrid(x, y, rect, layout.w * 12, layout.d * 12);
    assert.notEqual(width, layout.w * 12);
    assert.notEqual(height, layout.d * 12);
    assert.deepEqual(convert(rect.left, rect.top), { x: 0, z: 0 });
    assert.deepEqual(convert(rect.left + width, rect.top + height), { x: layout.w, z: layout.d });
    assert.deepEqual(convert(rect.left + clickX, rect.top + 240), expected);
    assert.deepEqual(convert(rect.left + width / 2, rect.top + height / 2), { x: layout.w / 2, z: layout.d / 2 });
    // ドラッグの丸めは操作側で行う。換算時は小数・canvas外の座標を保持する。
    const fractional = convert(rect.left + width / 8, rect.top - height / 8);
    assert.deepEqual(fractional, { x: layout.w / 8, z: -layout.d / 8 });
  });
}

// Node用の最小DOM。実ブラウザの描画やネイティブ選択UIは対象外。
function setupEditor(t) {
  class Element extends EventTarget {
    style = {};
    children = [];
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); }
    replaceChildren(...children) { this.children = children; }
    focus() { this.focused = true; }
  }
  const win = new EventTarget();
  const parent = new Element();
  const canvas = new Element();
  const rect = { left: 40, top: 80, width: 472, height: 210 };
  const context = Object.fromEntries(['fillRect', 'strokeRect', 'fillText', 'beginPath', 'moveTo', 'lineTo', 'stroke'].map(name => [name, () => {}]));
  const captures = new Set();
  Object.assign(canvas, {
    parentElement: parent,
    getContext: () => context,
    getBoundingClientRect: () => rect,
    setPointerCapture: id => captures.add(id),
    hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id),
  });
  const globals = {
    window: win,
    document: { createElement: () => new Element() },
    getComputedStyle: () => ({ position: 'relative' }),
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
  };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }
  const layout = TEMPLATES.mid320.build();
  const changes = [], hovers = [];
  const editor = createEditor(canvas, { layout, onChange: value => changes.push(value), onHover: value => hovers.push(value) });
  editor.render();
  function pointer(target, type, x, z, extra = {}) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, {
      clientX: rect.left + x / layout.w * rect.width,
      clientY: rect.top + z / layout.d * rect.height,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, shiftKey: false,
      ...extra,
    });
    target.dispatchEvent(event);
    return event;
  }
  return { canvas, win, layout, editor, pointer, picker: parent.children[0], changes, hovers, captures };
}

for (const pointerType of ['mouse', 'touch']) {
  test(`${pointerType}: 台の選択・選び直し・Shift一括割当・blurによる取消`, t => {
    const { canvas, layout, pointer, picker, changes } = setupEditor(t);
    const first = layout.islands[0], last = layout.islands.at(-1);
    const original = first.slots[0].machineId;
    const select = (island, extra = {}) => pointer(canvas, 'pointerdown', island.x - island.w / 2, island.z - island.d / 2, { pointerType, ...extra });
    assert.equal(select(first).defaultPrevented, true);
    assert.equal(picker.style.display, 'block');
    assert.equal(picker.focused, true);
    assert.equal(select(last).defaultPrevented, true);
    picker.value = 's01';
    picker.dispatchEvent(new Event('change'));
    assert.equal(first.slots[0].machineId, original); // 前の台へのハンドラが残らない。
    assert.equal(last.slots[0].machineId, 's01');
    assert.equal(changes.length, 1);
    assert.equal(picker.style.display, 'none');

    select(last, { shiftKey: true });
    picker.value = 'p01';
    picker.dispatchEvent(new Event('change'));
    assert.ok(last.slots.every(slot => slot.machineId === 'p01'));
    assert.equal(changes.length, 2);

    select(first);
    picker.dispatchEvent(new Event('blur')); // 外側クリックやTabでフォーカスを外す。
    assert.equal(picker.style.display, 'none');
    picker.dispatchEvent(new Event('change'));
    assert.equal(changes.length, 2);
    select(last);
    pointer(canvas, 'pointerdown', 0, layout.d, { pointerType });
    assert.equal(picker.style.display, 'none');
  });

  test(`${pointerType}: 島・入口・受付の移動とドラッグ終了を換算後の座標で扱う`, t => {
    const { canvas, win, layout, pointer, changes, captures } = setupEditor(t);
    const targets = [layout.islands.at(-1), layout.entrance[0], layout.counter];
    for (const [index, target] of targets.entries()) {
      const { x, z } = target;
      pointer(canvas, 'pointerdown', x, z, { pointerType });
      assert.equal(captures.has(1), true);
      pointer(win, 'pointermove', x + 10, z + 10, { pointerType, pointerId: 2, isPrimary: false });
      assert.equal(target.x, x); // 別の指では動かない。
      pointer(win, 'pointerup', x, z, { pointerType, pointerId: 2 });
      assert.equal(changes.length, index);
      pointer(win, 'pointermove', x + 2.6, z + 3.6, { pointerType });
      assert.equal(target.x, x + 2.5);
      assert.equal(target.z, z + 3.5);
      pointer(win, index === 1 ? 'pointercancel' : 'pointerup', x + 2.6, z + 3.6, { pointerType });
      assert.equal(captures.size, 0);
      assert.equal(changes.length, index + 1);
      pointer(win, 'pointermove', x + 20, z + 20, { pointerType });
      assert.equal(target.x, x + 2.5);
    }
  });
}

test('縮小表示でも実際の台の位置からヒートマップを参照する', t => {
  const { win, layout, editor, pointer, hovers } = setupEditor(t);
  const island = layout.islands.at(-1), slot = island.slots[0];
  editor.setHeatmap([{ islandId: island.id, i: slot.i, side: slot.side, heat: 0.75 }]);
  pointer(win, 'pointermove', island.x - island.w / 2, island.z - island.d / 2);
  assert.equal(hovers.at(-1).slot, slot);
  assert.equal(hovers.at(-1).heat, 0.75);
});
