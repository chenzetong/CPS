# CPS 上游同步与发布

CPS 是 [jlcodes99/cockpit-tools](https://github.com/jlcodes99/cockpit-tools) 的社区维护分支。仓库保留上游的跨平台账号管理能力，并维护 Codex SSH 历史会话同步、状态库/rollout 对齐、孤立会话恢复和 app-server 重载等扩展。

## 版本策略

- CPS 的发行版本号与当时合入的上游 `package.json` 版本保持一致。
- CPS 不在同一上游版本上追加新的 SemVer 后缀；对应 Release 标题使用 `CPS vX.Y.Z`。
- 上游尚未提升版本号的普通提交可以合入 `main`，但不会覆盖已有同版本标签或重复发布 Release。

## 自动同步流程

`.github/workflows/sync-upstream.yml` 每 6 小时运行一次，也支持手动触发：

1. 以 `CPS/main` 为基础，无标签抓取 `jlcodes99/cockpit-tools:main`。
2. 使用正常 Git merge 保留双方历史，不重写 CPS 提交。
3. 将 `package.json`、`package-lock.json`、Tauri 和 Cargo 的应用版本统一为上游版本。
4. 运行版本脚本测试、敏感内容扫描、TypeScript、locale、SSH 事务测试和 `cargo check --locked`。
5. 验证成功后才推送 `main`；若该版本尚无 CPS 标签，则创建同版本标签并调度 Release 工作流。
6. 若发生冲突，工作流中止且不推送代码、不创建标签、不发布 Release；详情写入 Actions Job Summary 和逐文件错误注解。仓库启用 Issues 时还会创建或复用冲突 Issue，关闭 Issues 时不会产生二次失败。

冲突时必须同时保留上游修复以及 CPS 的品牌、updater 端点/公钥和 SSH 会话修复。自动化不会使用 `ours`/`theirs` 覆盖未知冲突。

## Release 与应用内更新

`.github/workflows/release.yml` 由 `v*` 标签或手动调度触发，构建 Windows、macOS 和 Linux 资产，并生成每目标 updater manifest 与兼容的 `latest.json`。应用只从以下 CPS 地址检查更新：

```text
https://github.com/chenzetong/CPS/releases/latest/download/latest-{{target}}-{{arch}}-{{bundle_type}}.json
https://github.com/chenzetong/CPS/releases/latest/download/latest.json
```

Tauri updater 使用 CPS 自有签名密钥。私钥和密码只保存在 GitHub Actions Secrets：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

仓库中只提交公钥。任何人都不应把私钥、账号文件、SSH 私钥、访问令牌或真实远端诊断信息提交到源码、Issue、日志或构建产物。

### 从 v0.26.8 迁移

`v0.26.8` 嵌入的是原仓库 updater 公钥，而 CPS 无权取得与之配对的私钥。Tauri 的签名校验不允许用新私钥伪造兼容更新，因此已经安装 `v0.26.8` 的用户需要手动安装一次首个包含 CPS 自有公钥的上游同版本发行版。完成这次桥接安装后，后续 CPS Release 可正常应用内自动检查、下载和安装。

macOS 目前使用完整的 ad-hoc 包签名，但没有 Apple Developer ID 公证。若 Gatekeeper 阻止首次打开，可执行：

```sh
sudo xattr -rd com.apple.quarantine "/Applications/CPS.app"
```

## 上游贡献原则

提交到原仓库的 PR 只包含可复用源码、语言包和测试，不包含 CPS 品牌、版本号、GitHub Release 配置、安装包或其他编译产物。

## 安全检查

提交前运行：

```sh
npm run security:scan
```

扫描会检查已跟踪文本文件中的私钥头、常见访问令牌格式，以及开发期间使用过的本机路径、远端地址和诊断任务 ID；命中内容只报告文件、行号和规则名，不打印疑似密钥值。

## 致谢

- 感谢 [jlcodes99/cockpit-tools](https://github.com/jlcodes99/cockpit-tools) 原作者与贡献者提供并维护项目基础。
- 感谢 [angusdevgo/OC-Codex](https://github.com/angusdevgo/OC-Codex) 公开账号切换和记录同步实现，为 CPS 的方案调研提供参考。
