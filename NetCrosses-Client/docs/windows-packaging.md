# Windows 打包操作方法

## 环境准备
- Windows 10/11 x64
- Node.js 20+（64 位）
- npm

说明：建议在 Windows 本机打包；非 Windows 环境打包 exe 需要额外的兼容环境（不推荐）。

## 安装依赖
```bash
cd <你的项目路径>/NetCrosses-Client
npm install
```

## 打包命令
```bash
npm run dist:win
```

该命令会先编译 TypeScript，然后使用 `electron-builder` 生成安装包与便携版。
首次运行需要从网络下载 Electron 运行时。

## 输出位置
- 安装包：`release/NetCrosses Setup <版本>.exe`
- 便携版：`release/NetCrosses <版本>.exe`

## 图标与安装界面
当前图标文件：`assets/netcrosses.ico`
NSIS 相关配置已写入 `package.json` 的 `build.nsis`，支持：
- 可视化安装界面（非一键安装）
- 可选择安装目录

如需更换图标：用你的 `.ico` 文件覆盖 `assets/netcrosses.ico` 即可。

## 常见问题
- `electron-builder` 下载失败：检查网络或代理后重试。
- 找不到 `electron-builder`：运行 `npm install` 后再打包。
