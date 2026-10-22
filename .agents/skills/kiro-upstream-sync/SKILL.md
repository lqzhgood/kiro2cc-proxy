---
name: kiro-upstream-sync
description: 同步此 kiro2cc-proxy fork 的上游更新，适配并验证独立的一键导入功能。用于合并上游、升级上游或检查升级影响；普通界面修改不触发。
---

# Kiro fork 上游同步

维护目标：把用户指定的上游更新合入当前 fork，并保留一键导入功能。只要求检查影响时执行只读比较，不擅自合并。同步请求包含常规冲突修复和兼容适配，但不扩大为无关功能改造。

先读仓库根目录 `docs/fork-one-click-import.md`，核对当前接入点、契约和验证命令，以实际代码为准。

## 基线

- 核对仓库、分支、HEAD、暂存区和工作区。用户已有改动不得混入同步提交；必要时从当前 fork HEAD 建隔离工作树，不能隔离的冲突则询问处理方式。根目录 `admin-ui/dist/`、`user-ui/dist/` 可能是既有构建输出，不要纳入提交。
- 本 fork 是 `lqzhgood/kiro2cc-proxy`；已核验上游为 `https://github.com/TsinHzl/kiro2cc-proxy.git`，默认分支 `master`。检查现有 remote，不改写不匹配的 upstream；缺失时为该 URL 添加 upstream。若 upstream 名称已指向其他仓库，为正确 URL 选择新的不冲突名称，后续 fetch/merge 均使用这个已核验的 remote，不能继续读取错误的 upstream/master。
- 记录同步前 fork HEAD 和 merge-base。fetch 已核验的上游，确定用户指定版本；未指定则使用本次 fetch 得到的该 remote 的 master 的具体 SHA。检查这段差异，不能把 Git 无冲突当作验证成功。

## 合并与适配

执行 merge 保留 fork 历史，不擅自 rebase 或强推。需要新分支时用 `codex/` 前缀。解决冲突须结合上游新行为和下述契约，不能整文件采用 ours/theirs。

- 上游前端接入文件当前是 `web-ui/admin-ui/src/components/dashboard/credential-action-bar.tsx`：旧 KAM 按钮保留 `display: none`，挂载独立 `OneClickImport`。上游重构操作栏时迁移小接入点，不复制整个上游页面或使用 DOM 补丁。
- 上游后端接入仅 `src/admin/mod.rs` 模块声明和 `src/admin/router.rs` 路由注册，实现在 `src/admin/fork_import.rs`。配置端点必须留在管理员鉴权范围内，返回 `Cache-Control: no-store`。脚本 URL 仅从服务端运行时 `KIRO_IMPORT_SCRIPT_URL` 读取，无默认地址；不得写入源码、测试、文档、提交信息、日志或构建变量。保留 `.env` 的 Git/Docker 忽略规则和独立 Compose override 的环境变量传入。未配置或获取失败时，手动导入仍可用。
- 独立目录是 `web-ui/admin-ui/src/features/one-click-import/`。检查账户请求类型、`useAddCredential` / `useSetDisabled`、余额接口、哈希格式和 UI 组件变动，在独立适配层修复。
- 脚本输出单账户数组；Social 不带 IdC client 字段，IdC 同时带 clientId/clientSecret；保留 email/profileArn/authRegion/apiRegion/machineId。禁用创建、验活后启用；重复账户跳过；验活或启用失败不得误报为创建失败并自动重复创建。
- 仅弹窗打开时监听 focus/visibility，仅空框和合法 JSON 自动填入；异步读取不得覆盖用户输入或污染下次弹窗。拒绝后停止自动重试，保留主动粘贴和手动输入。确定按钮是唯一提交入口，关闭清空凭据。
- `scripts/fork/get-kiro-info.sh` 目前仅 macOS。末尾显示完整 JSON；真实复制成功才显示成功，失败明确提示手动复制。外部下载地址的发布独立进行，本地修改不意味着线上已更新。

## 验证与交付

按维护文档运行固定回归：Node 合约测试、管理端构建、Playwright 页面回归、Python 脚本回归，以及构建两套前端后的 `cargo test admin::fork_import`。配置测试仅使用 example.invalid 等虚构地址，检查未授权访问和无配置的降级行为。脚本测试必须使用合成数据根目录和模拟剪贴板，不导出本机真实凭据或向服务提交真实账户。

若上游改变相关后端路径，补跑受影响的 Rust 检查和仓库要求的检查；读 `.github/workflows/test.yaml` 核对当前上游命令。接口变化时同时更新合约断言和 mock，并核对实际后端请求类型或反序列化验证；新增必填字段必须确认来源和默认值，不能猜造字段值或仅凭旧 mock 通过就认定兼容。环境缺失时完成能运行的部分，准确报告未验证项，不能将跳过写成通过。

审查完整 diff，确保上游功能没有被定制代码回退。只提交此次同步与适配文件；按用户授权处理提交，不自动 push、发布脚本或部署服务。

报告同步前后 SHA、上游版本、适配位置、测试结果、未解决问题和回滚点。失败时保留可审查状态，不宣称成功；不要承诺未来无冲突。
