// 窗 —— 一个跑在自己服务器上的浏览器，交给自己，也交给 Claude。
//
// 一个 Node 进程同时提供操作页面和两套接口：
//   /api/*        给网页和脚本用，登录 Cookie 或 Bearer Token
//   /mcp/<token>  给 Claude 这类 MCP 客户端用，密钥在网址里
// 零依赖：Node 自带 http、crypto、WebSocket 和 fetch，CDP 本身就是 WebSocket + JSON。
import { createServer } from 'node:http'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBrowser } from './browser.mjs'
import { createMcp } from './mcp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATE_DIR = resolve(process.env.WINDOW_STATE_DIR || HERE)
const CONFIG_FILE = join(STATE_DIR, 'config.json')

await mkdir(STATE_DIR, { recursive: true })

// 首次启动自动生成配置和随机凭据
let CFG = {}
let firstRun = false
try { CFG = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) }
catch (e) {
  if (e.code !== 'ENOENT') throw new Error(`config.json 解析失败：${e.message}`)
  firstRun = true
}
CFG.auth = CFG.auth || {}
let generated = false
for (const [k, n] of [['password', 15], ['secret', 32], ['mcpToken', 32], ['apiToken', 32]]) {
  if (!CFG.auth[k]) { CFG.auth[k] = randomBytes(n).toString('base64url'); generated = true }
}
if (firstRun || generated) {
  await writeFile(CONFIG_FILE, JSON.stringify(CFG, null, 2) + '\n', { mode: 0o600 })
  try { await chmod(CONFIG_FILE, 0o600) } catch {}
  console.log(`\n已生成 ${CONFIG_FILE}`)
  if (!process.env.WINDOW_PASSWORD) console.log(`网页登录密码：${CFG.auth.password}`)
  console.log('请妥善保存；不要把 config.json 发给别人。\n')
}

const PORT = Number(process.env.PORT || CFG.port || 18800)
const HOST = process.env.HOST || CFG.host || '127.0.0.1'
const PASSWORD = String(process.env.WINDOW_PASSWORD || CFG.auth.password)
const SECRET = String(process.env.WINDOW_SECRET || CFG.auth.secret)
const API_TOKEN = String(process.env.WINDOW_API_TOKEN || CFG.auth.apiToken)
const MCP_TOKEN = String(process.env.WINDOW_MCP_TOKEN || CFG.auth.mcpToken)
const PUBLIC_URL = String(CFG.publicUrl || process.env.WINDOW_PUBLIC_URL || '').replace(/\/+$/, '')

const OPT = Object.assign({ allowPrivate: false, allowScript: false, idleMinutes: 5 }, CFG.browser || {})
const BROWSER = createBrowser({
  stateDir: STATE_DIR,
  allowPrivate: !!OPT.allowPrivate,
  idleMs: Math.max(1, Number(OPT.idleMinutes) || 5) * 60 * 1000,
  proxy: process.env.WINDOW_PROXY || OPT.proxy || '',
  log: msg => console.log(msg),
})
const MCP = createMcp({ browser: BROWSER, token: MCP_TOKEN })

// ——— 鉴权 ———
const SESSION_SECONDS = 30 * 24 * 60 * 60
const COOKIE = 'win_session'
const safeEqual = (a, b) => {
  const aa = Buffer.from(String(a)), bb = Buffer.from(String(b))
  return aa.length === bb.length && timingSafeEqual(aa, bb)
}
const sign = exp => createHmac('sha256', SECRET).update(`window:${exp}`).digest('base64url')
const makeSession = () => {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS
  return `${exp}.${sign(exp)}`
}
const cookies = req => Object.fromEntries(
  String(req.headers.cookie || '').split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf('=')
    return i < 0 ? [v, ''] : [v.slice(0, i), decodeURIComponent(v.slice(i + 1))]
  }))
function validSession(t) {
  const [exp, sig] = String(t || '').split('.')
  if (!/^\d+$/.test(exp || '') || Number(exp) < Date.now() / 1000) return false
  return safeEqual(sig || '', sign(exp))
}
function authed(req) {
  const a = String(req.headers.authorization || '')
  if (a.startsWith('Bearer ') && safeEqual(a.slice(7), API_TOKEN)) return true
  return validSession(cookies(req)[COOKIE])
}
const secureReq = req =>
  !!req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true                    // curl / 脚本靠 Bearer Token
  try {
    const fwd = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
    return new URL(origin).host === (fwd || req.headers.host)
  } catch { return false }
}
function headers(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
}
async function readBody(req, limit = 1024 * 1024) {
  if (Number(req.headers['content-length'] || 0) > limit) {
    throw Object.assign(new Error('request_too_large'), { statusCode: 413 })
  }
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw Object.assign(new Error('request_too_large'), { statusCode: 413 })
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}
async function readJson(req, limit) {
  const raw = await readBody(req, limit)
  try { return JSON.parse(raw || '{}') }
  catch { throw Object.assign(new Error('invalid_json'), { statusCode: 400 }) }
}
const bad = m => { throw Object.assign(new Error(m), { statusCode: 400 }) }
const J = (res, obj, code = 200) => {
  headers(res)
  res.setHeader('Cache-Control', 'no-store')
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

const attempts = new Map()
function loginAllowed(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
  const now = Date.now()
  let row = attempts.get(ip)
  if (!row || now - row.since > 10 * 60 * 1000) row = { since: now, fails: 0 }
  attempts.set(ip, row)
  return { ip, row, ok: row.fails < 8 }
}
const loginPage = (err = '') => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>窗</title><style>*{box-sizing:border-box}html,body{min-height:100%;margin:0}
body{display:grid;place-items:center;padding:24px;background:#12141a;color:#e6e6ea;
font-family:-apple-system,"PingFang SC",sans-serif}
.box{width:min(360px,100%);background:#1b1e26;border:1px solid #2c303c;border-radius:18px;padding:26px}
h1{font-size:20px;margin:0 0 8px}p{font-size:13px;line-height:1.7;color:#8b90a0}
.err{color:#ff8098}input,button{width:100%;font:inherit;border-radius:12px;padding:12px 14px}
input{border:1px solid #2c303c;background:#12141a;color:#e6e6ea;outline:none}
button{margin-top:12px;border:0;background:#5b8cff;color:#fff;font-weight:600}</style></head>
<body><form class="box" method="post" action="/login"><h1>窗</h1>
<p>输入登录密码。</p>${err ? '<p class="err">密码不对，或者尝试太频繁了。</p>' : ''}
<input name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">进去</button></form></body></html>`

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname
  headers(res)

  try {
    if (p === '/healthz') return J(res, { ok: true })

    // MCP 自带认证（密钥在网址里），所以排在网页登录检查之前
    if (p === '/mcp' || p.startsWith('/mcp/')) {
      if (await MCP.handle(req, res, p, readBody)) return
      res.writeHead(404); return res.end('404')
    }

    if (p === '/login' && req.method === 'GET') {
      if (authed(req)) { res.writeHead(302, { Location: '/' }); return res.end() }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(loginPage())
    }
    if (p === '/login' && req.method === 'POST') {
      const at = loginAllowed(req)
      const form = new URLSearchParams(await readBody(req, 16 * 1024))
      if (!at.ok || !safeEqual(form.get('password') || '', PASSWORD)) {
        at.row.fails += 1
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        return res.end(loginPage(true))
      }
      attempts.delete(at.ip)
      res.writeHead(303, {
        Location: '/',
        'Set-Cookie': `${COOKIE}=${encodeURIComponent(makeSession())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secureReq(req) ? '; Secure' : ''}`,
        'Cache-Control': 'no-store',
      })
      return res.end()
    }
    if (p === '/logout' && req.method === 'POST') {
      res.writeHead(303, {
        Location: '/login',
        'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      })
      return res.end()
    }

    if (!authed(req)) {
      if (p.startsWith('/api/')) return J(res, { error: 'unauthorized' }, 401)
      res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' })
      return res.end()
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method || 'GET') && !sameOrigin(req) &&
        !String(req.headers.authorization || '').startsWith('Bearer ')) {
      return J(res, { error: 'cross_origin_request_blocked' }, 403)
    }

    // ——— 浏览器 ———
    if (p === '/api/browser' && req.method === 'GET') {
      return J(res, { ...BROWSER.status(), allowScript: !!OPT.allowScript, session: BROWSER.hasSession() })
    }
    if (p === '/api/browser/read' && req.method === 'POST') {
      const { url: u } = await readJson(req)
      if (!u) bad('url_required')
      return J(res, await BROWSER.read(String(u)))
    }
    if (p === '/api/browser/shot' && req.method === 'POST') {
      const b = await readJson(req)
      if (!b.url) bad('url_required')
      const out = await BROWSER.shot(String(b.url), { fullPage: !!b.fullPage })
      headers(res)
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
      return res.end(out.png)
    }
    if (p === '/api/browser/script' && req.method === 'POST') {
      if (!OPT.allowScript) return J(res, { error: 'script_disabled' }, 403)
      const { url: u, expression } = await readJson(req)
      if (!u || !expression) bad('url_and_expression_required')
      return J(res, await BROWSER.script(String(u), String(expression)))
    }

    // ——— 常驻会话 ———
    if (p === '/api/session/open' && req.method === 'POST') {
      const b = await readJson(req)
      if (!b.url) bad('url_required')
      return J(res, await BROWSER.sessionOpen(String(b.url), { viewport: b.viewport }))
    }
    if (p === '/api/session/state' && req.method === 'GET') {
      return J(res, await BROWSER.sessionState())
    }
    if (p === '/api/session/act' && req.method === 'POST') {
      return J(res, await BROWSER.sessionAct(await readJson(req)))
    }
    if (p === '/api/session/shot' && req.method === 'GET') {
      const out = await BROWSER.sessionShot({
        format: url.searchParams.get('format') === 'png' ? 'png' : 'jpeg',
        quality: Number(url.searchParams.get('q')) || 60,
      })
      headers(res)
      res.writeHead(200, {
        'Content-Type': out.format === 'png' ? 'image/png' : 'image/jpeg',
        'Cache-Control': 'no-store',
        'X-View-Size': `${out.w}x${out.h}`,
      })
      return res.end(out.buf)
    }
    if (p === '/api/session/close' && req.method === 'POST') {
      return J(res, await BROWSER.sessionClose())
    }
    if (p === '/api/browser/close' && req.method === 'POST') {
      await BROWSER.close()
      return J(res, { ok: true })
    }

    if (!['GET', 'HEAD'].includes(req.method || 'GET')) return J(res, { error: 'method_not_allowed' }, 405)

    // 只提供这一个页面，别的什么都不暴露
    if (p === '/' || p === '/index.html') {
      const f = join(HERE, 'index.html')
      if (!existsSync(f)) { res.writeHead(404); return res.end('404') }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
      if (req.method === 'HEAD') return res.end()
      return res.end(await readFile(f))
    }
    res.writeHead(404); res.end('404')
  } catch (e) {
    const code = Number(e.statusCode) || 500
    J(res, { error: code === 500 ? 'internal_error' : String(e.message || e) }, code)
    if (code === 500) console.error(e)
  }
})

server.listen(PORT, HOST, () => {
  console.log(`窗 on http://${HOST}:${PORT}`)
  console.log(PUBLIC_URL
    ? `MCP 连接器地址：${PUBLIC_URL}/mcp/${MCP_TOKEN}`
    : `MCP 端点路径：/mcp/${MCP_TOKEN}（前面拼上你自己的 https 地址）`)
  console.log('这个网址本身就是凭据，不要发给别人、不要截图公开。')
})

// 退出时别在机器上留一个没人管的 Chrome
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { BROWSER.close().catch(() => {}).finally(() => process.exit(0)) })
}
