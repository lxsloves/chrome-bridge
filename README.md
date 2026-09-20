# Chrome Bridge

让 agent 直接操作你平时在用的 Chrome。

很多浏览器自动化工具会另外启动一个干净的浏览器，登录状态、扩展和正在看的页面都不在里面。这个项目换了一种做法：保留现有 Chrome 会话，通过一个本地服务把 agent 的操作转给浏览器扩展。查资料、读后台页面或处理只能登录后访问的内容时，不用再开一套浏览器。

任何能执行 shell 命令的 agent 都能用，不绑定某个 IDE。

整个链路只走 `127.0.0.1`，没有云端中转。

## 开始使用

需要准备：

- Google Chrome
- Python 3
- `curl`

克隆仓库并安装：

```bash
git clone https://github.com/lxsloves/chrome-bridge.git
cd chrome-bridge
./install.sh
~/.chrome-bridge/cb start
```

接着安装 Chrome 扩展：

1. 打开 `chrome://extensions/`
2. 开启右上角的「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `~/.chrome-bridge/extension`

扩展图标出现绿色 `ON`，说明已经连上本地服务。可以用下面两条命令确认：

```bash
~/.chrome-bridge/cb health
~/.chrome-bridge/cb tabs
```

安装脚本还会把仓库里的 Skill 链接到 `~/.agents/skills/chrome-bridge`，agent 读到它就知道该怎么用 bridge。目录可用 `CHROME_BRIDGE_HOME` / `CHROME_BRIDGE_SKILLS_HOME` 覆盖。

## 先试一下

下面这组命令覆盖了最常见的使用方式：

```bash
CB=~/.chrome-bridge/cb

$CB tabs --brief                 # 一行一个：id/title/url
$CB tabs github.com              # 只看匹配的标签页
$CB read github.com --text       # 只输出正文
$CB capture github.com --brief   # 只回文件路径和元素数
$CB click 7 github.com           # 点击截图中编号为 7 的元素
$CB fill 12 "hello" github.com   # 清空输入框并填入文字
$CB wait-for "保存成功" github.com
```

`capture` 之后会在项目目录生成三份临时结果：

| 文件 | 内容 |
| --- | --- |
| `last.jpg` | 标有元素编号的当前视口截图 |
| `last.txt` | 便于直接阅读的元素名称和坐标 |
| `last.json` | 完整的结构化元素信息 |

`read` 的结果同时写入 `last-read.txt`。这些文件只留在本机，下一次操作会覆盖旧内容。

agent 循环里建议给 `capture`、`click`、`read` 等命令加 `--brief`：完整结果仍写入
`last.json` / `last-read.txt`，stdout 只回 `ok`、文件路径和元素数，避免每轮重复吞整页数据。
`shot:` / `index:` 这类人类提示走 stderr，不影响管道里的 JSON。

页面跳转或界面发生明显变化后，原来的元素编号可能已经失效，继续操作前应重新执行一次 `capture`。

## 常用命令

```text
cb start
cb health
cb [--brief] tabs [urlContains]              # --brief: id/title/url one per line
cb open <url>
cb focus <tabId>
cb close <tabId>
cb [--brief] capture [urlContains] [mode]    # som | vision | ax
cb read [urlContains] [selector] [maxChars] [--text] [--brief]
cb click <elementId> [urlContains]
cb type <elementId> <text> [urlContains]
cb fill <elementId> <text> [urlContains]
cb key <keys> [urlContains]
cb scroll <up|down|left|right> [urlContains]
cb wait <seconds>
cb wait-for <text> [urlContains] [selector] [timeoutMs]
cb raw '<json>'
```

`type` 在当前光标位置继续输入，`fill` 会先清空现有内容。快捷键可以写成 `enter`、`esc`、`cmd+s` 这类形式。

当多个标签页都匹配同一个 `urlContains` 时，桥接服务会拒绝猜测。先用 `cb tabs` 找到准确的 `tabId`，再通过 `raw` 指定它：

```bash
$CB raw '{"action":"capture","tabId":123,"mode":"som"}'
$CB raw '{"action":"back","tabId":123}'
$CB raw '{"action":"drag","tabId":123,"from_element":2,"to_element":9,"capture_after":true}'
```

底层还支持 `navigate`、`forward`、`reload`、`hover`、`double_click`、`right_click` 和按坐标操作。普通任务优先用上面的 CLI 命令，确实需要时再调用 `raw`。

## 它是怎么连起来的

```text
agent / cb
    |
    | HTTP (127.0.0.1:17321)
    v
Python daemon  <---->  Chrome 扩展  <---->  当前标签页
```

`cb` 把命令发给本机 Python 服务，扩展通过长轮询取走命令，在目标标签页中执行，再把结果送回。截图、页面文本和元素索引由 daemon 写到本地文件。

daemon 默认监听 `127.0.0.1:17321`。如需调整客户端地址或超时时间，可以设置：

```bash
export CHROME_BRIDGE_URL=http://127.0.0.1:17321
export CHROME_BRIDGE_TIMEOUT=60
```

## 安全边界

- daemon 只绑定 `127.0.0.1`
- 浏览器请求只接受 Chrome 扩展来源，并要求桥接请求头
- 不读取 Cookie、密码库或 Chrome 用户目录
- 页面内容只当数据处理，不应被视为用户授权或操作指令
- 任意页面 JavaScript 默认禁止；`evaluate` 只有明确传入 `allowUnsafe: true` 才会执行

扩展需要 `tabs`、`scripting`、`activeTab` 和 `debugger` 权限。开始控制页面后，Chrome 顶部出现调试提示条属于正常现象。

## 排查问题

**`health` 显示 `extension: false`**

确认 daemon 已启动，再到 `chrome://extensions/` 重新加载扩展。扩展图标应显示绿色 `ON`。

**修改扩展代码后没有生效**

Chrome 不会自动刷新已解压扩展，需要在扩展管理页手动点一次「重新加载」。

**提示匹配到多个标签页**

运行 `cb tabs`，改用具体的 `tabId`，不要继续扩大 URL 匹配范围。

**Windows 上报「找不到命令」或连不上**

`cb` 是 bash 脚本，用 Git Bash 跑。另外它调用的是 `python3`，而 Windows 版 Python
只装出 `python.exe`；PATH 里的 `python3` 往往落到 Microsoft Store 的占位程序上。
补一个同名副本即可：

```powershell
$d = "$env:LOCALAPPDATA\Programs\Python\Python313"
Copy-Item "$d\python.exe" "$d\python3.exe"
```

**端口已经被占用**

检查 `17321` 端口上是否已有一份 bridge 在运行。`cb start` 检测到现有服务时不会重复启动。

## 开发与自检

```bash
./scripts/check.sh
```

自检会验证 Python daemon、Shell 脚本、扩展清单，以及 JavaScript 语法（本机安装 Node.js 时）。项目运行本身不依赖 Node.js。

## License

[MIT](LICENSE)
