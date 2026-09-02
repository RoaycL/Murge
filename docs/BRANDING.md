# 品牌与重命名契约

所有公共标识均源自 `brand.config.json`。

## 已配置字段

- `productName`: 窗口标题、安装器名称和面向用户的全名。
- `shortName`: 紧凑的导航/关于文本。
- `appId`: 包标识。更改它会创建一个不同的已安装应用。
- `executableName`: Windows 可执行文件基本名。
- `protocolScheme`: 深链（deep-link）协议。
- `companyName`: 在应用代码签名之前的安装器发布者文本。
- `repositoryUrl` 和 `supportUrl`: 关于与诊断链接。
- `copyright`: 关于与元数据文本。

## 重命名流程

1. 更新 `brand.config.json`。
2. 当 `resources/icons` 目录引入后，替换其下的资源。
3. 运行 `npm run brand:check`。
4. 构建一个未打包的应用，并验证文件名、进程名和标题。
5. 决定 `appId` 和 `protocolScheme` 是应迁移还是保持兼容。
6. 若更改 `appId`，请记录如何从旧的应用数据目录导入现有配置。

## 禁止的耦合

- 不得在 TypeScript 类名、IPC 通道或存储键中使用产品名。
- 不得在新代码中将环境变量按产品命名。现有的 `MURGE_DEV_*` 变量是临时性的开发兼容名，应在首次重命名前替换为中性的 `APP_DEV_*` 名称。
- 不得硬编码仓库所有者。
- 不得从 `productName` 推断应用数据文件夹；请使用带显式迁移映射的稳定存储命名空间。

当当前公共名称出现在已批准的品牌文档之外的源码/配置文件里时，`brand:check` 脚本会刻意失败。
