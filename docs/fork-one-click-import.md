# Fork：一键导入与上游同步

## 使用

管理员在管理页打开「一键导入」，选择 macOS 或 Windows，复制命令到已登录 Kiro IDE 的电脑执行。终端要求填写邮箱，用于区分账户，然后自动上传当前登录账户，不再复制或粘贴凭证。

- macOS：Bash、curl，以及 jq 或 python3。
- Windows：Windows PowerShell 5.1 或 PowerShell 7，使用系统自带 JSON/HTTP 能力，无需 Git Bash，也不修改系统执行策略。
- 只读取当前用户 `~/.aws/sso/cache/kiro-auth-token.json`，IdC 必须有 `clientIdHash` 对应的注册文件。直接导入不扫描其他账户注册文件，不支持 Kiro CLI 或 external_idp。
- 邮箱必填；machineId 存在时读取，缺失的 profileArn 交由现有后端处理。
- 终端显示成功、重复或失败阶段，不输出凭证、不写凭证文件、不改剪贴板。打开的管理页轮询结果并刷新账户列表；关闭页面不取消已被服务端接收的任务。

手动导入区域作为备用入口保留：可主动粘贴、输入账户 JSON；仅空框时在弹窗内尝试从剪贴板填入。手动输入仍需点击「确定导入」。剪贴板读取依赖 HTTPS/localhost、浏览器支持和权限。

## JSON 导入

账户操作栏的「JSON 导入」支持粘贴或选择一个 `.json` 文件（UTF-8，可带 BOM，最大 2 MB）。内容必须是非空账户数组，点击「确定导入」才发送。支持的字段与现有账户 API 同名：

```json
[
  {
    "nickname": "工作账号",
    "email": "name@example.com",
    "authMethod": "idc",
    "provider": "Enterprise",
    "refreshToken": "<refreshToken>",
    "clientId": "<clientId>",
    "clientSecret": "<clientSecret>",
    "profileArn": "<profileArn>",
    "authRegion": "us-east-1",
    "apiRegion": "us-east-1"
  }
]
```

`refreshToken` 必填；`authMethod` 省略时为 `social`，只接受 `social` / `idc`；`idc` 需要同时填写 `clientId`、`clientSecret`，`social` 不应携带这两个字段。`provider` 可省略，social 支持 `Google` / `GitHub`，idc 支持 `Enterprise`。昵称和邮箱可省略，分别保存，填写邮箱时检查格式。企业账号应提供实际 `profileArn`，两个区域填写账户实际区域。以上文本字段不接受数字、对象或 null；不支持的字段忽略，不透传到接口。

先检查整批结构和字段，错误提示条目编号及字段名；全部通过后逐条创建、验活、启用。重复账户跳过，单条失败继续，已创建但验活失败的账户保持禁用。原始服务端错误不会显示，避免带出凭证。文件选择不会自动提交；完成或关闭弹窗后清空输入。导入在页面中执行，期间应保持页面打开，刷新或离开页面后需到列表核对已创建账户。

独立代码位于 `web-ui/admin-ui/src/features/json-import/`，仅在现有 `credential-action-bar.tsx` 挂载按钮，复用一键导入的 `import-accounts.ts` 和现有账户 API、查询缓存；不改后端、一键导入脚本和上游账户数据结构。测试位于 `tools/one-click-import/json-import.test.mjs`，已接入下文 `npm test`；浏览器用例随现有 CI 执行，本机仍不运行 Playwright。

## 脚本分发与授权

维护源是 `scripts/fork/get-kiro-info.sh` 和 `scripts/fork/get-kiro-info.ps1`，由 Rust `include_str!` 嵌入二进制，随镜像和二进制发布。Docker 构建必须复制 `scripts/fork`。无需外部下载站、`KIRO_IMPORT_SCRIPT_URL` 或独立 Compose override；旧部署中留下该环境变量也不再生效。

前端用 `window.location.origin` 获取协议、域名和端口，生成同站点下载及上传命令。当前支持既有根路径部署（管理页 `/admin/`，API `/api/admin`），不新增任意反向代理子路径支持。脚本下载不跟随重定向；HTTPS 使用正常证书校验。生产环境应沿用 HTTPS，HTTP 会明文传输导入凭证和账户信息。

独立接口位于 `/api/admin/fork/`：

- `POST import-sessions`：仅现有管理员鉴权通过后创建授权，10 分钟内可提交一个账户。
- `GET scripts/macos`、`GET scripts/windows`：返回项目内的脚本，不含任何账户或授权信息。
- `POST import-session`：通过 `x-kiro-import-token` 校验临时授权，接受单个账户对象或单元素数组，限制 2 MB，校验邮箱、字段类型与 Social/IdC 配对，并按白名单构造请求。
- `GET import-session`：同一临时授权查询状态，不返回凭证。重复 POST 只返回该任务状态，不重复创建。

临时授权不放进 URL，不包含管理员密码。授权、任务结果只保存在单实例内存，最多保留 64 个未过期或运行中的会话；后台运行期间可继续查询，完成结果保留 10 分钟。服务重启后授权失效，需先检查账户列表再生成新命令。命令中的临时授权在有效期内仍具备一次导入权限，勿发给他人。

## 隔离边界

- 上游前端接入：`web-ui/admin-ui/src/components/dashboard/credential-action-bar.tsx`，旧 KAM 按钮隐藏，挂载 `OneClickImport` 和 `JsonImport` 两个按钮。原上游弹窗保留。
- 上游后端接入：`src/admin/mod.rs` 声明模块，`src/admin/router.rs` 合并独立路由；不修改 `AdminState`、账户服务和 token manager。
- 独立后端：`src/admin/fork_import.rs`，测试 `src/admin/fork_import_tests.rs`。创建会话的路由必须保留管理员鉴权，上传/查询只接受临时授权；脚本公开下载，响应禁止缓存。
- 独立前端：`web-ui/admin-ui/src/features/one-click-import/` 和 `web-ui/admin-ui/src/features/json-import/`，复用现有 UI、账户 API 和查询缓存；JSON 导入共用前者的 `import-accounts.ts` 执行器。
- 导入保持「禁用创建 → 查余额验活 → 启用」。已知重复凭证跳过；验活失败保留禁用账户；启用失败明确提示结果未确认，不能自动重建。脚本上传已接收的后台任务不依赖 HTTP 连接或页面存活；JSON 和手动备用入口在页面中执行，导入期间需保持页面打开。
- 测试工具在 `tools/one-click-import/`；不添加业务依赖、不修改上游前端 package.json。

## 验证

本机不运行 Playwright 浏览器回归（用户已明确禁止，原因和边界见升级技能）。不要使用 `npm run verify`，它会间接启动浏览器。可执行：

```sh
npm --prefix tools/one-click-import test
npm --prefix web-ui/admin-ui run build
npm --prefix web-ui/user-ui run build
python3 tools/one-click-import/test_export.py
python3 tools/one-click-import/test_upload.py
cargo test admin::fork_import
```

需要 Node.js 24+、Python、Bash 和 PowerShell。Windows 用 `python`，通过 `KIRO_TEST_BASH` 指定 Git Bash，`KIRO_TEST_POWERSHELL` 指定 PowerShell；仅检查一种脚本时可设置 `KIRO_TEST_PLATFORM=macos` 或 `windows`。上传测试只读取临时合成缓存并向回环 HTTP stub 发送虚构账户；macOS 分支在非 Mac 上会模拟 Darwin 与 machineId 路径，不代表真实 Mac 验收。

独立 CI `.github/workflows/fork-import.yml` 在 Linux 运行 Node/前端/浏览器回归，在 macOS 运行导出和上传脚本回归，在 Windows PowerShell 5.1 运行上传回归。上游 Rust CI 构建两套前端后覆盖后端测试。浏览器回归保留在 CI，不能在本机执行。真实 IDE 登录、终端交互和实际代理部署仍需发布验收。

## 同步上游

在此仓库对 Codex 说「同步上游并验证导入功能」，或调用 `$kiro-upstream-sync`。技能位于 `.agents/skills/kiro-upstream-sync/SKILL.md`，同时覆盖一键导入和 JSON 导入。

上游是 `TsinHzl/kiro2cc-proxy` 的 `master`，fork 是 `lqzhgood/kiro2cc-proxy`。技能检查上游差异、合并并适配接入点，运行上述回归及受影响的上游检查，最后报告实际验证结果和限制。技能与测试降低遗漏风险，无法保证所有未来上游改动均无冲突或无需人工适配。

## Docker 部署和更新

本地 `git commit` 不会触发 GitHub Actions。推送到本 fork 的 `master` 后，现有 `.github/workflows/docker-build.yaml` 会构建 amd64/arm64 镜像并发布到 `ghcr.io/lqzhgood/kiro2cc-proxy`：

- 普通 master 推送：更新 `beta` 和 `beta-<提交号前6位>`。
- 推送 `v*` 标签或手动运行 Docker 工作流：更新对应版本标签和 `latest`。
- master 推送对应的提交若已有 `v*` 标签，预检查会跳过 beta 构建，由标签触发发布。

首次使用 fork 时确认 GitHub 仓库 Actions 已启用。镜像需要构建成功才能拉取；GHCR 包若为私有，服务器需有读取权限并登录，或者在包设置中将其公开。Docker 发布与 `Fork one-click import` 测试是独立工作流，部署前应确认两者对同一提交都成功。

服务器继续使用原来的 Compose 和数据目录即可。当前仓库的 Compose 支持 `IMAGE_OWNER` / `IMAGE_TAG`，在**原部署目录**的 `.env` 中添加或修改下面两项，保留已有其他配置：

```dotenv
IMAGE_OWNER=lqzhgood
IMAGE_TAG=beta
```

不再需要 `KIRO_IMPORT_SCRIPT_URL` 或本 fork 旧版的 `docker-compose.override.yml`。若已有 override 还包含其他部署设置，保留这些设置；无需为本功能新增环境变量。沿用现有数据挂载和配置，不重新初始化账户数据。

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

脚本与当前服务版本一起更新，不再单独发布下载站点。正式部署使用 HTTPS；手动备用入口的剪贴板权限限制不影响脚本直接上传。

参考：[Compose 环境变量](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)、[compose pull](https://docs.docker.com/reference/cli/docker/compose/pull/)、[compose up](https://docs.docker.com/reference/cli/docker/compose/up/)。
