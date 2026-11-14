# 在 Mac 预览真实手机 App

双击仓库根目录的 **`预览手机App.command`**，或在仓库根目录运行：

```sh
pnpm app:preview
```

工具打开现有 `companion-android` 模拟器，在其中运行真正的 Companion Android App：`companion` flavor、`lib/whale_main.dart`、包名 `ai.companion.whale`。使用相同的 Flutter 页面、Android 插件和 WebView，不是网页仿版。

首次显示正常配对页。请在你自己的 Companion 工作台生成一次性配对链接，粘贴到模拟器中；不要复制其他手机的凭据。通过 HTTPS/Tailscale 正常配对，宿主需可从模拟器访问。模拟器中的 `127.0.0.1` 指模拟器自身，不是 Mac。启动时模拟器沿用 Mac 当前的 DNS（含 Tailscale 分流 DNS），配对链接里的 Tailscale 域名可直接解析；若模拟器在加入该行为前已在运行，先 `stop` 再启动一次。配对凭据保存在模拟器内的系统安全存储，App 重启与模拟器重启后自动恢复，无需重新配对；卸载或清除 App 数据才会丢失。配对成功后即可查看首页、聊天、动态、音乐、视频和活动；Live2D 仍要求宿主已提供可用模型与形象能力。

## 日常操作

| 命令 | 作用 |
|---|---|
| `pnpm app:preview` | 打开已有包；不构建、不下载，重复启动跳过相同包的安装 |
| `pnpm app:preview -- dev` | 连接 debug App 的 Flutter 热重载 |
| `pnpm app:preview -- build` | 离线增量构建，同一路径覆盖 debug 包 |
| `pnpm app:preview -- build --online` | 明确允许构建下载缺少的依赖 |
| `pnpm app:preview -- dev --rebuild` | 先构建，再启动并连接热重载 |
| `pnpm app:preview -- status` | 查看专用模拟器、安装包和剩余磁盘空间 |
| `pnpm app:preview -- screenshot` | 覆盖保存 `.work/app-preview/screenshot.png` |
| `pnpm app:preview -- stop` | 关闭本工具启动的模拟器，保留 App 数据 |

热重载会重启专用模拟器中的 App，读取当前进程的调试地址并连接，不清除 App 数据。在终端中使用：`r` 更新修改后的 Dart 界面，`R` 热重启，`d` 断开调试并保留 App，`q` 结束调试。连接前已改过的代码可先按 `R`。修改 Kotlin、Android 清单、原生依赖或资产声明后，需要明确重新构建。默认打开的是已有安装包，不会悄悄把最新源码重新编译。

双击入口的终端可在启动后按回车关闭，模拟器继续运行。模拟器能用鼠标操作；键盘输入配对链接与聊天内容。系统返回、旋转、音量等可用模拟器侧栏。

## 存储管理

- 复用已存在的 `companion-android`，不下载系统镜像、不克隆 AVD、不复制工程。
- 复用 `app/build/app/outputs/flutter-apk/app-companion-debug.apk`。重新构建覆盖同一个包，不另存带日期的 APK，也不生成 release 包。
- 默认不编译；剩余空间不足 4 GiB 拒绝启动，不足 12 GiB 拒绝构建。阈值只是保留空间，不能保证构建所需容量上限。
- 启动使用 `-no-snapshot`，不读取或新存内存快照；原有快照不会自动删除。App 用户数据仍保存在原 AVD，首次启动、安装和系统缓存可能让已有 AVD 增长。
- 不收集持续日志。构建只保留最后 2 MiB，覆盖 `.work/app-preview/build.log`；截图只保留固定一张，下一次覆盖。
- Gradle、Flutter 及 Android 的现有共享缓存仍会在明确构建时使用，必要依赖可能扩大它们。本工具不擅自删除缓存、备份或 App 数据，也不会自动运行 `flutter clean`。
- 不用时运行 `stop` 释放模拟器的内存和 CPU；这不会删除磁盘上的 AVD。需要回收历史构建或旧镜像时，应另行确认具体清理对象。

## 本机工具与隔离

自动查找仓库 `.work/toolchain/flutter`、已配置的 Android SDK 和本机 JDK。也可指定：

```sh
APP_PREVIEW_FLUTTER_ROOT=/path/to/flutter \
APP_PREVIEW_ANDROID_SDK=/path/to/android-sdk \
APP_PREVIEW_JAVA_HOME=/path/to/jdk \
pnpm app:preview -- build
```

构建临时将工程 `android/local.properties` 的 Flutter SDK 路径转成 Java 可读的 Unicode 转义，结束后恢复原内容；不改全局 Flutter 设置。不要同时用其他终端修改该工程的构建配置。缺少 SDK、AVD 或安装包时会给出说明，不会自动下载大文件。

所有安装、启动、截图和停止操作都指定已核对 AVD 名称的模拟器，不选择 USB 真机。安装只用 `adb install -r`，失败即停止，不自动卸载、清数据或降级；安装前后核对首次安装时间。若签名不匹配，请使用兼容签名的包，不要为了预览删除已有数据。

`stop` 只在记录的进程、启动时间和专用 AVD 一致时退出，不能确认归属则拒绝关闭。已由其他工具启动的模拟器可以复用，但需在原工具或窗口里关闭。

## 验证边界

模拟器适合验证真实 Android 页面、导航、输入、布局与 WebView。debug 模式和模拟器的动画、麦克风、扬声器及性能不等于真机；最终流畅度和硬件体验仍需正式包真机验收。不会伪造配对成功状态，也不会用截图代替真实 Live2D。
