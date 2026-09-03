/* ── SHARED CASE STUDY JS ──────────────────────────────────────────────────
   Reads window.CASE_CONFIG defined by each project page before this script.
   Config shape:
   {
     slug: 'plaiar',
     ringCount: 7,
     nextProject: { name: 'METAPATIENT', path: '../metapatient/', restricted: false },
     projectInfo: {
       phrases: ['Phrase one.', 'Phrase two.'],
       meta: [
         { label: 'Contribution', value: 'Co-founder & Product Designer' },
         ...
       ]
     }
   }
────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var CFG = window.CASE_CONFIG || {};

  /* ── Constants ──────────────────────────────────────────────── */
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── Build hero info overlay from CASE_CONFIG.projectInfo ───── */
  (function buildInfoOverlay() {
    var cnt = document.getElementById('hero-info-content');
    if (!cnt) return;
    var info = CFG.projectInfo;
    if (!info) return;

    var html = '';

    /* Phrases */
    var phrases = info.phrases || [];
    phrases.forEach(function (ph) {
      html += '<p class="hi-phrase">' + ph + '</p>';
    });

    /* Meta */
    var meta = info.meta || [];
    if (meta.length) {
      html += '<div class="hi-meta">';
      meta.forEach(function (item, i) {
        html += '<p class="hi-label">' + item.label + '</p>';
        /* Value can be a string or array of strings */
        var vals = Array.isArray(item.value) ? item.value : [item.value];
        vals.forEach(function (v) {
          html += '<p class="hi-value">' + v + '</p>';
        });
      });
      html += '</div>';
    }

    cnt.innerHTML = html;
  })();

  /* ── Element refs ────────────────────────────────────────────── */
  var heroBgWrap = document.querySelector('.hero-bg-wrap');
  var heroPhone  = document.querySelector('.hero-phone');
  var scenes     = Array.from(document.querySelectorAll('.scene'));
  var ringFills  = Array.from(document.querySelectorAll('.scene-ring-fill'));

  /* ── Triangle icon path length (measured once) ─────────────── */
  var RING_C = (function () {
    var tmp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tmp.setAttribute('d', 'M9.39062 3.14355C9.88428 2.2855 11.1157 2.2855 11.6094 3.14355L19.3252 16.5654C19.8208 17.4281 19.199 18.4998 18.2158 18.5H2.78418C1.80103 18.4998 1.17919 17.4281 1.6748 16.5654L9.39062 3.14355Z');
    document.body.appendChild(tmp);
    var len = tmp.getTotalLength();
    document.body.removeChild(tmp);
    return len;
  })();

  /* ── Initialise ring stroke-dasharray ──────────────────────── */
  ringFills.forEach(function (el) {
    el.style.strokeDasharray  = RING_C;
    el.style.strokeDashoffset = RING_C;
  });

  /* ── Scroll state ────────────────────────────────────────────── */
  var raf = null;

  /* Global progress across all scenes [0..1] */
  function globalProgress() {
    if (!scenes.length) return 0;
    var first = scenes[0].getBoundingClientRect().top;
    var last  = scenes[scenes.length - 1].getBoundingClientRect().bottom;
    var total = last - first;
    if (total <= 0) return 0;
    return Math.max(0, Math.min(1, -first / total));
  }

  /* ── Next-project navigation ─────────────────────────────────── */
  var nextCfg    = CFG.nextProject || {};
  var NEXT_HREF  = nextCfg.path || '';
  var RESTRICTED = nextCfg.restricted === true;
  var FALLBACK   = '/projects/plaiar/';
  var nextScroll = document.getElementById('cs-next-scroll');
  var barFill    = document.getElementById('cs-next-bar-fill');
  var labelEl    = document.getElementById('cs-next-label');
  var nextBgImg  = document.querySelector('.cs-next-bg-img');
  var navigating = false;
  var navTimer   = null;
  var navEnabled = false;
  setTimeout(function () { navEnabled = true; }, 600);

  /* Update cs-next name from config */
  (function () {
    var nameEl = document.querySelector('.cs-next-name');
    if (nameEl && nextCfg.name) nameEl.textContent = nextCfg.name;
  })();

  function getNextProgress() {
    if (!nextScroll) return 0;
    var rect = nextScroll.getBoundingClientRect();
    var dist = nextScroll.offsetHeight - window.innerHeight;
    if (dist <= 0) return 0;
    return Math.max(0, Math.min(1, -rect.top / dist));
  }

  function doNavigate(href) {
    navigating = true;
    var block = document.getElementById('pgtrans');
    if (block) {
      block.style.pointerEvents = 'all';
      sessionStorage.setItem('pg_dir', 'to-case-study');
      if (typeof gsap !== 'undefined') {
        gsap.to(block, { opacity: 1, duration: 0.36, ease: 'power2.in',
          onComplete: function () { window.location.href = href; } });
      } else {
        block.style.opacity = '1';
        setTimeout(function () { window.location.href = href; }, 360);
      }
    } else { window.location.href = href; }
  }

  function navigate() {
    if (!NEXT_HREF) return;
    if (RESTRICTED) {
      fetch('/auth/check')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          doNavigate(data && data.authenticated ? NEXT_HREF : FALLBACK);
        })
        .catch(function () { doNavigate(FALLBACK); });
    } else {
      doNavigate(NEXT_HREF);
    }
  }

  function renderNext() {
    if (REDUCED) return;
    var p = getNextProgress();
    if (barFill) barFill.style.transform = 'scaleX(' + p + ')';
    if (nextBgImg) {
      nextBgImg.style.opacity = String(0.1 + p * 0.9);
    }
    if (p >= 0.88 && !navigating && navEnabled) {
      if (!navTimer) navTimer = setTimeout(function () {
        navTimer = null;
        if (!navigating && getNextProgress() >= 0.75) navigate();
      }, 350);
    } else if (p < 0.75 && !navigating) {
      if (navTimer) { clearTimeout(navTimer); navTimer = null; }
    }
  }

  /* ── Parallax render ─────────────────────────────────────────── */
  function render() {
    raf = null;
    renderNext();
    if (REDUCED) return;

    /* Hero parallax */
    if (heroBgWrap) {
      var heroEl = document.getElementById('hero');
      if (heroEl) {
        var heroRect = heroEl.getBoundingClientRect();
        var heroT    = Math.max(0, Math.min(1, -heroRect.top / heroRect.height));
        heroBgWrap.style.transform = 'translateY(' + (heroT * 80) + 'px)';
        if (heroPhone) {
          heroPhone.style.transform = 'translateX(-50%) translateY(' + (heroT * -20) + 'px)';
        }
      }
    }

    /* Per-scene parallax */
    var vh = window.innerHeight;
    scenes.forEach(function (scene) {
      var rect = scene.getBoundingClientRect();
      var mid  = rect.top + rect.height / 2;
      var t    = (vh / 2 - mid) / (vh / 2 + rect.height / 2);
      t = Math.max(-1, Math.min(1, t));
      var px = t * 45;
      scene.querySelectorAll('[data-parallax]').forEach(function (wrap) {
        if (wrap.classList.contains('s-gameplay-wrap') && window.innerWidth <= 960) {
          var sc = Math.min(0.8, (window.innerWidth - 32) / 406);
          wrap.style.transform = 'translateY(' + px + 'px) scale(' + sc + ')';
        } else {
          wrap.style.transform = 'translateY(' + px + 'px)';
        }
      });
    });

    /* Icon ring global progress */
    var gp     = globalProgress();
    var offset = RING_C * (1 - gp);
    ringFills.forEach(function (el) {
      el.style.strokeDashoffset = offset;
    });
  }

  function onScroll() {
    if (!raf) raf = requestAnimationFrame(render);
  }

  /* ── Hero info overlay ───────────────────────────────────────── */
  (function () {
    var ov   = document.getElementById('hero-info-ov');
    var scr  = document.getElementById('hero-info-scroll');
    var cnt  = document.getElementById('hero-info-content');
    var cls  = document.getElementById('hero-info-close');
    if (!ov || !scr || !cnt || !cls) return;

    var isOpen = false, savedY = 0;

    function getPhrases() {
      return Array.from(cnt.querySelectorAll('.hi-phrase'));
    }

    function highlight() {
      var phrases = getPhrases();
      var ry = window.innerHeight * 0.38, ai = 0;
      phrases.forEach(function (p, i) { if (p.getBoundingClientRect().top <= ry) ai = i; });
      phrases.forEach(function (p, i) { p.classList.toggle('is-active', i === ai); });
    }
    scr.addEventListener('scroll', highlight, { passive: true });

    function open() {
      if (isOpen) return;
      isOpen = true; savedY = window.scrollY;
      document.documentElement.classList.add('scroll-locked');
      scr.scrollTop = 0;
      ov.setAttribute('aria-hidden', 'false');
      ov.classList.add('is-open');
      highlight();
      if (typeof gsap !== 'undefined') {
        gsap.killTweensOf(ov);
        gsap.to(ov, { opacity: 1, duration: 0.4, ease: 'expo.out' });
      } else {
        ov.style.opacity = '1';
      }
      cls.focus();
    }
    function close() {
      if (!isOpen) return;
      isOpen = false;
      if (typeof gsap !== 'undefined') {
        gsap.killTweensOf(ov);
        gsap.to(ov, { opacity: 0, duration: 0.3, ease: 'expo.in', onComplete: function () {
          ov.classList.remove('is-open');
          ov.setAttribute('aria-hidden', 'true');
          document.documentElement.classList.remove('scroll-locked');
          window.scrollTo(0, savedY);
        }});
      } else {
        ov.style.opacity = '0';
        ov.classList.remove('is-open');
        ov.setAttribute('aria-hidden', 'true');
        document.documentElement.classList.remove('scroll-locked');
        window.scrollTo(0, savedY);
      }
    }

    cls.addEventListener('click', close);
    ov.addEventListener('click', function (e) {
      if (!cnt.contains(e.target) && !cls.contains(e.target)) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen) close();
    });

    var expandBtn = document.getElementById('hero-expand-btn');
    if (expandBtn) expandBtn.addEventListener('click', open);
    var mobBtn = document.querySelector('.hero-mob-btn');
    if (mobBtn) mobBtn.addEventListener('click', open);

    /* bfcache restore: if the overlay was open when the user navigated away,
       the scroll-locked class and panel state persist. Reset without animation. */
    window.addEventListener('pageshow', function (e) {
      if (!e.persisted) return;
      isOpen = false;
      document.documentElement.classList.remove('scroll-locked');
      if (ov) {
        ov.classList.remove('is-open');
        ov.setAttribute('aria-hidden', 'true');
        if (typeof gsap !== 'undefined') gsap.set(ov, { opacity: 0 });
        else ov.style.opacity = '0';
      }
    });
  })();

  /* ── Expand info panels ──────────────────────────────────────── */
  document.querySelectorAll('.scene-expand-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var panel = document.getElementById(btn.getAttribute('data-info'));
      if (!panel) return;
      panel.classList.add('is-open');
      panel.setAttribute('aria-hidden', 'false');
    });
  });
  document.querySelectorAll('.scene-close-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var panel = document.getElementById(btn.getAttribute('data-info'));
      if (!panel) return;
      panel.classList.remove('is-open');
      panel.setAttribute('aria-hidden', 'true');
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.scene-info.is-open').forEach(function (p) {
      p.classList.remove('is-open');
      p.setAttribute('aria-hidden', 'true');
    });
  });

  /* ── RAF loop ────────────────────────────────────────────────── */
  window.addEventListener('scroll', onScroll, { passive: true });
  new ResizeObserver(function () {
    if (!raf) raf = requestAnimationFrame(render);
  }).observe(document.documentElement);
  render();
  renderNext();

  /* bfcache restore: navigating flag and navTimer persist from the previous
     visit, which would prevent scroll-to-next from ever firing again. */
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    navigating = false;
    if (navTimer) { clearTimeout(navTimer); navTimer = null; }
    navEnabled = false;
    setTimeout(function () { navEnabled = true; }, 600);
  });

})();
