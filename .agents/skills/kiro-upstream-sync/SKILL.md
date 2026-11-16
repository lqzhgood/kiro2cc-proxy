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
- 上游后端接入仅 `src/admin/mod.rs` 模块声明和 `src/admin/router.rs` 合并独立路由。实现和测试是 `src/admin/fork_import.rs`、`src/admin/fork_import_tests.rs`。创建一次性导入授权必须使用现有管理员鉴权；上传/查询使用独立 `x-kiro-import-token`，不能变成未鉴权账户写入入口，也不能把管理员密码放入命令。保留 10 分钟单次授权、2 MB 限制、邮箱必填、字段白名单、并发去重及已接收任务不依赖页面存活的契约。重复上传只查询原结果，不能再次创建。
- 脚本随二进制嵌入，由当前站点提供；`Dockerfile` 必须包含 `COPY scripts/fork ./scripts/fork`。前端下载和上传地址均由 `window.location.origin` 生成，包含协议和端口，不写死部署地址。已移除 `KIRO_IMPORT_SCRIPT_URL` 和仅用于传入它的 Compose override；不要在同步时恢复这套外部分发配置。保留 `.env` 的 Git/Docker 忽略规则。
- 独立目录是 `web-ui/admin-ui/src/features/one-click-import/`。检查账户请求类型、`useAddCredential` / `useSetDisabled`、余额接口、哈希格式和 UI 组件变动，在独立适配层修复。
- macOS 脚本 `scripts/fork/get-kiro-info.sh`、Windows 脚本 `scripts/fork/get-kiro-info.ps1` 只读取当前 Kiro IDE 登录；邮箱必须交互填写或显式提供。IdC 直接上传只用 clientIdHash 精确对应的注册文件，不能按修改时间猜选；Social 不带 IdC 字段。当前不支持 Kiro CLI/external_idp。脚本不得在直传模式打印凭证、写凭证文件或复制到剪贴板；HTTP 失败和结果日志不得泄漏凭证。
- 保留「禁用创建 → 查余额验活 → 启用」及各阶段结果。重复凭证跳过；验活或启用失败不能误报为创建失败、不能自动重建。核对复用的 AdminService 方法和上游请求字段，不能用新接口绕过现有校验。
- 管理页支持 macOS/Windows 命令、授权重新生成、状态轮询和账户缓存刷新；关闭清空页面内信息、停止轮询，但不取消已接收任务。临时授权仅保存在单实例内存，重启失效，不宣称支持多副本共享。
- 手动粘贴保留为备用入口，其确定按钮仅提交手动数据；不能再把“确定是唯一提交入口”套用到自动上传。自动剪贴板读取仅限弹窗打开、空输入框且 JSON 合法；异步读取不覆盖用户输入或污染下次弹窗，拒绝后停止自动重试。
- macOS 原有 `get --stdout` 手动导出模式仍可输出 JSON，只有 pbcopy 真成功才提示已复制；与直传模式分别验证。Windows 支持 PowerShell 5.1+，不依赖 Git Bash、不永久修改执行策略。
- 管理端侧边栏页脚（左下角）的 GitHub 链接固定为 fork 仓库 `https://github.com/lqzhgood/kiro2cc-proxy`，位于 `web-ui/admin-ui/src/components/dashboard/sidebar.tsx` 页脚版本号 `<a href>`（约在「页脚（设计稿 .side-foot）：运行状态点 + 版本号 + 退出登录」注释下方）。上游该位置是 `TsinHzl/kiro2cc-proxy`，合并时上游改动可能把它改回；每次同步都须检查并恢复为 fork 地址。该文件其余位置（顶部 logo 链接、`dashboard/docs-page.tsx`、`hooks/use-credentials.ts` 的更新检查与 release/tags 查询）按上游原样保留，不随此项改写；README 徽章与链接同理不动。

## 验证与交付

升级或同步上游时，遵守用户明确要求：**不要在本机运行一键导入的 Playwright 浏览器回归**。2026-11-03 的升级验证以 10 个 worker 启动 Chrome，时间和数量与 Windows 账户的 10 次密码验证失败及锁定吻合；重复启动浏览器可能再次触发账户锁定。

- 禁止运行 `npm --prefix tools/one-click-import run verify`（或进入该目录后的 `npm run verify`），因为它会间接执行浏览器回归。
- 禁止运行该目录的 `npm run test:browser`、`npx playwright test` 或直接执行 `browser.spec.mjs`；不要通过设置 `KIRO_TEST_BROWSER=chrome`、改用 Chromium/Edge、降低并发或其他等价入口绕过此限制。常规“升级并验证”请求不表示撤销此要求。
- 即使维护文档仍列出完整 `verify` 流程，也按本节拆开运行不启动浏览器的检查；不要为通过测试修改 Windows 账户锁定策略。
- 交付时明确记录“浏览器回归按用户要求跳过”，不能写成通过。只有用户后续明确要求恢复这项测试时，才重新评估执行方式。

固定回归仅运行：`npm --prefix tools/one-click-import test`（Node 合约测试）、管理端构建、Python 导出/上传脚本回归（`test_export.py`、`test_upload.py`），以及构建两套前端后的 `cargo test admin::fork_import`。运行前核对 package.json 中这些命令及其 pre/post 钩子仍不启动浏览器。接口测试使用虚构凭证，检查管理员/临时授权、过期、并发重复提交、字段白名单和失败阶段。脚本测试必须设置临时合成数据根目录，模拟剪贴板；上传只能发往测试回环 HTTP stub，不能读取本机真实凭据或向真实服务提交账户。Windows/macOS 两种脚本及 Docker 嵌入路径都纳入检查；在 Windows 模拟 Darwin 的通过结果不能声称真实 Mac 已验收。

若上游改变相关后端路径，补跑受影响的 Rust 检查和仓库要求的检查；读 `.github/workflows/test.yaml` 核对当前上游命令。接口变化时同时更新合约断言和 mock，并核对实际后端请求类型或反序列化验证；新增必填字段必须确认来源和默认值，不能猜造字段值或仅凭旧 mock 通过就认定兼容。环境缺失时完成能运行的部分，准确报告未验证项，不能将跳过写成通过。

审查完整 diff，确保上游功能没有被定制代码回退。只提交此次同步与适配文件；按用户授权处理提交，不自动 push、发布脚本或部署服务。
交付前确认侧边栏页脚链接仍为 `https://github.com/lqzhgood/kiro2cc-proxy`（例如在 `sidebar.tsx` 中检索页脚版本号 `<a>` 的 href）；被上游覆盖时在同步提交内一并修复。

报告同步前后 SHA、上游版本、适配位置、测试结果、未解决问题和回滚点。失败时保留可审查状态，不宣称成功；不要承诺未来无冲突。
