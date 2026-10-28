/** 调试：为什么 (套餐 × 目标) 组合的多得部分算价没有生成 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeMenu } from '../src/adapter.js';
import { isComboEntry, analyzeCombo } from '../src/deal.js';

const here = dirname(fileURLToPath(import.meta.url));
const d = JSON.parse(readFileSync(resolve(here, '..', 'demo', 'dataset.json'), 'utf8'));
const menu = normalizeMenu(d.static['query-meals']?.data);
const menuDict = new Map(menu.map((m) => [m.code, m]));
console.log('菜单项数', menu.length);

for (const [comboCode, raw] of Object.entries(d.mealDetail)) {
  const combo = menuDict.get(comboCode);
  const rounds = raw?.data?.data?.rounds ?? [];
  const comboPay = Number(d.prices[`${comboCode}x1`]?.price ?? 0) / 100;
  console.log(`\n=== 套餐 ${comboCode} ${combo?.name ?? '?'} | comboPay=${comboPay} | rounds=${rounds.length} ===`);

  const seen = new Set();
  for (const r of rounds) {
    for (const ch of r.choices ?? []) {
      const code = String(ch.code ?? '');
      if (!code) continue;
      if (seen.has(code)) continue;
      seen.add(code);
      const m = menuDict.get(code);
      const isCombo = m ? isComboEntry(m) : null;
      const targetPay = Number(d.prices[`${code}x1`]?.price ?? 0) / 100;
      let note = '';
      if (!m) note = '不在菜单中';
      else if (isCombo) note = '是套餐，跳过';
      else if (!targetPay) note = `单点价缺失(${d.prices[`${code}x1`] ? 'price=0' : '无缓存'})`;
      else {
        const pre = analyzeCombo({ target: m, combo, rounds, menuDict, comboPrice: comboPay, targetPrice: targetPay });
        if (!pre) note = 'analyzeCombo 返回 null';
        else {
          const ev = pre.extras?.evaluable ?? [];
          note = `evaluable=${ev.length}` + (ev.length ? ' → ' + ev.map((e) => e.code).join(',') : '');
        }
      }
      console.log(`   ${code} ${String(m?.name ?? '?').padEnd(18)} ${note}`);
    }
  }
}
