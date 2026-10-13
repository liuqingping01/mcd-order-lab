/**
 * 真实链路冒烟测试 —— 会消耗 MCP 调用额度，**默认跳过**。
 *
 * 单元测试（test/*.test.js）用的是缓存样例，不联网；
 * 这个文件用来验证"线上结构没变"——因为本项目踩过多次
 * 「文档写的和线上返回不一致」的坑，光靠离线用例发现不了。
 *
 * 运行（需先在 .env 配好 MCD_MCP_TOKEN）：
 *   npm run test:live
 * 或：
 *   RUN_LIVE=1 node --test test/live.smoke.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '../src/env.js';
import { McdMcpClient } from '../src/mcp-client.js';
import { normalizeStores, normalizeMenu, extractPrice } from '../src/adapter.js';
import { matchTargets, pickTarget, isComboEntry } from '../src/deal.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

/** 未显式开启 RUN_LIVE 就整体跳过，避免每次 npm test 都烧额度 */
const LIVE = process.env.RUN_LIVE === '1';

test('真实链路冒烟：门店 → 菜单 → 套餐判定 → 官方算价', { skip: !LIVE }, async (t) => {
  if (!existsSync(resolve(projectRoot, '.env'))) {
    t.skip('缺少 .env，跳过');
    return;
  }
  loadEnv();
  const token = process.env.MCD_MCP_TOKEN;
  if (!token) {
    t.skip('未配置 MCD_MCP_TOKEN，跳过');
    return;
  }

  const client = new McdMcpClient({ token });
  await client.initialize();

  // 1) 门店
  const storeRes = await client.callToolJson('query-nearby-stores', {
    beType: 1, city: '杭州', keyword: '武林广场', searchType: 2,
  });
  const stores = normalizeStores(storeRes.data);
  assert.ok(stores.length > 0, '应查到门店');
  const storeCode = stores[0].code;

  // 2) 菜单：categories 与 meals 必须 join 后才有名称与价格
  const mealsRes = await client.callToolJson('query-meals', { storeCode, beType: 1, orderType: 1 });
  const menu = normalizeMenu(mealsRes.data);
  assert.ok(menu.length > 50, `菜单条目应充足，实际 ${menu.length}`);
  assert.ok(menu.every((m) => m.name && !m.name.startsWith('商品 ')), '菜单不应出现无名条目');

  // 3) 套餐判定：名称特征应显著多于 tags
  const byName = menu.filter(isComboEntry).length;
  assert.ok(byName > 20, `套餐类应多于 20 个，实际 ${byName}`);

  // 4) 目标匹配：跨叫法差异命中单品
  const target = pickTarget(matchTargets(menu, '麦辣鸡腿堡'));
  assert.ok(target, '应命中单品');
  assert.equal(target.isCombo, false);

  // 5) 官方算价：单位是分，且 productList 必须非空
  const priceRes = await client.callToolJson('calculate-price', {
    storeCode, beType: 1, orderType: 1,
    items: [{ productCode: target.code, quantity: 1 }],
  });
  const price = extractPrice(priceRes.data);
  assert.ok(price, '官方算价不应为空（productList 为空即静默失败）');
  assert.ok(price.pay > 0 && price.pay < 200, `单品价格应在合理区间，实际 ¥${price.pay}`);
});
