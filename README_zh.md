# pi-btw

<div align="center">

<img src="https://cdn.jsdelivr.net/gh/L2ncE/pi-btw@main/assets/logo.png" alt="pi-btw" width="280"/>

</div>

Claude Code 风格的 `/btw` side question 扩展，为 [pi](https://pi.dev) 打造。[English](README.md)

主 agent 正在跑的时候，随手问一个小问题：

```
/btw 刚才那个配置文件叫什么来着？
/btw 这个报错是什么意思？
```

- 答案出现在**顶部悬浮 overlay**，主界面继续跑，互不打断
- 不进主会话历史，不占主上下文窗口
- side question 共享主会话的真实消息上下文，后续 side question 也能看到之前的 side Q&A（保留最近 20 组）
- 只读工具集（`read` / `grep` / `find` / `ls`），能自己去看代码，但改不了任何东西
- overlay 内直接追问，同一个 side thread 连续对话

![pi-btw 实际效果](https://cdn.jsdelivr.net/gh/L2ncE/pi-btw@main/assets/screenshot.png)

## overlay 按键

| 键 | 作用 |
|---|---|
| `Enter` | 提交输入框里的追问 |
| `Esc` | 回答进行中 → 中止；空闲 → 关闭 overlay |
| `c` | 复制当前答案（原始 markdown）到剪贴板 |
| `←` / `→` | 翻看本次会话的历史 side Q&A |
| `↑` / `↓` | 滚动长答案 |
| `Alt+/` | 在 overlay 与主输入框之间切换焦点（overlay 保持显示；`Ctrl+Alt+W` 为备用键） |

历史 side Q&A 以暗色问题列表显示在当前答案上方，只存在内存里，`/new`、重启即清空，也永远不会进入主会话。

## 安装

```bash
pi install npm:@lanlance/pi-btw
```

或从 git：

```bash
pi install git:https://github.com/L2ncE/pi-btw
```

本地试用（不安装）：

```bash
pi -e /path/to/pi-btw
```

## 设计

- 每次 pi 会话懒创建一个 in-memory `AgentSession` 子会话（`SessionManager.inMemory()`，不落盘），种子为主会话 branch 的真实 messages
- 子会话工具白名单 `["read", "grep", "find", "ls"]`，无 bash / edit / write
- 模型与 thinking level 继承主会话，每次提问前同步
- system prompt 明确声明：只读的临时 side agent，主 agent 未被打断，只回答，不承诺任何修改

License: Apache-2.0
