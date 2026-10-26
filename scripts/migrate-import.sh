#!/bin/sh
# 在新机器上导入迁移包：恢复 .env、config/、roles/ 和七个卷，然后跑部署前检查。
# 用法：scripts/migrate-import.sh /path/to/qqbot-migrate-<时间>.tar
# 会覆盖本项目现有的 .env、config/、roles/ 和卷（覆盖前把旧的 .env/config 存到 backups/pre-import-<时间>/）。
set -eu

cd "$(dirname "$0")/.."
BUNDLE="${1:?用法：scripts/migrate-import.sh qqbot-migrate-<时间>.tar}"
test -f "$BUNDLE" || { echo "找不到 $BUNDLE" >&2; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="backups/import-$STAMP"
umask 077
mkdir -p "$WORK"
tar -C "$WORK" -xf "$BUNDLE"
test -f "$WORK/dot-env" && test -f "$WORK/config-and-roles.tar.gz" || { echo "$BUNDLE 不是迁移包" >&2; exit 1; }
echo "迁移包信息："; sed 's/^/  /' "$WORK/MANIFEST" 2>/dev/null || true

if docker compose ps -q 2>/dev/null | grep -q .; then
  echo "本项目有容器在运行，先 docker compose down 再导入" >&2; exit 1
fi

# 先留一份旧的
if [ -f .env ] || [ -f config/qq-bridge/config.json ]; then
  mkdir -p "backups/pre-import-$STAMP"
  cp -p .env "backups/pre-import-$STAMP/" 2>/dev/null || true
  cp -pR config roles "backups/pre-import-$STAMP/" 2>/dev/null || true
fi

cp "$WORK/dot-env" .env
chmod 600 .env
# 只拿 config/ 和 roles/：代码、补丁、docker-compose.yml 以 git 里的版本为准
tar -xzf "$WORK/config-and-roles.tar.gz" config roles
chmod 640 config/qq-bridge/config.json
chmod 644 config/extras.json config/dsh/home.cordis.patch.yml roles/*.md

scripts/restore.sh "$WORK" -y
rm -rf "$WORK"

echo
scripts/preflight.sh --fix || true
echo
echo "下一步：docker compose build && docker compose up -d，然后到 http://127.0.0.1:6081 点一次登录（见 docs/MIGRATION-WSL.md）"
