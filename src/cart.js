/**
 * 购物车 → 套餐方案对比
 * ============================================================
 * 回答一个问题：**购物车里这几样，全买单品划算，还是换个套餐更划算？**
 *
 * 场景：用户往购物车加了「巨无霸 + 中薯条」，其实「巨无霸三件套」就含这两样再多一杯可乐，
 *      而且可能更便宜。这个模块负责找出这种可能性。
 *
 * 口径（与 deal.js 保持一致）
 * --------------------------
 * 1) 所有金额由调用方传入，**本模块不参与计价**，只做集合运算。
 * 2) 套餐组成里可能有「套餐专属商品」（无法单点），它们会出现在 surplus 里，
 *    是"白送的"，不影响 covered / uncovered 的判定。
 * 3) 匹配按 code 精确匹配 + 数量贪心抵扣，不做名称模糊匹配 —— 避免把不同商品当成同一个。
 */

/**
 * 用套餐的默认组成去抵扣购物车。
 *
 * @param {Array} parts 套餐默认组成 [{ code, name, quantity }]
 * @param {Array} cart  购物车条目 [{ code, quantity }]
 * @returns {{
 *   covered:   Array<{code, quantity, name}>,  // 购物车中被套餐覆盖掉的
 *   uncovered: Array<{code, quantity}>,        // 套餐没覆盖、仍需单点的
 *   surplus:   Array<{code, quantity, name}>,  // 套餐里多出来的（含套餐专属品）
 *   coverCount: number                          // 覆盖的件数，0 表示完全不相关
 * }}
 */
export function matchCartWithCombo(parts, cart) {
  const need = new Map();
  for (const it of cart ?? []) {
    const code = String(it.code ?? '');
    if (!code) continue;
    need.set(code, (need.get(code) ?? 0) + (Number(it.quantity) || 1));
  }

  const covered = [];
  const surplus = [];

  for (const p of parts ?? []) {
    const code = String(p.code ?? '');
    if (!code) continue;
    const qty = Number(p.quantity) || 1;
    const left = need.get(code) ?? 0;
    const take = Math.min(left, qty);
    if (take > 0) {
      need.set(code, left - take);
      covered.push({ code, quantity: take, name: p.name ?? '' });
    }
    if (qty - take > 0) {
      surplus.push({ code, quantity: qty - take, name: p.name ?? '' });
    }
  }

  const uncovered = [];
  for (const [code, quantity] of need) {
    if (quantity > 0) uncovered.push({ code, quantity });
  }

  return {
    covered,
    uncovered,
    surplus,
    coverCount: covered.reduce((s, x) => s + x.quantity, 0),
  };
}

/**
 * 判断某个购物车方案是否值得展示给用户。
 *
 * 过滤规则：
 *   - 一件都没覆盖 → 不相关，丢弃
 *   - 官方算价失败（total 为 0 或空）→ 丢弃，绝不用 0 元充当便宜
 */
export function isUsableOption(option) {
  if (!option) return false;
  if (!option.coverCount) return false;
  return Number(option.total) > 0;
}

/**
 * 给方案排序：便宜的在前；同价时覆盖件数多的在前（更贴合用户原本想买的东西）。
 */
export function rankOptions(options) {
  return [...options.filter(isUsableOption)].sort((a, b) => {
    if (a.total !== b.total) return a.total - b.total;
    return b.coverCount - a.coverCount;
  });
}
