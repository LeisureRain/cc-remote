# CC Remote

**躺在沙发上写代码。** CC Remote 让你用 Android 手机远程操控工作站上的 Claude Code — 浏览项目目录、启动编程会话、用聊天的方式指挥 Claude 干活。专为 vibe coder 打造：灵感来了掏手机就能写，不用被绑在电脑前。

喝咖啡时突然有个想法？掏出手机，用自然语言描述需求，Claude Code 在你的真实开发机上帮你搞定。你只需要手机和电脑之间有个网络连接。

## 工作原理

```
┌──────────────┐   WebSocket (JSON)   ┌────────────────┐    PTY    ┌──────────┐
│  Android App │ ◄──────────────────► │ Node.js Server │ ◄───────► │  claude  │
│   (随时随地)  │   局域网 / VPN 连接   │   (你的电脑)    │          │   CLI    │
└──────────────┘                     └────────────────┘          └──────────┘
```

1. **Node.js 服务端**运行在你的工作机上，在伪终端中启动 `claude` CLI 进程
2. **Android 应用**通过 WebSocket 连接，列出会话、浏览目录、与 Claude 对话
3. Claude Code 在你的工作机上读写文件，就像你正坐在键盘前一样

聊天界面实时渲染 Claude 的 Markdown 回复 — 包括表格、代码块、链接。你用自然语言描述需求，Claude 执行，你在手机上看到实时结果。

## 通过 ZeroTier 远程访问

服务端默认监听局域网地址。想在咖啡馆、办公室或沙发上随时连接？用 [ZeroTier](https://www.zerotier.com/) 创建虚拟局域网：

1. **在 [my.zerotier.com](https://my.zerotier.com) 创建一个 ZeroTier 网络**
2. **在你的工作机和 Android 手机上安装 ZeroTier**，把两台设备都加入你的网络
3. **启动 CC Remote 服务端** — 默认绑定 `0.0.0.0`，ZeroTier 虚拟网卡也能访问
4. **在 Android 应用中配置**你工作机的 ZeroTier IP（如 `10.147.17.x:11199`）

搞定。无论你用的是移动数据还是 Wi-Fi，手机和电脑都在同一个虚拟局域网里，就像在同一间屋子里。无需端口转发、无需动态 DNS、无需把服务暴露到公网。

> **提示：** ZeroTier 免费支持最多 25 台设备。如果遇到严格的防火墙限制，可以试试 [Tailscale](https://tailscale.com/) — 底层基于 WireGuard，与 CC Remote 配合同样完美。

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

### Web 终端 (xterm.js)

服务端内置了基于 [xterm.js](https://xtermjs.org/) 的全功能浏览器终端。无需安装 Android 应用 — 打开浏览器标签页就能用。

**功能一览：**

| 功能 | 说明 |
|---|---|
| **实时 PTY 流** | 原始终端输出通过 WebSocket 实时推送 — 完整支持 ANSI 颜色、光标移动、交互式 TUI 应用 |
| **会话面板** | 下拉列表展示所有活跃会话，显示目录和状态（运行中 / 已退出） |
| **创建会话** | 输入工作目录，一键创建新的 Claude Code 会话 |
| **目录浏览器** | 弹窗式文件选择器 — 浏览服务端文件系统，可视化选择目录 |
| **连接 / 断开 / 终止** | 工具栏提供完整的会话生命周期控制 |
| **工作区感知** | 响应 `workspace` 配置 — 预填工作区路径，目录浏览限制在工作区内 |
| **连接状态** | 实时状态指示器：绿色已连接 / 红色已断开 |
| **键盘输入** | 按键直接转发到 PTY — 和本地终端一样输入命令 |
| **自适应尺寸** | 终端自动填满浏览器窗口，缩放窗口时自适应调整 |

**访问方式：** 在浏览器中打开 `http://<服务器IP>:11199/terminal?token=<你的token>`。Auth token 在服务端启动时打印在控制台中。

Web 终端适合在笔记本上快速访问、与同事结对编程、或者手机不在身边时作为备选方案。它与 Android 应用共享同一 WebSocket 协议，因此两者可以同时连接到同一个会话。

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

> **⚠️ 后台通知注意事项：** 为了在应用切到后台时仍能收到 Claude 的回复通知：
> 1. **通知权限** — 首次启动时 Android 会询问通知权限，请点击「允许」。如果跳过了，去 **设置 → 应用 → CC Remote → 通知管理** 中开启所有通知通道。不开启的话，回复通知将是**静默**的（无声音/震动）。
> 2. **电池优化** — 去 **设置 → 应用 → CC Remote → 耗电管理 → 无限制**（或关闭电池优化）。国产 ROM（MIUI、ColorOS、EMUI 等）默认会激进地杀掉后台进程，不加白名单的话前台服务会被杀死，从而收不到通知。

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
