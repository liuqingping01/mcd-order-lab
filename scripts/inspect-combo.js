/**
 * 开发调试工具：查看某个套餐在 query-meal-detail 下的原始组成结构。
 *
 * 用途：套餐的 rounds/choices 结构直接决定「多得部分」算得对不对。
 *      当某个套餐的净收益看起来不合理时，先用这个脚本看原始数据，
 *      不要凭推断改算法。
 *
 * 用法：node scripts/inspect-combo.js <comboCode> [comboCode2 ...]
 * 可选：--city=杭州 --keyword=武林广场
 */
import { readFileSync } from 'node:fs';
import { loadEnv } from '../src/env.js';
import { McdMcpClient } from '../src/mcp-client.js';
import { normalizeStores, extractPrice } from '../src/adapter.js';

loadEnv();

const args = process.argv.slice(2);
const codes = args.filter((a) => !a.startsWith('--'));
const opt = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=')[1] : d;
};
const city = opt('city', '杭州');
const keyword = opt('keyword', '武林广场');

if (!process.env.MCD_MCP_TOKEN) {
  console.error('未配置 MCD_MCP_TOKEN');
  process.exit(1);
}
if (!codes.length) {
  console.error('用法：node scripts/inspect-combo.js <comboCode> [更多 code...]');
  process.exit(1);
}

const client = new McdMcpClient({ token: process.env.MCD_MCP_TOKEN });
await client.initialize();

const storeRes = await client.callToolJson('query-nearby-stores', {
  beType: 1, city, keyword, searchType: 2,
});
const stores = normalizeStores(storeRes.data);
if (!stores.length) {
  console.error('未查到门店，原始返回：', JSON.stringify(storeRes).slice(0, 500));
  process.exit(1);
}
const storeCode = stores[0].code;
console.log(`门店：${stores[0].name} (${storeCode})\n`);

for (const code of codes) {
  const d = await client.callToolJson('query-meal-detail', {
    storeCode, beType: 1, orderType: 1, code,
  });
  // 注意层级：callToolJson 直接返回的是信封对象，payload 在 .data
  // （server.js 里多一层 d.data.data 是因为经过了 step() 包装）
  const dd = d.data ?? {};
  const price = await client.callToolJson('calculate-price', {
    storeCode, beType: 1, orderType: 1, items: [{ productCode: code, quantity: 1 }],
  }).then((r) => extractPrice(r?.data)?.pay ?? null);

  console.log(`=== ${code} | 官方算价 ¥${price ?? '?'} | 字段: ${Object.keys(dd).join(', ')}`);
  console.log(`    name = ${dd.name ?? dd.mealName ?? dd.productName ?? '(无名称字段)'}`);
  const rounds = dd.rounds ?? [];
  if (!rounds.length) console.log('    ⚠️ rounds 为空');
  for (const r of rounds) {
    const defs = (r.choices ?? []).filter((x) => x.isDefault === 1);
    console.log(`  round「${r.name}」 选项 ${(r.choices ?? []).length} 个 | 默认: ${defs.length ? defs.map((x) => `${x.name}#${x.code}`).join(',') : '(无 isDefault=1，回退取第一个)'}`);
    for (const ch of (r.choices ?? []).slice(0, 12)) {
      console.log(`      ${ch.name}#${ch.code} def=${ch.isDefault ?? '-'} diff=${ch.diffPrice ?? '-'} qty=${ch.quantity ?? '-'}`);
    }
  }

  // --price-parts：对套餐默认组成逐项单独算价，验证「能否单点 / 单点多少钱」
  // 这比"菜单里有没有"更权威：calculate-price 返回 productList 为空即为无法单点。
  if (args.includes('--price-parts')) {
    console.log('  --price-parts：逐项单独算价（判断能否单点）');
    for (const r of rounds) {
      const def = (r.choices ?? []).find((x) => x.isDefault === 1) ?? r.choices?.[0];
      if (!def) continue;
      const pr = await client.callToolJson('calculate-price', {
        storeCode, beType: 1, orderType: 1,
        items: [{ productCode: String(def.code), quantity: 1 }],
      });
      const p = extractPrice(pr?.data);
      const ok = Boolean(p && p.itemCount > 0 && p.pay > 0);
      console.log(`      ${def.name}#${def.code}  → ${ok ? `可单点 ¥${p.pay}` : `❌ 不可单点（pay=${p?.pay ?? 'null'}, items=${p?.itemCount ?? 0}）`}`);
    }
  }
  console.log('');
}
