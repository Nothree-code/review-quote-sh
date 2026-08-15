# review-quote-sh

对话消息**审查（多模型互审）**与**引用（问答胶囊）**插件，为 DeepSeek Harness（dsh web）定制。

- **审查**：对任意助手消息做代码/回复审查，可多选模型并行互审（Kimi / Qwen / DeepSeek / 智谱…），流式显示、可取消、历史回看、一键把审查意见发回对话。
- **引用**：一键把历史问答以胶囊形式引到输入框上方，点击查看全文，继续追问；输入框内只留紧凑标记。

## 特性

| 能力 | 说明 |
|---|---|
| 审查范围 | 当前消息 / 最近 1/3/5 轮 / 全部对话（以按钮所在消息为锚点向前取） |
| 多模型互审 | 复选框多选，并行审查，每模型独立报告卡片 |
| 模型动态枚举 | 自动列出 settings 中 `llm-pi-ai.providers` 配置的所有 provider 的模型，配置即用 |
| 自动判型 | 含代码 → 代码审查（CRITICAL/MAJOR/MINOR/NIT + 行号 + 修复代码）；纯文本 → 回复审查 |
| 流式输出 | 轮询实时增量显示，随时取消；超长内容自动压缩（保留轮次结构） |
| 事实核实纪律 | 审查模型对无法确认的外部事实标注「⚠️ 待核实」，不断言不存在 |
| 错误分类 | QUOTA/限流/上下文超限/认证/超时 → 中文可操作提示 |
| 审查历史 | 最近 5 次回看（时间/模型/范围/报告），历史报告可发回对话 |
| 偏好记忆 | 模型组合与范围持久化（Host 文件存储，跨重启保留） |
| 引用 | 问答胶囊（前 10 字预览）→ 点击展开全文 → ✕ 移除同步删标记；可多引用 |
| 隐私警示 | 多轮范围显示"内容将发送至模型服务商"提示条 |

## 安装（dsh web 用户）

```powershell
# 1. 把本仓库放入用户 profile 的 packages 目录
#    （以默认 profile 为例）
$dst = "$env:USERPROFILE\.dsh\profiles\web\packages\dsh-review-quote"
git clone https://github.com/<YOUR_ORG>/review-quote-sh.git $dst   # 或手动拷贝

# 2. 安装到 profile 的 node_modules
cd "$env:USERPROFILE\.dsh\profiles\web"
pnpm add "file:./packages/dsh-review-quote"

# 3. 在 profiles/web/cordis.patch.yml 追加挂载行：
# - insert:
#     - id: review-quote-sh
#       name: 'review-quote-sh'

# 4. 重启 dsh web
```

重启后每条助手消息操作行自动出现「审查」「引用」按钮，刷新页面不消失。

## 配置模型

凭据写入 `~/.dsh/.credentials.yaml`：

```yaml
DEEPSEEK_API_KEY: sk-xxx
MOONSHOT_API_KEY: sk-xxx        # Kimi（中国区）
ZHIPU_API_KEY: sk-xxx           # 智谱 GLM（可选）
DASHSCOPE_API_KEY: sk-xxx       # 通义千问（可选）
QWEN_TOKEN_PLAN_CN_API_KEY: sk-xxx  # 阿里云百炼 Token 计划（可选）
```

路由写入 `~/.dsh/settings.yaml`（也可在 Web 设置 → 模型管理页图形化配置）：

```yaml
llm-pi-ai:
  providers:
    moonshotai-cn:
      apiKeyEnv: MOONSHOT_API_KEY
    zai:
      apiKeyEnv: ZHIPU_API_KEY
    qwen-token-plan-cn:
      apiKeyEnv: QWEN_TOKEN_PLAN_CN_API_KEY
```

配置任意 provider 后，审查弹窗的模型列表自动出现对应模型。

## 使用

1. 悬停助手消息 → 「审查」/「引用」
2. 审查：选范围 → 勾选 1+ 模型 → 开始审查 → 各模型报告实时流出 → 「填入输入框发送」把意见发回对话由主模型执行修改
3. 引用：点「引用」→ 胶囊出现在输入框上方 → 点开看全文 → 补充问题 → 回车发送

## 开发

```powershell
# 改源码后同步到 node_modules（必须重启 dsh web 生效）
cd packages\dsh-review-quote
powershell -ExecutionPolicy Bypass -File sync.ps1
```

## 目录结构

```
review-quote-sh/
├── package.json          # dsh.client 元数据（web 扫描加载 client 半）
├── lib/
│   ├── index.js          # Host 半：审查任务 + /review-quote-* HTTP 路由 + 偏好文件存储
│   └── client.js         # Client 半：UI（__ModuleLoader__ 模块格式）
├── sync.ps1              # 开发同步脚本
└── docs/dynamic-archive/ # 早期动态插件版本归档（历史参考）
```

## 已知限制

- 引用发送给模型的是紧凑标记（`[引用：前10字…]`）而非全文；被引用问答通常在会话上下文中，主模型可定位
- 审查任务超时依赖模型适配器默认流空闲超时（约 5 分钟）
- 动态版（docs/dynamic-archive）与静态版不兼容并存：正式使用以静态版为准

## 安全加固（v1.0.1）

本版本根据三模型安全评估修订：

- **Origin/Sec-Fetch-Site 守卫**：全部 `/review-quote-*` 路由拒绝跨站简单请求与外来 Origin。
- **请求体上限**：`readBody` 增加 2MB 上限，超限拒绝。
- **模型白名单**：`/review-quote-start` 与 `/review-quote-summarize` 的 provider/model 必须来自设置中已配置的模型枚举，未配置一律拒绝（不再接受任意 provider/model）。
- **频率限制**：token 消耗型路由（start/summarize）每分钟最多 30 次、并发任务最多 16 个，超限返回可操作提示。
- 升级方式：同步 `sync.ps1` 后**完全重启 dsh web**。

## License

MIT
