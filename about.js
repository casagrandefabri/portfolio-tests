(function () {
  'use strict';

  const PHRASES = [
    'Fabrizio Casagrande is an Interactive Designer and innovation strategist based in Montevideo, working across product design, AI, and immersive experiences. He creates learning products, conversational AI services, and operational tools, turning complex ideas into clear systems.',
    'With a Master’s in Innovation & Entrepreneurship, his practice combines design craft, product thinking, and business perspective to explore new ways people learn, decide, and interact with technology.',
    'Art above everything.',
    'Stay curious.   No bullshit.'
  ];

  const READING_RATIO = 0.38;

  // --- CSS ---
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    #about-ov {
      position: fixed; inset: 0; z-index: 500;
      background: rgba(19, 20, 23, 0.5);
      -webkit-backdrop-filter: blur(40px);
      backdrop-filter: blur(40px);
      opacity: 0;
      pointer-events: none;
    }
    #about-ov.is-open { pointer-events: auto; }

    #about-scroll {
      position: absolute; inset: 0;
      overflow-y: auto; overflow-x: hidden;
      -webkit-overflow-scrolling: touch;
    }

    #about-content {
      padding-top: 35vh;
      padding-bottom: 50vh;
      padding-left: clamp(24px, 2.5vw, 40px);
      padding-right: clamp(24px, 2.5vw, 40px);
      max-width: 1091px;
    }

    .about-phrase {
      font-family: 'Red Hat Mono', ui-monospace, monospace;
      font-size: clamp(18px, 2.4vw, 40px);
      line-height: 1.625;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.14);
      margin: 0;
      max-width: 1051px;
      transition: color 0.3s ease;
    }
    .about-phrase + .about-phrase { margin-top: 65px; }
    .about-phrase:nth-child(3) { margin-top: 130px; }
    .about-phrase.is-active { color: rgba(255, 255, 255, 1); }

    #about-close {
      position: fixed;
      top: 32px; right: 40px;
      width: 44px; height: 44px;
      background: none; border: none;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      color: rgba(255, 255, 255, 0.5);
      z-index: 501;
      padding: 0;
      transition: color 0.2s ease;
    }
    #about-close:hover { color: rgba(255, 255, 255, 1); }
    #about-close:focus { outline: none; }
    #about-close:focus-visible { box-shadow: 0 0 0 1px rgba(255,255,255,0.55); border-radius: 4px; }
  `;
  document.head.appendChild(styleEl);

  // --- DOM ---
  const overlayEl = document.createElement('div');
  overlayEl.id = 'about-ov';
  overlayEl.setAttribute('role', 'dialog');
  overlayEl.setAttribute('aria-modal', 'true');
  overlayEl.setAttribute('aria-label', 'About Fabrizio Casagrande');

  const closeBtn = document.createElement('button');
  closeBtn.id = 'about-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true"><path d="M17 5L5 17M5 5L17 17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

  const scrollEl = document.createElement('div');
  scrollEl.id = 'about-scroll';

  const contentEl = document.createElement('div');
  contentEl.id = 'about-content';

  PHRASES.forEach(function (text) {
    var p = document.createElement('p');
    p.className = 'about-phrase';
    p.textContent = text;
    contentEl.appendChild(p);
  });

  scrollEl.appendChild(contentEl);
  overlayEl.appendChild(closeBtn);
  overlayEl.appendChild(scrollEl);
  document.body.appendChild(overlayEl);

  // --- Highlight logic ---
  var phrases = Array.from(contentEl.querySelectorAll('.about-phrase'));

  function updateHighlight() {
    var readingY = window.innerHeight * READING_RATIO;
    var activeIdx = 0;
    phrases.forEach(function (p, i) {
      if (p.getBoundingClientRect().top <= readingY) activeIdx = i;
    });
    phrases.forEach(function (p, i) {
      p.classList.toggle('is-active', i === activeIdx || (activeIdx >= 2 && i >= 2));
    });
  }

  scrollEl.addEventListener('scroll', updateHighlight, { passive: true });

  // --- Open / Close ---
  var isOpen = false;
  var savedScrollY = 0;

  function open() {
    if (isOpen) return;
    isOpen = true;
    savedScrollY = window.scrollY;
    document.body.style.overflow = 'hidden';
    scrollEl.scrollTop = 0;
    overlayEl.classList.add('is-open');
    updateHighlight();
    if (window.gsap) {
      gsap.killTweensOf(overlayEl);
      gsap.to(overlayEl, { opacity: 1, duration: 0.4, ease: 'expo.out' });
    } else {
      overlayEl.style.opacity = '1';
    }
    closeBtn.focus();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;

    function afterClose() {
      overlayEl.classList.remove('is-open');
      document.body.style.overflow = '';
      window.scrollTo(0, savedScrollY);
    }

    if (window.gsap) {
      gsap.killTweensOf(overlayEl);
      gsap.to(overlayEl, { opacity: 0, duration: 0.3, ease: 'expo.in', onComplete: afterClose });
    } else {
      overlayEl.style.opacity = '0';
      afterClose();
    }
  }

  // --- Events ---
  closeBtn.addEventListener('click', close);

  overlayEl.addEventListener('click', function (e) {
    if (!contentEl.contains(e.target) && !closeBtn.contains(e.target)) close();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen) close();
  });

  // --- Bind triggers ---
  function bindTrigger(el) {
    if (el._aboutBound) return;
    el._aboutBound = true;
    el.addEventListener('click', function (e) {
      e.preventDefault();
      open();
    });
  }

  function bindAll() {
    document.querySelectorAll('[data-about]').forEach(bindTrigger);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAll);
  } else {
    bindAll();
  }

  var observer = new MutationObserver(function () {
    document.querySelectorAll('[data-about]').forEach(bindTrigger);
  });
  observer.observe(document.body, { childList: true, subtree: true });

})();
