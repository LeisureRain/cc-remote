# 设计方案:会话改造为常驻 stream-json 进程

> 目标:把"每会话一个交互式 PTY + 每条消息单独 `claude -p --continue`"的双进程模式,
> 换成**每个会话一个常驻 `claude` 流式进程**,从而获得:流式输出、真正的会话连续性、
> 可中断、(进阶)手机端工具授权,并消除 shell 转义问题。

## 0. 背景:现状的问题

| 现状 | 问题 |
|---|---|
| 会话启动时在 PTY 里跑交互式 `claude` | 聊天路径根本不用它(S2 之后),纯浪费一个进程/上下文 |
| 每条消息 `claude -p --continue` 新起进程 | 慢、冷启动、`--continue` 只接"最近一次",同目录会话串台 |
| print 模式默认不弹工具授权 | 手机上无法批准"是否允许编辑文件",核心场景卡死 |
| 整段 stdout 一次性返回 | 手机端只能干等 "Thinking…",长任务体验差 |
| 聊天历史只在内存 | 服务器重启即丢,无法 resume |

## 1. CLI 能力(已实测确认,claude 2.1.170)

启动一个**常驻**进程:
```bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --include-partial-messages \
  --verbose \
  --session-id <uuid> \
  --permission-mode <mode> \
  [--add-dir <dir> ...]
```
- 用户消息通过 **stdin 逐行 NDJSON** 喂入(无任何 shell 转义问题):
  ```json
  {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
  ```
- stdout 是 **NDJSON 事件流**。实测一轮对话的事件序列:

```
system/init        → {session_id, model, tools[], permissionMode, slash_commands[]}
system/status      → {status:"requesting"}            # 进度
stream_event       → message_start
stream_event       → content_block_start {index, content_block:{type:"text"}}
stream_event       → content_block_delta {index, delta:{type:"text_delta", text:"p"}}   # 增量 token
stream_event       → content_block_delta {... text:"ong"}
assistant          → 完整 message 快照 {content:[{type:"text"|"tool_use", ...}]}
stream_event       → content_block_stop / message_delta(stop_reason) / message_stop
result             → {subtype:"success", result:"pong", session_id, total_cost_usd, duration_ms, is_error}
```
- 工具调用:会以 `content_block` 的 `type:"tool_use"`(在 stream_event 和 assistant 快照里)出现,
  工具结果以后续 `type:"user"` 的 `tool_result` 出现。
- **权限**:本版本 `--help` 已无 `--permission-prompt-tool`。可用手段:
  - `--permission-mode`(如 `acceptEdits` / `plan` / `bypassPermissions` / 默认),或
  - `--allowedTools` / `--disallowedTools` 白名单,或
  - (进阶)自建 MCP 权限工具路由到手机 —— **需另行验证,列为后期阶段**。

## 2. 服务端改造(`claude-session.js`)

### 2.1 进程模型
- `_start()`:不再 spawn PTY + 延时敲 `claude`。改为 `child_process.spawn` 上面的常驻命令,
  `cwd = this.directory`,`--session-id = this.id`(让 our id == claude session id,便于 resume)。
- `chat(text)`:不再起新进程,而是把一行 NDJSON 写入 `child.stdin`。
- 用一个 readline 按行解析 `child.stdout`,维护"当前回合"状态机。

### 2.2 事件 → WebSocket 映射
| stream-json 事件 | 处理 |
|---|---|
| `system/init` | 记录 model/tools/真实 session_id;广播 `session_meta` |
| `content_block_delta` (text_delta) | 累积当前回合文本;广播 `session_delta {text}`(增量) |
| `assistant` 含 `tool_use` | 广播 `session_tool {tool, input_summary}`(进度提示) |
| `result` | 落历史 + 广播 `session_result {text, cost_usd, duration_ms, is_error}` |
| `system/status` | (可选)广播 `session_status` 给"正在思考"动效 |

- **断线重连**:保留"当前回合已累积文本",新客户端 `addClient` 时把进行中的部分一起补发
  (现有 chat_history + 一个 `pending_text` 字段)。
- **历史持久化**:`_chatHistory` 写盘(按 session_id),服务器重启后可 `--resume <id>` 复活进程。

### 2.3 中断
- stream-json input 是否支持 `control_request` 中断需实测;若不支持,降级方案 = kill 当前进程并以
  `--resume <id>` 重启(会话上下文不丢)。**列为待验证项**。

## 3. 协议扩展(WebSocket)

新增 S→C:
| type | 字段 | 含义 |
|---|---|---|
| `session_meta` | `session_id, claude_session_id, model, tools` | init 元信息 |
| `session_delta` | `session_id, text` | 增量 token,追加到当前气泡 |
| `session_tool` | `session_id, tool, summary` | 工具调用进度(可选) |
| `session_result` | `session_id, text, cost_usd, duration_ms, is_error` | 回合结束(替代/补充 session_response) |
| `permission_request` | `session_id, request_id, tool, input` | (进阶)请求授权 |

新增 C→S:
| type | 字段 | 含义 |
|---|---|---|
| `interrupt` | `session_id` | 停止当前回合 |
| `permission_response` | `session_id, request_id, decision` | (进阶)allow/deny/always |

`send_chat` 保留,但服务端改为写常驻 stdin。旧的 `session_response`(整段)可保留做兼容,
新客户端优先用 `session_delta`+`session_result`。

## 4. Android 改造

- **ChatMessage**:Claude 气泡支持"流式累积"——`session_delta` 到达时追加文本并 `notifyItemChanged`;
  对 UI 刷新做节流(~60–100ms 合批),避免每个 token 都刷导致卡顿。
- **消息流**:`session_delta` → 把 "Thinking…" 占位替换为正在增长的文本;`session_result` → 定稿
  (渲染 Markdown、停动效、显示耗时/花费,可选)。
- **停止按钮**:回合进行中显示,点了发 `interrupt`。
- **(进阶)授权弹窗**:`permission_request` → Allow / Deny / Always 三键 → 回 `permission_response`。
- **通知**:回合结束后台时通知(已实现);可在通知里放流式预览/直接回复(RemoteInput)。

## 5. 兼容性 / Web 终端

- 现在的 `/terminal` 网页端依赖 PTY 原始输出。本方案下 chat 会话不再有 PTY。处理选项:
  1. Web 终端单列为一种"raw PTY 会话",与"chat 会话"并存(`sessionMode` 区分);
  2. 或直接退役 Web 终端(Android 才是主力客户端)。
- **建议**:加 `config.json` 的 `sessionMode: 'stream' | 'legacy'` 开关,先灰度,可回退。

## 6. 待验证项(动手前先跑实测,别拍脑袋)

1. 工具调用 / `tool_result` 的精确事件形状(用一个会触发 Edit/Bash 的 prompt 抓一段)。
2. stream-json input 的**中断**机制(control message?还是只能 kill+resume)。
3. `--verbose` 是否为 stream-json 必需(实测加了是 OK 的)。
4. 多轮对话下 stdin 持续喂消息是否稳定(进程长期存活、内存)。
5. 权限:能否用 MCP 权限工具把审批路由到手机(决定阶段 3 可行性)。

## 7. 分阶段实施(降低风险)

| 阶段 | 内容 | 价值 / 风险 |
|---|---|---|
| **P1** | 常驻进程 + stdin 喂消息 + 仅用 `result` 出整段 | 干掉双进程、修连续性/转义;风险低 |
| **P2** | 流式 `session_delta` + Android 增量渲染 + 停止按钮 | 体验质变;中风险 |
| **P3** | 工具调用进度 + 手机端权限审批 | "真能干活";高(依赖权限路由验证) |
| **P4** | 历史持久化 + 服务器重启后 `--resume` | 可靠性 |

P1 就已经能替换现有架构并修掉一批历史问题,建议先做 P1 打通链路,再逐阶段加。
