# agent_mcp

**简体中文** | [English](README.en.md)

**让主力 AI 像调子 agent 一样，调用便宜、快速的开源模型。**

这是给 Claude Code、Codex、OpenCode 等工具使用的 MCP 插件。

## 为什么做这个

DeepSeek V4.1 Flash 足够便宜，能力也足够好，但要在 Codex 和 Claude Code 里把它当子 agent 调用，还是很麻烦。

这个项目就是想给笨笨的 Luna、Haiku 执行子 agent 一个替代方案：通过这个 MCP，像调用子 agent 一样，调用优秀、快速的开源模型来完成开发任务。

agent_mcp 把这些协作放回当前对话：主 agent 分配任务、查看进度、拿回结果，你可以给不同任务指定不同模型，同时开多个会话。

## 能做什么

- **写代码**：读文件、改代码、跑测试，返回修改和日志。
- **检查界面**：打开浏览器、点击页面、看控制台、截图，也能操作 Windows 软件。
- **接着干活**：保存会话，随时补充要求、查看进度或取消。支持模型思考设置和上下文自动压缩。

## 安装与接入

准备好 **Node.js 22.19+、Git，以及一个支持工具调用的模型 API 和密钥**。插件的模型调用使用你配置的 API，费用由对应厂商收取。

```sh
git clone https://github.com/ywzry/agent_mcp.git
cd agent_mcp
npm ci
npm run build
```

**1. 配好模型。** 把 [config/example.yaml](config/example.yaml) 复制为 `config/local.yaml`，填好 API 地址、模型 ID，并把 `defaults.workspace` 指向要操作的项目目录。示例中的地址和模型 ID 必须替换，模型能力和上下文大小也按厂商填写；相对路径以配置文件所在目录为准。

**2. 设置密钥。** 在启动 AI 工具的终端里设置 `MODEL_API_KEY`，然后从该终端启动工具，并确保它把这个变量传给 MCP 进程。

```powershell
# Windows PowerShell
$env:MODEL_API_KEY = "YOUR_API_KEY"
```

```sh
# macOS / Linux
export MODEL_API_KEY="YOUR_API_KEY"
```

**3. 添加 MCP。** 在 AI 工具的 MCP 设置里添加一个本地 **stdio** 服务：

- 名称：`agent_mcp`
- 命令：`node`
- 参数：`["/你的安装目录/agent_mcp/dist/index.js", "--config", "/你的安装目录/agent_mcp/config/local.yaml"]`

路径换成你电脑上的绝对路径，Windows 可以使用正斜杠；宿主找不到 Node 时，命令也填 Node 的绝对路径。插件由宿主启动，连接成功后会显示 4 个工具。

## 基础使用

接好后，直接对当前 AI 说：

> 用 agent_mcp 的 main 模型修复这个项目的失败测试。完成后，把改了什么、测试结果和日志给我。

想同时用不同模型，就在配置的 `models` 里添加模型，并在任务中指定其名称。每个会话使用一个模型。任务进行中可以继续说：“看看进度”“补充这个要求”或“取消这个任务”。

### 需要浏览器或电脑操作？

- **浏览器**：安装 Chrome，把本地配置中的 `tools.bundled.browser` 改为 `true`。
- **Windows 桌面**：先安装 [uv](https://docs.astral.sh/uv/getting-started/installation/)，运行 `npm run setup:desktop`，再把 `tools.bundled.desktop` 改为 `true`。

修改配置后重启 MCP 连接。需要模型看截图时，选支持图片的模型，并将其 `capabilities.vision` 设为 `true`。然后可以说：

> 用 agent_mcp 打开我的本地网页，检查登录按钮能否点击，查看控制台报错并截图。

**使用范围：** 当前实机验证以 Windows 为主；部分 Windows 应用的窗口切换、重排仍可能失败。桌面任务请顺序执行；多个宿主同时使用时，各自配置不同的 `state_dir`。命令和桌面操作使用本机权限，工作区不是安全沙箱；任务内容可能发送给所选模型厂商。密钥放环境变量，本地配置和会话数据请保持私有。

若出现 `STOP_UNCONFIRMED`，该后端会被隔离，其它独立工具仍可用。确认后台动作已停后，关闭插件、删除错误提示指向的隔离标记，再启动。保留 `state_dir` 才能让隔离跨重启生效。

---

感谢 [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)（Apache-2.0）、[Google Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)（Apache-2.0）和 [Windows-MCP](https://github.com/CursorTouch/Windows-MCP)（MIT）。
