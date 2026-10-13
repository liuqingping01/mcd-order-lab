/**
 * 菜单大类归并测试（离线）
 *
 * 归并靠字符串 includes，官方一旦改分类名就会静默丢类 —— 所以钉住。
 * 分类名取自 examples/query-meals.real.json 的实测值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY_GROUPS, groupOf } from '../src/catalog.js';
import { realMenu } from './fixtures.js';

test('groupOf: 实测的 15 个分类都能归并，不落进「其他」', () => {
  const menu = realMenu();
  const cats = [...new Set(menu.map((m) => m.category))];
  const unknown = cats.filter((c) => groupOf(c) === null);
  assert.deepEqual(unknown, [], `这些分类没被归并：${unknown.join('、')}`);
});

test('groupOf: 汉堡相关三类都归到 burger', () => {
  for (const c of ['鸡肉汉堡/卷', '巨无霸牛鱼肉堡', '安格斯MAX厚牛堡']) {
    assert.equal(groupOf(c)?.key, 'burger', `${c} 应归入汉堡`);
  }
});

test('groupOf: 炸鸡与蘸酱炸鸡都归到 chicken', () => {
  assert.equal(groupOf('炸鸡')?.key, 'chicken');
  assert.equal(groupOf('蘸酱炸鸡')?.key, 'chicken');
  assert.equal(groupOf('小食甜品/其他')?.key, 'side');
  assert.equal(groupOf('麦咖啡™')?.key, 'drink');
  assert.equal(groupOf('小食拼盘/多人餐')?.key, 'party');
  assert.equal(groupOf('开心乐园')?.key, 'kids');
});

test('groupOf: 分类名带后缀也能匹配（includes 而非全等）', () => {
  assert.equal(groupOf('巨无霸牛鱼肉堡（新）')?.key, 'burger');
  assert.equal(groupOf('精选单人餐A')?.key, 'combo');
});

test('groupOf: 空值/未知返回 null，不抛错', () => {
  assert.equal(groupOf(''), null);
  assert.equal(groupOf(null), null);
  assert.equal(groupOf(undefined), null);
  assert.equal(groupOf('完全没见过的分类'), null);
});

test('每个大类在真实菜单里都至少有一款商品（无空入口）', () => {
  const menu = realMenu();
  for (const g of CATEGORY_GROUPS) {
    const n = menu.filter((m) => groupOf(m.category)?.key === g.key).length;
    assert.ok(n > 0, `大类「${g.name}」在真实菜单里为空`);
  }
});
