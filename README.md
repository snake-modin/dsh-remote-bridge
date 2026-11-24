# dsh-remote-bridge

把远端服务器上运行的 **DeepSeek Harness（dsh）** 直接嵌进本机 dsh 窗口：在同一个窗口里切换多台服务器的 dsh 界面，**在远端执行、消耗远端 token**，不需要手动转发端口、也不需要额外开浏览器标签。

> 设计目标：像 Codex 的 remote SSH 那样"连上就用"，但保持**远端原生 dsh 界面**（不重新渲染对话、不做风格改写）。

---

## 功能

| 能力 | 说明 |
|---|---|
| 多台远端服务器 | 在界面里「配置」添加：SSH 别名（`~/.ssh/config`）+ 远端端口 + 可选远端目录 |
| 窗口内嵌 | 侧栏底部「远程」按钮 → 悬浮条 + 全窗口远端 dsh 界面（iframe） |
| 免 token | 插件自动完成一次性 token 兑换与 cookie 注入，浏览器端完全不接触 token |
| 自动拉起远端 dsh web | 远端端口没人监听时，自动在远端 tmux 里启动 `dsh web --no-open --port <端口>` 并抓取 URL |
| 断线自愈 | SSH 隧道断开自动重连；「重连」按钮强制健康检查 |
| 多主机常驻 | 每台主机各有一个常驻 iframe，**切换主机不重新加载** |
| 自动隐藏控制条 | 底部悬浮条默认收起成小胶囊，悬停展开：主机切换 / 状态 / 重连 / 配置 / 关闭 |
| Esc 关闭 | 焦点即使落在远端页面里，Esc 也能关闭（通过代理注入的转发脚本） |
| 配置增量生效 | 保存配置时只重连改动过的主机，未改动的主机连接保持不变 |

---

## 工作原理

```
┌──────────────────────── 本机（dsh Host 进程） ────────────────────────┐
│                                                                      │
│  侧栏「远程」按钮 + 悬浮条（client.js）                                │
│        │                                                             │
│        ↓  iframe: http://127.0.0.1:<本地代理端口>/                    │
│  本地反向代理（index.js 里 http server）                              │
│        │  · 注入 Cookie: dsh-auth-…=…（插件启动时兑换的会话 cookie）    │
│        │  · Host: 127.0.0.1:<远端端口>                                │
│        │  · 改写 Origin / Referer（远端请求信任校验要求 Origin==Host）  │
│        │  · 给 text/html 注入 Esc 转发脚本                            │
│        ↓                                                             │
│  SSH 端口转发  127.0.0.1:<tunnelPort>  →  远端 127.0.0.1:<远端端口>    │
└──────────────────────────────────────────────────────────────────────┘
                                    │ ssh (BatchMode, 免密)
                                    ↓
┌──────────────────────── 远端服务器 ──────────────────────────────────┐
│  dsh web --no-open --port 3080（tmux 托管，或由你手动启动的实例）      │
└──────────────────────────────────────────────────────────────────────┘
```

几个关键点（踩过的坑，已固化在实现里）：

1. **远端 dsh 的启动 URL 带一次性 token**：谁先兑换谁拿到会话 cookie，第二次兑换会被拒。所以插件自己兑换一次，把 cookie 保存在 Host 进程里，**代理逐请求注入**，浏览器端永远不碰 token。
2. **会话 cookie 绑定启动时的 authority（`127.0.0.1:3080`）**，且远端有请求信任校验（`Origin` 必须等于 `Host`）。代理转发时统一改写 `Host` / `Origin` / `Referer` 到远端 authority。
3. **本地代理端口与远端端口无关**：代理自己选一个本地空闲端口监听，远端 authority 只出现在注入的 header 里，因此多台远端可以都用 3080，且互不冲突。
4. **远端定位方式**：优先读配置的 `url`；否则从远端 tmux 历史里抓最近打印的 `dsh web: http://…?token=…`；端口没人监听时用 tmux 新起一个实例（`capture-pane -pJ` 合并折行后抓取）。
5. **Esc**：焦点在跨源 iframe 内时按键不会到父页面，所以代理给远端 HTML 注入一小段监听器，用 `postMessage` 把 Esc 转发给外层，外层校验 `event.source` 后关闭。
6. **切换主机不重载**：每台主机一个常驻 iframe，切换只切 `display`；只有「重连」或该主机配置变更才重建对应 iframe。

---

## 环境要求

- 本机：Windows / macOS / Linux，已安装 **OpenSSH 客户端**（`ssh` 在 PATH），DSH 桌面端或 web 端（本插件在 dsh 0.2.0-rc.2 上验证）。
- 远端：Linux / macOS，已安装 **Node.js ≥ 24.9** 与 `dsh` 命令，且安装了 **tmux**（自动拉起需要）。
- 免密 SSH：`ssh <别名> true` 能直接成功（本插件只用 `BatchMode=yes`，不会弹交互式认证）。
- `~/.ssh/config` 中已有可用别名，例如：

```sshconfig
Host XZY
  HostName 10.208.40.45
  User zongyao
  Port 2222
  IdentityFile ~/.ssh/id_ed25519
```

---

## 安装

### 方式 A：脚本（推荐）

```powershell
pwsh -File D:\window_tyh\plugins\dsh-remote-bridge\scripts\install.ps1
```

脚本会：
1. 把插件复制到 `$DSH_HOME/profiles/node_modules/dsh-remote-bridge`；
2. 在 profile 的 `cordis.patch.yml` 末尾追加插件行（改前自动备份 `cordis.patch.yml.bak-<时间戳>`）；
3. 打印后续操作提示。

### 方式 B：手工

1. 复制目录到 `%USERPROFILE%\.dsh\profiles\node_modules\dsh-remote-bridge\`；
2. 在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾追加（内容见 `scripts/cordis.patch.fragment.yml`）：

```yaml
# --- dsh-remote-bridge: 在本地 DSH 窗口内嵌显示远端服务器上的 DSH ---------
- insert:
    - id: remote-bridge
      name: "dsh-remote-bridge"
      config:
        hosts:
          - alias: XZY
            label: "XZY (zongyao)"
            port: 3080
          - alias: "2903"
            label: "2903 (taoyuanhang)"
            port: 3080
```

3. 重启 DSH（或让 profile HMR 重载），然后刷新页面。

> profile HMR 会让**宿主侧**立即生效；**客户端 UI** 需要刷新页面（Ctrl+R）。若刷新后仍看不到侧栏「远程」按钮，完整重启一次 DSH。

### 安装后第一次使用

1. 刷新窗口 → 侧栏底部出现「🖥 远程」；
2. 点开后底部悬浮条会先展开 2.6 秒，然后自动收起成小胶囊；
3. 点「配置」可以增删服务器，保存后自动连接；
4. 远端首次连接需要约 5–20 秒（建隧道 + 抓 token + 远端必要时拉起 dsh web）。

---

## 配置

### 图形界面

悬浮条展开 →「配置」：
- **SSH 别名**：`~/.ssh/config` 里的 Host 名；
- **显示名**：界面标签；
- **远端端口**：那台机器上 `dsh web` 的端口（默认 3080，各服务器独立）；
- **远端目录**（可选）：远端 tmux 托管实例的工作目录，留空为 `$HOME`。

保存后只重连**改动过**的主机。

### 配置文件

保存位置：`$DSH_HOME/remote-bridge-hosts.json`（默认 `%USERPROFILE%\.dsh\remote-bridge-hosts.json`），优先级高于 profile 里的 `hosts`：

```json
{
  "version": 1,
  "hosts": [
    {
      "alias": "XZY",
      "label": "XZY (zongyao)",
      "port": 3080,
      "remoteDir": "/data/zongyao"
    },
    {
      "alias": "2903",
      "label": "2903 (taoyuanhang)",
      "port": 3080,
      "remoteDir": "/home/taoyuanhang"
    }
  ]
}
```

删除该文件即回退到 profile 里配置的默认主机。

### 可选 profile 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `hosts` | `[]` | 默认主机列表（仅在没有 hosts 文件时使用） |
| `hostsFile` | `$DSH_HOME/remote-bridge-hosts.json` | 自定义配置文件路径 |

### 单台主机的完整字段（配置系统读取的字段）

| 字段 | 说明 |
|---|---|
| `alias` | SSH 别名；只允许字母、数字和 `. _ @ : -` |
| `label` | 显示名，缺省等于 alias |
| `port` | 远端 `dsh web` 端口，1–65535，默认 3080 |
| `remoteDir` | 远端托管实例的工作目录，缺省 `$HOME` |
| `mode` | `auto`（默认：能 attach 就 attach，否则托管）/ `attach`（只用已有实例）/ `manage`（总是托管） |
| `url` | 直接指定带 token 的 `dsh web` 启动 URL（attach 模式下可用，跳过抓取） |
| `dshBin` | 远端 dsh 可执行命令，默认 `dsh`（PATH 里没有时会自动探测 nvm / 常见安装位置） |
| `takeover` | `true` 时允许杀掉占用端口的非托管实例并接管 |

---

## 使用

| 操作 | 位置 |
|---|---|
| 打开远程视图 | 侧栏底部「🖥 远程」 |
| 展开控制条 | 鼠标移到窗口底部中间的小胶囊上 |
| 切换服务器 | 展开后的主机 tab |
| 检查 / 重连 / 自动拉起远端 | 「重连」（远端 dsh web 没跑时自动用 tmux 拉起） |
| 增删服务器 | 「配置」 |
| 关闭（保留会话） | 「关闭 (Esc)」；只是隐藏，iframe 保持挂载，再打开无需重新加载 |
| 彻底释放 | 退出 DSH 或从 profile 移除插件（见卸载） |

---

## HTTP 路由（宿主侧，仅回环监听，用于排错/自动化）

| 路由 | 方法 | 作用 |
|---|---|---|
| `/remote-bridge/state[?ensure=1]` | GET | 各主机状态、本地代理 URL；带 `ensure=1` 会触发连接 |
| `/remote-bridge/open?host=<别名>` | GET | 303 跳到该主机的本地代理地址（备用入口） |
| `/remote-bridge/retry` | POST `{host}` | 强制健康检查；远端没跑则自动 tmux 拉起 |
| `/remote-bridge/hosts` | GET / POST | 读取 / 保存主机配置（POST `{hosts:[…]}`） |
| `/remote-bridge/sessions?host=<别名>` | GET | 远端会话列表（备用，供后续会话级集成） |
| `/remote-bridge/session?host=&id=&maxMessages=` | GET | 远端会话消息（备用） |
| `/remote-bridge/prompt` | POST `{host,sessionId,text}` | 向远端会话发消息（备用） |

> 注意：这些是 loopback 上无额外鉴权的普通路由（与本机其它插件路由一致），仅本机可访问。

---

## 排错

| 症状 | 可能原因 / 处理 |
|---|---|
| 侧栏没有「远程」按钮 | 客户端插件未加载：刷新页面；仍无则完整重启 DSH |
| 悬浮条显示「出错：…」 | 看错误文本：常见为 SSH 免密不通、远端没有 `tmux`、端口被非托管实例占用（可设 `takeover: true`） |
| 长时间「正在连接远端…」 | 远端 dsh web 启动慢或 token 兑换超时；可点「重连」，或手动 `ssh <别名> 'tmux ls'` 查看托管会话 |
| 页面白屏 | 用 `/remote-bridge/state` 确认该主机 `phase=ready` 且 `url` 可访问；也可直接浏览器打开该 `url` 验证 |
| `HTTP 403` | 请求信任校验：通常是代理未改写 `Origin`/`Referer`（旧版本问题，1.0 已修复） |
| 401 authentication required | cookie 注入失效：点「重连」重新兑换 token |
| 切换主机后回到旧主机又变慢 | 旧版本问题；1.0 起每台主机 iframe 常驻，切换不重载 |
| DSH 升级后不生效 | `profiles/node_modules` 可能被重建：重跑 `scripts/install.ps1`，重启 DSH |

调试建议：

```powershell
# 主机状态
curl.exe -s http://127.0.0.1:<本机 DSH 端口>/remote-bridge/state
# 强制重连某台
curl.exe -s -X POST -H "Content-Type: application/json" -d '{"host":"XZY"}' http://127.0.0.1:<端口>/remote-bridge/retry
```

---

## 已知限制

- **跨源 iframe**：远端页面与本地 DSH 页面不同源，无法在脚本层共享状态；这正是"原样嵌入、不重新渲染"的代价。
- 同一远端会话不要在「远程视图」和远端自己的浏览器里同时打开（远端会提示 session in use）。
- HTML 注入只作用于 `text/html` 响应；远端页面若重度依赖 Service Worker 缓存可能绕过注入（Esc 转发失效时可改用悬浮条「关闭」）。
- 远端需要 `tmux` 才能自动拉起；已有实例（非 tmux 启动）且抓不到 token 时，需要提供 `url` 或设 `takeover: true`。
- 插件随 DSH 版本升级可能需要重新适配（验证于 dsh 0.2.0-rc.2）；被依赖的内部接口：`ctx.webServer.register`、`sidebar.footer.action` 插槽、`dsh.client` 清单。
- 单机验证过的规模：2 台远端、每台 45–136 个会话的列表读取无压力（iframe 常驻会占用少量内存/网络）。

---

## 安全说明

- 远端 token 只在 Host 进程内进行一次兑换，**不会出现在浏览器端**；代理转发时以 `Cookie` 头注入。
- 本地代理仅绑定 `127.0.0.1`，HTTP 路由无额外鉴权（与本机其他 DSH 路由一致）；能访问本机 loopback 的进程/用户即可使用，请按本机受信环境使用。
- SSH 使用 `BatchMode=yes`，不做交互式认证；不向远端写任何凭据（凭据仍由 `~/.ssh` 持有）。
- 注入的 Esc 转发监听器只发送一个固定 `postMessage`，不携带任何数据；外层会校验消息来源是本插件挂载的 iframe。

---

## 卸载 / 回滚

```powershell
pwsh -File D:\window_tyh\plugins\dsh-remote-bridge\scripts\uninstall.ps1
```

会备份并从 profile patch 中移除本插件的块、删除 `profiles/node_modules/dsh-remote-bridge`。之后重启/刷新 DSH。

如果只是想临时停用：在 `cordis.patch.yml` 里把该 insert 行改成 `disabled: true`。

---

## 文件结构

```
dsh-remote-bridge/
├── package.json                      # 包清单：dsh.client（web 平台、加载时立即注入）
├── index.js                          # 宿主侧：SSH 隧道、本地反向代理、cookie 注入、
│                                     #   远端 tmux 拉起、RPC 路由、配置读写
├── client.js                         # 客户端：侧栏入口、悬浮条、每主机常驻 iframe、配置面板
├── README.md
└── scripts/
    ├── install.ps1                   # 安装（复制包 + 追加 profile patch，幂等、自动备份）
    ├── uninstall.ps1                 # 卸载（备份并移除 patch 块 + 删除包）
    └── cordis.patch.fragment.yml     # patch 片段（手工安装用）
```

### 版本记录（开发过程摘要）

- 1.0.0：多主机、自动隐藏悬浮条、配置面板、增量重连、每主机常驻 iframe、Esc 转发、重连自动拉起远端 dsh web。
- 0.x：逐步修复一次性 token、Origin 403、本地端口冲突、拖拽区吞点击、全屏布局、会话列表等早期问题。

---

## 开发与验证

本插件是在本机 dsh 0.2.0-rc.2 上端到端验证的，验证手段：

- 传输层：`ssh` 直连同一命令，确认 `stat / list / read / write / byte-range` 行为；
- 宿主侧：`/remote-bridge/state|hosts|retry|open` 全路由 curl 验证；
- 代理层：无 cookie 直接请求代理地址应返回 200；带 iframe 同款 `Origin` 调 `/api/*` 应返回 200（非 403）；
- 场景：远端 kill 掉 dsh web 后点「重连」，确认 tmux 实例被自动拉起、代理恢复 200；
- 配置：保存时只改显示名不重连；改某台远端目录时只有该台端口变化。
