# 页间激活服务器

`folio-license.mjs` 是页间会员的激活服务器：页间里用微信或支付宝买会员（通过[简付](https://jian-pay.com/docs)收款），付完在这里生成激活码并直接开通到买家的电脑上；送人的激活码也在这里激活，退款时在这里作废。页间每次收到的都是服务器用私钥签过名的“会员凭证”，应用里只有公钥，所以改应用数据文件或者假冒服务器都没用。

只需要 Node.js 22.13 或更新版本，不用 `npm install`。数据存在一个 SQLite 文件里。

激活码的生成、查询、作废用 Mac 应用「页间激活码管理」，代码在 `/Users/xxy/resources/chat-ai/claudecode/manage-activeCode`（见那里的 README）。

## 规则

- 价格：30 天 ¥19.9，365 天 ¥99，永久 ¥298；永久在 2026 年 11 月 12 日前是早鸟价 ¥198。改价格、改早鸟截止时间，改 `folio-license.mjs` 开头的 `prices` 再部署，不用发新版页间。
- 永久会员没有到期时间。永久码作废（退款）后，这台电脑回到其他码的天数。
- 升级永久时，这台电脑上买来的 30 天、365 天会员按剩余天数折算抵扣：每笔订单的实付金额 × 剩余天数 / 总天数，还没开始的（排在后面的）全额算，合计四舍五入到整元。试用和送的码不抵扣。最少付 ¥1。抵扣多少记在订单上，管理应用里能看到。
- 激活码 16 位（`XXXX-XXXX-XXXX-XXXX`），去掉了 0/O、1/I/L 这些容易看错的字。
- 一个码同一时间只在一台电脑上用。别人再输入同一个码，会提示“正在另一台电脑上使用”。
- 换电脑：在新电脑上输入同一个码，确认后会员转过去，旧电脑上的会员停用。7 天内只能转一次（管理应用里的「允许立即换电脑」可以帮用户解除）。
- 会员没到期时再激活新码，天数接在后面。
- 每台电脑可以免费试用 3 天，只能试用一次，重装也不行。
- 作废（退款）后，用户的电脑下次联网检查时会员就没了。页间开着时每 6 小时检查一次，打开会员窗口时也会检查。
- 断网时会员最多保留 7 天，到时间没联网，PDF 和 AI 就先停用，联网后自动恢复。所以作废的码在一直断网的电脑上最多还能用 7 天。

时长、价格等数字在 `folio-license.mjs` 开头的 `plans`、`prices` 和 `rules` 里。

## 在线购买（简付）

1. 页间请服务器下单（`/order`），服务器按当前价格向简付下单，把简付收银台的地址交给页间，页间把它显示成二维码。微信扫就用微信付，支付宝扫就用支付宝付。
2. 付完简付通知服务器（`https://helloxxy.com/api/folio/pay/notify`）。服务器验签、核对金额，生成一个这个套餐的激活码，直接激活在下单的电脑上。
3. 页间开着二维码时每 2 秒问一次（`/order-status`）。通知还没到的话，服务器自己向简付查单。付完后关了窗口也没关系，下次打开页间或会员窗口时会查到。

商户号和密钥在简付控制台的「API安全」页面，存成 `~/.folio-license/jianpay.json`：

```json
{ "clientNo": "JP…", "key": "…" }
```

`deploy.sh` 每次都会把它传到服务器的 `/etc/folio-license/jianpay.json`。没有这个文件时页间里不能购买，只能输入激活码。简付的接口手续费是预充值的，余额不够时下单会失败，记得在简付控制台充值。

退款：在简付控制台退钱，再在「页间激活码管理」里搜订单号（简付单号或页间单号都行）找到激活码，点「作废（退款）」。

## 部署和更新

```sh
bash server/deploy.sh
```

用的是 PersonalHomePage 部署网站时配好的 SSH 免密登录（`root@8.133.216.33`）。第一次运行会：

1. 在 `/opt/folio-license/node` 装一份这个服务专用的 Node 24（版本和校验值取自 nodejs.org，安装包从国内镜像下），不影响宝塔和别的程序。
2. 上传 `folio-license.mjs` 到 `/opt/folio-license/`，私钥和管理口令到 `/etc/folio-license/`（只有 root 和服务能读），数据库放在 `/var/lib/folio-license/`。
3. 建系统用户 `folio-license`，装 systemd 服务 `folio-license`（开机自启，崩了 3 秒后自动重启），只监听本机 8787 端口。
4. 把 `nginx-folio-license.conf` 放进宝塔站点的扩展配置目录 `/www/server/panel/vhost/nginx/extension/helloxxy.com/`，让 `https://helloxxy.com/api/folio/` 转到这个服务。站点主配置不改，PersonalHomePage 的 `deploy.sh` 只同步网站目录，也碰不到它。
5. 检查配置后重载 nginx，最后访问 `https://helloxxy.com/api/folio/health` 确认能用。

以后改了 `folio-license.mjs`，再运行一次就行：只更新文件、重启服务，数据库原样保留并自动升级。服务器上已经有私钥和管理口令时不会覆盖；如果和本机的不一样，脚本会停下来。

私钥和管理口令不在仓库里，只在你 Mac 的 `~/.folio-license/` 里。**把这两个文件另外备份一份**（比如存进密码管理器）：

- 私钥丢了，已发布的页间就不认新的凭证了，只能换一对密钥再发一个新版本。
- 私钥泄露了，别人能自己签会员。这时同样要换密钥、发新版本。

在服务器上查看服务：`systemctl status folio-license`，日志：`journalctl -u folio-license -n 50`。

## 日常

打开「页间激活码管理」（在“应用程序”里）：

- **生成**：选时长、数量、备注，生成送人用的码，一行一个存成 txt（`~/.folio-license/batches/`）。买的码不用生成，付款后服务器自动生成，备注是「在线购买」。
- **激活码**：搜索（激活码或订单号）、筛选、查看某个码在哪台电脑上、会员到哪天、哪笔订单买的。退款时先在简付控制台退钱，再点「作废（退款）」。作废只扣这个码的天数：用户同一台电脑上如果还有别的码，那些天数照常有效。
- **概览**：会员人数、在线收入、试用、各批次、最近记录。
- 右上角「下载备份」：服务器数据库下载到 `~/.folio-license/backups/`。

## 备份

服务器每天把数据库复制一份到 `/var/lib/folio-license/backups/`，保留最近 14 天。服务器硬盘坏了这些也会丢，所以 Mac 上也每天自动下载一份到 `~/.folio-license/backups/`，保留 30 天（由「页间激活码管理」项目的 `npm run install-backup` 装好，见那里的 README）。

恢复：停掉服务，把备份文件改名成 `/var/lib/folio-license/license.db` 放回去（删掉旁边的 `license.db-wal`、`license.db-shm`），再启动。

## 本机测试

本机的 Node 低于 22.13 时，可以借用 Electron 自带的 Node：

```sh
ELECTRON_RUN_AS_NODE=1 PORT=8799 FOLIO_LICENSE_DATA=/tmp/folio-license \
  FOLIO_LICENSE_KEY=~/.folio-license/license-private.pem \
  FOLIO_LICENSE_ADMIN_TOKEN=~/.folio-license/admin-token \
  node_modules/.bin/electron server/folio-license.mjs
```

开发版页间用 `FOLIO_LICENSE_SERVER=http://127.0.0.1:8799/api/folio` 连它，用 `FOLIO_LICENSE_DEVICE=任意名字` 假装成另一台电脑。管理应用同样用 `FOLIO_LICENSE_SERVER` 指过去。打包后的页间不认 `FOLIO_LICENSE_DEVICE` 和测试用的 `FOLIO_MEMBER`。
