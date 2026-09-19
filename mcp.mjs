// MCP 端点 —— 把这个浏览器递给 Claude 这类客户端。
//
// 走 MCP 的 Streamable HTTP 传输（JSON-RPC 2.0 over POST），手写实现，同样零依赖。
// 无状态：不分配 Mcp-Session-Id，每个请求自己带齐信息，这样平台重启也不会把会话弄丢。
//
// 私网策略：这里的工具是对公网开放的入口，所以每次调用都显式禁止访问内网地址，
// 不跟着 config 里的 browser.allowPrivate 走 —— 那个开关是给「本机自用的网页界面」的，
// 不该顺带把服务器内网也递给远端客户端。
//
// 认证：claude.ai 添加自定义连接器时只能填 URL（OAuth 之外没有地方放 Bearer 头），
// 所以密钥放在路径里 —— /mcp/<mcpToken>。这等同于 webhook URL 的做法：URL 本身就是凭据，
// 因此它会出现在反向代理和平台的访问日志里，别把这个地址贴给任何人。

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const SERVER_INFO = { name: 'window', title: '窗', version: '1.0.0' }

const INSTRUCTIONS = [
  '这是一个跑在服务器上的真实浏览器。',
  '它用 Chrome 打开网页，读回来的是页面脚本跑完之后的样子，',
  '所以那些靠 JS 渲染、直接抓 HTML 看不到内容的网站也读得到。',
  '需要查资料、看某个具体网址、或者想亲眼看看页面长什么样的时候，就用这里的工具。',
].join('')

const TOOLS = [
  {
    name: 'browse_web',
    title: '打开网页',
    description:
      '用一个真实的浏览器打开网址，读回标题、正文和页面上的链接。'
      + '拿到的是脚本执行完之后的内容，不是静态 HTML，所以单页应用和动态加载的页面也读得到。'
      + '想看某个具体网址的内容时用这个。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的网址，必须是 http 或 https 开头' },
        max_chars: { type: 'number', description: '正文最多返回多少字符，默认 8000，最大 40000' },
        include_links: { type: 'boolean', description: '是否一并返回页面上的链接，默认 true' },
      },
      required: ['url'],
    },
  },
  {
    name: 'search_web',
    title: '搜索网页',
    description:
      '在搜索引擎里搜一个关键词，返回若干条结果的标题、网址和摘要。'
      + '不知道该去哪个网址、需要先找一找的时候用这个，拿到结果再用 browse_web 打开想看的那条。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        limit: { type: 'number', description: '最多返回几条，默认 8，最大 20' },
      },
      required: ['query'],
    },
  },
  {
    name: 'page_open',
    title: '在常驻页面里打开',
    description:
      '在一个会一直停在那里的页面里打开网址，之后可以继续往下翻、点开某一条、在框里填字。'
      + '要连着看同一个网站（刷时间线、翻列表、进到详情页）就用这个；只想读一篇文章用 browse_web 更省事。'
      + '返回页面的文字，以及此刻屏幕上能操作的东西（每个带一个编号，后面按编号指认）。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的网址，必须是 http 或 https 开头' },
        mobile: { type: 'boolean', description: '用手机尺寸的窗口打开，默认 false（桌面尺寸）' },
      },
      required: ['url'],
    },
  },
  {
    name: 'page_look',
    title: '看看现在这一页',
    description:
      '返回常驻页面此刻的样子：标题、网址、正文、能操作的元素、滚到了哪里、到底了没有。'
      + '不会重新加载，纯粹是看一眼现在屏幕上有什么。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'page_do',
    title: '在这一页上做点什么',
    description:
      '在常驻页面上做一个动作，做完返回页面的新样子。动作有：'
      + 'scroll（往下翻一屏，dy 给负数就是往回翻）、'
      + 'click（点某个元素，index 用 page_look 给的编号）、'
      + 'type（在某个输入框里填字）、'
      + 'key（按 Enter / Escape / Tab / Backspace / 方向键）、'
      + 'back（回上一页）、reload（重新加载）。'
      + '刷一个列表就是反复 scroll；想看某一条就 click 它的编号，看完 back 回来。',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['scroll', 'click', 'type', 'key', 'back', 'reload'],
          description: '要做的动作',
        },
        index: { type: 'number', description: 'click / type 用：page_look 里那个元素的编号' },
        text: { type: 'string', description: 'type 用：要填进去的文字' },
        clear: { type: 'boolean', description: 'type 用：先清空原有内容，默认 false' },
        key: { type: 'string', description: 'key 用：Enter、Escape、Tab、Backspace、ArrowDown、ArrowUp' },
        dy: { type: 'number', description: 'scroll 用：翻多少像素，负数往回翻，默认往下一屏' },
      },
      required: ['type'],
    },
  },
  {
    name: 'page_shot',
    title: '给这一页拍照',
    description:
      '把常驻页面此刻的画面截下来。'
      + '文字读不到内容、或者想亲眼看看排版和图片的时候用它 —— 比如视频网站的列表页，'
      + '标题和封面是看得见的，但文字提取往往拿不到。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'page_done',
    title: '关掉常驻页面',
    description: '不看了就关掉它，省下服务器的内存。登录状态不会丢，下次打开还在。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'screenshot_web',
    title: '给网页拍照',
    description:
      '打开网址并截一张图返回，用来亲眼看看页面长什么样子——排版、配色、有没有报错。'
      + '只想要文字内容的话用 browse_web，那个便宜得多。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的网址，必须是 http 或 https 开头' },
        full_page: { type: 'boolean', description: '是否截整页而不只是首屏，默认 false' },
      },
      required: ['url'],
    },
  },
]

const text = t => ({ content: [{ type: 'text', text: String(t) }] })
const failed = t => ({ content: [{ type: 'text', text: String(t) }], isError: true })

const WHY = {
  address_not_allowed: '这个地址指向内网或本机，出于安全被挡下了。',
  protocol_not_allowed: '只能打开 http 和 https 的网页。',
  invalid_url: '这个网址不合法。',
  chrome_not_found: '服务器上没有安装 Chrome，浏览器起不来。',
  url_required: '要给一个网址。',
  no_session: '现在没有开着的页面，先用 page_open 打开一个。',
  no_such_item: '这一屏上没有这个编号的东西，先 page_look 看一眼现在有什么。',
  unknown_action: '不认识这个动作。',
  unsupported_key: '这个按键不支持。',
}
const explain = e => WHY[e && e.message] || `打开失败：${(e && e.message) || e}`

// 把常驻页面此刻的状态整理成一段能读的话。
function stateToText(st, { maxChars = 6000 } = {}) {
  const head = [
    `标题：${st.title || '（无）'}`,
    `网址：${st.url}`,
    `位置：${st.scrollY} / ${st.pageHeight}${st.atBottom ? '（已经到底了）' : ''}`,
  ].join('\n')
  const body = st.text
    ? (st.text.length > maxChars ? st.text.slice(0, maxChars) + '\n……（还有，往下翻）' : st.text)
    : '（这一页没读到文字。很多视频站、图片站就是这样，用 page_shot 看画面反而看得见。）'
  const items = (st.items || [])
    .map(i => `  [${i.i}] ${i.tag}${i.type ? ':' + i.type : ''} ${i.label || '（没有文字）'}`)
    .join('\n')
  return [head, '', body, '',
    `这一屏能操作的（${(st.items || []).length} 个，按编号指认）：`,
    items || '  （没有）'].join('\n')
}

// 把一次浏览结果整理成适合阅读的纯文本。
function pageToText(r, includeLinks) {
  const head = [`标题：${r.title || '（无）'}`, `网址：${r.url}`]
  if (r.blocked && r.blocked.length) head.push(`（顺带挡掉了 ${r.blocked.length} 个指向内网的请求）`)
  const body = r.text ? r.text : '（这一页没有读到文字内容）'
  const parts = [head.join('\n'), '', body]
  if (r.truncated) parts.push('\n……正文太长，后面截断了。')
  if (includeLinks && r.links && r.links.length) {
    parts.push('', '页面上的链接：')
    parts.push(r.links.slice(0, 60).map(l => `- ${l.text} → ${l.href}`).join('\n'))
  }
  return parts.join('\n')
}

// 搜索源：Bing 主、DuckDuckGo 兜底，一个没结果就试下一个。
// 这两家都要求来访者看起来像正常浏览器 —— browser.mjs 里把无头 Chrome 的自报身份
// 换回普通 Chrome 之后才拿得到结果；在那之前它们只给挑战页。
// Mojeek、Startpage、Brave 实测仍是 403 或 Captcha，就不放进来了。
const SEARCH_SOURCES = [
  {
    name: 'Bing',
    url: q => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    extract: `(() => {
      // 结果链接套了一层跳转，真实地址在 u 参数里：去掉 a1 前缀再 base64 解码
      const real = raw => {
        try {
          let s = String(raw).replace(/^a1/, '').replace(/-/g, '+').replace(/_/g, '/')
          while (s.length % 4) s += '='
          const bin = atob(s)
          return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)))
        } catch (e) { return null }
      }
      const out = []
      for (const li of document.querySelectorAll('li.b_algo')) {
        const a = li.querySelector('h2 a')
        if (!a) continue
        let href = a.href
        try {
          const u = new URL(href, location.href).searchParams.get('u')
          if (u) { const r = real(u); if (r) href = r }
        } catch (e) {}
        if (!/^https?:/i.test(href)) continue
        // innerText 在无头浏览器里对这些节点返回空，必须用 textContent
        const title = (a.textContent || '').trim()
        if (!title) continue
        const cap = li.querySelector('.b_caption p') || li.querySelector('p')
        out.push({ title, href, snippet: cap ? (cap.textContent || '').trim().slice(0, 300) : '' })
        if (out.length >= 25) break
      }
      return out
    })()`,
  },
  {
    name: 'DuckDuckGo',
    url: q => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    extract: `(() => {
      const out = []
      for (const row of document.querySelectorAll('.result, .web-result')) {
        const a = row.querySelector('a.result__a')
        if (!a) continue
        let href = a.href
        try {
          // 这边的跳转把真实地址放在 uddg 参数里
          const u = new URL(href, location.href).searchParams.get('uddg')
          if (u) href = u
        } catch (e) {}
        if (!/^https?:/i.test(href)) continue
        const title = (a.textContent || '').trim()
        if (!title) continue
        const s = row.querySelector('.result__snippet')
        out.push({ title, href, snippet: s ? (s.textContent || '').trim().slice(0, 300) : '' })
        if (out.length >= 25) break
      }
      return out
    })()`,
  },
]

export function createMcp({ browser, token }) {
  const enc = new TextEncoder()
  const safeToken = String(token || '')

  // 定长比较，避免把 token 一个字符一个字符地试出来。
  function tokenOk(given) {
    const a = enc.encode(String(given || ''))
    const b = enc.encode(safeToken)
    if (!safeToken || a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
    return diff === 0
  }

  async function callTool(name, args) {
    const a = args || {}
    if (name === 'browse_web') {
      if (!a.url) return failed(WHY.url_required)
      const max = Math.min(Math.max(Number(a.max_chars) || 8000, 200), 40000)
      const withLinks = a.include_links !== false
      try {
        const r = await browser.read(String(a.url), { maxChars: max, maxLinks: 60, allowPrivate: false })
        return text(pageToText(r, withLinks))
      } catch (e) { return failed(explain(e)) }
    }

    if (name === 'search_web') {
      if (!a.query) return failed('要给一个搜索关键词。')
      const q = String(a.query)
      const limit = Math.min(Math.max(Number(a.limit) || 8, 1), 20)
      let lastErr = null
      for (const src of SEARCH_SOURCES) {
        try {
          // 搜索结果页本身也是网页，所以复用同一个浏览器，那套地址校验照样生效
          const r = await browser.script(src.url(q), src.extract, { allowPrivate: false })
          const rows = Array.isArray(r.value) ? r.value.slice(0, limit) : []
          if (!rows.length) continue
          return text([`「${q}」的搜索结果（来自 ${src.name}）：`, '',
            rows.map((x, i) => `${i + 1}. ${x.title}\n   ${x.href}${x.snippet ? '\n   ' + x.snippet : ''}`).join('\n\n'),
          ].join('\n'))
        } catch (e) { lastErr = e }
      }
      if (lastErr) return failed(explain(lastErr))
      return text(`「${q}」没有搜到结果。可以换个说法再试，或者直接用 browse_web 打开某个网址。`)
    }

    if (name === 'page_open') {
      if (!a.url) return failed(WHY.url_required)
      try {
        const st = await browser.sessionOpen(String(a.url), {
          allowPrivate: false,
          viewport: a.mobile ? { width: 390, height: 844, mobile: true } : { width: 1280, height: 800 },
        })
        return text(stateToText(st))
      } catch (e) { return failed(explain(e)) }
    }

    if (name === 'page_look') {
      try { return text(stateToText(await browser.sessionState())) }
      catch (e) { return failed(explain(e)) }
    }

    if (name === 'page_do') {
      if (!a.type) return failed('要说做什么动作。')
      try {
        const st = await browser.sessionAct({
          type: String(a.type),
          index: a.index, text: a.text, clear: a.clear, key: a.key, dy: a.dy,
        })
        return text(stateToText(st))
      } catch (e) { return failed(explain(e)) }
    }

    if (name === 'page_shot') {
      try {
        const r = await browser.sessionShot({ format: 'png' })
        return {
          content: [
            { type: 'text', text: '常驻页面此刻的画面' },
            { type: 'image', data: r.buf.toString('base64'), mimeType: 'image/png' },
          ],
        }
      } catch (e) { return failed(explain(e)) }
    }

    if (name === 'page_done') {
      try { await browser.sessionClose(); return text('已经关掉了。登录状态还留着，下次打开还在。') }
      catch (e) { return failed(explain(e)) }
    }

    if (name === 'screenshot_web') {
      if (!a.url) return failed(WHY.url_required)
      try {
        const r = await browser.shot(String(a.url), { fullPage: !!a.full_page, allowPrivate: false })
        return {
          content: [
            { type: 'text', text: `${r.title || '（无标题）'} — ${a.url}` },
            { type: 'image', data: r.png.toString('base64'), mimeType: 'image/png' },
          ],
        }
      } catch (e) { return failed(explain(e)) }
    }

    return null   // 交给上层报 method/tool not found
  }

  // 处理一条 JSON-RPC 消息；返回 null 表示这是通知，不需要回应。
  async function handleMessage(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return { jsonrpc: '2.0', id: (msg && msg.id) ?? null,
               error: { code: -32600, message: 'invalid_request' } }
    }
    const { method, id } = msg
    const isNotification = id === undefined || id === null
    const ok = result => (isNotification ? null : { jsonrpc: '2.0', id, result })
    const err = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } })

    if (method === 'initialize') {
      const want = msg.params && msg.params.protocolVersion
      // 对方要的版本我们支持就用同一个，不支持就回我们自己最新的。
      const version = PROTOCOL_VERSIONS.includes(want) ? want : PROTOCOL_VERSIONS[0]
      return ok({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      })
    }
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) return null
    if (method === 'ping') return ok({})
    if (method === 'tools/list') return ok({ tools: TOOLS })
    if (method === 'tools/call') {
      const name = msg.params && msg.params.name
      const out = await callTool(name, msg.params && msg.params.arguments)
      if (out === null) return err(-32602, `unknown_tool:${name}`)
      return ok(out)
    }
    return err(-32601, `method_not_found:${method}`)
  }

  // 返回 true 表示这个请求已经被 MCP 端点处理掉了。
  async function handle(req, res, pathname, readBody) {
    const m = /^\/mcp(?:\/(.*))?$/.exec(pathname)
    if (!m) return false

    const send = (code, obj, headers = {}) => {
      const body = obj === null ? '' : JSON.stringify(obj)
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers,
      })
      res.end(body)
    }

    if (!tokenOk(m[1])) { send(404, { error: 'not_found' }); return true }

    // 不做服务端主动推送，按规范明确回 405。
    if (req.method === 'GET') {
      res.writeHead(405, { Allow: 'POST, DELETE', 'Cache-Control': 'no-store' })
      res.end()
      return true
    }
    // 无状态，没有会话要删，直接认掉。
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return true }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, DELETE' }); res.end(); return true
    }

    let payload
    try { payload = JSON.parse(await readBody(req, 1024 * 1024) || 'null') }
    catch { send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse_error' } }); return true }

    // 2025-06-18 起不再有批量消息，但收到数组也照样处理，省得客户端版本不同就断掉。
    if (Array.isArray(payload)) {
      const out = (await Promise.all(payload.map(handleMessage))).filter(Boolean)
      if (!out.length) { res.writeHead(202); res.end(); return true }
      send(200, out)
      return true
    }

    const out = await handleMessage(payload)
    if (out === null) { res.writeHead(202); res.end(); return true }
    send(200, out)
    return true
  }

  return { handle, tools: TOOLS }
}
