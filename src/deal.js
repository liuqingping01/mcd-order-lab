/**
 * 购买路径对比引擎
 * ============================================================
 * 回答一个问题：**我想吃 X，是单点划算，还是买包含 X 的套餐划算？**
 *
 * 设计要点
 * --------
 * 1) 对比的是两条**都能真正下单**的路径（买单品 / 买套餐），
 *    因此不存在「拆开买买不到」的问题。
 *
 * 2) 套餐内存在「套餐专属商品」（如可乐中杯 code 3050），它们在单点菜单里没有、
 *    实测 calculate-price 对其返回 price=0 / productList=[]，即**无法单独购买**。
 *    处理原则：
 *      - 没有可信单价 → **不计入任何金额计算**（不猜、不估）
 *      - 在结果中标注为「套餐专属 · 无法单点」，列入"多得"清单供知情
 *      - 因此净收益是**保守下界**，真实划算程度只会更高
 *
 * 3) 所有价格以官方 calculate-price 为准，本模块只做减法和分类，不自造价格规则。
 */

/**
 * 套餐类判定。
 *
 * ⚠️ 实测坑点：菜单 tags **不可靠**。「麦辣鸡腿堡四件套」的 tags 是 ["麦金卡"]，
 *    只有三件套系列才带 ["套餐"]。只靠 tags 会漏掉整个「四件套/随心选/麦金卡」系列。
 *    因此以**名称特征为主**，tags 仅作补充。
 */
const COMBO_NAME_RE = /件套|套餐|组合|随心选|随心拼|单人餐|双人餐|多人餐|拼盘|乐园餐|超值|桶/;
const COMBO_TAG_RE = /套餐|组合|拼盘|乐园餐/;

export function isComboEntry(item) {
  const name = String(item?.name ?? '');
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  return COMBO_NAME_RE.test(name) || tags.some((t) => COMBO_TAG_RE.test(String(t)));
}

/**
 * 名称归一化：抹平「麦辣鸡腿汉堡」vs「麦辣鸡腿堡」这类叫法差异。
 * 只做等价替换，不做截断，避免把不同商品误并。
 */
function normalizeName(s) {
  return String(s ?? '')
    .replace(/\s+/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/汉堡/g, '堡')
    .replace(/鸡腿堡/g, '鸡腿堡')
    .toLowerCase();
}

/** 二元组 Dice 相似度，用于模糊匹配（0~1） */
function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const gram = (s) => {
    const out = [];
    for (let i = 0; i < s.length - 1; i += 1) out.push(s.slice(i, i + 2));
    return out;
  };
  const ga = gram(a);
  const gb = gram(b);
  if (!ga.length || !gb.length) return 0;
  const pool = new Map();
  for (const g of ga) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of gb) {
    const n = pool.get(g) ?? 0;
    if (n > 0) { hit += 1; pool.set(g, n - 1); }
  }
  return (2 * hit) / (ga.length + gb.length);
}

/**
 * 在菜单里按关键词匹配用户"想吃的东西"。
 *
 * 排序原则：**单品永远优先于套餐**——套餐是一种购买路径，不是用户想吃的目标本身。
 * 实测「麦辣鸡腿堡」若不归一化，只会命中「麦辣鸡腿堡四件套」（¥28 麦金卡价），
 * 而真正的单品叫「麦辣鸡腿汉堡」（¥22.5）。
 *
 * @returns {Array} 候选（含 _score / _sim / isCombo），已按优先级排序
 */
export function matchTargets(menu, keyword) {
  const kw = String(keyword ?? '').trim();
  if (!kw) return [];
  const nkw = normalizeName(kw);

  const scored = [];
  for (const m of menu) {
    const name = String(m.name ?? '');
    const nn = normalizeName(name);
    let score = null;
    if (nn === nkw) score = 0;                          // 归一化后精确同名
    else if (name.includes(kw)) score = 1;              // 原名直接包含
    else if (nn.includes(nkw)) score = 2;               // 归一化后包含
    if (score === null) {
      const sim = dice(nn, nkw);
      if (sim >= 0.7) score = 3;                        // 模糊相似
      else if (sim >= 0.5) score = 4;
      else continue;
    }
    scored.push({
      ...m,
      isCombo: isComboEntry(m),
      _score: score,
      _sim: Math.round(dice(nn, nkw) * 100) / 100,
    });
  }

  // 单品组在前，套餐组在后；组内按匹配度
  scored.sort((a, b) => {
    if (a.isCombo !== b.isCombo) return a.isCombo ? 1 : -1;
    if (a._score !== b._score) return a._score - b._score;
    return b._sim - a._sim;
  });
  return scored.slice(0, 10);
}

/**
 * 从候选中挑出「用户想吃的目标单品」。
 * 没有单品命中时返回 null，由调用方决定降级提示（不拿套餐冒充目标）。
 */
export function pickTarget(candidates) {
  return candidates.find((c) => !c.isCombo) ?? null;
}

/**
 * 判定某个组成项是否可以单独购买。
 * 依据：该 code 是否出现在门店单点菜单中（菜单里的商品都是可单点的）。
 */
export function isIndividuallyOrderable(code, menuDict) {
  return Boolean(code) && menuDict instanceof Map && menuDict.has(String(code));
}

/**
 * 分析「买套餐」相对「买单品」的划算程度。
 *
 * @param {object} input
 * @param {object} input.target        想吃的目标单品 { code, name, price }
 * @param {object} input.combo         套餐条目 { code, name, price }
 * @param {Array}  input.rounds        query-meal-detail 返回的 rounds
 * @param {Map}    input.menuDict      code → 菜单条目（用于判断是否可单点）
 * @param {number} input.comboPrice    **官方算价**得到的套餐价
 * @param {number} input.targetPrice   **官方算价**得到的单品价
 * @param {number} [input.extrasValue] **官方算价**得到的多得部分合计；缺省时退回菜单价并标注为估算
 *
 * ⚠️ 价格口径：实测「菜单展示价」与「官方算价」在部分商品上不一致
 *    （如板烧鸡腿堡四件套菜单 ¥28 / 官方算价 ¥57，菜单展示的是起价）。
 *    因此**一律以 calculate-price 的官方算价为准**，菜单价仅作兜底。
 */
export function analyzeCombo(input) {
  const { target, combo, rounds = [], menuDict } = input;
  const comboPrice = Number(input.comboPrice ?? 0);
  const targetPrice = Number(input.targetPrice ?? 0);
  if (!comboPrice || !targetPrice) return null;

  // 取每个 round 的默认选项作为「套餐默认配置」
  const parts = [];
  for (const round of rounds) {
    const choices = round?.choices ?? [];
    const def = choices.find((c) => c.isDefault === 1) ?? choices[0];
    if (!def) continue;
    const code = String(def.code ?? '');
    parts.push({
      code,
      name: def.name ?? '',
      roundName: round?.name ?? '',
      diffPrice: def.diffPrice ?? '',
      quantity: Number(def.quantity ?? 1) || 1,
    });
  }

  // 区分：套餐自带的目标项 / 多得的项
  const extras = parts.filter((p) => p.code !== String(target.code));
  const matchedTarget = parts.some((p) => p.code === String(target.code));

  const evaluable = [];
  const exclusive = [];
  let menuValue = 0;
  for (const p of extras) {
    const menuItem = menuDict?.get(p.code);
    if (menuItem) {
      evaluable.push({
        code: p.code,
        name: p.name || menuItem.name,
        price: menuItem.price,
        orderable: true,
      });
      menuValue += Number(menuItem.price ?? 0);
    } else {
      exclusive.push({
        code: p.code,
        name: p.name,
        price: null,
        orderable: false,
      });
    }
  }

  // 优先采用官方算价；拿不到才退回菜单价，并如实标注来源
  const useOfficial = typeof input.extrasValue === 'number' && input.extrasValue > 0;
  const extraValue = Math.round((useOfficial ? input.extrasValue : menuValue) * 100) / 100;
  const valueSource = useOfficial ? 'official' : 'menu';
  const delta = Math.round((comboPrice - targetPrice) * 100) / 100;
  const netGain = Math.round((extraValue - delta) * 100) / 100;

  // 菜单展示价 vs 官方算价不一致时如实提示。
  // 实测：麦辣鸡腿堡四件套 菜单 ¥28（麦金卡会员价）/ 官方算价 ¥57。
  // 若静默按官方价判"不划算"，对会员用户是误导，因此必须显式标注差额来源。
  const menuPrice = Number(combo.price ?? 0) || null;
  const priceNote = menuPrice && Math.abs(menuPrice - comboPrice) >= 1
    ? `菜单展示价 ¥${menuPrice} 与官方算价 ¥${comboPrice} 不一致（疑似会员/活动价），本结果以官方算价为准；若你享该优惠，实际更划算`
    : '';

  return {
    combo: { code: String(combo.code), name: combo.name, price: comboPrice, menuPrice },
    target: { code: String(target.code), name: target.name, price: targetPrice },
    containsTarget: matchedTarget,
    delta,                       // 买套餐相对单买多花的钱
    extras: {
      evaluable,                 // 多得且可单独购买（计入金额）
      exclusive,                 // 多得但无法单点（不计入金额，仅知情）
      value: extraValue,         // 可估值部分合计
      valueSource,               // 'official' 官方算价 | 'menu' 菜单价兜底
    },
    netGain,                     // 可估值部分 - 加价，>0 即套餐划算
    verdict: netGain > 0 ? 'combo' : netGain < 0 ? 'single' : 'tie',
    priceNote,
    note:
      exclusive.length
        ? `另有 ${exclusive.length} 项为套餐专属（官方算价显示无法单点），未计入金额，实际只会更划算`
        : '',
  };
}

/** 多人/大份套餐：划算绝对值往往更高，但偏离"我就想吃一个 X"的诉求 */
const MULTI_RE = /双人|多人|全家|拼盘|桶|7件|7 件|分享/;

/**
 * 汇总所有购买路径并给出推荐。
 *
 * 排序策略（**不是**单纯按净收益高低）：
 *   1. 划算的（净收益 > 0）排在前面
 *   2. 同为划算 — 单人份优先于多人/大份餐
 *   3. 再按「加价」从小到大 —— 用户的核心诉求是"吃到 X"，多花钱是次要的。
 *      实测若只按净收益排，「麦麦周末双人餐」（多花 ¥27.4）会压过
 *      「麦辣鸡腿汉堡三件套」（多花 ¥11），后者才是用户真正想要的答案。
 *
 * 同时单独给出 bestValue（净收益绝对值最高），供 UI 作为「加价升级」备选展示，
 * 保证信息完整、不替用户做唯一决定。
 *
 * @param {Array} paths  analyzeCombo 的结果数组（过滤掉 null）
 */
export function recommend(paths) {
  const usable = paths.filter(Boolean).filter((p) => p.containsTarget);
  if (!usable.length) return { best: null, bestValue: null, paths: usable };

  const rank = (p) => [
    p.netGain > 0 ? 0 : 1,
    MULTI_RE.test(p.combo.name) ? 1 : 0,
    p.delta,
  ];
  const cmp = (a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i += 1) {
      if (ra[i] !== rb[i]) return ra[i] - rb[i];
    }
    return b.netGain - a.netGain;
  };

  const sorted = [...usable].sort(cmp);
  const byValue = [...usable].sort((a, b) => b.netGain - a.netGain);
  return {
    best: sorted[0],
    bestValue: byValue[0]?.netGain > sorted[0]?.netGain ? byValue[0] : null,
    paths: sorted,
  };
}

/**
 * 购物车营养合计（**仅作附加展示，不参与任何决策**）。
 * 匹配不上的项会被跳过并在 coverage 中体现，不猜数据。
 */
export function nutritionSummary(items, lookupNutrition) {
  let energy = 0, protein = 0, fat = 0, carbohydrate = 0, matched = 0;
  for (const it of items) {
    const n = lookupNutrition?.(it.name);
    if (!n) continue;
    matched += 1;
    const q = Number(it.quantity ?? 1) || 1;
    energy += (n.energy ?? 0) * q;
    protein += (n.protein ?? 0) * q;
    fat += (n.fat ?? 0) * q;
    carbohydrate += (n.carbohydrate ?? 0) * q;
  }
  const total = items.length;
  return {
    energy: Math.round(energy),
    protein: Math.round(protein * 10) / 10,
    fat: Math.round(fat * 10) / 10,
    carbohydrate: Math.round(carbohydrate * 10) / 10,
    coverage: total ? matched / total : 0,
    matched,
    total,
  };
}
