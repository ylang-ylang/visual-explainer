import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, lstat, readdir, open } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema,
  ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { parse } from 'node-html-parser';

const publicUrl = new URL(process.env.PUBLIC_URL);
const outputDir = resolve(process.env.VISUAL_EXPLAINER_OUTPUT_DIR ?? '/data');
const token = (await readFile(process.env.TOKEN_FILE ?? '/run/secrets/api_token', 'utf8')).trim();
if (token.length < 32) throw new Error('API token must contain at least 32 characters');
const upstreamDir = process.env.UPSTREAM_DIR ?? '/opt/upstream';
const bridgeVersion = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')).version;
const instructions = 'Remote Visual Explainer; no LLM is called. Read visual-explainer://skill/SKILL.md and relevant resources/prompts, inspect your LOCAL project yourself, then send html and filename to visual_explainer_render_html. Do not send local paths or request a server-side browser window. Render results include a persistent browser URL. Anyone with a page URL can read that page; keep it private. Executable ve-flow models are disabled; use declarative data instead. Repository citation checks and video export require local project access and are not remote MCP tools.';
const galleryHtml = await readFile(new URL('./index.html', import.meta.url));
const cjkFont = await readFile(new URL('./static/cjk.woff2', import.meta.url));
const cjkLicense = await readFile(new URL('./static/LICENSE.fonts-wqy-zenhei', import.meta.url));
const viewerKey = createHmac('sha256', token).update('viewer-access').digest('hex');
const sessionLifetime = 7 * 24 * 60 * 60;

function sessionSignature(expires) {
  return createHmac('sha256', token).update(`viewer-session:${expires}`).digest('hex');
}
function viewerSession(req) {
  const value = (req.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith('ve_viewer='))?.slice(10);
  if (!value) return false;
  const [expires, sig] = value.split('.');
  const remaining = Number(expires) - Math.floor(Date.now() / 1000);
  return remaining > 0 && remaining <= sessionLifetime && equal(sig ?? '', sessionSignature(expires));
}
function setViewerSession(res) {
  const expires = Math.floor(Date.now() / 1000) + sessionLifetime;
  res.setHeader('Set-Cookie', `ve_viewer=${expires}.${sessionSignature(expires)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetime}${publicUrl.protocol === 'https:' ? '; Secure' : ''}`);
}
async function listPages() {
  const pages = [];
  for (const entry of await readdir(outputDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.html?$/i.test(entry.name) || /\.src\.html?$/i.test(entry.name)) continue;
    const path = join(outputDir, entry.name);
    let handle;
    try {
      handle = await open(path, 'r');
      const info = await handle.stat();
      const buffer = Buffer.alloc(Math.min(16384, info.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const title = parse(buffer.subarray(0, bytesRead).toString('utf8')).querySelector('title')?.textContent.trim() || entry.name;
      pages.push({ filename: entry.name, title, modified: info.mtime.toISOString(), bytes: info.size, url: pageUrl(entry.name) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally { await handle?.close(); }
  }
  return pages.sort((a, b) => b.modified.localeCompare(a.modified));
}

function equal(a, b) {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function signature(filename) {
  return createHmac('sha256', token).update(`page:${filename}`).digest('hex');
}
function pageUrl(filename) {
  return new URL(`/pages/${signature(filename)}/${encodeURIComponent(filename)}`, publicUrl).href;
}
function send(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(text);
}

// Run this checkout's original stdio server; one process multiplexes independent MCP calls.
const upstream = new Client({ name: 'truenas-visual-explainer-bridge', version: bridgeVersion });
let stopping = false;
upstream.onclose = () => { if (!stopping) process.exit(1); };
await upstream.connect(new StdioClientTransport({
  command: process.execPath,
  args: [join(upstreamDir, 'plugins/visual-explainer/mcp/server.mjs')],
  cwd: upstreamDir,
  env: {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/tmp',
    PLAYWRIGHT_BROWSERS_PATH: '/opt/browsers',
    VISUAL_EXPLAINER_OUTPUT_DIR: outputDir,
    VISUAL_EXPLAINER_RUN_MODELS: '0',
  },
  stderr: 'inherit',
}));

function proxyServer() {
  const server = new Server({ name: 'truenas-visual-explainer', version: bridgeVersion }, {
    capabilities: { tools: {}, resources: {}, prompts: {} }, instructions,
  });
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const result = await upstream.listTools(request.params);
    return { ...result, tools: result.tools.map((tool) => {
      if (tool.name !== 'visual_explainer_render_html') return tool;
      return {
        ...tool,
        description: 'Render complete HTML or visual-explainer page source on TrueNAS and return a persistent browser URL. Send html, not a local filesystem path. No LLM; executable models disabled.',
        inputSchema: {
          type: 'object', additionalProperties: false,
          properties: { filename: tool.inputSchema.properties.filename, html: tool.inputSchema.properties.html },
          required: ['filename', 'html'],
        },
        outputSchema: {
          ...tool.outputSchema,
          properties: { ...tool.outputSchema.properties, url: { type: 'string', format: 'uri' } },
        },
      };
    }) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    let params = request.params;
    if (params.name === 'visual_explainer_render_html') {
      const args = params.arguments ?? {};
      if (Object.keys(args).some((key) => !['filename', 'html'].includes(key)) ||
          typeof args.filename !== 'string' || typeof args.html !== 'string') {
        return { isError: true, content: [{ type: 'text', text: 'Send only filename and html strings; local paths, root and browser opening are not supported remotely.' }] };
      }
      params = { ...params, arguments: { ...args, open: false } };
    }
    const result = await upstream.callTool(params, undefined, { timeout: 180000 });
    if (params.name === 'visual_explainer_prepare' && !result.isError) {
      result.content.push({ type: 'text', text: instructions });
    }
    if (params.name === 'visual_explainer_render_html' && !result.isError) {
      const path = result.structuredContent?.path;
      if (typeof path !== 'string' || resolve(path) !== join(outputDir, basename(path))) {
        throw new Error('Upstream returned a path outside the output directory');
      }
      const url = pageUrl(basename(path));
      result.structuredContent = { ...result.structuredContent, url };
      result.content.push({ type: 'text', text: `View: ${url}\nThis link grants read access to this page. Reusing the filename replaces it; use unique filenames for immutable reports.` });
    }
    return result;
  });
  server.setRequestHandler(ListResourcesRequestSchema, (request) => upstream.listResources(request.params));
  server.setRequestHandler(ReadResourceRequestSchema, (request) => upstream.readResource(request.params));
  server.setRequestHandler(ListPromptsRequestSchema, (request) => upstream.listPrompts(request.params));
  server.setRequestHandler(GetPromptRequestSchema, (request) => upstream.getPrompt(request.params));
  return server;
}

const http = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, publicUrl);
    if (url.pathname === '/health' && req.method === 'GET') return send(res, 200, 'ok');
    if (req.headers.host !== publicUrl.host) return send(res, 403, 'Unexpected Host');
    if (url.pathname.startsWith('/pages/') && ['GET', 'HEAD'].includes(req.method)) {
      const parts = url.pathname.split('/');
      if (parts.length !== 4) return send(res, 404, 'Not found');
      const filename = decodeURIComponent(parts[3]);
      if (basename(filename) !== filename || filename.includes('\\') || filename.includes('..') ||
          /[\x00-\x1f\x7f]/.test(filename) || !/\.html?$/i.test(filename) ||
          !equal(parts[2], signature(filename))) return send(res, 404, 'Not found');
      const path = join(outputDir, filename);
      const status = await lstat(path).catch(() => null);
      if (!status?.isFile() || status.isSymbolicLink()) return send(res, 404, 'Not found');
      // Capability URLs need no cookie. Sandbox prevents generated HTML from accessing
      // the service origin or other reports; allow scripts for upstream interactive diagrams.
      res.setHeader('Content-Security-Policy', 'sandbox allow-scripts; frame-ancestors \'self\'');
      res.setHeader('Referrer-Policy', 'no-referrer');
      return send(res, 200, req.method === 'HEAD' ? '' : await readFile(path), 'text/html; charset=utf-8');
    }
    if (['/assets/cjk.woff2', '/assets/cjk-license'].includes(url.pathname) && ['GET', 'HEAD'].includes(req.method)) {
      const font = url.pathname.endsWith('.woff2');
      res.writeHead(200, {
        'Content-Type': font ? 'font/woff2' : 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(req.method === 'HEAD' ? '' : font ? cjkFont : cjkLicense);
    }
    if (url.pathname === '/' && req.method === 'GET') {
      if (url.searchParams.has('access')) {
        if (!equal(url.searchParams.get('access'), viewerKey)) return send(res, 403, 'Invalid viewer access link');
        setViewerSession(res);
        res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        return res.end();
      }
      res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      res.setHeader('Referrer-Policy', 'no-referrer');
      return send(res, 200, galleryHtml, 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (req.headers.origin !== publicUrl.origin) return send(res, 403, 'Unexpected Origin');
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 1024) return send(res, 413, 'Request too large');
      }
      const key = new URLSearchParams(body).get('key') ?? '';
      if (!equal(key, viewerKey) && !equal(key, token)) return send(res, 401, '访问密钥不正确');
      setViewerSession(res);
      return send(res, 200, 'ok');
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      if (req.headers.origin !== publicUrl.origin) return send(res, 403, 'Unexpected Origin');
      res.setHeader('Set-Cookie', 've_viewer=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      return send(res, 200, 'ok');
    }
    if (url.pathname === '/api/pages' && req.method === 'GET') {
      if (!viewerSession(req)) return send(res, 401, '请先登录');
      return send(res, 200, JSON.stringify({ pages: await listPages() }), 'application/json; charset=utf-8');
    }
    if (url.pathname !== '/mcp') return send(res, 404, 'Not found');
    if (!equal(req.headers.authorization ?? '', `Bearer ${token}`)) return send(res, 401, 'Bearer token required');
    if (req.headers.origin && req.headers.origin !== publicUrl.origin) return send(res, 403, 'Unexpected Origin');
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, 'Use stateless MCP POST'); }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 12 * 1024 * 1024) return send(res, 413, 'Request exceeds 12 MiB');
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return send(res, 400, 'Invalid JSON'); }
    const server = proxyServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close().catch(console.error); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, 500, 'Internal server error');
    else res.end();
  }
});
http.requestTimeout = 180000;
http.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => console.log(`Visual Explainer ready: ${publicUrl.origin}/mcp`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  stopping = true;
  http.close();
  await upstream.close();
  process.exit(0);
});
