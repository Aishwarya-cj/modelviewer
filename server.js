const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadManifest, assembleGlb } = require('./assembler');

let QRCode = null;
try {
  QRCode = require('qrcode');
} catch (e) {
  // qrcode optional fallback
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';
const ROOT = __dirname;

let publicTunnelUrl = null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.usdz': 'model/vnd.usdz+zip',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function handleBufferRangeResponse(req, res, buffer, contentType) {
  const totalSize = buffer.length;
  const rangeHeader = req.headers.range;

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      let start = match[1] ? parseInt(match[1], 10) : 0;
      let end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= totalSize) end = totalSize - 1;

      if (start > end || start >= totalSize) {
        res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
        res.end();
        return;
      }

      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      res.end(buffer.subarray(start, end + 1));
      return;
    }
  }

  res.writeHead(200, {
    'Content-Length': totalSize,
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600'
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  res.end(buffer);
}

const server = http.createServer(async (req, res) => {
  // Enable CORS for AR viewers (Android Scene Viewer, iOS Quick Look, WebXR)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  // API: Manifest
  if (pathname === '/api/manifest') {
    const m = loadManifest();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(m));
    return;
  }

  // API: Server & Tunnel Info
  if (pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      port: PORT,
      tunnelUrl: publicTunnelUrl
    }));
    return;
  }

  // API: Dynamic Model Assembly (/api/assemble?parts=TRAY-DE12.glb,...)
  if (pathname === '/api/assemble' || pathname === '/assembled.glb') {
    const partsParam = parsedUrl.searchParams.get('parts') || '';
    const parts = partsParam ? partsParam.split(',').filter(Boolean) : [];

    try {
      const glbBuffer = await assembleGlb(parts);
      handleBufferRangeResponse(req, res, glbBuffer, 'model/gltf-binary');
    } catch (err) {
      console.error('Assembly error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to assemble 3D model', details: err.message }));
    }
    return;
  }

  // API: QR Code Generator
  if (pathname === '/api/qrcode') {
    const text = parsedUrl.searchParams.get('text') || publicTunnelUrl || `http://localhost:${PORT}`;
    if (QRCode) {
      QRCode.toDataURL(text, { width: 320, margin: 2 }, (err, url) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ dataUrl: url, targetUrl: text }));
        }
      });
      return;
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'QRCode module not available' }));
      return;
    }
  }

  // Static File Serving
  let relativePath = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(path.join(ROOT, relativePath));
  if (!safePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Access Denied');
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const totalSize = stats.size;

    // Support HTTP Range requests
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      if (match) {
        let start = match[1] ? parseInt(match[1], 10) : 0;
        let end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

        if (isNaN(start) || start < 0) start = 0;
        if (isNaN(end) || end >= totalSize) end = totalSize - 1;

        if (start > end || start >= totalSize) {
          res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
          res.end();
          return;
        }

        const chunkSize = end - start + 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': contentType
        });

        if (req.method === 'HEAD') {
          res.end();
          return;
        }

        const stream = fs.createReadStream(safePath, { start, end });
        stream.pipe(res);
        return;
      }
    }

    // Full file response
    res.writeHead(200, {
      'Content-Length': totalSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    fs.createReadStream(safePath).pipe(res);
  });
});

function printBanner(localUrl, tunnelUrl) {
  const line = '═'.repeat(64);
  console.log(`\n${line}`);
  console.log('  🖨️  3D PRINTER MODULAR AR VIEWER');
  console.log(line);
  console.log(`  💻 Local Access (Laptop / PC):`);
  console.log(`     ${localUrl}`);
  if (tunnelUrl) {
    console.log(`\n  📱 Mobile AR Access (Public HTTPS Tunnel):`);
    console.log(`     ${tunnelUrl}`);
    console.log(`\n  ✨ Open the tunnel URL on mobile to view in Augmented Reality!`);
  } else {
    console.log(`\n  💡 Tip: Run 'npm run dev' or 'npm run tunnel' to enable`);
    console.log(`     public HTTPS access for mobile Augmented Reality.`);
  }
  console.log(`${line}\n`);
}

function startTunnel(localPort) {
  console.log('🔄 Starting Cloudflare Tunnel for public HTTPS access...');
  const cf = spawn('npx', ['--yes', 'cloudflared', 'tunnel', '--url', `http://localhost:${localPort}`], {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const checkOutput = (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match && !publicTunnelUrl) {
      publicTunnelUrl = match[0];
      printBanner(`http://localhost:${localPort}`, publicTunnelUrl);
    }
  };

  cf.stdout.on('data', checkOutput);
  cf.stderr.on('data', checkOutput);

  cf.on('close', (code) => {
    if (code !== 0 && !publicTunnelUrl) {
      console.warn(`Cloudflare tunnel exited with code ${code}`);
    }
  });

  process.on('SIGINT', () => {
    cf.kill();
    process.exit();
  });
  process.on('SIGTERM', () => {
    cf.kill();
    process.exit();
  });
}

let currentPort = PORT;

function startListening(port) {
  server.listen(port, HOST, () => {
    currentPort = port;
    const localUrl = `http://localhost:${port}`;
    const shouldTunnel = process.argv.includes('--tunnel') || process.env.TUNNEL === 'true';

    if (shouldTunnel) {
      startTunnel(port);
    } else {
      printBanner(localUrl, null);
    }
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`⚠️  Port ${currentPort} is already in use. Trying port ${currentPort + 1}...`);
    currentPort++;
    setTimeout(() => {
      startListening(currentPort);
    }, 200);
  } else {
    console.error('Server error:', err);
  }
});

startListening(PORT);
