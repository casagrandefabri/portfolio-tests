/* ── FADE PAGE TRANSITION ─────────────────────────────────────────────
   Snappy exit (power2.in, 360ms) → graceful reveal (expo.out, 900ms).
   Asymmetric easing is the style — page "lands" softly on arrival.
   Requires #pgtrans div in DOM (flash-blocker).
──────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var EXIT_MS  = 360;
  var ENTER_MS = 900;
  var SWIPE_PX = 55;
  var SWIPE_MS = 460;

  var block = document.getElementById('pgtrans');
  var busy  = false;

  /* ── Overlay helpers ────────────────────────────────────────────── */
  function block_set(op, pe) {
    if (!block) return;
    block.style.opacity      = op;
    block.style.pointerEvents = pe;
  }

  /* ── Exit: fade page to black ───────────────────────────────────── */
  function fadeOut(ms, cb) {
    block_set(0, 'all');
    gsap.to(block, {
      opacity:    1,
      duration:   ms / 1000,
      ease:       'power2.in',
      overwrite:  true,
      onComplete: cb
    });
  }

  /* ── Enter: reveal page from black ─────────────────────────────── */
  function fadeIn(ms, cb) {
    block_set(1, 'all');
    gsap.to(block, {
      opacity:  0,
      duration: ms / 1000,
      ease:     'expo.out',
      overwrite: true,
      onComplete: function () {
        block_set(0, 'none');
        if (cb) cb();
      }
    });
  }

  /* ── Navigate ───────────────────────────────────────────────────── */
  function go(href, dir) {
    if (busy) return;
    busy = true;
    sessionStorage.setItem('pg_dir', dir);
    fadeOut(EXIT_MS, function () { window.location.href = href; });
  }

  /* ── Entrance ───────────────────────────────────────────────────── */
  var arrivedFrom = sessionStorage.getItem('pg_dir');
  sessionStorage.removeItem('pg_dir');

  if (arrivedFrom) {
    if (arrivedFrom === 'to-case-study' && typeof gsap !== 'undefined') {
      /* Hide elements now (overlay still opaque — nothing visible changes).
         Animate them in while the overlay clears, so there is never a frame
         where elements snap from visible → invisible. */
      gsap.set('.cs-hero-img img',              { opacity: 0, scale: 1.04 });
      gsap.set('.cs-title',                     { opacity: 0, y: 26 });
      gsap.set('.cs-info-col',                  { opacity: 0, y: 14 });
      gsap.set('.cs-divider',                   { scaleX: 0, transformOrigin: 'left center' });
      gsap.set('.cs-rail-item,.cs-mobile-nav-item', { opacity: 0, x: -10 });

      /* Overlay fades gradually (power2.out) so the build plays through it */
      block_set(1, 'all');
      gsap.to(block, {
        opacity: 0, duration: 1.0, ease: 'power2.out', overwrite: true,
        onComplete: function () { block_set(0, 'none'); }
      });

      gsap.to('.cs-hero-img img', {
        opacity: 1, scale: 1,
        duration: 0.9, ease: 'expo.out', delay: 0.28, clearProps: 'all'
      });
      gsap.to('.cs-title', {
        opacity: 1, y: 0,
        duration: 0.7, ease: 'expo.out', delay: 0.37, clearProps: 'all'
      });
      gsap.to('.cs-info-col', {
        opacity: 1, y: 0,
        duration: 0.55, ease: 'expo.out', delay: 0.46, stagger: 0.065, clearProps: 'all'
      });
      gsap.to('.cs-divider', {
        scaleX: 1,
        duration: 0.65, ease: 'expo.out', delay: 0.72, clearProps: 'all'
      });
      gsap.to('.cs-rail-item,.cs-mobile-nav-item', {
        opacity: 1, x: 0,
        duration: 0.45, ease: 'expo.out', delay: 0.78, stagger: 0.05, clearProps: 'all'
      });
    } else {
      fadeIn(ENTER_MS, null);

      if (typeof gsap !== 'undefined') {
        if (arrivedFrom === 'to-projects') {
          gsap.from('.p-row', {
            opacity:  0,
            y:        14,
            duration: 0.55,
            stagger:  0.07,
            ease:     'power3.out',
            delay:    0.15,
            clearProps: 'all'
          });
          gsap.from('#p-footer', {
            opacity:  0,
            y:        8,
            duration: 0.45,
            ease:     'power3.out',
            delay:    0.62,
            clearProps: 'all'
          });
        }
      }
    }
  }

  /* ── Click interception ─────────────────────────────────────────── */

  /* Project rows → case study (exit: siblings fold away, overlay sweeps in) */
  document.querySelectorAll('a.p-row--active').forEach(function (row) {
    row.addEventListener('click', function (e) {
      e.preventDefault();
      var self = this;
      document.querySelectorAll('a.p-row--active').forEach(function (r) {
        if (r !== self) gsap.to(r, { opacity: 0, y: -7, duration: 0.26, ease: 'power2.in' });
      });
      go(self.getAttribute('href'), 'to-case-study');
    });
  });

  var fwd = document.querySelector('a.copy-btn[href="projects/"]');
  if (fwd) {
    fwd.addEventListener('click', function (e) {
      e.preventDefault();
      go(fwd.getAttribute('href'), 'to-projects');
    });
  }

  document.querySelectorAll('#g-nav-back, #g-nav-logo').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault();
      go(el.getAttribute('href'), 'to-index');
    });
  });

  /* ── Swipe gesture ──────────────────────────────────────────────── */
  var tx = 0, ty = 0, tt = 0;

  window.addEventListener('touchstart', function (e) {
    tx = e.touches[0].clientX;
    ty = e.touches[0].clientY;
    tt = Date.now();
  }, { passive: true });

  window.addEventListener('touchend', function (e) {
    var dx = e.changedTouches[0].clientX - tx;
    var dy = e.changedTouches[0].clientY - ty;
    if (Date.now() - tt > SWIPE_MS)         return;
    if (Math.abs(dx) < SWIPE_PX)            return;
    if (Math.abs(dy) > Math.abs(dx) * 0.65) return;
    if (dx < 0 && fwd)                       fwd.click();
    else if (dx > 0) {
      var back = document.getElementById('g-nav-back');
      if (back) back.click();
    }
  }, { passive: true });
})();
