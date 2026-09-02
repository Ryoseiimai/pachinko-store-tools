// hall3d/engine.js — レイアウト・機種・来店/着席/OUTのシミュレーション（DOM非依存・純JS・node可）
//
// 用語: OUT=台に打ち込まれた玉数(稼働指標)。経営指標(OUT・稼働率・売上・粗利・客数・滞在時間・台移動)のみを扱う。
//
// 来客数モデル: 台数×基準稼働率(baseUtilization)から期待来客数を算出し、
//   立地/曜日/イベント/競合の効果は「基準からの倍率」として掛け合わせる方式。
//   レジャー白書の参加率(7.4%)は全国値であり、店単位の稼働率の公開統計が存在しないため、
//   基準稼働率はユーザーが自店実績に合わせて調整する仮置き値として扱う（UIにも明記）。
// 出典: レジャー白書2026速報版 参加率7.4%（data/industry_stats.json 参照。着席モデルの重み等は仮置き）。

const DOW_COEF = { 0: 1.2, 1: 1.0, 2: 1.0, 3: 1.0, 4: 1.0, 5: 1.05, 6: 1.2 }; // 0=日
const EVENT_COEF = { none: 0, newMachine: 0.15, payday: 0.10, rain: -0.10, holiday: 0.10 };
const AVG_STORE_SEATS_IN_AREA = 250; // 仮置き: 商圏内1店舗あたり平均台数
const DEFAULT_GROSS_MARGIN = 0.15;   // 仮置き: 業界目安15〜17%の下限（出典: industry_stats.json）
const MOVE_PROBABILITY = 0.2;        // 離席後、別の台へ移動する客の割合

const DEFAULT_BASE_UTILIZATION = 0.35; // 仮置き: 基準台稼働率（自店実績が分かれば差し替える前提）
const MIN_BASE_UTILIZATION = 0.05, MAX_BASE_UTILIZATION = 0.8;

// 貸玉率(仮置き): アウト玉数のうち「新規に貸し出した玉」の割合。
// アウトには持ち玉の再投入(打ち直し)が含まれ、貸玉売上=アウト×単価にはならないため、
// 売上 = アウト玉数 × 貸玉単価(rate) × 貸玉率 として概算する。keiei.htmlの既定(4円台=25,000円/台/日)と
// 整合する水準として0.25を既定値とする。
const DEFAULT_SALES_RATIO = 0.24;
const MIN_SALES_RATIO = 0.1, MAX_SALES_RATIO = 0.5;
const REFERENCE_SHARE = 0.33; // 仮置き: 「基準倍率=1」とみなす自店の商圏内台数シェアの目安
const MIN_MULTIPLIER = 0.6, MAX_MULTIPLIER = 1.5; // 立地/曜日/イベント/競合効果の倍率クリップ幅

// 見送り(着席せず退店)モデル: 最良の空き台スコアが閾値を下回るほど見送り率が上がる。
// 新台を入口付近に置くなど「良い席が用意できているか」が来店客の定着に影響する体感を再現する。
const WALKAWAY_THRESHOLD = 0.5; // 正規化スコア(0-1)がこれを下回ると見送り率が発生し始める
const WALKAWAY_MAX = 0.6;       // 正規化スコア0のときの見送り率上限
const STAY_SCALE_RANGE = 0.2;   // 台のスコアに応じて滞在時間を±20%伸縮させる

// 時間帯別 来店の重み（10時開店ピーク・17〜20時ピークの二峰型。仮置き、raiten.htmlのカーブを流用）
const HOURLY_WEIGHTS = { 10:0.9,11:1.0,12:0.85,13:0.7,14:0.75,15:0.95,16:1.1,17:1.15,18:1.05,19:0.9,20:0.75,21:0.55,22:0.35,23:0.15 };

// 着席モデル(多項ロジット風)のスコア重み。値はモデル内の相対重要度の仮置きで、
// 「新台・入口近く・角台・にぎわいのある島」が選ばれやすくなるよう設計している。
const W = {
  popularity: 30, // 機種の集客力: 新台・人気台に客が集まる体感を再現しつつ、位置の効果も無視されないよう配分
  proximity: 32,  // 入口からの近さ: 最初に目に入る/歩く距離が短い台が選ばれやすい。人気台でも配置次第で埋まり方が変わるよう強め
  corner: 10,     // 角台(島の端): 通路に面して視認性が高く選ばれやすい
  neighbor: 15,   // 隣接台の稼働(にぎわい): 賑わっている島に引き寄せられる心理を反映
  penalty: 20,    // 向かい側の台が埋まっている場合の圧迫感ペナルティ
};
// スコアの理論上の最小/最大（popularity=0〜1, 反対面が埋まっている場合の減点を含む）
const SCORE_MIN = -W.penalty;
const SCORE_MAX = W.popularity + W.proximity + W.corner + W.neighbor;

function clamp(v, lo, hi){ return Math.min(hi, Math.max(lo, v)); }

// ---- 乱数(xorshift32・seed再現可能) ----
export function createRng(seed){
  let s = (seed >>> 0) || 123456789;
  return function rand(){
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s |= 0;
    return ((s >>> 0) / 4294967296);
  };
}

function slotKey(islandId, i, side){ return islandId + '#' + i + '#' + side; }

// island の x,z,dir から各スロットの物理座標を計算する
function islandSlotPosition(island, i, side){
  const cx = island.x, cz = island.z;
  const w = island.w, d = island.d;
  const count = island.slots.length;
  const along = count > 1 ? (i / (count - 1) - 0.5) : 0; // -0.5..0.5
  if (island.dir === 'h') {
    const x = cx + along * w;
    const z = cz + (side === 'A' ? -d / 2 : d / 2);
    return { x, z };
  }
  const z = cz + along * d;
  const x = cx + (side === 'A' ? -w / 2 : w / 2);
  return { x, z };
}

// レイアウトから台のあるスロットを平坦化して物理情報を付与する
export function collectSlots(layout){
  const slots = [];
  const byIsland = new Map();
  for (const island of (layout.islands || [])) {
    const list = [];
    for (const slot of island.slots) {
      if (!slot.machineId) continue;
      const pos = islandSlotPosition(island, slot.i, slot.side);
      const corner = slot.i === 0 || slot.i === island.slots.length - 1;
      const entry = {
        islandId: island.id, i: slot.i, side: slot.side, machineId: slot.machineId,
        x: pos.x, z: pos.z, corner, key: slotKey(island.id, slot.i, slot.side),
      };
      slots.push(entry);
      list.push(entry);
    }
    byIsland.set(island.id, list);
  }
  // 同一島・同indexの反対面(oppositeSlot)と、同一島の全スロット(islandSlots)を紐付け
  for (const s of slots) {
    const siblings = byIsland.get(s.islandId) || [];
    s.islandSlots = siblings;
    s.oppositeSlot = siblings.find(o => o.i === s.i && o.side !== s.side) || null;
  }
  return slots;
}

export function countSlots(layout){
  let n = 0;
  for (const island of (layout.islands || [])) {
    for (const slot of island.slots) if (slot.machineId) n++;
  }
  return n;
}

// レイアウトに実際に割り当てられている機種の平均滞在時間(分)。台数配分の目安として使う。
function averageStayMin(layout, machineMap){
  let sum = 0, count = 0;
  for (const island of (layout.islands || [])) {
    for (const slot of island.slots) {
      const m = slot.machineId && machineMap.get(slot.machineId);
      if (!m) continue;
      sum += (m.stayMin[0] + m.stayMin[1]) / 2;
      count++;
    }
  }
  return count > 0 ? sum / count : 30;
}

// 各スロットに入口からの近さ(proximity, 0-1)を付与する
function attachProximity(slots, layout){
  const entrance = (layout.entrance && layout.entrance[0]) || { x: 0, z: 0 };
  const maxDist = Math.max(1, Math.hypot(layout.w || 1, layout.d || 1));
  for (const s of slots) {
    const dist = Math.hypot(s.x - entrance.x, s.z - entrance.z);
    s.proximity = 1 - Math.min(1, dist / maxDist);
  }
  return slots;
}

// 店構えの見え方効果: 人気機種が入口付近に配置されているほど、
// 外からの視認性・入店動線の良さから来店自体が増える(逆に奥まっていると素通りされやすい)という想定。
// 島単位の配置(=編集者が意図的に動かせる要素)が店全体の来客数に反映されるようにする。
const REFERENCE_APPEAL = 0.356; // 仮置き: テンプレ標準配置での見え方スコアの目安（この値を基準倍率=1とする）
const APPEAL_SENSITIVITY = 1.6; // 仮置き: 見え方スコアのずれに対する感度
const MIN_APPEAL_MULTIPLIER = 0.85, MAX_APPEAL_MULTIPLIER = 1.25;

function layoutAppeal(slots, machineMap){
  if (slots.length === 0) return 0;
  let sum = 0;
  for (const s of slots) {
    const m = machineMap.get(s.machineId);
    if (!m) continue;
    sum += m.popularity * s.proximity;
  }
  return sum / slots.length;
}

// その日の総来店客数を概算する。
// 期待来客数 = 台数 × 基準稼働率 × 営業分 ÷ 平均滞在分 を基準に、
// 立地/曜日/イベント/競合の効果を「基準からの倍率(0.6〜1.5にクリップ)」として掛ける。
export function estimateDailyVisitors(layout, dayParams = {}, machineMap = new Map()){
  const seats = Math.max(1, countSlots(layout));
  const rivals = Math.max(0, dayParams.rivals ?? 3);
  const openHour = dayParams.openHour ?? 10;
  const closeHour = dayParams.closeHour ?? 23;
  const minutes = Math.max(1, (closeHour - openHour) * 60);
  const baseUtilization = clamp(dayParams.baseUtilization ?? DEFAULT_BASE_UTILIZATION, MIN_BASE_UTILIZATION, MAX_BASE_UTILIZATION);
  const avgStay = averageStayMin(layout, machineMap);
  // 離席後にMOVE_PROBABILITYの割合で別の台へ移動して着席し直す分、
  // 同じ稼働容量を複数セッションで使い回す（実来店客数は単純な容量÷滞在時間より少なくなる）。
  const sessionMultiplier = 1 / (1 - MOVE_PROBABILITY);
  const capacityVisitors = seats * baseUtilization * minutes / (avgStay * sessionMultiplier);

  const dowCoef = DOW_COEF[dayParams.weekday ?? 6] ?? 1.0;
  const eventCoef = 1 + Math.min(EVENT_COEF[dayParams.event ?? 'none'] ?? 0, 0.5);
  const areaTotalSeats = seats + rivals * AVG_STORE_SEATS_IN_AREA;
  const occupancyShare = areaTotalSeats > 0 ? seats / areaTotalSeats : 1;
  const shareMultiplier = REFERENCE_SHARE > 0 ? occupancyShare / REFERENCE_SHARE : 1;
  const multiplier = clamp(dowCoef * eventCoef * shareMultiplier, MIN_MULTIPLIER, MAX_MULTIPLIER);

  const slots = attachProximity(collectSlots(layout), layout);
  const appeal = layoutAppeal(slots, machineMap);
  const appealMultiplier = clamp(1 + (appeal - REFERENCE_APPEAL) * APPEAL_SENSITIVITY, MIN_APPEAL_MULTIPLIER, MAX_APPEAL_MULTIPLIER);

  return Math.max(0, capacityVisitors * multiplier * appealMultiplier);
}

function scoreSlot(slot, occupied, machineMap){
  const m = machineMap.get(slot.machineId);
  if (!m) return -Infinity;
  let busy = 0;
  const total = slot.islandSlots.length;
  for (const ns of slot.islandSlots) if (occupied.has(ns.key)) busy++;
  const neighborBusy = total > 0 ? busy / total : 0;
  const oppositeBusy = (slot.oppositeSlot && occupied.has(slot.oppositeSlot.key)) ? 1 : 0;
  return m.popularity * W.popularity
    + slot.proximity * W.proximity
    + (slot.corner ? 1 : 0) * W.corner
    + neighborBusy * W.neighbor
    - oppositeBusy * W.penalty;
}

function pickSlot(slots, occupied, machineMap){
  let best = null, bestScore = -Infinity;
  for (const s of slots) {
    if (occupied.has(s.key)) continue;
    const score = scoreSlot(s, occupied, machineMap);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  if (!best) return null;
  return { slot: best, score: bestScore };
}

function normalizeScore(score){
  return clamp((score - SCORE_MIN) / (SCORE_MAX - SCORE_MIN), 0, 1);
}

function walkAwayProbability(normScore){
  if (normScore >= WALKAWAY_THRESHOLD) return 0;
  return WALKAWAY_MAX * (1 - normScore / WALKAWAY_THRESHOLD);
}

// 空き台を探して着席を試みる。満席、または見送り(着席せず退店)の場合は null を返す。
function trySeatCustomer(slots, occupied, machineMap, rand){
  const pick = pickSlot(slots, occupied, machineMap);
  if (!pick) return null; // 満席
  const normScore = normalizeScore(pick.score);
  if (rand() < walkAwayProbability(normScore)) return null; // 見送り
  const m = machineMap.get(pick.slot.machineId);
  const scale = 1 + (normScore - 0.5) * 2 * STAY_SCALE_RANGE; // スコアが高いほど長居する
  const base = m.stayMin[0] + rand() * (m.stayMin[1] - m.stayMin[0]);
  const stay = Math.max(1, Math.round(base * scale));
  return { slot: pick.slot, machine: m, stay };
}

// ---- 客の歩行(簡易版) ----
// 経路: 入口 → 最寄りの主通路(入口を出てすぐの横移動レーン) → 目的の島の通路 → 台の前、の折れ線。
// 島の内部は通らない(壁沿い・通路上のみを移動する簡易モデル)。1分あたり最大60m進む。
const WALK_SPEED_M_PER_MIN = 60; // 仮置き: 1分あたりの最大歩行距離(簡易版)
const GRID_METERS = 0.5;         // レイアウトの1マス=0.5m
const MAIN_AISLE_FRACTION = 0.35; // 入口から目的地までの距離のうち、主通路へ抜けるまでの割合(仮置き)

function buildWalkPath(from, to){
  const midZ = from.z + (to.z - from.z) * MAIN_AISLE_FRACTION;
  return [
    { x: from.x, z: from.z },
    { x: from.x, z: midZ },
    { x: to.x, z: midZ },
    { x: to.x, z: to.z },
  ];
}

function pathLengthMeters(path){
  let total = 0;
  for (let i = 1; i < path.length; i++) total += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
  return total * GRID_METERS;
}

function walkMinutesFor(path){
  return Math.max(1, Math.ceil(pathLengthMeters(path) / WALK_SPEED_M_PER_MIN));
}

// 折れ線pathに沿って、minutesCount分割した各分の到達点を返す(最後の要素が終点)
function walkFrames(path, minutesCount){
  const segLens = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) { const d = Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z); segLens.push(d); total += d; }
  const frames = [];
  for (let m = 1; m <= minutesCount; m++) {
    const targetDist = total * (m / minutesCount);
    let acc = 0, pt = path[path.length - 1];
    for (let i = 0; i < segLens.length; i++) {
      const segLen = segLens[i];
      if (acc + segLen >= targetDist || i === segLens.length - 1) {
        const segFrac = segLen > 0 ? Math.min(1, Math.max(0, (targetDist - acc) / segLen)) : 1;
        const a = path[i], b = path[i + 1];
        pt = { x: a.x + (b.x - a.x) * segFrac, z: a.z + (b.z - a.z) * segFrac };
        break;
      }
      acc += segLen;
    }
    frames.push(pt);
  }
  return frames;
}

// 780分(10:00-23:00)の来店/着席/OUTシミュレーションを実行する
export function simulate(input){
  const { layout, machines, dayParams = {} } = input;
  const rand = createRng(dayParams.seed ?? 42);
  const openHour = dayParams.openHour ?? 10;
  const closeHour = dayParams.closeHour ?? 23;
  const minutes = Math.max(0, (closeHour - openHour) * 60);
  const grossMargin = dayParams.grossMargin ?? DEFAULT_GROSS_MARGIN;
  const salesRatio = clamp(dayParams.salesRatio ?? DEFAULT_SALES_RATIO, MIN_SALES_RATIO, MAX_SALES_RATIO);

  const machineMap = new Map(machines.map(m => [m.id, m]));
  const slots = attachProximity(collectSlots(layout), layout);
  const entrance = (layout.entrance && layout.entrance[0]) || { x: 0, z: 0 };

  const totalVisitors = Math.round(estimateDailyVisitors(layout, { ...dayParams, openHour, closeHour }, machineMap));

  // 時間帯の重みから分単位の来店数配列を作る（端数は繰り越して合計を保つ）
  let sumW = 0;
  for (let h = openHour; h < closeHour; h++) sumW += (HOURLY_WEIGHTS[h] ?? 0.5);
  const arrivalsPerMinute = new Array(minutes).fill(0);
  let carry = 0;
  for (let h = openHour; h < closeHour; h++) {
    const w = HOURLY_WEIGHTS[h] ?? 0.5;
    const hourVisitors = sumW > 0 ? (totalVisitors * w / sumW) : 0;
    for (let m = 0; m < 60; m++) {
      const idx = (h - openHour) * 60 + m;
      if (idx >= minutes) break;
      carry += hourVisitors / 60;
      const n = Math.floor(carry);
      carry -= n;
      arrivalsPerMinute[idx] = n;
    }
  }

  const perSlotStat = new Map();
  for (const s of slots) perSlotStat.set(s.key, { islandId: s.islandId, i: s.i, machineId: s.machineId, occupiedMin: 0, out: 0, sales: 0, visits: 0 });

  const entrancePos = { x: entrance.x, z: entrance.z };
  const occupied = new Map(); // slot.key -> customer(予約。歩行中も他客に取られないよう確保する)
  let customers = []; // 各要素: { phase:'walk-in'|'sit'|'walk-out', ... }
  let nextId = 1;
  let peakInStore = 0, peakHour = openHour;
  let totalOut = 0, totalSales = 0, totalStayMin = 0, uniqueVisitors = 0, walkAways = 0, walkingCustomerMinutes = 0;
  const timeline = new Array(minutes);

  for (let t = 0; t < minutes; t++) {
    // ---- 来店(入口→台への歩行を開始) ----
    const arrivals = arrivalsPerMinute[t];
    for (let a = 0; a < arrivals; a++) {
      const seated = trySeatCustomer(slots, occupied, machineMap, rand);
      if (!seated) { walkAways++; continue; }
      const slotPos = { x: seated.slot.x, z: seated.slot.z };
      const path = buildWalkPath(entrancePos, slotPos);
      const walkInMinutes = walkMinutesFor(path);
      const sitStart = t + walkInMinutes;
      const cust = {
        id: nextId++, slot: seated.slot, machine: seated.machine,
        phase: 'walk-in', walkStartT: t, walkInMinutes, walkFrames: walkFrames(path, walkInMinutes),
        sitStart, sitEnd: sitStart + seated.stay,
        x: entrancePos.x, z: entrancePos.z,
      };
      occupied.set(seated.slot.key, cust);
      customers.push(cust);
      uniqueVisitors++;
      perSlotStat.get(seated.slot.key).visits++;
    }

    // ---- 各客の当該分の位置を確定し、着席分のみOUT/売上を加算 ----
    for (const c of customers) {
      if (c.phase === 'walk-in') {
        const idx = t - c.walkStartT;
        if (idx >= 0 && idx < c.walkFrames.length) { const p = c.walkFrames[idx]; c.x = p.x; c.z = p.z; }
        walkingCustomerMinutes++;
        if (t + 1 >= c.sitStart) { c.phase = 'sit'; c.x = c.slot.x; c.z = c.slot.z; }
      } else if (c.phase === 'sit') {
        c.x = c.slot.x; c.z = c.slot.z;
        if (t < c.sitEnd) {
          // 売上 = アウト玉数 × 貸玉単価(rate) × 貸玉率。アウトには持ち玉の再投入(打ち直し)が
          // 含まれるため、貸玉として売上計上されるのはその一部(貸玉率)のみとして概算する。
          const salesPerMin = c.machine.outPerMin * c.machine.rate * salesRatio;
          const st = perSlotStat.get(c.slot.key);
          st.occupiedMin++;
          st.out += c.machine.outPerMin;
          st.sales += salesPerMin;
          totalOut += c.machine.outPerMin;
          totalSales += salesPerMin;
        }
      } else { // walk-out
        const idx = t - c.walkOutStartT;
        if (idx >= 0 && idx < c.walkOutFrames.length) { const p = c.walkOutFrames[idx]; c.x = p.x; c.z = p.z; }
        walkingCustomerMinutes++;
      }
    }

    // ---- 着席終了 → 台移動 or 退店(入口への歩行を開始) / 歩行完了で退店 ----
    const remaining = [];
    for (const c of customers) {
      if (c.phase === 'sit' && t + 1 >= c.sitEnd) {
        occupied.delete(c.slot.key);
        totalStayMin += (c.sitEnd - c.sitStart);
        const fromPos = { x: c.slot.x, z: c.slot.z };
        const moved = (rand() < MOVE_PROBABILITY) ? trySeatCustomer(slots, occupied, machineMap, rand) : null;
        if (moved) {
          const toPos = { x: moved.slot.x, z: moved.slot.z };
          const path2 = buildWalkPath(fromPos, toPos);
          const walkInMinutes2 = walkMinutesFor(path2);
          const sitStart2 = t + 1 + walkInMinutes2;
          const c2 = {
            id: nextId++, slot: moved.slot, machine: moved.machine,
            phase: 'walk-in', walkStartT: t + 1, walkInMinutes: walkInMinutes2, walkFrames: walkFrames(path2, walkInMinutes2),
            sitStart: sitStart2, sitEnd: sitStart2 + moved.stay,
            x: fromPos.x, z: fromPos.z,
          };
          occupied.set(moved.slot.key, c2);
          remaining.push(c2);
          perSlotStat.get(moved.slot.key).visits++;
          continue;
        }
        // 退店: 台→入口へ歩く
        const pathOut = buildWalkPath(fromPos, entrancePos);
        const walkOutMinutes = walkMinutesFor(pathOut);
        c.phase = 'walk-out';
        c.walkOutStartT = t + 1;
        c.walkOutFrames = walkFrames(pathOut, walkOutMinutes);
        remaining.push(c);
        continue;
      }
      if (c.phase === 'walk-out' && t + 1 >= c.walkOutStartT + c.walkOutFrames.length) {
        continue; // 入口に到達=退店完了。timelineから除外
      }
      remaining.push(c);
    }
    customers = remaining;

    const inStoreCount = customers.length;
    if (inStoreCount > peakInStore) { peakInStore = inStoreCount; peakHour = openHour + Math.floor(t / 60); }

    timeline[t] = {
      t,
      customers: customers.map(c => ({
        id: c.id, x: c.x, z: c.z,
        state: c.phase === 'sit' ? 'sit' : (c.phase === 'walk-out' ? 'leave' : 'walk'),
        slotRef: { islandId: c.slot.islandId, i: c.slot.i, side: c.slot.side },
      })),
      kpi: { inStore: inStoreCount, out: Math.round(totalOut), sales: Math.round(totalSales) },
    };
  }

  const perSlot = slots.map(s => {
    const st = perSlotStat.get(s.key);
    const heat = minutes > 0 ? Math.min(1, st.occupiedMin / minutes) : 0;
    const slotGrossProfit = st.sales * grossMargin;
    return { islandId: s.islandId, i: s.i, side: s.side, machineId: s.machineId, occupiedMin: st.occupiedMin, out: Math.round(st.out), sales: Math.round(st.sales), grossProfit: Math.round(slotGrossProfit), visits: st.visits, heat };
  });

  const grossProfit = totalSales * grossMargin;
  const utilization = perSlot.length > 0 ? perSlot.reduce((a, b) => a + b.heat, 0) / perSlot.length : 0;

  const summary = {
    visitors: uniqueVisitors,
    walkAways,
    walkingCustomerMinutes,
    peakInStore,
    peakHour,
    totalOut: Math.round(totalOut),
    totalSales: Math.round(totalSales),
    grossProfit: Math.round(grossProfit),
    avgStayMin: uniqueVisitors > 0 ? Math.round(totalStayMin / uniqueVisitors) : 0,
    utilization,
  };

  return { minutes, timeline, perSlot, summary };
}
