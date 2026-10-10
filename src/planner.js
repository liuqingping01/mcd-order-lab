/**
 * 决策引擎：多目标点单方案搜索
 *
 * 目标函数同时考虑：预算、热量、蛋白质、套餐丰盛度。
 * 价格估算仅用于排序剪枝，**最终价格一律以 MCP `calculate-price` 为准**，
 * 本模块不自造价格规则，避免出现与官方算价不一致的错误结论。
 */

import { toNumber } from './adapter.js';

/**
 * 分类判定：把菜单归入 主食 / 小食 / 饮料 / 其他
 *
 * 优先使用线上真实分类名（来自 query-meals 的 categories[].name，
 * 已在 adapter 中去除空白）。实测分类名如下，比按名称猜准确得多：
 *   主食类：鸡肉汉堡/卷、巨无霸牛鱼肉堡、安格斯MAX厚牛堡、500大卡套餐、
 *          大堡口福单人餐、精选单人餐、随心配1+1、开心乐园
 *   小食类：小食甜品/其他、炸鸡、蘸酱炸鸡、小食拼盘/多人餐
 *   饮料类：饮品、麦咖啡™
 * 「人气热卖」是混合推荐位，不映射，回落到名称正则。
 */
const CATEGORY_MAP = {
  '鸡肉汉堡/卷': 'main',
  '巨无霸牛鱼肉堡': 'main',
  '安格斯MAX厚牛堡': 'main',
  '500大卡套餐': 'main',
  '大堡口福单人餐': 'main',
  '精选单人餐': 'main',
  '随心配1+1': 'main',
  '开心乐园': 'main',
  '小食甜品/其他': 'side',
  '炸鸡': 'side',
  '蘸酱炸鸡': 'side',
  '小食拼盘/多人餐': 'side',
  '饮品': 'drink',
  '麦咖啡™': 'drink',
};

const CATEGORY_RULES = [
  { bucket: 'main', re: /汉堡|堡|卷|饭|面|鸡腿|麦香|主食|套餐/ },
  { bucket: 'side', re: /薯条|鸡块|鸡翅|派|小食|沙拉|玉米|薯格|麦乐鸡/ },
  { bucket: 'drink', re: /可乐|雪碧|汽水|咖啡|奶茶|牛奶|果汁|饮|冰|热饮/ },
];

export function classify(name = '', category = '', tags = []) {
  if (category && CATEGORY_MAP[category]) return CATEGORY_MAP[category];
  const text = `${name} ${category} ${tags.join(' ')}`;
  for (const { bucket, re } of CATEGORY_RULES) {
    if (re.test(text)) return bucket;
  }
  return 'other';
}

/**
 * 营养查表：用名称包含匹配把菜单条目关联到营养数据。
 * 麦当劳营养 Tool 返回的是「常见餐品」清单，未必与菜单 code 一一对应，
 * 因此采用名称包含匹配 + 精确匹配优先的两级策略。
 */
export function buildNutritionIndex(nutritionList) {
  const exact = new Map();
  const list = nutritionList ?? [];
  for (const n of list) {
    if (n.key) exact.set(n.key, n);
  }
  const lookup = (name) => {
    if (!name) return null;
    if (exact.has(name)) return exact.get(name);
    for (const n of list) {
      if (!n.key) continue;
      if (name.includes(n.key) || n.key.includes(name)) return n;
    }
    return null;
  };
  return lookup;
}

/**
 * 生成候选方案。
 *
 * @param {object} input
 * @param {Array}  input.meals        normalizeMeal 后的菜单
 * @param {Function} input.lookupNutrition  (name) => nutrition | null
 * @param {object} input.constraints
 *   @param {number} input.constraints.people       人数，>=1
 *   @param {number} input.constraints.budget       总预算（元）
 *   @param {number} input.constraints.maxKcal      人均热量上限（千卡），0 表示不限
 *   @param {number} input.constraints.minProtein   人均蛋白质下限（克），0 表示不限
 *   @param {string[]} input.constraints.avoid      忌口关键词
 *   @param {string[]} input.constraints.prefer     偏好关键词
 * @param {object} [input.weights]
 * @param {number} [input.topN]
 * @param {number} [input.perBucketLimit]  每个桶保留的候选数，控制组合规模
 */
export function plan(input) {
  const {
    meals = [],
    lookupNutrition = () => null,
    constraints = {},
    weights = { price: 0.4, calorie: 0.3, protein: 0.2, variety: 0.1 },
    topN = 5,
    perBucketLimit = 8,
  } = input;

  const people = Math.max(1, Math.floor(toNumber(constraints.people ?? 1)));
  const budget = toNumber(constraints.budget ?? Infinity) || Infinity;
  const maxKcal = toNumber(constraints.maxKcal ?? 0);
  const minProtein = toNumber(constraints.minProtein ?? 0);
  const avoid = constraints.avoid ?? [];
  const prefer = constraints.prefer ?? [];

  // 1) 过滤忌口
  const pool = meals.filter((m) => {
    const text = `${m.name} ${m.category} ${m.tags.join(' ')}`;
    return !avoid.some((a) => a && text.includes(a));
  });

  // 2) 分桶
  const buckets = { main: [], side: [], drink: [], other: [] };
  for (const m of pool) {
    buckets[classify(m.name, m.category, m.tags)].push(m);
  }

  // 3) 每桶预打分并截断，控制组合规模（否则菜单一大就组合爆炸）
  const bucketScore = (m) => {
    let s = -m.price * 0.01;
    const nut = lookupNutrition(m.name);
    if (nut) s += nut.protein * 0.02;
    if (prefer.some((p) => p && `${m.name} ${m.tags.join(' ')}`.includes(p))) s += 3;
    return s;
  };
  const mains = buckets.main.sort((a, b) => bucketScore(b) - bucketScore(a)).slice(0, perBucketLimit);
  const sides = buckets.side.sort((a, b) => bucketScore(b) - bucketScore(a)).slice(0, perBucketLimit);
  const drinks = buckets.drink.sort((a, b) => bucketScore(b) - bucketScore(a)).slice(0, perBucketLimit);

  const candidates = [];

  // 4) 枚举：每人 1 份主食 + 0~1 份小食 + 0~1 份饮料
  const combos = [];
  for (const main of mains) {
    combos.push([main]);
    for (const side of sides) {
      combos.push([main, side]);
      for (const drink of drinks) {
        combos.push([main, side, drink]);
      }
    }
  }

  for (const combo of combos) {
    const items = combo.map((m) => ({
      code: m.code,
      name: m.name,
      price: m.price,
      qty: people,
      bucket: classify(m.name, m.category, m.tags),
      nutrition: lookupNutrition(m.name),
    }));

    const estPrice = items.reduce((s, i) => s + i.price * i.qty, 0);
    if (estPrice > budget) continue;

    let energy = 0;
    let protein = 0;
    let fat = 0;
    let carb = 0;
    let matched = 0;
    for (const i of items) {
      if (i.nutrition) {
        matched += 1;
        energy += toNumber(i.nutrition.energy) * i.qty;
        protein += toNumber(i.nutrition.protein) * i.qty;
        fat += toNumber(i.nutrition.fat) * i.qty;
        carb += toNumber(i.nutrition.carbohydrate) * i.qty;
      }
    }

    const kcalPerPerson = energy / people;
    const proteinPerPerson = protein / people;
    if (maxKcal > 0 && kcalPerPerson > maxKcal) continue;
    if (minProtein > 0 && proteinPerPerson < minProtein) continue;

    // 5) 打分
    const priceScore = budget === Infinity ? 0.5 : 1 - Math.min(1, estPrice / budget);
    const calorieScore =
      maxKcal > 0 ? 1 - Math.abs(kcalPerPerson - maxKcal * 0.85) / maxKcal : 0.5;
    const proteinScore = minProtein > 0 ? Math.min(1, proteinPerPerson / (minProtein * 1.5)) : 0.5;
    const varietyScore = items.length / 3;
    const coverage = items.length ? matched / items.length : 0;

    const score =
      weights.price * priceScore +
      weights.calorie * calorieScore +
      weights.protein * proteinScore +
      weights.variety * varietyScore;

    candidates.push({
      items,
      estimate: {
        price: round2(estPrice),
        perPersonPrice: round2(estPrice / people),
        energy: Math.round(energy),
        kcalPerPerson: Math.round(kcalPerPerson),
        protein: round1(protein),
        proteinPerPerson: round1(proteinPerPerson),
        fat: round1(fat),
        carbohydrate: round1(carb),
      },
      coverage,
      score: round4(score),
      reasons: buildReasons({
        estPrice, perPersonPrice: estPrice / people, budget,
        kcalPerPerson, maxKcal, proteinPerPerson, minProtein,
        items, coverage,
      }),
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  // 6) 去重：去掉主食相同、只是小食/饮料不同的近似方案，保证推荐有区分度
  const seen = new Set();
  const deduped = [];
  for (const c of candidates) {
    const key = c.items
      .filter((i) => i.bucket === 'main')
      .map((i) => i.code)
      .join('|');
    if (seen.has(key) && deduped.length >= 3) continue;
    seen.add(key);
    deduped.push(c);
    if (deduped.length >= topN * 3) break;
  }

  return deduped.slice(0, topN);
}

function buildReasons({
  estPrice, perPersonPrice, budget, kcalPerPerson, maxKcal,
  proteinPerPerson, minProtein, items, coverage,
}) {
  const reasons = [];
  if (budget !== Infinity) {
    const ratio = estPrice / budget;
    reasons.push(
      ratio <= 0.7
        ? `预算利用率 ${(ratio * 100).toFixed(0)}%，留有余量`
        : `人均 ¥${perPersonPrice.toFixed(1)}，接近预算上限`
    );
  }
  if (maxKcal > 0) {
    reasons.push(
      `人均 ${Math.round(kcalPerPerson)} 千卡，为上限 ${maxKcal} 的 ${((kcalPerPerson / maxKcal) * 100).toFixed(0)}%`
    );
  }
  if (minProtein > 0) {
    reasons.push(`人均蛋白质 ${proteinPerPerson.toFixed(1)}g`);
  }
  reasons.push(
    `包含 ${items.length} 个品类，搭配完整度 ${((items.length / 3) * 100).toFixed(0)}%`
  );
  if (coverage < 1) {
    reasons.push(`营养数据覆盖 ${(coverage * 100).toFixed(0)}%，部分餐品未匹配到营养表`);
  }
  return reasons;
}

const round2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;
const round4 = (n) => Math.round(n * 10000) / 10000;
