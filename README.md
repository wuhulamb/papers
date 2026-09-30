# paper-downloader

通过 **Chrome DevTools Protocol (CDP)** 批量下载中英文学术论文：
- **`cnki-dl`**：从 [CNKI 中国知网](https://kns.cnki.net/) 按篇名批量下载中文期刊文献，自动处理知网的滑块安全验证。
- **`en-dl`**：用**有头 Chrome** 批量下载英文学术论文——Bing / Crossref 定位官方页面，PDF 直接落盘，并用 `pdf-parse` 校验题名，避免下到同名或相近的错误文献。

两个命令共享同一套 CDP 客户端 / 浏览器管理代码（`src/core/`），无第三方运行时依赖（`pdf-parse` 仅用于英文文献的题名校验）。

## 目录结构

```
.
├── bin/
│   ├── cnki-dl.js            # CLI：知网中文文献批量下载
│   └── en-dl.js              # CLI：英文学术论文批量下载
├── src/
│   ├── core/                 # 共享：CDP 客户端 / 浏览器启动与连接 / 通用工具
│   │   ├── cdp.js
│   │   ├── browser.js
│   │   └── utils.js
│   ├── cnki/
│   │   ├── cnki.js           # CNKI 检索 URL、结果行匹配、下载链接提取
│   │   ├── captcha.js        # 滑块拼图验证求解器（页面注入源码）
│   │   └── downloader.js     # 中文文献批量下载主流程与日志
│   └── en/
│       ├── search.js         # Bing / Crossref / 落地页 PDF 链接提取 / 候选排序
│       ├── download.js       # 下载 URL / 点击 PDF 按钮
│       ├── verify.js         # pdf-parse 题名校验
│       └── pipeline.js       # 英文文献批量下载主流程与日志
├── tools/
│   ├── enumerate-author.js   # 按“作者+机构”枚举 CNKI 论文，生成配置文件
│   ├── get-dois.js           # 用 Crossref 为英文配置补 DOI
│   ├── batch-dois.js         # 批量补 DOI（fetch 直连 Crossref，无需浏览器）
│   ├── sync-list.js          # 把下载日志状态同步回 Markdown 清单
│   ├── probe-cnki.js         # CNKI 题名探测（排查标题失配）
│   ├── salvage.js            # 手动抢救下载（直链/点开放获取按钮 + 校验）
│   └── scholar-to-config.js / topic-enumerate.js
├── examples/                 # 配置示例（见下）
├── output/                   # 下载产物（按作者分目录）
└── package.json
```

## 环境要求

- Node.js **>= 20**（依赖全局 `WebSocket`）。
- 本机有 Chromium / Chrome（可用环境变量 `CHROME_BIN` 指定路径）。
- 对目标文献有访问权限（校园网 / 机构 IP / 登录会话）。

```bash
npm install
```

## 一、中文文献（cnki-dl）

### 工作原理

1. **连接浏览器**：连接一个开启了远程调试端口（`--remote-debugging-port`）的 Chrome。
2. **篇名检索**：导航到 `https://kns.cnki.net/kns8s/defaultresult/index?kw=<篇名>&korder=TI`，在结果表中匹配题名与作者。
3. **滑块验证**：若出现 `.verify-move-block`，注入 JS 读取背景图与拼图块，用**归一化互相关（NCC）**求出缺口偏移，再派发合成的 `mousedown → mousemove → mouseup` 事件拖动滑块。
4. **提取下载链接**：打开知网文章页（知网节），读取「PDF下载 / CAJ下载」链接。
5. **下载**：通过 CDP `Browser.setDownloadBehavior` 指定 ASCII 临时目录，然后 `Page.navigate` 直达下载链接（并附带 `referrer` 以通过知网防盗链），Chrome 落盘后按 `id_题名.pdf` 归档。
6. **断点续传**：每个条目的状态写入 JSON 日志；已成功且文件存在的条目会自动跳过。

> 下载**不是**靠模拟鼠标点击完成的——合成 `click` 不被视为用户手势，会被弹窗拦截；这里用「设置下载目录 + 直接导航到下载 URL」的方式最稳。

### 快速开始

```bash
# 方式 A：连接已有 Chrome（推荐）
# 先用调试端口启动 Chrome：
#   /usr/lib/chromium/chromium --remote-debugging-port=9222 --user-data-dir=/tmp/cnki-chrome --no-first-run about:blank
node bin/cnki-dl.js --config examples/cnki-guoqi.json --port 9222

# 方式 B：由脚本启动 Chrome
node bin/cnki-dl.js --config examples/cnki-guoqi.json --launch            # 有界面
node bin/cnki-dl.js --config examples/cnki-guoqi.json --launch --headless # 无头

# 只跑其中几篇
node bin/cnki-dl.js --config examples/cnki-guoqi.json --ids 15,16,17

# 只检索匹配、不下载（用于验证配置/权限）
node bin/cnki-dl.js --config examples/cnki-guoqi.json --dry-run
```

### CLI 参数

| 参数 | 说明 |
|---|---|
| `--config <file>` | 配置文件（默认 `./cnki.config.json`） |
| `--ids 14,15` | 只处理指定 id |
| `--port <n>` | Chrome 调试端口（默认自动发现） |
| `--launch` | 自动启动 Chrome |
| `--headless` | 配合 `--launch` 使用无头模式 |
| `--no-new-tab` | 复用现有标签页 |
| `--dry-run` | 只检索匹配，不下载 |
| `-h, --help` | 帮助 |

端口自动发现顺序：`--port` → 环境变量 `CHROME_DEBUG_PORT` → 常见 profile 目录下的 `DevToolsActivePort` → `9222`。

### 按作者批量下载

先枚举某作者在 CNKI 上以“学术期刊”收录、且属于指定机构的论文，生成配置，再下载：

```bash
# 1) 枚举（可选 --affiliation 按机构过滤，减少重名作者）
node tools/enumerate-author.js --author 朱晟君 --affiliation 北京大学 --out examples/zhuchengjun.json --port 9222

# 2) 下载
node bin/cnki-dl.js --config examples/zhuchengjun.json --port 9222
```

`enumerate-author.js` 输出即为可用的配置文件（`{ authorFilter, papers }`），可自行补充 `outputDir` 等字段。

## 二、英文文献（en-dl）

### 工作原理

1. **定位**（三种手段，按优先级）：
   - 配置里直接给的 **DOI**；
   - 若没有 DOI，用 **Crossref API** 按题名查 DOI（对题名关键词做相似度匹配）；
   - 用 **cn.bing.com** 搜索题名（`"<title>" pdf` / `filetype:pdf` 等），收集候选链接。
2. **下载**：启动一个**有头 Chrome**（curl / 无头会被 Cloudflare 拦截），并在**全新 profile** 首次启动前写入 `plugins.always_open_pdf_externally = true`，
   让 Chrome 遇到 PDF 时**直接下载**而不是打开内置阅读器（否则只能拿到阅读器外壳，拿不到 PDF 内容）。
   下载目录由 `Browser.setDownloadBehavior` 指定为 **ASCII 临时目录**；每次运行默认重建 profile，避免反爬指纹残留。
3. **校验**：用 `pdf-parse` 提取 PDF 的元数据标题/正文开头，与预期题名比对；命中才保存，否则丢弃（可留档到 `rejectedDir`）。
4. **Cloudflare 处理**：访问落地页遇到「Just a moment」挑战时，自动先访问平台**首页**建立机构会话再重试（实测 ScienceDirect 机构订阅文献可完整下载）。
5. **失败记录**：无机构订阅的付费墙（T&F 等）或拦截会记为失败并写入日志，可断点续跑。

### 快速开始

```bash
# 用示例配置跑
node bin/en-dl.js --config examples/en-guoqi.json

# 只跑其中几篇
node bin/en-dl.js --config examples/en-guoqi.json --ids 10,11,12

# 不用 Bing，只用 DOI/Crossref
node bin/en-dl.js --config examples/en-guoqi.json --no-bing

# 保留有头 Chrome 便于人工观察（默认任务结束自动关闭，profile 默认自动重建）
node bin/en-dl.js --config examples/en-guoqi.json --keep-chrome
```

补全 DOI：

```bash
node tools/get-dois.js --config examples/en-guoqi.json
```

### CLI 参数

| 参数 | 说明 |
|---|---|
| `--config <file>` | 配置文件（默认 `./en.config.json`） |
| `--ids 1,2,3` | 只处理指定 id |
| `--port <n>` | 调试端口（默认 `9336`） |
| `--no-bing` | 不使用 Bing |
| `--keep-chrome` | 结束后保留启动的 Chrome（方便人工观察/复用） |
| `--profile <dir>` | 指定 user-data-dir（默认 `/tmp/en-headed`，每次运行自动重建全新 profile） |
| `-h, --help` | 帮助 |

默认启动**有头 Chrome**（全新 profile，预写 PDF 直接落盘偏好）；定位可用 pi-chrome-devtools 扩展观察（连接到同一调试端口时）。

## 三、机构订阅文献下载（已验证流程）

> 场景：机构订阅数据库（如 ScienceDirect）付费文献的批量下载。
> **适用于有机构 IP 授权的环境（如校园网）。** 全文下载需要机构订阅权限，站点可达不等于可下载。

### 已验证的平台可用性（本环境：华东师范大学 IP）

| 平台 | 访问 | 下载 | 说明 |
|---|---|---|---|
| **ScienceDirect (Elsevier)** | ✅ | ✅ | 页面显示机构徽章「Brought to you by: …」即有订阅权限 |
| **Nature 系**（nature.com） | ✅ | ✅ | OA 文献直链 / `citation_pdf_url` 可下 |
| **Springer**（link.springer.com） | ✅ | ✅ | 部分文章 OA（`/content/pdf/` 直链） |
| **Taylor & Francis**（tandfonline.com） | ✅ | ❌ | 本环境无机构订阅（页面无机构徽章，PDF 被拒） |
| City 期刊等 Elsevier 大库 | — | 视订阅 | 判断依据：页面是否显示机构徽章 |

> ⚠️ 注意：**curl / 无头 Chrome 访问这些站点会被 Cloudflare 拦截（403 / Just a moment）**，
> 有界面 Chromium + 机构 IP 才能通过。代理（SOCKS5）对 Cloudflare 付费墙基本无用。

### 为什么之前失败 / 关键要点

1. **必须用有界面 Chrome**（非无头）：Cloudflare 对无头/脚本 UA 直接 `Just a moment` 或 403。
2. **全新 profile 预写 `Preferences`**（`plugins.always_open_pdf_externally=true`）：否则 Chrome 用内置 PDF 阅读器打开 PDF，永远不落盘。注意：Chrome 启动后会重写 Preferences，字段要**在全新 profile 首次启动前写入**才会被保留（`--disable-pdf-viewer` 参数在本版本无效）。
   参考（`src/core/browser.js` 的 `launchHeadedPdf` 同款写法）：
   ```bash
   mkdir -p /tmp/pdfdl-chrome/Default
   echo '{"plugins":{"always_open_pdf_externally":true},"download":{"prompt_for_download":false}}' \
     > /tmp/pdfdl-chrome/Default/Preferences
   /usr/lib/chromium/chromium --no-sandbox \
     --remote-debugging-port=9341 --user-data-dir=/tmp/pdfdl-chrome about:blank &
   ```
3. **先访问平台首页 → 再访问文章页**：直接在机构库裸访问文章页容易触发 Cloudflare 挑战；从首页进入可建立机构会话（页面出现「Brought to you by: 我的大学」即成功）。
4. **用 CDP `Input.dispatchMouseEvent` 真实点击页面里的 PDF 链接**（真实用户手势）：注入 `el.click()` 会被站点 JS 忽略；新标签页/下载才会正常触发。
5. **下载动作 = `Browser.setDownloadBehavior`(allow → ASCII tmpDir) + 点击/导航**，与 cnki 下载器同一套路；校验依然用 `pdf-parse`。
6. **不要用 Node/curl 直接 GET 最终 CDN URL**：SD 的 `pdf.sciencedirectassets.com` 签名 URL 带时效且要求浏览器 cookie，直接请求会 302/HTML。

### 走通的完整流程（以 ScienceDirect 为例）

```
1) 启动有界面 Chromium（预写 Preferences，见上）
2) 导航 https://www.sciencedirect.com/ 首页（建立机构会话）
3) 导航目标文章页，确认机构徽章出现：
     document.body.innerText 含 “Brought to you by: …”（即订阅生效）
4) 在文章页找到 PDF 链接（a[href*=pdfft]），用 CDP Input 真实点击
   （真实用户手势，页面的 JS 下载逻辑才会执行）
5) Browser.setDownloadBehavior 已设为 ASCII 临时目录 → PDF 自动落盘
6) pdf-parse 校验题名后归档到 outputDir/<id>_<题名>.pdf
```

### 定位文献的两段式（代理 + 直连）

- **代理定位**：Google Scholar 等被墙站点用 SOCKS5 代理访问（`curl -x socks5h://127.0.0.1:1080` 或 Chromium `--proxy-server=socks5://127.0.0.1:1080`），抓取题名/作者/来源/年份；
- **直连下载**：关闭代理，在有机构授权的直连网络里按上流程下载（代理出口 IP 通常没有机构订阅授权）。

## 配置文件

两个命令都通过 `--config <file>` 指定配置文件；不传时默认在当前目录找 `cnki.config.json` / `en.config.json`（找不到会报错并提示）。**相对路径以配置文件所在目录为基准**（因此 `examples/` 下的示例配置把产物输出到仓库根 `output/`）。

```jsonc
// cnki 配置示例（examples/cnki-guoqi.json）
{
  "authorFilter": "郭琪",              // 可选：结果作者须包含该字符串，否则记失败（题名精确匹配时放行）
  "outputDir": "../output/郭琪_中文文献",
  "tmpDir": "../.tmp-download",       // 必须为 ASCII 路径，中文路径会导致 Chrome 回退默认目录
  "logFile": "../output/郭琪_中文文献/download-log.json",
  "downloadTimeoutMs": 45000,
  "delayBetweenMs": 4000,             // 每篇之间的间隔，降低风控概率
  "cooldownEvery": 12,                // 每下载 N 篇冷却一次
  "cooldownMs": 90000,                // 冷却时长
  "papers": [
    { "id": 15, "title": "出口集聚、企业相关生产能力与企业出口扩展",
      "authors": "郭琪,周沂,贺灿飞", "source": "中国工业经济", "year": "2020" }
  ]
}
```

```jsonc
// en 配置示例（examples/en-guoqi.json）
{
  "outputDir": "../output/郭琪_英文文献",
  "tmpDir": "/tmp/en-paper-dl",             // 必须是 ASCII 路径
  "rejectedDir": "/tmp/en-paper-rejected",  // 校验失败文件的留档目录
  "logFile": "../output/郭琪_英文文献/download-log.json",
  "paperBudgetMs": 70000,                   // 单篇候选尝试总预算
  "downloadTimeoutMs": 14000,               // 单个 URL 下载超时
  "useBing": true,
  "papers": [
    { "id": 1, "title": "...", "authors": "...", "source": "...", "year": "2024", "doi": "10.xxxx/yyyyy" }
  ]
}
```

`downloadTimeoutMs` / `outputDir` / `tmpDir` / `logFile` / 限速项均有默认值，可省略。批量较大时建议保留 `delayBetweenMs` 与 `cooldown*`（CNKI），否则可能在连续下载数十篇后触发风控（表现为下载超时）。

## 输出与日志

- 每篇文献平铺保存为 `outputDir/<id>_<题名>.pdf`（或 `.caj`），不建子目录。
- 状态写入 `logFile`，字段包括 `status`、`file`、`bytes`、`format`、`reason`、`verify` 等，便于汇总和续传。
- 已成功且文件存在的条目会自动跳过，支持断点续跑。

## 常见问题

- **「来源应用不正确(01)」**：知网下载链接有防盗链，必须从文章页携带 `referrer` 访问——代码已处理。
- **下载后找不到文件**：`tmpDir` 用了中文/非 ASCII 路径；改成纯英文路径（如 `/tmp/en-paper-dl`）。
- **滑块验证反复出现/失败（CNKI）**：多为触发风控或访问过快；可放慢节奏、使用有界面 Chrome，并确认网络出口稳定。
- **连续下载数十篇后批量失败（CNKI）**：`bar.cnki.net` 下载链路有「每 N 次下载后需验证」（EveryNTimes）的频控；验证失败后会被重定向到登录页，且日志里保存的 `downloadHref` 有过期，直接复用会挂起。**应对：关闭所有 `login.cnki.net` 登录页 tab，重新完整跑一遍下载**（从检索页 → 文章页重新提取新下载链接 → 下载），新会话不再要求登录。分批下载（如 `--ids` 每次 10-20 篇）可减少触发。
- **「下载未开始或超时」且页面停在 about:blank**：同上，多为旧 `downloadHref` 已过期或登录墙；重跑流程获取新链接即可。
- **大型失败（英文文献）**：多数站点（T&F/Wiley/SAGE/Elsevier/MDPI/OUP 等）部署了 **Cloudflare 人机验证**，curl / 无头 Chrome 会被直接拦截（403 / Just a moment）。`en-dl` 已默认改**有头 Chrome**（全新 profile + 落地页自动首页预热）应对；能否下载全文仍取决于机构订阅（见「三、机构订阅文献下载」）——没有订阅的付费墙任何网络都救不了。
- **下到错误文献**：正是 `pdf-parse` 校验要拦截的情况；被丢弃的文件会留档在 `rejectedDir`。
- **需要登录/权限**：无权限的文献会记为失败并跳过，可在日志中查看原因（机构 IP 直连时一般无需登录）。
- **CNKI 标题失配 / 整题名搜不到**：知网存储题名与参考文献题名常在全角/半角标点（`：`/`:`、`（）`/`()`、`“”`/`"`、`、`/`,`）上不一致，导致 TI 检索失配——代码已做标点归一化比对；仍失配时先用 `tools/probe-cnki.js` 探出知网真实题名再改配置，或用主关键词截断检索（`korder=SU/TI`）。
- **下到 Web of Science「Citation Report」伪 PDF**：Bing 候选可能混入 WoS 引文报告导出，meta 含目标题名但并非论文全文——`pdf-parse` 校验已过滤 `citation report / web of science / clarivate` 并拒收。
- **短文 / 图版类论文被校验误拒**：如 Environment and Planning A 的 2 页 "Featured Graphic"，正文以图为主命中分常不足 0.7——此类人工确认后保留即可。
- **付费墙抢救顺序**（机构有订阅时的补充手段，需有头 Chrome + 全新 profile）：SAGE 中国镜像 `sage.cnpereading.com/doi/<doi>`（点「PDF」按钮）→ Wiley `onlinelibrary.wiley.com/doi/pdfdirect/<doi>` → T&F `tandfonline.com/doi/pdf/<doi>` 直下 → 作者/机构库（pure.eur.nl、eprints、edu，常藏 published/working 版）→ OJS 平台（oekom.de 等）`article/download/<id>/<galley>` 直链。
- **跨设备归档报 EXDEV**：`/tmp` 与工作区不在同一文件系统时 `fs.renameSync` 会抛 EXDEV——归档统一用「rename 失败则 copyFile + unlink」兜底（管线已内置）。

## 合规提示

请仅下载你有权访问的文献，遵守中国知网及各出版方的服务条款与版权规定，用于个人学习/研究用途。

## 许可

MIT