#!/usr/bin/env bash
# 部署或更新页间的激活服务器（阿里云轻量服务器 + 宝塔面板，helloxxy.com）。
#   bash server/deploy.sh
# 第一次运行：装一份服务专用的 Node、建系统用户和目录、放私钥和管理口令、装 systemd 服务、
# 加 nginx 反向代理。以后再运行：只更新 folio-license.mjs 和配置，重启服务。
# 用的是 PersonalHomePage 部署网站时配好的 SSH 免密登录。
set -euo pipefail

SERVER="root@8.133.216.33"
HERE="$(cd "$(dirname "$0")" && pwd)"
SECRETS="$HOME/.folio-license"
for f in "$SECRETS/license-private.pem" "$SECRETS/admin-token"; do
  test -f "$f" || { echo "缺少 $f" >&2; exit 1; }
done

echo "→ 上传服务"
ssh -o ConnectTimeout=10 "$SERVER" 'mkdir -p /opt/folio-license /etc/folio-license /var/lib/folio-license /www/server/panel/vhost/nginx/extension/helloxxy.com'
scp -q "$HERE/folio-license.mjs" "$SERVER:/opt/folio-license/folio-license.mjs"
scp -q "$HERE/folio-license.service" "$SERVER:/etc/systemd/system/folio-license.service"
scp -q "$HERE/nginx-folio-license.conf" "$SERVER:/www/server/panel/vhost/nginx/extension/helloxxy.com/folio-license.conf"

# 私钥和管理口令：服务器上没有才上传。已有但和本机不同就停下，免得已发出的会员凭证对不上。
echo "→ 私钥和管理口令"
for pair in "license-private.pem:private.pem" "admin-token:admin-token"; do
  local_file="$SECRETS/${pair%%:*}"
  remote_file="/etc/folio-license/${pair#*:}"
  remote_sum=$(ssh "$SERVER" "sha256sum $remote_file 2>/dev/null | cut -d' ' -f1")
  local_sum=$(shasum -a 256 "$local_file" | cut -d' ' -f1)
  if [[ -z "$remote_sum" ]]; then
    scp -q "$local_file" "$SERVER:$remote_file"
  elif [[ "$remote_sum" != "$local_sum" ]]; then
    echo "服务器上的 $remote_file 和本机的 $local_file 不一样，先弄清楚用哪一份再部署" >&2
    exit 1
  fi
done

# 简付的商户号和密钥：本机有就每次都传上去（在简付控制台换了密钥，改本机这份再部署一次）。
if [[ -f "$SECRETS/jianpay.json" ]]; then
  echo "→ 简付商户配置"
  scp -q "$SECRETS/jianpay.json" "$SERVER:/etc/folio-license/jianpay.json"
else
  echo "  没有 $SECRETS/jianpay.json，页间里暂时不能在线购买"
fi

echo "→ 配置服务器"
ssh "$SERVER" bash -s <<'REMOTE'
set -euo pipefail
NODE=/opt/folio-license/node/bin/node
# Node 22.13+ 才有 node:sqlite。版本号和校验值从 nodejs.org 取，安装包先从国内镜像下。
if ! "$NODE" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' 2>/dev/null; then
  sums=$(curl -fsSL -m 30 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt)
  line=$(grep -E ' node-v[0-9.]+-linux-x64\.tar\.xz$' <<<"$sums")
  file=${line##* }
  version=${file#node-}; version=${version%%-linux*}
  echo "  安装 Node $version"
  curl -fsSL -m 600 -o "/tmp/$file" "https://registry.npmmirror.com/-/binary/node/$version/$file" ||
    curl -fsSL -m 600 -o "/tmp/$file" "https://nodejs.org/dist/$version/$file"
  (cd /tmp && sha256sum -c - <<<"$line" >/dev/null)
  rm -rf /opt/folio-license/node && mkdir -p /opt/folio-license/node
  tar -xJf "/tmp/$file" -C /opt/folio-license/node --strip-components=1
  rm -f "/tmp/$file"
fi
echo "  Node $("$NODE" -v)"

id folio-license >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin folio-license
chown -R root:folio-license /etc/folio-license
chmod 750 /etc/folio-license
chmod 640 /etc/folio-license/*
chown -R folio-license:folio-license /var/lib/folio-license

systemctl daemon-reload
systemctl enable folio-license >/dev/null 2>&1
systemctl restart folio-license
for i in $(seq 30); do
  curl -fsS http://127.0.0.1:8787/api/folio/health >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS http://127.0.0.1:8787/api/folio/health >/dev/null || {
  journalctl -u folio-license -n 30 --no-pager
  exit 1
}

/www/server/nginx/sbin/nginx -t -q
/www/server/nginx/sbin/nginx -s reload
REMOTE

echo "→ 检查"
sleep 1
curl -fsS https://helloxxy.com/api/folio/health && echo
echo "✓ 激活服务器已部署：https://helloxxy.com/api/folio"
