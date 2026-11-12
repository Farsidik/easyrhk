/* EasyRHK — lapisan akun + Google Drive personal di atas template v17.
 * Tidak mengubah susunan laporan v17. Menambah: login/daftar/OTP, simpan laporan ke Drive milik pengguna,
 * daftar laporan, folder per template, panel admin. Semua teks dari server ditampilkan sebagai teks (bukan HTML). */
(function () {
  'use strict';
  var CFG = window.EASYRHK_CONFIG || {};
  var SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var DRIVE = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  var E = { session: null, settings: {}, tokenClient: null, gtoken: null, gexp: 0, driveOn: false, local: false,
            busy: false, dirty: false, timer: null, imgMap: {}, imgCache: {} };
  window.EasyRHK = E;

  /* ---------- util ---------- */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') el.className = attrs[k]; else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k]);
    });
    (function add(list) { list.forEach(function (c) { if (c == null || c === false) return; if (Array.isArray(c)) return add(c); el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }); })([].slice.call(arguments, 2));
    return el;
  }
  function $e(id) { return document.getElementById(id); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function fmtDate(s) { try { var d = new Date(s); return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return s; } }
  function status(txt, cls) { var s = $e('erhkSt'); if (s) { s.textContent = txt; s.className = cls || ''; } }
  function say(m) { if (typeof toast === 'function') toast(m, 4000); }

  /* ---------- API backend (Apps Script) ---------- */
  function api(action, payload) {
    var body = Object.assign({ action: action }, payload || {});
    if (E.session && !('token' in body)) body.token = E.session.token;
    return fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .catch(function () { throw { code: 'NET', message: 'Tidak dapat menghubungi server. Periksa internet atau alamat API_URL.' }; })
      .then(function (j) {
        if (j.ok) return j.data;
        if (j.error === 'AUTH' && E.session) { E.session = null; lsDel('easyrhk_session'); say('Sesi berakhir. Silakan login lagi.'); setTimeout(function () { location.reload(); }, 1200); }
        throw { code: j.error, message: j.message };
      });
  }

  /* ---------- Google Drive (izin drive.file, langsung dari browser) ---------- */
  function loadGis() {
    return new Promise(function (res, rej) {
      if (window.google && google.accounts && google.accounts.oauth2) return res();
      var s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = function () { res(); }; s.onerror = function () { rej({ message: 'Gagal memuat layanan Google. Periksa internet.' }); };
      document.head.appendChild(s);
    });
  }
  function getToken(interactive) {
    if (E.gtoken && Date.now() < E.gexp - 60000) return Promise.resolve(E.gtoken);
    if (!CFG.GOOGLE_CLIENT_ID) return Promise.reject({ message: 'GOOGLE_CLIENT_ID belum diisi di config.js.' });
    return loadGis().then(function () {
      return new Promise(function (res, rej) {
        if (!E.tokenClient) {
          E.tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CFG.GOOGLE_CLIENT_ID, scope: SCOPE, callback: function () {} });
        }
        E.tokenClient.callback = function (r) {
          if (r.error || !r.access_token) return rej({ message: 'Izin Google Drive belum diberikan.' });
          E.gtoken = r.access_token; E.gexp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
          E.driveOn = true; lsSet(uk('drive'), '1'); renderBar(); res(E.gtoken);
        };
        E.tokenClient.error_callback = function () { rej({ message: 'Jendela izin Google ditutup atau diblokir.' }); };
        E.tokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' });
      });
    });
  }
  function uk(n) { return 'easyrhk_' + n + '_' + (E.session ? E.session.user.userId : 'x'); }
  function driveFetch(url, opts, retried) {
    return getToken(false).then(function (t) {
      opts = opts || {}; opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + t });
      return fetch(url, opts);
    }).then(function (r) {
      if (r.status === 401 && !retried) { E.gtoken = null; return driveFetch(url, opts, true); }
      if (!r.ok) { var e = new Error('Drive ' + r.status); e.status = r.status; throw e; }
      return r;
    });
  }
  function qEsc(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
  function folderOk(id) {
    return driveFetch(DRIVE + '/files/' + encodeURIComponent(id) + '?fields=id,trashed,mimeType').then(function (r) { return r.json(); })
      .then(function (f) { return !f.trashed && f.mimeType === 'application/vnd.google-apps.folder'; }, function () { return false; });
  }
  function makeFolder(name, parent) {
    var q = "mimeType='application/vnd.google-apps.folder' and trashed=false and name='" + qEsc(name) + "'" + (parent ? " and '" + qEsc(parent) + "' in parents" : '');
    return driveFetch(DRIVE + '/files?fields=files(id,name)&q=' + encodeURIComponent(q)).then(function (r) { return r.json(); }).then(function (j) {
      if (j.files && j.files.length) return j.files[0].id;
      var meta = { name: name, mimeType: 'application/vnd.google-apps.folder' }; if (parent) meta.parents = [parent];
      return driveFetch(DRIVE + '/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) })
        .then(function (r) { return r.json(); }).then(function (f) { return f.id; });
    });
  }
  var TPL_NAME = { waliAsuh: 'Laporan Wali Asuh', waliAsrama: 'Laporan Wali Asrama' };
  /** Pastikan folder ada (pulihkan otomatis bila terhapus/dipindah ke sampah). Mengembalikan {root, foto, tpl}. */
  function ensureFolders(role) {
    var f = (E.settings.folders = E.settings.folders || {}), changed = false;
    function ensure(key, name, parentKey) {
      return Promise.resolve(f[key] && f[key].id ? folderOk(f[key].id) : false).then(function (ok) {
        if (ok) return f[key].id;
        return makeFolder(name, parentKey ? f[parentKey].id : null).then(function (id) { f[key] = { id: id, name: name }; changed = true; return id; });
      });
    }
    return ensure('root', 'EasyRHK').then(function () { return ensure('foto', 'Foto', 'root'); })
      .then(function () { return ensure(role, TPL_NAME[role] || role, 'root'); })
      .then(function () { return changed ? api('saveSettings', { settings: { folders: f } }).then(function (r) { E.settings = r.settings; }) : null; })
      .then(function () { return { root: f.root.id, foto: f.foto.id, tpl: f[role].id }; });
  }
  function multipart(opts) {
    var b = 'erhk' + Date.now() + Math.random().toString(36).slice(2), meta = opts.id ? { name: opts.name } : { name: opts.name, parents: [opts.parent] };
    var blob = new Blob(['--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + b + '\r\nContent-Type: ' + opts.mime + '\r\n\r\n', opts.body, '\r\n--' + b + '--']);
    return driveFetch(UPLOAD + '/files' + (opts.id ? '/' + encodeURIComponent(opts.id) : '') + '?uploadType=multipart&fields=id', { method: opts.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: blob })
      .then(function (r) { return r.json(); }).then(function (j) { return j.id; });
  }
  function blobToDataUrl(blob) { return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = rej; fr.readAsDataURL(blob); }); }

  /* ---------- gambar: Base64 (v17) <-> berkas Drive ---------- */
  function hashStr(s) { var a = 2166136261, b = 5381; for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = ((b << 5) + b + c) | 0; } return (a >>> 0).toString(36) + (b >>> 0).toString(36) + s.length.toString(36); }
  function walk(o, fn) {
    if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) { if (typeof o[i] === 'string') { var r = fn(o[i]); if (r !== undefined) o[i] = r; } else if (o[i] && typeof o[i] === 'object') walk(o[i], fn); } }
    else if (o && typeof o === 'object') { Object.keys(o).forEach(function (k) { var v = o[k]; if (typeof v === 'string') { var r = fn(v); if (r !== undefined) o[k] = r; } else if (v && typeof v === 'object') walk(v, fn); }); }
  }
  function collect(o, pred) { var out = []; walk(o, function (v) { if (pred(v)) out.push(v); }); return out; }
  var IS_IMG = function (v) { return v.indexOf('data:image/') === 0; }, IS_REF = function (v) { return v.indexOf('drive:') === 0; };

  function externalize(state, folderId) {
    var clone = JSON.parse(JSON.stringify(state)), imgs = Array.from(new Set(collect(clone, IS_IMG))), map = {};
    var chain = Promise.resolve();
    imgs.forEach(function (d) {
      chain = chain.then(function () {
        var k = hashStr(d);
        if (E.imgMap[k]) { map[d] = 'drive:' + E.imgMap[k]; return; }
        return fetch(d).then(function (r) { return r.blob(); }).then(function (blob) {
          var ext = blob.type === 'image/png' ? 'png' : 'jpg';
          return multipart({ name: 'img_' + k + '.' + ext, parent: folderId, mime: blob.type || 'image/jpeg', body: blob });
        }).then(function (id) { E.imgMap[k] = id; E.imgCache[id] = d; lsSet(uk('imgmap'), JSON.stringify(E.imgMap)); map[d] = 'drive:' + id; });
      });
    });
    return chain.then(function () { walk(clone, function (v) { if (IS_IMG(v)) return map[v]; }); return clone; });
  }
  function hydrate(state) {
    var refs = Array.from(new Set(collect(state, IS_REF))), data = {}, missing = 0, i = 0;
    function worker() {
      if (i >= refs.length) return Promise.resolve();
      var ref = refs[i++], id = ref.slice(6);
      if (E.imgCache[id]) { data[ref] = E.imgCache[id]; return worker(); }
      return driveFetch(DRIVE + '/files/' + encodeURIComponent(id) + '?alt=media').then(function (r) { return r.blob(); }).then(blobToDataUrl)
        .then(function (d) { E.imgCache[id] = d; data[ref] = d; }, function () { missing++; data[ref] = ''; }).then(worker);
    }
    return Promise.all([worker(), worker(), worker()]).then(function () { walk(state, function (v) { if (IS_REF(v)) return data[v]; }); return missing; });
  }

  /* ---------- sinkronisasi laporan ---------- */
  function periodOf() {
    var d = (S.rows || []).map(function (r) { return r.date; }).filter(Boolean).sort()[0] || (typeof todayS !== 'undefined' ? todayS : new Date().toISOString().slice(0, 10));
    return d.slice(0, 7);
  }
  function titleOf(period) {
    var p = period.split('-'), nm = (typeof BLN !== 'undefined' ? BLN[Number(p[1]) - 1] : p[1]) + ' ' + p[0];
    return (S.rhk || 'Laporan') + ' — ' + (S.role === 'waliAsrama' ? 'Wali Asrama' : 'Wali Asuh') + ' — ' + nm;
  }
  function onSave() { if (E.local || !E.session) return; if (!E.driveOn) { status('Tersimpan di browser · Drive belum terhubung', 'warn'); return; } E.dirty = true; clearTimeout(E.timer); E.timer = setTimeout(syncNow, 4000); status('Menunggu sinkron…', ''); }
  function syncNow() {
    if (E.local || !E.session) return Promise.resolve();
    if (E.busy) { E.dirty = true; return Promise.resolve(); }
    clearTimeout(E.timer); E.busy = true; E.dirty = false; status('Menyimpan ke Drive…', '');
    var role = S.role === 'waliAsrama' ? 'waliAsrama' : 'waliAsuh', period = periodOf(), erhk = (S.erhk = S.erhk || {});
    return getToken(false).then(function () { return ensureFolders(role); })
      .then(function (fo) {
        return externalize(S, fo.foto).then(function (clone) {
          var title = erhk.title || titleOf(period); clone.erhk = { reportId: erhk.reportId || '', title: title };
          var body = JSON.stringify({ app: 'EasyRHK', v: 1, state: clone });
          return multipart({ id: erhk.fileId || null, name: title.replace(/[\\/:*?"<>|]/g, '-') + '.json', parent: fo.tpl, mime: 'application/json', body: body })
            .catch(function (e) { if (e.status === 404 && erhk.fileId) { erhk.fileId = null; return multipart({ name: title.replace(/[\\/:*?"<>|]/g, '-') + '.json', parent: fo.tpl, mime: 'application/json', body: body }); } throw e; })
            .then(function (fileId) {
              erhk.fileId = fileId;
              var pay = { title: title, period: period, rhk: S.rhk || '', role: role, driveFileId: fileId, reportId: erhk.reportId || undefined };
              return api('upsertReport', pay).catch(function (e) { if (e.code === 'NOT_FOUND') { delete pay.reportId; return api('upsertReport', pay); } throw e; });
            });
        });
      })
      .then(function (r) { erhk.reportId = r.report.reportId; erhk.title = r.report.title; try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} status('Tersimpan di Drive ✓ ' + new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }), 'ok'); })
      .catch(function (e) {
        if (e && e.message && /Izin|diblokir|GOOGLE_CLIENT/.test(e.message)) { E.driveOn = false; renderBar(); status('Perlu hubungkan Drive (klik tombol)', 'warn'); }
        else status('Gagal sinkron: ' + ((e && e.message) || 'kesalahan') + ' — data aman di browser', 'err');
      })
      .then(function () { E.busy = false; if (E.dirty) { clearTimeout(E.timer); E.timer = setTimeout(syncNow, 1500); } });
  }
  function connectDrive() { return getToken(true).then(function () { status('Drive terhubung ✓', 'ok'); return syncNow(); }, function (e) { alert(e.message); }); }

  /* ---------- UI dasar ---------- */
  function modal(content, wide) {
    var m = h('div', { class: 'erhk-modal', onclick: function (ev) { if (ev.target === m) m.remove(); } }, h('div', { class: 'erhk-card' + (wide ? ' wide' : '') }, content));
    document.body.appendChild(m); return m;
  }
  function msgBox() { return h('div', { class: 'erhk-msg' }); }
  function showMsg(box, text, ok) { box.className = 'erhk-msg ' + (ok ? 'ok' : 'err'); box.textContent = text; }
  function field(label, type, id, ph, extra) { return [h('label', { for: id }, label), h('input', Object.assign({ id: id, type: type, placeholder: ph || '', autocomplete: type === 'password' ? 'current-password' : 'off' }, extra || {}))]; }
  function val(id) { return $e(id).value; }
  function btn(txt, cls, fn) { var b = h('button', { class: cls || '', type: 'button' }, txt); b.addEventListener('click', function () { b.disabled = true; Promise.resolve().then(fn).catch(function () {}).then(function () { b.disabled = false; }); }); return b; }

  /* ---------- layar masuk / daftar ---------- */
  function authScreen() {
    var box = $e('erhkAuth'); if (box) box.remove();
    var card = h('div', { class: 'erhk-card' }), wrap = h('div', { id: 'erhkAuth' }, card);
    document.body.appendChild(wrap);
    var tab = 'login', pendingNip = '';
    function draw(msg, ok) {
      card.innerHTML = '';
      card.appendChild(h('h2', {}, 'EasyRHK'));
      card.appendChild(h('p', { class: 's' }, 'Laporan RHK Wali Asuh / Wali Asrama. Foto dan dokumen Anda tersimpan di Google Drive Anda sendiri.'));
      if (!CFG.API_URL) {
        card.appendChild(h('div', { class: 'erhk-msg err' }, 'Aplikasi belum dikonfigurasi (API_URL kosong di config.js). Ikuti PANDUAN_PEMASANGAN.md, atau gunakan mode lokal di bawah.'));
        card.appendChild(h('div', { class: 'row' }, btn('Lanjut tanpa akun (mode lokal, seperti v17)', 'g', function () { E.local = true; wrap.remove(); renderBar(); status('Mode lokal — tidak ada sinkron', 'warn'); })));
        return;
      }
      if (tab !== 'otp' && tab !== 'resetotp') card.appendChild(h('div', { class: 'erhk-tabs' },
        ['login:Masuk', 'register:Daftar', 'forgot:Lupa password'].map(function (x) { var p = x.split(':'); return h('button', { type: 'button', class: tab === p[0] ? 'on' : '', onclick: function () { tab = p[0]; draw(); } }, p[1]); })));
      var m = msgBox(); var ctl = [];
      if (tab === 'login') {
        ctl = [].concat(field('NIP', 'text', 'a_nip', '18 digit', { inputmode: 'numeric', maxlength: 30 }), field('Password', 'password', 'a_pw', ''),
          [h('div', { class: 'row' }, btn('Masuk', '', function () {
            return api('login', { nip: val('a_nip').trim(), password: val('a_pw'), token: undefined }).then(function (d) { startSession(d); }, function (e) {
              if (e.code === 'PENDING_EMAIL') { pendingNip = val('a_nip').trim(); tab = 'otp'; draw('Email belum diverifikasi. Masukkan kode OTP, atau klik "Kirim ulang kode".', false); } else showMsg(m, e.message, false); });
          }))]);
      } else if (tab === 'register') {
        ctl = [].concat(field('NIP (18 digit)', 'text', 'a_nip', '', { inputmode: 'numeric', maxlength: 18 }), field('NIK (16 digit)', 'text', 'a_nik', '', { inputmode: 'numeric', maxlength: 16 }),
          field('Email aktif', 'email', 'a_em', 'nama@gmail.com'), field('Password (min. 8, huruf + angka)', 'password', 'a_pw', ''), field('Ulangi password', 'password', 'a_pw2', ''),
          [h('p', { class: 's' }, 'NIK hanya dipakai untuk memastikan akun unik; yang tersimpan hanya sidik digital dan 4 digit terakhir.'),
           h('div', { class: 'row' }, btn('Daftar & kirim kode OTP', '', function () {
            if (val('a_pw') !== val('a_pw2')) return showMsg(m, 'Ulangi password tidak sama.', false);
            return api('register', { nip: val('a_nip').trim(), nik: val('a_nik').trim(), email: val('a_em').trim(), password: val('a_pw'), token: undefined })
              .then(function (d) { pendingNip = val('a_nip').trim(); tab = 'otp'; draw(d.message, true); }, function (e) { showMsg(m, e.message, false); });
          }))]);
      } else if (tab === 'otp') {
        ctl = [].concat([h('h3', {}, 'Verifikasi email')], field('Kode OTP (6 digit) dari email', 'text', 'a_otp', '', { inputmode: 'numeric', maxlength: 6 }),
          [h('div', { class: 'row' }, btn('Verifikasi', '', function () {
            return api('verifyRegistration', { nip: pendingNip, otp: val('a_otp').trim(), token: undefined }).then(function (d) { tab = 'login'; draw(d.message, true); }, function (e) { showMsg(m, e.message, false); });
          }), btn('Kirim ulang kode', 'g', function () { return api('resendOtp', { nip: pendingNip, token: undefined }).then(function (d) { showMsg(m, d.message, true); }, function (e) { showMsg(m, e.message, false); }); }),
          btn('Kembali', 'g', function () { tab = 'login'; draw(); }))]);
      } else if (tab === 'forgot') {
        ctl = [].concat(field('NIP', 'text', 'a_nip', '', { inputmode: 'numeric', maxlength: 18 }), field('Email terdaftar', 'email', 'a_em', ''),
          [h('div', { class: 'row' }, btn('Kirim kode reset', '', function () {
            return api('forgotStart', { nip: val('a_nip').trim(), email: val('a_em').trim(), token: undefined }).then(function (d) { pendingNip = val('a_nip').trim(); tab = 'resetotp'; draw(d.message, true); }, function (e) { showMsg(m, e.message, false); });
          }))]);
      } else if (tab === 'resetotp') {
        ctl = [].concat([h('h3', {}, 'Atur password baru')], field('Kode OTP dari email', 'text', 'a_otp', '', { inputmode: 'numeric', maxlength: 6 }), field('Password baru (min. 8, huruf + angka)', 'password', 'a_pw', ''),
          [h('div', { class: 'row' }, btn('Simpan password baru', '', function () {
            return api('forgotReset', { nip: pendingNip, otp: val('a_otp').trim(), newPassword: val('a_pw'), token: undefined }).then(function (d) { tab = 'login'; draw(d.message, true); }, function (e) { showMsg(m, e.message, false); });
          }), btn('Kembali', 'g', function () { tab = 'login'; draw(); }))]);
      }
      ctl.forEach(function (c) { card.appendChild(c); }); card.appendChild(m);
      if (msg) showMsg(m, msg, ok);
      var first = card.querySelector('input'); if (first) first.focus();
    }
    draw();
  }

  function startSession(d) {
    E.session = { token: d.token, user: d.user }; E.settings = d.settings || {};
    lsSet('easyrhk_session', JSON.stringify(E.session));
    var a = $e('erhkAuth'); if (a) a.remove();
    afterLogin(true);
  }

  function afterLogin(fresh) {
    var uid = E.session.user.userId, userKey = 'rhk_template_u_' + uid;
    try { E.imgMap = JSON.parse(lsGet(uk('imgmap')) || '{}'); } catch (e) { E.imgMap = {}; }
    var legacy = lsGet('rhk_template_v1');
    if (!lsGet(userKey) && legacy && confirm('Ditemukan data template v17 lama di browser ini. Impor ke akun Anda sekarang?\n(Pilih Batal untuk memulai laporan kosong.)')) lsSet(userKey, legacy);
    KEY = userKey; load(); initRhkSel(); render(); $('fTempat').value = S.ttd.tempat;
    E.driveOn = lsGet(uk('drive')) === '1' && !!E.gtoken;
    renderBar();
    status('Masuk sebagai NIP ' + E.session.user.nip, '');
    if (lsGet(uk('drive')) === '1') getToken(false).then(function () { status('Drive terhubung ✓', 'ok'); }, function () { status('Klik "Hubungkan Drive" untuk sinkron', 'warn'); });
    else status('Klik "Hubungkan Drive" agar laporan & foto tersimpan di Drive Anda', 'warn');
    api('me').then(function (d) { E.settings = d.settings || {}; });
  }

  /* ---------- bilah atas ---------- */
  function renderBar() {
    var old = $e('erhkBar'); if (old) old.remove();
    var bar = h('div', { id: 'erhkBar', class: 'no-print' }, h('b', {}, 'EasyRHK'));
    if (E.session) {
      bar.appendChild(h('span', {}, 'NIP ' + E.session.user.nip));
      bar.appendChild(h('button', { class: E.driveOn ? '' : 'pri', onclick: connectDrive }, E.driveOn ? '☁ Drive terhubung' : '☁ Hubungkan Drive'));
      bar.appendChild(h('button', { onclick: openReports }, '📚 Laporan saya'));
      bar.appendChild(h('button', { onclick: newReport }, '➕ Laporan baru'));
      bar.appendChild(h('button', { onclick: openFolders }, '📁 Folder Drive'));
      bar.appendChild(h('span', { id: 'erhkSt' }, ''));
      bar.appendChild(h('span', { class: 'sp' }));
      if (E.session.user.isAdmin) bar.appendChild(h('button', { onclick: openAdmin }, '🛡 Admin'));
      bar.appendChild(h('button', { onclick: openAccount }, '👤 Akun'));
      bar.appendChild(h('button', { onclick: logout }, 'Keluar'));
    } else { bar.appendChild(h('span', { id: 'erhkSt' }, 'Mode lokal')); }
    var top = $e('top'); top.insertBefore(bar, top.firstChild);
  }
  function logout() {
    var go = function () { E.session = null; lsDel('easyrhk_session'); location.reload(); };
    (E.dirty ? syncNow() : Promise.resolve()).then(function () { return api('logout'); }).catch(function () {}).then(go);
  }

  /* ---------- Laporan saya ---------- */
  function openReports() {
    var list = h('div', { class: 'erhk-list' }), m = msgBox();
    var q = h('input', { id: 'rq', type: 'text', placeholder: 'Cari judul/RHK…' }), per = h('input', { id: 'rp', type: 'month' });
    var mod = modal([h('button', { class: 'x erhk-x', onclick: function () { mod.remove(); } }, '×'), h('h2', {}, 'Laporan saya'),
      h('p', { class: 's' }, 'Isi laporan ada di Google Drive Anda; di sini hanya daftar & pencarian.'),
      h('div', { class: 'row' }, q, per, btn('Cari', 'g', load)), list, m], true);
    function load() {
      list.textContent = 'Memuat…';
      return api('listReports', { q: q.value, period: per.value }).then(function (d) {
        list.innerHTML = ''; if (!d.reports.length) list.appendChild(h('div', { class: 'erhk-item' }, 'Belum ada laporan.'));
        d.reports.forEach(function (r) {
          list.appendChild(h('div', { class: 'erhk-item' }, h('div', { class: 't' }, h('b', {}, r.title), h('small', {}, (r.period || '-') + ' · diubah ' + fmtDate(r.updated))),
            btn('Buka', '', function () { return openReport(r, mod, m); }), btn('Hapus', 'd', function () { return delReport(r, load, m); })));
        });
      }, function (e) { list.textContent = ''; showMsg(m, e.message, false); });
    }
    load();
  }
  function openReport(r, mod, m) {
    if (!confirm('Buka laporan ini? Perubahan di layar saat ini akan disimpan dulu.')) return Promise.resolve();
    showMsg(m, 'Mengunduh dari Drive…', true);
    return (E.dirty ? syncNow() : Promise.resolve()).then(function () { return getToken(true); })
      .then(function () { return driveFetch(DRIVE + '/files/' + encodeURIComponent(r.driveFileId) + '?alt=media'); }).then(function (x) { return x.json(); })
      .then(function (pkg) {
        if (!pkg || pkg.app !== 'EasyRHK' || !pkg.state || !pkg.state.sec || !pkg.state.kop) throw { message: 'Berkas bukan laporan EasyRHK yang valid.' };
        return hydrate(pkg.state).then(function (missing) {
          pkg.state.erhk = Object.assign({}, pkg.state.erhk, { reportId: r.reportId, title: r.title, fileId: r.driveFileId });
          lsSet(KEY, JSON.stringify(pkg.state)); load(); initRhkSel(); render(); $('fTempat').value = S.ttd.tempat;
          mod.remove(); say(missing ? '✓ Laporan dibuka (' + missing + ' gambar tidak ditemukan di Drive)' : '✓ Laporan dibuka');
        });
      }).catch(function (e) {
        showMsg(m, e.status === 404 ? 'Berkas tidak ditemukan di Drive. Pastikan Anda menghubungkan akun Google yang sama seperti saat menyimpan, dan berkas belum dihapus.' : (e.message || 'Gagal membuka.'), false);
      });
  }
  function delReport(r, reload, m) {
    if (!confirm('Hapus laporan "' + r.title + '"?\nBerkasnya di Drive Anda juga akan dipindahkan ke Sampah.')) return Promise.resolve();
    return api('deleteReport', { reportId: r.reportId }).then(function (d) {
      return getToken(true).then(function () { return driveFetch(DRIVE + '/files/' + encodeURIComponent(d.driveFileId), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }); })
        .catch(function () { showMsg(m, 'Terhapus dari daftar, tetapi berkas Drive belum bisa dipindah ke Sampah (hapus manual).', false); });
    }).then(function () { if (S.erhk && S.erhk.reportId === r.reportId) { delete S.erhk.reportId; delete S.erhk.fileId; } return reload(); }, function (e) { showMsg(m, e.message, false); });
  }
  function newReport() {
    if (!confirm('Mulai laporan baru? Laporan saat ini disimpan dulu. Logo, tanda tangan, kop, dan template Anda dipertahankan.')) return;
    save(); (E.dirty ? syncNow() : Promise.resolve()).then(function () {
      var keep = { kop: S.kop, ttd: S.ttd, role: S.role, roleTpls: S.roleTpls, font: S.font, fs: S.fs, page: S.page, orient: S.orient, ctlMode: S.ctlMode };
      lsSet(KEY, JSON.stringify(keep)); load(); initRhkSel(); render(); $('fTempat').value = S.ttd.tempat; say('✓ Laporan baru dimulai');
    });
  }

  /* ---------- Folder Drive per template ---------- */
  function openFolders() {
    var m = msgBox(), body = h('div', {});
    var mod = modal([h('button', { class: 'erhk-x', onclick: function () { mod.remove(); } }, '×'), h('h2', {}, 'Folder Google Drive'),
      h('p', { class: 's' }, 'Aplikasi hanya dapat melihat folder/berkas yang ia buat sendiri (izin "drive.file"), bukan seluruh Drive Anda. Setiap template punya folder laporan sendiri; foto disimpan di folder "Foto".'), body, m], true);
    function draw() {
      body.innerHTML = ''; var f = (E.settings.folders = E.settings.folders || {});
      [['root', 'Folder utama'], ['foto', 'Foto'], ['waliAsuh', 'Template Wali Asuh'], ['waliAsrama', 'Template Wali Asrama']].forEach(function (x) {
        var cur = f[x[0]];
        body.appendChild(h('div', { class: 'erhk-item' }, h('div', { class: 't' }, h('b', {}, x[1]), h('small', {}, cur ? 'Folder: ' + cur.name : 'Belum dibuat (otomatis dibuat saat pertama menyimpan)')),
          cur ? h('a', { href: 'https://drive.google.com/drive/folders/' + encodeURIComponent(cur.id), target: '_blank', rel: 'noopener' }, 'Buka') : null,
          x[0] === 'root' ? null : btn('Ganti nama folder…', 'g', function () {
            var nm = prompt('Nama folder baru untuk "' + x[1] + '" (dibuat di dalam folder EasyRHK):', cur ? cur.name : x[1]); if (!nm || !nm.trim()) return Promise.resolve();
            return getToken(true).then(function () { return ensureFolders(S.role === 'waliAsrama' ? 'waliAsrama' : 'waliAsuh'); })
              .then(function () { return makeFolder(nm.trim().slice(0, 80), f.root.id); })
              .then(function (id) { f[x[0]] = { id: id, name: nm.trim().slice(0, 80) }; return api('saveSettings', { settings: { folders: f } }); })
              .then(function (r) { E.settings = r.settings; showMsg(m, 'Folder diperbarui. Laporan berikutnya masuk ke folder ini.', true); draw(); }, function (e) { showMsg(m, e.message, false); });
          })));
      });
      body.appendChild(h('div', { class: 'row' }, btn('Putuskan Drive dari aplikasi ini', 'd', function () {
        if (!confirm('Putuskan koneksi Drive? Berkas yang sudah ada tetap di Drive Anda.')) return Promise.resolve();
        if (E.gtoken && window.google && google.accounts) google.accounts.oauth2.revoke(E.gtoken, function () {});
        E.gtoken = null; E.driveOn = false; lsDel(uk('drive')); renderBar(); status('Drive diputus', 'warn'); mod.remove(); return Promise.resolve();
      })));
    }
    draw();
  }

  /* ---------- Akun ---------- */
  function openAccount() {
    var m = msgBox(), u = E.session.user;
    var mod = modal([h('button', { class: 'erhk-x', onclick: function () { mod.remove(); } }, '×'), h('h2', {}, 'Akun saya'),
      h('p', { class: 's' }, 'NIP ' + u.nip + ' · ' + u.email + ' · NIK ****' + u.nikLast4),
      h('h3', {}, 'Ganti password')].concat(field('Password lama', 'password', 'c_old', ''), field('Password baru', 'password', 'c_new', ''),
      [h('div', { class: 'row' }, btn('Ganti password', '', function () {
        return api('changePassword', { oldPassword: val('c_old'), newPassword: val('c_new') }).then(function (d) { showMsg(m, d.message, true); }, function (e) { showMsg(m, e.message, false); });
      })), m]));
  }

  /* ---------- Admin ---------- */
  function openAdmin() {
    var body = h('div', {}), m = msgBox();
    var mod = modal([h('button', { class: 'erhk-x', onclick: function () { mod.remove(); } }, '×'), h('h2', {}, 'Dashboard Admin'),
      h('p', { class: 's' }, 'Admin tidak dapat melihat password, OTP, NIK lengkap, maupun isi laporan. Setiap tindakan admin dicatat di audit log.'),
      h('div', { class: 'row' }, btn('Pengguna', 'g', users), btn('Audit log', 'g', audit)), body, m], true);
    function users() {
      return api('adminListUsers').then(function (d) {
        var t = h('table', {}, h('tr', {}, h('th', {}, 'NIP'), h('th', {}, 'Email'), h('th', {}, 'Status'), h('th', {}, 'Laporan'), h('th', {}, 'Login terakhir'), h('th', {}, '')));
        d.users.forEach(function (u) {
          t.appendChild(h('tr', {}, h('td', {}, u.nip), h('td', {}, u.email), h('td', {}, u.status), h('td', {}, String(u.reports)), h('td', {}, u.lastLogin ? fmtDate(u.lastLogin) : '-'),
            h('td', {}, (u.status === 'active' || u.status === 'disabled') && u.userId !== E.session.user.userId ? btn(u.status === 'active' ? 'Nonaktifkan' : 'Aktifkan', u.status === 'active' ? 'd' : '', function () {
              var why = prompt('Alasan (dicatat di audit log):', ''); if (why === null) return Promise.resolve();
              return api('adminSetStatus', { userId: u.userId, status: u.status === 'active' ? 'disabled' : 'active', reason: why }).then(users, function (e) { showMsg(m, e.message, false); });
            }) : '')));
        });
        body.innerHTML = ''; body.appendChild(t);
      }, function (e) { showMsg(m, e.message, false); });
    }
    function audit() {
      return api('adminAudit').then(function (d) {
        var t = h('table', {}, h('tr', {}, h('th', {}, 'Waktu'), h('th', {}, 'Pelaku'), h('th', {}, 'Aksi'), h('th', {}, 'Target'), h('th', {}, 'Rincian')));
        d.audit.forEach(function (a) { t.appendChild(h('tr', {}, h('td', {}, fmtDate(a.ts)), h('td', {}, a.actor), h('td', {}, a.action), h('td', {}, a.target), h('td', {}, a.detail))); });
        body.innerHTML = ''; body.appendChild(t);
      }, function (e) { showMsg(m, e.message, false); });
    }
    users();
  }

  /* ---------- kait ke v17 ---------- */
  function hook() {
    var origSave = window.save;
    window.save = function () { origSave.apply(this, arguments); onSave(); };
    var origReset = window.resetSemua;
    window.resetSemua = function () { origReset.apply(this, arguments); if (S && S.erhk) { delete S.erhk; } };
    window.addEventListener('beforeunload', function () { if (E.dirty && E.session) { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} } });
  }
  function boot() {
    hook(); renderBar();
    var saved = null; try { saved = JSON.parse(lsGet('easyrhk_session') || 'null'); } catch (e) {}
    if (CFG.API_URL && saved && saved.token) {
      E.session = saved;
      api('me').then(function (d) { E.session.user = d.user; E.settings = d.settings || {}; lsSet('easyrhk_session', JSON.stringify(E.session)); afterLogin(false); }, function () { E.session = null; lsDel('easyrhk_session'); authScreen(); });
      // layar penutup sementara sesi diperiksa
      var cover = h('div', { id: 'erhkAuth' }, h('div', { class: 'erhk-card' }, h('h2', {}, 'EasyRHK'), h('p', { class: 's' }, 'Memeriksa sesi…')));
      document.body.appendChild(cover); var iv = setInterval(function () { if (E.session && $e('erhkBar') && $e('erhkSt') && $e('erhkSt').textContent) { cover.remove(); clearInterval(iv); } else if (!E.session) { cover.remove(); clearInterval(iv); } }, 150);
    } else authScreen();
  }
  E._test = { externalize: externalize, hydrate: hydrate, ensureFolders: ensureFolders, syncNow: syncNow };
  boot();
})();
