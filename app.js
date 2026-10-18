/* StreamTV v2.0 - canale Twitch pe televizoare LG webOS.
 *
 * Scris în ES5 pentru browsere vechi (webOS 3.x = Chrome 38): fără ?. , ??, =>, let/const, fetch,
 * template strings, Object.assign, includes/startsWith.
 *
 * Două moduri de redare:
 *  - "api"    : playerul oficial Twitch încorporat (dacă browserul îl poate rula);
 *  - "native" : redare directă a fluxului HLS în elementul <video> al televizorului.
 *               Folosește interfața internă a Twitch (neoficială), pentru browsere prea vechi pentru embed.
 */
(function () {
  'use strict';

  var VERSION = '2.0';

  // Adresa unui proxy propriu pentru cererea de token (opțional; vezi ghidul, secțiunea „proxy”).
  var DEFAULT_PROXY = '';

  var CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  var GQL_URL = 'https://gql.twitch.tv/gql';
  var GQL_HASH = 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9';
  var GQL_QUERY = 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, ' +
    '$isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, ' +
    'params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) ' +
    '@include(if: $isLive) { value signature __typename } videoPlaybackAccessToken(id: $vodID, ' +
    'params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) ' +
    '@include(if: $isVod) { value signature __typename } }';

  // ---------- Coduri taste (telecomanda LG + tastatură pentru test pe PC) ----------
  var KEY = {
    BKSP: 8, ENTER: 13, ESC: 27, PAUSE: 19,
    CH_UP: 33, CH_DOWN: 34, ZERO: 48,
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    STOP: 413, PLAY: 415, BACK: 461,
    F1: 112, F2: 113, F3: 114, F4: 115
  };

  var DEFAULT_FAVS = ['twitch', 'monstercat', 'criticalrole', 'riotgames'];

  var state = {
    screen: 'home',
    channel: null,
    mode: null,          // 'api' | 'native' | null
    player: null,        // obiectul Twitch.Player (mod api)
    video: null,         // elementul <video> (mod native)
    chat: false,
    muted: false,
    volume: 0.8,
    favs: [],
    recent: []
  };

  var hudTimer = null;
  var toastTimer = null;
  var nativeTimer = null;
  var playId = 0;
  var nativeHintShown = false;

  // ---------- Diagnostic ----------
  var twitchApi = { state: 'loading', tries: 0 };   // loading | ready | error | noapi
  var diagInfo = { token: '-', video: '-' };
  var jsErrors = [];

  function $(sel) { return document.querySelector(sel); }

  function apiReady() { return !!(window.Twitch && window.Twitch.Player); }

  function loadTwitchScript() {
    twitchApi.tries++;
    twitchApi.state = 'loading';
    var s = document.createElement('script');
    s.src = 'https://player.twitch.tv/js/embed/v1.js';
    s.async = true;
    s.onload = function () { twitchApi.state = apiReady() ? 'ready' : 'noapi'; refreshDiag(); };
    s.onerror = function () {
      twitchApi.state = 'error';
      refreshDiag();
      if (twitchApi.tries < 2) { setTimeout(loadTwitchScript, 2000); }
    };
    (document.head || document.documentElement).appendChild(s);
  }

  window.addEventListener('error', function (ev) {
    var f = ev && ev.filename ? String(ev.filename).split('/').pop() : '';
    jsErrors.push(String(ev && ev.message) + (f ? ' [' + f + ':' + ev.lineno + ']' : ''));
    if (jsErrors.length > 4) { jsErrors.shift(); }
  });

  function diagText() {
    var ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '?';
    var m = ua.match(/Chrome\/[\d.]+/);
    var proxy = getProxy();
    var proxyHost = proxy ? proxy.replace(/^https:\/\//, '').split('/')[0] : 'niciunul (cerere directă)';
    var lines = [
      'DIAGNOSTIC StreamTV v' + VERSION,
      '',
      'Browser: ' + (m ? m[0] : ua),
      'Adresa paginii: ' + (location.hostname || '(fișier local)'),
      'Player Twitch încorporat: ' + (apiReady() ? 'disponibil' : 'indisponibil') + ' (' + twitchApi.state + ')',
      'Mod redare: ' + (state.mode || '-'),
      'Proxy token: ' + proxyHost,
      'Token Twitch: ' + diagInfo.token,
      'Flux video: ' + diagInfo.video,
      'Erori JS: ' + (jsErrors.length ? '' : 'niciuna')
    ];
    for (var i = 0; i < jsErrors.length; i++) { lines.push('  - ' + jsErrors[i]); }
    lines.push('', 'User-Agent: ' + ua);
    return lines.join('\n');
  }

  function refreshDiag() {
    var d = $('#diag');
    if (d && !d.hidden) { $('#diag-text').textContent = diagText(); }
  }

  function showDiag() { $('#diag').hidden = false; refreshDiag(); }
  function hideDiag() { $('#diag').hidden = true; }

  function onDiagKey(e, k) {
    if (k === KEY.ENTER || k === KEY.BACK || k === KEY.ESC || k === KEY.BKSP || k === KEY.ZERO) {
      hideDiag();
    } else if (k === KEY.GREEN || k === KEY.F2) {
      hideDiag();
      if (state.screen === 'player' && state.channel) { startPlayer(state.channel); }
    }
    e.preventDefault();
    e.stopPropagation();
  }

  // ---------- Stocare locală (în try/catch: poate lipsi în unele contexte) ----------
  function load(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignorăm */ }
  }

  function getProxy() {
    var p = load('streamtv.proxy', '');
    if (typeof p !== 'string' || !/^https:\/\//i.test(p)) { p = ''; }
    return p || DEFAULT_PROXY;
  }

  // ---------- Utilitare ----------
  function normalizeChannel(raw) {
    var s = String(raw || '').trim().toLowerCase();
    var m = s.match(/twitch\.tv\/([a-z0-9_]+)/);   // acceptă și linkuri twitch.tv/nume
    if (m) { s = m[1]; }
    s = s.replace(/^@/, '');
    return /^[a-z0-9_]{3,25}$/.test(s) ? s : null;
  }

  function hue(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) { h = (h * 31 + name.charCodeAt(i)) % 360; }
    return h;
  }

  function isFav(name) { return state.favs.indexOf(name) !== -1; }

  function toast(text) {
    var t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2800);
  }

  function setMsg(text) { $('#msg').textContent = text || ''; }

  // ---------- Favorite / recente ----------
  function toggleFav(name) {
    if (!name) { return; }
    var i = state.favs.indexOf(name);
    if (i === -1) {
      state.favs.push(name);
      toast('★ ' + name + ' adăugat la favorite');
    } else {
      state.favs.splice(i, 1);
      toast(name + ' scos din favorite');
    }
    save('streamtv.favs', state.favs);
  }

  function pushRecent(name) {
    state.recent = [name].concat(state.recent.filter(function (c) { return c !== name; })).slice(0, 12);
    save('streamtv.recent', state.recent);
  }

  // ---------- Ecran principal ----------
  function makeCard(name, fav) {
    var el = document.createElement('div');
    el.className = 'card focusable';
    el.tabIndex = 0;
    el.setAttribute('data-channel', name);

    var av = document.createElement('div');
    av.className = 'avatar';
    av.textContent = name.charAt(0).toUpperCase();
    av.style.background = 'hsl(' + hue(name) + ', 55%, 38%)';

    var nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = name;

    var tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = fav ? '★ Favorit' : 'Recent';

    el.appendChild(av);
    el.appendChild(nm);
    el.appendChild(tag);

    el.addEventListener('click', function () { openChannel(name); });
    return el;
  }

  function fillGrid(box, list, fav, emptyText) {
    box.innerHTML = '';
    if (!list.length) {
      var p = document.createElement('div');
      p.className = 'empty';
      p.textContent = emptyText;
      box.appendChild(p);
      return;
    }
    list.forEach(function (name) { box.appendChild(makeCard(name, fav)); });
  }

  function renderHome() {
    fillGrid($('#favs'), state.favs, true,
      'Nu ai favorite încă. Scrie numele unui canal mai sus, apoi apasă butonul roșu cât timp îl urmărești.');
    var recent = state.recent.filter(function (c) { return !isFav(c); });
    $('#recent-sec').hidden = recent.length === 0;
    fillGrid($('#recent'), recent, false, '');
  }

  function focusables() {
    var all = document.querySelectorAll('#home .focusable');
    return Array.prototype.slice.call(all).filter(function (el) { return el.offsetParent !== null; });
  }

  function focusChannelCard(name) {
    var el = name ? document.querySelector('#home [data-channel="' + name + '"]') : null;
    if (!el) { el = focusables()[0]; }
    if (el) { el.focus(); }
  }

  // Navigare spațială: alege cel mai apropiat element în direcția apăsată.
  function moveFocus(dir) {
    var list = focusables();
    var cur = document.activeElement;
    if (!cur || list.indexOf(cur) === -1) {
      if (list[0]) { list[0].focus(); }
      return;
    }
    var r = cur.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    var best = null;
    var bestScore = Infinity;

    list.forEach(function (el) {
      if (el === cur) { return; }
      var b = el.getBoundingClientRect();
      var dx = b.left + b.width / 2 - cx;
      var dy = b.top + b.height / 2 - cy;
      var primary, secondary;

      if (dir === 'left') {
        if (dx >= -2) { return; }
        primary = -dx; secondary = Math.abs(dy);
        if (secondary > r.height * 0.6) { return; }
      } else if (dir === 'right') {
        if (dx <= 2) { return; }
        primary = dx; secondary = Math.abs(dy);
        if (secondary > r.height * 0.6) { return; }
      } else if (dir === 'up') {
        if (dy >= -2) { return; }
        primary = -dy; secondary = Math.abs(dx);
      } else {
        if (dy <= 2) { return; }
        primary = dy; secondary = Math.abs(dx);
      }

      var score = primary + secondary * 2;
      if (score < bestScore) { bestScore = score; best = el; }
    });

    if (best) {
      best.focus();
      try {
        if (best.scrollIntoViewIfNeeded) { best.scrollIntoViewIfNeeded(true); }
        else if (best.scrollIntoView) { best.scrollIntoView(false); }
      } catch (e) { /* ignorăm */ }
    }
  }

  // Comandă ascunsă în căsuța de căutare: „proxy https://adresa” sau „proxy off”.
  function handleProxyCommand(raw) {
    var m = String(raw || '').trim().match(/^proxy\s+(\S+)$/i);
    if (!m) { return false; }
    var arg = m[1];
    if (arg.toLowerCase() === 'off') {
      save('streamtv.proxy', '');
      setMsg('Proxy dezactivat.');
    } else if (/^https:\/\/[^\s\/]+/i.test(arg)) {
      save('streamtv.proxy', arg);
      setMsg('Proxy salvat: ' + arg.replace(/^https:\/\//i, '').split('/')[0]);
    } else {
      setMsg('Adresa proxy trebuie să înceapă cu https://');
      return true;
    }
    $('#q').value = '';
    return true;
  }

  function submitSearch() {
    var raw = $('#q').value;
    if (handleProxyCommand(raw)) { return; }
    var name = normalizeChannel(raw);
    if (!name) {
      setMsg('Nume de canal invalid. Folosește 3–25 caractere: litere, cifre sau _ (ex: monstercat).');
      try { $('#q').select(); } catch (e) { /* ignorăm */ }
      return;
    }
    setMsg('');
    openChannel(name);
  }

  // ---------- Ecran player ----------
  function showStatus(text) {
    var s = $('#status');
    s.textContent = text;
    s.hidden = false;
  }
  function hideStatus() { $('#status').hidden = true; }

  function updateHud() {
    $('#hud-channel').textContent = state.channel || '';
    $('#hud-fav').textContent = isFav(state.channel) ? '★ favorit' : '';
  }

  function showHud() {
    updateHud();
    var h = $('#hud');
    h.classList.add('show');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(function () { h.classList.remove('show'); }, 5000);
  }

  function onPlayerEvent(evt, fn) {
    if (state.player && window.Twitch && Twitch.Player && Twitch.Player[evt]) {
      state.player.addEventListener(Twitch.Player[evt], fn);
    }
  }

  // ----- Mod "api": playerul oficial încorporat -----
  function startApi(name) {
    state.mode = 'api';
    var p = new Twitch.Player('player', {
      channel: name,
      parent: [location.hostname],
      width: '100%',
      height: '100%',
      autoplay: true,
      muted: false
    });
    state.player = p;

    onPlayerEvent('READY', function () {
      try { p.setVolume(state.volume); p.setMuted(state.muted); } catch (e) { /* ignorăm */ }
    });
    onPlayerEvent('OFFLINE', function () { showStatus('Canalul „' + state.channel + '” este offline acum.'); });
    onPlayerEvent('ONLINE', hideStatus);
    onPlayerEvent('PLAYING', hideStatus);
    onPlayerEvent('PLAYBACK_BLOCKED', function () { showStatus('Apasă OK pentru a porni redarea.'); });
    applyChat();
  }

  // ----- Mod "native": token + flux HLS în <video> -----
  function postJson(url, body, withClientId, cb) {
    var done = false;
    function finish(err, data) { if (!done) { done = true; cb(err, data); } }
    try {
      var x = new XMLHttpRequest();
      x.open('POST', url, true);
      x.timeout = 15000;
      x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      if (withClientId) { x.setRequestHeader('Client-ID', CLIENT_ID); }
      x.onload = function () {
        if (x.status < 200 || x.status >= 300) { finish({ kind: 'http', status: x.status }); return; }
        var data = null;
        try { data = JSON.parse(x.responseText); } catch (e) { finish({ kind: 'parse' }); return; }
        finish(null, data);
      };
      x.onerror = function () { finish({ kind: 'net' }); };
      x.ontimeout = function () { finish({ kind: 'timeout' }); };
      x.send(JSON.stringify(body));
    } catch (e2) { finish({ kind: 'net', detail: String(e2) }); }
  }

  function tokenFrom(data) {
    var d = data && data.data;
    var t = d && d.streamPlaybackAccessToken;
    return (t && t.value && t.signature) ? { value: t.value, signature: t.signature } : null;
  }

  function describeGql(data) {
    if (!data) { return ''; }
    if (data.errors && data.errors[0] && data.errors[0].message) { return String(data.errors[0].message); }
    if (data.data && data.data.streamPlaybackAccessToken === null) { return 'canalul nu există'; }
    return '';
  }

  function requestToken(name, cb) {
    var proxy = getProxy();
    var url = proxy || GQL_URL;
    var withId = !proxy;   // către proxy nu trimitem antete speciale (evităm cererea de verificare CORS)

    var persisted = {
      operationName: 'PlaybackAccessToken',
      extensions: { persistedQuery: { version: 1, sha256Hash: GQL_HASH } },
      variables: { isLive: true, login: name, isVod: false, vodID: '', playerType: 'embed', platform: 'site' }
    };
    var full = {
      operationName: 'PlaybackAccessToken_Template',
      query: GQL_QUERY,
      variables: { isLive: true, login: name, isVod: false, vodID: '', playerType: 'site' }
    };

    postJson(url, persisted, withId, function (err, data) {
      if (err) { cb(err); return; }
      var t = tokenFrom(data);
      if (t) { cb(null, t); return; }
      // interogarea „persistată” poate fi refuzată: încercăm varianta completă
      postJson(url, full, withId, function (err2, data2) {
        if (err2) { cb(err2); return; }
        var t2 = tokenFrom(data2);
        if (t2) { cb(null, t2); return; }
        cb({ kind: 'notoken', detail: describeGql(data2) || describeGql(data) });
      });
    });
  }

  function tokenErrorShort(err) {
    if (err.kind === 'net' || err.kind === 'timeout') { return 'EȘUAT: nicio legătură cu Twitch (' + err.kind + ': CORS / rețea / certificat)'; }
    if (err.kind === 'http') { return 'EȘUAT: HTTP ' + err.status; }
    if (err.kind === 'notoken') { return 'EȘUAT: ' + (err.detail || 'fără token'); }
    return 'EȘUAT: ' + err.kind;
  }

  function tokenErrorText(err) {
    if (err.kind === 'net' || err.kind === 'timeout') {
      return 'Nu pot contacta serverul Twitch.\nBrowserul a blocat cererea (CORS) sau nu există rețea / certificat valid.\n' +
             'Apasă 0 pentru diagnostic; vezi „proxy” în ghid.';
    }
    if (err.kind === 'http') { return 'Twitch a răspuns cu eroarea HTTP ' + err.status + '.'; }
    if (err.kind === 'notoken') { return 'Twitch nu a dat acces la flux' + (err.detail ? ': ' + err.detail : '') + '.'; }
    return 'Răspuns neașteptat de la Twitch.';
  }

  function videoFailed(v) {
    if (state.video !== v) { return; }
    var code = v.error && v.error.code ? v.error.code : null;
    diagInfo.video = 'EROARE' + (code ? ' cod ' + code : '');
    refreshDiag();
    showStatus('Nu pot reda fluxul' + (code ? ' (cod ' + code + ')' : '') + '.\n' +
               'Cel mai probabil canalul este offline acum. Apasă 0 pentru diagnostic.');
  }

  function playHls(name, tok, myId) {
    var url = 'https://usher.ttvnw.net/api/v2/channel/hls/' + encodeURIComponent(name) + '.m3u8' +
      '?platform=web&p=' + Math.floor(Math.random() * 1000000) +
      '&allow_source=true&allow_audio_only=false&playlist_include_framerate=true&supported_codecs=h264' +
      '&sig=' + encodeURIComponent(tok.signature) + '&token=' + encodeURIComponent(tok.value);

    var box = $('#player');
    box.innerHTML = '';

    var v = document.createElement('video');
    v.setAttribute('autoplay', 'autoplay');
    v.setAttribute('playsinline', '');
    v.autoplay = true;
    v.volume = state.volume;
    v.muted = state.muted;

    var src = document.createElement('source');
    src.setAttribute('type', 'application/vnd.apple.mpegurl');
    src.setAttribute('src', url);
    v.appendChild(src);
    state.video = v;

    v.addEventListener('playing', function () {
      if (myId !== playId) { return; }
      diagInfo.video = 'se redă';
      refreshDiag();
      hideStatus();
      clearTimeout(nativeTimer);
    });
    v.addEventListener('waiting', function () { if (myId === playId) { diagInfo.video = 'se încarcă'; refreshDiag(); } });
    v.addEventListener('error', function () { if (myId === playId) { videoFailed(v); } });
    src.addEventListener('error', function () { if (myId === playId) { videoFailed(v); } });

    box.appendChild(v);
    diagInfo.video = 'se pornește';
    try { v.load(); } catch (e) { /* ignorăm */ }
    try { v.play(); } catch (e2) { /* ignorăm */ }

    clearTimeout(nativeTimer);
    nativeTimer = setTimeout(function () {
      if (myId === playId && state.video === v && diagInfo.video !== 'se redă') {
        showStatus('Încă se încarcă…\nDacă rămâne așa, canalul e offline sau TV-ul nu acceptă acest flux.');
      }
    }, 12000);
  }

  function startNative(name) {
    state.mode = 'native';
    state.player = null;
    state.video = null;
    var myId = ++playId;
    diagInfo.token = 'se cere…';
    diagInfo.video = '-';
    $('#player').innerHTML = '';
    showStatus('Se obține fluxul pentru „' + name + '”…');
    if (!nativeHintShown) {
      nativeHintShown = true;
      toast('Mod direct: fără chat și fără alegerea calității');
    }

    requestToken(name, function (err, tok) {
      if (myId !== playId || state.screen !== 'player' || state.channel !== name) { return; }
      if (err) {
        diagInfo.token = tokenErrorShort(err);
        refreshDiag();
        showStatus(tokenErrorText(err));
        return;
      }
      diagInfo.token = 'OK';
      refreshDiag();
      playHls(name, tok, myId);
    });
  }

  // ----- Alegerea modului -----
  // Așteaptă (maxim ~6 secunde) scriptul Twitch dacă încă se încarcă; altfel trece pe modul direct.
  function waitForApi(name, n) {
    if (state.screen !== 'player' || state.channel !== name) { return; }
    if (apiReady()) { startPlayer(name); return; }
    if (twitchApi.state !== 'loading' || n >= 20) { startNative(name); return; }
    showStatus('Se pregătește playerul…');
    setTimeout(function () { waitForApi(name, n + 1); }, 300);
  }

  function startPlayer(name) {
    $('#player').innerHTML = '';
    hideStatus();
    clearTimeout(nativeTimer);
    playId++;
    state.player = null;
    state.video = null;
    state.mode = null;

    if (!apiReady()) { waitForApi(name, 0); return; }
    if (!location.hostname) { startNative(name); return; }   // embed-ul cere adresă web; modul direct nu
    startApi(name);
  }

  function stopPlayer() {
    playId++;
    clearTimeout(nativeTimer);
    try { if (state.player && state.player.pause) { state.player.pause(); } } catch (e) { /* ignorăm */ }
    var v = state.video;
    if (v) {
      try {
        v.pause();
        while (v.firstChild) { v.removeChild(v.firstChild); }   // eliberăm decodorul TV-ului
        v.removeAttribute('src');
        v.load();
      } catch (e2) { /* ignorăm */ }
    }
    state.player = null;
    state.video = null;
    state.mode = null;
    $('#player').innerHTML = '';
    $('#chat').innerHTML = '';
    $('#stage').classList.remove('with-chat');
    hideStatus();
    clearTimeout(hudTimer);
    $('#hud').classList.remove('show');
  }

  function applyChat() {
    var stage = $('#stage');
    var box = $('#chat');
    box.innerHTML = '';
    if (state.chat && state.mode === 'api' && state.channel && location.hostname) {
      var f = document.createElement('iframe');
      f.src = 'https://www.twitch.tv/embed/' + encodeURIComponent(state.channel) +
              '/chat?parent=' + encodeURIComponent(location.hostname) + '&darkpopout';
      f.setAttribute('title', 'Chat');
      box.appendChild(f);
      stage.classList.add('with-chat');
    } else {
      stage.classList.remove('with-chat');
    }
  }

  function openChannel(name) {
    state.channel = name;
    state.screen = 'player';
    pushRecent(name);
    $('#home').hidden = true;
    $('#player-screen').hidden = false;
    startPlayer(name);
    showHud();
  }

  function goHome() {
    var last = state.channel;
    stopPlayer();
    state.screen = 'home';
    $('#player-screen').hidden = true;
    $('#home').hidden = false;
    $('#q').value = '';
    setMsg('');
    renderHome();
    focusChannelCard(last);
  }

  function zap(dir) {
    var list = state.favs;
    if (!list.length) { toast('Nu ai canale favorite pentru schimbare rapidă'); return; }
    var i = list.indexOf(state.channel);
    var next;
    if (i === -1) { next = dir > 0 ? list[0] : list[list.length - 1]; }
    else { next = list[(i + dir + list.length) % list.length]; }
    if (next === state.channel) { return; }

    state.channel = next;
    pushRecent(next);
    hideStatus();
    if (state.mode === 'native') { startNative(next); }
    else if (state.mode === 'api' && state.player && typeof state.player.setChannel === 'function') {
      state.player.setChannel(next);
      if (state.chat) { applyChat(); }
    }
    else { startPlayer(next); }
    toast(next);
  }

  // ----- Controale de redare (valabile în ambele moduri) -----
  function hasPlayback() {
    if (state.player || state.video) { return true; }
    toast('Nu rulează niciun flux acum');
    return false;
  }

  function applyVolume() {
    try {
      if (state.player) { state.player.setVolume(state.volume); }
      else if (state.video) { state.video.volume = state.volume; }
    } catch (e) { /* ignorăm */ }
  }

  function applyMuted() {
    try {
      if (state.player) { state.player.setMuted(state.muted); }
      else if (state.video) { state.video.muted = state.muted; }
    } catch (e) { /* ignorăm */ }
  }

  function changeVolume(delta) {
    if (!hasPlayback()) { return; }
    state.volume = Math.max(0, Math.min(1, Math.round((state.volume + delta) * 10) / 10));
    save('streamtv.volume', state.volume);
    if (state.muted && delta > 0) { state.muted = false; applyMuted(); }
    applyVolume();
    toast('Volum player: ' + Math.round(state.volume * 100) + '%');
  }

  function toggleMute() {
    if (!hasPlayback()) { return; }
    state.muted = !state.muted;
    applyMuted();
    toast(state.muted ? 'Sunet oprit' : 'Sunet pornit');
  }

  function togglePlay(forceState) {
    if (!hasPlayback()) { return; }
    hideStatus();
    try {
      if (state.player) {
        var p = state.player;
        if (forceState === 'play') { p.play(); }
        else if (forceState === 'pause') { p.pause(); }
        else {
          var paused = typeof p.isPaused === 'function' ? p.isPaused() : false;
          if (paused) { p.play(); } else { p.pause(); }
        }
      } else {
        var v = state.video;
        if (forceState === 'play' || (!forceState && v.paused)) { v.play(); }
        else { v.pause(); }
      }
    } catch (e) { /* ignorăm */ }
  }

  function prettyQuality(q) {
    if (q === 'chunked') { return 'Sursă (maximă)'; }
    if (q === 'auto') { return 'Automată'; }
    if (q === 'audio_only') { return 'Doar sunet'; }
    return String(q);
  }

  function qualityName(q) {
    if (q && typeof q === 'object') { return q.group || q.name; }
    return q;
  }

  function cycleQuality() {
    if (state.mode === 'native') { toast('În modul direct calitatea se alege automat'); return; }
    var p = state.player;
    if (!p || typeof p.getQualities !== 'function') { toast('Nu rulează niciun flux acum'); return; }
    try {
      var list = (p.getQualities() || []).map(qualityName);
      if (!list.length) { toast('Calitățile nu sunt disponibile încă'); return; }
      var cur = typeof p.getQuality === 'function' ? qualityName(p.getQuality()) : null;
      var i = list.indexOf(cur);
      var next = list[(i + 1) % list.length];
      p.setQuality(next);
      toast('Calitate: ' + prettyQuality(next));
    } catch (e) { toast('Nu pot schimba calitatea acum'); }
  }

  function toggleChat() {
    if (state.mode !== 'api') { toast('Chatul nu este disponibil în modul direct'); return; }
    state.chat = !state.chat;
    save('streamtv.chat', state.chat);
    applyChat();
    toast(state.chat ? 'Chat pornit' : 'Chat oprit');
  }

  // ---------- Taste ----------
  function exitApp() {
    try {
      if (window.webOS && typeof window.webOS.platformBack === 'function') { window.webOS.platformBack(); return; }
    } catch (e) { /* ignorăm */ }
    try { window.close(); } catch (e2) { /* ignorăm */ }
  }

  function onPlayerKey(e, k) {
    var handled = true;
    switch (k) {
      case KEY.BACK: case KEY.ESC: case KEY.BKSP: case KEY.STOP: goHome(); break;
      case KEY.ENTER: togglePlay(); break;
      case KEY.PLAY: togglePlay('play'); break;
      case KEY.PAUSE: togglePlay('pause'); break;
      case KEY.LEFT: case KEY.CH_DOWN: zap(-1); break;
      case KEY.RIGHT: case KEY.CH_UP: zap(1); break;
      case KEY.UP: changeVolume(0.1); break;
      case KEY.DOWN: changeVolume(-0.1); break;
      case KEY.RED: case KEY.F1: toggleFav(state.channel); break;
      case KEY.GREEN: case KEY.F2: cycleQuality(); break;
      case KEY.YELLOW: case KEY.F3: toggleChat(); break;
      case KEY.BLUE: case KEY.F4: toggleMute(); break;
      case KEY.ZERO: showDiag(); break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      if (state.screen === 'player') { showHud(); }
    }
  }

  function onHomeKey(e, k) {
    var input = $('#q');
    var typing = e.target === input;

    if (typing) {
      if (k === KEY.ENTER) {
        if (input.value.trim() !== '') { e.preventDefault(); submitSearch(); }
        return;   // câmp gol: lăsăm sistemul să deschidă tastatura de pe ecran
      }
      if (k === KEY.UP || k === KEY.DOWN) {
        e.preventDefault();
        moveFocus(k === KEY.UP ? 'up' : 'down');
        return;
      }
      if ((k === KEY.LEFT || k === KEY.RIGHT) && input.value === '') {
        e.preventDefault();
        moveFocus(k === KEY.LEFT ? 'left' : 'right');
        return;
      }
      if (k === KEY.BACK || k === KEY.ESC) {
        if (input.value !== '') { e.preventDefault(); input.value = ''; setMsg(''); input.blur(); return; }
      }
      if (k !== KEY.BACK && k !== KEY.ESC) { return; }   // restul tastelor: scriere normală
    }

    switch (k) {
      case KEY.LEFT: e.preventDefault(); moveFocus('left'); break;
      case KEY.RIGHT: e.preventDefault(); moveFocus('right'); break;
      case KEY.UP: e.preventDefault(); moveFocus('up'); break;
      case KEY.DOWN: e.preventDefault(); moveFocus('down'); break;
      case KEY.ENTER:
        var a = document.activeElement;
        if (a && a.getAttribute && a.getAttribute('data-channel')) {
          e.preventDefault();
          openChannel(a.getAttribute('data-channel'));
        } else if (a && a.id === 'go') {
          e.preventDefault();
          submitSearch();
        } else if (a && a.id === 'diag-btn') {
          e.preventDefault();
          showDiag();
        }
        break;
      case KEY.RED: case KEY.F1:
        var c = document.activeElement;
        var ch = c && c.getAttribute ? c.getAttribute('data-channel') : null;
        if (ch) {
          e.preventDefault();
          toggleFav(ch);
          renderHome();
          focusChannelCard(ch);
        }
        break;
      case KEY.BACK: case KEY.ESC:
        // Nu blocăm acțiunea implicită: sistemul închide aplicația. Pentru siguranță o cerem și noi.
        setTimeout(exitApp, 150);
        break;
      default: break;
    }
  }

  document.addEventListener('keydown', function (e) {
    if (!$('#diag').hidden) { onDiagKey(e, e.keyCode); return; }
    if (state.screen === 'player') { onPlayerKey(e, e.keyCode); }
    else { onHomeKey(e, e.keyCode); }
  }, true);

  // Pointer (Magic Remote): hover = focus, click pe butoane
  document.addEventListener('mouseover', function (e) {
    if (state.screen !== 'home') { return; }
    var el = e.target;
    while (el && el !== document.body) {
      if (el.classList && el.classList.contains('focusable') && el !== $('#q')) { el.focus(); return; }
      el = el.parentNode;
    }
  });

  $('#go').addEventListener('click', submitSearch);
  $('#diag-btn').addEventListener('click', showDiag);
  $('#hud-back').addEventListener('click', goHome);
  $('#diag').addEventListener('click', hideDiag);
  $('#hotzone').addEventListener('mouseenter', function () { if (state.screen === 'player') { showHud(); } });
  document.addEventListener('mousemove', function () { if (state.screen === 'player') { showHud(); } });

  // Cât timp se redă în iframe (mod api), Twitch poate „fura” focusul și telecomanda nu mai ajunge la noi.
  function reclaimFocus() {
    if (state.screen !== 'player') { return; }
    var a = document.activeElement;
    if (a && a.tagName === 'IFRAME') { try { a.blur(); } catch (e) { /* ignorăm */ } }
    try { window.focus(); } catch (e2) { /* ignorăm */ }
  }
  window.addEventListener('blur', function () { setTimeout(reclaimFocus, 400); });
  setInterval(reclaimFocus, 2000);

  // ---------- Pornire ----------
  (function init() {
    var favs = load('streamtv.favs', null);
    if (!Array.isArray(favs)) { favs = DEFAULT_FAVS.slice(); save('streamtv.favs', favs); }
    state.favs = favs;

    var recent = load('streamtv.recent', []);
    state.recent = Array.isArray(recent) ? recent : [];

    var vol = load('streamtv.volume', 0.8);
    state.volume = typeof vol === 'number' ? Math.max(0, Math.min(1, vol)) : 0.8;
    state.chat = load('streamtv.chat', false) === true;

    loadTwitchScript();
    renderHome();
    focusChannelCard(state.favs[0]);
  })();
})();
