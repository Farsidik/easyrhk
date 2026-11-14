/* EasyRHK — lapisan akun + Google Drive personal di atas template v17.
 * Tidak mengubah susunan laporan v17. Menambah: login/daftar/OTP, simpan laporan ke Drive milik pengguna,
 * daftar laporan, folder per template, panel admin. Semua teks dari server ditampilkan sebagai teks (bukan HTML). */
(function () {
  'use strict';
  var CFG = window.EASYRHK_CONFIG || {};
  var SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var DRIVE = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  var E = { session: null, settings: {}, tokenClient: null, gtoken: null, gexp: 0, driveOn: false, local: false,
            busy: false, dirty: false, timer: null, imgMap: {}, imgCache: {}, dests: [], destFoto: {} };
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
  function folderInfo(id) {
    return driveFetch(DRIVE + '/files/' + encodeURIComponent(id) + '?fields=id,name,trashed,mimeType').then(function (r) { return r.json(); })
      .then(function (f) { return (!f.trashed && f.mimeType === 'application/vnd.google-apps.folder') ? f : null; }, function () { return null; });
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
  function ensureFolders(role, destId) {
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
      .then(function () {
        var base = { root: f.root.id, foto: f.foto.id, tpl: f[role].id };
        if (!destId) return base;
        return folderOk(destId).then(function (ok) {
          if (!ok) { status('Folder tujuan tidak bisa diakses — memakai folder otomatis', 'warn'); return base; }
          var cached = E.destFoto[destId];
          return (cached ? folderOk(cached) : Promise.resolve(false)).then(function (cok) {
            if (cok) return { root: base.root, foto: cached, tpl: destId };
            return makeFolder('Foto', destId).then(function (fid) { E.destFoto[destId] = fid; return { root: base.root, foto: fid, tpl: destId }; });
          });
        });
      });
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
    return getToken(false).then(function () { return ensureFolders(role, erhk.dest); })
      .then(function (fo) { return moveIfNeeded(erhk, fo.tpl).then(function () { return fo; }); })
      .then(function (fo) {
        return externalize(S, fo.foto).then(function (clone) {
          var title = erhk.title || titleOf(period); clone.erhk = { reportId: erhk.reportId || '', title: title };
          var body = JSON.stringify({ app: 'EasyRHK', v: 1, state: clone });
          return multipart({ id: erhk.fileId || null, name: title.replace(/[\\/:*?"<>|]/g, '-') + '.json', parent: fo.tpl, mime: 'application/json', body: body })
            .catch(function (e) { if (e.status === 404 && erhk.fileId) { erhk.fileId = null; return multipart({ name: title.replace(/[\\/:*?"<>|]/g, '-') + '.json', parent: fo.tpl, mime: 'application/json', body: body }); } throw e; })
            .then(function (fileId) {
              erhk.fileId = fileId; erhk.parentId = fo.tpl;
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
  /* bila folder tujuan laporan diganti, pindahkan berkas yang sudah ada; bila gagal, buat salinan baru di folder tujuan */
  function moveIfNeeded(erhk, target) {
    if (!erhk.fileId || erhk.parentId === target) return Promise.resolve();
    return driveFetch(DRIVE + '/files/' + encodeURIComponent(erhk.fileId) + '?fields=parents').then(function (r) { return r.json(); }).then(function (m) {
      var cur = (m.parents || [])[0];
      if (cur === target) { erhk.parentId = target; return; }
      return driveFetch(DRIVE + '/files/' + encodeURIComponent(erhk.fileId) + '?addParents=' + encodeURIComponent(target) + (cur ? '&removeParents=' + encodeURIComponent(cur) : '') + '&fields=id', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { erhk.parentId = target; });
    }).catch(function () { erhk.fileId = null; erhk.parentId = null; });
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

  /* ---------- logo & merek ---------- */
  var LOGO_INNER = "<defs><linearGradient id=\"g1@@\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0\" stop-color=\"#1d3f9e\"/><stop offset=\"1\" stop-color=\"#0891b2\"/></linearGradient><linearGradient id=\"g2@@\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0\" stop-color=\"#fb923c\"/><stop offset=\"1\" stop-color=\"#ea580c\"/></linearGradient><clipPath id=\"cp@@\"><rect width=\"120\" height=\"120\" rx=\"28\"/></clipPath><filter id=\"sh@@\" x=\"-20%\" y=\"-20%\" width=\"140%\" height=\"150%\"><feDropShadow dx=\"0\" dy=\"3\" stdDeviation=\"3\" flood-color=\"#0b1f4d\" flood-opacity=\".28\"/></filter></defs><rect width=\"120\" height=\"120\" rx=\"28\" fill=\"url(#g1@@)\"/><g clip-path=\"url(#cp@@)\"><circle cx=\"104\" cy=\"14\" r=\"34\" fill=\"#fff\" opacity=\".07\"/><circle cx=\"10\" cy=\"112\" r=\"30\" fill=\"#fff\" opacity=\".06\"/></g><!-- lembar laporan dengan sudut terlipat --><g filter=\"url(#sh@@)\"><path d=\"M30 20h37l23 23v53a6 6 0 0 1-6 6H30a6 6 0 0 1-6-6V26a6 6 0 0 1 6-6z\" fill=\"#fff\"/></g><path d=\"M67 20l23 23H73a6 6 0 0 1-6-6z\" fill=\"#bfdbfe\"/><!-- hati = pendampingan / kepedulian --><path d=\"M46 52.5c-5-3.6-9.5-7-9.5-11.2a5.4 5.4 0 0 1 9.5-3.5 5.4 5.4 0 0 1 9.5 3.5c0 4.2-4.5 7.6-9.5 11.2z\" fill=\"#0891b2\"/><!-- baris laporan --><rect x=\"33\" y=\"62\" width=\"40\" height=\"5\" rx=\"2.5\" fill=\"#c7d2e4\"/><rect x=\"33\" y=\"73\" width=\"30\" height=\"5\" rx=\"2.5\" fill=\"#dbe3f1\"/><rect x=\"33\" y=\"84\" width=\"22\" height=\"5\" rx=\"2.5\" fill=\"#dbe3f1\"/><!-- lencana centang = laporan selesai --><g filter=\"url(#sh@@)\"><circle cx=\"85\" cy=\"86\" r=\"19\" fill=\"url(#g2@@)\"/></g><circle cx=\"85\" cy=\"86\" r=\"19\" fill=\"none\" stroke=\"#fff\" stroke-width=\"3.5\"/><path d=\"M76 86.500l6.500 6.500L95 79.5\" fill=\"none\" stroke=\"#fff\" stroke-width=\"6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>";
  function logoSvg(px, pf) { return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="' + px + '" height="' + px + '" aria-hidden="true">' + LOGO_INNER.replace(/@@/g, pf) + '</svg>'; }
  function logo(px, pf) { var sp = document.createElement('span'); sp.style.display = 'inline-flex'; sp.style.flex = 'none'; sp.innerHTML = logoSvg(px, pf); return sp; }
  function setFavicon() {
    var l = document.querySelector('link[rel="icon"]') || document.head.appendChild(h('link', { rel: 'icon' }));
    l.setAttribute('type', 'image/svg+xml'); l.setAttribute('href', 'data:image/svg+xml,' + encodeURIComponent(logoSvg(64, 'fv').replace('aria-hidden="true"', '')));
  }
  function feat(ic, t, d) { return h('li', {}, h('span', { class: 'ic' }, ic), h('div', {}, h('b', {}, t), h('small', {}, d))); }
  function heroPanel() {
    return h('div', { class: 'erhk-hero' },
      h('div', { class: 'erhk-brand' }, logo(54, 'hb'), h('div', {}, h('b', {}, 'Easy', h('span', {}, 'RHK')), h('small', {}, 'Laporan pendampingan, lebih mudah.'))),
      h('div', { class: 'erhk-hl' }, h('h1', {}, 'Laporan RHK selesai lebih cepat dan lebih rapi.'),
        h('p', {}, 'Dirancang untuk Wali Asuh dan Wali Asrama: pilih RHK, sesuaikan kegiatan, tambahkan foto, lalu simpan sebagai PDF atau Word.')),
      h('ul', { class: 'erhk-ft' },
        feat('📝', 'Isi cepat', 'Narasi tiap RHK dan shift sudah disiapkan. Anda tinggal menyesuaikan.'),
        feat('☁️', 'Tersimpan di Drive Anda', 'Laporan dan foto masuk ke folder Google Drive milik Anda sendiri.'),
        feat('📄', 'PDF dan Word yang rapi', 'Foto potret dan lanskap tertata, bisa langsung dikirim ke folder pilihan.')),
      h('div', { class: 'erhk-c1' }), h('div', { class: 'erhk-c2' }),
      h('small', { class: 'erhk-cr' }, 'Template dibuat oleh IG: @Farsidik'));
  }
  var TITLES = { login: ['Selamat datang kembali', 'Masuk dengan NIP dan password Anda.'], register: ['Buat akun baru', 'Cukup sekali. Setelah itu langsung bisa membuat laporan.'],
    forgot: ['Atur ulang password', 'Kode reset dikirim ke email yang terdaftar.'], otp: ['Verifikasi email', 'Masukkan 6 digit kode yang dikirim ke email Anda.'], resetotp: ['Password baru', 'Masukkan kode dari email dan password baru Anda.'] };

  /* ---------- layar masuk / daftar ---------- */
  function authScreen() {
    var box = $e('erhkAuth'); if (box) box.remove();
    var card = h('div', { class: 'erhk-card' }), wrap = h('div', { id: 'erhkAuth' }, heroPanel(), h('div', { class: 'erhk-formwrap' }, card));
    document.body.appendChild(wrap);
    var tab = 'login', pendingNip = '';
    function draw(msg, ok) {
      card.innerHTML = '';
      var ti = TITLES[tab] || TITLES.login;
      card.appendChild(h('div', { class: 'erhk-chead' }, logo(40, 'cd'), h('div', {}, h('h2', {}, CFG.API_URL ? ti[0] : 'EasyRHK'), h('p', { class: 's' }, CFG.API_URL ? ti[1] : 'Laporan RHK Wali Asuh / Wali Asrama.'))));
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
    loadDests();
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
    var bar = h('div', { id: 'erhkBar', class: 'no-print' }, logo(22, 'tb'), h('b', {}, 'EasyRHK'));
    if (E.session) {
      bar.appendChild(h('span', {}, 'NIP ' + E.session.user.nip));
      bar.appendChild(h('button', { class: E.driveOn ? '' : 'pri', onclick: connectDrive }, E.driveOn ? '☁ Drive terhubung' : '☁ Hubungkan Drive'));
      bar.appendChild(h('button', { onclick: openReports }, '📚 Laporan saya'));
      bar.appendChild(h('button', { onclick: newReport }, '➕ Laporan baru'));
      bar.appendChild(h('button', { onclick: openFolders }, '📁 Folder Drive'));
      bar.appendChild(h('label', { style: 'display:flex;gap:4px;align-items:center' }, 'Simpan ke:', h('select', { id: 'erhkDest', onchange: destChange })));
      bar.appendChild(h('button', { class: 'pri', onclick: uploadPdf }, '📤 PDF → Drive'));
      bar.appendChild(h('button', { onclick: uploadWord }, '📤 Word → Drive'));
      bar.appendChild(h('button', { onclick: uploadFile, title: 'Unggah berkas PDF/Word yang sudah Anda simpan sendiri' }, '📤 Unggah berkas'));
      bar.appendChild(h('span', { id: 'erhkSt' }, ''));
      bar.appendChild(h('span', { class: 'sp' }));
      if (E.session.user.isAdmin) bar.appendChild(h('button', { onclick: openAdmin }, '🛡 Admin'));
      bar.appendChild(h('button', { onclick: openAccount }, '👤 Akun'));
      bar.appendChild(h('button', { onclick: logout }, 'Keluar'));
    } else { bar.appendChild(h('span', { id: 'erhkSt' }, 'Mode lokal')); }
    var top = $e('top'); top.insertBefore(bar, top.firstChild); syncDestSel();
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
      h('p', { class: 's' }, 'Aplikasi hanya dapat melihat folder/berkas yang ia buat sendiri atau yang Anda pilih lewat aplikasi (izin "drive.file"), bukan seluruh Drive Anda.'), body, m], true);
    function draw() {
      body.innerHTML = ''; var f = (E.settings.folders = E.settings.folders || {});
      body.appendChild(destSection(m, draw)); body.appendChild(h('h3', {}, 'Folder otomatis EasyRHK'));
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

  /* ---------- folder tujuan pilihan pengguna (link / Google Picker) ---------- */
  function loadDests() { try { E.dests = JSON.parse(lsGet(uk('dests')) || '[]'); } catch (e) { E.dests = []; } if (!Array.isArray(E.dests)) E.dests = []; }
  function saveDests() { lsSet(uk('dests'), JSON.stringify(E.dests)); syncDestSel(); }
  function addDest(id, name) {
    var nm = String(name || 'Folder Drive').slice(0, 80), ex = E.dests.filter(function (d) { return d.id === id; })[0];
    if (ex) ex.name = nm; else E.dests.push({ id: id, name: nm }); saveDests();
  }
  function parseFolderId(s) {
    s = String(s || '').trim();
    var m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{15,}$/.test(s) ? s : null;
  }
  function syncDestSel() {
    var sel = $e('erhkDest'); if (!sel || typeof S === 'undefined' || !S) return;
    var cur = (S.erhk && S.erhk.dest) || '', known = false;
    sel.innerHTML = '';
    sel.appendChild(h('option', { value: '' }, 'Otomatis (EasyRHK / Laporan ' + (S.role === 'waliAsrama' ? 'Wali Asrama' : 'Wali Asuh') + ')'));
    E.dests.forEach(function (d) { if (d.id === cur) known = true; sel.appendChild(h('option', { value: d.id }, d.name)); });
    if (cur && !known) sel.appendChild(h('option', { value: cur }, '(folder lain)'));
    sel.value = cur;
  }
  function destChange() {
    S.erhk = S.erhk || {}; S.erhk.dest = this.value; save();
    if (E.driveOn) syncNow(); else say('Pilihan folder tersimpan; berlaku saat Drive terhubung.');
  }
  function loadPicker() {
    return new Promise(function (res, rej) {
      if (window.google && google.picker) return res();
      function go() { gapi.load('picker', { callback: res, onerror: function () { rej({ message: 'Gagal memuat Google Picker.' }); } }); }
      if (window.gapi && gapi.load) return go();
      var sc = document.createElement('script'); sc.src = 'https://apis.google.com/js/api.js'; sc.async = true; sc.onload = go;
      sc.onerror = function () { rej({ message: 'Gagal memuat Google Picker. Periksa internet.' }); }; document.head.appendChild(sc);
    });
  }
  /** Jendela pemilih folder resmi Google. Memilih folder di sini adalah yang MEMBERI izin drive.file ke folder tersebut. */
  function pickFolder() {
    if (!CFG.GOOGLE_API_KEY) return Promise.reject({ message: 'GOOGLE_API_KEY belum diisi di config.js (lihat panduan Langkah Picker).' });
    return getToken(true).then(function (t) {
      return loadPicker().then(function () {
        return new Promise(function (res) {
          var view = new google.picker.DocsView(google.picker.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder');
          new google.picker.PickerBuilder().setAppId(String(CFG.GOOGLE_CLIENT_ID).split('-')[0]).setOAuthToken(t).setDeveloperKey(CFG.GOOGLE_API_KEY)
            .setOrigin(location.protocol + '//' + location.host).addView(view).enableFeature(google.picker.Feature.MULTISELECT_ENABLED).setTitle('Pilih satu atau beberapa folder tujuan laporan (tahan Ctrl untuk memilih banyak)').setLocale('id')
            .setCallback(function (d) { if (d.action === 'picked') res(d.docs || []); else if (d.action === 'cancel') res(null); }).build().setVisible(true);
        });
      });
    });
  }
  function doPick(m, redraw) {
    return pickFolder().then(function (docs) {
      if (!docs || !docs.length) return;
      docs.forEach(function (doc) { addDest(doc.id, doc.name); });
      showMsg(m, docs.length === 1 ? 'Folder "' + docs[0].name + '" ditambahkan dan siap dipakai.' : docs.length + ' folder ditambahkan dan siap dipakai.', true); redraw();
    }, function (e) { showMsg(m, e.message || 'Gagal membuka pemilih folder.', false); });
  }
  function addFromLink(text, m, redraw) {
    var id = parseFolderId(text);
    if (!id) return Promise.resolve(showMsg(m, 'Link folder tidak dikenali. Contoh: https://drive.google.com/drive/folders/1AbC...', false));
    return getToken(true).then(function () { return folderInfo(id); }).then(function (info) {
      if (info) { addDest(info.id, info.name); showMsg(m, 'Folder "' + info.name + '" ditambahkan.', true); redraw(); return; }
      if (!CFG.GOOGLE_API_KEY) return showMsg(m, 'Aplikasi belum punya izin ke folder itu (izin Drive hanya mencakup folder yang dibuat/dipilih lewat aplikasi). Pasang GOOGLE_API_KEY sesuai panduan lalu gunakan tombol "Pilih folder dari Drive saya".', false);
      showMsg(m, 'Izin ke folder ini belum ada (aturan keamanan Google, cukup sekali). Jendela pemilih dibuka: pilih folder tersebut lalu klik Pilih.', true);
      return doPick(m, redraw);
    }, function (e) { showMsg(m, e.message || 'Gagal.', false); });
  }
  function destSection(m, redraw) {
    var box = h('div', {}, h('h3', {}, 'Folder tujuan saya (folder Drive yang sudah Anda punya)'),
      h('p', { class: 's' }, 'Tambahkan folder Anda sendiri, lalu pilih folder mana yang dipakai untuk tiap laporan lewat menu "Simpan ke" di bilah atas.'));
    var list = h('div', { class: 'erhk-list' });
    if (!E.dests.length) list.appendChild(h('div', { class: 'erhk-item' }, 'Belum ada folder pilihan.'));
    E.dests.forEach(function (d) {
      list.appendChild(h('div', { class: 'erhk-item' }, h('div', { class: 't' }, h('b', {}, d.name)),
        h('a', { href: 'https://drive.google.com/drive/folders/' + encodeURIComponent(d.id), target: '_blank', rel: 'noopener' }, 'Buka'),
        btn('Hapus dari daftar', 'g', function () { E.dests = E.dests.filter(function (x) { return x.id !== d.id; }); saveDests(); redraw(); return Promise.resolve(); })));
    });
    var inp = h('input', { type: 'text', placeholder: 'Tempel link folder Drive…' });
    box.appendChild(list);
    box.appendChild(h('div', { class: 'row' }, inp, btn('Tambah dari link', '', function () { return addFromLink(inp.value, m, redraw); })));
    box.appendChild(h('div', { class: 'row' }, btn('📂 Pilih folder dari Drive saya', 'g', function () { return doPick(m, redraw); })));
    return box;
  }

  /* ---------- unggah hasil ke Drive ---------- */
  function targetFolder() {
    var role = S.role === 'waliAsrama' ? 'waliAsrama' : 'waliAsuh';
    return ensureFolders(role, S.erhk && S.erhk.dest).then(function (fo) { return fo.tpl; });
  }
  function uploadBlob(blob, name, mime) {
    if (!E.session || E.local) { alert('Masuk dan hubungkan Drive dulu.'); return Promise.resolve(); }
    status('Mengunggah ' + name + '…', '');
    return getToken(true).then(targetFolder).then(function (parent) { return multipart({ name: name, parent: parent, mime: mime || 'application/octet-stream', body: blob }); })
      .then(function (id) { status('Terunggah ke Drive ✓ ' + name, 'ok'); say('✓ ' + name + ' tersimpan di folder tujuan Drive'); return id; },
            function (e) { status('Gagal unggah: ' + (e.message || 'kesalahan'), 'err'); alert('Gagal mengunggah: ' + (e.message || 'kesalahan') + '\nPastikan Drive terhubung dan folder tujuan masih ada.'); });
  }
  function uploadWord() { return uploadBlob(new Blob(['﻿', buildWord()], { type: 'application/msword' }), fnama() + '.doc', 'application/msword'); }
  function uploadFile() {
    var inp = h('input', { type: 'file', accept: '.pdf,.doc,.docx,.png,.jpg,.jpeg', style: 'display:none' });
    inp.addEventListener('change', function () {
      var f = inp.files[0]; inp.remove(); if (!f) return;
      if (f.size > 25 * 1024 * 1024) return alert('Berkas lebih dari 25 MB. Kecilkan dulu.');
      uploadBlob(f, f.name.replace(/[\\/:*?"<>|]/g, '-'), f.type);
    });
    document.body.appendChild(inp); inp.click();
  }

  /* ---------- PDF langsung dari halaman, lalu unggah ke Drive ---------- */
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var sc = document.createElement('script'); sc.src = src; sc.onload = function () { res(); };
      sc.onerror = function () { rej({ message: 'Gagal memuat ' + src + '. Pastikan folder "vendor" ikut terunggah ke GitHub.' }); }; document.head.appendChild(sc);
    });
  }
  function loadPdfLibs() {
    return Promise.all([window.html2canvas ? 1 : loadScript('vendor/html2canvas.min.js'), (window.jspdf && window.jspdf.jsPDF) ? 1 : loadScript('vendor/jspdf.umd.min.js')]);
  }
  /** Titik potong halaman: hanya di sela blok (baris tabel, paragraf, foto), tidak memotong tengah teks/foto. */
  function pageBreaks(clone, pageH) {
    var base = clone.getBoundingClientRect().top, total = clone.scrollHeight, atoms = [], forced = [], heads = [];
    [].slice.call(clone.querySelectorAll('.hd, .it > table.kv')).forEach(function (el) { var r = el.getBoundingClientRect(); if (r.height > 1) heads.push([r.top - base, r.bottom - base]); });
    [].slice.call(clone.querySelectorAll('*')).forEach(function (el) {
      var r = el.getBoundingClientRect(); if (r.height < 1) return;
      var leaf = el.children.length === 0 && (el.textContent.trim() || el.tagName === 'IMG');
      if (leaf || el.tagName === 'TR' || el.tagName === 'IMG') atoms.push([r.top - base, r.bottom - base]);
      var cs = getComputedStyle(el); if ((cs.pageBreakBefore === 'always' || cs.breakBefore === 'page') && r.top - base > 5) forced.push(r.top - base);
    });
    var cuts = [0], top = 0, guard = 0;
    while (top < total - 2 && guard++ < 200) {
      var limit = top + pageH, f = forced.filter(function (y) { return y > top + 5 && y <= limit; }).sort(function (a, b) { return a - b; })[0], cut;
      if (f !== undefined) cut = f;
      else if (limit >= total) cut = total;
      else {
        var cand = atoms.map(function (a) { return a[0]; }).concat(atoms.map(function (a) { return a[1]; })).filter(function (y) { return y > top + pageH * 0.3 && y <= limit; }).sort(function (a, b) { return b - a; });
        cut = limit;
        for (var i = 0; i < cand.length; i++) { var y = cand[i]; if (!atoms.some(function (a) { return a[0] < y - 0.5 && a[1] > y + 0.5; })) { cut = y; break; } }
      }
      heads.forEach(function (hh) { if (f === undefined && cut < total && hh[1] > cut - 8 && hh[1] <= cut + 8 && hh[0] > top + pageH * 0.3) cut = hh[0]; });   // judul bagian/sub-judul ikut pindah ke halaman berikutnya
      cuts.push(cut); top = cut;
    }
    cuts[cuts.length - 1] = Math.max(cuts[cuts.length - 1], total);
    return cuts;
  }
  function makePdfBlob() {
    var dim = pageDim(), pw = dim[0], ph = dim[1], PX = 3.7795, cwMm = pw - 30, chMm = ph - 24, cwPx = Math.round(cwMm * PX), holder, pdf;
    return loadPdfLibs().then(function () {
      holder = h('div', { style: 'position:absolute;left:-99999px;top:0;width:' + cwPx + 'px;background:#fff' });
      holder.appendChild(h('style', {}, '[contenteditable]:empty:before{content:""!important}[contenteditable]{outline:none!important}.sg{outline:none!important}.gb{background:none!important}.lamp{margin-top:0!important}'));
      var clone = $e('doc').cloneNode(true);
      clone.style.cssText = 'margin:0;padding:0;width:' + cwPx + 'px;zoom:1;box-shadow:none;background:#fff;transform:none'; clone.classList.add('hide-allctl', 'hide-kopctl');
      [].slice.call(clone.querySelectorAll('.no-print,.pg,.add,.ctl')).forEach(function (n) { n.remove(); });   // tombol/isian penyunting tidak ikut tercetak, sama seperti aturan cetak v17
      holder.appendChild(clone); document.body.appendChild(holder);
      var imgs = [].slice.call(clone.querySelectorAll('img')).map(function (im) { return im.complete ? 1 : new Promise(function (r) { im.onload = im.onerror = r; }); });
      return Promise.all(imgs).then(function () { return clone; });
    }).then(function (clone) {
      var cuts = pageBreaks(clone, chMm * PX), jsPDF = window.jspdf.jsPDF, chain = Promise.resolve();
      pdf = new jsPDF({ unit: 'mm', format: [Math.min(pw, ph), Math.max(pw, ph)], orientation: pw > ph ? 'landscape' : 'portrait', compress: true });
      for (var i = 0; i < cuts.length - 1; i++) (function (i) {
        chain = chain.then(function () {
          var y0 = cuts[i], y1 = cuts[i + 1]; status('Membuat PDF… halaman ' + (i + 1) + ' dari ' + (cuts.length - 1), '');
          return html2canvas(clone, { scale: 2, backgroundColor: '#fff', useCORS: true, logging: false, x: 0, y: Math.floor(y0), width: cwPx, height: Math.ceil(y1 - y0), windowWidth: cwPx, scrollX: 0, scrollY: 0 }).then(function (cv) {
            if (i > 0) pdf.addPage();
            pdf.addImage(cv.toDataURL('image/jpeg', 0.92), 'JPEG', 15, 12, cwMm, (y1 - y0) / PX, undefined, 'FAST');
          });
        });
      })(i);
      return chain.then(function () { return pdf.output('blob'); });
    }).then(function (b) { if (holder) holder.remove(); return b; }, function (e) { if (holder) holder.remove(); throw e; });
  }
  function downloadBlob(blob, name) { var a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); }, 1000); }
  function uploadPdf() {
    if (!E.session || E.local) { alert('Masuk dan hubungkan Drive dulu.'); return Promise.resolve(); }
    var name = fnama() + '.pdf', erhk = (S.erhk = S.erhk || {});
    status('Membuat PDF…', '');
    return makePdfBlob().then(function (blob) {
      status('Mengunggah PDF…', '');
      return getToken(true).then(targetFolder).then(function (parent) {
        var upd = erhk.pdfId && erhk.pdfParent === parent ? erhk.pdfId : null;
        return multipart({ id: upd, name: name, parent: parent, mime: 'application/pdf', body: blob })
          .catch(function (e) { if (e.status === 404 && upd) return multipart({ name: name, parent: parent, mime: 'application/pdf', body: blob }); throw e; })
          .then(function (id) { erhk.pdfId = id; erhk.pdfParent = parent; try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} return id; });
      }).then(function (id) {
        status('PDF terunggah ✓ ' + name, 'ok');
        var mod = modal([h('h2', {}, 'PDF tersimpan di Drive'), h('p', { class: 's' }, name + ' (' + Math.round(blob.size / 1024) + ' KB). Unggah ulang pada laporan yang sama akan memperbarui berkas ini, bukan membuat salinan baru.'),
          h('div', { class: 'row' }, h('a', { href: 'https://drive.google.com/file/d/' + encodeURIComponent(id) + '/view', target: '_blank', rel: 'noopener' }, 'Buka di Drive'), btn('Tutup', 'g', function () { mod.remove(); return Promise.resolve(); }))]);
      }, function (e) {
        downloadBlob(blob, name); status('Gagal unggah — PDF diunduh ke komputer', 'err');
        alert('PDF sudah dibuat tetapi gagal diunggah (' + (e.message || 'kesalahan') + '). Salinannya diunduh ke komputer Anda. Pastikan Drive terhubung lalu coba lagi.');
      });
    }, function (e) { status('Gagal membuat PDF', 'err'); alert('Gagal membuat PDF: ' + (e && e.message || 'kesalahan') + '\nSebagai gantinya gunakan Unduh PDF lalu "📤 Unggah PDF".'); });
  }

  /* ---------- perbaikan ekspor Word: foto potret/lanskap dihitung ulang agar muat di kotaknya ---------- */
  function fixWordGallery(html) {
    var d = new DOMParser().parseFromString(html, 'text/html'), imgs = [].slice.call(d.querySelectorAll('.gal img'));
    var sp = d.querySelector('.ttd-space'); if (sp && sp.querySelector('img')) sp.style.textAlign = 'left';   // posisi gambar tanda tangan dihitung dari tepi kiri blok
    var wrapHtml = function () { return '<html ' + [].slice.call(d.documentElement.attributes).map(function (a) { return a.name + '="' + a.value.replace(/"/g, '&quot;') + '"'; }).join(' ') + '>' + d.documentElement.innerHTML + '</html>'; };
    if (!imgs.length) return sp ? wrapHtml() : html;
    var live = [].slice.call(document.querySelectorAll('#doc .gal img')), L = S.lamp, n = L.cols || 3, dim = pageDim();
    var cellW = Math.floor((dim[0] - 30) * 3.7795 / n - 10);                                  // lebar isi halaman (margin 1,5 cm) dibagi kolom
    var maxH = L.mode === 'asli' ? Math.floor((dim[1] - 40) * 3.7795 * 0.45) : Math.max(60, Number(L.h) || 145);
    imgs.forEach(function (im, i) {
      var src = live[i], nw = (src && src.naturalWidth) || 800, nh = (src && src.naturalHeight) || 600;
      var r = Math.min(cellW / nw, maxH / nh);
      im.setAttribute('width', String(Math.max(1, Math.round(nw * r)))); im.setAttribute('height', String(Math.max(1, Math.round(nh * r)))); im.removeAttribute('style');
    });
    [].slice.call(d.querySelectorAll('.gal .gb')).forEach(function (g) { g.removeAttribute('style'); g.setAttribute('align', 'center'); });
    [].slice.call(d.querySelectorAll('.gal td')).forEach(function (td) { td.setAttribute('align', 'center'); td.setAttribute('valign', 'top'); });
    return wrapHtml();
  }

  /* ---------- kait ke v17 ---------- */
  function hook() {
    var origSave = window.save;
    window.save = function () { origSave.apply(this, arguments); onSave(); };
    var origRender = window.render;
    window.render = function () { origRender.apply(this, arguments); syncDestSel(); };
    var origWord = window.buildWord;
    window.buildWord = function () { var html = origWord.apply(this, arguments); try { return fixWordGallery(html); } catch (e) { return html; } };
    window.addEventListener('afterprint', function () { if (E.session && E.driveOn) say('Mau PDF langsung masuk Drive tanpa unduh? Pakai tombol "📤 PDF → Drive" di bilah atas.'); });
    /* Blok tanda tangan: blok tetap di kanan, isinya (tanggal, nama, NIP) rata tengah atau rata kiri.
       Nilai lama (r/c/l) tetap dipakai apa adanya. Laporan lama yang masih "r" (bawaan) dipindah ke "rc" sekali saja. */
    var sel = $e('ttdAl');
    if (sel) { sel.innerHTML = ''; [['rc', 'Blok kanan · teks rata tengah (disarankan)'], ['rl', 'Blok kanan · teks rata kiri'], ['r', 'Rata kanan'], ['c', 'Blok di tengah'], ['l', 'Blok di kiri']].forEach(function (o) { sel.appendChild(h('option', { value: o[0] }, o[1])); }); }
    var origTtd = window.ttdHTML;
    window.ttdHTML = function () {
      var html = origTtd.apply(this, arguments), a = S.ttd && S.ttd.al;
      if (a === 'rc') return html.replace('text-align:right;', 'text-align:center;');
      if (a === 'rl') return html.replace('text-align:right;', 'text-align:left;');
      return html;
    };
    var origLoad = window.load;
    function migrateTtd() { if (S && S.ttd && !S.ttd.v2) { S.ttd.v2 = 1; if (S.ttd.al === 'r' || !S.ttd.al) { S.ttd.al = 'rc'; return true; } } return false; }
    window.load = function () { origLoad.apply(this, arguments); migrateTtd(); };
    if (migrateTtd()) render();
    var origReset = window.resetSemua;
    window.resetSemua = function () { origReset.apply(this, arguments); if (S && S.erhk) { delete S.erhk; } };
    window.addEventListener('beforeunload', function () { if (E.dirty && E.session) { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} } });
  }
  function boot() {
    hook(); setFavicon(); renderBar();
    var saved = null; try { saved = JSON.parse(lsGet('easyrhk_session') || 'null'); } catch (e) {}
    if (CFG.API_URL && saved && saved.token) {
      E.session = saved;
      api('me').then(function (d) { E.session.user = d.user; E.settings = d.settings || {}; lsSet('easyrhk_session', JSON.stringify(E.session)); afterLogin(false); }, function () { E.session = null; lsDel('easyrhk_session'); authScreen(); });
      // layar penutup sementara sesi diperiksa
      var cover = h('div', { id: 'erhkAuth', class: 'erhk-cover' }, h('div', { class: 'erhk-card' }, h('h2', {}, 'EasyRHK'), h('p', { class: 's' }, 'Memeriksa sesi…')));
      document.body.appendChild(cover); var iv = setInterval(function () { if (E.session && $e('erhkBar') && $e('erhkSt') && $e('erhkSt').textContent) { cover.remove(); clearInterval(iv); } else if (!E.session) { cover.remove(); clearInterval(iv); } }, 150);
    } else authScreen();
  }
  E._test = { makePdfBlob: makePdfBlob, externalize: externalize, hydrate: hydrate, ensureFolders: ensureFolders, syncNow: syncNow };
  boot();
})();
