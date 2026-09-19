// 窗 —— 用 Chrome 调试协议（CDP）在服务器上开一个真正的浏览器。
//
// 不依赖 puppeteer：Node 22 自带 WebSocket 与 fetch，而 CDP 本身就是 WebSocket + JSON，
// 所以整个项目仍然保持零 npm 依赖。
//
// 安全基调与本机玩法不同：这个浏览器跑在服务器上，一旦能被诱导去访问内网地址或云平台
// 元数据服务（169.254.169.254），等于把整台机器交出去。所以这里做两层拦截：
//   1. 导航前解析目标域名，任何落在私网/环回/链路本地的 IP 直接拒绝；
//   2. 用 Fetch 域拦截页面发出的每一个请求，重定向和子资源同样逐个校验。
// 残余风险：域名可以在两次解析之间改指向（DNS rebinding），第 2 层能挡住绝大多数实际
// 情况，但不能把那个窗口完全关死。
import { spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { existsSync } from 'node:fs'
import { readFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isIP } from 'node:net'

// 按顺序找一个能用的 Chrome/Chromium；都找不到就让功能优雅失效，而不是拖垮整个服务。
const CHROME_CANDIDATES = () => [
  process.env.PAIRNEST_CHROME,
  process.env.PLAYWRIGHT_BROWSERS_PATH && join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium'),
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean)

export function findChrome() {
  for (const p of CHROME_CANDIDATES()) if (existsSync(p)) return p
  return null
}

// ——— 地址校验：哪些 IP 绝对不许这个浏览器碰 ———
function ipv4Blocked(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  if (a === 0) return true                              // 本网络
  if (a === 10) return true                             // 私网
  if (a === 127) return true                            // 环回
  if (a === 169 && b === 254) return true               // 链路本地，含云平台元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true      // 私网
  if (a === 192 && b === 168) return true               // 私网
  if (a === 192 && b === 0) return true                 // IETF 协议保留
  if (a === 100 && b >= 64 && b <= 127) return true     // 运营商级 NAT
  if (a === 198 && (b === 18 || b === 19)) return true  // 基准测试
  if (a >= 224) return true                             // 组播、保留、广播
  return false
}

function ipv6Blocked(ip) {
  const s = String(ip).toLowerCase().split('%')[0]
  if (s === '::' || s === '::1') return true
  const mapped = s.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return ipv4Blocked(mapped[1])             // IPv4 映射地址按 v4 规则判
  const head = parseInt((s.split(':')[0] || '0'), 16) || 0
  if ((head & 0xfe00) === 0xfc00) return true           // fc00::/7 唯一本地
  if ((head & 0xffc0) === 0xfe80) return true           // fe80::/10 链路本地
  if ((head & 0xff00) === 0xff00) return true           // ff00::/8 组播
  return false
}

export function ipBlocked(ip) {
  const v = isIP(ip)
  if (v === 4) return ipv4Blocked(ip)
  if (v === 6) return ipv6Blocked(ip)
  return true                                           // 认不出来的一律当危险
}

// 域名解析结果短暂缓存：页面里几十个子请求不该触发几十次 DNS。
const hostCache = new Map()
const HOST_TTL = 30 * 1000

async function hostAllowed(hostname) {
  const key = hostname.toLowerCase()
  const hit = hostCache.get(key)
  if (hit && Date.now() - hit.at < HOST_TTL) return hit.ok

  let ok = false
  try {
    if (isIP(key)) ok = !ipBlocked(key)
    else {
      const rows = await lookup(key, { all: true })
      // 有一个解析结果落在私网就整体拒绝，避免多 A 记录里混一条内网地址。
      ok = rows.length > 0 && rows.every(r => !ipBlocked(r.address))
    }
  } catch { ok = false }

  hostCache.set(key, { ok, at: Date.now() })
  if (hostCache.size > 500) hostCache.clear()
  return ok
}

// 对外暴露的地址检查：协议与解析结果一起看。
// allowPrivate 只给「服务就跑在自己电脑上、想让它看本机页面」这种情形，默认必须关。
export async function checkUrl(raw, { allowPrivate = false } = {}) {
  let u
  try { u = new URL(String(raw)) } catch { return { ok: false, why: 'invalid_url' } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, why: 'protocol_not_allowed' }
  if (!u.hostname) return { ok: false, why: 'invalid_url' }
  if (allowPrivate) return { ok: true, url: u.toString() }
  // 去掉 IPv6 字面量的方括号再解析
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!(await hostAllowed(host))) return { ok: false, why: 'address_not_allowed' }
  return { ok: true, url: u.toString() }
}

// ——— CDP 连接：一条 WebSocket 跑完所有会话 ———
class Conn {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.waiting = new Map()
    this.listeners = new Set()
    this.closed = false
    ws.addEventListener('message', e => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id)
        this.waiting.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message || 'cdp_error')) : resolve(msg.result || {})
        return
      }
      if (msg.method) for (const fn of this.listeners) { try { fn(msg) } catch {} }
    })
    const die = () => {
      this.closed = true
      for (const { reject } of this.waiting.values()) reject(new Error('cdp_closed'))
      this.waiting.clear()
    }
    ws.addEventListener('close', die)
    ws.addEventListener('error', die)
  }

  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('cdp_connect_timeout')), 10000)
      ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('cdp_connect_failed')) }, { once: true })
    })
    return new Conn(ws)
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('cdp_closed'))
    const id = ++this.id
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (this.waiting.delete(id)) reject(new Error(`cdp_timeout:${method}`))
      }, 30000)
      const done = fn => v => { clearTimeout(t); fn(v) }
      this.waiting.set(id, { resolve: done(resolve), reject: done(reject) })
      try { this.ws.send(JSON.stringify(payload)) }
      catch (e) { clearTimeout(t); this.waiting.delete(id); reject(e) }
    })
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  close() { this.closed = true; try { this.ws.close() } catch {} }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ——— 浏览器实例：懒启动、空闲自动关、同一时间只开一个标签页 ———
export function createBrowser(opts = {}) {
  const stateDir = opts.stateDir || process.cwd()
  const profileDir = join(stateDir, 'data', 'browser-profile')
  const idleMs = Number(opts.idleMs || 5 * 60 * 1000)
  const navTimeout = Number(opts.navTimeout || 15000)
  const allowPrivate = !!opts.allowPrivate
  const log = opts.log || (() => {})

  let proc = null
  let conn = null
  let starting = null
  let startedAt = 0
  let idleTimer = null
  let busy = Promise.resolve()
  let lastError = ''
  let visits = 0
  let realUA = ''
  // 常驻会话：一个标签页一直开着，翻页、点开、填写都落在同一个页面上。
  // 无状态的 read/shot/script 仍然各开各的临时标签页，互不干扰。
  let session = null

  // 无头模式的 UA 会自报 HeadlessChrome，不少网站看到就给降级页面甚至直接拦掉。
  // 这里只把它换回同一个版本的普通 Chrome 标识 —— 版本跟着实际浏览器走，
  // 不冒充别的浏览器，只是不再主动声明自己是无头的。
  async function captureUA() {
    try {
      const v = await conn.send('Browser.getVersion')
      realUA = String(v.userAgent || '').replace('HeadlessChrome', 'Chrome')
    } catch { realUA = '' }
  }

  const touchIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { close().catch(() => {}) }, idleMs)
    if (idleTimer.unref) idleTimer.unref()
  }

  async function readDevToolsPort() {
    // Chrome 用 --remote-debugging-port=0 时会把真实端口写进这个文件，省得我们抢占固定端口。
    const f = join(profileDir, 'DevToolsActivePort')
    for (let i = 0; i < 60; i++) {
      try {
        const txt = await readFile(f, 'utf8')
        const [port, path] = txt.split('\n')
        if (port && path) return { port: Number(port), path: path.trim() }
      } catch {}
      if (proc && proc.exitCode !== null) throw new Error('chrome_exited')
      await sleep(250)
    }
    throw new Error('chrome_no_debug_port')
  }

  // 服务被强杀（平台重启、OOM）时 Chrome 会活下来变成孤儿。与其和它抢同一个
  // 用户资料目录，不如直接接管：连得上就继续用，连不上才说明是上次留下的死文件。
  async function adopt() {
    try {
      const txt = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')
      const [port, path] = txt.split('\n')
      if (!port || !path) return null
      const res = await fetch(`http://127.0.0.1:${Number(port)}/json/version`,
        { signal: AbortSignal.timeout(1500) })
      if (!res.ok) return null
      const info = await res.json()
      return info.webSocketDebuggerUrl || null
    } catch { return null }
  }

  async function start() {
    const chrome = findChrome()
    if (!chrome) throw new Error('chrome_not_found')
    await mkdir(profileDir, { recursive: true })

    const alive = await adopt()
    if (alive) {
      conn = await Conn.open(alive)
      session = null
      await captureUA()
      startedAt = Date.now()
      log('接管了上次留下的 Chrome')
      touchIdle()
      return
    }

    // 到这里说明旧进程已经不在了，把它留下的端口文件和资料目录锁一起清掉，
    // 否则新的 Chrome 会以为资料目录还被占着而起不来。
    for (const f of ['DevToolsActivePort', 'SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      await rm(join(profileDir, f), { force: true }).catch(() => {})
    }

    const args = [
      '--headless=new',
      // 调试端口只听本机，且交给系统分配；绝不对外暴露。
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',        // 容器里 /dev/shm 往往很小
      '--disable-background-networking',
      '--disable-sync',
      '--disable-extensions',
      // 无头 Chrome 默认会把 navigator.webdriver 标成 true，很多站点据此给降级内容
      '--disable-blink-features=AutomationControlled',
      '--mute-audio',
      '--window-size=1280,800',
      '--metrics-recording-only',
    ]
    // 容器里以 root 跑时 Chrome 的沙箱起不来；非 root 环境保留沙箱。
    if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox')
    if (opts.proxy) args.push(`--proxy-server=${opts.proxy}`)

    session = null   // 换了新的浏览器进程，旧会话作废
    proc = spawn(chrome, args, { stdio: 'ignore', detached: false })
    proc.on('exit', () => { proc = null; if (conn) { conn.close(); conn = null } })

    const { port, path } = await readDevToolsPort()
    conn = await Conn.open(`ws://127.0.0.1:${port}${path}`)
    await captureUA()
    startedAt = Date.now()
    log(`浏览器已启动：${chrome}`)
    touchIdle()
  }

  async function ensure() {
    if (conn && !conn.closed) { touchIdle(); return }
    if (!starting) {
      starting = start().catch(e => { lastError = e.message; throw e })
        .finally(() => { starting = null })
    }
    return starting
  }

  async function close() {
    clearTimeout(idleTimer)
    session = null
    if (conn) { try { await conn.send('Browser.close') } catch {} conn.close(); conn = null }
    if (proc) { try { proc.kill('SIGTERM') } catch {} proc = null }
    startedAt = 0
  }

  // 所有页面操作排队串行，避免并发把小机器的内存打爆。
  function queue(fn) {
    const run = busy.then(fn, fn)
    // 排队是串行的，所以一个卡住的操作会把后面所有请求一起拖死。
    // 给接力棒单独设一个上限：到点就放行下一个，当前这次仍按自己的结果返回。
    busy = Promise.race([
      run.then(() => {}, () => {}),
      sleep(Math.max(navTimeout * 3, 45000)),
    ])
    return run
  }

  // 开一个标签页做事，用完一定关掉。
  async function withPage(fn) {
    await ensure()
    const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank' })
    let sessionId
    try {
      const att = await conn.send('Target.attachToTarget', { targetId, flatten: true })
      sessionId = att.sessionId
      return await fn(sessionId)
    } finally {
      try { await conn.send('Target.closeTarget', { targetId }) } catch {}
      touchIdle()
    }
  }

  // 拦下请求逐个校验，挡住重定向绕过和内网地址。
  //
  // 只拦会把内容送回调用者手里的那几类：Document 是导航本身，XHR / Fetch 是脚本
  // 能读到响应的路径 —— 数据要外泄只能走这三条。图片、样式、字体、媒体不拦：
  // 它们即使指向内网也读不回内容，而一个重型页面动辄几百个这样的请求，全部排队
  // 过检会把整条队列堵死（实测抖音因此 45 秒都打不开）。
  async function guard(sessionId, priv) {
    await conn.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
        { urlPattern: '*', resourceType: 'XHR', requestStage: 'Request' },
        { urlPattern: '*', resourceType: 'Fetch', requestStage: 'Request' },
      ],
    }, sessionId)
    const blocked = []
    const off = conn.on(async msg => {
      if (msg.method !== 'Fetch.requestPaused' || msg.sessionId !== sessionId) return
      const { requestId, request } = msg.params
      const verdict = await checkUrl(request.url, { allowPrivate: priv })
      try {
        if (verdict.ok) await conn.send('Fetch.continueRequest', { requestId }, sessionId)
        else {
          if (blocked.length < 20) blocked.push({ url: request.url.slice(0, 200), why: verdict.why })
          await conn.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId)
        }
      } catch {}
    })
    return { off, blocked }
  }

  // 导航并等到加载完成（或超时就用当下的内容，总比什么都没有强）。
  async function goto(sessionId, url) {
    await conn.send('Page.enable', {}, sessionId)
    await conn.send('Runtime.enable', {}, sessionId)
    await conn.send('Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId)
    if (realUA) {
      await conn.send('Emulation.setUserAgentOverride',
        { userAgent: realUA, acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8' }, sessionId).catch(() => {})
    }

    const loaded = new Promise(resolve => {
      const off = conn.on(msg => {
        if (msg.sessionId === sessionId &&
            (msg.method === 'Page.loadEventFired' || msg.method === 'Page.frameStoppedLoading')) {
          off(); resolve(true)
        }
      })
      setTimeout(() => { off(); resolve(false) }, navTimeout)
    })
    await conn.send('Page.navigate', { url }, sessionId)
    const finished = await loaded
    await sleep(600)   // 给首屏脚本一点渲染时间
    return finished
  }

  const evalIn = async (sessionId, expression) => {
    const r = await conn.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (r.exceptionDetails) throw new Error('page_script_failed')
    return r.result?.value
  }

  // 读一个网页：标题、正文、链接。
  async function read(rawUrl, { maxChars = 20000, maxLinks = 100, allowPrivate: ap } = {}) {
    const priv = ap === undefined ? allowPrivate : !!ap
    const verdict = await checkUrl(rawUrl, { allowPrivate: priv })
    if (!verdict.ok) throw Object.assign(new Error(verdict.why), { statusCode: 400 })

    return queue(() => withPage(async sessionId => {
      const g = await guard(sessionId, priv)
      const t0 = Date.now()
      try {
        const finished = await goto(sessionId, verdict.url)
        const page = await evalIn(sessionId, `(() => {
          const pick = document.querySelector('main,article') || document.body
          const text = (pick ? pick.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim()
          const links = [...document.querySelectorAll('a[href]')]
            .map(a => ({ text: (a.innerText || '').trim().slice(0, 80), href: a.href }))
            .filter(l => l.text && /^https?:/.test(l.href))
          return { title: document.title, url: location.href, text, links }
        })()`)
        visits += 1
        return {
          url: page?.url || verdict.url,
          title: String(page?.title || '').slice(0, 300),
          text: String(page?.text || '').slice(0, maxChars),
          truncated: String(page?.text || '').length > maxChars,
          links: (page?.links || []).slice(0, maxLinks),
          blocked: g.blocked,
          finished,
          ms: Date.now() - t0,
        }
      } finally {
        g.off()
        try { await conn.send('Fetch.disable', {}, sessionId) } catch {}
      }
    }))
  }

  // 给一个网页拍张照。
  async function shot(rawUrl, { fullPage = false, allowPrivate: ap } = {}) {
    const priv = ap === undefined ? allowPrivate : !!ap
    const verdict = await checkUrl(rawUrl, { allowPrivate: priv })
    if (!verdict.ok) throw Object.assign(new Error(verdict.why), { statusCode: 400 })

    return queue(() => withPage(async sessionId => {
      const g = await guard(sessionId, priv)
      try {
        await goto(sessionId, verdict.url)
        const title = await evalIn(sessionId, 'document.title')
        const params = { format: 'png' }
        if (fullPage) params.captureBeyondViewport = true
        const r = await conn.send('Page.captureScreenshot', params, sessionId)
        visits += 1
        return { title: String(title || '').slice(0, 300), png: Buffer.from(r.data, 'base64') }
      } finally {
        g.off()
        try { await conn.send('Fetch.disable', {}, sessionId) } catch {}
      }
    }))
  }

  // 在页面里跑一段 JS。能力很深，所以由调用方用独立开关控制是否放行。
  async function script(rawUrl, expression, { allowPrivate: ap } = {}) {
    const priv = ap === undefined ? allowPrivate : !!ap
    const verdict = await checkUrl(rawUrl, { allowPrivate: priv })
    if (!verdict.ok) throw Object.assign(new Error(verdict.why), { statusCode: 400 })

    return queue(() => withPage(async sessionId => {
      const g = await guard(sessionId, priv)
      try {
        await goto(sessionId, verdict.url)
        const value = await evalIn(sessionId, `(async () => { return (${expression}) })()`)
        visits += 1
        let out
        try { out = JSON.parse(JSON.stringify(value ?? null)) } catch { out = String(value) }
        return { url: verdict.url, value: out }
      } finally {
        g.off()
        try { await conn.send('Fetch.disable', {}, sessionId) } catch {}
      }
    }))
  }

  // ——— 常驻会话：一个能停在那里、可以继续往下看的页面 ———

  // 页面此刻显示着什么、有哪些能碰的东西。每个元素给一个编号，后续按编号指认。
  const PROBE = `(() => {
    const seen = new Set()
    const out = []
    const sel = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [onclick], [contenteditable="true"]'
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect()
      // 只收此刻真的显示在屏幕范围内的
      if (r.width < 2 || r.height < 2) continue
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue
      const st = getComputedStyle(el)
      if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue
      const tag = el.tagName.toLowerCase()
      const label = (
        el.getAttribute('aria-label') || el.placeholder || el.value ||
        (el.innerText || el.textContent || '').trim() || el.title || el.alt || ''
      ).replace(/\\s+/g, ' ').trim().slice(0, 70)
      const key = tag + '|' + label + '|' + Math.round(r.top) + '|' + Math.round(r.left)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        i: out.length, tag, type: el.type || '', label,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
      })
      if (out.length >= 100) break
    }
    const pick = document.querySelector('main, article') || document.body
    return {
      title: document.title,
      url: location.href,
      text: ((pick && pick.innerText) || document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim(),
      scrollY: Math.round(scrollY),
      pageHeight: Math.round(document.documentElement.scrollHeight),
      viewH: innerHeight,
      atBottom: scrollY + innerHeight >= document.documentElement.scrollHeight - 40,
      items: out,
    }
  })()`

  async function ensureSession(priv, viewport) {
    await ensure()
    if (session && session.conn === conn) { touchIdle(); return session }
    const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank' })
    const att = await conn.send('Target.attachToTarget', { targetId, flatten: true })
    const sid = att.sessionId
    await conn.send('Page.enable', {}, sid)
    await conn.send('Runtime.enable', {}, sid)
    const vw = (viewport && Number(viewport.width)) || 1280
    const vh = (viewport && Number(viewport.height)) || 800
    await conn.send('Emulation.setDeviceMetricsOverride',
      { width: vw, height: vh, deviceScaleFactor: 1, mobile: !!(viewport && viewport.mobile) }, sid)
    if (realUA) {
      await conn.send('Emulation.setUserAgentOverride',
        { userAgent: realUA, acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8' }, sid).catch(() => {})
    }
    // 会话里跳转到的地址同样要过校验，常驻会话不能成为绕开限制的后门
    const g = await guard(sid, priv)
    session = { conn, targetId, sessionId: sid, guard: g, priv, w: vw, h: vh }
    touchIdle()
    return session
  }

  const sEval = async (sid, expression) => {
    const r = await conn.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, sid)
    if (r.exceptionDetails) throw new Error('page_script_failed')
    return r.result?.value
  }

  // 等页面安顿下来：地址不再变、正文长度不再涨，就算稳住了
  async function settle(sid, ms = 1500) {
    let last = ''
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      await sleep(300)
      const now = await sEval(sid, `location.href + '|' + document.body.innerText.length`).catch(() => '')
      if (now && now === last) break
      last = now
    }
  }

  // 在常驻会话里打开一个地址
  async function sessionOpen(rawUrl, { allowPrivate: ap, viewport } = {}) {
    const priv = ap === undefined ? allowPrivate : !!ap
    const verdict = await checkUrl(rawUrl, { allowPrivate: priv })
    if (!verdict.ok) throw Object.assign(new Error(verdict.why), { statusCode: 400 })
    return queue(async () => {
      const s = await ensureSession(priv, viewport)
      const loaded = new Promise(resolve => {
        const off = conn.on(m => {
          if (m.sessionId === s.sessionId && m.method === 'Page.loadEventFired') { off(); resolve(true) }
        })
        setTimeout(() => { off(); resolve(false) }, navTimeout)
      })
      await conn.send('Page.navigate', { url: verdict.url }, s.sessionId)
      await loaded
      await settle(s.sessionId)
      visits += 1
      return sEval(s.sessionId, PROBE)
    })
  }

  // 当前页此刻的样子，不重新加载
  async function sessionState() {
    return queue(async () => {
      if (!session || session.conn !== conn) throw Object.assign(new Error('no_session'), { statusCode: 400 })
      touchIdle()
      return sEval(session.sessionId, PROBE)
    })
  }

  // 当前页的画面。给手机看的用 jpeg，体积小很多。
  async function sessionShot({ format = 'jpeg', quality = 60 } = {}) {
    return queue(async () => {
      if (!session || session.conn !== conn) throw Object.assign(new Error('no_session'), { statusCode: 400 })
      touchIdle()
      const params = { format }
      if (format === 'jpeg') params.quality = Math.min(Math.max(Number(quality) || 60, 20), 95)
      const r = await conn.send('Page.captureScreenshot', params, session.sessionId)
      // 报的是页面自己的坐标系（CSS 像素），不是截图的物理尺寸：
      // 手机仿真下没写 viewport meta 的页面会被整体缩放，两者不相等，
      // 拿物理尺寸去换算点击位置就会点偏。
      const vp = await sEval(session.sessionId, '({ w: innerWidth, h: innerHeight })')
        .catch(() => ({ w: session.w, h: session.h }))
      return {
        buf: Buffer.from(r.data, 'base64'), format,
        w: (vp && vp.w) || session.w,
        h: (vp && vp.h) || session.h,
      }
    })
  }

  // 在当前页上做一件事，做完回报页面的新样子。
  // 这些都是普通浏览器里人手就能做的动作：往下看、点开一条、在框里填字、回上一页。
  async function sessionAct(act = {}) {
    return queue(async () => {
      if (!session || session.conn !== conn) throw Object.assign(new Error('no_session'), { statusCode: 400 })
      const sid = session.sessionId
      const kind = String(act.type || '')

      // 按编号找到那个元素此刻在屏幕上的位置
      const pointAt = async index => {
        const st = await sEval(sid, PROBE)
        const it = (st.items || [])[Number(index)]
        if (!it) throw Object.assign(new Error('no_such_item'), { statusCode: 400 })
        return it
      }
      const tap = async (x, y) => {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await conn.send('Input.dispatchMouseEvent',
            { type, x, y, button: 'left', clickCount: 1, pointerType: 'mouse' }, sid)
        }
      }

      if (kind === 'scroll') {
        // 先用真实的滚轮事件，那些自己接管了滚动的页面才会响应
        const dy = Number(act.dy ?? Math.round(session.h * 0.8))
        const before = await sEval(sid, 'Math.round(scrollY)')
        await conn.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: Math.round(session.w / 2), y: Math.round(session.h / 2),
          deltaX: 0, deltaY: dy, pointerType: 'mouse',
        }, sid)
        await sleep(700)
        // 手机尺寸的窗口里滚轮常常不被理会，没动就直接滚
        const after = await sEval(sid, 'Math.round(scrollY)')
        if (after === before) {
          await sEval(sid, `scrollBy({ top: ${dy}, behavior: 'instant' })`)
          await sleep(500)
        }
        await sleep(400)          // 等惰性加载的内容补上来
      } else if (kind === 'click') {
        const it = (act.x !== undefined && act.y !== undefined)
          ? { x: Math.round(act.x), y: Math.round(act.y) }
          : await pointAt(act.index)
        await tap(it.x, it.y)
        await settle(sid, 2500)
      } else if (kind === 'type') {
        if (act.index !== undefined) { const it = await pointAt(act.index); await tap(it.x, it.y); await sleep(250) }
        if (act.clear) {
          await sEval(sid, `(() => { const el = document.activeElement
            if (el && ('value' in el)) { el.value = ''
              el.dispatchEvent(new Event('input', { bubbles: true })) } })()`)
        }
        await conn.send('Input.insertText', { text: String(act.text || '') }, sid)
        await sleep(300)
      } else if (kind === 'key') {
        const KEYS = {
          Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\\r' },
          Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
          Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
          Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
          ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
          ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
        }
        const k = KEYS[String(act.key)]
        if (!k) throw Object.assign(new Error('unsupported_key'), { statusCode: 400 })
        await conn.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k }, sid)
        await conn.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k }, sid)
        await settle(sid, 2500)
      } else if (kind === 'back') {
        await sEval(sid, 'history.back()')
        await settle(sid, 2500)
      } else if (kind === 'reload') {
        await conn.send('Page.reload', {}, sid)
        await sleep(1500)
        await settle(sid)
      } else {
        throw Object.assign(new Error('unknown_action'), { statusCode: 400 })
      }

      touchIdle()
      return sEval(sid, PROBE)
    })
  }

  async function sessionClose() {
    if (!session) return { ok: true }
    const s = session
    session = null
    try { s.guard.off() } catch {}
    try { await conn.send('Fetch.disable', {}, s.sessionId) } catch {}
    try { await conn.send('Target.closeTarget', { targetId: s.targetId }) } catch {}
    return { ok: true }
  }

  const status = () => ({
    chrome: findChrome(),
    available: !!findChrome(),
    running: !!(conn && !conn.closed),
    since: startedAt ? new Date(startedAt).toISOString() : null,
    visits,
    profile: profileDir,
    allowPrivate,
    lastError,
  })

  return { read, shot, script, status, close,
    sessionOpen, sessionState, sessionAct, sessionShot, sessionClose,
    hasSession: () => !!(session && session.conn === conn) }
}
