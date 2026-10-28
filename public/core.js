/* BLACKOUT 주문관리 PWA - 공통 (로그인 · 알림 · 주문 입력 · 도우미). 화면은 app.js(관리자·공장) / vendor.js(업체) 가 등록한다 */
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


  // ---------- 화면 틀 (어느 화면을 그릴지는 역할 묶음 app.js / vendor.js 가 register 로 알려 준다) ----------
  // 업체는 /vendor/ 에서, 관리자·공장은 / 에서만 쓴다. 다른 자리에 로그인하면 제 자리로 보낸다.
  const IS_VENDOR_APP = location.pathname.startsWith('/vendor');
  const homeFor = (role) => (role === 'vendor' ? '/vendor/' : '/');
  let bundle = null; // { roles, nav, dispatch }
  function register(b) { bundle = b; if (state.booted) render(); }

  function render() {
    if (!state.booted || !bundle) { app.innerHTML = '<div class="empty">불러오는 중…</div>'; return; }
    if (!state.user) return renderLogin();
    if (!bundle.roles.includes(state.user.role)) { location.replace(homeFor(state.user.role) + location.hash); return; }
    const r = route();
    const nav = bundle.nav[state.user.role] || [];
    const activePath = r.parts[0] === 'orders' && r.parts[1] === 'new' ? '/orders/new' : `/${r.parts[0] || 'orders'}`;
    app.innerHTML = `
      <header class="topbar">
        <div class="logo"><img src="/icons/logo-white.png" alt="${esc(state.meta?.company_name || 'BLACKOUT')}" /><small>${IS_VENDOR_APP ? '업체 주문' : '주문관리'}</small></div>
        <div class="row">
          <div class="who">${esc(state.user.name)}<span class="role">${roleName(state.user.role)}</span></div>
          <button data-action="notify" title="휴대폰 알림">알림</button>
          <button data-action="password" title="비밀번호 변경">비밀번호</button>
          <button data-action="logout">로그아웃</button>
        </div>
      </header>
      <nav class="nav">${nav.map(([p, l]) => `<a href="#${p}" class="${p === activePath ? 'active' : ''}">${l}</a>`).join('')}</nav>
      <main id="main"></main>`;
    app.querySelector('[data-action=logout]').onclick = async () => {
      await disablePush().catch(() => {}); // 같은 휴대폰에 다른 계정이 로그인해도 이전 계정 알림이 가지 않게
      await api('POST', '/api/auth/logout', {}); state.user = null; state.meta = null; go('/'); render();
    };
    app.querySelector('[data-action=password]').onclick = () => go('/password');
    app.querySelector('[data-action=notify]').onclick = () => go('/notifications');
    const main = document.getElementById('main');
    const p = r.parts;
    if (p[0] === 'password') return viewPassword(main);
    if (p[0] === 'notifications') return viewNotifications(main);
    return bundle.dispatch(main, r, p, state.user.role);
  }

  const roleName = (r) => ({ admin: '관리자', vendor: '업체', factory: '공장' }[r] || r);

  // ---------- 휴대폰 알림 ----------
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const PUSH_TOPICS = {
    admin: ['업체 새 주문 · 업체 주문 취소', '스마트스토어 새 주문 · 확인 필요 · 취소 요청', '송장 후보 고르기 · 송장 못 찾음'],
    factory: ['새 제작 주문서 (발주 승인)', '송장 후보 고르기 · 송장 못 찾음'],
    vendor: ['발주 승인', '출고 · 송장번호 등록'],
  };
  async function currentPushSub() {
    if (!pushSupported()) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }
  function b64ToU8(s) {
    const b = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  }
  async function enablePush() {
    if (!pushSupported()) throw new Error(isIOS && !isStandalone() ? '아이폰은 Safari 공유 버튼 → 「홈 화면에 추가」로 설치한 앱에서만 알림을 켤 수 있습니다.' : '이 브라우저는 알림을 지원하지 않습니다.');
    const perm = await Notification.requestPermission(); // 아이폰은 버튼을 누른 직후에만 허용 창이 뜬다
    if (perm !== 'granted') throw new Error('알림이 차단돼 있습니다. 휴대폰 설정에서 이 앱(또는 브라우저)의 알림을 허용해 주세요.');
    const { key } = await api('GET', '/api/push/key');
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(key) }));
    await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
  }
  async function disablePush() {
    const sub = await currentPushSub();
    if (!sub) return;
    await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }

  async function viewNotifications(main) {
    const sub = await currentPushSub().catch(() => null);
    const on = !!sub && Notification.permission === 'granted';
    main.innerHTML = `
      <h1>휴대폰 알림</h1>
      <div class="card">
        <div class="title">${on ? '이 휴대폰으로 알림을 받고 있습니다' : '이 휴대폰은 알림이 꺼져 있습니다'}</div>
        <p class="small muted" style="margin-bottom:4px">받는 알림</p>
        <ul class="small">${(PUSH_TOPICS[state.user.role] || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        ${!pushSupported() ? `<div class="notice">${isIOS
          ? '아이폰은 Safari에서 공유 버튼 → 「홈 화면에 추가」 → 홈 화면의 BLACKOUT 아이콘으로 열어야 알림을 켤 수 있습니다 (iOS 16.4 이상).'
          : '이 브라우저는 알림을 지원하지 않습니다. 크롬이나 삼성 인터넷으로 열어 주세요.'}</div>` : ''}
        <div class="error" id="pushErr"></div>
        <div class="actions">${pushSupported() ? (on
          ? '<button class="btn" id="pushTest">시험 알림 보내기</button><button class="btn" id="pushOff">알림 끄기</button>'
          : '<button class="btn primary" id="pushOn">알림 켜기</button>') : ''}</div>
      </div>`;
    const bind = (id, fn) => {
      const b = document.getElementById(id);
      if (b) b.onclick = async () => { busy(b, true); try { await fn(b); } catch (e) { document.getElementById('pushErr').textContent = e.message; busy(b, false); } };
    };
    bind('pushOn', async () => { await enablePush(); toast('알림을 켰습니다.'); render(); });
    bind('pushOff', async () => { await disablePush(); toast('알림을 껐습니다.'); render(); });
    bind('pushTest', async (b) => {
      const r = await api('POST', '/api/push/test', {});
      toast(r.sent ? '시험 알림을 보냈습니다.' : '보낼 기기가 없습니다. 알림을 다시 켜 주세요.', !r.sent);
      busy(b, false);
    });
  }

  // 주문 목록 위: 아직 알림을 안 켠 휴대폰에 한 번 권하기 (「나중에」 누르면 그 기기에서는 다시 안 띄움)
  async function showPushPrompt(box) {
    try {
      if (!pushSupported() || Notification.permission === 'denied' || localStorage.getItem('pushPromptDismissed')) return;
      if (await currentPushSub()) return;
    } catch { return; }
    box.innerHTML = `<div class="notice row between"><span>새 주문 알림을 이 휴대폰으로 받으시겠어요?</span>
      <span class="row"><button class="btn primary sm" id="ppOn">알림 켜기</button><button class="btn sm" id="ppLater">나중에</button></span></div>`;
    document.getElementById('ppOn').onclick = async (e) => {
      busy(e.target, true);
      try { await enablePush(); box.innerHTML = ''; toast('알림을 켰습니다.'); } catch (err) { toast(err.message, true); busy(e.target, false); }
    };
    document.getElementById('ppLater').onclick = () => { try { localStorage.setItem('pushPromptDismissed', '1'); } catch {} box.innerHTML = ''; };
  }

  // ---------- login ----------
  function renderLogin() {
    app.innerHTML = `
      <div class="login">
        <div class="brand"><img src="/icons/logo-dark.png" alt="BLACKOUT" /></div>
        <div class="sub">${IS_VENDOR_APP ? '시공업체 주문 앱' : '관리자 · 제조공장 주문관리'}</div>
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

  window.BO = {
    state, esc, won, num, dt, nameOf, sizeOf, toast, api, formData, busy, route, go, render, reloadMeta, roleName, register, IS_VENDOR_APP,
    orderCard, specFields, shipFields, quoteHtml, bindLiveQuote, viewNewOrder, historyItem, fmtVal, FIELD_NAMES, showPushPrompt,
  };
  boot();
})();
