#!/usr/bin/env bash
# 还原 dsh-mobile 会话首页上限补丁：从最近一次 apply.sh 生成的备份还原。
set -euo pipefail

LIB="${DSH_INSTALL:-$HOME/dsh-app}/node_modules/@deepseek-ai/dsh-api-session-controller/lib"
BK=$(ls -d "${BACKUP_DIR:-$HOME}"/dsh-page-cap-backup-* 2>/dev/null | sort | tail -1)
if [ -z "${BK:-}" ]; then
  echo "no backup found under Work/backups/dsh-page-cap-*" >&2
  exit 1
fi
echo "restoring from $BK"
cp "$BK/index.js" "$LIB/index.js"
cp "$BK/types/history.js" "$LIB/types/history.js"
node --check "$LIB/index.js" && node --check "$LIB/types/history.js"
echo "reverted -- restart dsh-web.service to activate"
