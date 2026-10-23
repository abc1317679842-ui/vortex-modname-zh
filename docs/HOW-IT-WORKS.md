# 工作原理

> 这份文档写给想改代码、或想知道「为什么这句没翻」的人。
> 只想装来用的话，看 [README](../README.md) 就够了。

---

## 一、为什么要分三层

Vortex 的界面文字来自三个完全不同的地方，一种手段治不了全部：

| 来源 | 例子 | 谁能管 |
|---|---|---|
| i18next 语言包（走了 `t()`） | 菜单、按钮、设置项、对话框 | 语言包 |
| 代码里写死的字符串 | `Refresh List`、`Sort by Deploy Order`、`View page` | 只能 DOM 层 |
| 第三方扩展注册的内容 | 扩展的页面标题、游戏卡片名、模组简介 | 只能 DOM 层 + 模型 |

所以本项目分三层，共用同一份 `pack.json`，避免「菜单叫设置、正文叫偏好设置」：

| 层 | 负责 | 代价 |
|---|---|---|
| 界面语言包 | 走 `t()` 的 6166 条（字符串叶子，= 语言包 manifest 的 `entries`） | 0 token，重启生效 |
| DOM 实时翻译 | 硬编码文案、扩展标题、游戏卡片 | 词库命中 0 token，否则走模型 |
| 批量翻译 | 模组名、合集名、更新日志、简介 | 走模型，结果落缓存 |

---

## 二、语言包是怎么接管的

Vortex 的 i18next 用 `MultiBackend` 加载语言包，**只认一份来源**，优先级：

```
%APPDATA%\Vortex\locales\<lang>\          ← 用户级（我们的目标）
某个第三方翻译扩展的 zh/ 或 locales/zh/    ← 扩展级
<安装目录>\resources\locales\<lang>\       ← 内置，只有 en
```

两个关键事实（都在 `app.asar` 里核实过）：

1. **只认一份**。同时装两个中文包，只有一个生效 —— 后来装的或优先级高的赢。
2. **按当前语言选目录**。宿主读 `settings.interface.language`，值是 `en` 时不会去看 `locales/zh/`。
   所以 README 让你把界面语言改成中文，不单纯是「选择语言」，而是**不选就不会加载**。

`locale-pack.js` 做的事：扫描 Vortex 内置的 `en` 语言包 → 和 `pack.json` 合并 → 写成**一个**
`locales/zh/common.json`。

一个文件为什么够：Vortex 的 i18n 初始化参数是 `fallbackNS: "common"`，
任何命名空间查不到的 key 都会回退到 `common`。

### 不覆盖别人的东西

`locales/zh/` 是共用目录。所以：

- 每次写入前算磁盘上 `common.json` 的哈希，与 manifest 里记的不一致 → 说明被别的包改过 → 先备份到 `backup-<时间戳>-foreign/`
- 备份失败就中止本次写入，不硬盖
- 「移除接管」只在「文件确实还是我们写的那份」时才删
- 清理旧文件只删 manifest 记录过的，不按「译文像不像我们的」反推

---

## 三、DOM 层：为什么以「段落」为单位

早期按文本节点翻，结果是把一句话拆成碎片：

```
页面： <p>Links are now <a href=x>exposed over IPC</a> (<code>nxm://</code> links)</p>
碎片： "Links are now" / "exposed over IPC" / "(nxm:// links)"
```

碎片没有上下文，模型要么照抄，要么吐不出 JSON，整批失败、堵死队列。

现在以「最内层块级元素」为单位，先序列化成带占位符的串：

```
Links are now <i1>exposed over IPC</i1> ({{2}} links)
```

- `<iN>` 对应可交互元素（`a` / `b` / `span`），回填时把原节点 clone 回来
- `{{N}}` 对应不可交互元素（`code` / `img` / `svg`），回填时插回去
- 模型返回中文后，按伪标签重新组装，链接照样能点、图标照样在

### 回填只改文本，不删节点

`applyInPlace` 只写 `node.nodeValue`，不增删任何元素节点 —— React 维护的结构没变，
它下次更新时不会找不到节点。

任何一层结构对不上（模型把嵌套拍平了），就整体 `rollback()`，这一块留英文。
宁可少翻一句，也不能让界面白屏。

整块重建（`innerHTML`）只在 `CONTENT_SEL` 白名单内（changelog / description / markdown / modal），
而且必须先过 `canBlockReplace()`：元素里不能有按钮、输入框、`[data-zh-skip]`。

### 什么时候跳过

- 已经是中文（CJK 判定）
- `<code>` / `<pre>` / `<kbd>` / 图片 / SVG
- 版本号、文件大小、颜色值、CSS 类名、URL、本地路径
- 纯专名：`UE4SS`、`LogicMods`、`CR4Player.CanApplyOilOnItem`
- 作者名（只翻 `By` / `Created by` / `Uploaded by` 前缀）
- 扩展自己的设置页（`[data-zh-skip]`），但设置页里嵌的更新日志例外

---

## 四、模型调用：窗口是动态算的

模型的 `max_context_length` **不等于**实际加载的上下文。
LM Studio 的 `/api/v0/models` 里 `loaded_context_length` 才是真的（开发机 8192，模型标称 262144）。

写死 `max_tokens: 4096` 会撞上实际只有 4096 的窗口，服务端返回
`Context size has been exceeded`，整批作废 —— 这是早期「整页英文」的真正原因。

现在的算法（权重为 2026-10 在 LM Studio + hy-mt2-7b 上的实测值，全部刻意高于实测）：

```
estIn    = estInputTokens(输入) + 系统提示词估值 + 64
           estInputTokens 按字符分类加权：ASCII 0.25 / 汉字 0.68 /
           假名谚文全角 0.95 / emoji 符号 1.65 / 其他拼音文字 0.75，
           另对 ≥20 字符的无空格 ASCII 长串（URL、Base64）加收 0.5/字符
want     = 输入字符数 × 0.5（mod）/ 0.85（html、ui）+ 256   // 输出需求
room     = ctx - estIn - 128
if (room < 400 || room < min(want, 4096)) → 抛 CTX_OVER，上层劈半重发
outTokens = clamp(min(want, room, 4096), 256, …)
```

两个闸门缺一不可：只查输入，大批次的 `room` 会被吃得只剩几百 token，发出去必被
`max_tokens` 截断整批作废；输出估低了同样截断（短模组名实测约 0.4 token/源字符，
含版本号和术语标记开销，所以 mod 取 0.5）。

真实 400 里能从报错学窗口（请求量和窗口同时出现时取小值），但**解析值等于当前估值时不动**——
那说明探测本来就对，是估算低估，该劈批而不是砍窗口。

超过 3000 字符的块按句子切成约 800 字符的小片，只在伪标签外部切，保证每片 `<iN>` 配对完整。

---

## 五、失败状态机

`failed` 里的数字有明确含义：

| 值 | 含义 | 行为 |
|---|---|---|
| `> 0` | 暂态失败（超时、解析失败、上下文超限、格式拒收） | 按 45 秒 / 4 分钟 / 15 分钟退避重试，最多 3 次 |
| `-1` | 不可译（模型连续两次原样返回，如纯专名） | 永不自动重试 |
| `> 3` | 重试用尽 | 永不自动重试 |

只有两个东西能解除终态：**用户点「清空缓存」** 或 **版本升级**（`failCache._ver` 变化）。

早期这里踩过大坑：有四个入口都能「复活」失败条目（三个定时器 + 可见复活 + 探活清空整表），
叠起来等于**永远在重试**，实测某个专名每 10 秒烧一次调用。现在只剩一个入口。

### 「照抄」和「格式拒收」要分开

`finishOne()` 有五个「宁可留英文」的出口：占位符丢了、伪标签不配对、BBcode 坏了、长文漏译。
它们都返回原文。

如果上层把「返回原文」一律当成「模型不肯翻」，第二次就判 `-1` 永久封杀 ——
用户会看到「这段怎么重开都不变」。

所以现在被拒收的条目会额外记进 `_rejects` 集合，上层只有「逐字相同**且**不在 `_rejects` 里」
才按不可译处理。

---

## 六、准确性：三类一定会错的东西

7B 级模型不是不会翻，是**会自信地翻错**，而且错得很稳定。这三类不靠提示词，靠机制：

| 类型 | 实测错法 | 做法 |
|---|---|---|
| 游戏名缩写 | `TW3` → 《上古卷轴3》 | 内置对照钉进提示词；对照表里没有的缩写保留原文，禁止猜 |
| Vortex 专有词 | `profile` → 账号 | 术语表：profile=配置档、purge=清除部署、staging folder=暂存文件夹 |
| 文件路径 | `The Witcher 3\mods\xxx\` → `巫师3\mods\xxx\`，反斜杠还变 `/` | 发送前换成 `{{P1}}` 占位符，回来原样还原；占位符丢了就整条留英文 |

路径这条是硬要求：用户是照着路径删文件、放文件的，错一个字符就是白干。
**宁可整句英文，也不放行改过的路径。**

### 游戏名对照按需注入

746 条游戏名如果全塞进提示词，既浪费上下文又会被截断。
所以每次只注入「这一批文本里实际出现的那几条」（包含匹配，上限 40）。

### 其他后处理

- 繁→简（逐字符查表，表里只能放单字）
- 剥掉模型加的 `【】` / `《》` / 弯引号
- `&amp;` / `&lt;` 等实体在回填前解码
- BBcode 配对校验（模型会把 `[i]…[/i]` 写成 `[i]…</i>`）
- 译文里一个中文都没有 → 判定为「不是翻译」，不进缓存

---

## 七、数据放在哪

扩展升级是**整个目录覆盖**，所以运行时数据不能放在扩展目录里：

| 位置 | 内容 |
|---|---|
| `%APPDATA%\Vortex\vortex-modname-zh\` | `config.json` 配置、`cache.json` 模组名译文、`domCache.json` 页面译文、`failCache.json` 失败名单、`collected.json` 采集记录、`translator.log` 日志、`seed-skip.json` |
| 扩展目录 | `pack.json` / `gamenames*.json` / `domCache.seed.json` 等静态资源，以及全部 js |

首次启动会自动从扩展目录迁移旧文件，翻过的东西不会白翻。

写盘统一 `.tmp` + `rename`（原子），日志超 1 MB 轮转。

---

## 八、目录结构

```
index.js              入口、设置页 UI、模组名批量翻译、缓存读写、实时状态
dom-translator.js     DOM 兜底层：扫描、判定、序列化、回填、队列、重试
translate-core.js     模型调用层：HTTP、提示词、占位符保护、分批、JSON 解析
locale-pack.js        语言包接管：扫 en 词条、合并词库、写 common.json
pack.json             界面词库（6166 条，按字符串叶子计）
gamenames.json        游戏固定中文名（746 条）
gamenames-keep.json   明确保持英文的名单
domCache.seed.json    种子译文（清缓存升级后垫底）
config.json           出厂配置（接口地址为空）
```

修改代码前请先读 [DEV-NOTES.md](../DEV-NOTES.md)：里面每条纪律都对应一次真实故障。
