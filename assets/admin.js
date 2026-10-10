// Zerake admin panel for the computer (zerake.com/admin).
// Same server as the Mini App's "Requests" tab: every action goes through the admin-action function,
// which checks the staff table on the server. The page only shows what the server allows.
(function () {
  var C = window.ZERAKE || {};
  var $ = function (id) { return document.getElementById(id); };
  var sb = window.supabase.createClient(C.supabaseUrl, C.supabaseAnonKey);
  var role = null, explorer = {}, editing = 0, seenFree = null, view = 'queue';

  /* ---------- small helpers ---------- */
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function fid(v) { var d = String(v == null ? '' : v).replace(/\D/g, ''); return d.length > 4 ? d.replace(/(\d{4})(?=\d)/g, '$1-') : String(v || ''); }
  function n2(v) { return Math.floor(Number(v) * 100) / 100; }
  function when(iso) { return iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; }
  function ago(iso) {
    var m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (m < 1) return 'только что';
    if (m < 60) return m + ' мин назад';
    if (m < 1440) return Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин назад';
    return Math.floor(m / 1440) + ' дн назад';
  }
  function toast(text, bad) {
    var t = el('div', 'toast' + (bad ? ' bad' : ''), text);
    $('toasts').appendChild(t);
    var hide = function () { t.remove(); };
    t.addEventListener('click', hide); setTimeout(hide, bad ? 7000 : 3500);
  }
  function ask(text, yes) {
    $('m-text').textContent = text; $('modal').hidden = false;
    var done = function (ok) { $('modal').hidden = true; $('m-yes').onclick = $('m-no').onclick = null; if (ok) yes(); };
    $('m-yes').onclick = function () { done(true); };
    $('m-no').onclick = function () { done(false); };
  }
  function btn(text, cls, fn) {
    var b = el('button', 'btn ' + (cls || ''), text); b.type = 'button';
    b.addEventListener('click', function () { fn(b); });
    return b;
  }
  function copy(text, label) {
    var b = el('button', 'copy', label || 'Копировать'); b.type = 'button';
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      navigator.clipboard.writeText(text).then(function () { var o = b.textContent; b.textContent = 'Скопировано'; setTimeout(function () { b.textContent = o; }, 1200); });
    });
    return b;
  }
  function txLinks(net, hashes, box) {
    if (!hashes || !explorer[net]) return;
    String(hashes).split(',').forEach(function (h, i, all) {
      var a = el('a', '', 'Открыть перевод' + (all.length > 1 ? ' ' + (i + 1) : '') + ' ↗');
      a.href = explorer[net] + h.trim(); a.target = '_blank'; a.rel = 'noopener';
      box.appendChild(a); box.appendChild(document.createTextNode(' '));
    });
  }
  async function call(body) {
    var ses = (await sb.auth.getSession()).data.session;
    if (!ses) { showLogin(); return { ok: false, status: 401, data: {} }; }
    var r = await fetch(C.supabaseUrl + '/functions/v1/admin-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: C.supabaseAnonKey, Authorization: 'Bearer ' + ses.access_token },
      body: JSON.stringify(body)
    });
    var d = {}; try { d = await r.json(); } catch (e) {}
    if (r.status === 401) showLogin();
    return { ok: r.ok, status: r.status, data: d };
  }

  /* ---------- statuses ---------- */
  var ST = {
    dep: { received: 'Оплачено, фишки не выданы', chips_sent: 'Фишки выданы', below_min: 'Меньше минимума' },
    wd: { pending: 'Ждёт снятия фишек', approved: 'Фишки сняты, выплата', sending: 'Отправляется', paid: 'Выплачено', rejected: 'Отклонено' }
  };
  var SETTABLE = { dep: ['received', 'chips_sent', 'below_min'], wd: ['pending', 'paid', 'rejected'] };
  function stPill(kind, s) { return el('span', 'st s-' + s, ST[kind][s] || s); }
  var NOTE_RU = {
    'not enough USDT on the deposit addresses': 'на адресах клуба не хватает USDT',
    'not enough USDT on the deposit addresses (after the GasFree fee)': 'на адресах клуба не хватает USDT (с учётом комиссии GasFree)',
    'auto payout is off (no wallet key)': 'автовыплаты выключены: на сервере не задан ключ кошелька',
    'not enough GRAM on the club addresses': 'на адресах клуба не хватает GRAM'
  };

  /* ---------- sign in ---------- */
  function showLogin(text) {
    $('loading').hidden = true; $('panel').hidden = true; $('login').hidden = false;
    if (text) { $('login-msg').textContent = text; $('login-msg').hidden = false; }
  }
  function loadScript(src) { return new Promise(function (ok, no) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); }
  $('login-btn').addEventListener('click', async function () {
    $('login-msg').hidden = true;
    try {
      if (!window.Telegram || !window.Telegram.Login) await loadScript('https://oauth.telegram.org/js/telegram-login.js?6');
      window.Telegram.Login.auth({ client_id: C.telegramBotId, scope: ['profile'] }, async function (data) {
        if (!data || data.error || !data.id_token) return;
        try {
          var r = await fetch(C.supabaseUrl + '/functions/v1/telegram-auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: C.supabaseAnonKey, Authorization: 'Bearer ' + C.supabaseAnonKey },
            body: JSON.stringify({ id_token: data.id_token })
          });
          var d = await r.json();
          if (!r.ok || !d.token_hash) throw new Error('telegram');
          var v = await sb.auth.verifyOtp({ token_hash: d.token_hash, type: 'magiclink' });
          if (v.error) throw v.error;
          start();
        } catch (e) { showLogin('Не удалось войти через Telegram. Попробуйте ещё раз.'); }
      });
    } catch (e) { showLogin('Не удалось загрузить Telegram. Попробуйте ещё раз.'); }
  });
  $('logout').addEventListener('click', function () { sb.auth.signOut().then(function () { location.reload(); }); });

  async function start() {
    var ses = (await sb.auth.getSession()).data.session;
    if (!ses) { showLogin(); return; }
    var w = await call({ action: 'whoami' });
    if (!w.ok || !w.data.role) {
      showLogin('У этого аккаунта Telegram нет доступа к админке. Попросите владельца добавить вас в менеджеры.');
      $('login-btn').textContent = 'Войти другим аккаунтом';
      sb.auth.signOut();
      return;
    }
    role = w.data.role;
    var m = ses.user.user_metadata || {};
    $('me-name').textContent = m.username ? '@' + m.username : (m.first_name || m.full_name || '—');
    $('me-role').textContent = role === 'owner' ? 'владелец' : 'менеджер';
    document.querySelectorAll('.owner').forEach(function (b) { b.hidden = role !== 'owner'; });
    $('loading').hidden = true; $('login').hidden = true; $('panel').hidden = false;
    if (role === 'owner') { $('ops-note').hidden = false; }
    var hv = location.hash.replace('#', '');
    go(['queue', 'ops', 'unm', 'log', 'agent', 'team'].indexOf(hv) >= 0 && (role === 'owner' || ['agent', 'team', 'ops'].indexOf(hv) < 0) ? hv : 'queue');
    if (role !== 'owner') document.querySelector('[data-view="ops"]').hidden = true;
    setInterval(tick, 8000);
  }

  /* ---------- navigation ---------- */
  function go(v) {
    view = v; location.hash = v;
    document.querySelectorAll('#nav button').forEach(function (b) { b.classList.toggle('on', b.dataset.view === v); });
    document.querySelectorAll('.view').forEach(function (s) { s.hidden = s.id !== 'v-' + v; });
    load(v);
  }
  document.querySelectorAll('#nav button').forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.view); }); });
  function load(v) {
    if (v === 'queue') loadQueue();
    else if (v === 'ops') loadOps();
    else if (v === 'unm') loadUnm();
    else if (v === 'log') loadLog();
    else if (v === 'agent') loadAgent();
    else if (v === 'team') loadTeam();
  }
  function tick() {
    if (document.hidden) return;
    if (view === 'queue' || view === 'agent') load(view); else loadQueue(true);   // keep the badge fresh everywhere
  }

  /* ---------- queue ---------- */
  async function loadQueue(badgeOnly) {
    if (editing && Date.now() - editing < 120000) return;   // someone is typing in a card
    editing = 0;
    var q = await call({ action: 'queue' }), wq = await call({ action: 'wqueue' }), um = await call({ action: 'unmatched' });
    if (!q.ok || !wq.ok) return;
    explorer = q.data.explorer || explorer;
    var deps = q.data.items || [], wds = wq.data.items || [];
    var free = deps.filter(function (d) { return !d.claimed_name; }).map(function (d) { return 'd' + d.id; })
      .concat(wds.filter(function (w) { return !w.claimed_name && w.status === 'pending'; }).map(function (w) { return 'w' + w.id; }));
    var nMine = deps.filter(function (d) { return d.mine; }).length + wds.filter(function (w) { return w.mine; }).length;
    $('b-queue').textContent = free.length; $('b-queue').hidden = !free.length;
    var nu = um.ok ? (um.data.items || []).length : 0;
    $('b-unm').textContent = nu; $('b-unm').hidden = !nu;
    document.title = (free.length ? '(' + free.length + ') ' : '') + 'Zerake · Админка';
    if (seenFree && free.some(function (i) { return seenFree.indexOf(i) < 0; })) { beep(); toast('Новая заявка в очереди'); }
    seenFree = free;
    if (badgeOnly) return;
    $('n-new').textContent = free.length; $('n-mine').textContent = nMine;
    $('upd').textContent = 'обновлено ' + new Date().toLocaleTimeString('ru-RU');
    $('c-dep').textContent = deps.length ? '· ' + deps.length : ''; $('c-wd').textContent = wds.length ? '· ' + wds.length : '';
    renderDeps(deps); renderWds(wds);
  }
  function beep() {
    try {
      var a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(), g = a.createGain();
      o.frequency.value = 880; g.gain.value = 0.06; o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.18);
    } catch (e) {}
  }
  function head(kind, x, amount) {
    var top = el('div', 'qtop');
    top.appendChild(el('span', 'amt', amount));
    var r = el('span', 'muted'); r.appendChild(el('span', 'opid', x.op_id || '')); r.appendChild(document.createTextNode(' · ' + x.network)); top.appendChild(r);
    return top;
  }
  function idRow(gg) {
    var k = el('div', 'kv'); k.appendChild(el('span', 'muted', 'ClubGG ID')); k.appendChild(el('b', '', gg ? fid(gg) : '—'));
    if (gg) k.appendChild(copy(fid(gg)));
    return k;
  }
  function renderDeps(items) {
    var box = $('q-dep'); box.innerHTML = '';
    if (!items.length) { box.appendChild(el('div', 'empty', 'Пополнений в очереди нет')); return; }
    items.forEach(function (d) {
      var free = !d.claimed_name, need = d.base_amount != null ? Number(d.base_amount) : n2(d.amount);
      var c = el('div', 'card' + (d.mine ? ' mine' : !free ? ' taken' : ''));
      c.appendChild(head('dep', d, need + ' USDT'));
      c.appendChild(idRow(d.gg_id));
      c.appendChild(el('div', 'muted', 'Ждёт ' + ago(d.created_at) + (Number(d.amount) !== need ? ' · оплачено ' + n2(d.amount) : '')));
      if (!d.gg_id) c.appendChild(el('div', 'note bad', 'Игрок не указал ClubGG ID. Уточните у него до выдачи фишек.'));
      if (!free && !d.mine) c.appendChild(el('div', 'note warn', 'В работе: ' + d.claimed_name + (d.claimed_name === 'agent' ? ' (Mac)' : '')));
      var b = el('div', 'btns');
      if (free) b.appendChild(btn('Беру', 'primary', function (x) { act(x, 'claim', d.id); }));
      else if (d.mine) {
        b.appendChild(btn('Фишки выданы', 'primary', function (x) { ask('Отметить ' + need + ' USDT для ID ' + (d.gg_id ? fid(d.gg_id) : '—') + ' как выданные?', function () { act(x, 'mark_sent', d.id); }); }));
        b.appendChild(btn('Отпустить', '', function (x) { act(x, 'release', d.id); }));
      } else if (role === 'owner') b.appendChild(btn('Забрать себе', '', function (x) { act(x, 'claim', d.id); }));
      c.appendChild(b);
      var l = el('div', 'small'); txLinks(d.network, d.tx_hash, l); if (l.childNodes.length) c.appendChild(l);
      box.appendChild(c);
    });
  }
  function renderWds(items) {
    var box = $('q-wd'); box.innerHTML = '';
    if (!items.length) { box.appendChild(el('div', 'empty', 'Снятий в очереди нет')); return; }
    items.forEach(function (w) {
      var free = !w.claimed_name;
      var c = el('div', 'card wd' + (w.mine ? ' mine' : !free ? ' taken' : ''));
      c.appendChild(head('wd', w, Number(w.chips) + ' фишек'));
      c.appendChild(idRow(w.gg_id));
      c.appendChild(el('div', '', 'Игрок получит: ' + (w.coin_amount ? Number(w.coin_amount) + ' GRAM (≈ $' + Number(w.amount) + ')' : Number(w.amount) + ' USDT') + (Number(w.fee) ? ' · комиссия ' + Number(w.fee) : '')));
      var a = el('div', 'kv'); a.appendChild(el('span', 'addr', w.address)); a.appendChild(copy(w.address)); c.appendChild(a);
      c.appendChild(el('div', 'muted', 'Ждёт ' + ago(w.created_at) + ' · ' + (ST.wd[w.status] || w.status)));
      if (!free && !w.mine) c.appendChild(el('div', 'note warn', 'В работе: ' + w.claimed_name));
      var b = el('div', 'btns');
      if (w.status === 'sending') {
        var gf = w.note && w.note.indexOf('gf:') === 0;
        c.appendChild(el('div', w.note && !gf ? 'note bad' : 'note', w.note && !gf ? w.note : 'Выплата отправляется автоматически…'));
        b.appendChild(btn('Проверить статус', 'primary', function (x) { wact(x, 'wretry', w.id); }));
        if (role === 'owner') b.appendChild(btn('Проверил: выплачено', '', function () { payForm(c, w); }));
      } else if (w.status === 'approved') {
        c.appendChild(el('div', 'note bad', 'Автовыплата не прошла: ' + (w.note ? (NOTE_RU[w.note] || w.note) : 'ещё не запускалась')));
        b.appendChild(btn('Отправить выплату', 'primary', function (x) { wact(x, 'wretry', w.id); }));
        b.appendChild(btn('Выплатил вручную', '', function () { payForm(c, w); }));
      } else if (free) {
        c.appendChild(el('div', 'note', 'Снимите фишки с игрока в ClubGG, проверьте баланс и нажмите «Фишки сняты». Выплата уйдёт автоматически.'));
        b.appendChild(btn('Беру', 'primary', function (x) { wact(x, 'wclaim', w.id); }));
      } else if (w.mine) {
        b.appendChild(btn('Фишки сняты', 'primary', function () { takenForm(c, w); }));
        b.appendChild(btn('Отпустить', '', function (x) { wact(x, 'wrelease', w.id); }));
      } else if (role === 'owner') b.appendChild(btn('Забрать себе', '', function (x) { wact(x, 'wclaim', w.id); }));
      if (w.status === 'pending' && (w.mine || role === 'owner')) b.appendChild(btn('Отклонить', 'danger', function (x) { ask('Отклонить снятие ' + (w.op_id || '') + '? Фишки у игрока не трогаются.', function () { wact(x, 'wreject', w.id); }); }));
      c.appendChild(b);
      var l = el('div', 'small'); txLinks(w.network, w.tx_hash, l); if (l.childNodes.length) c.appendChild(l);
      box.appendChild(c);
    });
  }
  function takenForm(c, w) {
    editing = Date.now();
    if (c.querySelector('.inline')) { c.querySelector('.inline input').focus(); return; }
    var f = el('div', 'inline'), inp = el('input'); inp.inputMode = 'decimal'; inp.placeholder = 'Сколько фишек сняли (' + Number(w.chips) + ')';
    f.appendChild(inp);
    f.appendChild(btn('Подтвердить', 'primary', function (b) {
      b.disabled = true; b.textContent = 'Отправляю…';
      call({ action: 'wtaken', id: w.id, amount: inp.value }).then(function (r) {
        editing = 0; b.disabled = false; b.textContent = 'Подтвердить';
        if (r.ok) { var p = r.data.payout || {}; toast(p.ok ? 'Готово. Выплата отправлена автоматически.' : 'Фишки подтверждены, но автовыплата не прошла: ' + (NOTE_RU[p.reason] || p.reason || ''), !p.ok); loadQueue(); return; }
        toast(r.data && r.data.error === 'amount mismatch' ? 'Сумма не совпадает с заявкой (' + Number(w.chips) + ').' : 'Не удалось сохранить. Повторите.', true);
      });
    }));
    c.appendChild(f); inp.focus();
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') f.lastChild.click(); });
  }
  function payForm(c, w) {
    editing = Date.now();
    if (c.querySelector('.inline')) return;
    var f = el('div', 'inline'), inp = el('input'); inp.placeholder = 'Хэш перевода (необязательно)'; inp.spellcheck = false;
    f.appendChild(inp);
    f.appendChild(btn('Подтвердить: выплачено', 'primary', function (b) { wact(b, 'wpaid', w.id, { tx_hash: inp.value.trim() }); }));
    c.appendChild(f); inp.focus();
  }
  async function act(b, action, id) {
    b.disabled = true;
    var r = await call({ action: action, id: id });
    if (!r.ok) toast(r.status === 409 ? 'Это уже взял или закрыл кто-то другой.' : 'Не удалось сохранить.', true);
    editing = 0; loadQueue();
  }
  async function wact(b, action, id, extra) {
    b.disabled = true;
    var r = await call(Object.assign({ action: action, id: id }, extra || {}));
    if (!r.ok) toast(r.status === 409 ? 'Это уже взял или закрыл кто-то другой.' : 'Не удалось сохранить.', true);
    else if (r.data.payout && !r.data.payout.ok) toast('Автовыплата не прошла: ' + (NOTE_RU[r.data.payout.reason] || r.data.payout.reason || ''), true);
    editing = 0; loadQueue();
  }

  /* ---------- all operations ---------- */
  var opsKind = 'dep';
  function fillStatus() {
    var s = $('ops-status'), cur = s.value; s.innerHTML = '';
    var o = el('option', '', 'Все статусы'); o.value = ''; s.appendChild(o);
    Object.keys(ST[opsKind]).forEach(function (k) { var o = el('option', '', ST[opsKind][k]); o.value = k; s.appendChild(o); });
    if (ST[opsKind][cur]) s.value = cur;
  }
  document.querySelectorAll('#ops-kind button').forEach(function (b) {
    b.addEventListener('click', function () {
      opsKind = b.dataset.kind;
      document.querySelectorAll('#ops-kind button').forEach(function (x) { x.classList.toggle('on', x === b); });
      fillStatus(); loadOps();
    });
  });
  $('ops-status').addEventListener('change', loadOps);
  $('ops-form').addEventListener('submit', function (e) { e.preventDefault(); loadOps(); });
  fillStatus();
  async function loadOps() {
    var kind = opsKind, tb = $('ops-tbl').tBodies[0];
    var r = await call({ action: 'ops', kind: kind, status: $('ops-status').value, q: $('ops-q').value });
    tb.innerHTML = '';
    if (!r.ok) { var tr0 = el('tr'); var td0 = el('td', '', r.status === 403 ? 'Только для владельца.' : 'Не удалось загрузить.'); td0.colSpan = 7; tr0.appendChild(td0); tb.appendChild(tr0); return; }
    explorer = r.data.explorer || explorer;
    var items = r.data.items || [];
    if (!items.length) { var tr1 = el('tr'); var td1 = el('td', 'muted', 'Ничего не найдено.'); td1.colSpan = 7; tr1.appendChild(td1); tb.appendChild(tr1); return; }
    items.forEach(function (x) {
      var tr = el('tr', 'row');
      var coin = x.coin_amount ? ' · ' + Number(x.coin_amount) + ' GRAM' : '';
      var amount = kind === 'dep' ? n2(x.amount) + ' USDT' + coin : Number(x.chips != null ? x.chips : x.amount) + ' → ' + Number(x.amount) + ' USDT' + coin;
      tr.appendChild(el('td', 'nw mono', x.op_id || '#' + x.id));
      tr.appendChild(el('td', 'nw', when(x.created_at)));
      tr.appendChild(el('td', 'nw', x.gg_id ? fid(x.gg_id) : '—'));
      tr.appendChild(el('td', '', x.network));
      tr.appendChild(el('td', 'r', amount));
      var st = el('td'); st.appendChild(stPill(kind, x.status)); tr.appendChild(st);
      tr.appendChild(el('td', 'muted', x.handled_name || (x.claimed_name ? 'взял ' + x.claimed_name : '')));
      var det = null;
      tr.addEventListener('click', function () {
        if (det) { det.remove(); det = null; tr.classList.remove('open'); return; }
        det = detailRow(kind, x); tr.after(det); tr.classList.add('open');
      });
      tb.appendChild(tr);
    });
  }
  function detailRow(kind, x) {
    var tr = el('tr', 'det'), td = el('td'); td.colSpan = 7;
    var g = el('div', 'detgrid'), dl = el('dl', 'detkv');
    function kv(k, v) { if (v == null || v === '') return; dl.appendChild(el('dt', '', k)); var dd = el('dd', '', String(v)); dl.appendChild(dd); }
    kv('Статус', ST[kind][x.status] || x.status);
    kv('ClubGG ID', x.gg_id ? fid(x.gg_id) : null);
    if (kind === 'dep') { kv('Оплачено', n2(x.amount) + ' USDT' + (x.coin_amount ? ' (' + Number(x.coin_amount) + ' GRAM)' : '')); kv('От', x.from_address); kv('На адрес', x.to_address); }
    else { kv('Фишки', x.chips); kv('Выплата', Number(x.amount) + ' USDT' + (x.coin_amount ? ' (' + Number(x.coin_amount) + ' GRAM)' : '')); kv('Комиссия', Number(x.fee) ? x.fee : null); kv('Кошелёк', x.address); kv('Заметка', x.note); }
    kv('Хэш', x.tx_hash);
    kv('Создана', when(x.created_at));
    kv('Взял', x.claimed_name);
    kv('Выполнил', x.handled_name ? x.handled_name + ' · ' + when(x.handled_at) : null);
    if (x.tx_hash && explorer[x.network]) { dl.appendChild(el('dt', '', 'Перевод')); var dd = el('dd'); txLinks(x.network, x.tx_hash, dd); dl.appendChild(dd); }
    g.appendChild(dl);
    var chg = el('div', 'chg');
    chg.appendChild(el('b', '', 'Сменить статус'));
    var sel = el('select');
    SETTABLE[kind].filter(function (s) { return s !== x.status; }).forEach(function (s) { var o = el('option', '', ST[kind][s]); o.value = s; sel.appendChild(o); });
    chg.appendChild(sel);
    chg.appendChild(el('small', 'muted', 'Меняется только запись: фишки и деньги никуда не отправляются. Изменение попадёт в журнал.'));
    chg.appendChild(btn('Сменить', 'primary', function (b) {
      var to = sel.value;
      ask('Сменить статус ' + (x.op_id || '#' + x.id) + ' на «' + ST[kind][to] + '»?', async function () {
        b.disabled = true;
        var r = await call({ action: 'set_status', kind: kind, id: x.id, status: to });
        b.disabled = false;
        if (r.ok) { toast('Статус изменён.'); loadOps(); loadQueue(true); }
        else toast('Не удалось сменить статус. ' + (r.data && r.data.error ? r.data.error : ''), true);
      });
    }));
    g.appendChild(chg);
    td.appendChild(g); tr.appendChild(td);
    return tr;
  }

  /* ---------- unmatched payments ---------- */
  async function loadUnm() {
    var tb = $('unm-tbl').tBodies[0];
    var r = await call({ action: 'unmatched' });
    tb.innerHTML = '';
    var items = (r.ok && r.data.items) || [];
    if (!items.length) { var tr0 = el('tr'); var td0 = el('td', 'muted', 'Неопознанных платежей нет.'); td0.colSpan = 6; tr0.appendChild(td0); tb.appendChild(tr0); return; }
    items.forEach(function (x) {
      var tr = el('tr');
      tr.appendChild(el('td', 'nw', when(x.seen_at)));
      tr.appendChild(el('td', '', x.network));
      tr.appendChild(el('td', 'r', Number(x.amount) + (x.network === 'GRAM' ? ' GRAM' : ' USDT')));
      var a = el('td'); a.appendChild(el('span', 'addr', x.address)); tr.appendChild(a);
      var f = el('td'); f.appendChild(el('span', 'addr', x.from_address || '—')); txLinks(x.network, x.tx_hash, f); tr.appendChild(f);
      var b = el('td', 'r'); b.appendChild(btn('Разобрано', 'sm', function (bb) { bb.disabled = true; call({ action: 'resolve', id: x.id }).then(function () { loadUnm(); loadQueue(true); }); })); tr.appendChild(b);
      tb.appendChild(tr);
    });
  }

  /* ---------- log ---------- */
  var EV = {
    created: 'Создана', snapshot: 'Записана', claimed: 'Взята в работу', released: 'Отпущена', updated: 'Изменена',
    'agent proof': 'Агент: баланс проверен', 'agent failed': 'Агент не справился',
    'status:pending->approved': 'Фишки сняты', 'status:approved->sending': 'Отправка выплаты', 'status:sending->paid': 'Выплачено автоматически',
    'status:approved->paid': 'Выплачено вручную', 'status:sending->approved': 'Автовыплата не прошла', 'status:pending->rejected': 'Отклонена',
    'status:received->chips_sent': 'Фишки выданы', 'status:below_min->received': 'Засчитано вручную'
  };
  $('log-form').addEventListener('submit', function (e) { e.preventDefault(); loadLog(); });
  async function loadLog() {
    var tb = $('log-tbl').tBodies[0];
    var r = await call({ action: 'log', q: $('log-q').value });
    tb.innerHTML = '';
    var items = (r.ok && r.data.items) || [];
    if (!items.length) { var tr0 = el('tr'); var td0 = el('td', 'muted', r.ok ? 'Ничего не найдено.' : 'Не удалось загрузить.'); td0.colSpan = 6; tr0.appendChild(td0); tb.appendChild(tr0); return; }
    items.forEach(function (x) {
      var tr = el('tr', 'row');
      tr.appendChild(el('td', 'nw', new Date(x.at).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })));
      tr.appendChild(el('td', 'nw mono', x.op_id));
      tr.appendChild(el('td', '', EV[x.event] || x.event));
      tr.appendChild(el('td', 'nw', x.gg_id ? fid(x.gg_id) : ''));
      tr.appendChild(el('td', 'r', x.amount != null ? n2(x.amount) + ' USDT' : ''));
      tr.appendChild(el('td', 'muted', x.actor_name || ''));
      var det = null;
      tr.addEventListener('click', function () {
        if (det) { det.remove(); det = null; tr.classList.remove('open'); return; }
        det = el('tr', 'det'); var td = el('td'); td.colSpan = 6;
        var dl = el('dl', 'detkv'), d = x.row_data || {};
        Object.keys(d).filter(function (k) { return d[k] != null && d[k] !== '' && typeof d[k] !== 'object'; }).forEach(function (k) { dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', String(d[k]))); });
        if (x.changed) { dl.appendChild(el('dt', '', 'было')); dl.appendChild(el('dd', '', Object.keys(x.changed).filter(function (k) { return k !== 'updated_at'; }).map(function (k) { return k + ' = ' + x.changed[k]; }).join(', '))); }
        td.appendChild(dl); det.appendChild(td); tr.after(det); tr.classList.add('open');
      });
      tb.appendChild(tr);
    });
  }

  /* ---------- agent ---------- */
  async function loadAgent() {
    var r = await call({ action: 'agent' });
    if (!r.ok) { $('ag-alive').textContent = r.status === 403 ? 'Только для владельца' : 'Ошибка'; return; }
    renderAgent(r.data);
  }
  function renderAgent(d) {
    var s = d.settings || {};
    var seen = s.seen_at ? (Date.now() - new Date(s.seen_at).getTime()) / 1000 : Infinity;
    $('ag-alive').textContent = seen < 60 ? 'На связи' : seen < 600 ? 'Давно не было' : 'Нет связи';
    $('ag-alive').style.color = seen < 60 ? 'var(--green)' : seen < 600 ? 'var(--amber)' : 'var(--red)';
    $('ag-seen').textContent = s.seen_at ? 'последний запрос ' + ago(s.seen_at) : 'ни одного запроса';
    $('ag-on').textContent = s.enabled ? 'Включён' : 'Выключен';
    $('ag-on').style.color = s.enabled ? 'var(--green)' : 'var(--soft)';
    var tg = $('ag-toggle');
    tg.textContent = s.enabled ? 'Выключить' : 'Включить';
    tg.className = 'btn ' + (s.enabled ? 'danger' : 'primary');
    tg.onclick = function () {
      ask(s.enabled ? 'Выключить агента? Новые пополнения он брать не будет, их выдают менеджеры.' : 'Включить агента? Он начнёт сам выдавать фишки по оплаченным пополнениям.', async function () {
        tg.disabled = true;
        var r = await call({ action: 'agent_set', enabled: !s.enabled });
        tg.disabled = false;
        if (r.ok) { renderAgent(r.data); toast(r.data.settings && r.data.settings.enabled ? 'Агент включён.' : 'Агент выключен.'); } else toast('Не удалось.', true);
      });
    };
    var given = d.given || [], sum = given.reduce(function (a, x) { return a + Number(x.amount); }, 0);
    $('ag-sum').textContent = n2(sum) + ' USDT';
    $('ag-count').textContent = given.length + ' пополнений';
    var w = $('ag-work'); w.innerHTML = '';
    if (!(d.in_work || []).length) w.appendChild(el('div', 'empty', 'Сейчас ничего'));
    (d.in_work || []).forEach(function (x) { var c = el('div', 'card'); c.appendChild(el('b', 'mono', x.op_id)); c.appendChild(el('span', 'muted', n2(x.amount) + ' USDT · взял ' + ago(x.claimed_at))); w.appendChild(c); });
    var f = $('ag-fail'); f.innerHTML = '';
    if (!(d.failed || []).length) f.appendChild(el('div', 'empty', 'Ошибок нет'));
    (d.failed || []).forEach(function (x) { var c = el('div', 'card'); c.appendChild(el('b', 'mono', x.op_id)); c.appendChild(el('div', 'note bad', x.reason || 'без причины')); c.appendChild(el('span', 'muted', when(x.at))); f.appendChild(c); });
    var tb = $('ag-tbl').tBodies[0]; tb.innerHTML = '';
    if (!given.length) { var tr0 = el('tr'); var td0 = el('td', 'muted', 'За 24 часа агент ничего не выдавал.'); td0.colSpan = 3; tr0.appendChild(td0); tb.appendChild(tr0); }
    given.forEach(function (x) { var tr = el('tr'); tr.appendChild(el('td', 'nw', when(x.handled_at))); tr.appendChild(el('td', 'mono', x.op_id)); tr.appendChild(el('td', 'r', n2(x.amount) + ' USDT')); tb.appendChild(tr); });
  }

  /* ---------- team & wallet ---------- */
  async function loadTeam() {
    var r = await call({ action: 'staff_list' });
    var box = $('staff'); box.innerHTML = '';
    (r.ok ? r.data.items || [] : []).forEach(function (m) {
      var c = el('div', 'card'); var row = el('div', 'qtop');
      row.appendChild(el('b', '', m.username ? '@' + m.username : String(m.telegram_id)));
      row.appendChild(el('span', 'muted', m.role === 'owner' ? 'владелец' : 'менеджер'));
      c.appendChild(row);
      if (m.role !== 'owner') c.appendChild(btn('Убрать', 'danger sm', function (b) { ask('Убрать ' + (m.username ? '@' + m.username : m.telegram_id) + ' из менеджеров?', function () { b.disabled = true; call({ action: 'staff_remove', telegram_id: m.telegram_id }).then(loadTeam); }); }));
      box.appendChild(c);
    });
  }
  $('staff-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var u = $('staff-user').value.trim(); if (!u) return;
    var r = await call({ action: 'staff_add', username: u });
    if (r.ok) { toast('Менеджер добавлен.'); $('staff-user').value = ''; loadTeam(); }
    else toast(r.status === 404 ? 'Не нашли такого пользователя. Пусть он сначала откроет бота @zerakebot.' : 'Не удалось добавить.', true);
  });
  $('wallet-btn').addEventListener('click', async function () {
    var b = $('wallet-btn'); b.disabled = true; b.textContent = 'Загружаю…';
    var r = await call({ action: 'wallet' });
    var box = $('wallet'); box.innerHTML = '';
    if (!r.ok || !r.data.ready) { box.appendChild(el('div', 'note bad', 'Автовыплаты выключены: ключ кошелька не задан на сервере.')); }
    else ['TRC20', 'BEP20'].forEach(function (n) {
      var x = r.data[n] || {}, c = el('div', 'card');
      var top = el('div', 'qtop'); top.appendChild(el('span', 'amt', (x.pool_usdt != null ? Number(x.pool_usdt) : '—') + ' USDT')); top.appendChild(el('span', 'muted', n)); c.appendChild(top);
      if (x.error) c.appendChild(el('div', 'note bad', x.error));
      else { c.appendChild(el('div', 'muted', 'Кошелёк для комиссий: ' + x.gas_balance)); var a = el('div', 'kv'); a.appendChild(el('span', 'addr', x.gas_address)); a.appendChild(copy(x.gas_address)); c.appendChild(a); }
      box.appendChild(c);
    });
    var again = btn('Обновить', '', function () { box.innerHTML = ''; box.appendChild(b); b.click(); });
    b.disabled = false; b.textContent = 'Показать балансы';
    box.appendChild(again);
  });

  document.addEventListener('visibilitychange', function () { if (!document.hidden && role) load(view); });
  start();
})();
