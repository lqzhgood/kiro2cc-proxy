#!/usr/bin/env bash
#
# get-kiro-info.sh —— 导出本机 Kiro IDE 账户凭证，供「一键导入」使用
#
#   get    从 ~/.aws/sso/cache 读取当前登录凭证，拼成批量导入 JSON 并复制到剪贴板
#   set    配置 Claude Code / Codex CLI 指向 kiro-proxy（尚未实现）
#
# 仅支持 macOS。依赖 jq（优先）或 python3（兜底）。
#
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

# ---------- 路径常量 ----------
# 回归测试可指定隔离的假数据根目录；日常运行默认使用当前用户目录。
KIRO_DATA_ROOT="${KIRO_EXPORT_ROOT:-$HOME}"
SSO_CACHE_DIR="$KIRO_DATA_ROOT/.aws/sso/cache"
TOKEN_FILE="$SSO_CACHE_DIR/kiro-auth-token.json"
DEFAULT_REGION="us-east-1"

# Kiro IDE 日志目录，用于 token 文件缺 profileArn 时兜底
KIRO_LOG_DIR="$KIRO_DATA_ROOT/.kiro/logs"

# Kiro IDE 的 machineid 文件（不同版本目录名大小写不一致，两个都探）
MACHINE_ID_CANDIDATES="
$KIRO_DATA_ROOT/Library/Application Support/kiro/machineid
$KIRO_DATA_ROOT/Library/Application Support/Kiro/machineid
"

# ---------- 输出辅助 ----------
info() { printf '%s\n' "$*"; }
step() { printf '  → %s\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
err()  { printf '✗ %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

# ---------- JSON 工具探测 ----------
# 凭证里含 5000+ 字符的 JWT 和任意用户输入，一律走真正的 JSON 库，不手拼字符串
JSON_TOOL=""
detect_json_tool() {
    if command -v jq >/dev/null 2>&1; then
        JSON_TOOL="jq"
    elif command -v python3 >/dev/null 2>&1; then
        JSON_TOOL="python3"
    else
        die "需要 jq 或 python3 来处理 JSON，都没找到。安装其中之一：brew install jq"
    fi
}

# jvalid FILE —— 校验文件是合法 JSON
jvalid() {
    case "$JSON_TOOL" in
        jq)      jq -e . "$1" >/dev/null 2>&1 ;;
        python3) python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$1" >/dev/null 2>&1 ;;
    esac
}

# jread FILE KEY —— 读取顶层字符串字段，不存在则输出空
jread() {
    case "$JSON_TOOL" in
        jq)
            jq -r --arg k "$2" 'if (.[$k] // null) == null then "" else (.[$k] | tostring) end' "$1" 2>/dev/null || true
            ;;
        python3)
            python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
v = d.get(sys.argv[2])
if v is not None:
    print(v if isinstance(v, str) else json.dumps(v))
' "$1" "$2" 2>/dev/null || true
            ;;
    esac
}

# ---------- 剪贴板 ----------
copy_to_clipboard() {
    # 只支持 macOS，pbcopy 是系统自带
    if ! command -v pbcopy >/dev/null 2>&1; then
        return 1
    fi
    printf '%s' "$1" | pbcopy
}

# ---------- 时间处理 ----------
# iso_to_epoch "2026-08-27T13:35:31.036Z" —— 解析 UTC 时间戳为 epoch 秒，失败输出空
iso_to_epoch() {
    local s="$1"
    # 去掉小数秒和末尾 Z，得到 YYYY-MM-DDTHH:MM:SS
    s="${s%Z}"
    s="${s%%.*}"
    # export 而非前置赋值：命令替换子 shell 里前置赋值不一定传给 date，
    # 传丢了会把 UTC 时间戳当本地时间解析，差出整个时区偏移
    export TZ=UTC
    date -j -f "%Y-%m-%dT%H:%M:%S" "$s" "+%s" 2>/dev/null || true
    unset TZ
}

# 把 UTC 时间戳转成本地可读时间，失败则回显原串
iso_to_local() {
    local epoch
    epoch="$(iso_to_epoch "$1")"
    if [ -n "$epoch" ]; then
        date -r "$epoch" "+%Y-%m-%d %H:%M:%S %Z" 2>/dev/null || printf '%s' "$1"
    else
        printf '%s' "$1"
    fi
}

# ---------- 脱敏 ----------
# 长凭证只显示头 8 尾 4
redact() {
    local v="$1" n
    n="${#v}"
    if [ "$n" -le 16 ]; then
        printf '%s' "$v"
    else
        printf '%s…%s (%d 字符)' "${v:0:8}" "${v:$((n - 4))}" "$n"
    fi
}

# =====================================================================
# get
# =====================================================================

GET_EMAIL=""
GET_EMAIL_GIVEN=0
GET_PRINT_STDOUT=1
GET_OUT_FILE=""

parse_get_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --email)
                [ $# -ge 2 ] || die "--email 需要一个参数"
                GET_EMAIL="$2"; GET_EMAIL_GIVEN=1; shift 2
                ;;
            --email=*)
                GET_EMAIL="${1#--email=}"; GET_EMAIL_GIVEN=1; shift
                ;;
            --out)
                [ $# -ge 2 ] || die "--out 需要一个参数"
                GET_OUT_FILE="$2"; shift 2
                ;;
            --out=*)
                GET_OUT_FILE="${1#--out=}"; shift
                ;;
            --stdout)
                GET_PRINT_STDOUT=1; shift
                ;;
            -h|--help)
                usage; exit 0
                ;;
            -*)
                die "get: 未知参数 '$1'（用 $SCRIPT_NAME --help 查看用法）"
                ;;
            *)
                die "get: 多余的参数 '$1'"
                ;;
        esac
    done
}

# 邮箱宽松校验：含 @ 且无空白
email_looks_valid() {
    case "$1" in
        *[[:space:]]*) return 1 ;;
        ?*@?*)         return 0 ;;
        *)             return 1 ;;
    esac
}

# 交互式询问邮箱。必填，且必须含 @，不合格就一直重问
prompt_email() {
    local input
    if [ ! -e /dev/tty ]; then
        die "没有可用终端来读取邮箱，请改用 --email <地址>"
    fi

    while true; do
        printf '请输入该账户的邮箱: ' > /dev/tty
        IFS= read -r input < /dev/tty || input=""

        if [ -z "$input" ]; then
            printf '  邮箱不能为空，请重新输入。\n' > /dev/tty
            continue
        fi

        if email_looks_valid "$input"; then
            GET_EMAIL="$input"; return 0
        fi

        printf '  「%s」不是合法邮箱（需含 @ 且不含空格），请重新输入。\n' "$input" > /dev/tty
    done
}

# 定位 machineid 文件
find_machine_id() {
    local p
    printf '%s\n' "$MACHINE_ID_CANDIDATES" | while IFS= read -r p; do
        [ -n "$p" ] || continue
        if [ -f "$p" ]; then
            printf '%s' "$p"
            break
        fi
    done
}

# 定位 client 注册文件（含 clientId / clientSecret）
# 沿用 Kiro-account-manager 的优先级：先按 token 里的 clientIdHash 精确匹配，
# 找不到再扫描目录；扫描顺序改为 mtime 最新优先，并在用到兜底时明确告知。
CLIENT_REG_FILE=""
CLIENT_REG_VIA_FALLBACK=0
find_client_reg() {
    local hash="$1" candidate f cid csec

    if [ -n "$hash" ]; then
        candidate="$SSO_CACHE_DIR/$hash.json"
        if [ -f "$candidate" ] && jvalid "$candidate"; then
            cid="$(jread "$candidate" clientId)"
            csec="$(jread "$candidate" clientSecret)"
            if [ -n "$cid" ] && [ -n "$csec" ]; then
                CLIENT_REG_FILE="$candidate"
                return 0
            fi
        fi
    fi

    # 兜底：按修改时间从新到旧扫描（文件名是 40 位 hex，无空格风险）
    for f in $(ls -t "$SSO_CACHE_DIR"/*.json 2>/dev/null); do
        [ "$f" = "$TOKEN_FILE" ] && continue
        jvalid "$f" || continue
        cid="$(jread "$f" clientId)"
        csec="$(jread "$f" clientSecret)"
        if [ -n "$cid" ] && [ -n "$csec" ]; then
            CLIENT_REG_FILE="$f"
            CLIENT_REG_VIA_FALLBACK=1
            return 0
        fi
    done

    return 1
}

# 从单个日志文件里取最后一次出现的 profileArn。
# 日志里是转义过的 JSON 字符串（\"profileArn\":\"arn:aws:...\"），
# 所以先筛出含 profileArn 的行，再按 ARN 合法字符集截取，天然停在反斜杠前。
extract_profile_arn_from_log() {
    # 没匹配到时 grep 返 1，pipefail 下会让整条命令替换失败，用 || true 吞掉
    { grep -a 'profileArn' "$1" 2>/dev/null \
        | grep -oE 'arn:aws[A-Za-z0-9:/_.+-]*' \
        | tail -n 1 ; } || true
}

# 兜底：从 ~/.kiro/logs 各次启动的日志里找 profileArn，目录名就是启动时间戳，按名倒序＝最近优先
PROFILE_ARN_LOG_FILE=""
find_profile_arn_in_logs() {
    local dir f arn
    [ -d "$KIRO_LOG_DIR" ] || return 1

    for dir in $(ls -1 "$KIRO_LOG_DIR" 2>/dev/null | sort -r); do
        [ -d "$KIRO_LOG_DIR/$dir" ] || continue
        for f in "$KIRO_LOG_DIR/$dir"/*.log; do
            [ -f "$f" ] || continue
            arn="$(extract_profile_arn_from_log "$f")"
            if [ -n "$arn" ]; then
                F_PROFILE_ARN="$arn"
                PROFILE_ARN_LOG_FILE="$f"
                return 0
            fi
        done
    done

    return 1
}

# 构造批量导入 JSON。字段顺序与 kiro-proxy 文档示例一致。
# 空值字段整个省略：批量导入靠 clientId+clientSecret 是否成对存在推导 authMethod，
# 只给其中一个会被直接判为非法。
build_json() {
    case "$JSON_TOOL" in
        jq)
            jq -n --indent 4 \
                --arg refreshToken "$F_REFRESH_TOKEN" \
                --arg profileArn   "$F_PROFILE_ARN" \
                --arg clientId     "$F_CLIENT_ID" \
                --arg clientSecret "$F_CLIENT_SECRET" \
                --arg authRegion   "$F_AUTH_REGION" \
                --arg apiRegion    "$F_API_REGION" \
                --arg machineId    "$F_MACHINE_ID" \
                --arg authMethod   "$F_AUTH_METHOD" \
                --arg email        "$F_EMAIL" \
                '[ {refreshToken: $refreshToken}
                   + (if $profileArn   == "" then {} else {profileArn:   $profileArn}   end)
                   + (if $clientId     == "" then {} else {clientId:     $clientId}     end)
                   + (if $clientSecret == "" then {} else {clientSecret: $clientSecret} end)
                   + (if $authRegion   == "" then {} else {authRegion:   $authRegion}   end)
                   + (if $apiRegion    == "" then {} else {apiRegion:    $apiRegion}    end)
                   + (if $machineId    == "" then {} else {machineId:    $machineId}    end)
                   + (if $authMethod   == "" then {} else {authMethod:   $authMethod}   end)
                   + (if $email        == "" then {} else {email:        $email}        end)
                 ]'
            ;;
        python3)
            F_REFRESH_TOKEN="$F_REFRESH_TOKEN" \
            F_PROFILE_ARN="$F_PROFILE_ARN" \
            F_CLIENT_ID="$F_CLIENT_ID" \
            F_CLIENT_SECRET="$F_CLIENT_SECRET" \
            F_AUTH_REGION="$F_AUTH_REGION" \
            F_API_REGION="$F_API_REGION" \
            F_MACHINE_ID="$F_MACHINE_ID" \
            F_AUTH_METHOD="$F_AUTH_METHOD" \
            F_EMAIL="$F_EMAIL" \
            python3 -c '
import json, os, collections
order = [
    ("refreshToken", "F_REFRESH_TOKEN"),
    ("profileArn",   "F_PROFILE_ARN"),
    ("clientId",     "F_CLIENT_ID"),
    ("clientSecret", "F_CLIENT_SECRET"),
    ("authRegion",   "F_AUTH_REGION"),
    ("apiRegion",    "F_API_REGION"),
    ("machineId",    "F_MACHINE_ID"),
    ("authMethod",   "F_AUTH_METHOD"),
    ("email",        "F_EMAIL"),
]
acct = collections.OrderedDict()
for key, env in order:
    val = os.environ.get(env, "")
    if val != "":
        acct[key] = val
print(json.dumps([acct], indent=4, ensure_ascii=False))
'
            ;;
    esac
}

cmd_get() {
    parse_get_args "$@"

    [ "$(uname -s)" = "Darwin" ] || die "当前导出脚本仅支持 macOS，请在已登录 Kiro IDE 的 Mac 上运行"

    info "读取 Kiro IDE 本地凭证"

    # --- token 文件 ---
    [ -f "$TOKEN_FILE" ] || die "找不到 ${TOKEN_FILE}，请先在 Kiro IDE 中登录"
    jvalid "$TOKEN_FILE" || die "$TOKEN_FILE 不是合法 JSON，可能正被 Kiro IDE 写入，请稍后重试"
    step "token: $TOKEN_FILE"

    F_REFRESH_TOKEN="$(jread "$TOKEN_FILE" refreshToken)"
    [ -n "$F_REFRESH_TOKEN" ] || die "$TOKEN_FILE 里没有 refreshToken，请在 Kiro IDE 中重新登录"

    F_PROFILE_ARN="$(jread "$TOKEN_FILE" profileArn)"
    local raw_auth_method raw_region client_id_hash expires_at provider
    raw_auth_method="$(jread "$TOKEN_FILE" authMethod)"
    raw_region="$(jread "$TOKEN_FILE" region)"
    client_id_hash="$(jread "$TOKEN_FILE" clientIdHash)"
    expires_at="$(jread "$TOKEN_FILE" expiresAt)"
    provider="$(jread "$TOKEN_FILE" provider)"

    # kiro-proxy 侧的 authMethod 取值是小写 social / idc
    F_AUTH_METHOD="$(printf '%s' "$raw_auth_method" | tr '[:upper:]' '[:lower:]')"
    [ -n "$F_AUTH_METHOD" ] || F_AUTH_METHOD="idc"

    F_AUTH_REGION="${raw_region:-$DEFAULT_REGION}"
    F_API_REGION="$F_AUTH_REGION"

    # --- profileArn 兜底：token 文件里没有就翻 Kiro IDE 日志 ---
    if [ -z "$F_PROFILE_ARN" ]; then
        if find_profile_arn_in_logs; then
            step "profileArn: ${PROFILE_ARN_LOG_FILE}（token 文件里没有，取自日志）"
        else
            die "没有找到 profileArn，尝试重新登录 kiro（已查 ${TOKEN_FILE} 与 ${KIRO_LOG_DIR}）"
        fi
    fi

    # --- client 注册文件（social 登录不需要） ---
    F_CLIENT_ID=""
    F_CLIENT_SECRET=""
    if [ "$F_AUTH_METHOD" = "social" ]; then
        step "authMethod=social，跳过 clientId / clientSecret"
    else
        if find_client_reg "$client_id_hash"; then
            F_CLIENT_ID="$(jread "$CLIENT_REG_FILE" clientId)"
            F_CLIENT_SECRET="$(jread "$CLIENT_REG_FILE" clientSecret)"
            step "client: $CLIENT_REG_FILE"
            if [ "$CLIENT_REG_VIA_FALLBACK" -eq 1 ]; then
                if [ -n "$client_id_hash" ]; then
                    warn "clientIdHash=$client_id_hash 对应的文件不可用，已回退到修改时间最新的注册文件（见上一行）"
                else
                    warn "token 里没有 clientIdHash，已回退到修改时间最新的注册文件（见上一行）"
                fi
            fi
        else
            die "在 $SSO_CACHE_DIR 里找不到含 clientId/clientSecret 的注册文件，请确保已在 Kiro IDE 中完成登录"
        fi
    fi

    # --- machineId ---
    local machine_id_file
    machine_id_file="$(find_machine_id)"
    F_MACHINE_ID=""
    if [ -n "$machine_id_file" ]; then
        F_MACHINE_ID="$(tr -d '[:space:]' < "$machine_id_file")"
        step "machineId: $machine_id_file"
    fi
    if [ -z "$F_MACHINE_ID" ]; then
        warn "没读到 machineId，该字段将省略（代理会用 refreshToken 派生一个稳定的兜底值）"
    else
        # 代理侧接受 64 位 hex 或 UUID（去连字符后 32 位 hex），其余格式会被忽略
        local stripped
        stripped="$(printf '%s' "$F_MACHINE_ID" | tr -d '-')"
        case "${#stripped}" in
            32|64) : ;;
            *) warn "machineId 格式不常见（去连字符后 ${#stripped} 字符），代理可能忽略它并改用兜底值" ;;
        esac
    fi

    # --- email ---
    if [ "$GET_EMAIL_GIVEN" -eq 1 ]; then
        F_EMAIL="$GET_EMAIL"
        [ -n "$F_EMAIL" ] || die "--email 不能为空"
        email_looks_valid "$F_EMAIL" || die "--email 传入的「${F_EMAIL}」不是合法邮箱（需含 @ 且不含空格）"
    else
        echo
        prompt_email
        F_EMAIL="$GET_EMAIL"
    fi

    # --- 构造 JSON ---
    local payload
    payload="$(build_json)"

    echo
    info "账户信息"
    printf '  %-13s %s\n' "email"        "${F_EMAIL:-（留空）}"
    printf '  %-13s %s\n' "authMethod"   "$F_AUTH_METHOD${provider:+ / provider=$provider}"
    printf '  %-13s %s\n' "region"       "$F_AUTH_REGION"
    [ -n "$F_CLIENT_ID" ]     && printf '  %-13s %s\n' "clientId"     "$F_CLIENT_ID"
    [ -n "$F_CLIENT_SECRET" ] && printf '  %-13s %s\n' "clientSecret" "$(redact "$F_CLIENT_SECRET")"
    printf '  %-13s %s\n' "refreshToken" "$(redact "$F_REFRESH_TOKEN")"
    [ -n "$F_PROFILE_ARN" ]   && printf '  %-13s %s\n' "profileArn"   "$F_PROFILE_ARN"
    [ -n "$F_MACHINE_ID" ]    && printf '  %-13s %s\n' "machineId"    "$F_MACHINE_ID"

    # --- 输出 ---
    local clipboard_copied=0
    if copy_to_clipboard "$payload"; then
        clipboard_copied=1
    fi

    if [ -n "$GET_OUT_FILE" ]; then
        printf '%s\n' "$payload" > "$GET_OUT_FILE"
        chmod 600 "$GET_OUT_FILE" 2>/dev/null || true
        ok "已写入 ${GET_OUT_FILE}（权限 600，内含长期凭证，用完请删除）"
    fi

    # --- 提示 ---
    if [ -n "$expires_at" ]; then
        echo
        local exp_epoch now
        exp_epoch="$(iso_to_epoch "$expires_at")"
        now="$(date +%s)"
        if [ -n "$exp_epoch" ] && [ "$exp_epoch" -le "$now" ]; then
            warn "accessToken 已于 $(iso_to_local "$expires_at") 过期。"
            warn "  refreshToken 通常仍然可用（导入后代理会自己刷新）；若导入验活失败，"
            warn "  请先在 Kiro IDE 里操作一次触发刷新，再重新运行本命令。"
        elif [ -n "$exp_epoch" ]; then
            local left_min=$(( (exp_epoch - now) / 60 ))
            local span
            if [ "$left_min" -lt 1 ]; then
                span="不到 1 分钟"
            elif [ "$left_min" -lt 60 ]; then
                span="${left_min} 分钟"
            elif [ "$left_min" -lt 1440 ]; then
                span="约 $(( left_min / 60 )) 小时"
            else
                span="约 $(( left_min / 1440 )) 天"
            fi
            info "过期时间 $(iso_to_local "$expires_at")，请在${span}内使用"
        else
            info "过期时间 ${expires_at}"
        fi
    fi

    # 完整 JSON 放在结尾，复制失败时也能直接手动复制。
    if [ "$GET_PRINT_STDOUT" -eq 1 ]; then
        echo
        info "账户 JSON（可手动复制下方内容）"
        printf '%s\n' "$payload"
    fi
    echo
    printf '%s\n' '============================================================'
    if [ "$clipboard_copied" -eq 1 ]; then
        if [ -t 1 ]; then printf '\033[1;32m'; fi
        ok "已复制到剪贴板，请返回浏览器确认导入"
    else
        if [ -t 1 ]; then printf '\033[1;33m'; fi
        printf '  ! 未能复制到剪贴板，请手动复制上面的账户 JSON\n'
    fi
    if [ -t 1 ]; then printf '\033[0m'; fi
    printf '%s\n' '============================================================'
}

# =====================================================================
# set —— 骨架，具体能力待实现
# =====================================================================

set_stub() {
    local target="$1"
    err "set $target 尚未实现"
    echo >&2
    printf '将来该子命令会修改：\n' >&2
    case "$target" in
        cc)
            printf '  ~/.claude/settings.json      合并 env.ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN\n' >&2
            ;;
        codex)
            printf '  ~/.codex/config.toml         顶层 model_provider + [model_providers.kiro] 段\n' >&2
            printf '  ~/.codex/.env                KIRO_API_KEY\n' >&2
            ;;
        all)
            printf '  ~/.claude/settings.json      合并 env.ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN\n' >&2
            printf '  ~/.codex/config.toml         顶层 model_provider + [model_providers.kiro] 段\n' >&2
            printf '  ~/.codex/.env                KIRO_API_KEY\n' >&2
            ;;
    esac
    exit 1
}

cmd_set() {
    if [ $# -lt 1 ]; then
        err "set 需要一个子命令"
        printf '可用子命令：cc | codex | all\n' >&2
        exit 1
    fi

    local sub="$1"; shift
    case "$sub" in
        -h|--help)
            usage; exit 0
            ;;
        cc|codex|all)
            set_stub "$sub"
            ;;
        *)
            err "set: 未知子命令 '$sub'"
            printf '可用子命令：cc | codex | all\n' >&2
            exit 1
            ;;
    esac
}

# =====================================================================
# 入口
# =====================================================================

usage() {
    cat <<EOF
$SCRIPT_NAME —— Kiro 账户凭证导出 / 客户端配置工具（仅 macOS）

用法：
  $SCRIPT_NAME get [选项]
  $SCRIPT_NAME set <cc|codex|all>

get —— 读取本机 Kiro IDE 登录凭证，拼成 kiro-proxy 批量导入所需的 JSON
        并复制到剪贴板。只读磁盘，不会刷新 token、不会影响 IDE 登录状态。

  --email <地址>   直接指定邮箱，跳过交互提示（必须含 @）
  --stdout         兼容选项，默认已在结尾打印完整 JSON 和剪贴板复制结果
  --out <文件>     同时写入文件（权限 600）
  -h, --help       显示本帮助

set —— 把 Claude Code / Codex CLI 指向 kiro-proxy

  cc               配置 ~/.claude/settings.json
  codex            配置 ~/.codex/config.toml 与 ~/.codex/.env
  all              两者都配

读取的文件：
  ~/.aws/sso/cache/kiro-auth-token.json    refreshToken / profileArn / region / authMethod
  ~/.aws/sso/cache/<clientIdHash>.json     clientId / clientSecret
  ~/Library/Application Support/kiro/machineid
  ~/.kiro/logs/<启动时间戳>/*.log           profileArn 兜底（token 文件里没有时按时间从新到旧翻）
EOF
}

main() {
    if [ $# -lt 1 ]; then
        usage
        exit 1
    fi

    detect_json_tool

    local cmd="$1"; shift
    case "$cmd" in
        get)        cmd_get "$@" ;;
        set)        cmd_set "$@" ;;
        -h|--help)  usage ;;
        *)
            err "未知命令 '$cmd'"
            printf '可用命令：get | set\n' >&2
            exit 1
            ;;
    esac
}

main "$@"
