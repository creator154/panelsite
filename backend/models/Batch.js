const mongoose = require('mongoose');

const BatchSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  category: { type: String, default: 'Other Batch Tests' },
  subgroup: { type: String, default: '' },
  exam: { type: String, default: '' },
  language: { type: String, default: 'Hindi' },
  status: { type: String, enum: ['Paid', 'Unpaid'], default: 'Paid' },
  active: { type: Boolean, default: true },
  sourceBatchId: { type: String, index: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Batch', BatchSchema);
