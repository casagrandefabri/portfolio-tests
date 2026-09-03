#!/usr/bin/env python3
"""
Portfolio server — HttpOnly session-cookie authentication for private routes.

Usage:
  1. Copy .env.example to .env and fill in SESSION_SECRET
  2. python3 server.py
     or: SESSION_SECRET=... python3 server.py
"""

import base64
import hashlib
import hmac
import http.server
import json
import os
import re
import sys
import time
from urllib.parse import urlparse


# ── Load .env ─────────────────────────────────────────────────────────────────
def _load_dotenv():
    env_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if not os.path.isfile(env_file):
        return
    with open(env_file) as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, _, v = line.partition('=')
            os.environ.setdefault(k.strip(), v.strip().strip('"\''))

_load_dotenv()


# ── Config ────────────────────────────────────────────────────────────────────
_SECRET_STR = os.environ.get('SESSION_SECRET', '')
if not _SECRET_STR:
    print(
        '[server] ERROR: SESSION_SECRET is not set.\n'
        '  Create a .env file with: SESSION_SECRET=<long-random-string>\n'
        '  or export the variable before starting.',
        file=sys.stderr,
    )
    sys.exit(1)

SECRET       = _SECRET_STR.encode()
PW_HASH      = '1fa04f119f782c1e40a5f476298b3a0c53c94416a564aa2f6978a3eee5f62756'
SESSION_SECS = int(os.environ.get('SESSION_DAYS', '7')) * 86400
PORT         = int(os.environ.get('PORT', '8080'))
IS_PROD      = os.environ.get('NODE_ENV') == 'production'
COOKIE_NAME  = 'pg_sess'

PRIVATE_ROOTS = ['/projects/power-of-v', '/projects/1mm-forum']
BLOCKED_NAMES = {'server.py', '.env'}

# ── Clean project URL routing ──────────────────────────────────────────────────
# Maps canonical URL slug → physical folder name under projects/
PROJECT_SLUGS = {
    'plaiar':         'plaiar',
    'metapatient':    'metapatient',
    'nexus-smart':    'nexus-smart',
    '1mm':            '1mm-forum',
    'the-power-of-v': 'power-of-v',
}
# Old folder names that should redirect to their canonical slug
SLUG_REDIRECTS = {
    '1mm-forum':  '1mm',
    'power-of-v': 'the-power-of-v',
}
PRIVATE_SLUGS = {'1mm', 'the-power-of-v'}
_PROJ_RE      = re.compile(r'^/projects/([^/]+)(/(?:index\.html)?)?$')


# ── Token helpers ─────────────────────────────────────────────────────────────
def _b64(s: str) -> str:
    return base64.urlsafe_b64encode(s.encode()).decode().rstrip('=')

def _sign(data: str) -> str:
    return hmac.new(SECRET, data.encode(), hashlib.sha256).hexdigest()

def make_token() -> str:
    payload = json.dumps({'auth': True, 'exp': int(time.time()) + SESSION_SECS})
    data    = _b64(payload)
    return f'{data}.{_sign(data)}'

def verify_token(raw: str) -> bool:
    if not raw or '.' not in raw:
        return False
    dot  = raw.rfind('.')
    data = raw[:dot]
    sig  = raw[dot + 1:]
    try:
        expected = _sign(data)
        if not hmac.compare_digest(sig, expected):
            return False
        pad     = '=' * (-len(data) % 4)
        payload = json.loads(base64.urlsafe_b64decode(data + pad).decode())
        return payload.get('auth') is True and int(payload.get('exp', 0)) > int(time.time())
    except Exception:
        return False


# ── Gate HTML (never served as a static file) ─────────────────────────────────
_GATE_HTML = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Protected — CASAGRANDE</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Red+Hat+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/cursor.css">
<link rel="stylesheet" href="/nav.css">
<script>if(sessionStorage.getItem('pg_dir')){document.documentElement.style.setProperty('--pgtrans-init','1')}</script>
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
[hidden]{display:none!important}
img,svg{display:block}
a{color:inherit;text-decoration:none}
:root{
  --mono:'Red Hat Mono',ui-monospace,monospace;
  --monument:'PP Monument Extended',sans-serif;
  --ease:cubic-bezier(0.22,1,0.36,1);
}
html,body{
  height:100%;
  background:
    radial-gradient(72% 85% at 82% 42%,rgba(10,7,24,0.98) 0%,rgba(12,8,27,0.96) 34%,rgba(16,10,27,0.8) 54%,transparent 76%),
    radial-gradient(95% 120% at -8% 48%,rgba(57,23,43,0.38) 0%,rgba(38,17,34,0.22) 42%,transparent 74%),
    radial-gradient(72% 72% at 56% 110%,rgba(47,18,36,0.34) 0%,transparent 72%),
    linear-gradient(115deg,#19131d 0%,#160f1a 42%,#12101e 100%);
  color:#e4e4e4;
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
  overflow:hidden;
}
body::before{
  content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
  opacity:0.045;mix-blend-mode:soft-light;
  background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 240 240' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.9'/%3E%3C/svg%3E");
  background-size:220px 220px;
}

#gate{
  position:fixed;inset:0;z-index:20;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding:
    max(env(safe-area-inset-top),0px)
    max(env(safe-area-inset-right),0px)
    max(env(safe-area-inset-bottom),0px)
    max(env(safe-area-inset-left),0px);
  background:rgba(10,8,16,0.72);
  backdrop-filter:blur(24px);
  -webkit-backdrop-filter:blur(24px);
}
.gate-form{
  width:min(560px,100vw - 80px);
  display:flex;flex-direction:column;align-items:center;
}
.gate-label{
  font-family:var(--mono);font-size:11px;letter-spacing:2.5px;
  text-transform:uppercase;color:rgba(255,255,255,0.42);
  margin-bottom:40px;text-align:center;
}
.gate-field{
  position:relative;width:100%;
  display:flex;align-items:center;justify-content:center;
  border-bottom:1px solid rgba(255,255,255,0.15);
  padding-bottom:14px;margin-bottom:18px;
  transition:border-color 0.2s;
}
#gate.is-error .gate-field{
  border-color:rgba(255,80,80,0.5);
  animation:gate-shake 0.42s ease;
}
@keyframes gate-shake{
  0%,100%{transform:translateX(0)}
  20%{transform:translateX(-10px)}
  55%{transform:translateX(10px)}
  80%{transform:translateX(-5px)}
}
.gate-input{
  background:transparent;border:none;outline:none;
  font-family:var(--monument);font-size:clamp(28px,5vw,60px);
  font-weight:900;text-transform:uppercase;text-align:center;
  color:rgba(255,255,255,0.72);caret-color:rgba(255,255,255,0.7);
  letter-spacing:0.12em;width:100%;line-height:1;
  transition:opacity 0.15s;
}
.gate-input:disabled{opacity:0.3}
.gate-ph{
  font-family:var(--monument);font-size:clamp(28px,5vw,60px);
  font-weight:900;text-transform:uppercase;
  color:transparent;-webkit-text-stroke:1px rgba(255,255,255,0.2);
  pointer-events:none;white-space:nowrap;user-select:none;
  position:absolute;left:50%;top:40%;transform:translate(-50%,-50%);
  transition:opacity 0.15s;
}
.gate-input:focus ~ .gate-ph,
.gate-input:not(:placeholder-shown) ~ .gate-ph{opacity:0}
.gate-error{
  font-family:var(--mono);font-size:12px;letter-spacing:0.5px;
  color:rgba(255,90,90,0.9);text-align:center;
  min-height:18px;transition:opacity 0.2s;
}
.gate-error:empty{opacity:0}
.gate-hint{
  font-family:var(--mono);font-size:11px;letter-spacing:1.5px;
  text-transform:uppercase;color:rgba(255,255,255,0.16);
  margin-top:36px;text-align:center;
}
#pgtrans{
  position:fixed;inset:0;z-index:9999;pointer-events:none;
  background:radial-gradient(ellipse at 50% 44%,#1d1929 0%,#12101a 62%);
  opacity:var(--pgtrans-init,0);
}
@media(max-width:768px){
  .gate-form{width:min(560px,100vw - 48px)}
}
@media(prefers-reduced-motion:reduce){
  @keyframes gate-shake{0%,100%{transform:none}}
}
</style>
</head>
<body>
<div id="pgtrans" aria-hidden="true"></div>

<header id="g-nav" role="banner">
  <div id="g-nav-left">
    <a id="g-nav-back" href="/projects/" aria-label="Back to projects" data-aura>
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path d="M11 4L6 9L11 14" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </a>
    <span id="g-nav-breadcrumb">Projects</span>
  </div>
  <a id="g-nav-logo" href="/" aria-label="CASAGRANDE" data-aura>
    <img class="g-nav-icon" src="/icons/simone.svg"      alt="" aria-hidden="true">
    <img class="g-nav-icon" src="/icons/metapatient.svg" alt="" aria-hidden="true">
    <div id="g-nav-wordmark"><span id="g-nav-wordmark-text">CASAGRANDE</span></div>
    <img class="g-nav-icon" src="/icons/nexus.svg"       alt="" aria-hidden="true">
    <img class="g-nav-icon" src="/icons/booth.svg"       alt="" aria-hidden="true">
  </a>
</header>

<div id="gate" role="dialog" aria-modal="true" aria-label="Authentication required">
  <form class="gate-form" id="gate-form" novalidate autocomplete="off">
    <p class="gate-label">Protected project</p>
    <div class="gate-field">
      <input class="gate-input" type="text" id="gate-input"
             placeholder=" " autocomplete="off"
             autocorrect="off" autocapitalize="off" spellcheck="false"
             aria-label="Enter password to unlock">
      <span class="gate-ph" aria-hidden="true">PASSWORD</span>
    </div>
    <p class="gate-error" id="gate-error" role="alert" aria-live="assertive"></p>
    <p class="gate-hint">Press Enter to unlock</p>
  </form>
</div>

<div id="cursor"><div id="cursor-inner">
  <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
    <mask id="cursor-mask" fill="white">
      <path d="M0 14.9632C0 6.69925 6.69925 0 14.9632 0C23.2271 0 29.9264 6.69925 29.9264 14.9632C29.9264 23.2271 23.2271 29.9264 14.9632 29.9264C6.69925 29.9264 0 23.2271 0 14.9632Z"/>
    </mask>
    <path d="M0 14.9632C0 6.69925 6.69925 0 14.9632 0C23.2271 0 29.9264 6.69925 29.9264 14.9632C29.9264 23.2271 23.2271 29.9264 14.9632 29.9264C6.69925 29.9264 0 23.2271 0 14.9632Z" fill="white" fill-opacity="0.01"/>
    <path d="M14.9632 29.9264V27.7888C7.87982 27.7888 2.1376 22.0466 2.1376 14.9632H-2.1376C-2.1376 24.4077 5.51869 32.064 14.9632 32.064V29.9264ZM29.9264 14.9632H27.7888C27.7888 22.0466 22.0466 27.7888 14.9632 27.7888V32.064C24.4077 32.064 32.064 24.4077 32.064 14.9632H29.9264ZM14.9632 0V2.1376C22.0466 2.1376 27.7888 7.87982 27.7888 14.9632H32.064C32.064 5.51869 24.4077 -2.1376 14.9632 -2.1376V0ZM14.9632 0V-2.1376C5.51869 -2.1376 -2.1376 5.51869 -2.1376 14.9632H2.1376C2.1376 7.87982 7.87982 2.1376 14.9632 2.1376V0Z" fill="white" mask="url(#cursor-mask)"/>
  </svg>
</div></div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
<script src="/cursor.js"></script>
<script src="/nav.js"></script>
<script src="/transition.js"></script>
<script>
'use strict';
(function () {
  var gateEl  = document.getElementById('gate');
  var input   = document.getElementById('gate-input');
  var errorEl = document.getElementById('gate-error');
  var pgtrans = document.getElementById('pgtrans');
  var realVal = '';
  var busy    = false;

  requestAnimationFrame(function () { input.focus(); });

  input.addEventListener('beforeinput', function (e) {
    e.preventDefault();
    var t = e.inputType;
    if      (t === 'insertText' && e.data)  realVal += e.data;
    else if (t === 'insertFromPaste')       realVal += e.data || (e.dataTransfer && e.dataTransfer.getData('text/plain')) || '';
    else if (t === 'deleteContentBackward') realVal  = realVal.slice(0, -1);
    else if (t === 'deleteContentForward')  realVal  = realVal.slice(1);
    else if (t === 'deleteWordBackward') {
      var tr = realVal.trimEnd(), ls = tr.lastIndexOf(' ');
      realVal = ls >= 0 ? realVal.slice(0, ls + 1) : '';
    }
    else if (t === 'deleteWordForward') {
      var fs = realVal.indexOf(' ');
      realVal = fs >= 0 ? realVal.slice(fs + 1) : '';
    }
    else if (/^delete/.test(t)) realVal = '';
    input.value = '*'.repeat(realVal.length);
    input.setSelectionRange(input.value.length, input.value.length);
  });

  function showError(msg) {
    errorEl.textContent = msg || 'Incorrect password. Try again.';
    gateEl.classList.add('is-error');
    setTimeout(function () {
      gateEl.classList.remove('is-error');
      realVal = ''; input.value = '';
      input.disabled = false; busy = false;
      input.focus();
    }, 500);
  }

  function unlock() {
    sessionStorage.setItem('pg_dir', 'unlock');
    if (pgtrans && typeof gsap !== 'undefined') {
      pgtrans.style.pointerEvents = 'all';
      gsap.to(pgtrans, {
        opacity: 1, duration: 0.36, ease: 'power2.in',
        onComplete: function () { window.location.reload(); }
      });
    } else {
      window.location.reload();
    }
  }

  input.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || busy || !realVal.trim()) return;
    busy = true;
    input.disabled = true;
    errorEl.textContent = '';
    fetch('/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: realVal })
    })
    .then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, data: d }; });
    })
    .then(function (res) {
      if (res.ok) { unlock(); }
      else { showError(res.data && res.data.error); }
    })
    .catch(function () {
      showError('Connection error. Please try again.');
    });
  });
})();
</script>
</body>
</html>'''


# ── Request handler ────────────────────────────────────────────────────────────
class PortfolioHandler(http.server.SimpleHTTPRequestHandler):

    def log_message(self, fmt, *args):
        sys.stdout.write('  %s  %s\n' % (self.address_string(), fmt % args))

    # ── Cookie helpers ─────────────────────────────────────────────────────
    def _get_token(self):
        for part in self.headers.get('Cookie', '').split(';'):
            part = part.strip()
            if part.startswith(COOKIE_NAME + '='):
                return part[len(COOKIE_NAME) + 1:]
        return None

    def _is_authed(self):
        return verify_token(self._get_token())

    def _cookie_set(self, token):
        attrs = f'HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_SECS}'
        if IS_PROD:
            attrs += '; Secure'
        return f'{COOKIE_NAME}={token}; {attrs}'

    def _cookie_clear(self):
        return f'{COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'

    # ── Redirect helper ────────────────────────────────────────────────────
    def _redirect(self, code, location):
        self.send_response(code)
        self.send_header('Location', location)
        self.send_header('Content-Length', '0')
        self.end_headers()

    # ── Serve a project index.html at a canonical slug ─────────────────────
    def _serve_project(self, folder):
        html_path = os.path.join('projects', folder, 'index.html')
        try:
            with open(html_path, 'rb') as fh:
                content = fh.read()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        except FileNotFoundError:
            self.send_error(404)

    # ── Response helpers ───────────────────────────────────────────────────
    def _send_json(self, code, data, extra_headers=None):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, code, html, extra_headers=None):
        body = html.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    # ── Path helpers ───────────────────────────────────────────────────────
    def _path(self):
        return urlparse(self.path).path

    def _private_root(self, path):
        norm = path.rstrip('/') or '/'
        for root in PRIVATE_ROOTS:
            if norm == root or path.startswith(root + '/'):
                return root
        return None

    def _is_blocked(self, path):
        name = os.path.basename(path)
        return name in BLOCKED_NAMES or name.endswith('.py')

    # ── GET ────────────────────────────────────────────────────────────────
    def do_GET(self):
        path = self._path()

        if path == '/auth/check':
            return self._send_json(200, {'authenticated': self._is_authed()})

        if self._is_blocked(path):
            return self._send_json(403, {'error': 'Forbidden'})

        # ── Clean project URL routing ──────────────────────────────────────
        m = _PROJ_RE.match(path)
        if m:
            slug   = m.group(1)
            suffix = m.group(2) or ''
            # Old folder name → redirect to canonical slug
            if slug in SLUG_REDIRECTS:
                return self._redirect(301, '/projects/' + SLUG_REDIRECTS[slug])
            if slug in PROJECT_SLUGS:
                # /projects/slug/ or /projects/slug/index.html → /projects/slug
                if suffix:
                    return self._redirect(301, '/projects/' + slug)
                # Auth gate for private projects
                if slug in PRIVATE_SLUGS and not self._is_authed():
                    return self._send_html(200, _GATE_HTML)
                # Serve the physical index.html
                return self._serve_project(PROJECT_SLUGS[slug])

        # ── Existing private-root guard (covers asset requests) ────────────
        root = self._private_root(path)
        if root:
            if not self._is_authed():
                ext = os.path.splitext(path)[1].lower()
                if ext and ext != '.html':
                    return self._send_json(401, {'error': 'Unauthorized'})
                return self._send_html(200, _GATE_HTML)

        super().do_GET()

    # ── HEAD ───────────────────────────────────────────────────────────────
    def do_HEAD(self):
        path = self._path()
        if self._is_blocked(path):
            self.send_error(403)
            return
        root = self._private_root(path)
        if root and not self._is_authed():
            self.send_error(401)
            return
        super().do_HEAD()

    # ── POST ───────────────────────────────────────────────────────────────
    def do_POST(self):
        path = self._path()

        if path == '/auth/login':
            length = int(self.headers.get('Content-Length', 0))
            try:
                payload  = json.loads(self.rfile.read(length))
                password = str(payload.get('password', ''))
            except Exception:
                return self._send_json(400, {'error': 'Bad request'})

            pw_hash = hashlib.sha256(password.encode()).hexdigest()
            if not hmac.compare_digest(pw_hash, PW_HASH):
                return self._send_json(401, {'error': 'Incorrect password. Try again.'})

            return self._send_json(
                200, {'ok': True},
                {'Set-Cookie': self._cookie_set(make_token())}
            )

        if path == '/auth/logout':
            return self._send_json(200, {'ok': True},
                                   {'Set-Cookie': self._cookie_clear()})

        self._send_json(404, {'error': 'Not found'})


# ── Start ──────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    server_address = ('', PORT)
    with http.server.ThreadingHTTPServer(server_address, PortfolioHandler) as httpd:
        print(f'[server] Portfolio  →  http://localhost:{PORT}')
        print(f'[server] Ctrl+C to stop')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n[server] Stopped.')
