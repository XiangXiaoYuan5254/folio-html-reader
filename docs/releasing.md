# 发布 macOS 安装包

环境：macOS、Node.js 22.13+。PDF 渲染资源随应用离线打包，使用 electron-builder 只为 Apple 芯片 arm64 打包。

```sh
npm ci
npm test
npm run test:e2e
npm run dist:mac
```

`release/` 会包含 arm64 的 DMG、`SHA256SUMS.txt`，以及自动更新用的 zip、`.zip.blockmap` 和 `latest-mac.yml`（见下文「自动更新」）。DMG 中包含页间、Applications 文件夹快捷方式和中文安装说明。安装包只包含 `samples/` 中的原创演示资料。

发布前检查：

```sh
hdiutil verify release/Folio-版本号-mac-arm64.dmg
codesign --verify --deep --strict release/mac-arm64/页间.app
```

在独立的临时用户目录启动打包应用，检查首次启动、演示文档和批注保存。当前不构建或发布 Intel 版本。

## Windows 版本

在 Mac 上即可交叉构建，不需要 Windows 或 Wine：

```sh
npm run dist:win
```

`release/` 会生成：

- `Folio-版本号-win-x64-setup.exe`：中文安装向导，默认只为当前用户安装（无需管理员权限），可改安装位置，创建开始菜单和桌面快捷方式“页间”。
- `SHA256SUMS.txt`：包含 `release/` 中同版本 Mac 与 Windows 的全部安装包。先后运行 `dist:mac` 和 `dist:win`，得到一份合并的校验文件。
- `.exe.blockmap` 和 `latest.yml`：自动更新用。

支持 Windows 10 / 11 x64，Windows on ARM 可以通过系统自带的 x64 转译运行。

Windows 的语音对话用到 sherpa-onnx 的原生模块，npm 在 Mac 上只装 Mac 版。`dist:win` 先运行 `scripts/win-native.mjs`，按 `package-lock.json` 锁定的版本和校验值把 `sherpa-onnx-win-x64` 放进 `node_modules`，Mac 和 Linux 版不打进 Windows 安装包。打包后可以确认 `release/win-unpacked/resources/app.asar.unpacked/node_modules/` 下只有 `sherpa-onnx-node` 和 `sherpa-onnx-win-x64`。

安装程序通过 `build/installer.nsh`，在资源管理器的“打开方式”中加入页间（`.html` / `.htm`），不改变用户的默认浏览器；卸载时移除这些注册表项。该文件须保持纯 ASCII。

与 Mac 版的差异：

- 窗口右上角使用 Windows 原生的最小化、最大化、关闭按钮，菜单栏隐藏，快捷键照常可用（`Ctrl+O`、`Ctrl+S`、`Ctrl+F`、`Ctrl+Shift+F`、`F11`）。
- 界面快捷键提示显示为 `Ctrl`，“访达”“废纸篓”显示为“资源管理器”“回收站”。`Ctrl` + 滚轮缩放正文，`Ctrl+Y` 也可重做。
- 从资源管理器复制的文件可直接粘贴进项目（通过系统自带的 PowerShell 读取剪贴板）。
- 应用数据位于 `%APPDATA%\页间`。

GitHub Actions 的 `Windows` 工作流（`.github/workflows/windows.yml`）在 Windows 虚拟机上自动检查：它在 Windows 上构建安装程序，静默安装后核对“打开方式”注册表项和开始菜单快捷方式，再用 `tests/windows.e2e.mjs` 测试安装好的应用（首次启动、标题栏按钮、Ctrl 快捷键、批注保存、`Ctrl` + 滚轮缩放、应用运行中和未运行时从资源管理器打开文件、粘贴资源管理器复制的文件、专注阅读全屏），最后静默卸载并确认清理干净。桌面截图作为 `windows-screenshots` 附件保存 14 天。改动 `electron/`、`src/`、`tests/` 等目录并推送到 main 时自动运行，也可以在 Actions 页面手动运行。

这个工作流在 Windows 上原生构建；正式发布的安装包在 Mac 上交叉构建，两者使用同一份配置。发布前最好仍在一台真实的 Windows 10 / 11 上装一次，确认 SmartScreen 提示和右键“打开方式”。

### Windows 签名

当前未做代码签名。首次运行时 Windows SmartScreen 会提示“Windows 已保护你的电脑”，需点击 **更多信息 → 仍要运行**。发布说明中应写明这一点，并提示用户核对 `SHA256SUMS.txt`。

如需消除提示，需要购买代码签名证书（OV / EV，或使用 Azure Trusted Signing），通过 `CSC_LINK`、`CSC_KEY_PASSWORD` 环境变量或 `win.azureSignOptions` 配置。凭据同样不得写入源码或 Release 附件。

## 自动更新

页间启动 5 秒后、之后每 4 小时，读取官网下载目录（`package.json` 中 `build.publish` 的地址，`https://helloxxy.com/works/folio/downloads/`）里的 `latest-mac.yml` 或 `latest.yml`。有新版本就在后台下载，下载好后右下角提示“页间 x.y.z 已准备好”：

- **立即重启**：先像关窗口一样保存，再退出、安装、重新打开。
- **稍后**：标题栏右侧留一个“重启以更新”，下次退出页间时静默安装，不重新打开。

提示卡片列出从已安装的版本以来每一版的更新内容：最新一版的来自 `.yml`，中间几版的来自同一目录下的 `release-notes.json`（读不到时只列最新一版）。

下载好、还没安装时仍按时检查：这期间又发了新版本，就改下新版本，安装时直接装最新的，不会先装上一版、重开后再更新一次。

点标题栏中间的“页间”可以手动检查更新（Windows 没有菜单栏，只能从这里检查），macOS 的“页间”菜单里也有“检查更新…”。实现在 `electron/updater.cjs`。

**两个平台的做法不同**

- Windows 用 electron-updater 的标准流程：下载新的安装程序，退出时以 `--updated /S` 静默运行。有上一版的 `.exe.blockmap` 时只下载变化的部分。
- macOS 不用 electron-updater 自带的 Squirrel.Mac（早期的页间是 ad-hoc 签名，它装不了），而是另写了一套：下载 zip，解压后核对应用 ID、版本号和签名完整性（`codesign --verify`），页间退出后用新的 `页间.app` 替换旧的。之后的更新会用缓存的上一个 zip 只下载变化的部分。ad-hoc 签名的旧版也能这样直接升级到 Developer ID 签名的新版。
- macOS 上只有页间所在的文件夹可写时才能替换，一般就是“应用程序”文件夹。直接从 DMG 或“下载”文件夹里运行时做不到，这时提示卡片改为“去官网下载”。

`MacBundleUpdater` 用到了 electron-updater 的内部方法，所以 `package.json` 里把 electron-updater 锁在确切版本。升级它之后要重新运行下面的测试。

**0.7.0 及更早的版本没有自动更新。** 这些用户要手动更新一次，之后就会自动更新。可以在发布说明、官网等渠道提醒他们。

### 每次发版

1. 改 `package.json` 的版本号，必须比线上版本大。
2. 在 `build/release-notes.md` 写这次更新了什么，每行一条，会显示在提示卡片里。它会写进更新清单，所以要在打包前改好。
3. `npm run dist:mac` 和 `npm run dist:win`。
4. `npm run website:downloads`：核对 `release/` 里的更新清单与版本号一致，再把两个安装包、mac zip、两个 `.blockmap` 和两个 `.yml` 复制到 `website/downloads/`，并写出 `release-notes.json`：这一版的说明取自 `build/release-notes.md`，之前各版的取自它们发布标签里的同一文件，所以每次发版都要打 `v版本号` 标签。
5. 上传到服务器：**先传安装包，最后传两个 `.yml`**。`.yml` 一上线，用户的页间就会开始下载它列出的文件。
6. 旧版本的 `.blockmap` 留在服务器上，更新时靠它只下载变化的部分；旧版本的安装包和 zip 可以删。

### 测试

```sh
npm run test:update
```

在 Mac 上打包 0.0.1、0.0.2、0.0.3 三个版本，用本地服务器提供 0.0.2 的更新文件，依次检查：页间所在文件夹不可写时只提示去官网；选“稍后”后退出时静默安装且不重新打开；“立即重启”安装后重新打开；装好的 0.0.2 手动检查时提示已是最新版本；0.0.2 下载好、还没安装时再检查，不会重复下载；这时服务器换成 0.0.3，再检查会改下 0.0.3，提示卡片同时列出 0.0.3 和 0.0.2 的更新内容，退出后直接装上 0.0.3。约 5 分钟。`FOLIO_UPDATE_URL` 环境变量可以把更新地址换成测试服务器。

Windows 的同一测试在 GitHub Actions 的 `Windows` 工作流里运行（「Test automatic update」一步）。

## GitHub Release

更新 `package.json` 与锁文件的版本，提交后创建同版本标签。通过 GitHub CLI 创建草稿 Release，上传 arm64 的 DMG、Windows 的安装程序和校验文件；检查附件后再发布。发布说明应注明最低系统版本、Apple 芯片要求、两个平台的签名状态及本次变更。

源码仓库忽略本地阅读材料、`.html-reader`、构建目录和个人环境配置。请勿把整份个人工作空间作为附件上传。

## 签名与公证

macOS 版用 Developer ID 签名，并经过 Apple 公证（2026-10 接入）。`npm run dist:mac` 会自动完成：

1. 用钥匙串里的 `Developer ID Application: Li Ming wang (46AL7LQ9T8)` 签名（`mac.identity`），开启 hardened runtime，entitlements 见 `build/entitlements.mac.plist`。
2. 用钥匙串里名为 `helloxxy-notary` 的公证凭据（`APPLE_KEYCHAIN_PROFILE`，写在 `dist:mac` 里）把 `页间.app` 交给 Apple 公证，通过后把票据贴进应用，再打 DMG 和 zip。公证加上传大约 10–15 分钟（2026-10-08 实测），这段时间 electron-builder 没有输出，不是卡住了。
3. 检查 `release/mac-arm64/页间.app` 是否真的公证上了，没有就直接失败、不出包。只认 `spctl` 的 `source=Notarized Developer ID`：打包用的 Mac 关掉了 Gatekeeper（`override=security disabled`），没公证的包在它上面也显示 accepted；而 electron-builder 找不到凭据时只警告、照样出包。

证书和公证凭据都在这台 Mac 的登录钥匙串里，项目里不存任何密钥。

**打包时要注意**

- 打包期间别让 Mac 锁屏。锁屏后读不到公证凭据，notarytool 会报 `No Keychain password item found for profile: helloxxy-notary`，看起来像凭据丢了，其实解锁就好。
- 第一次签名时 macOS 可能问 codesign 能否使用钥匙串里的私钥，输入登录密码并选“始终允许”。
- 公证卡住或被拒：`xcrun notarytool history --keychain-profile helloxxy-notary` 看提交记录，`xcrun notarytool log <提交 ID> --keychain-profile helloxxy-notary` 看被拒原因。

**换一台 Mac 打包前**

- 证书：双击备份的 `.p12`（`~/resources/其他/苹果开发者证书/` 里 G2 那份，2031-09-17 到期）导入钥匙串，用 `security find-identity -v -p codesigning` 确认能看到上面的证书。
- 公证凭据：在 account.apple.com 生成一个 App 专用密码，然后运行 `xcrun notarytool store-credentials "helloxxy-notary" --apple-id <开发者 Apple ID> --team-id 46AL7LQ9T8`，按提示输入密码。

证书、私钥、App 专用密码都不写进源码、脚本或 Release 附件。Developer ID 证书不要吊销，吊销后已经发出去的版本会打不开。

**手动检查**

```
codesign -dv --verbose=4 "release/mac-arm64/页间.app"
spctl -a -vvv -t install "release/mac-arm64/页间.app"
```

0.17.3 的 macOS 安装包在 2026-10-08 换成了公证版，`README.md`、`docs/安装说明.txt`（DMG 里的安装说明）、`docs/verification.md`、`website/index.html` 里“无法验证开发者 → 仍要打开”的说明都已去掉。之后的发布说明照 0.17.3 的写 macOS 一行；Windows 的 SmartScreen 提示照旧保留。

Windows 版仍未签名，见上文“Windows 签名”。
