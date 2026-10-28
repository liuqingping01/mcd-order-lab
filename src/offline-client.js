/**
 * 离线演示模式的 MCP 客户端
 * ============================================================
 * 目的：让产品在没有 Token 的环境下也能完整跑通——用于公开部署的演示站点，
 *       避免把个人 MCP Token 放到公网。
 *
 * 设计要点：
 *   1) 对外接口与 McdMcpClient 完全一致（initialize / listTools / callToolJson），
 *      因此 server.js 里的 buildPlan / buildDeal / buildExplore / buildCart
 *      一行都不用改。
 *   2) 所有数据来自 scripts/build-demo-dataset.js 预生成的真实快照，
 *      **包括官方 calculate-price 的真实结果**——结论不是估算出来的。
 *   3) 预生成时已按「套餐 × 目标单品」穷举过会真实发生的组合，
 *      所以主线比价全部命中真实数据；只有购物车的任意组合无法穷举，
 *      这类组合会按单项实价求和，并通过 `usedSynthetic` 标记暴露出去，
 *      由前端如实标注，绝不冒充官方整单算价。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { projectRoot } from './env.js';

const CENTS = 100;

export function datasetPath() {
  return resolve(projectRoot, 'demo', 'dataset.json');
}

export function hasDataset() {
  return existsSync(datasetPath());
}

function env(data) {
  return { success: true, code: 200, message: '请求成功', data };
}

function fail(message) {
  return { success: false, code: 500, message };
}

function priceKey(items) {
  return (items ?? [])
    .map((i) => `${i.productCode}x${i.quantity ?? 1}`)
    .sort()
    .join('_');
}

export class OfflineMcpClient {
  constructor() {
    const p = datasetPath();
    if (!existsSync(p)) {
      throw new Error(`离线数据集不存在：${p}。请先执行 node scripts/build-demo-dataset.js 生成。`);
    }
    this.dataset = JSON.parse(readFileSync(p, 'utf8'));
    /** 本请求周期内是否用过「合成价格」（供上层如实标注） */
    this.usedSynthetic = false;
    this.serverInfo = {
      name: 'mcd-offline-demo',
      version: this.dataset.generatedAt,
    };
  }

  async initialize() {
    return this.serverInfo;
  }

  async listTools() {
    return this.dataset.tools ?? [];
  }

  async callToolJson(name, args = {}) {
    switch (name) {
      case 'now-time-info':
      case 'query-nearby-stores':
      case 'query-meals':
      case 'list-nutrition-foods':
      case 'available-coupons':
      case 'campaign-calendar': {
        const raw = this.dataset.static?.[name];
        return raw ?? fail(`演示数据集没有「${name}」的快照`);
      }

      case 'query-meal-detail': {
        const raw = this.dataset.mealDetail?.[String(args.code ?? '')];
        return raw ?? fail(`演示数据集没有套餐 ${args.code} 的明细快照`);
      }

      case 'calculate-price':
        return this.#price(args);

      // 演示模式不做任何写操作
      case 'create-order':
      case 'query-my-account':
      case 'delivery-query-addresses':
        return fail(`演示模式不提供「${name}」，请在本机配置 Token 后使用`);

      default:
        return fail(`演示模式未收录工具「${name}」`);
    }
  }

  /**
   * 算价：优先返回真实快照；查不到且组合内每项都有单项实价时，按求和合成。
   * 合成结果一定伴随 usedSynthetic 标记，不允许被当作官方整单算价呈现。
   */
  #price(args) {
    const items = Array.isArray(args?.items) ? args.items : [];
    const key = priceKey(items);
    const hit = this.dataset.prices?.[key];

    if (hit) return env(hit);

    // 逐项求和：先看能不能凑出来
    const productList = [];
    let cents = 0;
    let originalCents = 0;
    for (const it of items) {
      const code = String(it.productCode ?? it.code ?? '');
      const qty = Number(it.quantity ?? 1);
      const single = this.dataset.prices?.[`${code}x1`];
      if (!single) return fail(`演示数据集未收录该组合的官方算价（缺少 ${code}）`);
      const unit = Number(single.price ?? 0);
      const unitOriginal = Number(single.originalPrice ?? single.price ?? 0);
      if (!unit) return fail(`演示数据集未收录该组合的官方算价（缺少 ${code}）`);
      cents += unit * qty;
      originalCents += unitOriginal * qty;
      const src = (single.productList ?? [])[0] ?? {};
      productList.push({
        productCode: code,
        productName: src.productName ?? src.name ?? '',
        quantity: qty,
        subtotal: unit * qty,
      });
    }

    this.usedSynthetic = true;
    return {
      ...env({
        price: cents,
        originalPrice: originalCents,
        discount: Math.max(0, originalCents - cents),
        productList,
      }),
      _synthetic: true,
    };
  }
}
