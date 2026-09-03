/* ── CURSOR DISPLACEMENT ─────────────────────────────────────────────────────
 * Subtle organic page-level displacement driven by cursor velocity.
 *
 * Visual family: the homepage fluid displaces the logo via its velocity field.
 * Here the same concept is applied to the full page content using an SVG
 * feTurbulence + feDisplacementMap filter on #page-wrap (or <main> on simpler
 * pages).  Moving the cursor stirs the noise field; stopping lets it decay.
 *
 * Guard rails:
 *   • prefers-reduced-motion → no-op
 *   • touch / coarse pointer → no-op
 *   • All fixed UI (#pgtrans, #g-nav, #cs-next, #hero-info-ov) sits OUTSIDE
 *     #page-wrap, so the filter does not affect fixed positioning.
 *   • pointer-events: none on the SVG element.
 *   • One RAF loop; sleeps automatically when idle, wakes on mousemove.
 *   • Cleans up on pagehide.
 * ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* ── Guards ──────────────────────────────────────────────────────────────── */
  if (typeof window === 'undefined') return;
  var mq = window.matchMedia;
  if (mq && mq('(prefers-reduced-motion: reduce)').matches) return;
  if (mq && mq('(hover: none) and (pointer: coarse)').matches) return;
  if (typeof SVGElement === 'undefined') return;

  /* ── Target ──────────────────────────────────────────────────────────────── */
  /* #page-wrap for full case studies (all fixed elements are outside it).
     <main> fallback for Power of V and other placeholder pages.             */
  var wrap = document.getElementById('page-wrap') || document.querySelector('main');
  if (!wrap) return;

  /* ── Inject SVG filter ───────────────────────────────────────────────────── */
  var NS   = 'http://www.w3.org/2000/svg';
  var svg  = document.createElementNS(NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;';

  var defs = document.createElementNS(NS, 'defs');
  var flt  = document.createElementNS(NS, 'filter');
  /* Extra margin lets displaced edge pixels read from outside the element
     bounding box instead of clamping — avoids edge smearing artefacts.     */
  flt.setAttribute('id',    'cd-flt');
  flt.setAttribute('x',     '-10%');
  flt.setAttribute('y',     '-10%');
  flt.setAttribute('width', '120%');
  flt.setAttribute('height','120%');
  flt.setAttribute('color-interpolation-filters', 'sRGB');

  /* fractalNoise: smoother, more atmospheric than type="turbulence".
     Non-square baseFrequency (x ≠ y) breaks the uniform isotropy so the
     distortion feels like heat shimmer or glass refraction, not a grid.    */
  var turb = document.createElementNS(NS, 'feTurbulence');
  turb.setAttribute('type',          'fractalNoise');
  turb.setAttribute('baseFrequency', '0.009 0.006');
  turb.setAttribute('numOctaves',    '4');
  turb.setAttribute('seed',          '12');
  turb.setAttribute('stitchTiles',   'stitch');
  turb.setAttribute('result',        'noiseField');

  var disp = document.createElementNS(NS, 'feDisplacementMap');
  disp.setAttribute('in',              'SourceGraphic');
  disp.setAttribute('in2',             'noiseField');
  disp.setAttribute('scale',           '0');
  disp.setAttribute('xChannelSelector','R');
  disp.setAttribute('yChannelSelector','G');

  flt.appendChild(turb);
  flt.appendChild(disp);
  defs.appendChild(flt);
  svg.appendChild(defs);
  /* Insert before the rest of <body> so it does not interfere with layout. */
  document.body.insertBefore(svg, document.body.firstChild);

  /* Apply filter to content wrapper */
  wrap.style.filter = 'url(#cd-flt)';

  /* ── Animation state ─────────────────────────────────────────────────────── */
  var rawX = 0.5, rawY = 0.5;   /* normalised mouse position (0-1) */
  var lerpX = 0.5, lerpY = 0.5; /* smoothed position with inertia  */
  var prevX = 0.5, prevY = 0.5; /* previous smoothed, for velocity  */
  var dispScale = 0;             /* current displacement magnitude  */
  var bfPhase   = 0;             /* noise-drift phase accumulator   */
  var lastMove  = -Infinity;     /* timestamp of last mousemove     */
  var rafId     = null;          /* current rAF handle              */

  /* ── Mouse tracking ──────────────────────────────────────────────────────── */
  window.addEventListener('mousemove', function (e) {
    rawX = e.clientX / window.innerWidth;
    rawY = e.clientY / window.innerHeight;
    lastMove = performance.now();
    if (!rafId) rafId = requestAnimationFrame(tick);
  }, { passive: true });

  /* ── RAF tick ────────────────────────────────────────────────────────────── */
  function tick(now) {
    /* Inertia lerp. */
    prevX = lerpX; prevY = lerpY;
    lerpX += (rawX - lerpX) * 0.09;
    lerpY += (rawY - lerpY) * 0.09;

    /* Velocity: distance moved this frame in normalised coordinates. */
    var vel = Math.hypot(lerpX - prevX, lerpY - prevY);

    /* Constant low-level distortion even at rest (3 px floor).
       Movement drives it up to 80 px.                                      */
    var moving    = (now - lastMove) < 600;
    var floor     = 3;
    var target    = moving ? Math.max(floor, Math.min(vel * 4000, 80)) : floor;

    /* Fast attack, very slow decay — lingers like real fluid. */
    var lerpRate  = target > dispScale ? 0.22 : 0.018;
    dispScale    += (target - dispScale) * lerpRate;

    /* Apply displacement scale to filter. */
    disp.setAttribute('scale', dispScale.toFixed(2));

    /* Fast noise drift — always running so the floor distortion breathes. */
    bfPhase += 0.0022;
    var bfx = 0.009 + Math.sin(bfPhase * 0.73) * 0.005
                    + Math.sin(bfPhase * 2.91)  * 0.0015;
    var bfy = 0.006 + Math.cos(bfPhase * 1.19) * 0.004
                    + Math.cos(bfPhase * 3.47)  * 0.0012;
    turb.setAttribute('baseFrequency', bfx.toFixed(5) + ' ' + bfy.toFixed(5));

    /* Sleep only when scale is near floor and fully idle. */
    if (dispScale < floor + 0.1 && (now - lastMove) > 4000) {
      rafId = null;
      return;
    }

    rafId = requestAnimationFrame(tick);
  }

  /* Boot one tick immediately so the lerp position is primed and the first
     mousemove doesn't cause a positional jump.                              */
  rafId = requestAnimationFrame(tick);

  /* ── Cleanup ─────────────────────────────────────────────────────────────── */
  window.addEventListener('pagehide', function () {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    wrap.style.filter = '';
    if (svg.parentNode) svg.parentNode.removeChild(svg);
  }, { once: true, passive: true });

})();
