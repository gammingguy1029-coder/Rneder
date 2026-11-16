// MINI CHROME - SERVER V2 - ZERO TRACE ON PHONE
// RULE: NOTHING is stored on friend's phone.
// Cookies, Tokens, History, Session = ALL stored on THIS server (RAM + history.json)
// Phone only sees the page, it gets NO cookies, NO localStorage, NO history.
//
// Run:
//   npm install
//   node server.js
// Deploy on Render free - see TUTORIAL.txt

const express = require('express');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
const PORT = process.env.PORT || 8080;

// ===== SERVER STORAGE (NOT ON PHONE) =====
// sessions: Map sessionId -> { cookies: {domain: "a=b; c=d"}, history: [], createdAt }
const sessions = new Map();
const HISTORY_FILE = './history.json';

// Load history from file if exists (server keeps it, phone never sees file)
let serverHistory = [];
try { if (fs.existsSync(HISTORY_FILE)) serverHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch(e){ serverHistory=[]; }
function saveHistory(){
  try{ fs.writeFileSync(HISTORY_FILE, JSON.stringify(serverHistory.slice(-1000), null, 2)); }catch(e){}
}
function getSession(id){
  if(!id) return null;
  if(!sessions.has(id)) sessions.set(id, { cookies:{}, history:[], createdAt: Date.now() });
  return sessions.get(id);
}
function makeId(){ return Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2); }

// Always tell browser: DO NOT STORE ANYTHING
app.use((req,res,next)=>{
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma','no-cache');
  res.setHeader('Expires','0');
  // Do NOT send any Set-Cookie to phone from our server
  next();
});

app.get('/', (req,res)=>{
  // FIX: If someone opens server URL with ?url=... in browser, redirect to /browse
  if(req.query.url){
    return res.redirect('/browse?session=' + (req.query.session||'anon') + '&url=' + encodeURIComponent(req.query.url));
  }
  // If opened directly in browser, show friendly HTML, NOT ugly JSON
  res.send(`<html><head><title>Mini Chrome Server</title><style>body{font-family:Arial;background:#1c1b22;color:white;padding:30px;text-align:center} .box{background:#2b2a33;padding:20px;border-radius:16px;max-width:500px;margin:auto} b{color:#00ddff}</style></head><body><div class="box"><h2>Mini Chrome Server is LIVE ✅</h2><p>This is your <b>SERVER</b>, not a website to browse.</p><p>Do NOT type this URL in the Search bar.</p><p>Go back to your Mini Chrome website, paste this URL in <b>Connect My Server</b> box, then search <b>wikipedia.org</b></p><p>Endpoints: /session, /browse, /history, /wipe</p></div></body></html>`);
});

// 1. Create session - frontend keeps sessionId ONLY in RAM, never localStorage
app.post('/session', (req,res)=>{
  const id = makeId();
  sessions.set(id, { cookies:{}, history:[], createdAt: Date.now() });
  res.json({ sessionId: id });
});

// 2. Log history to SERVER only
app.post('/log', (req,res)=>{
  const { sessionId, url } = req.body || {};
  const entry = { sessionId: sessionId||'anon', url, time: new Date().toISOString() };
  serverHistory.push(entry);
  const s = getSession(sessionId); if(s) s.history.push(entry);
  saveHistory();
  res.json({ ok:true });
});

// 3. See history - ONLY YOU (server owner) should call this, not phone
app.get('/history', (req,res)=>{
  // In real project, add a secret: ?key=YOUR_SECRET
  // Example: /history?key=12345
  // For now open, but add secret in production
  res.json({ count: serverHistory.length, history: serverHistory.slice(-200) });
});

// 4. Wipe session - deletes ALL cookies + history for that session from server
app.post('/wipe', (req,res)=>{
  const { sessionId } = req.body || {};
  if(sessionId) sessions.delete(sessionId);
  // Also remove that session from serverHistory
  serverHistory = serverHistory.filter(h=>h.sessionId!==sessionId);
  saveHistory();
  res.json({ ok:true, wiped:true });
});

// 5. MAIN PROXY - Cookies stay on SERVER, never go to phone
app.get('/browse', async (req,res)=>{
  const targetUrl = req.query.url;
  const sessionId = req.query.session || 'anon';
  if(!targetUrl) return res.status(400).send('Missing ?url=');
  const session = getSession(sessionId);

  // Log to server
  const entry = { sessionId, url: targetUrl, time: new Date().toISOString() };
  serverHistory.push(entry); session.history.push(entry); saveHistory();

  try{
    const u = new URL(targetUrl);
    // Send stored cookies FROM SERVER to target site (phone never sees them)
    const cookieHeader = session.cookies[u.hostname] || '';
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 MiniChrome',
        'Accept': req.headers['accept'] || 'text/html',
        'Cookie': cookieHeader,
        'Referer': u.origin + '/'
      },
      redirect: 'follow'
    });

    // Save Set-Cookie FROM target site TO SERVER (not to phone)
    const setCookie = response.headers.get('set-cookie');
    if(setCookie){
      // Simple: store raw cookie string per domain
      session.cookies[u.hostname] = (session.cookies[u.hostname] ? session.cookies[u.hostname]+'; ' : '') + setCookie.split(';')[0];
    }
    // Also handle multiple set-cookie via getSetCookie if available
    if(typeof response.headers.getSetCookie === 'function'){
      const all = response.headers.getSetCookie();
      if(all.length) session.cookies[u.hostname] = all.map(c=>c.split(';')[0]).join('; ');
    }

    let body = await response.text();
    const contentType = response.headers.get('content-type') || 'text/html';

    // If HTML, rewrite links so next clicks ALSO go through server (so phone never touches real site directly)
    if(contentType.includes('text/html')){
      // Rewrite href="/xxx" and src="/xxx" to go via /browse
      // This is basic rewrite - enough for Wikipedia, news, blogs. YouTube needs more.
      body = body.replace(/(href|src|action)=["']\/(?!\/)/g, (m,p1)=>{
        return `${p1}="/browse?session=${sessionId}&url=${encodeURIComponent(u.origin + '/')}&_p=/`;
      });
      // Rewrite absolute links to same site: href="https://site/..."
      // We keep it simple: inject base tag to keep relative links working via proxy
      body = body.replace(/<head>/i, `<head><base href="/browse?session=${sessionId}&url=${encodeURIComponent(u.origin)}/">`);
    }

    // STRIP headers that would store stuff on phone or block iframe
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Frame-Options','ALLOWALL');
    // NO Set-Cookie to phone - this is the key!
    // NO CSP that blocks
    res.setHeader('Content-Security-Policy',"frame-ancestors *");
    res.send(body);
  }catch(err){
    res.status(500).send('<h2>Proxy Error</h2><p>'+err.message+'</p><p>Try another site like wikipedia.org</p>');
  }
});

app.listen(PORT, ()=> console.log('ZERO-TRACE Server running on '+PORT));
