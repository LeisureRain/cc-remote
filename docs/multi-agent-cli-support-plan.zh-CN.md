# 同时支持 Claude Code、Codex CLI、OpenCode CLI 的可行性分析与开发计划

本文档记录 CC Remote 扩展为多 Agent CLI 后端的可行性判断、推荐架构和分阶段实施计划。

## 背景

当前 CC Remote 的核心路径是：

```text
Android App <-> WebSocket <-> Node.js Server <-> claude CLI stdio
```

服务端每个会话对应一个常驻 `claude -p` 进程：

```bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --include-partial-messages \
  --verbose \
  --session-id <id>
```

用户消息通过 stdin 写入 NDJSON，Claude 的 JSON 事件从 stdout 返回，服务端再转换为现有 WebSocket 事件：

- `session_meta`
- `session_delta`
- `session_response`
- `session_tool`
- `session_exited`
- `session_stopped`
- `session_resumed`

当前实现中 Claude 绑定较深，主要集中在：

- `server/src/claude-session.js`
- `server/src/session-manager.js`
- `server/src/index.js`
- Android 侧部分文案、通知和注释

因此扩展到 Codex / OpenCode 的关键不是简单替换命令名，而是抽象出统一的 Agent Session 适配层。

## 总体结论

可以实现。

改动规模判断为中等：服务端改动较大，Android 改动较小。推荐保持 Android 与 Node server 之间的 WebSocket 协议基本不变，在服务端内部增加 Agent CLI Adapter。

推荐目标架构：

```text
Android App
  |
  | WebSocket: create_session / send_chat / interrupt / stop / resume
  v
Node.js Server
  |
  +-- AgentSession interface
        |
        +-- ClaudeSessionAdapter
        +-- CodexSessionAdapter
        +-- OpenCodeSessionAdapter
```

Android 创建会话时新增 `agent` 字段：

```json
{
  "type": "create_session",
  "directory": "D:\\workspace-AI\\cc-remote",
  "agent": "claude"
}
```

可选值：

- `claude`
- `codex`
- `opencode`

如果未传 `agent`，默认保持 `claude`，保证向后兼容。

## Claude Code 可行性

### 当前路径

当前项目采用 `claude -p` 的 stream-json stdio 模式。这是目前最适合 CC Remote 的 Claude Code 接入方式。

优势：

- 本地 stdio，可由 Node 直接控制。
- 支持机器可读 JSON 事件流。
- 支持 `--session-id` 和 `--resume`。
- 支持 `--settings <file>`，当前项目利用这个能力实现私有 profile overlay。
- 不依赖 Claude 官方订阅 Remote Control。
- 可支持第三方代理、API key、CC Switch profile。

### Claude 是否有 server 模式

Claude Code 有 `claude remote-control`，但它不是适合 CC Remote 使用的本地 HTTP/WebSocket API server。

`claude remote-control` 的定位是让 `claude.ai/code` 或 Claude App 通过 Anthropic 官方远程通道连接本机 Claude Code。它依赖 Anthropic 的 Remote Control 机制，而不是开放一个本地 API 给第三方客户端调用。

限制：

- 需要 Claude Pro / Max / Team / Enterprise 订阅。
- 不支持 API key 模式。
- 不支持第三方代理 base URL。
- 连接路径经过 Anthropic 服务。
- 不适合作为 CC Remote 的本地后端适配层。

因此，Claude 侧应继续使用当前 `claude -p` stream-json stdio 模式。

## Codex CLI 可行性

Codex 有两条可行路径。

### 路径 A：`codex exec --json`

适合 MVP。

Codex CLI 支持：

```bash
codex exec --json <prompt>
```

也支持从 stdin 读取 prompt：

```bash
codex exec --json -
```

`--json` 会输出 JSONL 事件流，适合服务端逐行解析并映射到 CC Remote 的 WebSocket 事件。

可映射方向：

- Codex thread / turn started -> `session_meta` 或内部状态
- agent message / final message -> `session_delta` / `session_response`
- command execution / tool call / file change -> `session_tool`
- error / failed turn -> `session_response` with `is_error`

Codex 也有 resume 能力，例如：

```bash
codex exec resume <SESSION_ID> --json <prompt>
```

或通过 `codex resume` 进入交互恢复路径。MVP 可先围绕 `codex exec resume` 做一轮一进程的非交互会话。

优点：

- 接入简单。
- 不需要解析 TUI。
- JSONL 适配当前服务端模型。
- 风险低，适合先验证。

不足：

- 不是天然常驻会话。
- 每轮可能需要启动新进程。
- 工具状态、审批、长期 session 控制粒度不如 app-server。
- 需要仔细保存 Codex 返回的 session/thread id，用于后续 resume。

### 路径 B：`codex app-server`

适合长期完整体验。

Codex CLI 有 experimental `app-server`，面向 rich client，提供 JSON-RPC 2.0 协议。传输方式包括 stdio，部分版本也提供 WebSocket/Unix socket 等模式。

推荐使用方式：

```bash
codex app-server --stdio
```

Node server spawn 该进程，通过 stdio JSONL/JSON-RPC 与它交互。

优点：

- 更接近当前 Claude 的长期会话模型。
- 更适合 conversation history、approval、streamed agent events。
- 避免 TUI/PTY 解析。

不足：

- app-server 仍带 experimental 属性。
- 协议需要单独适配，开发成本高于 `exec --json`。
- 需要跟踪 Codex CLI 版本变化。

### Codex 结论

Codex 路径可通。

推荐先做 `codex exec --json` 作为 MVP，跑通新建会话、发送消息、流式输出、最终响应、停止/删除。后续再做 `codex app-server` 深度适配。

## OpenCode CLI 可行性

OpenCode 有两条可行路径。

### 路径 A：`opencode run --format json`

适合 MVP。

OpenCode CLI 支持非交互运行：

```bash
opencode run --format json "<prompt>"
```

常见能力包括：

- JSON 事件输出。
- 指定工作目录。
- 指定 model。
- 指定 agent。
- 继续会话或指定 session。

优点：

- 接入简单。
- 与 `codex exec --json` 类似。
- 可以快速做成一轮一进程的适配。

不足：

- 常驻会话和细粒度控制不如 server 模式。
- 需要验证目标版本的 JSON event schema。

### 路径 B：`opencode serve`

适合长期完整体验，也可能是 OpenCode 的首选接入方式。

OpenCode 支持 headless server：

```bash
opencode serve
```

其 server 暴露 HTTP API，并提供事件流能力。Node server 可以调用 OpenCode 的 HTTP API 创建 session、发送消息、停止会话、读取 diff/状态，并通过 SSE 或事件接口接收流式事件，再映射为 CC Remote 的 WebSocket 事件。

推荐路径：

```text
Node.js Server
  |
  +-- spawn/connect opencode serve
  |
  +-- HTTP API: create session / send message / abort / delete
  |
  +-- SSE/event stream: stream tool/message/status events
```

优点：

- OpenCode server 模式与 CC Remote 的 Node server 架构匹配度高。
- 不需要解析 TUI。
- 支持会话管理能力更完整。
- 更适合作为长期方案。

不足：

- 需要管理 OpenCode server 子进程生命周期。
- 需要处理端口分配、健康检查、崩溃重启。
- 需要适配 OpenCode 的事件 schema。

### OpenCode 结论

OpenCode 路径可通，而且 server 模式比 Codex 当前可用路径更清晰。

推荐优先考虑 `opencode serve`，如果开发初期需要更快验证，可先做 `opencode run --format json`。

## 关键设计点

### 1. AgentSession 接口

建议定义统一接口：

```js
class AgentSession extends EventEmitter {
  constructor(id, directory, options) {}
  sendMessage(text) {}
  interrupt() {}
  restart() {}
  stop() {}
  resume() {}
  kill() {}
  addClient(ws) {}
  removeClient(ws) {}
  toJSON() {}
  static fromSaved(data) {}
}
```

每个 adapter 负责把自己的 CLI/API event 转成统一事件：

```js
this.emit('delta', { text });
this.emit('response', { text, is_error });
this.emit('tool', { status, name, detail, result });
this.emit('meta', { model, tools });
this.emit('exit', { code });
```

### 2. Session 持久化增加 agent 字段

当前 session 文件需要增加：

```json
{
  "id": "...",
  "agent": "claude",
  "directory": "...",
  "createdAt": "...",
  "chatHistory": [],
  "agentState": {}
}
```

`agentState` 用于保存不同 adapter 的内部状态：

- Claude: `claudeSessionId`
- Codex: `codexSessionId` / thread id
- OpenCode: `openCodeSessionId`

### 3. Profile 需要拆分

当前 profile 是 Claude settings overlay，主要面向：

- `~/.claude/settings.json`
- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`
- `model`

Codex 和 OpenCode 的配置模型不同，不能强行复用 Claude settings。

建议拆为：

```text
Agent selection:
  claude / codex / opencode

Agent profile:
  ClaudeProfile
  CodexProfile
  OpenCodeProfile
```

第一阶段可以先不做完整 profile UI，只支持：

- Claude：保持现有 profile 功能。
- Codex：使用本机 Codex 默认配置，可选传 `model`。
- OpenCode：使用本机 OpenCode 默认配置，可选传 `model` / `agent`。

### 4. WebSocket 协议保持兼容

新增字段：

```json
{
  "type": "session_created",
  "session_id": "...",
  "agent": "codex",
  "directory": "...",
  "createdAt": "..."
}
```

`list_sessions` 返回新增：

```json
{
  "id": "...",
  "agent": "opencode",
  "directory": "...",
  "status": "running"
}
```

### 5. Android 端改动

MVP 改动：

- 新建会话弹窗增加 Agent 选择。
- session 列表显示 Agent 名称或图标。
- 文案从 Claude-specific 改为 Agent-neutral。
- 通知文案从 `Claude replied` 改为 `<Agent> replied`。
- 保持聊天渲染逻辑不变。

不建议第一阶段大改 Android 聊天协议。

## 分阶段计划

### Phase 0：验证 CLI 能力

目标：确认目标机器上实际安装版本的命令和事件 schema。

验证项：

- `claude -p` 当前路径继续可用。
- `codex exec --json` 输出 JSONL，确认 event types。
- `codex exec resume <id> --json` 是否满足多轮会话。
- `codex app-server --stdio` 是否稳定可用。
- `opencode run --format json` 输出 schema。
- `opencode serve` HTTP API 和 event stream 是否稳定。

产出：

- 保存样例 JSONL/SSE event。
- 明确 Codex/OpenCode adapter 的字段映射表。

### Phase 1：服务端抽象，不改变行为

目标：抽出 adapter 结构，但 Claude 行为保持一致。

任务：

- 将 `claude-session.js` 包装为 `adapters/claude-session.js`。
- 新增 `AgentSessionFactory`。
- `SessionManager.createSession(directory, { agent })` 根据 agent 创建对应 adapter。
- session persistence 增加 `agent` 字段。
- `list_sessions` / `session_created` 返回 `agent`。
- 默认 agent 为 `claude`。

验收：

- 现有 Claude 会话创建、聊天、停止、恢复、删除全部保持可用。
- 旧 session 文件没有 `agent` 时按 `claude` 读取。

### Phase 2：Codex MVP

目标：通过 `codex exec --json` 支持 Codex 会话。

任务：

- 新增 `CodexExecSessionAdapter`。
- 检测 `codex --version` 或 `codex exec --help`。
- 首轮运行 `codex exec --json -`。
- 后续轮次优先使用 `codex exec resume <id> --json -`。
- 解析 JSONL event。
- 映射 agent message 到 `session_delta` / `session_response`。
- 映射 command execution / tool events 到 `session_tool`。
- 保存 Codex session id 到 `agentState`。

验收：

- Android 可创建 Codex session。
- 可发送至少 2 轮消息并保持上下文。
- 可看到最终回答。
- 基础工具/命令事件有状态展示。
- 停止/删除不会残留进程。

### Phase 3：OpenCode MVP

目标：优先通过 `opencode serve` 支持 OpenCode 会话。

任务：

- 新增 OpenCode server manager，负责启动/复用 `opencode serve`。
- 健康检查和端口管理。
- 调用 OpenCode HTTP API 创建 session。
- 调用 message/prompt API 发送用户输入。
- 订阅 event stream。
- 将 OpenCode event 映射到统一 WebSocket 事件。
- 保存 OpenCode session id 到 `agentState`。

验收：

- Android 可创建 OpenCode session。
- 可发送多轮消息。
- 可流式看到输出。
- 可中断/停止/删除。
- OpenCode server 崩溃时能给客户端明确错误。

### Phase 4：Android Agent 选择与文案通用化

目标：让用户在 App 中选择 CLI 后端。

任务：

- 新建会话弹窗增加 Agent 选择控件。
- session 列表显示 agent。
- 通知、标题、按钮确认文案通用化。
- 保持旧服务器兼容：如果 server 未返回 agent，则显示 Claude。

验收：

- 用户可选择 Claude / Codex / OpenCode。
- 不同 session 可同时使用不同 agent。
- 现有 Claude 用户体验不退化。

### Phase 5：深度能力

目标：补齐长期体验。

候选任务：

- Codex 从 `exec --json` 升级到 `app-server --stdio`。
- Codex/OpenCode approval flow 对接。
- Codex/OpenCode profile/model 管理。
- 统一工具事件展示。
- 统一成本/耗时/model meta。
- 多 Agent session restore 稳定化。

## 风险与注意事项

### 1. Codex app-server 是 experimental

可以做长期方向，但不建议第一阶段直接依赖它作为唯一实现。

应先以 `codex exec --json` 打通基础路径。

### 2. OpenCode 本机版本兼容

不同 OpenCode 版本的 CLI/API schema 可能变化。需要在 Phase 0 固定最低支持版本，并在服务端启动时输出版本信息。

### 3. Profile 不可直接复用

Claude profile overlay、Codex config.toml、OpenCode provider/model 配置不一致。第一阶段应避免做大一统 profile UI，否则会扩大复杂度。

### 4. 会话恢复语义不同

Claude 的 `--resume <id>` 与 Codex/OpenCode 的 session id 不一定等价。必须在 `agentState` 中保存各自真实 session id，不应假设 CC Remote 的 UUID 能直接作为 CLI session id。

### 5. 工具事件 schema 不一致

三者的工具调用事件不同。UI 上应先展示通用字段：

- status
- name
- detail
- result
- ok/error

不要在 Android 端依赖 Claude-specific 的 tool_use id 语义。

### 6. 进程生命周期

Claude 当前是每 session 一个长期进程。Codex MVP 可能是一轮一个进程。OpenCode server 可能是全局一个长期 server，再有多个内部 session。

因此 session adapter 内部生命周期可以不同，但对外必须保持统一。

## 推荐执行顺序

推荐顺序：

1. 抽象 `AgentSession`，保持 Claude 行为不变。
2. 支持 `agent` 字段和 session persistence。
3. 接入 Codex `exec --json`，快速验证多 Agent 架构。
4. 接入 OpenCode `serve`，验证 server/API 型 adapter。
5. Android 增加 Agent 选择。
6. 再考虑 Codex app-server 和统一 profile 管理。

不推荐顺序：

- 直接改 Android 大 UI。
- 直接做三套 profile 管理。
- 直接解析 Codex/OpenCode TUI。
- 直接把 Claude Remote Control 当作后端 server。

## 参考资料

- Claude Code CLI reference: <https://code.claude.com/docs/en/cli-reference>
- Claude Code Remote Control: <https://code.claude.com/docs/en/remote-control>
- OpenAI Codex CLI: <https://developers.openai.com/codex/cli>
- OpenAI Codex non-interactive mode: <https://developers.openai.com/codex/noninteractive>
- OpenAI Codex app-server: <https://developers.openai.com/codex/app-server>
- OpenCode CLI: <https://opencode.ai/docs/cli>
- OpenCode server: <https://opencode.ai/docs/server>
