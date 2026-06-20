# CC Remote 服务端启动器 (Windows)

一个极轻量的 Windows 桌面程序,用来在普通用户的电脑上一键启动 / 停止 CC Remote 服务端,
并实时查看服务端日志 —— 不需要会用命令行。

- **单文件分发**:整个服务端(源码 + 生产依赖 + 默认配置)被**嵌入到 exe 内**,exe 约 ~160 KB。
  用户只需下载这一个 exe,无需任何其它文件。目标 .NET Framework 4.8 为 Windows 10/11 系统自带,无需安装运行时。
- **主界面**:启动服务 / 停止服务 / 重启服务 / **设置** / 清空日志 / 打开服务端目录 + 实时日志框 + 运行状态行。
- **职责单一**:只管"服务端进程"的起停。会话级操作(创建 / 停止 / 重启 / 删除会话)请在 Android App 中进行。

## 前置条件(目标机器)

- Windows 10 (1903+) 或 Windows 11(自带 .NET Framework 4.8)。
- 已安装 **Node.js**,且 `node` 在 PATH 中(装了 `claude` CLI 的机器通常已满足)。
- 已安装并登录 **`claude` CLI**(服务端真正干活是调用本机的 claude,exe 不能替代它)。

## 运行方式

直接双击 `CCRemoteLauncher.exe` —— 仅此一个文件。首次运行时,程序会把内置的服务端释放到
用户数据目录,然后用系统 `node` 拉起它,并把日志实时显示在窗口里。关闭窗口会连同子进程
(node + claude)一起结束。

- 服务端释放位置:`%LOCALAPPDATA%\CC-Remote\server\`(可写,无需管理员权限)。
- `config.json`(端口等)、`sessions/`、`profiles/` 都在该目录下持久保存;**升级换新版 exe 时只刷新代码,不覆盖你改过的 `config.json`**。
- 想改**端口**或**工作区目录**:点界面上的 **设置** 按钮直接改,保存后会自动重启服务端生效(也可手动编辑该目录下的 `config.json`)。

> 若该 exe 没有内置服务端(纯 `dotnet build` 的开发构建),则回退为查找与 exe 同级 / 上层的 `server/` 目录。

## 从源码构建

需要 .NET SDK(本机用 8.0.x 即可,会离线编译 net48):

```bash
cd launcher
dotnet build -c Release
# 产物:bin/Release/net48/CCRemoteLauncher.exe(不含内置服务端,用于开发调试)
```

构建只在编译期用到 `Microsoft.NETFramework.ReferenceAssemblies`(已在 NuGet 缓存),
最终 exe 不含任何额外 DLL。

## 打包(生成可分发的单 exe)

在仓库根目录:

```bash
node package-win.mjs
# 1) 同步版本号  2) 把服务端打包成 server-bundle.zip 嵌入资源
# 3) 重新编译  ->  dist/CCRemoteLauncher.exe(单文件,约 160 KB,已内置服务端)
```

把 `dist/CCRemoteLauncher.exe` 直接发给用户即可。

## 版本号

版本由仓库根的 `VERSION` 文件统一管理。改完后运行 `node tools/sync-version.mjs`,
会把版本同步到本启动器的 `.csproj`、`server/package.json` 和 Android 的 `versionName`。
