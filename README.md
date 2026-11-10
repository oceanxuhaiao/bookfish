# Bookfish novel runtime（第三方运行时分发）

本仓库只承载 Bookfish 扩展使用的 **Windows x64 运行时资产**，不是引擎作者，也不对上游代码重新授权。

## 资产

- `bookfish-novel-runtime-1.12.0-bf1-win32-x64.zip`
  - 85,784,286 字节
  - SHA-256：`b9f16f858150a8370fb59a2c4df582b99f133b2b60419434c579d7485060b71e`
  - 解压后 189,431,419 字节 / 323 个文件
- `so-novel-v1.12.0-source.tar.gz`：对应上游引擎源码
- `bookfish-bridge-bf1-source.tar.gz`：Bookfish bridge 源码
- `SHA256SUMS`、`sbom.json`、`RELEASE-NOTES.md`

## 上游与许可证

- **so-novel v1.12.0**，commit `88acec6ee489ca1c2489c624cedd1ef417d3f3ee`，**AGPL-3.0**：https://github.com/freeok/so-novel
- **Eclipse Temurin JRE 21.0.8+9-LTS**，**GPLv2 with Classpath Exception**；对应上游源码：https://github.com/adoptium/jdk21u/tree/18dfe1e4938d
- Bookfish 扩展代码是 MIT；本仓库的运行时资产**不是 MIT**，也不能被当作 MIT 再分发。
- `app.jar` 与规则是上游未修改内容；修改或与 bridge 组合分发时的 AGPL 边界仍需法律确认。

## 再分发要求

再分发时必须保留 ZIP 内的版权、LICENSE、NOTICE、SOURCE 文件，并提供对应源码；不要移除或替换上游许可证。若修改上游代码，必须按 AGPL-3.0 提供修改后的完整源码，并遵守 AGPL 的网络交互条款。

下载后由 Bookfish 扩展校验摘要、安全解压、自检并原子启用；不要手工解压覆盖正在使用的运行时。