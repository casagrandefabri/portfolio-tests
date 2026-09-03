/* ─── SHARED CURSOR SYSTEM ──────────────────────────────────────────────── */
/* Requires GSAP to be loaded first. Place after gsap.min.js script tag.    */
/* Expects #cursor and #page-aura to be present in the page HTML.            */
(function () {
  'use strict';

  var cursorEl     = document.getElementById('cursor');
  var cursorInner  = document.getElementById('cursor-inner');
  var pageAuraEl   = document.getElementById('page-aura');
  var pageAuraInner = pageAuraEl ? document.getElementById('page-aura-inner') : null;

  if (!cursorEl) return;

  var isDesktop = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (!isDesktop) return;

  var pageAuraShown = false;
  var overButton    = false;
  var auraOverBtn   = false;

  /* Position cursor ring + page aura on every mouse move */
  document.addEventListener('mousemove', function (e) {
    cursorEl.style.transform = 'translate(' + (e.clientX - 15) + 'px,' + (e.clientY - 15) + 'px)';
    if (pageAuraEl) {
      pageAuraEl.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)';
      if (!pageAuraShown && !auraOverBtn) {
        pageAuraShown = true;
        gsap.to(pageAuraInner, { opacity: 1, duration: 0.25, ease: 'power2.out' });
      }
    }
  });

  document.addEventListener('mouseleave', function () {
    if (pageAuraEl && pageAuraShown) {
      pageAuraShown = false;
      gsap.to(pageAuraInner, { opacity: 0, duration: 0.22, ease: 'power2.out' });
    }
  });

  /* Cursor ring scale on press — context-aware: tighter over buttons */
  document.addEventListener('mousedown', function () {
    cursorInner.style.filter = 'brightness(1.5)';
    gsap.to(cursorInner, { scale: overButton ? 0.8 : 0.86, duration: 0.10, ease: 'power2.out', overwrite: true });
  });

  document.addEventListener('mouseup', function () {
    cursorInner.style.filter = '';
    gsap.to(cursorInner, { scale: overButton ? 0.9 : 1, duration: 0.20, ease: 'power2.out', overwrite: true });
  });

  /* Ring shrink + page-aura suppression on any interactive element hover */
  document.querySelectorAll('a, button, [tabindex="0"]').forEach(function (el) {
    el.addEventListener('pointerenter', function (e) {
      if (e.pointerType !== 'mouse') return;
      overButton  = true;
      auraOverBtn = true;
      gsap.to(cursorInner, { scale: 0.9, duration: 0.12, ease: 'power2.out', overwrite: true });
      if (pageAuraInner) gsap.to(pageAuraInner, { opacity: 0, duration: 0.18, ease: 'power2.out', overwrite: true });
    });
    el.addEventListener('pointerleave', function (e) {
      if (e.pointerType !== 'mouse') return;
      overButton  = false;
      auraOverBtn = false;
      gsap.to(cursorInner, { scale: 1.0, duration: 0.15, ease: 'power2.out', overwrite: true });
      if (pageAuraInner && pageAuraShown) gsap.to(pageAuraInner, { opacity: 1, duration: 0.25, ease: 'power2.out', overwrite: true });
    });
  });

  /* Per-button aura: radial glow tracking cursor within each [data-aura] element */
  document.querySelectorAll('[data-aura]').forEach(function (el) {
    var rect = null;
    var setVars = function (e) {
      el.style.setProperty('--mx', (e.clientX - rect.left) + 'px');
      el.style.setProperty('--my', (e.clientY - rect.top)  + 'px');
    };
    el.addEventListener('pointerenter', function (e) {
      if (e.pointerType === 'touch') return;
      rect = el.getBoundingClientRect();
      setVars(e);
      el.classList.add('is-aura-active');
    });
    el.addEventListener('pointermove',  function (e) { if (rect) setVars(e); });
    el.addEventListener('pointerleave', function ()  { el.classList.remove('is-aura-active'); rect = null; });
  });
})();
