/**
 * 前端逻辑
 * 所有来自 MCP 的文本一律用 textContent 写入，不使用 innerHTML，
 * 避免外部数据带来的注入风险。
 */

const $ = (id) => document.getElementById(id);

const els = {
  statusDot: $('statusDot'), statusText: $('statusText'),
  want: $('want'), city: $('city'), keyword: $('keyword'),
  runBtn: $('runBtn'), warnings: $('warnings'), empty: $('empty'), deal: $('deal'),
};

/* ---------- 状态检测 ---------- */
async function checkHealth() {
  try {
    const j = await (await fetch('/api/health')).json();
    if (j.tokenConfigured) {
      els.statusDot.className = 'dot ok';
      els.statusText.textContent = 'MCP 已连接';
    } else {
      els.statusDot.className = 'dot bad';
      els.statusText.textContent = '未配置 MCP Token';
    }
  } catch {
    els.statusDot.className = 'dot bad';
    els.statusText.textContent = '服务未响应';
  }
}

/* ---------- 小工具 ---------- */
function el(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}
const yuan = (n) => `¥${Number(n ?? 0).toFixed(2)}`;
/** 大份/多人餐提示：避免用户误以为是单人份 */
const MULTI_HINT = (p) => (/双人|多人|全家|拼盘|桶|7件|分享/.test(p?.combo?.name ?? '') ? '，注意这是大份/多人餐' : '');

/* ---------- 结果渲染 ---------- */
function renderDeal(r) {
  els.deal.textContent = '';
  els.empty.hidden = true;

  // 门店 / 目标
  const meta = el('div', 'meta');
  const s1 = el('span'); const b1 = el('b', null, r.store?.name ?? '');
  s1.append(document.createTextNode('门店 '), b1);
  const s2 = el('span'); const b2 = el('b', null, r.target?.name ?? '');
  s2.append(document.createTextNode('想吃 '), b2);
  const s3 = el('span'); const b3 = el('b', null, `${r.combosScanned} 个`);
  s3.append(document.createTextNode('已扫描套餐 '), b3);
  meta.append(s1, s2, s3);
  els.deal.append(meta);

  const best = r.best;

  if (!best) {
    const card = el('div', 'verdict-card none');
    card.append(el('h2', null, `「${r.target?.name}」没有包含它的套餐`));
    card.append(el('p', 'verdict-sub', `只能单点，官方价 ${yuan(r.singlePrice)}`));
    els.deal.append(card);
  } else {
    const win = best.verdict === 'combo';
    const card = el('div', 'verdict-card' + (win ? ' win' : ' lose'));

    const tag = el('div', 'verdict-tag', win ? '买套餐更划算' : '单点更划算');
    const title = el('h2', null, win ? best.combo.name : best.target.name);
    const money = el('div', 'verdict-money', yuan(win ? best.combo.price : best.target.price));
    const gain = el('div', 'verdict-gain',
      win
        ? `多花 ${yuan(best.delta)}，多得价值 ${yuan(best.extras.value)} 的东西 → 净赚 ${yuan(best.netGain)}`
        : `比买套餐少花 ${yuan(Math.abs(best.netGain))}`
    );
    card.append(tag, title, money, gain);

    // 对比明细
    const cmp = el('div', 'compare');
    cmp.append(compareRow('单点', best.target.name, best.target.price));
    cmp.append(compareRow('买套餐', best.combo.name, best.combo.price));
    card.append(cmp);

    // 多得清单
    if (best.extras.evaluable.length || best.extras.exclusive.length) {
      const ex = el('div', 'extras');
      ex.append(el('div', 'extras-title', '买套餐会多得到'));
      for (const e of best.extras.evaluable) {
        const row = el('div', 'extra-row');
        row.append(el('span', 'extra-name', `+ ${e.name}`));
        row.append(el('span', 'extra-tag ok', `可单点 ${yuan(e.price)}`));
        ex.append(row);
      }
      for (const e of best.extras.exclusive) {
        const row = el('div', 'extra-row');
        row.append(el('span', 'extra-name', `+ ${e.name}`));
        row.append(el('span', 'extra-tag dim', '套餐专属 · 无法单点'));
        ex.append(row);
      }
      if (best.note) ex.append(el('div', 'extras-note', `ⓘ ${best.note}`));
      card.append(ex);
    }

    // 菜单展示价与官方算价不一致时如实提示（如四件套 菜单¥28 / 官方¥57）
    if (best.priceNote) {
      card.append(el('div', 'extras-note warn', `ⓘ ${best.priceNote}`));
    }

    els.deal.append(card);

    // 加价升级备选：净收益绝对值更高，但要多花更多钱
    const bv = r.bestValue;
    if (bv) {
      const box = el('div', 'upgrade');
      box.append(el('div', 'others-title', '想更省？加价升级'));
      const row = el('div', 'other-row');
      row.append(el('span', null, bv.combo.name));
      row.append(el('span', 'other-net', `多花 ${yuan(bv.delta)} · 净赚 ${yuan(bv.netGain)}`));
      box.append(row);
      box.append(el('div', 'extras-note', `ⓘ 要多花 ${yuan(bv.delta)}，但净收益更高${MULTI_HINT(bv)}`));
      els.deal.append(box);
    }

    // 其他可选套餐
    if (r.paths && r.paths.length > 1) {
      const others = el('div', 'others');
      others.append(el('div', 'others-title', `其他包含「${r.target.name}」的套餐`));
      for (const p of r.paths.slice(1)) {
        const row = el('div', 'other-row');
        row.append(el('span', null, p.combo.name + MULTI_HINT(p)));
        row.append(el('span', 'other-net',
          `多花 ${yuan(p.delta)} · ${p.netGain > 0 ? '净赚 ' : '亏 '}${yuan(Math.abs(p.netGain))}`));
        others.append(row);
        if (p.priceNote) others.append(el('div', 'extras-note warn', `ⓘ ${p.combo.name}：${p.priceNote}`));
      }
      els.deal.append(others);
    }
  }

  // 营养：仅附加展示，不参与决策
  const n = r.nutrition;
  if (n && n.total) {
    const box = el('div', 'nutrition');
    box.append(el('span', 'nut-label', '营养合计（仅供参考）'));
    box.append(el('span', null, `${n.energy} kcal · 蛋白质 ${n.protein}g · 脂肪 ${n.fat}g · 碳水 ${n.carbohydrate}g`));
    if (n.coverage < 1) box.append(el('span', 'nut-cov', `覆盖 ${n.matched}/${n.total} 项`));
    els.deal.append(box);
  }

  // 附属：券 + 活动
  const sup = r.supplements ?? {};
  if ((sup.coupons?.length) || (sup.campaigns?.length)) {
    const wrap = el('div', 'supplements');
    if (sup.coupons?.length) {
      const box = el('div', 'sup-box');
      box.append(el('div', 'sup-title', `可领券 ${sup.coupons.length} 张`));
      const ul = el('ul', 'sup-list');
      for (const c of sup.coupons.slice(0, 8)) ul.append(el('li', null, c.name));
      box.append(ul);
      wrap.append(box);
    }
    if (sup.campaigns?.length) {
      const box = el('div', 'sup-box');
      box.append(el('div', 'sup-title', `今日活动 ${sup.campaigns.length} 个`));
      const ul = el('ul', 'sup-list');
      for (const c of sup.campaigns.slice(0, 8)) ul.append(el('li', null, c.title));
      box.append(ul);
      wrap.append(box);
    }
    els.deal.append(wrap);
  }

  // 下单（二次确认）
  const orderBtn = el('button', 'btn-primary btn-order', best && best.verdict === 'combo'
    ? `就买「${best.combo.name}」`
    : `就单点「${r.target?.name}」`);
  orderBtn.addEventListener('click', () => {
    const items = best && best.verdict === 'combo'
      ? [best.combo.name]
      : [r.target?.name];
    const price = best ? (best.verdict === 'combo' ? best.combo.price : best.target.price) : r.singlePrice;
    const ok = window.confirm(
      `确认下单？\n\n门店：${r.store?.name}\n商品：${items.join('、')}\n金额：${yuan(price)}\n\n（演示环境：确认后调用官方 create-order 生成订单）`
    );
    if (!ok) return;
    window.alert('下单接口已就位，但为避免误产生真实交易，此处默认不发起。可在 src/server.js 的 /api/order 中开启。');
  });
  els.deal.append(orderBtn);
}

function compareRow(label, name, price) {
  const row = el('div', 'compare-row');
  row.append(el('span', 'compare-label', label));
  row.append(el('span', 'compare-name', name));
  row.append(el('span', 'compare-price', yuan(price)));
  return row;
}

/* ---------- 主流程 ---------- */
async function run() {
  els.runBtn.disabled = true;
  els.runBtn.textContent = '正在扫描套餐并核对官方价格…';
  els.deal.textContent = '';
  els.warnings.hidden = true;

  const payload = {
    want: els.want.value.trim(),
    city: els.city.value.trim(),
    keyword: els.keyword.value.trim(),
  };
  if (!payload.want) {
    showWarnings(['请先填写你想吃的东西']);
    els.runBtn.disabled = false;
    els.runBtn.textContent = '算一下怎么买划算';
    return;
  }

  try {
    const res = await fetch('/api/deal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await res.json();
    if (!j.ok) {
      showWarnings([j.error ?? '请求失败'].concat(j.suggestions ? [`相近商品：${j.suggestions.join('、')}`] : []));
      return;
    }
    if (j.warnings?.length) showWarnings(j.warnings);
    renderDeal(j);
  } catch (err) {
    showWarnings([`请求异常：${err.message}`]);
  } finally {
    els.runBtn.disabled = false;
    els.runBtn.textContent = '算一下怎么买划算';
  }
}

function showWarnings(list) {
  els.warnings.hidden = false;
  els.warnings.textContent = '';
  els.warnings.append(el('b', null, '提示'));
  const ul = document.createElement('ul');
  for (const w of list) ul.append(el('li', null, w));
  els.warnings.append(ul);
}

els.runBtn.addEventListener('click', run);
checkHealth();
