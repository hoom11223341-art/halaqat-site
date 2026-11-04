// منطق الخادم: نفس عمليات خادم Google (init / version / all / batch / lookup) مع التخزين في Netlify Blobs
export const STATUSES = ['نشط', 'منسحب', 'منقول', 'متخرج'];
const MAX_FAILS = 40;

export function makeApi({ store, env, fetchFn, gasUrl, seed }) {
  const ADMIN = String(env('ADMIN_PASSWORD') || '');
  const VIEW = String(env('VIEW_PASSWORD') || '');
  const adminReady = () => !!ADMIN;
  const role = (pw) => {
    pw = String(pw == null ? '' : pw);
    if (!adminReady()) return 'admin';
    if (pw && pw === ADMIN) return 'admin';
    if (VIEW && pw === VIEW) return 'view';
    return 'view';
  };
  const empty = () => ({ students: {}, config: null, version: '0' });
  async function read() {
    let r = await store.getWithMetadata('db', { type: 'json' });
    if (!r && seed) {
      // أول تشغيل فقط (لم تُكتب القاعدة قط): تُملأ بالبيانات الأولية من ملف المتابعة
      const students = {};
      Object.keys(seed.students || {}).forEach((id) => { try { students[id] = cleanStudent(seed.students[id]); } catch (e) {} });
      let config = null;
      try { config = seed.config ? cleanConfig(seed.config) : null; } catch (e) {}
      await store.setJSON('db', { students, config, version: bump() }, { onlyIfNew: true });
      r = await store.getWithMetadata('db', { type: 'json' });
    }
    return r && r.data ? { db: r.data, etag: r.etag } : { db: empty(), etag: null };
  }
  async function write(db, etag) {
    const r = await store.setJSON('db', db, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    return r && r.modified !== false;
  }
  const bump = () => String(Date.now()) + '-' + Math.floor(Math.random() * 1000);
  const list = (db, strip) => Object.keys(db.students).map((id) => {
    const data = { ...db.students[id] };
    if (strip) delete data.nid;
    return { id, data };
  });

  async function lookup(raw) {
    const now = Date.now();
    let lk = (await store.get('lk', { type: 'json' })) || { n: 0, t: now };
    if (now - lk.t > 600000) lk = { n: 0, t: now };
    if (lk.n >= MAX_FAILS) return { error: 'busy' };
    const fail = async () => { lk.n++; await store.setJSON('lk', lk); return { ok: false }; };
    const nid = String(raw == null ? '' : raw)
      .replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 0x660)
      .replace(/[۰-۹]/g, (c) => c.charCodeAt(0) - 0x6F0).replace(/\D/g, '');
    if (nid.length < 5 || nid.length > 20) return fail();
    const { db } = await read();
    const all = list(db, false);
    const me = all.find((x) => x.data.nid && x.data.nid === nid);
    if (!me) return fail();
    const cfg = db.config || {};
    const hq = (cfg.halaqat || []).find((h) => h.name === me.data.halaqa);
    let n = 0, done = 0, tot = 0, sum = 0;
    all.forEach((x) => {
      if (x.data.halaqa !== me.data.halaqa || x.data.status !== 'نشط') return;
      n++;
      (x.data.tests || []).forEach((t) => { tot++; if (t.c) { done++; sum += t.g || 0; } });
    });
    const d = me.data;
    return {
      ok: true,
      s: { name: d.name, halaqa: d.halaqa, teacher: hq ? hq.teacher : '', curriculum: d.curriculum, level: d.level, status: d.status, tests: d.tests || [] },
      h: { n, done, tot, avg: done ? sum / done : null },
    };
  }

  async function batch(arg) {
    const ops = arg && Array.isArray(arg.ops) ? arg.ops : null;
    if (!ops || ops.length > 200) return { error: 'bad_request' };
    for (let attempt = 0; attempt < 6; attempt++) {
      const { db, etag } = await read();
      const next = { students: { ...db.students }, config: db.config, version: db.version };
      for (const o of ops) {
        if (o && o.k === 'student') {
          const id = String(o.id || '');
          if (!/^[A-Za-z0-9_-]{1,60}$/.test(id)) return { error: 'bad_request' };
          if (o.op === 'delete') delete next.students[id];
          else if (o.op === 'set') {
            try { next.students[id] = cleanStudent(o.data); } catch (e) { return { error: 'bad_request' }; }
          } else return { error: 'bad_request' };
        } else if (o && o.k === 'config' && o.op === 'set') {
          try { next.config = cleanConfig(o.data); } catch (e) { return { error: 'bad_request' }; }
        } else return { error: 'bad_request' };
      }
      next.version = bump();
      if (await write(next, etag)) return { version: next.version };
      await new Promise((r) => setTimeout(r, 120 + Math.random() * 300));
    }
    return { error: 'busy' };
  }

  async function migrate(arg) {
    const { db, etag } = await read();
    const have = Object.keys(db.students).length;
    if (have && !(arg && arg.force)) return { error: 'not_empty', count: have };
    const res = await fetchFn(gasUrl, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ pw: String((arg && arg.gpw) || ''), op: 'all' }) });
    const text = await res.text();
    let r;
    try { r = JSON.parse(text); } catch (e) { return { error: 'gas_not_ready' }; }
    if (!r || !Array.isArray(r.students)) return { error: r && r.needPassword ? 'gas_password' : 'gas_bad' };
    const students = {};
    let bad = 0;
    r.students.forEach((x) => {
      const id = String(x && x.id || '');
      if (!/^[A-Za-z0-9_-]{1,60}$/.test(id)) { bad++; return; }
      try { students[id] = cleanStudent(x.data); } catch (e) { bad++; }
    });
    let config = null;
    try { config = r.config ? cleanConfig(r.config) : null; } catch (e) { config = null; }
    const next = { students, config, version: bump() };
    if (!(await write(next, etag))) return { error: 'busy' };
    return { ok: true, students: Object.keys(students).length, skipped: bad, config: !!config, version: next.version };
  }

  return async function api(pw, op, arg) {
    if (op === 'lookup') return lookup(arg);
    const r = role(pw);
    if (op === 'init') return { role: r, needPassword: false, adminReady: adminReady() };
    if (op === 'version') { const { db } = await read(); return { version: db.version }; }
    if (op === 'all') { const { db } = await read(); return { role: r, version: db.version, students: list(db, r !== 'admin'), config: db.config }; }
    if (op === 'batch') { if (r !== 'admin') return { error: 'forbidden' }; return batch(arg); }
    if (op === 'migrate') { if (r !== 'admin') return { error: 'forbidden' }; return migrate(arg); }
    return { error: 'unknown_op' };
  };
}

/* ---------------- التحقق من المدخلات (منقول من Code.gs) ---------------- */
function cleanStudent(d) {
  if (!d || typeof d !== 'object') throw new Error('bad');
  const name = String(d.name || '').trim().slice(0, 200);
  const halaqa = String(d.halaqa || '').trim().slice(0, 200);
  const c = Math.round(Number(d.curriculum)), l = Math.round(Number(d.level));
  if (!name || !halaqa || !(c >= 1 && c <= 4) || !(l >= 1 && l <= 200)) throw new Error('bad');
  const tests = (Array.isArray(d.tests) ? d.tests : []).slice(0, 300).map((t) => {
    t = t || {};
    const g = (t.c && typeof t.g === 'number' && isFinite(t.g)) ? Math.max(0, Math.min(1, Math.round(t.g * 1e4) / 1e4)) : null;
    return { l: Math.round(Number(t.l)) || 1, t: t.t === 'n' ? 'n' : 'r', d: /^\d{4}-\d{2}-\d{2}$/.test(String(t.d || '')) ? t.d : '', c: g !== null, g };
  });
  return {
    name, halaqa, curriculum: c, level: l,
    status: STATUSES.indexOf(d.status) >= 0 ? d.status : 'نشط',
    notes: String(d.notes || '').slice(0, 2000),
    nid: String(d.nid || '').replace(/\D/g, '').slice(0, 20), tests,
  };
}
function numMap(o, lo, hi) {
  const r = {};
  Object.keys(o && typeof o === 'object' ? o : {}).slice(0, 40).forEach((k) => {
    const n = Number(o[k]);
    if (isFinite(n) && n >= lo && n <= hi) r[String(k).slice(0, 20)] = n;
  });
  return r;
}
function cleanConfig(d) {
  if (!d || typeof d !== 'object') throw new Error('bad');
  const halaqat = (Array.isArray(d.halaqat) ? d.halaqat : []).slice(0, 100)
    .map((h) => ({ name: String((h && h.name) || '').trim().slice(0, 200), teacher: String((h && h.teacher) || '').trim().slice(0, 200) }))
    .filter((h) => h.name);
  const examDates = (Array.isArray(d.examDates) ? d.examDates : []).slice(0, 400).map(String).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
  return {
    halaqat, examDates,
    weights: numMap(d.weights, 0, 100), targets: numMap(d.targets, 0, 100000), prev: numMap(d.prev, 0, 100000),
    term: String(d.term || '').slice(0, 100),
  };
}
