// language toggle (English by default)
(function () {
  var btn = document.getElementById('lang');
  function set(l) {
    document.body.dataset.lang = l;
    document.documentElement.lang = l;
    btn.textContent = l === 'en' ? 'RU' : 'EN';
    try { localStorage.setItem('zerake-lang', l); } catch (e) {}
  }
  var saved = 'en';
  try { saved = localStorage.getItem('zerake-lang') || 'en'; } catch (e) {}
  set(saved);
  btn.addEventListener('click', function () { set(document.body.dataset.lang === 'ru' ? 'en' : 'ru'); });
})();

// copy buttons
document.querySelectorAll('[data-copy]').forEach(function (b) {
  b.addEventListener('click', function () {
    var done = function () {
      var en = b.querySelector('.en'), ru = b.querySelector('.ru');
      var o1 = en.textContent, o2 = ru.textContent;
      en.textContent = 'Copied'; ru.textContent = 'Скопировано';
      setTimeout(function () { en.textContent = o1; ru.textContent = o2; }, 1500);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(b.dataset.copy).then(done, function () {});
  });
});

// starry sky
(function () {
  var cv = document.getElementById('stars'), ctx = cv.getContext('2d'), W, H, stars = [];
  function resize() {
    var dpr = window.devicePixelRatio || 1;
    W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = Array.from({ length: Math.round(W * H / 6000) }, function () {
      return {
        x: Math.random() * W, y: Math.random() * H,
        r: Math.random() < 0.9 ? 0.5 + Math.random() * 0.6 : 1.1 + Math.random() * 0.6,
        a: 0.15 + Math.random() * 0.55, s: 0.0005 + Math.random() * 0.0015, p: Math.random() * 6.28
      };
    });
  }
  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    stars.forEach(function (st) {
      ctx.globalAlpha = st.a * (0.55 + 0.45 * Math.sin(t * st.s + st.p));
      ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, 6.2832);
      ctx.fillStyle = '#fff'; ctx.fill();
    });
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) requestAnimationFrame(draw);
  }
  addEventListener('resize', resize);
  resize(); requestAnimationFrame(draw);
})();
