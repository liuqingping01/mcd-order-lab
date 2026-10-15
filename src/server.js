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
import { networkInterfaces } from 'node:os';
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
import { CATEGORY_GROUPS, groupOf } from './catalog.js';
import { matchCartWithCombo, rankOptions } from './cart.js';
import {
  matchTargets, pickTarget, isComboEntry, analyzeCombo, recommend, nutritionSummary,
} from './deal.js';

loadEnv();

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', 'public');
const PORT = Number(process.env.PORT ?? 5173);
/**
 * 监听地址：默认只绑 127.0.0.1（Token 与订单不出本机）。
 * 需要在手机上访问时设 HOST=0.0.0.0，服务会打印局域网地址供手机打开。
 * 注意：设为 0.0.0.0 后同一局域网内的任何人都能访问，请只在可信网络下开启。
 */
const HOST = process.env.HOST ?? '127.0.0.1';
const LAN_MODE = HOST === '0.0.0.0';

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

/* ------------------------------------------------------------------ */
/* 门店选取                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从门店列表里挑一家「当前营业中」的。
 *
 * ⚠️ 实测依据（2026-10-15 21:41，杭州西湖）：`query-nearby-stores` 返回的门店带
 * `businessStatus`，景区店 07:00–19:00；打烊后 `query-meals` 对这类门店直接返回
 * `success=false` +「门店可能已关闭或不在营业时间」。若只取列表第一家（可能已打烊），
 * 整条链路会表现得像「服务坏了」，实际只是非营业时间。
 */
function pickOpenStore(stores, fixedStoreCode) {
  if (fixedStoreCode) {
    const fixed = stores.find((s) => s.code === String(fixedStoreCode));
    // 指定门店即使打烊也尊重用户选择，由下游统一报错
    if (fixed) return fixed;
  }
  return stores.find((s) => s.open !== false) ?? null;
}

/** 一家营业门店都找不到时的说明文案 */
function noOpenStoreError(stores, city, keyword) {
  if (!stores.length) {
    return `未查询到「${city ?? ''} ${keyword ?? ''}」附近的门店，换个城市或位置关键词试试`;
  }
  const s = stores[0];
  return (
    `周边 ${stores.length} 家门店当前都已打烊（最近的「${s.name}」营业时间 ${s.hours || '未知'}）。` +
    '麦当劳 MCP 在非营业时间不返回菜单，请换个位置关键词或明天再试。'
  );
}

/**
 * 统一解析「用哪家店」：优先营业中门店；若当前关键词下全部打烊，
 * 自动放宽到城市级再查一次（城市范围更大，通常能覆盖 24 小时门店）。
 */
async function resolveStore(client, { city, keyword, storeCode: fixedStoreCode }, warnings) {
  const query = async (kw) => {
    const res = await step('query-nearby-stores', () =>
      client.callToolJson('query-nearby-stores', { beType: 1, city: city ?? '', keyword: kw ?? '', searchType: 2 })
    );
    if (!res.ok) warnings.push(`门店查询失败：${res.error}`);
    return res.ok ? normalizeStores(res.data?.data) : [];
  };

  let stores = await query(keyword);
  let store = pickOpenStore(stores, fixedStoreCode);

  if (!store && !fixedStoreCode && city && keyword && String(keyword) !== String(city)) {
    const wider = await query(city);
    const fallback = pickOpenStore(wider, null);
    if (fallback) {
      stores = wider;
      store = fallback;
      warnings.push(`「${keyword}」附近门店已打烊，已改用「${city}」范围内仍在营业的门店：${store.name}`);
    }
  }
  return { store, stores };
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

  // 2) 门店（优先取营业中的，打烊门店拿不到菜单，详见 pickOpenStore）
  if (!fixedStoreCode && (!city || !keyword)) {
    warnings.push('缺少城市或位置关键词，无法查询门店');
  }
  const { store, stores: storeList } = await resolveStore(
    client, { city, keyword, storeCode: fixedStoreCode }, warnings
  );
  if (!store) warnings.push(noOpenStoreError(storeList, city, keyword));

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

  // 1) 门店（优先取营业中的，打烊门店拿不到菜单）
  const { store, stores } = await resolveStore(
    client, { city, keyword, storeCode: fixedStoreCode }, warnings
  );
  if (!store) return { ok: false, error: noOpenStoreError(stores, city, keyword), warnings };
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
    target: { code: target.code, name: target.name, image: target.image ?? '' },
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

/**
 * 探索链路：按用户"出发点"取数据，支撑首页的多个入口。
 *
 *   mode=groups      → 大类清单（每个类有多少商品）
 *   mode=category    → 某个大类下的全部商品，单品在前、套餐在后
 *   mode=deals       → 省钱榜（有折扣的，按省得多寡排序）+ 低价榜（最便宜的单品）
 *   mode=campaigns   → 活动日历（按天）+ 可领券
 *
 * 价格说明：本接口展示**菜单价**（不给每个商品都调一次官方算价，那会打爆限流）；
 * 用户点进具体商品后走 /api/deal，那里全部用官方算价。
 */
async function buildExplore(client, body) {
  const warnings = [];
  const { city, keyword, mode = 'groups', category } = body ?? {};

  // ⚠️ 层级：step() 把结果包成 {ok, data} 后，data 才是 callToolJson 返回的信封，
  //    再往下一层 .data 才是业务 payload（见 adapter.normalizeStores）。
  const { store, stores } = await resolveStore(client, { city, keyword }, warnings);
  if (!store) return { ok: false, error: noOpenStoreError(stores, city, keyword), warnings };
  const storeCode = store.code;

  const mealsRes = await step('query-meals', () =>
    client.callToolJson('query-meals', { storeCode, beType: 1, orderType: 1 })
  );
  if (!mealsRes.ok || mealsRes.data?.success === false) {
    return { ok: false, error: `菜单查询失败：${mealsRes.error ?? mealsRes.data?.message}`, warnings };
  }
  const menu = normalizeMenu(mealsRes.data?.data);

  // image：官方商品图 CDN 直链，实测 128/128 商品都有、无防盗链，可直接 <img src> 引用
  const shape = (m) => ({
    code: m.code,
    name: m.name,
    price: m.price,
    originalPrice: m.originalPrice,
    save: Math.round((m.originalPrice - m.price) * 100) / 100,
    tags: m.tags,
    category: m.category,
    isCombo: isComboEntry(m),
    image: m.image ?? '',
  });

  // 大类清单
  if (mode === 'groups') {
    const groups = CATEGORY_GROUPS.map((g) => {
      const items = menu.filter((m) => groupOf(m.category)?.key === g.key);
      return {
        key: g.key,
        name: g.name,
        count: items.length,
        sample: items.slice(0, 3).map((m) => m.name),
      };
    }).filter((g) => g.count > 0);
    const other = menu.filter((m) => !groupOf(m.category));
    if (other.length) {
      groups.push({
        key: 'other', name: '其他', count: other.length,
        sample: other.slice(0, 3).map((m) => m.name),
      });
    }
    return { ok: true, mode, store, groups, warnings };
  }

  // 某个大类的商品：单品在前，套餐在后
  if (mode === 'category') {
    const g = CATEGORY_GROUPS.find((x) => x.key === category);
    const items = category === 'other'
      ? menu.filter((m) => !groupOf(m.category))
      : menu.filter((m) => groupOf(m.category)?.key === category);
    const singles = items.filter((m) => !isComboEntry(m)).sort((a, b) => a.price - b.price);
    const combos = items.filter(isComboEntry).sort((a, b) => a.price - b.price);
    return {
      ok: true, mode, store,
      groupName: g?.name ?? '其他',
      items: [...singles, ...combos].map(shape),
      warnings,
    };
  }

  // 省钱榜 + 低价榜
  if (mode === 'deals') {
    const discounted = menu
      .filter((m) => m.originalPrice > m.price && m.price > 0)
      .sort((a, b) => (b.originalPrice - b.price) - (a.originalPrice - a.price))
      .slice(0, 12)
      .map(shape);

    const cheapest = menu
      .filter((m) => !isComboEntry(m) && m.price > 0)
      .sort((a, b) => a.price - b.price)
      .slice(0, 12)
      .map(shape);

    return { ok: true, mode, store, discounted, cheapest, warnings };
  }

  // 活动日历 + 可领券
  if (mode === 'campaigns') {
    const calRes = await step('campaign-calendar', () => client.callToolJson('campaign-calendar', {}));
    const daily = asArray(calRes.ok ? calRes.data?.data?.dailyList : null);
    const days = daily.map((d) => ({
      date: d?.date ?? '',
      dateText: d?.dateText ?? '',
      events: asArray(d?.events).map((e) => ({
        title: e?.articleDto?.title ?? e?.activityTitle ?? '',
        highlight: e?.articleDto?.highlights ?? '',
        content: e?.articleDto?.content ?? '',
        price: e?.price ?? '',
        priceSuffix: e?.priceSuffix ?? '',
        image: e?.articleDto?.imgList?.[0] ?? '',
        buttonText: e?.articleDto?.buttonText ?? e?.button?.text ?? '',
      })).filter((e) => e.title || e.highlight),
    })).filter((d) => d.events.length);
    if (!calRes.ok) warnings.push(`活动日历查询失败：${calRes.error}`);

    const couponRes = await step('available-coupons', () => client.callToolJson('available-coupons', {}));
    const coupons = couponRes.ok
      ? asArray(couponRes.data?.data).map((c) => ({
          name: c.couponName ?? '', image: c.couponImage ?? '',
          status: c.couponStatus ?? '', label: c.label ?? '',
        }))
      : [];

    return { ok: true, mode, store, days, coupons, warnings };
  }

  return { ok: false, error: `未知的 mode：${mode}`, warnings };
}

/**
 * 购物车 → 相似方案对比
 *
 * 用户往购物车加了几样单品后，这里回答：**全买单品划算，还是换成某个套餐更划算？**
 *
 * 做法：
 *   1) 先对购物车原样求一次官方算价，作为基线
 *   2) 扫描门店所有套餐，用套餐默认组成去"抵扣"购物车（见 src/cart.js）
 *   3) 对有覆盖的套餐，按「套餐 ×1 + 未被覆盖的商品」重新官方算价
 *   4) 与基线比差价，便宜的排在前面
 *
 * ⚠️ 套餐里多出来的东西（surplus，含无法单点的套餐专属品）视为"白送"，
 *    不计入抵扣金额，因此省下的钱是**保守下界**。
 */
async function buildCart(client, body) {
  const warnings = [];
  const { items, city, keyword } = body ?? {};
  const cart = (Array.isArray(items) ? items : [])
    .map((i) => ({ code: String(i.code ?? '').trim(), quantity: Number(i.quantity) || 1 }))
    .filter((i) => i.code && i.quantity > 0);

  if (!cart.length) return { ok: false, error: '购物车是空的' };

  // 1) 门店（优先取营业中的，打烊门店拿不到菜单）
  const { store, stores } = await resolveStore(client, { city, keyword }, warnings);
  if (!store) return { ok: false, error: noOpenStoreError(stores, city, keyword), warnings };
  const storeCode = store.code;

  // 2) 菜单（用来补全名称、图片、以及判定套餐）
  const mealsRes = await step('query-meals', () =>
    client.callToolJson('query-meals', { storeCode, beType: 1, orderType: 1 })
  );
  if (!mealsRes.ok || mealsRes.data?.success === false) {
    return { ok: false, error: `菜单查询失败：${mealsRes.error ?? mealsRes.data?.message}`, warnings };
  }
  const menu = normalizeMenu(mealsRes.data?.data);
  const menuDict = new Map(menu.map((x) => [x.code, x]));

  const priceOf = async (list) => {
    const r = await client.callToolJson('calculate-price', {
      storeCode, beType: 1, orderType: 1,
      items: list.map((i) => ({ productCode: i.code, quantity: i.quantity })),
    });
    return extractPrice(r?.data)?.pay ?? 0;
  };

  // 3) 基线：购物车原样全买单品
  const decorate = (list) => list.map((x) => {
    const m = menuDict.get(String(x.code));
    return {
      code: String(x.code),
      name: m?.name ?? x.name ?? `商品 ${x.code}`,
      image: m?.image ?? '',
      quantity: x.quantity,
      orderable: Boolean(m),      // 不在菜单里 = 无法单点（套餐专属）
    };
  });

  const baseRes = await step('calculate-price(购物车基线)', () => priceOf(cart));
  if (!baseRes.ok || !baseRes.data) {
    // 最常见的原因：购物车里有套餐专属品（官方算价返回空），提示要说得清
    const bad = decorate(cart).filter((x) => !x.orderable);
    return {
      ok: false,
      error: bad.length
        ? `购物车里有 ${bad.length} 件无法单独下单的商品（${bad.map((x) => x.name).join('、')}），请移除后再试`
        : `购物车算价失败：${baseRes.error ?? '未取到官方价格'}`,
      warnings,
    };
  }
  const baselinePrice = baseRes.data;

  // 4) 扫描套餐，找能替代部分购物车的方案
  const combos = menu.filter(isComboEntry);
  const raw = await mapLimit(combos, 5, async (combo) => {
    const d = await step('query-meal-detail', () =>
      client.callToolJson('query-meal-detail', { storeCode, beType: 1, orderType: 1, code: combo.code })
    );
    const rounds = d.ok ? d.data?.data?.rounds ?? [] : [];
    const parts = rounds.map((r) => {
      const ch = (r?.choices ?? []).find((c) => c.isDefault === 1) ?? r?.choices?.[0];
      return ch ? { code: String(ch.code ?? ''), name: ch.name ?? '', quantity: Number(ch.quantity) || 1 } : null;
    }).filter(Boolean);

    const m = matchCartWithCombo(parts, cart);
    if (!m.coverCount) return null;

    // 「套餐 ×1 + 未被覆盖的商品」整体官方算价
    const bill = [{ code: combo.code, quantity: 1 }, ...m.uncovered];
    const pr = await step('calculate-price(套餐方案)', () => priceOf(bill));
    if (!pr.ok || !pr.data) return null;

    return {
      combo: { code: combo.code, name: combo.name, image: combo.image ?? '' },
      covered: decorate(m.covered),
      uncovered: decorate(m.uncovered),
      surplus: decorate(m.surplus),
      coverCount: m.coverCount,
      total: pr.data,
      diff: Math.round((pr.data - baselinePrice) * 100) / 100,   // 负数 = 比全单点省
    };
  });

  const options = rankOptions(raw.filter(Boolean)).slice(0, 8);

  return {
    ok: true,
    store,
    cart: decorate(cart),
    baseline: { price: baselinePrice, count: cart.reduce((s, x) => s + x.quantity, 0) },
    options,
    // 最省的方案：比基线便宜才算"更划算"
    best: options.find((o) => o.diff < 0) ?? null,
    combosScanned: combos.length,
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

  // 探索：首页多个入口（分类浏览 / 省钱榜 / 活动）
  if (pathname === '/api/explore' && req.method === 'POST') {
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
      return json(res, 200, await buildExplore(client, body));
    } catch (err) {
      return json(res, 502, { ok: false, error: err.message });
    }
  }

  // 购物车：全买单品 vs 换成套餐，哪个更省
  if (pathname === '/api/cart' && req.method === 'POST') {
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
      return json(res, 200, await buildCart(client, body));
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

/** 列出局域网 IPv4 地址，方便手机直接打开 */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  const configured = Boolean(process.env.MCD_MCP_TOKEN);
  console.log(`麦麦点单决策台已启动： http://localhost:${PORT}`);
  if (LAN_MODE) {
    const addrs = lanAddresses();
    console.log('局域网访问（手机与电脑连同一 WiFi 时可直接打开）：');
    if (addrs.length) {
      for (const a of addrs) console.log(`  http://${a}:${PORT}`);
    } else {
      console.log('  未探测到局域网地址，请确认网络已连接');
    }
    console.log('⚠️  当前对局域网开放：同一网络下的其他人也能访问本服务，请勿在公共网络使用。');
  }
  console.log(`MCP Token：${configured ? '已配置' : '未配置（请复制 .env.example 为 .env 并填入 Token）'}`);
  if (!configured) {
    console.log('未配置 Token 时 /api/plan 会返回错误提示，但页面仍可打开查看界面。');
  }
});
