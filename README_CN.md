# CC Remote

通过 Android 设备远程使用 Claude Code。在局域网内浏览目录、启动 Claude Code 会话并与 Claude 对话。

## 架构

```
Android App  ←──WebSocket (JSON)──→  Node.js Server  ←──PTY──→  claude CLI
```

Node.js 服务端运行在你的工作机上，在伪终端中启动 `claude` CLI 进程。Android 应用通过 WebSocket 连接，管理并交互会话。

## 功能

- **会话管理** — 创建、列出、连接、终止 Claude Code 会话
- **Markdown 渲染** — 完整支持 Markdown，包括表格、代码块、链接
- **工作区限制** — 可配置服务端锁定到指定目录，禁止访问外部路径
- **目录浏览** — 从 Android 端浏览服务端文件系统，选择工作目录
- **后台保活** — 前台服务保持 WebSocket 连接，应用切到后台也不断开
- **回复通知** — 应用在后台时，Claude 回复会弹出通知
- **Continue 模式开关** — 可选择是否传递 `--continue` 给 `claude -p`
- **多端同时观看** — 多个 Android 设备可同时查看同一会话
- **Web 终端** — 内置 xterm.js 浏览器终端，访问 `/terminal` 即可

## 快速开始

### 服务端

```bash
cd server
npm install
npm start
```

服务端默认监听 `http://0.0.0.0:11199`。浏览器打开 `http://<服务器IP>:11199` 可访问 Web 终端和健康检查页面。

### Android

用 Android Studio 打开 `android/` 目录，或命令行构建：

```bash
cd android
./gradlew assembleDebug
```

将 APK 安装到设备上。在设置中配置服务器 IP 和端口（默认端口 **11199**）。

## 配置

编辑 `server/config.json`：

```json
{
  "port": 11199,
  "host": "0.0.0.0",
  "maxSessions": 20,
  "workspace": ""
}
```

| 字段 | 说明 |
|---|---|
| `port` | HTTP/WebSocket 监听端口 |
| `host` | 绑定地址（`0.0.0.0` 允许局域网访问） |
| `maxSessions` | 最大同时会话数 |
| `workspace` | 设置后，目录浏览和会话创建将被限制在此路径及其子目录内 |

环境变量（`PORT`、`HOST`、`MAX_SESSIONS`、`WORKSPACE`）可覆盖配置文件。

## WebSocket 协议

所有消息均为 JSON 格式，包含 `type` 字段。完整协议表见 [CLAUDE.md](CLAUDE.md)。

## 环境要求

**服务端：** Node.js 18+，`claude` CLI 已安装并在 PATH 中。

**Android：** API 26+ (Android 8.0)。

## 许可证

MIT
