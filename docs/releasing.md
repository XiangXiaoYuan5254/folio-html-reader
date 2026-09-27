# 发布 macOS 安装包

环境：macOS、Node.js 22.13+。PDF 渲染资源随应用离线打包，使用 electron-builder 只为 Apple 芯片 arm64 打包。

```sh
npm ci
npm test
npm run test:e2e
npm run dist:mac
```

`release/` 会包含arm64 的 DMG / ZIP，以及 `SHA256SUMS.txt`。DMG 中包含页间、Applications 文件夹快捷方式和中文安装说明。安装包只包含 `samples/` 中的原创演示资料。

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
- `Folio-版本号-win-x64.zip`：免安装版，解压后运行 `Folio.exe`。
- `SHA256SUMS.txt`：包含 `release/` 中同版本 Mac 与 Windows 的全部安装包。先后运行 `dist:mac` 和 `dist:win`，得到一份合并的校验文件。

支持 Windows 10 / 11 x64，Windows on ARM 可以通过系统自带的 x64 转译运行。

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

## GitHub Release

更新 `package.json` 与锁文件的版本，提交后创建同版本标签。通过 GitHub CLI 创建草稿 Release，上传arm64 的 DMG / ZIP、Windows 的安装程序 / ZIP、中文安装说明和校验文件；检查附件后再发布。发布说明应注明最低系统版本、Apple 芯片要求、签名状态及本次变更。

源码仓库忽略本地阅读材料、`.html-reader`、构建目录和个人环境配置。请勿把整份个人工作空间作为附件上传。

## 签名与公证

当前配置采用 ad-hoc 本地签名，`mac.identity` 为 `-`、`mac.notarize` 为 `false`。签名完整性校验通过不表示经过 Apple 公证。

`build/entitlements.notarize.plist` 已备好，尚未接入配置。启用 Developer ID 签名与公证的步骤如下。

**一、取得证书**

加入 Apple Developer Program 后，申请 **Developer ID Application** 证书（不是 Mac App Store 证书），下载安装到钥匙串。用 `security find-identity -v -p codesigning` 确认证书名称与 Team ID。

**二、准备公证凭据**

electron-builder 26 支持三组环境变量，优先使用 App Store Connect API 密钥，避免账号密码落在环境里：

1. `APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`（推荐）
2. `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`
3. `APPLE_KEYCHAIN`、`APPLE_KEYCHAIN_PROFILE`

凭据通过受保护的环境变量传入，不写入源码、脚本或 Release 附件。

**三、改 `package.json` 的 `mac` 段**

```json
"identity": "Developer ID Application: 姓名 (TEAMID)",
"notarize": true,
"entitlements": "build/entitlements.notarize.plist",
"entitlementsInherit": "build/entitlements.notarize.plist"
```

`hardenedRuntime` 默认为 `true`，无需显式声明。entitlements 中的 `com.apple.security.cs.allow-jit` 对 arm64 上的 Electron 20+ 是必需的，缺失会导致启动崩溃。

**四、验证**

打包后依次执行：

```
codesign -dv --verbose=4 "release/mac-arm64/页间.app"
spctl -a -vvv -t install "release/mac-arm64/页间.app"
xcrun stapler validate "release/页间-<版本>-mac-arm64.dmg"
```

`spctl` 输出应为 `source=Notarized Developer ID`。公证通过后，发布说明与 DMG 内的安装说明中的首次打开提示即可移除。

目前发布说明必须保留首次打开提示，并链接 [Apple 官方说明](https://support.apple.com/zh-cn/102445)。不修改用户的 Gatekeeper 设置，不附带关闭系统安全保护的脚本。
