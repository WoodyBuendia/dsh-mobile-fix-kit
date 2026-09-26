#!/bin/bash
# ============================================================================
# 给 @april-jk/dsh-mobile 重新打上「DSH Web 授权」补丁
#
# 什么时候需要跑它：
#   - 执行过 `dsh plugin --profile web update/install`（会覆盖 dist/，补丁丢失）
#   - 重新安装了该插件
#
# 用法：
#   ./apply.sh              # 应用到默认 profile
#   ./apply.sh <包目录>      # 应用到指定包目录
#   ./apply.sh <包目录> --force   # 版本不一致时强行覆盖
#
# 注意：应用后**必须重启 dsh-web.service** 才生效 —— dsh 的 patchReload:"live"
# 只重建 loader 条目、不重新导入模块（已实测：禁用→启用后条目回来了，但新代码
# 的日志与路由都不出现），改了 dist/ 只有新进程才会加载。
# ============================================================================
set -euo pipefail

PATCH_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG="${1:-${DSH_MOBILE_PKG:-$HOME/.dsh/profiles/web/node_modules/@april-jk/dsh-mobile}}"
DIST="$PKG/dist"
FORCE="${2:-}"

if [ ! -d "$DIST" ]; then
  echo "错误：找不到 $DIST" >&2
  exit 1
fi

VERSION="$(python3 -c "import json;print(json.load(open('$PKG/package.json'))['version'])")"
EXPECTED="$(sed -n 's/^权威副本对应插件版本: *//p' "$PATCH_DIR/VERSION.txt")"
echo "已安装插件版本 : $VERSION"
echo "权威副本基于   : $EXPECTED"

if [ "$VERSION" != "$EXPECTED" ] && [ "$FORCE" != "--force" ]; then
  cat >&2 <<EOF

错误：版本不一致，拒绝直接覆盖。
权威副本是整文件拷贝，只对 $EXPECTED 成立；把它盖到 $VERSION 上会带回旧逻辑。
处理办法二选一：
  1) 先用 $VERSION 的原始 dist 重新派生补丁（见 README.md 的「升级插件后怎么重修」），
     再把新副本放进本目录并更新 VERSION.txt；
  2) 确认插件结构没变时，用 --force 强行覆盖。
EOF
  exit 2
fi

if grep -q "local patch" "$DIST/plugin.js" 2>/dev/null && [ "$FORCE" != "--force" ]; then
  echo "plugin.js 已含补丁，无需重复应用（要强制覆盖请加 --force）。"
  exit 0
fi

BK="$PATCH_DIR/backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK"
cp "$DIST/plugin.js" "$BK/plugin.js"
cp "$DIST/relay-client.js" "$BK/relay-client.js"
echo "原始文件已备份到 $BK"

cp "$PATCH_DIR/plugin.js" "$DIST/plugin.js"
cp "$PATCH_DIR/relay-client.js" "$DIST/relay-client.js"

for f in plugin.js relay-client.js; do
  node --check "$DIST/$f" || { echo "错误：$f 语法检查失败" >&2; exit 1; }
done
echo "补丁已应用，语法检查通过。"

cat <<'EOF'

下一步（必须做，否则不生效）：
  systemctl --user restart dsh-web.service

重启后验证（等约 12 秒再打，插件铸造 cookie 有重试）：
  curl -s http://127.0.0.1:3080/dsh-mobile-authprobe
应看到 "verdict":"PASS: DSH accepted the forwarded request"。

注意：重启会让访问 URL 里的 token 换新（配对凭据存在 ~/.dsh-remote/config.json，
不会丢，手机不需要重新扫码）：
  grep -o 'http://127.0.0.1:3080[^ ]*' "${DSH_WEB_LOG:-$HOME/dsh-app/web.log}" | tail -1
EOF
