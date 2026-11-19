const express = require('express');
const { Pool } = require('pg');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});
async function initDB(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT DEFAULT 'Member', created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS codes (id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, room TEXT NOT NULL, active BOOLEAN DEFAULT true, admin_only BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, room TEXT NOT NULL, username TEXT NOT NULL, role TEXT DEFAULT 'Member', text TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS comments (id SERIAL PRIMARY KEY, post_id INT NOT NULL, username TEXT NOT NULL, text TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());
  `);
  const adminPass = process.env.ADMIN_PASSWORD || 'rubendhrah10';
  const hashed = bcrypt.hashSync(adminPass, 10);
  await pool.query(`INSERT INTO users (username,password,role) VALUES ('admin',$1,'OWNER') ON CONFLICT (username) DO NOTHING`, [hashed]);
  await pool.query(`INSERT INTO codes (code,room,active) VALUES ('MOON123','Moon Room',true) ON CONFLICT (code) DO NOTHING`);
  await pool.query(`INSERT INTO codes (code,room,active) VALUES ('VIP99','VIP Room',true) ON CONFLICT (code) DO NOTHING`);
  await pool.query(`INSERT INTO codes (code,room,active,admin_only) VALUES ('ADMIN','Admin Chat',true,true) ON CONFLICT (code) DO NOTHING`);
  console.log('DB ready');
}
initDB().catch(e=>console.error('DB init failed',e));
async function getUser(req){
  const uname = req.cookies.shadowblog_session;
  if(!uname) return null;
  const r = await pool.query('SELECT username,role FROM users WHERE username=$1',[uname]);
  return r.rows[0] || null;
}
function requireOwner(req,res,next){
  getUser(req).then(u=>{
    if(!u || u.role!=='OWNER') return res.status(403).json({error:'Owner only'});
    req.user=u; next();
  }).catch(()=>res.status(500).json({error:'db error'}));
}
app.post('/api/auth/register', async (req,res)=>{
  const {username,password}=req.body||{};
  if(!username||!password) return res.status(400).json({error:'Enter username and password'});
  try{
    const h=bcrypt.hashSync(password,10);
    await pool.query('INSERT INTO users (username,password,role) VALUES ($1,$2,$3)',[username,h,'Member']);
    res.cookie('shadowblog_session',username,{maxAge:30*24*60*60*1000,path:'/',sameSite:'lax'});
    res.json({ok:true,username,role:'Member'});
  }catch(e){
    if(e.code==='23505') return res.status(400).json({error:'Username already taken'});
    res.status(500).json({error:'DB error'});
  }
});
app.post('/api/auth/login', async (req,res)=>{
  const {username,password}=req.body||{};
  const r=await pool.query('SELECT * FROM users WHERE username=$1',[username]);
  if(!r.rows.length) return res.status(400).json({error:'User not found - switch to Register'});
  const u=r.rows[0];
  if(!bcrypt.compareSync(password,u.password)) return res.status(400).json({error:'Wrong password'});
  res.cookie('shadowblog_session',username,{maxAge:30*24*60*60*1000,path:'/',sameSite:'lax'});
  res.json({ok:true,username:u.username,role:u.role});
});
app.get('/api/me', async (req,res)=>{ const u=await getUser(req); res.json({user:u||null}); });
app.post('/api/auth/logout', (req,res)=>{ res.clearCookie('shadowblog_session',{path:'/'}); res.json({ok:true}); });
app.get('/api/codes', async (req,res)=>{
  const u=await getUser(req);
  if(!u||u.role!=='OWNER') return res.status(403).json({error:'Owner only'});
  const r=await pool.query('SELECT * FROM codes ORDER BY id'); res.json(r.rows);
});
app.post('/api/codes', requireOwner, async (req,res)=>{
  const {room}=req.body||{};
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code='';
  for(let i=0;i<6;i++) code+=chars[Math.floor(Math.random()*chars.length)];
  const r=await pool.query('INSERT INTO codes (code,room,active) VALUES ($1,$2,true) RETURNING *',[code,room||'New Room']);
  res.json(r.rows[0]);
});
app.post('/api/codes/:code/validate', requireOwner, async (req,res)=>{ await pool.query('UPDATE codes SET active=true WHERE code=$1',[req.params.code.toUpperCase()]); res.json({ok:true}); });
app.post('/api/codes/:code/invalidate', requireOwner, async (req,res)=>{ await pool.query('UPDATE codes SET active=false WHERE code=$1',[req.params.code.toUpperCase()]); res.json({ok:true}); });
app.delete('/api/codes/:code', requireOwner, async (req,res)=>{ await pool.query('DELETE FROM codes WHERE code=$1',[req.params.code.toUpperCase()]); res.json({ok:true}); });
app.get('/api/codes/:code/check', async (req,res)=>{
  const code=req.params.code.toUpperCase();
  const r=await pool.query('SELECT * FROM codes WHERE code=$1',[code]);
  if(!r.rows.length) return res.json({ok:false,error:'Code not found'});
  const c=r.rows[0];
  if(!c.active) return res.json({ok:false,error:'This code is invalid / expired. Ask admin to Validate it.'});
  if(c.admin_only){ const u=await getUser(req); if(!u||u.role!=='OWNER') return res.json({ok:false,error:'Access Denied - Owner Only'}); }
  res.json({ok:true,code:c});
});
app.get('/api/rooms/:code/messages', async (req,res)=>{
  const code=req.params.code.toUpperCase();
  const r=await pool.query('SELECT username,role,text,created_at FROM messages WHERE room=$1 ORDER BY id ASC LIMIT 500',[code]);
  res.json(r.rows);
});
app.post('/api/rooms/:code/messages', async (req,res)=>{
  const code=req.params.code.toUpperCase();
  const u=await getUser(req);
  if(!u) return res.status(401).json({error:'Login first'});
  const {text}=req.body||{};
  if(!text||!text.trim()) return res.status(400).json({error:'Empty message'});
  const cr=await pool.query('SELECT * FROM codes WHERE code=$1',[code]);
  if(!cr.rows.length||!cr.rows[0].active) return res.status(403).json({error:'Code invalid'});
  if(cr.rows[0].admin_only && u.role!=='OWNER') return res.status(403).json({error:'Owner only'});
  const r=await pool.query('INSERT INTO messages (room,username,role,text) VALUES ($1,$2,$3,$4) RETURNING *',[code,u.username,u.role,text.trim()]);
  res.json(r.rows[0]);
});
app.get('/api/posts/:id/comments', async (req,res)=>{
  const r=await pool.query('SELECT username,text,created_at FROM comments WHERE post_id=$1 ORDER BY id ASC',[req.params.id]);
  res.json(r.rows);
});
app.post('/api/posts/:id/comments', async (req,res)=>{
  const u=await getUser(req); const {text}=req.body||{};
  if(!text) return res.status(400).json({error:'Empty'});
  await pool.query('INSERT INTO comments (post_id,username,text) VALUES ($1,$2,$3)',[req.params.id,u?u.username:'Guest',text]);
  res.json({ok:true});
});
app.get('/api/users', async (req,res)=>{
  const u=await getUser(req);
  if(!u||u.role!=='OWNER') return res.status(403).json({error:'Owner only'});
  const r=await pool.query('SELECT username,role,created_at FROM users ORDER BY id'); res.json(r.rows);
});
app.get('/health', (req,res)=>res.send('ok'));
app.get('*', (req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT, ()=>console.log('ShadowBlog on '+PORT));
