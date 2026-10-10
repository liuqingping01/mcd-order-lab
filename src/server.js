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
import {
  matchTargets, pickTarget, isComboEntry, analyzeCombo, recommend, nutritionSummary,
} from './deal.js';

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

/** 有限并发：套餐扫描要打 50+ 次 MCP，串行太慢，无限并发会撞限流（600 次/分钟）。 */
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) {
      const idx = i;
      i += 1;
      out[idx] = await fn(list[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
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

/**
 * 主线链路：我想吃 X —— 买套餐还是单点更划算？
 *
 * 价格口径：**全部取自官方 calculate-price**。实测菜单展示价与官方算价在部分商品上
 * 不一致（如板烧鸡腿堡四件套 菜单 ¥28 / 官方算价 ¥57），菜单价仅用于判断"能否单点"。
 *
 * 套餐内无法单点的商品（套餐专属）不计入金额，只作知情展示，
 * 因此净收益是保守下界，实际只会更划算。
 */
async function buildDeal(client, body) {
  const warnings = [];
  const { city, keyword, want, storeCode: fixedStoreCode } = body ?? {};
  if (!want) return { ok: false, error: '缺少 want（你想吃什么）' };

  // 1) 门店
  let store = null;
  const storeRes = await step('query-nearby-stores', () =>
    client.callToolJson('query-nearby-stores', { beType: 1, city, keyword, searchType: 2 })
  );
  const stores = storeRes.ok ? normalizeStores(storeRes.data?.data) : [];
  if (!storeRes.ok) warnings.push(`门店查询失败：${storeRes.error}`);
  store = fixedStoreCode
    ? stores.find((s) => s.code === String(fixedStoreCode)) ?? stores[0] ?? null
    : stores[0] ?? null;
  if (!store) return { ok: false, error: '未查询到门店', warnings };
  const storeCode = store.code;

  // 2) 菜单
  const mealsRes = await step('query-meals', () =>
    client.callToolJson('query-meals', { storeCode, beType: 1, orderType: 1 })
  );
  if (!mealsRes.ok || mealsRes.data?.success === false) {
    return { ok: false, error: `菜单查询失败：${mealsRes.error ?? mealsRes.data?.message}`, warnings };
  }
  const menu = normalizeMenu(mealsRes.data?.data);
  const menuDict = new Map(menu.map((x) => [x.code, x]));

  // 3) 目标商品：必须是**单品**。套餐是购买路径，不能当"想吃的东西"。
  const candidates = matchTargets(menu, want);
  const target = pickTarget(candidates);
  if (!target) {
    return {
      ok: false,
      error: candidates.length
        ? `菜单里只找到名为「${want}」的套餐，没找到同名单品。请换一个单品名试试（如「麦辣鸡腿汉堡」「板烧鸡腿堡」）`
        : `菜单里没找到「${want}」`,
      candidates: candidates.slice(0, 8).map((m) => ({ name: m.name, code: m.code, isCombo: m.isCombo })),
      suggestions: menu.filter((m) => !isComboEntry(m)).slice(0, 10).map((m) => m.name),
    };
  }

  const priceOf = async (items) => {
    const r = await client.callToolJson('calculate-price', { storeCode, beType: 1, orderType: 1, items });
    return extractPrice(r?.data)?.pay ?? 0;
  };

  // 4) 官方算价：单点该商品
  const targetPrice = await step('calculate-price(单点)', () =>
    priceOf([{ productCode: target.code, quantity: 1 }])
  );
  if (!targetPrice.ok || !targetPrice.data) {
    return { ok: false, error: `单品算价失败：${targetPrice.error}`, warnings };
  }

  // 5) 扫描包含该商品的套餐
  //    ⚠️ 套餐判定走 isComboEntry（名称特征为主），不能只信 tags：
  //       「麦辣鸡腿堡四件套」tags 是 ["麦金卡"]，只按 tags 会整系列漏掉。
  const combos = menu.filter(isComboEntry);
  const scanned = await mapLimit(combos, 5, async (combo) => {
    const d = await step('query-meal-detail', () =>
      client.callToolJson('query-meal-detail', { storeCode, beType: 1, orderType: 1, code: combo.code })
    );
    const rounds = d.ok ? d.data?.data?.rounds ?? [] : [];
    const hasTarget = rounds.some((r) =>
      (r.choices ?? []).some((ch) => String(ch.code) === String(target.code))
    );
    if (!hasTarget) return null;

    const comboPrice = await step('calculate-price(套餐)', () =>
      priceOf([{ productCode: combo.code, quantity: 1 }])
    );
    if (!comboPrice.ok || !comboPrice.data) return null;

    // 先用菜单价分类出可单点项，再对其整体用官方算价
    const pre = analyzeCombo({
      target, combo, rounds, menuDict,
      comboPrice: comboPrice.data, targetPrice: targetPrice.data,
    });
    if (!pre) return null;
    let extrasValue = 0;
    if (pre.extras.evaluable.length) {
      const ev = await step('calculate-price(多得部分)', () =>
        priceOf(pre.extras.evaluable.map((e) => ({ productCode: e.code, quantity: 1 })))
      );
      extrasValue = ev.ok ? ev.data : 0;
    }
    return analyzeCombo({
      target, combo, rounds, menuDict,
      comboPrice: comboPrice.data, targetPrice: targetPrice.data, extrasValue,
    });
  });
  const results = scanned.filter(Boolean);

  const { best, bestValue, paths } = recommend(results);

  // 6) 附属信息：可领券 + 今日活动（官方 App 已有，这里只是搬到决策现场）
  const couponsRes = await step('available-coupons', () => client.callToolJson('available-coupons', {}));
  const coupons = couponsRes.ok
    ? asArray(couponsRes.data?.data).map((c) => ({
        name: c.couponName ?? '',
        image: c.couponImage ?? '',
        status: c.couponStatus ?? '',
        label: c.label ?? '',
      }))
    : [];

  const calRes = await step('campaign-calendar', () => client.callToolJson('campaign-calendar', {}));
  const today = calRes.ok
    ? (asArray(calRes.data?.data?.dailyList).slice(-1)[0]?.events ?? []).map((e) => ({
        title: e?.articleDto?.title ?? e?.activityTitle ?? '',
        highlight: e?.articleDto?.highlights ?? '',
        price: e?.price ?? '',
      })).filter((e) => e.title)
    : [];

  // 7) 营养：仅作附加展示，不参与决策
  const nutRes = await step('list-nutrition-foods', () => client.callToolJson('list-nutrition-foods', {}));
  const nutrition = nutRes.ok ? parseNutritionTable(nutRes.data?.data).map(normalizeNutrition) : [];
  const lookupNutrition = buildNutritionIndex(nutrition);
  const cartForNutrition = [];
  if (best) {
    cartForNutrition.push({ name: best.target.name, quantity: 1 });
    for (const e of best.extras.evaluable) cartForNutrition.push({ name: e.name, quantity: 1 });
    for (const e of best.extras.exclusive) cartForNutrition.push({ name: e.name, quantity: 1 });
  }

  return {
    ok: true,
    store,
    target: { code: target.code, name: target.name },
    singlePrice: targetPrice.data,
    combosScanned: combos.length,
    best,
    bestValue,   // 净收益绝对值最高的方案（可能是大份/多人餐），作为「加价升级」备选
    paths,
    supplements: { coupons, campaigns: today },
    nutrition: nutritionSummary(cartForNutrition, lookupNutrition),
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

  // 主线：我想吃 X，买套餐还是单点更划算
  if (pathname === '/api/deal' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
    if (!process.env.MCD_MCP_TOKEN) {
      return json(res, 400, { ok: false, error: '未配置 MCD_MCP_TOKEN' });
    }
    try {
      const client = new McdMcpClient({ token: process.env.MCD_MCP_TOKEN });
      await client.initialize();
      return json(res, 200, await buildDeal(client, body));
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
