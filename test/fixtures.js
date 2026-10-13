/**
 * 测试夹具
 * ============================================================
 * 数据来源分两类，都标注清楚，避免"测试里的数据是我编的"这种自欺：
 *
 *   A) 真实菜单：读 examples/query-meals.real.json（线上真实响应，已 gitignore）
 *   B) 手工固化的观测值：来自 scripts/inspect-combo.js 的实跑输出，
 *      每一条都在文件里标注了观测时间、门店与来源命令。
 *
 * 全部测试**不发起任何网络请求、不消耗 MCP 调用额度**。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeMenu, parseNutritionTable, normalizeNutrition } from '../src/adapter.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

/**
 * 真实菜单（128 项）。
 * 文件缺失时给出明确指引，而不是静默返回空数组让测试"假通过"。
 */
export function realMenu() {
  const p = resolve(projectRoot, 'examples', 'query-meals.real.json');
  if (!existsSync(p)) {
    throw new Error(
      `缺少真实菜单样例：${p}\n` +
      '该文件由线上探测生成且已 gitignore。请先配置 .env 后运行：node scripts/probe.js'
    );
  }
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  return normalizeMenu(raw.data ?? raw);
}

export function realMenuDict() {
  return new Map(realMenu().map((m) => [m.code, m]));
}

export function realNutrition() {
  const p = resolve(projectRoot, 'examples', 'list-nutrition-foods.real.json');
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  return parseNutritionTable(raw.data ?? raw).map(normalizeNutrition);
}

/* ------------------------------------------------------------------ */
/* 以下为实跑观测值的手工固化                                          */
/* 观测时间：2026-10-10 16:20                                          */
/* 门店：麦当劳杭州国大城市广场餐厅（storeCode 3330387）                */
/* 来源：node scripts/inspect-combo.js <code> --price-parts            */
/* ------------------------------------------------------------------ */

/**
 * 麦辣鸡腿汉堡三件套（code 9900005456）
 * 官方算价 ¥33.5；组成：麦辣鸡腿汉堡 + 中薯条 + 可乐中杯
 * 逐项单独算价：1440 → ¥22.5 可单点 / 4810 → ¥14.5 可单点 / 3050 → productList 为空（不可单点）
 */
export const COMBO_3 = {
  code: '9900005456',
  name: '麦辣鸡腿汉堡三件套',
  price: 33.5,          // 菜单展示价（与官方算价一致，故不应触发 priceNote）
  officialPrice: 33.5,
  rounds: [
    {
      name: '麦辣鸡腿汉堡',
      choices: [{ code: '1440', name: '麦辣鸡腿汉堡', quantity: 1, isDefault: 1, diffPrice: '+ ¥0' }],
    },
    {
      name: '选择套餐内小食',
      choices: [
        { code: '4810', name: '中薯条', quantity: 1, isDefault: 1, diffPrice: '+ ¥0' },
        { code: '4820', name: '大薯条', quantity: 1, isDefault: 0, diffPrice: '+ ¥1.5' },
      ],
    },
    {
      name: '选择套餐内饮料',
      choices: [
        { code: '3050', name: '可乐中杯', quantity: 1, isDefault: 1, diffPrice: '+ ¥0' },
        { code: '3060', name: '雪碧中杯', quantity: 1, isDefault: 0, diffPrice: '+ ¥0' },
      ],
    },
  ],
  extrasOfficialValue: 14.5,   // 中薯条单独算价；可乐不可单点故不计
};

/**
 * 麦辣鸡腿堡四件套（code 9900000891）
 * 官方算价 ¥57，但**菜单展示价 ¥28**（tags 含"麦金卡"，疑为会员价）——用于验证价格口径冲突提示
 * 组成：麦辣鸡腿汉堡 + 中薯条 + 麦乐鸡4块 + 可乐中杯
 * 逐项单独算价：515106（麦乐鸡4块）→ productList 为空（不可单点）
 */
export const COMBO_4 = {
  code: '9900000891',
  name: '麦辣鸡腿堡四件套',
  price: 28,            // 菜单展示价
  officialPrice: 57,    // 官方算价
  rounds: [
    {
      name: '麦辣鸡腿汉堡',
      choices: [{ code: '1440', name: '麦辣鸡腿汉堡', quantity: 1, isDefault: 1, diffPrice: '+ ¥0' }],
    },
    {
      name: '小食',
      choices: [{ code: '4810', name: '中薯条', quantity: 1, isDefault: 1, diffPrice: '+ ¥0' }],
    },
    {
      name: '小食',
      choices: [{ code: '515106', name: '麦乐鸡4块', quantity: 1, isDefault: 1, diffPrice: '+ ¥0' }],
    },
    {
      name: '选择套餐内饮料',
      choices: [{ code: '3050', name: '可乐中杯', quantity: 1, isDefault: 1, diffPrice: '+ ¥0' }],
    },
  ],
  extrasOfficialValue: 14.5,   // 麦乐鸡4块与可乐均不可单点，只有中薯条计入
};

/** 目标单品：麦辣鸡腿汉堡（code 1440），官方单点价 ¥22.5 */
export const TARGET_BURGER = { code: '1440', name: '麦辣鸡腿汉堡', price: 22.5 };
