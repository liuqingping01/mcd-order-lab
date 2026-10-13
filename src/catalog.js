/**
 * 菜单「大类」归并
 * ============================================================
 * 用户说"想吃汉堡"，但线上菜单的 category 是
 * 「鸡肉汉堡/卷」「巨无霸牛鱼肉堡」「安格斯MAX厚牛堡」三类，
 * 另有「小食甜品/其他」「麦咖啡™」等共 15 个分类 —— 直接抛给用户太碎。
 *
 * 这里把它们合并成用户认知里的 7 个大类。
 * 匹配用 includes，避免官方微调分类名（如加后缀）导致整类丢失。
 */

export const CATEGORY_GROUPS = [
  // 「人气热卖」是官方推荐位而非品类，但用户确实会想看"大家都在吃什么"，单列一类
  { key: 'hot', name: '人气推荐', cats: ['人气热卖'] },
  { key: 'burger', name: '汉堡', cats: ['鸡肉汉堡', '巨无霸', '安格斯'] },
  { key: 'chicken', name: '炸鸡', cats: ['炸鸡'] },
  { key: 'side', name: '小食甜品', cats: ['小食甜品', '随心配'] },
  { key: 'drink', name: '饮品咖啡', cats: ['饮品', '麦咖啡'] },
  { key: 'combo', name: '超值套餐', cats: ['精选单人餐', '500大卡', '大堡口福'] },
  { key: 'party', name: '多人餐拼盘', cats: ['小食拼盘', '多人餐'] },
  { key: 'kids', name: '开心乐园餐', cats: ['开心乐园'] },
];

/** 返回该 category 所属的大类；匹配不上返回 null（归入「其他」） */
export function groupOf(category) {
  const c = String(category ?? '');
  return CATEGORY_GROUPS.find((g) => g.cats.some((k) => c.includes(k))) ?? null;
}
