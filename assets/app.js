// Zerake Telegram Mini App: deposit, withdraw, history.
(function () {
  var C = window.ZERAKE || {};
  var MIN_DEPOSIT = C.minDeposit || 10;
  var MIN_WITHDRAW = C.minWithdraw || 10;
  var TRON = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
  var tg = window.Telegram && window.Telegram.WebApp;
  var $ = function (id) { return document.getElementById(id); };
  var sb = null, me = null, ggId = '';

  function bi(en, ru) { return '<span class="en">' + en + '</span><span class="ru">' + ru + '</span>'; }
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
    ['deposit', 'withdraw', 'history'].forEach(function (n) { $('tab-' + n).hidden = n !== name; });
    if (name === 'history') loadHistory();
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
    $('dep-id').textContent = $('wd-id').textContent = ggId || '—';
    $('noid').hidden = !!ggId;
    $('wsubmit').disabled = !ggId;
  }
  async function loadAddress() {
    var r = await sb.from('deposit_addresses').select('address').eq('user_id', me.id).maybeSingle();
    var a = r.data && r.data.address;
    $('addr').textContent = a || '—';
    $('copy').disabled = !a;
    $('addr-note').textContent = a ? '' : t('Your personal address is being prepared. Check back in a moment.', 'Ваш личный адрес готовится. Загляните чуть позже.');
  }

  var rows = [];
  async function loadHistory() {
    var d = await sb.from('deposits').select('id,amount,status,created_at').eq('user_id', me.id).order('created_at', { ascending: false }).limit(30);
    var w = await sb.from('withdrawals').select('id,amount,status,created_at').eq('user_id', me.id).order('created_at', { ascending: false }).limit(30);
    rows = []
      .concat((d.data || []).map(function (x) { x.kind = 'dep'; return x; }))
      .concat((w.data || []).map(function (x) { x.kind = 'wd'; return x; }))
      .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
    renderHistory();
  }
  var LABEL = {
    received: ['Received, chips on the way', 'Получено, фишки в пути'], chips_sent: ['Chips sent', 'Фишки отправлены'],
    pending: ['Pending', 'В обработке'], approved: ['Approved', 'Одобрено'], paid: ['Paid', 'Выплачено'], rejected: ['Rejected', 'Отклонено']
  };
  function renderHistory() {
    var box = $('hist'); if (!box) return;
    box.innerHTML = '';
    if (!rows.length) { var e = document.createElement('div'); e.className = 'empty'; e.innerHTML = bi('Nothing here yet.', 'Пока пусто.'); box.appendChild(e); return; }
    rows.forEach(function (x) {
      var el = document.createElement('div'); el.className = 'item';
      var left = document.createElement('div');
      var title = document.createElement('div'); title.innerHTML = x.kind === 'dep' ? bi('Deposit', 'Депозит') : bi('Withdrawal', 'Вывод');
      var date = document.createElement('small'); date.textContent = new Date(x.created_at).toLocaleString(document.body.dataset.lang === 'ru' ? 'ru-RU' : 'en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      left.appendChild(title); left.appendChild(date);
      var right = document.createElement('div');
      var amt = document.createElement('div'); amt.className = 'amt'; amt.textContent = (x.kind === 'dep' ? '+' : '−') + Number(x.amount) + ' USDT';
      var st = document.createElement('div'); st.className = 'st' + (x.status === 'chips_sent' || x.status === 'paid' ? ' ok' : '');
      var lb = LABEL[x.status] || [x.status, x.status]; st.innerHTML = bi(lb[0], lb[1]);
      right.appendChild(amt); right.appendChild(st);
      el.appendChild(left); el.appendChild(right); box.appendChild(el);
    });
  }

  /* ---------- actions ---------- */
  $('copy').addEventListener('click', function () {
    var a = $('addr').textContent; if (!a || a === '—') return;
    var done = function () { haptic('success'); var b = $('copy'); b.innerHTML = bi('Copied', 'Скопировано'); setTimeout(function () { b.innerHTML = bi('Copy address', 'Скопировать адрес'); }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(a).then(done, function () {});
  });
  $('open-site').addEventListener('click', function () { try { tg.openLink('https://zerake.com/'); } catch (e) { window.open('https://zerake.com/', '_blank'); } });

  function wmsg(en, ru, bad) {
    var m = $('wmsg'); m.innerHTML = bi(en, ru); m.className = 'note' + (bad ? ' bad' : ''); m.hidden = false;
  }
  $('wform').addEventListener('submit', async function (e) {
    e.preventDefault();
    var amount = Number(String($('wamt').value).replace(',', '.'));
    var address = $('waddr').value.trim();
    if (!ggId) { wmsg('Add your ClubGG ID first.', 'Сначала добавьте ID в ClubGG.', true); return; }
    if (!(amount >= MIN_WITHDRAW)) { wmsg('Minimum withdrawal is ' + MIN_WITHDRAW + ' USDT.', 'Минимальный вывод: ' + MIN_WITHDRAW + ' USDT.', true); return; }
    if (!TRON.test(address)) { wmsg('Enter a valid TRC20 address (starts with T).', 'Введите корректный адрес TRC20 (начинается с T).', true); return; }
    $('wsubmit').disabled = true;
    var r = await sb.from('withdrawals').insert({ user_id: me.id, amount: amount, address: address });
    $('wsubmit').disabled = false;
    if (r.error) { haptic('error'); wmsg('Could not send the request. Please try again.', 'Не удалось отправить запрос. Попробуйте ещё раз.', true); return; }
    haptic('success');
    wmsg('Request sent. We will pay out after the chips are received.', 'Запрос отправлен. Выплатим после получения фишек.', false);
    $('wamt').value = ''; $('waddr').value = '';
  });

  /* ---------- start ---------- */
  $('min-dep').textContent = $('min-dep-ru').textContent = MIN_DEPOSIT;
  signIn().then(function (user) {
    me = user;
    var u = tg.initDataUnsafe && tg.initDataUnsafe.user;
    $('who').textContent = u ? (u.username ? '@' + u.username : (u.first_name || '')) : '';
    return Promise.all([loadProfile(), loadAddress()]);
  }).then(function () {
    $('splash').hidden = true; $('app').hidden = false;
  }).catch(function () {
    splashError('Could not sign you in. Please reopen the app.', 'Не удалось войти. Откройте приложение заново.');
  });
})();
