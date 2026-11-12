# PDF 导出的技术选型与中文字体方案

> 对应 issue：`XH-note/Task-Layout-Engine#4`（label：`wayfinder:research`）
> 调研范围：本地 Web 应用（浏览器打开 → 本机后端调 LLM → 前端展示/编辑结构化「任务计划书」→ 导出 Markdown + PDF），单人使用、无账号无云、界面与输出均为中文。
> 取证原则：仅采信官方文档 / 项目仓库 / 发布说明等一手来源，逐条附 URL（见末尾「来源列表」）。个别体积数值因网络限制无法从 GitHub Release API 取到精确字节数，已在正文标注为量级判断。

---

## 结论摘要

1. **v1 主方案：浏览器打印（CSS Paged Media）**。零额外依赖、零安装体积、不增加打包负担，且天然复用前端已有的 HTML/CSS。结构化计划书本身是「业务级排版」（标题 + 表格 + 任务树），不是书籍级排版，浏览器打印的保真度足够。
2. **v1 升级方案（需要「点一下按钮就出 PDF」时）：Headless Chromium（Playwright / Puppeteer）**。与主方案共用**同一份 `print.css`**，只是把「用户点打印对话框」换成后端脚本调用 `page.pdf()`。代价是随应用分发/首次下载 Chromium 内核。
3. **Typst 是「排版质量 / 安装体积」性价比最好的第三方方案，但不建议 v1 采用**：它要求为 PDF 单独维护一套 `.typ` 模板，**无法复用前端 CSS**，等于同一份文档要维护两套渲染实现；中文字体还必须显式指定（默认字体不含 CJK 字形）。
4. **Pandoc + LaTeX 与 reportlab 均不推荐**：Pandoc 自己不是 PDF 引擎，默认走 LaTeX，必须再拖一个 TeX 发行版（官方称完整 MacTeX「占 4 GB」，TinyTeX 的完整 TeX Live 是「several GB」）；reportlab 是「手写绘制代码」的库，中文连断行都不是默认行为（官方要求 `wordWrap='CJK'`）。
5. **WeasyPrint 技术上最贴合需求，但 Windows 落地成本偏高**：官方文档明说在 Windows 上「最省事的用法是直接用官方发布的可执行文件」，作为库使用要先装 Python 再用 MSYS2 装 Pango；官方还专门警告它「经常被杀毒软件标记为恶意软件」；文档自述渲染较慢；flex/grid 直到 v62（2024-04）才引入 grid，之后仍在持续修 bug。
6. **中文字体方案：随应用打包一份开源 CJK 字体，用 `@font-face` 引入**，不要依赖用户机器上有没有装字体；同时显式声明 `font-family` 回退链、行高与中西文混排间距。
7. **能力边界要写进设计**：Chromium 从 131 起支持 `@page` 页边距盒子（页码、静态页眉页脚都能用 CSS 做），但**仍不支持** `string-set`/`string()`（running header 取章节名）、`target-counter`（正文交叉引用页码）、`float: footnote`（脚注）。v1 若要求「每页页眉显示当前章节名」，需降级为固定标题或用 `headerTemplate`。
8. **Markdown 导出确实只是前端一键生成**：`plan(JSON) → Markdown 字符串 → Blob → URL.createObjectURL → <a download>` 即可，不需要后端、不需要额外依赖。PDF 才是唯一需要「渲染引擎」的那一项。注意选对 Markdown 方言（GFM 的表格与任务列表）并处理转义。

---

## 候选对比表

| 维度 | ① 浏览器打印 / CSS Paged Media | ② Headless Chromium（Playwright / Puppeteer） | ③ Typst | ④ Pandoc + LaTeX | ⑤ WeasyPrint / reportlab |
| --- | --- | --- | --- | --- | --- |
| **安装体积与依赖** | 无。用的是用户已装的浏览器（建议限定 Chrome/Edge 131+） | 需 Chromium 内核；Playwright 会下载整套浏览器二进制，通常需随应用分发或首次联网下载（体积显著，具体数值随平台/版本而变） | 单一可执行文件，无运行时依赖（无 Python/Node/JVM）；字体可随项目目录打包 | 需 Pandoc + TeX 发行版。官方：完整 MacTeX「占四个 GB」，建议 BasicTeX/TinyTeX；TinyTeX 的完整 TeX Live 是「several GB」，其自述动机是「多半只会用到不到 1% 的宏包」 | WeasyPrint：Python ≥3.10 + Pango ≥1.44 + pydyf/tinycss2/tinyhtml5/cssselect2/Pyphen/Pillow/fontTools；Windows 作库使用要先装 Python 再用 MSYS2 装 Pango。reportlab：纯 Python 包，体积小但功能=代码绘制 |
| **中文字体与断行** | 用系统字体即可；但「用户机器上恰好没装」是真实风险 → 应 `@font-face` 自带字体。断行由浏览器排版引擎处理，中文表现最好（含避头尾、标点挤压） | 与①同引擎，行为一致；`waitForFonts` 默认 `true`，会等字体加载完再出图 | 必须显式配置：默认字体 `libertinus serif` 无 CJK 字形；官方提供 `covers: "latin-in-cjk"` 的字体描述符做中西文混排，`cjk-latin-spacing` 默认 `auto` 自动加中西文间距；`lang` 默认 `en`，中文文档应设 `lang: "zh"` | 取决于所选引擎与模板；XeLaTeX/LuaLaTeX + `ctex` 生态成熟，但模板与字体配置是另一套知识 | WeasyPrint：靠 Pango/HarfBuzz，中文断行可用，但须装字体或 `@font-face`（官方「Missing Fonts」一节：缺字体就出方块）。reportlab：**中文断行不是默认行为**，官方指南要求 `wordWrap='CJK'`，否则整段不折行 |
| **分页 / 页眉页脚 / 表格** | 强：`@page` 尺寸与边距、`break-before/after`、`break-inside: avoid`、`orphans/widows`；Chrome 131+ 支持 16 个页边距盒子（`@top-left` … `@bottom-right-corner`）+ `counter(page)`/`counter(pages)`。缺：running header、`target-counter`、脚注 | 同①，另加 `displayHeaderFooter` + `headerTemplate`/`footerTemplate`（HTML 模板，可注入 `pageNumber`/`totalPages`/`title`/`url`/`date`）、`preferCSSPageSize`、`pageRanges`、`tagged`（无障碍标记）、`outline`（书签） | 最强：`page(header:, footer:, numbering:)` 内建页码与页眉页脚，`counter(page).display("1 of 1", both: true)`；孤行寡行默认就防（`costs` 里 widow/orphan 默认 100%）；表格跨页表头用 `table.header`/`table.footer` | LaTeX 分页质量最好，但模板维护成本高，出错信息难读 | WeasyPrint：`@page` + margin box + 书签/链接/附件，能力接近①且可脚本化。reportlab：分页/页眉页脚要自己写 `onPage` 回调、自己算布局 |
| **能否复用前端页面样式** | **能，且是同一套 CSS**（`@media print`） | **能，逐字节复用**（同一份 `print.css`） | **不能**。需另写 `.typ` 模板，前端改了样式 PDF 不会跟着变 | 不能。Markdown/LaTeX 模板另立一套 | WeasyPrint 部分能：吃 HTML+CSS2.1/部分 CSS3，但 flex/grid 是近两年才补齐（grid 自 v62 起），复杂布局需实测；reportlab 完全不能 |
| **离线可用性** | 完全离线（浏览器本地渲染） | 完全离线（本地 Chromium） | 完全离线 | 完全离线（装了 TeX 之后） | 完全离线（WeasyPrint 需注意默认 HTTP 超时 10s，本地资源无碍） |
| **上手 / 维护成本** | 最低：只写 CSS。痛点=必须让用户手动「打印 → 另存为 PDF」 | 低-中：`page.goto()` + `page.pdf()` 十来行；成本在分发内核与冷启动 | 中-高：要学 Typst 语言与模板体系，双份渲染实现 | 高：LaTeX 模板 + 字体配置 + 数百 MB~GB 级依赖 | 中：WeasyPrint 装好后可脚本化出 PDF，但 Windows 装 Pango、杀软误报、性能都要处理；reportlab 是纯代码排版，长期维护成本最高 |
| **本项目适配结论** | ✅ v1 采用 | ✅ v1.1 采用（做「一键导出」） | ⏸ 备选（排版质量升级时） | ❌ | ❌（WeasyPrint 仅作跨平台脚本化备选） |

> 说明：Chromium 支持 `@page` 页边距盒子是 **Chrome 131（2024-10）** 之后的新能力，见 `developer.chrome.com/blog/print-margins`；因此网上大量「Chromium 不支持 CSS 页眉页脚」的旧结论已过期。仍未支持项见该文列出的 chromestatus/Issues 编号（`376420244` running header、`40529223` target-counter、`376428674` 脚注）。
>
> Puppeteer / Playwright 的取证说明：Playwright 官方 `page.pdf` 文档页在本次抓取时被截断，故以 API 同源的 Puppeteer 文档（`pptr.dev`）取证；两者都是 Chromium DevTools Protocol 的封装，`page.pdf()` 行为一致。

---

## 推荐与取舍

### 方案 A（v1 默认）：浏览器打印 + 一份专属 `print.css`

- **怎么做**：前端维护两套呈现——屏幕用编辑态 UI，打印用 `@media print` 下的「文档态」（隐藏工具栏/抽屉、去掉交互态边框、展开任务树、表格去掉省略号）。`@page { size: A4; margin: 20mm 16mm; }`，页码用 Chrome 131+ 的页边距盒子：
  ```css
  @page {
    size: A4;
    margin: 20mm 16mm 18mm;
    @bottom-center { content: counter(page) " / " counter(pages); font-size: 9pt; }
    @top-right { content: "任务计划书"; font-size: 9pt; color: #888; }
  }
  ```
- **为什么选它**：
  - 安装体积 = 0，不引入任何运行时或浏览器内核，符合「本地单人使用、零云端」的定位；
  - 复用前端 CSS，样式改动立即反映到 PDF，不存在「两套渲染实现漂移」；
  - 中文字体、断行、表格都由成熟排版引擎处理，是五个候选里中文表现最稳的。
- **明确取舍（要写进产品说明）**：
  - 需要用户手动完成「打印 → 目标选『另存为 PDF』→ 关闭『页眉和页脚』→ 勾选『背景图形』」；
  - 浏览器自带页眉页脚（含 URL、日期）会叠加，必须提示用户关闭，或把 `@page` margin 设小到不显示（官方说明：`@page` 边距为 0 或过小时浏览器自带的不会显示）；
  - 分页结果依赖浏览器版本，需在 Chrome/Edge 双端回归；Safari/Firefox 的 `@page` 盒子支持不可依赖 → 明确只支持 Chromium 系。

### 方案 B（v1 或 v1.1）：Headless Chromium 出一键 PDF

- **怎么做**：本机后端（已有，用于调 LLM）加一个 `GET /export/pdf`，用 Playwright 打开同一个前端路由（带 `?print=1` 的只读视图），等 `document.fonts.ready` 后 `page.pdf({ path, format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate, footerTemplate })`。
- **为什么选它**：与方案 A **零样式分叉**（同一份 HTML/CSS），换来真正的「一键导出」、可脚本化、可批量、可加书签（`outline`）与无障碍标记（`tagged`，Puppeteer 默认已开）。
- **明确取舍**：
  - 首次需下载 Chromium 内核（体积显著），并处理「离线机器首次安装」的分发问题——这是唯一实质成本；
  - 冷启动与首屏渲染有秒级延迟，需要 loading 态；
  - `page.pdf()` 用 **print 媒体类型**（官方原文："Generates a PDF of the page with the `print` CSS media type"）；若为了截屏效果去 `emulateMediaType('screen')`，会**同时禁用 `@media print`**，可能破坏分页 —— 不要这么做；
  - 颜色默认会被「打印修正」，要 `printBackground: true` + `-webkit-print-color-adjust: exact` 才能出原色。

### 方案 C（备选，暂不采用）：Typst

- 若将来 PDF 要求升级到「书籍级」（严格孤行寡行控制、脚注、交叉引用、书签目录、可复现的排版结果），Typst 是五个候选里**质量/体积**综合最优的：单二进制、无运行时、PDF 1.7 默认、默认就写 Tagged PDF、`page(header:, footer:, numbering:)` 内建页码、跨页表头有 `table.header`。
- **但代价是接受「双份渲染实现」**：前端 CSS 与 `.typ` 模板各自演进。这与「界面可编辑、导出与界面一致」的产品直觉相冲突，故不作为 v1。
- 采用时必须做两件中文相关的事：显式 `#set text(font: (...), lang: "zh")` 并打包 CJK 字体（CLI 用 `--font-path`/`TYPST_FONT_PATHS` 追加字体目录，或用 `--ignore-system-fonts` 保证只用随包字体，避免不同机器字体不同导致排版漂移）。

### 为什么不选 ④⑤

- **Pandoc + LaTeX**：Pandoc 官方明确「默认用 LaTeX 生成 PDF」，等于把问题从「HTML→PDF」换成「Markdown→LaTeX→PDF」，并引入 GB 级 TeX 依赖与 LaTeX 模板调试成本。对一个单人使用的本地工具，投入产出比最差。
- **WeasyPrint**：能力上其实很贴合（吃 HTML/CSS、可脚本化、支持 `@page` 与书签），但 Windows 是它最不顺的平台：官方建议直接用发布的可执行文件；作库使用需 MSYS2 装 Pango 并设 `WEASYPRINT_DLL_DIRECTORIES`；官方还有「经常被杀软误报」的专门警告；文档自述「pretty slow」。如果将来要跨平台（macOS/Linux 也是主要使用场景）且必须脚本化，它是比 Playwright 更轻的备选——**但 v1 不必背这个包袱**。
- **reportlab**：定位是「用 Python 画 PDF」，没有 HTML/CSS 概念，布局、分页、页眉页脚都要手写；中文还需显式 `wordWrap='CJK'`。等于自己实现一个排版器，与「复用前端样式」的目标完全相反。

---

## 落地注意事项

### 1. 打印样式与屏幕样式分离
- 只维护一份 `print.css`，用 `@media print` 定义文档态；屏幕侧用 `@media screen` 隐藏编辑器 chrome。
- 打印视图里任务树**全部展开**（不要依赖用户当时的折叠状态），`details[open]` 或渲染时强制展开。
- 交互态（hover、选中、拖拽占位、输入框边框）在打印时一律清零，否则 PDF 会出现灰色输入框。

### 2. 中文字体（本 issue 的核心）
- **随应用打包字体**，用 `@font-face` + `src: url(...) format('woff2')`，并给出 `local()` 回退；推荐 Noto Sans SC / 思源黑体（OFL 许可，可商用可再分发）。理由：WeasyPrint 与 Chromium 都遵循「字体不在就没字形」的规则（WeasyPrint 文档的 Missing Fonts 一节就是讲这个），不能假设用户机器有中文字体。
- **字体方案要覆盖三件事**：正文（黑体/宋体二选一）、等宽（代码/工时数字）、符号（✓ ✗ → ★ 等）。任务优先级常用符号最容易缺字形，务必进字体子集或用图片/纯 CSS 实现。
- `font-family` 显式回退链，例：`"Noto Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif`。
- 行高给足：中文正文建议 `line-height: 1.7` 左右，`letter-spacing: 0.01em` 左右，避免打印后显得挤。

### 3. 断行与标点
- 中文不要用 `hyphens: auto`（无效），用 `line-break: strict`（避头尾严格）、`word-break: normal`、`overflow-wrap: anywhere` 只用于长 URL/长英文串。
- **不要对中文段落用 `text-align: justify`**：浏览器两端对齐对中文没有标点挤压，会出现字距忽大忽小。左对齐更安全。
- 数字与英文混排：不强制加空格（中文排版习惯），但要保证 `font-variant-numeric: tabular-nums`，避免工时列宽度跳动。

### 4. 分页控制
- 任务树节点、验收标准条目：`break-inside: avoid`（防止一条被切成两半）。
- 章节标题：`break-after: avoid`，避免标题孤零零留在页底。
- 表格：`thead { display: table-header-group; }` 让表头在每页重复；表格行也加 `break-inside: avoid`。
- 全局 `orphans: 3; widows: 3;`。
- A4 固定：`@page { size: A4; }`，前端不要用 `vh` 布局（打印时视口概念不同）。

### 5. 页码与页眉页脚
- 首选 CSS：Chrome 131+ 的 `@page` 页边距盒子（见上文方案 A 示例），`counter(pages)` 可取总页数。
- 若走 Playwright：用 `footerTemplate`/`headerTemplate`，注入 `pageNumber`/`totalPages`；注意模板里必须自带内联样式与 `font-size`，否则默认不显示。
- **已知缺口**：需要「页眉显示当前章节名」时，Chromium 的 `string-set`/`string()` 仍未实现（Chromium issue `376420244`）。v1 的替代做法：页眉固定为「任务计划书」+ 项目名，或按章节拆成多个 PDF（不建议）。

### 6. 颜色与图形
- 打印默认不输出背景色：CSS 加 `-webkit-print-color-adjust: exact`，Playwright 加 `printBackground: true`。
- 优先级色块别用低对比度浅色（打印/灰度会消失），改用「色块 + 文字标签（P0/P1/P2）」双编码。

### 7. Markdown 导出（回答「是不是前端一键生成」）
- **是**。链路：`plan` 对象 → 纯函数 `toMarkdown(plan): string` → `new Blob([md], { type: 'text/markdown;charset=utf-8' })` → `URL.createObjectURL(blob)` → 触发 `<a download="任务计划书.md">` → `URL.revokeObjectURL()`。无后端、无依赖、离线可用。
- 需要注意的三点：
  1. **方言**：用 GFM（GitHub Flavored Markdown），任务树用嵌套列表、优先级用表格（GFM 表格是扩展，需前置表头分隔行）；勾选框用 GFM 任务列表 `- [ ]`。
  2. **转义**：正文里的 `|` 要转义为 `\|`（否则破坏表格），行内换行转 `<br>` 或折叠成空格，代码/工时里的反引号要处理。
  3. **一致性**：Markdown 与 PDF 必须由**同一份 plan 数据**生成（不要在 PDF 里读 DOM 文本、在 Markdown 里读另一条路径），否则两个导出会不一致。
- 建议同时提供「复制到剪贴板」与「下载 .md」两个入口，前者更贴合单人快速粘贴场景。

### 8. 验证清单
- Chrome + Edge 两个版本各导出一次，对比分页位置与表格断行；
- 把系统字体全部禁用（或用 `--ignore-system-fonts` 的思路：只允许随包字体）后导出，确认无方块字；
- 用 3 个典型样例回归：10 条以内小任务、50 条含多层任务树、含长英文与长 URL 的任务；
- 检查页数、页码连续性、表头重复、无空白页（空白页多因 `break-before` 与 margin 叠加）。

---

## 来源列表

**浏览器打印 / CSS Paged Media**
1. Rachel Andrew, *CSS printing: Adding content to page margins*（Chrome 131+ 的 `@page` 页边距盒子与页码计数器，并列明 string-set / target-counter / 脚注等未支持项） — https://developer.chrome.com/blog/print-margins
2. 同文镜像（直连 developer.chrome.com 失败时使用） — https://developer.chrome.google.cn/blog/print-margins

**Headless Chromium**
3. Puppeteer, `Page.pdf()`（print 媒体类型、`emulateMediaType('screen')` 的影响、颜色修正） — https://pptr.dev/api/puppeteer.page.pdf
4. Puppeteer, `PDFOptions`（`displayHeaderFooter`、`headerTemplate`/`footerTemplate` 注入的 `pageNumber`/`totalPages`、`preferCSSPageSize`、`printBackground`、`tagged`、`outline`、`waitForFonts`） — https://pptr.dev/api/puppeteer.pdfoptions
5. Playwright, `page.pdf()` API — https://playwright.dev/docs/api/class-page#page-pdf （本次抓取被截断，能力以 3/4 同源文档为准）

**Typst**
6. Typst Reference, `text`（`font` 列表与 `covers: "latin-in-cjk"`、`cjk-latin-spacing`、`lang`、`fallback`、`costs` 中 widow/orphan 默认值、字体发现与 `--font-path`/`TYPST_FONT_PATHS`） — https://typst.app/docs/reference/text/text/
7. Typst Reference, `page`（`header`/`footer`/`numbering`/`number-align`、默认 A4 与 2.5cm 边距、`counter(page).display(..., both: true)`） — https://typst.app/docs/reference/layout/page/
8. Typst Reference, PDF 导出（默认 PDF 1.7、默认写 Tagged PDF、`--pdf-standard`、`--pages`） — https://typst.app/docs/reference/pdf/
9. Typst Reference, `table`（`table.header`/`table.footer` 跨页重复表头） — https://typst.app/docs/reference/model/table/

**Pandoc / LaTeX**
10. Pandoc, *Installing pandoc*（「By default, Pandoc creates PDFs using LaTeX」、完整 MacTeX 4 GB、建议 BasicTeX/TinyTeX、`--pdf-engine`） — https://pandoc.org/installing.html
11. Yihui Xie, *TinyTeX*（轻量 TeX Live、免管理员权限、`tlmgr` 手动补包、完整 TeX Live 为 several GB） — https://yihui.org/tinytex/

**WeasyPrint**
12. WeasyPrint 70.0, *First Steps*（Python/Pango 等依赖版本、Windows 上 MSYS2 装 Pango 与 `WEASYPRINT_DLL_DIRECTORIES`、推荐用发布版可执行文件、杀软误报警告、Missing Fonts、性能说明） — https://doc.courtbouillon.org/weasyprint/stable/first_steps.html
13. WeasyPrint, *Going further*（定位：无 JavaScript、无交互、无实时渲染；只实现 CSS 盒模型 + 分页媒体；渲染管线） — https://doc.courtbouillon.org/weasyprint/stable/going_further.html
14. WeasyPrint, *Changelog*（v62.0 引入 CSS Grid、v65 flex 修复与 gap、v67 grid 行内分页、v70 onedir Windows 可执行文件与安全更新） — https://doc.courtbouillon.org/weasyprint/stable/changelog.html

**reportlab**
15. reportlab, *User Guide*（第 5 章 Paragraphs：「Set wordWrap to 'CJK' to get Asian language linewrapping」） — https://www.reportlab.com/docs/reportlab-userguide.pdf
    - 注：`https://docs.reportlab.com/reportlab/userguide/ch5_paragraphs/` 返回 404，故引用官方 PDF 指南。

**Markdown 导出**
16. MDN, `URL.createObjectURL()` — https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static
17. GitHub Flavored Markdown Spec（表格与任务列表均为 GFM 扩展） — https://github.github.com/gfm/
