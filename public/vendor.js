/* BLACKOUT 업체 주문 앱 - 업체 화면만 (core.js 다음에 읽힘). 관리자·공장 화면 코드는 이 앱에 없다 */
(() => {
  'use strict';
  const { state, esc, won, dt, nameOf, sizeOf, toast, api, formData, busy, go, render, orderCard, specFields, shipFields, bindLiveQuote, viewNewOrder, historyItem, showPushPrompt } = window.BO;

  const NAV = { vendor: [['/orders', '내 주문'], ['/orders/new', '새 주문']] };
  const TABS = [
    ['', '전체'], ['received,on_hold', '접수'], ['approved,in_production', '제작 중'], ['shipped', '배송 중'], ['delivered', '완료'], ['cancelled', '취소'],
  ];

  async function viewOrders(main, r) {
    const status = r.query.status ?? '';
    const q = r.query.q || '';
    main.innerHTML = `
      <div class="row between">
        <h1>내 주문</h1>
        <a class="btn primary sm" href="#/orders/new">+ 새 주문</a>
      </div>
      <div id="pushPrompt"></div>
      <div class="tabs">${TABS.map(([s, l]) => `<button data-status="${s}" class="${s === status ? 'active' : ''}">${l}</button>`).join('')}</div>
      <form class="filters" id="filterForm">
        <input type="text" name="q" placeholder="주문번호 · 수령인 · 송장번호" value="${esc(q)}" />
        <button class="btn sm" type="submit">검색</button>
      </form>
      <div id="list"><div class="empty">불러오는 중…</div></div>`;
    main.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => go(`/orders?${new URLSearchParams({ status: b.dataset.status, q })}`)));
    document.getElementById('filterForm').onsubmit = (e) => {
      e.preventDefault();
      go(`/orders?${new URLSearchParams({ status, q: formData(e.target).q || '' })}`);
    };
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (q) params.set('q', q);
    showPushPrompt(document.getElementById('pushPrompt'));
    try {
      const { orders } = await api('GET', `/api/orders?${params}`);
      const list = document.getElementById('list');
      if (!orders.length) { list.innerHTML = '<div class="empty">주문이 없습니다.</div>'; return; }
      list.innerHTML = orders.map((o) => orderCard(o, 'vendor')).join('');
    } catch (err) { document.getElementById('list').innerHTML = `<div class="error">${esc(err.message)}</div>`; }
  }

  async function viewOrderDetail(main, id) {
    main.innerHTML = '<div class="empty">불러오는 중…</div>';
    let data;
    try { data = await api('GET', `/api/orders/${id}`); }
    catch (err) { main.innerHTML = `<div class="error">${esc(err.message)}</div><a class="btn" href="#/orders">목록으로</a>`; return; }
    const { order: o, history, allowed_transitions } = data;
    const m = state.meta;
    const canEdit = ['received', 'on_hold'].includes(o.status);

    main.innerHTML = `
      <div class="row between"><a href="#/orders" class="muted small">← 목록</a></div>
      <div class="row between"><h1 style="margin:8px 0">${esc(o.order_no)}</h1><span class="chip ${o.status}">${esc(o.status_name)}</span></div>

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
          <dt>택배사 / 송장</dt><dd>${o.tracking_no ? `${esc(o.tracking_carrier)} <strong>${esc(o.tracking_no)}</strong>` : o.status === 'shipped' ? `${esc(o.tracking_carrier || '')} <span class="muted">송장번호 등록 중</span>` : '<span class="muted">미등록</span>'}</dd>
        </dl>
      </div>

      <div class="card">
        <h3>주문 금액</h3>
        <dl class="kv">
          <dt>적용 단가</dt><dd>${won(o.unit_price)}/㎡ · 과금 면적 ${o.billed_area_sqm}㎡</dd>
          <dt>제품금액</dt><dd>${won(o.product_amount)}</dd>
          ${o.surcharge ? `<dt>유형 추가금</dt><dd>${won(o.surcharge)}</dd>` : ''}
          <dt>택배비</dt><dd>${won(o.shipping_fee)}</dd>
          <dt>최종 금액</dt><dd><strong>${won(o.total_amount)}</strong></dd>
        </dl>
      </div>

      <div class="card">
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

      ${canEdit ? `<div class="card"><div class="row between"><h3>주문 내용 수정</h3><button class="btn sm" id="editToggle">수정</button></div><div id="editArea"></div></div>` : ''}

      <div class="card">
        <h3>변경 이력</h3>
        <ul class="timeline">${history.map(historyItem).join('') || '<li class="muted">이력이 없습니다.</li>'}</ul>
      </div>`;

    renderActions(document.getElementById('actionArea'), o, allowed_transitions);

    if (canEdit) {
      const area = document.getElementById('editArea');
      document.getElementById('editToggle').onclick = () => {
        if (area.innerHTML) { area.innerHTML = ''; return; }
        area.innerHTML = `
          <form id="editForm">
            ${specFields(m, o)}
            <div class="quote" id="editQuote"></div>
            ${shipFields(o)}
            <label class="f"><span>변경 사유</span><input type="text" name="note" placeholder="예: 현장 실측 반영" /></label>
            <div class="error" id="editErr"></div>
            <div class="actions"><button class="btn primary" type="submit">수정 저장</button></div>
          </form>`;
        const form = document.getElementById('editForm');
        bindLiveQuote(form, document.getElementById('editQuote'), 'vendor');
        form.onsubmit = async (e) => {
          e.preventDefault();
          try { await api('PATCH', `/api/orders/${o.id}`, formData(form)); toast('주문을 수정했습니다.'); render(); }
          catch (err) { document.getElementById('editErr').textContent = err.message; }
        };
      };
    }
  }

  // 업체가 할 수 있는 일: 접수·보류 중 취소, 출고된 주문 배송 완료 처리
  function renderActions(area, o, transitions) {
    if (!transitions.length) { area.innerHTML = ''; return; }
    const btnClass = { delivered: 'ok', cancelled: 'danger' };
    const btnLabel = { delivered: '배송 완료 처리', cancelled: '주문 취소' };
    area.innerHTML = `
      <div class="actions">${transitions.map((t) => `<button class="btn ${btnClass[t.code] || ''}" data-to="${t.code}">${btnLabel[t.code] || t.name}</button>`).join('')}</div>
      <div id="actionForm"></div>`;
    area.querySelectorAll('button[data-to]').forEach((b) => (b.onclick = () => showActionForm(o, b.dataset.to)));
  }

  function showActionForm(o, to) {
    const box = document.getElementById('actionForm');
    const needReason = to === 'cancelled';
    box.innerHTML = `
      <form id="statusForm" class="card" style="margin-top:10px">
        <h3>${esc((state.meta.statuses.find((s) => s.code === to) || {}).name)}</h3>
        <label class="f"><span>메모 ${needReason ? '(사유)' : '(선택)'}</span><input type="text" name="note" ${needReason ? 'required' : ''} /></label>
        ${needReason ? '<div class="notice">취소 후에는 되돌릴 수 없습니다.</div>' : ''}
        <div class="error" id="statusErr"></div>
        <div class="actions"><button class="btn primary" type="submit">확인</button><button class="btn" type="button" id="cancelAction">닫기</button></div>
      </form>`;
    document.getElementById('cancelAction').onclick = () => (box.innerHTML = '');
    document.getElementById('statusForm').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      busy(btn, true);
      try {
        await api('POST', `/api/orders/${o.id}/status`, { ...formData(e.target), status: to });
        toast('처리되었습니다.');
        render();
      } catch (err) { document.getElementById('statusErr').textContent = err.message; busy(btn, false); }
    };
  }

  window.BO.register({
    roles: ['vendor'],
    nav: NAV,
    dispatch(main, r, p) {
      if (p[0] === 'orders' && p[1] === 'new') return viewNewOrder(main, r);
      if (p[0] === 'orders' && p[1]) return viewOrderDetail(main, Number(p[1]));
      return viewOrders(main, r);
    },
  });
})();
