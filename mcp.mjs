// PairNest 的 MCP 端点 —— 把小屋里那扇「小窗」递给 Claude。
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
const SERVER_INFO = { name: 'pairnest', title: 'PairNest 小窗', version: '1.0.0' }

const INSTRUCTIONS = [
  '这是 PairNest（两个人的小屋）提供的浏览器。',
  '它在小屋的服务器上开一个真正的 Chrome 去打开网页，读回来的是页面脚本跑完之后的样子，',
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
  address_not_allowed: '这个地址指向内网或本机，出于安全被小屋挡下了。',
  protocol_not_allowed: '只能打开 http 和 https 的网页。',
  invalid_url: '这个网址不合法。',
  chrome_not_found: '小屋的服务器上没有安装 Chrome，浏览器起不来。',
  url_required: '要给一个网址。',
}
const explain = e => WHY[e && e.message] || `打开失败：${(e && e.message) || e}`

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

// DuckDuckGo 的无脚本版页面结构稳定，适合拿来提结果。
const SEARCH_URL = q => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
const SEARCH_EXTRACT = `(() => {
  const out = []
  for (const row of document.querySelectorAll('.result, .web-result')) {
    const a = row.querySelector('a.result__a')
    if (!a) continue
    let href = a.href
    try {
      // 搜索页的链接套了一层跳转，把真实地址解出来
      const u = new URL(href, location.href)
      const real = u.searchParams.get('uddg')
      if (real) href = real
    } catch (e) {}
    const snip = row.querySelector('.result__snippet')
    out.push({ title: (a.innerText || '').trim(), href,
               snippet: snip ? (snip.innerText || '').trim() : '' })
    if (out.length >= 25) break
  }
  return out
})()`

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
      const limit = Math.min(Math.max(Number(a.limit) || 8, 1), 20)
      try {
        // 搜索结果页本身就是网页，所以复用同一个浏览器，SSRF 那套校验照样生效。
        const r = await browser.script(SEARCH_URL(String(a.query)), SEARCH_EXTRACT, { allowPrivate: false })
        const rows = Array.isArray(r.value) ? r.value.slice(0, limit) : []
        if (!rows.length) {
          return text(`「${a.query}」没有搜到结果，或者搜索页这次没能正常加载。可以换个说法再试，或者直接用 browse_web 打开某个网址。`)
        }
        return text([`「${a.query}」的搜索结果：`, '',
          rows.map((x, i) => `${i + 1}. ${x.title}\n   ${x.href}${x.snippet ? '\n   ' + x.snippet : ''}`).join('\n\n'),
        ].join('\n'))
      } catch (e) { return failed(explain(e)) }
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
