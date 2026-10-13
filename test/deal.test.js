/**
 * 购买路径对比引擎的单元测试（离线，零 MCP 调用）
 *
 * 重点覆盖 2026-10-10 修复的 3 个真实 bug —— 每个 bug 都有一条回归用例钉住，
 * 防止后续改动把它们改回去。
 *
 * 运行：node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  matchTargets, pickTarget, isComboEntry, analyzeCombo, recommend, nutritionSummary,
} from '../src/deal.js';
import { realMenu, realMenuDict, COMBO_3, COMBO_4, TARGET_BURGER } from './fixtures.js';

/* ------------------------------------------------------------------ */
/* BUG 1：套餐判定不能只靠 tags                                        */
/* ------------------------------------------------------------------ */

test('isComboEntry: tags 只有「麦金卡」的四件套也必须判为套餐', () => {
  // 实测：麦辣鸡腿堡四件套 tags = ["麦金卡"]，不含"套餐"
  assert.equal(isComboEntry({ name: '麦辣鸡腿堡四件套', tags: ['麦金卡'] }), true);
  assert.equal(isComboEntry({ name: '安格斯厚牛堡四件套随心选', tags: ['麦金卡'] }), true);
  assert.equal(isComboEntry({ name: '麦辣鸡腿汉堡三件套', tags: ['套餐', '立省10.5元起'] }), true);
  assert.equal(isComboEntry({ name: '汉堡开心乐园餐', tags: ['开心乐园餐'] }), true);
  assert.equal(isComboEntry({ name: '堡堡随心拼（7件任选）', tags: ['小食拼盘'] }), true);
});

test('isComboEntry: 普通单品不能被误判为套餐', () => {
  assert.equal(isComboEntry({ name: '麦辣鸡腿汉堡', tags: ['单品', '人气经典'] }), false);
  assert.equal(isComboEntry({ name: '巨无霸', tags: ['单品'] }), false);
  assert.equal(isComboEntry({ name: '中薯条', tags: ['小食'] }), false);
});

test('BUG 回归：按 tags 找套餐会漏掉 2/3，按名称特征才能覆盖全', () => {
  // ⚠️ 数值取自 examples/query-meals.real.json（2026-10-09 杭州黄龙万科中心店，128 项）。
  //    另一家门店（国大城市广场，2026-10-10 实跑）是 16 vs 56 —— 门店菜单不同，
  //    断言不能跨门店混用，这里只锁缓存菜单的实测值。
  const menu = realMenu();
  const byTag = menu.filter((m) => m.tags.includes('套餐')).length;
  const byName = menu.filter(isComboEntry).length;

  assert.equal(byTag, 16);
  assert.equal(byName, 54);
  assert.ok(byName > byTag * 3, `名称特征应覆盖远多于 tags：byName=${byName} byTag=${byTag}`);
});

/* ------------------------------------------------------------------ */
/* BUG 2：目标匹配要命中单品，且能跨叫法差异                           */
/* ------------------------------------------------------------------ */

test('matchTargets: 「麦辣鸡腿堡」应命中单品「麦辣鸡腿汉堡」（¥22.5）而非四件套', () => {
  const menu = realMenu();
  const hits = matchTargets(menu, '麦辣鸡腿堡');
  assert.ok(hits.length > 0, '应有命中');

  const target = pickTarget(hits);
  assert.ok(target, '应能选出非套餐目标');
  assert.equal(target.code, '1440');
  assert.equal(target.name, '麦辣鸡腿汉堡');
  assert.equal(target.price, 22.5);
});

test('matchTargets: 单品永远排在套餐之前', () => {
  const menu = realMenu();
  for (const kw of ['巨无霸', '板烧鸡腿堡', '麦香鸡']) {
    const hits = matchTargets(menu, kw);
    const firstComboIdx = hits.findIndex((h) => h.isCombo);
    const lastSingleIdx = hits.map((h) => h.isCombo).lastIndexOf(false);
    if (firstComboIdx !== -1 && lastSingleIdx !== -1) {
      assert.ok(lastSingleIdx < firstComboIdx, `「${kw}」的套餐不应排在单品之前`);
    }
  }
});

test('matchTargets: 精确同名的单品排第一', () => {
  const menu = realMenu();
  assert.equal(matchTargets(menu, '巨无霸')[0].name, '巨无霸');
  assert.equal(matchTargets(menu, '板烧鸡腿堡')[0].name, '板烧鸡腿堡');
});

test('pickTarget: 只有套餐命中时返回 null（不拿套餐冒充"想吃的东西"）', () => {
  const onlyCombos = [
    { code: '1', name: '麦辣鸡腿堡四件套', isCombo: true },
    { code: '2', name: '巨无霸三件套', isCombo: true },
  ];
  assert.equal(pickTarget(onlyCombos), null);
});

test('matchTargets: 空关键词返回空数组', () => {
  assert.deepEqual(matchTargets(realMenu(), ''), []);
  assert.deepEqual(matchTargets(realMenu(), '   '), []);
});

/* ------------------------------------------------------------------ */
/* 核心算法：analyzeCombo                                              */
/* ------------------------------------------------------------------ */

test('analyzeCombo: 三件套 —— 多花 ¥11 换到中薯条 ¥14.5，净赚 ¥3.5', () => {
  const r = analyzeCombo({
    target: TARGET_BURGER,
    combo: COMBO_3,
    rounds: COMBO_3.rounds,
    menuDict: realMenuDict(),
    comboPrice: COMBO_3.officialPrice,
    targetPrice: TARGET_BURGER.price,
    extrasValue: COMBO_3.extrasOfficialValue,
  });

  assert.equal(r.containsTarget, true);
  assert.equal(r.delta, 11);              // 33.5 - 22.5
  assert.equal(r.extras.value, 14.5);
  assert.equal(r.extras.valueSource, 'official');
  assert.equal(r.netGain, 3.5);           // 14.5 - 11
  assert.equal(r.verdict, 'combo');

  // 分类：中薯条可单点，可乐中杯为套餐专属
  const evalNames = r.extras.evaluable.map((e) => e.name);
  const exclNames = r.extras.exclusive.map((e) => e.name);
  assert.deepEqual(evalNames, ['中薯条']);
  assert.deepEqual(exclNames, ['可乐中杯']);
  assert.ok(r.note.includes('套餐专属'), '应提示存在套餐专属项');

  // 菜单价与官方价一致，不应触发价格冲突提示
  assert.equal(r.priceNote, '');
});

test('analyzeCombo: 四件套 —— 官方价 ¥57 但菜单价 ¥28，必须提示价格口径冲突', () => {
  const r = analyzeCombo({
    target: TARGET_BURGER,
    combo: COMBO_4,
    rounds: COMBO_4.rounds,
    menuDict: realMenuDict(),
    comboPrice: COMBO_4.officialPrice,
    targetPrice: TARGET_BURGER.price,
    extrasValue: COMBO_4.extrasOfficialValue,
  });

  assert.equal(r.delta, 34.5);            // 57 - 22.5
  assert.equal(r.netGain, -20);           // 14.5 - 34.5
  assert.equal(r.verdict, 'single');
  assert.ok(r.priceNote.includes('¥28'), '应明示菜单展示价 ¥28');
  assert.ok(r.priceNote.includes('¥57'), '应明示官方算价 ¥57');

  // 麦乐鸡4块与可乐中杯均不可单点 → 2 项套餐专属
  assert.equal(r.extras.exclusive.length, 2);
  assert.equal(r.extras.evaluable.length, 1);
});

test('analyzeCombo: 套餐专属项不计入金额，净收益因此是保守下界', () => {
  const withOfficial = analyzeCombo({
    target: TARGET_BURGER, combo: COMBO_4, rounds: COMBO_4.rounds,
    menuDict: realMenuDict(), comboPrice: 57, targetPrice: 22.5, extrasValue: 14.5,
  });
  // 没有官方估值时退回菜单价，金额只会更低或相等 —— 不会凭空变高
  const withoutOfficial = analyzeCombo({
    target: TARGET_BURGER, combo: COMBO_4, rounds: COMBO_4.rounds,
    menuDict: realMenuDict(), comboPrice: 57, targetPrice: 22.5,
  });
  assert.equal(withoutOfficial.extras.valueSource, 'menu');
  assert.ok(withoutOfficial.extras.value <= withOfficial.extras.value);
});

test('analyzeCombo: 价格缺失时返回 null，不返回看似正常的 0 元结论', () => {
  assert.equal(analyzeCombo({
    target: TARGET_BURGER, combo: COMBO_3, rounds: COMBO_3.rounds,
    menuDict: realMenuDict(), comboPrice: 0, targetPrice: 22.5,
  }), null);
  assert.equal(analyzeCombo({
    target: TARGET_BURGER, combo: COMBO_3, rounds: COMBO_3.rounds,
    menuDict: realMenuDict(), comboPrice: 33.5, targetPrice: 0,
  }), null);
});

test('analyzeCombo: 套餐不含目标商品时 containsTarget 为 false', () => {
  const r = analyzeCombo({
    target: { code: '9999', name: '不存在的商品', price: 10 },
    combo: COMBO_3, rounds: COMBO_3.rounds,
    menuDict: realMenuDict(), comboPrice: 33.5, targetPrice: 10,
  });
  assert.equal(r.containsTarget, false);
});

/* ------------------------------------------------------------------ */
/* BUG 3：排序不能只看净收益绝对值                                     */
/* ------------------------------------------------------------------ */

const path = (name, delta, netGain) => ({
  combo: { code: name, name, price: 0 },
  target: { code: '1440', name: '麦辣鸡腿汉堡', price: 22.5 },
  containsTarget: true, delta, netGain,
  extras: { evaluable: [], exclusive: [], value: 0, valueSource: 'official' },
  verdict: netGain > 0 ? 'combo' : 'single', note: '', priceNote: '',
});

test('BUG 回归：净收益最高的双人餐不能压过加价更少的单人套餐', () => {
  // 2026-10-10 实测：主推荐曾被「麦麦周末双人餐」（多花 ¥27.4）抢走
  const { best, bestValue } = recommend([
    path('麦辣鸡腿汉堡三件套', 11, 3.5),
    path('麦麦周末双人餐', 27.4, 9.1),
    path('麦辣鸡腿堡四件套', 34.5, -20),
  ]);

  assert.equal(best.combo.name, '麦辣鸡腿汉堡三件套', '单人份且加价小的应为主推荐');
  assert.ok(bestValue, '净收益更高者应作为「加价升级」备选另行展示');
  assert.equal(bestValue.combo.name, '麦麦周末双人餐');
});

test('recommend: 划算的排在亏损的前面', () => {
  const { paths } = recommend([
    path('亏的四件套', 34.5, -20),
    path('赚的三件套', 11, 3.5),
  ]);
  assert.equal(paths[0].combo.name, '赚的三件套');
});

test('recommend: 同为划算时按加价从小到大', () => {
  const { paths } = recommend([
    path('贵套餐', 50, 8),
    path('便宜套餐', 10, 3),
  ]);
  assert.equal(paths[0].combo.name, '便宜套餐');
});

test('recommend: 过滤掉不含目标商品的路径；全为空时返回 null', () => {
  const bad = { ...path('无关套餐', 10, 5), containsTarget: false };
  const { best } = recommend([bad]);
  assert.equal(best, null);

  assert.deepEqual(recommend([]), { best: null, bestValue: null, paths: [] });
});

test('recommend: 主推荐本身就是净收益最高时，不再重复给 bestValue', () => {
  const { best, bestValue } = recommend([path('唯一套餐', 11, 3.5)]);
  assert.equal(best.combo.name, '唯一套餐');
  assert.equal(bestValue, null);
});

/* ------------------------------------------------------------------ */
/* 营养附加（不参与决策，但要如实反映覆盖率）                          */
/* ------------------------------------------------------------------ */

test('nutritionSummary: 匹配不上的项跳过并体现覆盖率，不编数值', () => {
  const lookup = (name) => ({ '中薯条': { energy: 289, protein: 4, fat: 12, carbohydrate: 38 } })[name];
  const r = nutritionSummary(
    [{ name: '中薯条', quantity: 1 }, { name: '可乐中杯', quantity: 1 }],
    lookup
  );
  assert.equal(r.energy, 289);
  assert.equal(r.matched, 1);
  assert.equal(r.total, 2);
  assert.equal(r.coverage, 0.5);
});

test('nutritionSummary: 数量倍率生效', () => {
  const lookup = () => ({ energy: 100, protein: 1, fat: 1, carbohydrate: 1 });
  assert.equal(nutritionSummary([{ name: 'x', quantity: 3 }], lookup).energy, 300);
});

test('nutritionSummary: 空购物车不炸，coverage 为 0', () => {
  const r = nutritionSummary([], () => null);
  assert.equal(r.energy, 0);
  assert.equal(r.coverage, 0);
});
