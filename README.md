# dsh-update-center

给 **DeepSeek Harness** Web 设置面板加一个「**更新与版本**」页面：显示当前安装的
`@deepseek-ai/dsh` 版本、自动检测仓库上的新版本，并可以一键装到同一个全局目录。

> 一个 DSH Cordis 插件（Host + Client 双半边），纯 JavaScript，无构建步骤、无运行时依赖。

English summary: an "Updates & Version" settings page for the DeepSeek Harness Web GUI.
It reads the running `@deepseek-ai/dsh` version, checks the npm registry for a newer
release on a selectable channel, and installs it into the same global prefix. Plain
ESM, no bundler, no runtime dependencies; the browser half only imports `react`.

---

## 目录

- [界面与功能](#界面与功能)
- [工作原理](#工作原理)
- [HTTP 接口](#http-接口)
- [安装](#安装)
- [配置](#配置)
- [开发与测试](#开发与测试)
- [目录结构](#目录结构)
- [安全边界](#安全边界)
- [已知限制](#已知限制)
- [许可](#许可)

---

## 界面与功能

页面注册在设置面板的 `settings.section` 插槽，导航位置 `order: 12`（「模型」之后、「插件」之前）。

| 卡片 | 内容 |
|---|---|
| **版本信息** | 已安装版本、最新版本（按通道）、更新通道切换（稳定版 / 预览版）、状态行、上次检测时间、「立即检查」、「立即更新」 |
| **自动检测** | 自动检测开关、检测频率（1 / 6 / 12 / 24 小时）、自动安装开关（默认关闭，开启时给出风险提示） |
| **安装** | 将执行的完整命令、安装输出实时回显、安装结果、以及「需要重启才生效」的提示 |

几个刻意的行为：

- **不把「读不懂」当成「已是最新」**：定位不到安装版本、或注册表没返回所选标签时，
  页面显示明确的状态/错误，而不是绿色的「已是最新」。
- **不自动降级**：本机跑预发布版、仓库 `latest` 还是更旧的稳定版时，判定为「无更新」。
- **更新完成但未重启时**，页面同时列出「已安装」和「运行中」两个版本，说明磁盘上已经是新版、进程里仍是旧代码。
- **空闲时零请求**：只有检测或安装进行中才以 1s 轮询状态，其余时间页面完全不访问后端。

## 工作原理

```
┌──────────────────────── 浏览器 ────────────────────────┐
│  client.js → settings.section 页面                     │
│    fetch('/dsh-update-center/state' | '/check' | ...)  │
└───────────────────────────┬────────────────────────────┘
                            │ 同源 HTTP，仅回环
┌───────────────────────────▼────────────────────────────┐
│  index.js  → ctx.webServer.register(prefix)            │
│  lib/center.js   状态机 / 路由 / 自动检测 / 安装子进程   │
│  lib/semver.js   版本解析与 semver 优先级比较            │
│  lib/installation.js  定位安装目录、探测包管理器         │
└────────────────────────────────────────────────────────┘
```

- **Host 半边**（`index.js` + `lib/`）持有三件浏览器拿不到的事实：本机安装的版本、
  注册表发布的版本、以及「把新版装上去」的能力。它注册一条前缀路由
  `/dsh-update-center`，并把状态、检查、偏好、安装四个动作暴露成 JSON。
- **Client 半边**（`client.js`）只从浏览器模块表取 `react`，不 import 任何 Harness
  Client 包——那些包会随版本变化，而这个页面崩溃会让整个 slot entry 变空。
- **偏好落盘**到 `<DSH_HOME>/dsh-update-center.json`（通道、自动检测、自动安装、频率、
  上次检测时间）。运行期数据（安装输出、错误）只留在内存里。

## HTTP 接口

所有路由都在前缀 `/dsh-update-center` 之下，返回 `application/json; charset=utf-8`，
并且**只接受来自本机回环地址的请求**，非回环一律 `403`。

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/dsh-update-center/state` | 读取完整状态快照 |
| `POST` | `/dsh-update-center/check` | 查注册表；可带 `{"channel":"latest"\|"next"}`；等检测完成再返回 |
| `POST` | `/dsh-update-center/settings` | 写偏好，字段 `channel` / `autoCheck` / `autoInstall` / `checkIntervalHours` |
| `POST` | `/dsh-update-center/update` | 启动安装；立即返回，进度靠轮询 `/state` |

状态对象的主要字段：

| 字段 | 含义 |
|---|---|
| `currentVersion` | 磁盘上已安装的版本（安装成功后会刷新） |
| `runningVersion` | 本进程启动时加载的版本 |
| `latestVersion` | 所选通道在注册表上的版本 |
| `updateAvailable` | 是否确实有更新（`false` 也包含「无法判定」） |
| `checking` / `checkedAt` / `checkError` | 检测中 / 上次检测时间 / 检测错误（无错误为 `null`） |
| `updating` / `updateOutput` / `updateResult` | 安装中 / 安装输出 / 安装结果 |
| `installCommand` | 将执行（或已执行）的完整命令 |
| `restartRequired` | 是否已装上磁盘但还没重启 |
| `channels` / `statePath` | 允许的通道列表 / 偏好文件路径 |

## 安装

本仓库是插件源码，不是 npm 包，因此从本地目录装进某个 profile：

1. 克隆到本地任意目录：

   ```powershell
   git clone https://github.com/<你的账号>/dsh-update-center.git
   ```

2. 让 Harness 把该目录作为 bundle 装进目标 profile。在 DSH 里最直接的方式是调用
   插件管理器的 `install_bundle`，`target` 指向克隆下来的绝对路径：

   ```
   plugin_manager(action: "install_bundle", target: "C:\\path\\to\\dsh-update-center")
   ```

   它会完成 pnpm 依赖安装、把包名写进 `dsh.profile.bundles`，并在支持热加载时立即生效。

3. 手动等价做法（不使用插件管理器时）：

   ```powershell
   dsh plugin --profile web add "file:C:\path\to\dsh-update-center"
   # 然后编辑 ~/.dsh/profiles/web/package.json，
   # 把 "@local/dsh-update-center" 追加到 dsh.profile.bundles
   dsh --profile web --dump-config   # 确认它出现在组合树里
   ```

4. 重启 Harness（或让它热加载），打开 **设置 → 更新与版本**。

## 配置

写在 profile 的 `cordis.patch.yml` 覆盖行里，字段全部可选：

```yaml
- id: dsh-update-center
  name: "@local/dsh-update-center"
  config:
    channel: latest            # latest | next，默认 latest
    registry: "https://registry.npmjs.org/"   # 可换成内网镜像
    autoCheck: true            # 后台自动检测，默认 true
    autoInstall: false         # 检测到就自动安装，默认 false
    checkIntervalHours: 6      # 自动检测频率，默认 6
```

界面上能改的只有 `channel` / `autoCheck` / `autoInstall` / `checkIntervalHours`，
它们会落到偏好文件里并覆盖这里的默认值；`registry` 只在配置里生效。

## 开发与测试

无需安装依赖、无需构建：

```powershell
node --test                  # 25 个用例：版本比较 + 路由/状态/拒绝分支
node --check index.js        # 语法检查（client.js / lib/*.js 同理）
```

如果运行环境禁止 Node 测试运行器 fork 子进程（沙箱会报 `spawn EPERM`），
改用单进程模式并显式列出文件：

```powershell
node --test --test-isolation=none test/semver.test.js test/center.test.js
```

测试不访问外网：注册表由本地假 HTTP 服务提供，偏好文件写在临时目录里，
也绝不会真的执行 `npm install`。

改动 `client.js` 后，运行中的 Harness 会通过 bundle 探测自动热加载新的浏览器半边；
改动 Host 半边（`index.js` / `lib/`）通常需要重启 Harness 才会载入新的模块代。

## 目录结构

```
.
├── index.js              Host 半边入口：inject + apply，只做挂载
├── client.js             浏览器半边：单文件，settings.section 页面
├── lib/
│   ├── center.js         状态机、HTTP 路由、自动检测、安装子进程管理
│   ├── semver.js         版本解析与 semver 优先级比较（纯函数）
│   └── installation.js   定位安装目录、探测包管理器、拼装安装命令
├── test/
│   ├── semver.test.js    版本比较的边界用例
│   └── center.test.js    路由 / 状态 / 拒绝分支
├── locale/
│   ├── zh.json           插件卡片的中文显示名与描述
│   └── en.json           英文显示名与描述
├── cordis.patch.yml      bundle 补丁：插入 Host 插件行
├── icon.svg              插件卡片图标
└── package.json          清单：dsh.bundle.patch + dsh.client
```

## 安全边界

这条路由能替换机器上的全局 npm 包，因此：

- **仅回环**：`req.socket.remoteAddress` 不是 `::1` / `127.0.0.0/8` / `::ffff:127.0.0.1`
  就直接 `403`，并且不返回任何状态；空地址也按拒绝处理。
- **不自动安装**：`autoInstall` 默认关闭，开启后界面会常驻一条风险提示。
- **同时只跑一个安装**：检测与安装互相排斥，重复请求返回 `409`。
- **插件卸载即收尾**：路由、定时器、正在运行的安装子进程都由 `ctx.effect` 的清理函数一起释放。
- **更新仍需重启**：安装只换磁盘上的文件，新版本要重启 Harness 才真正生效。

## 已知限制

- 需要 Node ≥ 20（用到全局 `fetch` 与 `AbortSignal.timeout`）。
- 安装用的是「同一个全局前缀 + 探测到的包管理器（npm / pnpm）」。如果这个包当初是用
  其它方式（例如手工拷贝）放进去的，探测会退回 `npm`，可能不符合你的环境；此时请手工
  执行界面上展示的那条命令。
- Windows 上正在运行的进程可能占住原生模块文件，导致全局安装失败；界面会把安装器的
  原始输出原样显示出来，按提示手动执行即可。
- 桌面（Electron）版的更新走 Harness 自带通道，与本插件无关。
- 没有浏览器控制的环境下无法验证视觉呈现；本项目的验证覆盖语法、清单、Host 路由与
  实时 Client 插槽注册。

## 许可

[MIT](LICENSE)
