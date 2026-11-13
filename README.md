# 任务排版器（Task Layout Engine）

粘贴一段复杂的任务描述，调用大模型产出一份结构化的「任务计划书」：目标与背景、任务树、里程碑、验收标准。可编辑、可导出 Markdown 与 PDF。单人使用，本地或可信内网运行，数据保存在本机 JSON 文件里。

## 功能

- **生成计划书**：输入不超过 20,000 字符的任务描述，服务端解析模型输出并做完整性校验，不合格不入库。
- **编辑任务树**：增删节点，改标题、描述、验收标准、优先级、工时、依赖；拖动调整同阶段或跨阶段顺序。
- **单叶任务重写**：只重写某个叶子任务，不重新生成整份计划。
- **导出**：Markdown 与 UI 一致；打印为 A4 PDF（17/15/15 mm 边距、页脚页码、任务条不跨页），叶子超过 12 个可选「一页总览」版式。
- **历史与草稿**：生成记录可切换，编辑后刷新不丢。
- **整库备份**：导出全部 JSON（不含密钥），导入时校验版本并重分配冲突 id。

## 快速开始

### Docker（推荐）

```bash
docker compose up -d --build
```

打开 `http://localhost:18787`。

- `web`：nginx 托管前端静态文件，并把 `/api/` 反向代理给 API。
- `api`：Fastify 服务，只暴露在容器网络内（8787）。
- 数据保存在命名卷 `task-layout-data`，重建容器不丢。
- 改页面端口：编辑 `docker-compose.yml` 里 `web.ports` 的 `"18787:80"`，再执行 `docker compose up -d`。

### 本地开发

```bash
npm install
npm run dev
```

打开 `http://127.0.0.1:5173`（Vite 会把 `/api` 代理到 `127.0.0.1:8787`）。需要 Node.js >= 22。

## 配置模型

首次使用打开页面右上角「设置」，填写 Base URL、模型名与 API key，并点「测试连接」。

- 默认 `https://api.deepseek.com/v1` + `deepseek-flash`；也可填任意兼容 OpenAI Chat Completions 的服务。
- 能力分级（原生 JSON Schema / JSON 模式 + 提示词 / 严格工具调用 / 纯文本 + 客户端校验）由 Base URL 与模型名推导。
- API key 只保存在本机；选择不落盘时仅在当次服务进程内有效。

## 数据位置

`TASK_LAYOUT_DATA_DIR` 优先；否则 Windows 为 `%APPDATA%\task-layout`，其他系统为 `~/.config/task-layout`。

| 文件 | 内容 |
| --- | --- |
| `settings.json` | Base URL、模型、extraBody，以及（可选）API key |
| `plans.json` | 全部任务计划书记录 |

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 并行启动 API(8787) 与 Vite(5173) |
| `npm run build` | 构建前端到 `dist/` |
| `npm start` | 生产方式运行 API（tsx） |
| `npm test` | Vitest |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check` | typecheck + test + build |

环境变量：`PORT`（默认 8787）、`HOST`（默认 127.0.0.1；容器内必须为 `0.0.0.0`）、`TASK_LAYOUT_DATA_DIR`。

## 项目结构

```
src/server/   Fastify 应用、路由、计划库与设置存储、模型调用与生成服务
src/shared/   前后端共用：计划模型与校验、schema、Markdown 渲染、备份导入导出、设置
src/web/      React 界面：计划树、检查器、导出菜单、历史、设置对话框、打印样式
docs/         ADR、v1 验收记录与固定样例、协作约定
deploy/       nginx 配置
```

## 文档

- [说明文档.md](说明文档.md)：完整说明（部署、配置、接口一览、目录结构、已知限制）。
- [GLOSSARY.md](GLOSSARY.md)：领域术语表，改代码或写需求前先看。
- [docs/adr/](docs/adr/)：架构决策记录。
- [docs/acceptance/v1-acceptance.md](docs/acceptance/v1-acceptance.md)：v1 验收结论、性能与 PDF 基线、已知问题。

## 注意

- 没有鉴权与多用户隔离，只适合单人本地或可信内网，不要直接把端口暴露到公网。
- 大输入可能触发 `OUTPUT_TRUNCATED`（422），需缩短内容后重试；单次生成超时 120 s。
- 模型的输出质量不做自动断言，按验收文档人工评分。
