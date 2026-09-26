#!/usr/bin/env bash
# 一键应用本手册的两个补丁（§A/§B 的插件补丁 + §C 的宿主分页上限）。
# 幂等；每步都会先备份。生效需要重启 dsh-web.service。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="${DSH_MOBILE_PKG:-$HOME/.dsh/profiles/web/node_modules/@april-jk/dsh-mobile}"

if [ ! -d "$PKG/dist" ]; then
  echo "找不到插件目录 $PKG（可用 DSH_MOBILE_PKG 指定）" >&2
  exit 1
fi

echo "== [1/2] §A/§B 插件补丁（cookie 注入 + 中继看门狗）=="
if bash "$HERE/01-dsh-web-auth/apply.sh" "$PKG"; then
  echo "   ok"
else
  echo "   失败：多半是插件版本不是 0.1.5。请按 README §A 的两个坑手工移植。" >&2
fi

echo "== [2/2] §C 宿主分页上限（压小会话首页，避免超中继 4 MiB 单帧上限）=="
bash "$HERE/02-history-page-cap/apply.sh"

cat <<'EOF'

两个补丁都已就位。生效（会掐断当前 dsh-web 会话，用延迟重启先让回复送达）：

  systemd-run --user --on-active=40 --unit=dsh-fix-restart systemctl --user restart dsh-web.service

手机侧：把 App 从「最近任务」划掉再打开（卡死态不会自恢复）。
回滚：bash 02-history-page-cap/revert.sh（01 请从 apply 时输出的备份目录还原）。
EOF
