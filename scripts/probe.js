/**
 * M1 校准脚本
 * ===========
 * 用途：用真实 MCP Token 拉取线上工具清单与真实返回结构，
 *       用于校准 src/adapter.js 的字段映射。
 *
 * 用法：
 *   1) cp .env.example .env 并填入 MCD_MCP_TOKEN
 *   2) node scripts/probe.js
 *
 * 输出：
 *   控制台   —— 工具清单摘要与链路探测结果
 *   examples/tools.json        —— 线上工具定义（可提交，不含个人信息）
 *   examples/<tool>.real.json  —— 真实响应样例（已被 .gitignore 排除）
 *
 * 说明：门店采用「到店自取」链路（beType=1），无需用户配置配送地址，
 *       因此可在不触碰用户地址簿的前提下完成校准。
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadEnv, projectRoot } from '../src/env.js';
import { McdMcpClient } from '../src/mcp-client.js';

loadEnv();

const outDir = resolve(projectRoot, 'examples');

/** 校准用的默认定位参数，可通过环境变量覆盖 */
const CITY = process.env.PROBE_CITY ?? '杭州';
const KEYWORD = process.env.PROBE_KEYWORD ?? '文三路';

/** 无需依赖的探测项 */
const SIMPLE_PROBES = [
  { name: 'now-time-info', args: {} },
  { name: 'list-nutrition-foods', args: {} },
  { name: 'query-my-account', args: {} },
  { name: 'available-coupons', args: {} },
  { name: 'delivery-query-addresses', args: {} },
];

async function main() {
  const token = process.env.MCD_MCP_TOKEN;
  if (!token) {
    console.error('未配置 MCD_MCP_TOKEN。请先 cp .env.example .env 并填入 Token。');
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  const client = new McdMcpClient({ token });

  console.log('→ initialize ...');
  const init = await client.initialize();
  console.log('  服务端信息：', JSON.stringify(init?.serverInfo ?? init ?? {}).slice(0, 200));

  console.log('→ tools/list ...');
  const tools = await client.listTools();
  await writeFile(resolve(outDir, 'tools.json'), JSON.stringify(tools, null, 2), 'utf8');
  console.log(`  线上工具数：${tools.length}`);

  console.log('\n→ 独立工具探测 ...');
  for (const p of SIMPLE_PROBES) {
    await probeOne(client, p.name, p.args);
  }

  // 链式：门店 → 菜单 → 优惠券
  console.log('\n→ 链式探测（到店自取 beType=1）...');
  const storeRes = await probeOne(client, 'query-nearby-stores', {
    beType: 1, city: CITY, keyword: KEYWORD, searchType: 2,
  });

  const store =
    storeRes?.data?.stores?.[0] ??
    storeRes?.data?.list?.[0] ??
    (Array.isArray(storeRes?.data) ? storeRes.data[0] : null);

  if (!store) {
    console.log('  ⚠️ 未取到门店，后续链式探测跳过。可用 PROBE_CITY / PROBE_KEYWORD 环境变量调整定位。');
    return;
  }

  const storeCode = store.storeCode ?? store.code ?? store.id;
  console.log(`  取到门店：${store.storeName ?? store.name}（storeCode=${storeCode}）`);

  await probeOne(client, 'query-meals', { storeCode, beType: 1, orderType: 1 });
  await probeOne(client, 'query-store-coupons', { storeCode, beType: 1, orderType: 1 });

  console.log('\n完成。请检查 examples/*.real.json 的真实字段，据此修正 src/adapter.js。');
}

async function probeOne(client, name, args) {
  process.stdout.write(`  ${name} ... `);
  try {
    const data = await client.callToolJson(name, args);
    await writeFile(
      resolve(outDir, `${name}.real.json`),
      JSON.stringify(data, null, 2),
      'utf8'
    );
    const ok = data?.success === true;
    const keys =
      data && typeof data === 'object' ? Object.keys(data).join(', ') : typeof data;
    console.log(`${ok ? 'OK ' : 'FAIL'} code=${data?.code ?? '-'} 顶层字段：${keys}`);
    if (!ok) console.log(`      message: ${data?.message ?? '(无)'}`);
    return data;
  } catch (err) {
    console.log(`异常：${err.message}`);
    return null;
  }
}

main().catch((err) => {
  console.error('探测失败：', err.message);
  process.exit(1);
});
