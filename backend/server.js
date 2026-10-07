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


/* =====================================================
   MIDDLEWARE
===================================================== */

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


/* =====================================================
   CONFIG
===================================================== */

const JWT_SECRET =
  process.env.JWT_SECRET ||
  'change-this-secret';


const PENPENCIL_API_TOKEN =
  process.env.PENPENCIL_API_TOKEN ||
  '';


/*
  IMPORTANT

  Old:
  https://api.penpencil.xyz/v1

  New default:
  https://api.penpencil.co/v1

  You can also override this from Heroku Config Vars:
  PENPENCIL_BASE
*/

const PENPENCIL_BASE =
  (
    process.env.PENPENCIL_BASE ||
    'https://api.penpencil.co/v1'
  ).replace(/\/$/, '');


/*
  Keep source paths configurable.
*/

const PENPENCIL_BATCHES_PATH =
  process.env.PENPENCIL_BATCHES_PATH ||
  '/users/batches?page=1&limit=50';


/*
  Existing Batch model may already contain this.
  Add dynamically if not present.
*/

if (!Batch.schema.path('sourceBatchId')) {

  Batch.schema.add({
    sourceBatchId: {
      type: String,
      index: true
    }
  });

}


/* =====================================================
   PENPENCIL REQUEST
===================================================== */

async function penpencilRequest(path) {

  if (!PENPENCIL_API_TOKEN) {

    throw new Error(
      'PENPENCIL_API_TOKEN is missing in Heroku Config Vars'
    );

  }


  const cleanPath =
    String(path).startsWith('/')
      ? String(path)
      : `/${path}`;


  const url =
    PENPENCIL_BASE + cleanPath;


  console.log(
    'PenPencil request:',
    url
  );


  const response =
    await fetch(url, {
      method: 'GET',

      headers: {

        Authorization:
          'Bearer ' +
          PENPENCIL_API_TOKEN,

        Accept:
          'application/json',

        'User-Agent':
          'ZX-Batch-Uploader/1.0'
      }
    });


  const text =
    await response.text();


  let data = {};


  try {

    data =
      text
        ? JSON.parse(text)
        : {};

  } catch {

    data = {
      raw: text
    };

  }


  if (!response.ok) {

    console.error(
      'PenPencil API error:',
      response.status,
      data
    );


    throw new Error(
      data?.message ||
      data?.error?.message ||
      data?.error ||
      `PenPencil API returned ${response.status}`
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
    .update(String(token))
    .digest('hex');

}


function generateUploaderToken() {

  return crypto.randomBytes(32).toString('hex');

}


/* =====================================================
   JWT
===================================================== */

function sign(user) {

  return jwt.sign(

    {
      sub:
        String(user._id),

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


/* =====================================================
   AUTH
===================================================== */

function auth(req, res, next) {

  const header =
    req.headers.authorization || '';


  const token =
    header.replace(
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

  } catch {

    return res.status(401).json({

      success: false,

      message:
        'Invalid or expired token'

    });

  }

}


/* =====================================================
   MASTER ONLY
===================================================== */

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


/* =====================================================
   LOCAL BATCH ACCESS
===================================================== */

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
  )
    .map(String);

}


/* =====================================================
   SOURCE BATCH ACCESS
===================================================== */

async function canAccessSourceBatch(
  req,
  sourceBatchId
) {

  if (!req.user) {
    return false;
  }


  if (
    req.user.scope === 'all'
  ) {

    return true;

  }


  const allowedLocalIds =
    (
      req.user.batchIds || []
    ).map(String);


  if (!allowedLocalIds.length) {
    return false;
  }


  const batch =
    await Batch.findOne({

      _id: {
        $in:
          allowedLocalIds
      },

      sourceBatchId:
        String(sourceBatchId),

      active:
        true

    }).lean();


  return !!batch;

}


/* =====================================================
   ALLOWED SOURCE BATCH IDS
===================================================== */

async function getAllowedSourceBatchIds(req) {

  if (
    req.user.scope === 'all'
  ) {

    return null;

  }


  const allowedLocalIds =
    (
      req.user.batchIds || []
    ).map(String);


  if (!allowedLocalIds.length) {
    return [];
  }


  const batches =
    await Batch.find({

      _id: {
        $in:
          allowedLocalIds
      },

      active:
        true,

      sourceBatchId: {
        $exists: true,
        $ne: ''
      }

    })
      .select(
        '_id sourceBatchId'
      )
      .lean();


  return batches
    .map(
      b =>
        String(
          b.sourceBatchId
        )
    )
    .filter(Boolean);

}


/* =====================================================
   SOURCE ARRAY NORMALIZER
===================================================== */

function sourceArray(data) {

  if (Array.isArray(data)) {
    return data;
  }


  if (
    Array.isArray(data?.data)
  ) {
    return data.data;
  }


  if (
    Array.isArray(
      data?.data?.data
    )
  ) {
    return data.data.data;
  }


  if (
    Array.isArray(
      data?.data?.batches
    )
  ) {
    return data.data.batches;
  }


  if (
    Array.isArray(
      data?.data?.items
    )
  ) {
    return data.data.items;
  }


  if (
    Array.isArray(
      data?.data?.results
    )
  ) {
    return data.data.results;
  }


  if (
    Array.isArray(
      data?.results
    )
  ) {
    return data.results;
  }


  if (
    Array.isArray(
      data?.items
    )
  ) {
    return data.items;
  }


  if (
    Array.isArray(
      data?.batches
    )
  ) {
    return data.batches;
  }


  if (
    Array.isArray(
      data?.tests
    )
  ) {
    return data.tests;
  }


  if (
    Array.isArray(
      data?.dpps
    )
  ) {
    return data.dpps;
  }


  return [];

}


/* =====================================================
   SOURCE BATCH ID
===================================================== */

function getSourceBatchId(batch) {

  if (!batch) {
    return '';
  }


  return String(

    batch._id ||

    batch.id ||

    batch.batchId ||

    batch.batch_id ||

    ''

  );

}


/* =====================================================
   HEALTH
===================================================== */

app.get(
  '/health',
  (req, res) => {

    res.json({

      ok: true,

      service:
        'zx-backend'

    });

  }
);


/* =====================================================
   ROOT
===================================================== */

app.get(
  '/',
  (req, res) => {

    res.json({

      ok: true,

      service:
        'zx-backend',

      message:
        'ZX backend is running'

    });

  }
);


/* =====================================================
   LOGIN
===================================================== */

app.post(
  '/api/auth/login',
  async (req, res) => {

    try {

      const {
        username,
        password,
        authToken
      } =
        req.body || {};


      /* -----------------------------------------------
         MASTER AUTH TOKEN
      ------------------------------------------------ */

      if (authToken) {

        if (

          process.env.ADMIN_AUTH_TOKEN &&

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

            success:
              true,

            token,

            role:
              'Batch Uploader',

            scope:
              'all'

          });

        }


        /* ---------------------------------------------
           SCOPED UPLOADER TOKEN
        ---------------------------------------------- */

        const tokenHash =
          hashToken(
            authToken
          );


        const uploader =
          await UploaderToken
            .findOne({

              tokenHash,

              active:
                true

            })
            .populate(
              'batchIds'
            );


        if (!uploader) {

          return res.status(401).json({

            success:
              false,

            message:
              'Invalid or inactive auth token'

          });

        }


        const assignedBatchIds =
          (
            uploader.batchIds || []
          )
            .map(
              b =>
                b?._id
            )
            .filter(Boolean)
            .map(String);


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
              assignedBatchIds

          });


        return res.json({

          success:
            true,

          token,

          role:
            'Batch Uploader',

          scope:
            'batches',

          batchIds:
            assignedBatchIds

        });

      }


      /* ---------------------------------------------
         USERNAME / PASSWORD
      ---------------------------------------------- */

      if (
        !username ||
        !password
      ) {

        return res.status(400).json({

          success:
            false,

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

        !(await bcrypt.compare(
          password,
          user.passwordHash
        ))

      ) {

        return res.status(401).json({

          success:
            false,

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


      return res.json({

        success:
          true,

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


      return res.status(500).json({

        success:
          false,

        message:
          'Login failed'

      });

    }

  }
);


/* =====================================================
   PUBLIC BATCHES
===================================================== */

app.get(
  '/api/public/batches',
  async (req, res) => {

    try {

      const batches =
        await Batch.find({

          active:
            true

        })
          .sort({

            category:
              1,

            name:
              1

          });


      return res.json({

        success:
          true,

        batches

      });


    } catch (e) {

      console.error(e);


      return res.status(500).json({

        success:
          false,

        message:
          'Failed to load batches'

      });

    }

  }
);


/* =====================================================
   PUBLIC CONTENT
===================================================== */

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
        await Test.find({

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


      return res.json({

        success:
          true,

        items

      });


    } catch (e) {

      console.error(e);


      return res.status(500).json({

        success:
          false,

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

    return res.json({

      success:
        true,

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

  }
);


/* =====================================================
   SOURCE BATCHES
===================================================== */

app.get(
  '/api/admin/source/batches',
  auth,
  async (req, res) => {

    try {

      console.log(
        'Loading source batches...'
      );


      const data =
        await penpencilRequest(
          PENPENCIL_BATCHES_PATH
        );


      let batches =
        sourceArray(data);


      console.log(
        'Source batches from API:',
        batches.length
      );


      /* ---------------------------------------------
         SCOPED UPLOADER
      ---------------------------------------------- */

      if (
        req.user.scope !== 'all'
      ) {

        const allowedSourceIds =
          await getAllowedSourceBatchIds(
            req
          );


        const allowedSet =
          new Set(
            allowedSourceIds
              .map(String)
          );


        batches =
          batches.filter(
            batch => {

              const sourceId =
                getSourceBatchId(
                  batch
                );


              return (

                sourceId &&

                allowedSet.has(
                  sourceId
                )

              );

            }
          );

      }


      console.log(

        'Source batches returned:',
        batches.length,

        'scope:',
        req.user.scope

      );


      return res.json({

        success:
          true,

        data,

        batches

      });


    } catch (e) {

      console.error(

        'PenPencil batches error:',
        e.message

      );


      return res.status(502).json({

        success:
          false,

        message:
          e.message,

        batches:
          []

      });

    }

  }
);


/* =====================================================
   SOURCE TESTS
===================================================== */

app.get(
  '/api/admin/source/batches/:batchId/tests',
  auth,
  async (req, res) => {

    try {

      const sourceBatchId =
        String(
          req.params.batchId
        );


      const allowed =
        await canAccessSourceBatch(

          req,

          sourceBatchId

        );


      if (!allowed) {

        return res.status(403).json({

          success:
            false,

          message:
            'You do not have access to this source batch',

          items:
            []

        });

      }


      const id =
        encodeURIComponent(
          sourceBatchId
        );


      const data =
        await penpencilRequest(

          `/batches/${id}/tests`

        );


      const items =
        sourceArray(data);


      return res.json({

        success:
          true,

        data,

        items

      });


    } catch (e) {

      console.error(

        'PenPencil tests error:',
        e.message

      );


      return res.status(502).json({

        success:
          false,

        message:
          e.message,

        items:
          []

      });

    }

  }
);


/* =====================================================
   SOURCE DPPs
===================================================== */

app.get(
  '/api/admin/source/batches/:batchId/dpps',
  auth,
  async (req, res) => {

    try {

      const sourceBatchId =
        String(
          req.params.batchId
        );


      const allowed =
        await canAccessSourceBatch(

          req,

          sourceBatchId

        );


      if (!allowed) {

        return res.status(403).json({

          success:
            false,

          message:
            'You do not have access to this source batch',

          items:
            []

        });

      }


      const id =
        encodeURIComponent(
          sourceBatchId
        );


      const data =
        await penpencilRequest(

          `/batches/${id}/dpps`

        );


      const items =
        sourceArray(data);


      return res.json({

        success:
          true,

        data,

        items

      });


    } catch (e) {

      console.error(

        'PenPencil DPP error:',
        e.message

      );


      return res.status(502).json({

        success:
          false,

        message:
          e.message,

        items:
          []

      });

    }

  }
);


/* =====================================================
   SOURCE TEST DETAILS
===================================================== */

app.get(
  '/api/admin/source/tests/:testId',
  auth,
  async (req, res) => {

    try {

      const requestedBatchId =
        req.query.batchId
          ? String(
              req.query.batchId
            )
          : '';


      if (

        requestedBatchId &&

        !(await canAccessSourceBatch(

          req,

          requestedBatchId

        ))

      ) {

        return res.status(403).json({

          success:
            false,

          message:
            'You do not have access to this source batch'

        });

      }


      const id =
        encodeURIComponent(
          req.params.testId
        );


      const data =
        await penpencilRequest(

          `/tests/${id}`

        );


      return res.json({

        success:
          true,

        data

      });


    } catch (e) {

      console.error(

        'PenPencil test details error:',
        e.message

      );


      return res.status(502).json({

        success:
          false,

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
          await Batch.find()
            .sort({
              createdAt:
                -1
            });

      } else {

        batches =
          await Batch.find({

            _id: {
              $in:
                await getAllowedBatchIds(
                  req
                )
            }

          })
            .sort({
              createdAt:
                -1
            });

      }


      return res.json({

        success:
          true,

        batches

      });


    } catch (e) {

      console.error(e);


      return res.status(500).json({

        success:
          false,

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

      const batch =
        await Batch.create({

          name:
            req.body.name,

          category:
            req.body.category ||
            'Other Batch Tests',

          subgroup:
            req.body.subgroup ||
            '',

          exam:
            req.body.exam ||
            '',

          language:
            req.body.language ||
            'Hindi',

          status:
            req.body.status ||
            'Paid',

          active:
            req.body.active !== false,

          sourceBatchId:
            req.body.sourceBatchId ||
            undefined

        });


      return res.json({

        success:
          true,

        batch

      });


    } catch (e) {

      console.error(e);


      return res.status(400).json({

        success:
          false,

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

      const batch =
        await Batch.findByIdAndUpdate(

          req.params.id,

          {
            ...req.body,

            updatedAt:
              new Date()
          },

          {
            new:
              true
          }

        );


      if (!batch) {

        return res.status(404).json({

          success:
            false,

          message:
            'Batch not found'

        });

      }


      return res.json({

        success:
          true,

        batch

      });


    } catch (e) {

      return res.status(400).json({

        success:
          false,

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


      return res.json({

        success:
          true

      });


    } catch (e) {

      return res.status(400).json({

        success:
          false,

        message:
          'Delete failed'

      });

    }

  }
);


/* =====================================================
   LOCAL CONTENT LIST
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

          success:
            false,

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
        await Test.find({

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


      return res.json({

        success:
          true,

        items

      });


    } catch (e) {

      console.error(e);


      return res.status(500).json({

        success:
          false,

        message:
          'Failed to load content'

      });

    }

  }
);


/* =====================================================
   CREATE LOCAL BATCH FROM SOURCE
===================================================== */

app.post(
  '/api/admin/source/batches/:sourceBatchId/local',
  auth,
  masterOnly,
  async (req, res) => {

    try {

      const srcId =
        String(
          req.params.sourceBatchId
        );


      let batch =
        await Batch.findOne({

          sourceBatchId:
            srcId

        });


      if (!batch) {

        const name =
          String(

            req.body.name ||

            'Source Batch'

          ).trim();


        batch =
          await Batch.create({

            name,

            category:
              req.body.category ||
              'Other Batch Tests',

            subgroup:
              req.body.subgroup ||
              '',

            exam:
              req.body.exam ||
              '',

            language:
              req.body.language ||
              'Hindi',

            status:
              req.body.status ||
              'Paid',

            active:
              true,

            sourceBatchId:
              srcId

          });

      }


      return res.json({

        success:
          true,

        batch

      });


    } catch (e) {

      console.error(

        'Local source batch error:',
        e

      );


      return res.status(400).json({

        success:
          false,

        message:
          e.message

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

          success:
            false,

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


      const title =
        String(

          req.body.title ||

          'Untitled'

        ).trim();


      const item =
        await Test.create({

          batchId:
            req.params.id,

          type,

          title,

          instructions:
            req.body.instructions ||
            '',

          startTime:
            req.body.startTime ||
            null,

          questions,

          totalQuestions:
            questions.length,

          published:
            req.body.published !== false,

          uploadedAt:
            new Date(),

          updatedAt:
            new Date()

        });


      return res.json({

        success:
          true,

        item

      });


    } catch (e) {

      console.error(
        'Upload error:',
        e
      );


      return res.status(400).json({

        success:
          false,

        message:
          e.message

      });

    }

  }
);


/* =====================================================
   PUBLISH / UNPUBLISH
===================================================== */

async function setPublished(
  req,
  res,
  value,
  failMessage
) {

  try {

    const item =
      await Test.findById(
        req.params.id
      );


    if (!item) {

      return res.status(404).json({

        success:
          false,

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

        success:
          false,

        message:
          'Access denied'

      });

    }


    item.published =
      value;

    item.updatedAt =
      new Date();


    await item.save();


    return res.json({

      success:
        true,

      item

    });


  } catch {

    return res.status(400).json({

      success:
        false,

      message:
        failMessage

    });

  }

}


app.post(
  '/api/admin/content/:id/publish',
  auth,
  (req, res) =>

    setPublished(
      req,
      res,
      true,
      'Publish failed'
    )

);


app.post(
  '/api/admin/content/:id/unpublish',
  auth,
  (req, res) =>

    setPublished(
      req,
      res,
      false,
      'Unpublish failed'
    )

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

          success:
            false,

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

          success:
            false,

          message:
            'Access denied'

        });

      }


      await Test.findByIdAndDelete(

        req.params.id

      );


      return res.json({

        success:
          true

      });


    } catch {

      return res.status(400).json({

        success:
          false,

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

          ? await Batch.countDocuments()

          : await Batch.countDocuments({

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


      return res.json({

        success:
          true,

        batches,

        tests,

        dpps,

        published

      });


    } catch (e) {

      console.error(e);


      return res.status(500).json({

        success:
          false,

        message:
          'Failed to load stats'

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
        await UploaderToken.find()

          .populate(

            'batchIds',

            'name status category sourceBatchId'

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


      return res.json({

        success:
          true,

        tokens:
          result

      });


    } catch (e) {

      console.error(e);


      return res.status(500).json({

        success:
          false,

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

          req.body.name ||
          ''

        ).trim();


      const batchIds =

        Array.isArray(
          req.body.batchIds
        )

          ? req.body.batchIds

          : [];


      if (!name) {

        return res.status(400).json({

          success:
            false,

          message:
            'Token name is required'

        });

      }


      if (!batchIds.length) {

        return res.status(400).json({

          success:
            false,

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

          success:
            false,

          message:
            'One or more batches are invalid'

        });

      }


      const unmapped =
        batches.filter(

          b =>

            !b.sourceBatchId ||

            !String(
              b.sourceBatchId
            ).trim()

        );


      if (unmapped.length) {

        return res.status(400).json({

          success:
            false,

          message:
            'Selected batch is not mapped to a source batch yet'

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


      return res.json({

        success:
          true,

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


      return res.status(400).json({

        success:
          false,

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

      await UploaderToken.findByIdAndUpdate(

        req.params.id,

        {
          active:
            false
        }

      );


      return res.json({

        success:
          true

      });


    } catch {

      return res.status(400).json({

        success:
          false,

        message:
          'Failed to revoke token'

      });

    }

  }
);


/* =====================================================
   DATABASE BOOT
===================================================== */

async function boot() {

  if (!process.env.MONGO_URI) {

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


    console.log(
      'Default admin user created'
    );

  }

}


boot().catch(
  e => {

    console.error(
      'DB boot error:',
      e.message
    );

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

    console.log(
      `PenPencil base: ${PENPENCIL_BASE}`
    );

  }

);
