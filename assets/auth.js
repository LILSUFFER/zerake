// Sign-in pop-up (Google + Telegram) and the account drop-down (ClubGG ID, language, sign out).
(function () {
  var C = window.ZERAKE || {};
  var configured = !!(C.supabaseUrl && C.supabaseAnonKey);
  var sb = null, session = null;

  var GOOGLE = '<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
  var TELEGRAM = '<svg width="20" height="20" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M21.94 4.34 18.7 19.6c-.24 1.08-.88 1.35-1.78.84l-4.92-3.63-2.37 2.29c-.26.26-.48.48-.99.48l.35-5.01 9.12-8.24c.4-.35-.09-.55-.61-.2L6.2 13.22 1.34 11.7c-1.06-.33-1.08-1.06.22-1.57L20.58 2.8c.88-.32 1.65.2 1.36 1.54z"/></svg>';
  var CHEVRON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  function bi(en, ru) { return '<span class="en">' + en + '</span><span class="ru">' + ru + '</span>'; }
  var $ = function (id) { return document.getElementById(id); };
  var opener = document.querySelector('[data-open-login]');

  /* ---------- sign-in pop-up ---------- */
  var modal = document.createElement('div');
  modal.className = 'zmodal';
  modal.hidden = true;
  modal.innerHTML =
    '<div class="zbackdrop" data-close></div>' +
    '<div class="zdialog" role="dialog" aria-modal="true" aria-labelledby="zt">' +
      '<button class="zclose" type="button" data-close aria-label="Close">&times;</button>' +
      '<h2 id="zt">' + bi('Sign in', 'Вход') + '</h2>' +
      '<p class="zsub">' + bi('Choose how you want to sign in.', 'Выберите, как войти.') + '</p>' +
      '<div class="zbtns">' +
        '<button class="zbtn google" type="button" id="zg">' + GOOGLE + bi('Continue with Google', 'Продолжить с Google') + '</button>' +
        '<button class="zbtn telegram" type="button" id="zt-btn">' + TELEGRAM + bi('Continue with Telegram', 'Продолжить с Telegram') + '</button>' +
      '</div>' +
      '<p class="zfoot">' + bi('We never ask for your ClubGG password.', 'Мы никогда не просим пароль от ClubGG.') + '</p>' +
      '<p class="znote" id="zmsg" hidden></p>' +
    '</div>';
  document.body.appendChild(modal);

  function note(el, en, ru, bad) {
    el.innerHTML = bi('', '');
    el.firstChild.textContent = en;
    el.lastChild.textContent = ru;
    el.className = 'znote' + (bad ? ' bad' : '');
    el.hidden = false;
  }
  function openModal() { $('zmsg').hidden = true; modal.hidden = false; document.body.style.overflow = 'hidden'; }
  function closeModal() { modal.hidden = true; document.body.style.overflow = ''; }
  function notReady() { note($('zmsg'), 'Sign-in is being set up and will be available soon.', 'Вход настраивается и скоро будет доступен.'); }

  modal.addEventListener('click', function (e) { if (e.target.hasAttribute('data-close')) closeModal(); });

  /* ---------- account drop-down ---------- */
  var menu = document.createElement('div');
  menu.className = 'zmenu';
  menu.hidden = true;
  menu.innerHTML =
    '<div class="zmhead"><div class="zav" id="zav"></div><div class="zmwho"><small>' + bi('Signed in as', 'Вы вошли как') + '</small><b id="zwho"></b></div></div>' +
    '<div class="zsep"></div>' +
    '<div class="zblock">' +
      '<div class="zlabel">' + bi('ClubGG ID', 'ID в ClubGG') + '</div>' +
      '<div class="zidview" id="zidview"><span class="zidtext" id="zidtext"></span><button class="zlink" type="button" id="zedit">' + bi('Change', 'Изменить') + '</button></div>' +
      '<form class="zidform" id="zform" hidden>' +
        '<input id="zid" inputmode="numeric" autocomplete="off" maxlength="10" placeholder="12345678">' +
        '<div class="zrow2"><button class="zbtn save" type="submit">' + bi('Save', 'Сохранить') + '</button><button class="zbtn plain" type="button" id="zcancel">' + bi('Cancel', 'Отмена') + '</button></div>' +
      '</form>' +
      '<details class="zdet"><summary>' + bi('Where to find your ID', 'Где найти свой ID') + '</summary><ol>' +
        '<li>' + bi('Open the ClubGG app.', 'Откройте приложение ClubGG.') + '</li>' +
        '<li>' + bi('Tap <b>Me</b> in the lower right corner of the lobby.', 'Нажмите <b>Me</b> в правом нижнем углу лобби.') + '</li>' +
        '<li>' + bi('In <b>Account Info</b> find <b>Player ID</b> and enter those digits.', 'В разделе <b>Account Info</b> найдите <b>Player ID</b> и введите эти цифры.') + '</li>' +
      '</ol></details>' +
      '<p class="znote" id="zmsg2" hidden></p>' +
    '</div>' +
    '<div class="zsep"></div>' +
    '<button class="zitem" type="button" id="zlang">' + bi('Language: English &rarr; Русский', 'Язык: Русский &rarr; English') + '</button>' +
    '<button class="zitem danger" type="button" id="zout">' + bi('Sign out', 'Выйти') + '</button>';
  document.body.appendChild(menu);

  function placeMenu() {
    var r = opener.getBoundingClientRect();
    menu.style.top = (r.bottom + 10) + 'px';
    menu.style.right = Math.max(12, document.documentElement.clientWidth - r.right) + 'px';
  }
  function openMenu() { placeMenu(); menu.hidden = false; }
  function closeMenu() { menu.hidden = true; }
  window.addEventListener('resize', function () { if (!menu.hidden) placeMenu(); });
  document.addEventListener('click', function (e) {
    if (!menu.hidden && !menu.contains(e.target) && !opener.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!modal.hidden) closeModal();
    if (!menu.hidden) closeMenu();
  });

  opener.addEventListener('click', function () {
    if (session) { menu.hidden ? openMenu() : closeMenu(); } else { openModal(); }
  });
  $('zlang').addEventListener('click', function () { $('lang').click(); });

  /* ---------- helpers ---------- */
  function who(user) {
    var md = user.user_metadata || {};
    if (md.provider === 'telegram') return md.username ? '@' + md.username : (md.first_name || 'Telegram');
    return user.email || md.name || '';
  }
  function setOpenerLoggedIn(on) {
    if (!on) { opener.innerHTML = bi('Sign in', 'Войти'); opener.classList.remove('logged'); return; }
    var w = who(session.user);
    var span = document.createElement('span');
    span.className = 'zname';
    span.textContent = w.length > 16 ? w.slice(0, 15) + '…' : w;
    opener.innerHTML = '';
    opener.appendChild(span);
    opener.insertAdjacentHTML('beforeend', CHEVRON);
    opener.classList.add('logged');
  }
  function showId(value) {
    $('zid').value = value || '';
    if (value) {
      $('zidtext').textContent = value;
      $('zidview').hidden = false; $('zform').hidden = true;
    } else {
      $('zidtext').textContent = '';
      $('zidview').hidden = true; $('zform').hidden = false;
    }
  }

  if (!configured) {
    $('zg').addEventListener('click', notReady);
    $('zt-btn').addEventListener('click', notReady);
    return;
  }

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.async = true; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  async function render(sess) {
    session = sess;
    setOpenerLoggedIn(!!sess);
    if (!sess) { closeMenu(); return; }
    closeModal();
    $('zwho').textContent = who(sess.user);
    $('zav').textContent = (who(sess.user).replace('@', '')[0] || '?').toUpperCase();
    $('zmsg2').hidden = true;
    var r = await sb.from('profiles').select('gg_id').eq('user_id', sess.user.id).maybeSingle();
    var id = (r.data && r.data.gg_id) || '';
    showId(id);
    if (!id) promptOnce();
  }

  // open the menu with the ID field right after the first sign-in of a session
  function promptOnce() {
    try { if (sessionStorage.getItem('zerake-idprompt')) return; sessionStorage.setItem('zerake-idprompt', '1'); } catch (e) {}
    openMenu();
    setTimeout(function () { $('zid').focus(); }, 60);
  }

  var ready = window.supabase ? Promise.resolve() : loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
  ready.then(function () {
    sb = window.supabase.createClient(C.supabaseUrl, C.supabaseAnonKey);

    $('zg').addEventListener('click', async function () {
      try {
        var st = await (await fetch(C.supabaseUrl + '/auth/v1/settings', { headers: { apikey: C.supabaseAnonKey } })).json();
        if (!st.external || !st.external.google) { notReady(); return; }
      } catch (e) { notReady(); return; }
      sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
    });

    $('zt-btn').addEventListener('click', async function () {
      if (!C.telegramBotId) { notReady(); return; }
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
          } catch (e) {
            note($('zmsg'), 'Telegram sign-in failed. Please try again.', 'Не удалось войти через Telegram. Попробуйте ещё раз.', true);
          }
        });
      } catch (e) {
        note($('zmsg'), 'Could not load Telegram. Please try again.', 'Не удалось загрузить Telegram. Попробуйте ещё раз.', true);
      }
    });

    $('zedit').addEventListener('click', function () { $('zidview').hidden = true; $('zform').hidden = false; $('zid').focus(); });
    $('zcancel').addEventListener('click', function () { if ($('zidtext').textContent) { $('zform').hidden = true; $('zidview').hidden = false; } });

    $('zform').addEventListener('submit', async function (e) {
      e.preventDefault();
      var id = $('zid').value.trim();
      if (!/^[0-9]{5,10}$/.test(id)) { note($('zmsg2'), 'The ID must be 5–10 digits.', 'ID должен состоять из 5–10 цифр.', true); return; }
      var u = (await sb.auth.getUser()).data.user;
      var r = await sb.from('profiles').upsert({ user_id: u.id, gg_id: id, updated_at: new Date().toISOString() });
      if (r.error) { note($('zmsg2'), 'Could not save. Please try again.', 'Не удалось сохранить. Попробуйте ещё раз.', true); return; }
      showId(id);
      note($('zmsg2'), 'Saved.', 'Сохранено.', false);
    });

    $('zout').addEventListener('click', function () { closeMenu(); sb.auth.signOut(); });

    sb.auth.onAuthStateChange(function (_e, s) { render(s); });
    sb.auth.getSession().then(function (r) { render(r.data.session); });
  }).catch(function () {
    $('zg').addEventListener('click', notReady);
    $('zt-btn').addEventListener('click', notReady);
  });
})();
