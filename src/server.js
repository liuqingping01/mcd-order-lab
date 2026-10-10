/**
 * 麦麦点单决策台 —— 本地服务
 *
 * 职责：
 *   1) 托管 public/ 静态前端
 *   2) 作为 MCP 代理：浏览器永远拿不到 Token，也绕不开 CORS
 *
 * 零第三方依赖：git clone 后 `node src/server.js` 即可运行。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { loadEnv, projectRoot } from './env.js';
import { McdMcpClient } from './mcp-client.js';
import {
  normalizeStores, normalizeMenu, normalizeNutrition, normalizeCoupon,
  parseNutritionTable, extractPrice, asArray,
} from './adapter.js';
import { plan, buildNutritionIndex } from './planner.js';

loadEnv();

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', 'public');
const PORT = Number(process.env.PORT ?? 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

async function serveStatic(req, res, pathname) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(publicDir, rel);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error('not a file');
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
}

function readBody(req) {
  return new Promise((resolve_, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve_({});
      try {
        resolve_(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 每一步都允许失败并降级，但必须在 warnings 中如实告知前端，不静默吞错。 */
async function step(name, fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, name, error: err.message ?? String(err) };
  }
}

/**
 * 点单链路（到店自取 beType=1）。
 *
 * 参数规则（来自线上工具 schema，务必遵守）：
 *   beType     1=到店自取, 2=麦乐送到家, 5=得来速, 6=企业团餐
 *   orderType  1=到店（含自取+得来速）, 2=外送（含麦乐送+团餐）
 *   beCode     与 storeCode 配对；**到店自取(beType=1)不传，传了会报错**
 *   calculate-price 的 items 元素字段是 productCode + quantity
 */
async function buildPlan(client, body) {
  const warnings = [];
  const {
    city, keyword, storeCode: fixedStoreCode,
    people, budget, maxKcal, minProtein, avoid = [], prefer = [],
  } = body ?? {};

  // 1) 时间
  const timeRes = await step('now-time-info', () => client.callToolJson('now-time-info'));
  const nowInfo = timeRes.ok ? timeRes.data?.data ?? timeRes.data : null;
  if (!timeRes.ok) warnings.push(`时间查询失败：${timeRes.error}`);

  // 2) 门店
  let store = null;
  if (fixedStoreCode) {
    const res = await step('query-nearby-stores', () =>
      client.callToolJson('query-nearby-stores', {
        beType: 1, city: city ?? '', keyword: keyword ?? '', searchType: 2,
      })
    );
    const all = res.ok ? normalizeStores(res.data?.data) : [];
    store = all.find((s) => s.code === String(fixedStoreCode)) ?? null;
  } else {
    if (!city || !keyword) {
      warnings.push('缺少城市或位置关键词，无法查询门店');
    }
    const res = await step('query-nearby-stores', () =>
      client.callToolJson('query-nearby-stores', {
        beType: 1, city, keyword, searchType: 2,
      })
    );
    const all = res.ok ? normalizeStores(res.data?.data) : [];
    if (!res.ok) warnings.push(`门店查询失败：${res.error}`);
    store = all[0] ?? null;
    if (!store && res.ok) warnings.push(`未查询到「${city} ${keyword}」附近的门店，请换一个关键词`);
  }

  const storeCode = store?.code ?? '';

  // 3) 菜单：categories（分类归属） + meals（名称价格）两份数据合并
  let meals = [];
  if (storeCode) {
    const res = await step('query-meals', () =>
      client.callToolJson('query-meals', { storeCode, beType: 1, orderType: 1 })
    );
    if (res.ok && res.data?.success !== false) {
      meals = normalizeMenu(res.data?.data);
    } else {
      warnings.push(`菜单查询失败：${res.error ?? res.data?.message ?? '未知原因'}`);
    }
  }

  // 4) 营养：data 是表格字符串，需专用解析
  const nutRes = await step('list-nutrition-foods', () =>
    client.callToolJson('list-nutrition-foods', {})
  );
  let nutrition = [];
  if (nutRes.ok) {
    nutrition = parseNutritionTable(nutRes.data?.data).map(normalizeNutrition);
  } else {
    warnings.push(`营养数据查询失败：${nutRes.error}`);
  }

  // 5) 优惠券
  let coupons = [];
  if (storeCode) {
    const couponRes = await step('query-store-coupons', () =>
      client.callToolJson('query-store-coupons', { storeCode, beType: 1, orderType: 1 })
    );
    coupons = couponRes.ok ? asArray(couponRes.data?.data).map(normalizeCoupon) : [];
    if (!couponRes.ok) warnings.push(`优惠券查询失败：${couponRes.error}`);
  }
  if (coupons.length === 0 && !warnings.length) {
    warnings.push('当前门店/账号下没有查询到可用优惠券，方案价格不含券后优惠');
  }

  // 6) 组合搜索（本地估算排序）
  const lookupNutrition = buildNutritionIndex(nutrition);
  const schemes = plan({
    meals,
    lookupNutrition,
    constraints: { people, budget, maxKcal, minProtein, avoid, prefer },
  });

  // 7) 用官方 calculate-price 校正候选价格（不自造价格规则）
  for (const s of schemes) {
    const priceRes = await step('calculate-price', () =>
      client.callToolJson('calculate-price', {
        storeCode,
        beType: 1,
        orderType: 1,
        items: s.items.map((i) => ({ productCode: i.code, quantity: i.qty })),
      })
    );
    const payload = priceRes.ok ? priceRes.data?.data : null;
    const parsed = extractPrice(payload);
    if (priceRes.ok && priceRes.data?.success !== false && parsed) {
      s.officialPrice = parsed.pay;
      s.officialOriginal = parsed.original;
      s.officialDiscount = parsed.discount;
      // 算价清单与请求清单数量不一致，说明有商品未被计入，必须明示
      s.priceComplete = parsed.itemCount === s.items.length;
      if (!s.priceComplete) {
        s.priceNote = `官方算价只返回 ${parsed.itemCount}/${s.items.length} 个商品，金额可能不完整`;
      }
      s.priceVerified = true;
    } else {
      s.priceVerified = false;
      s.priceError = priceRes.error ?? priceRes.data?.message ?? '未取到官方算价结果';
    }
  }

  return {
    store,
    nowInfo,
    totals: {
      meals: meals.length,
      missingDetail: meals.filter((m) => m.detailMissing).length,
      nutrition: nutrition.length,
      coupons: coupons.length,
    },
    coupons,
    schemes,
    warnings,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      tokenConfigured: Boolean(process.env.MCD_MCP_TOKEN),
      node: process.version,
    });
  }

  if (pathname === '/api/tools') {
    try {
      const client = new McdMcpClient({ token: process.env.MCD_MCP_TOKEN });
      await client.initialize();
      const tools = await client.listTools();
      return json(res, 200, { ok: true, count: tools.length, tools });
    } catch (err) {
      return json(res, 502, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/plan' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
    if (!process.env.MCD_MCP_TOKEN) {
      return json(res, 400, {
        ok: false,
        error: '未配置 MCD_MCP_TOKEN。请复制 .env.example 为 .env 并填入从 https://open.mcd.cn/mcp 申请的 Token。',
      });
    }
    try {
      const client = new McdMcpClient({ token: process.env.MCD_MCP_TOKEN });
      await client.initialize();
      const result = await buildPlan(client, body);
      return json(res, 200, { ok: true, ...result });
    } catch (err) {
      return json(res, 502, { ok: false, error: err.message });
    }
  }

  // 下单：必须显式 confirm，避免误产生真实交易
  if (pathname === '/api/order' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
    if (body?.confirm !== true) {
      return json(res, 400, { ok: false, error: '下单需要显式传入 confirm: true 作为二次确认' });
    }
    try {
      const client = new McdMcpClient({ token: process.env.MCD_MCP_TOKEN });
      await client.initialize();
      const r = await client.callToolJson('create-order', body.order ?? {});
      return json(res, 200, { ok: true, order: r });
    } catch (err) {
      return json(res, 502, { ok: false, error: err.message });
    }
  }

  return serveStatic(req, res, pathname);
});

// 只监听本地回环：Token 与订单数据不出本机，也不对局域网暴露。
server.listen(PORT, '127.0.0.1', () => {
  const configured = Boolean(process.env.MCD_MCP_TOKEN);
  console.log(`麦麦点单决策台已启动： http://localhost:${PORT}`);
  console.log(`MCP Token：${configured ? '已配置' : '未配置（请复制 .env.example 为 .env 并填入 Token）'}`);
  if (!configured) {
    console.log('未配置 Token 时 /api/plan 会返回错误提示，但页面仍可打开查看界面。');
  }
});
