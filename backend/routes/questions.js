'use strict';

const express = require('express');
const mongoose = require('mongoose');

const router = express.Router();

/*
 * Questions API
 * Save questions and retrieve them by test ID.
 */

const QuestionSetSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      default: 'authorized-source'
    },

    sourceTestId: {
      type: String,
      required: true
    },

    title: {
      type: String,
      default: ''
    },

    questions: {
      type: [mongoose.Schema.Types.Mixed],
      default: []
    },

    updatedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

const QuestionSet =
  mongoose.models.QuestionSet ||
  mongoose.model('QuestionSet', QuestionSetSchema);


/*
 * POST /api/questions/:testId
 * Save question data.
 */

router.post('/:testId', async (req, res) => {
  try {
    const testId = String(req.params.testId || '').trim();
    const { title = '', questions } = req.body;

    if (!testId) {
      return res.status(400).json({
        success: false,
        error: 'Test ID is required'
      });
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(422).json({
        success: false,
        error: 'Valid question array is required'
      });
    }

    const document = await QuestionSet.findOneAndUpdate(
      { sourceTestId: testId },
      {
        $set: {
          title,
          questions,
          updatedAt: new Date()
        }
      },
      {
        new: true,
        upsert: true,
        runValidators: true
      }
    );

    return res.json({
      success: true,
      message: 'Questions saved successfully',
      testId: document.sourceTestId,
      totalQuestions: document.questions.length
    });

  } catch (error) {
    console.error('Save questions error:', error.message);

    return res.status(500).json({
      success: false,
      error: 'Unable to save questions'
    });
  }
});


/*
 * GET /api/questions/:testId
 * Retrieve saved questions.
 */

router.get('/:testId', async (req, res) => {
  try {
    const testId = String(req.params.testId || '').trim();

    const document = await QuestionSet.findOne({
      sourceTestId: testId
    }).lean();

    if (!document) {
      return res.status(404).json({
        success: false,
        error: 'Questions not found',
        testId
      });
    }

    return res.json({
      success: true,
      testId: document.sourceTestId,
      title: document.title,
      totalQuestions: document.questions.length,
      questions: document.questions
    });

  } catch (error) {
    console.error('Get questions error:', error.message);

    return res.status(500).json({
      success: false,
      error: 'Unable to retrieve questions'
    });
  }
});


module.exports = router;
