# 我 vibe coding 了一个 vibe coding 神器

> 缘起：某天晚上躺在沙发上想写代码，但不想爬起来开电脑。
> 于是我用 Claude Code 写了一个能让我躺着用 Claude Code 的工具。

---

## 先说说"Vibe Coding"

2025 年最火的编程姿势是什么？不是 TDD，不是敏捷，是 **Vibe Coding**。

这个词是 Andrej Karpathy 造的——你不再一行一行地手写代码，而是跟 AI 描述你想要什么，让 AI 替你写，你负责"感受 vibe"、review、迭代。音乐放着，咖啡喝着，思路顺着流。

听起来很爽对吧？

但有一个问题：**Vibe Coding 最舒服的姿势是躺着 / 瘫着 / 歪着，可 Claude Code 要求你坐在电脑前开终端。**

这就很矛盾了——

> 我的身体想躺平，我的代码不想停。

## 我需要的不是又一个 AI IDE

市面上不缺移动端写代码的方案。但我翻了无数轮之后发现，它们都有一个共同的问题：**太重了**。

- 有人推荐 Termux 全套——装 Python、配环境、搞 SSH、硬啃终端小键盘。这叫"极客浪漫"，不叫"vibe"。
- 有人推荐云 IDE——打开浏览器、等加载、切来切去。网络一卡，vibe 就断了。
- 有人直接在手机上跑 AI Agent 框架——一个会话烧掉几万 token 做手机上没必要做的计算。

我想要的其实很简单：

1. 手机当遥控器
2. 真正的代码工作在工作机上跑
3. 跟 Claude 自然语言对话
4. 开箱即用，不折腾

找了一圈，没有。那就自己写吧。

## 什么叫"用 vibe coding 写 vibe coding 神器"？

这个故事有点递归。

> 2025 年 3 月的一个周末，我躺在沙发上，想给项目改个 bug，但实在不想起来。
> 我掏出手机，通过 SSH 连上电脑，在 6 寸屏幕上艰难地敲 `claude -p "fix the bug in user module"`。
> 那一刻我意识到：**这不叫 vibe coding，这叫 self-harm coding。**

于是我打开电脑，打开 Claude Code，跟它说：

> "帮我写一个 WebSocket 服务端，能管理多个 claude 进程，让手机连上来跟我聊天。"

接下来的 48 小时里，我躺在沙发上、靠在床上、坐在咖啡馆——**全程用手机遥控 Claude Code，写一个能让我用手机遥控 Claude Code 的工具。**

是的，这件事本身就是一个 meta 笑话。

但效果惊人。因为 Claude Code 太强了，我只需要用手机发消息说：

- "帮我加一个结束会话的功能"
- "给 WebSocket 加一个 ping/pong 心跳"
- "Android 端做个 Markdown 渲染"
- "这个 tool call 的 UI 有点丑，帮我改一下"

它就哐哐哐把代码改了。我只负责看 vibe 对不对、方向偏没偏、代码质量行不行。

**这就是传说中的"吃自己的狗粮，还觉得挺香"。**

## 成品：CC Remote

折腾了几个周末之后，我得到了一个两件套系统：

```
┌──────────────┐   WebSocket   ┌────────────────┐    stdio    ┌──────────┐
│  Android APP │ ◄───────────► │  Node.js 服务端 │ ◄─────────► │ claude   │
│  (你的手机)   │   局域网/VPN   │  (你的工作站)    │             │ CLI     │
└──────────────┘               └────────────────┘             └──────────┘
```

**服务端（Node.js）** 在你的工作机上跑，负责启动和管理 Claude Code 进程。**手机 App（Android）** 通过 WebSocket 连上去，就是一个全功能的 Claude Code 遥控器。

来看看它长什么样。

---

### 主页：会话列表

![主页界面](../screenshots/home.jpg)

打开 App 第一眼就是你的会话列表。每个会话对应一个项目目录，状态一目了然——Running 表示正在工作，Exited 表示已完成，Stopped 表示已暂停。下拉刷新，随时知道你的 Claude 们在干嘛。

主页上还能看到服务器连接状态，绿色就是一切正常。

---

### 新建会话：选目录

![新建会话](../screenshots/start-session.jpg)

点右下角的 "+" 按钮，手机会弹出目录浏览器。你可以直接浏览工作机上的整个文件系统，找到想干活的项目目录，给它起个名字，Claude 就在那个目录里启动了。

不用担心点错——目录可以展开、可以后退，跟 Windows/Mac 上的文件管理器一样直观。

---

### 聊天界面：跟 Claude 对话

![聊天界面](../screenshots/chat.jpg)

这是核心。你输入一条消息，Claude 就在工作机上干活了。

整个聊天界面是原生 Android 写的——Markdown 渲染、代码块高亮、表格展示，全都整得明明白白。

你还会看到 Claude 调用工具的实时状态：
- ✳ **Thinking…** 表示 Claude 正在思考
- ⚙ **Read · 文件名** 表示它在读哪个文件
- ⚙ **Edit · 文件名** 表示它在改哪个文件
- ⚙ **Bash · 命令前几个字** 表示它在跑什么命令

每个工具调用完成后，会显示结果摘要——绿色表示成功，红色表示出错。整个进度一目了然，不用干等着猜它在干嘛。

---

### 配置界面：填 IP 就完事

![设置界面](../screenshots/server-settings.jpg)

最让用户头疼的是什么？配置。

CC Remote 的配置就这么简单：
- 填你电脑的局域网 IP
- 填端口（默认 11199，不用改）
- 保存

完事。

---

### Profile 切换：想用什么模型都可以

![Profile 界面](../screenshots/profiles.jpg)

Claude Code 支持多种模型——Claude Sonnet、Opus、DeepSeek 等等。CC Remote 直接读取你本地的 Claude 配置，手机上就能切换模型。

如果你的机器上装了 [CC Switch](https://github.com/yenertuz/cc-switch) 管理多 provider，CC Remote 也能自动识别，支持一键切换。

---

### Windows 桌面端：给不用终端的用户

![Windows 桌面端](../screenshots/windows.png)

不是所有人都习惯终端。所以我还给 Windows 用户做了一个迷你的桌面启动器——一个 **160KB 的单文件 exe**，把整个服务端都打包进去了。

下载 → 双击 → 自动启动。就这么简单。

它还能实时显示会话列表和服务器日志，方便不熟悉命令行的用户也能用。

## 技术细节（想抄作业的可以看）

我知道有些读者看到这里已经想自己写了。所以把关键设计思路分享一下：

**为什么选 WebSocket 而不是 HTTP/REST？**
因为 Claude Code 的流式输出太适合 WebSocket 了——每个 token、每次 tool call、每个 thinking 步骤，都可以实时推送到手机。用 REST 就得不停轮询，vibe 就断了。

**为什么不直接在手机上跑 claude？**
claude CLI 的交互体验是为终端设计的——全屏编辑器、快捷键、光标控制。手机上最自然的交互是"点"和"滑"，所以需要一个原生 UI 层把终端的复杂交互翻译成手机友好的形式。

**为什么全程没用 PTY？**
Claude Code 支持 `--input-format stream-json --output-format stream-json`，这意味着可以用纯 JSON 流跟它通信，不需要伪终端（PTY）。这样解析 stdout 就变成了简单的行解析，避免了 PTY 的种种诡异行为。

**为什么 Profile 切换不用环境变量？**
因为我踩过坑。`~/.claude/settings.json` 里的 `env` 块会覆盖真实的环境变量。所以正确的做法是用 `--settings` 参数指定一个私有 overlay 文件——它优先级最高，不影响全局配置。

**如何支持多端同时观看？**
Server 端对每个 session 维护一个广播列表。所有连到这个 session 的客户端都收到同样的消息流。所以你可以手机在口袋里，打开电脑的 Web 终端接着聊——上下文是连续的。

## 几个真实 vibe 时刻

### 凌晨一点，沙发上

我蜷在沙发里，脑子里突然冒出要不要试试把 SQLite 直接集成到服务端。掏出手机 → 打开 CC Remote → 选项目目录 → 敲：

> "帮我把 cc-switch 的配置读取从 JSON 文件改成 SQLite 数据库读取，用 node:sqlite 内置模块实现"

Claude 开始干活。我刷了两分钟朋友圈，回来一看——代码写好了，还加了迁移脚本。

锁屏，睡觉。

### 通勤路上

地铁上 25 分钟。打开 CC Remote → 连上服务器 → 选正在做的 feature 分支 → 

> "给 WebSocket 的心跳机制加一个指数退避重连，最大重试 10 次"

到站的时候，代码写好了，测试也过了。

### 出差时救火

正在客户现场开会，手机震了——家里测试环境挂了。偷偷瞄一眼，好像是 Node.js 版本兼容问题。

打开 CC Remote → "看看最新的 error log 是什么"

Claude 读完日志 → "是 fs.cpSync 在 Node 18 上不支持 recursive 参数，换成 `fs.cp` 的 Promise 版本就好了"

> "改"

搞定。继续开会。

## 这就是我理解的 Vibe Coding

过去一年，我最大的体会是：

**Vibe Coding 不只是"AI 写代码"，更是"在任何你想写代码的地方写代码"。**

传统的编程把你绑在椅子上——显示器、键盘、终端，一个都不能少。但灵感不会因为你没坐在电脑前就不来。恰恰相反，最好的想法往往出现在 shower、散步、躺平的时候。

CC Remote 是我给这个问题交的答卷。它不是什么革命性的技术——WebSocket + JSON 流 + Android UI，都是再普通不过的东西。但它解决了最具体的问题：**让想写代码的人，在任何姿势下都能写。**

而且整个开发过程本身就是一次大型 vibe coding 实验——我用手机遥控 Claude Code，写了一个让我能用手机遥控 Claude Code 的工具。这个"自指"的快乐，大概只有程序员才懂。

---

## 想试试？

项目完全开源，MIT 协议。地址在这里：

👉 **[https://github.com/LeisureRain/cc-remote](https://github.com/LeisureRain/cc-remote)**

电脑上需要：
- Node.js 18+
- 已安装 `claude` CLI（`npm install -g @anthropic-ai/claude-code`）
- 跟手机在同一个局域网，或者通过 ZeroTier/Tailscale 组网

手机上需要：
- Android 8.0+
- 下载 APK → 填入电脑 IP → 开聊

---

*如果你也 vibe coding 出了什么好玩的东西，或者对 CC Remote 有想法，欢迎来 GitHub 提 issue 或者 PR。一起让编程变得更随意一点。*
