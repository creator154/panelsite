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

/* =========================================================
   CONFIG
========================================================= */

const PORT = process.env.PORT || 5000;

const MONGO_URI =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI;

const JWT_SECRET =
  process.env.JWT_SECRET ||
  'zx-panel-secret';

const ADMIN_AUTH_TOKEN =
  process.env.ADMIN_AUTH_TOKEN ||
  '';

const PANEL_SOURCE_TOKEN =
  process.env.PW_JWT_TOKEN ||
  '';

/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(cors({
  origin: '*',
  methods: [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS'
  ],
  allowedHeaders: [
    'Content-Type',
    'Authorization'
  ]
}));

app.use(express.json({
  limit: '10mb'
}));

app.use(express.urlencoded({
  extended: true,
  limit: '10mb'
}));

/* =========================================================
   DATABASE
========================================================= */

if (!MONGO_URI) {
  console.error('MONGO_URI / MONGODB_URI missing');
  process.exit(1);
}

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log('MongoDB connected');
  })
  .catch((err) => {
    console.error(
      'MongoDB connection error:',
      err
    );
  });

/* =========================================================
   HELPERS
========================================================= */

function normalizeType(type) {

  const value =
    String(type || '')
      .toLowerCase()
      .trim();

  if (
    value === 'dpp' ||
    value === 'dpps'
  ) {
    return 'dpp';
  }

  return 'test';
}


function sha256(value) {

  return crypto
    .createHash('sha256')
    .update(String(value))
    .digest('hex');
}


function makeToken() {

  return crypto
    .randomBytes(32)
    .toString('hex');
}


function safeObjectId(value) {

  return mongoose.Types.ObjectId.isValid(
    String(value || '')
  );
}


/* =========================================================
   SOURCE API
========================================================= */

async function sourceFetch(
  path,
  options = {}
) {

  if (!PANEL_SOURCE_TOKEN) {

    throw new Error(
      'PW_JWT_TOKEN is not configured'
    );
  }

  const response = await fetch(
    `https://api.penpencil.xyz${path}`,
    {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization:
          `Bearer ${PANEL_SOURCE_TOKEN}`,
        Accept: 'application/json'
      }
    }
  );

  const text =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {

    const error =
      new Error(
        `Source API ${response.status}`
      );

    error.status =
      response.status;

    error.data =
      data;

    throw error;
  }

  return data;
}


function extractList(data) {

  if (Array.isArray(data)) {
    return data;
  }

  if (
    data &&
    Array.isArray(data.data)
  ) {
    return data.data;
  }

  if (
    data &&
    Array.isArray(data.items)
  ) {
    return data.items;
  }

  if (
    data &&
    data.data &&
    Array.isArray(data.data.items)
  ) {
    return data.data.items;
  }

  return [];
}


/* =========================================================
   BATCH HELPERS
========================================================= */

async function resolveSourceBatchId(id) {

  const raw =
    String(id || '').trim();

  if (!raw) {
    return '';
  }

  /* Already source batch ID */
  const bySource =
    await Batch.findOne({
      sourceBatchId: raw,
      active: true
    })
      .select('sourceBatchId')
      .lean();

  if (bySource) {
    return String(
      bySource.sourceBatchId
    );
  }

  /* Local Mongo _id */
  if (
    safeObjectId(raw)
  ) {

    const byId =
      await Batch.findOne({
        _id: raw,
        active: true
      })
        .select('sourceBatchId')
        .lean();

    if (
      byId &&
      byId.sourceBatchId
    ) {
      return String(
        byId.sourceBatchId
      );
    }
  }

  return raw;
}


/* =========================================================
   IMPORTANT:
   RESOLVE LOCAL BATCH ID FOR PUBLIC SITE
========================================================= */

async function resolveLocalBatchId(id) {

  const raw =
    String(id || '').trim();

  if (!raw) {
    return '';
  }

  /* -------------------------------------------------------
     1. Direct Mongo _id
  ------------------------------------------------------- */

  if (
    safeObjectId(raw)
  ) {

    const byId =
      await Batch.findOne({
        _id: raw,
        active: true
      })
        .select('_id')
        .lean();

    if (byId) {

      return String(
        byId._id
      );
    }
  }

  /* -------------------------------------------------------
     2. Source batch ID
  ------------------------------------------------------- */

  const bySource =
    await Batch.findOne({
      sourceBatchId: raw,
      active: true
    })
      .select('_id')
      .lean();

  if (bySource) {

    return String(
      bySource._id
    );
  }

  return '';
}


/* =========================================================
   AUTH
========================================================= */

async function authMiddleware(
  req,
  res,
  next
) {

  try {

    const header =
      req.headers.authorization ||
      '';

    const token =
      header.startsWith('Bearer ')
        ? header.slice(7).trim()
        : '';

    if (!token) {

      return res
        .status(401)
        .json({
          success: false,
          message: 'Authorization required'
        });
    }

    /* -----------------------------------------------------
       ADMIN MASTER TOKEN
    ----------------------------------------------------- */

    if (
      ADMIN_AUTH_TOKEN &&
      token === ADMIN_AUTH_TOKEN
    ) {

      req.auth = {
        scope: 'all',
        batchIds: []
      };

      return next();
    }

    /* -----------------------------------------------------
       UPLOADER TOKEN
    ----------------------------------------------------- */

    const tokenHash =
      sha256(token);

    const uploader =
      await UploaderToken.findOne({
        tokenHash,
        active: true
      });

    if (!uploader) {

      return res
        .status(401)
        .json({
          success: false,
          message: 'Invalid token'
        });
    }

    if (
      uploader.expiresAt &&
      new Date(
        uploader.expiresAt
      ) < new Date()
    ) {

      return res
        .status(401)
        .json({
          success: false,
          message: 'Token expired'
        });
    }

    req.auth = {
      scope:
        uploader.scope || 'batches',

      batchIds:
        uploader.batchIds || [],

      uploaderId:
        uploader._id
    };

    return next();

  } catch (e) {

    console.error(
      'Auth error:',
      e
    );

    return res
      .status(500)
      .json({
        success: false,
        message: 'Authentication failed'
      });
  }
}


/* =========================================================
   BATCH ACCESS
========================================================= */

function canAccessBatch(
  req,
  batchId
) {

  if (
    req.auth &&
    req.auth.scope === 'all'
  ) {
    return true;
  }

  const allowed =
    (req.auth &&
      req.auth.batchIds) ||
    [];

  return allowed.some(
    id =>
      String(id) ===
      String(batchId)
  );
}


/* =========================================================
   HEALTH
========================================================= */

app.get(
  '/api/health',
  (req, res) => {

    res.json({
      success: true,
      message: 'ZX backend running'
    });
  }
);


/* =========================================================
   AUTH LOGIN
========================================================= */

app.post(
  '/api/auth/login',
  async (req, res) => {

    try {

      const authToken =
        String(
          req.body.token ||
          req.body.authToken ||
          ''
        ).trim();

      if (!authToken) {

        return res
          .status(400)
          .json({
            success: false,
            message: 'Token required'
          });
      }

      /* ---------------------------------------------------
         ADMIN TOKEN
      --------------------------------------------------- */

      if (
        ADMIN_AUTH_TOKEN &&
        authToken === ADMIN_AUTH_TOKEN
      ) {

        const jwtToken =
          jwt.sign(
            {
              scope: 'all',
              batchIds: []
            },
            JWT_SECRET,
            {
              expiresIn: '7d'
            }
          );

        return res.json({
          success: true,
          token: jwtToken,
          scope: 'all',
          batchIds: []
        });
      }

      /* ---------------------------------------------------
         UPLOADER TOKEN
      --------------------------------------------------- */

      const tokenHash =
        sha256(authToken);

      const uploader =
        await UploaderToken.findOne({
          tokenHash,
          active: true
        });

      if (!uploader) {

        return res
          .status(401)
          .json({
            success: false,
            message: 'Invalid uploader token'
          });
      }

      if (
        uploader.expiresAt &&
        new Date(
          uploader.expiresAt
        ) < new Date()
      ) {

        return res
          .status(401)
          .json({
            success: false,
            message: 'Uploader token expired'
          });
      }

      const jwtToken =
        jwt.sign(
          {
            scope:
              uploader.scope ||
              'batches',

            batchIds:
              uploader.batchIds ||
              []
          },
          JWT_SECRET,
          {
            expiresIn: '7d'
          }
        );

      return res.json({
        success: true,
        token: jwtToken,
        scope:
          uploader.scope ||
          'batches',

        batchIds:
          uploader.batchIds ||
          []
      });

    } catch (e) {

      console.error(
        'Login error:',
        e
      );

      return res
        .status(500)
        .json({
          success: false,
          message: 'Login failed'
        });
    }
  }
);


/* =========================================================
   JWT MIDDLEWARE
========================================================= */

function jwtMiddleware(
  req,
  res,
  next
) {

  try {

    const header =
      req.headers.authorization ||
      '';

    if (
      !header.startsWith(
        'Bearer '
      )
    ) {

      return res
        .status(401)
        .json({
          success: false,
          message: 'Authorization required'
        });
    }

    const token =
      header.slice(7).trim();

    const decoded =
      jwt.verify(
        token,
        JWT_SECRET
      );

    req.auth =
      decoded;

    return next();

  } catch (e) {

    return res
      .status(401)
      .json({
        success: false,
        message: 'Invalid or expired session'
      });
  }
}


/* =========================================================
   ADMIN ME
========================================================= */

app.get(
  '/api/admin/me',
  jwtMiddleware,
  async (req, res) => {

    return res.json({
      success: true,
      scope:
        req.auth.scope ||
        'all',

      batchIds:
        req.auth.batchIds ||
        []
    });
  }
);


/* =========================================================
   ADMIN STATS
========================================================= */

app.get(
  '/api/admin/stats',
  jwtMiddleware,
  async (req, res) => {

    try {

      const [
        batches,
        tests,
        dpps
      ] = await Promise.all([

        Batch.countDocuments({
          active: true
        }),

        Test.countDocuments({
          type: 'test'
        }),

        Test.countDocuments({
          type: 'dpp'
        })

      ]);

      return res.json({
        success: true,
        stats: {
          batches,
          tests,
          dpps
        }
      });

    } catch (e) {

      return res
        .status(500)
        .json({
          success: false,
          message: 'Failed to load stats'
        });
    }
  }
);


/* =========================================================
   ADMIN BATCHES
========================================================= */

app.get(
  '/api/admin/batches',
  jwtMiddleware,
  async (req, res) => {

    try {

      let filter = {
        active: true
      };

      if (
        req.auth.scope !== 'all'
      ) {

        filter._id = {
          $in:
            req.auth.batchIds || []
        };
      }

      const batches =
        await Batch.find(filter)
          .sort({
            category: 1,
            name: 1
          })
          .lean();

      return res.json({
        success: true,
        items: batches
      });

    } catch (e) {

      return res
        .status(500)
        .json({
          success: false,
          message: 'Failed to load batches'
        });
    }
  }
);


/* =========================================================
   ADMIN SOURCE BATCHES
========================================================= */

app.get(
  '/api/admin/source/batches',
  jwtMiddleware,
  async (req, res) => {

    try {

      const data =
        await sourceFetch(
          '/v1/users/batches?page=1&limit=50'
        );

      const items =
        extractList(data);

      return res.json({
        success: true,
        items
      });

    } catch (e) {

      console.error(
        'Source batches error:',
        e
      );

      return res
        .status(
          e.status || 500
        )
        .json({
          success: false,
          message:
            e.message ||
            'Failed to load source batches',

          items: []
        });
    }
  }
);


/* =========================================================
   SOURCE BATCH TESTS
========================================================= */

app.get(
  '/api/admin/source/batches/:batchId/tests',
  jwtMiddleware,
  async (req, res) => {

    try {

      const sourceBatchId =
        await resolveSourceBatchId(
          req.params.batchId
        );

      const data =
        await sourceFetch(
          `/v1/batches/${sourceBatchId}/tests`
        );

      const items =
        extractList(data);

      return res.json({
        success: true,
        items
      });

    } catch (e) {

      console.error(
        'Source tests error:',
        e
      );

      return res
        .status(
          e.status || 500
        )
        .json({
          success: false,
          message:
            e.message ||
            'Failed to load tests',

          items: []
        });
    }
  }
);


/* =========================================================
   SOURCE BATCH DPPs
========================================================= */

app.get(
  '/api/admin/source/batches/:batchId/dpps',
  jwtMiddleware,
  async (req, res) => {

    try {

      const sourceBatchId =
        await resolveSourceBatchId(
          req.params.batchId
        );

      const data =
        await sourceFetch(
          `/v1/batches/${sourceBatchId}/dpps`
        );

      const items =
        extractList(data);

      return res.json({
        success: true,
        items
      });

    } catch (e) {

      console.error(
        'Source DPP error:',
        e
      );

      return res
        .status(
          e.status || 500
        )
        .json({
          success: false,
          message:
            e.message ||
            'Failed to load DPPs',

          items: []
        });
    }
  }
);


/* =========================================================
   SOURCE TEST DETAIL
========================================================= */

app.get(
  '/api/admin/source/tests/:testId',
  jwtMiddleware,
  async (req, res) => {

    try {

      const testId =
        String(
          req.params.testId
        ).trim();

      let data;

      try {

        data =
          await sourceFetch(
            `/v3/tests/${testId}`
          );

      } catch (e) {

        data =
          await sourceFetch(
            `/v1/tests/${testId}`
          );
      }

      return res.json({
        success: true,
        data
      });

    } catch (e) {

      console.error(
        'Source test detail error:',
        e
      );

      return res
        .status(
          e.status || 500
        )
        .json({
          success: false,
          message:
            e.message ||
            'Failed to load test'
        });
    }
  }
);


/* =========================================================
   SOURCE CONTENT STATUS
========================================================= */

app.get(
  '/api/admin/source/batches/:batchId/:type/status',
  jwtMiddleware,
  async (req, res) => {

    try {

      const sourceBatchId =
        await resolveSourceBatchId(
          req.params.batchId
        );

      const type =
        normalizeType(
          req.params.type
        );

      const items =
        await Test.find({
          sourceBatchId,
          type
        })
          .select(
            'sourceTestId sourceBatchId title published'
          )
          .lean();

      return res.json({
        success: true,
        items
      });

    } catch (e) {

      console.error(
        'Status error:',
        e
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            'Failed to load upload status',

          items: []
        });
    }
  }
);


/* =========================================================
   SOURCE CONTENT UPLOAD
========================================================= */

app.post(
  '/api/admin/source/batches/:batchId/:type/upload',
  jwtMiddleware,
  async (req, res) => {

    try {

      const rawBatchId =
        String(
          req.params.batchId
        ).trim();

      const type =
        normalizeType(
          req.params.type
        );

      /* ---------------------------------------------------
         Resolve source batch
      --------------------------------------------------- */

      const sourceBatchId =
        await resolveSourceBatchId(
          rawBatchId
        );

      /* ---------------------------------------------------
         Find local batch
      --------------------------------------------------- */

      const localBatch =
        await Batch.findOne({
          sourceBatchId,
          active: true
        });

      if (!localBatch) {

        return res
          .status(404)
          .json({
            success: false,
            message:
              'Local batch not found. Create/import the batch first.'
          });
      }

      /* ---------------------------------------------------
         Source item
      --------------------------------------------------- */

      const sourceItem =
        req.body.sourceItem ||
        req.body.item ||
        req.body;

      const sourceTestId =
        String(
          sourceItem._id ||
          sourceItem.id ||
          sourceItem.testId ||
          sourceItem.sourceTestId ||
          ''
        ).trim();

      if (!sourceTestId) {

        return res
          .status(400)
          .json({
            success: false,
            message:
              'Source test/DPP ID missing'
          });
      }

      /* ---------------------------------------------------
         Already uploaded?
      --------------------------------------------------- */

      const existing =
        await Test.findOne({
          sourceTestId,
          sourceBatchId,
          type
        });

      if (existing) {

        return res.json({
          success: true,
          skipped: true,
          message: 'Already uploaded',
          item: existing
        });
      }

      /* ---------------------------------------------------
         Try fetching detail
      --------------------------------------------------- */

      let detail =
        sourceItem;

      if (type === 'test') {

        try {

          let result;

          try {

            result =
              await sourceFetch(
                `/v3/tests/${sourceTestId}`
              );

          } catch {

            result =
              await sourceFetch(
                `/v1/tests/${sourceTestId}`
              );
          }

          if (result) {

            detail =
              result.data ||
              result.item ||
              result;
          }

        } catch (e) {

          console.log(
            'Test detail fetch failed, using source item:',
            e.message
          );
        }
      }

      /* ---------------------------------------------------
         Extract fields
      --------------------------------------------------- */

      const title =
        detail.title ||
        detail.name ||
        sourceItem.title ||
        sourceItem.name ||
        'Untitled';

      const instructions =
        detail.instructions ||
        detail.description ||
        sourceItem.instructions ||
        sourceItem.description ||
        '';

      const startTime =
        detail.startTime ||
        detail.start_date ||
        sourceItem.startTime ||
        sourceItem.start_date ||
        null;

      const questions =
        detail.questions ||
        detail.questionList ||
        sourceItem.questions ||
        [];

      /* ---------------------------------------------------
         Create Test
      --------------------------------------------------- */

      const created =
        await Test.create({

          batchId:
            localBatch._id,

          type,

          title,

          startTime,

          instructions,

          questions,

          totalQuestions:
            Number(
              detail.totalQuestions ||
              sourceItem.totalQuestions ||
              questions.length ||
              0
            ),

          published: true,

          sourceTestId,

          sourceBatchId
        });

      return res.json({
        success: true,
        skipped: false,
        message: 'Uploaded successfully',
        item: created
      });

    } catch (e) {

      console.error(
        'Upload error:',
        e
      );

      return res
        .status(
          e.status || 500
        )
        .json({
          success: false,
          message:
            e.message ||
            'Upload failed'
        });
    }
  }
);


/* =========================================================
   PUBLIC BATCHES
========================================================= */

app.get(
  '/api/public/batches',
  async (req, res) => {

    try {

      const batches =
        await Batch.find({
          active: true
        })
          .sort({
            category: 1,
            name: 1
          })
          .lean();

      res.set(
        'Cache-Control',
        'no-store'
      );

      return res.json({
        success: true,
        items: batches
      });

    } catch (e) {

      console.error(
        'Public batches error:',
        e
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            'Failed to load public batches',

          items: []
        });
    }
  }
);


/* =========================================================
   PUBLIC TEST / DPP CONTENT
   IMPORTANT FIX:
   Accepts BOTH:
   - local Mongo Batch._id
   - sourceBatchId
========================================================= */

app.get(
  '/api/public/batches/:id/:type',
  async (req, res) => {

    try {

      const localBatchId =
        await resolveLocalBatchId(
          req.params.id
        );

      if (!localBatchId) {

        res.set(
          'Cache-Control',
          'no-store'
        );

        return res.json({
          success: true,
          items: []
        });
      }

      const type =
        normalizeType(
          req.params.type
        );

      const items =
        await Test.find({
          batchId: localBatchId,
          type,
          published: true
        })
          .sort({
            startTime: -1,
            createdAt: -1
          })
          .lean();

      res.set(
        'Cache-Control',
        'no-store'
      );

      return res.json({
        success: true,
        items
      });

    } catch (e) {

      console.error(
        'Public content error:',
        e
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            'Failed to load content',

          items: []
        });
    }
  }
);


/* =========================================================
   PUBLIC SINGLE TEST
========================================================= */

app.get(
  '/api/public/tests/:testId',
  async (req, res) => {

    try {

      const test =
        await Test.findOne({
          $or: [
            {
              _id:
                safeObjectId(
                  req.params.testId
                )
                  ? req.params.testId
                  : null
            },
            {
              sourceTestId:
                req.params.testId
            }
          ],
          published: true
        }).lean();

      if (!test) {

        return res
          .status(404)
          .json({
            success: false,
            message: 'Test not found'
          });
      }

      return res.json({
        success: true,
        item: test
      });

    } catch (e) {

      console.error(
        'Public test error:',
        e
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            'Failed to load test'
        });
    }
  }
);


/* =========================================================
   ADMIN UPLOADER TOKENS
========================================================= */

app.get(
  '/api/admin/uploader-tokens',
  jwtMiddleware,
  async (req, res) => {

    try {

      if (
        req.auth.scope !== 'all'
      ) {

        return res
          .status(403)
          .json({
            success: false,
            message: 'Admin access required'
          });
      }

      const tokens =
        await UploaderToken.find({})
          .select(
            '-tokenHash'
          )
          .sort({
            createdAt: -1
          })
          .lean();

      return res.json({
        success: true,
        items: tokens
      });

    } catch (e) {

      return res
        .status(500)
        .json({
          success: false,
          message:
            'Failed to load uploader tokens'
        });
    }
  }
);


/* =========================================================
   CREATE UPLOADER TOKEN
========================================================= */

app.post(
  '/api/admin/uploader-tokens',
  jwtMiddleware,
  async (req, res) => {

    try {

      if (
        req.auth.scope !== 'all'
      ) {

        return res
          .status(403)
          .json({
            success: false,
            message: 'Admin access required'
          });
      }

      const token =
        makeToken();

      const tokenHash =
        sha256(token);

      const scope =
        req.body.scope ||
        'batches';

      const batchIds =
        Array.isArray(
          req.body.batchIds
        )
          ? req.body.batchIds
          : [];

      const uploader =
        await UploaderToken.create({

          name:
            req.body.name ||
            'Uploader',

          tokenHash,

          scope,

          batchIds,

          active: true,

          expiresAt:
            req.body.expiresAt ||
            null
        });

      return res.json({
        success: true,

        token,

        item: {
          _id:
            uploader._id,

          name:
            uploader.name,

          scope:
            uploader.scope,

          batchIds:
            uploader.batchIds,

          active:
            uploader.active,

          expiresAt:
            uploader.expiresAt
        }
      });

    } catch (e) {

      console.error(
        'Create token error:',
        e
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            'Failed to create uploader token'
        });
    }
  }
);


/* =========================================================
   DISABLE UPLOADER TOKEN
========================================================= */

app.patch(
  '/api/admin/uploader-tokens/:id',
  jwtMiddleware,
  async (req, res) => {

    try {

      if (
        req.auth.scope !== 'all'
      ) {

        return res
          .status(403)
          .json({
            success: false,
            message: 'Admin access required'
          });
      }

      const updated =
        await UploaderToken.findByIdAndUpdate(
          req.params.id,
          {
            active:
              req.body.active !== false
          },
          {
            new: true
          }
        )
          .select('-tokenHash');

      if (!updated) {

        return res
          .status(404)
          .json({
            success: false,
            message:
              'Uploader token not found'
          });
      }

      return res.json({
        success: true,
        item: updated
      });

    } catch (e) {

      return res
        .status(500)
        .json({
          success: false,
          message:
            'Failed to update token'
        });
    }
  }
);


/* =========================================================
   ROOT
========================================================= */

app.get(
  '/',
  (req, res) => {

    res.json({
      success: true,
      message:
        'ZX backend running'
    });
  }
);


/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {

    res
      .status(404)
      .json({
        success: false,
        message: 'Route not found'
      });
  }
);


/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (err, req, res, next) => {

    console.error(
      'Unhandled error:',
      err
    );

    return res
      .status(500)
      .json({
        success: false,
        message:
          'Internal server error'
      });
  }
);


/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      `ZX backend running on ${PORT}`
    );
  }
);
