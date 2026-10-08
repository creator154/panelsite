require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const Batch = require('./models/Batch');
const Test = require('./models/Test');
const User = require('./models/User');
const UploaderToken = require('./models/UploaderToken');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';
const PENPENCIL_API_TOKEN = process.env.PENPENCIL_API_TOKEN || '';
const PENPENCIL_CLIENT_ID = process.env.PENPENCIL_CLIENT_ID || '5eb393ee95fc740011883134';
const PENPENCIL_ALT_CLIENT_ID = '5eb393ee95fab7468a79d189';
const PENPENCIL_BASE = (process.env.PENPENCIL_BASE || 'https://api.penpencil.co').replace(/\/$/, '');
const PENPENCIL_BATCHES_PATH = process.env.PENPENCIL_BATCHES_PATH ||
  '/batch-service/v1/batches/purchased-batches?page=1&type=ALL&amount=paid';
const PENPENCIL_BATCH_DETAILS_PATH = process.env.PENPENCIL_BATCH_DETAILS_PATH || '/v3/batches/{batchId}/details';
const PENPENCIL_TESTS_PATH = process.env.PENPENCIL_TESTS_PATH ||
  '/v3/test-service/tests/check-tests?testSource=BATCH_QUIZ&batchId={batchId}';
const PENPENCIL_DPPS_PATH = process.env.PENPENCIL_DPPS_PATH ||
  '/v3/test-service/tests/dpp?batchId={batchId}&isSubjective=false';
const PENPENCIL_TEST_DETAIL_PATH = process.env.PENPENCIL_TEST_DETAIL_PATH || '/v3/tests/{testId}';
const MAX_PAGES = Math.max(1, Number(process.env.PENPENCIL_MAX_PAGES) || 500);
const SESSION_TTL_MS = Math.max(60_000, Number(process.env.SOURCE_SESSION_TTL_MS) || 7 * 24 * 60 * 60 * 1000);
const sourceSessions = new Map();
const profileCache = new Map();

if (!Batch.schema.path('sourceBatchId')) {
  Batch.schema.add({ sourceBatchId: { type: String, index: true } });
}

function decodeJwtPayload(t) {
  try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString()); }
  catch { return null; }
}
function findOrgId(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return '';
  for (const [k, v] of Object.entries(obj)) {
    if (/^(organizationId|orgId|organization_id)$/i.test(k) && typeof v === 'string') return v;
    if (/^organization$/i.test(k)) {
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object' && (v._id || v.id)) return String(v._id || v.id);
    }
  }
  for (const v of Object.values(obj)) if (v && typeof v === 'object') {
    const found = findOrgId(v, depth + 1); if (found) return found;
  }
  return '';
}
function sourceArray(data) {
  const candidates = [
    data?.data, data?.data?.data, data?.data?.batches, data?.data?.items,
    data?.data?.results, data?.results, data?.items, data?.batches,
    data?.tests, data?.dpps, data
  ];
  for (const c of candidates) if (Array.isArray(c)) return c;
  return [];
}
function getSourceBatchId(batch) {
  return batch ? String(batch._id || batch.id || batch.batchId || batch.batch_id || '') : '';
}
function hashToken(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
function generateUploaderToken() { return crypto.randomBytes(32).toString('hex'); }
function looksLikeJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts.some(p => !p)) return false;
  const payload = decodeJwtPayload(token);
  return !!payload && typeof payload === 'object' && (!payload.exp || payload.exp * 1000 >= Date.now());
}
function buildSourcePath(template, values = {}) {
  let path = String(template);
  for (const [key, value] of Object.entries(values)) {
    path = path.replace(new RegExp(`\\{${key}\\}`, 'g'), encodeURIComponent(String(value)));
  }
  return path;
}
function withPage(basePath, page) {
  const url = new URL(String(basePath), 'https://placeholder.invalid');
  url.searchParams.set('page', String(page));
  return /^https?:\/\//i.test(String(basePath)) ? url.toString() : url.pathname + url.search;
}
function cleanExpiredSessions() {
  const now = Date.now();
  for (const [key, value] of sourceSessions) if (value.expiresAt <= now) sourceSessions.delete(key);
}
function sign(user) {
  const payload = {
    sub: String(user._id || user.sub || ''),
    username: user.username || 'Uploader',
    role: user.role || 'Batch Uploader',
    scope: user.scope || 'all'
  };
  if (user.scope === 'batches') {
    if (user.sessionId) payload.sid = user.sessionId;
    else payload.batchIds = (user.batchIds || []).map(String);
  }
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}
function auth(req, res, next) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ success: false, message: 'Authentication required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    if (req.user.sid) {
      cleanExpiredSessions();
      const session = sourceSessions.get(req.user.sid);
      if (!session) return res.status(401).json({ success: false, message: 'Source login expired; please sign in again' });
      req.sourceSession = session;
    }
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}
function masterOnly(req, res, next) {
  if (req.user?.scope === 'all') return next();
  return res.status(403).json({ success: false, message: 'Master access required' });
}
function canAccessBatch(req, batchId) {
  if (!req.user) return false;
  if (req.user.scope === 'all') return true;
  if (req.sourceSession?.localBatchIds?.has(String(batchId))) return true;
  return (req.user.batchIds || []).map(String).includes(String(batchId));
}
async function getAllowedBatchIds(req) {
  if (req.user.scope === 'all') return null;
  return (req.user.batchIds || []).map(String);
}
function ppTokenOf(req) { return req.sourceSession?.ppToken || ''; }
function sourceBatchSet(req) { return req.sourceSession?.sourceBatchIds || null; }
async function canAccessSourceBatch(req, sourceBatchId) {
  if (!req.user) return false;
  if (req.user.scope === 'all') return true;
  const sessionSet = sourceBatchSet(req);
  if (sessionSet) return sessionSet.has(String(sourceBatchId));
  const localIds = (req.user.batchIds || []).map(String);
  if (!localIds.length) return false;
  return !!(await Batch.findOne({
    _id: { $in: localIds }, sourceBatchId: String(sourceBatchId), active: true
  }).select('_id').lean());
}
async function getAllowedSourceBatchIds(req) {
  if (req.user.scope === 'all') return null;
  const sessionSet = sourceBatchSet(req);
  if (sessionSet) return [...sessionSet];
  const localIds = (req.user.batchIds || []).map(String);
  if (!localIds.length) return [];
  const batches = await Batch.find({
    _id: { $in: localIds }, active: true, sourceBatchId: { $exists: true, $ne: '' }
  }).select('sourceBatchId').lean();
  return batches.map(b => String(b.sourceBatchId)).filter(Boolean);
}

async function penpencilCall(url, token, clientId, clientType) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`, Accept: '*/*', 'Content-Type': 'application/json',
      'Client-Id': clientId, 'Client-Type': clientType, 'Client-Version': '5.2.15',
      Origin: 'https://www.pw.live', Referer: 'https://www.pw.live/',
      'User-Agent': 'Mozilla/5.0', 'x-sdk-version': '0.0.28'
    }
  });
  const bodyText = await response.text();
  let data = {};
  try { data = bodyText ? JSON.parse(bodyText) : {}; } catch { data = { raw: bodyText }; }
  return { ok: response.ok, status: response.status, data, retryAfter: response.headers.get('retry-after') };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function penpencilRequest(path, tokenOverride) {
  const token = tokenOverride || PENPENCIL_API_TOKEN;
  if (!token) throw new Error('PenPencil token missing: sign in with your own token or configure PENPENCIL_API_TOKEN');
  const cleanPath = String(path).startsWith('/') ? String(path) : `/${path}`;
  const url = /^https?:\/\//i.test(cleanPath) ? cleanPath : PENPENCIL_BASE + cleanPath;
  const payload = decodeJwtPayload(token);
  const org = findOrgId(payload);
  let profiles;
  if (profileCache.has(token)) profiles = [profileCache.get(token)];
  else {
    const ids = [...new Set([org, PENPENCIL_CLIENT_ID, PENPENCIL_ALT_CLIENT_ID].filter(Boolean))];
    profiles = ids.flatMap(id => ['WEB', 'ANDROID'].map(type => ({ id, type })));
  }
  let last = { status: 502, data: {} };
  for (const p of profiles) {
    let result;
    for (let attempt = 0; attempt < 4; attempt++) {
      result = await penpencilCall(url, token, p.id, p.type);
      if (result.status !== 429 && result.status < 500) break;
      if (attempt < 3) {
        const retryMs = Math.min(30_000, Math.max(1500, Number(result.retryAfter) * 1000 || (1500 * (attempt + 1))));
        await sleep(retryMs);
      }
    }
    if (result.ok) {
      if (profileCache.size > 1000) profileCache.clear();
      profileCache.set(token, p);
      return result.data;
    }
    last = result;
    if (![400, 401, 403, 429].includes(result.status)) break;
    if ([401, 403].includes(result.status)) continue;
    if (result.status === 429) break;
  }
  const d = last.data || {};
  const err = new Error(d.message || d.error?.message || (typeof d.error === 'string' ? d.error : '') || `PenPencil API returned ${last.status}`);
  err.upstreamStatus = last.status;
  throw err;
}
async function fetchBatchPage(page, token, basePath) {
  return penpencilRequest(withPage(basePath, page), token);
}
async function fetchAllSourceBatches(token, basePath = PENPENCIL_BATCHES_PATH, maxPages = MAX_PAGES) {
  const all = [], seen = new Set();
  let firstData = null, emptyPages = 0;
  for (let page = 1; page <= maxPages; page++) {
    let data;
    try {
      data = await fetchBatchPage(page, token, basePath);
    } catch (e) {
      if (e.upstreamStatus === 429) {
        console.warn(`PenPencil page ${page} rate-limited after retries; stopping safely.`, e.message);
        break;
      }
      if (page === 1) throw e;
      console.warn(`PenPencil page ${page} failed; stopping pagination:`, e.message);
      break;
    }
    if (!firstData) firstData = data;
    const rows = sourceArray(data);
    if (!rows.length) break;
    let added = 0;
    for (const batch of rows) {
      const id = getSourceBatchId(batch);
      if (!id || seen.has(id)) continue;
      seen.add(id); all.push(batch); added++;
    }
    emptyPages = added ? 0 : emptyPages + 1;
    if (emptyPages >= 2) break;
    // APIs commonly return fewer rows on the final page.
    if (rows.length === 0) break;
    await sleep(Math.max(250, Number(process.env.PENPENCIL_PAGE_DELAY_MS) || 700));
  }
  console.log('Source batches fetched (unique):', all.length);
  return { data: firstData, batches: all };
}
const BATCH_PATH_CANDIDATES = [
  '/batch-service/v1/batches/purchased-batches?page=1&type=ALL&amount=paid',
  '/v3/batches/my-batches?filter=true&amount=paid',
  '/v2/batches/my-batches?mode=1',
  '/v3/batches/all-purchased-batches?type=ALL',
  '/v3/batches/all-purchased-batches',
  '/v3/batches/purchased-batches'
];
async function checkUserSpecific(path, token) {
  const mineData = await fetchBatchPage(1, token, path);
  const mine = sourceArray(mineData).map(getSourceBatchId).filter(Boolean);
  if (!mine.length) return { ok: false, reason: 'empty list' };
  // Purchased-batches route is an authenticated endpoint; successful non-empty
  // response with a real JWT is sufficient. Avoid sending a fake token repeatedly.
  return { ok: true, reason: 'authenticated route returned batches' };
}
async function loginWithSourceToken(ppToken) {
  if (!looksLikeJwt(ppToken)) return { success: false, message: 'Invalid or expired PenPencil JWT token' };
  const candidates = process.env.PENPENCIL_BATCHES_PATH
    ? [process.env.PENPENCIL_BATCHES_PATH]
    : [...new Set([...BATCH_PATH_CANDIDATES, PENPENCIL_BATCHES_PATH])];
  let list = null, basePath = '', firstError = '';
  for (const candidate of candidates) {
    try {
      const check = await checkUserSpecific(candidate, ppToken);
      if (check.ok) {
        basePath = candidate;
        const fetched = await fetchAllSourceBatches(ppToken, candidate);
        list = fetched.batches;
        if (list.length) break;
      }
    } catch (e) {
      firstError = firstError || e.message;
      console.warn('Batch route probe failed:', candidate, e.message);
    }
  }
  if (!list || !list.length) return {
    success: false,
    message: 'Could not load batches for this token. ' + (firstError || 'No batches returned; check token and API route.')
  };

  const sourceIds = [...new Set(list.map(getSourceBatchId).filter(Boolean))];
  // Upsert source batches in chunks, without embedding their IDs in JWT.
  for (let i = 0; i < list.length; i += 250) {
    const chunk = list.slice(i, i + 250);
    const ops = chunk.map(item => {
      const sourceBatchId = getSourceBatchId(item);
      return {
        updateOne: {
          filter: { sourceBatchId },
          update: { $setOnInsert: {
            name: String(item.name || item.title || 'Source Batch').trim(),
            category: 'Other Batch Tests', subgroup: '', exam: '',
            language: item.language || 'Hindi', status: 'Paid', active: true, sourceBatchId
          } },
          upsert: true
        }
      };
    });
    if (ops.length) await Batch.bulkWrite(ops, { ordered: false });
  }
  cleanExpiredSessions();
  const localRows = await Batch.find({ sourceBatchId: { $in: sourceIds }, active: true }).select('_id sourceBatchId').lean();
  const localBatchIds = new Set(localRows.map(b => String(b._id)));
  const sessionId = crypto.randomBytes(24).toString('hex');
  sourceSessions.set(sessionId, {
    ppToken,
    basePath,
    sourceBatchIds: new Set(sourceIds),
    localBatchIds,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  const token = sign({
    _id: 'source-' + hashToken(ppToken).slice(0, 12),
    username: 'PW Batch Uploader',
    role: 'Batch Uploader',
    scope: 'batches',
    sessionId
  });
  return { success: true, token, role: 'Batch Uploader', scope: 'batches', batchCount: sourceIds.length };
}
function contentType(param) { return param === 'dpp' || param === 'dpps' ? 'dpp' : 'test'; }
function sourceError(res, error, extra = {}) {
  const status = error.upstreamStatus === 429 ? 503 : 502;
  return res.status(status).json({
    success: false, message: error.message, upstreamStatus: error.upstreamStatus || null, ...extra
  });
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'zx-backend' }));
app.get('/', (req, res) => res.json({ ok: true, service: 'zx-backend', message: 'ZX backend is running' }));

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const authToken = String(req.body?.authToken || '').trim().replace(/^Bearer\s+/i, '');
    if (authToken) {
      if (process.env.ADMIN_AUTH_TOKEN && authToken === process.env.ADMIN_AUTH_TOKEN) {
        const token = sign({ _id: 'master-token-user', username: 'Master Admin', role: 'Batch Uploader', scope: 'all', batchIds: [] });
        return res.json({ success: true, token, role: 'Batch Uploader', scope: 'all' });
      }
      const uploader = await UploaderToken.findOne({ tokenHash: hashToken(authToken), active: true }).populate('batchIds');
      if (uploader) {
        const assignedBatchIds = (uploader.batchIds || []).map(b => b?._id).filter(Boolean).map(String);
        const token = sign({ _id: uploader._id, username: uploader.name, role: 'Batch Uploader', scope: 'batches', batchIds: assignedBatchIds });
        return res.json({ success: true, token, role: 'Batch Uploader', scope: 'batches', batchIds: assignedBatchIds });
      }
      if (process.env.ALLOW_SOURCE_TOKEN_LOGIN === 'false') {
        return res.status(401).json({ success: false, message: 'Invalid or inactive auth token' });
      }
      const sourceLogin = await loginWithSourceToken(authToken);
      if (!sourceLogin.success) return res.status(502).json(sourceLogin);
      return res.json(sourceLogin);
    }
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required' });
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ success: false, message: 'Invalid login' });
    const token = sign({ _id: user._id, username: user.username, role: user.role, scope: 'all', batchIds: [] });
    return res.json({ success: true, token, role: user.role, scope: 'all' });
  } catch (e) {
    console.error('Login error:', e);
    return res.status(500).json({ success: false, message: 'Login failed', detail: e.message });
  }
});

app.get('/api/public/batches', async (req, res) => {
  try {
    const batches = await Batch.find({ active: true }).sort({ category: 1, name: 1 });
    return res.json({ success: true, batches });
  } catch (e) {
    console.error(e); return res.status(500).json({ success: false, message: 'Failed to load batches' });
  }
});
app.get('/api/public/batches/:id/:type', async (req, res) => {
  try {
    const items = await Test.find({ batchId: req.params.id, type: contentType(req.params.type), published: true }).sort({ startTime: -1, createdAt: -1 });
    return res.json({ success: true, items });
  } catch (e) { console.error(e); return res.status(500).json({ success: false, message: 'Failed to load content' }); }
});

app.get('/api/admin/me', auth, async (req, res) => res.json({
  success: true, user: {
    sub: req.user.sub, username: req.user.username, role: req.user.role,
    scope: req.user.scope || 'all', batchIds: req.user.batchIds || [],
    batchCount: req.sourceSession?.sourceBatchIds?.size || undefined
  }
}));

app.get('/api/admin/source/batches', auth, async (req, res) => {
  try {
    const usedToken = ppTokenOf(req);
    if (usedToken) {
      const fetched = await fetchAllSourceBatches(usedToken, req.sourceSession.basePath);
      const allowed = sourceBatchSet(req);
      const batches = fetched.batches.filter(b => allowed?.has(getSourceBatchId(b)));
      return res.json({ success: true, data: fetched.data, batches });
    }
    const fetched = await fetchAllSourceBatches(PENPENCIL_API_TOKEN, PENPENCIL_BATCHES_PATH);
    let batches = fetched.batches;
    if (req.user.scope !== 'all') {
      const allowed = new Set(await getAllowedSourceBatchIds(req));
      batches = batches.filter(b => allowed.has(getSourceBatchId(b)));
    }
    return res.json({ success: true, data: fetched.data, batches });
  } catch (e) { console.error('PenPencil batches error:', e.message); return sourceError(res, e, { batches: [] }); }
});

app.get('/api/admin/source/batches/:batchId/details', auth, async (req, res) => {
  try {
    const id = String(req.params.batchId);
    if (!(await canAccessSourceBatch(req, id))) return res.status(403).json({ success: false, message: 'You do not have access to this source batch' });
    const data = await penpencilRequest(buildSourcePath(PENPENCIL_BATCH_DETAILS_PATH, { batchId: id }), ppTokenOf(req));
    return res.json({ success: true, data });
  } catch (e) { console.error(e); return sourceError(res, e); }
});
app.get('/api/admin/source/batches/:batchId/tests', auth, async (req, res) => {
  try {
    const id = String(req.params.batchId);
    if (!(await canAccessSourceBatch(req, id))) return res.status(403).json({ success: false, message: 'You do not have access to this source batch', items: [] });
    const data = await penpencilRequest(buildSourcePath(PENPENCIL_TESTS_PATH, { batchId: id }), ppTokenOf(req));
    return res.json({ success: true, data, items: sourceArray(data) });
  } catch (e) { console.error(e); return sourceError(res, e, { items: [] }); }
});
app.get('/api/admin/source/batches/:batchId/dpps', auth, async (req, res) => {
  try {
    const id = String(req.params.batchId);
    if (!(await canAccessSourceBatch(req, id))) return res.status(403).json({ success: false, message: 'You do not have access to this source batch', items: [] });
    const data = await penpencilRequest(buildSourcePath(PENPENCIL_DPPS_PATH, { batchId: id }), ppTokenOf(req));
    return res.json({ success: true, data, items: sourceArray(data) });
  } catch (e) { console.error(e); return sourceError(res, e, { items: [] }); }
});
app.get('/api/admin/source/tests/:testId', auth, async (req, res) => {
  try {
    const batchId = req.query.batchId ? String(req.query.batchId) : '';
    if (batchId && !(await canAccessSourceBatch(req, batchId))) return res.status(403).json({ success: false, message: 'You do not have access to this source batch' });
    const data = await penpencilRequest(buildSourcePath(PENPENCIL_TEST_DETAIL_PATH, { testId: req.params.testId }), ppTokenOf(req));
    return res.json({ success: true, data });
  } catch (e) { console.error(e); return sourceError(res, e); }
});

app.get('/api/admin/batches', auth, async (req, res) => {
  try {
    if (req.sourceSession) {
      const ids = [...req.sourceSession.sourceBatchIds];
      const batches = await Batch.find({ sourceBatchId: { $in: ids }, active: true }).sort({ name: 1 });
      return res.json({ success: true, batches });
    }
    const batches = req.user.scope === 'all'
      ? await Batch.find().sort({ createdAt: -1 })
      : await Batch.find({ _id: { $in: await getAllowedBatchIds(req) } }).sort({ createdAt: -1 });
    return res.json({ success: true, batches });
  } catch (e) { console.error(e); return res.status(500).json({ success: false, message: 'Failed to load batches' }); }
});
app.post('/api/admin/batches', auth, masterOnly, async (req, res) => {
  try {
    const batch = await Batch.create({
      name: req.body.name, category: req.body.category || 'Other Batch Tests',
      subgroup: req.body.subgroup || '', exam: req.body.exam || '',
      language: req.body.language || 'Hindi', status: req.body.status || 'Paid',
      active: req.body.active !== false, sourceBatchId: req.body.sourceBatchId || undefined
    });
    return res.json({ success: true, batch });
  } catch (e) { console.error(e); return res.status(400).json({ success: false, message: e.message }); }
});
app.put('/api/admin/batches/:id', auth, masterOnly, async (req, res) => {
  try {
    const batch = await Batch.findByIdAndUpdate(req.params.id, { ...req.body, updatedAt: new Date() }, { new: true });
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    return res.json({ success: true, batch });
  } catch { return res.status(400).json({ success: false, message: 'Update failed' }); }
});
app.delete('/api/admin/batches/:id', auth, masterOnly, async (req, res) => {
  try {
    await Test.deleteMany({ batchId: req.params.id }); await Batch.findByIdAndDelete(req.params.id);
    return res.json({ success: true });
  } catch { return res.status(400).json({ success: false, message: 'Delete failed' }); }
});

app.get('/api/admin/batches/:id/content/:type', auth, async (req, res) => {
  try {
    if (!canAccessBatch(req, req.params.id)) return res.status(403).json({ success: false, message: 'You do not have access to this batch' });
    const items = await Test.find({ batchId: req.params.id, type: contentType(req.params.type) }).sort({ startTime: -1, createdAt: -1 });
    return res.json({ success: true, items });
  } catch (e) { console.error(e); return res.status(500).json({ success: false, message: 'Failed to load content' }); }
});
app.post('/api/admin/source/batches/:sourceBatchId/local', auth, masterOnly, async (req, res) => {
  try {
    const sourceBatchId = String(req.params.sourceBatchId);
    let batch = await Batch.findOne({ sourceBatchId });
    if (!batch) batch = await Batch.create({
      name: String(req.body.name || 'Source Batch').trim(), category: req.body.category || 'Other Batch Tests',
      subgroup: req.body.subgroup || '', exam: req.body.exam || '', language: req.body.language || 'Hindi',
      status: req.body.status || 'Paid', active: true, sourceBatchId
    });
    return res.json({ success: true, batch });
  } catch (e) { console.error(e); return res.status(400).json({ success: false, message: e.message }); }
});
app.post('/api/admin/batches/:id/content/:type', auth, async (req, res) => {
  try {
    if (!canAccessBatch(req, req.params.id)) return res.status(403).json({ success: false, message: 'You do not have access to this batch' });
    const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
    const item = await Test.create({
      batchId: req.params.id, type: contentType(req.params.type),
      title: String(req.body.title || 'Untitled').trim(), instructions: req.body.instructions || '',
      startTime: req.body.startTime || null, questions, totalQuestions: questions.length,
      published: req.body.published !== false, uploadedAt: new Date(), updatedAt: new Date()
    });
    return res.json({ success: true, item });
  } catch (e) { console.error('Upload error:', e); return res.status(400).json({ success: false, message: e.message }); }
});
async function setPublished(req, res, value, failMessage) {
  try {
    const item = await Test.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Content not found' });
    if (!canAccessBatch(req, item.batchId)) return res.status(403).json({ success: false, message: 'Access denied' });
    item.published = value; item.updatedAt = new Date(); await item.save();
    return res.json({ success: true, item });
  } catch { return res.status(400).json({ success: false, message: failMessage }); }
}
app.post('/api/admin/content/:id/publish', auth, (req, res) => setPublished(req, res, true, 'Publish failed'));
app.post('/api/admin/content/:id/unpublish', auth, (req, res) => setPublished(req, res, false, 'Unpublish failed'));
app.delete('/api/admin/content/:id', auth, async (req, res) => {
  try {
    const item = await Test.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Content not found' });
    if (!canAccessBatch(req, item.batchId)) return res.status(403).json({ success: false, message: 'Access denied' });
    await Test.findByIdAndDelete(req.params.id); return res.json({ success: true });
  } catch { return res.status(400).json({ success: false, message: 'Delete failed' }); }
});
app.get('/api/admin/stats', auth, async (req, res) => {
  try {
    const isMaster = req.user.scope === 'all';
    const allowedIds = isMaster ? null : (req.sourceSession ? [...req.sourceSession.localBatchIds] : await getAllowedBatchIds(req));
    const batchFilter = isMaster ? {} : { batchId: { $in: allowedIds } };
    const batches = isMaster ? await Batch.countDocuments() : await Batch.countDocuments({ _id: { $in: allowedIds } });
    const tests = await Test.countDocuments({ ...batchFilter, type: 'test' });
    const dpps = await Test.countDocuments({ ...batchFilter, type: 'dpp' });
    const published = await Test.countDocuments({ ...batchFilter, published: true });
    return res.json({ success: true, batches, tests, dpps, published });
  } catch (e) { console.error(e); return res.status(500).json({ success: false, message: 'Failed to load stats' }); }
});

app.get('/api/admin/uploader-tokens', auth, masterOnly, async (req, res) => {
  try {
    const tokens = await UploaderToken.find().populate('batchIds', 'name status category sourceBatchId').sort({ createdAt: -1 }).lean();
    return res.json({ success: true, tokens: tokens.map(t => ({
      id: t._id, name: t.name, active: t.active, createdAt: t.createdAt, batches: t.batchIds || []
    })) });
  } catch (e) { console.error(e); return res.status(500).json({ success: false, message: 'Failed to load uploader tokens' }); }
});
app.post('/api/admin/uploader-tokens', auth, masterOnly, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const batchIds = Array.isArray(req.body.batchIds) ? req.body.batchIds : [];
    if (!name) return res.status(400).json({ success: false, message: 'Token name is required' });
    if (!batchIds.length) return res.status(400).json({ success: false, message: 'Select at least one batch' });
    const batches = await Batch.find({ _id: { $in: batchIds } });
    if (batches.length !== batchIds.length) return res.status(400).json({ success: false, message: 'One or more batches are invalid' });
    const plainToken = generateUploaderToken();
    const uploader = await UploaderToken.create({ name, tokenHash: hashToken(plainToken), batchIds, active: true });
    return res.json({ success: true, token: plainToken, uploader: { id: uploader._id, name: uploader.name, batchIds: uploader.batchIds, active: uploader.active } });
  } catch (e) { console.error(e); return res.status(400).json({ success: false, message: e.message }); }
});
app.delete('/api/admin/uploader-tokens/:id', auth, masterOnly, async (req, res) => {
  try { await UploaderToken.findByIdAndUpdate(req.params.id, { active: false }); return res.json({ success: true }); }
  catch { return res.status(400).json({ success: false, message: 'Failed to revoke token' }); }
});

async function boot() {
  if (!process.env.MONGO_URI) { console.warn('MONGO_URI is required for persistent data.'); return; }
  await mongoose.connect(process.env.MONGO_URI);
  console.log('MongoDB connected');
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'change-me';
  const exists = await User.findOne({ username });
  if (!exists) {
    await User.create({ username, passwordHash: await bcrypt.hash(password, 10), role: 'Batch Uploader' });
    console.log('Default admin user created');
  }
}
boot().catch(e => console.error('DB boot error:', e.message));
app.listen(PORT, () => {
  console.log(`ZX backend running on ${PORT}`);
  console.log(`PenPencil base: ${PENPENCIL_BASE}`);
  console.log(`PenPencil batches path: ${PENPENCIL_BATCHES_PATH}`);
  console.log(`PenPencil max pages: ${MAX_PAGES}`);
});
