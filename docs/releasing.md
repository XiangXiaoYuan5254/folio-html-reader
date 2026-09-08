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

## GitHub Release

更新 `package.json` 与锁文件的版本，提交后创建同版本标签。通过 GitHub CLI 创建草稿 Release，上传arm64 的 DMG / ZIP、中文安装说明和校验文件；检查附件后再发布。发布说明应注明最低系统版本、Apple 芯片要求、签名状态及本次变更。

源码仓库忽略本地阅读材料、`.html-reader`、构建目录和个人环境配置。请勿把整份个人工作空间作为附件上传。

## 签名与公证

当前配置采用 ad-hoc 本地签名，`mac.identity` 为 `-`、`mac.notarize` 为 `false`。签名完整性校验通过不表示经过 Apple 公证。

如后续取得 Apple Developer Program 资格及 Developer ID Application 证书，可在独立发布环境配置 Developer ID 签名、公证凭据和相应的 electron-builder 选项。凭据通过受保护的环境变量或 GitHub Actions Secrets 传入，不写入源码、脚本或 Release 附件。

目前发布说明必须保留首次打开提示，并链接 [Apple 官方说明](https://support.apple.com/zh-cn/102445)。不修改用户的 Gatekeeper 设置，不附带关闭系统安全保护的脚本。
