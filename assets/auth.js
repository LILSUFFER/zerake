// Sign-in pop-up (Google + Telegram) and ClubGG ID. Works on every page.
(function () {
  var C = window.ZERAKE || {};
  var configured = !!(C.supabaseUrl && C.supabaseAnonKey);
  var sb = null;

  var GOOGLE = '<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
  var TELEGRAM = '<svg width="20" height="20" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M21.94 4.34 18.7 19.6c-.24 1.08-.88 1.35-1.78.84l-4.92-3.63-2.37 2.29c-.26.26-.48.48-.99.48l.35-5.01 9.12-8.24c.4-.35-.09-.55-.61-.2L6.2 13.22 1.34 11.7c-1.06-.33-1.08-1.06.22-1.57L20.58 2.8c.88-.32 1.65.2 1.36 1.54z"/></svg>';

  function bi(en, ru) { return '<span class="en">' + en + '</span><span class="ru">' + ru + '</span>'; }

  var root = document.createElement('div');
  root.className = 'zmodal';
  root.hidden = true;
  root.innerHTML =
    '<div class="zbackdrop" data-close></div>' +
    '<div class="zdialog" role="dialog" aria-modal="true" aria-labelledby="zt">' +
      '<button class="zclose" type="button" data-close aria-label="Close">&times;</button>' +
      '<div id="zin">' +
        '<h2 id="zt">' + bi('Sign in', 'Вход') + '</h2>' +
        '<p class="zsub">' + bi('Choose how you want to sign in.', 'Выберите, как войти.') + '</p>' +
        '<div class="zbtns">' +
          '<button class="zbtn google" type="button" id="zg">' + GOOGLE + bi('Continue with Google', 'Продолжить с Google') + '</button>' +
          '<button class="zbtn telegram" type="button" id="zt-btn">' + TELEGRAM + bi('Continue with Telegram', 'Продолжить с Telegram') + '</button>' +
        '</div>' +
        '<p class="zfoot">' + bi('We never ask for your ClubGG password.', 'Мы никогда не просим пароль от ClubGG.') + '</p>' +
      '</div>' +
      '<div id="zacc" hidden>' +
        '<h2>' + bi('Your account', 'Ваш аккаунт') + '</h2>' +
        '<p class="zwho">' + bi('Signed in as', 'Вы вошли как') + ' <b id="zwho"></b></p>' +
        '<form class="zform" id="zform">' +
          '<label for="zid">' + bi('Your ClubGG ID', 'Ваш ID в ClubGG') + '</label>' +
          '<input id="zid" inputmode="numeric" autocomplete="off" maxlength="10" placeholder="12345678">' +
          '<button class="zbtn save" type="submit">' + bi('Save', 'Сохранить') + '</button>' +
          '<button class="zbtn plain" type="button" id="zout">' + bi('Sign out', 'Выйти') + '</button>' +
        '</form>' +
      '</div>' +
      '<p class="znote" id="zmsg" hidden></p>' +
    '</div>';
  document.body.appendChild(root);

  var $ = function (id) { return document.getElementById(id); };
  var openers = document.querySelectorAll('[data-open-login]');

  function msg(en, ru, bad) {
    var m = $('zmsg');
    m.innerHTML = bi('', '');
    m.firstChild.textContent = en;
    m.lastChild.textContent = ru;
    m.className = 'znote' + (bad ? ' bad' : '');
    m.hidden = false;
  }
  function clearMsg() { $('zmsg').hidden = true; }
  function open() { clearMsg(); root.hidden = false; document.body.style.overflow = 'hidden'; }
  function close() { root.hidden = true; document.body.style.overflow = ''; }
  function notReady() { msg('Sign-in is being set up and will be available soon.', 'Вход настраивается и скоро будет доступен.'); }

  openers.forEach(function (b) { b.addEventListener('click', open); });
  root.addEventListener('click', function (e) { if (e.target.hasAttribute('data-close')) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !root.hidden) close(); });

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.async = true; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  if (!configured) {
    $('zg').addEventListener('click', notReady);
    $('zt-btn').addEventListener('click', notReady);
    return;
  }

  function who(user) {
    var md = user.user_metadata || {};
    if (md.provider === 'telegram') return md.username ? '@' + md.username : (md.first_name || 'Telegram');
    return user.email || md.name || '';
  }

  async function render(session) {
    var on = !!session;
    $('zin').hidden = on;
    $('zacc').hidden = !on;
    openers.forEach(function (b) {
      if (on) { var w = who(session.user); b.textContent = w.length > 14 ? w.slice(0, 13) + '…' : w; }
    });
    if (!on) return;
    $('zwho').textContent = who(session.user);
    var r = await sb.from('profiles').select('gg_id').eq('user_id', session.user.id).maybeSingle();
    $('zid').value = (r.data && r.data.gg_id) || '';
  }

  loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2').then(function () {
    sb = window.supabase.createClient(C.supabaseUrl, C.supabaseAnonKey);

    $('zg').addEventListener('click', function () {
      sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
    });

    $('zt-btn').addEventListener('click', async function () {
      if (!C.telegramBotId) { notReady(); return; }
      try {
        if (!window.Telegram || !window.Telegram.Login) await loadScript('https://telegram.org/js/telegram-widget.js?22');
        window.Telegram.Login.auth({ bot_id: C.telegramBotId, request_access: 'write' }, async function (user) {
          if (!user) return;
          try {
            var r = await fetch(C.supabaseUrl + '/functions/v1/telegram-auth', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', apikey: C.supabaseAnonKey, Authorization: 'Bearer ' + C.supabaseAnonKey },
              body: JSON.stringify(user)
            });
            var d = await r.json();
            if (!r.ok || !d.token_hash) throw new Error('telegram');
            var v = await sb.auth.verifyOtp({ token_hash: d.token_hash, type: 'magiclink' });
            if (v.error) throw v.error;
          } catch (e) {
            msg('Telegram sign-in failed. Please try again.', 'Не удалось войти через Telegram. Попробуйте ещё раз.', true);
          }
        });
      } catch (e) {
        msg('Could not load Telegram. Please try again.', 'Не удалось загрузить Telegram. Попробуйте ещё раз.', true);
      }
    });

    $('zform').addEventListener('submit', async function (e) {
      e.preventDefault();
      var id = $('zid').value.trim();
      if (!/^[0-9]{5,10}$/.test(id)) { msg('The ID must be 5–10 digits.', 'ID должен состоять из 5–10 цифр.', true); return; }
      var u = (await sb.auth.getUser()).data.user;
      var r = await sb.from('profiles').upsert({ user_id: u.id, gg_id: id, updated_at: new Date().toISOString() });
      if (r.error) msg('Could not save. Please try again.', 'Не удалось сохранить. Попробуйте ещё раз.', true);
      else msg('Saved.', 'Сохранено.', false);
    });

    $('zout').addEventListener('click', function () { sb.auth.signOut(); close(); });

    sb.auth.onAuthStateChange(function (_e, session) { render(session); });
    sb.auth.getSession().then(function (r) { render(r.data.session); });
  }).catch(function () {
    $('zg').addEventListener('click', notReady);
    $('zt-btn').addEventListener('click', notReady);
  });
})();
