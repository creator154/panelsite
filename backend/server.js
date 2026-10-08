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

/* ===================== MIDDLEWARE ===================== */

app.use(cors({ origin: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

/* ===================== CONFIG ===================== */

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';
const PENPENCIL_API_TOKEN = process.env.PENPENCIL_API_TOKEN || '';

// Organization id header (fixes "Could not get organization details!")
const PENPENCIL_CLIENT_ID =
  process.env.PENPENCIL_CLIENT_ID || '5eb393ee95fab7468a79d189';

const PENPENCIL_BASE = (
  process.env.PENPENCIL_BASE || 'https://api.penpencil.co'
).replace(/\/$/, '');

const PENPENCIL_BATCHES_PATH =
  process.env.PENPENCIL_BATCHES_PATH || '/v3/batches/my-batches';

const PENPENCIL_BATCH_DETAILS_PATH =
  process.env.PENPENCIL_BATCH_DETAILS_PATH || '/v3/batches/{batchId}/details';

const PENPENCIL_TESTS_PATH =
  process.env.PENPENCIL_TESTS_PATH ||
  '/v3/test-service/tests/check-tests?testSource=BATCH_QUIZ&batchId={batchId}';

const PENPENCIL_DPPS_PATH =
  process.env.PENPENCIL_DPPS_PATH ||
  '/v3/test-service/tests/dpp?batchId={batchId}&isSubjective=false';

const PENPENCIL_TEST_DETAIL_PATH =
  process.env.PENPENCIL_TEST_DETAIL_PATH || '/v3/tests/{testId}';

if (!Batch.schema.path('sourceBatchId')) {
  Batch.schema.add({
    sourceBatchId: { type: String, index: true }
  });
}

/* ===================== PENPENCIL REQUEST ===================== */

const profileCache = new Map();

function decodeJwtPayload(t) {
  try {
    return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString());
  } catch {
    return null;
  }
}

// Finds the organization id inside a token payload (if present)
function findOrgId(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return '';

  for (const [k, v] of Object.entries(obj)) {
    if (/^(organizationId|orgId|organization_id)$/i.test(k) && typeof v === 'string') {
      return v;
    }
    if (/^organization$/i.test(k)) {
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object' && (v._id || v.id)) return String(v._id || v.id);
    }
  }

  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = findOrgId(v, depth + 1);
      if (found) return found;
    }
  }

  return '';
}

async function penpencilCall(url, token, clientId, clientType) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Client-Id': clientId,
      'Client-Type': clientType,
      'Client-Version': '200',
      'User-Agent': 'Mozilla/5.0'
    }
  });

  const text = await response.text();

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  return { ok: response.ok, status: response.status, data };
}

async function penpencilRequest(path, tokenOverride) {
  const token = tokenOverride || PENPENCIL_API_TOKEN;

  if (!token) {
    throw new Error('PENPENCIL_API_TOKEN is missing in Heroku Config Vars');
  }

  const cleanPath = String(path).startsWith('/') ? String(path) : `/${path}`;
  const url = PENPENCIL_BASE + cleanPath;

  console.log('PenPencil request:', url);

  let profiles;

  if (!tokenOverride) {
    profiles = [{ id: PENPENCIL_CLIENT_ID, type: 'WEB' }];
  } else if (profileCache.has(token)) {
    profiles = [profileCache.get(token)];
  } else {
    const payload = decodeJwtPayload(token);

    console.log(
      'Source token payload keys:',
      payload ? Object.keys(payload).join(',') : 'not-a-jwt'
    );

    const org = findOrgId(payload);
    const ids = [...new Set([org, PENPENCIL_CLIENT_ID].filter(Boolean))];

    profiles = [];
    for (const id of ids) {
      for (const type of ['WEB', 'ANDROID']) {
        profiles.push({ id, type });
      }
    }
  }

  let last;

  for (const p of profiles) {
    const r = await penpencilCall(url, token, p.id, p.type);

    if (r.ok) {
      if (tokenOverride) {
        if (profileCache.size > 1000) profileCache.clear();
        profileCache.set(token, p);
      }
      return r.data;
    }

    last = r;

    if (r.status !== 400 && r.status !== 403) break;
  }

  console.error('PenPencil API error:', last.status, last.data);

  const d = last.data || {};
  const err = new Error(
    d.message ||
      d.error?.message ||
      (typeof d.error === 'string' ? d.error : '') ||
      (typeof d.data === 'string' ? d.data : '') ||
      `PenPencil API returned ${last.status}`
  );
  err.upstreamStatus = last.status;
  throw err;
}

/* ===================== HELPERS ===================== */

function buildSourcePath(template, values = {}) {
  let path = String(template);
  for (const [key, value] of Object.entries(values)) {
    path = path.replace(
      new RegExp(`\\{${key}\\}`, 'g'),
      encodeURIComponent(String(value))
    );
  }
  return path;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function generateUploaderToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sign(user) {
  return jwt.sign(
    {
      sub: String(user._id),
      username: user.username,
      role: user.role,
      scope: user.scope || 'all',
      batchIds: (user.batchIds || []).map(String),
      ppToken: user.ppToken || '',
      bp: user.bp || ''
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '');

  if (!token) {
    return res
      .status(401)
      .json({ success: false, message: 'Authentication required' });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res
      .status(401)
      .json({ success: false, message: 'Invalid or expired token' });
  }
}

function masterOnly(req, res, next) {
  if (req.user && req.user.scope === 'all') return next();
  return res
    .status(403)
    .json({ success: false, message: 'Master access required' });
}

function canAccessBatch(req, batchId) {
  if (!req.user) return false;
  if (req.user.scope === 'all') return true;
  return (req.user.batchIds || []).map(String).includes(String(batchId));
}

async function getAllowedBatchIds(req) {
  if (req.user.scope === 'all') return null;
  return (req.user.batchIds || []).map(String);
}

async function canAccessSourceBatch(req, sourceBatchId) {
  if (!req.user) return false;
  if (req.user.scope === 'all') return true;

  const allowedLocalIds = (req.user.batchIds || []).map(String);
  if (!allowedLocalIds.length) return false;

  const batch = await Batch.findOne({
    _id: { $in: allowedLocalIds },
    sourceBatchId: String(sourceBatchId),
    active: true
  }).lean();

  return !!batch;
}

async function getAllowedSourceBatchIds(req) {
  if (req.user.scope === 'all') return null;

  const allowedLocalIds = (req.user.batchIds || []).map(String);
  if (!allowedLocalIds.length) return [];

  const batches = await Batch.find({
    _id: { $in: allowedLocalIds },
    active: true,
    sourceBatchId: { $exists: true, $ne: '' }
  })
    .select('_id sourceBatchId')
    .lean();

  return batches.map(b => String(b.sourceBatchId)).filter(Boolean);
}

function sourceArray(data) {
  const candidates = [
    data,
    data?.data,
    data?.data?.data,
    data?.data?.batches,
    data?.data?.items,
    data?.data?.results,
    data?.results,
    data?.items,
    data?.batches,
    data?.tests,
    data?.dpps
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function getSourceBatchId(batch) {
  if (!batch) return '';
  return String(batch._id || batch.id || batch.batchId || batch.batch_id || '');
}

/*
  my-batches returns only one page at a time (20 items).
  Keep asking for next pages until no new batch comes.
*/
const MAX_PAGES = Number(process.env.PENPENCIL_MAX_PAGES) || 25;
const MAX_LOGIN_BATCHES = Number(process.env.PENPENCIL_MAX_BATCHES) || 100;

async function fetchBatchPage(page, ppToken, basePath) {
  const sep = basePath.includes('?') ? '&' : '?';
  return penpencilRequest(`${basePath}${sep}page=${page}`, ppToken);
}

async function fetchAllSourceBatches(
  ppToken,
  basePath = PENPENCIL_BATCHES_PATH,
  maxPages = MAX_PAGES
) {
  const all = [];
  const seen = new Set();
  let firstData = null;

  for (let start = 1; start <= maxPages; start += 4) {
    const pages = [];
    for (let p = start; p < Math.min(start + 4, maxPages + 1); p++) {
      pages.push(p);
    }

    const results = await Promise.all(
      pages.map(p =>
        fetchBatchPage(p, ppToken, basePath).catch(e => {
          if (p === 1) throw e;
          return null;
        })
      )
    );

    let added = 0;

    for (const data of results) {
      if (!data) continue;
      if (!firstData) firstData = data;

      for (const b of sourceArray(data)) {
        const id = getSourceBatchId(b);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        all.push(b);
        added++;
      }
    }

    if (!added) break;
  }

  console.log('Source batches fetched (all pages):', all.length);

  return { data: firstData, batches: all };
}

function ppTokenOf(req) {
  return (req.user && req.user.ppToken) || '';
}

/*
  Login with a PenPencil token directly.
  Token is checked against PenPencil, then only the batches
  that token can see are given access.
*/
const BATCH_PATH_CANDIDATES = [
  '/v3/batches/all-purchased-batches?type=ALL',
  '/v3/batches/all-purchased-batches',
  '/v3/batches/purchased-batches',
  '/v3/batches/my-batches?filter=true&amount=paid'
];

// Looks like a real JWT: 3 parts, readable payload, not expired
function looksLikeJwt(t) {
  const parts = String(t).split('.');
  if (parts.length !== 3 || parts.some(p => !p)) return false;

  const payload = decodeJwtPayload(t);
  if (!payload || typeof payload !== 'object') return false;

  if (payload.exp && payload.exp * 1000 < Date.now()) return false;

  return true;
}

/*
  A route is only useful if it returns DIFFERENT batches for a
  real token than for a fake token. If both give the same list,
  the route is a public catalog and not the user's own batches.
*/
async function checkUserSpecific(path, ppToken) {
  const idsOf = data =>
    sourceArray(data).map(getSourceBatchId).filter(Boolean);

  const mine = idsOf(await fetchBatchPage(1, ppToken, path));

  if (!mine.length) return { ok: false, reason: 'empty list' };

  let base = [];
  try {
    base = idsOf(
      await fetchBatchPage(1, 'invalid.invalid.invalid', path)
    );
  } catch {
    base = [];
  }

  const same =
    base.length === mine.length && base.every(id => mine.includes(id));

  if (same) return { ok: false, reason: 'same list for fake token (public catalog)' };

  return { ok: true, reason: 'differs from fake token' };
}

async function loginWithSourceToken(ppToken) {
  if (!looksLikeJwt(ppToken)) {
    console.log('Source login rejected: token is not a valid JWT');
    return null;
  }

  const candidates = process.env.PENPENCIL_BATCHES_PATH
    ? [process.env.PENPENCIL_BATCHES_PATH]
    : [...BATCH_PATH_CANDIDATES, PENPENCIL_BATCHES_PATH];

  let list = null;
  let basePath = '';
  const notes = [];

  for (const cand of candidates) {
    try {
      const chk = await checkUserSpecific(cand, ppToken);

      console.log(
        'Batch route probe:',
        cand,
        chk.ok ? 'USER-SPECIFIC' : 'not usable - ' + chk.reason
      );

      notes.push(cand + ' => ' + (chk.ok ? 'ok' : chk.reason));

      if (chk.ok) {
        basePath = cand;
        list = (await fetchAllSourceBatches(ppToken, cand)).batches;
        break;
      }
    } catch (e) {
      console.log('Batch route probe:', cand, 'failed:', e.message);
      notes.push(cand + ' => failed: ' + e.message);
    }
  }

  if (!list || !list.length) {
    console.error('No user-specific batch route worked for this token');
    return {
      success: false,
      message:
        'Could not load batches for this token\n' + notes.join('\n')
    };
  }

  console.log('Batch route used:', basePath, 'count:', list.length);

  if (!list.length) return null;

  let sourceList = list;

  if (sourceList.length > MAX_LOGIN_BATCHES) {
    console.warn(
      `Token has ${sourceList.length} batches, keeping first ${MAX_LOGIN_BATCHES}`
    );
    sourceList = sourceList.slice(0, MAX_LOGIN_BATCHES);
  }

  const byId = new Map();
  for (const sb of sourceList) {
    const id = getSourceBatchId(sb);
    if (id) byId.set(id, sb);
  }

  const ids = [...byId.keys()];

  const existing = await Batch.find({ sourceBatchId: { $in: ids } })
    .select('_id sourceBatchId')
    .lean();

  const have = new Map(
    existing.map(b => [String(b.sourceBatchId), String(b._id)])
  );

  const missing = ids.filter(id => !have.has(id));

  if (missing.length) {
    const created = await Batch.insertMany(
      missing.map(id => {
        const sb = byId.get(id);
        return {
          name: String(sb.name || sb.title || 'Source Batch').trim(),
          category: 'Other Batch Tests',
          subgroup: '',
          exam: '',
          language: 'Hindi',
          status: 'Paid',
          active: true,
          sourceBatchId: id
        };
      })
    );

    created.forEach(b => have.set(String(b.sourceBatchId), String(b._id)));
  }

  const localIds = ids.map(id => have.get(id)).filter(Boolean);

  const token = sign({
    _id: 'source-' + hashToken(ppToken).slice(0, 12),
    username: 'Source Token User',
    role: 'Batch Uploader',
    scope: 'batches',
    batchIds: localIds,
    ppToken,
    bp: basePath
  });

  return {
    success: true,
    token,
    role: 'Batch Uploader',
    scope: 'batches',
    batchIds: localIds
  };
}

function contentType(param) {
  return param === 'dpp' || param === 'dpps' ? 'dpp' : 'test';
}

function sourceError(res, e, extra = {}) {
  return res.status(502).json({
    success: false,
    message: e.message,
    upstreamStatus: e.upstreamStatus || null,
    ...extra
  });
}

/* ===================== HEALTH / ROOT ===================== */

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'zx-backend' });
});

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'zx-backend', message: 'ZX backend is running' });
});

/* ===================== LOGIN ===================== */

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const authToken = String(req.body?.authToken || '').trim();

    if (authToken) {
      /* MASTER AUTH TOKEN */
      if (
        process.env.ADMIN_AUTH_TOKEN &&
        authToken === process.env.ADMIN_AUTH_TOKEN
      ) {
        const token = sign({
          _id: 'master-token-user',
          username: 'Master Admin',
          role: 'Batch Uploader',
          scope: 'all',
          batchIds: []
        });

        return res.json({
          success: true,
          token,
          role: 'Batch Uploader',
          scope: 'all'
        });
      }

      /* SCOPED UPLOADER TOKEN */
      const uploader = await UploaderToken.findOne({
        tokenHash: hashToken(authToken),
        active: true
      }).populate('batchIds');

      if (!uploader) {
        if (process.env.ALLOW_SOURCE_TOKEN_LOGIN === 'false') {
          return res.status(401).json({
            success: false,
            message: 'Invalid or inactive auth token'
          });
        }

        const sourceLogin = await loginWithSourceToken(authToken);

        if (!sourceLogin) {
          return res.status(401).json({
            success: false,
            message: 'Invalid or inactive auth token'
          });
        }

        if (sourceLogin.success === false) {
          return res.status(502).json(sourceLogin);
        }

        return res.json(sourceLogin);
      }

      const assignedBatchIds = (uploader.batchIds || [])
        .map(b => b?._id)
        .filter(Boolean)
        .map(String);

      const token = sign({
        _id: uploader._id,
        username: uploader.name,
        role: 'Batch Uploader',
        scope: 'batches',
        batchIds: assignedBatchIds
      });

      return res.json({
        success: true,
        token,
        role: 'Batch Uploader',
        scope: 'batches',
        batchIds: assignedBatchIds
      });
    }

    /* USERNAME / PASSWORD */
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password required'
      });
    }

    const user = await User.findOne({ username });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ success: false, message: 'Invalid login' });
    }

    const token = sign({
      _id: user._id,
      username: user.username,
      role: user.role,
      scope: 'all',
      batchIds: []
    });

    return res.json({ success: true, token, role: user.role, scope: 'all' });
  } catch (e) {
    console.error('Login error:', e);
    return res.status(500).json({ success: false, message: 'Login failed' });
  }
});

/* ===================== PUBLIC ===================== */

app.get('/api/public/batches', async (req, res) => {
  try {
    const batches = await Batch.find({ active: true }).sort({
      category: 1,
      name: 1
    });
    return res.json({ success: true, batches });
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ success: false, message: 'Failed to load batches' });
  }
});

app.get('/api/public/batches/:id/:type', async (req, res) => {
  try {
    const items = await Test.find({
      batchId: req.params.id,
      type: contentType(req.params.type),
      published: true
    }).sort({ startTime: -1, createdAt: -1 });

    return res.json({ success: true, items });
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ success: false, message: 'Failed to load content' });
  }
});

/* ===================== CURRENT USER ===================== */

app.get('/api/admin/me', auth, async (req, res) => {
  return res.json({
    success: true,
    user: {
      sub: req.user.sub,
      username: req.user.username,
      role: req.user.role,
      scope: req.user.scope || 'all',
      batchIds: req.user.batchIds || []
    }
  });
});

/* ===================== SOURCE BATCHES ===================== */

app.get('/api/admin/source/batches', auth, async (req, res) => {
  try {
    console.log('Loading source batches...');

    const usedToken = ppTokenOf(req);

    console.log(
      'Source list using:',
      usedToken ? 'USER TOKEN ending ' + usedToken.slice(-6) : 'CONFIG TOKEN'
    );

    const fetched = await fetchAllSourceBatches(
      usedToken,
      (usedToken && req.user.bp) || PENPENCIL_BATCHES_PATH
    );
    const data = fetched.data;

    let batches = fetched.batches;

    console.log('Source batches from API:', batches.length);

    if (req.user.scope !== 'all') {
      const allowedSourceIds = await getAllowedSourceBatchIds(req);
      const allowedSet = new Set((allowedSourceIds || []).map(String));

      batches = batches.filter(batch => {
        const sourceId = getSourceBatchId(batch);
        return sourceId && allowedSet.has(sourceId);
      });
    }

    console.log(
      'Source batches returned:',
      batches.length,
      'scope:',
      req.user.scope
    );

    return res.json({ success: true, data, batches });
  } catch (e) {
    console.error('PenPencil batches error:', e.message);
    return sourceError(res, e, { batches: [] });
  }
});

app.get('/api/admin/source/batches/:batchId/details', auth, async (req, res) => {
  try {
    const sourceBatchId = String(req.params.batchId);

    if (!(await canAccessSourceBatch(req, sourceBatchId))) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this source batch'
      });
    }

    const data = await penpencilRequest(
      buildSourcePath(PENPENCIL_BATCH_DETAILS_PATH, { batchId: sourceBatchId }),
      ppTokenOf(req)
    );

    return res.json({ success: true, data });
  } catch (e) {
    console.error('PenPencil batch details error:', e.message);
    return sourceError(res, e);
  }
});

app.get('/api/admin/source/batches/:batchId/tests', auth, async (req, res) => {
  try {
    const sourceBatchId = String(req.params.batchId);

    if (!(await canAccessSourceBatch(req, sourceBatchId))) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this source batch',
        items: []
      });
    }

    const data = await penpencilRequest(
      buildSourcePath(PENPENCIL_TESTS_PATH, { batchId: sourceBatchId }),
      ppTokenOf(req)
    );

    return res.json({ success: true, data, items: sourceArray(data) });
  } catch (e) {
    console.error('PenPencil tests error:', e.message);
    return sourceError(res, e, { items: [] });
  }
});

app.get('/api/admin/source/batches/:batchId/dpps', auth, async (req, res) => {
  try {
    const sourceBatchId = String(req.params.batchId);

    if (!(await canAccessSourceBatch(req, sourceBatchId))) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this source batch',
        items: []
      });
    }

    const data = await penpencilRequest(
      buildSourcePath(PENPENCIL_DPPS_PATH, { batchId: sourceBatchId }),
      ppTokenOf(req)
    );

    return res.json({ success: true, data, items: sourceArray(data) });
  } catch (e) {
    console.error('PenPencil DPP error:', e.message);
    return sourceError(res, e, { items: [] });
  }
});

app.get('/api/admin/source/tests/:testId', auth, async (req, res) => {
  try {
    const requestedBatchId = req.query.batchId ? String(req.query.batchId) : '';

    if (
      requestedBatchId &&
      !(await canAccessSourceBatch(req, requestedBatchId))
    ) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this source batch'
      });
    }

    const data = await penpencilRequest(
      buildSourcePath(PENPENCIL_TEST_DETAIL_PATH, {
        testId: req.params.testId
      }),
      ppTokenOf(req)
    );

    return res.json({ success: true, data });
  } catch (e) {
    console.error('PenPencil test details error:', e.message);
    return sourceError(res, e);
  }
});

/* ===================== ADMIN BATCHES ===================== */

app.get('/api/admin/batches', auth, async (req, res) => {
  try {
    let batches;

    if (req.user.scope === 'all') {
      batches = await Batch.find().sort({ createdAt: -1 });
    } else {
      batches = await Batch.find({
        _id: { $in: await getAllowedBatchIds(req) }
      }).sort({ createdAt: -1 });
    }

    return res.json({ success: true, batches });
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ success: false, message: 'Failed to load batches' });
  }
});

app.post('/api/admin/batches', auth, masterOnly, async (req, res) => {
  try {
    const batch = await Batch.create({
      name: req.body.name,
      category: req.body.category || 'Other Batch Tests',
      subgroup: req.body.subgroup || '',
      exam: req.body.exam || '',
      language: req.body.language || 'Hindi',
      status: req.body.status || 'Paid',
      active: req.body.active !== false,
      sourceBatchId: req.body.sourceBatchId || undefined
    });

    return res.json({ success: true, batch });
  } catch (e) {
    console.error(e);
    return res.status(400).json({ success: false, message: e.message });
  }
});

app.put('/api/admin/batches/:id', auth, masterOnly, async (req, res) => {
  try {
    const batch = await Batch.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: new Date() },
      { new: true }
    );

    if (!batch) {
      return res
        .status(404)
        .json({ success: false, message: 'Batch not found' });
    }

    return res.json({ success: true, batch });
  } catch (e) {
    return res.status(400).json({ success: false, message: 'Update failed' });
  }
});

app.delete('/api/admin/batches/:id', auth, masterOnly, async (req, res) => {
  try {
    await Test.deleteMany({ batchId: req.params.id });
    await Batch.findByIdAndDelete(req.params.id);
    return res.json({ success: true });
  } catch (e) {
    return res.status(400).json({ success: false, message: 'Delete failed' });
  }
});

/* ===================== LOCAL CONTENT ===================== */

app.get('/api/admin/batches/:id/content/:type', auth, async (req, res) => {
  try {
    if (!canAccessBatch(req, req.params.id)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this batch'
      });
    }

    const items = await Test.find({
      batchId: req.params.id,
      type: contentType(req.params.type)
    }).sort({ startTime: -1, createdAt: -1 });

    return res.json({ success: true, items });
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ success: false, message: 'Failed to load content' });
  }
});

/* ===================== LOCAL BATCH FROM SOURCE ===================== */

app.post(
  '/api/admin/source/batches/:sourceBatchId/local',
  auth,
  masterOnly,
  async (req, res) => {
    try {
      const srcId = String(req.params.sourceBatchId);

      let batch = await Batch.findOne({ sourceBatchId: srcId });

      if (!batch) {
        batch = await Batch.create({
          name: String(req.body.name || 'Source Batch').trim(),
          category: req.body.category || 'Other Batch Tests',
          subgroup: req.body.subgroup || '',
          exam: req.body.exam || '',
          language: req.body.language || 'Hindi',
          status: req.body.status || 'Paid',
          active: true,
          sourceBatchId: srcId
        });
      }

      return res.json({ success: true, batch });
    } catch (e) {
      console.error('Local source batch error:', e);
      return res.status(400).json({ success: false, message: e.message });
    }
  }
);

/* ===================== UPLOAD TEST / DPP ===================== */

app.post('/api/admin/batches/:id/content/:type', auth, async (req, res) => {
  try {
    if (!canAccessBatch(req, req.params.id)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this batch'
      });
    }

    const questions = Array.isArray(req.body.questions)
      ? req.body.questions
      : [];

    const item = await Test.create({
      batchId: req.params.id,
      type: contentType(req.params.type),
      title: String(req.body.title || 'Untitled').trim(),
      instructions: req.body.instructions || '',
      startTime: req.body.startTime || null,
      questions,
      totalQuestions: questions.length,
      published: req.body.published !== false,
      uploadedAt: new Date(),
      updatedAt: new Date()
    });

    return res.json({ success: true, item });
  } catch (e) {
    console.error('Upload error:', e);
    return res.status(400).json({ success: false, message: e.message });
  }
});

/* ===================== PUBLISH / UNPUBLISH ===================== */

async function setPublished(req, res, value, failMessage) {
  try {
    const item = await Test.findById(req.params.id);

    if (!item) {
      return res
        .status(404)
        .json({ success: false, message: 'Content not found' });
    }

    if (!canAccessBatch(req, item.batchId)) {
      return res
        .status(403)
        .json({ success: false, message: 'Access denied' });
    }

    item.published = value;
    item.updatedAt = new Date();
    await item.save();

    return res.json({ success: true, item });
  } catch {
    return res.status(400).json({ success: false, message: failMessage });
  }
}

app.post('/api/admin/content/:id/publish', auth, (req, res) =>
  setPublished(req, res, true, 'Publish failed')
);

app.post('/api/admin/content/:id/unpublish', auth, (req, res) =>
  setPublished(req, res, false, 'Unpublish failed')
);

/* ===================== DELETE CONTENT ===================== */

app.delete('/api/admin/content/:id', auth, async (req, res) => {
  try {
    const item = await Test.findById(req.params.id);

    if (!item) {
      return res
        .status(404)
        .json({ success: false, message: 'Content not found' });
    }

    if (!canAccessBatch(req, item.batchId)) {
      return res
        .status(403)
        .json({ success: false, message: 'Access denied' });
    }

    await Test.findByIdAndDelete(req.params.id);

    return res.json({ success: true });
  } catch {
    return res.status(400).json({ success: false, message: 'Delete failed' });
  }
});

/* ===================== STATS ===================== */

app.get('/api/admin/stats', auth, async (req, res) => {
  try {
    const isMaster = req.user.scope === 'all';
    const allowedIds = isMaster ? null : await getAllowedBatchIds(req);

    const batchFilter = isMaster ? {} : { batchId: { $in: allowedIds } };

    const batches = isMaster
      ? await Batch.countDocuments()
      : await Batch.countDocuments({ _id: { $in: allowedIds } });

    const tests = await Test.countDocuments({ ...batchFilter, type: 'test' });
    const dpps = await Test.countDocuments({ ...batchFilter, type: 'dpp' });
    const published = await Test.countDocuments({
      ...batchFilter,
      published: true
    });

    return res.json({ success: true, batches, tests, dpps, published });
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ success: false, message: 'Failed to load stats' });
  }
});

/* ===================== UPLOADER TOKENS ===================== */

app.get('/api/admin/uploader-tokens', auth, masterOnly, async (req, res) => {
  try {
    const tokens = await UploaderToken.find()
      .populate('batchIds', 'name status category sourceBatchId')
      .sort({ createdAt: -1 })
      .lean();

    const result = tokens.map(t => ({
      id: t._id,
      name: t.name,
      active: t.active,
      createdAt: t.createdAt,
      batches: t.batchIds || []
    }));

    return res.json({ success: true, tokens: result });
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ success: false, message: 'Failed to load uploader tokens' });
  }
});

app.post('/api/admin/uploader-tokens', auth, masterOnly, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const batchIds = Array.isArray(req.body.batchIds) ? req.body.batchIds : [];

    if (!name) {
      return res
        .status(400)
        .json({ success: false, message: 'Token name is required' });
    }

    if (!batchIds.length) {
      return res
        .status(400)
        .json({ success: false, message: 'Select at least one batch' });
    }

    const batches = await Batch.find({ _id: { $in: batchIds } });

    if (batches.length !== batchIds.length) {
      return res.status(400).json({
        success: false,
        message: 'One or more batches are invalid'
      });
    }

    const plainToken = generateUploaderToken();

    const uploader = await UploaderToken.create({
      name,
      tokenHash: hashToken(plainToken),
      batchIds,
      active: true
    });

    return res.json({
      success: true,
      token: plainToken,
      uploader: {
        id: uploader._id,
        name: uploader.name,
        batchIds: uploader.batchIds,
        active: uploader.active
      }
    });
  } catch (e) {
    console.error(e);
    return res.status(400).json({ success: false, message: e.message });
  }
});

app.delete(
  '/api/admin/uploader-tokens/:id',
  auth,
  masterOnly,
  async (req, res) => {
    try {
      await UploaderToken.findByIdAndUpdate(req.params.id, { active: false });
      return res.json({ success: true });
    } catch {
      return res
        .status(400)
        .json({ success: false, message: 'Failed to revoke token' });
    }
  }
);

/* ===================== DATABASE BOOT ===================== */

async function boot() {
  if (!process.env.MONGO_URI) {
    console.warn('MONGO_URI is required for persistent data.');
    return;
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('MongoDB connected');

  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'change-me';

  const exists = await User.findOne({ username });

  if (!exists) {
    await User.create({
      username,
      passwordHash: await bcrypt.hash(password, 10),
      role: 'Batch Uploader'
    });
    console.log('Default admin user created');
  }
}

boot().catch(e => {
  console.error('DB boot error:', e.message);
});

/* ===================== SERVER ===================== */

app.listen(PORT, () => {
  console.log(`ZX backend running on ${PORT}`);
  console.log(`PenPencil base: ${PENPENCIL_BASE}`);
  console.log(`PenPencil batches path: ${PENPENCIL_BATCHES_PATH}`);
  console.log(`PenPencil tests path: ${PENPENCIL_TESTS_PATH}`);
  console.log(`PenPencil DPP path: ${PENPENCIL_DPPS_PATH}`);
});
