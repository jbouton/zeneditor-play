/* ZenMP — room-code, turn-based multiplayer on Firebase Realtime Database.

   Game-agnostic: it knows rooms, players, turns and an ordered log of events, and nothing
   about any particular game. Load order:

     <script src="multiplayer/vendor/firebase-app-compat.js"></script>
     <script src="multiplayer/vendor/firebase-auth-compat.js"></script>
     <script src="multiplayer/vendor/firebase-database-compat.js"></script>
     <script src="multiplayer/firebase-config.js"></script>
     <script src="multiplayer/zen-mp.js"></script>

   The one rule a game must follow: apply moves ONLY from the 'event' handler, never directly
   on tap. Every client receives every event (its own included) in the same server order, and
   that is what keeps the boards identical.

     ZenMP.on('event', ev => applyMove(ev.data));        // ev: {type,data,uid,mine,seq,replay}
     tile.onclick = () => ZenMP.send('move', {tile: 7}); // rejected locally when not your turn

   Typical flow:  createRoom()/joinRoom(code) -> host calls start() -> every client builds its
   board from ZenMP.rng() and then calls ready() -> events replay from the start and go live.

   URL switches for testing:  ?mpEmulator=1 (or =<host>) uses the local Firebase emulator;
   ?mpUser=B gives this window its own identity so two windows in one browser are two players. */
(function () {
  'use strict';

  var ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; /* no 0/O or 1/I/L */
  var STALE_MS = 24 * 60 * 60 * 1000;
  var qs = new URLSearchParams(location.search);
  var emu = qs.get('mpEmulator'), userTag = qs.get('mpUser') || '';
  var STORE_KEY = 'zenmp.room' + userTag;

  var app = null, auth = null, db = null, me = null, initP = null;
  var R = null; /* current room session */
  var handlers = {};

  function err(code, message) { var e = new Error(message); e.code = code; return e; }
  function denied(e) { return !!e && (e.code === 'PERMISSION_DENIED' || /permission[_ ]denied/i.test(String(e.message))); }
  function pad(n) { return ('000000' + n).slice(-6); }
  function TS() { return firebase.database.ServerValue.TIMESTAMP; }
  function emit(name, payload) {
    (handlers[name] || []).slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error('[ZenMP] ' + name + ' handler failed', e); }
    });
  }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randomInt(max) {
    var b = new Uint32Array(1); crypto.getRandomValues(b); return b[0] % max;
  }
  function randomCode() {
    var s = ''; for (var i = 0; i < 4; i++) s += ALPHABET[randomInt(ALPHABET.length)]; return s;
  }

  function config() {
    if (emu !== null) {
      return {
        firebase: { apiKey: 'demo-key', projectId: 'demo-zenmp', databaseURL: 'https://demo-zenmp-default-rtdb.firebaseio.com' },
        emulator: { host: emu && emu !== '1' ? emu : '127.0.0.1' }
      };
    }
    var c = window.ZEN_MP_CONFIG, f = c && c.firebase;
    if (!f || !f.apiKey || !f.databaseURL || /PASTE_/.test(f.apiKey + f.databaseURL)) return null;
    return c;
  }
  function available() {
    return !!config() && !!window.firebase && typeof firebase.database === 'function' &&
      typeof firebase.auth === 'function' && navigator.onLine !== false;
  }

  function init() {
    if (initP) return initP;
    initP = (async function () {
      if (!available()) throw err('unavailable', 'Multiplayer is not available (not configured, or offline).');
      var c = config(), name = 'zenmp' + userTag;
      app = firebase.apps.filter(function (a) { return a.name === name; })[0] || firebase.initializeApp(c.firebase, name);
      auth = app.auth(); db = app.database();
      if (c.emulator && !app.__zenEmu) {
        auth.useEmulator('http://' + c.emulator.host + ':9099', { disableWarnings: true });
        db.useEmulator(c.emulator.host, 9000);
        app.__zenEmu = true;
      }
      db.goOffline(); /* only hold a database connection while in a room */
      var cred = await auth.signInAnonymously();
      me = { uid: cred.user.uid };
      hookAppLifecycle();
      return { uid: me.uid };
    })();
    initP.catch(function () { initP = null; });
    return initP;
  }

  /* Backgrounding an Android app suspends the WebView; tell the room, and re-sync on return. */
  var hooked = false;
  function hookAppLifecycle() {
    if (hooked) return; hooked = true;
    var App = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App;
    if (!App || !App.addListener) return;
    App.addListener('appStateChange', function (state) {
      if (!R) return;
      var online = R.ref.child('players/' + me.uid + '/online');
      if (state.isActive) { db.goOnline(); online.set(true).catch(function () {}); }
      else online.set(false).catch(function () {});
    });
  }

  /* ---------- room session ---------- */
  function publicPlayers(r, val) {
    return Object.keys(val || {}).map(function (uid) {
      var p = val[uid];
      return { uid: uid, name: p.name, seat: Number(p.seat), score: p.score || 0, online: !!p.online, left: !!p.left,
        isMe: uid === me.uid, isHost: uid === r.hostUid };
    }).sort(function (a, b) { return a.seat - b.seat; });
  }
  function setTurn(r, uid, replay) {
    r.turn = uid;
    emit('turn', { uid: uid, mine: uid === me.uid, replay: replay });
  }
  function dispatch(r, key, ev) {
    var replay = key < r.replayUntil;
    if (ev.type === '__start') { if (ev.uid === r.hostUid && !r.started) { r.started = true; setTurn(r, ev.data.turn, replay); } return; }
    if (ev.type === '__turn') { if (ev.uid === r.turn) setTurn(r, ev.data.next, replay); return; }
    if (ev.type === '__finish') { emit('finish', { result: ev.data === undefined ? null : ev.data, uid: ev.uid, replay: replay }); return; }
    if (ev.type === '__rematch') { if (ev.uid === r.hostUid && !replay) emit('rematch', { code: ev.data.code }); return; }
    if (!ev.anyTurn && ev.uid !== r.turn) { console.warn('[ZenMP] dropped out-of-turn event', key); return; }
    emit('event', { type: ev.type, data: ev.data === undefined ? null : ev.data, uid: ev.uid, mine: ev.uid === me.uid,
      seq: parseInt(key, 10), replay: replay });
  }
  /* Deliver buffered events in key order, holding back anything of ours the server has not
     confirmed yet (a rejected write must never be applied). */
  function pump() {
    var r = R; if (!r || !r.ready) return;
    var keys = Array.from(r.buf.keys()).sort();
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (r.pending.has(k)) break;
      var ev = r.buf.get(k); r.buf.delete(k);
      if (k <= r.last) continue;
      r.last = k; dispatch(r, k, ev);
      if (R !== r) return;
    }
    if (!r.synced && (r.replayUntil === '000000' || (r.last !== '' && pad(parseInt(r.last, 10) + 1) >= r.replayUntil))) {
      r.synced = true; emit('synced', { code: r.code });
    }
  }
  function open(code, room) {
    var ref = db.ref('rooms/' + code);
    var r = R = {
      code: code, ref: ref, seed: room.seed, meta: room.meta === undefined ? null : room.meta, hostUid: room.hostUid,
      maxPlayers: room.maxPlayers, status: room.status, players: publicPlayers({ hostUid: room.hostUid }, room.players),
      turn: null, started: false, next: room.next || '000000', replayUntil: room.next || '000000', last: '',
      buf: new Map(), pending: new Set(), ready: false, synced: false, rng: mulberry32(room.seed),
      chain: Promise.resolve(), offs: []
    };
    function listen(q, type, fn) {
      var cb = q.on(type, function (s) { if (R === r) fn(s); }, function (e) { if (R === r) emit('error', e); });
      r.offs.push(function () { q.off(type, cb); });
    }
    listen(ref.child('status'), 'value', function (s) { if (s.val() && s.val() !== r.status) { r.status = s.val(); emit('status', { status: r.status }); } });
    listen(ref.child('players'), 'value', function (s) { r.players = publicPlayers(r, s.val()); emit('players', r.players); });
    listen(ref.child('next'), 'value', function (s) { r.next = s.val() || '000000'; });
    var events = ref.child('events').orderByKey();
    listen(events, 'child_added', function (s) { r.buf.set(s.key, s.val()); pump(); });
    listen(events, 'child_changed', function (s) { if (s.key > r.last) { r.buf.set(s.key, s.val()); pump(); } });
    listen(events, 'child_removed', function (s) { r.buf.delete(s.key); });
    listen(db.ref('.info/connected'), 'value', function (s) {
      var online = !!s.val();
      if (online) {
        var o = ref.child('players/' + me.uid + '/online');
        o.onDisconnect().set(false); o.set(true).catch(function () {});
      }
      emit('connection', { online: online });
    });
    try { localStorage.setItem(STORE_KEY, code); } catch (e) {}
    emit('status', { status: r.status });
    return { code: code, seed: r.seed, meta: r.meta };
  }

  /* Append one event at the room's next sequence number. The number is claimed by the
     write itself (rules reject a taken slot), so the log has one server-decided order. */
  function append(type, data, anyTurn, extra) {
    var r = R; if (!r) return Promise.reject(err('no_room', 'Not in a room.'));
    var job = r.chain.then(async function () {
      for (var attempt = 0; attempt < 25; attempt++) {
        if (R !== r) throw err('no_room', 'Left the room.');
        var key = r.next, ev = { uid: me.uid, type: type, t: TS() };
        if (data !== undefined && data !== null) ev.data = data;
        if (anyTurn) ev.anyTurn = true;
        var update = Object.assign({}, extra || {});
        update['events/' + key] = ev; update.next = pad(parseInt(key, 10) + 1);
        r.pending.add(key);
        try { await r.ref.update(update); r.pending.delete(key); pump(); return parseInt(key, 10); }
        catch (e) {
          r.pending.delete(key);
          if (!denied(e)) throw e;
          var s = await r.ref.child('next').get(); /* someone else took the slot: refresh and retry */
          if ((s.val() || '000000') === key) throw err('rejected', 'The server rejected that action.');
          r.next = s.val(); pump();
          await new Promise(function (res) { setTimeout(res, Math.random() * 30 * (attempt + 1)); }); /* jitter so racing senders interleave */
        }
      }
      throw err('busy', 'Could not send, please try again.');
    });
    r.chain = job.catch(function () {});
    return job;
  }

  async function createRoom(o) {
    o = o || {}; await init(); if (R) await leaveNow();
    db.goOnline();
    try {
      var max = Math.max(2, Math.min(4, o.maxPlayers || 2));
      for (var i = 0; i < 8; i++) {
        var code = randomCode(), players = {};
        players[me.uid] = { name: cleanName(o.name), seat: '0', score: 0, online: true, joinedAt: TS() };
        var room = { createdAt: TS(), hostUid: me.uid, seed: randomInt(0x7fffffff), status: 'lobby', maxPlayers: max,
          next: '000000', seats: { 0: me.uid }, players: players };
        if (o.meta !== undefined && o.meta !== null) room.meta = o.meta;
        try { await db.ref('rooms/' + code).set(room); }
        catch (e) { if (denied(e)) continue; throw e; } /* code in use: try another */
        return open(code, (await db.ref('rooms/' + code).get()).val());
      }
      throw err('busy', 'Could not create a room, please try again.');
    } finally { if (!R) db.goOffline(); }
  }

  async function joinRoom(code, o) {
    o = o || {}; code = String(code || '').trim().toUpperCase(); await init();
    if (R && R.code === code) return { code: code, seed: R.seed, meta: R.meta };
    if (R) await leaveNow();
    db.goOnline();
    try {
      var ref = db.ref('rooms/' + code), room = null;
      try { room = (await ref.get()).val(); } catch (e) { if (!denied(e)) throw e; }
      if (!room || room.createdAt < Date.now() - STALE_MS) {
        try { if (localStorage.getItem(STORE_KEY) === code) localStorage.removeItem(STORE_KEY); } catch (e) {}
        throw err('not_found', 'No room with that code.');
      }
      if (!(room.players && room.players[me.uid])) {
        if (room.status !== 'lobby') throw err('started', 'That game has already started.');
        var seats = room.seats || {}, seat = null, order = [];
        for (var n = 0; n < room.maxPlayers; n++) { if (seats[n] === me.uid) order.unshift(n); else if (seats[n] == null) order.push(n); }
        for (var j = 0; j < order.length && seat === null; j++) {
          try { await ref.child('seats/' + order[j]).set(me.uid); seat = order[j]; }
          catch (e) { if (!denied(e)) throw e; }
        }
        if (seat === null) throw err('full', 'That room is full.');
        await ref.child('players/' + me.uid).set({ name: cleanName(o.name), seat: String(seat), score: 0, online: true, joinedAt: TS() });
        room = (await ref.get()).val();
      }
      return open(code, room);
    } finally { if (!R) db.goOffline(); }
  }
  /* Room changes run one at a time: a join still in flight must never tear down a room that a
     later create has just opened. */
  var opChain = Promise.resolve();
  function serial(fn) {
    return function () {
      var args = arguments, p = opChain.then(function () { return fn.apply(null, args); });
      opChain = p.catch(function () {});
      return p;
    };
  }
  function cleanName(n) { n = String(n || '').trim().slice(0, 24); return n || 'Player'; }

  async function leaveNow() {
    var r = R; if (!r) return;
    R = null;
    r.offs.forEach(function (off) { off(); });
    var p = r.ref.child('players/' + me.uid);
    try {
      await p.child('online').onDisconnect().cancel();
      if (r.status === 'lobby') { await p.remove(); await r.ref.child('seats/' + mySeat(r)).remove(); }
      else await p.update({ online: false, left: true });
    } catch (e) { /* best effort: the room may already be gone or we may be offline */ }
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    db.goOffline();
    emit('status', { status: 'left' });
  }
  function mySeat(r) { var m = r.players.filter(function (p) { return p.isMe; })[0]; return m ? m.seat : 0; }

  function start(o) {
    var r = R; if (!r) return Promise.reject(err('no_room', 'Not in a room.'));
    if (r.hostUid !== me.uid) return Promise.reject(err('not_host', 'Only the host can start the game.'));
    if (r.players.length < ((o && o.minPlayers) || 2)) return Promise.reject(err('waiting', 'Waiting for another player.'));
    var first = (o && o.first) || me.uid;
    return append('__start', { turn: first }, true, { status: 'playing', turn: first });
  }
  function send(type, data, o) {
    var anyTurn = !!(o && o.anyTurn);
    if (!R) return Promise.reject(err('no_room', 'Not in a room.'));
    if (/^__/.test(String(type))) return Promise.reject(err('bad_type', 'Event types starting with __ are reserved.'));
    if (!anyTurn && R.turn !== me.uid) return Promise.reject(err('not_your_turn', 'It is not your turn.'));
    return append(String(type), data, anyTurn);
  }
  function endTurn(nextUid) {
    var r = R; if (!r) return Promise.reject(err('no_room', 'Not in a room.'));
    if (r.turn !== me.uid) return Promise.reject(err('not_your_turn', 'It is not your turn.'));
    if (!nextUid) {
      var active = r.players.filter(function (p) { return !p.left || p.isMe; });
      var i = active.findIndex(function (p) { return p.isMe; });
      nextUid = active[(i + 1) % active.length].uid;
    }
    return append('__turn', { next: nextUid }, false, { turn: nextUid });
  }
  function setScore(n) {
    if (!R) return Promise.reject(err('no_room', 'Not in a room.'));
    return R.ref.child('players/' + me.uid + '/score').set(Number(n) || 0);
  }
  function finish(result) {
    if (!R) return Promise.reject(err('no_room', 'Not in a room.'));
    return append('__finish', result, true, { status: 'done' });
  }
  /* Host opens a fresh room and tells the old one; other clients get 'rematch' {code}. */
  async function rematch() {
    var old = R; if (!old) throw err('no_room', 'Not in a room.');
    if (old.hostUid !== me.uid) throw err('not_host', 'Only the host can start a rematch.');
    var mine = old.players.filter(function (p) { return p.isMe; })[0];
    var room = { createdAt: TS(), hostUid: me.uid, seed: randomInt(0x7fffffff), status: 'lobby', maxPlayers: old.maxPlayers,
      next: '000000', seats: { 0: me.uid }, players: {} };
    room.players[me.uid] = { name: mine ? mine.name : 'Player', seat: '0', score: 0, online: true, joinedAt: TS() };
    if (old.meta !== null) room.meta = old.meta;
    for (var i = 0; i < 8; i++) {
      var code = randomCode();
      try { await db.ref('rooms/' + code).set(room); } catch (e) { if (denied(e)) continue; throw e; }
      await append('__rematch', { code: code }, true);
      old.offs.forEach(function (off) { off(); });
      old.ref.child('players/' + me.uid + '/online').onDisconnect().cancel();
      return open(code, (await db.ref('rooms/' + code).get()).val());
    }
    throw err('busy', 'Could not create a room, please try again.');
  }
  /* Call once the game has built its board: replays the log from the start, then goes live. */
  function ready() { if (R && !R.ready) { R.ready = true; pump(); } }

  async function share(o) {
    o = o || {};
    var code = R ? R.code : '', text = o.text || ('Join my game! Room code: ' + code);
    var Share = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Share;
    var payload = { title: o.title || 'Game invite', text: text }; if (o.url) payload.url = o.url;
    if (Share && Share.share) { await Share.share(payload); return 'shared'; }
    if (navigator.share) { try { await navigator.share(payload); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; } }
    await navigator.clipboard.writeText(o.url ? text + ' ' + o.url : text); return 'copied';
  }

  window.ZenMP = {
    init: init, createRoom: serial(createRoom), joinRoom: serial(joinRoom), leave: serial(leaveNow), start: start, send: send, endTurn: endTurn,
    setScore: setScore, finish: finish, rematch: serial(rematch), ready: ready, share: share,
    on: function (name, fn) { (handlers[name] = handlers[name] || []).push(fn); return function () { ZenMP.off(name, fn); }; },
    off: function (name, fn) { handlers[name] = (handlers[name] || []).filter(function (f) { return f !== fn; }); },
    rng: function () { if (!R) throw err('no_room', 'Not in a room.'); return R.rng(); },
    makeRng: function (salt) { if (!R) throw err('no_room', 'Not in a room.'); return mulberry32((R.seed ^ Math.imul((salt | 0) + 1, 0x9E3779B1)) >>> 0); },
    get available() { return available(); },
    get me() { return me; },
    get room() { return R ? { code: R.code, seed: R.seed, meta: R.meta, status: R.status, hostUid: R.hostUid, maxPlayers: R.maxPlayers, players: R.players, turn: R.turn, synced: R.synced } : null; },
    get isMyTurn() { return !!R && !!me && R.turn === me.uid; },
    get isHost() { return !!R && !!me && R.hostUid === me.uid; },
    get lastRoom() { try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; } }
  };
})();
