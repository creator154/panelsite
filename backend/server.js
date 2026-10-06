require('dotenv').config();
const express=require('express');
const cors=require('cors');
const mongoose=require('mongoose');
const jwt=require('jsonwebtoken');
const bcrypt=require('bcryptjs');
const path=require('path');
const Batch=require('./models/Batch');
const Test=require('./models/Test');
const User=require('./models/User');

const app=express();
const PORT=process.env.PORT||3000;
app.use(cors({origin:true}));
app.use(express.json({limit:'20mb'}));
app.use(express.urlencoded({extended:true,limit:'20mb'}));

function sign(user){return jwt.sign({sub:String(user._id),username:user.username,role:user.role},process.env.JWT_SECRET||'change-this-secret',{expiresIn:'7d'});}
function auth(req,res,next){
  const h=req.headers.authorization||''; const token=h.replace(/^Bearer\s+/i,'');
  if(!token)return res.status(401).json({success:false,message:'Authentication required'});
  try{req.user=jwt.verify(token,process.env.JWT_SECRET||'change-this-secret');next();}
  catch(e){return res.status(401).json({success:false,message:'Invalid or expired token'});}
}

app.get('/health',(req,res)=>res.json({ok:true,service:'zx-backend'}));

app.post('/api/auth/login',async(req,res)=>{
  try{
    const {username,password,authToken}=req.body||{};
    if(authToken){
      if(authToken===process.env.ADMIN_AUTH_TOKEN){
        return res.json({success:true,token:sign({ _id:'token-user',username:'Batch Uploader',role:'Batch Uploader'})});
      }
      return res.status(401).json({success:false,message:'Invalid auth token'});
    }
    if(!username||!password)return res.status(400).json({success:false,message:'Username and password required'});
    const user=await User.findOne({username});
    if(!user||!(await bcrypt.compare(password,user.passwordHash)))return res.status(401).json({success:false,message:'Invalid login'});
    res.json({success:true,token:sign(user),role:user.role});
  }catch(e){res.status(500).json({success:false,message:'Login failed'});}
});

// Public APIs: only content marked active/published is exposed.
app.get('/api/public/batches',async(req,res)=>{
  try{const batches=await Batch.find({active:true}).sort({category:1,name:1});res.json({success:true,batches});}
  catch(e){res.status(500).json({success:false,message:'Failed to load batches'});}
});
app.get('/api/public/batches/:id/:type',async(req,res)=>{
  try{
    const type=req.params.type==='dpp'||req.params.type==='dpps'?'dpp':'test';
    const items=await Test.find({batchId:req.params.id,type,published:true}).sort({startTime:-1,createdAt:-1});
    res.json({success:true,items});
  }catch(e){res.status(500).json({success:false,message:'Failed to load content'});}
});

// Admin/uploader APIs: this is the user's own backend; no external source API is used.
app.get('/api/admin/me',auth,(req,res)=>res.json({success:true,user:req.user}));
app.get('/api/admin/batches',auth,async(req,res)=>{try{res.json({success:true,batches:await Batch.find().sort({createdAt:-1})});}catch(e){res.status(500).json({success:false,message:'Failed to load batches'});}});
app.post('/api/admin/batches',auth,async(req,res)=>{
  try{const b=await Batch.create({name:req.body.name,category:req.body.category,subgroup:req.body.subgroup,exam:req.body.exam,language:req.body.language,status:req.body.status});res.json({success:true,batch:b});}
  catch(e){res.status(400).json({success:false,message:e.message});}
});
app.put('/api/admin/batches/:id',auth,async(req,res)=>{try{const b=await Batch.findByIdAndUpdate(req.params.id,{...req.body,updatedAt:new Date()},{new:true});res.json({success:true,batch:b});}catch(e){res.status(400).json({success:false,message:'Update failed'});}});
app.delete('/api/admin/batches/:id',auth,async(req,res)=>{try{await Test.deleteMany({batchId:req.params.id});await Batch.findByIdAndDelete(req.params.id);res.json({success:true});}catch(e){res.status(400).json({success:false,message:'Delete failed'});}});

app.get('/api/admin/batches/:id/content/:type',auth,async(req,res)=>{try{const type=req.params.type==='dpp'||req.params.type==='dpps'?'dpp':'test';res.json({success:true,items:await Test.find({batchId:req.params.id,type}).sort({startTime:-1,createdAt:-1})});}catch(e){res.status(500).json({success:false,message:'Failed to load content'});}});
app.post('/api/admin/batches/:id/content/:type',auth,async(req,res)=>{
  try{
    const type=req.params.type==='dpp'||req.params.type==='dpps'?'dpp':'test';
    const questions=Array.isArray(req.body.questions)?req.body.questions:[];
    const item=await Test.create({batchId:req.params.id,type,title:req.body.title,instructions:req.body.instructions||'',startTime:req.body.startTime||null,questions,totalQuestions:questions.length,published:req.body.published!==false,uploadedAt:new Date()});
    res.json({success:true,item});
  }catch(e){res.status(400).json({success:false,message:e.message});}
});
app.post('/api/admin/content/:id/publish',auth,async(req,res)=>{try{const item=await Test.findByIdAndUpdate(req.params.id,{published:true,updatedAt:new Date()},{new:true});res.json({success:true,item});}catch(e){res.status(400).json({success:false,message:'Publish failed'});}});
app.post('/api/admin/content/:id/unpublish',auth,async(req,res)=>{try{const item=await Test.findByIdAndUpdate(req.params.id,{published:false,updatedAt:new Date()},{new:true});res.json({success:true,item});}catch(e){res.status(400).json({success:false,message:'Unpublish failed'});}});
app.delete('/api/admin/content/:id',auth,async(req,res)=>{try{await Test.findByIdAndDelete(req.params.id);res.json({success:true});}catch(e){res.status(400).json({success:false,message:'Delete failed'});}});

app.get('/api/admin/stats',auth,async(req,res)=>{try{res.json({success:true,batches:await Batch.countDocuments(),tests:await Test.countDocuments({type:'test'}),dpps:await Test.countDocuments({type:'dpp'}),published:await Test.countDocuments({published:true})});}catch(e){res.status(500).json({success:false});}});

// Keep backend API-only. Public and panel remain deployable as separate apps.
app.listen(PORT,()=>console.log(`ZX backend running on ${PORT}`));

async function boot(){
  if(!process.env.MONGO_URI){console.warn('MONGO_URI is required for persistent data.');return;}
  await mongoose.connect(process.env.MONGO_URI); console.log('MongoDB connected');
  const username=process.env.ADMIN_USERNAME||'admin';
  const password=process.env.ADMIN_PASSWORD||'change-me';
  const exists=await User.findOne({username});
  if(!exists) await User.create({username,passwordHash:await bcrypt.hash(password,10),role:'Batch Uploader'});
}
boot().catch(e=>console.error('DB boot error:',e.message));
