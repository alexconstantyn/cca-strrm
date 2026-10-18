/* StreamTV - player de canale Twitch pentru televizoare LG webOS.
 * Scris pentru Chromium 79 (webOS 6): fără ?. , ??, fără alte sintaxe noi.
 */
(function () {
  'use strict';

  // ---------- Coduri taste (telecomanda LG + tastatură pentru test pe PC) ----------
  var KEY = {
    BKSP: 8, ENTER: 13, ESC: 27, PAUSE: 19,
    CH_UP: 33, CH_DOWN: 34,
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    STOP: 413, PLAY: 415, BACK: 461,
    F1: 112, F2: 113, F3: 114, F4: 115
  };

  var DEFAULT_FAVS = ['twitch', 'monstercat', 'criticalrole', 'riotgames'];

  var state = {
    screen: 'home',
    channel: null,
    player: null,
    chat: false,
    muted: false,
    volume: 0.8,
    favs: [],
    recent: []
  };

  var hudTimer = null;
  var toastTimer = null;

  function $(sel) { return document.querySelector(sel); }

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
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
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
      try { best.scrollIntoView({ block: 'center' }); } catch (e) { /* ignorăm */ }
    }
  }

  function submitSearch() {
    var name = normalizeChannel($('#q').value);
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

  function startPlayer(name) {
    var box = $('#player');
    box.innerHTML = '';
    hideStatus();

    var host = location.hostname;
    if (!host) {
      showStatus('Aplicația trebuie deschisă de la o adresă web (https://…), nu dintr-un fișier local. ' +
                 'Altfel Twitch refuză să pornească playerul.');
      return;
    }
    if (!window.Twitch || !Twitch.Player) {
      showStatus('Nu pot încărca playerul Twitch. Verifică dacă televizorul are internet, apoi încearcă din nou.');
      return;
    }

    var p = new Twitch.Player('player', {
      channel: name,
      parent: [host],
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
  }

  function stopPlayer() {
    try { if (state.player && state.player.pause) { state.player.pause(); } } catch (e) { /* ignorăm */ }
    state.player = null;
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
    if (state.chat && state.channel && location.hostname) {
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
    applyChat();
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
    var p = state.player;
    if (p && typeof p.setChannel === 'function') { p.setChannel(next); }
    else { startPlayer(next); }
    if (state.chat) { applyChat(); }
    toast(next);
  }

  function changeVolume(delta) {
    state.volume = Math.max(0, Math.min(1, Math.round((state.volume + delta) * 10) / 10));
    save('streamtv.volume', state.volume);
    try {
      if (state.player) {
        state.player.setVolume(state.volume);
        if (state.muted && delta > 0) { state.muted = false; state.player.setMuted(false); }
      }
    } catch (e) { /* ignorăm */ }
    toast('Volum player: ' + Math.round(state.volume * 100) + '%');
  }

  function toggleMute() {
    state.muted = !state.muted;
    try { if (state.player) { state.player.setMuted(state.muted); } } catch (e) { /* ignorăm */ }
    toast(state.muted ? 'Sunet oprit' : 'Sunet pornit');
  }

  function togglePlay(forceState) {
    var p = state.player;
    if (!p) { return; }
    try {
      hideStatus();
      if (forceState === 'play') { p.play(); }
      else if (forceState === 'pause') { p.pause(); }
      else {
        var paused = typeof p.isPaused === 'function' ? p.isPaused() : false;
        if (paused) { p.play(); } else { p.pause(); }
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
    var p = state.player;
    if (!p || typeof p.getQualities !== 'function') { return; }
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
  $('#hud-back').addEventListener('click', goHome);
  $('#hotzone').addEventListener('mouseenter', function () { if (state.screen === 'player') { showHud(); } });
  document.addEventListener('mousemove', function () { if (state.screen === 'player') { showHud(); } });

  // Cât timp se redă, iframe-ul Twitch poate „fura” focusul și astfel telecomanda nu mai ajunge la noi.
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

    renderHome();
    focusChannelCard(state.favs[0]);
  })();
})();
