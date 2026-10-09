// Zerake Telegram Mini App: deposit, withdraw, history.
(function () {
  var C = window.ZERAKE || {};
  var MIN_DEPOSIT = C.minDeposit || 10;
  var MIN_WITHDRAW = C.minWithdraw || 10;
  var ADDR_RE = { TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, BEP20: /^0x[0-9a-fA-F]{40}$/, TON: /^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$/ };
  var PLACEHOLDER = { TRC20: 'T...', BEP20: '0x...', TON: 'UQ...' };
  var ADDR_HINT = {
    TRC20: ['Enter a valid TRC20 address (starts with T).', 'Введите корректный адрес TRC20 (начинается с T).'],
    BEP20: ['Enter a valid BEP20 address (starts with 0x).', 'Введите корректный адрес BEP20 (начинается с 0x).'],
    TON: ['Enter a valid TON address (starts with UQ or EQ).', 'Введите корректный адрес TON (начинается с UQ или EQ).']
  };
  var WD_FEE = { TRC20: [3, 1], BEP20: [0, 0], TON: [0, 0] };   // fixed USDT, percent (the server decides; this is a preview)
  function wdFee(n, chips) { var f = WD_FEE[n] || [0, 0]; return Math.ceil(Math.round((f[0] + chips * f[1] / 100) * 1e6) / 1e4) / 100; }
  var net = 'TRC20';
  var tg = window.Telegram && window.Telegram.WebApp;
  var $ = function (id) { return document.getElementById(id); };
  var sb = null, me = null, ggId = '';

  function bi(en, ru) { return '<span class="en">' + en + '</span><span class="ru">' + ru + '</span>'; }
  function fid(v) { var d = String(v == null ? '' : v).replace(/\D/g, ''); return d.length > 4 ? d.replace(/(\d{4})(?=\d)/g, '$1-') : String(v || ''); }
  function t(en, ru) { return document.body.dataset.lang === 'ru' ? ru : en; }

  /* ---------- language ---------- */
  function setLang(l) {
    document.body.dataset.lang = l;
    document.documentElement.lang = l;
    $('lang').textContent = l === 'en' ? 'RU' : 'EN';
    try { localStorage.setItem('zerake-lang', l); } catch (e) {}
  }
  (function initLang() {
    var saved = null;
    try { saved = localStorage.getItem('zerake-lang'); } catch (e) {}
    var code = tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.language_code;
    setLang(saved || (code && code.indexOf('ru') === 0 ? 'ru' : 'en'));
    $('lang').addEventListener('click', function () { setLang(document.body.dataset.lang === 'en' ? 'ru' : 'en'); renderHistory(); });
  })();

  /* ---------- splash ---------- */
  function splashError(en, ru) {
    var s = $('splash'); s.classList.add('err'); s.hidden = false;
    $('splash-msg').textContent = t(en, ru);
  }
  $('splash-msg').textContent = t('Loading…', 'Загрузка…');

  /* ---------- starry sky ---------- */
  (function stars() {
    var cv = $('stars'), ctx = cv.getContext('2d'), W, H, st = [];
    function size() {
      var d = window.devicePixelRatio || 1; W = innerWidth; H = innerHeight;
      cv.width = W * d; cv.height = H * d; ctx.setTransform(d, 0, 0, d, 0, 0);
      st = Array.from({ length: Math.round(W * H / 9000) }, function () {
        return { x: Math.random() * W, y: Math.random() * H, r: .5 + Math.random() * .8, a: .15 + Math.random() * .5, s: .0005 + Math.random() * .0015, p: Math.random() * 6.28 };
      });
    }
    function draw(ts) {
      ctx.clearRect(0, 0, W, H);
      st.forEach(function (o) { ctx.globalAlpha = o.a * (.55 + .45 * Math.sin(ts * o.s + o.p)); ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, 6.2832); ctx.fillStyle = '#fff'; ctx.fill(); });
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) requestAnimationFrame(draw);
    }
    addEventListener('resize', size); size(); requestAnimationFrame(draw);
  })();

  /* ---------- Telegram chrome ---------- */
  if (tg) {
    try { tg.ready(); tg.expand(); tg.setHeaderColor('#141414'); tg.setBackgroundColor('#141414'); } catch (e) {}
  }
  function haptic(kind) { try { tg.HapticFeedback.notificationOccurred(kind); } catch (e) {} }

  /* ---------- tabs ---------- */
  function showTab(name) {
    document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === name); });
    ['deposit', 'withdraw', 'history', 'admin'].forEach(function (n) { $('tab-' + n).hidden = n !== name; });
    $('nets').hidden = name === 'history' || name === 'admin';
    if (name === 'history') loadHistory();
    if (name === 'admin') loadAdmin(true);
  }
  document.querySelectorAll('.tabs button').forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab); }); });

  /* ---------- guards ---------- */
  if (!tg || !tg.initData) { splashError('Open this page from the Zerake bot in Telegram.', 'Откройте эту страницу из бота Zerake в Telegram.'); return; }
  if (!C.supabaseUrl || !C.supabaseAnonKey || !window.supabase) { splashError('The service is not available right now.', 'Сервис сейчас недоступен.'); return; }
  sb = window.supabase.createClient(C.supabaseUrl, C.supabaseAnonKey);

  /* ---------- sign in with Telegram initData ---------- */
  async function signIn() {
    var r = await fetch(C.supabaseUrl + '/functions/v1/tg-webapp-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: C.supabaseAnonKey, Authorization: 'Bearer ' + C.supabaseAnonKey },
      body: JSON.stringify({ init_data: tg.initData })
    });
    var d = await r.json();
    if (!r.ok || !d.token_hash) throw new Error(d.error || 'auth');
    var v = await sb.auth.verifyOtp({ token_hash: d.token_hash, type: 'magiclink' });
    if (v.error) throw v.error;
    return v.data.session.user;
  }

  /* ---------- data ---------- */
  async function loadProfile() {
    var r = await sb.from('profiles').select('gg_id').eq('user_id', me.id).maybeSingle();
    ggId = (r.data && r.data.gg_id) || '';
    $('dep-id2').textContent = $('wd-id').textContent = ggId ? fid(ggId) : '—';
    $('noid').hidden = !!ggId;
    $('wsubmit').disabled = !ggId;
  }
  function loadAddress() { return loadOpenRequest(); }

  function applyNet() {
    document.body.dataset.net = net;
    document.querySelectorAll('#nets button').forEach(function (b) { b.classList.toggle('on', b.dataset.net === net); });
    document.querySelectorAll('.netname').forEach(function (e) { e.textContent = net; });
    $('req-net').textContent = 'USDT · ' + net;
    $('waddr').placeholder = PLACEHOLDER[net];
    $('waddr').value = '';
    $('wmsg').hidden = true;
    feePreview();
  }
  document.querySelectorAll('#nets button').forEach(function (b) {
    b.addEventListener('click', function () { net = b.dataset.net; applyNet(); loadAddress(); });
  });

  var rows = [];
  async function loadHistory() {
    var d = await sb.from('deposits').select('id,op_id,amount,status,network,created_at').eq('user_id', me.id).order('created_at', { ascending: false }).limit(30);
    var w = await sb.from('withdrawals').select('id,op_id,amount,chips,status,network,created_at').eq('user_id', me.id).order('created_at', { ascending: false }).limit(30);
    rows = []
      .concat((d.data || []).map(function (x) { x.kind = 'dep'; return x; }))
      .concat((w.data || []).map(function (x) { x.kind = 'wd'; return x; }))
      .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
    renderHistory();
  }
  var LABEL = {
    received: ['Received, chips on the way', 'Получено, фишки в пути'], chips_sent: ['Chips sent', 'Фишки отправлены'],
    pending: ['Pending', 'В обработке'], approved: ['Chips taken, payout on the way', 'Фишки сняты, выплата в пути'], sending: ['Sending USDT…', 'Отправляем USDT…'], paid: ['Paid', 'Выплачено'], rejected: ['Rejected', 'Отклонено']
  };
  function renderHistory() {
    var box = $('hist'); if (!box) return;
    box.innerHTML = '';
    if (!rows.length) { var e = document.createElement('div'); e.className = 'empty'; e.innerHTML = bi('Nothing here yet.', 'Пока пусто.'); box.appendChild(e); return; }
    rows.forEach(function (x) {
      var el = document.createElement('div'); el.className = 'item';
      var ic = document.createElement('div'); ic.className = 'ic' + (x.kind === 'dep' ? '' : ' out');
      ic.innerHTML = x.kind === 'dep' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
      el.appendChild(ic);
      var left = document.createElement('div');
      var title = document.createElement('div'); title.innerHTML = x.kind === 'dep' ? bi('Deposit', 'Депозит') : bi('Withdrawal', 'Вывод');
      var date = document.createElement('small'); date.textContent = new Date(x.created_at).toLocaleString(document.body.dataset.lang === 'ru' ? 'ru-RU' : 'en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' · ' + (x.network || 'TRC20');
      left.appendChild(title); left.appendChild(date);
      if (x.op_id) { var oid = document.createElement('small'); oid.className = 'opid'; oid.textContent = x.op_id; oid.title = t('Tap to copy', 'Нажмите, чтобы скопировать'); oid.addEventListener('click', function () { if (navigator.clipboard) navigator.clipboard.writeText(x.op_id).then(function () { haptic('success'); oid.textContent = t('Copied', 'Скопировано'); setTimeout(function () { oid.textContent = x.op_id; }, 1200); }); }); left.appendChild(oid); }
      var right = document.createElement('div');
      var amt = document.createElement('div'); amt.className = 'amt'; amt.textContent = (x.kind === 'dep' ? '+' : '−') + Number(x.kind === 'wd' && x.chips != null ? x.chips : x.amount) + (x.kind === 'wd' && x.chips != null && Number(x.chips) !== Number(x.amount) ? ' → ' + Number(x.amount) + ' USDT' : ' USDT');
      var st = document.createElement('div'); st.className = 'st' + (x.status === 'chips_sent' || x.status === 'paid' ? ' ok' : '');
      var lb = LABEL[x.status] || [x.status, x.status]; st.innerHTML = bi(lb[0], lb[1]);
      right.appendChild(amt); right.appendChild(st);
      el.appendChild(left); el.appendChild(right); box.appendChild(el);
    });
  }

  /* ---------- actions ---------- */
  $('open-site').addEventListener('click', function () { try { tg.openLink('https://zerake.com/'); } catch (e) { window.open('https://zerake.com/', '_blank'); } });

  function wmsg(en, ru, bad) {
    var m = $('wmsg'); m.innerHTML = bi(en, ru); m.className = 'note' + (bad ? ' bad' : ''); m.hidden = false;
  }
  function feePreview() {
    var box = $('wfee'); if (!box) return;
    var chips = Number(String($('wamt').value).replace(',', '.'));
    var f = WD_FEE[net] || [0, 0];
    var rule = f[0] || f[1] ? (f[0] ? f[0] + ' USDT' : '') + (f[0] && f[1] ? ' + ' : '') + (f[1] ? f[1] + '%' : '') : t('no fee', 'без комиссии');
    var fee = chips > 0 ? wdFee(net, chips) : 0, get = chips > 0 ? Math.max(0, Math.round((chips - fee) * 100) / 100) : 0;
    box.innerHTML =
      '<div class="row"><span>' + bi('Chips', 'Фишки') + '</span><span>' + (chips > 0 ? chips : '—') + '</span></div>' +
      '<div class="row"><span>' + bi('Network fee', 'Комиссия сети') + ' · ' + rule + '</span><span>' + (chips > 0 ? (fee ? '−' + fee : '0') : '—') + '</span></div>' +
      '<div class="row total"><span>' + bi('You get', 'Вы получите') + '</span><b>' + (chips > 0 ? get + ' USDT' : '—') + '</b></div>';
  }
  $('wamt').addEventListener('input', feePreview);
  $('wform').addEventListener('submit', async function (e) {
    e.preventDefault();
    var amount = Number(String($('wamt').value).replace(',', '.'));
    var address = $('waddr').value.trim();
    if (!ggId) { wmsg('Add your ClubGG ID first.', 'Сначала добавьте ID в ClubGG.', true); return; }
    if (!(amount >= MIN_WITHDRAW)) { wmsg('Minimum withdrawal is ' + MIN_WITHDRAW + ' USDT.', 'Минимальный вывод: ' + MIN_WITHDRAW + ' USDT.', true); return; }
    if (!ADDR_RE[net].test(address)) { wmsg(ADDR_HINT[net][0], ADDR_HINT[net][1], true); return; }
    $('wsubmit').disabled = true;
    var ses = (await sb.auth.getSession()).data.session;
    var res = await fetch(C.supabaseUrl + '/functions/v1/create-withdrawal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: C.supabaseAnonKey, Authorization: 'Bearer ' + ses.access_token },
      body: JSON.stringify({ network: net, address: address, amount: $('wamt').value })
    });
    var rd = {}; try { rd = await res.json(); } catch (x) {}
    $('wsubmit').disabled = false;
    if (!res.ok) {
      haptic('error');
      if (rd.error === 'below minimum') wmsg('Minimum withdrawal is ' + rd.min + ' USDT.', 'Минимальный вывод: ' + rd.min + ' USDT.', true);
      else if (rd.error === 'too many pending') wmsg('You already have 3 requests waiting. Please wait for them to be paid.', 'У вас уже 3 запроса в ожидании. Дождитесь их выплаты.', true);
      else if (rd.error === 'below fee') wmsg('The amount is too small to cover the fee (' + rd.fee + ' USDT).', 'Сумма слишком мала, чтобы покрыть комиссию (' + rd.fee + ' USDT).', true);
      else if (rd.error === 'bad address') wmsg(ADDR_HINT[net][0], ADDR_HINT[net][1], true);
      else if (rd.error === 'no clubgg id') wmsg('Add your ClubGG ID first.', 'Сначала добавьте ID в ClubGG.', true);
      else if (rd.error === 'bad amount') wmsg('Enter the amount with at most 2 decimals, for example 50 or 50.25.', 'Введите сумму не более чем с 2 знаками после точки, например 50 или 50.25.', true);
      else if (rd.error === 'above maximum') wmsg('Maximum withdrawal is ' + rd.max + ' USDT.', 'Максимальный вывод: ' + rd.max + ' USDT.', true);
      else if (rd.error === 'network disabled') wmsg('This network is not available yet.', 'Эта сеть пока недоступна.', true);
      else wmsg('Could not send the request (' + (rd.error || res.status) + '). Please try again.', 'Не удалось отправить запрос (' + (rd.error || res.status) + '). Попробуйте ещё раз.', true);
      return;
    }
    haptic('success');
    wmsg('Request ' + (rd.op_id || '') + ' sent. A manager will take the chips from your ClubGG ID and you will get ' + rd.payout + ' USDT.', 'Заявка ' + (rd.op_id || '') + ' отправлена. Менеджер снимет фишки с вашего ID, вы получите ' + rd.payout + ' USDT.', false);
    $('wamt').value = ''; $('waddr').value = '';
  });

  /* ---------- TRC20 deposit request ---------- */
  var curReq = null, tick = null, poll = null;
  function reqErr(en, ru) { var m = $('reqmsg'); m.innerHTML = bi(en, ru); m.className = 'note bad'; m.hidden = false; }
  async function callReq(body) {
    var ses = (await sb.auth.getSession()).data.session;
    var r = await fetch(C.supabaseUrl + '/functions/v1/create-deposit-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: C.supabaseAnonKey, Authorization: 'Bearer ' + ses.access_token },
      body: JSON.stringify(Object.assign({ network: net }, body))
    });
    var d = {}; try { d = await r.json(); } catch (e) {}
    return { ok: r.ok, data: d };
  }
  function fmt(ms) { if (ms < 0) ms = 0; var s = Math.floor(ms / 1000); return ('0' + Math.floor(s / 60)).slice(-2) + ':' + ('0' + (s % 60)).slice(-2); }
  function stopReqTimers() { clearInterval(tick); clearInterval(poll); tick = poll = null; }
  function renderQr(text) {
    var box = $('rv-qr'); box.innerHTML = '';
    try { var q = window.qrcode(0, 'M'); q.addData(text); q.make(); box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); } catch (e) {}
  }
  function setReqStatus(kind) {
    var m = $('rv-status');
    if (kind === 'paid') { m.className = 'note'; m.innerHTML = bi('Payment received. Chips will be sent to your ClubGG ID.', 'Платёж получен. Фишки будут отправлены на ваш ID в ClubGG.'); }
    else if (kind === 'expired') { m.className = 'note bad'; m.innerHTML = bi('The request has expired. If you already paid, we will still find the payment. Otherwise create a new request.', 'Срок заявки истёк. Если вы уже заплатили, мы всё равно найдём платёж. Иначе создайте новую заявку.'); }
    else { m.className = 'note'; m.innerHTML = bi('Waiting for your payment…', 'Ждём ваш платёж…'); }
  }
  function setState(st) {
    var tab = $('tab-deposit');
    tab.classList.remove('st-form', 'st-open', 'st-paid');
    tab.classList.add('st-' + st);
    document.body.classList.toggle('paid-view', st === 'paid');
  }
  function showPaid(st) {
    var first = !curReq.paid;
    curReq.paid = true; curReq.sent = st === 'chips_sent';
    $('req-view').hidden = false; $('reqform').hidden = true;
    $('req-view').classList.add('paid');
    setState('paid');
    if (curReq.sent) {
      $('rv-paid-title').innerHTML = bi('Chips sent', 'Фишки отправлены');
      $('rv-paid-sub').innerHTML = bi('Good luck at the tables!', 'Удачной игры!');
    } else {
      $('rv-paid-title').innerHTML = bi('Payment received', 'Платёж получен');
      $('rv-paid-sub').innerHTML = bi('Please wait. A manager is sending the chips to your ClubGG ID ', 'Ожидайте. Менеджер отправляет фишки на ваш ID в ClubGG ') + '<b>' + (ggId ? fid(ggId) : '—') + '</b>';
    }
    if (first) haptic('success');
    if (curReq.sent) stopReqTimers();
  }
  async function refreshPaid() {
    if (!curReq) return;
    var rq = await sb.from('deposit_requests').select('status,tx_hash').eq('request_no', curReq.request_no).maybeSingle();
    if (!rq.data || rq.data.status !== 'paid') return;
    var dp = await sb.from('deposits').select('status').eq('tx_hash', rq.data.tx_hash).maybeSingle();
    showPaid(dp.data ? dp.data.status : 'received');
  }
  async function checkPaid() { await refreshPaid(); }
  function showRequest(r) {
    stopReqTimers(); curReq = r;
    $('req-view').classList.remove('paid');
    setState('open');
    $('reqform').hidden = true; $('req-view').hidden = false;
    $('rv-no').textContent = r.request_no; $('rv-addr').textContent = r.address; $('rv-amt').textContent = r.amount;
    renderQr(r.address); setReqStatus('wait');
    var end = new Date(r.expires_at).getTime();
    function paint() {
      var left = end - Date.now();
      $('rv-timer').textContent = fmt(left);
      var bar = $('rv-bar'); if (bar) { bar.style.width = Math.max(0, Math.min(100, left / (30 * 60000) * 100)) + '%'; bar.style.background = left < 5 * 60000 ? 'var(--amber)' : ''; }
      if (left <= 0 && curReq && curReq.request_no === r.request_no && !curReq.paid) setReqStatus('expired');
    }
    paint(); tick = setInterval(paint, 1000); poll = setInterval(checkPaid, 8000);
  }
  var reqCache = {}, recentPaid = {};
  async function fetchOpen(n) {
    var r = await callReq({ check: true, network: n });
    var rq = (r.ok && r.data.request) || null;
    reqCache[n] = rq;
    if (!rq && !(n in recentPaid)) {
      // the player's last request was paid recently: keep showing how far it has got
      var lr = await sb.from('deposit_requests').select('request_no,address,amount,base_amount,expires_at,status').eq('user_id', me.id).eq('network', n).order('created_at', { ascending: false }).limit(1).maybeSingle();
      recentPaid[n] = lr.data && lr.data.status === 'paid' && Date.now() - new Date(lr.data.expires_at).getTime() < 24 * 3600 * 1000 ? lr.data : null;
    }
    return rq;
  }
  function renderOpen(n) {
    if (n !== net) return;
    var rq = reqCache[n];
    if (rq) { if (!curReq || curReq.request_no !== rq.request_no || $('req-view').hidden) showRequest(rq); return; }
    if (curReq && recentPaid[n] && curReq.request_no === recentPaid[n].request_no) return;
    stopReqTimers(); curReq = null; $('req-view').hidden = true; $('reqform').hidden = false; setState('form');
    if (recentPaid[n]) { curReq = recentPaid[n]; poll = setInterval(checkPaid, 8000); refreshPaid(); }
  }
  async function loadOpenRequest() {
    $('reqmsg').hidden = true;
    var n = net;
    if (n in reqCache) renderOpen(n);             // instant, from what we already know
    else { stopReqTimers(); curReq = null; $('req-view').hidden = true; $('reqform').hidden = false; setState('form'); }
    try { await fetchOpen(n); } catch (e) { return; }
    renderOpen(n);
  }
  function prefetchNets() { ['TRC20', 'BEP20', 'TON'].forEach(function (n) { if (n !== net) fetchOpen(n).catch(function () {}); }); }
  document.querySelectorAll('[data-quick]').forEach(function (b) {
    b.addEventListener('click', function () { $('reqamt').value = b.dataset.quick; try { tg.HapticFeedback.selectionChanged(); } catch (e) {} });
  });
  $('reqform').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!ggId) { reqErr('Add your ClubGG ID first.', 'Сначала добавьте ID в ClubGG.'); return; }
    $('reqmsg').hidden = true; $('reqbtn').disabled = true;
    var r = await callReq({ amount: $('reqamt').value, fresh: true });
    $('reqbtn').disabled = false;
    if (r.ok && r.data.request) { reqCache[net] = r.data.request; showRequest(r.data.request); return; }
    var er = r.data && r.data.error;
    if (er === 'network disabled') reqErr('This network is not available yet.', 'Эта сеть пока недоступна.');
    else if (er === 'below minimum') reqErr('Minimum deposit is ' + r.data.min + ' USDT.', 'Минимальный депозит: ' + r.data.min + ' USDT.');
    else if (er === 'above maximum') reqErr('Maximum deposit is ' + r.data.max + ' USDT.', 'Максимальный депозит: ' + r.data.max + ' USDT.');
    else if (er === 'bad amount') reqErr('Enter a valid amount, for example 50.', 'Введите корректную сумму, например 50.');
    else reqErr('Could not create the request. Please try again.', 'Не удалось создать заявку. Попробуйте ещё раз.');
  });
  function backToForm() { reqCache[net] = null; recentPaid[net] = null; stopReqTimers(); curReq = null; $('req-view').hidden = true; $('reqform').hidden = false; setState('form'); }
  $('rv-cancel').addEventListener('click', function () {
    var b = $('rv-cancel');
    ask('Cancel this request? If you have already sent the money, do not cancel: we will find the payment.', 'Отменить заявку? Если вы уже отправили деньги, не отменяйте: мы найдём платёж.', async function () {
      b.disabled = true;
      var r = await callReq({ cancel: true });
      b.disabled = false;
      if (r.ok) { haptic('success'); backToForm(); } else { haptic('error'); reqErr('Could not cancel. Please try again.', 'Не удалось отменить. Попробуйте ещё раз.'); }
    });
  });
  $('rv-new').addEventListener('click', function () { reqCache[net] = null; recentPaid[net] = null; stopReqTimers(); curReq = null; $('req-view').hidden = true; $('reqform').hidden = false; setState('form'); });
  document.querySelectorAll('[data-copy-from]').forEach(function (b) {
    b.addEventListener('click', function () {
      var txt = $(b.dataset.copyFrom).textContent; if (!txt || txt === '—') return;
      var done = function () { haptic('success'); var o = b.innerHTML; b.innerHTML = bi('Copied', 'Скопировано'); setTimeout(function () { b.innerHTML = o; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(done, function () {});
    });
  });

  /* ---------- manager panel (staff only; every action is checked again on the server) ---------- */
  var staffRole = null, admTimer = null, seenNew = null, admData = { explorer: {} };
  async function adminCall(body) {
    var ses = (await sb.auth.getSession()).data.session;
    var r = await fetch(C.supabaseUrl + '/functions/v1/admin-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: C.supabaseAnonKey, Authorization: 'Bearer ' + ses.access_token },
      body: JSON.stringify(body)
    });
    var d = {}; try { d = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, data: d };
  }
  function ago(iso) {
    var m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (m < 1) return t('just now', 'только что');
    if (m < 60) return m + t(' min ago', ' мин назад');
    return Math.floor(m / 60) + t(' h ago', ' ч назад');
  }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function btn(cls, html, fn) { var b = el('button', 'btn ' + cls, html); b.type = 'button'; b.addEventListener('click', function () { b.disabled = true; fn(b); }); return b; }
  function copyChip(text) {
    var b = el('button', 'chip', bi('Copy', 'Копировать')); b.type = 'button';
    b.addEventListener('click', function () {
      var done = function () { haptic('success'); var o = b.innerHTML; b.innerHTML = bi('Copied', 'Скопировано'); setTimeout(function () { b.innerHTML = o; }, 1400); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
    });
    return b;
  }
  function ask(en, ru, yes) {
    var msg = t(en, ru);
    var no = function () { if (staffRole) loadAdmin(false); };
    if (tg && tg.showConfirm) tg.showConfirm(msg, function (ok) { if (ok) yes(); else no(); });
    else if (window.confirm(msg)) yes(); else no();
  }
  async function act(action, id) {
    var r = await adminCall({ action: action, id: id });
    if (!r.ok && r.status === 409) { haptic('error'); try { tg.showAlert(t('Someone else already took or finished this one.', 'Эту заявку уже взял или закрыл кто-то другой.')); } catch (e) {} }
    else if (r.ok) haptic('success');
    loadAdmin(false);
  }
  function renderQueue(items, wres) {
    var box = $('adm-queue'); box.innerHTML = '';
    var nNew = 0, nMine = 0;
    if (!items.length) { box.appendChild(el('div', 'empty', bi('No deposits are waiting. Well done.', 'Заявок на депозит нет. Всё выполнено.'))); }
    items.forEach(function (d) {
      var free = !d.claimed_name, mine = d.mine;
      if (free) nNew++;
      if (mine) nMine++;
      var need = d.base_amount != null ? Number(d.base_amount) : Number(d.amount);
      var card = el('div', 'tcard' + (mine ? ' mine' : (!free ? ' taken' : '')));
      card.appendChild(el('div', 'tkind', bi('Deposit', 'Депозит') + (d.op_id ? ' · <span class="opid">' + d.op_id + '</span>' : '')));
      var top = el('div', 'trow'); top.appendChild(el('div', 'tamt', need + ' USDT')); top.appendChild(el('div', 'tnet', d.network)); card.appendChild(top);
      var idr = el('div', 'tid'); idr.appendChild(el('div', '', '<span class="muted">' + bi('ClubGG ID', 'ID в ClubGG') + '</span> <b>' + (d.gg_id ? fid(d.gg_id) : '—') + '</b>'));
      if (d.gg_id) idr.appendChild(copyChip(fid(d.gg_id)));
      card.appendChild(idr);
      var meta = el('div', 'tmeta');
      meta.innerHTML = bi('Waiting ', 'Ждёт ') + ago(d.created_at) + (Number(d.amount) !== need ? ' · ' + bi('paid ', 'оплачено ') + d.amount : '');
      card.appendChild(meta);
      if (!d.gg_id) card.appendChild(el('div', 'note bad', bi('The player has not set a ClubGG ID. Ask them before sending chips.', 'Игрок не указал ID в ClubGG. Уточните у него до отправки фишек.')));
      if (!free && !mine) card.appendChild(el('div', 'tstat', bi('In work: ', 'В работе: ') + d.claimed_name));
      var b = el('div', 'tbtns');
      if (free) b.appendChild(btn('primary', bi('Take it', 'Беру'), function () { act('claim', d.id); }));
      else if (mine) {
        b.className = 'tbtns two';
        b.appendChild(btn('primary', bi('Chips sent', 'Фишки отправлены'), function () {
          ask('Mark ' + need + ' USDT for ID ' + (d.gg_id ? fid(d.gg_id) : '—') + ' as sent?', 'Отметить ' + need + ' USDT для ID ' + (d.gg_id ? fid(d.gg_id) : '—') + ' как отправленное?', function () { act('mark_sent', d.id); });
        }));
        b.appendChild(btn('', bi('Release', 'Отпустить'), function () { act('release', d.id); }));
      } else if (staffRole === 'owner') b.appendChild(btn('', bi('Take over', 'Забрать себе'), function () { act('claim', d.id); }));
      if (b.childNodes.length) card.appendChild(b);
      if (d.tx_hash && admData.explorer[d.network]) {
        var a = el('button', 'linkish', bi('View transfer', 'Посмотреть перевод')); a.type = 'button';
        a.addEventListener('click', function () { var u = admData.explorer[d.network] + d.tx_hash; try { tg.openLink(u); } catch (e) { window.open(u, '_blank'); } });
        card.appendChild(a);
      }
      box.appendChild(card);
    });
    nNew += wres.nNew; nMine += wres.nMine;
    $('adm-n-new').textContent = nNew; $('adm-n-mine').textContent = nMine;
    var bdg = $('adm-badge'); bdg.textContent = nNew; bdg.hidden = nNew === 0;
    // a new waiting deposit appeared since the last check: buzz the phone
    var ids = items.filter(function (d) { return !d.claimed_name; }).map(function (d) { return d.id; }).concat(wres.free);
    if (seenNew) {
      var fresh = ids.filter(function (i) { return seenNew.indexOf(i) < 0; });
      if (fresh.length) { try { tg.HapticFeedback.notificationOccurred('warning'); } catch (e) {} }
    }
    seenNew = ids;
  }
  function renderWQueue(items) {
    var box = $('adm-wqueue'); box.innerHTML = '';
    var nNew = 0, nMine = 0;
    items.forEach(function (w) {
      var free = !w.claimed_name, mine = w.mine;
      if (free) nNew++;
      if (mine) nMine++;
      var card = el('div', 'tcard wd' + (mine ? ' mine' : (!free ? ' taken' : '')));
      card.appendChild(el('div', 'tkind', bi('Cash out', 'Вывод') + (w.op_id ? ' · <span class="opid">' + w.op_id + '</span>' : '')));
      var top = el('div', 'trow'); top.appendChild(el('div', 'tamt', Number(w.chips) + ' ' + t('chips', 'фишек'))); top.appendChild(el('div', 'tnet', w.network)); card.appendChild(top);
      card.appendChild(el('div', 'tmeta', bi('Player gets ', 'Игрок получит ') + '<b>' + Number(w.amount) + ' USDT</b>' + (Number(w.fee) ? ' · ' + bi('fee ', 'комиссия ') + Number(w.fee) : '')));
      var idr = el('div', 'tid'); idr.appendChild(el('div', '', '<span class="muted">' + bi('ClubGG ID', 'ID в ClubGG') + '</span> <b>' + (w.gg_id ? fid(w.gg_id) : '—') + '</b>'));
      if (w.gg_id) idr.appendChild(copyChip(fid(w.gg_id)));
      card.appendChild(idr);
      var ar = el('div', 'tid'); ar.appendChild(el('div', 'addr', ''));
      ar.firstChild.textContent = w.address;
      ar.appendChild(copyChip(w.address));
      card.appendChild(ar);
      card.appendChild(el('div', 'tmeta', bi('Waiting ', 'Ждёт ') + ago(w.created_at)));
      if (w.status === 'pending') card.appendChild(el('div', 'note', bi('Take these chips from the player in ClubGG (check the balance), then press "Chips taken". USDT is sent automatically.', 'Снимите эти фишки с игрока в ClubGG (проверьте баланс) и нажмите «Фишки сняты». USDT отправятся автоматически.')));
      if (!free && !mine) card.appendChild(el('div', 'tstat', bi('In work: ', 'В работе: ') + w.claimed_name));
      var b = el('div', 'tbtns');
      if (w.status === 'sending') {
        var gf = w.note && w.note.indexOf('gf:') === 0;
        card.appendChild(el('div', w.note && !gf ? 'note bad' : 'tstat', w.note && !gf ? '' : bi('Sending USDT automatically…', 'USDT отправляются автоматически…')));
        if (w.note && !gf) card.lastChild.textContent = w.note;
        b.appendChild(btn('primary', bi('Check status', 'Проверить статус'), function () { wact('wretry', w.id); }));
        if (staffRole === 'owner') { b.className = 'tbtns two'; b.appendChild(btn('', bi('Checked: it was paid', 'Проверил: выплачено'), function () { payForm(card, w); })); }
      } else if (w.status === 'approved') {
        var why = el('div', 'note bad', ''); why.textContent = t('Auto payout did not go through: ', 'Автовыплата не прошла: ') + (w.note || t('not started yet', 'ещё не запускалась'));
        card.appendChild(why);
        b.className = 'tbtns two';
        b.appendChild(btn('primary', bi('Send USDT', 'Отправить USDT'), function () { wact('wretry', w.id); }));
        b.appendChild(btn('', bi('I paid by hand', 'Выплатил вручную'), function () { payForm(card, w); }));
      } else if (free) b.appendChild(btn('primary', bi('Take it', 'Беру'), function () { wact('wclaim', w.id); }));
      else if (mine) {
        b.className = 'tbtns two';
        b.appendChild(btn('primary', bi('Chips taken', 'Фишки сняты'), function () { takenForm(card, w); }));
        b.appendChild(btn('', bi('Release', 'Отпустить'), function () { wact('wrelease', w.id); }));
      } else if (staffRole === 'owner') b.appendChild(btn('', bi('Take over', 'Забрать себе'), function () { wact('wclaim', w.id); }));
      if (b.childNodes.length) card.appendChild(b);
      if (w.status === 'pending' && (mine || staffRole === 'owner')) {
        var rj = el('button', 'linkish', bi('Reject', 'Отклонить')); rj.type = 'button';
        rj.addEventListener('click', function () { ask('Reject this cash out?', 'Отклонить этот вывод?', function () { wact('wreject', w.id); }); });
        card.appendChild(rj);
      }
      box.appendChild(card);
    });
    return { nNew: nNew, nMine: nMine, free: items.filter(function (w) { return !w.claimed_name; }).map(function (w) { return 'w' + w.id; }) };
  }
  function takenForm(card, w) {
    var f = el('div', 'stack');
    f.appendChild(el('div', 'note', bi('Type how many chips you took from the player. It must match the request exactly.', 'Введите, сколько фишек вы сняли с игрока. Должно точно совпасть с заявкой.')));
    var inp = el('input', 'txin'); inp.inputMode = 'decimal'; inp.placeholder = t('Amount taken, USDT', 'Снятая сумма, USDT');
    f.appendChild(inp);
    f.appendChild(btn('primary', bi('Confirm', 'Подтвердить'), function (b) {
      adminCall({ action: 'wtaken', id: w.id, amount: inp.value }).then(function (r) {
        if (r.ok) {
          var p = r.data.payout || {};
          haptic(p.ok ? 'success' : 'warning');
          try { tg.showAlert(p.ok ? t('Done. USDT sent automatically.', 'Готово. USDT отправлены автоматически.') : t('Chips confirmed, but the auto payout did not go through: ', 'Фишки подтверждены, но автовыплата не прошла: ') + (p.reason || '')); } catch (e) {}
          loadAdmin(false); return;
        }
        haptic('error'); b.disabled = false;
        try { tg.showAlert(r.data && r.data.error === 'amount mismatch' ? t('The amount does not match the request (' + Number(w.chips) + ').', 'Сумма не совпадает с заявкой (' + Number(w.chips) + ').') : t('Could not save. Try again.', 'Не удалось сохранить. Повторите.')); } catch (e) {}
      });
    }));
    card.appendChild(f);
  }
  function payForm(card, w) {
    var f = el('div', 'stack');
    var inp = el('input', 'txin'); inp.placeholder = t('Transfer hash (optional)', 'Хеш перевода (необязательно)'); inp.spellcheck = false; inp.autocapitalize = 'off';
    f.appendChild(inp);
    f.appendChild(btn('primary', bi('Confirm: paid', 'Подтвердить: выплачено'), function () { wact('wpaid', w.id, { tx_hash: inp.value.trim() }); }));
    card.appendChild(f);
  }
  async function wact(action, id, extra) {
    var r = await adminCall(Object.assign({ action: action, id: id }, extra || {}));
    if (!r.ok && r.status === 409) { haptic('error'); try { tg.showAlert(t('Someone else already took or finished this one.', 'Это уже взял или закрыл кто-то другой.')); } catch (e) {} }
    else if (r.ok && r.data.payout && !r.data.payout.ok) { haptic('error'); try { tg.showAlert(t('Auto payout did not go through: ', 'Автовыплата не прошла: ') + (r.data.payout.reason || '')); } catch (e) {} }
    else if (!r.ok) { haptic('error'); try { tg.showAlert(t('Could not save. Check the transfer hash and try again.', 'Не удалось сохранить. Проверьте хеш перевода и повторите.')); } catch (e) {} }
    else haptic('success');
    loadAdmin(false);
  }
  function renderMini(boxId, cardId, rows) {
    var box = $(boxId); box.innerHTML = ''; $(cardId).hidden = !rows.length;
    rows.forEach(function (r) { box.appendChild(r); });
  }
  async function loadAdmin(full) {
    if (!staffRole) return;
    var q = await adminCall({ action: 'queue' });
    var wq = await adminCall({ action: 'wqueue' });
    var wres = wq.ok ? renderWQueue(wq.data.items || []) : { nNew: 0, nMine: 0, free: [] };
    if (q.ok) { admData.explorer = q.data.explorer || {}; renderQueue(q.data.items || [], wres); }
    if (!full && $('tab-admin').hidden) return;
    var d = await adminCall({ action: 'done' });
    if (d.ok) renderMini('adm-done', 'adm-done-card', (d.data.items || []).map(function (x) {
      return el('div', 'mini', '<span>' + (x.gg_id ? fid(x.gg_id) : '—') + ' · ' + Number(x.base_amount != null ? x.base_amount : x.amount) + ' USDT</span><span><b>' + (x.handled_name || '') + '</b> · ' + ago(x.handled_at) + '</span>');
    }));
    var wd = await adminCall({ action: 'wdone' });
    if (wd.ok) renderMini('adm-wdone', 'adm-wdone-card', (wd.data.items || []).map(function (x) {
      return el('div', 'mini', '<span>' + (x.gg_id ? fid(x.gg_id) : '—') + ' · ' + Number(x.chips) + ' → ' + Number(x.amount) + ' USDT · ' + x.network + (x.status === 'rejected' ? ' · ' + t('rejected', 'отклонён') : '') + '</span><span><b>' + (x.handled_name || '') + '</b> · ' + ago(x.handled_at) + '</span>');
    }));
    var u = await adminCall({ action: 'unmatched' });
    if (u.ok) renderMini('adm-unm', 'adm-unm-card', (u.data.items || []).map(function (x) {
      var row = el('div', 'tcard');
      row.appendChild(el('div', 'tamt', Number(x.amount) + ' USDT'));
      row.appendChild(el('div', 'tmeta', bi('To ', 'На ') + x.address.slice(0, 8) + '…  ' + bi('from ', 'от ') + String(x.from_address || '').slice(0, 8) + '… · ' + ago(x.seen_at)));
      row.appendChild(el('div', 'tmeta', bi('No request matches this amount. Check it by hand.', 'Ни одна заявка не подходит по сумме. Проверьте вручную.')));
      row.appendChild(btn('', bi('Handled', 'Разобрано'), function () { adminCall({ action: 'resolve', id: x.id }).then(function () { loadAdmin(false); }); }));
      return row;
    }));
    if (full) loadLog();
    if (staffRole === 'owner') {
      $('adm-owner').hidden = false;
      if (full) adminCall({ action: 'wallet' }).then(function (r) {
        var box = $('adm-wallet'); if (!box || !r.ok) return; box.innerHTML = '';
        if (!r.data.ready) { box.appendChild(el('div', 'note bad', bi('Auto payout is off: the wallet key is not set on the server.', 'Автовыплаты выключены: ключ кошелька не задан на сервере.'))); return; }
        ['TRC20', 'BEP20'].forEach(function (n) {
          var x = r.data[n] || {}; var row = el('div', 'tcard');
          row.appendChild(el('div', 'trow', '<div class="tamt">' + (x.pool_usdt != null ? Number(x.pool_usdt) : '—') + ' USDT</div><div class="tnet">' + n + '</div>'));
          if (x.error) { var er = el('div', 'note bad', ''); er.textContent = x.error; row.appendChild(er); }
          else {
            row.appendChild(el('div', 'tmeta', bi('Fee wallet: ', 'Кошелёк для комиссий: ') + '<b>' + x.gas_balance + '</b>'));
            var ar = el('div', 'tid'); var ad = el('div', 'addr', ''); ad.textContent = x.gas_address; ar.appendChild(ad); ar.appendChild(copyChip(x.gas_address)); row.appendChild(ar);
          }
          box.appendChild(row);
        });
      });
      var s = await adminCall({ action: 'staff_list' });
      if (s.ok) {
        var box = $('adm-staff'); box.innerHTML = '';
        (s.data.items || []).forEach(function (m) {
          var row = el('div', 'mini', '<span><b>' + (m.username ? '@' + m.username : m.telegram_id) + '</b> · ' + (m.role === 'owner' ? t('owner', 'владелец') : t('manager', 'менеджер')) + '</span>');
          if (m.role !== 'owner') {
            var x = el('button', 'linkish', bi('Remove', 'Убрать')); x.type = 'button';
            x.addEventListener('click', function () { ask('Remove this manager?', 'Убрать этого менеджера?', function () { adminCall({ action: 'staff_remove', telegram_id: m.telegram_id }).then(function () { loadAdmin(true); }); }); });
            row.appendChild(x);
          }
          box.appendChild(row);
        });
      }
    }
  }
  var EV = {
    created: ['Created', 'Создана'], snapshot: ['Recorded', 'Записана'], claimed: ['Taken by a manager', 'Взята менеджером'], released: ['Released', 'Отпущена'], updated: ['Updated', 'Изменена'],
    'status:pending->approved': ['Chips taken', 'Фишки сняты'], 'status:approved->sending': ['Sending USDT', 'Отправка USDT'], 'status:sending->paid': ['Paid automatically', 'Выплачено автоматически'],
    'status:approved->paid': ['Paid by hand', 'Выплачено вручную'], 'status:sending->approved': ['Auto payout failed', 'Автовыплата не прошла'], 'status:pending->rejected': ['Rejected', 'Отклонена'],
    'status:received->chips_sent': ['Chips sent', 'Фишки отправлены']
  };
  async function loadLog() {
    var box = $('adm-log'); if (!box) return;
    var r = await adminCall({ action: 'log', q: $('adm-logq').value });
    box.innerHTML = '';
    if (!r.ok) { box.appendChild(el('div', 'note bad', bi('Could not load the log.', 'Не удалось загрузить журнал.'))); return; }
    var items = r.data.items || [];
    if (!items.length) { box.appendChild(el('div', 'tmeta', bi('Nothing found.', 'Ничего не найдено.'))); return; }
    items.forEach(function (x) {
      var ev = EV[x.event] || [x.event, x.event];
      var row = el('div', 'logrow');
      var head = el('div', 'loghead');
      var l = el('div', '', ''); var nm = el('b', '', bi(ev[0], ev[1])); l.appendChild(nm);
      var sub = el('small', '', ''); sub.textContent = x.op_id + (x.gg_id ? ' · ID ' + fid(x.gg_id) : '') + (x.actor_name ? ' · ' + x.actor_name : ''); l.appendChild(sub);
      var rr = el('div', 'logr', ''); rr.innerHTML = '<b>' + (x.amount != null ? Number(x.amount) + ' USDT' : '') + '</b><small>' + new Date(x.at).toLocaleString(document.body.dataset.lang === 'ru' ? 'ru-RU' : 'en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '</small>';
      head.appendChild(l); head.appendChild(rr); row.appendChild(head);
      var det = el('pre', 'logdet', ''); det.hidden = true;
      var d = x.row_data || {}, keep = ['op_id', 'status', 'network', 'chips', 'fee', 'amount', 'address', 'to_address', 'from_address', 'tx_hash', 'claimed_name', 'handled_name', 'note', 'created_at', 'handled_at'];
      det.textContent = keep.filter(function (k) { return d[k] != null && d[k] !== ''; }).map(function (k) { return k + ': ' + d[k]; }).join('\n') + (x.changed ? '\n\n' + t('Before: ', 'Было: ') + Object.keys(x.changed).filter(function (k) { return k !== 'updated_at'; }).map(function (k) { return k + '=' + x.changed[k]; }).join(', ') : '');
      row.appendChild(det);
      head.addEventListener('click', function () { det.hidden = !det.hidden; });
      box.appendChild(row);
    });
  }
  async function checkStaff() {
    try {
      var r = await adminCall({ action: 'whoami' });
      if (!r.ok || !r.data.role) return;
      staffRole = r.data.role;
      $('tab-admin-btn').hidden = false; $('tabs').classList.add('has-admin');
      await loadAdmin(false);
      admTimer = setInterval(function () { loadAdmin(false); }, 8000);
      if (/[?&]tab=admin/.test(location.search)) showTab('admin');
    } catch (e) {}
  }
  $('adm-logform').addEventListener('submit', function (e) { e.preventDefault(); loadLog(); });
  $('adm-add').addEventListener('submit', async function (e) {
    e.preventDefault();
    var uname = $('adm-user').value.trim(); if (!uname) return;
    var m = $('adm-msg'); m.hidden = true;
    var r = await adminCall({ action: 'staff_add', username: uname });
    if (r.ok) { $('adm-user').value = ''; loadAdmin(true); return; }
    m.className = 'note bad'; m.hidden = false;
    m.innerHTML = r.data.error === 'not found' ? bi('Not found. Ask this person to open the app once, then try again.', 'Не найден. Пусть человек один раз откроет приложение, затем повторите.') : bi('Could not add. Check the username.', 'Не удалось добавить. Проверьте имя пользователя.');
  });

  /* ---------- start ---------- */
  document.querySelectorAll('.mindep').forEach(function (e) { e.textContent = MIN_DEPOSIT; });
  document.querySelectorAll('.minwd').forEach(function (e) { e.textContent = MIN_WITHDRAW; });
  applyNet();
  signIn().then(function (user) {
    me = user;
    var u = tg.initDataUnsafe && tg.initDataUnsafe.user;
    var nm = u ? (u.username ? '@' + u.username : (u.first_name || '')) : '';
    if (nm) { var w = $('who'); w.innerHTML = '<span class="ava"></span><span class="nm"></span>'; w.firstChild.textContent = (u.first_name || u.username || '?').charAt(0).toUpperCase(); w.lastChild.textContent = nm; }
    return Promise.all([loadProfile(), loadAddress()]);
  }).then(function () {
    $('splash').hidden = true; $('app').hidden = false;
    var go = (location.search.match(/[?&]go=(buy|sell|history)/) || [])[1];
    if (go) showTab(go === 'buy' ? 'deposit' : go === 'sell' ? 'withdraw' : 'history');
    prefetchNets();
    checkStaff();
  }).catch(function () {
    splashError('Could not sign you in. Please reopen the app.', 'Не удалось войти. Откройте приложение заново.');
  });
})();
