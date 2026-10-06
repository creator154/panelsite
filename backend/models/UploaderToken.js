const mongoose = require('mongoose');

const uploaderTokenSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },

  tokenHash: {
    type: String,
    required: true,
    unique: true
  },

  batchIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Batch'
  }],

  active: {
    type: Boolean,
    default: true
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('UploaderToken', uploaderTokenSchema);
