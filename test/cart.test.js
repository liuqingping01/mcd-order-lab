/**
 * 购物车方案匹配测试（离线）
 *
 * 覆盖匹配按 code 精确匹配 + 数量贪心抵扣，是最容易出错的一块，钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchCartWithCombo, isUsableOption, rankOptions } from '../src/cart.js';

/** 巨无霸三件套的默认组成：巨无霸 + 中薯条 + 可乐中杯（套餐专属） */
const COMBO_PARTS = [
  { code: '1100', name: '巨无霸', quantity: 1 },
  { code: '4810', name: '中薯条', quantity: 1 },
  { code: '3050', name: '可乐中杯', quantity: 1 },
];

test('matchCartWithCombo: 购物车全部被覆盖时，uncovered 为空、套餐多出的进 surplus', () => {
  const r = matchCartWithCombo(COMBO_PARTS, [
    { code: '1100', quantity: 1 },
    { code: '4810', quantity: 1 },
  ]);
  assert.equal(r.coverCount, 2);
  assert.deepEqual(
    r.covered.map((x) => [x.code, x.quantity]),
    [['1100', 1], ['4810', 1]]
  );
  assert.deepEqual(r.uncovered, []);
  // 可乐是套餐自带的，购物车没要 → surplus
  assert.deepEqual(r.surplus.map((x) => x.code), ['3050']);
});

test('matchCartWithCombo: 只覆盖一部分时，剩下的进 uncovered', () => {
  const r = matchCartWithCombo(COMBO_PARTS, [
    { code: '1100', quantity: 1 },
    { code: '1700', quantity: 1 },   // 麦辣鸡翅，套餐里没有
  ]);
  assert.equal(r.coverCount, 1);
  assert.deepEqual(r.uncovered, [{ code: '1700', quantity: 1 }]);
  assert.deepEqual(r.surplus.map((x) => x.code), ['4810', '3050']);
});

test('matchCartWithCombo: 数量超额时按剩余需求抵扣，多的进 surplus', () => {
  const r = matchCartWithCombo(COMBO_PARTS, [{ code: '1100', quantity: 1 }]);
  // 套餐里的中薯条、可乐购物车没要 → 都进 surplus
  assert.deepEqual(r.surplus.map((x) => x.code), ['4810', '3050']);
  assert.equal(r.coverCount, 1);
});

test('matchCartWithCombo: 购物车同一商品多件，套餐只抵扣其数量上限', () => {
  const r = matchCartWithCombo(
    [{ code: '1100', name: '巨无霸', quantity: 1 }],
    [{ code: '1100', quantity: 3 }]
  );
  assert.equal(r.coverCount, 1);
  assert.deepEqual(r.uncovered, [{ code: '1100', quantity: 2 }]);
  assert.deepEqual(r.surplus, []);
});

test('matchCartWithCombo: 套餐组成不含购物车任何商品时 coverCount 为 0', () => {
  const r = matchCartWithCombo(COMBO_PARTS, [{ code: '9999', quantity: 1 }]);
  assert.equal(r.coverCount, 0);
  assert.deepEqual(r.uncovered, [{ code: '9999', quantity: 1 }]);
});

test('matchCartWithCombo: 空输入不抛错', () => {
  assert.equal(matchCartWithCombo([], []).coverCount, 0);
  assert.equal(matchCartWithCombo(null, null).coverCount, 0);
  assert.deepEqual(matchCartWithCombo(COMBO_PARTS, []).uncovered, []);
});

test('matchCartWithCombo: 按 code 匹配，不因名称相同而误配', () => {
  const r = matchCartWithCombo(
    [{ code: 'AAAA', name: '巨无霸', quantity: 1 }],
    [{ code: 'BBBB', quantity: 1 }]   // 也叫巨无霸，但 code 不同
  );
  assert.equal(r.coverCount, 0);
});

/* ---------- 排序与可用性 ---------- */

test('isUsableOption: 没覆盖或总价为 0 的方案一律丢弃（0 元不能当便宜）', () => {
  assert.equal(isUsableOption({ coverCount: 2, total: 30 }), true);
  assert.equal(isUsableOption({ coverCount: 0, total: 30 }), false);
  assert.equal(isUsableOption({ coverCount: 2, total: 0 }), false);   // 算价失败
  assert.equal(isUsableOption({ coverCount: 2, total: null }), false);
  assert.equal(isUsableOption(null), false);
});

test('rankOptions: 便宜的在前；同价时覆盖件数多的在前', () => {
  const ranked = rankOptions([
    { name: '贵', total: 50, coverCount: 3 },
    { name: '便宜', total: 30, coverCount: 1 },
    { name: '同价覆盖多', total: 30, coverCount: 4 },
    { name: '无效', total: 0, coverCount: 5 },        // 应被过滤
    { name: '不相关', total: 10, coverCount: 0 },     // 应被过滤
  ]);
  assert.deepEqual(ranked.map((x) => x.name), ['同价覆盖多', '便宜', '贵']);
});
