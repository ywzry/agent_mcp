# agent_mcp

为支持 MCP 的宿主增加外部模型协作能力。主 agent 创建 Session，让子模型独立读文件、改代码、运行命令，或使用浏览器、Windows 桌面工具，并通过 MCP 查看状态、续接任务和获取结果。

适用于 Claude Code、Codex、OpenCode，以及其他支持本地 stdio MCP 的宿主。

## 功能

- 统一 Session：自由命名、打标签、选择模型；同会话串行，不同会话按配置并发。
- 多模型配置：OpenAI Chat Completions、OpenAI Responses、Anthropic 协议；思考参数、上下文和输出上限按模型配置。
- 编码工具：读写文件、文本编辑、命令执行，返回 diff、退出码、日志和产物。
- 上下文管理：工具长输出转产物、摘要压缩；原始会话记录与工具结果保留。
- 本地状态：保存历史与产物，重启后检查记录并显式续接；支持运行中补发任务和取消。
- 可选 GUI：Google Chrome DevTools MCP 与开源 Windows-MCP，由插件管理下游连接。
- 自定义 stdio / Streamable HTTP 下游 MCP，以及按需读取的 Skills。

Session 名称和标签只是元数据，不会自动选择工具权限或赋予固定角色。

## 安装

需要 Node.js 22.19+ 和 npm。

```sh
git clone https://github.com/ywzry/agent_mcp.git
cd agent_mcp
npm ci
npm run build
```

将 `config/example.yaml` 复制为本地 `config/local.yaml`，填写真实 API 地址、模型 ID、能力与上下文限制。在启动宿主的进程环境中提供 `MODEL_API_KEY`。

示例地址与模型 ID 是占位值，使用前必须替换。可在 `providers` 和 `models` 中增加多家厂商、多种模型；`defaults.model` 指定默认模型。协议支持 `openai_chat_completions`、`openai_responses`、`anthropic`。

`workspace` 和 `state_dir` 相对配置文件所在目录解析。将 `workspace` 指向已有项目，或创建示例中的 `workspace/` 目录。API key 仅使用 `api_key_env` 引用环境变量，不填写到 YAML、提示词或命令参数中。

思考参数由协议决定：兼容 OpenAI 的模型可配置 `reasoning.effort`，Anthropic 可配置 `reasoning.budget_tokens`；配置须符合实际厂商支持情况。Session 可在模型上限内覆盖思考与输出设置。

## 接入 MCP 宿主

宿主启动入口为：

```sh
node /absolute/path/agent_mcp/dist/index.js --config /absolute/path/agent_mcp/config/local.yaml
```

这是 stdio MCP 进程；运行日志走 stderr，stdout 专用于协议。宿主需要把配置引用的密钥环境变量传入插件进程。

通用 JSON 配置示例（具体外层字段以宿主格式为准）：

```json
{
  "mcpServers": {
    "agent_mcp": {
      "command": "node",
      "args": [
        "/absolute/path/agent_mcp/dist/index.js",
        "--config",
        "/absolute/path/agent_mcp/config/local.yaml"
      ]
    }
  }
}
```

OpenCode 使用 `mcp` 与命令数组：

```json
{
  "mcp": {
    "agent_mcp": {
      "type": "local",
      "command": [
        "node",
        "/absolute/path/agent_mcp/dist/index.js",
        "--config",
        "/absolute/path/agent_mcp/config/local.yaml"
      ],
      "environment": { "MODEL_API_KEY": "{env:MODEL_API_KEY}" },
      "enabled": true,
      "timeout": 30000
    }
  }
}
```

Windows 路径可使用正斜杠。使用配置时，将示例中的绝对路径替换为安装位置。

## 四个外部工具

- `agent_start`：提供 `task`、可选 `model`、`name`、`tags`，立即返回 Session / Run ID。
- `agent_inspect`：无参数查看模型和能力；指定 `session_id` 查看状态、事件和结果。使用 `after_cursor` 增量轮询，`include_history` 查看历史，`artifact_id` 读取产物。
- `agent_send`：指定 `session_id` 补充任务，或更新名称、标签。运行中进入有界队列，空闲时在原会话续接。
- `agent_cancel`：指定 `session_id`、`run_id` 请求取消，再检查最终状态。

例如，给主 agent 的任务可以是：“使用 agent_mcp 的 main 模型修复该项目的失败测试，提交修改摘要、实际测试退出码和 diff；完成后读取工具证据。”

状态为 `completed` 表示执行器结束；仍需结合实际工具结果判断用户目标是否达成。

## 浏览器与 Windows 桌面

浏览器需要已安装 Google Chrome。在本地配置中设置：

```yaml
tools:
  builtin: [read, edit, write, exec]
  bundled: { browser: true, desktop: false }
  mcp_servers: {}
  skill_roots: []
```

Chrome DevTools MCP 随 npm 依赖安装并固定版本。每个 Session 使用独立浏览器进程及临时配置目录；支持页面观察、交互、控制台、网络信息和截图。文件访问限定为配置工作区与上游允许的临时目录。

Windows 桌面需要 Windows 和 [uv](https://docs.astral.sh/uv/getting-started/installation/)。首次执行：

```sh
npm run setup:desktop
```

脚本使用 Python 3.14.7，按带哈希的锁文件安装 Windows-MCP 到项目自己的 `.agent-mcp/backends/windows/.venv`。uv 可通过 PATH、用户目录下的 `.local/bin/uv.exe` 或 `AGENT_MCP_UV` 查找。随后将 `tools.bundled.desktop` 设为 `true`。项目移动后需要重新创建该环境。

桌面预设开放应用启动、快照、截图、鼠标、键盘等工具，并保留上游用户接管机制。UWP 应用的窗口切换、重排可能不可靠；应先观察真实可见 UI，依据最新快照操作。GUI 图像推理需要模型实际支持图片，并正确设置 `capabilities.vision`。

同名内置预设和自定义 `mcp_servers.browser/desktop` 不能同时启用。其他桌面后端可以通过自定义下游 MCP 接入。

## 权限与运行边界

- 文件工具限制在工作区内；`exec` 和桌面输入使用插件进程的操作系统权限。`workspace` 不是 shell 或桌面沙箱。只对可信任务启用相应工具。
- 项目文件、命令输出、UI 文本与截图可能发送给所选模型厂商；任务历史和产物保存在本机配置的状态目录。请保持这些目录私有，并按需清理。
- Skills 正文不授予工具权限。自定义下游只连接可信 MCP 服务；凭据使用显式环境变量映射，不写入普通配置字段。
- 取消不能撤回已经发生的文件修改、点击或外部副作用。任务启动的应用需要明确清理。
- 同一状态目录只允许一个插件进程。多个宿主并用时应分别配置 `state_dir`。
- 桌面锁仅串行化同一插件进程内的单次工具调用，不覆盖整个任务序列，也不跨插件进程；桌面任务应顺序安排。
- 内置桌面后端目前仅面向 Windows。跨系统行为、任意应用兼容性与长时间高并发仍有实际环境差异。

## 上游组件

- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)：Apache-2.0。
- [Google Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)：Apache-2.0，固定 npm 版本 1.9.0。
- [CursorTouch Windows-MCP](https://github.com/CursorTouch/Windows-MCP)：MIT，固定 Python 包版本 0.8.8。

这些组件按原始包安装，各自许可证随依赖包保留。桌面匿名遥测、Chrome DevTools MCP 用量统计及 CrUX 请求在内置预设中关闭。
