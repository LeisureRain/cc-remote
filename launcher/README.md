# CC Remote 服务端启动器 (Windows)

一个极轻量的 Windows 桌面程序,用来在普通用户的电脑上一键启动 / 停止 CC Remote 服务端,
并实时查看服务端日志 —— 不需要会用命令行。

- **极小体积**:目标 .NET Framework 4.8(Windows 10 1903+/11 系统自带),exe 仅 ~15 KB,
  无需安装任何运行时。
- **主界面**:启动服务 / 停止服务 / 重启服务 / 清空日志 / 打开服务端目录 + 实时日志框 + 运行状态行。
- **职责单一**:只管"服务端进程"的起停。会话级操作(创建 / 停止 / 重启 / 删除会话)请在 Android App 中进行。

## 前置条件(目标机器)

- Windows 10 (1903+) 或 Windows 11(自带 .NET Framework 4.8)。
- 已安装 **Node.js**,且 `node` 在 PATH 中(装了 `claude` CLI 的机器通常已满足)。
- 已安装并登录 **`claude` CLI**(服务端会调用它)。

## 运行方式(分发包)

把启动器和 `server/` 放在同一目录下:

```
CC-Remote-Server/
  CCRemoteLauncher.exe
  CCRemoteLauncher.exe.config
  server/
    src/...
    node_modules/
    package.json
    config.json
```

双击 `CCRemoteLauncher.exe` 即可。程序会自动定位 `server/src/index.js`、读取 `config.json` 的端口、
用系统 `node` 拉起服务端,并把日志实时显示在窗口里。关闭窗口会连同子进程(node + claude)一起结束。

> 启动器按以下顺序查找服务端:① 与 exe 同级的 `server/`;② 逐级向上的 `server/`(开发布局)。

## 从源码构建

需要 .NET SDK(本机用 8.0.x 即可,会离线编译 net48):

```bash
cd launcher
dotnet build -c Release
# 产物:bin/Release/net48/CCRemoteLauncher.exe
```

构建只在编译期用到 `Microsoft.NETFramework.ReferenceAssemblies`(已在 NuGet 缓存),
最终 exe 不含任何额外 DLL。

## 打包分发包

在仓库根目录:

```bash
node tools/package-win.mjs
# 产物:dist/CC-Remote-Server/(可直接压缩分发,整包约 2~3MB)
```

## 版本号

版本由仓库根的 `VERSION` 文件统一管理。改完后运行 `node tools/sync-version.mjs`,
会把版本同步到本启动器的 `.csproj`、`server/package.json` 和 Android 的 `versionName`。
