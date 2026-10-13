/**
 * 数据适配层测试（离线，零 MCP 调用）
 *
 * 这一层是线上真实结构与决策引擎之间唯一的耦合点，
 * 且踩过 4 个"返回 success 但数据是错的"的坑 —— 每个坑都钉一条用例。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { extractPrice, parseNutritionTable, normalizeNutrition, normalizeMenu } from '../src/adapter.js';

/* ------------------------------------------------------------------ */
/* 坑 1：金额单位是「分」                                              */
/* ------------------------------------------------------------------ */

test('extractPrice: 金额单位是分，必须除以 100', () => {
  const r = extractPrice({
    price: 3350,
    originalPrice: 4000,
    discount: 650,
    productList: [{ productCode: '9900005456', productName: '麦辣鸡腿汉堡三件套', quantity: 1, subtotal: 3350 }],
  });
  assert.equal(r.pay, 33.5);
  assert.equal(r.original, 40);
  assert.equal(r.discount, 6.5);
  assert.equal(r.itemCount, 1);
  assert.equal(r.items[0].code, '9900005456');
});

/* ------------------------------------------------------------------ */
/* 坑 2：productList 为空 = 静默失败，绝不能当 0 元                    */
/* ------------------------------------------------------------------ */

test('extractPrice: productList 为空时返回 null（0 元静默失败防御）', () => {
  // 实测：items 字段误用 code 会导致 success=true 但 price=0、productList=[]
  assert.equal(extractPrice({ price: 0, productList: [] }), null);
  // 实测：可乐中杯 3050、麦乐鸡4块 515106 单独算价即为此形态 → 判定为不可单点
  assert.equal(extractPrice({ success: true, price: 0, productList: [] }), null);
});

test('extractPrice: 入参非对象返回 null', () => {
  assert.equal(extractPrice(null), null);
  assert.equal(extractPrice(undefined), null);
  assert.equal(extractPrice('x'), null);
});

/* ------------------------------------------------------------------ */
/* 坑 3：营养接口返回的不是 JSON，是自定义表格字符串                   */
/* ------------------------------------------------------------------ */

test('parseNutritionTable: 解析真实表格格式', () => {
  const text = [
    '[2]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:',
    '  猪柳麦满分,null,1288,308,16,16,24,781,213',
    '  中薯条,null,1210,289,4,12,38,165,18',
  ].join('\n');

  const rows = parseNutritionTable(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].productName, '中薯条');
  assert.equal(rows[1].energyKcal, '289');
});

test('parseNutritionTable: 列数不足的行被跳过，非字符串输入返回空', () => {
  const text = [
    '[2]{productName,energyKcal}:',
    '  中薯条,289',
    '  残缺行',
  ].join('\n');
  assert.equal(parseNutritionTable(text).length, 1);

  assert.deepEqual(parseNutritionTable(null), []);
  assert.deepEqual(parseNutritionTable(''), []);
  assert.deepEqual(parseNutritionTable('没有表头的文本'), []);
});

test('normalizeNutrition: 热量字段名是 energyKcal', () => {
  const n = normalizeNutrition({
    productName: '中薯条', energyKj: '1210', energyKcal: '289',
    protein: '4', fat: '12', carbohydrate: '38', sodium: '165', calcium: '18',
  });
  assert.equal(n.key, '中薯条');
  assert.equal(n.energy, 289);
  assert.equal(n.protein, 4);
  assert.equal(n.carbohydrate, 38);
});

/* ------------------------------------------------------------------ */
/* 坑 4：菜单的名称价格不在同一个地方，要做 join                       */
/* ------------------------------------------------------------------ */

test('normalizeMenu: categories 与 meals 字典 join 出完整菜单', () => {
  const menu = normalizeMenu({
    categories: [
      { name: '汉堡', meals: [{ code: '1440', tags: ['单品', '人气经典'] }] },
    ],
    meals: {
      1440: { name: '麦辣鸡腿汉堡', currentPrice: 22.5, originalPrice: 25, image: 'x.png' },
    },
  });

  assert.equal(menu.length, 1);
  assert.equal(menu[0].code, '1440');
  assert.equal(menu[0].name, '麦辣鸡腿汉堡');   // 来自 meals 字典
  assert.equal(menu[0].price, 22.5);
  assert.equal(menu[0].category, '汉堡');        // 来自 categories
  assert.deepEqual(menu[0].tags, ['单品', '人气经典']);
  assert.equal(menu[0].detailMissing, false);
});

test('normalizeMenu: 只在 meals 字典里的条目也要兜底收进来', () => {
  const menu = normalizeMenu({
    categories: [],
    meals: { 9999: { name: '游离商品', currentPrice: 9.9 } },
  });
  assert.equal(menu.length, 1);
  assert.equal(menu[0].category, '未分类');
});

test('normalizeMenu: code 未出现在 meals 字典时标记 detailMissing', () => {
  const menu = normalizeMenu({
    categories: [{ name: 'x', meals: [{ code: '1234', tags: [] }] }],
    meals: {},
  });
  assert.equal(menu[0].detailMissing, true);
  assert.equal(menu[0].price, 0);
});
