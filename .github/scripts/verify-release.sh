#!/usr/bin/env bash
# 构建产物校验：版本号一致 + 产物没夹带私货。
# 由 .github/workflows/release.yml 调用，也可以本地跑：
#
#   bash .github/scripts/verify-release.sh
set -eu

cd "$(dirname "$0")/../.."

OUT=dist/index.user.js

test -f "$OUT" || { echo "::error::$OUT 没生成"; exit 1; }

# package.json 与产物里的 @version 必须一致，否则油猴会一直认为没更新
pkg=$(node -p "require('./package.json').version")
meta=$(grep -m1 -E '^// @version' "$OUT" | sed -E 's|^//[[:space:]]*@version[[:space:]]+||' | tr -d '[:space:]')
echo "package.json=$pkg  @version=$meta"
[ "$pkg" = "$meta" ] || { echo "::error::版本号不一致：package.json=$pkg / @version=$meta"; exit 1; }

# 私有域名黑名单：这个文件不入库（只在本地存在），所以检查能生效而仓库仍然干净。
# 每行一个域名，支持 # 注释与空行。
BLACKLIST=.github/scripts/private-hosts.txt
if [ -f "$BLACKLIST" ]; then
  hits=''
  while IFS= read -r word; do
    case "$word" in ''|'#'*) continue ;; esac
    if grep -qF "$word" "$OUT"; then hits="$hits $word"; fi
  done < "$BLACKLIST"
  if [ -n "$hits" ]; then
    echo "::error::产物里出现了私有域名：$hits"
    exit 1
  fi
  echo "私有域名检查：通过"
else
  echo "私有域名检查：跳过（本地没有 $BLACKLIST）"
fi

# 再挡一道本地开发路径
if grep -qE '[A-Za-z]:[\\/]Users[\\/]' "$OUT"; then
  echo "::error::产物里混进了本地路径"
  grep -nE '[A-Za-z]:[\\/]Users[\\/]' "$OUT" | head -n 5
  exit 1
fi

ls -l dist/
echo "校验通过"
