# 第三方作品声明

本项目包含来自以下项目的衍生内容。完整的条款原文、实测比对数据与本项目采取
的许可说明见 [`LICENSE-DATA`](LICENSE-DATA)。

## 1. Vortex 界面词库

**Chinese Translation for Vortex**
- 作者：**liuyanxi**
- Nexus Mods：https://www.nexusmods.com/site/mods/29
- GitHub：https://github.com/liuyanxi975/Chinese-Translation-for-Vortex
- 贡献者：liuyanxi、xuqingxin、SettingDust、TUsama、Souma-Sumire
- 使用方式：本项目 `pack.json` 的主体译文（实测 3764 条逐字相同，占对方 90.2%）
- 条款：署名 + 相同方式共享 + 禁止商业使用

**Vortex Chinese Translation - Simplified (Full Coverage)**
- 作者：**Evander666**
- Nexus Mods：https://www.nexusmods.com/site/mods/2320
- 版本：1.0（2026-09-15）
- 使用方式：基于上一项的增量补全与校对（紧凑视图、列显示、整合包流程、插件错误提示等类别）
- 条款：署名 + 禁止商业使用（其自述为 GPL-3.0）

## 3. 繁简字表

**OpenCC（Open Chinese Convert）**
- 项目：https://github.com/BYVoid/OpenCC
- 许可：Apache-2.0
- 使用方式：`translate-core.js` 里的 `TRAD_PAIRS` 由 OpenCC 的 `TSCharacters.txt`
  整理而来（只保留单字对单字的 2965 条，压成一维交替串）。模型偶尔吐出繁体时用它转简体。

## 4. Vortex 本体

- 项目：Vortex（Nexus Mods 官方模组管理器）
- 许可：GPL-3.0 — https://github.com/Nexus-Mods/Vortex/blob/master/LICENSE.md
- 使用方式：本扩展作为独立扩展运行，不修改、不重新分发 Vortex 本体代码。
  界面词条的**英文原文**（key）来自 Vortex 的 i18n 资源，中文译文由上列作者与本项目提供。

Vortex 与 Nexus Mods 的商标归其各自所有者所有。本项目为非官方社区项目，
与 Nexus Mods 无隶属关系。
