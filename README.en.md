# agent_mcp

[简体中文](README.md) | **English**

**Let your main AI call affordable, fast open-source models just like subagents.**

An MCP plugin for Claude Code, Codex, OpenCode, and other MCP-compatible tools.

## Why this exists

DeepSeek V4.1 Flash is cheap enough and capable enough, but using it as a subagent inside Codex or Claude Code is still a hassle.

This project offers an alternative to Luna and Haiku as execution subagents. With this MCP, you can hand development tasks to capable, fast open-source models just like you would to a subagent.

agent_mcp keeps that collaboration in your current conversation. Your main agent delegates work, checks progress, and collects results. You can choose a model for each task and run multiple sessions at once.

## What it can do

- **Code**: read files, edit code, run tests, and return changes and logs.
- **Check interfaces**: open a browser, click through pages, inspect console output, take screenshots, and operate Windows apps.
- **Keep working**: save sessions, add instructions, check progress, or cancel. Model reasoning settings and automatic context compaction are supported.

## Install and connect

You need **Node.js 22.19+, Git, and an API key for a model that supports tool calling**. The plugin uses your configured model API; usage is billed by that provider.

```sh
git clone https://github.com/ywzry/agent_mcp.git
cd agent_mcp
npm ci
npm run build
```

**1. Configure a model.** Copy [config/example.yaml](config/example.yaml) to `config/local.yaml`. Set the API URL, model ID, and `defaults.workspace` to the project you want to work on. Replace the placeholder URL and model ID, and set capabilities and context limits to match your provider. Relative paths are resolved from the config file's directory.

**2. Set your key.** Set `MODEL_API_KEY` in the terminal where you launch your AI tool. Launch it from that terminal and make sure it passes this variable to the MCP process.

```powershell
# Windows PowerShell
$env:MODEL_API_KEY = "YOUR_API_KEY"
```

```sh
# macOS / Linux
export MODEL_API_KEY="YOUR_API_KEY"
```

**3. Add the MCP server.** Add a local **stdio** server in your AI tool's MCP settings:

- Name: `agent_mcp`
- Command: `node`
- Arguments: `["/absolute/path/agent_mcp/dist/index.js", "--config", "/absolute/path/agent_mcp/config/local.yaml"]`

Replace the paths with absolute paths on your computer; forward slashes work on Windows. If your host cannot find Node, use its absolute executable path too. Your host starts the plugin. A successful connection exposes 4 tools.

## Start using it

Once connected, ask your AI:

> Use agent_mcp with the main model to fix this project's failing tests. Return a summary of the changes, test results, and logs.

To use several models, add them under `models` in your config and request them by name. Each session uses one model. While work is running, you can ask to check progress, add an instruction, or cancel the task.

### Need a browser or desktop?

- **Browser**: install Chrome and set `tools.bundled.browser` to `true` in your local config.
- **Windows desktop**: install [uv](https://docs.astral.sh/uv/getting-started/installation/), run `npm run setup:desktop`, then set `tools.bundled.desktop` to `true`.

Restart the MCP connection after changing the config. For screenshot understanding, use an image-capable model and set its `capabilities.vision` to `true`. Then try:

> Use agent_mcp to open my local web app, check whether the login button works, inspect console errors, and take a screenshot.

**Scope:** Live validation has focused on Windows. Window switching and resizing can still fail in some Windows apps. Run desktop tasks one at a time, and give each host a separate `state_dir` when using multiple hosts. Commands and desktop actions use your OS permissions; the workspace is not a security sandbox. Task content may be sent to your chosen model provider. Keep keys in environment variables and keep local configs and session data private.

If you see `STOP_UNCONFIRMED`, that backend is quarantined while independent tools remain available. Confirm its outstanding work has stopped, shut down the plugin, remove the marker named in the error, then restart. Keep `state_dir` configured to preserve quarantine across restarts.

---

Built with [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) (Apache-2.0), [Google Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) (Apache-2.0), and [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) (MIT).
