# Agent Adapter Pack

Charter 的外部 Agent 支持由严格、版本化的 Adapter Manifest 驱动。一个 Adapter 同时描述发现、启动、Session、能力和 lifecycle；核心 discovery/launch 路径不根据 Agent 名称分支，常规 resume argv 也由 Manifest 提供。

当前 Adapter engine 版本为 `1`，内置 Wave 1：

- Claude Code
- Codex
- Kimi Code

## 用户直接得到什么

- Settings → Agent → Agent Adapters 可以看到当前激活来源、Adapter/lifecycle 版本、安装状态和真实可用能力。
- 本机没有安装 CLI 时，不会把 Terminal、ACP、图片、history 等本机能力显示为可用；SSH 能力独立声明，不受本机安装状态影响。
- launch、首次 prompt、startup trust/update gate、exit sequence、resume、history/identity connector 和 lifecycle rule 都属于 Adapter 数据。
- 一个 override 解析失败或 engine 不兼容时，只隔离该文件；相同 id 的 bundled Adapter 继续生效，并在 Settings 显示诊断。
- 未知 Agent 仍可作为普通 Terminal 进程运行，但不会被伪装成具有 lifecycle、resume 或 history 支持的 Agent。
- `agent.result` 对所有被识别的 Agent 都是统一入口：有受信任 `historyConnector` 时返回最后一条原生最终答复（`source=native_history`、`fidelity=native`）；没有连接器、Session id、远端本地历史或解析失败时，返回完全被动的当前屏幕并明确标记 `source=screen`、`fidelity=observed`，不会把屏幕结果冒充精确历史。
- 普通 `terminal.read` 遇到 Agent 会拒绝并引导到 `agent.result`；只有调用者明确要诊断 UI 时才使用 `agent.read(screen|transcript)`。Shell 仍使用 `terminal.read`。

## 合同分层

一个完整 Adapter 包含：

1. `discovery`：候选命令、已知安装路径、版本探测 argv。
2. `terminal`：新 Session argv、首条 prompt 交付方式、Composer/trust/update gate、退出控制序列。
3. `acp`：原生 ACP 命令或应用内 bundled ACP package。
4. `sessions`：Session id 形状、预分配策略、resume/continue argv、identity/history connector 和数据目录。
5. `surfaces`：Skills、instructions 和 SSH availability。
6. `capabilities`：逐项显式声明；Charter 不再根据“发现了 ACP”推断所有能力。
7. `lifecycle`：process alias、规则版本、来源 revision、integration authority 和 OSC/screen rules。

所有对象使用 strict schema；未知字段会让该 Adapter 失效，避免拼写错误被静默接受。capability 声明还会和实现层交叉校验，例如声明 `exactResume: true` 必须提供 `resumeArgs`，声明 `history: true` 必须提供 history connector。

## 本地开发 override

开发构建会读取：

```text
~/.charter/agents/*.json
```

也可用 `PI_IDE_AGENT_MANIFESTS=/absolute/path` 指定目录。正式 packaged 构建默认禁用本地 override；只有显式设置 `PI_IDE_AGENT_ADAPTER_OVERRIDES=1` 才启用。这是开发入口，不是远端 Pack 安装入口。

Override 必须是完整 Adapter，而不是局部 patch。加载顺序按文件名排序；同一目录出现两个相同 id 时，第一份生效，后续文件被隔离并产生 `duplicate-override` 诊断。

可见诊断码：

- `invalid-json`
- `invalid-manifest`
- `incompatible-engine`
- `duplicate-override`
- `override-disabled`

## 远端 Pack 的安全边界

当前版本不会联网下载 Adapter。未来独立 Pack 必须满足：

- 发布者签名和固定来源；
- 绑定 engine version；
- 拒绝版本降级和同版本内容变化；
- 下载后先验证，再原子切换；
- 验证失败回退到上一份有效 Pack 或 bundled Adapter；
- 可一键禁用问题 Pack。

Adapter 是声明式数据，不允许携带任意 JavaScript、renderer UI 或主机代码。需要解析 provider 私有存储格式的 identity/history connector 必须由受信任的 Charter host 实现，Manifest 只能按 id 选择。

因此“支持其他 Agent”分两层：新 Agent 只要能被 Terminal/Presence 识别，就立刻拥有通用的 observed result 回退；若要达到 Claude Code、Codex、Kimi Code 相同的原生精确结果，Adapter 还需声明一个 Charter 宿主已经实现的 history connector。语义控制服务本身不包含 provider 名称分支。

## 验收

开发者验收：

```sh
npm run build
npx vitest run apps/desktop-main/src/services/agent-registry.test.ts \
  apps/desktop-main/src/services/agent-presence-service.test.ts \
  apps/desktop-main/src/services/agent-result-reader.test.ts \
  apps/desktop-main/src/services/agent-semantic-control-service.test.ts \
  apps/desktop-main/src/services/cli-session-locator.test.ts \
  apps/desktop-main/src/services/external-session.test.ts
npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/agent-adapter.spec.ts
npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/agent-catalog.spec.ts
npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/ssh-remotes.spec.ts
```

人工验收：

1. 打开 Settings → Agent，确认 Claude/Codex/Kimi 显示 `builtin`、Adapter 版本、lifecycle 版本及能力标签。
2. 点击 Rescan，确认安装状态和 CLI 版本刷新。
3. 在开发构建放入一份有效 override，确认来源变为 `override` 并显示绝对路径。
4. 再放入一份损坏 JSON，确认 Settings 出现诊断，其他 Agent 仍可启动。
5. 从 Home 分别本地启动一个内置 Agent，并在 Remote Setup 确认远端 Agent 探测和 SSH 启动不受影响。
6. 等 Agent 进入 idle 后调用 `charter-terminal agent result <Session>`：内置本地 Agent 应得到 `native_history/native`；无原生连接器的测试 Adapter 应得到 `screen/observed` 和 warning。
