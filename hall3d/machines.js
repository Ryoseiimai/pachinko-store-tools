// 架空機種カタログ（実在機種名・実在メーカー名は使用しない）
// popularity: 集客力(新台=高) / stayMin: 1人あたり滞在分の範囲
// outPerMin: 稼働中1分あたりアウト玉数（Pは約100〜120、Sは50玉換算で正規化）
// rate: 貸玉単価(円)。売上は engine.js 側で アウト×rate×貸玉率(salesRatio) から算出する
// （salesPerMinは持たない。アウトには持ち玉の再投入が含まれ、貸玉売上と直結しないため）。
export const MACHINES = [
  // ---- P機（パチンコ・20種） ----
  { id:'p01', name:'CR 蒼海物語 弐', kind:'P', rate:4, popularity:0.92, stayMin:[106,255], outPerMin:118, genre:'海物語系' },
  { id:'p02', name:'CR 蒼海物語 弐 ライト', kind:'P', rate:1, popularity:0.78, stayMin:[85,233], outPerMin:112, genre:'海物語系' },
  { id:'p03', name:'P 剣士伝説 弐式', kind:'P', rate:4, popularity:0.88, stayMin:[106,233], outPerMin:115, genre:'アニメ版権' },
  { id:'p04', name:'P 剣士伝説 弐式 甘', kind:'P', rate:4, popularity:0.7, stayMin:[85,212], outPerMin:108, genre:'甘デジ風' },
  { id:'p05', name:'CR 深淵の館', kind:'P', rate:4, popularity:0.65, stayMin:[85,212], outPerMin:110, genre:'ホラー' },
  { id:'p06', name:'CR 深淵の館 弐', kind:'P', rate:4, popularity:0.6, stayMin:[85,212], outPerMin:106, genre:'ホラー' },
  { id:'p07', name:'P 桜ノ乙女', kind:'P', rate:4, popularity:0.58, stayMin:[85,191], outPerMin:104, genre:'萌え' },
  { id:'p08', name:'P 桜ノ乙女 ライト', kind:'P', rate:1, popularity:0.5, stayMin:[76,191], outPerMin:100, genre:'萌え' },
  { id:'p09', name:'CR 花之丸新伝説', kind:'P', rate:4, popularity:0.55, stayMin:[76,191], outPerMin:103, genre:'甘デジ風' },
  { id:'p10', name:'CR 花之丸新伝説 極', kind:'P', rate:4, popularity:0.48, stayMin:[76,178], outPerMin:100, genre:'甘デジ風' },
  { id:'p11', name:'P 大将軍演義', kind:'P', rate:4, popularity:0.52, stayMin:[85,204], outPerMin:105, genre:'アニメ版権' },
  { id:'p12', name:'P 大将軍演義 弐', kind:'P', rate:4, popularity:0.44, stayMin:[76,187], outPerMin:100, genre:'アニメ版権' },
  { id:'p13', name:'CR 天空聖域', kind:'P', rate:4, popularity:0.4, stayMin:[68,178], outPerMin:98, genre:'ホラー' },
  { id:'p14', name:'CR 天空聖域 弐', kind:'P', rate:1, popularity:0.36, stayMin:[68,170], outPerMin:95, genre:'ホラー' },
  { id:'p15', name:'P 幻夜蝶', kind:'P', rate:4, popularity:0.34, stayMin:[64,161], outPerMin:96, genre:'萌え' },
  { id:'p16', name:'P 幻夜蝶 改', kind:'P', rate:4, popularity:0.3, stayMin:[64,161], outPerMin:94, genre:'萌え' },
  { id:'p17', name:'CR 竜鳴武伝', kind:'P', rate:4, popularity:0.33, stayMin:[64,152], outPerMin:95, genre:'アニメ版権' },
  { id:'p18', name:'CR 竜鳴武伝 弐', kind:'P', rate:1, popularity:0.28, stayMin:[60,149], outPerMin:92, genre:'アニメ版権' },
  { id:'p19', name:'P 常磐の宴', kind:'P', rate:4, popularity:0.26, stayMin:[60,145], outPerMin:90, genre:'甘デジ風' },
  { id:'p20', name:'P 常磐の宴 弐', kind:'P', rate:4, popularity:0.24, stayMin:[60,136], outPerMin:88, genre:'甘デジ風' },
  // ---- S機（パチスロ・10種） ----
  { id:'s01', name:'S 獣王咆哮', kind:'S', rate:20, popularity:0.9, stayMin:[127,297], outPerMin:50, genre:'6.5号機AT' },
  { id:'s02', name:'S 獣王咆哮 弐', kind:'S', rate:20, popularity:0.8, stayMin:[119,276], outPerMin:48, genre:'6.5号機AT' },
  { id:'s03', name:'S 紅蓮ジャグラー風', kind:'S', rate:20, popularity:0.6, stayMin:[149,340], outPerMin:44, genre:'ジャグラー風' },
  { id:'s04', name:'S 紅蓮ジャグラー風 弐', kind:'S', rate:5, popularity:0.5, stayMin:[127,318], outPerMin:44, genre:'ジャグラー風' },
  { id:'s05', name:'S 覇天降臨', kind:'S', rate:20, popularity:0.55, stayMin:[106,255], outPerMin:46, genre:'6.5号機AT' },
  { id:'s06', name:'S 覇天降臨 改', kind:'S', rate:5, popularity:0.46, stayMin:[102,246], outPerMin:46, genre:'6.5号機AT' },
  { id:'s07', name:'S 妖狐の舞', kind:'S', rate:20, popularity:0.42, stayMin:[102,233], outPerMin:42, genre:'萌え' },
  { id:'s08', name:'S 妖狐の舞 弐', kind:'S', rate:1, popularity:0.36, stayMin:[94,212], outPerMin:40, genre:'萌え' },
  { id:'s09', name:'S 疾風雷神', kind:'S', rate:20, popularity:0.38, stayMin:[94,212], outPerMin:40, genre:'6.5号機AT' },
  { id:'s10', name:'S 疾風雷神 弐', kind:'S', rate:5, popularity:0.3, stayMin:[85,195], outPerMin:38, genre:'6.5号機AT' },
];

export function findMachine(id){
  return MACHINES.find(m => m.id === id) || null;
}

export function machinesByKind(kind){
  return MACHINES.filter(m => m.kind === kind);
}
