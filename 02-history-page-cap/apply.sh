#!/usr/bin/env bash
# 给 DSH 的会话历史分页加"外发帧上限"，避免 dsh-mobile 隧道被中继 1009 打死。
# 幂等：已打过补丁会跳过。生效需要重启 dsh-web.service。
set -euo pipefail

LIB="${DSH_INSTALL:-$HOME/dsh-app}/node_modules/@deepseek-ai/dsh-api-session-controller/lib"
STAMP=$(date +%Y%m%d-%H%M%S)
BK="${BACKUP_DIR:-$HOME/dsh-page-cap-backup-$STAMP}"

if grep -q "local patch (dsh-mobile frame cap)" "$LIB/index.js"; then
  echo "already patched: $LIB/index.js"
  exit 0
fi

mkdir -p "$BK"
cp "$LIB/index.js" "$LIB/types/history.js" "$BK/"
echo "backup -> $BK"

python3 - "$LIB" <<'PY'
import sys
lib = sys.argv[1]
PATCH_JS = """function paginate(events, beforeSeq, maxMessages, throughSeq, turnWindow) {
%s// local patch (dsh-mobile frame cap): a session snapshot is ONE WebSocket frame;
%s// the Companion re-encodes it twice (base64 then E2EE base64 = x1.78) and the
%s// public relay closes the device socket with 1009 above its 4 MiB frame limit,
%s// which also tears down every phone tunnel. Keep the opening page small.
%smaxMessages = Math.min(maxMessages ?? 50, 40);
%sif (turnWindow) turnWindow = { minMessages: Math.min(turnWindow.minMessages, 8), minTurns: 1 };
%s// end local patch
%sconst end = SessionLogOffset(Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1));"""
for name, ind in (("index.js", "\t"), ("types/history.js", "    ")):
    path = f"{lib}/{name}"
    src = open(path, encoding="utf8").read()
    anchor = ("function paginate(events, beforeSeq, maxMessages, throughSeq, turnWindow) {\n"
              + ind + "const end = SessionLogOffset(Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1));")
    if anchor not in src:
        raise SystemExit(f"{name}: anchor not found (already patched or DSH changed)")
    src = src.replace(anchor, PATCH_JS % tuple([ind] * 8), 1)
    open(path, "w", encoding="utf8").write(src)
    print(f"{name}: patched")
PY

node --check "$LIB/index.js"
node --check "$LIB/types/history.js"
echo "syntax OK -- restart dsh-web.service to activate:"
echo "  systemd-run --user --on-active=40 --unit=dsh-page-cap-restart systemctl --user restart dsh-web.service"
