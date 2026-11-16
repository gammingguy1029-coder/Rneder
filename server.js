// MINI CHROME - OWN PROXY SERVER
// This server fetches any website for you, so it can open inside your website.
// Run: npm install && node server.js

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');

const app = express();
app.use(cors());
const PORT = process.env.PORT || 8080;

// Health check - open https://your-url.onrender.com/ to see if alive
app.get('/', (req, res) => {
  res.send('Mini Chrome Proxy is LIVE! Use it like: /proxy?url=https://example.com');
});

// Main proxy: /proxy?url=https://example.com
app.use('/proxy', createProxyMiddleware({
  target: 'https://example.com', // will be replaced dynamically
  changeOrigin: true,
  followRedirects: true,
  router: (req) => {
    const url = req.query.url;
    if (!url) return 'https://example.com';
    try {
      const u = new URL(url);
      return u.origin; // e.g. https://www.youtube.com
    } catch { return 'https://example.com'; }
  },
  pathRewrite: (path, req) => {
    const url = req.query.url;
    try {
      const u = new URL(url);
      // Keep path from original URL: /watch?v=xxx
      return u.pathname + u.search;
    } catch { return path; }
  },
  onProxyRes: (proxyRes) => {
    // Remove headers that block iframe embedding
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['content-security-policy'];
    delete proxyRes.headers['x-content-type-options'];
  },
  onError: (err, req, res) => {
    res.status(500).send('Proxy Error: ' + err.message);
  }
}));

app.listen(PORT, () => console.log('Proxy running on port ' + PORT));
