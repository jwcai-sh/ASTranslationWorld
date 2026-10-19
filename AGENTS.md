# AGENTS.md

## 项目目标

本项目工作区当前名为 `洞见`，工程入口也可称为 `ASTranslationWorld`。它包含两条需要严格区分的本地工作链路：

1. AS译林本地副本与 LLM API key / 聚合适配器接入链路。
2. 藏文 OCR、翻译服务与人工校对工作台链路。

当前最高优先级是尽快跑通“通过 LLM API key 访问的本地 AS译林应用”：

```text
本地 AS译林副本
→ 本地自动登录
→ 用户配置 / BYO LLM API key
→ LLM 聚合适配器或兼容 API
→ AS译林翻译 / AI 生成功能可稳定调用
→ 不影响线上 https://asyilin.cpolar.top/
```

藏文 OCR / 翻译 / 校对工作台的核心链路是：

```text
PDF / 图片上传
→ 文件类型识别与文本层判断
→ 单页渲染与分页浏览
→ BDRC OCR 逐页识别
→ OCR 结果与原文对照
→ 藏译汉逐页翻译
→ 人工校对与导出
```

本项目现阶段目标是先保证本地可用闭环，不追求过度设计。

## 项目边界

本项目包含两个当前需要区分的工作区。

AS译林本地副本与 LLM API key 接入链路：

- `sutra-image-package-20260611-2159-server-runtime-amd64/`
- `as-yilin-model-adapter/`

藏文 OCR / 翻译 / 校对独立工作台：

- `tibetan-proofreading-app/`
- `tibetan-ocr-core/`
- `tibetan-translation-services/`

除非用户明确要求，否则不要把这两条链路混在一起修改。调试 AS译林模型通路时，不要改 OCR 校对工作台；调试 OCR / 翻译工作台时，不要改 AS译林 Docker、Web 镜像或适配器。

本地 AS译林副本只用于验证 LLM API key / 聚合接口，不直接修改线上 `https://asyilin.cpolar.top/`。

禁止修改其他项目，例如：

```text
/Users/Min369/Documents/同步空间/Manju/AIProjects/UnivModel/ocr-review-workbench
```

除非用户明确要求该路径。

## 执行前规则

默认可以直接执行用户明确提出的修改任务，不需要每次等待确认。

但如果用户明确说：

- 只读
- 先给计划
- 不要修改文件
- 等我批准
- 先分析
- 需要确认后再执行

则必须严格停留在只读分析或计划阶段，不得编辑、删除、迁移、生成文件，也不得运行会改变项目状态的命令。

修改代码或项目规则前必须先输出 Preflight Plan。Preflight Plan 至少包含：

1. 本次任务目标。
2. 准备修改的文件。
3. 明确不会修改的文件或目录。
4. 是否涉及以下敏感文件或范围：
   - `tibetan-proofreading-app/app.js`
   - `tibetan-proofreading-app/styles.css`
   - `tibetan-proofreading-app/index.html`
   - `tibetan-ocr-core/bdrc_ocr_server.py`
   - `tibetan-translation-services/nllb_translate_server.py`
   - 本地缓存 / OCR 状态
   - 前端按钮、分页、三栏布局
5. 准备运行的命令。
6. 如果涉及前端，必须给出手动前端冒烟测试步骤。

输出 Preflight Plan 后，除非用户特别说明“需要确认后再执行”或明确要求当前任务先停留在规划阶段，否则无需等待确认，可以直接修改。

即使涉及以下内容，也遵循上述默认直接执行规则，但必须在 Preflight Plan 中明确说明：

1. OCR 结果数据结构。
2. 原文与 OCR 对照逻辑。
3. 翻译接口调用逻辑。
4. 本地缓存与识别状态标签。
5. 启动脚本 / 停止脚本。
6. 前端按钮布局与 DOM 事件。
7. 页面滚动、同步高亮、字体缩放。

## 当前优先级

优先顺序：

1. 本地 AS译林副本可打开、服务可启动、自动登录可用。
2. AS译林通过 LLM API key / BYO key / 聚合适配器成功调用模型。
3. LLM API 调用失败时能明确区分：前端配置、AS译林后端、适配器、外部模型 API、网络 / Docker 互通。
4. 可编辑 PDF、Word、Markdown 等文本型文件优先直接提取文本；只有扫描件或图片型 PDF 才进入 OCR。
5. 藏文 OCR / 翻译 / 校对工作台本地闭环可用。
6. 在稳定基础上再做样式、交互和导出优化。

## 项目结构

根目录主要内容：

- `README.md`: 工作区概览与本地启动入口。
- `AGENTS.md`: 当前项目级 Codex 协作规则。
- `提示词历史.md`: 所有提示词统一归档。
- `任务重点整理/`: 第二类任务重点整理文档集中目录，文件名为 `第*次*本次任务重点整理*.md`。
- `GOAL模板.md`: 项目内可复用目标模板。
- `AS译林.md`: AS译林相关记录。
- `AS译林模型通路适配器开发PRD.md`: 适配器需求说明。
- `AS译林模型通路适配器开发任务执行清单.md`: 适配器任务清单。
- `sutra-image-package-20260611-2159-server-runtime-amd64/`: AS译林本地隔离部署包、Compose 配置与本地自动登录补丁。
- `as-yilin-model-adapter/`: AS译林 BYO key 协议探测与模型通路适配器。
- `tibetan-proofreading-app/`: 浏览器端 OCR / 翻译 / 校对工作台。
- `tibetan-ocr-core/`: BDRC OCR 本地 HTTP wrapper 与 OCR 服务代码。
- `tibetan-translation-services/`: 藏译汉翻译服务与后续翻译后端。

模块边界：

- `tibetan-proofreading-app/` 只负责前端工作台、流程编排、人工校对和导出。
- `tibetan-ocr-core/` 只负责 OCR 服务，不承载前端工作台逻辑。
- `tibetan-translation-services/` 只负责翻译服务，不承载 OCR 或页面渲染逻辑。
- `as-yilin-model-adapter/` 只负责 AS译林协议探测、模型列表、登录兼容、文本生成转发和上游 API 格式适配。
- `sutra-image-package-20260611-2159-server-runtime-amd64/` 只负责本地 AS译林隔离部署，不用于改线上环境。

## 本地运行入口

藏文 OCR / 翻译 / 校对工作台从工作区根目录启动：

```bash
./tibetan-proofreading-app/start_services.sh
```

前端地址：

```text
http://127.0.0.1:8790/tibetan-proofreading-app/
```

停止：

```bash
./tibetan-proofreading-app/stop_services.sh
```

AS译林本地副本在 `sutra-image-package-20260611-2159-server-runtime-amd64/` 内启动：

```bash
DOCKER_HOST=unix:///Users/Min369/.colima/default/docker.sock /opt/homebrew/bin/docker compose \
  -f docker-compose.yml \
  -f compose.override.yml \
  -f compose.local.yml \
  up -d --build
```

AS译林本地地址：

```text
http://127.0.0.1:18088/
```

AS译林本地停止：

```bash
DOCKER_HOST=unix:///Users/Min369/.colima/default/docker.sock /opt/homebrew/bin/docker compose \
  -f docker-compose.yml \
  -f compose.override.yml \
  -f compose.local.yml \
  down
```

适配器本地开发常用命令：

```bash
cd "/Users/Min369/Documents/同步空间/Manju/AIProjects/洞见/as-yilin-model-adapter"
uvicorn probe_server.app:app --host 0.0.0.0 --port 18080 --app-dir .
uvicorn adapter_server.app:app --host 0.0.0.0 --port 18081 --app-dir .
```

适配器健康检查：

```bash
curl -i http://127.0.0.1:18080/health
curl -i http://127.0.0.1:18081/health
```

如果适配器跑在 Docker 里并访问 Mac 宿主机上的模型聚合服务，不要配置 `127.0.0.1`，优先使用 `host.docker.internal` 或 `host.lima.internal`。

## AS译林 LLM API Key 跑通规则

调试 `http://127.0.0.1:18088/` 的 AS译林本地副本时，必须优先围绕 LLM API key 调用链路定位问题。

标准链路：

1. Colima / Docker 运行状态。
2. `sutra-local-postgres` / `sutra-local-redis` / `sutra-local-server` / `sutra-local-web` 容器状态。
3. 前端 `http://127.0.0.1:18088/` 可访问。
4. 本地自动登录账号可用。
5. AS译林内 BYO key / LLM API key 配置已保存。
6. AS译林后端能访问 `host.docker.internal`。
7. `as-yilin-model-adapter` 或用户 LLM 聚合服务健康。
8. 适配器能访问真实模型 API。
9. 模型 API 返回格式被适配器转换为 AS译林可接受格式。
10. AS译林前端能收到并显示模型结果。

Debug 输出必须明确：

1. 当前失败位于上述哪一个链路环节。
2. 已验证正常的上游环节。
3. 尚未验证的下游环节。
4. 准备修改的错误模块。
5. 明确不会修改的其他模块。

修改原则：

1. 如果失败在 Docker / 网络 / 环境变量，只改部署或启动配置，不改业务代码。
2. 如果失败在 LLM API key 或外部模型调用，只改适配器或配置，不改 AS译林前端。
3. 如果失败在 AS译林响应格式，只改协议适配层，不改 OCR / 校对工作台。
4. 不因为一个 LLM 调用错误而同时修改前端、后端、适配器、Docker 和文档。
5. 必须优先保护线上 `https://asyilin.cpolar.top/`，默认只动本地副本。

## 文本型文档直读规则

AS译林或本地工作台处理上传文件时，必须先判断文件是否可直接提取文本。

直接提取链路：

1. Markdown / TXT：直接读取文本。
2. Word / DOCX：优先用 Pandoc 提取文本。
3. 可编辑 PDF：优先用 `pdftotext` 或等价文本层抽取。
4. 抽取文本足够有效时，直接进入分段、校对、翻译或 AI 处理。
5. 抽取为空、乱码或低质量时，才提示或切换到 OCR。

禁止把所有 PDF 默认送入 OCR。扫描 PDF / 图片 PDF 才进入 OCR。

Debug 时必须区分：

1. 文件上传失败。
2. 文件类型识别失败。
3. 文本层抽取失败。
4. OCR fallback 失败。
5. 分段失败。
6. 翻译 / LLM API 调用失败。

只修改确认出错的模块。

## OCR / 翻译规则

MVP 规则：

1. OCR 识别结果优先保留逐页缓存。
2. 文件状态必须区分 `ocr 识别未开始`、`ocr 识别进行中`、`ocr 识别已完成`。
3. OCR 结果与原文高亮关系必须可追踪。
4. OCR 与翻译功能都必须允许人工修改结果。
5. 翻译功能优先依赖本地接口，可替换为兼容 API。
6. 不能因为优化交互而破坏现有 OCR / 翻译主流程。

每次 debug OCR / 翻译问题时，必须先把完整流程拆成链路检查，不允许直接跳到改代码。

标准链路：

1. 文件选择与读取。
2. PDF / 图片 / Markdown 解析。
3. 单页渲染与分页状态。
4. 当前页图片生成。
5. BDRC OCR 接口调用。
6. OCR 响应解析。
7. OCR 文本写入与本地缓存。
8. OCR 与原文对照、高亮、人工校对。
9. 藏译汉接口调用。
10. 翻译响应解析。
11. 译文写入与本地缓存。
12. 人工校对、复制、导出。

Debug 输出必须明确：

1. 本次失败发生在哪一个或哪几个链路环节。
2. 已验证正常的上游环节。
3. 尚未验证的下游环节。
4. 准备修改的错误模块。
5. 明确不会修改的其他模块。

修改原则：

1. 只改确认出错的模块。
2. 不因为一个环节失败而顺手重构其他环节。
3. 不在未验证问题来源时同时修改前端、OCR 后端、翻译后端、缓存结构。
4. 如果必须跨模块修改，必须先说明每个模块在链路中的责任和失败证据。

## 前端与交互规则

`tibetan-proofreading-app/` 是工作台，不是营销页。

前端修改必须保护以下主流程：

1. 上传或从文件加载。
2. PDF / 图片 / Markdown / TXT / DOCX / 可编辑 PDF 的文件路由。
3. 原文区、OCR 区、译文区三栏协同。
4. 分页状态、当前页渲染和逐页缓存。
5. OCR 高危字符标注与原文对应位置提示。
6. 人工编辑、保存状态、复制和导出。

交互原则：

1. 点击失败必须在当前操作区域给出明确错误，不只在顶部显示笼统状态。
2. 上传成功后不能停在“上传成功”，必须让后续编辑、OCR、翻译或导出可继续操作。
3. 前端按钮、分页、三栏布局修改必须做手动冒烟测试。
4. 不为样式优化破坏 OCR / 翻译主链路。
5. 不做无关大规模视觉重构。

前端手动冒烟测试至少包括：

1. 打开 `http://127.0.0.1:8790/tibetan-proofreading-app/`。
2. 上传或加载一个 Markdown / TXT 文本文件，确认不会触发 OCR。
3. 上传或加载一个图片型文件，确认能进入 OCR 流程。
4. 切换页码，确认当前页、OCR 文本、译文和状态不串页。
5. 修改 OCR 或译文内容，确认保存状态有反馈。

## 测试与检查

只改文档时，至少运行：

```bash
git diff --check
git status --short
```

修改前端 JS 时，至少运行：

```bash
node --check tibetan-proofreading-app/app.js
```

修改 OCR 或翻译 Python 服务时，至少运行：

```bash
python3 -m py_compile tibetan-ocr-core/bdrc_ocr_server.py
python3 -m py_compile tibetan-translation-services/nllb_translate_server.py
```

修改适配器 Python 服务时，至少运行：

```bash
cd "/Users/Min369/Documents/同步空间/Manju/AIProjects/洞见/as-yilin-model-adapter"
python3 -m pytest tests
```

如果没有安装 `pytest`，使用项目内已有测试入口：

```bash
python3 tests/run_tests.py
```

修改本地 AS译林 Compose / Docker 配置后，至少检查：

```bash
DOCKER_HOST=unix:///Users/Min369/.colima/default/docker.sock /opt/homebrew/bin/docker compose \
  -f docker-compose.yml \
  -f compose.override.yml \
  -f compose.local.yml \
  ps

curl -I http://127.0.0.1:18088/
```

修改工作台启动脚本后，至少检查：

```bash
./tibetan-proofreading-app/start_services.sh
curl -I http://127.0.0.1:8790/tibetan-proofreading-app/
./tibetan-proofreading-app/stop_services.sh
```

如果服务无法启动，最终说明必须写清楚失败在哪个环节、已验证内容和未验证内容。

## 修改边界

除非任务明确要求，否则禁止修改：

1. 非本项目目录下的业务代码。
2. 用户未要求变更的远程部署配置。
3. 第三方模型本体或外部依赖源码。
4. 无关项目的 `AGENTS.md`。
5. 与当前任务无关的全局配置。
6. 用户未要求替换的正式工作流。
7. 无关样式重构。
8. 无关数据文件或样本文档。
9. package 依赖版本。
10. 其他项目的启动脚本。
11. `.env`、真实 API key、token、password、cookie、日志里的密钥。
12. 大型本地 PDF、DOCX、PPTX、XLSX、图片、视频、Docker 镜像包。

不要恢复、删除或覆盖用户已有未提交改动，除非用户明确要求。

如果需要清理错误生成的资料、缓存、上传文件或构建产物，必须先列出将删除的路径。

## Git 与推送规则

遇到重要更新时，默认使用当前环境明确可选的最弱模型处理后续实现与提交。这里的“最弱”指当前实际可用模型中能力档位最低的模型；如果无法确认可用模型列表或当前环境不能主动切换模型，必须明确说明限制，并继续按当前模型完成可执行部分。不得为了切换模型中断已获授权的任务。

重要更新包括：

1. 修改 OCR / 翻译主链路。
2. 修改本地缓存或状态结构。
3. 修改启动脚本、部署配置、Docker / Compose 配置。
4. 修改 LLM API / 聚合适配器调用方式。
5. 一次变更影响前端 app、后端服务器、数据库或管理后台中的两个及以上模块。
6. 修改 AS译林本地副本的 LLM API key 接入链路。
7. 修改文本型文档直读 / OCR fallback 链路。

重要更新完成后，默认自动推送到 GitHub，但必须遵守安全边界：

1. 推送前必须先执行 `git rev-parse --show-toplevel`，确认真实仓库根目录。
2. 推送前必须执行 `git status`，确认本次准备提交的文件。
3. 只提交本次任务相关文件，不混入无关改动。
4. 如果发现工作区已有用户或其他任务留下的无关改动，必须跳过这些文件；如果无法区分，先询问用户。
5. 提交信息必须说明本次链路环节和修复目标。
6. 推送前必须确认当前远程仓库和分支，避免推送到错误仓库。
7. 如果当前环境不能访问 GitHub，必须明确说明限制，并给出可执行的手动推送命令。

默认不要把以下内容推送到远程仓库，除非用户明确要求并确认风险：

1. `.env`、`config.yaml`、真实密钥或 token。
2. 大型本地资料、PDF、Word、图片、视频、Docker 镜像包。
3. 运行日志、临时缓存、OCR 中间产物。
4. 用户私有文档或未脱敏数据。

## 文档记录要求

开发过程中，项目根目录下维护两个文档体系：`提示词历史.md` 和 `任务重点整理/` 文件夹。

### 1. 提示词历史.md

- 文档命名为 `提示词历史.md`。
- 如果同名文档已存在，则不重复创建，只在原文档中继续追加内容。
- 所有提示词必须统一写入这一个文档，不要为提示词另建分散的 Markdown 文件。
- 任务重点整理文档中不要重复保存完整提示词原文，只记录任务重点、下一步和同步事项。
- 文档中必须保存以下信息：
  - 本次对话时间。
  - 这是第几次对话的提示词。
  - 本次提示词的内容。

### 2. 任务重点整理文档

- 第二类任务重点整理文档必须统一放在 `任务重点整理/` 文件夹中。
- 不要把 `第*次*本次任务重点整理*.md` 散落在项目根目录。
- 如果 `任务重点整理/` 不存在，先创建该文件夹。
- 文档命名规则：

```text
任务重点整理/第X次 + 时间（年月日时分） + 本次任务重点整理（20个字） + 谁的请求（前端app,管理后台,后端,数据库）.md
```

- 该文档中统一整理以下内容：
  - 本次完成的任务重点。
  - 下一步行动。
  - 需要跟前端交流的内容。
  - 需要跟前端 app、管理后台、后端服务器、数据库同步的内容。

### 3. 归档约束

- 不要拆成四个独立的 Markdown 文档。
- 前端 app、管理后台、后端、数据库相关内容，统一整理在第二个文档里。
- 在第二个文档中明确写出前端 app、管理后台、后端服务器、数据库各自的下一步。
- 不记录冗余数据，避免文档持续膨胀。
- 提示词归档只使用 `提示词历史.md`，不要在其它任务文档中复制同一份提示词内容。

## 最终回复要求

每次完成任务后，最终回复必须简要说明：

1. 改了哪些文件。
2. 没有改哪些敏感范围。
3. 运行了哪些检查。
4. 如果没有运行某项必要检查，说明原因。
5. 如涉及服务启动，给出可访问 URL 和健康检查结果。
