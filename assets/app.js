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
    TON: ['Enter a valid TON address (starts with UQ or EQ).', 'Введите корректный адрес TON (начинается с UQ или EQ).'],
    GRAM: ['Enter a valid TON address (starts with UQ or EQ).', 'Введите корректный адрес TON (начинается с UQ или EQ).']
  };
  var WD_FEE = { TRC20: [3, 1], BEP20: [0, 0], TON: [0, 0], GRAM: [0, 0] };   // fixed USDT, percent (the server decides; this is a preview)
  function wdFee(n, chips) { var f = WD_FEE[n] || [0, 0]; return Math.ceil(Math.round((f[0] + chips * f[1] / 100) * 1e6) / 1e4) / 100; }
  var CHAIN_OF = { TRC20: 'TRON', BEP20: 'BSC', TON: 'TON', GRAM: 'TON' };
  var CHAIN_NAME = { TRON: 'Tron (TRC20)', BSC: 'BNB Chain (BEP20)', TON: 'TON' };
  var wallets = {}, walletsLoaded = false;
  var net = 'TRC20';
  var tg = window.Telegram && window.Telegram.WebApp;
  var $ = function (id) { return document.getElementById(id); };
  var sb = null, me = null, ggId = '';

  /* in-app notifications instead of Telegram pop-ups */
  function toast(text, kind) {
    var box = document.getElementById('toasts'); if (!box) return;
    var el = document.createElement('div');
    var bad = kind === 'bad' || /not|could|wrong|failed|не удалось|неверн|не прошла|не совпадает|уже взял|ошибк/i.test(text);
    el.className = 'toast' + (bad ? ' bad' : '');
    el.innerHTML = '<span class="ti">' + (bad ? '!' : '✓') + '</span><span class="tt"></span>';
    el.lastChild.textContent = text;
    box.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('in'); });
    var hide = function () { el.classList.remove('in'); setTimeout(function () { el.remove(); }, 250); };
    el.addEventListener('click', hide);
    setTimeout(hide, bad ? 6000 : 3500);
  }
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
    var coin = net === 'GRAM' ? 'GRAM' : 'USDT', chain = net === 'GRAM' ? 'TON' : net;
    document.querySelectorAll('.netname').forEach(function (e) { e.textContent = chain; });
    document.querySelectorAll('.coinname').forEach(function (e) { e.textContent = coin; });
    $('req-net').textContent = coin + ' · ' + chain;
    applyWallet();
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
  function shortAddr(a) { return a && a.length > 24 ? a.slice(0, 10) + '…' + a.slice(-8) : (a || '—'); }
  /* TON friendly address (EQ/UQ/raw) -> one form (UQ…) so the same wallet is stored once */
  function tonNormalize(a) {
    a = String(a).trim();
    if (/^-?\d+:[0-9a-fA-F]{64}$/.test(a)) return tonFriendly(a);
    try {
      var bin = atob(a.replace(/-/g, '+').replace(/_/g, '/')); if (bin.length !== 36) return a;
      var hex = ''; for (var i = 2; i < 34; i++) hex += ('0' + bin.charCodeAt(i).toString(16)).slice(-2);
      var wc = bin.charCodeAt(1); return tonFriendly((wc > 127 ? wc - 256 : wc) + ':' + hex);
    } catch (e) { return a; }
  }
  var pending = [], hasCode = true, hasPin = false, sessionPin = '';
  /* ---------- PIN and Face ID ---------- */
  var bm = tg && tg.BiometricManager, bioReady = false;
  function bioInit(cb) {
    if (!bm || !bm.init) return cb && cb();
    try { bm.init(function () { bioReady = true; cb && cb(); }); } catch (e) { cb && cb(); }
  }
  function bioCan() { return bioReady && bm.isBiometricAvailable; }
  function bioName() { return bm && bm.biometricType === 'finger' ? t('fingerprint', 'отпечаток') : 'Face ID'; }
  var lockMode = null, entry = '', firstPin = '', lockDone = null;
  function paintDots() { document.querySelectorAll('#dots i').forEach(function (d, i) { d.classList.toggle('on', i < entry.length); }); }
  function lockMsg(en, ru) { $('lockmsg').innerHTML = en ? bi(en, ru) : ''; }
  function openLock(mode, done) {
    lockMode = mode; entry = ''; firstPin = ''; lockDone = done; paintDots(); lockMsg('');
    var titles = { unlock: ['Enter your PIN', 'Введите PIN-код'], set: ['Create a 6-digit PIN', 'Придумайте 6-значный PIN-код'], old: ['Enter your current PIN', 'Введите текущий PIN-код'], confirm: ['Enter the PIN for the cash out', 'Введите PIN-код для вывода'] };
    $('locktitle').innerHTML = bi(titles[mode][0], titles[mode][1]);
    $('kbio').disabled = !(mode === 'unlock' || mode === 'confirm') || !(bioCan() && bm.isBiometricTokenSaved);
    $('kbio').textContent = bm && bm.biometricType === 'finger' ? '☝' : '🙂';
    $('lockcancel').hidden = mode === 'unlock';
    $('lock').hidden = false;
    if ((mode === 'unlock' || mode === 'confirm') && !$('kbio').disabled) setTimeout(bioUnlock, 250);
  }
  function closeLock() { $('lock').hidden = true; lockMode = null; entry = ''; }
  function shake() { var d = $('dots'); d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake'); haptic('error'); }
  async function pinEntered(pin) {
    if (lockMode === 'unlock' || lockMode === 'confirm') {
      var r = await walletCall({ action: 'pin_check', pin: pin });
      if (r.ok) { sessionPin = pin; haptic('success'); var d = lockDone; closeLock(); d && d(pin); return; }
      entry = ''; paintDots(); shake();
      if (r.data.error === 'locked') lockMsg('Too many wrong PINs. Try again in 15 minutes.', 'Слишком много неверных попыток. Попробуйте через 15 минут.');
      else lockMsg('Wrong PIN. Attempts left: ' + r.data.left, 'Неверный PIN. Осталось попыток: ' + r.data.left);
      return;
    }
    if (lockMode === 'old') { firstPin = ''; window.__oldPin = pin; lockMode = 'set'; entry = ''; paintDots(); $('locktitle').innerHTML = bi('Create a new 6-digit PIN', 'Придумайте новый 6-значный PIN-код'); return; }
    if (lockMode === 'set' && !firstPin) { firstPin = pin; entry = ''; paintDots(); $('locktitle').innerHTML = bi('Repeat the PIN', 'Повторите PIN-код'); return; }
    if (lockMode === 'set') {
      if (pin !== firstPin) { firstPin = ''; entry = ''; paintDots(); shake(); $('locktitle').innerHTML = bi('PINs do not match. Create it again', 'PIN-коды не совпали. Придумайте заново'); return; }
      var r2 = await walletCall({ action: 'pin_set', pin: pin, old_pin: window.__oldPin || '' });
      window.__oldPin = '';
      if (!r2.ok) { entry = ''; firstPin = ''; paintDots(); shake(); lockMsg('Could not save the PIN (wrong current PIN?).', 'Не удалось сохранить PIN (неверный текущий PIN?).'); lockMode = hasPin ? 'old' : 'set'; return; }
      sessionPin = pin; hasPin = true; $('pinprompt').hidden = true; haptic('success'); closeLock();
      offerBio(pin);
    }
  }
  function offerBio(pin) {
    if (!bioCan()) { try { toast(t('PIN is set. It will be asked when the app opens and for cash outs.', 'PIN-код установлен. Его спросят при входе и при выводе.')); } catch (e) {} return; }
    ask('Also unlock with ' + bioName() + '?', 'Входить также по ' + bioName() + '?', function () {
      bm.requestAccess({ reason: t('Unlock Zerake', 'Вход в Zerake') }, function (granted) {
        if (!granted) return;
        bm.updateBiometricToken(pin, function (ok) { if (ok) { haptic('success'); try { toast(bioName() + t(' is on.', ' включён.')); } catch (e) {} } });
      });
    });
  }
  function bioUnlock() {
    if (!bioCan() || !bm.isBiometricTokenSaved) return;
    bm.authenticate({ reason: t('Unlock Zerake', 'Вход в Zerake') }, function (ok, token) { if (ok && token && /^\d{6}$/.test(token)) pinEntered(token); });
  }
  document.querySelectorAll('#keypad button').forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.id === 'kbio') return bioUnlock();
      if (b.classList.contains('k-del')) { entry = entry.slice(0, -1); paintDots(); return; }
      if (entry.length >= 6) return;
      entry += b.textContent; paintDots(); try { tg.HapticFeedback.impactOccurred('light'); } catch (e) {}
      if (entry.length === 6) { var p = entry; setTimeout(function () { pinEntered(p); }, 120); }
    });
  });
  $('lockcancel').addEventListener('click', function () { var d = lockDone, m = lockMode; closeLock(); if (m === 'confirm' && d) d(null); });
  $('pinsetup').addEventListener('click', function () { openLock('set'); });
  $('pinlater').addEventListener('click', function () { $('pinprompt').hidden = true; try { sessionStorage.setItem('zerake-pinlater', '1'); } catch (e) {} });
  $('secbtn').addEventListener('click', function () { openLock(hasPin ? 'old' : 'set'); });
  function askPinIfNeeded(d) {
    hasPin = !!d.has_pin;
    var later = false; try { later = !!sessionStorage.getItem('zerake-pinlater'); } catch (e) {}
    $('pinprompt').hidden = hasPin || later;
    if (hasPin && !sessionPin && !lockMode) bioInit(function () { openLock('unlock'); });
    else bioInit();
  }
  async function walletCall(body) {
    var ses = (await sb.auth.getSession()).data.session;
    var r = await fetch(C.supabaseUrl + '/functions/v1/wallet', {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: C.supabaseAnonKey, Authorization: 'Bearer ' + ses.access_token },
      body: JSON.stringify(body)
    });
    var d = {}; try { d = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, data: d };
  }
  function takeState(d) {
    if (!d || !d.wallets) return;
    wallets = d.wallets; pending = d.pending || []; hasCode = !!d.has_code; walletsLoaded = true;
    if (d.has_pin !== undefined && !window.__pinAsked) { window.__pinAsked = 1; askPinIfNeeded(d); }
    applyWallet(); paintPending();
    if (d.code) showCode(d.code);
  }
  async function loadWallets() {
    if (!me) return;
    var r = await walletCall({ action: 'status' });
    if (r.ok) takeState(r.data);
  }
  function paintPending() {
    var p = pending[0];
    $('pendbox').hidden = !p;
    if (p) {
      var when = new Date(p.effective_at).toLocaleString(document.body.dataset.lang === 'ru' ? 'ru-RU' : 'en-GB', { day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
      $('pendtext').innerHTML = bi(CHAIN_NAME[p.chain] + ': <code>' + shortAddr(p.old_address) + '</code> → <code>' + shortAddr(p.new_address) + '</code>.<br>Takes effect on <b>' + when + '</b>. Cash outs are frozen until then. If it was not you, cancel it.',
        CHAIN_NAME[p.chain] + ': <code>' + shortAddr(p.old_address) + '</code> → <code>' + shortAddr(p.new_address) + '</code>.<br>Вступит в силу <b>' + when + '</b>. До этого выводы заморожены. Если это не вы — отмените.');
    }
    $('nocode').hidden = hasCode || !Object.keys(wallets).length;
  }
  function showCode(code) {
    $('codetext').textContent = code; $('codeok').checked = false; $('codedone').disabled = true; $('codebox').hidden = false;
    try { tg.HapticFeedback.notificationOccurred('warning'); } catch (e) {}
  }
  $('codeok').addEventListener('change', function () { $('codedone').disabled = !$('codeok').checked; });
  $('codedone').addEventListener('click', function () { $('codebox').hidden = true; $('codetext').textContent = '—'; });
  $('pendcancel').addEventListener('click', function () {
    ask('Cancel the wallet change?', 'Отменить смену кошелька?', async function () {
      var r = await walletCall({ action: 'cancel' }); if (r.ok) { haptic('success'); takeState(r.data); }
    });
  });
  $('newcodebtn').addEventListener('click', async function () {
    var r = await walletCall({ action: 'newcode' }); if (r.ok) takeState(r.data);
  });
  $('chgopen').addEventListener('click', function () { $('chgform').hidden = !$('chgform').hidden; $('chgaddr').placeholder = PLACEHOLDER[net]; });
  $('chgbtn').addEventListener('click', function () {
    var m = $('chgmsg'); m.hidden = true;
    var a = $('chgaddr').value.trim(); if (net === 'TON' || net === 'GRAM') a = tonNormalize(a);
    var code = $('chgcode').value.trim();
    var bad = function (en, ru) { m.className = 'note bad'; m.innerHTML = bi(en, ru); m.hidden = false; haptic('error'); };
    if (!ADDR_RE[net].test(a)) return bad(ADDR_HINT[net][0], ADDR_HINT[net][1]);
    if (code.replace(/[^0-9A-Za-z]/g, '').length !== 12) return bad('Enter the 12-character recovery code.', 'Введите код восстановления из 12 символов.');
    ask('Change the wallet to ' + a + '? It takes effect in 48 hours.', 'Сменить кошелёк на ' + a + '? Смена вступит в силу через 48 часов.', async function () {
      $('chgbtn').disabled = true;
      var r = await walletCall({ action: 'change', chain: CHAIN_OF[net], address: a, code: code });
      $('chgbtn').disabled = false;
      if (r.ok) { haptic('success'); $('chgaddr').value = ''; $('chgcode').value = ''; $('chgform').hidden = true; takeState(r.data); return; }
      var e = r.data.error;
      if (e === 'wrong code') bad('Wrong code. Attempts left today: ' + r.data.left + '.', 'Неверный код. Осталось попыток на сегодня: ' + r.data.left + '.');
      else if (e === 'too many attempts') bad('Too many wrong codes. Try again tomorrow or write to support.', 'Слишком много неверных кодов. Попробуйте завтра или напишите в поддержку.');
      else if (e === 'wallet taken') bad('This wallet is bound to another player.', 'Этот кошелёк привязан к другому игроку.');
      else if (e === 'change pending') bad('A change is already waiting.', 'Смена уже запрошена и ждёт.');
      else if (e === 'same address') bad('This is already your wallet.', 'Это и так ваш кошелёк.');
      else bad('Could not request the change.', 'Не удалось запросить смену.');
    });
  });
  function applyWallet() {
    var ch = CHAIN_OF[net], w = wallets[ch];
    document.body.classList.toggle('nobind', walletsLoaded && !w);
    document.querySelectorAll('.chainname').forEach(function (e) { e.textContent = CHAIN_NAME[ch]; });
    $('bindaddr').placeholder = PLACEHOLDER[net];
    $('dep-wallet').textContent = shortAddr(w); $('dep-wallet').title = w || '';
    $('wd-wallet').textContent = w || '—'; $('waddr').value = w || '';
    $('wnoaddr').hidden = !walletsLoaded || !!w;
    $('wsubmit').disabled = !w || !ggId;
    loadCap();
  }
  $('bindbtn').addEventListener('click', function () {
    var m = $('bindmsg'); m.hidden = true;
    var a = $('bindaddr').value.trim();
    if (net === 'TON' || net === 'GRAM') a = tonNormalize(a);
    if (!ADDR_RE[net].test(a)) { m.className = 'note bad'; m.innerHTML = bi(ADDR_HINT[net][0], ADDR_HINT[net][1]); m.hidden = false; return; }
    if (!$('bindok').checked) { m.className = 'note bad'; m.innerHTML = bi('Please confirm it is your personal wallet.', 'Подтвердите, что это ваш личный кошелёк.'); m.hidden = false; return; }
    ask('Bind ' + a + ' for good? It cannot be changed later.', 'Привязать ' + a + ' навсегда? Сменить его потом будет нельзя.', async function () {
      $('bindbtn').disabled = true;
      var r = await walletCall({ action: 'bind', chain: CHAIN_OF[net], address: a });
      $('bindbtn').disabled = false;
      if (!r.ok) {
        haptic('error'); m.className = 'note bad'; m.hidden = false;
        m.innerHTML = r.data.error === 'wallet taken' ? bi('This wallet is already bound to another player.', 'Этот кошелёк уже привязан к другому игроку.') : r.data.error === 'already bound' ? bi('A wallet is already bound on this network.', 'В этой сети кошелёк уже привязан.') : bi('Could not bind. Check the address and try again.', 'Не удалось привязать. Проверьте адрес и попробуйте ещё раз.');
        if (r.data.error === 'already bound') loadWallets();
        return;
      }
      haptic('success'); $('bindaddr').value = ''; $('bindok').checked = false; takeState(r.data);
    });
  });
  /* how much can go back to this network now ("back the same way") */
  async function loadCap() {
    var box = $('wcap'); if (!box || !me) return;
    var n = net, ch = CHAIN_OF[n];
    var d = await sb.from('deposits').select('network,amount,status').eq('user_id', me.id);
    var w = await sb.from('withdrawals').select('network,chips,amount,status').eq('user_id', me.id);
    if (n !== net) return;
    var left = {};
    (d.data || []).forEach(function (x) { if (x.status === 'received' || x.status === 'chips_sent') left[CHAIN_OF[x.network]] = (left[CHAIN_OF[x.network]] || 0) + Number(x.amount); });
    (w.data || []).forEach(function (x) { if (x.status !== 'rejected') left[CHAIN_OF[x.network]] = (left[CHAIN_OF[x.network]] || 0) - Number(x.chips != null ? x.chips : x.amount); });
    var others = 0; Object.keys(left).forEach(function (k) { if (k !== ch) others += Math.max(0, left[k]); });
    if (others > 0.009) {
      var cap = Math.floor(Math.max(0, left[ch] || 0) * 100) / 100;
      box.innerHTML = bi('To this network you can cash out up to <b>$' + cap + '</b> now: deposits from other networks are paid back to them first.', 'В эту сеть сейчас можно вывести до <b>$' + cap + '</b>: депозиты из других сетей сначала возвращаются туда, откуда пришли.');
      box.hidden = false;
    } else box.hidden = true;
  }
  /* TON raw address (0:HEX) -> friendly non-bounceable UQ… form */
  function tonFriendly(raw) {
    var m = String(raw).match(/^(-?\d+):([0-9a-fA-F]{64})$/); if (!m) return raw;
    var b = [0x51, (Number(m[1]) + 256) % 256]; for (var i = 0; i < 64; i += 2) b.push(parseInt(m[2].substr(i, 2), 16));
    var crc = 0; b.forEach(function (x) { crc ^= x << 8; for (var k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; });
    b.push(crc >> 8, crc & 255);
    return btoa(String.fromCharCode.apply(null, b)).replace(/\+/g, '-').replace(/\//g, '_');
  }
  var wdAddrs = {};
  async function loadWdAddrs() {
    var n = net, sel = $('waddr');
    var chains = n === 'TON' || n === 'GRAM' ? ['TON', 'GRAM'] : [n];
    if (!wdAddrs[n] && me) {
      var r = await sb.from('deposits').select('from_address,created_at').eq('user_id', me.id).in('network', chains).order('created_at', { ascending: false }).limit(50);
      var seen = {}, list = [];
      (r.data || []).forEach(function (d) {
        var a = d.from_address; if (!a) return;
        if (chains[0] === 'TON') a = tonFriendly(a);
        var k = n === 'BEP20' ? a.toLowerCase() : a; if (seen[k]) return; seen[k] = 1; list.push(a);
      });
      wdAddrs[n] = list;
    }
    if (n !== net) return;
    var list = wdAddrs[n] || [];
    sel.innerHTML = '';
    list.forEach(function (a) { var o = document.createElement('option'); o.value = a; o.textContent = a.length > 24 ? a.slice(0, 10) + '…' + a.slice(-8) : a; sel.appendChild(o); });
    sel.hidden = !list.length; $('wnoaddr').hidden = !!list.length;
    $('wsubmit').disabled = !list.length || !ggId;
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
    if (hasPin && !sessionPin) { openLock('confirm', function (p) { if (p) $('wform').requestSubmit(); }); return; }
    $('wsubmit').disabled = true;
    var ses = (await sb.auth.getSession()).data.session;
    var res = await fetch(C.supabaseUrl + '/functions/v1/create-withdrawal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: C.supabaseAnonKey, Authorization: 'Bearer ' + ses.access_token },
      body: JSON.stringify({ network: net, address: address, amount: $('wamt').value, pin: sessionPin })
    });
    var rd = {}; try { rd = await res.json(); } catch (x) {}
    $('wsubmit').disabled = false;
    if (!res.ok) {
      haptic('error');
      if (rd.error === 'below minimum') wmsg('Minimum withdrawal is ' + rd.min + ' USDT.', 'Минимальный вывод: ' + rd.min + ' USDT.', true);
      else if (rd.error === 'too many pending') wmsg('You already have 3 requests waiting. Please wait for them to be paid.', 'У вас уже 3 запроса в ожидании. Дождитесь их выплаты.', true);
      else if (rd.error === 'below fee') wmsg('The amount is too small to cover the fee (' + rd.fee + ' USDT).', 'Сумма слишком мала, чтобы покрыть комиссию (' + rd.fee + ' USDT).', true);
      else if (rd.error === 'bad address') wmsg(ADDR_HINT[net][0], ADDR_HINT[net][1], true);
      else if (rd.error === 'wrong pin') { sessionPin = ''; wmsg('Wrong PIN. Try again.', 'Неверный PIN-код. Попробуйте ещё раз.', true); }
      else if (rd.error === 'pin locked') wmsg('Too many wrong PINs. Try again in 15 minutes.', 'Слишком много неверных PIN. Попробуйте через 15 минут.', true);
      else if (rd.error === 'wallet change pending') wmsg('A wallet change is waiting: cash outs are frozen until ' + new Date(rd.until).toLocaleString() + '.', 'Идёт смена кошелька: выводы заморожены до ' + new Date(rd.until).toLocaleString('ru-RU') + '.', true);
      else if (rd.error === 'address not allowed' || rd.error === 'no bound wallet') wmsg('Cash outs go only to your bound wallet on this network.', 'Вывод возможен только на ваш привязанный кошелёк в этой сети.', true);
      else if (rd.error === 'same way') {
        var wh = (rd.where || []).map(function (x) { return CHAIN_NAME[x.chain] + ' — $' + x.amount; }).join(', ');
        wmsg('To this network you can cash out up to $' + rd.cap + '. First withdraw to: ' + wh + '.', 'В эту сеть можно вывести до $' + rd.cap + '. Сначала выведите в: ' + wh + '.', true);
      }
      else if (rd.error === 'no clubgg id') wmsg('Add your ClubGG ID first.', 'Сначала добавьте ID в ClubGG.', true);
      else if (rd.error === 'bad amount') wmsg('Enter the amount with at most 2 decimals, for example 50 or 50.25.', 'Введите сумму не более чем с 2 знаками после точки, например 50 или 50.25.', true);
      else if (rd.error === 'above maximum') wmsg('Maximum withdrawal is ' + rd.max + ' USDT.', 'Максимальный вывод: ' + rd.max + ' USDT.', true);
      else if (rd.error === 'network disabled') wmsg('This network is not available yet.', 'Эта сеть пока недоступна.', true);
      else if (rd.error === 'no price, try again') wmsg('Could not get the GRAM rate. Try again in a moment.', 'Не удалось получить курс GRAM. Попробуйте через минуту.', true);
      else wmsg('Could not send the request (' + (rd.error || res.status) + '). Please try again.', 'Не удалось отправить запрос (' + (rd.error || res.status) + '). Попробуйте ещё раз.', true);
      return;
    }
    haptic('success'); loadCap();
    var got = rd.coin_amount ? Number(rd.coin_amount) + ' GRAM' : rd.payout + ' USDT';
    wmsg('Request ' + (rd.op_id || '') + ' sent. A manager will take the chips from your ClubGG ID and you will get ' + got + '.', 'Заявка ' + (rd.op_id || '') + ' отправлена. Менеджер снимет фишки с вашего ID, вы получите ' + got + '.', false);
    $('wamt').value = '';
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
    $('rv-no').textContent = r.request_no; $('rv-addr').textContent = r.address; $('rv-amt').textContent = r.network === 'GRAM' ? String(Number(r.amount)) : r.amount;
    if ($('rv-no2')) $('rv-no2').textContent = r.request_no;
    if (r.network === 'GRAM') { $('rv-chips').textContent = '$' + Number(r.base_amount); $('rv-rate').textContent = r.rate ? '1 GRAM = $' + Number(r.rate).toFixed(3) : '—'; }
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
  function prefetchNets() { ['TRC20', 'BEP20', 'TON', 'GRAM'].forEach(function (n) { if (n !== net) fetchOpen(n).catch(function () {}); }); }
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
    if (r.data && r.data.error === 'bind wallet') { loadWallets(); return; }
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
    var no = function () { if (staffRole) loadAdmin(false); };
    var box = $('confirm');
    $('confirmtext').textContent = t(en, ru);
    box.hidden = false;
    var done = function (ok) { box.hidden = true; $('confirmyes').onclick = $('confirmno').onclick = box.onclick = null; if (ok) yes(); else no(); };
    $('confirmyes').onclick = function (e) { e.stopPropagation(); done(true); };
    $('confirmno').onclick = function (e) { e.stopPropagation(); done(false); };
    box.onclick = function (e) { if (e.target === box) done(false); };
    try { tg.HapticFeedback.impactOccurred('light'); } catch (e) {}
  }
  async function act(action, id) {
    var r = await adminCall({ action: action, id: id });
    if (!r.ok && r.status === 409) { haptic('error'); try { toast(t('Someone else already took or finished this one.', 'Эту заявку уже взял или закрыл кто-то другой.')); } catch (e) {} }
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
      card.appendChild(el('div', 'tmeta', bi('Player gets ', 'Игрок получит ') + '<b>' + (w.coin_amount ? Number(w.coin_amount) + ' GRAM' : Number(w.amount) + ' USDT') + '</b>' + (w.coin_amount ? ' (≈ $' + Number(w.amount) + ')' : '') + (Number(w.fee) ? ' · ' + bi('fee ', 'комиссия ') + Number(w.fee) : '')));
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
        var why = el('div', 'note bad', ''); why.textContent = t('Auto payout did not go through: ', 'Автовыплата не прошла: ') + (w.note ? (document.body.dataset.lang === 'ru' && NOTE_RU[w.note] || w.note) : t('not started yet', 'ещё не запускалась'));
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
    editing = Date.now();
    if (card.querySelector('.txin')) { card.querySelector('.txin').focus(); return; }
    var f = el('div', 'stack');
    f.appendChild(el('div', 'note', bi('Type how many chips you took from the player. It must match the request exactly.', 'Введите, сколько фишек вы сняли с игрока. Должно точно совпасть с заявкой.')));
    var inp = el('input', 'txin'); inp.inputMode = 'decimal'; inp.placeholder = t('Amount taken, USDT', 'Снятая сумма, USDT');
    f.appendChild(inp);
    f.appendChild(btn('primary', bi('Confirm', 'Подтвердить'), function (b) {
      b.innerHTML = bi('Confirming and sending USDT…', 'Подтверждаю и отправляю USDT…');
      adminCall({ action: 'wtaken', id: w.id, amount: inp.value }).then(function (r) {
        editing = 0;
        if (r.ok) {
          var p = r.data.payout || {};
          haptic(p.ok ? 'success' : 'warning');
          try { toast(p.ok ? t('Done. USDT sent automatically.', 'Готово. USDT отправлены автоматически.') : t('Chips confirmed, but the auto payout did not go through: ', 'Фишки подтверждены, но автовыплата не прошла: ') + ((document.body.dataset.lang === 'ru' && NOTE_RU[p.reason]) || p.reason || '')); } catch (e) {}
          loadAdmin(false); return;
        }
        haptic('error'); b.disabled = false;
        try { toast(r.data && r.data.error === 'amount mismatch' ? t('The amount does not match the request (' + Number(w.chips) + ').', 'Сумма не совпадает с заявкой (' + Number(w.chips) + ').') : t('Could not save. Try again.', 'Не удалось сохранить. Повторите.')); } catch (e) {}
      });
    }));
    card.appendChild(f); setTimeout(function () { inp.focus(); }, 50);
  }
  function payForm(card, w) {
    editing = Date.now();
    if (card.querySelector('.txin')) { card.querySelector('.txin').focus(); return; }
    var f = el('div', 'stack');
    var inp = el('input', 'txin'); inp.placeholder = t('Transfer hash (optional)', 'Хеш перевода (необязательно)'); inp.spellcheck = false; inp.autocapitalize = 'off';
    f.appendChild(inp);
    f.appendChild(btn('primary', bi('Confirm: paid', 'Подтвердить: выплачено'), function () { wact('wpaid', w.id, { tx_hash: inp.value.trim() }); }));
    card.appendChild(f);
  }
  async function wact(action, id, extra) {
    editing = 0;
    var r = await adminCall(Object.assign({ action: action, id: id }, extra || {}));
    if (!r.ok && r.status === 409) { haptic('error'); try { toast(t('Someone else already took or finished this one.', 'Это уже взял или закрыл кто-то другой.')); } catch (e) {} }
    else if (r.ok && r.data.payout && !r.data.payout.ok) { haptic('error'); try { toast(t('Auto payout did not go through: ', 'Автовыплата не прошла: ') + ((document.body.dataset.lang === 'ru' && NOTE_RU[r.data.payout.reason]) || r.data.payout.reason || '')); } catch (e) {} }
    else if (!r.ok) { haptic('error'); try { toast(t('Could not save. Check the transfer hash and try again.', 'Не удалось сохранить. Проверьте хеш перевода и повторите.')); } catch (e) {} }
    else haptic('success');
    loadAdmin(false);
  }
  function renderMini(boxId, cardId, rows) {
    var box = $(boxId); box.innerHTML = ''; $(cardId).hidden = !rows.length;
    rows.forEach(function (r) { box.appendChild(r); });
  }
  var NOTE_RU = {"not enough USDT on the deposit addresses": "на адресах клуба не хватает USDT — пополните пул или выплатите вручную", "not enough USDT on the deposit addresses (after the GasFree fee)": "на адресах клуба не хватает USDT (с учётом комиссии GasFree)", "auto payout is off (no wallet key)": "автовыплаты выключены: на сервере не задан ключ кошелька"};
  var editing = 0;   // a manager is typing in a card: do not redraw the queue under their fingers
  async function loadAdmin(full) {
    if (!staffRole) return;
    if (editing && Date.now() - editing < 120000 && !full) return;
    editing = 0;
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
  $('adm-wc').addEventListener('submit', function (e) {
    e.preventDefault();
    var m = $('adm-wc-msg'); m.hidden = true;
    var gg = $('adm-wc-gg').value.replace(/\D/g, ''), ch = $('adm-wc-chain').value, a = $('adm-wc-addr').value.trim();
    ask('File a wallet change for ID ' + fid(gg) + ' (' + ch + ')? It takes effect in 7 days, the player can cancel it.', 'Оформить смену кошелька для ID ' + fid(gg) + ' (' + ch + ')? Вступит в силу через 7 дней, игрок может отменить.', async function () {
      var r = await adminCall({ action: 'wallet_change', gg_id: gg, chain: ch, address: a });
      m.hidden = false;
      if (r.ok) { m.className = 'note'; m.innerHTML = bi('Filed. Takes effect on ', 'Оформлено. Вступит в силу ') + new Date(r.data.effective_at).toLocaleString('ru-RU'); $('adm-wc-addr').value = ''; }
      else { m.className = 'note bad'; m.textContent = r.data.error || 'error'; }
    });
  });
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
    return Promise.all([loadProfile(), loadAddress()]).then(loadWallets);
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
