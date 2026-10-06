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

app.use(
  express.json({
    limit: '20mb'
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '20mb'
  })
);

const JWT_SECRET =
  process.env.JWT_SECRET || 'change-this-secret';


/* =====================================================
   PENPENCIL SOURCE API
   ===================================================== */

const PENPENCIL_API_TOKEN =
  process.env.PENPENCIL_API_TOKEN || '';

const PENPENCIL_BASE =
  'https://api.penpencil.xyz/v1';


async function penpencilRequest(path) {

  if (!PENPENCIL_API_TOKEN) {
    throw new Error(
      'PENPENCIL_API_TOKEN is not configured'
    );
  }

  const response = await fetch(
    PENPENCIL_BASE + path,
    {
      method: 'GET',

      headers: {
        Authorization:
          'Bearer ' + PENPENCIL_API_TOKEN,

        Accept: 'application/json'
      }
    }
  );

  const data =
    await response
      .json()
      .catch(() => ({}));

  if (!response.ok) {

    throw new Error(
      data.message ||
      `PenPencil API error: ${response.status}`
    );
  }

  return data;
}


/* =====================================================
   HELPERS
   ===================================================== */

function hashToken(token) {

  return crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');
}


function generateUploaderToken() {

  return crypto
    .randomBytes(32)
    .toString('hex');
}


function sign(user) {

  return jwt.sign(
    {
      sub: String(user._id),

      username:
        user.username,

      role:
        user.role,

      scope:
        user.scope || 'all',

      batchIds:
        (user.batchIds || [])
          .map(String)
    },

    JWT_SECRET,

    {
      expiresIn: '7d'
    }
  );
}


function auth(req, res, next) {

  const h =
    req.headers.authorization || '';

  const token =
    h.replace(
      /^Bearer\s+/i,
      ''
    );

  if (!token) {

    return res.status(401).json({
      success: false,
      message:
        'Authentication required'
    });
  }

  try {

    req.user =
      jwt.verify(
        token,
        JWT_SECRET
      );

    next();

  } catch (e) {

    return res.status(401).json({
      success: false,
      message:
        'Invalid or expired token'
    });
  }
}


function masterOnly(req, res, next) {

  if (
    req.user &&
    req.user.scope === 'all'
  ) {

    return next();
  }

  return res.status(403).json({
    success: false,
    message:
      'Master access required'
  });
}


function canAccessBatch(
  req,
  batchId
) {

  if (!req.user) {
    return false;
  }

  if (
    req.user.scope === 'all'
  ) {

    return true;
  }

  return (
    req.user.batchIds || []
  )
    .map(String)
    .includes(
      String(batchId)
    );
}


async function getAllowedBatchIds(req) {

  if (
    req.user.scope === 'all'
  ) {

    return null;
  }

  return (
    req.user.batchIds || []
  ).map(id => id);
}


/* =====================================================
   HEALTH
   ===================================================== */

app.get(
  '/health',
  (req, res) => {

    res.json({
      ok: true,
      service: 'zx-backend'
    });

  }
);


/* =====================================================
   AUTH LOGIN
   ===================================================== */

app.post(
  '/api/auth/login',
  async (req, res) => {

    try {

      const {
        username,
        password,
        authToken
      } = req.body || {};


      /* MASTER AUTH TOKEN */

      if (authToken) {

        if (
          authToken ===
          process.env.ADMIN_AUTH_TOKEN
        ) {

          const token =
            sign({
              _id:
                'master-token-user',

              username:
                'Master Admin',

              role:
                'Batch Uploader',

              scope:
                'all',

              batchIds:
                []
            });


          return res.json({
            success: true,
            token,

            role:
              'Batch Uploader',

            scope:
              'all'
          });
        }


        /* SCOPED UPLOADER TOKEN */

        const tokenHash =
          hashToken(authToken);


        const uploader =
          await UploaderToken
            .findOne({
              tokenHash,
              active: true
            })
            .populate(
              'batchIds'
            );


        if (!uploader) {

          return res.status(401).json({
            success: false,
            message:
              'Invalid or inactive auth token'
          });
        }


        const token =
          sign({

            _id:
              uploader._id,

            username:
              uploader.name,

            role:
              'Batch Uploader',

            scope:
              'batches',

            batchIds:
              uploader.batchIds
                .map(
                  b => b._id
                )
          });


        return res.json({

          success: true,

          token,

          role:
            'Batch Uploader',

          scope:
            'batches'

        });
      }


      /* USERNAME/PASSWORD LOGIN */

      if (
        !username ||
        !password
      ) {

        return res.status(400).json({
          success: false,
          message:
            'Username and password required'
        });
      }


      const user =
        await User.findOne({
          username
        });


      if (
        !user ||
        !(
          await bcrypt.compare(
            password,
            user.passwordHash
          )
        )
      ) {

        return res.status(401).json({
          success: false,
          message:
            'Invalid login'
        });
      }


      const token =
        sign({

          _id:
            user._id,

          username:
            user.username,

          role:
            user.role,

          scope:
            'all',

          batchIds:
            []
        });


      res.json({

        success: true,

        token,

        role:
          user.role,

        scope:
          'all'

      });

    } catch (e) {

      console.error(
        'Login error:',
        e
      );

      res.status(500).json({

        success: false,

        message:
          'Login failed'

      });
    }
  }
);


/* =====================================================
   PUBLIC APIs
   ===================================================== */

app.get(
  '/api/public/batches',
  async (req, res) => {

    try {

      const batches =
        await Batch
          .find({
            active: true
          })
          .sort({
            category: 1,
            name: 1
          });


      res.json({

        success: true,

        batches

      });

    } catch (e) {

      res.status(500).json({

        success: false,

        message:
          'Failed to load batches'

      });
    }
  }
);


app.get(
  '/api/public/batches/:id/:type',
  async (req, res) => {

    try {

      const type =
        req.params.type === 'dpp' ||
        req.params.type === 'dpps'
          ? 'dpp'
          : 'test';


      const items =
        await Test
          .find({

            batchId:
              req.params.id,

            type,

            published:
              true

          })
          .sort({

            startTime:
              -1,

            createdAt:
              -1

          });


      res.json({

        success: true,

        items

      });

    } catch (e) {

      res.status(500).json({

        success: false,

        message:
          'Failed to load content'

      });
    }
  }
);


/* =====================================================
   CURRENT USER
   ===================================================== */

app.get(
  '/api/admin/me',
  auth,
  async (req, res) => {

    try {

      res.json({

        success: true,

        user: {

          sub:
            req.user.sub,

          username:
            req.user.username,

          role:
            req.user.role,

          scope:
            req.user.scope || 'all',

          batchIds:
            req.user.batchIds || []

        }

      });

    } catch (e) {

      res.status(500).json({

        success: false,

        message:
          'Failed to load user'

      });
    }
  }
);


/* =====================================================
   PENPENCIL SOURCE BATCHES
   ===================================================== */

app.get(
  '/api/admin/source/batches',
  auth,
  async (req, res) => {

    try {

      const data =
        await penpencilRequest(
          '/users/batches?page=1&limit=50'
        );


      res.json({

        success: true,

        data

      });

    } catch (e) {

      console.error(
        'PenPencil batches error:',
        e.message
      );


      res.status(502).json({

        success: false,

        message:
          e.message

      });
    }
  }
);


/* =====================================================
   PENPENCIL TESTS
   ===================================================== */

app.get(
  '/api/admin/source/batches/:batchId/tests',
  auth,
  async (req, res) => {

    try {

      const data =
        await penpencilRequest(

          `/batches/${encodeURIComponent(
            req.params.batchId
          )}/tests`

        );


      res.json({

        success: true,

        data

      });

    } catch (e) {

      console.error(
        'PenPencil tests error:',
        e.message
      );


      res.status(502).json({

        success: false,

        message:
          e.message

      });
    }
  }
);


/* =====================================================
   PENPENCIL DPPs
   ===================================================== */

app.get(
  '/api/admin/source/batches/:batchId/dpps',
  auth,
  async (req, res) => {

    try {

      const data =
        await penpencilRequest(

          `/batches/${encodeURIComponent(
            req.params.batchId
          )}/dpps`

        );


      res.json({

        success: true,

        data

      });

    } catch (e) {

      console.error(
        'PenPencil DPP error:',
        e.message
      );


      res.status(502).json({

        success: false,

        message:
          e.message

      });
    }
  }
);


/* =====================================================
   PENPENCIL TEST DETAILS
   ===================================================== */

app.get(
  '/api/admin/source/tests/:testId',
  auth,
  async (req, res) => {

    try {

      const data =
        await penpencilRequest(

          `/tests/${encodeURIComponent(
            req.params.testId
          )}`

        );


      res.json({

        success: true,

        data

      });

    } catch (e) {

      console.error(
        'PenPencil test details error:',
        e.message
      );


      res.status(502).json({

        success: false,

        message:
          e.message

      });
    }
  }
);


/* =====================================================
   ADMIN BATCHES
   ===================================================== */

app.get(
  '/api/admin/batches',
  auth,
  async (req, res) => {

    try {

      let batches;


      if (
        req.user.scope === 'all'
      ) {

        batches =
          await Batch
            .find()
            .sort({
              createdAt: -1
            });

      } else {

        batches =
          await Batch
            .find({

              _id: {
                $in:
                  await getAllowedBatchIds(
                    req
                  )
              }

            })
            .sort({
              createdAt: -1
            });
      }


      res.json({

        success: true,

        batches

      });

    } catch (e) {

      console.error(e);


      res.status(500).json({

        success: false,

        message:
          'Failed to load batches'

      });
    }
  }
);


/* =====================================================
   CREATE BATCH
   ===================================================== */

app.post(
  '/api/admin/batches',
  auth,
  masterOnly,
  async (req, res) => {

    try {

      const b =
        await Batch.create({

          name:
            req.body.name,

          category:
            req.body.category,

          subgroup:
            req.body.subgroup,

          exam:
            req.body.exam,

          language:
            req.body.language,

          status:
            req.body.status

        });


      res.json({

        success: true,

        batch:
          b

      });

    } catch (e) {

      res.status(400).json({

        success: false,

        message:
          e.message

      });
    }
  }
);


/* =====================================================
   UPDATE BATCH
   ===================================================== */

app.put(
  '/api/admin/batches/:id',
  auth,
  masterOnly,
  async (req, res) => {

    try {

      const b =
        await Batch.findByIdAndUpdate(

          req.params.id,

          {
            ...req.body,
            updatedAt:
              new Date()
          },

          {
            new: true
          }

        );


      res.json({

        success: true,

        batch:
          b

      });

    } catch (e) {

      res.status(400).json({

        success: false,

        message:
          'Update failed'

      });
    }
  }
);


/* =====================================================
   DELETE BATCH
   ===================================================== */

app.delete(
  '/api/admin/batches/:id',
  auth,
  masterOnly,
  async (req, res) => {

    try {

      await Test.deleteMany({
        batchId:
          req.params.id
      });


      await Batch.findByIdAndDelete(
        req.params.id
      );


      res.json({
        success: true
      });

    } catch (e) {

      res.status(400).json({

        success: false,

        message:
          'Delete failed'

      });
    }
  }
);


/* =====================================================
   CONTENT LIST
   ===================================================== */

app.get(
  '/api/admin/batches/:id/content/:type',
  auth,
  async (req, res) => {

    try {

      if (
        !canAccessBatch(
          req,
          req.params.id
        )
      ) {

        return res.status(403).json({

          success: false,

          message:
            'You do not have access to this batch'

        });
      }


      const type =
        req.params.type === 'dpp' ||
        req.params.type === 'dpps'
          ? 'dpp'
          : 'test';


      const items =
        await Test
          .find({

            batchId:
              req.params.id,

            type

          })
          .sort({

            startTime:
              -1,

            createdAt:
              -1

          });


      res.json({

        success: true,

        items

      });

    } catch (e) {

      res.status(500).json({

        success: false,

        message:
          'Failed to load content'

      });
    }
  }
);


/* =====================================================
   UPLOAD TEST / DPP
   ===================================================== */

app.post(
  '/api/admin/batches/:id/content/:type',
  auth,
  async (req, res) => {

    try {

      if (
        !canAccessBatch(
          req,
          req.params.id
        )
      ) {

        return res.status(403).json({

          success: false,

          message:
            'You do not have access to this batch'

        });
      }


      const type =
        req.params.type === 'dpp' ||
        req.params.type === 'dpps'
          ? 'dpp'
          : 'test';


      const questions =
        Array.isArray(
          req.body.questions
        )
          ? req.body.questions
          : [];


      const item =
        await Test.create({

          batchId:
            req.params.id,

          type,

          title:
            req.body.title,

          instructions:
            req.body.instructions || '',

          startTime:
            req.body.startTime ||
            null,

          questions,

          totalQuestions:
            questions.length,

          published:
            req.body.published !== false,

          uploadedAt:
            new Date()

        });


      res.json({

        success: true,

        item

      });

    } catch (e) {

      console.error(e);


      res.status(400).json({

        success: false,

        message:
          e.message

      });
    }
  }
);


/* =====================================================
   PUBLISH
   ===================================================== */

app.post(
  '/api/admin/content/:id/publish',
  auth,
  async (req, res) => {

    try {

      const item =
        await Test.findById(
          req.params.id
        );


      if (!item) {

        return res.status(404).json({

          success: false,

          message:
            'Content not found'

        });
      }


      if (
        !canAccessBatch(
          req,
          item.batchId
        )
      ) {

        return res.status(403).json({

          success: false,

          message:
            'Access denied'

        });
      }


      item.published =
        true;

      item.updatedAt =
        new Date();


      await item.save();


      res.json({

        success: true,

        item

      });

    } catch (e) {

      res.status(400).json({

        success: false,

        message:
          'Publish failed'

      });
    }
  }
);


/* =====================================================
   UNPUBLISH
   ===================================================== */

app.post(
  '/api/admin/content/:id/unpublish',
  auth,
  async (req, res) => {

    try {

      const item =
        await Test.findById(
          req.params.id
        );


      if (!item) {

        return res.status(404).json({

          success: false,

          message:
            'Content not found'

        });
      }


      if (
        !canAccessBatch(
          req,
          item.batchId
        )
      ) {

        return res.status(403).json({

          success: false,

          message:
            'Access denied'

        });
      }


      item.published =
        false;

      item.updatedAt =
        new Date();


      await item.save();


      res.json({

        success: true,

        item

      });

    } catch (e) {

      res.status(400).json({

        success: false,

        message:
          'Unpublish failed'

      });
    }
  }
);


/* =====================================================
   DELETE CONTENT
   ===================================================== */

app.delete(
  '/api/admin/content/:id',
  auth,
  async (req, res) => {

    try {

      const item =
        await Test.findById(
          req.params.id
        );


      if (!item) {

        return res.status(404).json({

          success: false,

          message:
            'Content not found'

        });
      }


      if (
        !canAccessBatch(
          req,
          item.batchId
        )
      ) {

        return res.status(403).json({

          success: false,

          message:
            'Access denied'

        });
      }


      await Test.findByIdAndDelete(
        req.params.id
      );


      res.json({
        success: true
      });

    } catch (e) {

      res.status(400).json({

        success: false,

        message:
          'Delete failed'

      });
    }
  }
);


/* =====================================================
   STATS
   ===================================================== */

app.get(
  '/api/admin/stats',
  auth,
  async (req, res) => {

    try {

      let batchFilter = {};


      if (
        req.user.scope !== 'all'
      ) {

        batchFilter = {

          batchId: {

            $in:
              await getAllowedBatchIds(
                req
              )

          }

        };
      }


      const batches =
        req.user.scope === 'all'

          ? await Batch
              .countDocuments()

          : await Batch
              .countDocuments({

                _id: {

                  $in:
                    await getAllowedBatchIds(
                      req
                    )

                }

              });


      const tests =
        await Test.countDocuments({

          ...batchFilter,

          type:
            'test'

        });


      const dpps =
        await Test.countDocuments({

          ...batchFilter,

          type:
            'dpp'

        });


      const published =
        await Test.countDocuments({

          ...batchFilter,

          published:
            true

        });


      res.json({

        success: true,

        batches,

        tests,

        dpps,

        published

      });

    } catch (e) {

      console.error(e);


      res.status(500).json({

        success: false

      });
    }
  }
);


/* =====================================================
   UPLOADER TOKENS
   ===================================================== */

app.get(
  '/api/admin/uploader-tokens',
  auth,
  masterOnly,
  async (req, res) => {

    try {

      const tokens =
        await UploaderToken
          .find()
          .populate(
            'batchIds',
            'name status category'
          )
          .sort({
            createdAt:
              -1
          })
          .lean();


      const result =
        tokens.map(
          t => ({

            id:
              t._id,

            name:
              t.name,

            active:
              t.active,

            createdAt:
              t.createdAt,

            batches:
              t.batchIds || []

          })
        );


      res.json({

        success: true,

        tokens:
          result

      });

    } catch (e) {

      console.error(e);


      res.status(500).json({

        success: false,

        message:
          'Failed to load uploader tokens'

      });
    }
  }
);


/* =====================================================
   CREATE UPLOADER TOKEN
   ===================================================== */

app.post(
  '/api/admin/uploader-tokens',
  auth,
  masterOnly,
  async (req, res) => {

    try {

      const name =
        String(
          req.body.name || ''
        ).trim();


      const batchIds =
        Array.isArray(
          req.body.batchIds
        )
          ? req.body.batchIds
          : [];


      if (!name) {

        return res.status(400).json({

          success: false,

          message:
            'Token name is required'

        });
      }


      if (!batchIds.length) {

        return res.status(400).json({

          success: false,

          message:
            'Select at least one batch'

        });
      }


      const batches =
        await Batch.find({

          _id: {
            $in:
              batchIds
          }

        });


      if (
        batches.length !==
        batchIds.length
      ) {

        return res.status(400).json({

          success: false,

          message:
            'One or more batches are invalid'

        });
      }


      const plainToken =
        generateUploaderToken();


      const tokenHash =
        hashToken(
          plainToken
        );


      const uploader =
        await UploaderToken.create({

          name,

          tokenHash,

          batchIds,

          active:
            true

        });


      res.json({

        success: true,

        token:
          plainToken,

        uploader: {

          id:
            uploader._id,

          name:
            uploader.name,

          batchIds:
            uploader.batchIds,

          active:
            uploader.active

        }

      });

    } catch (e) {

      console.error(e);


      res.status(400).json({

        success: false,

        message:
          e.message

      });
    }
  }
);


/* =====================================================
   REVOKE UPLOADER TOKEN
   ===================================================== */

app.delete(
  '/api/admin/uploader-tokens/:id',
  auth,
  masterOnly,
  async (req, res) => {

    try {

      await UploaderToken
        .findByIdAndUpdate(

          req.params.id,

          {
            active:
              false
          }

        );


      res.json({
        success: true
      });

    } catch (e) {

      res.status(400).json({

        success: false,

        message:
          'Failed to revoke token'

      });
    }
  }
);


/* =====================================================
   SERVER
   ===================================================== */

app.listen(
  PORT,
  () => {

    console.log(
      `ZX backend running on ${PORT}`
    );

  }
);


/* =====================================================
   DATABASE BOOT
   ===================================================== */

async function boot() {

  if (
    !process.env.MONGO_URI
  ) {

    console.warn(
      'MONGO_URI is required for persistent data.'
    );

    return;
  }


  await mongoose.connect(
    process.env.MONGO_URI
  );


  console.log(
    'MongoDB connected'
  );


  const username =
    process.env.ADMIN_USERNAME ||
    'admin';


  const password =
    process.env.ADMIN_PASSWORD ||
    'change-me';


  const exists =
    await User.findOne({
      username
    });


  if (!exists) {

    await User.create({

      username,

      passwordHash:
        await bcrypt.hash(
          password,
          10
        ),

      role:
        'Batch Uploader'

    });

  }
}


boot().catch(
  e =>
    console.error(
      'DB boot error:',
      e.message
    )
);
