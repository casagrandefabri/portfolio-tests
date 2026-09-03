/* ─── SHARED NAV SCROLL BEHAVIOR ────────────────────────────────────────── */
/* Hysteresis: compact at 50px down, restore at 20px — prevents flicker.    */
(function () {
  'use strict';

  var nav = document.getElementById('g-nav');
  if (!nav) return;

  var COMPACT_AT = 50;
  var RESTORE_AT = 20;
  var compact    = false;
  var ticking    = false;

  function update() {
    var y = window.scrollY;
    if (!compact && y > COMPACT_AT) {
      compact = true;
      nav.classList.add('is-compact');
    } else if (compact && y <= RESTORE_AT) {
      compact = false;
      nav.classList.remove('is-compact');
    }
    ticking = false;
  }

  window.addEventListener('scroll', function () {
    if (!ticking) {
      requestAnimationFrame(update);
      ticking = true;
    }
  }, { passive: true });

  update();
})();
