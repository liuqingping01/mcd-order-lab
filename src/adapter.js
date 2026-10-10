/**
 * 数据适配层
 * ============================================================
 * 这一层是「MCP 真实返回结构」与「决策引擎」之间唯一的耦合点。
 *
 * ✅ 已于 2026-10-09 用真实 MCP Token 完成校准（见 scripts/probe.js 与 examples/）。
 *    以下字段映射均以线上实际响应为准，与官方 README 的文字描述存在差异，
 *    差异点已在各函数注释中标明 —— **以线上为准**。
 *
 * 统一响应外壳：{ success, code, message, datetime, traceId, data }
 */

/**
 * 解析营养表格。
 *
 * ⚠️ 与文档描述不同：`list-nutrition-foods` 的 data 不是 JSON，
 *    而是自定义表格字符串，形如：
 *
 *    [160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
 *      猪柳麦满分,null,1288,308,16,16,24,781,213
 *      中薯条,null,1210,289,4,12,38,165,18
 *
 *    第一行声明列数（160）与列名，其后每行按逗号分隔。
 */
export function parseNutritionTable(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];

  const headerMatch = lines[0].match(/\{([^}]*)\}/);
  if (!headerMatch) return [];
  const columns = headerMatch[1].split(',').map((s) => s.trim());

  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = line.trim().split(',').map((s) => s.trim());
    if (cells.length < columns.length) continue;
    const obj = {};
    columns.forEach((c, i) => {
      obj[c] = cells[i];
    });
    rows.push(obj);
  }
  return rows;
}

export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    if (value === 'null' || value === '' || value === '-') return 0;
    const n = Number(value.replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj?.[k] !== null) return obj[k];
  }
  return undefined;
}

export function asArray(value, ...keys) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const k of keys) {
      if (Array.isArray(value[k])) return value[k];
    }
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* 门店                                                                */
/* ------------------------------------------------------------------ */

/**
 * `query-nearby-stores` 的 data 是数组（非 {stores:[]} 包装）——与常见假设不同。
 * 字段：storeCode, storeName, address, distance, businessStatus,
 *       businessStartTime, businessEndTime, reservation, reservationTimeOptions
 */
export function normalizeStore(raw) {
  if (!raw) return null;
  return {
    code: String(pick(raw, 'storeCode', 'code', 'id') ?? ''),
    name: pick(raw, 'storeName', 'name') ?? '未命名门店',
    address: pick(raw, 'address') ?? '',
    distance: toNumber(pick(raw, 'distance')),
    open: pick(raw, 'businessStatus') !== false,
    hours:
      pick(raw, 'businessStartTime') && pick(raw, 'businessEndTime')
        ? `${pick(raw, 'businessStartTime')}–${pick(raw, 'businessEndTime')}`
        : '',
    raw,
  };
}

export function normalizeStores(data) {
  return asArray(data, 'stores', 'storeList', 'list').map(normalizeStore).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* 菜单                                                                */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `query-meals` 的 data 含两个关键部分，必须合并使用：
 *
 *   data.categories : [{ name, meals: [{ code, tags }] }]   ← 只有 code 和标签，**无名称无价格**
 *   data.meals      : { "<code>": { name, image, currentPrice, originalPrice, canWithOrder } }
 *
 * 单看任一部分都不完整：分类里的条目缺名称价格，meals 字典缺分类归属。
 * 因此这里做一次 join，产出带分类 + 名称 + 价格的完整菜单。
 */
export function normalizeMenu(data) {
  const dict = data?.meals ?? {};
  const categories = asArray(data, 'categories');

  const byCode = new Map();

  for (const cat of categories) {
    const catName = String(cat?.name ?? '').replace(/\s+/g, '');
    for (const item of asArray(cat?.meals)) {
      const code = String(pick(item, 'code') ?? '');
      if (!code) continue;
      const detail = dict[code] ?? {};
      const price = toNumber(pick(detail, 'currentPrice', 'price'));
      byCode.set(code, {
        code,
        name: pick(detail, 'name') ?? `商品 ${code}`,
        price,
        originalPrice: toNumber(pick(detail, 'originalPrice')) || price,
        image: pick(detail, 'image') ?? '',
        category: catName,
        tags: asArray(pick(item, 'tags')).map(String),
        // 名称缺失说明该 code 未出现在 meals 字典中，价格按 0 处理并在 UI 标注
        detailMissing: !pick(detail, 'name'),
      });
    }
  }

  // 兜底：某些 code 只存在于 meals 字典而未归入任何分类
  for (const [code, detail] of Object.entries(dict)) {
    if (byCode.has(code)) continue;
    const price = toNumber(pick(detail, 'currentPrice', 'price'));
    byCode.set(code, {
      code,
      name: pick(detail, 'name') ?? `商品 ${code}`,
      price,
      originalPrice: toNumber(pick(detail, 'originalPrice')) || price,
      image: pick(detail, 'image') ?? '',
      category: '未分类',
      tags: [],
      detailMissing: false,
    });
  }

  return [...byCode.values()];
}

/* ------------------------------------------------------------------ */
/* 营养                                                                */
/* ------------------------------------------------------------------ */

/**
 * 营养表字段与常见命名不同：热量字段名是 energyKcal（不是 calories/energy），
 * 另含 energyKj、calcium。数值单位是千卡与克/毫克。
 */
export function normalizeNutrition(row) {
  return {
    key: String(pick(row, 'productName', 'name') ?? '').trim(),
    energy: toNumber(pick(row, 'energyKcal', 'energy', 'calories')),      // 千卡
    energyKj: toNumber(pick(row, 'energyKj')),
    protein: toNumber(pick(row, 'protein')),                              // 克
    fat: toNumber(pick(row, 'fat')),                                      // 克
    carbohydrate: toNumber(pick(row, 'carbohydrate', 'carb')),            // 克
    sodium: toNumber(pick(row, 'sodium')),                                // 毫克
    calcium: toNumber(pick(row, 'calcium')),                              // 毫克
  };
}

/* ------------------------------------------------------------------ */
/* 优惠券                                                              */
/* ------------------------------------------------------------------ */

/**
 * `query-store-coupons` 实测返回空数组（该账号/门店当前无可使用券），
 * 因此字段映射保留常见命名，运行时若为空则 UI 明示"当前门店无可用券"。
 */
export function normalizeCoupon(raw) {
  return {
    id: String(pick(raw, 'couponId', 'id', 'couponCode', 'code') ?? ''),
    name: pick(raw, 'couponName', 'name', 'title') ?? '优惠券',
    type: pick(raw, 'type', 'couponType') ?? '',
    discount: toNumber(pick(raw, 'discount', 'discountAmount', 'amount')),
    threshold: toNumber(pick(raw, 'threshold', 'minAmount')),
    raw,
  };
}

/* ------------------------------------------------------------------ */
/* 算价结果                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从 calculate-price 的返回中提取金额。
 *
 * 实测要点（2026-10-09 校准）：
 *   1) 金额单位是**分**，不是元。巨无霸 25.5 元 × 2 返回 price=5100。
 *   2) 顶层字段为 price / originalPrice / discount / productOriginalPrice。
 *   3) **陷阱**：items 元素字段名必须是 productCode。若误用 code，
 *      接口会返回 success=true 但 price=0、productList=[] —— 静默失败。
 *      因此这里强制校验 productList 非空，否则判定为无效算价，
 *      绝不允许把 0 元当作真实金额返回。
 */
const CENTS = 100;

export function extractPrice(data) {
  if (!data || typeof data !== 'object') return null;
  const list = asArray(data, 'productList', 'products', 'items');
  if (list.length === 0) return null;

  const pay = toNumber(pick(data, 'price', 'payAmount', 'payPrice', 'actualAmount'));
  const original = toNumber(pick(data, 'originalPrice', 'productOriginalPrice'));
  const discount = toNumber(pick(data, 'discount'));

  return {
    pay: pay / CENTS,
    original: original / CENTS,
    discount: discount / CENTS,
    itemCount: list.length,
    items: list.map((i) => ({
      code: String(pick(i, 'productCode', 'code') ?? ''),
      name: pick(i, 'productName', 'name') ?? '',
      quantity: toNumber(pick(i, 'quantity')),
      subtotal: toNumber(pick(i, 'subtotal')) / CENTS,
    })),
    raw: data,
  };
}
