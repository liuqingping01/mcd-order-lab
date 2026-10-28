/**
 * 生成离线演示数据集
 * ============================================================
 * 用途：一次性抓取一份「真实且完整」的数据快照，供无 Token 的演示模式使用，
 *       使线上 Demo 不必携带任何凭据。
 *
 * 为什么必须「按套餐驱动」预取：
 *   比价链路对每个 (套餐 C, 目标单品 X) 组合都会真实调用一次 calculate-price，
 *   其中「多得部分」是该组合独有的商品列表（见 src/server.js buildDeal）。
 *   这些组合由 query-meal-detail 的 rounds 决定，是有限的，可以穷举；
 *   如果只对单品/套餐各自预取，离线时这些组合价就会查不到，
 *   结论将只能靠近似估算得出 —— 那正是我们要避免的。
 *
 * 用法：
 *   export MCD_MCP_TOKEN=<token>     # 或写入 .env
 *   node scripts/build-demo-dataset.js [城市] [关键词]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv, projectRoot } from '../src/env.js';
import { McdMcpClient } from '../src/mcp-client.js';
import { normalizeStores, normalizeMenu } from '../src/adapter.js';
import { isComboEntry, analyzeCombo } from '../src/deal.js';

loadEnv();

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '..', 'demo', 'dataset.json');

const city = process.argv[2] ?? '杭州';
const keyword = process.argv[3] ?? '西湖';

/** 简单并发池 */
async function pool(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= list.length) return;
      out[idx] = await fn(list[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/** calculate-price 的规范化缓存键 */
function priceKey(items) {
  return (items ?? [])
    .map((i) => `${i.productCode}x${i.quantity ?? 1}`)
    .sort()
    .join('_');
}

const token = process.env.MCD_MCP_TOKEN;
if (!token) {
  console.error('缺少 MCD_MCP_TOKEN（写入 .env 或用环境变量传入）');
  process.exit(1);
}

const client = new McdMcpClient({ token });
await client.initialize();
console.log('已连接 MCP');

const dataset = {
  generatedAt: new Date().toISOString(),
  note: '真实算价快照。 rated数据来源：麦当劳官方 MCP。请勿人工修改 prices 字段。'.replace(' rated', ''),
  scope: { city, keyword },
  static: {},
  mealDetail: {},
  prices: {},
};

dataset.tools = await client.listTools();

async function grab(name, args) {
  const raw = await client.callToolJson(name, args ?? {});
  if (!raw || raw.success === false) {
    console.warn(`  ⚠️ ${name} 返回失败：${raw?.message ?? '未知'}`);
  }
  return raw;
}

// 1) 门店：取第一家营业中的（与服务端 pickOpenStore 口径一致）
console.log('1/7 门店…');
const storesRaw = await grab('query-nearby-stores', { beType: 1, city, keyword, searchType: 2 });
dataset.static['query-nearby-stores'] = storesRaw;
const stores = normalizeStores(storesRaw?.data);
const store = stores.find((s) => s.open !== false) ?? null;
if (!store) {
  console.error('没有营业中的门店，无法生成数据集（门店打烊时官方不返回菜单）');
  process.exit(1);
}
const storeCode = store.code;
dataset.store = store;
console.log(`  门店：${store.name}（${storeCode}，营业 ${store.hours}）`);

// 2) 菜单
console.log('2/7 菜单…');
const mealsRaw = await grab('query-meals', { storeCode, beType: 1, orderType: 1 });
dataset.static['query-meals'] = mealsRaw;
const menu = normalizeMenu(mealsRaw?.data);
const menuDict = new Map(menu.map((m) => [m.code, m]));
console.log(`  商品 ${menu.length} 项`);

// DEMO_LIMIT>0 时只处理前 N 个套餐/单品，用于低成本试跑（验证脚本正确性）
const LIMIT = Number(process.env.DEMO_LIMIT ?? 0);
const combos = menu.filter(isComboEntry).slice(0, LIMIT || undefined);
const singles = menu.filter((m) => !isComboEntry(m)).slice(0, LIMIT ? Math.max(LIMIT * 4, 40) : undefined);
console.log(`  其中套餐 ${combos.length} 项 / 单品 ${singles.length} 项` + (LIMIT ? `（DEMO_LIMIT=${LIMIT} 试跑模式）` : ''));

// 3) 附属信息
console.log('3/7 附属信息（时间/营养/券/活动）…');
dataset.static['now-time-info'] = await grab('now-time-info');
dataset.static['list-nutrition-foods'] = await grab('list-nutrition-foods');
dataset.static['available-coupons'] = await grab('available-coupons');
dataset.static['campaign-calendar'] = await grab('campaign-calendar');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = { ok: 0, fail: 0, retried: 0 };
const failSamples = [];

/**
 * 带重试的调用。麦当劳 MCP 在密集调用时会偶发失败，直接丢弃会让数据集缺项，
 * 而缺项在离线模式下会表现为「算不出结论」，因此这里必须重试而非静默跳过。
 */
async function callWithRetry(fn, times = 3) {
  let last;
  for (let i = 0; i < times; i++) {
    const r = await fn();
    const env = r?.data ?? r;
    if (r && env?.success !== false) {
      if (i > 0) stats.retried++;
      stats.ok++;
      return r;
    }
    last = r;
    if (i < times - 1) await sleep(1200 * (i + 1));
  }
  stats.fail++;
  if (failSamples.length < 8) {
    failSamples.push(`${(last?.data ?? last)?.message ?? last?.message ?? '未知'} / ${JSON.stringify(last).slice(0, 100)}`);
  }
  return last;
}

const priceOf = (items) =>
  callWithRetry(() => client.callToolJson('calculate-price', { storeCode, beType: 1, orderType: 1, items }));

function recordPrice(items, raw) {
  const k = priceKey(items);
  if (raw?.success !== false && dataset.prices[k] === undefined) dataset.prices[k] = raw?.data ?? raw;
  return raw;
}

// 4) 全部单品单点价 + 全部套餐价
console.log('4/7 单品与套餐的单独算价…');
await pool(singles, 3, async (m) => {
  const raw = await priceOf([{ productCode: m.code, quantity: 1 }]);
  recordPrice([{ productCode: m.code, quantity: 1 }], raw);
});
await pool(combos, 2, async (c) => {
  const raw = await priceOf([{ productCode: c.code, quantity: 1 }]);
  recordPrice([{ productCode: c.code, quantity: 1 }], raw);
});
console.log(`  已缓存 ${Object.keys(dataset.prices).length} 条算价`);

// 5) 套餐明细
console.log('5/7 套餐明细（query-meal-detail）…');
const details = await pool(combos, 2, async (c) => {
  const raw = await callWithRetry(() =>
    client.callToolJson('query-meal-detail', { storeCode, beType: 1, orderType: 1, code: c.code })
  );
  dataset.mealDetail[c.code] = raw;
  // ⚠️ 层级：这里拿的是 callToolJson 的原始信封，比 server.js 里经 step() 包装的
  //    （那里是 res.data?.data?.rounds）少一层，因此这里是 raw.data.rounds。
  return { combo: c, rounds: raw?.data?.rounds ?? [] };
});

// 6) 关键：按 (套餐, 目标单品) 组合预取「多得部分」算价
//    与 src/server.js buildDeal 的调用序列保持一致
console.log('6/7 (套餐 × 目标单品) 组合的多得部分算价…');
let comboPairs = 0;
for (const { combo, rounds } of details) {
  const comboPriceRaw = dataset.prices[priceKey([{ productCode: combo.code, quantity: 1 }])];
  const comboPay = Number(comboPriceRaw?.price ?? 0) / 100;
  if (!comboPay) continue;

  // 该套餐 rounds 里出现过的全部可匹配商品（每个都可能被用户当作「想吃的东西」）
  const targetsSeen = new Set();
  for (const r of rounds) {
    for (const ch of r.choices ?? []) {
      const code = String(ch.code ?? '');
      if (!code) continue;
      const m = menuDict.get(code);
      if (m && !isComboEntry(m) && !targetsSeen.has(code)) targetsSeen.add(code);
    }
  }

  for (const code of targetsSeen) {
    const target = menuDict.get(code);
    const targetPriceRaw = dataset.prices[priceKey([{ productCode: code, quantity: 1 }])];
    const targetPay = Number(targetPriceRaw?.price ?? 0) / 100;
    if (!targetPay) continue;

    const pre = analyzeCombo({ target, combo, rounds, menuDict, comboPrice: comboPay, targetPrice: targetPay });
    if (!pre) continue;
    const evaluable = pre.extras?.evaluable ?? [];
    if (!evaluable.length) continue;
    const items = evaluable.map((e) => ({ productCode: e.code, quantity: 1 }));
    if (dataset.prices[priceKey(items)] !== undefined) continue;
    const raw = await priceOf(items);
    recordPrice(items, raw);
    comboPairs++;
  }
}
console.log(`  新增 ${comboPairs} 条组合算价，累计 ${Object.keys(dataset.prices).length} 条`);

// 7) 落盘
console.log('7/7 写入数据集…');
mkdirSync(dirname(OUT), { recursive: true });
const kb = (JSON.stringify(dataset).length / 1024).toFixed(0);
writeFileSync(OUT, JSON.stringify(dataset), 'utf8');

console.log('\n调用统计：成功 ' + stats.ok + ' / 失败 ' + stats.fail + ' / 重试后成功 ' + stats.retried);
if (failSamples.length) {
  console.log('  ⚠️ 失败样例：');
  failSamples.forEach((s) => console.log('     ' + s));
}
console.log('\n完成');
console.log('  文件：demo/dataset.json（' + kb + 'KB）');
console.log('  门店：' + store.name);
console.log('  算价条目：' + Object.keys(dataset.prices).length);
console.log('  套餐明细：' + Object.keys(dataset.mealDetail).length);
console.log('  生成时间：' + dataset.generatedAt);
