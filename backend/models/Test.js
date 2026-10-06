const mongoose = require('mongoose');
const TestSchema = new mongoose.Schema({
  batchId:{type:mongoose.Schema.Types.ObjectId,ref:'Batch',required:true,index:true},
  type:{type:String,enum:['test','dpp'],required:true,index:true},
  title:{type:String,required:true,trim:true},
  startTime:{type:Date},
  instructions:{type:String,default:''},
  questions:{type:Array,default:[]},
  totalQuestions:{type:Number,default:0},
  published:{type:Boolean,default:true},
  uploadedAt:{type:Date},
  createdAt:{type:Date,default:Date.now},
  updatedAt:{type:Date,default:Date.now}
});
module.exports=mongoose.model('Test',TestSchema);
