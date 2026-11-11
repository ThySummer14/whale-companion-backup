# 大肥鱼 Companion 备份

这个私有仓库保存 Companion 宿主、Minecraft Worker、移动端源码和 DSH Go 定制补丁。生产存档、运行时数据库、签名密钥、第三方模型和参考素材由各自的本地备份保管。

克隆本仓库后，从固定的上游版本恢复安卓工程。补丁包含修改与新增文件。

```sh
git clone https://github.com/ccch1mneyyy/dsh-Go.git apps/dsh-go
git -C apps/dsh-go checkout --detach 48355003c66c675db6a2307f86c795f90fa1e0db
git -C apps/dsh-go apply --binary ../../backups/dsh-go.patch
```

宿主从仓库根目录运行 `pnpm install --frozen-lockfile` 和 `pnpm check`。归档安装包见私有仓库 Releases。
