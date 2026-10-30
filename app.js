/*
 * ImperumTV – Samsung Smart TV (Tizen)
 * IPTV-Player für eigene Xtream-Zugänge. Enthält keine Sender oder Inhalte.
 * Wiedergabelisten werden auf der Website mit MAC-Adresse und Geräte-Schlüssel eingetragen.
 * Bewusst ohne neuere JS-Sprachmittel (?. ?? usw.), damit es auch auf Fernsehern ab 2018 läuft.
 */
(function () {
    'use strict';

    // =====================================================================
    // Hilfsfunktionen
    // =====================================================================

    function $(sel, root) { return (root || document).querySelector(sel); }

    function h(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = text;
        return n;
    }

    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    function fmtTime(sec) {
        if (!isFinite(sec) || sec < 0) sec = 0;
        sec = Math.floor(sec);
        var hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
        return hh > 0 ? hh + ':' + pad2(mm) + ':' + pad2(ss) : mm + ':' + pad2(ss);
    }

    function fmtClock(date) { return pad2(date.getHours()) + ':' + pad2(date.getMinutes()); }

    var Storage = {
        get: function (key, fallback) {
            try {
                var v = localStorage.getItem('imptv.' + key);
                return v === null ? fallback : JSON.parse(v);
            } catch (e) { return fallback; }
        },
        set: function (key, value) {
            try { localStorage.setItem('imptv.' + key, JSON.stringify(value)); } catch (e) { /* voll oder gesperrt */ }
        },
        remove: function (key) {
            try { localStorage.removeItem('imptv.' + key); } catch (e) { /* egal */ }
        }
    };

    function b64(s) {
        if (!s) return '';
        try { return decodeURIComponent(escape(atob(s))); } catch (e) { return s; }
    }

    var toastTimer = null;
    function toast(text, ms) {
        var t = $('#toast');
        t.textContent = text;
        t.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.classList.add('hidden'); }, ms || 3500);
    }

    /** Lade-Animation: goldenes Logo mit Lichtschimmer, Fortschrittsbalken und Schritten */
    var Loader = {
        built: false, steps: null, doneTimer: null,
        build: function () {
            var el = $('#loader');
            el.innerHTML = '';
            el.appendChild(h('div', 'ld-glow'));
            var wrap = h('div', 'ld-logo-wrap');
            var img = h('img', 'ld-logo');
            img.src = 'img/icon.png';
            wrap.appendChild(img);
            wrap.appendChild(h('div', 'ld-shine'));
            el.appendChild(wrap);
            var t = h('div', null);
            t.id = 'loader-text';
            el.appendChild(t);
            this.bar = h('div', 'ld-bar');
            this.fill = h('div', 'ld-fill');
            this.bar.appendChild(this.fill);
            el.appendChild(this.bar);
            this.stepsBox = h('div', 'ld-steps');
            el.appendChild(this.stepsBox);
            this.built = true;
        },
        /** steps: z. B. ['Anmelden', 'Sender laden', 'Fertig'] – ohne steps läuft der Balken endlos */
        show: function (text, steps) {
            if (!this.built) this.build();
            clearTimeout(this.doneTimer);
            var el = $('#loader');
            el.classList.remove('ld-finished', 'sync', 'sy-finished');
            el.onclick = null;
            $('#loader-text').textContent = text || 'Lädt …';
            this.steps = steps || null;
            this.stepsBox.innerHTML = '';
            if (steps) {
                var box = this.stepsBox;
                steps.forEach(function (name, i) {
                    if (i) box.appendChild(h('div', 'ld-line'));
                    var st = h('div', 'ld-step');
                    st.appendChild(h('span', 'ld-dot'));
                    st.appendChild(h('span', 'ld-name', name));
                    box.appendChild(st);
                });
                this.bar.classList.add('det');
                this.fill.style.width = '4%';
                this.step(0);
            } else {
                this.bar.classList.remove('det');
                this.fill.style.width = '';
            }
            el.classList.remove('hidden');
        },
        step: function (i) {
            if (!this.steps) return;
            var items = this.stepsBox.querySelectorAll('.ld-step');
            for (var k = 0; k < items.length; k++) {
                items[k].className = 'ld-step' + (k < i ? ' done' : k === i ? ' active' : '');
            }
            this.fill.style.width = Math.max(4, Math.round((i + 0.5) / this.steps.length * 100)) + '%';
        },
        /** Balken auf einen festen Wert (0–100) setzen, z. B. beim Update */
        progress: function (pct, text) {
            if (!this.built) this.build();
            this.bar.classList.add('det');
            this.fill.style.width = Math.max(2, Math.min(100, pct)) + '%';
            if (text) $('#loader-text').textContent = text;
        },
        /** Zum Schluss kurz „✓ Fertig“ zeigen, dann schließen */
        done: function (text, then, ms) {
            var self = this;
            if (this.steps) this.step(this.steps.length);
            this.fill.style.width = '100%';
            $('#loader-text').textContent = '✓  ' + text;
            $('#loader').classList.add('ld-finished');
            clearTimeout(this.doneTimer);
            this.doneTimer = setTimeout(function () { self.hide(); if (then) then(); }, ms || 1100);
        },
        hide: function () {
            clearTimeout(this.doneTimer);
            $('#loader').classList.add('hidden');
            $('#loader').classList.remove('ld-finished');
        }
    };
    function loader(show, text) {
        if (show) Loader.show(text); else Loader.hide();
    }

    /** Anmelden und Sender laden, mit Schritten in der Lade-Animation */
    // =====================================================================
    // Start & Aktualisieren: Live TV, Filme und Serien mit eigenem Lade-Bildschirm
    // =====================================================================

    var Sync = {
        cards: null, skip: null,
        show: function (title) {
            var el = $('#loader');
            Loader.built = false;                       // der normale Lade-Bildschirm baut sich später neu auf
            clearTimeout(Loader.doneTimer);
            el.innerHTML = '';
            el.className = 'sync';
            el.appendChild(h('div', 'sy-glow'));
            var logo = h('img', 'sy-logo');
            logo.src = 'img/logo-frei.png';
            el.appendChild(logo);
            var t = h('div', 'sy-title', title);
            t.id = 'loader-text';
            el.appendChild(t);
            var row = h('div', 'sy-cards');
            this.cards = {};
            var self = this;
            [['live', 'tv', 'Live TV'], ['movies', 'film', 'Filme'], ['series', 'series', 'Serien']].forEach(function (c) {
                var card = h('div', 'sy-card wait');
                var ico = h('div', 'sy-ico');
                ico.innerHTML = icon(c[1], 56);
                card.appendChild(ico);
                card.appendChild(h('div', 'sy-name', c[2]));
                var num = h('div', 'sy-num', '–');
                card.appendChild(num);
                var state = h('div', 'sy-state', 'wartet …');
                card.appendChild(state);
                var badge = h('div', 'sy-new hidden', '');
                card.appendChild(badge);
                var run = h('div', 'sy-run');
                run.appendChild(h('div', 'sy-beam'));
                card.appendChild(run);
                row.appendChild(card);
                self.cards[c[0]] = { card: card, num: num, state: state, badge: badge, timer: null };
            });
            el.appendChild(row);
            this.bar = h('div', 'sy-bar');
            this.fill = h('div', 'sy-fill');
            this.bar.appendChild(this.fill);
            el.appendChild(this.bar);
            this.hint = h('div', 'sy-hint', '');
            el.appendChild(this.hint);
            this.done = 0;
            this.skip = null;
            el.classList.remove('hidden');
        },
        /** state: 'load' | 'done' | 'fail' */
        card: function (kind, state, count, fresh, text) {
            var c = this.cards && this.cards[kind];
            if (!c) return;
            if (c.card.className !== 'sy-card ' + state) c.card.className = 'sy-card ' + state;
            if (state === 'load') { c.state.textContent = text || 'wird geladen …'; return; }
            if (state === 'fail') { c.state.textContent = text || 'gerade nicht erreichbar'; c.num.textContent = '–'; }
            if (state === 'done') {
                c.state.textContent = '✓ aktuell';
                this.countUp(c, count || 0);
                if (fresh > 0) { c.badge.textContent = '+' + fmtNum(fresh) + ' neu'; c.badge.classList.remove('hidden'); }
            }
            this.done++;
            this.setFill(this.done / 3);
        },
        /** Balken per transform (läuft auf der Grafikkarte, auch wenn gerade gerechnet wird) */
        setFill: function (part) {
            var v = 'scaleX(' + Math.max(0.04, Math.min(1, part)) + ')';
            this.fill.style.webkitTransform = v;
            this.fill.style.transform = v;
        },
        countUp: function (c, n) {
            c.timer = null;
            // Zahl gleich zeigen und weich einblenden – Hochzählen ruckelt, während das Gerät Listen auswertet
            c.num.textContent = fmtNum(n);
            c.num.classList.remove('pop');
            void c.num.offsetWidth;
            c.num.classList.add('pop');
        },
        /** Während Filme/Serien noch laden: mit OK schon loslegen */
        allowSkip: function (fn) {
            this.skip = fn;
            this.hint.textContent = 'OK drücken, um schon loszulegen – der Rest lädt im Hintergrund weiter';
            this.hint.classList.add('show');
            $('#loader').onclick = function () { if (Sync.skip) Sync.skip(); };   // Finger/Maus
        },
        finish: function (text, then, ms) {
            var el = $('#loader');
            this.skip = null;
            this.hint.classList.remove('show');
            this.setFill(1);
            $('#loader-text').textContent = '✓  ' + text;
            el.classList.add('sy-finished');
            setTimeout(function () { Sync.hide(); if (then) then(); }, ms || 900);
        },
        hide: function () {
            var el = $('#loader');
            this.skip = null;
            for (var k in this.cards || {}) if (this.cards.hasOwnProperty(k)) clearInterval(this.cards[k].timer);
            el.classList.add('hidden');
            el.className = 'hidden';
            el.innerHTML = '';
            el.onclick = null;
        }
    };
    function fmtNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }

    /**
     * Anmelden und alles laden: Live TV, dann Filme und Serien gleichzeitig.
     * Neu = mehr Einträge als beim letzten Mal auf diesem Gerät.
     */
    function syncAll(acc, title, onOk, onErr, pending) {
        var key = 'counts.' + (acc.demo ? 'demo' : acc.server + '|' + acc.username);
        var before = Storage.get(key, null);
        var finished = false, left = 2, mvOk = true, srOk = true;
        function fresh(now, old) { return before && old > 0 && now > old ? now - old : 0; }
        Sync.show(title);
        Sync.card('live', 'load', 0, 0, 'Anmelden …');
        (pending || Data.login(acc, function (i) { if (i === 1) Sync.card('live', 'load', 0, 0, 'Sender werden geladen …'); })).then(function () {
            Sync.card('live', 'done', Data.channels.length, fresh(Data.channels.length, before && before.c));
            Sync.card('movies', 'load');
            Sync.card('series', 'load');
            // Wer nicht warten will: los geht's, Filme/Serien laden im Hintergrund fertig
            Sync.allowSkip(function () { done(true); });
            Data.loadMovies().then(null, function () { mvOk = false; }).then(function () {
                if (mvOk) Sync.card('movies', 'done', Data.movies.length, fresh(Data.movies.length, before && before.m));
                else Sync.card('movies', 'fail');
                part();
            });
            Data.loadSeries().then(null, function () { srOk = false; }).then(function () {
                if (srOk) Sync.card('series', 'done', Data.series.length, fresh(Data.series.length, before && before.s));
                else Sync.card('series', 'fail');
                part();
            });
        }, function (e) {
            Sync.hide();
            onErr(e);
        });
        function part() {
            left--;
            if (left > 0) return;
            Storage.set(key, { c: Data.channels.length, m: Data.moviesLoaded ? Data.movies.length : (before ? before.m : 0),
                s: Data.seriesLoaded ? Data.series.length : (before ? before.s : 0) });
            done(false);
        }
        function done(skipped) {
            if (finished) return;
            finished = true;
            if (skipped) { Sync.hide(); onOk(); return; }
            Sync.finish(mvOk && srOk ? 'Alles aktuell' : 'Live TV ist bereit', onOk, 1100);
        }
    }

    function loginWithSteps(acc, title, onOk, onErr, showMs, pending) {
        var before = Data.channels.length;
        Loader.show(title, ['Anmelden', 'Sender laden', 'Fertig']);
        (pending || Data.login(acc, function (i) { Loader.step(i); })).then(function () {
            var n = Data.channels.length, diff = before ? n - before : 0;
            var text = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' Sender geladen' + (diff > 0 ? ' (+' + diff + ' neue)' : '');
            Loader.done(text, onOk, showMs || 500);
        }, function (e) {
            Loader.hide();
            onErr(e);
        });
    }

    // Einfache Symbole als SVG (Fernseher haben nicht immer passende Schriftzeichen)
    var ICONS = {
        tv: '<rect x="2.5" y="4.5" width="19" height="13" rx="2"/><path d="M8 21h8M12 17.5V21"/>',
        film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4"/>',
        series: '<rect x="2.5" y="6" width="15" height="12" rx="2"/><path d="M8.5 9.5l4 2.5-4 2.5z"/><path d="M6 3.5h14.5a1 1 0 0 1 1 1V15"/>',
        star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
        refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
        user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
        logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3"/>',
        crown: '<path d="M3 18h18M4 16l-1-9 5 4 4-6 4 6 5-4-1 9z"/>',
        list: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h10M7 17h6"/>',
        back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
        search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8"/>',
        sort: '<path d="M7 4v16M3.5 16.5L7 20l3.5-3.5M17 20V4M13.5 7.5L17 4l3.5 3.5"/>',
        resume: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.2 3.8v4.6h4.6"/><path d="M10 8.6l5.2 3.4-5.2 3.4z"/>',
        lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
        rec: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4" fill="currentColor"/>',
        gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.9 1.9M16.6 16.6l1.9 1.9M5.5 18.5l1.9-1.9M16.6 7.4l1.9-1.9"/><circle cx="12" cy="12" r="6.2"/>',
        epg: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h10M7 17h6"/><circle cx="5.2" cy="9" r=".4"/><circle cx="5.2" cy="13" r=".4"/><circle cx="5.2" cy="17" r=".4"/>'
    };
    function icon(name, size) {
        return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" ' +
            'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
    }

    // =====================================================================
    // Bildschirmgröße: Oberfläche ist für 1920 x 1080 gebaut und wird skaliert
    // =====================================================================

    var scale = 1, offX = 0, offY = 0;
    function viewportSize() {
        var de = document.documentElement;
        var w = window.innerWidth || (de && de.clientWidth) || 0;
        var hh = window.innerHeight || (de && de.clientHeight) || 0;
        // Größe noch unbekannt (manche Fernseher melden sie erst später): vorerst Full HD annehmen
        if (w < 100 || hh < 100) { w = 1920; hh = 1080; }
        return { w: w, h: hh };
    }
    function applyScale() {
        var vp = viewportSize(), w = vp.w, hh = vp.h;
        scale = Math.min(w / 1920, hh / 1080);
        offX = Math.round((w - 1920 * scale) / 2);
        offY = Math.round((hh - 1080 * scale) / 2);
        var st = $('#stage');
        st.style.transform = 'scale(' + scale + ')';
        st.style.left = offX + 'px';
        st.style.top = offY + 'px';
    }

    /** Position eines Elements in 1920er-Koordinaten */
    function stageRect(node) {
        var r = node.getBoundingClientRect();
        return { x: (r.left - offX) / scale, y: (r.top - offY) / scale, w: r.width / scale, h: r.height / scale };
    }

    /** Android-App: Verbindung zum eingebauten Video-Player (ExoPlayer) */
    var AB = window.AndroidBridge || null;

    // =====================================================================
    // Fernbedienung
    // =====================================================================

    var KEY = {
        LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
        BACK: 10009, ESC: 27, BACKSPACE: 8,
        PLAY: 415, PAUSE: 19, PLAYPAUSE: 10252, STOP: 413, FF: 417, RW: 412,
        CH_UP: 427, CH_DOWN: 428,
        RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
        IME_DONE: 65376, IME_CANCEL: 65385
    };

    function registerKeys() {
        if (typeof tizen === 'undefined' || !tizen.tvinputdevice) return;
        var keys = ['MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
            'ChannelUp', 'ChannelDown', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue'];
        for (var i = 0; i < keys.length; i++) {
            try { tizen.tvinputdevice.registerKey(keys[i]); } catch (e) { /* Taste gibt es nicht */ }
        }
    }

    /** LG-Fernseher (webOS) */
    var WEBOS = !!(window.PalmSystem || window.webOSSystem);

    function exitApp() {
        Player.stop();
        if (AB) { AB.exit(); return; }
        if (WEBOS) {
            try {
                if (window.webOSSystem && webOSSystem.platformBack) { webOSSystem.platformBack(); return; }
                if (window.PalmSystem && PalmSystem.platformBack) { PalmSystem.platformBack(); return; }
            } catch (e0) { /* weiter unten */ }
            try { window.close(); } catch (e1) { /* egal */ }
            return;
        }
        try { tizen.application.getCurrentApplication().exit(); } catch (e) { toast('App beenden geht nur auf dem Fernseher.'); }
    }

    // =====================================================================
    // Fokus-Steuerung mit den Pfeiltasten
    // =====================================================================

    function ensureVisible(node) {
        // Waagerechte Reihen (z. B. Schauspieler) seitlich mitscrollen
        var hp = node.parentElement;
        while (hp && !(hp.classList && hp.classList.contains('hscroll'))) hp = hp.parentElement;
        if (hp) {
            var a = node.getBoundingClientRect(), b = hp.getBoundingClientRect(), m = 20 * scale;
            if (a.left < b.left + m) hp.scrollLeft -= (b.left + m - a.left) / scale;
            else if (a.right > b.right - m) hp.scrollLeft += (a.right - b.right + m) / scale;
        }
        var p = node.parentElement;
        while (p && !(p.classList && (p.classList.contains('scroll') || p.classList.contains('vscroll')))) p = p.parentElement;
        if (!p) return;
        var nr = node.getBoundingClientRect(), pr = p.getBoundingClientRect();
        var margin = 30 * scale;
        if (nr.top < pr.top + margin) p.scrollTop -= (pr.top + margin - nr.top) / scale;
        else if (nr.bottom > pr.bottom - margin) p.scrollTop += (nr.bottom - pr.bottom + margin) / scale;
        // Einstellungen: beim letzten Eintrag ganz nach unten (damit der Hinweis darunter sichtbar wird)
        if (p.classList.contains('settings')) {
            var all = p.querySelectorAll('.focusable');
            if (all.length && all[all.length - 1] === node) p.scrollTop = p.scrollHeight;
            else if (all.length && all[0] === node) p.scrollTop = 0;
        }
    }

    var VERTICAL_LOCK = { cats: true, list: true, grid: true };
    var HORIZONTAL_LOCK = { cast: true, seasons: true, buttons: true, player: true, tiles: true, circles: true, acc: true, topbtns: true };

    var Focus = {
        cur: null,
        memory: {},

        set: function (node, noScroll) {
            if (!node) return;
            if (this.cur && this.cur !== node) this.cur.classList.remove('focused');
            this.cur = node;
            node.classList.add('focused');
            var zone = node.getAttribute('data-zone');
            if (zone) this.memory[zone] = node;
            if (!noScroll) ensureVisible(node);
            if (node._onFocus) node._onFocus();
        },

        clear: function () {
            if (this.cur) this.cur.classList.remove('focused');
            this.cur = null;
            this.memory = {};
        },

        all: function () {
            // Ist ein Auswahlfenster offen, nur dessen Knöpfe
            var list = document.querySelectorAll(Modal.node ? '#modal .focusable' : '#stage .focusable');
            var out = [];
            for (var i = 0; i < list.length; i++) {
                if (list[i].offsetParent !== null) out.push(list[i]);
            }
            return out;
        },

        isValid: function (node) {
            return node && document.body.contains(node) && node.offsetParent !== null;
        },

        first: function () {
            var all = this.all();
            if (all.length) this.set(all[0]);
        },

        byKey: function (key) {
            if (!key) return null;
            var root = document.querySelector(Modal.node ? '#modal' : '#stage');
            if (!root) return null;
            var nodes = root.querySelectorAll('.focusable[data-key="' + String(key).replace(/["\\]/g, '\\$&') + '"]');
            for (var i = 0; i < nodes.length; i++) {
                if (nodes[i].offsetParent !== null) return nodes[i];
            }
            return null;
        },

        /** Mögliche Ziele für die Pfeiltasten. In langen Listen nur die Nachbarn, sonst wird es bei Tausenden Postern zäh. */
        candidates: function (cur) {
            var list = document.querySelectorAll(Modal.node ? '#modal .focusable' : '#stage .focusable');
            var parent = cur.parentNode, kids = parent ? parent.children : null;
            var big = !!(kids && kids.length > 300);
            var out = [];
            if (big) {
                var idx = Array.prototype.indexOf.call(kids, cur);
                for (var j = Math.max(0, idx - 60); j < Math.min(kids.length, idx + 61); j++) {
                    var k = kids[j];
                    if (k.classList.contains('focusable') && k.offsetParent !== null) out.push(k);
                }
            }
            for (var i = 0; i < list.length; i++) {
                var n = list[i];
                if (big && n.parentNode === parent) continue;
                if (n.offsetParent !== null) out.push(n);
            }
            return out;
        },

        move: function (dir) {
            var cur = this.cur;
            if (!this.isValid(cur)) { this.first(); return false; }
            var r = cur.getBoundingClientRect();
            var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            var nodes = this.candidates(cur);
            var best = null, bestScore = Infinity;
            var zone = cur.getAttribute('data-zone');
            var vertical = dir === 'up' || dir === 'down';
            // Spalten verlässt man nur nach links/rechts, Reihen nur nach oben/unten
            var lockedHere = zone && (vertical ? VERTICAL_LOCK[zone] : HORIZONTAL_LOCK[zone]);

            for (var i = 0; i < nodes.length; i++) {
                var n = nodes[i];
                if (n === cur) continue;
                if (lockedHere && n.getAttribute('data-zone') !== zone) continue;
                var b = n.getBoundingClientRect();
                var dx = (b.left + b.width / 2) - cx, dy = (b.top + b.height / 2) - cy;
                var primary, secondary;
                if (dir === 'left') { if (dx > -2) continue; primary = -dx; secondary = Math.abs(dy); }
                else if (dir === 'right') { if (dx < 2) continue; primary = dx; secondary = Math.abs(dy); }
                else if (dir === 'up') { if (dy > -2) continue; primary = -dy; secondary = Math.abs(dx); }
                else { if (dy < 2) continue; primary = dy; secondary = Math.abs(dx); }
                var score = primary + secondary * 2.5;
                if (score < bestScore) { bestScore = score; best = n; }
            }
            if (!best) return false;

            // In eine andere Spalte gewechselt: dorthin zurück, wo man zuletzt war
            var curZone = cur.getAttribute('data-zone'), bestZone = best.getAttribute('data-zone');
            if (bestZone && bestZone !== curZone) {
                var remembered = this.memory[bestZone];
                // Zurück in die Kategorien: immer auf die gewählte Kategorie (z. B. „Bundesliga“)
                if (bestZone === 'cats') {
                    var active = document.querySelector('.col-cats .cat.active');
                    if (this.isValid(active)) remembered = active;
                }
                if (this.isValid(remembered)) best = remembered;
            }
            this.set(best);
            return true;
        },

        activate: function () {
            var n = this.cur;
            if (!this.isValid(n)) return;
            if (n.tagName === 'INPUT') {
                n.focus();
                if (AB) AB.showKeyboard();
                return;
            }
            if (n._action) n._action();
        }
    };

    /** Macht ein Element fernbedienbar */
    function focusable(node, key, action, zone) {
        node.classList.add('focusable');
        if (key) node.setAttribute('data-key', key);
        if (zone) node.setAttribute('data-zone', zone);
        node._action = action;
        node.addEventListener('click', function () {   // Maus/Touch
            if (node._longAt && Date.now() - node._longAt < 900) return;   // war ein langes Tippen
            Focus.set(node);
            if (node.tagName === 'INPUT') node.focus(); else if (action) action();
        });
        // LG Magic Remote: der Zeiger markiert, worauf er zeigt (ohne die Liste zu verschieben)
        if (WEBOS) node.addEventListener('mousemove', function () {
            if (Focus.cur === node || (Modal.node && !Modal.node.contains(node))) return;
            Focus.set(node, true);
        });
        // Langes Tippen mit dem Finger (Handy/Tablet)
        node.addEventListener('contextmenu', function (ev) {
            if (!node._onLong) return;
            ev.preventDefault();
            node._longAt = Date.now();
            Focus.set(node);
            node._onLong();
        });
        return node;
    }

    /**
     * Langes Drücken auf OK. Wird nur genutzt, wenn das Element eine Aktion für langes Drücken hat
     * und die Fernbedienung das Loslassen meldet (sonst reagiert OK wie bisher sofort).
     */
    var LongPress = {
        upSeen: false, node: null, timer: null, fired: false,
        start: function (node) {
            var self = this;
            this.cancel();
            this.node = node;
            this.fired = false;
            this.timer = setTimeout(function () {
                self.timer = null;
                if (self.node && Focus.cur === self.node && self.node._onLong) { self.fired = true; self.node._onLong(); }
            }, 650);
        },
        up: function () {
            this.upSeen = true;
            var n = this.node;
            this.node = null;
            if (!n) return;
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = null;
                if (!this.fired && Focus.cur === n) Focus.activate();
            }
        },
        cancel: function () { if (this.timer) clearTimeout(this.timer); this.timer = null; this.node = null; }
    };

    /** Favorit umschalten und den Stern am Element aktualisieren */
    function favToggleNode(node, type, item) {
        var on = Favs.toggle(type, item.id);
        var img = $('.img', node);
        if (img) {
            var st = $('.fav', node);
            if (on && !st) img.appendChild(h('div', 'fav', '★'));
            if (!on && st) st.parentNode.removeChild(st);
        } else {
            var s2 = $('.star', node);
            if (on && !s2) node.appendChild(h('div', 'star', '★'));
            if (!on && s2) s2.parentNode.removeChild(s2);
        }
        toast(on ? item.name + ' zu Favoriten hinzugefügt' : item.name + ' aus Favoriten entfernt');
        return on;
    }

    /** Lange Listen nur stückweise aufbauen, damit der Fernseher flüssig bleibt */
    function batchRender(container, items, make, size) {
        var shown = 0;
        function more() {
            var end = Math.min(items.length, shown + size);
            for (var i = shown; i < end; i++) {
                (function (index) {
                    var node = make(items[index], index);
                    var prev = node._onFocus;
                    node._onFocus = function () {
                        if (prev) prev();
                        if (index >= shown - 8 && shown < items.length) more();
                    };
                    container.appendChild(node);
                })(i);
            }
            shown = end;
        }
        more();
        // Für „Zurück“: Nav kann weitere Einträge nachladen, bis der gemerkte Eintrag wieder da ist
        container.classList.add('batch');
        container._batchMore = function () { if (shown >= items.length) return false; more(); return true; };
        // Maus/Finger: beim Scrollen nachladen (ohne Fokus würde sonst nach dem ersten Stapel Schluss sein)
        var sc = container;
        while (sc && !(sc.classList && (sc.classList.contains('scroll') || sc.classList.contains('vscroll')))) sc = sc.parentElement;
        if (sc) sc.addEventListener('scroll', function () {
            if (shown < items.length && sc.scrollTop + sc.clientHeight > sc.scrollHeight - 1500) more();
        });
        return {
            ensure: function (index) { while (shown <= index && shown < items.length) more(); }
        };
    }

    /**
     * Poster-Raster, das nur die sichtbaren Reihen (plus Puffer) wirklich anlegt.
     * Egal wie lang die Liste ist: es gibt immer nur gut 50 Poster auf der Seite – Scrollen bleibt flüssig.
     * Maße passen zu .poster in style.css (212 × 376 px, Abstand 14 px, Reihe 400 px).
     */
    function virtualGrid(scroll, grid, items, make) {
        // Puffer: 1 Reihe nach oben, 3 nach unten (dort lädt man meist hin – Bilder sind dann schon da)
        var COLW = 226, ROWH = 400, PADT = 10, PADL = 24, PADB = 40, BUF_UP = 1, BUF_DOWN = 3;
        grid.classList.add('vgrid');
        var cols = Math.max(1, Math.floor(((scroll.clientWidth || 1500) - PADL) / COLW));
        var rows = Math.ceil(items.length / cols);
        grid.style.height = (PADT + rows * ROWH + PADB) + 'px';
        var nodes = {}, first = -1, last = -1, queued = false;

        function place(n, i) {
            n.style.left = (PADL + (i % cols) * COLW) + 'px';
            n.style.top = (PADT + 14 + Math.floor(i / cols) * ROWH) + 'px';
        }
        function update(force) {
            if (!items.length) return;
            var top = scroll.scrollTop, hgt = scroll.clientHeight || 970;
            var r0 = Math.max(0, Math.floor((top - PADT) / ROWH) - BUF_UP);
            var r1 = Math.min(rows - 1, Math.floor((top + hgt - PADT) / ROWH) + BUF_DOWN);
            var a = r0 * cols, b = Math.min(items.length - 1, (r1 + 1) * cols - 1);
            if (!force && a === first && b === last) return;
            for (var k in nodes) {
                if (!nodes.hasOwnProperty(k)) continue;
                var idx = +k;
                if ((idx < a || idx > b) && nodes[k] !== Focus.cur) { grid.removeChild(nodes[k]); delete nodes[k]; }
            }
            var frag = document.createDocumentFragment();
            for (var i = a; i <= b; i++) {
                if (nodes[i]) continue;
                var n = make(items[i], i);
                n._vIndex = i;
                // Bild gleich laden: hier entstehen ohnehin nur Poster nahe am sichtbaren Bereich
                var im = n.querySelector('.img');
                if (im && im._lazyUrl) LazyImg.apply(im);
                place(n, i);
                nodes[i] = n;
                frag.appendChild(n);
            }
            grid.appendChild(frag);
            first = a; last = b;
        }
        scroll.addEventListener('scroll', function () {
            if (queued) return;
            queued = true;
            (window.requestAnimationFrame || setTimeout)(function () { queued = false; update(); });
        });
        grid._vgUpdate = function () { update(); };
        update(true);
        return {
            update: function () { update(); },
            /** Eintrag i sichtbar machen (z. B. nach „Zurück“) */
            ensure: function (i) {
                if (i < 0 || i >= items.length) return;
                var rowTop = PADT + Math.floor(i / cols) * ROWH;
                var hgt = scroll.clientHeight || 970;
                if (rowTop < scroll.scrollTop || rowTop + ROWH > scroll.scrollTop + hgt) scroll.scrollTop = Math.max(0, rowTop - ROWH);
                update();
            }
        };
    }

    // =====================================================================
    // Einstellungen und Favoriten
    // =====================================================================

    var Settings = {
        autoNext: Storage.get('autoNext', true),     // Serien: nächste Folge automatisch
        introBtn: Storage.get('introBtn', true),     // Serien: Knopf „Intro überspringen“
        introSec: 20,
        setFlag: function (name, on) { this[name] = on; Storage.set(name, on); },
        liveExt: Storage.get('liveExt', (window.PalmSystem || window.webOSSystem) ? 'm3u8' : 'ts'),   // 'ts' oder 'm3u8' (LG: HLS)
        setLiveExt: function (ext) { this.liveExt = ext; Storage.set('liveExt', ext); }
    };

    var Favs = {
        set: null,
        load: function () { this.set = {}; var list = Storage.get('favs', []); for (var i = 0; i < list.length; i++) this.set[list[i]] = true; },
        has: function (type, id) { return !!this.set[type + ':' + id]; },
        toggle: function (type, id) {
            var k = type + ':' + id;
            if (this.set[k]) delete this.set[k]; else this.set[k] = true;
            Storage.set('favs', Object.keys(this.set));
            return !!this.set[k];
        }
    };

    // =====================================================================
    // Weiterschauen: merkt sich bei Filmen und Serienfolgen, wo man aufgehört hat
    // =====================================================================

    var Resume = {
        MAX: 40,
        cache: null,
        accKey: function () { var a = Api.acc; return a ? a.server + '|' + a.username : ''; },
        raw: function () {
            if (!this.cache) { var l = Storage.get('resume', []); this.cache = Array.isArray(l) ? l : []; }
            return this.cache;
        },
        write: function (list) { this.cache = list; Storage.set('resume', list); },
        /** Einträge der aktuellen Wiedergabeliste, neueste zuerst */
        all: function () {
            var acc = this.accKey();
            var list = this.raw().filter(function (e) { return e.acc === acc; });
            if (Parental.enabled() && !Parental.unlocked()) {
                var hidden = {};
                Data.movies.forEach(function (m) { if (Parental.catProtected('movie', m.cat)) hidden['movie:' + m.id] = true; });
                Data.series.forEach(function (x) { if (Parental.catProtected('series', x.cat)) hidden['series:' + x.id] = true; });
                list = list.filter(function (e) { return !hidden[e.key]; });
            }
            return list;
        },
        keyFor: function (kind, it) {
            if (kind === 'episode') return 'series:' + (it.series ? it.series.id : 'ep' + it.id);
            return 'movie:' + it.id;
        },
        /** Eintrag genau für diesen Film bzw. diese Folge */
        forItem: function (kind, it) {
            if (!it || it.type === 'recording') return null;
            var key = this.keyFor(kind, it), acc = this.accKey(), list = this.raw();
            for (var i = 0; i < list.length; i++) {
                var e = list[i];
                if (e.acc === acc && e.key === key && String(e.id) === String(it.id)) return e;
            }
            return null;
        },
        forSeries: function (seriesId) {
            var key = 'series:' + seriesId, acc = this.accKey(), list = this.raw();
            for (var i = 0; i < list.length; i++) if (list[i].acc === acc && list[i].key === key) return list[i];
            return null;
        },
        save: function (kind, it, pos, dur, next) {
            var acc = this.accKey(), key = this.keyFor(kind, it);
            var e = {
                acc: acc, key: key, kind: kind, id: it.id, name: it.name, logo: it.logo || '', ext: it.ext || '',
                pos: Math.floor(pos), dur: Math.floor(dur), at: Date.now(), next: !!next
            };
            if (kind === 'episode') {
                e.season = it.season; e.num = it.num;
                if (it.series) { e.series = it.series; e.logo = it.series.logo || e.logo; }
            }
            var list = this.raw().filter(function (x) { return !(x.acc === acc && x.key === key); });
            list.unshift(e);
            if (list.length > this.MAX) list = list.slice(0, this.MAX);
            this.write(list);
        },
        remove: function (key) {
            var acc = this.accKey();
            this.write(this.raw().filter(function (x) { return !(x.acc === acc && x.key === key); }));
        },
        /** Stand nach dem Schauen merken (eigener oder externer Player) */
        record: function (kind, items, index, pos, dur, ended) {
            var it = items[index];
            if (!it || it.type === 'recording' || it.url) return;
            var done = ended || (dur > 60 && (pos >= dur * 0.95 || dur - pos < 60));
            if (done) {
                var next = kind === 'episode' ? items[index + 1] : null;
                if (next) this.save('episode', next, 0, 0, true);
                else this.remove(this.keyFor(kind, it));
            } else if (dur > 60 && pos >= 30) {
                this.save(kind, it, pos, dur, false);
            }
        },
        /** Fortschritt 0 … 1 */
        part: function (e) { return e && e.dur > 0 ? Math.max(0, Math.min(1, e.pos / e.dur)) : 0; },
        /** Kurztext: "Noch 23 Min." */
        leftText: function (e) {
            if (e.next) return 'Nächste Folge';
            var min = Math.max(1, Math.round((e.dur - e.pos) / 60));
            return 'Noch ' + min + ' Min.';
        },
        label: function (e) {
            if (e.kind !== 'episode') return e.name;
            return (e.series ? e.series.name : e.name) + ' · S' + e.season + ' F' + (e.num || '?');
        }
    };

    /** Fortschrittsbalken für Poster und Folgen */
    function progressNode(part) {
        var p = h('div', 'prog');
        var b = h('div', 'bar');
        b.style.width = Math.round(part * 100) + '%';
        p.appendChild(b);
        return p;
    }

    // =====================================================================
    // Player für Filme und Serien: eingebaut oder extern (VLC, MX Player … – nur Android)
    // =====================================================================

    var VodPlayer = {
        pending: null,
        available: function () { return !!(AB && AB.openExternal && AB.externalPlayers); },
        list: function () {
            if (!this.available()) return [];
            try { return JSON.parse(AB.externalPlayers()) || []; } catch (e) { return []; }
        },
        /** '' = ImperumTV-Player, 'ask' = jedes Mal fragen, sonst Paketname */
        pref: function () { return this.available() ? Storage.get('vodPlayer', '') : ''; },
        setPref: function (v) { Storage.set('vodPlayer', v); },
        nameOf: function (pkg) {
            if (!pkg) return 'ImperumTV';
            if (pkg === 'ask') return 'Jedes Mal fragen';
            var l = this.list();
            for (var i = 0; i < l.length; i++) if (l[i].pkg === pkg) return l[i].name;
            return 'ImperumTV';
        },
        installed: function (pkg) {
            var l = this.list();
            for (var i = 0; i < l.length; i++) if (l[i].pkg === pkg) return true;
            return false;
        },
        /** Startet Film/Folge im gewählten Player */
        play: function (items, index, kind, at) {
            var p = this.pref();
            if (p === 'ask') { this.choose(items, index, kind, at); return; }
            if (p && this.installed(p)) { this.launch(p, items, index, kind, at); return; }
            Nav.push(new PlayerScreen(items, index, kind, at));
        },
        /** Auswahl für dieses eine Mal */
        choose: function (items, index, kind, at) {
            var self = this, list = this.list();
            var buttons = [{ label: '▶  ImperumTV-Player', primary: true, action: function () { Nav.push(new PlayerScreen(items, index, kind, at)); } }];
            list.forEach(function (pl) {
                buttons.push({ label: '▶  ' + pl.name, action: function () { self.launch(pl.pkg, items, index, kind, at); } });
            });
            buttons.push({ label: 'Abbrechen' });
            Modal.open('Womit abspielen?', list.length ? 'Den Standard-Player stellst du in den Einstellungen ein.'
                : 'Kein anderer Player installiert. Installiere z. B. VLC oder MX Player aus dem Store.', buttons);
            if (Modal.node) Modal.node.classList.add('modal-list');
        },
        /** Standard-Player festlegen. done() wird danach aufgerufen. */
        pick: function (done) {
            var self = this, cur = this.pref(), list = this.list();
            var opts = [{ pkg: '', name: 'ImperumTV-Player (eingebaut)' }, { pkg: 'ask', name: 'Jedes Mal fragen' }].concat(list);
            var buttons = opts.map(function (o) {
                return { label: (o.pkg === cur ? '✓  ' : '      ') + o.name, primary: o.pkg === cur,
                    action: function () { self.setPref(o.pkg); toast('Player für Filme & Serien: ' + self.nameOf(o.pkg)); if (done) done(); } };
            });
            buttons.push({ label: 'Abbrechen' });
            Modal.open('Player für Filme & Serien', list.length ? '' : 'Kein anderer Player installiert. Installiere z. B. VLC oder MX Player aus dem Store.', buttons);
            if (Modal.node) Modal.node.classList.add('modal-list');
        },
        url: function (kind, it) { return kind === 'movie' ? Api.movieUrl(it.id, it.ext) : Api.episodeUrl(it.id, it.ext); },
        launch: function (pkg, items, index, kind, at) {
            var it = items[index];
            var title = kind === 'episode' && it.series ? it.series.name + ' – S' + it.season + ' F' + (it.num || '') + ' ' + it.name : it.name;
            this.pending = { items: items, index: index, kind: kind };
            toast('Wird in ' + this.nameOf(pkg) + ' geöffnet …');
            AB.openExternal(this.url(kind, it), pkg, title, at || 0);
        },
        /** Antwort vom externen Player (Position/Länge in Millisekunden) */
        returned: function (pos, dur, done, failed) {
            var p = this.pending;
            this.pending = null;
            if (failed) { toast('Der Player ließ sich nicht öffnen. Wähle einen anderen in den Einstellungen.', 6000); return; }
            if (!p) return;
            if (done || (pos >= 0 && dur > 0)) Resume.record(p.kind, p.items, p.index, Math.max(0, pos) / 1000, Math.max(0, dur) / 1000, !!done);
            var top = Nav.top();
            if (top && !(top instanceof PlayerScreen) && !Modal.node) {
                top.focusKey = Focus.cur ? Focus.cur.getAttribute('data-key') : top.focusKey;
                Nav.show(top);
            }
        }
    };
    window.__androidExternal = function (pos, dur, done, failed) { VodPlayer.returned(pos, dur, done, failed); };

    /** Knopf „⇄ Player: VLC“ für die Detailseiten */
    function playerButton(screen) {
        var b = h('div', 'button', '⇄  Player: ' + VodPlayer.nameOf(VodPlayer.pref()));
        focusable(b, 'vodplayer', function () {
            VodPlayer.pick(function () { screen.focusKey = 'vodplayer'; Nav.show(screen); });
        }, 'buttons');
        return b;
    }

    /** Film oder Folge starten. Gibt es einen gespeicherten Stand, wird gefragt. */
    function playWithResume(items, index, kind) {
        var it = items[index], e = Resume.forItem(kind, it);
        if (!e || e.next || e.pos < 30) { VodPlayer.play(items, index, kind, 0); return; }
        Modal.open(it.name, 'Du hast bei ' + fmtTime(e.pos) + (e.dur ? ' von ' + fmtTime(e.dur) : '') + ' aufgehört.', [
            { label: '▶  Fortsetzen ab ' + fmtTime(e.pos), primary: true, action: function () { VodPlayer.play(items, index, kind, e.pos); } },
            { label: '↺  Von vorne', action: function () { VodPlayer.play(items, index, kind, 0); } },
            { label: 'Abbrechen' }
        ]);
    }

    // =====================================================================
    // Xtream-Schnittstelle
    // =====================================================================

    var Account = {
        normalizeServer: function (raw) {
            var s = (raw || '').trim();
            if (!s) return s;
            if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
            return s.replace(/\/+$/, '');
        },
        /** Erkennt einen kompletten Anbieter-Link …/get.php?username=…&password=… */
        parse: function (link) {
            try {
                var u = new URL((link || '').trim());
                var user = u.searchParams.get('username'), pass = u.searchParams.get('password');
                if (!user || !pass) return null;
                var path = u.pathname.replace(/\/get\.php$/i, '').replace(/\/+$/, '');
                return { server: u.protocol + '//' + u.host + path, username: user, password: pass };
            } catch (e) { return null; }
        }
    };

    // =====================================================================
    // Demo: freie Testvideos (Creative Commons), z. B. für die Prüfung im LG- oder Samsung-Store
    // =====================================================================

    var Demo = {
        playlist: { id: 'demo', name: 'Demo', demo: true },
        account: function () { return { server: 'demo://imperumtv', username: 'demo', password: 'demo', demo: true }; },
        FILMS: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/',
        live: [
            { id: 1, name: 'Demo 1 · Big Buck Bunny', cat: '1', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', color: '#3f7d3a' },
            { id: 2, name: 'Demo 2 · Testbild', cat: '1', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8', color: '#2f5f9e' },
            { id: 3, name: 'Demo 3 · Tears of Steel', cat: '2', url: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8', color: '#8a3b3b' }
        ],
        movies: [
            { id: 101, name: 'Big Buck Bunny (2008)', file: 'BigBuckBunny.mp4', year: 2008, rating: '7.5', genre: 'Animation · Komödie', min: 10, color: '#5b8c2a',
                plot: 'Ein freundliches Riesenkaninchen nimmt es mit drei frechen Nagern auf. Kurzfilm der Blender Foundation (CC BY 3.0).', dir: 'Sacha Goedegebure' },
            { id: 102, name: 'Elephants Dream (2006)', file: 'ElephantsDream.mp4', year: 2006, rating: '6.6', genre: 'Animation · Sci-Fi', min: 11, color: '#6b4a8a',
                plot: 'Zwei Männer erkunden eine seltsame, mechanische Welt. Der erste offene Film der Blender Foundation (CC BY 2.5).', dir: 'Bassam Kurdali' },
            { id: 103, name: 'Sintel (2010)', file: 'Sintel.mp4', year: 2010, rating: '7.4', genre: 'Animation · Fantasy', min: 15, color: '#9a5a2a',
                plot: 'Eine junge Frau sucht ihren kleinen Drachen. Kurzfilm der Blender Foundation (CC BY 3.0).', dir: 'Colin Levy' },
            { id: 104, name: 'Tears of Steel (2012)', file: 'TearsOfSteel.mp4', year: 2012, rating: '6.0', genre: 'Sci-Fi', min: 12, color: '#3a5f7a',
                plot: 'Eine Gruppe von Wissenschaftlern versucht in Amsterdam, die Welt vor Robotern zu retten. Blender Foundation (CC BY 3.0).', dir: 'Ian Hubert' }
        ],
        /** Einfaches Poster als Bild (Titel auf Farbfläche) */
        poster: function (title, color, w, hh) {
            w = w || 400; hh = hh || 600;
            var lines = String(title).replace(/\s*\(\d{4}\)/, '').split(' '), rows = [], cur = '';
            lines.forEach(function (word) { if ((cur + ' ' + word).trim().length > 12) { rows.push(cur.trim()); cur = word; } else cur += ' ' + word; });
            if (cur.trim()) rows.push(cur.trim());
            var y0 = hh / 2 - (rows.length - 1) * 28;
            var text = rows.map(function (r, i) {
                return '<text x="' + w / 2 + '" y="' + (y0 + i * 56) + '" font-family="Arial,Helvetica,sans-serif" font-size="46" font-weight="bold" fill="#fff" text-anchor="middle">' +
                    r.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</text>';
            }).join('');
            var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + hh + '"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
                '<stop offset="0" stop-color="' + color + '"/><stop offset="1" stop-color="#111418"/></linearGradient></defs>' +
                '<rect width="100%" height="100%" fill="url(#g)"/>' + text +
                '<text x="' + w / 2 + '" y="' + (hh - 40) + '" font-family="Arial,Helvetica,sans-serif" font-size="26" fill="#d9b066" text-anchor="middle">DEMO</text></svg>';
            return 'data:image/svg+xml,' + encodeURIComponent(svg);
        },
        /** Hintergrund ohne Schrift */
        backdrop: function (color) {
            return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><defs><radialGradient id="g" cx=".7" cy=".3" r=".9">' +
                '<stop offset="0" stop-color="' + color + '"/><stop offset="1" stop-color="#0d0f12"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>');
        },
        b64: function (t) { try { return btoa(unescape(encodeURIComponent(t))); } catch (e) { return ''; } },
        /** Antworten wie ein Xtream-Server */
        answer: function (action, extra) {
            var self = this, now = Math.floor(Date.now() / 1000);
            switch (action || '') {
                case '': return { user_info: { auth: 1, status: 'Active', exp_date: null } };
                case 'get_live_categories': return [{ category_id: '1', category_name: 'Demo Live' }, { category_id: '2', category_name: 'Demo Kino' }];
                case 'get_live_streams': return this.live.map(function (c) {
                    return { stream_id: c.id, name: c.name, stream_icon: self.poster(c.name.split('· ')[1] || c.name, c.color, 300, 200), category_id: c.cat };
                });
                case 'get_short_epg':
                    var start = Math.floor(now / 1800) * 1800, list = [];
                    for (var i = 0; i < 8; i++) list.push({ title: this.b64('Demo-Programm ' + (i + 1)), description: this.b64('Freies Testvideo zum Ausprobieren von ImperumTV.'),
                        start_timestamp: String(start + i * 1800), stop_timestamp: String(start + (i + 1) * 1800) });
                    return { epg_listings: list };
                case 'get_vod_categories': return [{ category_id: '10', category_name: 'Blender Open Movies' }];
                case 'get_vod_streams': return this.movies.map(function (m, i) {
                    return { stream_id: m.id, name: m.name, stream_icon: self.poster(m.name, m.color), category_id: '10', container_extension: 'mp4',
                        rating: m.rating, year: String(m.year), added: String(now - i * 86400) };
                });
                case 'get_vod_info':
                    var mv = this.movie(extra && extra.vod_id);
                    return { info: mv ? { plot: mv.plot, genre: mv.genre, releasedate: String(mv.year), rating: mv.rating, director: mv.dir,
                        duration: '00:' + (mv.min < 10 ? '0' : '') + mv.min + ':00', movie_image: this.poster(mv.name, mv.color),
                        backdrop_path: [this.backdrop(mv.color)] } : {} };
                case 'get_series_categories': return [{ category_id: '20', category_name: 'Demo-Serien' }];
                case 'get_series': return [{ series_id: 201, name: 'Blender Open Movies', cover: this.poster('Blender Open Movies', '#7a5a1a'), category_id: '20', rating: '7.2', last_modified: String(now) }];
                case 'get_series_info':
                    return { info: { plot: 'Die freien Kurzfilme der Blender Foundation als Serie – zum Testen von Staffeln, Folgen und „Nächste Folge“.', genre: 'Animation', releaseDate: '2006' },
                        episodes: { '1': this.movies.map(function (m, i) { return { id: String(301 + i), episode_num: i + 1, title: m.name.replace(/\s*\(\d{4}\)/, ''), container_extension: 'mp4', season: 1 }; }) } };
                default: return [];
            }
        },
        movie: function (id) { for (var i = 0; i < this.movies.length; i++) if (String(this.movies[i].id) === String(id)) return this.movies[i]; return null; },
        liveUrl: function (id) { for (var i = 0; i < this.live.length; i++) if (this.live[i].id === Number(id)) return this.live[i].url; return this.live[0].url; },
        movieUrl: function (id) { var m = this.movie(id) || this.movies[0]; return this.FILMS + m.file; },
        episodeUrl: function (id) { var m = this.movies[(Number(id) - 301) % this.movies.length] || this.movies[0]; return this.FILMS + m.file; }
    };

    var Api = {
        acc: null,

        call: function (action, extra) {
            var a = this.acc;
            if (a && a.demo) {
                var answer = Demo.answer(action, extra);
                return new Promise(function (resolve) { setTimeout(function () { resolve(answer); }, 120); });
            }
            var url = a.server + '/player_api.php?username=' + encodeURIComponent(a.username) +
                '&password=' + encodeURIComponent(a.password);
            if (action) url += '&action=' + action;
            if (extra) {
                for (var k in extra) {
                    if (extra.hasOwnProperty(k)) url += '&' + k + '=' + encodeURIComponent(extra[k]);
                }
            }
            return this.fetchText(url).then(function (text) {
                try { return JSON.parse(text); }
                catch (e) { throw new Error('Unerwartete Antwort vom Server: ' + text.slice(0, 120)); }
            });
        },

        fetchText: function (url) {
            return fetch(url).then(function (res) {
                return res.text().then(function (text) {
                    if (!res.ok) throw new Error('Der Server antwortet mit HTTP ' + res.status + '. ' + text.slice(0, 120));
                    return text;
                });
            }, function () {
                throw new Error('Der Server ist nicht erreichbar. Prüfe die Adresse und die Internetverbindung.');
            });
        },

        /** Große Liste holen und im Hintergrund umrechnen. cats: Promise der Kategorien */
        list: function (action, kind, cats) {
            var a = this.acc, text;
            if (a && a.demo) text = Promise.resolve(JSON.stringify(Demo.answer(action)));
            else {
                var url = a.server + '/player_api.php?username=' + encodeURIComponent(a.username) +
                    '&password=' + encodeURIComponent(a.password) + '&action=' + action;
                // Rohe Bytes direkt an den Worker: kein Umwandeln riesiger Antworten auf dem Bedien-Thread
                text = Parser.wantsBytes() ? fetch(url).then(function (res) {
                    if (!res.ok) return res.text().then(function (t) { throw new Error('Der Server antwortet mit HTTP ' + res.status + '. ' + t.slice(0, 120)); });
                    return res.arrayBuffer();
                }, function () {
                    throw new Error('Der Server ist nicht erreichbar. Prüfe die Adresse und die Internetverbindung.');
                }) : this.fetchText(url);
            }
            return Promise.all([cats, text]).then(function (res) {
                return Parser.run(res[1], kind, Data.catMap(res[0]));
            });
        },

        creds: function () {
            return encodeURIComponent(this.acc.username) + '/' + encodeURIComponent(this.acc.password);
        },
        liveUrl: function (id) { if (this.acc.demo) return Demo.liveUrl(id); return this.acc.server + '/live/' + this.creds() + '/' + id + '.' + Settings.liveExt; },
        movieUrl: function (id, ext) { if (this.acc.demo) return Demo.movieUrl(id); return this.acc.server + '/movie/' + this.creds() + '/' + id + '.' + (ext || 'mp4'); },
        episodeUrl: function (id, ext) { if (this.acc.demo) return Demo.episodeUrl(id); return this.acc.server + '/series/' + this.creds() + '/' + id + '.' + (ext || 'mp4'); }
    };

    // =====================================================================
    // Wiedergabelisten über die Website (MAC-Adresse + Geräte-Schlüssel)
    // =====================================================================

    var REMOTE = {
        // Datenbank (Supabase): Project URL und publishable key
        url: 'https://dprwastkfqhisvsjrvrv.supabase.co',
        key: 'sb_publishable_LZau0nT_CfDUYqrzlQfM2Q_61r7g-K3',
        // Website, auf der man Wiedergabelisten einträgt und das Gerät aktiviert (Cloudflare)
        website: 'https://holy-mode-e130.imperumtv.workers.dev/',
        // Hier baut GitHub die Android-App; die App sucht dort nach Updates
        updateRepo: 'paypal199012-lgtm/ImperumTV-Android',
        // Wird nur angezeigt, der echte Preis steht in der Stripe-Funktion
        price: '9,99 €'
    };

    function hash32(text, seed) {
        var hsh = 2166136261 ^ seed;
        for (var i = 0; i < text.length; i++) {
            hsh ^= text.charCodeAt(i);
            hsh = Math.imul ? Math.imul(hsh, 16777619) : (hsh * 16777619) | 0;
        }
        hsh ^= hsh >>> 15;
        return hsh >>> 0;
    }

    var Device = {
        mac: '', key: '',
        validMac: function (m) { return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(m || ''); },
        validKey: function (k) { return /^[0-9]{6}$/.test(k || ''); },

        /** MAC-Adresse und Geräte-Schlüssel: bleiben für dieses Gerät immer gleich */
        load: function () {
            var base = '';
            try { if (AB && AB.deviceId) base = String(AB.deviceId() || ''); } catch (e) { base = ''; }
            if (!base) {
                try { if (window.webapis && webapis.productinfo) base = String(webapis.productinfo.getDuid() || ''); } catch (e2) { base = ''; }
            }
            var bytes = [], i;
            if (base) {
                var a = hash32(base, 11), b = hash32(base, 23);
                bytes = [a >>> 24, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, b >>> 24, (b >>> 16) & 255];
                this.key = ('00000' + (hash32(base, 37) % 1000000)).slice(-6);
            } else {
                var saved = Storage.get('device', null);
                if (saved && this.validMac(saved.mac) && this.validKey(saved.key)) {
                    this.mac = saved.mac; this.key = saved.key;
                    return;
                }
                for (i = 0; i < 6; i++) bytes.push(Math.floor(Math.random() * 256));
                this.key = ('00000' + Math.floor(Math.random() * 1000000)).slice(-6);
            }
            bytes[0] = (bytes[0] | 2) & 254;   // lokal vergebene Adresse
            this.mac = bytes.map(function (x) { return ('0' + x.toString(16)).slice(-2); }).join(':').toUpperCase();
            Storage.set('device', { mac: this.mac, key: this.key });
        },
        macText: function () { return this.mac.toLowerCase(); },
        link: function () {
            return REMOTE.website + '?mac=' + encodeURIComponent(this.macText()) + '&key=' + this.key;
        }
    };

    /** Testphase (7 Tage) und Aktivierung. Der letzte Stand wird gespeichert, damit es auch ohne Internet gilt. */
    var License = {
        state: Storage.get('license', null),   // { activated, trialUntil (ms), checked (ms) }
        set: function (row) {
            if (!row) return;
            var until = row.trial_until ? new Date(row.trial_until).getTime() : 0;
            var serverNow = row.server_time ? new Date(row.server_time).getTime() : Date.now();
            // Falsche Uhr am Gerät ausgleichen
            this.offset = serverNow - Date.now();
            var free = row.free_until ? new Date(row.free_until).getTime() : 0;
            this.state = { activated: !!row.activated, trialUntil: until, freeUntil: free, serverActive: !!row.active, checked: Date.now() };
            Storage.set('license', this.state);
        },
        known: function () { return !!this.state; },
        /** Vom Entwickler kostenlos freigeschaltet (z. B. für 1 Jahr) */
        free: function () {
            return !!(this.state && !this.state.activated && this.state.freeUntil && Date.now() + (this.offset || 0) < this.state.freeUntil);
        },
        freeText: function () {
            var d = new Date(this.state.freeUntil);
            return 'Freigeschaltet bis ' + pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear();
        },
        activated: function () { return !!(this.state && this.state.activated); },
        active: function () {
            if (!this.state) return true;     // noch nie geprüft (z. B. ganz neues Gerät ohne Internet)
            if (this.state.activated) return true;
            var t = Date.now() + (this.offset || 0);
            return t < this.state.trialUntil || t < (this.state.freeUntil || 0);
        },
        daysLeft: function () {
            if (!this.state || this.state.activated) return 0;
            var ms = this.state.trialUntil - (Date.now() + (this.offset || 0));
            return Math.max(0, Math.ceil(ms / 86400000));
        },
        text: function () {
            if (!this.state) return '';
            if (this.state.activated) return 'Dein Gerät ist aktiviert.';
            if (this.free()) return this.freeText();
            var d = this.daysLeft();
            if (d <= 0) return 'Testphase abgelaufen';
            return 'Testphase: noch ' + d + (d === 1 ? ' Tag' : ' Tage');
        }
    };

    var Remote = {
        lists: null,       // zuletzt geladene Wiedergabelisten
        registered: false,

        rpc: function (name, body) {
            var headers = { 'Content-Type': 'application/json', 'apikey': REMOTE.key };
            if (/^eyJ/.test(REMOTE.key)) headers.Authorization = 'Bearer ' + REMOTE.key;
            var req = fetch(REMOTE.url.replace(/\/+$/, '') + '/rest/v1/rpc/' + name, {
                method: 'POST', headers: headers, body: JSON.stringify(body)
            });
            var timeout = new Promise(function (resolve, reject) {
                setTimeout(function () { reject(new Error('Die Website antwortet nicht. Prüfe die Internetverbindung.')); }, 12000);
            });
            return Promise.race([req, timeout]).then(function (res) {
                return res.text().then(function (text) {
                    if (!res.ok) {
                        var err = new Error('Die Website meldet einen Fehler (HTTP ' + res.status + ').');
                        err.status = res.status;
                        throw err;
                    }
                    try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
                });
            }, function (e) {
                if (e && /antwortet nicht/.test(e.message)) throw e;
                throw new Error('Keine Verbindung zur Website. Prüfe die Internetverbindung.');
            });
        },

        register: function () {
            var self = this;
            var args = { p_mac: Device.mac, p_key: Device.key };
            return this.rpc('register_device', args).then(function () { self.registered = true; });
        },

        /** Holt alle Wiedergabelisten, die auf der Website für dieses Gerät eingetragen sind */
        load: function () {
            var self = this;
            var args = { p_mac: Device.mac, p_key: Device.key };
            var ready = self.registered ? Promise.resolve() : self.register().then(null, function () { /* unten nochmal */ });
            return ready.then(function () {
                // Stand der Testphase / Aktivierung (ältere Datenbank ohne diese Funktion: einfach weiter)
                var status = self.rpc('device_status', args).then(function (rows) {
                    if (rows && rows.length) { License.set(rows[0]); Parental.onStatus(rows[0].parental_reset_at); }
                }, function (e) { if (e.status !== 404) throw e; });
                return status.then(function () { return self.rpc('get_playlists', args); }).then(null, function (e) {
                    // Ältere Datenbank mit nur einer Wiedergabeliste
                    if (e.status !== 404) throw e;
                    return self.rpc('get_playlist', args).then(function (rows) {
                        return (rows || []).map(function (r) { r.id = 'alt'; r.name = 'Wiedergabeliste'; return r; });
                    });
                });
            }).then(function (rows) {
                self.lists = (Array.isArray(rows) ? rows : []).filter(function (r) {
                    return r && (r.m3u_url || r.server);
                }).map(function (r) {
                    return {
                        id: String(r.id),
                        name: str(r.name) || 'Wiedergabeliste',
                        server: str(r.server), username: str(r.username), password: str(r.password),
                        m3u: str(r.m3u_url)
                    };
                });
                return self.lists;
            });
        },

        find: function (id) {
            if (String(id) === 'demo') return Demo.playlist;
            var list = this.lists || [];
            for (var i = 0; i < list.length; i++) if (list[i].id === String(id)) return list[i];
            return null;
        }
    };

    /** Wiedergabeliste → Xtream-Zugang */
    function playlistAccount(p) {
        if (p.demo) return Demo.account();
        if (p.server && p.username && p.password) {
            var fromLink = Account.parse(p.server);
            if (fromLink) return fromLink;
            return { server: Account.normalizeServer(p.server), username: p.username, password: p.password };
        }
        return Account.parse(p.m3u || p.server || '');
    }

    function playlistAddress(p) {
        if (p.demo) return 'Freie Testvideos zum Ausprobieren';
        var a = playlistAccount(p);
        if (a) return a.server;
        return (p.m3u || p.server || '').split('?')[0];
    }

    function str(v) {
        if (v === null || v === undefined) return '';
        var s = String(v).trim();
        return (s === '0' || s.toLowerCase() === 'null' || s === 'N/A') ? '' : s;
    }

    function firstYear(text) {
        var m = /(19|20)\d{2}/.exec(text || '');
        return m ? parseInt(m[0], 10) : null;
    }

    function yearFromName(name) {
        var m = /[(\[](19|20)\d{2}[)\]]/.exec(name) || /[ ._-](19|20)\d{2}$/.exec(name);
        return m ? firstYear(m[0]) : null;
    }

    /** Bewertung als Zahl 0–10 (Anbieter liefern „7.5“, „75“ oder nur rating_5based) */
    function parseRating(r, r5) {
        var v = parseFloat(r);
        if (v > 10 && v <= 100) v = v / 10;
        if (!(v > 0) || v > 10) v = parseFloat(r5) * 2;
        if (!(v > 0) || v > 10) return 0;
        return Math.round(v * 10) / 10;
    }
    function ratingText(v) { return v > 0 ? '★ ' + v.toFixed(1) : ''; }

    /** Rohliste des Anbieters in kleine Einträge umrechnen (läuft im Worker oder als Notlösung hier) */
    function mapList(kind, list, cats) {
        var out = [], i, s, name, item;
        for (i = 0; i < list.length; i++) {
            s = list[i];
            if (!s) continue;
            if (kind === 'live') {
                item = { type: 'live', id: parseInt(s.stream_id, 10), num: i + 1,
                    name: str(s.name) || 'Sender ' + s.stream_id, logo: str(s.stream_icon),
                    cat: cats[String(s.category_id)] || '' };
            } else if (kind === 'movie') {
                name = str(s.name) || 'Film ' + s.stream_id;
                item = { type: 'movie', id: parseInt(s.stream_id, 10), name: name, logo: str(s.stream_icon),
                    cat: cats[String(s.category_id)] || '', ext: str(s.container_extension) || 'mp4',
                    year: firstYear(str(s.year)) || firstYear(str(s.release_date)) || firstYear(str(s.releaseDate)) || yearFromName(name),
                    rating: parseRating(s.rating, s.rating_5based), added: parseInt(s.added, 10) || 0 };
            } else {
                name = str(s.name) || 'Serie ' + s.series_id;
                item = { type: 'series', id: parseInt(s.series_id, 10), name: name, logo: str(s.cover),
                    cat: cats[String(s.category_id)] || '',
                    year: firstYear(str(s.releaseDate)) || firstYear(str(s.release_date)) || firstYear(str(s.year)) || yearFromName(name),
                    rating: parseRating(s.rating, s.rating_5based), added: parseInt(s.last_modified, 10) || 0 };
            }
            if (!isNaN(item.id)) out.push(item);
        }
        return out;
    }

    /**
     * Große Listen (zehntausende Filme/Serien) im Hintergrund-Worker auswerten:
     * die Oberfläche und die Lade-Animation laufen dabei flüssig weiter.
     */
    var Parser = {
        w: null, ready: false, seq: 0, wait: {},
        CHUNK: 4000,
        worker: function () {
            if (this.w !== null) return this.w;
            this.w = false;
            try {
                if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || !window.URL) return false;
                var body = function () {
                    postMessage({ ready: true, dec: typeof TextDecoder !== 'undefined' });
                    self.onmessage = function (e) {
                        var d = e.data, json, text = d.text, list, i, n;
                        try { if (d.buf) text = new TextDecoder('utf-8').decode(new Uint8Array(d.buf)); }
                        catch (x0) { postMessage({ id: d.id, err: 'Antwort vom Server konnte nicht gelesen werden.' }); return; }
                        try { json = JSON.parse(text); }
                        catch (x) { postMessage({ id: d.id, err: 'Unerwartete Antwort vom Server: ' + String(text).slice(0, 120) }); return; }
                        text = null;
                        try { list = mapList(d.kind, Array.isArray(json) ? json : [], d.cats); }
                        catch (x2) { postMessage({ id: d.id, err: 'Liste konnte nicht gelesen werden.' }); return; }
                        json = null;
                        // In Häppchen zurückschicken: die Oberfläche bleibt zwischendurch bedienbar
                        n = d.chunk || 4000;
                        for (i = 0; i < list.length; i += n) postMessage({ id: d.id, part: list.slice(i, i + n) });
                        postMessage({ id: d.id, end: true, total: list.length });
                    };
                };
                var src = [str, firstYear, yearFromName, parseRating, mapList].map(function (f) { return f.toString(); }).join('\n') +
                    '\n(' + body.toString() + ')();';
                var w = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
                var me = this;
                w.onmessage = function (e) {
                    var d = e.data;
                    if (d.ready) { me.ready = true; me.dec = !!d.dec; return; }
                    var job = me.wait[d.id];
                    if (!job) return;
                    if (d.part) { for (var i = 0; i < d.part.length; i++) job.list.push(d.part[i]); return; }
                    delete me.wait[d.id];
                    clearTimeout(job.timer);
                    if (d.err) job.reject(new Error(d.err));
                    else job.resolve(job.list);
                };
                w.onerror = function () { me.broken(); };
                this.w = w;
            } catch (e) { this.w = false; }
            return this.w;
        },
        /** Worker geht nicht: alles Offene hier erledigen und künftig ohne Worker */
        broken: function () {
            try { if (this.w) this.w.terminate(); } catch (e) { /* egal */ }
            this.w = false;
            this.ready = false;
            var jobs = this.wait;
            this.wait = {};
            for (var k in jobs) if (jobs.hasOwnProperty(k)) { clearTimeout(jobs[k].timer); this.local(jobs[k]); }
        },
        local: function (job) {
            var json;
            if (job.text === null) { job.reject(new Error('Die Liste konnte nicht gelesen werden. Bitte noch einmal aktualisieren.')); return; }
            try { json = JSON.parse(job.text); }
            catch (e) { job.reject(new Error('Unerwartete Antwort vom Server: ' + String(job.text).slice(0, 120))); return; }
            try { job.resolve(mapList(job.kind, Array.isArray(json) ? json : [], job.cats)); }
            catch (e2) { job.reject(e2); }
        },
        /** Kann der Worker rohe Bytes bekommen (spart das Umwandeln in Text hier)? */
        wantsBytes: function () {
            return !!(this.worker() && this.ready && this.dec && typeof ArrayBuffer !== 'undefined');
        },
        /** data: Text oder ArrayBuffer (nur wenn wantsBytes()) */
        run: function (data, kind, cats) {
            var me = this;
            return new Promise(function (resolve, reject) {
                var isBuf = typeof data !== 'string';
                var job = { text: isBuf ? null : data, kind: kind, cats: cats || {}, resolve: resolve, reject: reject, timer: null, list: [] };
                var w = me.worker();
                if (!w || (isBuf && !me.ready)) {
                    if (isBuf) { try { job.text = new TextDecoder('utf-8').decode(new Uint8Array(data)); } catch (e) { job.text = null; } }
                    setTimeout(function () { me.local(job); }, 0);
                    return;
                }
                var id = ++me.seq;
                me.wait[id] = job;
                // Antwortet der Worker gar nicht, nach 90 s aufgeben bzw. hier weitermachen
                job.timer = setTimeout(function () { if (me.wait[id]) { delete me.wait[id]; job.list = []; me.local(job); } }, 90000);
                try {
                    if (isBuf) w.postMessage({ id: id, buf: data, kind: kind, cats: job.cats, chunk: me.CHUNK }, [data]);
                    else w.postMessage({ id: id, text: data, kind: kind, cats: job.cats, chunk: me.CHUNK });
                } catch (e) {
                    delete me.wait[id]; clearTimeout(job.timer);
                    if (isBuf) { try { job.text = new TextDecoder('utf-8').decode(new Uint8Array(data)); } catch (e2) { job.text = null; } }
                    me.local(job);
                }
            });
        }
    };

    /** YouTube-Kennung aus dem, was der Anbieter liefert (ID oder ganzer Link) */
    function trailerId(v) {
        v = str(v);
        if (!v) return '';
        var m = /(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/.exec(v);
        if (m) return m[1];
        return /^[A-Za-z0-9_-]{11}$/.test(v) ? v : '';
    }

    function parseInfo(d) {
        d = d || {};
        function pick() {
            for (var i = 0; i < arguments.length; i++) { var v = str(d[arguments[i]]); if (v) return v; }
            return '';
        }
        var info = {
            plot: pick('plot', 'description'),
            genre: pick('genre'),
            year: '',
            rating: pick('rating'),
            duration: pick('duration'),
            cast: pick('cast', 'actors'),
            director: pick('director'),
            cover: pick('movie_image', 'cover_big', 'cover'),
            backdrop: '',
            trailer: trailerId(pick('youtube_trailer', 'trailer', 'youtube'))
        };
        info.score = parseRating(info.rating, d.rating_5based);
        var date = pick('releasedate', 'releaseDate', 'release_date', 'year');
        if (date) info.year = date.slice(0, 4);
        var parts = /^(\d+):(\d+):\d+$/.exec(info.duration);
        if (parts) {
            var hh = parseInt(parts[1], 10), mm = parseInt(parts[2], 10);
            info.duration = hh > 0 ? hh + ' Std. ' + mm + ' Min.' : mm + ' Min.';
        }
        var bd = d.backdrop_path;
        if (bd && bd.length && typeof bd === 'object') info.backdrop = str(bd[0]);
        else if (typeof bd === 'string') info.backdrop = str(bd);
        info.meta = [info.year, info.duration, info.genre].filter(function (x) { return !!x; }).join(' · ');
        return info;
    }

    // =====================================================================
    // Daten
    // =====================================================================

    var Data = {
        channels: [], movies: [], series: [],
        expiry: null, status: '',
        moviesLoaded: false, seriesLoaded: false,
        epgCache: {},

        catMap: function (cats) {
            var map = {};
            (cats || []).forEach(function (c) { map[String(c.category_id)] = str(c.category_name) || 'Ohne Kategorie'; });
            return map;
        },

        login: function (acc, progress) {
            Api.acc = acc;
            Parser.worker();                                   // Hintergrund-Helfer schon starten
            var self = this;
            // Alles gleichzeitig anfragen (spart Wartezeit); die Senderliste zählt nur, wenn die Anmeldung klappt
            var lists = Api.list('get_live_streams', 'live', Api.call('get_live_categories'));
            lists.then(null, function () { /* Fehler wird unten gemeldet */ });
            return Api.call(null).then(function (json) {
                var user = json && json.user_info;
                if (!user) throw new Error('Unerwartete Antwort vom Server.');
                if (String(user.auth) !== '1') throw new Error('Anmeldung abgelehnt. Benutzername oder Passwort stimmt nicht, oder das Abo ist abgelaufen.');
                self.status = str(user.status) || 'Active';
                var exp = parseFloat(user.exp_date);
                self.expiry = exp > 0 ? new Date(exp * 1000) : null;
                if (progress) progress(1);
                return lists;
            }).then(function (list) {
                self.channels = list;
                if (!self.channels.length) throw new Error('Anmeldung klappt, aber der Server liefert keine Live-Sender.');
                self.movies = []; self.series = [];
                self.moviesLoaded = false; self.seriesLoaded = false;
                self.gen++; self.moviesPromise = null; self.seriesPromise = null;
                self.epgCache = {};
                Storage.set('account', acc);
            });
        },

        gen: 0, moviesPromise: null, seriesPromise: null,

        loadMovies: function () {
            var self = this, gen = this.gen;
            if (self.moviesLoaded) return Promise.resolve();
            if (self.moviesPromise) return self.moviesPromise;       // lädt schon (z. B. im Hintergrund beim Start)
            self.moviesPromise = Api.list('get_vod_streams', 'movie', Api.call('get_vod_categories')).then(function (list) {
                if (gen !== self.gen) return;                         // inzwischen andere Liste gewählt
                self.movies = list;
                self.moviesLoaded = true;
            });
            self.moviesPromise.then(function () { if (gen === self.gen) self.moviesPromise = null; }, function () { if (gen === self.gen) self.moviesPromise = null; });
            return self.moviesPromise;
        },

        loadSeries: function () {
            var self = this, gen = this.gen;
            if (self.seriesLoaded) return Promise.resolve();
            if (self.seriesPromise) return self.seriesPromise;
            self.seriesPromise = Api.list('get_series', 'series', Api.call('get_series_categories')).then(function (list) {
                if (gen !== self.gen) return;
                self.series = list;
                self.seriesLoaded = true;
            });
            self.seriesPromise.then(function () { if (gen === self.gen) self.seriesPromise = null; }, function () { if (gen === self.gen) self.seriesPromise = null; });
            return self.seriesPromise;
        },

        movieInfo: function (id) {
            return Api.call('get_vod_info', { vod_id: id }).then(function (json) { return parseInfo(json && json.info); });
        },

        seriesDetails: function (id) {
            return Api.call('get_series_info', { series_id: id }).then(function (json) {
                json = json || {};
                var seasons = {};
                var eps = json.episodes;
                if (Array.isArray(eps)) eps.forEach(function (list, i) { seasons[String(i + 1)] = list; });
                else if (eps && typeof eps === 'object') seasons = eps;
                var all = [];
                Object.keys(seasons).forEach(function (key) {
                    (seasons[key] || []).forEach(function (ep) {
                        var id2 = str(ep.id);
                        if (!id2) return;
                        var num = parseInt(ep.episode_num, 10) || 0;
                        all.push({
                            type: 'episode',
                            id: id2,
                            season: parseInt(ep.season, 10) || parseInt(key, 10) || 1,
                            num: num,
                            name: str(ep.title) || 'Folge ' + num,
                            ext: str(ep.container_extension) || 'mp4'
                        });
                    });
                });
                all.sort(function (a, b) { return a.season - b.season || a.num - b.num; });
                return { episodes: all, info: parseInfo(json.info) };
            });
        },

        shortEpg: function (streamId) {
            var self = this;
            var cached = self.epgCache[streamId];
            if (cached && Date.now() - cached.at < 5 * 60 * 1000) return Promise.resolve(cached.list);
            return Api.call('get_short_epg', { stream_id: streamId, limit: 4 }).then(function (json) {
                var now = Date.now();
                var list = ((json && json.epg_listings) || []).map(function (e) {
                    var start = parseFloat(e.start_timestamp) * 1000, end = parseFloat(e.stop_timestamp) * 1000;
                    return { title: b64(e.title), start: start, end: end };
                }).filter(function (e) { return e.title && (!e.end || e.end > now); });
                self.epgCache[streamId] = { at: Date.now(), list: list };
                return list;
            }, function () { return []; });
        },

        /** Programm für die nächsten Stunden (für das EPG-Raster) */
        epgFull: function (streamId) {
            var self = this;
            self.epgFullCache = self.epgFullCache || {};
            var cached = self.epgFullCache[streamId];
            if (cached && Date.now() - cached.at < 10 * 60 * 1000) return Promise.resolve(cached.list);
            return Api.call('get_short_epg', { stream_id: streamId, limit: 60 }).then(function (json) {
                var list = ((json && json.epg_listings) || []).map(function (e) {
                    return {
                        title: b64(e.title), desc: b64(e.description || ''),
                        start: parseFloat(e.start_timestamp) * 1000, end: parseFloat(e.stop_timestamp) * 1000
                    };
                }).filter(function (e) { return e.title && e.start && e.end && e.end > e.start; });
                list.sort(function (a, b) { return a.start - b.start; });
                self.epgFullCache[streamId] = { at: Date.now(), list: list };
                return list;
            }, function () { return []; });
        },

        expiryText: function () {
            if (!this.expiry) return '';
            var d = this.expiry;
            var months = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
            return d.getDate() + '. ' + months[d.getMonth()] + ' ' + d.getFullYear() + ' ' + fmtClock(d);
        }
    };

    // =====================================================================
    // Video-Wiedergabe (Samsung AVPlay, im Browser HTML5-Video zum Testen)
    // =====================================================================

    var LANG = {
        deu: 'Deutsch', ger: 'Deutsch', de: 'Deutsch', eng: 'Englisch', en: 'Englisch', tur: 'Türkisch', tr: 'Türkisch',
        fra: 'Französisch', fre: 'Französisch', fr: 'Französisch', spa: 'Spanisch', es: 'Spanisch', ita: 'Italienisch', it: 'Italienisch',
        ara: 'Arabisch', ar: 'Arabisch', rus: 'Russisch', ru: 'Russisch', pol: 'Polnisch', pl: 'Polnisch', nld: 'Niederländisch', dut: 'Niederländisch',
        por: 'Portugiesisch', pt: 'Portugiesisch', alb: 'Albanisch', sqi: 'Albanisch', srp: 'Serbisch', hrv: 'Kroatisch', bos: 'Bosnisch', und: 'Unbekannt'
    };

    function langName(code, fallback) {
        var c = (code || '').toLowerCase();
        return LANG[c] || (c ? c.toUpperCase() : fallback);
    }

    var Player = {
        tizen: false,
        av: null,
        video: null,
        handlers: {},
        subtitleOn: false,
        subIndex: -1,

        init: function () {
            this.video = $('#html-player');
            this.android = !!AB;
            this.tizen = !this.android && typeof webapis !== 'undefined' && !!webapis.avplay;
            if (this.tizen) this.av = webapis.avplay;
            var self = this;
            // Ereignisse vom Android-Player
            window.__androidPlayerEvent = function (name, a, b) { self.emit(name, a, b); };
            this.video.addEventListener('waiting', function () { self.emit('buffer', true); });
            this.video.addEventListener('playing', function () { self.emit('buffer', false); });
            this.video.addEventListener('timeupdate', function () { self.emit('time', self.video.currentTime); });
            this.video.addEventListener('ended', function () { self.emit('end'); });
            this.video.addEventListener('error', function () {
                if (!self.video.getAttribute('src')) return;   // kommt nach dem Stoppen, ignorieren
                self.emit('error', 'Format wird im Browser nicht unterstützt');
            });
        },

        on: function (handlers) { this.handlers = handlers || {}; },
        emit: function (name, a, b) { var f = this.handlers[name]; if (f) f(a, b); },

        /** rect in 1920er-Koordinaten oder null für Vollbild */
        /**
         * Läuft genau dieser Sender schon (z. B. in der Vorschau)? Dann nur das Bild verschieben/vergrößern,
         * ohne neu zu laden. true = übernommen.
         */
        keep: function (url, rect) {
            if (!url || this.url !== url) return false;
            this.setRect(rect);
            this.applyAspect(rect ? 'fit' : this.aspect());
            return true;
        },

        open: function (url, rect) {
            this.stop();
            this.url = url;
            this.subtitleOn = false;
            this.subIndex = -1;
            this.emit('buffer', true);
            var self = this;

            if (this.android) {
                var fr = this.fractions(rect);
                this.applyAspect(rect ? 'fit' : this.aspect());
                AB.open(url, fr.x, fr.y, fr.w, fr.h);
            } else if (this.tizen) {
                var av = this.av;
                try {
                    av.open(url);
                    av.setListener({
                        onbufferingstart: function () { self.emit('buffer', true); },
                        onbufferingprogress: function () { },
                        onbufferingcomplete: function () { self.emit('buffer', false); },
                        oncurrentplaytime: function (ms) { self.emit('time', ms / 1000); },
                        onstreamcompleted: function () { self.emit('end'); },
                        onevent: function () { },
                        onerror: function (e) { self.emit('error', String(e)); },
                        onsubtitlechange: function (duration, text) { self.emit('subtitle', text, duration); }
                    });
                    try { av.setStreamingProperty('USER_AGENT', 'ImperumTV/1.0 (SmartTV)'); } catch (e1) { /* nicht überall verfügbar */ }
                    this.setRect(rect);
                    this.applyAspect(rect ? 'fit' : this.aspect());
                    av.prepareAsync(function () {
                        try { av.setSilentSubtitle(true); } catch (e3) { /* egal */ }
                        av.play();
                        self.emit('buffer', false);
                        self.emit('ready');
                    }, function (err) {
                        self.emit('error', String(err));
                    });
                } catch (e) {
                    this.emit('error', e && e.message ? e.message : String(e));
                }
            } else {
                var v = this.video;
                this.setRect(rect);
                this.applyAspect(rect ? 'fit' : this.aspect());
                v.src = url;
                var p = v.play();
                if (p && p.catch) p.catch(function () { /* Autoplay im Browser blockiert */ });
                setTimeout(function () { self.emit('ready'); }, 0);
            }
        },

        /** Bildbereich als Anteil des sichtbaren Fensters (für Android) */
        fractions: function (rect) {
            var vp = viewportSize(), w = vp.w, hh = vp.h;
            if (!rect) return { x: 0, y: 0, w: 1, h: 1 };
            return {
                x: (offX + rect.x * scale) / w, y: (offY + rect.y * scale) / hh,
                w: rect.w * scale / w, h: rect.h * scale / hh
            };
        },

        setRect: function (rect) {
            if (this.android) {
                var fr = this.fractions(rect);
                AB.setRect(fr.x, fr.y, fr.w, fr.h);
                return;
            }
            var r = rect || { x: 0, y: 0, w: 1920, h: 1080 };
            var node = this.tizen ? $('#av-player') : this.video;
            node.style.left = (offX + r.x * scale) + 'px';
            node.style.top = (offY + r.y * scale) + 'px';
            node.style.width = (r.w * scale) + 'px';
            node.style.height = (r.h * scale) + 'px';
            if (this.tizen) {
                try { this.av.setDisplayRect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)); } catch (e) { /* noch nicht offen */ }
            }
        },

        hideSurface: function () {
            var nodes = [$('#av-player'), this.video];
            for (var i = 0; i < nodes.length; i++) { nodes[i].style.width = '0'; nodes[i].style.height = '0'; }
        },

        stop: function () {
            this.url = null;
            if (this.android) { AB.stop(); return; }
            if (this.tizen) {
                try { this.av.stop(); } catch (e) { /* war nicht offen */ }
                try { this.av.close(); } catch (e2) { /* egal */ }
            } else if (this.video) {
                try { this.video.pause(); } catch (e3) { /* egal */ }
                this.video.removeAttribute('src');
                try { this.video.load(); } catch (e4) { /* egal */ }
            }
            this.hideSurface();
        },

        isPlaying: function () {
            if (this.android) return AB.isPlaying();
            if (this.tizen) { try { return this.av.getState() === 'PLAYING'; } catch (e) { return false; } }
            return !this.video.paused;
        },

        toggle: function () {
            if (this.android) { AB.toggle(); return; }
            if (this.tizen) {
                try { if (this.av.getState() === 'PLAYING') this.av.pause(); else this.av.play(); } catch (e) { /* egal */ }
            } else {
                if (this.video.paused) this.video.play(); else this.video.pause();
            }
        },

        current: function () {
            if (this.android) return AB.position();
            if (this.tizen) { try { return this.av.getCurrentTime() / 1000; } catch (e) { return 0; } }
            return this.video.currentTime || 0;
        },

        duration: function () {
            var d;
            if (this.android) d = AB.duration();
            else if (this.tizen) { try { d = this.av.getDuration() / 1000; } catch (e) { d = 0; } }
            else d = this.video.duration;
            return isFinite(d) && d > 0 && d < 86400 ? d : 0;
        },

        /** Bildformat: 'fit' = ganzes Bild, 'zoom' = Bildschirm füllen, 'fill' = strecken */
        ASPECTS: [
            { id: 'fit', name: 'Original (ganzes Bild)' },
            { id: 'zoom', name: 'Bildschirm füllen (Zoom)' },
            { id: 'fill', name: 'Strecken' }
        ],
        aspect: function () { return Storage.get('aspect', 'fit'); },
        setAspect: function (mode) { Storage.set('aspect', mode); this.applyAspect(mode); },
        applyAspect: function (mode) {
            if (this.android) { if (AB.setResize) AB.setResize(mode); return; }
            if (this.tizen) {
                var m = mode === 'zoom' ? 'PLAYER_DISPLAY_MODE_CROPPED_FULL' : mode === 'fill' ? 'PLAYER_DISPLAY_MODE_FULL_SCREEN' : 'PLAYER_DISPLAY_MODE_LETTER_BOX';
                try { this.av.setDisplayMethod(m); } catch (e) {
                    try { this.av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e2) { /* egal */ }
                }
                return;
            }
            if (this.video) this.video.style.objectFit = mode === 'zoom' ? 'cover' : mode === 'fill' ? 'fill' : 'contain';
        },

        /** Zu einer festen Stelle springen (Sekunden) */
        seekTo: function (sec) {
            sec = Math.max(0, sec);
            if (this.android) {
                if (AB.seekTo) AB.seekTo(sec); else AB.seekBy(sec - AB.position());
                return;
            }
            if (this.tizen) {
                var av = this.av, ms = Math.round(sec * 1000);
                try { av.seekTo(ms); } catch (e) {
                    try { av.jumpForward(ms); } catch (e2) { /* nicht möglich */ }
                }
                return;
            }
            var v = this.video;
            if (v.readyState >= 1) { v.currentTime = sec; return; }
            var f = function () { v.removeEventListener('loadedmetadata', f); v.currentTime = sec; };
            v.addEventListener('loadedmetadata', f);
        },

        seekBy: function (sec) {
            if (this.android) { AB.seekBy(sec); return; }
            if (this.tizen) {
                try {
                    if (sec > 0) this.av.jumpForward(sec * 1000); else this.av.jumpBackward(-sec * 1000);
                } catch (e) { /* bei Live nicht möglich */ }
            } else {
                var t = this.video.currentTime + sec;
                this.video.currentTime = Math.max(0, t);
            }
        },

        tracks: function (type) {
            if (!this.tizen) return [];
            var out = [];
            try {
                var list = this.av.getTotalTrackInfo();
                for (var i = 0; i < list.length; i++) {
                    if (list[i].type !== type) continue;
                    var extra = {};
                    try { extra = JSON.parse(list[i].extra_info); } catch (e) { /* kein JSON */ }
                    var code = extra.language || extra.track_lang || extra.lang || '';
                    var det = [];
                    var cc = String(extra.fourCC || extra.codec || '').toUpperCase();
                    if (/EAC3|E-AC3/.test(cc)) det.push('Dolby Digital Plus'); else if (/AC3/.test(cc)) det.push('Dolby Digital');
                    else if (/DTS/.test(cc)) det.push('DTS'); else if (/AAC|MP4A/.test(cc)) det.push('AAC'); else if (/MP3|MPEG/.test(cc)) det.push('MP3');
                    var chn = parseInt(extra.channels, 10);
                    if (chn === 1) det.push('Mono'); else if (chn === 2) det.push('Stereo'); else if (chn === 6) det.push('5.1'); else if (chn === 8) det.push('7.1');
                    out.push({ index: list[i].index, name: langName(code, (type === 'AUDIO' ? 'Tonspur ' : 'Untertitel ') + (out.length + 1)), detail: det.join(' · ') });
                }
            } catch (e2) { /* nicht verfügbar */ }
            return out;
        },

        currentAudio: function () {
            try {
                var info = this.av.getCurrentStreamInfo();
                for (var i = 0; i < info.length; i++) if (info[i].type === 'AUDIO') return info[i].index;
            } catch (e) { /* egal */ }
            return -1;
        },

        /** Nächste Tonspur, gibt den Namen zurück */
        nextAudio: function () {
            if (this.android) {
                var a = AB.nextAudio();          // Name der neuen Spur, "=" + Name bei nur einer, "" bei keiner
                if (!a) return 'Keine weiteren Tonspuren';
                if (a.charAt(0) === '=') return a.slice(1) + ' (nur eine Tonspur)';
                Storage.set('prefAudio', a);
                return 'Ton: ' + a;
            }
            var list = this.tracks('AUDIO');
            if (list.length < 2) return list.length ? list[0].name + ' (nur eine Tonspur)' : 'Keine weiteren Tonspuren';
            var cur = this.currentAudio(), pos = 0;
            for (var i = 0; i < list.length; i++) if (list[i].index === cur) pos = i;
            var next = list[(pos + 1) % list.length];
            try { this.av.setSelectTrack('AUDIO', next.index); } catch (e) { return 'Tonspur konnte nicht gewechselt werden'; }
            Storage.set('prefAudio', next.name);
            return 'Ton: ' + next.name;
        },

        /** Untertitel durchschalten: Aus → Spur 1 → Spur 2 → … → Aus */
        nextSubtitle: function () {
            if (this.android) {
                var sname = AB.nextSubtitle();   // Name, "Aus" oder "" wenn keine vorhanden
                if (!sname) return 'Keine Untertitel verfügbar';
                Storage.set('prefSubtitle', sname);
                return 'Untertitel: ' + sname;
            }
            var list = this.tracks('TEXT');
            if (!list.length) return 'Keine Untertitel verfügbar';
            this.subIndex++;
            if (this.subIndex >= list.length) {
                this.subIndex = -1;
                this.subtitleOn = false;
                try { this.av.setSilentSubtitle(true); } catch (e) { /* egal */ }
                Storage.set('prefSubtitle', 'Aus');
                return 'Untertitel: Aus';
            }
            var t = list[this.subIndex];
            try {
                this.av.setSelectTrack('TEXT', t.index);
                this.av.setSilentSubtitle(false);
            } catch (e2) { return 'Untertitel konnten nicht eingeschaltet werden'; }
            this.subtitleOn = true;
            Storage.set('prefSubtitle', t.name);
            return 'Untertitel: ' + t.name;
        },

        /** Spuren als Liste. kind 'audio' oder 'text'. Rückgabe [{ id, name, detail, selected }] */
        trackList: function (kind) {
            var out = [];
            if (this.android) {
                if (!AB.tracks) return out;
                try {
                    (JSON.parse(AB.tracks(kind)) || []).forEach(function (t) {
                        out.push({ id: t.i, name: t.name, detail: t.detail || '', selected: !!t.selected });
                    });
                } catch (e) { /* keine Liste */ }
                return out;
            }
            if (this.tizen) {
                var list = this.tracks(kind === 'text' ? 'TEXT' : 'AUDIO');
                var cur = kind === 'text' ? (this.subtitleOn && this.subIndex >= 0 && list[this.subIndex] ? list[this.subIndex].index : -1) : this.currentAudio();
                list.forEach(function (t) { out.push({ id: t.index, name: t.name, detail: t.detail || '', selected: t.index === cur }); });
                return out;
            }
            // Browser: nur Untertitel aus der Datei
            var tt = this.video && this.video.textTracks;
            if (kind === 'text' && tt) {
                for (var i = 0; i < tt.length; i++) out.push({ id: i, name: tt[i].label || langName(tt[i].language, 'Untertitel ' + (i + 1)), detail: '', selected: tt[i].mode === 'showing' });
            }
            return out;
        },
        /** Spur wählen, id -1 bei Untertiteln = aus. Merkt sich die Wahl für den nächsten Film. */
        selectTrack: function (kind, id, name) {
            var ok = true;
            if (this.android) {
                ok = AB.selectTrack ? AB.selectTrack(kind, id) : false;
            } else if (this.tizen) {
                try {
                    if (kind === 'audio') this.av.setSelectTrack('AUDIO', id);
                    else if (id < 0) { this.av.setSilentSubtitle(true); this.subtitleOn = false; this.subIndex = -1; }
                    else {
                        this.av.setSelectTrack('TEXT', id);
                        this.av.setSilentSubtitle(false);
                        this.subtitleOn = true;
                        var l = this.tracks('TEXT');
                        for (var j = 0; j < l.length; j++) if (l[j].index === id) this.subIndex = j;
                    }
                } catch (e) { ok = false; }
            } else if (this.video && this.video.textTracks) {
                var tt = this.video.textTracks;
                for (var k = 0; k < tt.length; k++) tt[k].mode = k === id ? 'showing' : 'disabled';
            }
            if (ok) Storage.set(kind === 'audio' ? 'prefAudio' : 'prefSubtitle', id < 0 ? 'Aus' : name);
            return ok;
        },

        /** Zuletzt gewählte Sprache automatisch nehmen (z. B. Deutsch) */
        applyPreferences: function () {
            if (this.android) {
                AB.applyPrefs(Storage.get('prefAudio', ''), Storage.get('prefSubtitle', ''));
                return;
            }
            if (!this.tizen) return;
            var pa = Storage.get('prefAudio', ''), ps = Storage.get('prefSubtitle', '');
            if (pa) {
                var audio = this.tracks('AUDIO');
                for (var i = 0; i < audio.length; i++) {
                    if (audio[i].name === pa) { try { this.av.setSelectTrack('AUDIO', audio[i].index); } catch (e) { /* egal */ } break; }
                }
            }
            if (ps && ps !== 'Aus') {
                var subs = this.tracks('TEXT');
                for (var j = 0; j < subs.length; j++) {
                    if (subs[j].name === ps) {
                        try { this.av.setSelectTrack('TEXT', subs[j].index); this.av.setSilentSubtitle(false); this.subtitleOn = true; this.subIndex = j; } catch (e2) { /* egal */ }
                        break;
                    }
                }
            }
        }
    };

    // =====================================================================
    // Navigation zwischen den Bildschirmen
    // =====================================================================

    var Nav = {
        stack: [],
        top: function () { return this.stack[this.stack.length - 1]; },

        show: function (screen, restoring) {
            screen._dom = null;
            var app = $('#app');
            app.innerHTML = '';
            $('#toast').classList.add('hidden');   // Meldungen vom vorherigen Bildschirm ausblenden
            document.body.classList.remove('preview-mode', 'video-mode');
            Focus.clear();
            screen.render(app);
            var saved = restoring ? screen._scrolls : null;
            if (saved) this.fillTo(saved);
            var target = Focus.byKey(screen.focusKey);
            if (!target && restoring && screen.focusKey) target = this.loadUntil(screen.focusKey);
            if (target) Focus.set(target); else Focus.first();
            if (saved) this.restoreScroll(screen, saved);
        },

        /** Alle Listen-Kästen (gleiche Reihenfolge wie beim Merken) */
        boxes: function () { return document.querySelectorAll('#app .scroll'); },

        /** So viele Einträge nachladen, dass die gemerkte Scroll-Position wieder erreichbar ist */
        fillTo: function (saved) {
            var boxes = this.boxes();
            for (var i = 0; i < boxes.length && i < saved.length; i++) {
                var box = boxes[i], batches = box.querySelectorAll('.batch');
                if (box.classList.contains('batch')) batches = [box].concat([].slice.call(batches));
                for (var guard = 0; guard < 200 && box.scrollHeight < saved[i] + box.clientHeight + 200; guard++) {
                    var any = false;
                    for (var j = 0; j < batches.length; j++) if (batches[j]._batchMore && batches[j]._batchMore()) any = true;
                    if (!any) break;
                }
                box.scrollTop = saved[i];
                Nav.syncVirtual(box);
            }
        },

        /** Virtuelles Raster in diesem Kasten sofort an die Scroll-Position anpassen */
        syncVirtual: function (box) {
            var g = box.querySelector('.vgrid');
            if (g && g._vgUpdate) g._vgUpdate();
        },

        /** Gemerkten Eintrag suchen, notfalls weitere Stapel nachladen */
        loadUntil: function (key) {
            var batches = document.querySelectorAll('#app .batch');
            for (var guard = 0; guard < 60; guard++) {
                var any = false;
                for (var j = 0; j < batches.length; j++) if (batches[j]._batchMore && batches[j]._batchMore()) any = true;
                var t = Focus.byKey(key);
                if (t || !any) return t;
            }
            return null;
        },

        push: function (screen) {
            var cur = this.top();
            if (cur) {
                cur.focusKey = Focus.cur ? Focus.cur.getAttribute('data-key') : null;
                // Scroll-Stand aller Listen merken, damit „Zurück“ genau dorthin führt
                var boxes = this.boxes();
                cur._scrolls = [];
                for (var i = 0; i < boxes.length; i++) cur._scrolls.push(boxes[i].scrollTop);
                if (cur.hide) cur.hide();
                // Lange Listen (Filme, Serien) aufheben statt später alles neu zu bauen
                cur._dom = null;
                if (cur.keepDom) {
                    var app = $('#app'), frag = document.createDocumentFragment();
                    while (app.firstChild) frag.appendChild(app.firstChild);
                    cur._dom = frag;
                }
            }
            this.stack.push(screen);
            this.show(screen);
        },

        /** Aufgehobenen Bildschirm wieder einsetzen (sofort, ohne Neuaufbau) */
        revive: function (screen) {
            var app = $('#app'), frag = screen._dom, saved = screen._scrolls;
            screen._dom = null;
            app.innerHTML = '';
            $('#toast').classList.add('hidden');
            document.body.classList.remove('preview-mode', 'video-mode');
            Focus.clear();
            app.appendChild(frag);
            LazyImg.scan(app);
            var boxes = this.boxes();
            if (saved) for (var i = 0; i < boxes.length && i < saved.length; i++) { boxes[i].scrollTop = saved[i]; this.syncVirtual(boxes[i]); }
            if (screen.revived) screen.revived();
            var target = Focus.byKey(screen.focusKey);
            if (target) Focus.set(target); else Focus.first();
            if (saved) this.restoreScroll(screen, saved);
        },

        replace: function (screen) {
            var cur = this.stack.pop();
            if (cur && cur.hide) cur.hide();
            this.stack = [];
            this.stack.push(screen);
            this.show(screen);
        },

        back: function () {
            if (this.stack.length <= 1) {
                var root = this.top();
                if (root && root.onRootBack) root.onRootBack();
                return;
            }
            var cur = this.stack.pop();
            cur._backTo = this.top();          // der Bildschirm darunter (für „Sender weiterlaufen lassen“)
            if (cur.hide) cur.hide();
            cur._backTo = null;
            var top = this.top();
            if (top._dom && (!top.canRevive || top.canRevive())) this.revive(top);
            else { top._dom = null; this.show(top, true); }
        },

        /** Gemerkten Scroll-Stand halten (auch kurz danach, falls das Gerät verspätet neu aufbaut oder Bilder nachlädt) */
        userAt: 0,
        restoreScroll: function (screen, saved) {
            screen._scrolls = null;
            var since = Date.now();
            var touch = document.body.classList.contains('touch');
            function apply() {
                if (Nav.top() !== screen || Nav.userAt > since) return;   // Nutzer bedient schon wieder: nicht dazwischenfunken
                var boxes = Nav.boxes();
                for (var i = 0; i < boxes.length && i < saved.length; i++) {
                    if (Math.abs(boxes[i].scrollTop - saved[i]) > 2) { boxes[i].scrollTop = saved[i]; Nav.syncVirtual(boxes[i]); }
                }
                // Mit Fernbedienung muss der Fokus sichtbar sein; mit Finger/Maus zählt die Position
                if (!touch && Focus.cur && document.body.contains(Focus.cur)) ensureVisible(Focus.cur);
            }
            apply();
            setTimeout(apply, 60);
            setTimeout(apply, 300);
            setTimeout(apply, 800);
            setTimeout(apply, 1600);
        }
    };
    // =====================================================================
    // Maus: Mausrad (und Touchpad) scrollt jede Liste, auch ohne Touch-Modus
    // =====================================================================

    var Wheel = {
        /** Nächster scrollbarer Kasten unter dem Mauszeiger */
        box: function (node, horizontal) {
            while (node && node !== document.body && node !== document.documentElement) {
                if (node.nodeType === 1 && node.id !== 'stage' && node.id !== 'app') {
                    var big = horizontal ? node.clientWidth > 200 : node.clientHeight > 150;
                    var more = horizontal ? node.scrollWidth > node.clientWidth + 2 : node.scrollHeight > node.clientHeight + 2;
                    if (big && more) {
                        var ov = window.getComputedStyle(node)[horizontal ? 'overflowX' : 'overflowY'];
                        if (ov === 'hidden' || ov === 'auto' || ov === 'scroll') return { node: node, native: ov !== 'hidden' };
                    }
                }
                node = node.parentNode;
            }
            return null;
        },
        /** Bewegung (in Bühnen-Pixeln) an den Kasten bzw. den Bildschirm weitergeben. true = verarbeitet */
        apply: function (target, dx, dy, nativeOk, notch) {
            if (Modal.node && !Modal.node.contains(target)) target = Modal.node.querySelector('.vscroll') || Modal.node;
            var horizontal = Math.abs(dx) > Math.abs(dy);
            var hit = this.box(target, horizontal);
            // Mausrad über einer waagerechten Reihe (z. B. Besetzung) ohne senkrechte Liste: seitlich scrollen
            if (!hit && !horizontal) { hit = this.box(target, true); if (hit) { horizontal = true; dx = dy; } }
            if (hit) {
                if (hit.native && nativeOk) return false;       // scrollt der Browser schon selbst
                if (horizontal) hit.node.scrollLeft += dx; else hit.node.scrollTop += dy;
                return true;
            }
            var top = Nav.top();
            if (!Modal.node && top && top.onWheel) {
                // Ein Rad-Klick = ein Schritt (Touchpads mit kleinen Schritten werden aufsummiert)
                if (notch) {
                    if (Math.abs(dy) >= Math.abs(dx) && Math.abs(dy) >= 40) { dy = dy > 0 ? 110 : -110; dx = 0; }
                    else if (Math.abs(dx) >= 40) { dx = dx > 0 ? 200 : -200; dy = 0; }
                }
                top.onWheel(dx, dy);
                return true;
            }
            return false;
        }
    };
    document.addEventListener('wheel', function (ev) {
        var dy = ev.deltaY, dx = ev.deltaX;
        if (ev.deltaMode === 1) { dy *= 40; dx *= 40; } else if (ev.deltaMode === 2) { dy *= 800; dx *= 800; }
        if (ev.shiftKey && !dx) { dx = dy; dy = 0; }
        if (Wheel.apply(ev.target, dx / scale, dy / scale, true, true) && ev.cancelable) ev.preventDefault();
    }, { passive: false });
    // Wischen auf Bildschirmen ohne echte Liste (z. B. EPG-Raster)
    (function () {
        var lx = null, ly = null;
        document.addEventListener('touchstart', function (ev) {
            var t = ev.touches && ev.touches[0];
            lx = t ? t.clientX : null; ly = t ? t.clientY : null;
        }, { passive: true });
        document.addEventListener('touchmove', function (ev) {
            var top = Nav.top(), t = ev.touches && ev.touches[0];
            if (!t || ly === null || !top || !top.onWheel || Modal.node) return;
            if (Wheel.box(ev.target, false) || Wheel.box(ev.target, true)) return;   // echte Liste: Browser wischt selbst
            var dx = (lx - t.clientX) / scale, dy = (ly - t.clientY) / scale;
            if (Math.abs(dx) < 25 && Math.abs(dy) < 25) return;
            lx = t.clientX; ly = t.clientY;
            top.onWheel(dx, dy);
        }, { passive: true });
    })();

    // Jede Bedienung beendet das Festhalten der alten Position
    (function () {
        function mark() { Nav.userAt = Date.now(); }
        ['keydown', 'wheel', 'touchstart', 'mousedown'].forEach(function (ev) {
            document.addEventListener(ev, mark, { capture: true, passive: true });
        });
    })();

    // =====================================================================
    // Bausteine für die Oberfläche
    // =====================================================================

    function topbar(title, hint) {
        var bar = h('div');
        if (title) bar.appendChild(h('div', 'screen-title', title));
        if (hint) bar.appendChild(h('div', 'hint', hint));
        return bar;
    }

    /** search: { query, onClick } → Eintrag „Suchen“ ganz oben */
    function categoryColumn(cats, activeIndex, onSelect, search) {
        var col = h('div', 'col col-cats');
        var scroll = h('div', 'scroll');
        if (search) {
            var sq = search.query;
            var si = h('div', 'cat cat-search' + (sq ? ' active' : ''));
            si.innerHTML = icon('search', 30) + '<span></span>';
            si.lastChild.textContent = sq ? '„' + sq + '“' : 'Suchen';
            focusable(si, 'cat-search', search.onClick, 'cats');
            scroll.appendChild(si);
            if (sq) activeIndex = -1;
        }
        if (search && search.sort) {
            var so = h('div', 'cat cat-search cat-sort');
            so.innerHTML = icon('sort', 30) + '<span></span>';
            so.lastChild.textContent = search.sort.label;
            focusable(so, 'cat-sort', search.sort.onClick, 'cats');
            scroll.appendChild(so);
        }
        scroll.appendChild(h('div', 'col-head', 'Kategorien'));
        var kind = search && search.kind;
        cats.forEach(function (name, i) {
            var item = h('div', 'cat' + (i === activeIndex ? ' active' : ''));
            if (kind && Parental.catProtected(kind, name)) {
                item.classList.add('locked');
                item.innerHTML = icon('lock', 24) + '<span></span>';
                item.lastChild.textContent = name;
            } else {
                item.textContent = name;
            }
            focusable(item, 'cat-' + i, function () {
                if (kind && Parental.catLocked(kind, name)) Parental.ask('PIN für „' + name + '“', function () { onSelect(i); });
                else onSelect(i);
            }, 'cats');
            scroll.appendChild(item);
        });
        col.appendChild(scroll);
        return col;
    }

    /**
     * Bilder (Poster, Senderlogos) erst laden, wenn sie gleich ins Bild kommen.
     * Spart auf Fire-TV-Sticks & Co. viel Netz und Rechenzeit.
     */
    var LazyImg = {
        pending: [], timer: null,
        /** Beobachter je Liste (Rand gilt dann innerhalb der Liste, nicht nur am Bildschirm) */
        observerFor: function (root) {
            var holder = root || document;
            if (holder._lazyIo) return holder._lazyIo;
            holder._lazyIo = new IntersectionObserver(function (entries, io) {
                entries.forEach(function (en) {
                    if (!en.isIntersecting) return;
                    io.unobserve(en.target);
                    LazyImg.apply(en.target);
                });
            }, { root: root || null, rootMargin: '600px 600px' });
            return holder._lazyIo;
        },
        apply: function (n) {
            var url = n._lazyUrl;
            if (!url) return;
            n._lazyUrl = null;
            n.classList.remove('lazy');
            if (n.tagName === 'IMG') n.src = url;
            else n.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
        },
        /** n: <img> oder Element mit Hintergrundbild */
        set: function (n, url) {
            if (!url) return;
            if (!window.IntersectionObserver) { n._lazyUrl = url; this.apply(n); return; }
            n._lazyUrl = url;
            n.classList.add('lazy');
            this.pending.push(n);
            var self = this;
            if (!this.timer) this.timer = setTimeout(function () { self.flush(); }, 0);
        },
        flush: function () {
            this.timer = null;
            var list = this.pending;
            this.pending = [];
            for (var i = 0; i < list.length; i++) {
                var n = list[i];
                if (!n._lazyUrl) continue;
                if (!document.body.contains(n)) continue;   // nicht (mehr) sichtbar: kommt über scan() wieder
                var root = n.parentElement;
                while (root && !(root.classList && (root.classList.contains('scroll') || root.classList.contains('vscroll') || root.classList.contains('hscroll')))) root = root.parentElement;
                this.observerFor(root).observe(n);
            }
        },
        /** Nach dem Wiedereinsetzen einer aufgehobenen Liste: offene Bilder neu beobachten */
        scan: function (root) {
            var nodes = (root || document).querySelectorAll('.lazy');
            for (var i = 0; i < nodes.length; i++) if (nodes[i]._lazyUrl) this.pending.push(nodes[i]);
            if (nodes.length) this.flush();
        }
    };

    /**
     * Kleinere Bildversion holen, wo der Bild-Server das anbietet.
     * Viele Anbieter verlinken Poster von TMDB in Originalgröße (oft 2000 px) – angezeigt werden nur ~200 px.
     * Kleinere Bilder = schneller geladen und viel weniger Arbeit für Fire TV & Co.
     */
    var THUMB_HOST = (function () { try { return AB && AB.thumbHost ? String(AB.thumbHost() || '') : ''; } catch (e) { return ''; } })();
    function thumbUrl(url, w) {
        if (!url) return url;
        var m = /^(https?:\/\/image\.tmdb\.org\/t\/p\/)[^\/]+(\/.+)$/i.exec(url);
        if (m) url = m[1] + 'w' + (w || 342) + m[2];
        // Android-App: Bild einmal laden, klein rechnen und auf dem Gerät aufheben (für alle Bild-Server)
        if (THUMB_HOST && /^https?:\/\//i.test(url)) return 'https://' + THUMB_HOST + '/p?w=260&u=' + encodeURIComponent(url);
        return url;
    }

    function posterNode(item, keyPrefix, isFav, action) {
        var node = h('div', 'poster');
        var img = h('div', 'img');
        if (item.logo) LazyImg.set(img, thumbUrl(item.logo));
        if (isFav) img.appendChild(h('div', 'fav', '★'));
        if (item.rating > 0) img.appendChild(h('div', 'rate', ratingText(item.rating)));
        var e = null;
        if (item.type === 'movie') { e = Resume.forItem('movie', item); if (e && e.pos < 30) e = null; }
        else if (item.type === 'series') e = Resume.forSeries(item.id);
        if (e && !e.next) img.appendChild(progressNode(Resume.part(e)));
        node.appendChild(img);
        node.appendChild(h('div', 'title', item.name));
        var favType = item.type === 'live' ? 'live' : item.type === 'movie' ? 'movie' : item.type === 'series' ? 'series' : null;
        if (favType) node._onLong = function () { favToggleNode(node, favType, item); };
        if (e && item.type === 'series') {
            node.classList.add('has-sub');
            node.appendChild(h('div', 'sub', 'S' + e.season + ' F' + (e.num || '?') + ' · ' + Resume.leftText(e)));
        }
        return focusable(node, keyPrefix + item.id, action, 'grid');
    }

    // =====================================================================
    // Wiedergabelisten (wie bei Smarters: Listen links, QR-Code und Gerätedaten rechts)
    // =====================================================================

    function PlaylistsScreen(message) {
        this.message = message || '';
        this.error = '';
        this.loading = Remote.lists === null;
        this.timer = null;
        this.lastBack = 0;
        this.signature = '';
    }
    PlaylistsScreen.prototype.render = function (root) {
        var self = this;
        var wrap = h('div', 'pl');

        // ---------- linke Seite ----------
        var left = h('div', 'pl-left');
        var head = h('div', 'pl-head');
        if (Nav.stack.length > 1) {
            var back = h('div', 'pl-back');
            back.innerHTML = icon('back', 46);
            head.appendChild(focusable(back, 'pl-back', function () { Nav.back(); }, 'plhead'));
            head.appendChild(h('div', 'pl-divider'));
        }
        head.appendChild(h('div', 'pl-title', 'Wiedergabelisten'));
        var logo = h('img', 'pl-logo');
        logo.src = 'img/icon.png';
        head.appendChild(logo);
        left.appendChild(head);

        var grid = h('div', 'pl-grid scroll');
        var lists = Remote.lists || [];
        var current = Api.acc ? String(Storage.get('playlistId', '')) : '';
        if (this.loading && !lists.length) {
            grid.appendChild(h('div', 'pl-note', 'Wiedergabelisten werden geladen …'));
        } else if (!lists.length) {
            var note = h('div', 'pl-note');
            note.appendChild(h('div', 'pl-note-title', this.error ? 'Keine Verbindung zur Website' : 'Noch keine Wiedergabeliste'));
            note.appendChild(h('div', null, this.error ||
                'Scanne den QR-Code rechts mit dem Handy oder öffne die Website und gib dort MAC-Adresse und Geräte-Schlüssel ein. ' +
                'Die Wiedergabeliste erscheint danach hier von selbst.'));
            grid.appendChild(note);
        }
        if (!(this.loading && !lists.length)) {
            lists.concat([Demo.playlist]).forEach(function (p) {
                var card = h('div', 'pl-card' + (p.demo ? ' pl-demo' : ''));
                card.appendChild(h('div', 'pl-name', p.name));
                card.appendChild(h('div', 'pl-url', playlistAddress(p)));
                if (p.id === current) card.appendChild(h('div', 'pl-badge', 'Verbunden'));
                grid.appendChild(focusable(card, 'pl-' + p.id, function () { self.connect(p); }, 'plgrid'));
            });
        }
        left.appendChild(grid);

        var foot = h('div', 'pl-foot');
        foot.appendChild(h('div', 'pl-foot-big', 'ImperumTV ist ein Player für deine eigenen Wiedergabelisten'));
        foot.appendChild(h('div', 'pl-foot-small', 'ImperumTV verkauft keine Inhalte. Bitte frage nicht nach Inhalten.'));
        left.appendChild(foot);
        wrap.appendChild(left);

        // ---------- rechte Seite ----------
        var side = h('div', 'pl-side');
        var qr = h('div', 'pl-qr');
        try { qr.innerHTML = window.ImperumQR.svg(Device.link(), 280); } catch (e) { qr.classList.add('hidden'); }
        side.appendChild(qr);
        side.appendChild(h('div', 'pl-yellow', 'Scanne den QR-Code, um eine Wiedergabeliste hinzuzufügen.'));
        var statusText = License.known() ? License.text() : (Remote.registered ? 'Dein Gerät ist angemeldet.' : (this.error ? 'Gerät noch nicht verbunden.' : 'Gerät wird angemeldet …'));
        side.appendChild(h('div', 'pl-status' + (License.known() && !License.activated() && !License.free() ? ' trial' : ''), statusText));
        if (License.known() && !License.activated() && !License.free()) {
            side.appendChild(h('div', 'pl-price', 'Danach ' + REMOTE.price + ' einmalig auf der Website aktivieren.'));
        }
        side.appendChild(h('div', 'pl-site', REMOTE.website.replace(/^https?:\/\//, '').replace(/\/$/, '')));
        side.appendChild(h('div', 'pl-text', 'Um Wiedergabelisten hinzuzufügen oder zu verwalten, verwende diese Werte:'));
        side.appendChild(h('div', 'pl-label', 'MAC-Adresse'));
        side.appendChild(h('div', 'pl-value', Device.macText()));
        side.appendChild(h('div', 'pl-label', 'Geräte-Schlüssel'));
        side.appendChild(h('div', 'pl-value', Device.key));

        var buttons = h('div', 'pl-buttons');
        var refresh = h('div', 'button', 'Aktualisieren');
        buttons.appendChild(focusable(refresh, 'pl-refresh', function () { self.reload(true); }, 'side'));
        if (AB && AB.openUrl && document.body.classList.contains('touch')) {
            var open = h('div', 'button', 'Website öffnen');
            buttons.appendChild(focusable(open, 'pl-open', function () { AB.openUrl(Device.link()); }, 'side'));
        }
        side.appendChild(buttons);
        wrap.appendChild(side);
        root.appendChild(wrap);

        if (!this.focusKey || !Focus.byKey(this.focusKey)) {
            this.focusKey = current && Remote.find(current) ? 'pl-' + current : (lists.length ? 'pl-' + lists[0].id : 'pl-demo');
        }
        this.signature = JSON.stringify([Remote.lists, Remote.registered, this.error, this.loading, License.state && License.state.activated, License.state && License.state.freeUntil, License.daysLeft()]);

        if (this.message) { toast(this.message, 7000); this.message = ''; }
        if (!this.timer) {
            this.timer = setInterval(function () { self.reload(false); }, 15000);
            if (this.loading || Remote.lists === null) this.reload(false);
            else setTimeout(function () { if (Nav.top() === self) self.reload(false); }, 300);
        }
    };
    PlaylistsScreen.prototype.hide = function () {
        clearInterval(this.timer);
        this.timer = null;
    };
    PlaylistsScreen.prototype.reload = function (manual) {
        var self = this;
        if (manual) loader(true, 'Wiedergabelisten werden geladen …');
        var hadLists = !!(Remote.lists && Remote.lists.length);
        Remote.load().then(function () {
            self.error = '';
        }, function (e) {
            self.error = e.message || String(e);
        }).then(function () {
            self.loading = false;
            if (manual) {
                loader(false);
                toast(self.error ? self.error : (Remote.lists.length ? Remote.lists.length + ' Wiedergabeliste(n) gefunden' : 'Noch keine Wiedergabeliste eingetragen'));
            }
            if (Nav.top() !== self) return;
            if (!License.active()) { Nav.replace(new LockScreen()); return; }
            var sig = JSON.stringify([Remote.lists, Remote.registered, self.error, self.loading, License.state && License.state.activated, License.state && License.state.freeUntil, License.daysLeft()]);
            if (sig === self.signature) return;
            self.focusKey = Focus.cur ? Focus.cur.getAttribute('data-key') : self.focusKey;
            // Erste Wiedergabeliste ist gerade angekommen: gleich darauf springen
            if (!hadLists && Remote.lists && Remote.lists.length) self.focusKey = 'pl-' + Remote.lists[0].id;
            Nav.show(self);
        });
    };
    PlaylistsScreen.prototype.connect = function (p) {
        if (!License.active() && !p.demo) { Nav.replace(new LockScreen()); return; }
        var acc = playlistAccount(p);
        if (!acc) {
            toast('Diese Wiedergabeliste wird nicht unterstützt. Nötig sind Server, Benutzername und Passwort oder ein Link mit get.php?username=…&password=…', 8000);
            return;
        }
        var previous = Api.acc;
        syncAll(acc, 'Verbinde mit „' + p.name + '“ …', function () {
            Storage.set('playlistId', p.id);
            Nav.replace(new HomeScreen());
            Updater.autoCheck();
        }, function (e) {
            Api.acc = previous;
            toast(e.message || String(e), 8000);
        });
    };
    PlaylistsScreen.prototype.onRootBack = function () {
        if (WEBOS) { exitApp(); return; }
        var now = Date.now();
        if (now - this.lastBack < 3000) { exitApp(); return; }
        this.lastBack = now;
        toast('Zum Beenden noch einmal Zurück drücken');
    };

    // =====================================================================
    // Testphase abgelaufen: Aktivierung auf der Website
    // =====================================================================

    function LockScreen() { this.timer = null; this.lastBack = 0; }
    LockScreen.prototype.render = function (root) {
        var self = this;
        Player.stop();
        var wrap = h('div', 'pl');
        var left = h('div', 'pl-left lock');
        var logo = h('img', 'lock-logo');
        logo.src = 'img/icon.png';
        left.appendChild(logo);
        left.appendChild(h('div', 'lock-title', 'Deine Testphase ist abgelaufen'));
        left.appendChild(h('div', 'lock-text', 'Aktiviere ImperumTV für ' + REMOTE.price + ' einmalig. Danach kannst du die App auf diesem Gerät unbegrenzt nutzen, ohne Abo.'));
        var steps = h('ol', 'lock-steps');
        ['Scanne den QR-Code rechts mit dem Handy.', 'Bezahle auf der Website ' + REMOTE.price + ' per PayPal und tippe dort auf „Ich habe bezahlt“.', 'Sobald die Zahlung bestätigt ist, geht es hier von selbst weiter.'].forEach(function (t) {
            steps.appendChild(h('li', null, t));
        });
        left.appendChild(steps);
        left.appendChild(h('div', 'pl-foot-small lock-note', 'Deine Wiedergabelisten bleiben gespeichert.'));
        wrap.appendChild(left);

        var side = h('div', 'pl-side');
        var qr = h('div', 'pl-qr');
        try { qr.innerHTML = window.ImperumQR.svg(Device.link(), 280); } catch (e) { qr.classList.add('hidden'); }
        side.appendChild(qr);
        side.appendChild(h('div', 'pl-yellow', 'Scanne den QR-Code, um dein Gerät zu aktivieren.'));
        side.appendChild(h('div', 'pl-site', REMOTE.website.replace(/^https?:\/\//, '').replace(/\/$/, '')));
        side.appendChild(h('div', 'pl-label', 'MAC-Adresse'));
        side.appendChild(h('div', 'pl-value', Device.macText()));
        side.appendChild(h('div', 'pl-label', 'Geräte-Schlüssel'));
        side.appendChild(h('div', 'pl-value', Device.key));
        var buttons = h('div', 'pl-buttons');
        var refresh = h('div', 'button primary', 'Ich habe bezahlt');
        buttons.appendChild(focusable(refresh, 'lock-refresh', function () { self.check(true); }, 'side'));
        var demo = h('div', 'button', 'Demo ansehen');
        buttons.appendChild(focusable(demo, 'lock-demo', function () { new PlaylistsScreen().connect(Demo.playlist); }, 'side'));
        if (AB && AB.openUrl && document.body.classList.contains('touch')) {
            var open = h('div', 'button', 'Website öffnen');
            buttons.appendChild(focusable(open, 'lock-open', function () { AB.openUrl(Device.link()); }, 'side'));
        }
        side.appendChild(buttons);
        wrap.appendChild(side);
        root.appendChild(wrap);
        if (!this.focusKey) this.focusKey = 'lock-refresh';
        if (!this.timer) this.timer = setInterval(function () { self.check(false); }, 10000);
    };
    LockScreen.prototype.hide = function () { clearInterval(this.timer); this.timer = null; };
    LockScreen.prototype.check = function (manual) {
        var self = this;
        if (manual) loader(true, 'Aktivierung wird geprüft …');
        Remote.load().then(function () {
            if (manual) loader(false);
            if (Nav.top() !== self) return;
            if (License.active()) {
                toast(License.activated() ? 'Danke! Dein Gerät ist jetzt aktiviert.' : 'Weiter geht\'s');
                startWithLists();
            } else if (manual) {
                toast('Noch nicht freigeschaltet. PayPal-Zahlungen werden von Hand geprüft, meist innerhalb von 24 Stunden.', 7000);
            }
        }, function (e) {
            if (manual) { loader(false); toast(e.message || String(e), 6000); }
        });
    };
    LockScreen.prototype.onRootBack = function () {
        if (WEBOS) { exitApp(); return; }
        var now = Date.now();
        if (now - this.lastBack < 3000) { exitApp(); return; }
        this.lastBack = now;
        toast('Zum Beenden noch einmal Zurück drücken');
    };


    // =====================================================================
    // Auswahlfenster (z. B. „Aufnahme planen“ / „Abbrechen“)
    // =====================================================================

    var Modal = {
        node: null,
        returnFocus: null,
        /** buttons: [{ label, action, primary }] */
        open: function (title, text, buttons) {
            this.close();
            this.returnFocus = Focus.cur;
            var wrap = h('div', null);
            wrap.id = 'modal';
            var box = h('div', 'modal-box');
            box.appendChild(h('div', 'modal-title', title));
            if (text) box.appendChild(h('div', 'modal-text', text));
            var row = h('div', 'modal-buttons vscroll');
            var self = this, first = null;
            buttons.forEach(function (b, i) {
                var node = h('div', 'button' + (b.primary ? ' primary' : ''), b.label);
                focusable(node, 'modal-' + i, function () {
                    self.close();
                    if (b.action) b.action();
                }, 'dialog');
                row.appendChild(node);
                if (!first) first = node;
            });
            box.appendChild(row);
            wrap.appendChild(box);
            $('#stage').appendChild(wrap);
            this.node = wrap;
            if (first) Focus.set(first);
        },
        /** Fenster mit eigenem Inhalt (z. B. Tastatur) */
        openBox: function (box, firstFocus) {
            this.close();
            this.returnFocus = Focus.cur;
            var wrap = h('div', null);
            wrap.id = 'modal';
            wrap.appendChild(box);
            $('#stage').appendChild(wrap);
            this.node = wrap;
            if (firstFocus) Focus.set(firstFocus);
        },
        close: function () {
            this.pinInput = null;
            if (!this.node) return;
            if (document.activeElement && this.node.contains(document.activeElement)) document.activeElement.blur();
            this.node.parentNode.removeChild(this.node);
            this.node = null;
            if (this.returnFocus && document.body.contains(this.returnFocus)) Focus.set(this.returnFocus);
            this.returnFocus = null;
        }
    };

    // =====================================================================
    // Bildschirmtastatur (funktioniert mit jeder Fernbedienung)
    // =====================================================================

    var Keyboard = {
        ROWS: [
            ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-'],
            ['Q', 'W', 'E', 'R', 'T', 'Z', 'U', 'I', 'O', 'P', 'Ü'],
            ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', 'Ö', 'Ä'],
            ['Y', 'X', 'C', 'V', 'B', 'N', 'M', '.', '&', '+', 'ß']
        ],
        /** Baut die Tasten. input: das Eingabefeld, das gefüllt wird. */
        build: function (input, prefix) {
            prefix = prefix || 'kb';
            var box = h('div', 'kbd');
            function changed() {
                try { input.dispatchEvent(new Event('input')); } catch (e) { /* alte Browser */ }
                if (input._onType) input._onType();
            }
            function key(label, cls, keyName, action) {
                var k = h('div', 'kbd-key' + (cls ? ' ' + cls : ''), label);
                focusable(k, prefix + '-' + keyName, function () { action(); changed(); }, 'kbd');
                return k;
            }
            this.ROWS.forEach(function (row, r) {
                var line = h('div', 'kbd-row');
                row.forEach(function (ch, c) {
                    line.appendChild(key(ch, '', r + '-' + c, function () { input.value += ch.toLowerCase(); }));
                });
                box.appendChild(line);
            });
            var last = h('div', 'kbd-row');
            last.appendChild(key('Leerzeichen', 'w5', 'space', function () { if (input.value && input.value.slice(-1) !== ' ') input.value += ' '; }));
            last.appendChild(key('←  Löschen', 'w3', 'del', function () { input.value = input.value.slice(0, -1); }));
            last.appendChild(key('✕  Leeren', 'w3', 'clear', function () { input.value = ''; }));
            box.appendChild(last);
            return box;
        },
        first: function (box) { return box.querySelector('.kbd-key'); }
    };

    /** Suchvergleich: Groß/Klein egal, alle Wörter müssen vorkommen */
    function searchNorm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
    function searchMatcher(query) {
        var words = searchNorm(query).split(' ').filter(function (w) { return w; });
        return function (item) {
            var n = searchNorm(item.name);
            for (var i = 0; i < words.length; i++) if (n.indexOf(words[i]) < 0) return false;
            return true;
        };
    }

    /** Suchfenster mit Tastatur. count(q) liefert die Trefferzahl, onDone(q) übernimmt die Suche. */
    function openSearchDialog(title, initial, count, onDone) {
        var box = h('div', 'modal-box kbd-box');
        box.appendChild(h('div', 'modal-title', title));
        var input = h('input', 'input search-input');
        input.type = 'text';
        input.placeholder = 'Suchbegriff …';
        input.value = initial || '';
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('autocapitalize', 'none');
        focusable(input, 'sd-input', null, 'searchbox');
        box.appendChild(input);
        var info = h('div', 'search-status', '');
        function changed() {
            var q = input.value.trim();
            info.textContent = q.length ? count(q) + ' Treffer' : 'Tippe mit den Pfeiltasten und OK.';
        }
        input._onType = changed;
        input.addEventListener('input', changed);
        var kb = Keyboard.build(input, 'sd');
        box.appendChild(kb);
        box.appendChild(info);
        var row = h('div', 'modal-buttons');
        function btn(label, primary, action) {
            var b = h('div', 'button' + (primary ? ' primary' : ''), label);
            focusable(b, 'sd-' + label, function () { Modal.close(); action(); }, 'dialog');
            row.appendChild(b);
        }
        btn('Suchen', true, function () { onDone(input.value.trim()); });
        if (initial) btn('Suche aufheben', false, function () { onDone(''); });
        btn('Abbrechen', false, function () { });
        box.appendChild(row);
        changed();
        Modal.openBox(box, Keyboard.first(kb));
    }

    // =====================================================================
    // Updates aus der App heraus (nur Android): neue APK von GitHub laden und installieren
    // =====================================================================

    var Updater = {
        latest: null,
        checked: false,
        /** Einmal pro App-Start, kurz nachdem die Startseite da ist */
        autoCheck: function () {
            var self = this;
            if (this.checked || !this.available()) return;
            this.checked = true;
            setTimeout(function () { self.check(false); }, 4000);
        },
        available: function () { return !!(AB && AB.downloadUpdate && AB.appVersion); },
        current: function () { try { return AB.appVersion() || 0; } catch (e) { return 0; } },
        versionText: function (n) { return '1.0.' + n; },
        /** Bei GitHub nachsehen. manual = vom Benutzer ausgelöst (dann auch „schon aktuell“ melden) */
        check: function (manual) {
            var self = this;
            if (!this.available()) return;
            if (manual) loader(true, 'Suche nach Updates …');
            fetch('https://api.github.com/repos/' + REMOTE.updateRepo + '/releases/latest', { cache: 'no-store' }).then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            }).then(function (rel) {
                if (manual) loader(false);
                var m = /(\d+)\s*$/.exec(String(rel.tag_name || ''));
                var latest = m ? parseInt(m[1], 10) : 0;
                var asset = (rel.assets || []).filter(function (a) { return /\.apk$/i.test(a.name || ''); })[0];
                var cur = self.current();
                if (!asset || !latest || latest <= cur) {
                    if (manual) toast('Du hast schon die neueste Version (' + self.versionText(cur) + ').');
                    return;
                }
                self.latest = { version: latest, url: asset.browser_download_url, size: asset.size || 0 };
                // Beim automatischen Prüfen nicht stören, wenn gerade etwas läuft
                if (!manual && (Modal.node || Nav.top() instanceof PlayerScreen)) return;
                var mb = asset.size ? ' (' + Math.round(asset.size / 1e6) + ' MB)' : '';
                Modal.open('Update verfügbar', 'Version ' + self.versionText(latest) + ' ist da' + mb + '. Du hast ' + self.versionText(cur) + '.', [
                    { label: 'Jetzt aktualisieren', primary: true, action: function () { self.install(); } },
                    { label: 'Später' }
                ]);
            }, function () {
                if (manual) { loader(false); toast('GitHub ist gerade nicht erreichbar. Versuche es später noch einmal.', 5000); }
            });
        },
        install: function () {
            var self = this;
            if (!this.latest) return;
            if (AB.canInstall && !AB.canInstall()) {
                Modal.open('Installation erlauben', 'Damit ImperumTV sich selbst aktualisieren darf, erlaube einmal „Apps aus dieser Quelle installieren“ für ImperumTV. ' +
                    'Fire TV: Einstellungen → Mein Fire TV → Entwickleroptionen → Apps unbekannter Herkunft → ImperumTV: AN.', [
                    { label: 'Einstellungen öffnen', primary: true, action: function () { AB.openInstallSettings(); } },
                    { label: 'Trotzdem versuchen', action: function () { self.download(); } },
                    { label: 'Abbrechen' }
                ]);
                return;
            }
            this.download();
        },
        download: function () {
            Loader.show('Update wird geladen …');
            Loader.progress(2, 'Update wird geladen … 0 %');
            AB.downloadUpdate(this.latest.url);
        }
    };
    window.__androidUpdate = function (state, pct, msg) {
        if (state === 'progress') { Loader.progress(pct, 'Update wird geladen … ' + pct + ' %'); return; }
        Loader.hide();
        if (state === 'installing') toast('Tippe jetzt auf „Installieren“. Deine Listen und Einstellungen bleiben erhalten.', 8000);
        else if (state === 'nosettings') toast('Bitte in den Einstellungen des Geräts „Apps unbekannter Herkunft“ für ImperumTV erlauben.', 8000);
        else toast('Update fehlgeschlagen' + (msg ? ': ' + msg : '') + '. Alternativ: ' + REMOTE.website.replace(/^https?:\/\//, '') + 'apk', 9000);
    };

    // =====================================================================
    // Kindersicherung: PIN schützt Erwachsenen- und ausgewählte Kategorien.
    // Der Admin kann die PIN auf der Website zurücksetzen (Gerät merkt das beim Abgleich).
    // =====================================================================

    var Parental = {
        ADULT: /(^|[^a-z])(xxx|adult|adults|erwachsene?|for adults|18\s*\+|\+\s*18|porn|porno|sex|sexy|erotik|erotic|hot\s*club|playboy|hustler|brazzers|redlight|private)([^a-z]|$)/i,
        unlockedUntil: 0,
        lastReset: undefined,     // letzter Stand von der Website (undefined = noch unbekannt)

        enabled: function () { return !!Storage.get('parentalPin', ''); },
        hash: function (pin) { return 'p' + hash32('imperum-pin:' + pin + ':' + Device.key, 7).toString(16); },
        check: function (pin) { return this.hash(pin) === Storage.get('parentalPin', ''); },
        autoAdult: function () { return Storage.get('parentalAdult', true) !== false; },
        cats: function () { var c = Storage.get('parentalCats', []); return Array.isArray(c) ? c : []; },
        unlocked: function () { return Date.now() < this.unlockedUntil; },
        lock: function () { this.unlockedUntil = 0; },
        unlock: function () { this.unlockedUntil = Date.now() + 60 * 60 * 1000; },   // 1 Stunde frei

        /** Ist diese Kategorie geschützt? kind: 'live', 'movie' oder 'series' */
        catProtected: function (kind, cat) {
            if (!cat || !this.enabled()) return false;
            if (this.autoAdult() && this.ADULT.test(cat)) return true;
            return this.cats().indexOf(kind + ':' + cat) >= 0;
        },
        /** Gerade gesperrt (geschützt und nicht mit PIN geöffnet) */
        catLocked: function (kind, cat) { return !this.unlocked() && this.catProtected(kind, cat); },
        /** Liste ohne gesperrte Inhalte */
        visible: function (kind, list) {
            if (!this.enabled() || this.unlocked()) return list;
            var self = this;
            return list.filter(function (it) { return !self.catProtected(kind, it.cat); });
        },
        toggleCat: function (kind, cat) {
            var c = this.cats(), k = kind + ':' + cat, i = c.indexOf(k);
            if (i >= 0) c.splice(i, 1); else c.push(k);
            Storage.set('parentalCats', c);
            return i < 0;
        },
        setPin: function (pin) {
            Storage.set('parentalPin', this.hash(pin));
            // Merken, welcher Rücksetz-Stand schon bekannt ist (alte Rücksetzungen zählen nicht)
            Storage.set('parentalResetSeen', this.lastReset === undefined ? '?' : (this.lastReset || ''));
            this.report(true);
        },
        clear: function () {
            Storage.remove('parentalPin');
            this.lock();
            this.report(false);
        },
        report: function (on) {
            Remote.rpc('device_parental', { p_mac: Device.mac, p_key: Device.key, p_on: on }).then(null, function () { /* offline: egal */ });
        },
        /** Wird bei jedem Abgleich mit der Website aufgerufen */
        onStatus: function (resetAt) {
            var now = resetAt || '';
            this.lastReset = now;
            if (!this.enabled()) return;
            var seen = Storage.get('parentalResetSeen', '?');
            if (seen === '?') { Storage.set('parentalResetSeen', now); return; }
            if (now && now !== seen) {
                Storage.remove('parentalPin');
                Storage.set('parentalResetSeen', now);
                this.lock();
                toast('Die Kindersicherung wurde vom Anbieter zurückgesetzt. Du kannst in den Einstellungen eine neue PIN vergeben.', 8000);
            }
        },
        /** PIN abfragen, dann onOk. Ohne Kindersicherung oder bereits geöffnet: sofort. */
        ask: function (title, onOk, force) {
            var self = this;
            if (!this.enabled() || (!force && this.unlocked())) { onOk(); return; }
            pinDialog(title || 'PIN eingeben', 'Diese Inhalte sind mit der Kindersicherung geschützt.', function (pin, fail) {
                if (!self.check(pin)) { fail('Falsche PIN. Bitte noch einmal.'); return false; }
                self.unlock();
                onOk();
                return true;
            }, true);
        }
    };

    /**
     * PIN-Eingabe mit Ziffernblock (Pfeiltasten + OK) oder den Zifferntasten der Fernbedienung.
     * onPin(pin, fail) gibt true zurück, wenn das Fenster schließen soll.
     */
    function pinDialog(title, text, onPin, showForgot) {
        var box = h('div', 'modal-box pin-box');
        box.appendChild(h('div', 'modal-title', title));
        var info = h('div', 'modal-text', text || '');
        box.appendChild(info);
        var dots = h('div', 'pin-dots');
        var dotNodes = [];
        for (var i = 0; i < 4; i++) { var dn = h('span', 'pin-dot'); dots.appendChild(dn); dotNodes.push(dn); }
        box.appendChild(dots);
        var err = h('div', 'pin-error', '');
        box.appendChild(err);
        var pin = '';
        function draw() { for (var k = 0; k < 4; k++) dotNodes[k].className = 'pin-dot' + (k < pin.length ? ' on' : ''); }
        function fail(msg) {
            err.textContent = msg;
            pin = '';
            draw();
            dots.classList.remove('shake');
            void dots.offsetWidth;
            dots.classList.add('shake');
        }
        function add(d) {
            if (pin.length >= 4) return;
            pin += d;
            err.textContent = '';
            draw();
            if (pin.length === 4) {
                var entered = pin;
                setTimeout(function () { if (onPin(entered, fail)) closePin(); }, 120);
            }
        }
        function closePin() { Modal.pinInput = null; Modal.close(); }
        var pad = h('div', 'pin-pad');
        ['1', '2', '3', '4', '5', '6', '7', '8', '9', '←', '0', '✕'].forEach(function (lab) {
            var b = h('div', 'pin-key' + (lab === '←' || lab === '✕' ? ' small' : ''), lab);
            focusable(b, 'pin-' + lab, function () {
                if (lab === '←') { pin = pin.slice(0, -1); draw(); }
                else if (lab === '✕') closePin();
                else add(lab);
            }, 'pin');
            pad.appendChild(b);
        });
        box.appendChild(pad);
        if (showForgot) {
            box.appendChild(h('div', 'pin-forgot', 'PIN vergessen? Dein Anbieter kann sie für die MAC-Adresse ' + Device.macText() + ' zurücksetzen.'));
        }
        Modal.openBox(box, pad.querySelector('[data-key="pin-5"]') || pad.firstChild);
        Modal.pinInput = add;
        // Neuer Stand von der Website, z. B. gerade zurückgesetzt
        if (showForgot) Remote.load().then(null, function () { });
    }

    /** Neue PIN zweimal eingeben lassen */
    function newPinFlow(done) {
        pinDialog('Neue PIN', 'Wähle eine 4-stellige PIN für die Kindersicherung.', function (first) {
            setTimeout(function () {
                pinDialog('PIN wiederholen', 'Gib dieselbe PIN noch einmal ein.', function (second, fail) {
                    if (second !== first) { fail('Die PINs stimmen nicht überein. Noch einmal.'); return false; }
                    Parental.setPin(second);
                    Parental.unlock();
                    toast('Kindersicherung ist an. Erwachsenen-Kategorien sind jetzt geschützt.', 5000);
                    if (done) done();
                    return true;
                });
            }, 50);
            return true;
        });
    }

    // =====================================================================
    // Aufnahmen (nur in der Android-App)
    // =====================================================================

    var Rec = {
        available: function () { return !!(AB && AB.recSchedule); },
        list: function () {
            if (!this.available()) return [];
            try { return JSON.parse(AB.recList()) || []; } catch (e) { return []; }
        },
        storage: function () {
            try { return JSON.parse(AB.recStorage()); } catch (e) { return null; }
        },
        /** Live-Adresse für Aufnahmen: immer TS, das lässt sich am besten speichern */
        url: function (ch) {
            return Api.acc.server + '/live/' + Api.creds() + '/' + ch.id + '.ts';
        },
        /** Aufnahme planen. Rückgabe: true oder Fehlertext */
        schedule: function (ch, title, start, end, progStart, progEnd) {
            var now = Date.now();
            var res = AB.recSchedule(JSON.stringify({
                channelId: ch.id, channel: ch.name, title: title || ch.name, url: this.url(ch),
                start: Math.max(now, start), end: end,
                progStart: progStart || start, progEnd: progEnd || end
            }));
            if (!res || res.charAt(0) === '!') return res ? res.slice(1) : 'Aufnahme konnte nicht geplant werden.';
            return true;
        },
        /** Geplante/laufende Aufnahmen je Sender und Sendungsbeginn */
        marks: function () {
            var map = {};
            this.list().forEach(function (r) {
                if (r.status === 'scheduled' || r.status === 'recording') map[r.channelId + ':' + (r.progStart || r.start)] = r;
            });
            return map;
        },
        sizeText: function (bytes) {
            if (!bytes) return '0 MB';
            if (bytes > 1e9) return (bytes / 1e9).toFixed(1).replace('.', ',') + ' GB';
            return Math.round(bytes / 1e6) + ' MB';
        }
    };

    function dateText(ms) {
        var d = new Date(ms), days = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
        var today = new Date(); today.setHours(0, 0, 0, 0);
        var diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - today) / 86400000);
        var day = diff === 0 ? 'Heute' : diff === 1 ? 'Morgen' : diff === -1 ? 'Gestern' : days[d.getDay()] + ' ' + pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.';
        return day + ' ' + fmtClock(d);
    }

    // =====================================================================
    // Startbildschirm
    // =====================================================================

    function HomeScreen() { this.lastBack = 0; }
    HomeScreen.prototype.render = function (root) {
        // Kopfzeile: Krone + ImperumTV in der Mitte, Suche und Neu laden rechts
        var head = h('div', 'home-head');
        var title = h('div', 'home-title');
        // Freigestelltes Logo (ohne Hintergrund), schwebt über der Startseite
        var logo = h('img', 'home-logo');
        logo.src = 'img/logo-frei.png';
        logo.alt = 'ImperumTV';
        title.appendChild(logo);
        head.appendChild(title);
        var btns = h('div', 'home-head-btns');
        [
            ['search', 'search', function () { Nav.push(new SearchScreen()); }],
            ['reload', 'refresh', function () { reloadAll(); }]
        ].forEach(function (b) {
            var node = h('div', 'round-btn');
            node.innerHTML = icon(b[1], 44);
            btns.appendChild(focusable(node, 'home-top-' + b[0], b[2], 'topbtns'));
        });
        head.appendChild(btns);
        root.appendChild(head);

        var circles = h('div', 'home-circles');
        [
            ['live', 'tv', 'LIVE TV', function () { Nav.push(new LiveScreen(0)); }],
            ['epg', 'epg', 'EPG', function () { Nav.push(new EpgGridScreen(0)); }],
            ['movies', 'film', 'FILME', function () { Nav.push(new MoviesScreen('movies')); }],
            ['series', 'series', 'SERIEN', function () { Nav.push(new MoviesScreen('series')); }]
        ].forEach(function (c) {
            var node = h('div', 'circle');
            node.innerHTML = '<div class="icon">' + icon(c[1], 120) + '</div><div class="label">' + c[2] + '</div>';
            circles.appendChild(focusable(node, 'home-' + c[0], c[3], 'circles'));
        });
        root.appendChild(circles);

        var tiles = h('div', 'home-tiles');
        var tileList = [];
        if (Resume.all().length) tileList.push(['continue', 'resume', 'WEITERSCHAUEN', function () { Nav.push(new ContinueScreen()); }]);
        tileList.push(
            ['favs', 'star', 'FAVORITEN', function () { Nav.push(new FavoritesScreen()); }],
            ['search', 'search', 'SUCHE', function () { Nav.push(new SearchScreen()); }]
        );
        if (Rec.available()) tileList.push(['recs', 'rec', 'AUFNAHMEN', function () { Nav.push(new RecordingsScreen()); }]);
        tileList.push(
            ['account', 'user', 'KONTO', function () { Nav.push(new AccountScreen()); }],
            ['settings', 'gear', 'EINSTELLUNGEN', function () { Nav.push(new SettingsScreen()); }],
            ['lists', 'list', 'LISTEN', function () { Nav.push(new PlaylistsScreen()); }]
        );
        tileList.forEach(function (t) {
            var node = h('div', 'tile');
            node.innerHTML = '<div class="icon">' + icon(t[1], 46) + '</div><div class="label">' + t[2] + '</div>';
            tiles.appendChild(focusable(node, 'home-' + t[0], t[3], 'tiles'));
        });
        root.appendChild(tiles);

        var exp = Data.expiryText();
        if (exp) root.appendChild(h('div', 'expiry', 'Läuft ab: ' + exp));
        if (License.known() && !License.activated() && !License.free()) {
            root.appendChild(h('div', 'trial-note', License.text() + ' · danach ' + REMOTE.price + ' einmalig unter Listen aktivieren'));
        }
        if (!this.focusKey) this.focusKey = 'home-live';
    };
    HomeScreen.prototype.onRootBack = function () {
        if (WEBOS) { exitApp(); return; }
        var now = Date.now();
        if (now - this.lastBack < 3000) { exitApp(); return; }
        this.lastBack = now;
        toast('Zum Beenden noch einmal Zurück drücken');
    };

    /** Aktualisieren: Sender, Filme und Serien neu vom Anbieter holen und zeigen, was neu ist */
    function reloadAll() {
        var acc = Api.acc || Storage.get('account', null);
        if (!acc) return;
        syncAll(acc, 'Liste wird aktualisiert …', function () {
            Nav.replace(new HomeScreen());
        }, function (e) {
            toast(e.message || String(e), 6000);
        });
    }

    // =====================================================================
    // Live-TV: Kategorien | Sender | Vorschau mit Programm
    // =====================================================================

    function LiveScreen(catIndex) {
        this.catIndex = catIndex || 0;
        this.selected = null;
        this.list = [];
    }
    /** Suche übernehmen und zum ersten Treffer springen (für Live, Filme, Serien) */
    function applySearch(q, firstSelector) {
        this.query = q;
        this.focusKey = null;
        this.savedScroll = 0;
        Nav.show(this);
        var first = q ? $(firstSelector) : null;
        var target = first || Focus.byKey('cat-search');
        if (target) Focus.set(target);
        if (q) toast(this.filter().length + ' Treffer für „' + q + '“');
    }
    LiveScreen.prototype.applySearch = applySearch;
    LiveScreen.prototype.categories = function () {
        var seen = {}, cats = [];
        Data.channels.forEach(function (c) { if (c.cat && !seen[c.cat]) { seen[c.cat] = true; cats.push(c.cat); } });
        return ['Alle', '★ Favoriten'].concat(cats);
    };
    LiveScreen.prototype.filter = function () {
        var all = Parental.visible('live', Data.channels);
        if (this.query) return all.filter(searchMatcher(this.query));
        var cats = this.categories(), cat = cats[this.catIndex];
        if (this.catIndex === 0) return all.slice();
        if (this.catIndex === 1) return all.filter(function (c) { return Favs.has('live', c.id); });
        return all.filter(function (c) { return c.cat === cat; });
    };
    LiveScreen.prototype.render = function (root) {
        var self = this;
        document.body.classList.add('preview-mode');
        root.appendChild(topbar('Live TV', 'OK: Vorschau · nochmal OK: Vollbild · OK lang: Favorit'));

        var columns = h('div', 'columns');
        var cats = this.categories();
        columns.appendChild(categoryColumn(cats, this.catIndex, function (i) {
            self.catIndex = i;
            self.query = '';
            self.focusKey = null;
            Nav.show(self);
            var first = $('.col-list .row');
            if (first) Focus.set(first);
        }, { query: this.query, kind: 'live', onClick: function () { self.openSearch(); } }));

        var listCol = h('div', 'col col-list');
        var scroll = h('div', 'scroll');
        listCol.appendChild(scroll);
        columns.appendChild(listCol);

        this.list = this.filter();
        if (!this.list.length) {
            scroll.appendChild(h('div', 'empty-note', this.query ? 'Kein Sender gefunden für „' + this.query + '“.' : this.catIndex === 1 ? 'Noch keine Favoriten. Drücke bei einem Sender die gelbe Taste.' : 'Keine Sender in dieser Kategorie.'));
        }
        var batch = batchRender(scroll, this.list, function (ch, i) {
            var row = h('div', 'row' + (self.selected && self.selected.id === ch.id ? ' active' : ''));
            row.appendChild(h('div', 'num', String(ch.num)));
            var logo = h('img', 'logo');
            if (ch.logo) LazyImg.set(logo, ch.logo);
            logo.onerror = function () { logo.style.visibility = 'hidden'; };
            row.appendChild(logo);
            row.appendChild(h('div', 'name', ch.name));
            if (Favs.has('live', ch.id)) row.appendChild(h('div', 'star', '★'));
            row._channel = ch;
            row._onLong = function () { favToggleNode(row, 'live', ch); };
            return focusable(row, 'ch-' + ch.id, function () { self.choose(ch, i); }, 'list');
        }, 120);

        // Gemerkten Sender wieder sichtbar machen
        if (this.selected) {
            for (var i = 0; i < this.list.length; i++) if (this.list[i].id === this.selected.id) { batch.ensure(i); break; }
        }

        var info = h('div', 'col col-info');
        this.previewBox = h('div', 'preview-box' + (this.selected ? '' : ' empty'));
        if (!this.selected) this.previewBox.appendChild(h('div', 'preview-placeholder', 'Sender auswählen'));
        info.appendChild(this.previewBox);
        this.infoPanel = h('div', 'info-panel');
        info.appendChild(this.infoPanel);
        columns.appendChild(info);
        root.appendChild(columns);

        if (!this.focusKey) this.focusKey = this.selected ? 'ch-' + this.selected.id : (this.list.length ? 'ch-' + this.list[0].id : 'cat-0');

        if (this.selected) {
            var sel = this.selected;
            setTimeout(function () { self.startPreview(sel); }, 50);
        }
    };
    LiveScreen.prototype.openSearch = function () {
        var self = this;
        openSearchDialog('Sender suchen', this.query, function (q) {
            return Parental.visible('live', Data.channels).filter(searchMatcher(q)).length;
        }, function (q) { self.applySearch(q, '.col-list .row'); });
    };
    LiveScreen.prototype.choose = function (ch, index) {
        if (this.selected && this.selected.id === ch.id) {
            this.openFullscreen(index);
            return;
        }
        this.selected = ch;
        var rows = document.querySelectorAll('.col-list .row');
        for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('active', rows[i]._channel && rows[i]._channel.id === ch.id);
        this.previewBox.className = 'preview-box';
        this.previewBox.innerHTML = '';
        this.startPreview(ch);
    };
    LiveScreen.prototype.startPreview = function (ch) {
        var self = this;
        Player.on({
            error: function () { toast('Vorschau nicht verfügbar: ' + ch.name); },
            ready: function () { Player.applyPreferences(); }
        });
        var url = Api.liveUrl(ch.id), rect = stageRect(this.previewBox);
        if (!Player.keep(url, rect)) Player.open(url, rect);     // läuft schon (z. B. aus dem Vollbild zurück): nur verkleinern
        this.renderInfo(ch, []);
        Data.shortEpg(ch.id).then(function (list) {
            if (self.selected && self.selected.id === ch.id) self.renderInfo(ch, list);
        });
    };
    LiveScreen.prototype.renderInfo = function (ch, epg) {
        var p = this.infoPanel;
        if (!p) return;
        p.innerHTML = '';
        p.appendChild(h('div', 'info-title', ch.name));
        if (!epg.length) { p.appendChild(h('div', 'epg-row later', 'Kein Programm verfügbar')); return; }
        epg.slice(0, 4).forEach(function (e, i) {
            var row = h('div', 'epg-row' + (i > 0 ? ' later' : ''));
            var t = e.start ? fmtClock(new Date(e.start)) + (e.end ? '–' + fmtClock(new Date(e.end)) : '') : '';
            row.appendChild(h('span', 'time', t));
            row.appendChild(document.createTextNode(e.title));
            p.appendChild(row);
            if (i === 0 && e.start && e.end) {
                var prog = h('div', 'progress'), bar = h('div', 'bar');
                bar.style.width = Math.max(0, Math.min(100, (Date.now() - e.start) / (e.end - e.start) * 100)) + '%';
                prog.appendChild(bar);
                p.appendChild(prog);
            }
        });
    };
    LiveScreen.prototype.openFullscreen = function (index) {
        Player.on({});
        this.handoff = true;                           // Bild weiterlaufen lassen, nur groß machen
        var screen = new PlayerScreen(this.list, index, 'live');
        screen.handoff = true;
        Nav.push(screen);
    };
    LiveScreen.prototype.onKey = function (k) {
        if (k === KEY.YELLOW && Focus.cur && Focus.cur._channel) {
            var ch = Focus.cur._channel;
            var on = Favs.toggle('live', ch.id);
            var star = $('.star', Focus.cur);
            if (on && !star) Focus.cur.appendChild(h('div', 'star', '★'));
            if (!on && star) star.parentNode.removeChild(star);
            toast(on ? ch.name + ' zu Favoriten hinzugefügt' : ch.name + ' aus Favoriten entfernt');
            return true;
        }
        return false;
    };
    LiveScreen.prototype.hide = function () {
        Player.on({});
        if (this.handoff) this.handoff = false;        // Vollbild übernimmt den laufenden Sender
        else Player.stop();
        document.body.classList.remove('preview-mode');
    };

    // =====================================================================
    // Filme und Serien: Kategorien | Poster
    // =====================================================================

    function MoviesScreen(kind) {
        this.kind = kind;          // 'movies' oder 'series'
        this.catIndex = 0;
    }
    MoviesScreen.prototype.allItems = function () { return this.kind === 'movies' ? Data.movies : Data.series; };
    MoviesScreen.prototype.items = function () { return Parental.visible(this.favType(), this.allItems()); };
    MoviesScreen.prototype.favType = function () { return this.kind === 'movies' ? 'movie' : 'series'; };
    MoviesScreen.prototype.yearLabel = function () { return 'Filme ' + new Date().getFullYear(); };
    var RESUME_CAT = '▶ Weiter ansehen';
    var NEW_CAT = 'Zuletzt hinzugefügt';
    /** Die neuesten Titel des Anbieters (nach Datum, sonst nach Reihenfolge der Liste) */
    MoviesScreen.prototype.newItems = function () {
        var items = this.items();
        var dated = items.filter(function (m) { return m.added > 0; });
        if (dated.length < items.length / 2) return items.slice(-150).reverse();
        return dated.slice().sort(function (a, b) { return b.added - a.added; }).slice(0, 150);
    };
    /** Angefangene Filme bzw. Serien, zuletzt geschaute zuerst */
    MoviesScreen.prototype.resumeItems = function () {
        var byId = {}, out = [], movies = this.kind === 'movies';
        this.items().forEach(function (m) { byId[String(m.id)] = m; });
        Resume.all().forEach(function (e) {
            if (movies && e.kind === 'movie' && e.pos >= 30 && byId[String(e.id)]) out.push(byId[String(e.id)]);
            if (!movies && e.kind === 'episode' && e.series && byId[String(e.series.id)]) out.push(byId[String(e.series.id)]);
        });
        return out;
    };
    MoviesScreen.prototype.categories = function () {
        var seen = {}, cats = [];
        this.allItems().forEach(function (m) { if (m.cat && !seen[m.cat]) { seen[m.cat] = true; cats.push(m.cat); } });
        var base = ['Alle', '★ Favoriten', RESUME_CAT, NEW_CAT];
        if (this.kind === 'movies') base.push(this.yearLabel());
        return base.concat(cats);
    };
    MoviesScreen.prototype.applySearch = applySearch;
    MoviesScreen.prototype.openSearch = function () {
        var self = this, items = this.items();
        openSearchDialog(this.kind === 'movies' ? 'Filme suchen' : 'Serien suchen', this.query, function (q) {
            return items.filter(searchMatcher(q)).length;
        }, function (q) { self.applySearch(q, '.poster'); });
    };
    // ---------- Sortieren ----------
    var SORTS = [
        { id: 'default', name: 'Standard', note: 'Reihenfolge des Anbieters' },
        { id: 'new', name: 'Neueste zuerst', note: 'Zuletzt beim Anbieter hinzugefügt' },
        { id: 'rating', name: 'Beste Bewertung', note: 'Höchste Bewertung oben' },
        { id: 'year', name: 'Erscheinungsjahr', note: 'Neueste Jahrgänge oben' },
        { id: 'az', name: 'A – Z', note: 'Alphabetisch' }
    ];
    /** Name zum Sortieren: ohne Länderkürzel vorne („DE - “), Umlaute wie ae/oe/ue */
    function sortKey(item) {
        if (item._sk === undefined) {
            item._sk = searchNorm(String(item.name || '').replace(/^[\[(|]?\s*(?:[A-Z]{2}|GER|ENG|DEU|4K)\s*[\])|:-]+\s*/, ''))
                .replace(/^[^a-z0-9äöüß]+/, '')
                .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
        }
        return item._sk;
    }
    MoviesScreen.prototype.sortId = function () {
        var id = Storage.get('sort.' + this.kind, 'default');
        for (var i = 0; i < SORTS.length; i++) if (SORTS[i].id === id) return id;
        return 'default';
    };
    MoviesScreen.prototype.sortName = function () {
        var id = this.sortId();
        for (var i = 0; i < SORTS.length; i++) if (SORTS[i].id === id) return SORTS[i].name;
        return 'Standard';
    };
    MoviesScreen.prototype.sortList = function (list) {
        var id = this.sortId();
        if (id === 'default' || list.length < 2) return list;
        var rows = list.map(function (m, i) { return { m: m, i: i }; });
        function byName(a, b) { var x = sortKey(a.m), y = sortKey(b.m); return x < y ? -1 : x > y ? 1 : a.i - b.i; }
        var cmp = {
            az: byName,
            'new': function (a, b) { return (b.m.added || 0) - (a.m.added || 0) || a.i - b.i; },
            rating: function (a, b) { return (b.m.rating || 0) - (a.m.rating || 0) || a.i - b.i; },
            year: function (a, b) { return (b.m.year || 0) - (a.m.year || 0) || (b.m.rating || 0) - (a.m.rating || 0) || a.i - b.i; }
        }[id];
        rows.sort(cmp);
        return rows.map(function (r) { return r.m; });
    };
    MoviesScreen.prototype.sortMenu = function () {
        var self = this, cur = this.sortId();
        var buttons = SORTS.map(function (o) {
            return { label: (o.id === cur ? '✓  ' : '      ') + o.name + '  ·  ' + o.note, primary: o.id === cur, action: function () {
                Storage.set('sort.' + self.kind, o.id);
                self.focusKey = 'cat-sort';
                self.savedScroll = 0;
                Nav.show(self);
                toast('Sortiert: ' + o.name);
            } };
        });
        buttons.push({ label: 'Schließen', action: function () { } });
        Modal.open('Sortieren', this.kind === 'movies' ? 'Gilt für alle Film-Kategorien.' : 'Gilt für alle Serien-Kategorien.', buttons);
        if (Modal.node) Modal.node.classList.add('modal-list');
        var sel = Modal.node && Modal.node.querySelector('.button.primary');
        if (sel) Focus.set(sel);
    };
    MoviesScreen.prototype.filter = function () {
        var cat0 = this.categories()[this.catIndex];
        var list = this.filterRaw();
        return !this.query && cat0 === RESUME_CAT ? list : this.sortList(list);
    };
    MoviesScreen.prototype.filterRaw = function () {
        if (this.query) return this.items().filter(searchMatcher(this.query));
        var items = this.items(), fav = this.favType();
        var cats = this.categories(), cat = cats[this.catIndex];
        if (this.catIndex === 0) return items.slice();
        if (this.catIndex === 1) return items.filter(function (m) { return Favs.has(fav, m.id); });
        if (cat === RESUME_CAT) return this.resumeItems();
        if (cat === NEW_CAT) return this.newItems();
        if (this.kind === 'movies' && cat === this.yearLabel()) {
            var year = new Date().getFullYear();
            return items.filter(function (m) { return m.year === year; });
        }
        return items.filter(function (m) { return m.cat === cat; });
    };
    MoviesScreen.prototype.render = function (root) {
        var self = this;
        var title = this.kind === 'movies' ? 'Filme' : 'Serien';
        var loaded = this.kind === 'movies' ? Data.moviesLoaded : Data.seriesLoaded;
        root.appendChild(topbar(title, 'OK: Öffnen · OK lang: Favorit'));
        if (!loaded) {
            loader(true, title + ' werden geladen …');
            (this.kind === 'movies' ? Data.loadMovies() : Data.loadSeries()).then(function () {
                loader(false);
                if (Nav.top() === self) Nav.show(self);
            }, function (e) {
                loader(false);
                toast(e.message || String(e), 6000);
            });
            return;
        }

        var columns = h('div', 'columns');
        columns.appendChild(categoryColumn(this.categories(), this.catIndex, function (i) {
            self.catIndex = i;
            self.query = '';
            self.focusKey = null;
            self.savedScroll = 0;
            Nav.show(self);
            var first = $('.poster');
            if (first) Focus.set(first);
        }, { query: this.query, kind: this.favType(), onClick: function () { self.openSearch(); },
             sort: { label: 'Sortieren: ' + this.sortName(), onClick: function () { self.sortMenu(); } } }));

        var gridCol = h('div', 'col col-grid');
        var scroll = h('div', 'scroll');
        var grid = h('div', 'grid');
        scroll.appendChild(grid);
        gridCol.appendChild(scroll);
        columns.appendChild(gridCol);
        root.appendChild(columns);

        var list = this.filter(), fav = this.favType();
        if (!list.length) {
            var note = this.query ? 'Nichts gefunden für „' + this.query + '“.' :
                this.categories()[this.catIndex] === RESUME_CAT ? 'Hier erscheinen ' + (this.kind === 'movies' ? 'Filme' : 'Serien') + ', die du angefangen hast.' :
                this.catIndex === 1 ? 'Noch keine Favoriten. Drücke bei einem Poster die gelbe Taste.'
                : (this.categories()[this.catIndex] === this.yearLabel() ? 'Dein Anbieter hat keine Filme mit dem Jahr ' + new Date().getFullYear() + ' gekennzeichnet.' : 'Nichts gefunden.');
            grid.appendChild(h('div', 'empty-note', note));
        }
        if (this.savedScroll) scroll.scrollTop = this.savedScroll;
        var vg = virtualGrid(scroll, grid, list, function (item) {
            var node = posterNode(item, fav + '-', Favs.has(fav, item.id), function () {
                self.opened = item;
                Nav.push(self.kind === 'movies' ? new MovieDetailScreen(item) : new SeriesDetailScreen(item));
            });
            node._item = item;
            return node;
        });
        if (this.savedScroll) { scroll.scrollTop = this.savedScroll; vg.update(); }
        // Zurück aus einem Film: genau dort weitermachen, wo man war
        if (this.focusKey) {
            for (var i = 0; i < list.length; i++) {
                if (fav + '-' + list[i].id === this.focusKey) { vg.ensure(i); break; }
            }
        }
        this.scrollBox = scroll;
        if (!this.focusKey) this.focusKey = list.length ? fav + '-' + list[0].id : 'cat-0';
    };
    MoviesScreen.prototype.hide = function () {
        this.savedScroll = this.scrollBox ? this.scrollBox.scrollTop : 0;
    };
    // Zurück aus Film/Serie: Liste nicht neu bauen (bei Tausenden Postern dauert das sonst ewig)
    MoviesScreen.prototype.keepDom = true;
    MoviesScreen.prototype.canRevive = function () {
        if (this.query) return true;
        var cat = this.categories()[this.catIndex];
        return this.catIndex !== 1 && cat !== RESUME_CAT;     // Favoriten/Weiterschauen ändern sich, die sind kurz
    };
    /** Nur das geöffnete Poster auffrischen (Favorit-Stern, Fortschritt) */
    MoviesScreen.prototype.revived = function () {
        var fav = this.favType(), keys = [this.focusKey];
        if (this.opened) keys.push(fav + '-' + this.opened.id);
        for (var i = 0; i < keys.length; i++) {
            var node = Focus.byKey(keys[i]);
            if (!node || !node._item) continue;
            var item = node._item;
            var fresh = posterNode(item, fav + '-', Favs.has(fav, item.id), function () { });
            node.innerHTML = '';
            while (fresh.firstChild) node.appendChild(fresh.firstChild);
            if (fresh.classList.contains('has-sub')) node.classList.add('has-sub'); else node.classList.remove('has-sub');
        }
    };
    MoviesScreen.prototype.onKey = function (k) {
        if (k === KEY.YELLOW && Focus.cur && Focus.cur._item) {
            var item = Focus.cur._item;
            var on = Favs.toggle(this.favType(), item.id);
            var img = $('.img', Focus.cur), star = $('.fav', Focus.cur);
            if (on && !star) img.appendChild(h('div', 'fav', '★'));
            if (!on && star) star.parentNode.removeChild(star);
            toast(on ? item.name + ' zu Favoriten hinzugefügt' : item.name + ' aus Favoriten entfernt');
            return true;
        }
        return false;
    };

    // =====================================================================
    // Favoriten (alles zusammen)
    // =====================================================================

    function FavoritesScreen() { }
    FavoritesScreen.prototype.render = function (root) {
        var self = this;
        root.appendChild(topbar('Favoriten', 'OK: Öffnen · OK lang: Entfernen'));
        var col = h('div', 'col col-grid');
        col.style.left = '0';
        col.style.top = '110px';
        var scroll = h('div', 'scroll'), grid = h('div', 'grid');
        grid.style.paddingLeft = '70px';
        scroll.appendChild(grid);
        col.appendChild(scroll);
        root.appendChild(col);

        var live = Parental.visible('live', Data.channels).filter(function (c) { return Favs.has('live', c.id); });
        var movies = Parental.visible('movie', Data.movies).filter(function (m) { return Favs.has('movie', m.id); });
        var series = Parental.visible('series', Data.series).filter(function (s) { return Favs.has('series', s.id); });
        var all = live.concat(movies, series);

        if (!all.length) {
            grid.appendChild(h('div', 'empty-note', 'Noch keine Favoriten. Drücke bei einem Sender, Film oder einer Serie die gelbe Taste.' +
                (Data.moviesLoaded && Data.seriesLoaded ? '' : ' Film- und Serien-Favoriten erscheinen, sobald Filme bzw. Serien einmal geöffnet wurden.')));
        }
        all.forEach(function (item) {
            var type = item.type === 'live' ? 'live' : item.type === 'movie' ? 'movie' : 'series';
            var node = posterNode(item, 'fav-' + type + '-', true, function () {
                if (type === 'live') Nav.push(new PlayerScreen(live, live.indexOf(item), 'live'));
                else if (type === 'movie') Nav.push(new MovieDetailScreen(item));
                else Nav.push(new SeriesDetailScreen(item));
            });
            node._item = item; node._type = type;
            node._onLong = function () {
                Favs.toggle(type, item.id);
                toast(item.name + ' aus Favoriten entfernt');
                self.focusKey = null;
                Nav.show(self);
            };
            grid.appendChild(node);
        });
    };
    FavoritesScreen.prototype.onKey = function (k) {
        if (k === KEY.YELLOW && Focus.cur && Focus.cur._item) {
            Favs.toggle(Focus.cur._type, Focus.cur._item.id);
            toast(Focus.cur._item.name + ' aus Favoriten entfernt');
            this.focusKey = null;
            Nav.show(this);
            return true;
        }
        return false;
    };

    // =====================================================================
    // Weiter ansehen
    // =====================================================================

    function ContinueScreen() { }
    ContinueScreen.prototype.render = function (root) {
        var self = this;
        root.appendChild(topbar('Weiter ansehen', 'OK: Abspielen · Gelb: Entfernen'));
        var col = h('div', 'col col-grid');
        col.style.left = '0';
        col.style.top = '110px';
        var scroll = h('div', 'scroll'), grid = h('div', 'grid');
        grid.style.paddingLeft = '70px';
        scroll.appendChild(grid);
        col.appendChild(scroll);
        root.appendChild(col);

        var list = Resume.all();
        if (!list.length) grid.appendChild(h('div', 'empty-note', 'Hier erscheinen Filme und Serien, die du angefangen hast.'));
        list.forEach(function (e) {
            var node = h('div', 'poster resume');
            var img = h('div', 'img');
            if (e.logo) img.style.backgroundImage = 'url("' + String(e.logo).replace(/"/g, '%22') + '")';
            if (!e.next) img.appendChild(progressNode(Resume.part(e)));
            node.appendChild(img);
            node.appendChild(h('div', 'title', Resume.label(e)));
            node.appendChild(h('div', 'sub', Resume.leftText(e)));
            focusable(node, 'cont-' + e.key, function () { self.open(e); }, 'grid');
            node._entry = e;
            grid.appendChild(node);
        });
    };
    ContinueScreen.prototype.open = function (e) {
        var self = this;
        var item = { type: e.kind, id: e.id, name: e.name, logo: e.logo, ext: e.ext, season: e.season, num: e.num, series: e.series };
        var title = e.kind === 'episode' ? Resume.label(e) : e.name;
        var buttons = [];
        buttons.push({ label: e.next || e.pos < 30 ? '▶  Abspielen' : '▶  Fortsetzen ab ' + fmtTime(e.pos), primary: true,
            action: function () { self.play(e, item, e.next ? 0 : e.pos); } });
        if (!e.next) buttons.push({ label: '↺  Von vorne', action: function () { self.play(e, item, 0); } });
        if (e.kind === 'episode' && e.series) {
            buttons.push({ label: 'Zur Serie', action: function () {
                Nav.push(new SeriesDetailScreen({ type: 'series', id: e.series.id, name: e.series.name, logo: e.series.logo }));
            } });
        }
        buttons.push({ label: 'Entfernen', action: function () { self.removeEntry(e); } });
        Modal.open(title, e.kind === 'episode' ? e.name : '', buttons);
    };
    /** Filme sofort, Folgen mit allen Folgen der Serie (damit die nächste automatisch kommt) */
    ContinueScreen.prototype.play = function (e, item, at) {
        if (e.kind !== 'episode' || !e.series) { VodPlayer.play([item], 0, e.kind, at); return; }
        loader(true, 'Folgen werden geladen …');
        Data.seriesDetails(e.series.id).then(function (res) {
            loader(false);
            var eps = res.episodes, idx = -1;
            eps.forEach(function (ep, i) { ep.series = e.series; if (String(ep.id) === String(e.id)) idx = i; });
            if (idx < 0) VodPlayer.play([item], 0, 'episode', at);
            else VodPlayer.play(eps, idx, 'episode', at);
        }, function () {
            loader(false);
            VodPlayer.play([item], 0, 'episode', at);
        });
    };
    ContinueScreen.prototype.removeEntry = function (e) {
        Resume.remove(e.key);
        toast(Resume.label(e) + ' entfernt');
        this.focusKey = null;
        if (!Resume.all().length) { Nav.back(); return; }
        Nav.show(this);
    };
    ContinueScreen.prototype.onKey = function (k) {
        if (k === KEY.YELLOW && Focus.cur && Focus.cur._entry) { this.removeEntry(Focus.cur._entry); return true; }
        return false;
    };

    // =====================================================================
    // Besetzung mit Fotos (Fotos kostenlos von Wikipedia)
    // =====================================================================

    var People = {
        mem: null,
        queue: [], running: 0,
        JOB: /schauspiel|darsteller|actor|actress|regisseur|director|komiker|comedian|moderator|presenter|sänger|singer|rapper|musiker|musician|model|synchronsprecher|voice|filmemacher|filmmaker|drehbuch|screenwriter|wrestler|sportler|fußball|boxer|kabarettist|entertainer|tänzer|dancer|youtuber|influencer|autor|writer/i,
        cache: function () {
            if (!this.mem) { var m = Storage.get('people', {}); this.mem = m && typeof m === 'object' ? m : {}; }
            return this.mem;
        },
        store: function (name, url) {
            var c = this.cache(), keys = Object.keys(c);
            if (keys.length > 600) { for (var i = 0; i < 200; i++) delete c[keys[i]]; }
            c[name] = url;
            Storage.set('people', c);
        },
        /** Namen aus "A, B, C" */
        names: function (text, max) {
            var seen = {}, out = [];
            String(text || '').split(/\s*[,;\n\/|]\s*/).forEach(function (n) {
                n = n.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
                if (n.length < 3 || n.length > 40 || seen[n.toLowerCase()]) return;
                seen[n.toLowerCase()] = true;
                out.push(n);
            });
            return out.slice(0, max || 12);
        },
        /** Foto-Adresse oder '' – callback(url) */
        photo: function (name, cb) {
            var c = this.cache();
            if (c.hasOwnProperty(name)) { cb(c[name]); return; }
            this.queue.push({ name: name, cb: cb });
            this.next();
        },
        next: function () {
            var self = this;
            while (this.running < 4 && this.queue.length) {
                (function (job) {
                    self.running++;
                    self.lookup(job.name, 'de', function (url) {
                        if (url !== null) return finish(url);
                        self.lookup(job.name, 'en', function (url2) { finish(url2 || ''); });
                    });
                    function finish(url) {
                        if (url !== undefined) self.store(job.name, url);
                        self.running--;
                        job.cb(url || '');
                        self.next();
                    }
                })(this.queue.shift());
            }
        },
        /** Fragt eine Wikipedia ab. cb(url) mit url = Bild, '' = Person ohne Bild, null = nicht gefunden */
        lookup: function (name, lang, cb) {
            var url = 'https://' + lang + '.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(name.replace(/ /g, '_'));
            var done = false, self = this;
            var timer = setTimeout(function () { if (!done) { done = true; cb(undefined); } }, 8000);
            fetch(url).then(function (res) { return res.ok ? res.json() : null; }).then(function (j) {
                if (done) return;
                done = true; clearTimeout(timer);
                if (!j || j.type !== 'standard') return cb(null);
                var desc = (j.description || '') + ' ' + String(j.extract || '').slice(0, 200);
                if (!self.JOB.test(desc)) return cb(null);
                cb(j.thumbnail && j.thumbnail.source ? j.thumbnail.source : '');
            }, function () { if (!done) { done = true; clearTimeout(timer); cb(undefined); } });
        }
    };

    function initials(name) {
        var p = name.split(' ');
        return (p[0].charAt(0) + (p.length > 1 ? p[p.length - 1].charAt(0) : '')).toUpperCase();
    }

    /** Leiste/Raster mit Schauspielern. layout: 'row' (Filme) oder 'grid' (Serien) */
    function castNode(names, layout) {
        var wrap = h('div', 'cast cast-' + layout);
        wrap.appendChild(h('div', 'cast-head', 'Besetzung'));
        var strip = h('div', 'cast-strip' + (layout === 'row' ? ' hscroll' : ''));
        var inner = h('div', 'cast-inner');
        names.forEach(function (n, i) {
            var card = h('div', 'actor');
            var ph = h('div', 'photo', initials(n));
            card.appendChild(ph);
            card.appendChild(h('div', 'name', n));
            focusable(card, 'actor-' + i, null, layout === 'row' ? 'cast' : 'castgrid');
            People.photo(n, function (url) {
                if (!url) return;
                var img = new Image();
                img.onload = function () {
                    ph.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
                    ph.classList.add('has-img');
                    ph.textContent = '';
                };
                img.src = url;
            });
            inner.appendChild(card);
        });
        strip.appendChild(inner);
        wrap.appendChild(strip);
        return wrap;
    }

    // =====================================================================
    // Trailer (YouTube): Android → YouTube-App, Samsung → YouTube-App, sonst eingebettet
    // =====================================================================

    var Trailer = {
        url: function (id) { return 'https://www.youtube.com/watch?v=' + id; },
        play: function (id, title) {
            if (AB && AB.openYoutube) {
                try { if (AB.openYoutube(id)) return; } catch (e) { /* weiter unten */ }
            }
            if (typeof tizen !== 'undefined' && tizen.application && tizen.ApplicationControl && tizen.ApplicationControlData) {
                try {
                    var ctrl = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', null, null, null,
                        [new tizen.ApplicationControlData('PAYLOAD', [JSON.stringify({ values: 'v=' + id })])]);
                    tizen.application.launchAppControl(ctrl, '9Ur5IzDKqV.TizenYouTube', function () { },
                        function () { Nav.push(new TrailerScreen(id, title)); });
                    return;
                } catch (e) { /* YouTube-App fehlt: eingebettet zeigen */ }
            }
            Nav.push(new TrailerScreen(id, title));
        },
        /** Knopf „▶ Trailer“ für die Detailseiten */
        button: function (id, title) {
            var b = h('div', 'button', '▷  Trailer');
            focusable(b, 'trailer', function () { Trailer.play(id, title); }, 'buttons');
            return b;
        }
    };

    function TrailerScreen(id, title) { this.id = id; this.title = title; }
    TrailerScreen.prototype.render = function (root) {
        var wrap = h('div', 'trailer');
        var frame = document.createElement('iframe');
        frame.className = 'trailer-frame';
        frame.setAttribute('allow', 'autoplay; encrypted-media; fullscreen');
        frame.setAttribute('allowfullscreen', 'true');
        frame.setAttribute('frameborder', '0');
        frame.src = 'https://www.youtube-nocookie.com/embed/' + this.id + '?autoplay=1&rel=0&playsinline=1&modestbranding=1';
        wrap.appendChild(frame);
        var side = h('div', 'trailer-side');
        side.appendChild(h('div', 'trailer-title', 'Trailer: ' + this.title));
        var qr = h('div', 'trailer-qr');
        try { qr.innerHTML = window.ImperumQR.svg(Trailer.url(this.id), 200); } catch (e) { qr.classList.add('hidden'); }
        side.appendChild(qr);
        side.appendChild(h('div', 'trailer-note', 'Läuft der Trailer nicht? QR-Code mit dem Handy scannen.'));
        var back = h('div', 'button', 'Zurück');
        focusable(back, 'tr-back', function () { Nav.back(); }, 'buttons');
        side.appendChild(back);
        wrap.appendChild(side);
        root.appendChild(wrap);
        this.focusKey = 'tr-back';
    };

    // =====================================================================
    // Film-Detailseite
    // =====================================================================

    function MovieDetailScreen(movie) { this.movie = movie; this.info = null; }
    MovieDetailScreen.prototype.render = function (root) {
        var self = this, m = this.movie;
        var bg = h('div', 'detail-bg');
        root.appendChild(bg);
        root.appendChild(h('div', 'detail-shade'));
        var d = h('div', 'detail');
        var cover = h('div', 'cover');
        d.appendChild(cover);
        var body = h('div', 'body');
        body.appendChild(h('h1', null, m.name));
        var meta = h('div', 'meta', m.year ? String(m.year) : '');
        var rating = h('div', 'rating', '');
        body.appendChild(meta);
        body.appendChild(rating);

        var saved = Resume.forItem('movie', m);
        if (saved && saved.pos >= 30) {
            var cont = h('div', 'button primary', '▶  Weiter ab ' + fmtTime(saved.pos));
            focusable(cont, 'play', function () { VodPlayer.play([m], 0, 'movie', saved.pos); }, 'buttons');
            body.appendChild(cont);
            var again = h('div', 'button', '↺  Von vorne');
            focusable(again, 'restart', function () { VodPlayer.play([m], 0, 'movie', 0); }, 'buttons');
            body.appendChild(again);
        } else {
            var play = h('div', 'button primary', '▶  Abspielen');
            focusable(play, 'play', function () { VodPlayer.play([m], 0, 'movie', 0); }, 'buttons');
            body.appendChild(play);
        }
        var fav = h('div', 'button', Favs.has('movie', m.id) ? '★  Favorit' : '☆  Zu Favoriten');
        focusable(fav, 'fav', function () {
            var on = Favs.toggle('movie', m.id);
            fav.textContent = on ? '★  Favorit' : '☆  Zu Favoriten';
        }, 'buttons');
        body.appendChild(fav);
        if (VodPlayer.available()) body.appendChild(playerButton(this));

        var plot = h('div', 'plot', 'Infos werden geladen …');
        var credits = h('div', 'credits', '');
        body.appendChild(plot);
        body.appendChild(credits);
        d.appendChild(body);
        root.appendChild(d);

        var castBox = h('div', 'cast-box');
        body.appendChild(castBox);
        function fill(info) {
            var img = info.cover || m.logo;
            if (img) cover.style.backgroundImage = 'url("' + img.replace(/"/g, '%22') + '")';
            var back = info.backdrop || info.cover || m.logo;
            if (back) bg.style.backgroundImage = 'url("' + back.replace(/"/g, '%22') + '")';
            meta.textContent = info.meta || (m.year ? String(m.year) : '');
            var score = info.score || m.rating;
            rating.textContent = score ? ratingText(score) + ' / 10' : '';
            if (info.trailer && !$('[data-key="trailer"]', body)) fav.parentNode.insertBefore(Trailer.button(info.trailer, m.name), fav.nextSibling);
            plot.textContent = info.plot || '';
            credits.textContent = info.director ? 'Regie: ' + info.director : '';
            castBox.innerHTML = '';
            var names = People.names(info.cast, 15);
            if (names.length) castBox.appendChild(castNode(names, 'row'));
        }
        if (this.info) fill(this.info);
        else {
            fill({ cover: m.logo });
            plot.textContent = 'Infos werden geladen …';
            Data.movieInfo(m.id).then(function (info) { self.info = info; if (Nav.top() === self) fill(info); },
                function () { plot.textContent = ''; });
        }
        if (!this.focusKey) this.focusKey = 'play';
    };

    // =====================================================================
    // Serien-Detailseite mit Staffeln und Folgen
    // =====================================================================

    function SeriesDetailScreen(series) {
        this.series = series;
        this.episodes = null;
        this.info = null;
        this.season = null;
    }
    SeriesDetailScreen.prototype.render = function (root) {
        var self = this, s = this.series;
        var bg = h('div', 'detail-bg');
        root.appendChild(bg);
        root.appendChild(h('div', 'detail-shade'));
        var d = h('div', 'detail');
        var cover = h('div', 'cover');
        if (s.logo) cover.style.backgroundImage = 'url("' + s.logo.replace(/"/g, '%22') + '")';
        d.appendChild(cover);
        var body = h('div', 'body');
        body.appendChild(h('h1', null, s.name));
        root.appendChild(d);
        d.appendChild(body);

        if (!this.episodes) {
            body.appendChild(h('div', 'meta', 'Folgen werden geladen …'));
            Data.seriesDetails(s.id).then(function (res) {
                self.episodes = res.episodes;
                self.info = res.info;
                var ser = { id: s.id, name: s.name, logo: s.logo || '' };
                self.episodes.forEach(function (e) { e.series = ser; });
                if (self.episodes.length) self.season = self.episodes[0].season;
                // Mit der Staffel weitermachen, in der man zuletzt war
                var last = Resume.forSeries(s.id);
                if (last && self.episodes.some(function (e) { return e.season === last.season; })) self.season = last.season;
                if (Nav.top() === self) Nav.show(self);
            }, function (e) {
                toast(e.message || String(e), 6000);
            });
            var favWait = h('div', 'button', Favs.has('series', s.id) ? '★  Favorit' : '☆  Zu Favoriten');
            focusable(favWait, 'sfav', function () {
                var on = Favs.toggle('series', s.id);
                favWait.textContent = on ? '★  Favorit' : '☆  Zu Favoriten';
            }, 'buttons');
            body.appendChild(favWait);
            return;
        }

        var info = this.info || {};
        if (info.cover) cover.style.backgroundImage = 'url("' + info.cover.replace(/"/g, '%22') + '")';
        var back = info.backdrop || info.cover || s.logo;
        if (back) bg.style.backgroundImage = 'url("' + back.replace(/"/g, '%22') + '")';
        var sScore = info.score || s.rating;
        if (info.meta || sScore) {
            var sm = h('div', 'meta', info.meta || '');
            if (sScore) { var rs = h('span', 'meta-rate', ratingText(sScore)); sm.insertBefore(rs, sm.firstChild); }
            body.appendChild(sm);
        }
        if (info.plot) { body.appendChild(h('div', 'splot', info.plot)); body.classList.add('with-plot'); }
        // Besetzung links unter dem Cover
        var castNames = People.names(info.cast, 6);
        if (castNames.length) { d.classList.add('with-cast'); d.appendChild(castNode(castNames, 'grid')); }

        // Weiterschauen: zuletzt gesehene (oder nächste) Folge
        var all = this.episodes, last = Resume.forSeries(s.id), lastIndex = -1;
        if (last) for (var li = 0; li < all.length; li++) if (String(all[li].id) === String(last.id)) lastIndex = li;
        // Seit dem letzten Anzeigen weitergeschaut (z. B. nächste Staffel)? Dann dorthin springen.
        if (lastIndex >= 0 && last.at > (this.seasonCheckedAt || 0) && this.season !== all[lastIndex].season) {
            this.season = all[lastIndex].season;
            if (this.seasonCheckedAt) this.focusKey = 'scont';
        }
        this.seasonCheckedAt = Date.now();
        if (lastIndex >= 0) {
            var ep0 = all[lastIndex];
            var txt = (last.next ? '▶  Nächste: ' : '▶  Weiter: ') + 'S' + ep0.season + ' F' + (ep0.num || lastIndex + 1) +
                (last.next || last.pos < 30 ? '' : ' ab ' + fmtTime(last.pos));
            var cont = h('div', 'button primary', txt);
            focusable(cont, 'scont', function () {
                VodPlayer.play(all, lastIndex, 'episode', last.next ? 0 : last.pos);
            }, 'buttons');
            body.appendChild(cont);
        }

        var fav = h('div', 'button', Favs.has('series', s.id) ? '★  Favorit' : '☆  Zu Favoriten');
        focusable(fav, 'sfav', function () {
            var on = Favs.toggle('series', s.id);
            fav.textContent = on ? '★  Favorit' : '☆  Zu Favoriten';
        }, 'buttons');
        body.appendChild(fav);
        if (info.trailer) body.appendChild(Trailer.button(info.trailer, s.name));
        if (VodPlayer.available()) body.appendChild(playerButton(this));

        // Staffeln
        var seasons = [];
        this.episodes.forEach(function (e) { if (seasons.indexOf(e.season) < 0) seasons.push(e.season); });
        var row = h('div', 'seasons');
        seasons.forEach(function (n) {
            var b = h('div', 'season' + (n === self.season ? ' active' : ''), 'Staffel ' + n);
            focusable(b, 'season-' + n, function () {
                self.season = n;
                self.focusKey = 'season-' + n;
                Nav.show(self);
            }, 'seasons');
            row.appendChild(b);
        });
        body.appendChild(row);

        // Folgen der gewählten Staffel
        var list = this.episodes.filter(function (e) { return e.season === self.season; });
        var eps = h('div', 'episodes');
        var scroll = h('div', 'scroll');
        eps.appendChild(scroll);
        if (!list.length) scroll.appendChild(h('div', 'empty-note', 'Keine Folgen gefunden.'));
        list.forEach(function (ep, i) {
            var n = h('div', 'episode');
            n.appendChild(h('span', 'n', String(ep.num || i + 1)));
            var e = Resume.forItem('episode', ep);
            if (e && !e.next && e.pos >= 30) {
                n.appendChild(h('span', 'ep-left', Resume.leftText(e)));
                n.appendChild(progressNode(Resume.part(e)));
            }
            n.appendChild(document.createTextNode(ep.name));
            focusable(n, 'ep-' + ep.id, function () { playWithResume(all, all.indexOf(ep), 'episode'); }, 'episodes');
            scroll.appendChild(n);
        });
        body.appendChild(eps);
        // Folgenliste immer unter den Staffeln beginnen lassen (Knöpfe können zwei Reihen brauchen)
        var below = row.offsetTop + row.offsetHeight + 14;
        if (below > 0) eps.style.top = below + 'px';

        if (!this.focusKey) this.focusKey = lastIndex >= 0 ? 'scont' : list.length ? 'ep-' + list[0].id : 'sfav';
    };

    // =====================================================================
    // Konto
    // =====================================================================

    function AccountScreen() { }
    AccountScreen.prototype.render = function (root) {
        root.appendChild(topbar('Konto', ''));
        var box = h('div', 'account');
        var acc = Api.acc || {};
        function line(label, value) {
            var l = h('div', 'line');
            l.appendChild(h('span', null, label));
            l.appendChild(document.createTextNode(value || '–'));
            box.appendChild(l);
        }
        line('Server', acc.server);
        line('Benutzer', acc.username);
        line('Status', Data.status);
        line('Läuft ab', Data.expiryText());
        line('Live-Sender', String(Data.channels.length));
        line('Filme', Data.moviesLoaded ? String(Data.movies.length) : 'noch nicht geladen');
        line('Serien', Data.seriesLoaded ? String(Data.series.length) : 'noch nicht geladen');
        line('Lizenz', License.activated() ? 'Aktiviert (unbegrenzt)' : (License.free() ? License.freeText() : (License.known() ? License.text() : '–')));
        line('MAC-Adresse', Device.macText());
        line('Geräte-Schlüssel', Device.key);

        var buttons = h('div', 'buttons');
        var reload = h('div', 'button primary', 'Neu laden');
        focusable(reload, 'acc-reload', function () { reloadAll(); }, 'acc');
        buttons.appendChild(reload);

        var fmt = h('div', 'button', 'Live-Format: ' + Settings.liveExt.toUpperCase());
        focusable(fmt, 'acc-format', function () {
            Settings.setLiveExt(Settings.liveExt === 'ts' ? 'm3u8' : 'ts');
            fmt.textContent = 'Live-Format: ' + Settings.liveExt.toUpperCase();
            toast(Settings.liveExt === 'ts' ? 'Live-Sender laufen jetzt als TS (meist am stabilsten)' : 'Live-Sender laufen jetzt als HLS (M3U8)');
        }, 'acc');
        buttons.appendChild(fmt);

        var out = h('div', 'button', 'Wiedergabelisten');
        focusable(out, 'acc-lists', function () { Nav.push(new PlaylistsScreen()); }, 'acc');
        buttons.appendChild(out);
        box.appendChild(buttons);
        root.appendChild(box);
        if (!this.focusKey) this.focusKey = 'acc-reload';
    };

    // =====================================================================
    // EPG: alle Sender mit „Jetzt“ und „Danach“
    // =====================================================================

    /** Programm-Abfragen nacheinander (höchstens 4 gleichzeitig) */
    var EpgQueue = {
        running: 0, list: [], generation: 0,
        add: function (job) { this.list.push({ job: job, gen: this.generation }); this.next(); },
        clear: function () { this.list = []; this.generation++; },
        next: function () {
            var self = this;
            while (this.running < 4 && this.list.length) {
                var item = this.list.shift();
                if (item.gen !== this.generation) continue;
                this.running++;
                item.job().then(done, done);
            }
            function done() { self.running--; self.next(); }
        }
    };

    function timeRange(e) {
        if (!e.start) return '';
        var t = fmtClock(new Date(e.start));
        return e.end ? t + ' – ' + fmtClock(new Date(e.end)) : t;
    }

    function EpgScreen(catIndex) { this.catIndex = catIndex || 0; this.list = []; }
    EpgScreen.prototype.categories = LiveScreen.prototype.categories;
    EpgScreen.prototype.filter = LiveScreen.prototype.filter;
    EpgScreen.prototype.render = function (root) {
        var self = this;
        EpgQueue.clear();
        root.appendChild(topbar('EPG', 'OK: Sender ansehen · Gelb: Favorit'));
        var columns = h('div', 'columns');
        columns.appendChild(categoryColumn(this.categories(), this.catIndex, function (i) {
            self.catIndex = i;
            self.focusKey = null;
            Nav.show(self);
            var first = $('.col-epg .erow');
            if (first) Focus.set(first);
        }));
        var col = h('div', 'col col-epg');
        var scroll = h('div', 'scroll');
        col.appendChild(scroll);
        columns.appendChild(col);
        root.appendChild(columns);

        this.list = this.filter();
        if (!this.list.length) scroll.appendChild(h('div', 'empty-note', 'Keine Sender in dieser Kategorie.'));

        // Programm erst laden, wenn eine Zeile sichtbar wird
        var observer = null;
        if (window.IntersectionObserver) {
            observer = new IntersectionObserver(function (entries) {
                entries.forEach(function (en) {
                    if (en.isIntersecting && en.target._loadEpg) { en.target._loadEpg(); observer.unobserve(en.target); }
                });
            }, { root: scroll, rootMargin: '300px 0px' });
        }
        this.observer = observer;

        batchRender(scroll, this.list, function (ch, i) {
            var row = h('div', 'erow');
            row.appendChild(h('div', 'num', String(ch.num)));
            var logo = h('img', 'logo');
            if (ch.logo) LazyImg.set(logo, ch.logo);
            logo.onerror = function () { logo.style.visibility = 'hidden'; };
            row.appendChild(logo);
            var main = h('div', 'emain');
            main.appendChild(h('div', 'name', ch.name + (Favs.has('live', ch.id) ? '  ★' : '')));
            var now = h('div', 'enow', 'Programm wird geladen …');
            var prog = h('div', 'progress'), bar = h('div', 'bar');
            prog.appendChild(bar);
            main.appendChild(now);
            main.appendChild(prog);
            row.appendChild(main);
            var next = h('div', 'enext');
            row.appendChild(next);
            row._channel = ch;
            row._loadEpg = function () {
                row._loadEpg = null;
                EpgQueue.add(function () {
                    return Data.shortEpg(ch.id).then(function (list) {
                        var t = Date.now();
                        var cur = list.filter(function (e) { return e.start <= t && (!e.end || e.end > t); })[0] || list[0];
                        var after = cur ? list[list.indexOf(cur) + 1] : null;
                        if (!cur) { now.textContent = 'Kein Programm verfügbar'; prog.style.visibility = 'hidden'; return; }
                        now.innerHTML = '';
                        now.appendChild(h('span', 'time', timeRange(cur)));
                        now.appendChild(document.createTextNode(cur.title));
                        if (cur.start && cur.end && cur.end > cur.start) {
                            bar.style.width = Math.max(0, Math.min(100, (t - cur.start) / (cur.end - cur.start) * 100)) + '%';
                        } else prog.style.visibility = 'hidden';
                        if (after) {
                            next.appendChild(h('div', 'lbl', 'Danach'));
                            next.appendChild(h('div', 'ntitle', (after.start ? fmtClock(new Date(after.start)) + '  ' : '') + after.title));
                        }
                    });
                });
            };
            if (observer) observer.observe(row);
            else if (i < 12) row._loadEpg();
            var prevFocus = row._onFocus;
            row._onFocus = function () { if (prevFocus) prevFocus(); if (row._loadEpg) row._loadEpg(); };
            return focusable(row, 'epg-' + ch.id, function () { Nav.push(new PlayerScreen(self.list, i, 'live')); }, 'list');
        }, 80);
        if (!this.focusKey) this.focusKey = this.list.length ? 'epg-' + this.list[0].id : 'cat-0';
    };
    EpgScreen.prototype.onKey = function (k) {
        if (k === KEY.YELLOW && Focus.cur && Focus.cur._channel) {
            var ch = Focus.cur._channel;
            var on = Favs.toggle('live', ch.id);
            var name = $('.name', Focus.cur);
            if (name) name.textContent = ch.name + (on ? '  ★' : '');
            toast(on ? ch.name + ' zu Favoriten hinzugefügt' : ch.name + ' aus Favoriten entfernt');
            return true;
        }
        return false;
    };
    EpgScreen.prototype.hide = function () {
        EpgQueue.clear();
        if (this.observer) this.observer.disconnect();
    };


    // =====================================================================
    // EPG-Raster: Sender untereinander, Sendungen als Balken über die Zeit
    // =====================================================================

    var HALF_HOUR = 30 * 60 * 1000;
    function floorHalfHour(ms) { return Math.floor(ms / HALF_HOUR) * HALF_HOUR; }

    function EpgGridScreen(catIndex) {
        this.catIndex = catIndex || 0;
        this.chIndex = 0;
        this.cursor = Date.now();
        this.winStart = floorHalfHour(Date.now());
        this.col = 'prog';
        this.rowTop = 0;
        this.epg = {};
        this.loading = {};
        this.previewId = null;
    }
    EpgGridScreen.prototype.ROWS = 6;
    EpgGridScreen.prototype.SPAN = 150 * 60 * 1000;      // 2,5 Stunden sichtbar
    EpgGridScreen.prototype.X0 = 360;                    // Beginn der Zeitachse (px)
    EpgGridScreen.prototype.WIDTH = 1520;                // Breite der Zeitachse (px)
    EpgGridScreen.prototype.categories = LiveScreen.prototype.categories;
    EpgGridScreen.prototype.filter = LiveScreen.prototype.filter;

    EpgGridScreen.prototype.render = function (root) {
        var self = this;
        document.body.classList.add('preview-mode');
        EpgQueue.clear();
        this.list = this.filter();
        if (this.chIndex >= this.list.length) this.chIndex = 0;

        var wrap = h('div', 'eg');
        this.previewBox = h('div', 'eg-preview');
        this.previewLabel = h('div', 'eg-preview-label', '');
        this.previewBox.appendChild(this.previewLabel);
        wrap.appendChild(this.previewBox);
        this.info = h('div', 'eg-info');
        wrap.appendChild(this.info);
        this.clock = h('div', 'eg-clock', fmtClock(new Date()));
        wrap.appendChild(this.clock);
        this.main = h('div', 'eg-main');
        wrap.appendChild(this.main);
        var hint = h('div', 'eg-hint');
        hint.innerHTML = '<span><b>◀ ▶</b> Zeit</span><span><b>▲ ▼</b> Sender</span><span><b>OK</b> Ansehen' +
            (Rec.available() ? ' / Aufnehmen' : '') + '</span><span><i class="k red"></i>−2 Std.</span><span><i class="k green"></i>+2 Std.</span>' +
            '<span><i class="k yellow"></i>Favorit</span><span><i class="k blue"></i>Jetzt</span><span><b>◀</b> ganz links: Kategorie</span>';
        wrap.appendChild(hint);
        root.appendChild(wrap);

        this.marks = Rec.marks();
        if (!this.list.length) {
            this.main.appendChild(h('div', 'empty-note', 'Keine Sender in dieser Kategorie.'));
            return;
        }
        this.draw();
        clearInterval(this.ticker);
        this.ticker = setInterval(function () {
            if (Nav.top() !== self || Modal.node) return;
            self.clock.textContent = fmtClock(new Date());
            self.marks = Rec.marks();
            self.draw();
        }, 30000);
    };

    EpgGridScreen.prototype.hide = function () {
        clearInterval(this.ticker);
        clearTimeout(this.previewTimer);
        EpgQueue.clear();
        Player.on({});
        if (this.handoff) this.handoff = false;
        else Player.stop();
        this.previewId = null;
    };

    EpgGridScreen.prototype.px = function (ms) {
        return this.X0 + (ms - this.winStart) / this.SPAN * this.WIDTH;
    };

    /** Sendungen eines Senders im sichtbaren Zeitfenster (oder ein Platzhalter) */
    EpgGridScreen.prototype.programs = function (ch) {
        var list = this.epg[ch.id], winEnd = this.winStart + this.SPAN, self = this;
        if (!list) return [{ placeholder: true, loading: true, title: 'Programm wird geladen …', start: this.winStart, end: winEnd }];
        var out = list.filter(function (p) { return p.end > self.winStart && p.start < winEnd; });
        if (!out.length) return [{ placeholder: true, title: 'Kein Programm verfügbar', start: this.winStart, end: winEnd }];
        return out;
    };

    EpgGridScreen.prototype.focusedProgram = function () {
        var ch = this.list[this.chIndex];
        if (!ch) return null;
        var progs = this.programs(ch), c = this.cursor;
        for (var i = 0; i < progs.length; i++) if (progs[i].start <= c && progs[i].end > c) return progs[i];
        for (var j = 0; j < progs.length; j++) if (progs[j].start > c) return progs[j];
        return progs[progs.length - 1];
    };

    EpgGridScreen.prototype.load = function (ch) {
        var self = this;
        if (this.epg[ch.id] || this.loading[ch.id]) return;
        this.loading[ch.id] = true;
        EpgQueue.add(function () {
            return Data.epgFull(ch.id).then(function (list) {
                self.epg[ch.id] = list;
                if (Nav.top() === self && !Modal.node) self.draw();
            });
        });
    };

    EpgGridScreen.prototype.draw = function () {
        var self = this, main = this.main;
        if (!main) return;
        main.innerHTML = '';
        // Sichtbare Sender
        if (this.chIndex < this.rowTop) this.rowTop = this.chIndex;
        if (this.chIndex >= this.rowTop + this.ROWS) this.rowTop = this.chIndex - this.ROWS + 1;

        // Zeitachse
        var axis = h('div', 'eg-axis');
        for (var t = this.winStart; t < this.winStart + this.SPAN; t += HALF_HOUR) {
            var lbl = h('div', 'eg-time', fmtClock(new Date(t)));
            lbl.style.left = (this.px(t) - this.X0) + 'px';
            axis.appendChild(lbl);
        }
        main.appendChild(axis);

        var rows = h('div', 'eg-rows');
        var focused = this.focusedProgram();
        var now = Date.now();
        for (var r = 0; r < this.ROWS; r++) {
            var idx = this.rowTop + r;
            var ch = this.list[idx];
            if (!ch) break;
            this.load(ch);
            var next = this.list[idx + this.ROWS];
            if (next) this.load(next);

            var row = h('div', 'eg-row');
            row.style.top = (r * 98) + 'px';
            var cn = h('div', 'eg-chan' + (idx === this.chIndex ? ' sel' : '') + (idx === this.chIndex && this.col === 'chan' ? ' focus' : ''));
            cn.appendChild(h('div', 'n', String(ch.num)));
            cn.appendChild(h('div', 'nm', ch.name + (Favs.has('live', ch.id) ? ' ★' : '')));
            row.appendChild(cn);

            this.programs(ch).forEach(function (p) {
                var a = Math.max(p.start, self.winStart), b = Math.min(p.end, self.winStart + self.SPAN);
                var cls = 'eg-prog';
                if (p.placeholder) cls += ' empty';
                if (!p.placeholder && p.start <= now && p.end > now) cls += ' now';
                if (idx === self.chIndex && self.col === 'prog' && p === focused) cls += ' focus';
                var block = h('div', cls);
                block.style.left = (self.px(a) + 4) + 'px';
                block.style.width = Math.max(20, self.px(b) - self.px(a) - 8) + 'px';
                var mark = !p.placeholder && self.marks[ch.id + ':' + p.start];
                block.appendChild(h('div', 't', (mark ? '● ' : '') + p.title));
                if (!p.placeholder) block.appendChild(h('div', 'tm', fmtClock(new Date(p.start)) + ' – ' + fmtClock(new Date(p.end))));
                if (mark) block.classList.add('rec');
                row.appendChild(block);
            });
            rows.appendChild(row);
        }
        main.appendChild(rows);

        // Linie „Jetzt“
        if (now >= this.winStart && now < this.winStart + this.SPAN) {
            var line = h('div', 'eg-nowline');
            line.style.left = this.px(now) + 'px';
            main.appendChild(line);
        }
        this.renderInfo(focused);
        this.schedulePreview();
    };

    EpgGridScreen.prototype.renderInfo = function (p) {
        var ch = this.list[this.chIndex], box = this.info;
        box.innerHTML = '';
        if (!ch) return;
        if (this.col === 'chan') {
            box.appendChild(h('div', 'eg-title', ch.name));
            box.appendChild(h('div', 'eg-meta', 'Kategorie: ' + this.categories()[this.catIndex] + ' · OK: Kategorie wechseln'));
            return;
        }
        box.appendChild(h('div', 'eg-title', p ? p.title : ch.name));
        var meta = ch.name;
        if (p && !p.placeholder) meta += ' · ' + dateText(p.start) + ' – ' + fmtClock(new Date(p.end));
        var mark = p && !p.placeholder && this.marks[ch.id + ':' + p.start];
        if (mark) meta += mark.status === 'recording' ? ' · ● Wird aufgenommen' : ' · ● Aufnahme geplant';
        box.appendChild(h('div', 'eg-meta', meta));
        if (p && p.desc) box.appendChild(h('div', 'eg-desc', p.desc));
    };

    /** Vorschau des markierten Senders (startet erst, wenn man kurz verweilt) */
    EpgGridScreen.prototype.schedulePreview = function () {
        var self = this, ch = this.list[this.chIndex];
        if (!ch) return;
        this.previewLabel.textContent = ch.num + ' · ' + ch.name;
        if (this.previewId === ch.id) return;
        clearTimeout(this.previewTimer);
        // Kommt man aus dem Vollbild zurück, läuft der Sender schon: sofort verkleinern statt warten
        if (Player.url && Player.url === Api.liveUrl(ch.id)) {
            this.previewId = ch.id;
            Player.on({ ready: function () { Player.applyPreferences(); } });
            Player.keep(Player.url, stageRect(this.previewBox));
            return;
        }
        this.previewTimer = setTimeout(function () {
            if (Nav.top() !== self || Modal.node) return;
            self.previewId = ch.id;
            Player.on({ ready: function () { Player.applyPreferences(); } });
            var url = Api.liveUrl(ch.id), rect = stageRect(self.previewBox);
            if (!Player.keep(url, rect)) Player.open(url, rect);
        }, 900);
    };

    EpgGridScreen.prototype.moveTime = function (delta) {
        var earliest = floorHalfHour(Date.now()) - HALF_HOUR;
        this.cursor = Math.max(earliest, this.cursor + delta);
        this.fitWindow();
    };

    /** Zeitfenster so verschieben, dass der Cursor sichtbar ist */
    EpgGridScreen.prototype.fitWindow = function () {
        var earliest = floorHalfHour(Date.now()) - HALF_HOUR;
        while (this.cursor >= this.winStart + this.SPAN - 15 * 60 * 1000) this.winStart += HALF_HOUR;
        while (this.cursor < this.winStart && this.winStart > earliest) this.winStart -= HALF_HOUR;
        if (this.winStart < earliest) this.winStart = earliest;
    };

    EpgGridScreen.prototype.onKey = function (k) {
        var p = this.focusedProgram(), ch = this.list[this.chIndex];
        if (!ch) return false;
        var earliest = floorHalfHour(Date.now()) - HALF_HOUR;
        switch (k) {
            case KEY.UP: this.chIndex = Math.max(0, this.chIndex - 1); break;
            case KEY.DOWN: this.chIndex = Math.min(this.list.length - 1, this.chIndex + 1); break;
            case KEY.CH_UP: this.chIndex = Math.max(0, this.chIndex - this.ROWS); break;
            case KEY.CH_DOWN: this.chIndex = Math.min(this.list.length - 1, this.chIndex + this.ROWS); break;
            case KEY.RIGHT:
                if (this.col === 'chan') { this.col = 'prog'; break; }
                this.cursor = p.placeholder ? this.cursor + HALF_HOUR : p.end + 1000;
                this.fitWindow();
                break;
            case KEY.LEFT:
                if (this.col === 'chan') return true;
                var target = p.placeholder ? this.cursor - HALF_HOUR : p.start - 1000;
                if (target < Math.max(earliest, this.winStart) && this.winStart <= earliest) { this.col = 'chan'; break; }
                if (p.placeholder && this.cursor - HALF_HOUR < earliest) { this.col = 'chan'; break; }
                this.cursor = Math.max(earliest, target);
                this.fitWindow();
                break;
            case KEY.RED: this.moveTime(-2 * 3600 * 1000); break;
            case KEY.GREEN: this.moveTime(2 * 3600 * 1000); break;
            case KEY.BLUE: this.cursor = Date.now(); this.winStart = floorHalfHour(Date.now()); break;
            case KEY.YELLOW:
                var on = Favs.toggle('live', ch.id);
                toast(on ? ch.name + ' zu Favoriten hinzugefügt' : ch.name + ' aus Favoriten entfernt');
                break;
            case KEY.ENTER: this.choose(ch, p); return true;
            default: return false;
        }
        this.draw();
        return true;
    };

    /** Mausrad / Wischen: senkrecht = Sender, waagerecht = Zeit */
    EpgGridScreen.prototype.onWheel = function (dx, dy) {
        if (!this.list.length) return;
        this.wheelY = (this.wheelY || 0) + dy;
        this.wheelX = (this.wheelX || 0) + dx;
        var moved = false;
        while (Math.abs(this.wheelY) >= 110) {
            var step = this.wheelY > 0 ? 1 : -1;
            this.wheelY -= step * 110;
            var next = Math.max(0, Math.min(this.list.length - 1, this.chIndex + step));
            if (next !== this.chIndex) { this.chIndex = next; moved = true; }
        }
        while (Math.abs(this.wheelX) >= 200) {
            var dir = this.wheelX > 0 ? 1 : -1;
            this.wheelX -= dir * 200;
            this.moveTime(dir * HALF_HOUR);
            moved = true;
        }
        if (moved) this.draw();
    };

    EpgGridScreen.prototype.choose = function (ch, p) {
        var self = this;
        if (this.col === 'chan') { this.chooseCategory(); return; }
        var now = Date.now();
        if (!p.placeholder && p.end <= now) { toast('Diese Sendung ist schon vorbei.'); return; }
        var running = p.placeholder || (p.start <= now && p.end > now);
        var watch = function () {
            Player.on({});
            var keepIt = self.previewId === ch.id;    // Vorschau zeigt schon diesen Sender: nur groß machen
            if (!keepIt) Player.stop();
            self.handoff = keepIt;
            self.previewId = null;
            var screen = new PlayerScreen(self.list, self.chIndex, 'live');
            screen.handoff = keepIt;
            Nav.push(screen);
        };
        if (!Rec.available() || p.placeholder) { if (running) watch(); else toast('Diese Sendung beginnt erst um ' + fmtClock(new Date(p.start)) + '.'); return; }

        var mark = this.marks[ch.id + ':' + p.start];
        var when = dateText(p.start) + ' – ' + fmtClock(new Date(p.end)) + ' · ' + ch.name;
        var buttons = [];
        if (running) buttons.push({ label: 'Ansehen', primary: true, action: watch });
        if (mark) {
            buttons.push({ label: mark.status === 'recording' ? 'Aufnahme stoppen' : 'Aufnahme löschen', primary: !running, action: function () {
                AB.recCancel(mark.id);
                toast(mark.status === 'recording' ? 'Aufnahme gestoppt' : 'Geplante Aufnahme gelöscht');
                self.marks = Rec.marks(); self.draw();
            } });
        } else {
            buttons.push({ label: running ? 'Bis zum Ende aufnehmen' : 'Aufnahme planen', primary: !running, action: function () {
                // 2 Minuten Puffer vorher, 5 Minuten nachher
                var res = Rec.schedule(ch, p.title, p.start - 2 * 60000, p.end + 5 * 60000, p.start, p.end);
                if (res === true) toast(running ? 'Aufnahme läuft: ' + p.title : 'Aufnahme geplant: ' + p.title + ' (' + dateText(p.start) + ')', 4500);
                else toast(res, 6000);
                self.marks = Rec.marks(); self.draw();
            } });
        }
        buttons.push({ label: 'Abbrechen' });
        Modal.open(p.title, when, buttons);
    };

    EpgGridScreen.prototype.chooseCategory = function () {
        var self = this, cats = this.categories();
        // Viele Kategorien: als Liste mit bis zu 12 Einträgen ab der aktuellen
        var start = Math.max(0, Math.min(this.catIndex - 2, cats.length - 12));
        var buttons = cats.slice(start, start + 12).map(function (name, i) {
            var prot = Parental.catProtected('live', name);
            return { label: (prot ? '[PIN] ' : '') + name, primary: start + i === self.catIndex, action: function () {
                function go() { self.catIndex = start + i; self.chIndex = 0; self.rowTop = 0; self.col = 'prog'; Nav.show(self); }
                if (Parental.catLocked('live', name)) Parental.ask('PIN für „' + name + '“', go); else go();
            } };
        });
        if (start + 12 < cats.length) buttons.push({ label: 'Weitere …', action: function () { self.catIndex = Math.min(cats.length - 1, start + 12); self.chooseCategory(); } });
        Modal.open('Kategorie wählen', '', buttons);
        if (Modal.node) Modal.node.classList.add('modal-list');
    };

    // =====================================================================
    // Aufnahmen
    // =====================================================================

    function RecordingsScreen() { this.timer = null; }
    RecordingsScreen.prototype.render = function (root) {
        var self = this;
        root.appendChild(topbar('Aufnahmen', Rec.available() ? 'OK: Abspielen / Optionen · Aufnahmen planst du im EPG' : ''));
        var box = h('div', 'recs scroll');
        root.appendChild(box);
        if (!Rec.available()) {
            box.appendChild(h('div', 'empty-note', 'Aufnahmen gibt es nur in der Android-App (Handy, Android TV, Google TV, Fire TV).'));
            return;
        }
        var st = Rec.storage();
        if (st) box.appendChild(h('div', 'rec-storage', 'Freier Speicher: ' + Rec.sizeText(st.free) + ' von ' + Rec.sizeText(st.total) + (st.removable ? ' (USB/SD-Karte)' : '') +
            ' · etwa ' + Math.max(0, Math.floor(st.free / 2.5e9)) + ' Std. Aufnahme'));

        var list = Rec.list();
        var groups = [
            ['Läuft gerade', list.filter(function (r) { return r.status === 'recording'; })],
            ['Geplant', list.filter(function (r) { return r.status === 'scheduled'; }).sort(function (a, b) { return a.start - b.start; })],
            ['Fertig', list.filter(function (r) { return r.status === 'done'; }).sort(function (a, b) { return b.start - a.start; })],
            ['Nicht geklappt', list.filter(function (r) { return r.status === 'failed' || r.status === 'missed'; })]
        ];
        if (!list.length) {
            box.appendChild(h('div', 'empty-note', 'Noch keine Aufnahmen. Öffne das EPG, wähle eine Sendung und drücke OK → „Aufnahme planen“. Im Live-Player gibt es außerdem den Knopf „● Aufnehmen“.'));
        }
        groups.forEach(function (g) {
            if (!g[1].length) return;
            box.appendChild(h('div', 'search-section', g[0] + ' (' + g[1].length + ')'));
            g[1].forEach(function (r) {
                var row = h('div', 'rec-row ' + r.status);
                row.appendChild(h('div', 'rec-title', (r.status === 'recording' ? '● ' : '') + r.title));
                var info = r.channel + ' · ' + dateText(r.progStart || r.start) + ' – ' + fmtClock(new Date(r.progEnd || r.end));
                if (r.status === 'done' || r.status === 'recording') info += ' · ' + Rec.sizeText(r.size);
                if (r.status === 'failed') info += ' · ' + (r.error || 'Fehlgeschlagen');
                if (r.status === 'missed') info += ' · Gerät war zur Startzeit aus';
                row.appendChild(h('div', 'rec-info', info));
                focusable(row, 'rec-' + r.id, function () { self.options(r); }, 'reclist');
                box.appendChild(row);
            });
        });
        // Größe laufender Aufnahmen aktualisieren
        clearInterval(this.timer);
        if (groups[0][1].length) {
            this.timer = setInterval(function () {
                if (Nav.top() !== self || Modal.node) return;
                self.focusKey = Focus.cur ? Focus.cur.getAttribute('data-key') : self.focusKey;
                Nav.show(self);
            }, 10000);
        }
        if (!this.focusKey) { var f = $('.rec-row'); if (f) this.focusKey = f.getAttribute('data-key'); }
    };
    RecordingsScreen.prototype.hide = function () { clearInterval(this.timer); };
    RecordingsScreen.prototype.options = function (r) {
        var self = this;
        function refresh() { self.focusKey = null; Nav.show(self); }
        if (r.status === 'done') {
            Modal.open(r.title, r.channel + ' · ' + dateText(r.progStart || r.start) + ' · ' + Rec.sizeText(r.size), [
                { label: '▶ Abspielen', primary: true, action: function () {
                    var url = AB.recFileUrl(r.id);
                    if (!url) { toast('Die Datei wurde nicht gefunden.'); return; }
                    Nav.push(new PlayerScreen([{ id: r.id, type: 'recording', name: r.title, url: url }], 0, 'movie'));
                } },
                { label: 'Löschen', action: function () { AB.recDelete(r.id); toast('Aufnahme gelöscht'); refresh(); } },
                { label: 'Abbrechen' }
            ]);
        } else if (r.status === 'scheduled') {
            Modal.open(r.title, 'Geplant: ' + dateText(r.start) + ' · ' + r.channel, [
                { label: 'Aufnahme absagen', primary: true, action: function () { AB.recCancel(r.id); toast('Geplante Aufnahme gelöscht'); refresh(); } },
                { label: 'Abbrechen' }
            ]);
        } else if (r.status === 'recording') {
            Modal.open(r.title, 'Läuft bis ' + fmtClock(new Date(r.end)) + ' · bisher ' + Rec.sizeText(r.size), [
                { label: 'Aufnahme stoppen', primary: true, action: function () { AB.recCancel(r.id); toast('Aufnahme wird gestoppt'); setTimeout(refresh, 1500); } },
                { label: 'Abbrechen' }
            ]);
        } else {
            Modal.open(r.title, r.error || 'Diese Aufnahme hat nicht geklappt.', [
                { label: 'Entfernen', primary: true, action: function () { AB.recDelete(r.id); refresh(); } },
                { label: 'Abbrechen' }
            ]);
        }
    };

    // =====================================================================
    // Suche: Sender, Filme und Serien
    // =====================================================================

    function SearchScreen() { this.query = ''; this.timer = null; }
    SearchScreen.prototype.render = function (root) {
        var self = this;
        root.appendChild(topbar('Suche', 'Tippen mit Pfeiltasten und OK · ▶ zu den Ergebnissen'));
        var wrap = h('div', 'search-wrap');
        var input = h('input', 'input search-input');
        input.type = 'text';
        input.placeholder = 'Sender, Film oder Serie suchen …';
        input.value = this.query;
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('autocapitalize', 'none');
        focusable(input, 'search-input', null, 'searchbox');
        input._onFocus = function () { if (self.results) self.results.scrollTop = 0; };
        wrap.appendChild(input);
        wrap.appendChild(Keyboard.build(input, 'kb'));
        this.status = h('div', 'search-status');
        wrap.appendChild(this.status);
        root.appendChild(wrap);

        this.results = h('div', 'search-results scroll');
        root.appendChild(this.results);

        function update() {
            clearTimeout(self.timer);
            self.timer = setTimeout(function () {
                if (self.query === input.value.trim()) return;
                self.query = input.value.trim();
                self.renderResults();
            }, 350);
        }
        input._onType = update;
        input.addEventListener('input', update);
        input.addEventListener('change', update);

        // Filme und Serien im Hintergrund laden, damit die Suche alles findet
        var waiting = [];
        if (!Data.moviesLoaded) waiting.push(Data.loadMovies());
        if (!Data.seriesLoaded) waiting.push(Data.loadSeries());
        if (waiting.length) {
            this.status.textContent = 'Filme und Serien werden geladen …';
            Promise.all(waiting).then(null, function () { /* trotzdem suchen */ }).then(function () {
                if (Nav.top() !== self) return;
                self.status.textContent = '';
                self.renderResults();
            });
        }
        this.renderResults();
        if (!this.focusKey) this.focusKey = 'kb-1-0';
    };
    SearchScreen.prototype.renderResults = function () {
        var self = this, box = this.results, q = this.query.toLowerCase();
        box.innerHTML = '';
        if (q.length < 2) {
            box.appendChild(h('div', 'empty-note', 'Gib mindestens 2 Buchstaben ein. Gesucht wird in Live TV, Filmen und Serien.'));
            return;
        }
        var match = searchMatcher(q);
        var live = Parental.visible('live', Data.channels).filter(match).slice(0, 40);
        var movies = Parental.visible('movie', Data.movies).filter(match).slice(0, 40);
        var series = Parental.visible('series', Data.series).filter(match).slice(0, 40);
        if (!live.length && !movies.length && !series.length) {
            box.appendChild(h('div', 'empty-note', 'Nichts gefunden für „' + this.query + '“.'));
            return;
        }
        function section(title, items, type) {
            if (!items.length) return;
            box.appendChild(h('div', 'search-section', title + ' (' + items.length + ')'));
            var grid = h('div', 'grid');
            items.forEach(function (item, i) {
                var node = posterNode(item, 'sr-' + type + '-', Favs.has(type, item.id), function () {
                    if (type === 'live') Nav.push(new PlayerScreen(live, i, 'live'));
                    else if (type === 'movie') Nav.push(new MovieDetailScreen(item));
                    else Nav.push(new SeriesDetailScreen(item));
                });
                node.setAttribute('data-zone', 'sgrid');
                grid.appendChild(node);
            });
            box.appendChild(grid);
        }
        section('Live-TV', live, 'live');
        section('Filme', movies, 'movie');
        section('Serien', series, 'series');
        void self;
    };
    SearchScreen.prototype.hide = function () { clearTimeout(this.timer); };

    // =====================================================================
    // Einstellungen
    // =====================================================================

    function SettingsScreen() { }
    SettingsScreen.prototype.render = function (root) {
        root.appendChild(topbar('Einstellungen', ''));
        var box = h('div', 'settings vscroll');
        function row(key, label, value, action) {
            var r = h('div', 'set-row');
            r.appendChild(h('div', 'set-label', label));
            var v = h('div', 'set-value', value || '');
            r.appendChild(v);
            focusable(r, 'set-' + key, function () { action(v); }, 'setlist');
            box.appendChild(r);
            return r;
        }
        row('reload', 'Alles neu laden', 'Sender, Filme und Serien neu vom Anbieter holen', function () { reloadAll(); });
        row('format', 'Live-Format', Settings.liveExt.toUpperCase(), function (v) {
            Settings.setLiveExt(Settings.liveExt === 'ts' ? 'm3u8' : 'ts');
            v.textContent = Settings.liveExt.toUpperCase();
            toast(Settings.liveExt === 'ts' ? 'Live-Sender laufen jetzt als TS (meist am stabilsten)' : 'Live-Sender laufen jetzt als HLS (M3U8)');
        });
        if (VodPlayer.available()) {
            var self = this;
            row('vodplayer', 'Player für Filme & Serien', VodPlayer.nameOf(VodPlayer.pref()), function () {
                VodPlayer.pick(function () { self.focusKey = 'set-vodplayer'; Nav.show(self); });
            });
        }
        row('autonext', 'Serien: nächste Folge automatisch', Settings.autoNext ? 'An · Countdown 10 s vor Folgenende' : 'Aus', function (v) {
            Settings.setFlag('autoNext', !Settings.autoNext);
            v.textContent = Settings.autoNext ? 'An · Countdown 10 s vor Folgenende' : 'Aus';
        });
        row('intro', 'Serien: „Intro überspringen“', Settings.introBtn ? 'An · springt ' + Settings.introSec + ' s weiter' : 'Aus', function (v) {
            Settings.setFlag('introBtn', !Settings.introBtn);
            v.textContent = Settings.introBtn ? 'An · springt ' + Settings.introSec + ' s weiter' : 'Aus';
        });
        var me = this;
        row('parental', 'Kindersicherung', Parental.enabled() ? 'An · PIN gesetzt' : 'Aus', function () {
            if (!Parental.enabled()) {
                newPinFlow(function () { me.focusKey = 'set-parental'; Nav.push(new ParentalScreen()); });
            } else {
                Parental.ask('PIN eingeben', function () { Nav.push(new ParentalScreen()); }, true);
            }
        });
        if (Updater.available()) {
            row('update', 'App-Version ' + Updater.versionText(Updater.current()), 'Nach Updates suchen', function () { Updater.check(true); });
        }
        row('lists', 'Wiedergabelisten', 'Liste wechseln oder neue hinzufügen', function () { Nav.push(new PlaylistsScreen()); });
        row('account', 'Konto', License.activated() ? 'Aktiviert (unbegrenzt)' : (License.free() ? License.freeText() : License.text()), function () { Nav.push(new AccountScreen()); });
        row('device', 'Gerät', 'MAC ' + Device.macText() + '  ·  Schlüssel ' + Device.key, function () { Nav.push(new PlaylistsScreen()); });
        box.appendChild(h('div', 'set-note', 'Bleibt ein Sender schwarz oder hängt, stelle das Live-Format um.'));
        root.appendChild(box);
        if (!this.focusKey) this.focusKey = 'set-reload';
    };

    // =====================================================================
    // Kindersicherung: Einstellungen
    // =====================================================================

    function ParentalScreen() { }
    ParentalScreen.prototype.render = function (root) {
        var self = this;
        root.appendChild(topbar('Kindersicherung', 'Geschützte Kategorien brauchen die PIN'));
        var box = h('div', 'settings vscroll');
        function row(key, label, value, action) {
            var r = h('div', 'set-row');
            r.appendChild(h('div', 'set-label', label));
            r.appendChild(h('div', 'set-value', value || ''));
            focusable(r, 'par-' + key, function () { self.focusKey = 'par-' + key; action(); }, 'setlist');
            box.appendChild(r);
        }
        row('adult', 'Erwachsenen-Kategorien automatisch sperren', Parental.autoAdult() ? 'An' : 'Aus', function () {
            Storage.set('parentalAdult', !Parental.autoAdult());
            Nav.show(self);
        });
        var counts = { live: 0, movie: 0, series: 0 };
        Parental.cats().forEach(function (k) { var t = k.split(':')[0]; if (counts[t] !== undefined) counts[t]++; });
        row('live', 'Live-TV-Kategorien sperren', counts.live + ' ausgewählt', function () { Nav.push(new ParentalCatsScreen('live')); });
        row('movie', 'Film-Kategorien sperren', counts.movie + ' ausgewählt', function () { Nav.push(new ParentalCatsScreen('movie')); });
        row('series', 'Serien-Kategorien sperren', counts.series + ' ausgewählt', function () { Nav.push(new ParentalCatsScreen('series')); });
        row('change', 'PIN ändern', '', function () { newPinFlow(function () { Nav.show(self); }); });
        row('off', 'Kindersicherung ausschalten', '', function () {
            Modal.open('Kindersicherung ausschalten?', 'Danach sind alle Kategorien ohne PIN zu sehen.', [
                { label: 'Ausschalten', primary: true, action: function () { Parental.clear(); toast('Kindersicherung ist aus.'); Nav.back(); } },
                { label: 'Abbrechen' }
            ]);
        });
        box.appendChild(h('div', 'set-note', 'Automatisch gesperrt werden Kategorien mit Namen wie „XXX“, „Adult“, „18+“ oder „Erotik“. ' +
            'Nach der PIN bleibt alles eine Stunde offen oder bis die App geschlossen wird. ' +
            'PIN vergessen? Dein Anbieter kann sie für die MAC-Adresse ' + Device.macText() + ' zurücksetzen.'));
        root.appendChild(box);
        if (!this.focusKey) this.focusKey = 'par-adult';
    };

    /** Kategorien zum Sperren an- und abhaken */
    function ParentalCatsScreen(kind) { this.kind = kind; }
    ParentalCatsScreen.prototype.render = function (root) {
        var self = this, kind = this.kind;
        var title = kind === 'live' ? 'Live-TV-Kategorien sperren' : kind === 'movie' ? 'Film-Kategorien sperren' : 'Serien-Kategorien sperren';
        root.appendChild(topbar(title, 'OK: sperren / freigeben'));
        var list = kind === 'live' ? Data.channels : kind === 'movie' ? Data.movies : Data.series;
        var loaded = kind === 'live' || (kind === 'movie' ? Data.moviesLoaded : Data.seriesLoaded);
        if (!loaded) {
            loader(true, (kind === 'movie' ? 'Filme' : 'Serien') + ' werden geladen …');
            (kind === 'movie' ? Data.loadMovies() : Data.loadSeries()).then(function () {
                loader(false);
                if (Nav.top() === self) Nav.show(self);
            }, function (e) { loader(false); toast(e.message || String(e), 6000); });
            return;
        }
        var seen = {}, cats = [];
        list.forEach(function (it) { if (it.cat && !seen[it.cat]) { seen[it.cat] = true; cats.push(it.cat); } });
        var col = h('div', 'col col-list par-cats');
        var scroll = h('div', 'scroll');
        col.appendChild(scroll);
        root.appendChild(col);
        if (!cats.length) scroll.appendChild(h('div', 'empty-note', 'Keine Kategorien gefunden.'));
        batchRender(scroll, cats, function (cat, i) {
            var r = h('div', 'row par-row');
            var mark = h('div', 'par-mark');
            function draw() {
                var own = Parental.cats().indexOf(kind + ':' + cat) >= 0;
                var auto = Parental.autoAdult() && Parental.ADULT.test(cat);
                mark.innerHTML = (own || auto) ? icon('lock', 30) : '';
                r.classList.toggle('on', own || auto);
                note.textContent = auto && !own ? 'automatisch' : '';
            }
            r.appendChild(mark);
            r.appendChild(h('div', 'name', cat));
            var note = h('div', 'par-note', '');
            r.appendChild(note);
            draw();
            return focusable(r, 'pc-' + i, function () {
                if (Parental.autoAdult() && Parental.ADULT.test(cat) && Parental.cats().indexOf(kind + ':' + cat) < 0) {
                    toast('„' + cat + '“ ist automatisch gesperrt. Das lässt sich unter „Erwachsenen-Kategorien automatisch sperren“ abschalten.', 5000);
                    return;
                }
                var on = Parental.toggleCat(kind, cat);
                draw();
                toast(on ? '„' + cat + '“ ist jetzt gesperrt' : '„' + cat + '“ ist wieder frei');
            }, 'list');
        }, 80);
        if (!this.focusKey) this.focusKey = 'pc-0';
    };

    // =====================================================================
    // Vollbild-Player
    // =====================================================================

    function PlayerScreen(items, index, kind, startAt) {
        this.items = items;
        this.index = index;
        this.kind = kind;          // 'live', 'movie' oder 'episode'
        this.startAt = startAt;    // Sekunden; undefined = gespeicherten Stand nehmen
        this.lastSave = 0;
        this.overlay = false;
        this.hideTimer = null;
        this.retries = 0;
        this.lastTime = -1;
        this.lastProgress = Date.now();
        this.watchdog = null;
    }
    PlayerScreen.prototype.item = function () { return this.items[this.index]; };
    PlayerScreen.prototype.url = function () {
        var it = this.item();
        if (it.url) return it.url;          // z. B. eigene Aufnahme
        if (this.kind === 'live') return Api.liveUrl(it.id);
        if (this.kind === 'movie') return Api.movieUrl(it.id, it.ext);
        return Api.episodeUrl(it.id, it.ext);
    };
    PlayerScreen.prototype.render = function () {
        document.body.classList.add('video-mode');
        this.ui = $('#player-ui');
        this.ui.classList.remove('hidden');
        this.start();
        this.showOverlay();
        var self = this;
        clearInterval(this.watchdog);
        this.watchdog = setInterval(function () { self.checkStall(); }, 2000);
    };
    /** Filme und Folgen merken sich den Stand (Aufnahmen und Live nicht) */
    PlayerScreen.prototype.resumable = function () {
        var it = this.item();
        return (this.kind === 'movie' || this.kind === 'episode') && it && it.type !== 'recording' && !it.url;
    };
    /** Stand speichern. Fast zu Ende geschaut: Eintrag entfernen bzw. nächste Folge vormerken. */
    PlayerScreen.prototype.saveProgress = function (ended) {
        if (!this.resumable() || this.seekPending) return;
        var it = this.item(), pos = Player.current(), dur = Player.duration();
        if (!ended && !(dur > 60)) return;            // Länge noch unbekannt
        this.lastSave = Date.now();
        void it;
        Resume.record(this.kind, this.items, this.index, pos, dur, ended);
    };
    PlayerScreen.prototype.start = function () {
        var self = this;
        this.lastTime = -1;
        this.lastProgress = Date.now();
        $('#subtitle').classList.add('hidden');
        // Startpunkt: beim ersten Mal der übergebene Wert, sonst gespeicherter Stand der Folge
        var at = 0;
        if (this.resumable()) {
            if (this.startAt !== undefined && this.startAt !== null) at = this.startAt;
            else { var e = Resume.forItem(this.kind, this.item()); if (e && !e.next && e.pos >= 30) at = e.pos; }
        }
        this.startAt = undefined;
        this.seekPending = at > 5 ? at : 0;
        if (this.popFor !== this.index) { this.popFor = this.index; this.introDone = false; this.nextCancelled = false; }
        this.showPop(null);
        Player.on({
            buffer: function (b) { self.buffering = b; },
            time: function (t) {
                if (Math.abs(t - self.lastTime) > 0.2) { self.lastTime = t; self.lastProgress = Date.now(); }
                if (self.overlay) self.updateBar();
                if (self.seekPending && t >= self.seekPending - 15) self.seekPending = 0;   // Sprung ist angekommen
                if (Date.now() - self.lastSave > 10000) self.saveProgress(false);
                self.extras(t);
            },
            ready: function () {
                Player.applyPreferences();
                if (self.seekPending) {
                    var target = self.seekPending;
                    Player.seekTo(target);
                    toast('Weiter ab ' + fmtTime(target));
                    // Falls der Sprung nicht klappt, nach 8 s trotzdem wieder speichern
                    setTimeout(function () { self.seekPending = 0; }, 8000);
                }
            },
            end: function () { self.saveProgress(true); self.onEnd(); },
            error: function (msg) { self.onError(msg); },
            subtitle: function (text, ms) { self.showSubtitle(text, ms); }
        });
        var reuse = this.handoff && this.kind === 'live';
        this.handoff = false;
        if (reuse && Player.keep(this.url(), null)) {
            self.buffering = false;                    // Bild läuft schon: nur auf Vollbild vergrößert
        } else {
            Player.open(this.url(), null);
        }
        this.nowTitle = '';
        if (this.kind === 'live') {
            var it = this.item();
            Data.shortEpg(it.id).then(function (list) {
                if (self.item() === it && list.length) { self.nowTitle = list[0].title; self.nowEnd = list[0].end; if (self.overlay) self.renderOverlay(); }
            });
        }
    };
    PlayerScreen.prototype.checkStall = function () {
        // Hängt das Bild länger als 15 Sekunden, Sender neu laden (max. 2 Mal)
        if (Nav.top() !== this || !Player.isPlaying()) { this.lastProgress = Date.now(); return; }
        if (Date.now() - this.lastProgress > 15000 && this.retries < 2) {
            this.retries++;
            toast('Sender hängt – wird neu geladen …');
            this.start();
        }
    };
    PlayerScreen.prototype.onEnd = function () {
        this.showPop(null);
        if (this.kind === 'episode' && this.index < this.items.length - 1 && Settings.autoNext && !this.nextCancelled) {
            this.goNext();
        } else if (this.kind !== 'live') {
            Nav.back();
        }
    };
    PlayerScreen.prototype.goNext = function () {
        if (this.index >= this.items.length - 1) return;
        this.saveProgress(true);
        this.showPop(null);
        this.index++;
        toast('Nächste Folge: ' + this.item().name);
        this.start();
        this.showOverlay();
    };

    // ---------- Einblendungen bei Serien: „Intro überspringen“ und „Nächste Folge in … s“ ----------
    PlayerScreen.prototype.extras = function (t) {
        if (this.kind !== 'episode' || !this.resumable() || this.seekPending) return;
        var dur = Player.duration(), left = dur - t;
        var hasNext = this.index < this.items.length - 1;
        var next = hasNext && Settings.autoNext && !this.nextCancelled && dur > 300 && left <= 30 && left > 1;
        var intro = Settings.introBtn && !this.introDone && t >= 2 && t < 10;   // nur 8 Sekunden lang
        this.showPop(next ? 'next' : intro ? 'intro' : null);
    };
    PlayerScreen.prototype.showPop = function (kind) {
        var self = this;
        if (this.pop === kind) return;
        this.pop = kind;
        clearInterval(this.popTimer);
        var box = $('#player-pop');
        if (!box) {
            box = h('div', 'hidden');
            box.id = 'player-pop';
            var ui = $('#player-ui');
            ui.parentNode.insertBefore(box, ui.nextSibling);
        }
        var hadFocus = Focus.cur && box.contains(Focus.cur);
        box.innerHTML = '';
        if (!kind) {
            box.classList.add('hidden');
            if (hadFocus) { Focus.cur = null; if (this.overlay) this.renderOverlay(); }
            return;
        }
        box.classList.remove('hidden');
        function button(key, label, primary, action) {
            var b = h('div', 'pp-btn' + (primary ? ' primary' : ''), label);
            focusable(b, key, action, 'pop');
            box.appendChild(b);
            return b;
        }
        if (kind === 'intro') {
            button('pp-intro', '⏭  Intro überspringen', true, function () { self.skipIntro(); });
            box.appendChild(h('div', 'pp-hint', 'OK drücken'));
            return;
        }
        var n = this.items[this.index + 1];
        var count = 10;
        var title = h('div', 'pp-title', 'Nächste Folge in ' + count + ' s');
        box.appendChild(title);
        box.appendChild(h('div', 'pp-sub', 'S' + n.season + ' F' + (n.num || this.index + 2) + ' · ' + n.name));
        var bar = h('div', 'pp-bar'), fill = h('div', 'bar');
        bar.appendChild(fill);
        box.appendChild(bar);
        button('pp-next', '▶  Jetzt ansehen', true, function () { self.goNext(); });
        button('pp-cancel', 'Abbrechen', false, function () { self.cancelNext(); });
        box.appendChild(h('div', 'pp-hint', 'OK: Jetzt ansehen · Zurück: Abbrechen'));
        this.popTimer = setInterval(function () {
            if (Nav.top() !== self) { clearInterval(self.popTimer); return; }
            if (!Player.isPlaying()) return;           // Pause hält den Countdown an
            count--;
            title.textContent = 'Nächste Folge in ' + Math.max(0, count) + ' s';
            fill.style.width = ((10 - count) * 10) + '%';
            if (count <= 0) self.goNext();
        }, 1000);
    };
    PlayerScreen.prototype.skipIntro = function () {
        this.introDone = true;
        this.showPop(null);
        Player.seekBy(Settings.introSec);
        toast('Intro übersprungen (+' + Settings.introSec + ' s)');
    };
    PlayerScreen.prototype.cancelNext = function () {
        this.nextCancelled = true;
        this.showPop(null);
        toast('Automatische Wiedergabe abgebrochen');
    };
    PlayerScreen.prototype.onError = function (msg) {
        if (this.kind === 'live' && this.retries < 1) {
            this.retries++;
            this.start();
            return;
        }
        toast('Wiedergabe fehlgeschlagen' + (msg ? ' (' + msg + ')' : '') + '. Versuche es erneut oder wähle etwas anderes.', 7000);
        this.showOverlay();
    };
    PlayerScreen.prototype.showSubtitle = function (text, ms) {
        var s = $('#subtitle');
        clearTimeout(this.subTimer);
        if (!text) { s.classList.add('hidden'); return; }
        s.innerHTML = '';
        String(text).replace(/<[^>]+>/g, '').split(/\n|\\N/).forEach(function (line, i) {
            if (i) s.appendChild(h('br'));
            s.appendChild(document.createTextNode(line));
        });
        s.classList.remove('hidden');
        this.subTimer = setTimeout(function () { s.classList.add('hidden'); }, ms > 0 ? ms : 4000);
    };
    PlayerScreen.prototype.renderOverlay = function () {
        var self = this, it = this.item(), ui = this.ui;
        var focusedKey = Focus.cur && ui.contains(Focus.cur) ? Focus.cur.getAttribute('data-key') : 'pl-play';
        ui.innerHTML = '';

        var top = h('div', 'pl-top');
        var title = h('div', 'pl-title');
        if (this.kind === 'live') {
            title.appendChild(h('span', 'live-badge', 'LIVE'));
            title.appendChild(document.createTextNode((it.num ? it.num + '  ' : '') + it.name));
        } else {
            title.textContent = it.name;
        }
        top.appendChild(title);
        if (this.kind === 'live') top.appendChild(h('div', 'pl-sub', this.nowTitle ? 'Jetzt: ' + this.nowTitle : ''));
        if (this.kind === 'episode') top.appendChild(h('div', 'pl-sub', 'Staffel ' + it.season + ' · Folge ' + (it.num || this.index + 1)));
        ui.appendChild(top);

        var bottom = h('div', 'pl-bottom');
        if (this.kind !== 'live') {
            var bar = h('div', 'pl-bar'); this.barFill = h('div', 'bar'); bar.appendChild(this.barFill);
            bottom.appendChild(bar);
            var times = h('div', 'pl-times');
            this.timeLeft = h('span', null, '0:00');
            this.timeRight = h('span', 'right', '');
            times.appendChild(this.timeLeft); times.appendChild(this.timeRight);
            bottom.appendChild(times);
        } else {
            bottom.appendChild(h('div', 'pl-times', 'Kanal ' + (this.index + 1) + ' / ' + this.items.length + '   ·   ▲▼ Kanal wechseln'));
        }

        var buttons = h('div', 'pl-buttons');
        function btn(key, label, action) {
            var b = h('div', 'pl-btn', label);
            focusable(b, key, function () { action(); self.showOverlay(); }, 'player');
            buttons.appendChild(b);
        }
        if (this.kind === 'live') {
            btn('pl-prev', '◀ Kanal', function () { self.step(-1); });
            btn('pl-play', Player.isPlaying() ? '❚❚ Pause' : '▶ Weiter', function () { Player.toggle(); self.renderOverlay(); });
            btn('pl-next', 'Kanal ▶', function () { self.step(1); });
        } else {
            btn('pl-rw', '« 10 s', function () { Player.seekBy(-10); });
            btn('pl-play', Player.isPlaying() ? '❚❚ Pause' : '▶ Weiter', function () { Player.toggle(); self.renderOverlay(); });
            btn('pl-ff', '10 s »', function () { Player.seekBy(10); });
            if (this.kind === 'episode' && this.index < this.items.length - 1) {
                btn('pl-nextep', 'Nächste Folge', function () { self.goNext(); });
            }
        }
        if (this.kind === 'live' && Rec.available()) {
            btn('pl-rec', '● Aufnehmen', function () { self.recordNow(); });
        }
        if (this.kind !== 'live' && this.resumable() && VodPlayer.available()) {
            btn('pl-switch', '⇄ Player', function () { self.switchPlayer(); });
        }
        btn('pl-aspect', '▭ Format', function () { self.aspectMenu(); });
        btn('pl-audio', '♪ Sprache', function () { self.trackMenu('audio'); });
        btn('pl-sub', 'CC Untertitel', function () { self.trackMenu('text'); });
        if (this.kind !== 'episode' && it.type !== 'recording') {
            var favType = this.kind === 'live' ? 'live' : 'movie';
            btn('pl-fav', Favs.has(favType, it.id) ? '★ Favorit' : '☆ Favorit', function () {
                var on = Favs.toggle(favType, it.id);
                toast(on ? 'Zu Favoriten hinzugefügt' : 'Aus Favoriten entfernt');
                self.renderOverlay();
            });
        }
        btn('pl-back', 'Zurück', function () { self.close(); });
        bottom.appendChild(buttons);
        ui.appendChild(bottom);

        var target = Focus.byKey(focusedKey) || Focus.byKey('pl-play');
        if (target) Focus.set(target);
        this.updateBar();
    };
    /** Bildformat wählen (gilt für Live TV, Filme und Serien) */
    PlayerScreen.prototype.aspectMenu = function () {
        var self = this, cur = Player.aspect();
        clearTimeout(this.hideTimer);
        var buttons = Player.ASPECTS.map(function (a) {
            return { label: (a.id === cur ? '✓  ' : '      ') + a.name, primary: a.id === cur, action: function () {
                Player.setAspect(a.id);
                toast('Bildformat: ' + a.name);
                self.showOverlay();
            } };
        });
        buttons.push({ label: 'Schließen', action: function () { self.showOverlay(); } });
        Modal.open('▭ Bildformat', 'Die Wahl gilt für alle Sender, Filme und Serien.', buttons);
        if (Modal.node) Modal.node.classList.add('modal-list');
        var sel = Modal.node && Modal.node.querySelector('.button.primary');
        if (sel) Focus.set(sel);
    };
    /** Auswahlliste für Sprache (audio) oder Untertitel (text) */
    PlayerScreen.prototype.trackMenu = function (kind) {
        var self = this, list = Player.trackList(kind), audio = kind === 'audio';
        clearTimeout(this.hideTimer);
        var buttons = [];
        if (!audio) {
            var anyOn = list.some(function (t) { return t.selected; });
            buttons.push({ label: (anyOn ? '      ' : '✓  ') + 'Aus', primary: !anyOn, action: function () {
                Player.selectTrack('text', -1, 'Aus'); toast('Untertitel: Aus'); self.showOverlay();
            } });
        }
        list.forEach(function (t) {
            buttons.push({ label: (t.selected ? '✓  ' : '      ') + t.name + (t.detail ? '  ·  ' + t.detail : ''), primary: t.selected, action: function () {
                var ok = Player.selectTrack(kind, t.id, t.name);
                toast(ok ? (audio ? 'Sprache: ' : 'Untertitel: ') + t.name : 'Diese Spur ließ sich nicht wählen');
                self.showOverlay();
            } });
        });
        var empty = audio ? 'Dieser Film hat nur eine Tonspur.' : 'Dieser Film hat keine Untertitel.';
        if (this.kind === 'live') empty = audio ? 'Dieser Sender hat nur eine Tonspur.' : 'Dieser Sender sendet keine Untertitel.';
        buttons.push({ label: 'Schließen', action: function () { self.showOverlay(); } });
        Modal.open(audio ? '♪ Sprache' : 'CC Untertitel', (audio ? list.length < 2 : !list.length) ? empty : 'Die Auswahl merkt sich die App für den nächsten Film.', buttons);
        if (Modal.node) Modal.node.classList.add('modal-list');
        // Fokus auf die gewählte Spur
        var sel = Modal.node && Modal.node.querySelector('.button.primary');
        if (sel) Focus.set(sel);
    };
    /** Mitten im Film zu VLC & Co. wechseln, an derselben Stelle */
    PlayerScreen.prototype.switchPlayer = function () {
        var self = this, list = VodPlayer.list();
        clearTimeout(this.hideTimer);
        if (!list.length) {
            toast('Kein anderer Player installiert. Installiere z. B. VLC oder MX Player aus dem Store.', 6000);
            this.showOverlay();
            return;
        }
        var buttons = list.map(function (pl) {
            return { label: '▶  ' + pl.name, primary: false, action: function () {
                var items = self.items, index = self.index, kind = self.kind, pos = Player.current();
                self.saveProgress(false);
                self.saved = true;
                Nav.back();
                VodPlayer.launch(pl.pkg, items, index, kind, pos);
            } };
        });
        if (buttons.length) buttons[0].primary = true;
        buttons.push({ label: 'Abbrechen', action: function () { self.showOverlay(); } });
        Modal.open('Weiterschauen mit …', 'Ab ' + fmtTime(Player.current()), buttons);
        if (Modal.node) Modal.node.classList.add('modal-list');
    };
    /** Sofort aufnehmen: bis Sendungsende oder für eine feste Zeit */
    PlayerScreen.prototype.recordNow = function () {
        var self = this, ch = this.item(), now = Date.now();
        clearTimeout(this.hideTimer);
        function go(end, title) {
            var res = Rec.schedule(ch, title, now, end, now, end);
            toast(res === true ? 'Aufnahme läuft bis ' + fmtClock(new Date(end)) + ': ' + title : res, 5000);
            self.showOverlay();
        }
        var buttons = [];
        if (this.nowEnd && this.nowEnd > now) {
            buttons.push({ label: 'Bis Sendungsende (' + fmtClock(new Date(this.nowEnd)) + ')', primary: true,
                action: function () { go(self.nowEnd + 5 * 60000, self.nowTitle || ch.name); } });
        }
        [30, 60, 120].forEach(function (min) {
            buttons.push({ label: min < 60 ? min + ' Min.' : (min / 60) + ' Std.', primary: !buttons.length,
                action: function () { go(now + min * 60000, (self.nowTitle || ch.name)); } });
        });
        buttons.push({ label: 'Abbrechen', action: function () { self.showOverlay(); } });
        Modal.open('Aufnehmen: ' + ch.name, this.nowTitle ? 'Jetzt: ' + this.nowTitle : '', buttons);
    };
    PlayerScreen.prototype.updateBar = function () {
        if (this.kind === 'live' || !this.barFill) return;
        var cur = Player.current(), dur = Player.duration();
        this.barFill.style.width = (dur > 0 ? Math.min(100, cur / dur * 100) : 0) + '%';
        this.timeLeft.textContent = fmtTime(cur);
        this.timeRight.textContent = dur > 0 ? '-' + fmtTime(dur - cur) : '';
    };
    PlayerScreen.prototype.showOverlay = function () {
        var self = this;
        this.overlay = true;
        this.ui.classList.remove('hidden');
        this.ui.classList.add('player-ui-visible');
        this.renderOverlay();
        clearTimeout(this.hideTimer);
        this.hideTimer = setTimeout(function () { self.hideOverlay(); }, 5000);
    };
    PlayerScreen.prototype.hideOverlay = function () {
        if (!Player.isPlaying() && Player.tizen) {      // Bei Pause stehen lassen
            var self = this;
            clearTimeout(this.hideTimer);
            this.hideTimer = setTimeout(function () { self.hideOverlay(); }, 5000);
            return;
        }
        this.overlay = false;
        this.ui.innerHTML = '';
        this.ui.classList.remove('player-ui-visible');
        Focus.cur = null;
    };
    PlayerScreen.prototype.step = function (delta) {
        if (this.items.length < 2) return;
        this.index = (this.index + delta + this.items.length) % this.items.length;
        this.retries = 0;
        this.start();
        this.showOverlay();
    };
    PlayerScreen.prototype.close = function () {
        Nav.back();
    };
    PlayerScreen.prototype.onKey = function (k) {
        var live = this.kind === 'live';
        if (k === KEY.CH_UP || (live && k === KEY.UP && !this.overlay)) { this.step(-1); return true; }
        if (k === KEY.CH_DOWN || (live && k === KEY.DOWN && !this.overlay)) { this.step(1); return true; }
        if (live && this.overlay && (k === KEY.UP || k === KEY.DOWN)) { this.step(k === KEY.UP ? -1 : 1); return true; }
        if (k === KEY.PLAY || k === KEY.PAUSE || k === KEY.PLAYPAUSE) { Player.toggle(); this.showOverlay(); return true; }
        if (k === KEY.FF) { Player.seekBy(30); this.showOverlay(); return true; }
        if (k === KEY.RW) { Player.seekBy(-30); this.showOverlay(); return true; }
        if (k === KEY.STOP) { this.close(); return true; }
        if (k === KEY.GREEN) { this.trackMenu('audio'); return true; }
        if (k === KEY.BLUE) { this.trackMenu('text'); return true; }

        if (!this.overlay && this.pop) {
            if (k === KEY.ENTER) { if (this.pop === 'intro') this.skipIntro(); else this.goNext(); return true; }
            if (this.pop === 'next' && (k === KEY.BACK || k === KEY.ESC || k === KEY.BACKSPACE)) { this.cancelNext(); return true; }
        }
        if (!this.overlay) {
            if (k === KEY.ENTER) { this.showOverlay(); return true; }
            if (!live && (k === KEY.LEFT || k === KEY.RIGHT)) { Player.seekBy(k === KEY.RIGHT ? 10 : -10); this.showOverlay(); return true; }
            if (k === KEY.LEFT || k === KEY.RIGHT || k === KEY.UP || k === KEY.DOWN) { this.showOverlay(); return true; }
            return false;   // Zurück-Taste → Nav.back()
        }

        // Steuerung sichtbar: Zurück blendet sie aus, alles andere startet den Timer neu
        if (k === KEY.BACK || k === KEY.ESC || k === KEY.BACKSPACE) { this.hideOverlay(); return true; }
        var self = this;
        clearTimeout(this.hideTimer);
        this.hideTimer = setTimeout(function () { self.hideOverlay(); }, 5000);
        return false;
    };
    PlayerScreen.prototype.hide = function () {
        this.saveProgress(false);
        this.showPop(null);
        this.popFor = null;
        clearTimeout(this.hideTimer);
        clearTimeout(this.subTimer);
        clearInterval(this.watchdog);
        // Zurück aus dem Live-Vollbild in die Senderliste/EPG: Sender weiterlaufen lassen, dort nur verkleinern
        var below = this._backTo;
        var ch = this.kind === 'live' ? this.item() : null;
        if (ch && below && (below instanceof LiveScreen || below instanceof EpgGridScreen)) {
            if (below instanceof LiveScreen) below.selected = ch;
            if (below instanceof EpgGridScreen) {
                for (var i = 0; i < below.list.length; i++) if (below.list[i].id === ch.id) { below.chIndex = i; break; }
            }
        } else {
            Player.stop();
        }
        Player.on({});
        this.ui.innerHTML = '';
        this.ui.classList.add('hidden');
        this.ui.classList.remove('player-ui-visible');
        $('#subtitle').classList.add('hidden');
        document.body.classList.remove('video-mode');
    };

    // =====================================================================
    // Tasten verteilen
    // =====================================================================

    var lastRepeatAt = 0;
    function onKeyDown(e) {
        var k = e.keyCode;
        if (k === 461) k = KEY.BACK;          // Zurück-Taste der LG-Fernbedienung
        // Pfeiltaste gedrückt halten: höchstens alle 90 ms einen Schritt, sonst stauen sich die Tasten und es ruckelt
        if (e.repeat && (k === KEY.UP || k === KEY.DOWN || k === KEY.LEFT || k === KEY.RIGHT)) {
            var t = Date.now();
            if (t - lastRepeatAt < 90) { if (e.preventDefault) e.preventDefault(); return; }
            lastRepeatAt = t;
        }
        var active = document.activeElement;

        // Eingabefeld mit Bildschirmtastatur
        if (active && active.tagName === 'INPUT') {
            if (k === KEY.ENTER || k === KEY.IME_DONE || k === KEY.IME_CANCEL || k === KEY.BACK || k === KEY.ESC) {
                active.blur();
                active.dispatchEvent(new Event('change'));
                e.preventDefault();
                return;
            }
            if (k === KEY.UP || k === KEY.DOWN) {
                active.blur();
                Focus.move(k === KEY.UP ? 'up' : 'down');
                e.preventDefault();
            }
            return;
        }

        if (!$('#loader').classList.contains('hidden')) {
            if (Sync.skip && (k === KEY.ENTER || k === KEY.BACK || k === KEY.ESC || k === KEY.BACKSPACE)) Sync.skip();
            e.preventDefault();
            return;
        }

        if (Modal.node) {
            if (Modal.pinInput && ((k >= 48 && k <= 57) || (k >= 96 && k <= 105))) {
                Modal.pinInput(String(k >= 96 ? k - 96 : k - 48));
                e.preventDefault();
                return;
            }
            if (k === KEY.BACK || k === KEY.ESC || k === KEY.BACKSPACE) { Modal.pinInput = null; Modal.close(); e.preventDefault(); return; }
            if (k === KEY.LEFT || k === KEY.UP) { Focus.move(k === KEY.LEFT ? 'left' : 'up'); e.preventDefault(); return; }
            if (k === KEY.RIGHT || k === KEY.DOWN) { Focus.move(k === KEY.RIGHT ? 'right' : 'down'); e.preventDefault(); return; }
            if (k === KEY.ENTER) { Focus.activate(); e.preventDefault(); return; }
            e.preventDefault();
            return;
        }

        // OK auf einem Sender/Film/Serie: kurz = öffnen, lang = Favorit
        if (k === KEY.ENTER && Focus.cur && Focus.cur._onLong && !(Nav.top() instanceof PlayerScreen)) {
            e.preventDefault();
            if (e.repeat) return;                       // Taste wird gehalten
            if (LongPress.upSeen) { LongPress.start(Focus.cur); return; }
        }

        var top = Nav.top();
        if (top && top.onKey && top.onKey(k, e)) { e.preventDefault(); return; }

        switch (k) {
            case KEY.LEFT: Focus.move('left'); break;
            case KEY.RIGHT: Focus.move('right'); break;
            case KEY.UP: Focus.move('up'); break;
            case KEY.DOWN: Focus.move('down'); break;
            case KEY.ENTER: Focus.activate(); break;
            case KEY.BACK: case KEY.ESC: case KEY.BACKSPACE: Nav.back(); break;
            default: return;
        }
        e.preventDefault();
    }

    // =====================================================================
    // Start
    // =====================================================================

    function boot() {
        applyScale();
        window.addEventListener('resize', applyScale);
        window.addEventListener('load', applyScale);
        window.addEventListener('orientationchange', function () { setTimeout(applyScale, 300); });
        // Zur Sicherheit kurz nach dem Start nochmal einpassen
        setTimeout(applyScale, 300);
        setTimeout(applyScale, 1200);
        registerKeys();
        Favs.load();
        Player.init();
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('keyup', function (e) { if (e.keyCode === KEY.ENTER) LongPress.up(); });

        // App in den Hintergrund: Video anhalten
        function lifecycle(hidden) {
            if (hidden) {
                Parental.lock();
                var top = Nav.top();
                if (top && (top instanceof PlayerScreen || top instanceof LiveScreen)) {
                    if (top instanceof PlayerScreen) top.saveProgress(false);   // beim Zurückkommen geht es dort weiter
                    try { Player.stop(); } catch (e) { /* egal */ }
                }
            } else {
                var cur = Nav.top();
                if (cur instanceof PlayerScreen) cur.start();
                else if (cur instanceof LiveScreen && cur.selected) cur.startPreview(cur.selected);
            }
        }
        document.addEventListener('visibilitychange', function () { if (!AB) lifecycle(document.hidden); });
        window.__androidLifecycle = function (state) { lifecycle(state === 'hidden'); };

        // Tasten, die die Android-App weiterreicht (Zurück, Medientasten, Farbtasten)
        window.__androidKey = function (code, repeat) {
            Nav.userAt = Date.now();
            onKeyDown({ keyCode: code, repeat: !!repeat, preventDefault: function () { } });
        };
        window.__androidKeyUp = function (code) { if (code === KEY.ENTER) LongPress.up(); };

        // Bedienung per Finger (Handy/Tablet): Listen dürfen wischen
        if ('ontouchstart' in window) document.body.classList.add('touch');
        // Android/Fire TV: sparsamere Effekte (schwache Grafikchips)
        if (AB) document.body.classList.add('lowfx');

        Device.load();
        var saved = Storage.get('account', null);
        var lastId = Storage.get('playlistId', null);

        // Schnellstart: mit der zuletzt genutzten Liste schon anmelden, während die Website noch antwortet
        var early = null;
        if (lastId !== null && saved && saved.server && saved.username && saved.password) {
            early = Data.login(saved, null);
            early.then(null, function () { /* wird unten normal behandelt */ });
        }
        function sameAcc(a, b) { return a && b && a.server === b.server && a.username === b.username && a.password === b.password && !!a.demo === !!b.demo; }

        function start(acc) {
            var pending = early && sameAcc(acc, saved) ? early : null;
            early = null;
            syncAll(acc, 'ImperumTV wird gestartet …', function () {
                Nav.replace(new HomeScreen());
                Updater.autoCheck();
            }, function (e) {
                Nav.replace(new PlaylistsScreen(e.message || String(e)));
            }, pending);
        }

        loader(true, 'Wiedergabelisten werden geladen …');
        Remote.load().then(function () {
            loader(false);
            var chosen = lastId !== null ? Remote.find(lastId) : null;
            if (!License.active() && !(chosen && chosen.demo)) { Nav.replace(new LockScreen()); return; }
            var acc = chosen ? playlistAccount(chosen) : null;
            if (acc) start(acc);
            else Nav.replace(new PlaylistsScreen(lastId !== null && !chosen && Remote.lists.length ? 'Die zuletzt genutzte Wiedergabeliste gibt es nicht mehr. Bitte wähle eine aus.' : ''));
        }, function (e) {
            loader(false);
            // Website nicht erreichbar: zuletzt bekannter Stand der Testphase gilt
            if (!License.active() && !(saved && saved.demo && lastId === 'demo')) { Nav.replace(new LockScreen()); return; }
            if (lastId !== null && saved && saved.server && saved.username && saved.password) start(saved);
            else Nav.replace(new PlaylistsScreen(e.message || String(e)));
        });

        // Läuft die Testphase während der Nutzung ab: alle 10 Minuten nachsehen
        setInterval(function () {
            if (Nav.top() instanceof LockScreen) return;
            Remote.load().then(null, function () { /* offline: gespeicherter Stand */ }).then(function () {
                if (Api.acc && Api.acc.demo) return;      // Demo braucht keine Freischaltung
                if (!License.active() && !(Nav.top() instanceof LockScreen)) Nav.replace(new LockScreen());
            });
        }, 600000);
    }

    /** Nach der Aktivierung: mit der zuletzt genutzten Liste weitermachen oder die Listen zeigen */
    function startWithLists() {
        var lastId = Storage.get('playlistId', null);
        var chosen = lastId !== null ? Remote.find(lastId) : null;
        var acc = chosen ? playlistAccount(chosen) : null;
        if (!acc) { Nav.replace(new PlaylistsScreen()); return; }
        syncAll(acc, 'Anmelden und alles laden …', function () {
            Nav.replace(new HomeScreen());
            Updater.autoCheck();
        }, function (e) {
            Nav.replace(new PlaylistsScreen(e.message || String(e)));
        });
    }

    // Nur für automatische Tests im Browser
    window.ImperumTV = { Parser: Parser, Sync: Sync, Resume: Resume, Parental: Parental, Updater: Updater,  Nav: Nav, Focus: Focus, Data: Data, Player: Player, KEY: KEY, Device: Device, Remote: Remote, License: License };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
