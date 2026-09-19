# PairNest

两个人的小屋：纪念日、心情日记、经期记录、云养宠、档案卡和可选定位。

一个 Node 进程同时提供页面和 API。私人内容保存在本机 `config.json` 与 `data/`，不会写进 Git 仓库。公开部署时整站有登录保护，API 也支持独立 Bearer Token。

## 部署需要什么

PairNest 不绑定或推荐具体云平台。每位使用者需要自行选择部署产品，并自行判断其价格、地区、付款方式、服务限制与隐私条款。

部署环境至少需要：

- Node.js 20 或更高版本；
- 能持续运行 `node server.mjs` 的 Web Service、服务器或自己的电脑；
- 一个 HTTPS 访问地址，供手机定位和 PWA 安装使用；
- 一个可写且不会在重启、休眠或重新部署时被清空的持久目录；
- 可配置环境变量与健康检查的能力。

如果要开「小窗」（让 PairNest 自己去看网页），部署环境还需要能执行的 Chrome/Chromium 和 1GB 以上内存，详见后面单独一节。

建议的服务配置：

```text
Build Command: node --check server.mjs
Start Command: node server.mjs
Health Check: /healthz
HOST: 0.0.0.0
PORT: 由平台提供
PAIRNEST_STATE_DIR: 持久目录的挂载路径
PAIRNEST_PASSWORD: 自己设置的网页登录密码
PAIRNEST_AUTH_SECRET: 足够长的随机字符串
PAIRNEST_API_TOKEN: 单独生成的随机 Token
```

`PAIRNEST_STATE_DIR` 中会保存 `config.json` 和整个 `data/`。选择产品时必须确认这个目录确实具有持久性；如果平台只提供临时文件系统，页面虽然能打开，日记、经期、定位等数据仍可能在服务重启后消失。

每位使用者都应部署自己的独立实例，不要多人共用原作者的密码、Token、地图 Key、配置文件或数据目录。平台选择、账号注册、套餐购买与续费由使用者自行处理。

## 从零部署

要求：Node.js 20 或更高版本。

```bash
git clone https://github.com/bear40828-cmyk/PairNest.git
cd PairNest
node -v
node server.mjs
```

第一次运行时程序会自动：

1. 创建 `config.json`，权限尽量设为仅当前用户可读写；
2. 创建 `data/`、`data/memories/` 和 `data/uploads/`；
3. 生成随机的网页登录密码、会话密钥和 API Token；
4. 在终端显示一次网页登录密码与 API Token。

先保存终端里的两个值，再打开 `http://127.0.0.1:8795` 登录。`config.json` 已在 `.gitignore` 中，不要把它发给别人或提交到仓库。

首次启动后可编辑 `config.json`，然后重启服务。`config.example.json` 只是字段参考；其中空的鉴权字段会在启动时自动生成。

## 配置

- `host`：默认 `127.0.0.1`。建议保持不变，通过反向代理提供 HTTPS；不要直接把 Node 端口暴露到公网。
- `port`：默认 `8795`。
- `auth.password`：网页登录密码。
- `auth.secret`：登录会话签名密钥，不要共享。
- `auth.apiToken`：给自己的脚本或 AI 调用 API 使用，不要放进前端代码。
- `auth.mcpToken`：MCP 连接器网址里的那段密钥，首次启动自动生成，和 apiToken 分开，可以单独更换。
- `publicUrl`：小屋对外的 https 地址，只用来在启动日志里拼出完整的 MCP 连接器地址，可不填。
- `startDate`：在一起的第一天。
- `parents`：档案卡中的名字和称呼。
- `features`：定位、密钥本、长期记忆、交接页、小窗与 MCP 开关，默认全关。
- `browser`：小窗（服务端浏览器）的细项开关，见下面单独一节。
- `myPlace`：定位页“我在哪”的显示名和坐标。

也可以用环境变量覆盖监听地址、状态目录与三个鉴权值：

```bash
HOST='0.0.0.0' \
PAIRNEST_STATE_DIR='/你的持久磁盘目录' \
PAIRNEST_PASSWORD='新的网页登录密码' \
PAIRNEST_AUTH_SECRET='足够长的随机字符串' \
PAIRNEST_API_TOKEN='单独的随机Token' \
node server.mjs
```

设置 `PAIRNEST_STATE_DIR` 后，程序会把 `config.json` 和整个 `data/` 都写到该目录。云平台必须把这个目录挂到持久磁盘；只设置目录名但没有挂盘，仍然会丢数据。云平台提供的 `PORT` 环境变量也会被自动识别。

API 调用示例：

```bash
curl -H "Authorization: Bearer 你的API Token" \
  https://你的域名/api/state
```

## 用 HTTPS 给手机访问

定位权限和添加到主屏幕都要求 HTTPS。推荐让 Node 继续只监听 `127.0.0.1`，由 Caddy、Nginx 或 Cloudflare Tunnel 反向代理。

Caddy 示例：

```caddy
pairnest.example.com {
  reverse_proxy 127.0.0.1:8795
}
```

不要把 `config.json`、`data/` 或整个项目目录交给另一个静态服务器公开。PairNest 自带的 Node 服务只会提供以下白名单资源：

- `index.html` 与 `manifest.json`；
- 仓库根目录的图片素材；
- `fonts/` 中的字体；
- `data/uploads/` 中由应用上传的纪念日背景。

`server.mjs`、`browser.mjs`、`.git/`、`config.json` 和其余 `data/` 内容不会通过静态 URL 返回。

## 小窗：让 PairNest 自己去看网页

开启后，PairNest 会在服务器上启动一个无界面的 Chrome，用 Chrome 调试协议（CDP）真的打开网页，
再把结果交给页面或 API。拿回来的是**脚本执行完之后**的内容，不是一段静态 HTML，所以那些靠 JS
渲染的页面也读得到。这部分没有引入任何 npm 依赖：Node 自带 WebSocket 和 fetch，CDP 本身就是
WebSocket + JSON。

手机上进「恋爱记忆 → 小窗」，输网址就能看；`config.json` 里没打开时，这个入口不会出现。

### 打开它

```json
{
  "features": { "browser": true },
  "browser": { "allowPrivate": false, "allowScript": false, "idleMinutes": 5 }
}
```

- `features.browser`：总开关，默认关。关着时全部 `/api/browser*` 一律 404。
- `browser.allowPrivate`：**默认关，除非你清楚自己在做什么，否则别开**。见下面的安全说明。
- `browser.allowScript`：是否允许 `/api/browser/script` 在页面里跑任意 JS，默认关。
- `browser.idleMinutes`：闲置多久自动关掉浏览器省内存，默认 5 分钟。

浏览器是懒启动的：没人用就不占内存，用的时候才起，闲置超时自己关。服务收到 `SIGINT`/`SIGTERM`
时也会把它一起带走。如果服务是被强杀的（平台重启、OOM），下次启动会接管上次留下的那个 Chrome，
而不是再起一个。

### 部署环境的额外要求

- 一个能执行的 Chrome / Chromium；
- 内存建议 **1GB 以上**。Chrome 本身通常要 300MB 起，512MB 的免费实例跑不动；
- 程序会按顺序找：`PAIRNEST_CHROME` 环境变量 → `PLAYWRIGHT_BROWSERS_PATH` 下的 chromium →
  `/usr/bin/chromium` 等常见路径 → macOS 的 Chrome.app。找不到就只是这个功能失效，不影响小屋其他部分。

Debian/Ubuntu 装一个：

```bash
apt-get update && apt-get install -y chromium
```

用 Docker 部署时，镜像里要自带 Chromium，例如：

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends       chromium ca-certificates fonts-noto-cjk     && rm -rf /var/lib/apt/lists/*
ENV PAIRNEST_CHROME=/usr/bin/chromium
WORKDIR /app
COPY . .
CMD ["node", "server.mjs"]
```

装了中文字体截图里才不会是一片方块。

### 登录态

浏览器的用户资料存在 `PAIRNEST_STATE_DIR/data/browser-profile/`，挂了持久盘就能长期保留。
这个目录已经在 `.gitignore` 里——**里面有 Cookie，等同于凭据，不要提交、不要打包发人**。

### API

都要鉴权（登录 Cookie 或 `Authorization: Bearer <apiToken>`）：

```bash
# 读一个网页：标题、正文、链接
curl -H "Authorization: Bearer 你的Token" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}' https://你的域名/api/browser/read

# 给网页拍张照，直接返回 PNG
curl -H "Authorization: Bearer 你的Token" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}' https://你的域名/api/browser/shot -o shot.png

# 看状态 / 主动关掉省内存
curl -H "Authorization: Bearer 你的Token" https://你的域名/api/browser
curl -X POST -H "Authorization: Bearer 你的Token" https://你的域名/api/browser/close
```

`/api/browser/script` 需要 `allowScript` 打开，请求体是 `{"url":"…","expression":"…"}`。

### 安全说明，认真读

一个跑在服务器上的浏览器，和跑在自己电脑上的浏览器风险完全不同：它能访问的是**服务器的网络位置**。
如果被诱导去访问内网地址或云平台的元数据服务（`169.254.169.254`），等于把整台机器交出去。
所以这里做了两层拦截：

1. 导航之前先解析目标域名，任何解析结果落在环回、私网、链路本地、运营商级 NAT 或组播地址的一律拒绝；
2. 页面发出的每一个请求都会被拦下来单独校验，重定向和子资源同样过一遍。

**残余风险要说清楚**：域名可以在「校验」和「Chrome 自己解析」这两次之间改变指向
（DNS rebinding）。第 2 层能挡住绝大多数实际情况，但不能把这个窗口完全关死。因此：

- 这个功能默认关闭，需要你自己判断能不能接受这点风险再开；
- **`allowPrivate` 会把上面两层防护整个关掉**，只在「PairNest 就跑在自己电脑上、你想让它看本机页面」
  这种情形下才开，公网部署的实例永远不要开；
- `allowScript` 允许在页面里执行任意 JS，能力很深，不需要就别开；
- 调试端口只监听 `127.0.0.1` 且由系统随机分配，不会对外暴露；
- 小窗读回来的内容全部当作不可信数据处理：文字转义后再显示，链接只认 `http(s)`。

另外，和本机玩法一样的那几条仍然成立：**只在这个浏览器里登录内容类账号，支付类、银行类账号永远不要登**；
扫码、密码、验证码这些始终自己动手。

## 把小窗接给 Claude（MCP 连接器）

小窗除了自己在手机上用，还能作为 MCP 工具交给 Claude 这类客户端，让它自己去查资料、打开网页、
看页面长什么样。PairNest 内置了一个 MCP 端点，走 Streamable HTTP 传输，同样是手写的，没有额外依赖。

这条路最实际的用处是：**不需要有电脑**。claude.ai 的自定义连接器是从 Anthropic 那边连过来的，
只要小屋有公网 https 地址就行，手机上添加一次，之后每个对话窗口都能用。

### 打开它

```json
{
  "features": { "browser": true, "mcp": true },
  "publicUrl": "https://你的域名"
}
```

两个开关都要开（MCP 提供的就是小窗的能力，单开 `mcp` 没有意义）。启动时终端会打印连接器地址：

```text
MCP 连接器地址：https://你的域名/mcp/<mcpToken>
```

### 在手机上添加

1. claude.ai → 设置 → 连接器 → 添加自定义连接器；
2. 把上面那个完整地址填进去，OAuth 的两个框留空；
3. 保存后在对话里就能看到 `browse_web`、`search_web`、`screenshot_web` 三个工具。

### 提供的工具

- `browse_web`：打开一个网址，读回标题、正文和链接；
- `search_web`：搜关键词，返回若干条结果的标题、网址和摘要；
- `screenshot_web`：打开网址并截图返回，用来亲眼看页面长什么样。

### 安全说明

- **这个网址本身就是凭据**。没有 OAuth 的自定义连接器没地方放 Bearer 头，所以密钥只能放在路径里
  （和 webhook 的做法一样）。这意味着它会出现在反向代理和平台的访问日志中：不要发给别人、
  不要截图公开、换人知道了就改 `auth.mcpToken` 重新生成一个；
- 端点的密钥用定长比较，猜不出来；`features.mcp` 关着时路径一律 404，不会透露它存不存在；
- **MCP 的三个工具永远不允许访问内网地址**，即使 `browser.allowPrivate` 开着也一样。
  那个开关只放宽小屋自己的网页界面（你本人在操作），不会顺带把服务器内网递给远端客户端；
- 端点不做服务端主动推送（GET 返回 405），也不分配会话 ID，是无状态的，平台重启不会把连接弄丢。

## 高德地图 Key：每个使用者必须自己申请

定位功能不能共用原作者或其他人的高德 Key。每个部署者都要登录自己的[高德开放平台](https://console.amap.com/)，为自己的域名分别申请：

1. `Web 服务` Key：服务器坐标转换与逆地理编码使用，填到 `amap.web_service.key`；
2. `Web 端（JS API）` Key 与安全密钥：地图底图使用，填到 `amap.web_js.key` 和 `amap.web_js.security_code`。

Key 的额度、白名单、账单与定位数据都属于申请者自己的账号。**不要把自己的 Key 写进公开仓库、截图、教程示例或发给其他使用者。**

不配置高德时，页面没有高德底图，服务器会尝试使用 OpenStreetMap Nominatim 反查地名。

## 隐私说明

- 日记、经期、宠物、语录等数据保存在本机 `data/*.json`。
- 浏览器提交定位后，精确坐标会先发到你自己的 PairNest 服务器。
- 配置高德时，服务器会把坐标发送给高德做坐标转换和地名反查；未配置高德时会发送给 OpenStreetMap Nominatim。
- 只有从 Telegram WebApp 启动时，页面才加载 Telegram 的 WebApp 脚本；普通浏览器不再固定请求该脚本。
- 开启小窗后，你让它打开的网址会由服务器上的浏览器去访问，对方网站看到的是服务器的 IP；浏览器的 Cookie 存在 `data/browser-profile/`。
- 登录 Cookie 使用 `HttpOnly` 与 `SameSite=Strict`；经 HTTPS 反代时还会带 `Secure`。

因此“数据在本地”是指 PairNest 不把数据集中上传给项目作者，不代表开启定位后完全不与地图服务通信。

## 手机安装为 PWA

### iPhone / iPad

1. 用 Safari 打开 HTTPS 地址并登录；
2. 点“分享”→“添加到主屏幕”；
3. 首次打开时允许定位权限（只在需要定位时）；
4. 如果从旧版本升级后仍看到顶部状态栏分层，删除旧的主屏幕图标，再从 Safari 重新添加一次，让 iOS 刷新 PWA 元数据。

页面使用 `viewport-fit=cover`、`black-translucent` 和动态安全区高度，状态栏背景会跟随当前页面。

### Android

1. 推荐用最新版 Chrome 打开 HTTPS 地址并登录；
2. 点右上角菜单 → “安装应用”或“添加到主屏幕”；
3. 确认安装，之后可从桌面像普通 App 一样打开；
4. 需要定位时，在浏览器或系统设置中允许该站点使用位置权限。

Edge、Samsung Internet 等支持 PWA 的浏览器也可以安装，菜单名称可能略有不同。如果没有“安装应用”，先确认网站使用 HTTPS、浏览器未处于无痕模式，并刷新页面后重试。旧版本更新后仍显示缓存页面时，卸载桌面上的 PairNest，再清除该站点数据并重新安装。

## 数据与备份

`data/` 下每个 JSON 对应一类数据：

- `anniversaries`：纪念日
- `diaries`：日记
- `moods` / `hermoods`：双方心情
- `periods` / `pdays` / `pdrec` / `pdcfg`：经期
- `locs`：定位轨迹
- `pet`：云养宠
- `quotes`：语录
- `quiz` / `quizans`：默契挑战
- `events`：事件

备份时同时保存 `data/` 和 `config.json`。恢复时放回原位置后重启服务。两者都含私人数据或凭据，不要上传公开网盘或 Git 仓库。

## 换成自己的样子

- `av-me.png` / `av-her.png`：两张占位头像，替换成自己的方图。
- `room3.jpg`：主页背景。
- `pet-egg.png`、`pet-baby.png`、`pet-kid.png`、`pet-adult.png`：宠物四阶段。
- 其余根目录图片为页面素材，可同名替换。

图片替换后如果手机仍显示旧图，可删除主屏幕上的旧 PWA，清除该站点的 Safari 网站数据后重新添加。
