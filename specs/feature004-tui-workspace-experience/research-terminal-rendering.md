# Feature 004 Research：终端代码高亮与文件引用呈现

状态：Research 已完成

## 开发者速览

> **一句话**：为终端代码配色与本地文件引用筛选可降级的开源实现候选。<br>
> **核心做法**：对比直接 ANSI、语言覆盖、维护、许可证和体量，并调查 OSC 8 安全边界。<br>
> **边界**：Research 只提供选型证据；Shiki 的产品决定由 Spec 承载，颜色和链接不承载唯一语义。<br>
> **风险 / 未验证**：真实安装增量、冷启动、语料精度和终端点击仍需本地 A/B。<br>
> **当前 / 请审阅**：已完成；开发者已选择 Shiki，Plan 只需确定其接入形态并验证本地预算。

## 1. 调查目的与边界

本 Research 回答三个限界问题：

1. Node.js / TypeScript TUI 如何把 Markdown fenced code block 渲染为带 ANSI 颜色的终端文本；
2. Agent 引用文件时，如何同时获得稳定可识别样式与可选 OSC 8 点击链接；
3. 哪些候选适合当前 Node.js 24、ESM 的 Anthias，哪些取舍仍应留给后续 Spec / Plan。

调查日期为 2026-09-04。版本、发布时间、许可证、Node.js 要求、依赖和包体量来自 npm 官方 Registry 的只读元数据；API 与行为来自项目官方文档、官方 GitHub 仓库、Node.js 文档及终端官方资料。本次没有安装依赖、运行候选代码或连接真实 Provider。

本文使用以下标记区分证据层级：

- **来源事实**：可由所附一手来源直接核对；
- **Anthias 推断**：结合当前产品约束得出的工程判断，不是上游承诺；
- **未验证项**：仅有文档、元数据或 issue 证据，仍需要本地实验确认。

本 Research 本身不替 Spec 决定实现库。Feature 004 已把已知语言代码高亮和文件标识纳入体验合同，开发者随后明确选择 Shiki；候选对照继续保存选型依据，后续 Plan 只确定 Shiki 的具体 package 入口、首批 grammar、加载方式与性能预算，不再进行跨库 A/B。

## 2. 评价维度

代码高亮候选按以下维度比较：

- 能否直接产生 ANSI，还是需要 HTML / token 到 ANSI 的适配层；
- 能否只加载首期需要的语言与主题；
- TypeScript、JavaScript、JSON、Shell、PowerShell、Python、Java、C / C++、C#、Rust、Go、diff 等 Coding Agent 常见输入的覆盖；
- Node.js 24 + ESM 兼容性；
- 当前维护状态、许可证、直接依赖和安装体量；
- 未知语言、无 TTY、低色深和 `NO_COLOR` 下是否能安全退回纯文本。

文件引用方案按以下维度比较：

- 不支持链接或颜色时，用户仍能否一眼认出“这是文件”；
- Windows 路径、空格、中文、`#`、`%` 等字符能否安全形成 `file:` URL；
- 是否能探测 OSC 8 能力，并让 CI、重定向输出和未知终端不包含控制序列；
- 是否会把模型文本中的控制字符误当成终端指令；
- 能否避免承诺跨终端统一的编辑器打开、行列跳转和 UNC 行为。

## 3. 候选元数据快照

以下数据来自同一时间点执行的只读 `npm view` 查询。`unpackedSize` 和 `fileCount` 只代表该包自身 tarball 解包后的大小与文件数，不包含递归依赖，也不等同于冷启动耗时、实际内存或打包产物。

| 包 | 版本 / 最近发布时间 | 许可证 | Node.js / 模块 | 直接依赖 | 自身解包体量 |
| --- | --- | --- | --- | ---: | ---: |
| `cli-highlight` | 2.1.11 / 2021-03-28 | ISC | `>=8`，提供 CJS | 6 | 42,742 B / 16 文件 |
| `highlight.js` | 11.12.0 / 2026-08-12 | BSD-3-Clause | `>=12`，含 ESM 入口 | 0 | 5,503,982 B / 1,569 文件 |
| `shiki` | 4.4.3 / 2026-08-10 | MIT | ESM，Node.js `>=20` | 8 | 602,856 B / 885 文件 |
| `@shikijs/cli` | 4.4.3 / 2026-08-10 | MIT | ESM，Node.js `>=20` | 4 | 7,888 B / 9 文件；另依赖完整 `shiki` |
| `@speed-highlight/core` | 2.1.0 / 2026-08-25 | CC0-1.0 | ESM + CJS exports；未声明 `engines` | 0 | 264,544 B / 305 文件 |
| `terminal-link` | 5.0.0 / 2025-09-08 | MIT | ESM，Node.js `>=20` | 2 | 6,697 B / 5 文件 |
| `supports-hyperlinks` | 4.5.0 / 2026-06-19 | MIT | ESM，Node.js `>=20` | 2 | 8,534 B / 6 文件 |

**来源事实：** npm 页面分别为 [`cli-highlight`](https://www.npmjs.com/package/cli-highlight)、[`highlight.js`](https://www.npmjs.com/package/highlight.js)、[`shiki`](https://www.npmjs.com/package/shiki)、[`@shikijs/cli`](https://www.npmjs.com/package/@shikijs/cli)、[`@speed-highlight/core`](https://www.npmjs.com/package/@speed-highlight/core)、[`terminal-link`](https://www.npmjs.com/package/terminal-link) 和 [`supports-hyperlinks`](https://www.npmjs.com/package/supports-hyperlinks)。

**未验证项：** Registry 体量不能回答实际安装增量。pnpm 的内容寻址复用、现有 lockfile、生产打包方式和依赖去重都会改变最终占用；这应在候选进入 Plan 后以 Anthias 的真实安装产物测量。

## 4. ANSI 代码高亮候选

### 4.1 `cli-highlight`：接口直接，但不宜作为新依赖

**来源事实：** [`cli-highlight` 官方源码](https://github.com/felixfbecker/cli-highlight/blob/main/src/index.ts)把 `highlight.js` 产生的 CSS class 转为 Chalk 样式并直接返回 ANSI 文本，API 对终端调用方很方便。其 [`package.json`](https://github.com/felixfbecker/cli-highlight/blob/main/package.json)声明 6 个直接依赖，并依赖 `highlight.js ^10.7.1`；源码导入完整的 `highlight.js`，而不是 `highlight.js/lib/core`。`languageSubset` 只缩小自动识别候选集，不会让安装包或导入语言真正按需裁剪。

**来源事实：** npm 上最新发布仍是 2.1.11，发布时间为 2021-03-28。当前 [`highlight.js` 安全策略](https://github.com/highlightjs/highlight.js/security)把 11.x 列为受支持版本，10.x 不在受支持范围内。

**Anthias 推断：** 它省掉了 ANSI 适配层，却把 Anthias 带回一个旧的 highlighter 主版本，并增加 Chalk、HTML parser、参数解析等依赖。对新 Feature 来说，这个便利不足以抵消维护与供应链边界，因此不建议选用。

**未验证项：** 本文不把“多年无 npm 发布”等同于项目已正式废弃；仓库可能仍接受维护。结论只针对当前已发布版本及其依赖基线。

### 4.2 `highlight.js/lib/core`：语言可注册，ANSI 适配需自持

**来源事实：** [`highlight.js` 官方文档](https://highlightjs.org/)当前列出 11.12.0、193 种语言和 516 个样式。包无运行时依赖，BSD-3-Clause 许可证见[官方 LICENSE](https://github.com/highlightjs/highlight.js/blob/main/LICENSE)。官方支持从 core 入口逐个注册语言：

```ts
import hljs from 'highlight.js/lib/core'
import typescript from 'highlight.js/lib/languages/typescript'

hljs.registerLanguage('typescript', typescript)
```

这种方式能限制运行时加载或 bundler 产物中的语言；官方还提供[自定义构建下载](https://highlightjs.org/download)。但 npm 包本身仍包含完整语言集合，所以“不加载”不等于未安装那些文件。

**来源事实：** 标准 `highlight()` 返回经过转义、带 `hljs-*` class 的 HTML `<span>`，不是 ANSI。若直接采用，需要一个受控的 HTML / token → ANSI 转换层。官方生态的 [`lowlight`](https://github.com/wooorm/lowlight)把 highlight.js 结果转换为 HAST，并明确列出命令行 ANSI 作为使用场景；但 [`lowlight` npm 元数据](https://www.npmjs.com/package/lowlight)当前版本 3.3.0 依赖 `highlight.js ~11.11.0`，它仍不是开箱即用的 ANSI renderer。

**Anthias 推断：** `highlight.js/lib/core` 是三者中的折中项：语言覆盖广、维护活跃、highlighter 自身零依赖；代价是 Anthias 必须拥有一个窄而安全的 ANSI 适配边界。适配层不能靠正则随意剥离 HTML，也不应依赖未公开的 emitter 内部 API。

**未验证项：** 需要用 Anthias 的真实 Markdown parser 输出验证“转义后的源码仍逐字符保持一致”，并测量注册首期语言后的冷导入成本。是否引入 HAST 中间层，应由实现复杂度而不是抽象偏好决定。

### 4.3 Shiki：语言与主题精度最高，默认路径更重

**来源事实：** Shiki 使用 VS Code / TextMate grammar 与主题。官方 [`@shikijs/cli` 文档](https://shiki.style/packages/cli)提供异步的 `codeToANSI(code, language, theme)`，可以直接得到 ANSI 文本。Shiki 4.4.3 是 ESM-only，要求 Node.js 20 以上，MIT 许可证见[官方 LICENSE](https://github.com/shikijs/shiki/blob/main/LICENSE)，符合 Anthias 的 Node.js 24 / ESM 基线。

**来源事实：** 直接使用 `@shikijs/cli` 会经其依赖拉入完整 `shiki`。官方[细粒度安装指南](https://shiki.style/guide/install)允许从 `shiki/core` 只导入所需语言、主题和 regex engine；官方[正则引擎指南](https://shiki.style/guide/regex-engines)说明 JavaScript engine 在现代 Node.js 中可以避免 Oniguruma WASM，并自 Shiki 3.9.1 起支持所有内置语言。官方 [`@shikijs/langs` exports](https://github.com/shikijs/shiki/blob/main/packages/langs/package.json)可核对 PowerShell、C++、C# 等独立语言入口。

**来源事实：** 当前精细拆包的 npm 自身解包体量约为：`@shikijs/core` 64,493 B、`@shikijs/langs` 8,653,550 B、`@shikijs/themes` 1,479,330 B、`@shikijs/engine-javascript` 10,699 B、`@shikijs/engine-oniguruma` 643,892 B。逐入口导入可降低加载和打包产物，但在未 bundle 的 Node.js 应用里，安装整个 `@shikijs/langs` / `themes` 包仍会落下完整包文件。

**Anthias 推断：** 如果首期明确要求 PowerShell、C#、C++ 等 Windows / 多语言仓库的高保真支持，Shiki 是最稳妥的能力候选。如果主要目标是小依赖与快速启动，则 `@shikijs/cli` 的默认便利路径可能过重；`shiki/core` + 选定语言 / 主题 + JavaScript engine 更可控，但 Anthias 还要把 token 转成 ANSI，工程成本不能藏起来。

**未验证项：** 上游 [Shiki issue #1274](https://github.com/shikijs/shiki/issues/1274)报告 `codeToANSI` 会受底层终端颜色探测与 `NO_COLOR` 影响；issue 不是稳定 API 合同，Anthias 必须在本地验证并显式决定颜色策略。冷启动、首次 grammar 加载、长代码块耗时及主题在 16 / 256 色下的退化效果也尚未测量。

### 4.4 `@speed-highlight/core`：轻量、直接 ANSI，但语言覆盖有明显缺口

**来源事实：** [`@speed-highlight/core` 官方仓库](https://github.com/speed-highlight/core)提供直接的异步 `highlightANSI`：

```ts
import { highlightANSI } from '@speed-highlight/core'
import theme from '@speed-highlight/core/themes/atom-dark.js'

const renderedCode = await highlightANSI(sourceCode, 'ts', theme)
```

当前包无运行时依赖，许可证为 CC0-1.0，并同时给出 ESM / CJS exports。官方 README 声称 core 约 2 KB、单语言通常约 1 KB、全部语言 gzip 后约 14.4 KB；这些是上游给出的打包指标，不等同于 npm 自身 264,544 B 的解包大小，也不是 Anthias 实测。

**来源事实：** 官方导出支持逐语言 loader，也允许用 `tokenizeWith` 接入自定义 grammar。内置列表覆盖 TypeScript / JavaScript / JSON、Bash、C、Java、Python、Rust、Go、SQL、diff、YAML 等，但没有列出 PowerShell、C++ 或 C#。未列出不代表无法扩展，只代表首期若需要这些语言，Anthias 要补 grammar 或退回纯文本。

**Anthias 推断：** 如果 Feature 把首期语言限定为一个小而明确的集合，并接受未知语言原样显示，它是最值得先做轻量 spike 的候选。它的正则 grammar 设计应被看作“足够清楚的终端配色”，不能预设为与 TextMate grammar 同等精度。

**未验证项：** 包没有声明 `engines`，所以“在 Node.js 24 可运行”仍需本地 import 与语料测试确认。还要验证模板字符串、泛型、嵌套注释、超长行以及不完整代码片段；不能直接采用上游自测 benchmark 作为 Anthias 的性能证据。

## 5. 候选对照与阶段性建议

| 候选 | 直接 ANSI | 按语言加载 | 内置语言广度 | 当前主要代价 | 阶段判断 |
| --- | --- | --- | --- | --- | --- |
| `cli-highlight` | 是 | 否；只能限缩自动检测 | 继承旧版 highlight.js | 旧依赖基线、6 个直接依赖 | 不建议新引入 |
| `highlight.js/lib/core` | 否 | 是 | 广 | 自持安全 ANSI 适配；npm 包仍完整 | 可作中间方案 |
| `@shikijs/cli` | 是 | 默认否 | 很广，TextMate 精度 | 完整 Shiki 依赖、异步加载 | 高覆盖候选 |
| `shiki/core` 细粒度 | 需 token → ANSI | 是 | 可按需选，仍很广 | 组合与适配成本 | 体量敏感时再评估 |
| `@speed-highlight/core` | 是 | 是 | 中等；缺 PowerShell / C++ / C# 内置项 | 精度与语言缺口 | 轻量首选 spike |

**Research 阶段推断：** 首期语言明确包含 PowerShell，并重视接近编辑器的 grammar / theme 效果，因此 Shiki 比缺少该内置语言的 `@speed-highlight/core` 更完整。需要验证的取舍位于 Shiki 内部：优先评估能够直接生成 ANSI 的便利入口；若完整依赖的安装或冷启动成本超过 Plan 预算，再评估 `shiki/core` 的细粒度加载与安全 ANSI 适配成本。

**后续产品决定（2026-09-04）：** 开发者确认 Feature 004 直接使用 Shiki。Plan 不再比较 `@speed-highlight/core`、highlight.js 或其他 highlighter，只在 Shiki 范围内确定 package 入口、grammar / theme 导入、缓存和失败降级；如需更换库，必须回到 Spec 重新确认。

这不是 TUI 框架决定。高亮器应位于 fenced code block renderer 的窄接口后面，输入是已由 Markdown parser 确认的 `language` 与原始代码，输出是当前终端能力允许的文本；未知语言、渲染异常或无颜色能力都回退原始代码。

## 6. 文件引用的终端呈现

### 6.1 先有不依赖颜色和点击的语义

**Anthias 推断：** 文件引用的最低可用形态应该是稳定的可见标签，例如：

```text
▸ packages/agent/src/run.ts:118
```

24-bit / 256 色终端可以给路径、行号和前缀不同的弱强调；16 色终端映射到基础色；无色模式保持上面的纯文本。OSC 8 可用时，只让同一可见标签变成可点击链接，不额外显示冗长的 `file:///...`。

这里的 `▸` 只是 Research 示例，不决定最终鱼类图标或视觉系统。语义不能只靠颜色、下划线或某个特殊字形；若字体不支持图标，路径文本仍完整可读。

**Anthias 推断：** 自动识别范围应从可信结构开始：Tool event 中的目标路径，以及 Markdown inline code / link 节点中明确的路径。不要用一个宽泛正则把所有包含点号的模型文本都变成链接，否则版本号、域名、命令参数和代码容易误判。

### 6.2 OSC 8 的能力与限制

**来源事实：** iTerm2 官方文档给出的 hyperlink 序列为：

```text
OSC 8 ; params ; URI ST visible-label OSC 8 ; ; ST
```

其中 OSC 通常是 `ESC ]`，ST 通常是 `ESC \`。详见 [iTerm2 proprietary escape codes](https://iterm2.com/documentation-escape-codes.html)。[Windows Terminal 官方 issue #204](https://github.com/microsoft/terminal/issues/204)记录 OSC 8 支持已在 1.4 版本里程碑完成。

**来源事实：** [`terminal-link`](https://github.com/sindresorhus/terminal-link) 5.0.0 是 Node.js 20+ 的 ESM 包，内部组合 `supports-hyperlinks` 与 `ansi-escapes`。默认在不支持链接时输出 `label URL`；传入 `fallback: false` 时只保留 label。它适合 Anthias 避免把很长的本地 `file:` URI 泄漏到普通 transcript。

**来源事实：** [`supports-hyperlinks`](https://github.com/chalk/supports-hyperlinks) 4.5.0 提供 stdout / stderr 探测，并支持 `--no-hyperlinks`、`--hyperlink=always|never` 与 `FORCE_HYPERLINK`。这种探测基于 TTY、环境变量和已知终端特征，不是与当前终端做能力协商，因此结果仍可能误判。

**来源事实：** VS Code 集成终端还会识别纯文本文件路径和部分 `:line:column` 形式，详见[官方 terminal basics](https://github.com/microsoft/vscode-docs/blob/main/docs/terminal/basics.md)。这与 OSC 8 是两条不同机制：纯文本路径即使没有 OSC 8，也可能由宿主终端自行 linkify。

**未验证项：** 没有跨终端统一的“打开指定编辑器并跳到行列”的 OSC 8 文件 URI 合同。iTerm2 文档描述了自己的文件片段语义，但不能外推到 Windows Terminal、VS Code、SSH 会话或其他终端。行号应继续显示在 label 中，点击后的精确落点只作为宿主能力，不作为 Feature 承诺。

**未验证项：** [Windows Terminal issue #19236](https://github.com/microsoft/terminal/issues/19236)记录 UNC `file://` hyperlink 的限制，且该请求以 not planned 关闭。因此首期不能承诺 `\\server\share`、WSL UNC 或远程 workspace 的点击行为。

### 6.3 路径到 URI 的安全转换

**来源事实：** Node.js 官方 [`pathToFileURL()`](https://nodejs.org/api/url.html#urlpathtofileurlpath-options)把平台路径转换为绝对 `file:` URL，并正确编码 `#`、`%` 等 URL 控制字符。它比字符串拼接 `file://` 更适合 Windows drive letter、空格和 Unicode 路径。

**Anthias 推断：** 建议的处理顺序是：

1. 从结构化事件或 Markdown 节点得到候选路径与可选行号；
2. 按 Workspace Root 解析相对路径，避免把 drive letter 的冒号误当成行号；
3. 对路径做规范化并检查目标是否是允许链接的本地文件；首期可只链接已存在且位于 Workspace Root 内的文件；
4. 使用 `pathToFileURL(absolutePath).href` 生成 URI，不手写 `file://`；
5. 分别清理 label 与 URI 中实际存在的 C0 / ESC 控制字符，再由一个受控函数插入 Anthias 自己的 ANSI / OSC 8；
6. 仅在 stdout 是 TTY 且 hyperlink 探测为真时包裹 OSC 8，否则输出相同的纯文本 label；
7. 每个样式片段和代码块都显式 reset，避免颜色或 underline 泄漏到输入框和底栏。

`pathToFileURL()` 只保证 URI 构造正确，不会替 Anthias 清理可见 label，也不会判断文件是否应被暴露或可点击。模型可能输出真实 ESC 字节；高亮器和 Markdown parser 都不能被当作终端控制序列 sanitizer。

### 6.4 颜色与 hyperlink 应分别降级

**来源事实：** Node.js [`tty.WriteStream.getColorDepth()`](https://nodejs.org/api/tty.html#writestreamgetcolordepthenv)返回 1、4、8 或 24 bit，并明确提示环境探测可能出现 false positive / false negative。Node.js 还考虑 `FORCE_COLOR`、`NO_COLOR` 与 `NODE_DISABLE_COLORS`。[`NO_COLOR`](https://no-color.org/)约定在环境变量存在且非空时关闭颜色，但它本身不禁止粗体、下划线等所有非颜色样式。

**Anthias 推断：** renderer 应把“颜色能力”和“hyperlink 能力”作为两个独立输入。建议最多维护 24-bit、256 色、16 色、plain 四级 palette，且所有信息在 plain 层仍完整。非 TTY 输出应默认同时关闭 ANSI 色彩和 OSC 8，保证重定向日志可搜索、可复制。

## 7. 文件链接实现候选建议

**Anthias 推断：** 首选验证 `terminal-link` 5，而不是直接拼 OSC 8。它与当前 Node.js 24 / ESM 匹配，体量小，并复用成熟的能力探测。Anthias 应传 `fallback: false` 或自定义 fallback，让不支持时保留“可识别文件 label”，而不是追加绝对 `file:` URI。

如果实现最终只需要一个极窄的 OSC 8 encoder，且项目希望减少一层依赖，也可以直接依赖 `supports-hyperlinks` 并由 Anthias 自己编码开始 / 结束序列。不过这意味着转义、关闭序列、fallback 与测试边界全部归 Anthias 持有，不能只比较依赖数量。

无论选哪条路径，用户点击链接才产生外部打开动作；TUI 自身不应在输出阶段自动打开文件。实现依赖应留在 TUI package，不进入 Agent package，也不改变 AgentEvent 的业务所有权。

## 8. 建议进入 Plan 的验证矩阵

以下是后续 spike / 实施的验证输入，不是本 Research 已完成的运行证据。

### 8.1 代码高亮

- 固定语料：TypeScript、JavaScript、JSON、Bash、PowerShell、Python、Java、C++、C#、Rust、Go、diff、Markdown；每种包含正常、截断和非法片段；
- fenced language：规范名称、常见 alias、空语言、未知语言；未知或失败必须原样回退；
- 内容保持：剥离 ANSI 后与原始代码逐字符相同，不能吞掉 `<`、`&`、反引号或换行；
- 终端能力：24-bit、256 色、16 色、`NO_COLOR`、非 TTY；
- 安全：源码中的 ESC / C0 字节不能成为可执行终端控制序列，渲染结束不得 style bleed；
- 成本：真实 Anthias 安装增量、cold import、首块与 warm block 延迟、长代码块峰值内存；
- 视觉：暗色 / 亮色终端上对比度可读，不依赖背景一定是黑色。

### 8.2 文件引用

- 路径：Windows drive、相对路径、空格、中文、`#`、`%`、带 `:line` / `:line:column`；
- 识别：Tool 结构化路径、Markdown inline code、普通自然语言中的相似字符串不应误连；
- 能力：支持 OSC 8、不支持、非 TTY、`--no-hyperlinks`、强制开关；
- 结果：Windows Terminal 和 VS Code 集成终端中进行人工点击验收；不把某一终端结果外推到全部终端；
- 安全：label 和 URI 含控制字符、链接关闭序列、超长路径；
- 明确排除：UNC、SSH / remote workspace、编辑器与精确行列跳转，除非后续单独验证并纳入范围。

## 9. 结论

1. `cli-highlight` 的直接 ANSI API 很省事，但当前发行版停留在 2021 年并绑定 unsupported 的 highlight.js 10.x，不适合 Anthias 新增依赖。
2. `@speed-highlight/core` 是当前最值得验证的轻量候选：直接 ANSI、零运行时依赖、可逐语言加载；其内置 PowerShell / C++ / C# 缺口必须先与首期语言范围对齐。
3. Shiki 是高覆盖、高保真候选，尤其适合 Windows 与多语言代码库；默认 `@shikijs/cli` 较重，细粒度 core 路线则把 token → ANSI 与组合成本交给 Anthias。
4. `highlight.js/lib/core` 位于两者之间，但没有官方直接 ANSI 输出；只有愿意维护安全的转换边界时才值得选择。
5. 文件引用应先保证纯文本可识别，再叠加颜色和 OSC 8。`terminal-link` + `pathToFileURL()` 是适合 Node.js 24 ESM 的首选验证组合；能力探测只是启发式，必须保留 plain fallback。
6. 开发者已结合首期语言覆盖与视觉精度选择 Shiki；冷启动、安装体量和渲染性能仍需在 Plan 与实施中测量，但这些结果只决定 Shiki 的接入形态，不重新开放跨库选型。

## 10. 来源索引

- [`cli-highlight` 官方仓库](https://github.com/felixfbecker/cli-highlight)与 [npm](https://www.npmjs.com/package/cli-highlight)
- [`highlight.js` 官方站点](https://highlightjs.org/)、[官方仓库](https://github.com/highlightjs/highlight.js)、[安全策略](https://github.com/highlightjs/highlight.js/security)与 [npm](https://www.npmjs.com/package/highlight.js)
- [Shiki 安装与细粒度导入](https://shiki.style/guide/install)、[`@shikijs/cli` ANSI 文档](https://shiki.style/packages/cli)、[regex engine 文档](https://shiki.style/guide/regex-engines)与[官方 releases](https://github.com/shikijs/shiki/releases)
- [`@speed-highlight/core` 官方仓库](https://github.com/speed-highlight/core)与 [npm](https://www.npmjs.com/package/@speed-highlight/core)
- [`terminal-link` 官方仓库](https://github.com/sindresorhus/terminal-link)与 [npm](https://www.npmjs.com/package/terminal-link)
- [`supports-hyperlinks` 官方仓库](https://github.com/chalk/supports-hyperlinks)与 [npm](https://www.npmjs.com/package/supports-hyperlinks)
- [Node.js URL API](https://nodejs.org/api/url.html)、[Node.js TTY API](https://nodejs.org/api/tty.html)、[iTerm2 escape codes](https://iterm2.com/documentation-escape-codes.html)、[Windows Terminal OSC 8 记录](https://github.com/microsoft/terminal/issues/204)与 [VS Code terminal basics](https://github.com/microsoft/vscode-docs/blob/main/docs/terminal/basics.md)
