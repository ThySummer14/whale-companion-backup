# 大肥鱼 Companion 备份

这个仓库保存 Companion 宿主、Minecraft Worker、移动端源码和 DSH Go 定制补丁。生产存档、运行时数据库、签名密钥、第三方模型和参考素材由各自的本地备份保管。

克隆本仓库后，从固定的上游版本恢复安卓工程。补丁包含修改与新增文件。

```sh
git clone https://github.com/ccch1mneyyy/dsh-Go.git apps/dsh-go
git -C apps/dsh-go checkout --detach 48355003c66c675db6a2307f86c795f90fa1e0db
git -C apps/dsh-go apply --binary ../../backups/dsh-go.patch
```

## 当前安卓备份校验

2026-11-14 已从上述固定上游在独立临时目录应用补丁，并与当前安卓工作树逐文件比对。补丁覆盖 77 个文件，其中 58 个为新增文件；恢复后的 5,459 个文件内容、符号链接和可执行权限与当前源码一致。

该次备份包含角色首页、建筑审批、共看、歌曲和收件箱等页面及其配套测试、文案、原生音频代码和应用资源，包括 `app/lib/whale/companion_home.dart` 与 `app/lib/whale/house_approvals.dart`。

2026-11-18 补丁加入跨日建筑工程进度，现覆盖 78 个文件。已在固定上游的临时索引中应用完整补丁，本次涉及的 12 个文件与安卓工作区源码一致。

2026-11-20 补丁纳入后续的体素蓝图、音乐页面、多语言文案与测试，共覆盖 82 个文件。将补丁应用到固定上游后，恢复的 Git 树与当前安卓源码、资源和文件权限完全一致。该检出仍以固定上游为基线，安卓定制改动由主仓库中的补丁保存。

更新补丁时，应同时包含相对固定上游的已跟踪修改和新增源码，不能只运行普通 `git diff`。生成和恢复校验使用独立临时索引与目录，保留现有安卓工作树及暂存区；排除 `.DS_Store`、本地凭据、签名密钥、缓存和构建产物。

此校验只确认源码备份可重建，不代表 Flutter 编译或安卓真机功能验收。

宿主从仓库根目录运行 `pnpm install --frozen-lockfile` 和 `pnpm check`。本地日常保留最新构建与上一版回退包，历史版本的验收记录保存在接入文档。`0.118.0` 宿主包和 `0.18.0` 安卓 APK 已校验 SHA-256，可从公开的 GitHub Release 取回。 [备份发布](https://github.com/ThySummer14/whale-companion-backup/releases/tag/backup-2026-11-12)
