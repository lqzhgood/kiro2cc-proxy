# Fork：一键导入与上游同步

## 使用

管理页的「一键导入」提供 macOS 命令、命令复制、账户 JSON 输入和确定导入。运行命令需要本机 Kiro IDE 已登录、`curl`、Bash，以及 `jq` 或 `python3`；按终端提示输入邮箱。脚本末尾输出完整账户 JSON，并且仅在 `pbcopy` 成功时显示「已复制到剪贴板」。失败时仍可复制终端中的 JSON。

弹窗打开期间，页面重新获得焦点或变为可见时尝试读取剪贴板。仅合法账户 JSON 且输入为空时填入。拒绝读取后停止自动重试，可点击「从剪贴板粘贴」重试，也可手动粘贴。HTTPS/localhost 和浏览器权限是自动读取的前提，Firefox/Safari 等浏览器可能仍要求主动粘贴。关闭弹窗清空信息；点击确定才提交给当前代理，不会在浏览器中执行脚本。

原 KAM 按钮保留在 DOM 中并使用 `display: none` 隐藏。原导入弹窗及其上游状态链保持原样。

## 发布脚本

维护源文件是 `scripts/fork/get-kiro-info.sh`，基于用户提供的脚本修订。将该文件发布到自己的下载地址，并只在部署环境中设置 `KIRO_IMPORT_SCRIPT_URL`。下面是无效的占位示例，不是实际部署地址：

`https://example.invalid/get-kiro-info.sh`

真实地址不得写入源码、测试、文档、提交信息或 Vite 构建变量。运行时通过受管理员鉴权保护的 `/api/admin/fork/import-config` 返回，响应禁止缓存；没有合法配置时不提供默认地址，手动导入仍可用。地址不会编译进前端静态资源或镜像，但登录管理员为执行命令仍能看到地址。

本仓库不会自动发布外部脚本。弹窗命令下载成功后再运行，并带 `get --stdout`；发布与真实 Mac 运行需要单独验收。

## 隔离边界

- 上游前端接入：`web-ui/admin-ui/src/components/dashboard/credential-action-bar.tsx`，新组件导入、旧按钮隐藏样式、新按钮挂载共三处。
- 上游后端接入：`src/admin/mod.rs` 声明独立的 `fork_import` 模块；`src/admin/router.rs` 在管理员鉴权范围内注册配置路由。实现和测试均位于新文件 `src/admin/fork_import.rs`，不修改现有账户接口。
- 独立实现：`web-ui/admin-ui/src/features/one-click-import/`。文案也在模块中，避免修改上游全局语言文件。
- `parse.ts` 只接受账户对象或非空数组，限制 2 MB、校验字符串字段和 Social/IdC 一致性，按白名单构造请求。
- `import-accounts.ts` 保存「禁用创建 → 查余额验活 → 启用」契约，跳过已知重复账户。验活失败保留禁用账户；启用响应失败提示结果未确认，不重复创建。
- 账户 API、查询缓存、哈希和对话框基础组件由上游提供；不通过 DOM 搜索或构建时打补丁替换功能。
- 测试工具放在 `tools/one-click-import/`，有独立锁文件，不修改上游前端 package.json。仅使用虚构账户和 mock API，不访问真实 Kiro 凭据或提交真实账户。

## 验证

需要 Node.js 24+、npm、Python 3 和 Bash。

```sh
npm --prefix web-ui/admin-ui install
npm --prefix tools/one-click-import ci
cd tools/one-click-import
npx playwright install chromium
npm run verify
cd ../..
python3 tools/one-click-import/test_export.py
npm --prefix web-ui/user-ui install
npm --prefix web-ui/user-ui run build
cargo test admin::fork_import
```

Windows 可设置 `KIRO_TEST_BROWSER=chrome` 使用已安装的 Chrome；用 `KIRO_TEST_BASH` 指定 Git Bash 路径，然后用 `python` 运行脚本测试。测试通过 `KIRO_EXPORT_ROOT` 指向临时假数据目录，并模拟剪贴板，避免访问真实账户或覆盖真实剪贴板。Rust 检查前需先构建两套上游前端，满足静态资源嵌入要求。

独立 CI 为 `.github/workflows/fork-import.yml`：Linux 运行解析/流程测试、管理端构建和 Chromium 界面回归；macOS 运行脚本回归。浏览器权限提示和真实 Mac 的终端/剪贴板交互还应在发布前手动验收一次。

## 同步上游

在此仓库对 Codex 说「同步上游并验证一键导入」，或调用 `$kiro-upstream-sync`。技能位于 `.agents/skills/kiro-upstream-sync/SKILL.md`。

上游是 `TsinHzl/kiro2cc-proxy` 的 `master`，fork 是 `lqzhgood/kiro2cc-proxy`。技能检查上游差异、合并并适配接入点，运行上述回归及受影响的上游检查，最后报告实际验证结果和限制。技能与测试降低遗漏风险，无法保证所有未来上游改动均无冲突或无需人工适配。

## Docker 部署和更新

本地 `git commit` 不会触发 GitHub Actions。推送到本 fork 的 `master` 后，现有 `.github/workflows/docker-build.yaml` 会构建 amd64/arm64 镜像并发布到 `ghcr.io/lqzhgood/kiro2cc-proxy`：

- 普通 master 推送：更新 `beta` 和 `beta-<提交号前6位>`。
- 推送 `v*` 标签或手动运行 Docker 工作流：更新对应版本标签和 `latest`。
- master 推送对应的提交若已有 `v*` 标签，预检查会跳过 beta 构建，由标签触发发布。

首次使用 fork 时确认 GitHub 仓库 Actions 已启用。镜像需要构建成功才能拉取；GHCR 包若为私有，服务器需有读取权限并登录，或者在包设置中将其公开。Docker 发布与 `Fork one-click import` 测试是独立工作流，部署前应确认两者对同一提交都成功。

服务器继续使用原来的 Compose 和数据目录即可。当前仓库的 Compose 支持 `IMAGE_OWNER` / `IMAGE_TAG`，在**原部署目录**的 `.env` 中添加或修改下面三项，保留已有其他配置：

```dotenv
IMAGE_OWNER=lqzhgood
IMAGE_TAG=beta
KIRO_IMPORT_SCRIPT_URL=https://example.invalid/get-kiro-info.sh
```

将示例 URL 换为自己的真实地址；`.env` 已被 Git 忽略，不要强制加入暂存区。将本 fork 的 `docker-compose.override.yml` 放到同一部署目录，它会把该变量传入容器。已有 override 文件时仅合并其中的 `environment` 配置。使用默认 `docker compose` 命令会读取 override；如果显式指定 `-f`，需要同时指定基础文件和 override。只有 `.env` 而没有对应 environment 配置，不会自动把变量传入容器。

如果服务器使用较旧的 Compose 文件，`image` 没有引用这两个变量，则将该服务的镜像改为 `ghcr.io/lqzhgood/kiro2cc-proxy:beta`；沿用原端口与 `./data:/app/config` 挂载。

镜像构建成功后，在原部署目录执行：

```sh
docker compose config --images
# 确认输出为 ghcr.io/lqzhgood/kiro2cc-proxy:beta
docker compose pull kiro2cc-proxy
docker compose up -d kiro2cc-proxy
docker compose logs --tail=100 kiro2cc-proxy
```

`pull` 下载镜像，`up -d` 根据新镜像重建容器，继续挂载原数据；无需先 `down`。不要重新初始化已有 `data/config.json` 或 `data/credentials.json`。

后续更新流程：同步上游并通过检查 → 提交并推送自己的 fork → 等待 Docker 构建和功能回归成功 → 服务器执行上述 pull/up。只有镜像变更时，服务器不必为了更新镜像而执行 `git pull`；上游 Compose 配置变化时再单独核对更新。

需要固定发布版本或回滚时，将 `IMAGE_TAG` 从 `beta` 改为已成功构建的 `beta-<提交号前6位>`，再执行 pull/up。部署前记录旧镜像标签或 digest 并备份数据；跨版本数据格式变化时，回滚镜像还应核对数据兼容性。

脚本下载站点的发布仍需单独完成。远程管理页若使用普通 HTTP，自动剪贴板读取通常不可用；使用 HTTPS 或手动粘贴。

参考：[Compose 环境变量](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)、[compose pull](https://docs.docker.com/reference/cli/docker/compose/pull/)、[compose up](https://docs.docker.com/reference/cli/docker/compose/up/)。
