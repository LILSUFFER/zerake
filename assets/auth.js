(function () {
  var C = window.ZERAKE || {};
  var $ = function (id) { return document.getElementById(id); };
  var show = function (id, on) { $(id).hidden = !on; };

  // bilingual status line
  function msg(en, ru, bad) {
    var m = $('msg');
    m.innerHTML = '<span class="en"></span><span class="ru"></span>';
    m.firstChild.textContent = en;
    m.lastChild.textContent = ru;
    m.className = 'note' + (bad ? ' bad' : '');
    m.hidden = false;
  }

  if (!C.supabaseUrl || !C.supabaseAnonKey || !window.supabase) { show('notready', true); return; }
  var sb = window.supabase.createClient(C.supabaseUrl, C.supabaseAnonKey);

  function who(user) {
    var md = user.user_metadata || {};
    if (md.provider === 'telegram') return md.username ? '@' + md.username : (md.first_name || 'Telegram');
    return user.email || md.name || '';
  }

  async function render(session) {
    var on = !!session;
    show('signin', !on);
    show('account', on);
    if (!on) return;
    $('who').textContent = who(session.user);
    var r = await sb.from('profiles').select('gg_id').eq('user_id', session.user.id).maybeSingle();
    $('ggid').value = (r.data && r.data.gg_id) || '';
  }

  // Google
  $('google').addEventListener('click', function () {
    sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + '/login/' } });
  });

  // Telegram
  if (C.telegramBot) {
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://telegram.org/js/telegram-widget.js?22';
    s.setAttribute('data-telegram-login', C.telegramBot);
    s.setAttribute('data-size', 'large');
    s.setAttribute('data-radius', '100');
    s.setAttribute('data-onauth', 'onTelegramAuth(user)');
    $('tg').appendChild(s);
  }
  window.onTelegramAuth = async function (user) {
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
  };

  // Save ClubGG ID
  $('idform').addEventListener('submit', async function (e) {
    e.preventDefault();
    var id = $('ggid').value.trim();
    if (!/^[0-9]{5,10}$/.test(id)) {
      msg('The ID must be 5–10 digits.', 'ID должен состоять из 5–10 цифр.', true);
      return;
    }
    var u = (await sb.auth.getUser()).data.user;
    var r = await sb.from('profiles').upsert({ user_id: u.id, gg_id: id, updated_at: new Date().toISOString() });
    if (r.error) msg('Could not save. Please try again.', 'Не удалось сохранить. Попробуйте ещё раз.', true);
    else msg('Saved.', 'Сохранено.', false);
  });

  $('signout').addEventListener('click', function () { sb.auth.signOut(); });

  sb.auth.onAuthStateChange(function (_e, session) { render(session); });
  sb.auth.getSession().then(function (r) { render(r.data.session); });
})();
