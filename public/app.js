/**
 * 前端逻辑
 *
 * 交互结构
 * --------
 *   唯一主入口「我想吃…」：可直接输入，也可点下面的大分类挑
 *   右上角两个小图标：优惠券 / 活动（抽屉展开，带数量徽章）
 *   结果区做薄：一句话结论 → 方案对比卡（可切换）→ 选中方案细节 → 结算（含领券）→ 折叠信息
 *
 * 图片：直接用麦当劳官方 CDN 直链（已实测无防盗链、128/128 商品都有），
 *       统一 lazy loading + onerror 隐藏，避免破图占位。
 *
 * 安全：所有来自 MCP 的文本一律用 textContent 写入，不使用 innerHTML；
 *       图片 URL 只写入 img.src，且限定 http(s) 协议。
 */

const $ = (id) => document.getElementById(id);

const els = {
  statusDot: $('statusDot'), statusText: $('statusText'),
  city: $('city'), keyword: $('keyword'), locStore: $('locStore'),
  want: $('want'), runBtn: $('runBtn'), heroCatsList: $('heroCatsList'),
  catResult: $('catResult'),
  warnings: $('warnings'), empty: $('empty'), deal: $('deal'),
  btnCoupons: $('btnCoupons'), btnCampaigns: $('btnCampaigns'), btnCart: $('btnCart'),
  couponBadge: $('couponBadge'), campaignBadge: $('campaignBadge'), cartBadge: $('cartBadge'),
  sheet: $('sheet'), sheetTitle: $('sheetTitle'), sheetBody: $('sheetBody'),
  sheetClose: $('sheetClose'), sheetMask: $('sheetMask'),
};

const state = {
  dealResult: null,
  selected: 'single',
  campaignsData: null,   // explore?mode=campaigns 的结果，缓存避免重复调用
  bindCoupons: false,    // 结算时是否领券
  cart: [],              // [{ code, name, image, quantity }]
  cartResult: null,      // /api/cart 的结果
  cartPicked: 'baseline',// 购物车结算选中的方案：'baseline' | 'combo:<code>'
  sheetKind: null,       // 当前打开的抽屉：cart | coupons | campaigns
};

/* ---------- 购物车 ---------- */
function cartCount() { return state.cart.reduce((s, x) => s + x.quantity, 0); }

function addToCart(item) {
  const code = String(item.code ?? '');
  if (!code) return;
  const hit = state.cart.find((x) => x.code === code);
  if (hit) hit.quantity += 1;
  else state.cart.push({ code, name: item.name ?? '', image: item.image ?? '', quantity: 1 });
  state.cartResult = null;      // 购物车变了，之前的对比结果已失效
  syncCartBadge();
  flashCart();
  // 抽屉正开着就顺手刷新，让用户看到刚加进去的东西
  if (state.sheetKind === 'cart' && !els.sheet.hidden) renderCartSheet();
}

function changeQty(code, delta) {
  const i = state.cart.findIndex((x) => x.code === code);
  if (i < 0) return;
  state.cart[i].quantity += delta;
  if (state.cart[i].quantity <= 0) state.cart.splice(i, 1);
  state.cartResult = null;      // 同上
  syncCartBadge();
  renderCartSheet();
}

function clearCart() {
  state.cart = [];
  state.cartResult = null;
  state.cartPicked = 'baseline';
  syncCartBadge();
  renderCartSheet();
}

function syncCartBadge() {
  const n = cartCount();
  els.cartBadge.hidden = !n;
  if (n) els.cartBadge.textContent = String(n);
}

function flashCart() {
  els.btnCart.classList.add('bump');
  setTimeout(() => els.btnCart.classList.remove('bump'), 260);
}

/* ---------- 小工具 ---------- */
function el(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}
const yuan = (n) => `¥${Number(n ?? 0).toFixed(2)}`;
const MULTI_HINT = (name) => (/双人|多人|全家|拼盘|桶|7件|分享/.test(name ?? '') ? ' · 大份/多人' : '');

/** 只接受 http(s) 图片地址，防止外部数据塞入 javascript: 之类的协议 */
function safeImg(url, cls) {
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = '';
  if (cls) img.className = cls;
  let href = null;
  try {
    const u = new URL(String(url ?? ''), window.location.href);
    if (u.protocol === 'https:' || u.protocol === 'http:') href = u.href;
  } catch { href = null; }
  if (!href) { img.style.display = 'none'; return img; }
  img.src = href;
  img.addEventListener('error', () => { img.style.display = 'none'; });
  return img;
}

async function post(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

function showWarnings(list) {
  els.warnings.hidden = false;
  els.warnings.textContent = '';
  els.warnings.append(el('b', null, '提示'));
  const ul = document.createElement('ul');
  for (const w of list) ul.append(el('li', null, w));
  els.warnings.append(ul);
}
function clearWarnings() { els.warnings.hidden = true; els.warnings.textContent = ''; }
function setStore(name) { els.locStore.textContent = name ? `当前门店：${name}` : ''; }

const loc = () => ({ city: els.city.value.trim(), keyword: els.keyword.value.trim() });

/* ---------- MCP 状态 ---------- */
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

/* ---------- 主入口下方的大分类 ---------- */
async function loadHeroCats() {
  try {
    const r = await post('/api/explore', { mode: 'groups', ...loc() });
    if (!r.ok) { els.heroCatsList.textContent = '分类加载失败'; return; }
    setStore(r.store?.name);
    els.heroCatsList.textContent = '';
    for (const g of r.groups) {
      const chip = el('button', 'hero-chip');
      chip.append(el('span', null, g.name));
      chip.append(el('span', 'hero-chip-count', String(g.count)));
      chip.addEventListener('click', () => loadCategory(g.key, g.name));
      els.heroCatsList.append(chip);
    }
  } catch (err) {
    els.heroCatsList.textContent = `分类加载失败：${err.message}`;
  }
}

async function loadCategory(key, name) {
  els.catResult.hidden = false;
  els.catResult.textContent = '';
  const box = el('div', 'panel-inner');
  box.append(el('div', 'item-title', `正在加载「${name}」…`));
  els.catResult.append(box);

  const r = await post('/api/explore', { mode: 'category', category: key, ...loc() });
  box.textContent = '';
  if (!r.ok) { box.append(el('div', 'loading', r.error ?? '加载失败')); return; }

  box.append(el('div', 'item-title', `${r.groupName} · ${r.items.length} 款　点任意一个看怎么买划算`));
  const list = el('div', 'item-grid-list');
  for (const it of r.items) {
    // 用 div 而非 button：卡片内部还要放一个「+」按钮，button 不能嵌套
    const card = el('div', 'item-card' + (it.isCombo ? ' combo' : ''));
    card.append(safeImg(it.image, 'item-img'));
    // 有优惠的单品单独标注
    if (it.save > 0) card.append(el('span', 'item-save-flag', `省 ${yuan(it.save)}`));
    card.append(el('span', 'item-name', it.name));
    card.append(el('span', 'item-price', yuan(it.price)));
    if (it.save > 0) card.append(el('span', 'item-was', `原价 ${yuan(it.originalPrice)}`));

    const add = el('button', 'item-add', '+');
    add.title = '加入购物车';
    add.addEventListener('click', (e) => { e.stopPropagation(); addToCart(it); });
    card.append(add);

    card.addEventListener('click', () => {
      els.want.value = it.name;
      runDeal(it.name);
    });
    list.append(card);
  }
  box.append(list);
  els.catResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------- 购物车抽屉 ---------- */
function renderCartSheet() {
  const body = els.sheetBody;
  body.textContent = '';

  if (!state.cart.length) {
    body.append(el('div', 'loading', '购物车还是空的。去下面挑一类，点卡片右上角的「+」加进来。'));
    return;
  }

  const list = el('div', 'cart-list');
  for (const it of state.cart) {
    const row = el('div', 'cart-row');
    row.append(safeImg(it.image, 'cart-img'));
    row.append(el('span', 'cart-name', it.name));

    const stepper = el('div', 'cart-step');
    const minus = el('button', 'step-btn', '−');
    minus.addEventListener('click', () => changeQty(it.code, -1));
    const plus = el('button', 'step-btn', '+');
    plus.addEventListener('click', () => changeQty(it.code, 1));
    stepper.append(minus, el('span', 'cart-qty', String(it.quantity)), plus);
    row.append(stepper);
    list.append(row);
  }
  body.append(list);

  const bar = el('div', 'cart-bar');
  bar.append(el('span', null, `共 ${cartCount()} 件`));
  const clear = el('button', 'link-btn', '清空');
  clear.addEventListener('click', clearCart);
  bar.append(clear);
  body.append(bar);

  const cmpBtn = el('button', 'btn-primary', '看看怎么买更省');
  cmpBtn.addEventListener('click', runCartCompare);
  body.append(cmpBtn);

  const result = el('div', 'cart-result');
  result.id = 'cartResult';
  body.append(result);
  if (state.cartResult) renderCartOptions(state.cartResult);
}

async function runCartCompare() {
  const box = $('cartResult');
  if (box) { box.textContent = ''; box.append(el('div', 'loading', '正在用官方价格比对所有可能的套餐组合…')); }
  try {
    const r = await post('/api/cart', {
      items: state.cart.map((x) => ({ code: x.code, quantity: x.quantity })),
      ...loc(),
    });
    if (!r.ok) {
      if (box) { box.textContent = ''; box.append(el('div', 'loading', r.error ?? '对比失败')); }
      return;
    }
    state.cartResult = r;
    state.cartPicked = r.best ? `combo:${r.best.combo.code}` : 'baseline';
    if (box) renderCartOptions(r);
  } catch (err) {
    if (box) { box.textContent = ''; box.append(el('div', 'loading', `请求异常：${err.message}`)); }
  }
}

/** 相似方案对比：全单点（基线）vs 各「套餐 + 补单」方案 */
function renderCartOptions(r) {
  const box = $('cartResult');
  if (!box) return;
  box.textContent = '';

  box.append(el('div', 'cart-cmp-title', '相似方案对比'));

  const row = el('div', 'cart-opt-row');

  // 基线：原样全买单品
  const baseCard = el('button', 'cart-opt' + (state.cartPicked === 'baseline' ? ' selected' : ''));
  baseCard.append(el('span', 'cart-opt-badge', '原样'));
  baseCard.append(el('span', 'cart-opt-name', '全部单点'));
  baseCard.append(el('span', 'cart-opt-price', yuan(r.baseline.price)));
  baseCard.append(el('span', 'cart-opt-hint', `${r.baseline.count} 件`));
  baseCard.addEventListener('click', () => { state.cartPicked = 'baseline'; renderCartOptions(r); });
  row.append(baseCard);

  for (const o of r.options ?? []) {
    const key = `combo:${o.combo.code}`;
    const cheaper = o.diff < 0;
    const card = el('button', 'cart-opt' + (state.cartPicked === key ? ' selected' : '') + (cheaper ? ' cheaper' : ''));
    if (cheaper) card.append(el('span', 'cart-opt-flag', '更省'));
    card.append(safeImg(o.combo.image, 'cart-opt-img'));
    card.append(el('span', 'cart-opt-badge', '套餐'));
    card.append(el('span', 'cart-opt-name', o.combo.name));
    card.append(el('span', 'cart-opt-price', yuan(o.total)));
    card.append(el('span', 'cart-opt-hint',
      cheaper ? `省 ${yuan(-o.diff)}` : `贵 ${yuan(o.diff)}`));
    card.addEventListener('click', () => { state.cartPicked = key; renderCartOptions(r); });
    row.append(card);
  }
  box.append(row);

  // 选中方案细节
  const detail = el('div', 'cart-detail');
  if (state.cartPicked === 'baseline') {
    detail.append(el('div', 'detail-line', `按原样单点，共 ${r.baseline.count} 件，官方价 ${yuan(r.baseline.price)}`));
  } else {
    const code = state.cartPicked.slice(6);
    const o = (r.options ?? []).find((x) => x.combo.code === code);
    if (o) {
      detail.append(el('div', 'detail-line', `${o.combo.name} ＋ 未被覆盖的商品继续单点`));
      if (o.covered.length) {
        const ul = el('div', 'cart-sub');
        ul.append(el('span', 'cart-sub-t', '套餐已包含'));
        ul.append(el('span', null, o.covered.map((x) => `${x.name}×${x.quantity}`).join('、')));
        detail.append(ul);
      }
      if (o.uncovered.length) {
        const ul = el('div', 'cart-sub');
        ul.append(el('span', 'cart-sub-t', '仍需单点'));
        ul.append(el('span', null, o.uncovered.map((x) => `${x.name}×${x.quantity}`).join('、')));
        detail.append(ul);
      }
      if (o.surplus.length) {
        const ul = el('div', 'cart-sub');
        ul.append(el('span', 'cart-sub-t', '套餐多送'));
        ul.append(el('span', null, o.surplus.map((x) => x.name + (x.orderable ? '' : '（套餐专属）')).join('、')));
        detail.append(ul);
      }
    }
  }
  box.append(detail);

  // 结算
  const picked = state.cartPicked === 'baseline'
    ? { name: '全部单点', price: r.baseline.price }
    : (() => {
      const code = state.cartPicked.slice(6);
      const o = (r.options ?? []).find((x) => x.combo.code === code);
      return o ? { name: o.combo.name, price: o.total } : { name: '全部单点', price: r.baseline.price };
    })();

  const pay = el('div', 'checkout-amount');
  pay.append(el('span', 'co-label', picked.name));
  pay.append(el('span', 'co-price', yuan(picked.price)));
  box.append(pay);

  const btn = el('button', 'btn-primary btn-order', '下单');
  btn.addEventListener('click', () => {
    const ok = window.confirm(
      `确认下单？\n\n门店：${r.store?.name ?? ''}\n方案：${picked.name}\n金额：${yuan(picked.price)}\n\n（演示环境：默认不发起真实下单）`
    );
    if (!ok) return;
    window.alert('下单接口已就位，但为避免误产生真实交易，此处默认不发起。');
  });
  box.append(btn);
}

/* ---------- 右上角抽屉：券 / 活动 ---------- */
async function openSheet(kind) {
  els.sheet.hidden = false;
  state.sheetKind = kind;
  els.sheetTitle.textContent =
    kind === 'coupons' ? '可领的优惠券' : kind === 'cart' ? '购物车' : '近期活动';
  els.sheetBody.textContent = '';

  if (kind === 'cart') { renderCartSheet(); return; }

  els.sheetBody.append(el('div', 'loading', '加载中…'));

  let data = state.campaignsData;
  if (!data) {
    data = await post('/api/explore', { mode: 'campaigns', ...loc() });
    if (data.ok) { state.campaignsData = data; updateBadges(); }
  }
  els.sheetBody.textContent = '';
  if (!data.ok) { els.sheetBody.append(el('div', 'loading', data.error ?? '加载失败')); return; }

  if (kind === 'coupons') renderCoupons(data.coupons ?? []);
  else renderCampaigns(data.days ?? []);
}

function renderCoupons(coupons) {
  if (!coupons.length) { els.sheetBody.append(el('div', 'loading', '当前没有查询到可用券')); return; }
  const grid = el('div', 'coupon-grid');
  for (const c of coupons) {
    const card = el('div', 'coupon-card');
    card.append(safeImg(c.image, 'coupon-img'));
    card.append(el('div', 'coupon-name', c.name || '优惠券'));
    if (c.label) card.append(el('div', 'coupon-label', c.label));
    grid.append(card);
  }
  els.sheetBody.append(grid);
  els.sheetBody.append(el('p', 'ask-hint', '券的实际抵扣以官方算价为准，下单时会自动带入。'));
}

function renderCampaigns(days) {
  if (!days.length) { els.sheetBody.append(el('div', 'loading', '当前没有查询到活动')); return; }
  for (const d of days) {
    const day = el('div', 'day-box');
    day.append(el('div', 'day-date', d.dateText || d.date));
    for (const e of d.events) {
      // 默认只展示标题，点击展开完整信息
      const card = document.createElement('details');
      card.className = 'event-fold';
      const sum = el('summary', 'event-summary');
      sum.append(el('span', 'event-title', e.title || e.highlight));
      card.append(sum);

      const body = el('div', 'event-body');
      body.append(safeImg(e.image, 'event-img'));
      if (e.highlight && e.title) body.append(el('div', 'event-hl', e.highlight));
      if (e.content) body.append(el('div', 'event-text', e.content.replace(/\n/g, ' ')));
      card.append(body);
      day.append(card);
    }
    els.sheetBody.append(day);
  }
  els.sheetBody.append(el('p', 'ask-hint', '点标题展开完整内容。'));
}

function updateBadges() {
  const d = state.campaignsData;
  if (!d?.ok) return;
  const nc = (d.coupons ?? []).length;
  const nd = (d.days ?? []).reduce((s, x) => s + x.events.length, 0);
  els.couponBadge.hidden = !nc;
  els.campaignBadge.hidden = !nd;
  if (nc) els.couponBadge.textContent = String(nc);
  if (nd) els.campaignBadge.textContent = String(nd);
}

function closeSheet() { els.sheet.hidden = true; }

/* ---------- 主线：算怎么买划算 ---------- */
async function runDeal(want) {
  const kw = String(want ?? els.want.value).trim();
  if (!kw) { showWarnings(['请先填写你想吃的东西']); return; }
  els.want.value = kw;
  clearWarnings();
  els.empty.hidden = true;
  els.deal.textContent = '';
  els.deal.append(el('div', 'loading', `正在扫描套餐并核对官方价格：${kw}…`));

  try {
    const r = await post('/api/deal', { want: kw, ...loc() });
    els.deal.textContent = '';
    if (!r.ok) {
      showWarnings([r.error ?? '请求失败'].concat(
        r.suggestions?.length ? [`相近商品：${r.suggestions.join('、')}`] : []
      ));
      return;
    }
    if (r.warnings?.length) showWarnings(r.warnings);
    setStore(r.store?.name);
    // 顺带把券数量刷进右上角徽章，不额外消耗 MCP 调用
    const n = r.supplements?.coupons?.length ?? 0;
    els.couponBadge.hidden = !n;
    if (n) els.couponBadge.textContent = String(n);
    renderDeal(r);
  } catch (err) {
    els.deal.textContent = '';
    showWarnings([`请求异常：${err.message}`]);
  }
}

/* ---------- 结果渲染 ---------- */
function renderDeal(r) {
  state.dealResult = r;
  const best = r.best;

  const options = [{
    key: 'single', kind: 'single',
    name: r.target.name, price: r.singlePrice, image: r.target.image,
    badge: '单点', hint: '只买它自己', netGain: 0,
  }];
  for (const p of r.paths ?? []) {
    options.push({
      key: `combo:${p.combo.code}`, kind: 'combo', path: p,
      name: p.combo.name, price: p.combo.price, image: p.combo.image,
      badge: '套餐',
      hint: p.netGain > 0 ? `净赚 ${yuan(p.netGain)}` : `不划算 ${yuan(p.netGain)}`,
      netGain: p.netGain,
      recommended: Boolean(best && p.combo.code === best.combo.code && best.verdict === 'combo'),
    });
  }
  state.selected = options.find((o) => o.recommended)?.key ?? 'single';

  // ① 一句话结论
  const head = el('div', 'verdict-head');
  if (best && best.verdict === 'combo') {
    head.className += ' win';
    head.append(safeImg(best.combo.image, 'verdict-img'));
    head.append(el('span', 'verdict-badge', '买套餐更划算'));
    head.append(el('span', 'verdict-main', `${best.combo.name} ${yuan(best.combo.price)}`));
    head.append(el('span', 'verdict-sub', `比单点多花 ${yuan(best.delta)}，净赚 ${yuan(best.netGain)}`));
  } else if (best) {
    head.className += ' lose';
    head.append(safeImg(r.target.image, 'verdict-img'));
    head.append(el('span', 'verdict-badge', '单点更划算'));
    head.append(el('span', 'verdict-main', `${r.target.name} ${yuan(r.singlePrice)}`));
    head.append(el('span', 'verdict-sub', '包含的套餐算下来都不划算，直接单点'));
  } else {
    head.append(safeImg(r.target.image, 'verdict-img'));
    head.append(el('span', 'verdict-badge', '只能单点'));
    head.append(el('span', 'verdict-main', `${r.target.name} ${yuan(r.singlePrice)}`));
    head.append(el('span', 'verdict-sub', `已扫描 ${r.combosScanned} 个套餐，没有包含它的`));
  }
  els.deal.append(head);

  // ② 方案对比卡
  const cmp = el('div', 'opt-compare');
  cmp.append(el('div', 'opt-title', '方案对比（点一个看细节）'));
  const row = el('div', 'opt-row');
  for (const o of options) {
    const card = el('button', 'opt-card' + (o.recommended ? ' recommended' : ''));
    card.dataset.key = o.key;
    if (o.recommended) card.append(el('span', 'opt-flag', '推荐'));
    card.append(safeImg(o.image, 'opt-img'));
    card.append(el('span', 'opt-badge', o.badge));
    card.append(el('span', 'opt-name', o.name + (o.kind === 'combo' ? MULTI_HINT(o.name) : '')));
    card.append(el('span', 'opt-price', yuan(o.price)));
    card.append(el('span', 'opt-hint', o.hint));
    card.addEventListener('click', () => selectOption(o.key));
    row.append(card);
  }
  cmp.append(row);
  els.deal.append(cmp);

  // ③ 选中方案细节
  const detail = el('div', 'opt-detail');
  detail.id = 'optDetail';
  els.deal.append(detail);
  selectOption(state.selected);

  // ④ 次要信息
  els.deal.append(buildExtras(r));

  // ⑤ 结算区（含领券选项）
  els.deal.append(buildCheckout(r, options));
}

function selectOption(key) {
  state.selected = key;
  for (const c of els.deal.querySelectorAll('.opt-card')) {
    c.classList.toggle('selected', c.dataset.key === key);
  }
  const box = $('optDetail');
  if (!box) return;
  box.textContent = '';

  const r = state.dealResult;
  if (key === 'single') {
    box.append(el('div', 'detail-title', `单点「${r.target.name}」`));
    box.append(el('div', 'detail-line', `官方价 ${yuan(r.singlePrice)}`));
    box.append(el('div', 'detail-note', '只有它自己，没有多得的东西。想知道加点钱能多得到什么，点上面的套餐卡。'));
    const addBtn = el('button', 'btn-ghost', `把「${r.target.name}」加入购物车`);
    addBtn.addEventListener('click', () => addToCart({
      code: r.target.code, name: r.target.name, image: r.target.image,
    }));
    box.append(addBtn);
    updateCheckoutAmount(r.singlePrice);
    return;
  }

  const p = (r.paths ?? []).find((x) => `combo:${x.combo.code}` === key);
  if (!p) return;

  const title = el('div', 'detail-title');
  title.append(safeImg(p.combo.image, 'detail-img'));
  title.append(el('span', null, p.combo.name));
  box.append(title);

  const cmp = el('div', 'detail-cmp');
  const rSingle = el('div', 'compare-row');
  rSingle.append(el('span', 'compare-label', '单点'));
  const mid1 = el('span', 'compare-name');
  mid1.append(safeImg(p.target.image, 'compare-img'));
  mid1.append(document.createTextNode(p.target.name));
  rSingle.append(mid1);
  rSingle.append(el('span', 'compare-price', yuan(p.target.price)));
  const rCombo = el('div', 'compare-row');
  rCombo.append(el('span', 'compare-label', '套餐'));
  const mid2 = el('span', 'compare-name');
  mid2.append(safeImg(p.combo.image, 'compare-img'));
  mid2.append(document.createTextNode(p.combo.name));
  rCombo.append(mid2);
  rCombo.append(el('span', 'compare-price', yuan(p.combo.price)));
  cmp.append(rSingle, rCombo);
  box.append(cmp);

  box.append(el('div', 'detail-line',
    `多花 ${yuan(p.delta)}，多得价值 ${yuan(p.extras.value)} 的东西 → ${p.netGain > 0 ? '净赚' : '净亏'} ${yuan(Math.abs(p.netGain))}`));

  if (p.extras.evaluable.length || p.extras.exclusive.length) {
    const ex = el('div', 'detail-extras');
    for (const e of p.extras.evaluable) {
      const row2 = el('div', 'extra-row');
      const left = el('span', 'extra-name');
      left.append(safeImg(e.image, 'extra-img'));
      left.append(document.createTextNode(`+ ${e.name}`));
      row2.append(left);
      row2.append(el('span', 'extra-tag ok', `可单点 ${yuan(e.price)}`));
      ex.append(row2);
    }
    for (const e of p.extras.exclusive) {
      const row2 = el('div', 'extra-row');
      row2.append(el('span', 'extra-name', `+ ${e.name}`));
      row2.append(el('span', 'extra-tag dim', '套餐专属 · 无法单点'));
      ex.append(row2);
    }
    box.append(ex);
  }

  if (p.note) box.append(el('div', 'extras-note', `ⓘ ${p.note}`));
  if (p.priceNote) box.append(el('div', 'extras-note warn', `ⓘ ${p.priceNote}`));

  const addBtn = el('button', 'btn-ghost', `把「${p.combo.name}」加入购物车`);
  addBtn.addEventListener('click', () => addToCart({
    code: p.combo.code, name: p.combo.name, image: p.combo.image,
  }));
  box.append(addBtn);

  updateCheckoutAmount(p.combo.price);
}

/** 营养 / 券 / 活动：折起来，不占主视线 */
function buildExtras(r) {
  const wrap = el('div', 'extras-fold');
  const det = document.createElement('details');
  det.append(el('summary', null, '更多信息（营养 · 券 · 活动）'));

  const n = r.nutrition;
  if (n && n.total) {
    const row = el('div', 'fold-row');
    row.append(el('span', 'fold-label', '营养合计（仅供参考）'));
    row.append(el('span', null, `${n.energy} kcal · 蛋白质 ${n.protein}g · 脂肪 ${n.fat}g · 碳水 ${n.carbohydrate}g`));
    if (n.coverage < 1) row.append(el('span', 'fold-dim', `覆盖 ${n.matched}/${n.total} 项`));
    det.append(row);
  }
  const sup = r.supplements ?? {};
  if (sup.coupons?.length) {
    const row = el('div', 'fold-row');
    row.append(el('span', 'fold-label', `可领券 ${sup.coupons.length} 张`));
    row.append(el('span', null, sup.coupons.slice(0, 6).map((c) => c.name).join('、')));
    det.append(row);
  }
  if (sup.campaigns?.length) {
    const row = el('div', 'fold-row');
    row.append(el('span', 'fold-label', `今日活动 ${sup.campaigns.length} 个`));
    row.append(el('span', null, sup.campaigns.slice(0, 6).map((c) => c.title).join('、')));
    det.append(row);
  }
  wrap.append(det);
  return wrap;
}

/** 结算区：金额随选中方案联动 + 领券勾选 + 下单 */
function buildCheckout(r, options) {
  const box = el('div', 'checkout');
  box.append(el('div', 'checkout-title', '结算'));

  const amount = el('div', 'checkout-amount');
  amount.id = 'checkoutAmount';
  box.append(amount);

  const nCoupon = r.supplements?.coupons?.length ?? 0;
  if (nCoupon > 0) {
    const opt = el('label', 'checkout-coupon');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.bindCoupons;
    cb.addEventListener('change', () => {
      state.bindCoupons = cb.checked;
      const cur = (r.paths ?? []).find((p) => `combo:${p.combo.code}` === state.selected);
      updateCheckoutAmount(cur ? cur.combo.price : r.singlePrice);
    });
    opt.append(cb);
    opt.append(document.createTextNode(`同时领取 ${nCoupon} 张可用优惠券`));
    box.append(opt);
  }

  const btn = el('button', 'btn-primary btn-order', '下单');
  btn.addEventListener('click', () => {
    const o = options.find((x) => x.key === state.selected);
    const lines = [
      `门店：${r.store?.name ?? ''}`,
      `方案：${o?.name ?? ''}`,
      `金额：${yuan(o?.price ?? 0)}`,
      state.bindCoupons ? `已勾选：领取 ${nCoupon} 张优惠券` : '未勾选领券',
    ].join('\n');
    if (!window.confirm(`确认下单？\n\n${lines}\n\n（演示环境：默认不发起真实下单）`)) return;
    window.alert('下单接口已就位，但为避免误产生真实交易，此处默认不发起。可在 src/server.js 的 /api/order 中开启。');
  });
  box.append(btn);
  return box;
}

function updateCheckoutAmount(price) {
  const box = $('checkoutAmount');
  if (!box) return;
  const r = state.dealResult;
  if (!r) return;
  const cur = (r.paths ?? []).find((p) => `combo:${p.combo.code}` === state.selected);
  const name = cur ? cur.combo.name : r.target.name;
  box.textContent = '';
  box.append(el('span', 'co-label', name));
  box.append(el('span', 'co-price', yuan(price)));
  if (state.bindCoupons) box.append(el('span', 'co-note', '· 券后金额以官方算价为准'));
}

/* ---------- 绑定 ---------- */
els.runBtn.addEventListener('click', () => runDeal(els.want.value));
els.want.addEventListener('keydown', (e) => { if (e.key === 'Enter') runDeal(els.want.value); });
els.btnCoupons.addEventListener('click', () => openSheet('coupons'));
els.btnCampaigns.addEventListener('click', () => openSheet('campaigns'));
els.btnCart.addEventListener('click', () => openSheet('cart'));
els.sheetClose.addEventListener('click', closeSheet);
els.sheetMask.addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
for (const inp of [els.city, els.keyword]) {
  inp.addEventListener('change', () => {
    setStore('');
    state.campaignsData = null;
    els.catResult.hidden = true;
    loadHeroCats();
  });
}

checkHealth();
loadHeroCats();
