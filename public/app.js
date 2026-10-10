/**
 * 前端逻辑
 * 所有来自 MCP 的文本一律用 textContent 写入，不使用 innerHTML，
 * 避免外部数据带来的注入风险。
 */

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'), statusDot: $('statusDot'), statusText: $('statusText'),
  city: $('city'), keyword: $('keyword'), people: $('people'), budget: $('budget'),
  maxKcal: $('maxKcal'), minProtein: $('minProtein'),
  avoid: $('avoid'), prefer: $('prefer'),
  runBtn: $('runBtn'), warnings: $('warnings'), meta: $('meta'),
  empty: $('empty'), schemes: $('schemes'),
};

/* ---------- 启动检测 ---------- */
async function checkHealth() {
  try {
    const r = await fetch('/api/health');
    const j = await r.json();
    if (j.tokenConfigured) {
      els.statusDot.className = 'dot ok';
      els.statusText.textContent = 'MCP Token 已配置';
    } else {
      els.statusDot.className = 'dot bad';
      els.statusText.textContent = '未配置 MCP Token';
    }
  } catch {
    els.statusDot.className = 'dot bad';
    els.statusText.textContent = '服务未响应';
  }
}

/* ---------- 图表：预算消耗条 ---------- */
function budgetBar(price, budget) {
  const W = 236, H = 54;
  const ratio = budget > 0 ? Math.min(1, price / budget) : 0;
  const barW = W - 8;
  const fillW = Math.max(2, barW * ratio);
  const over = budget > 0 && price > budget;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', H);

  const track = rect(4, 14, barW, 12, '#e6e8ec', 6);
  const fill = rect(4, 14, fillW, 12, over ? '#d62d20' : '#1f9d55', 6);
  const label = text(4, 8, `¥${price.toFixed(2)} / 预算 ¥${budget}`, 11, '#1c1e21', '600');
  const pct = text(W - 4, 40, `${(ratio * 100).toFixed(0)}%`, 11, '#6b7280', '600');
  pct.setAttribute('text-anchor', 'end');
  const hint = text(4, 40, over ? '超出预算' : '预算内', 11, over ? '#d62d20' : '#1f9d55', '500');

  svg.append(label, track, fill, hint, pct);
  return svg;
}

/* ---------- 图表：营养环形 ---------- */
function calorieRing(kcalPerPerson, maxKcal, proteinPerPerson) {
  const S = 130, cx = S / 2, cy = S / 2, r = 46, sw = 12;
  const c = 2 * Math.PI * r;
  const ratio = maxKcal > 0 ? Math.min(1, kcalPerPerson / maxKcal) : 0;
  const color = maxKcal === 0 ? '#6b7280' : ratio > 1 ? '#d62d20' : ratio > 0.85 ? '#f5b400' : '#1f9d55';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${S} ${S}`);
  svg.setAttribute('width', S);
  svg.setAttribute('height', S);
  svg.style.display = 'block';
  svg.style.margin = '0 auto';

  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  bg.setAttribute('cx', cx); bg.setAttribute('cy', cy); bg.setAttribute('r', r);
  bg.setAttribute('fill', 'none'); bg.setAttribute('stroke', '#e6e8ec'); bg.setAttribute('stroke-width', sw);

  const fg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  fg.setAttribute('cx', cx); fg.setAttribute('cy', cy); fg.setAttribute('r', r);
  fg.setAttribute('fill', 'none'); fg.setAttribute('stroke', color);
  fg.setAttribute('stroke-width', sw); fg.setAttribute('stroke-linecap', 'round');
  fg.setAttribute('stroke-dasharray', `${c * ratio} ${c}`);
  fg.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);

  const v1 = text(cx, cy - 2, String(Math.round(kcalPerPerson)), 22, '#1c1e21', '800');
  v1.setAttribute('text-anchor', 'middle');
  const v2 = text(cx, cy + 16, maxKcal > 0 ? `千卡 / 上限 ${maxKcal}` : '千卡', 10.5, '#6b7280', '500');
  v2.setAttribute('text-anchor', 'middle');
  const v3 = text(cx, cy + 32, `蛋白质 ${proteinPerPerson.toFixed(1)}g`, 10.5, '#6b7280', '500');
  v3.setAttribute('text-anchor', 'middle');

  svg.append(bg, fg, v1, v2, v3);
  return svg;
}

function rect(x, y, w, h, fill, rx) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  el.setAttribute('x', x); el.setAttribute('y', y);
  el.setAttribute('width', Math.max(0, w)); el.setAttribute('height', h);
  el.setAttribute('fill', fill); el.setAttribute('rx', rx ?? 0);
  return el;
}
function text(x, y, str, size, fill, weight) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  el.setAttribute('x', x); el.setAttribute('y', y);
  el.setAttribute('font-size', size); el.setAttribute('fill', fill);
  el.setAttribute('font-weight', weight ?? '400');
  el.setAttribute('font-family', '-apple-system, "PingFang SC", sans-serif');
  el.textContent = str;
  return el;
}

/* ---------- 卡片渲染 ---------- */
function renderScheme(s, idx, ctx) {
  const { people, budget, maxKcal } = ctx;
  const card = div('scheme' + (idx === 0 ? ' best' : ''));

  // 头部
  const head = div('scheme-head');
  const left = div('scheme-rank');
  const badge = div('rank-badge');
  badge.textContent = String(idx + 1);
  const titles = div();
  const h = document.createElement('p');
  h.className = 'scheme-title';
  h.textContent = s.items.map((i) => i.name).join(' + ');
  const sub = document.createElement('p');
  sub.className = 'scheme-sub';
  sub.textContent = `${people} 人 · ${s.items.length} 个品类 · 综合得分 ${s.score.toFixed(3)}`;
  titles.append(h, sub);
  left.append(badge, titles);

  // 官方算价通过则以其为准，否则退回本地估算并明确标注
  const shown = s.priceVerified ? s.officialPrice : s.estimate.price;
  const priceBox = div('price-box');
  const pm = div('price-main');
  pm.textContent = `¥${shown.toFixed(2)}`;
  const pp = div('price-per');
  pp.textContent = `人均 ¥${(shown / ctx.people).toFixed(2)}`;
  if (s.priceVerified && s.officialDiscount > 0) {
    const off = div('price-per');
    off.textContent = `已省 ¥${s.officialDiscount.toFixed(2)}`;
    pp.append(off);
  }
  const tag = document.createElement('span');
  tag.className = 'price-tag' + (s.priceVerified ? '' : ' unverified');
  tag.textContent = s.priceVerified ? '官方算价' : '估算价（算价未校验）';
  priceBox.append(pm, pp, tag);
  if (s.priceNote) {
    const note = document.createElement('span');
    note.className = 'price-tag unverified';
    note.textContent = s.priceNote;
    priceBox.append(note);
  }

  head.append(left, priceBox);

  // 主体
  const body = div('scheme-body');

  const leftCol = div();
  const ul = document.createElement('ul');
  ul.className = 'items';
  for (const it of s.items) {
    const li = document.createElement('li');
    const nameWrap = div();
    const nm = document.createElement('span');
    nm.className = 'item-name';
    nm.textContent = it.name;
    nameWrap.append(nm);
    if (it.bucket && it.bucket !== 'other') {
      const t = document.createElement('span');
      t.className = 'item-tag';
      t.textContent = bucketLabel(it.bucket);
      nameWrap.append(t);
    }
    const right = div('item-right');
    const b = document.createElement('b');
    b.textContent = `¥${(it.price ?? 0).toFixed(2)}`;
    right.append(b, document.createTextNode(` × ${it.qty}`));
    if (it.nutrition?.energy) {
      right.append(document.createTextNode(` · ${Math.round(it.nutrition.energy)} 千卡`));
    }
    li.append(nameWrap, right);
    ul.append(li);
  }
  leftCol.append(ul);

  const rl = document.createElement('ul');
  rl.className = 'reasons';
  for (const r of s.reasons ?? []) {
    const li = document.createElement('li');
    li.textContent = r;
    rl.append(li);
  }
  leftCol.append(rl);

  // 图表列
  const charts = div('charts');
  const c1 = div('chart-card');
  const t1 = div('chart-title');
  t1.textContent = '预算消耗';
  c1.append(t1, budgetBar(shown, budget === Infinity ? shown : budget));

  const c2 = div('chart-card');
  const t2 = div('chart-title');
  t2.textContent = '人均营养';
  c2.append(t2, calorieRing(s.estimate.kcalPerPerson, maxKcal, s.estimate.proteinPerPerson));

  charts.append(c1, c2);
  body.append(leftCol, charts);
  card.append(head, body);
  return card;
}

function bucketLabel(b) {
  return { main: '主食', side: '小食', drink: '饮料', other: '其他' }[b] ?? b;
}
function div(cls) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  return d;
}

/* ---------- 主流程 ---------- */
function splitKeywords(v) {
  return (v ?? '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
}

async function run() {
  els.runBtn.disabled = true;
  els.runBtn.textContent = '正在调用麦当劳 MCP…';
  els.schemes.textContent = '';
  els.warnings.hidden = true;
  els.meta.hidden = true;

  const payload = {
    city: els.city.value.trim(),
    keyword: els.keyword.value.trim(),
    people: Number(els.people.value) || 1,
    budget: Number(els.budget.value) || 0,
    maxKcal: Number(els.maxKcal.value) || 0,
    minProtein: Number(els.minProtein.value) || 0,
    avoid: splitKeywords(els.avoid.value),
    prefer: splitKeywords(els.prefer.value),
  };

  try {
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await res.json();

    if (!j.ok) {
      showWarnings([j.error ?? '请求失败']);
      els.runBtn.disabled = false;
      els.runBtn.textContent = '生成点单方案';
      return;
    }

    if (j.warnings?.length) showWarnings(j.warnings);

    els.empty.hidden = true;

    // 元信息
    els.meta.hidden = false;
    els.meta.textContent = '';
    const mStore = document.createElement('span');
    mStore.innerHTML = '';
    const b1 = document.createElement('b');
    b1.textContent = j.store?.name ?? '未识别门店';
    mStore.append(document.createTextNode('门店：'), b1);
    const mCount = document.createElement('span');
    const b2 = document.createElement('b');
    b2.textContent = `${j.totals.meals} 项`;
    mCount.append(document.createTextNode('菜单：'), b2);
    const mNut = document.createElement('span');
    const b3 = document.createElement('b');
    b3.textContent = `${j.totals.nutrition} 条`;
    mNut.append(document.createTextNode('营养数据：'), b3);
    const mCp = document.createElement('span');
    const b4 = document.createElement('b');
    b4.textContent = `${j.totals.coupons} 张`;
    mCp.append(document.createTextNode('优惠券：'), b4);
    els.meta.append(mStore, mCount, mNut, mCp);

    if (!j.schemes?.length) {
      const p = document.createElement('p');
      p.textContent = '在当前约束下没有找到可行方案。可以放宽预算或热量上限后重试。';
      p.style.color = '#6b7280';
      els.schemes.append(p);
    } else {
      const ctx = { people: payload.people, budget: payload.budget, maxKcal: payload.maxKcal };
      j.schemes.forEach((s, i) => els.schemes.append(renderScheme(s, i, ctx)));
    }
  } catch (err) {
    showWarnings([`请求异常：${err.message}`]);
  }

  els.runBtn.disabled = false;
  els.runBtn.textContent = '生成点单方案';
}

function showWarnings(list) {
  els.warnings.hidden = false;
  els.warnings.textContent = '';
  const b = document.createElement('b');
  b.textContent = '提示';
  const ul = document.createElement('ul');
  for (const w of list) {
    const li = document.createElement('li');
    li.textContent = w;
    ul.append(li);
  }
  els.warnings.append(b, ul);
}

els.runBtn.addEventListener('click', run);
checkHealth();
