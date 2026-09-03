# dsh-plugin-stalegreen

[English](README.md) | 中文

[stalegreen](https://github.com/pavangupta352/stalegreen) 的新鲜度检查，以 DeepSeek Harness 插件的形式提供。验证命令（`pytest`、`pnpm test`、`tsc`、`eslint`、`cargo test`、`next build` 等约八十种）会被记录为凭据，文件修改会被记录为编辑事件；当智能体以"所有测试通过"、"tsc 无错误"或"构建成功"结束一轮时，这个说法会与该类别最近的一条凭据对照：

| 证据 | 判定 | 结果 |
| --- | --- | --- |
| 通过的运行，之后没有修改 | FRESH | 本轮正常结束 |
| 通过的运行，之后文件被修改过 | STALE | 再走一步，附上凭据和被修改的文件 |
| 失败的运行 | FAILED | 再走一步 |
| 结果被管道或后缀隐藏的运行 | MASKED | 再走一步，要求不加管道重新运行 |
| 完全没有运行 | NONE | 本轮正常结束（strict 模式下再走一步） |

DeepSeek Harness 自己的目标系统说明它没有独立的评估者。这个插件就是一个：确定性的、本地的，每个判定都引用一条凭据。零 token，零网络，零遥测。

## 安装

```sh
dsh plugin add dsh-plugin-stalegreen
```

这个组合包会在 profile 中插入一行名为 `stalegreen` 的插件。选项写在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: stalegreen
  config:
    policy: advisory   # 只记录判定，不引导下一步
    mode: strict       # 拒绝被掩盖结果的验证命令
```

凭据、编辑事件和判定保存在 `~/.stalegreen/sessions/<会话 id>/`，与 `stalegreen` 命令行工具读取的是同一个存储：`npx stalegreen check` 显示最近一次会话的说法与证据，`npx stalegreen receipt r-0017` 显示某次运行的凭据和日志末尾。

## 接入方式

- `tools/pre-execute`：验证命令会得到一条待定凭据；strict 模式下，被掩盖结果的命令（`| tail -5`、`|| true`、`2>/dev/null`）会被拒绝，并要求去掉管道重新运行。Harness 的 pre-execute 瀑布不能改写工具调用，所以与 Claude Code 和 Codex 的钩子不同，这里不做改写；bash 工具会把长输出完整保存到文件，管道能隐藏的内容因此有限。
- `tools/post-execute`：bash 工具的输出根据运行器自己的汇总行和 `[exit code: N]` 标记变成一条凭据；`edit`、`write` 和 `str_replace_editor` 调用变成编辑事件。
- `agent/turn-stopping`：读取本轮最后一条助手消息中的"绿色"说法。过期、失败或被掩盖的说法会引导再走一步，消息形如：

```
stalegreen: "all tests pass" is stale. Receipt r-0017 (`pnpm test`, 41 passed, 14:02:11) predates 3 later edits:
  src/routes/pay.ts (14:05:40), src/lib/hold.ts (14:06:02), src/lib/hold.test.ts (14:06:31)
Rerun `pnpm test` and report the result, or state explicitly that the tests were not rerun after these edits.
```

同一类别每轮最多引导一次，智能体不会被困住。

## 它不是什么

它不判断意图，只检查说法背后的证据是否新鲜、完整。也不取代运行器的判断：通过与否以运行器自己的汇总为准，从不仅凭沉默推断。

## 许可

MIT。版权所有 (c) 2026 Pavan Gupta。
