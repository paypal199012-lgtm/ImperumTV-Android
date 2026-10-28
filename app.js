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

    function loader(show, text) {
        $('#loader-text').textContent = text || 'Lädt …';
        $('#loader').classList.toggle('hidden', !show);
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
        back: '<path d="M19 12H5M11 6l-6 6 6 6"/>'
    };
    function icon(name, size) {
        return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" ' +
            'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
    }

    // =====================================================================
    // Bildschirmgröße: Oberfläche ist für 1920 x 1080 gebaut und wird skaliert
    // =====================================================================

    var scale = 1, offX = 0, offY = 0;
    function applyScale() {
        var w = window.innerWidth || 1920, hh = window.innerHeight || 1080;
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

    function exitApp() {
        Player.stop();
        if (AB) { AB.exit(); return; }
        try { tizen.application.getCurrentApplication().exit(); } catch (e) { toast('App beenden geht nur auf dem Fernseher.'); }
    }

    // =====================================================================
    // Fokus-Steuerung mit den Pfeiltasten
    // =====================================================================

    function ensureVisible(node) {
        var p = node.parentElement;
        while (p && !(p.classList && p.classList.contains('scroll'))) p = p.parentElement;
        if (!p) return;
        var nr = node.getBoundingClientRect(), pr = p.getBoundingClientRect();
        var margin = 30 * scale;
        if (nr.top < pr.top + margin) p.scrollTop -= (pr.top + margin - nr.top) / scale;
        else if (nr.bottom > pr.bottom - margin) p.scrollTop += (nr.bottom - pr.bottom + margin) / scale;
    }

    var VERTICAL_LOCK = { cats: true, list: true, grid: true };
    var HORIZONTAL_LOCK = { seasons: true, buttons: true, player: true, tiles: true, circles: true, acc: true };

    var Focus = {
        cur: null,
        memory: {},

        set: function (node) {
            if (!node) return;
            if (this.cur && this.cur !== node) this.cur.classList.remove('focused');
            this.cur = node;
            node.classList.add('focused');
            var zone = node.getAttribute('data-zone');
            if (zone) this.memory[zone] = node;
            ensureVisible(node);
            if (node._onFocus) node._onFocus();
        },

        clear: function () {
            if (this.cur) this.cur.classList.remove('focused');
            this.cur = null;
            this.memory = {};
        },

        all: function () {
            var list = document.querySelectorAll('#stage .focusable');
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
            var nodes = this.all();
            for (var i = 0; i < nodes.length; i++) {
                if (nodes[i].getAttribute('data-key') === key) return nodes[i];
            }
            return null;
        },

        move: function (dir) {
            var cur = this.cur;
            if (!this.isValid(cur)) { this.first(); return false; }
            var r = cur.getBoundingClientRect();
            var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            var nodes = this.all();
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
        node.addEventListener('click', function () {   // Maus/Touch beim Testen am PC
            Focus.set(node);
            if (node.tagName === 'INPUT') node.focus(); else if (action) action();
        });
        return node;
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
        return {
            ensure: function (index) { while (shown <= index && shown < items.length) more(); }
        };
    }

    // =====================================================================
    // Einstellungen und Favoriten
    // =====================================================================

    var Settings = {
        liveExt: Storage.get('liveExt', 'ts'),   // 'ts' oder 'm3u8'
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

    var Api = {
        acc: null,

        call: function (action, extra) {
            var a = this.acc;
            var url = a.server + '/player_api.php?username=' + encodeURIComponent(a.username) +
                '&password=' + encodeURIComponent(a.password);
            if (action) url += '&action=' + action;
            if (extra) {
                for (var k in extra) {
                    if (extra.hasOwnProperty(k)) url += '&' + k + '=' + encodeURIComponent(extra[k]);
                }
            }
            return fetch(url).then(function (res) {
                return res.text().then(function (text) {
                    if (!res.ok) throw new Error('Der Server antwortet mit HTTP ' + res.status + '. ' + text.slice(0, 120));
                    try { return JSON.parse(text); }
                    catch (e) { throw new Error('Unerwartete Antwort vom Server: ' + text.slice(0, 120)); }
                });
            }, function () {
                throw new Error('Der Server ist nicht erreichbar. Prüfe die Adresse und die Internetverbindung.');
            });
        },

        creds: function () {
            return encodeURIComponent(this.acc.username) + '/' + encodeURIComponent(this.acc.password);
        },
        liveUrl: function (id) { return this.acc.server + '/live/' + this.creds() + '/' + id + '.' + Settings.liveExt; },
        movieUrl: function (id, ext) { return this.acc.server + '/movie/' + this.creds() + '/' + id + '.' + (ext || 'mp4'); },
        episodeUrl: function (id, ext) { return this.acc.server + '/series/' + this.creds() + '/' + id + '.' + (ext || 'mp4'); }
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
                    if (rows && rows.length) License.set(rows[0]);
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
            var list = this.lists || [];
            for (var i = 0; i < list.length; i++) if (list[i].id === String(id)) return list[i];
            return null;
        }
    };

    /** Wiedergabeliste → Xtream-Zugang */
    function playlistAccount(p) {
        if (p.server && p.username && p.password) {
            var fromLink = Account.parse(p.server);
            if (fromLink) return fromLink;
            return { server: Account.normalizeServer(p.server), username: p.username, password: p.password };
        }
        return Account.parse(p.m3u || p.server || '');
    }

    function playlistAddress(p) {
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
            backdrop: ''
        };
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

        login: function (acc) {
            Api.acc = acc;
            var self = this;
            return Api.call(null).then(function (json) {
                var user = json && json.user_info;
                if (!user) throw new Error('Unerwartete Antwort vom Server.');
                if (String(user.auth) !== '1') throw new Error('Anmeldung abgelehnt. Benutzername oder Passwort stimmt nicht, oder das Abo ist abgelaufen.');
                self.status = str(user.status) || 'Active';
                var exp = parseFloat(user.exp_date);
                self.expiry = exp > 0 ? new Date(exp * 1000) : null;
                return Promise.all([Api.call('get_live_categories'), Api.call('get_live_streams')]);
            }).then(function (res) {
                var cats = self.catMap(res[0]);
                var streams = Array.isArray(res[1]) ? res[1] : [];
                self.channels = streams.map(function (s, i) {
                    return {
                        type: 'live',
                        id: parseInt(s.stream_id, 10),
                        num: i + 1,
                        name: str(s.name) || 'Sender ' + s.stream_id,
                        logo: str(s.stream_icon),
                        cat: cats[String(s.category_id)] || ''
                    };
                }).filter(function (c) { return !isNaN(c.id); });
                if (!self.channels.length) throw new Error('Anmeldung klappt, aber der Server liefert keine Live-Sender.');
                self.movies = []; self.series = [];
                self.moviesLoaded = false; self.seriesLoaded = false;
                self.epgCache = {};
                Storage.set('account', acc);
            });
        },

        loadMovies: function () {
            var self = this;
            if (self.moviesLoaded) return Promise.resolve();
            return Promise.all([Api.call('get_vod_categories'), Api.call('get_vod_streams')]).then(function (res) {
                var cats = self.catMap(res[0]);
                var list = Array.isArray(res[1]) ? res[1] : [];
                self.movies = list.map(function (s) {
                    var name = str(s.name) || 'Film ' + s.stream_id;
                    var year = firstYear(str(s.year)) || firstYear(str(s.release_date)) || firstYear(str(s.releaseDate)) || yearFromName(name);
                    return {
                        type: 'movie',
                        id: parseInt(s.stream_id, 10),
                        name: name,
                        logo: str(s.stream_icon),
                        cat: cats[String(s.category_id)] || '',
                        ext: str(s.container_extension) || 'mp4',
                        year: year
                    };
                }).filter(function (m) { return !isNaN(m.id); });
                self.moviesLoaded = true;
            });
        },

        loadSeries: function () {
            var self = this;
            if (self.seriesLoaded) return Promise.resolve();
            return Promise.all([Api.call('get_series_categories'), Api.call('get_series')]).then(function (res) {
                var cats = self.catMap(res[0]);
                var list = Array.isArray(res[1]) ? res[1] : [];
                self.series = list.map(function (s) {
                    return {
                        type: 'series',
                        id: parseInt(s.series_id, 10),
                        name: str(s.name) || 'Serie ' + s.series_id,
                        logo: str(s.cover),
                        cat: cats[String(s.category_id)] || ''
                    };
                }).filter(function (s) { return !isNaN(s.id); });
                self.seriesLoaded = true;
            });
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
        open: function (url, rect) {
            this.stop();
            this.subtitleOn = false;
            this.subIndex = -1;
            this.emit('buffer', true);
            var self = this;

            if (this.android) {
                var fr = this.fractions(rect);
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
                    try { av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e2) { /* egal */ }
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
                v.src = url;
                var p = v.play();
                if (p && p.catch) p.catch(function () { /* Autoplay im Browser blockiert */ });
                setTimeout(function () { self.emit('ready'); }, 0);
            }
        },

        /** Bildbereich als Anteil des sichtbaren Fensters (für Android) */
        fractions: function (rect) {
            var w = window.innerWidth || 1920, hh = window.innerHeight || 1080;
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
                    out.push({ index: list[i].index, name: langName(code, (type === 'AUDIO' ? 'Tonspur ' : 'Untertitel ') + (out.length + 1)) });
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

        show: function (screen) {
            var app = $('#app');
            app.innerHTML = '';
            $('#toast').classList.add('hidden');   // Meldungen vom vorherigen Bildschirm ausblenden
            document.body.classList.remove('preview-mode', 'video-mode');
            Focus.clear();
            screen.render(app);
            var target = Focus.byKey(screen.focusKey);
            if (target) Focus.set(target); else Focus.first();
        },

        push: function (screen) {
            var cur = this.top();
            if (cur) {
                cur.focusKey = Focus.cur ? Focus.cur.getAttribute('data-key') : null;
                if (cur.hide) cur.hide();
            }
            this.stack.push(screen);
            this.show(screen);
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
            if (cur.hide) cur.hide();
            this.show(this.top());
        }
    };

    // =====================================================================
    // Bausteine für die Oberfläche
    // =====================================================================

    function topbar(title, hint) {
        var bar = h('div');
        if (title) bar.appendChild(h('div', 'screen-title', title));
        if (hint) bar.appendChild(h('div', 'hint', hint));
        return bar;
    }

    function categoryColumn(cats, activeIndex, onSelect) {
        var col = h('div', 'col col-cats');
        var scroll = h('div', 'scroll');
        scroll.appendChild(h('div', 'col-head', 'Kategorien'));
        cats.forEach(function (name, i) {
            var item = h('div', 'cat' + (i === activeIndex ? ' active' : ''), name);
            focusable(item, 'cat-' + i, function () { onSelect(i); }, 'cats');
            scroll.appendChild(item);
        });
        col.appendChild(scroll);
        return col;
    }

    function posterNode(item, keyPrefix, isFav, action) {
        var node = h('div', 'poster');
        var img = h('div', 'img');
        if (item.logo) img.style.backgroundImage = 'url("' + item.logo.replace(/"/g, '%22') + '")';
        if (isFav) img.appendChild(h('div', 'fav', '★'));
        node.appendChild(img);
        node.appendChild(h('div', 'title', item.name));
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
        } else {
            lists.forEach(function (p) {
                var card = h('div', 'pl-card');
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
            this.focusKey = current && Remote.find(current) ? 'pl-' + current : (lists.length ? 'pl-' + lists[0].id : 'pl-refresh');
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
        if (!License.active()) { Nav.replace(new LockScreen()); return; }
        var acc = playlistAccount(p);
        if (!acc) {
            toast('Diese Wiedergabeliste wird nicht unterstützt. Nötig sind Server, Benutzername und Passwort oder ein Link mit get.php?username=…&password=…', 8000);
            return;
        }
        var previous = Api.acc;
        loader(true, 'Verbinde mit „' + p.name + '“ …');
        Data.login(acc).then(function () {
            Storage.set('playlistId', p.id);
            loader(false);
            Nav.replace(new HomeScreen());
        }, function (e) {
            Api.acc = previous;
            loader(false);
            toast(e.message || String(e), 8000);
        });
    };
    PlaylistsScreen.prototype.onRootBack = function () {
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
        var now = Date.now();
        if (now - this.lastBack < 3000) { exitApp(); return; }
        this.lastBack = now;
        toast('Zum Beenden noch einmal Zurück drücken');
    };

    // =====================================================================
    // Startbildschirm
    // =====================================================================

    function HomeScreen() { this.lastBack = 0; }
    HomeScreen.prototype.render = function (root) {
        var bar = h('div', 'topbar');
        var brand = h('div', 'brand');
        brand.innerHTML = '<img src="img/icon.png" alt="">';
        bar.appendChild(brand);
        root.appendChild(bar);

        var circles = h('div', 'home-circles');
        [
            ['live', 'tv', 'LIVE TV', function () { Nav.push(new LiveScreen(0)); }],
            ['movies', 'film', 'FILME', function () { Nav.push(new MoviesScreen('movies')); }],
            ['series', 'series', 'SERIEN', function () { Nav.push(new MoviesScreen('series')); }],
            ['favs', 'star', 'FAVORITEN', function () { Nav.push(new FavoritesScreen()); }]
        ].forEach(function (c) {
            var node = h('div', 'circle');
            node.innerHTML = '<div class="icon">' + icon(c[1], 120) + '</div><div class="label">' + c[2] + '</div>';
            circles.appendChild(focusable(node, 'home-' + c[0], c[3], 'circles'));
        });
        root.appendChild(circles);

        var tiles = h('div', 'home-tiles');
        [
            ['reload', 'refresh', 'NEU LADEN', function () { reloadAll(); }],
            ['account', 'user', 'KONTO', function () { Nav.push(new AccountScreen()); }],
            ['lists', 'list', 'LISTEN', function () { Nav.push(new PlaylistsScreen()); }]
        ].forEach(function (t) {
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
        var now = Date.now();
        if (now - this.lastBack < 3000) { exitApp(); return; }
        this.lastBack = now;
        toast('Zum Beenden noch einmal Zurück drücken');
    };

    function reloadAll() {
        var acc = Api.acc || Storage.get('account', null);
        if (!acc) return;
        loader(true, 'Sender werden neu geladen …');
        Data.login(acc).then(function () {
            loader(false);
            Nav.replace(new HomeScreen());
            toast('Senderliste aktualisiert');
        }, function (e) {
            loader(false);
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
    LiveScreen.prototype.categories = function () {
        var seen = {}, cats = [];
        Data.channels.forEach(function (c) { if (c.cat && !seen[c.cat]) { seen[c.cat] = true; cats.push(c.cat); } });
        return ['Alle', '★ Favoriten'].concat(cats);
    };
    LiveScreen.prototype.filter = function () {
        var cats = this.categories(), cat = cats[this.catIndex];
        if (this.catIndex === 0) return Data.channels.slice();
        if (this.catIndex === 1) return Data.channels.filter(function (c) { return Favs.has('live', c.id); });
        return Data.channels.filter(function (c) { return c.cat === cat; });
    };
    LiveScreen.prototype.render = function (root) {
        var self = this;
        document.body.classList.add('preview-mode');
        root.appendChild(topbar('Live TV', 'OK: Vorschau · nochmal OK: Vollbild · Gelb: Favorit'));

        var columns = h('div', 'columns');
        var cats = this.categories();
        columns.appendChild(categoryColumn(cats, this.catIndex, function (i) {
            self.catIndex = i;
            self.focusKey = null;
            Nav.show(self);
            var first = $('.col-list .row');
            if (first) Focus.set(first);
        }));

        var listCol = h('div', 'col col-list');
        var scroll = h('div', 'scroll');
        listCol.appendChild(scroll);
        columns.appendChild(listCol);

        this.list = this.filter();
        if (!this.list.length) {
            scroll.appendChild(h('div', 'empty-note', this.catIndex === 1 ? 'Noch keine Favoriten. Drücke bei einem Sender die gelbe Taste.' : 'Keine Sender in dieser Kategorie.'));
        }
        var batch = batchRender(scroll, this.list, function (ch, i) {
            var row = h('div', 'row' + (self.selected && self.selected.id === ch.id ? ' active' : ''));
            row.appendChild(h('div', 'num', String(ch.num)));
            var logo = h('img', 'logo');
            if (ch.logo) logo.src = ch.logo;
            logo.onerror = function () { logo.style.visibility = 'hidden'; };
            row.appendChild(logo);
            row.appendChild(h('div', 'name', ch.name));
            if (Favs.has('live', ch.id)) row.appendChild(h('div', 'star', '★'));
            row._channel = ch;
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
        Player.open(Api.liveUrl(ch.id), stageRect(this.previewBox));
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
        Player.stop();
        Nav.push(new PlayerScreen(this.list, index, 'live'));
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
        Player.stop();
        document.body.classList.remove('preview-mode');
    };

    // =====================================================================
    // Filme und Serien: Kategorien | Poster
    // =====================================================================

    function MoviesScreen(kind) {
        this.kind = kind;          // 'movies' oder 'series'
        this.catIndex = 0;
    }
    MoviesScreen.prototype.items = function () { return this.kind === 'movies' ? Data.movies : Data.series; };
    MoviesScreen.prototype.favType = function () { return this.kind === 'movies' ? 'movie' : 'series'; };
    MoviesScreen.prototype.yearLabel = function () { return 'Filme ' + new Date().getFullYear(); };
    MoviesScreen.prototype.categories = function () {
        var seen = {}, cats = [];
        this.items().forEach(function (m) { if (m.cat && !seen[m.cat]) { seen[m.cat] = true; cats.push(m.cat); } });
        var base = ['Alle', '★ Favoriten'];
        if (this.kind === 'movies') base.push(this.yearLabel());
        return base.concat(cats);
    };
    MoviesScreen.prototype.filter = function () {
        var items = this.items(), fav = this.favType();
        var cats = this.categories(), cat = cats[this.catIndex];
        if (this.catIndex === 0) return items.slice();
        if (this.catIndex === 1) return items.filter(function (m) { return Favs.has(fav, m.id); });
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
        root.appendChild(topbar(title, 'OK: Öffnen · Gelb: Favorit'));
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
            self.focusKey = null;
            Nav.show(self);
            var first = $('.poster');
            if (first) Focus.set(first);
        }));

        var gridCol = h('div', 'col col-grid');
        var scroll = h('div', 'scroll');
        var grid = h('div', 'grid');
        scroll.appendChild(grid);
        gridCol.appendChild(scroll);
        columns.appendChild(gridCol);
        root.appendChild(columns);

        var list = this.filter(), fav = this.favType();
        if (!list.length) {
            var note = this.catIndex === 1 ? 'Noch keine Favoriten. Drücke bei einem Poster die gelbe Taste.'
                : (this.categories()[this.catIndex] === this.yearLabel() ? 'Dein Anbieter hat keine Filme mit dem Jahr ' + new Date().getFullYear() + ' gekennzeichnet.' : 'Nichts gefunden.');
            grid.appendChild(h('div', 'empty-note', note));
        }
        batchRender(grid, list, function (item) {
            var node = posterNode(item, fav + '-', Favs.has(fav, item.id), function () {
                Nav.push(self.kind === 'movies' ? new MovieDetailScreen(item) : new SeriesDetailScreen(item));
            });
            node._item = item;
            return node;
        }, 60);
        if (!this.focusKey) this.focusKey = list.length ? fav + '-' + list[0].id : 'cat-0';
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
        root.appendChild(topbar('Favoriten', 'OK: Öffnen · Gelb: Entfernen'));
        var col = h('div', 'col col-grid');
        col.style.left = '0';
        col.style.top = '110px';
        var scroll = h('div', 'scroll'), grid = h('div', 'grid');
        grid.style.paddingLeft = '70px';
        scroll.appendChild(grid);
        col.appendChild(scroll);
        root.appendChild(col);

        var live = Data.channels.filter(function (c) { return Favs.has('live', c.id); });
        var movies = Data.movies.filter(function (m) { return Favs.has('movie', m.id); });
        var series = Data.series.filter(function (s) { return Favs.has('series', s.id); });
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
            grid.appendChild(node);
        });
        void self;
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

        var play = h('div', 'button primary', '▶  Abspielen');
        focusable(play, 'play', function () { Nav.push(new PlayerScreen([m], 0, 'movie')); }, 'buttons');
        body.appendChild(play);
        var fav = h('div', 'button', Favs.has('movie', m.id) ? '★  Favorit' : '☆  Zu Favoriten');
        focusable(fav, 'fav', function () {
            var on = Favs.toggle('movie', m.id);
            fav.textContent = on ? '★  Favorit' : '☆  Zu Favoriten';
        }, 'buttons');
        body.appendChild(fav);

        var plot = h('div', 'plot', 'Infos werden geladen …');
        var credits = h('div', 'credits', '');
        body.appendChild(plot);
        body.appendChild(credits);
        d.appendChild(body);
        root.appendChild(d);

        function fill(info) {
            var img = info.cover || m.logo;
            if (img) cover.style.backgroundImage = 'url("' + img.replace(/"/g, '%22') + '")';
            var back = info.backdrop || info.cover || m.logo;
            if (back) bg.style.backgroundImage = 'url("' + back.replace(/"/g, '%22') + '")';
            meta.textContent = info.meta || (m.year ? String(m.year) : '');
            rating.textContent = info.rating ? '★ ' + info.rating : '';
            plot.textContent = info.plot || '';
            var c = [];
            if (info.director) c.push('Regie: ' + info.director);
            if (info.cast) c.push('Besetzung: ' + info.cast);
            credits.textContent = c.join('\n');
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
                if (self.episodes.length) self.season = self.episodes[0].season;
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
        if (info.meta) body.appendChild(h('div', 'meta', info.meta));

        var fav = h('div', 'button', Favs.has('series', s.id) ? '★  Favorit' : '☆  Zu Favoriten');
        focusable(fav, 'sfav', function () {
            var on = Favs.toggle('series', s.id);
            fav.textContent = on ? '★  Favorit' : '☆  Zu Favoriten';
        }, 'buttons');
        body.appendChild(fav);

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
            n.appendChild(document.createTextNode(ep.name));
            focusable(n, 'ep-' + ep.id, function () { Nav.push(new PlayerScreen(list, i, 'episode')); }, 'episodes');
            scroll.appendChild(n);
        });
        body.appendChild(eps);

        if (!this.focusKey) this.focusKey = list.length ? 'ep-' + list[0].id : 'sfav';
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
    // Vollbild-Player
    // =====================================================================

    function PlayerScreen(items, index, kind) {
        this.items = items;
        this.index = index;
        this.kind = kind;          // 'live', 'movie' oder 'episode'
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
    PlayerScreen.prototype.start = function () {
        var self = this;
        this.lastTime = -1;
        this.lastProgress = Date.now();
        $('#subtitle').classList.add('hidden');
        Player.on({
            buffer: function (b) { self.buffering = b; },
            time: function (t) {
                if (Math.abs(t - self.lastTime) > 0.2) { self.lastTime = t; self.lastProgress = Date.now(); }
                if (self.overlay) self.updateBar();
            },
            ready: function () { Player.applyPreferences(); },
            end: function () { self.onEnd(); },
            error: function (msg) { self.onError(msg); },
            subtitle: function (text, ms) { self.showSubtitle(text, ms); }
        });
        Player.open(this.url(), null);
        this.nowTitle = '';
        if (this.kind === 'live') {
            var it = this.item();
            Data.shortEpg(it.id).then(function (list) {
                if (self.item() === it && list.length) { self.nowTitle = list[0].title; if (self.overlay) self.renderOverlay(); }
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
        if (this.kind === 'episode' && this.index < this.items.length - 1) {
            this.index++;
            toast('Nächste Folge: ' + this.item().name);
            this.start();
            this.showOverlay();
        } else if (this.kind !== 'live') {
            Nav.back();
        }
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
                btn('pl-nextep', 'Nächste Folge', function () { self.index++; self.start(); });
            }
        }
        btn('pl-audio', 'Sprache', function () { toast(Player.nextAudio()); });
        btn('pl-sub', 'Untertitel', function () { toast(Player.nextSubtitle()); });
        if (this.kind !== 'episode') {
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
        if (k === KEY.GREEN) { toast(Player.nextAudio()); return true; }
        if (k === KEY.BLUE) { toast(Player.nextSubtitle()); return true; }

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
        clearTimeout(this.hideTimer);
        clearTimeout(this.subTimer);
        clearInterval(this.watchdog);
        Player.stop();
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

    function onKeyDown(e) {
        var k = e.keyCode;
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

        if (!$('#loader').classList.contains('hidden')) { e.preventDefault(); return; }

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
        registerKeys();
        Favs.load();
        Player.init();
        document.addEventListener('keydown', onKeyDown);

        // App in den Hintergrund: Video anhalten
        function lifecycle(hidden) {
            if (hidden) {
                var top = Nav.top();
                if (top && (top instanceof PlayerScreen || top instanceof LiveScreen)) {
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
        window.__androidKey = function (code) {
            onKeyDown({ keyCode: code, preventDefault: function () { } });
        };

        // Bedienung per Finger (Handy/Tablet): Listen dürfen wischen
        if ('ontouchstart' in window) document.body.classList.add('touch');

        Device.load();
        var saved = Storage.get('account', null);
        var lastId = Storage.get('playlistId', null);

        function start(acc) {
            loader(true, 'Anmelden und Sender laden …');
            Data.login(acc).then(function () {
                loader(false);
                Nav.replace(new HomeScreen());
            }, function (e) {
                loader(false);
                Nav.replace(new PlaylistsScreen(e.message || String(e)));
            });
        }

        loader(true, 'Wiedergabelisten werden geladen …');
        Remote.load().then(function () {
            loader(false);
            if (!License.active()) { Nav.replace(new LockScreen()); return; }
            var chosen = lastId !== null ? Remote.find(lastId) : null;
            var acc = chosen ? playlistAccount(chosen) : null;
            if (acc) start(acc);
            else Nav.replace(new PlaylistsScreen(lastId !== null && !chosen && Remote.lists.length ? 'Die zuletzt genutzte Wiedergabeliste gibt es nicht mehr. Bitte wähle eine aus.' : ''));
        }, function (e) {
            loader(false);
            // Website nicht erreichbar: zuletzt bekannter Stand der Testphase gilt
            if (!License.active()) { Nav.replace(new LockScreen()); return; }
            if (lastId !== null && saved && saved.server && saved.username && saved.password) start(saved);
            else Nav.replace(new PlaylistsScreen(e.message || String(e)));
        });

        // Läuft die Testphase während der Nutzung ab: alle 10 Minuten nachsehen
        setInterval(function () {
            if (Nav.top() instanceof LockScreen) return;
            Remote.load().then(null, function () { /* offline: gespeicherter Stand */ }).then(function () {
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
        loader(true, 'Anmelden und Sender laden …');
        Data.login(acc).then(function () {
            loader(false);
            Nav.replace(new HomeScreen());
        }, function (e) {
            loader(false);
            Nav.replace(new PlaylistsScreen(e.message || String(e)));
        });
    }

    // Nur für automatische Tests im Browser
    window.ImperumTV = { Nav: Nav, Focus: Focus, Data: Data, Player: Player, KEY: KEY, Device: Device, Remote: Remote, License: License };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
