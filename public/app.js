/* BLACKOUT 주문관리 PWA - 프론트엔드 (의존성 없는 단일 파일) */
(() => {
  'use strict';

  const app = document.getElementById('app');
  const state = { user: null, meta: null, booted: false };

  // ---------- utils ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const won = (n) => (n === null || n === undefined ? '-' : `${Number(n).toLocaleString('ko-KR')}원`);
  const num = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('ko-KR'));
  const dt = (s) => (s ? String(s).slice(0, 16) : '-');
  const nameOf = (list, code) => (list || []).find((x) => x.code === code)?.name || code || '-';
  const sizeOf = (o) => `${num(o.width_mm)} × ${num(o.height_mm)} mm`;

  let toastTimer;
  function toast(msg, isErr) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast show${isErr ? ' err' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = 'toast'), 2600);
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && state.user) {
      state.user = null;
      state.meta = null;
      render();
    }
    if (!res.ok) {
      const err = new Error(data.error || `요청 실패 (${res.status})`);
      err.data = data;
      throw err;
    }
    return data;
  }

  function formData(form) {
    const out = {};
    for (const [k, v] of new FormData(form).entries()) out[k] = v;
    return out;
  }

  function busy(btn, on) {
    if (!btn) return;
    btn.disabled = on;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = '처리 중…'; }
    else if (btn.dataset.label) btn.textContent = btn.dataset.label;
  }

  // ---------- routing ----------
  function route() {
    const hash = location.hash.replace(/^#/, '') || '/';
    const [path, qs] = hash.split('?');
    const parts = path.split('/').filter(Boolean);
    return { path, parts, query: Object.fromEntries(new URLSearchParams(qs || '')) };
  }
  const go = (path) => { location.hash = path; };
  window.addEventListener('hashchange', render);

  // ---------- boot ----------
  async function boot() {
    try {
      const me = await api('GET', '/api/auth/me');
      state.user = me.user;
      state.meta = await api('GET', '/api/meta');
    } catch { state.user = null; }
    state.booted = true;
    render();
  }

  async function reloadMeta() {
    state.meta = await api('GET', '/api/meta');
  }

  // ---------- render ----------
  const NAV = {
    vendor: [['/orders', '내 주문'], ['/orders/new', '새 주문']],
    admin: [['/orders', '주문관리'], ['/smartstore', '스마트스토어'], ['/stats', '매출·마진'], ['/vendors', '업체관리'], ['/users', '계정관리'], ['/settings', '가격설정']],
    factory: [['/orders', '제작 주문서']],
  };

  function render() {
    if (!state.booted) { app.innerHTML = '<div class="empty">불러오는 중…</div>'; return; }
    if (!state.user) return renderLogin();
    const r = route();
    const nav = NAV[state.user.role];
    const activePath = r.parts[0] === 'orders' && r.parts[1] === 'new' ? '/orders/new' : `/${r.parts[0] || 'orders'}`;
    app.innerHTML = `
      <header class="topbar">
        <div class="logo"><img src="/icons/logo-white.png" alt="${esc(state.meta?.company_name || 'BLACKOUT')}" /><small>주문관리</small></div>
        <div class="row">
          <div class="who">${esc(state.user.name)}<span class="role">${roleName(state.user.role)}</span></div>
          <button data-action="password" title="비밀번호 변경">비밀번호</button>
          <button data-action="logout">로그아웃</button>
        </div>
      </header>
      <nav class="nav">${nav.map(([p, l]) => `<a href="#${p}" class="${p === activePath ? 'active' : ''}">${l}</a>`).join('')}</nav>
      <main id="main"></main>`;
    app.querySelector('[data-action=logout]').onclick = async () => { await api('POST', '/api/auth/logout', {}); state.user = null; state.meta = null; go('/'); render(); };
    app.querySelector('[data-action=password]').onclick = () => go('/password');
    const main = document.getElementById('main');
    const role = state.user.role;
    const p = r.parts;
    if (p[0] === 'password') return viewPassword(main);
    if (p[0] === 'orders' && p[1] === 'new' && role !== 'factory') return viewNewOrder(main, r);
    if (p[0] === 'orders' && p[1]) return viewOrderDetail(main, Number(p[1]));
    if (role === 'admin' && p[0] === 'stats') return viewStats(main, r);
    if (role === 'admin' && p[0] === 'vendors') return viewVendors(main);
    if (role === 'admin' && p[0] === 'users') return viewUsers(main);
    if (role === 'admin' && p[0] === 'settings') return viewSettings(main);
    if (role === 'admin' && p[0] === 'smartstore') return viewSmartstore(main, r);
    return viewOrders(main, r);
  }

  const roleName = (r) => ({ admin: '관리자', vendor: '업체', factory: '공장' }[r] || r);

  // ---------- login ----------
  function renderLogin() {
    app.innerHTML = `
      <div class="login">
        <div class="brand"><img src="/icons/logo-dark.png" alt="BLACKOUT" /></div>
        <div class="sub">업체 · 관리자 · 제조공장 통합 주문관리</div>
        <form id="loginForm" class="card">
          <label class="f"><span>아이디</span><input type="text" name="username" autocomplete="username" autocapitalize="none" required /></label>
          <label class="f"><span>비밀번호</span><input type="password" name="password" autocomplete="current-password" required /></label>
          <div class="error" id="loginErr"></div>
          <button class="btn primary block" type="submit">로그인</button>
        </form>
        <p class="muted small" style="text-align:center">계정이 필요하면 BLACKOUT 관리자에게 문의하세요.</p>
      </div>`;
    const form = document.getElementById('loginForm');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button');
      busy(btn, true);
      try {
        const res = await api('POST', '/api/auth/login', formData(form));
        state.user = res.user;
        state.meta = await api('GET', '/api/meta');
        go('/orders');
        render();
      } catch (err) {
        document.getElementById('loginErr').textContent = err.message;
      } finally { busy(btn, false); }
    };
  }

  // ---------- password ----------
  function viewPassword(main) {
    main.innerHTML = `
      <h1>비밀번호 변경</h1>
      <form id="pwForm" class="card">
        <label class="f"><span>현재 비밀번호</span><input type="password" name="current_password" autocomplete="current-password" required /></label>
        <label class="f"><span>새 비밀번호 (8자 이상)</span><input type="password" name="new_password" autocomplete="new-password" minlength="8" required /></label>
        <label class="f"><span>새 비밀번호 확인</span><input type="password" name="confirm" autocomplete="new-password" required /></label>
        <div class="error" id="pwErr"></div>
        <div class="actions"><button class="btn primary" type="submit">변경</button><a class="btn" href="#/orders">취소</a></div>
      </form>`;
    const form = document.getElementById('pwForm');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const d = formData(form);
      if (d.new_password !== d.confirm) { document.getElementById('pwErr').textContent = '새 비밀번호가 일치하지 않습니다.'; return; }
      try { await api('POST', '/api/auth/password', d); toast('비밀번호가 변경되었습니다.'); go('/orders'); }
      catch (err) { document.getElementById('pwErr').textContent = err.message; }
    };
  }

  // ---------- orders list ----------
  const FACTORY_TABS = [
    ['approved', '제작 대기'], ['in_production', '제작 중'], ['shipped', '출고 완료'], ['delivered,cancelled', '완료·취소'], ['', '전체'],
  ];
  const ADMIN_TABS = [
    ['', '전체'], ['received', '접수 (승인 대기)'], ['on_hold', '보류'], ['approved', '공장 전달'], ['in_production', '제작 중'], ['shipped', '출고'], ['delivered', '배송 완료'], ['cancelled', '취소'],
  ];
  const VENDOR_TABS = [
    ['', '전체'], ['received,on_hold', '접수'], ['approved,in_production', '제작 중'], ['shipped', '배송 중'], ['delivered', '완료'], ['cancelled', '취소'],
  ];

  async function viewOrders(main, r) {
    const role = state.user.role;
    const tabs = role === 'factory' ? FACTORY_TABS : role === 'admin' ? ADMIN_TABS : VENDOR_TABS;
    const status = r.query.status ?? (role === 'factory' ? 'approved' : '');
    const q = r.query.q || '';
    const vendorId = r.query.vendor_id || '';
    main.innerHTML = `
      <div class="row between">
        <h1>${role === 'factory' ? '제작 주문서' : role === 'admin' ? '주문관리' : '내 주문'}</h1>
        ${role !== 'factory' ? '<a class="btn primary sm" href="#/orders/new">+ 새 주문</a>' : ''}
      </div>
      <div class="tabs">${tabs.map(([s, l]) => `<button data-status="${s}" class="${s === status ? 'active' : ''}">${l}</button>`).join('')}</div>
      <form class="filters" id="filterForm">
        <input type="text" name="q" placeholder="주문번호 · 수령인 · 송장번호${role === 'admin' ? ' · 업체' : ''}" value="${esc(q)}" />
        ${role === 'admin' ? `<select name="vendor_id"><option value="">전체 업체</option>${(state.meta.vendors || []).map((v) => `<option value="${v.id}" ${String(v.id) === vendorId ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>` : ''}
        <button class="btn sm" type="submit">검색</button>
      </form>
      <div id="list"><div class="empty">불러오는 중…</div></div>`;
    main.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => go(`/orders?${new URLSearchParams({ status: b.dataset.status, q, vendor_id: vendorId })}`)));
    document.getElementById('filterForm').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      go(`/orders?${new URLSearchParams({ status, q: d.q || '', vendor_id: d.vendor_id || '' })}`);
    };
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (q) params.set('q', q);
    if (vendorId) params.set('vendor_id', vendorId);
    try {
      const { orders } = await api('GET', `/api/orders?${params}`);
      const list = document.getElementById('list');
      if (!orders.length) { list.innerHTML = '<div class="empty">주문이 없습니다.</div>'; return; }
      list.innerHTML = orders.map((o) => orderCard(o, role)).join('');
    } catch (err) { document.getElementById('list').innerHTML = `<div class="error">${esc(err.message)}</div>`; }
  }

  function orderCard(o, role) {
    const m = state.meta;
    return `
      <a class="card link" href="#/orders/${o.id}">
        <div class="row between">
          <span class="title">${esc(o.order_no)}</span>
          <span><span class="chip ${o.status}">${esc(o.status_name)}</span>${o.source === 'smartstore' ? ' <span class="chip source">스마트스토어</span>' : ''}</span>
        </div>
        <div class="spec">${esc(o.product_type_name)} · ${sizeOf(o)}${o.quantity > 1 ? ` · ${o.quantity}개` : ''}</div>
        <div class="small muted">프레임 ${nameOf(m.frame_colors, o.frame_color)} · 원단 ${nameOf(m.fabric_colors, o.fabric_color)} · ${o.area_sqm}㎡</div>
        <div class="row between small" style="margin-top:8px">
          <span class="muted">${role === 'admin' ? esc(o.vendor_name || '-') + ' · ' : ''}${esc(o.recipient_name)} · ${dt(o.created_at)}</span>
          ${role !== 'factory' ? `<strong>${won(o.total_amount)}</strong>` : `<span>${o.tracking_no ? esc(o.tracking_carrier) + ' ' + esc(o.tracking_no) : ''}</span>`}
        </div>
      </a>`;
  }

  // ---------- new order ----------
  function specFields(m, o = {}, { withVendor = false } = {}) {
    const seg = (name, list, cur) => `<div class="seg">${list.map((x) => `<label><input type="radio" name="${name}" value="${x.code}" ${cur === x.code ? 'checked' : ''} required /><span class="opt">${esc(x.name)}</span></label>`).join('')}</div>`;
    return `
      ${withVendor ? `<label class="f"><span>주문 업체</span><select name="vendor_id" required><option value="">업체 선택</option>${(m.vendors || []).filter((v) => v.active).map((v) => `<option value="${v.id}" ${o.vendor_id === v.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>` : ''}
      <label class="f"><span>제품 형태</span>${seg('product_type', m.product_types, o.product_type || m.product_types[0]?.code)}</label>
      <div class="grid2">
        <label class="f"><span>가로 (mm)</span><input type="number" name="width_mm" inputmode="numeric" min="${m.limits.min_size_mm}" max="${m.limits.max_size_mm}" step="1" value="${o.width_mm ?? ''}" placeholder="예: 1200" required /></label>
        <label class="f"><span>세로 (mm)</span><input type="number" name="height_mm" inputmode="numeric" min="${m.limits.min_size_mm}" max="${m.limits.max_size_mm}" step="1" value="${o.height_mm ?? ''}" placeholder="예: 1800" required /></label>
      </div>
      <label class="f"><span>프레임 색상</span>${seg('frame_color', m.frame_colors, o.frame_color || 'white')}</label>
      <label class="f"><span>허니콤 원단</span>${seg('fabric_color', m.fabric_colors, o.fabric_color || 'white')}</label>
      <label class="f"><span>수량</span><input type="number" name="quantity" inputmode="numeric" min="1" max="100" step="1" value="${o.quantity ?? 1}" required /></label>`;
  }

  function shipFields(o = {}) {
    return `
      <div class="grid2 stack-sm">
        <label class="f"><span>수령인</span><input type="text" name="recipient_name" value="${esc(o.recipient_name)}" required /></label>
        <label class="f"><span>수령인 연락처</span><input type="tel" name="recipient_phone" value="${esc(o.recipient_phone)}" placeholder="010-0000-0000" required /></label>
      </div>
      <div class="grid2 stack-sm">
        <label class="f"><span>우편번호</span><input type="text" name="zip_code" value="${esc(o.zip_code)}" inputmode="numeric" /></label>
        <label class="f"><span>배송지 주소</span><input type="text" name="address" value="${esc(o.address)}" required /></label>
      </div>
      <label class="f"><span>상세 주소</span><input type="text" name="address_detail" value="${esc(o.address_detail)}" /></label>
      <label class="f"><span>설치 관련 요청사항</span><textarea name="install_note" placeholder="설치 희망일, 현장 특이사항 등">${esc(o.install_note)}</textarea></label>`;
  }

  function quoteHtml(result, role) {
    if (!result) return '<div class="muted small">규격을 입력하면 견적이 자동 계산됩니다.</div>';
    if (!result.ok) return result.errors.map((e) => `<div class="err">· ${esc(e)}</div>`).join('');
    const q = result.quote;
    const minNote = q.area_sqm < q.billed_area_sqm ? ` (최소 ${q.min_billable_area_sqm}㎡ 적용)` : '';
    return `
      <div class="line"><span>실제 면적</span><span>${q.area_sqm}㎡${minNote}</span></div>
      <div class="line"><span>제품금액 (${q.billed_area_sqm}㎡ × ${won(q.unit_price)}${q.quantity > 1 ? ` × ${q.quantity}` : ''})</span><span>${won(q.product_amount)}</span></div>
      ${q.surcharge ? `<div class="line"><span>${esc(q.product_type_name)} 추가금</span><span>${won(q.surcharge)}</span></div>` : ''}
      <div class="line"><span>택배비 (업체 부담)</span><span>${won(q.shipping_fee)}</span></div>
      <div class="total"><span>최종 주문금액</span><span>${won(q.total_amount)}</span></div>
      ${role === 'admin' && q.factory_cost !== undefined ? `<div class="line small"><span>예상 제작원가 / 마진</span><span>${won(q.factory_cost)} / ${won(q.product_amount + q.surcharge - q.factory_cost)}</span></div>` : ''}`;
  }

  function bindLiveQuote(form, box, role) {
    let timer;
    const run = async () => {
      const d = formData(form);
      if (!d.width_mm || !d.height_mm || (role === 'admin' && !d.vendor_id)) { box.innerHTML = quoteHtml(null); return; }
      try { box.innerHTML = quoteHtml(await api('POST', '/api/quote', d), role); }
      catch (err) { box.innerHTML = `<div class="err">${esc(err.message)}</div>`; }
    };
    form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
    form.addEventListener('change', run);
    run();
  }

  function viewNewOrder(main) {
    const m = state.meta;
    const role = state.user.role;
    main.innerHTML = `
      <h1>새 주문</h1>
      ${role === 'vendor' && m.vendor ? `<div class="muted small" style="margin-bottom:10px">${esc(m.vendor.name)} · 적용 단가 ${won(m.vendor.unit_price_per_sqm)}/㎡ · 최소 주문면적 ${m.pricing.min_billable_area_sqm}㎡</div>` : ''}
      <form id="orderForm">
        <div class="card"><h3>제품 · 규격</h3>${specFields(m, {}, { withVendor: role === 'admin' })}</div>
        <div class="quote" id="quoteBox"></div>
        <div class="card"><h3>배송지 · 수령인</h3>${shipFields()}</div>
        ${role === 'admin' ? `<div class="card"><h3>관리자 전용</h3>
          <label class="f"><span>주문 경로</span><select name="source"><option value="vendor">업체 주문</option><option value="smartstore">스마트스토어 (수동 등록)</option></select></label>
          <label class="f"><span>외부 주문번호 (스마트스토어 등)</span><input type="text" name="external_ref" /></label>
          <label class="f"><span>관리자 메모 (공장 비노출)</span><textarea name="admin_memo"></textarea></label></div>` : ''}
        <div class="error" id="orderErr"></div>
        <div class="actions"><button class="btn primary block" type="submit">주문하기</button></div>
      </form>`;
    const form = document.getElementById('orderForm');
    bindLiveQuote(form, document.getElementById('quoteBox'), role);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      busy(btn, true);
      try {
        const res = await api('POST', '/api/orders', formData(form));
        toast(`주문 ${res.order.order_no} 접수되었습니다.`);
        go(`/orders/${res.order.id}`);
      } catch (err) {
        document.getElementById('orderErr').textContent = err.message;
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      } finally { busy(btn, false); }
    };
  }

  // ---------- order detail ----------
  async function viewOrderDetail(main, id) {
    main.innerHTML = '<div class="empty">불러오는 중…</div>';
    let data;
    try { data = await api('GET', `/api/orders/${id}`); }
    catch (err) { main.innerHTML = `<div class="error">${esc(err.message)}</div><a class="btn" href="#/orders">목록으로</a>`; return; }
    const { order: o, history, allowed_transitions, smartstore: ssInfo, tracking_lookup: tl } = data;
    const role = state.user.role;
    const m = state.meta;
    const canEdit = role === 'admin' ? ['received', 'on_hold', 'approved'].includes(o.status) : role === 'vendor' ? ['received', 'on_hold'].includes(o.status) : false;

    main.innerHTML = `
      <div class="row between no-print">
        <a href="#/orders" class="muted small">← 목록</a>
        ${role === 'factory' ? '<button class="btn sm" id="printBtn">주문서 인쇄</button>' : ''}
      </div>
      <div class="row between"><h1 style="margin:8px 0">${esc(o.order_no)}</h1><span class="chip ${o.status}">${esc(o.status_name)}</span></div>
      ${o.source === 'smartstore' ? `<div class="small muted">스마트스토어 주문${o.external_ref ? ' · ' + esc(o.external_ref) : ''}</div>` : ''}

      <div class="card">
        <h3>제작 규격</h3>
        <dl class="kv">
          <dt>제품 형태</dt><dd><strong>${esc(o.product_type_name)}</strong></dd>
          <dt>제작 규격</dt><dd><strong>${sizeOf(o)}</strong> (${o.area_sqm}㎡)</dd>
          <dt>프레임 색상</dt><dd>${nameOf(m.frame_colors, o.frame_color)}</dd>
          <dt>허니콤 원단</dt><dd>${nameOf(m.fabric_colors, o.fabric_color)}</dd>
          <dt>수량</dt><dd>${o.quantity}개</dd>
          <dt>설치 요청</dt><dd>${esc(o.install_note || '-')}</dd>
        </dl>
      </div>

      <div class="card">
        <h3>배송지</h3>
        <dl class="kv">
          <dt>수령인</dt><dd>${esc(o.recipient_name)}</dd>
          <dt>연락처</dt><dd><a href="tel:${esc(o.recipient_phone)}">${esc(o.recipient_phone)}</a></dd>
          <dt>주소</dt><dd>${o.zip_code ? `(${esc(o.zip_code)}) ` : ''}${esc(o.address)} ${esc(o.address_detail || '')}</dd>
          <dt>택배사 / 송장</dt><dd>${o.tracking_no ? `${esc(o.tracking_carrier)} <strong>${esc(o.tracking_no)}</strong>` : tl && !['found', 'manual'].includes(tl.status) ? `${esc(o.tracking_carrier)} <span class="muted">송장 찾는 중</span>` : '<span class="muted">미등록</span>'}</dd>
        </dl>
        ${!o.tracking_no && tl && !['found', 'manual'].includes(tl.status) ? trackingLookupBox(tl) : ''}
      </div>

      ${role !== 'factory' ? `
      <div class="card">
        <h3>주문 금액</h3>
        <dl class="kv">
          ${role === 'admin' ? `<dt>업체</dt><dd>${esc(o.vendor_name || '-')}</dd>` : ''}
          <dt>적용 단가</dt><dd>${won(o.unit_price)}/㎡ · 과금 면적 ${o.billed_area_sqm}㎡</dd>
          <dt>제품금액</dt><dd>${won(o.product_amount)}</dd>
          ${o.surcharge ? `<dt>유형 추가금</dt><dd>${won(o.surcharge)}</dd>` : ''}
          <dt>택배비</dt><dd>${won(o.shipping_fee)}</dd>
          <dt>최종 금액</dt><dd><strong>${won(o.total_amount)}</strong></dd>
          ${role === 'admin' ? `<dt>제작원가 / 마진</dt><dd>${won(o.factory_cost)} / <strong>${won(o.product_amount + o.surcharge - o.factory_cost)}</strong></dd>` : ''}
        </dl>
      </div>` : ''}

      <div class="card no-print">
        <h3>진행</h3>
        <dl class="kv small">
          <dt>접수</dt><dd>${dt(o.created_at)}</dd>
          <dt>발주 승인</dt><dd>${dt(o.approved_at)}</dd>
          <dt>제작 시작</dt><dd>${dt(o.production_started_at)}</dd>
          <dt>출고</dt><dd>${dt(o.shipped_at)}</dd>
          <dt>배송 완료</dt><dd>${dt(o.delivered_at)}</dd>
        </dl>
        <div id="actionArea"></div>
      </div>

      ${role === 'admin' && ssInfo ? `<div class="card no-print"><h3>스마트스토어 연동</h3>
        <dl class="kv small">
          <dt>상품주문번호</dt><dd>${esc(ssInfo.product_order_id)} <span class="muted">(주문번호 ${esc(ssInfo.naver_order_id || '-')})</span></dd>
          <dt>주문자</dt><dd>${esc(ssInfo.orderer_name || '-')}</dd>
          <dt>구매 옵션</dt><dd>${esc(ssInfo.product_option || '-')}</dd>
          <dt>배송 메모</dt><dd>${esc(ssInfo.shipping_memo || '-')}</dd>
          <dt>네이버 상태</dt><dd>${esc(ssInfo.naver_status || '-')}${ssInfo.claim_status ? ` · <span class="chip on_hold">${esc(ssInfo.claim_status)}</span>` : ''}</dd>
          <dt>발주확인</dt><dd>${ssInfo.confirmed_at ? `전송됨 (${dt(ssInfo.confirmed_at)})` : '<span class="muted">미전송 (승인 시 자동)</span>'}</dd>
          <dt>발송처리</dt><dd>${ssInfo.dispatch_synced ? '전송됨' : ssInfo.dispatch_error ? `<span class="error">실패: ${esc(ssInfo.dispatch_error)}</span>` : '<span class="muted">출고 시 자동</span>'}</dd>
        </dl>
        ${ssInfo.dispatch_error && !ssInfo.dispatch_synced ? `<div class="actions"><button class="btn sm" id="dispatchRetry">발송처리 재전송</button></div>` : ''}
      </div>` : ''}
      ${role === 'admin' ? `<div class="card no-print"><h3>관리자 메모 (공장·업체 비노출)</h3>
        <form id="memoForm"><textarea name="admin_memo">${esc(o.admin_memo)}</textarea><div class="actions"><button class="btn sm" type="submit">메모 저장</button></div></form></div>` : ''}

      ${canEdit ? `<div class="card no-print"><div class="row between"><h3>주문 내용 수정</h3><button class="btn sm" id="editToggle">수정</button></div><div id="editArea"></div></div>` : ''}

      <div class="card no-print">
        <h3>변경 이력</h3>
        <ul class="timeline">${history.map(historyItem).join('') || '<li class="muted">이력이 없습니다.</li>'}</ul>
      </div>

      <div class="worksheet card">
        <h3>BLACKOUT 제작 주문서</h3>
        <p class="small muted">출력일시 ${new Date().toLocaleString('ko-KR')}</p>
      </div>`;

    if (role === 'factory') document.getElementById('printBtn').onclick = () => window.print();
    renderActions(document.getElementById('actionArea'), o, allowed_transitions, role);

    main.querySelectorAll('[data-lookup]').forEach((b) => (b.onclick = async () => {
      busy(b, true);
      try {
        const r = await api('POST', `/api/orders/${o.id}/tracking-lookup`, b.dataset.lookup === 'retry' ? { action: 'retry' } : { action: 'choose', tracking_no: b.dataset.lookup });
        toast(r.order.tracking_no ? `송장번호 ${r.order.tracking_no} 등록` : r.tracking_lookup.status === 'multiple' ? '후보를 골라 주세요.' : '아직 찾지 못했습니다.');
        render();
      } catch (err) { toast(err.message, true); busy(b, false); }
    }));

    if (role === 'admin' && document.getElementById('dispatchRetry')) {
      document.getElementById('dispatchRetry').onclick = async () => {
        try { await api('POST', `/api/smartstore/orders/${ssInfo.product_order_id}/dispatch-retry`, {}); toast('발송처리를 전송했습니다.'); render(); }
        catch (err) { toast(err.message, true); }
      };
    }
    if (role === 'admin') {
      document.getElementById('memoForm').onsubmit = async (e) => {
        e.preventDefault();
        try { await api('PATCH', `/api/orders/${o.id}`, formData(e.target)); toast('메모를 저장했습니다.'); render(); }
        catch (err) { toast(err.message, true); }
      };
    }
    if (canEdit) {
      const area = document.getElementById('editArea');
      document.getElementById('editToggle').onclick = () => {
        if (area.innerHTML) { area.innerHTML = ''; return; }
        area.innerHTML = `
          ${o.status === 'approved' ? '<div class="notice">이미 공장에 전달된 주문입니다. 수정하면 공장 주문서에 즉시 반영되므로 공장에 별도 확인이 필요합니다.</div>' : ''}
          <form id="editForm">
            ${specFields(m, o)}
            <div class="quote" id="editQuote"></div>
            ${shipFields(o)}
            <label class="f"><span>변경 사유</span><input type="text" name="note" placeholder="예: 현장 실측 반영" /></label>
            <div class="error" id="editErr"></div>
            <div class="actions"><button class="btn primary" type="submit">수정 저장</button></div>
          </form>`;
        const form = document.getElementById('editForm');
        if (role === 'admin') {
          const hidden = document.createElement('input');
          hidden.type = 'hidden'; hidden.name = 'vendor_id'; hidden.value = o.vendor_id;
          form.appendChild(hidden);
        }
        bindLiveQuote(form, document.getElementById('editQuote'), role);
        form.onsubmit = async (e) => {
          e.preventDefault();
          const d = formData(form);
          delete d.vendor_id;
          try { await api('PATCH', `/api/orders/${o.id}`, d); toast('주문을 수정했습니다.'); render(); }
          catch (err) { document.getElementById('editErr').textContent = err.message; }
        };
      };
    }
  }

  function historyItem(h) {
    const label = { created: '주문 접수', updated: '주문 내용 수정', status: `${h.from_status_name || ''} → ${h.to_status_name || ''}`, tracking: '송장 정보 수정', note: '연동 알림' }[h.event] || h.event;
    const details = h.details ? Object.entries(h.details).map(([k, v]) => {
      const name = FIELD_NAMES[k] || k;
      if (v && typeof v === 'object' && 'from' in v) return `${name}: ${fmtVal(k, v.from)} → ${fmtVal(k, v.to)}`;
      return `${name}: ${esc(v)}`;
    }).join(' · ') : '';
    return `<li><div><strong>${esc(label)}</strong> <span class="muted">· ${esc(h.actor_name || '')}${h.actor_role ? ` (${roleName(h.actor_role)})` : ''}</span></div>
      ${h.note ? `<div>${esc(h.note)}</div>` : ''}${details ? `<div class="d">${details}</div>` : ''}<div class="t">${dt(h.created_at)}</div></li>`;
  }
  const FIELD_NAMES = {
    product_type: '제품 형태', width_mm: '가로', height_mm: '세로', frame_color: '프레임', fabric_color: '원단', quantity: '수량',
    area_sqm: '면적', billed_area_sqm: '과금 면적', unit_price: '단가', product_amount: '제품금액', surcharge: '추가금', shipping_fee: '택배비',
    total_amount: '최종 금액', factory_cost: '제작원가', recipient_name: '수령인', recipient_phone: '연락처', zip_code: '우편번호', address: '주소',
    address_detail: '상세주소', install_note: '설치 요청', admin_memo: '관리자 메모', tracking_carrier: '택배사', tracking_no: '송장번호',
  };
  function fmtVal(k, v) {
    if (v === null || v === undefined || v === '') return '-';
    if (/amount|price|surcharge|fee|cost/.test(k)) return won(v);
    if (k === 'product_type') return esc(nameOf(state.meta.product_types, v));
    if (k === 'frame_color') return esc(nameOf(state.meta.frame_colors, v));
    if (k === 'fabric_color') return esc(nameOf(state.meta.fabric_colors, v));
    return esc(v);
  }

  // 송장 없이 출고된 대신택배 주문: 자동 찾기 상태 · 후보 고르기
  function trackingLookupBox(tl) {
    const tried = tl.attempts ? ` · ${tl.attempts}회 조회${tl.last_error ? ` · <span class="error">${esc(tl.last_error)}</span>` : ''}` : '';
    if (tl.status === 'multiple') {
      return `<div class="notice no-print"><strong>송장 후보 ${tl.candidates.length}건</strong> · 맞는 송장을 골라 주세요.
        <div class="table-wrap"><table><thead><tr><th>접수</th><th>송장번호</th><th>받는 분</th><th>도착 영업소</th><th>상태</th><th></th></tr></thead><tbody>
        ${tl.candidates.map((c) => `<tr><td>${esc(c.received_at)}</td><td>${esc(c.tracking_no)}</td><td>${esc(c.receiver)}</td><td>${esc(c.branch)}</td><td>${esc(c.status)}</td>
          <td><button class="btn sm primary" data-lookup="${esc(c.tracking_no)}">이 송장</button></td></tr>`).join('')}
        </tbody></table></div></div>`;
    }
    if (tl.status === 'not_found') {
      return `<div class="notice no-print">대신택배에서 송장을 찾지 못했습니다${tried}. 아래 「송장 수정」으로 직접 입력하거나 다시 찾아 주세요.
        <div class="actions"><button class="btn sm" data-lookup="retry">지금 다시 찾기</button></div></div>`;
    }
    return `<div class="notice no-print">대신택배에서 받는 분 전화번호로 송장번호를 찾는 중입니다 (30분마다${tried}). 찾으면 자동으로 등록됩니다.
      <div class="actions"><button class="btn sm" data-lookup="retry">지금 다시 찾기</button></div></div>`;
  }

  function renderActions(area, o, transitions, role) {
    if (!transitions.length && !(role !== 'vendor' && ['shipped', 'delivered'].includes(o.status))) {
      area.innerHTML = '';
      return;
    }
    const btnClass = { approved: 'accent', in_production: 'accent', shipped: 'ok', delivered: 'ok', cancelled: 'danger', on_hold: '', received: '' };
    const btnLabel = { approved: '결제 확인 · 발주 승인 (공장 전달)', in_production: '주문 확인 · 제작 시작', shipped: '제작 완료 · 출고 (송장 등록)', delivered: '배송 완료 처리', cancelled: '주문 취소', on_hold: '보류 (확인 필요)', received: '접수 상태로 되돌리기' };
    area.innerHTML = `
      <div class="actions">${transitions.map((t) => `<button class="btn ${btnClass[t.code] || ''}" data-to="${t.code}">${btnLabel[t.code] || t.name}</button>`).join('')}
      ${role !== 'vendor' && ['shipped', 'delivered'].includes(o.status) ? '<button class="btn" data-to="__tracking">송장 수정</button>' : ''}</div>
      <div id="actionForm"></div>`;
    area.querySelectorAll('button[data-to]').forEach((b) => (b.onclick = () => showActionForm(o, b.dataset.to, role)));
  }

  function showActionForm(o, to, role) {
    const box = document.getElementById('actionForm');
    const m = state.meta;
    const needsTracking = to === 'shipped' || to === '__tracking';
    const carrier0 = o.tracking_carrier || m.default_carrier;
    const carrierSel = `<label class="f"><span>택배사</span><select name="tracking_carrier" required>${m.carriers.map((c) => `<option ${carrier0 === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>`;
    box.innerHTML = `
      <form id="statusForm" class="card" style="margin-top:10px">
        <h3>${to === '__tracking' ? '송장 수정' : esc((state.meta.statuses.find((s) => s.code === to) || {}).name)}</h3>
        ${needsTracking ? carrierSel + `<label class="f"><span>송장번호</span><input type="text" name="tracking_no" value="${esc(o.tracking_no)}" inputmode="numeric" autocomplete="off" /><small class="muted" id="trackingHint"></small></label>` : ''}
        ${to !== '__tracking' ? `<label class="f"><span>메모 ${to === 'cancelled' || to === 'on_hold' ? '(사유)' : '(선택)'}</span><input type="text" name="note" ${to === 'cancelled' || to === 'on_hold' ? 'required' : ''} /></label>` : ''}
        ${to === 'cancelled' ? '<div class="notice">취소 후에는 되돌릴 수 없습니다.</div>' : ''}
        <div class="error" id="statusErr"></div>
        <div class="actions"><button class="btn primary" type="submit">확인</button><button class="btn" type="button" id="cancelAction">닫기</button></div>
      </form>`;
    document.getElementById('cancelAction').onclick = () => (box.innerHTML = '');
    if (needsTracking) {
      // 대신택배 출고는 송장을 비워 두면 서버가 대신택배에서 찾아 채운다
      const sel = box.querySelector('[name=tracking_carrier]');
      const input = box.querySelector('[name=tracking_no]');
      const syncHint = () => {
        const auto = sel.value === m.auto_lookup_carrier;
        input.required = !(auto && to === 'shipped');
        input.placeholder = auto ? '숫자 13자리' : '';
        document.getElementById('trackingHint').textContent = auto && to === 'shipped' ? '비워 두면 대신택배에서 받는 분 전화번호로 자동으로 찾습니다.' : '';
      };
      sel.onchange = syncHint;
      syncHint();
    }
    document.getElementById('statusForm').onsubmit = async (e) => {
      e.preventDefault();
      const d = formData(e.target);
      const btn = e.target.querySelector('button[type=submit]');
      busy(btn, true);
      try {
        if (to === '__tracking') await api('POST', `/api/orders/${o.id}/tracking`, d);
        else await api('POST', `/api/orders/${o.id}/status`, { ...d, status: to });
        toast('처리되었습니다.');
        render();
      } catch (err) { document.getElementById('statusErr').textContent = err.message; busy(btn, false); }
    };
  }

  // ---------- admin: stats ----------
  async function viewStats(main, r) {
    const today = new Date();
    const first = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    const from = r.query.from ?? first;
    const to = r.query.to ?? '';
    main.classList.add('wide');
    main.innerHTML = `
      <h1>매출 · 마진</h1>
      <form class="filters" id="statsForm">
        <input type="date" name="from" value="${esc(from)}" /><input type="date" name="to" value="${esc(to)}" />
        <button class="btn sm" type="submit">조회</button><a class="btn sm" href="#/stats?from=&to=">전체 기간</a>
      </form>
      <div id="statsBody"><div class="empty">불러오는 중…</div></div>`;
    document.getElementById('statsForm').onsubmit = (e) => { e.preventDefault(); const d = formData(e.target); go(`/stats?${new URLSearchParams({ from: d.from, to: d.to })}`); };
    try {
      const s = await api('GET', `/api/stats?${new URLSearchParams({ from, to })}`);
      const t = s.totals;
      const sc = s.status_counts;
      document.getElementById('statsBody').innerHTML = `
        <div class="tiles">
          <div class="tile dark"><div class="k">주문 건수 (취소 제외)</div><div class="v">${num(t.orders)}건</div></div>
          <div class="tile"><div class="k">매출 (제품+추가금)</div><div class="v">${won(t.revenue)}</div></div>
          <div class="tile"><div class="k">제작원가</div><div class="v">${won(t.factory_cost)}</div></div>
          <div class="tile"><div class="k">마진</div><div class="v">${won(t.margin)}</div></div>
          <div class="tile"><div class="k">택배비 (업체 부담)</div><div class="v">${won(t.shipping)}</div></div>
          <div class="tile"><div class="k">과금 면적</div><div class="v">${num(Math.round(t.billed_area * 100) / 100)}㎡</div></div>
        </div>
        <h2>현재 진행 현황 (전체 기간)</h2>
        <div class="tiles">
          ${['received', 'on_hold', 'approved', 'in_production', 'shipped'].map((k) => `<a class="tile" href="#/orders?status=${k}"><div class="k">${esc(nameOf(state.meta.statuses, k))}</div><div class="v">${num(sc[k])}건</div></a>`).join('')}
        </div>
        ${s.by_source && s.by_source.length > 1 ? `<h2>주문 경로별</h2>
        <div class="table-wrap"><table><thead><tr><th>경로</th><th class="num">건수</th><th class="num">매출</th><th class="num">제작원가</th><th class="num">마진</th></tr></thead>
        <tbody>${s.by_source.map((x) => `<tr><td>${x.source === 'smartstore' ? '스마트스토어' : '업체 주문'}</td><td class="num">${num(x.orders)}</td><td class="num">${won(x.revenue)}</td><td class="num">${won(x.factory_cost)}</td><td class="num">${won(x.margin)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <h2>월별</h2>
        <div class="table-wrap"><table><thead><tr><th>월</th><th class="num">건수</th><th class="num">매출</th><th class="num">제작원가</th><th class="num">마진</th><th class="num">마진율</th></tr></thead>
        <tbody>${s.by_month.map((m) => `<tr><td>${esc(m.month)}</td><td class="num">${num(m.orders)}</td><td class="num">${won(m.revenue)}</td><td class="num">${won(m.factory_cost)}</td><td class="num">${won(m.margin)}</td><td class="num">${m.revenue ? Math.round((m.margin / m.revenue) * 100) : 0}%</td></tr>`).join('') || '<tr><td colspan="6" class="muted">데이터 없음</td></tr>'}</tbody></table></div>
        <h2>업체별</h2>
        <div class="table-wrap"><table><thead><tr><th>업체</th><th class="num">건수</th><th class="num">매출</th><th class="num">제작원가</th><th class="num">마진</th></tr></thead>
        <tbody>${s.by_vendor.map((v) => `<tr class="clickable" data-vendor="${v.vendor_id ?? ''}"><td>${esc(v.vendor_name)}</td><td class="num">${num(v.orders)}</td><td class="num">${won(v.revenue)}</td><td class="num">${won(v.factory_cost)}</td><td class="num">${won(v.margin)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">데이터 없음</td></tr>'}</tbody></table></div>`;
      main.querySelectorAll('tr[data-vendor]').forEach((tr) => (tr.onclick = () => go(`/orders?vendor_id=${tr.dataset.vendor}`)));
    } catch (err) { document.getElementById('statsBody').innerHTML = `<div class="error">${esc(err.message)}</div>`; }
  }

  // ---------- admin: vendors ----------
  async function viewVendors(main) {
    main.innerHTML = `<div class="row between"><h1>업체관리</h1><button class="btn primary sm" id="newVendor">+ 업체 등록</button></div><div id="vendorForm"></div><div id="vendorList"><div class="empty">불러오는 중…</div></div>`;
    const defaultPrice = state.meta.pricing.default_unit_price_per_sqm;
    const showForm = (v = {}) => {
      document.getElementById('vendorForm').innerHTML = `
        <form id="vForm" class="card">
          <h3>${v.id ? '업체 수정' : '업체 등록'}</h3>
          <label class="f"><span>업체명</span><input type="text" name="name" value="${esc(v.name)}" required /></label>
          <div class="grid2 stack-sm">
            <label class="f"><span>담당자</span><input type="text" name="contact_name" value="${esc(v.contact_name)}" /></label>
            <label class="f"><span>연락처</span><input type="tel" name="phone" value="${esc(v.phone)}" /></label>
          </div>
          <label class="f"><span>이메일</span><input type="email" name="email" value="${esc(v.email)}" /></label>
          <label class="f"><span>업체 납품단가 (원/㎡) · 비워두면 기본 단가 ${won(defaultPrice)} 적용</span><input type="number" name="unit_price_per_sqm" value="${v.unit_price_per_sqm ?? ''}" min="0" step="1000" /></label>
          <label class="f"><span>메모</span><textarea name="memo">${esc(v.memo)}</textarea></label>
          ${v.id ? `<label class="f"><span>상태</span><select name="active"><option value="1" ${v.active ? 'selected' : ''}>거래 중</option><option value="0" ${!v.active ? 'selected' : ''}>거래 중지 (주문 불가)</option></select></label>` : ''}
          <div class="error" id="vErr"></div>
          <div class="actions"><button class="btn primary" type="submit">저장</button><button class="btn" type="button" id="vCancel">닫기</button></div>
        </form>`;
      document.getElementById('vCancel').onclick = () => (document.getElementById('vendorForm').innerHTML = '');
      document.getElementById('vForm').onsubmit = async (e) => {
        e.preventDefault();
        const d = formData(e.target);
        if (d.active !== undefined) d.active = d.active === '1';
        try {
          if (v.id) await api('PATCH', `/api/vendors/${v.id}`, d); else await api('POST', '/api/vendors', d);
          toast('저장되었습니다.'); await reloadMeta(); render();
        } catch (err) { document.getElementById('vErr').textContent = err.message; }
      };
    };
    document.getElementById('newVendor').onclick = () => showForm();
    const { vendors } = await api('GET', '/api/vendors');
    document.getElementById('vendorList').innerHTML = vendors.map((v) => `
      <div class="card">
        <div class="row between"><span class="title">${esc(v.name)} ${v.active ? '' : '<span class="chip cancelled">거래 중지</span>'}</span><button class="btn sm" data-id="${v.id}">수정</button></div>
        <dl class="kv small" style="margin-top:8px">
          <dt>담당 / 연락처</dt><dd>${esc(v.contact_name || '-')} / ${esc(v.phone || '-')}</dd>
          <dt>납품단가</dt><dd>${v.unit_price_per_sqm != null ? won(v.unit_price_per_sqm) + '/㎡' : `기본 (${won(defaultPrice)}/㎡)`}</dd>
          <dt>주문 / 계정</dt><dd><a href="#/orders?vendor_id=${v.id}">${num(v.order_count)}건</a> / ${num(v.user_count)}개</dd>
          ${v.memo ? `<dt>메모</dt><dd>${esc(v.memo)}</dd>` : ''}
        </dl>
      </div>`).join('') || '<div class="empty">등록된 업체가 없습니다.</div>';
    main.querySelectorAll('button[data-id]').forEach((b) => (b.onclick = () => { showForm(vendors.find((v) => v.id === Number(b.dataset.id))); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
  }

  // ---------- admin: users ----------
  async function viewUsers(main) {
    main.innerHTML = `<div class="row between"><h1>계정관리</h1><button class="btn primary sm" id="newUser">+ 계정 생성</button></div><div id="userForm"></div><div id="userList"><div class="empty">불러오는 중…</div></div>`;
    const vendors = state.meta.vendors || [];
    const vendorOpts = (sel) => vendors.map((v) => `<option value="${v.id}" ${sel === v.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
    const showForm = (u = null) => {
      document.getElementById('userForm').innerHTML = u ? `
        <form id="uForm" class="card">
          <h3>${esc(u.username)} 수정</h3>
          <label class="f"><span>이름</span><input type="text" name="name" value="${esc(u.name)}" required /></label>
          ${u.role === 'vendor' ? `<label class="f"><span>소속 업체</span><select name="vendor_id">${vendorOpts(u.vendor_id)}</select></label>` : ''}
          <label class="f"><span>비밀번호 재설정 (변경 시에만 입력)</span><input type="password" name="password" autocomplete="new-password" minlength="8" /></label>
          <label class="f"><span>상태</span><select name="active"><option value="1" ${u.active ? 'selected' : ''}>사용</option><option value="0" ${!u.active ? 'selected' : ''}>사용 중지</option></select></label>
          <div class="error" id="uErr"></div>
          <div class="actions"><button class="btn primary" type="submit">저장</button><button class="btn" type="button" id="uCancel">닫기</button></div>
        </form>` : `
        <form id="uForm" class="card">
          <h3>계정 생성</h3>
          <label class="f"><span>역할</span><select name="role" id="roleSel"><option value="vendor">업체</option><option value="factory">공장</option><option value="admin">관리자</option></select></label>
          <label class="f" id="vendorRow"><span>소속 업체</span><select name="vendor_id"><option value="">선택</option>${vendorOpts()}</select></label>
          <label class="f"><span>아이디 (영문 소문자·숫자)</span><input type="text" name="username" autocapitalize="none" required /></label>
          <label class="f"><span>이름 / 표시명</span><input type="text" name="name" required /></label>
          <label class="f"><span>초기 비밀번호 (8자 이상)</span><input type="password" name="password" autocomplete="new-password" minlength="8" required /></label>
          <div class="error" id="uErr"></div>
          <div class="actions"><button class="btn primary" type="submit">생성</button><button class="btn" type="button" id="uCancel">닫기</button></div>
        </form>`;
      document.getElementById('uCancel').onclick = () => (document.getElementById('userForm').innerHTML = '');
      const roleSel = document.getElementById('roleSel');
      if (roleSel) roleSel.onchange = () => (document.getElementById('vendorRow').style.display = roleSel.value === 'vendor' ? '' : 'none');
      document.getElementById('uForm').onsubmit = async (e) => {
        e.preventDefault();
        const d = formData(e.target);
        if (d.active !== undefined) d.active = d.active === '1';
        if (d.password === '') delete d.password;
        try {
          if (u) await api('PATCH', `/api/users/${u.id}`, d); else await api('POST', '/api/users', d);
          toast('저장되었습니다.'); render();
        } catch (err) { document.getElementById('uErr').textContent = err.message; }
      };
    };
    document.getElementById('newUser').onclick = () => showForm();
    const { users } = await api('GET', '/api/users');
    document.getElementById('userList').innerHTML = `<div class="table-wrap"><table><thead><tr><th>아이디</th><th>역할</th><th>이름</th><th>소속 업체</th><th>상태</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.username)}</td><td>${roleName(u.role)}</td><td>${esc(u.name)}</td><td>${esc(u.vendor_name || '-')}</td><td>${u.active ? '사용' : '<span class="chip cancelled">중지</span>'}</td><td><button class="btn sm" data-id="${u.id}">수정</button></td></tr>`).join('')}
    </tbody></table></div>`;
    main.querySelectorAll('button[data-id]').forEach((b) => (b.onclick = () => { showForm(users.find((u) => u.id === Number(b.dataset.id))); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
  }

  // ---------- admin: settings ----------
  async function viewSettings(main) {
    main.innerHTML = '<h1>가격 · 제작 설정</h1><div id="settingsBody"><div class="empty">불러오는 중…</div></div>';
    const data = await api('GET', '/api/settings');
    const body = document.getElementById('settingsBody');
    body.innerHTML = `
      <form id="sForm">
        <div class="card">
          <h3>기본 가격정책</h3>
          ${data.settings.map((s) => `<label class="f"><span>${esc(s.label)}</span>${s.key === 'default_carrier'
            ? `<select name="s.${s.key}">${state.meta.carriers.map((c) => `<option ${c === s.value ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`
            : `<input type="${s.key === 'company_name' ? 'text' : 'number'}" name="s.${s.key}" value="${esc(s.value)}" ${s.key === 'company_name' ? '' : 'min="0" step="any"'} required />`}</label>`).join('')}
          <div class="notice">제품금액 = max(실제 면적, 최소 주문면적) × 단가(업체별 단가 우선) + 유형별 추가금, 최종 금액 = 제품금액 + 택배비. 설정 변경은 이후 신규 주문부터 적용되며 기존 주문 금액은 바뀌지 않습니다.</div>
        </div>
        <div class="card">
          <h3>제품 형태별 추가금</h3>
          <div class="table-wrap"><table id="ptTable"><thead><tr><th>코드</th><th>이름</th><th>업체 추가금 (원)</th><th>공장 추가원가 (원)</th><th>순서</th><th>사용</th></tr></thead>
          <tbody>${data.product_types.map((t) => ptRow(t)).join('')}</tbody></table></div>
          <div class="actions"><button class="btn sm" type="button" id="addPt">+ 형태 추가</button></div>
        </div>
        <div class="error" id="sErr"></div>
        <div class="actions"><button class="btn primary" type="submit">설정 저장</button></div>
      </form>`;
    document.getElementById('addPt').onclick = () => document.querySelector('#ptTable tbody').insertAdjacentHTML('beforeend', ptRow({ code: '', name: '', surcharge: 0, factory_surcharge: 0, sort_order: data.product_types.length + 1, active: 1 }, true));
    document.getElementById('sForm').onsubmit = async (e) => {
      e.preventDefault();
      const settings = {};
      for (const [k, v] of Object.entries(formData(e.target))) if (k.startsWith('s.')) settings[k.slice(2)] = v;
      const product_types = [...document.querySelectorAll('#ptTable tbody tr')].map((tr) => ({
        code: tr.querySelector('[name=code]').value, name: tr.querySelector('[name=name]').value,
        surcharge: tr.querySelector('[name=surcharge]').value, factory_surcharge: tr.querySelector('[name=factory_surcharge]').value,
        sort_order: tr.querySelector('[name=sort_order]').value, active: tr.querySelector('[name=active]').checked,
      })).filter((t) => t.code || t.name);
      try { await api('PUT', '/api/settings', { settings, product_types }); toast('설정을 저장했습니다.'); await reloadMeta(); render(); }
      catch (err) { document.getElementById('sErr').textContent = err.message; }
    };
  }
  function ptRow(t, isNew) {
    return `<tr>
      <td><input type="text" name="code" value="${esc(t.code)}" ${isNew ? 'placeholder="영문 코드"' : 'readonly'} style="width:110px" /></td>
      <td><input type="text" name="name" value="${esc(t.name)}" style="width:110px" /></td>
      <td><input type="number" name="surcharge" value="${t.surcharge}" min="0" step="1000" style="width:120px" /></td>
      <td><input type="number" name="factory_surcharge" value="${t.factory_surcharge}" min="0" step="1000" style="width:120px" /></td>
      <td><input type="number" name="sort_order" value="${t.sort_order}" style="width:70px" /></td>
      <td><input type="checkbox" name="active" ${t.active ? 'checked' : ''} /></td></tr>`;
  }

  // ---------- admin: smartstore ----------
  const SS_TABS = [['needs_review', '확인 필요'], ['cancel', '취소 요청'], ['errors', '발송 오류'], ['imported', '등록됨'], ['', '전체']];
  async function viewSmartstore(main, r) {
    const filter = r.query.filter ?? 'needs_review';
    const m = state.meta;
    const mode = m.smartstore?.mode || 'off';
    main.innerHTML = `
      <h1>네이버 스마트스토어 연동</h1>
      <div id="ssStatus" class="card"><div class="muted">불러오는 중…</div></div>
      <div class="tabs">${SS_TABS.map(([f, l]) => `<button data-filter="${f}" class="${f === filter ? 'active' : ''}">${l}</button>`).join('')}</div>
      <div id="ssList"><div class="empty">불러오는 중…</div></div>
      <h2>동기화 기록</h2>
      <div id="ssLog"></div>`;
    main.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => go(`/smartstore?filter=${b.dataset.filter}`)));

    const renderStatus = (st) => {
      const c = st.counts;
      document.getElementById('ssStatus').innerHTML = `
        <div class="row between">
          <div>
            <div class="title">${mode === 'live' ? '실서버 연동 중' : mode === 'mock' ? '모의(mock) 모드' : '연동 미설정'}</div>
            <div class="small muted">${mode === 'off'
              ? '서버 환경변수 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 을 설정하면 자동으로 연동됩니다. 시험용은 SMARTSTORE_MODE=mock.'
              : `${st.poll_minutes}분 간격 자동 수집${st.polling ? '' : ' (대기 중)'} · 마지막 수집 ${st.last_pull_at ? dt(st.last_pull_at.replace('T', ' ')) + (st.last_pull_ok ? ' 성공' : ' <span class="error">실패</span>') : '없음'}`}</div>
          </div>
          <div class="row">
            ${mode === 'mock' ? '<button class="btn sm" id="mockAdd">모의 주문 생성</button>' : ''}
            <button class="btn primary sm" id="syncNow" ${mode === 'off' ? 'disabled' : ''}>지금 동기화</button>
          </div>
        </div>
        <div class="tiles" style="margin-top:12px">
          <a class="tile" href="#/smartstore?filter=needs_review"><div class="k">확인 필요</div><div class="v">${num(c.needs_review)}</div></a>
          <a class="tile" href="#/smartstore?filter=cancel"><div class="k">취소 요청</div><div class="v">${num(c.cancel_requests)}</div></a>
          <a class="tile" href="#/smartstore?filter=errors"><div class="k">발송 오류</div><div class="v">${num(c.dispatch_errors)}</div></a>
          <a class="tile" href="#/smartstore?filter=imported"><div class="k">등록됨</div><div class="v">${num(c.imported)}</div></a>
        </div>`;
      const syncBtn = document.getElementById('syncNow');
      if (syncBtn) syncBtn.onclick = async () => {
        busy(syncBtn, true);
        try { const res = await api('POST', '/api/smartstore/sync', {}); toast(`수집 ${res.summary.paid.new}건 (자동 등록 ${res.summary.paid.imported}, 확인 필요 ${res.summary.paid.review})`); render(); }
        catch (err) { toast(err.message, true); busy(syncBtn, false); }
      };
      const mockBtn = document.getElementById('mockAdd');
      if (mockBtn) mockBtn.onclick = async () => {
        try { await api('POST', '/api/smartstore/mock/order', {}); toast('모의 주문을 만들었습니다. "지금 동기화"를 눌러 수집하세요.'); }
        catch (err) { toast(err.message, true); }
      };
    };

    try {
      const [{ status: st, logs }, { rows }] = await Promise.all([api('GET', '/api/smartstore/status'), api('GET', `/api/smartstore/orders?filter=${filter}`)]);
      renderStatus(st);
      document.getElementById('ssList').innerHTML = rows.map((row) => ssRow(row, m)).join('') || '<div class="empty">해당 건이 없습니다.</div>';
      document.getElementById('ssLog').innerHTML = logs.length ? `<div class="table-wrap"><table><thead><tr><th>시각</th><th>구분</th><th>결과</th><th>내용</th></tr></thead><tbody>${logs.map((l) => `<tr><td>${dt(l.ran_at)}</td><td>${esc(l.kind)}</td><td>${l.ok ? '성공' : '<span class="error">실패</span>'}</td><td style="white-space:normal">${esc(l.message)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="muted small">기록 없음</div>';
      bindSsRows(rows, m);
    } catch (err) { document.getElementById('ssList').innerHTML = `<div class="error">${esc(err.message)}</div>`; }
  }

  function ssRow(row, m) {
    const spec = row.parsed_spec || {};
    const specText = [spec.product_type ? nameOf(m.product_types, spec.product_type) : null, spec.width_mm && spec.height_mm ? `${num(spec.width_mm)} × ${num(spec.height_mm)} mm` : null,
      spec.frame_color ? `프레임 ${nameOf(m.frame_colors, spec.frame_color)}` : null, spec.fabric_color ? `원단 ${nameOf(m.fabric_colors, spec.fabric_color)}` : null].filter(Boolean).join(' · ');
    const badge = row.import_status === 'imported' ? `<span class="chip ${row.order_status}">${esc(nameOf(m.statuses, row.order_status))}</span>` : row.import_status === 'ignored' ? '<span class="chip">무시됨</span>' : '<span class="chip on_hold">확인 필요</span>';
    const addr = row.shipping_address || {};
    return `
      <div class="card" data-pid="${esc(row.product_order_id)}">
        <div class="row between">
          <span class="title">${row.order_no ? `<a href="#/orders/${row.order_id}">${esc(row.order_no)}</a> · ` : ''}${esc(row.product_order_id)}</span>
          <span>${badge}${row.claim_status === 'CANCEL_REQUEST' ? ' <span class="chip cancelled">취소 요청</span>' : ''}${row.dispatch_error && !row.dispatch_synced ? ' <span class="chip cancelled">발송 오류</span>' : ''}</span>
        </div>
        <div class="small muted">${esc(row.product_name || '')} · ${esc(row.orderer_name || '')} · ${won(row.payment_amount)}${row.delivery_fee ? ` + 배송비 ${won(row.delivery_fee)}` : ''} · ${dt(row.paid_at ? row.paid_at.replace('T', ' ') : row.created_at)}</div>
        <div class="small" style="margin-top:6px"><strong>옵션</strong> ${esc(row.product_option || '-')}</div>
        ${row.shipping_memo ? `<div class="small"><strong>배송메모</strong> ${esc(row.shipping_memo)}</div>` : ''}
        <div class="small"><strong>변환 규격</strong> ${specText || '<span class="muted">없음</span>'}${row.parse_missing.length ? ` <span class="error">누락: ${esc(row.parse_missing.join(', '))}</span>` : ''}</div>
        <div class="small muted">배송지: ${esc(addr.name || '')} ${esc(addr.tel1 || '')} ${esc(addr.baseAddress || '')} ${esc(addr.detailedAddress || '')}</div>
        ${row.dispatch_error && !row.dispatch_synced ? `<div class="error">발송처리 실패: ${esc(row.dispatch_error)}</div>` : ''}
        <div class="actions">
          ${row.import_status === 'needs_review' ? `<button class="btn primary sm" data-act="complete">규격 확인 후 등록</button><button class="btn sm" data-act="ignore">무시</button>` : ''}
          ${row.claim_status === 'CANCEL_REQUEST' ? `<button class="btn danger sm" data-act="cancel">네이버 취소 승인 + 주문 취소</button>` : ''}
          ${row.dispatch_error && !row.dispatch_synced && row.order_id ? `<button class="btn sm" data-act="retry">발송처리 재전송</button>` : ''}
        </div>
        <div class="ss-form"></div>
      </div>`;
  }

  function bindSsRows(rows, m) {
    document.querySelectorAll('[data-pid]').forEach((card) => {
      const pid = card.dataset.pid;
      const row = rows.find((r) => r.product_order_id === pid);
      card.querySelectorAll('button[data-act]').forEach((b) => (b.onclick = async () => {
        const act = b.dataset.act;
        try {
          if (act === 'ignore') { if (!confirm('이 상품주문을 수집 목록에서 무시할까요?')) return; await api('POST', `/api/smartstore/orders/${pid}/ignore`, {}); toast('무시 처리했습니다.'); render(); }
          else if (act === 'cancel') { if (!confirm('네이버에 취소 승인을 전송하고 내부 주문을 취소합니다. 진행할까요?')) return; await api('POST', `/api/smartstore/orders/${pid}/cancel-approve`, {}); toast('취소 승인했습니다.'); render(); }
          else if (act === 'retry') { await api('POST', `/api/smartstore/orders/${pid}/dispatch-retry`, {}); toast('발송처리를 전송했습니다.'); render(); }
          else if (act === 'complete') {
            const box = card.querySelector('.ss-form');
            if (box.innerHTML) { box.innerHTML = ''; return; }
            const spec = row.parsed_spec || {};
            box.innerHTML = `<form class="card" style="margin-top:10px;background:#f8f9fb">
              <div class="notice">옵션에서 읽지 못한 항목을 채우고 등록하면 주문이 "접수" 상태로 생성됩니다. 고객에게 치수를 확인한 뒤 진행하세요.</div>
              ${specFields(m, { product_type: spec.product_type, width_mm: spec.width_mm, height_mm: spec.height_mm, frame_color: spec.frame_color, fabric_color: spec.fabric_color, quantity: row.quantity })}
              <div class="error"></div>
              <div class="actions"><button class="btn primary" type="submit">주문 등록</button></div></form>`;
            const form = box.querySelector('form');
            form.querySelector('input[name=quantity]').readOnly = true;
            form.onsubmit = async (e) => {
              e.preventDefault();
              try { const res = await api('POST', `/api/smartstore/orders/${pid}/import`, formData(form)); toast(`주문 ${res.order.order_no} 등록`); go(`/orders/${res.order.id}`); }
              catch (err) { form.querySelector('.error').textContent = err.message; }
            };
          }
        } catch (err) { toast(err.message, true); }
      }));
    });
  }

  boot();
})();
