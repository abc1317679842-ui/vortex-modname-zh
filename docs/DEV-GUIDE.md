# DEV-GUIDE · vortex-modname-zh 开发指南

> **定位**：动手改代码**之前**查这份。它记的是「要动哪几处、按什么顺序、拿什么验证」——正向地图。
> 负向知识（踩了什么坑、为什么死）在 [DEV-NOTES.md](../DEV-NOTES.md)，每条纪律都对应一次真实故障。
>
> **正确性纪律**（维护本指南的人必须遵守）：
> 1. 所有函数名、分派顺序、判据**写作时现场读源码核实**，禁止凭记忆写。
> 2. 不写死行号（行号会漂），只写 `文件 + 函数名`。
> 3. 每条经验都可回溯到一次真实故障的修复。
> 4. **只收真机验收过的做法**。修完未验收的先留在日志，验收后才升格进来。
> 5. 本指南允许**缺**（新功能以后补），不允许**错**——发现与现实不符立即改这里。

---

## 1. 名字管线链路图（index.js）

模组名/下载行从「看到英文」到「显示中文」的完整路径。改名字相关功能前先走一遍这条链。

```
Vortex 状态变化（mods/downloads 表）
  └→ autoHook（绑定见 §1.4）── running/scheduled 围栏（防重入）
       └→ collectTargets / collectDownloadTargets
            │   判据 needsTranslate(raw)：raw 无中文才收 → 翻完天然退出队列，结构上不可能死循环
            │   已安装行 raw 从 mods 表显示名来；英文骨架走 englishBaseNameOf
            └→ core.translateConcurrently(..., 'mod')   ← ★ 必须显式传 mode='mod'
                 │   漏传 = isUiBatch 按批长猜（批均>24字符判 ui）→ modOnly 词不遮蔽
                 │   → 产出缺固定译名 → 漂移对账判漂移 → 删键重翻循环
                 └→ 写回：已安装行 → customFileName；下载行 → applyDownloadTranslation → modInfo.name
                     ★ 写 modInfo.name 无效（Vortex 不读它做显示）；
                     ★ 写前必须把英文原名备份到 zhSourceName
```

### 1.1 缓存与状态层（三层论，最重要的事实）

| 层 | 内容 | 性质 |
|---|---|---|
| 状态层 | mods 表 `customFileName`、下载行 `modInfo.nexus.fileInfo.name` | **落地成果**，清缓存不清它 |
| cache.json | 原名→中文 键值对（名字缓存） | 派生、可再生 |
| domCache/failCache | DOM 文本翻译缓存/失败账 | 派生、可再生 |

- 「要不要翻」的判据看**状态层是否已中文**，缓存不参与。
- **删缓存键 ≠ 回到翻译队列**——状态层中文的行，所有收集线都当「已翻过」跳过。
- 读侧入口：`nameCacheOf(raw)`（内部走 cacheKeyOf 规范键查 cache.json）；写侧只经 `dropTranslation`/收集线。
- 收养路径：`downloadTargetOf` 在 dl 缓存填充时把状态层中文灌回缓存（键=英文原名），
  入口有 `glossaryDrifted` 闸拦旧译文回流。

### 1.2 键算法（只准一套）

- 统一用 `cacheKeyOf`（index.js）产出规范键；删除用 `dropTranslation`（它内部做 domCache/failCache
  双针扫尾：`ckt && ckt !== t ? [t, ckt] : [t]`）。
- **禁止**在别处手写 `delete cache[t]` / 自己拼键（读侧不算规范键，键不同源查不到）。
- mods 表的键 ≠ 名字；对用户只能用显示名。

### 1.3 词库漂移对账（autostart 段，applyCachedSilently 之前）

```
glossaryStampOf(wordFixTerms())  → 词表指纹（前缀 wfg2 + djb2）
  cache._gl !== stamp 才扫（平时零成本短路）
  └→ auditGlossaryDrift：复用 core.applyTerms 的 mask 判据（与送翻零分叉）
       译文缺任一『』期望译名 = stale
       ├→ stale=0：落戳落盘（自收敛）
       └→ stale>0：dropTranslation 逐条删键、**不落戳**（下次启动再审），
            并 setTimeout 15s 踢一次 autoHookRef
```

- 判据必须复用 `core.applyTerms`，另写一份正则必然分叉（分叉=对账和送翻互相打架）。
- 踢管线**不要求 stale>0**：上次启动删过键、本次只落戳的窗口也要踢（todo 空时 autoHook 空手返回，零成本）。
- 加新词条（WORD_FIXES 改动）→ 存量译文会在下次启动自动对账重翻，**不用手写迁移**。

### 1.4 启动序列（autostart 段实际顺序，改启动逻辑前必读）

```
main()
 ├→ startDomRef()                    // DOM 层注入（cfg.domTranslate!==false 时）
 └→ setTimeout(...)
      ├→ restoreBrandNames()         // 先还原品牌坏译文
      ├→ seedExtensionNames()        // 再补 `<游戏> Vortex Extension` 零模型译文（顺序不能反）
      ├→ 绑定 autoHook 到 onStateChange(mods/downloads)   ← init 阶段绑是静默失效的
      ├→ 词库漂移对账（§1.3）
      ├→ applyCachedSilently()       // 静默贴缓存，不联网
      └→ 界面自愈（存量半中半英，异步）
```

- `autoHook` 只挂在 onStateChange 上：**启动后表不变它一次都不跑**。改「启动后自动做事」的逻辑时，
  必须自己主动踢 `autoHookRef`，不能假设它会被触发。
- `startDomTranslator` 拿不到 body 返回 false → `startDomRef` 必须**接返回值**：false 不置
  `domStarted`，否则设置页补启条件 `!domStarted` 恒假、该会话 DOM 层静默死亡。

### 1.5 送翻汇聚点（translate-core.js）

- 所有文本送模型统一走 `llmTranslate`：送前 `mask`（cfg.terms 全量带，替换成『固定译名』占位）、
  回来 `unmask` 还原——遮蔽是硬保证，提示词词表只是模型自觉（真模型实测对照）。
- `mode` 参数：'mod' 全遮 / 'ui' 按 modOnly 过滤 / 缺省时 `isUiBatch` 按批长猜（批均>24 字符或
  单条>70 字符判 ui）。**名字管线必须显式传 'mod'**（见 §1 链路图）。

### 1.6 自动翻译的防失控闸（全部在 index.js autoHook 附近）

| 闸 | 值 | 作用 |
|---|---|---|
| `running` / `scheduled` 围栏 | — | 手动连点、自动+手动叠加进不来 |
| `HOOK_BACKOFF` | [5s, 30s, 120s, 600s] | 失败退避，封顶 10 分钟 |
| `modelDown` | 连续失败置位 | 暂停重试，每 2 分钟探活；UI 显示「模型无响应，已暂停重试」 |
| `needsTranslate` | — | 无中文才收，翻完退出队列 |

改任何「自动重试」逻辑前，先确认没有拆掉这四道闸。

---

## 2. DOM 管线分派顺序图（dom-translator.js）

界面文本从「看到英文」到「翻译/保持英文」的完整路径。**顺序即语义**——每一条都有「为什么排这个位置」，改顺序前必须读懂相邻两条的冲突关系。

### 2.1 handleTextNode（节点入口）分派顺序

```
1. SKIP_TAGS / RAW_TAGS 直爹 → 放弃（PRE/CODE 折叠丢换行）
2. isZhSkip(祖先) → 放弃
3. keepSet.has(t) → 打标记放弃（保留英文名单）
4. 祖先含 author/uploader → handleAuthor（作者名不许翻，节点级前缀替换）
5. /^missing (?:required mods?|mod may be required) for:/ → handlePrefixSentence
   （词典前缀句，节点级「前缀中文+余串原样」写回；在名字闸门之前：整句不是模组名）
6. handleFileNameNode → 下载页压缩包文件名剥骨架查短名（零模型）
   ★ 必须排在名字闸门之前：闸门命中是 return，贴不上整条放弃，这里永远轮不到
7. fileStemOf(t) → 放弃（整串文件名绝不送模型：fileId/版本尾巴会揉进中文，
   且写进 domCache 永久固化）
8. 名字闸门：noteNameCandidate && blockedByName → handleNameNode（贴 cache.json 名字，D1）
9. leafBlockOf → processBlock（返回非 'nodelevel' 即结束）
10. processNode（节点级兜底）
```

### 2.2 processBlock（块级）顺序

```
1. RAW_TAGS / data-zh-block 摘除（React 重渲染还原英文但标记还在 → 摘掉重来）
2. 非内容容器 && children>12 → nodelevel（大容器整块翻会把十几个控件粘成一团）
3. seenText 全文比对（只比长度会被虚拟列表同长不同文骗过）
4. serialize → src（链接等内联元素变 <i1> 伪标签）
5. fileStemOf(src) → nodelevel（文件名整块走节点级剥尾）
6. keepSet（src 或 normText）→ 放弃
7. src.length>MAX_LEN(3000) → processLongBlock（切片 ≤800，先查缓存/词库再入队）
8. patternHit(src)                          ← ★ 必须先于 okUnit
   │   pattern 是人工维护句式白名单，命中即可翻，无需「整块纯英文」把关
   │   （状态层直渲染的模组名让整块天生半中半英，okUnit 的 CJK 早退会把 pattern
   │     永久锁死在后面）
   ├→ canBlockReplace=false → nodelevel
   └→ applyUnit 贴失败 → nodelevel（不是 false！false 会让 handleTextNode 短路，
       前缀节点永远轮不到词典）
9. okUnit(src) 失败 → false（CJK 早退/noise/isTranslatable）
10. 伪标签+占位符+裸产品名守卫 → false（下载页身份行，送翻必产垃圾）
11. 词库三路查询：lookup(src) → shellInner 去壳 → 去伪标签纯文本
12. hit → canBlockReplace → coolIfPingPong('block') → applyUnit → fallback
    （fallback：slots>1 才降 nodelevel）
    ★ 顺序不能反：先判 canBlockReplace 再记拉锯账，否则普通虚拟列表复用几次
      就把计数顶爆白挨熔断
13. 无 hit → canBlockReplace → enqueue(src)
```

### 2.3 processNode（节点级兜底）顺序

```
1. namePasteOf(t)（cache.json 名字，D1，kill switch cfg.domWriteNames===false 整档回退）
   → lookup(t) → shellInner 去壳再 lookup
2. hit → coolIfPingPong('node') → node.nodeValue 写回
   ★ 第二参数用回调 () => hit：直传字符串时译文里的 $&/$`/$1 会被当替换模式展开
3. collectMode 采集（COLLECT_MAX=5000 封顶，到顶只报一次）
4. cache[t] !== undefined → 放弃（domCache 命中不送模型）
5. nameKnown(t) → 不送模型（名字归状态层队列；这里送只会产出 domCache 垃圾）
6. reviveIfVisible / isTranslatable / queueMeta 去重 → queue
```

### 2.4 横切保护（两条管线共用）

| 机制 | 位置 | 要点 |
|---|---|---|
| 拉锯熔断 `coolIfPingPong` | 两路写回前 | 计数键=**元素+原文**（不是文本节点，React 会重建节点导致计数永远归 1）；`WRITE_PATIENCE=6` 次熔断 |
| 入队去重 `enqueue` | processBlock 尾 | Set 按全文去重：同一段文本多个位置**只送一次模型**；`RETRY_MAX=3` 封顶永久放弃 |
| 汉字总闸 | 译文回填前 | 译文不含 CJK 整体作废回滚（含 pattern 输出——pattern 模板必须写含汉字） |
| reviveIfVisible 三重限流 | 送模型前 | 视口内 + 时间窗条数上限 + 每条复活次数上限 |

---

## 3. 常见改动落点清单

### 3.1 加/改一个词条（WORD_FIXES / gamenames-keep.json）

1. 改 `index.js` 的 WORD_FIXES（或 gamenames-keep.json）
2. modOnly 判定：通用词（如 oils/reborn）加进 `WORD_FIX_MOD_ONLY`，域内专名不加——
   **改前必须先跑真模型 A/B**（§5.5），拿到「各方案屏幕效果+命中率」再动源码
3. 术语判据细节：短语加右边界、全大写大小写敏感、边界用非字母数字不用 `\b`、
   bare/短语两分支分开写、遮罩早于 normalizeCase
4. 存量对账自动发生（wfg2 戳变化，§1.3），不用手写迁移
5. 同步改对应守卫测试

### 3.2 加一句 DOM 文案翻译（先走 §4 决策树定类型）

| 类型 | 落点 | 误伤面 |
|---|---|---|
| 纯固定句（画出来=原文） | pack.json 加词典键（normText 折叠空白后全等匹配） | 零 |
| 模板句（{{var}}/<link> 渲染后拆节点） | ①节点级：若前缀固定 → handlePrefixSentence 加变体 ②块级：PATTERNS 加正则（`^...$` 锚定整单元、输出含汉字） | 正则要求高特异性前缀 |
| 模组名 | 不在 DOM 层翻——走名字管线（cache.json），DOM 只贴 | — |
| 文件名/标识符 | 保持英文是**设计**（isTranslatable 碎片判据+汉字总闸），别加翻译 | — |

- 同一句必须**译文字面统一**：pattern 输出与 handlePrefixSentence 的译文格式一致
  （同一句无论哪种 DOM 形态显示同一译文）。
- 加完补三层断言：词典键存在 / 正则命中 / 降级接线。

### 3.3 改缓存结构/键算法

1. 只能走 `cacheKeyOf` / `dropTranslation`（§1.2），改动点在这两个函数内
2. 写盘一律 `saveJson(file, data, what)`（失败留痕）；守卫测试盯着：谁加回 `writeJson`
   直调，谁红
3. 新引用注入：downloadTargetOf 的测试沙箱要补新函数 stub
   （`typeof X === 'function'` 守卫的函数，沙箱不注入=静默测降级路径）

### 3.4 加一个设置项

1. `config.json` 默认值（注意发布红线：baseUrl/apiKey/model 必须为空）
2. 设置页 UI（index.js 设置页段）
3. 配置读失败**保留内存现值**（不回退 DEFAULT——baseUrl 空=必全灭）
4. 若是开关类，考虑 autostart / startDomRef / autoHook 三处消费点的接线

### 3.5 改自动重试/自愈类逻辑

动手前必须答出两问：
- **触发**：这条链靠什么启动？我改的场景里启动条件会发生吗？（autoHook 只挂 onStateChange）
- **判据**：下游凭什么处理这条数据？我改的标记在判据里占什么位置？（删缓存键 ≠ 回到队列）

答不出 → 先读 §1/§2 链路图，读完再答；还答不出 → 上探针（§5）。

---

### 3.6 加一个手动翻译入口

任何「用户亲手点的」入口（按钮、右键、菜单），除了走正常管线，**必须调一次 `kickDomLayer(原因)`**：

- DOM 层可能因为模型挂机处在 `modelDown` 暂停里，恢复只靠 120 秒一次的探活
- 手动动作不叫醒它，用户看到的就是「模型开了、按钮点了、界面还在排队」
- 同时确认闸门调用是 `gateModel(manual, ...)`，别写死 `false` —— 写死会让手动点击静默失败

## 4. 「这句英文没翻出来」诊断决策树

按序判，命中即停：

```
1. 是模组名/合集名吗？
   └→ 走名字管线（cache.json）。查 cache.json 有没有键：
      有键显示英文 → 名字闸门/贴名路问题
      无键 → collectTargets 没收（needsTranslate/英文骨架 englishBaseNameOf）
2. 是压缩包文件名/含 fileId 版本尾巴吗？
   └→ 保持英文是设计（fileStemOf 放弃通道）。若骨架能剥 → handleFileNameNode
3. 是单词碎片/标识符（如 Sharedddlibs）吗？
   └→ 保持英文是设计（isTranslatable：无空格短词不送模型——模型对无上下文单词
      只会照抄白烧调用；就算送了，汉字总闸也会回滚）
4. 是固定句吗？（画出来的文本=完整英文句）
   └→ pack.json 有没有这个键？有 → 块级没走到/被拦（§2.2 逐条对）；
      没有 → 加键（§3.2）
5. 是模板句吗？（前缀固定+动态尾巴，或带链接）
   └→ DOM 里可能整句在一个文本节点（状态层直渲染名字）→ handlePrefixSentence 变体；
      也可能拆成 前缀节点+链接节点 → 前缀词典键 + pattern 拦送模型 + 降级接线
      ★ 三件套缺一不可，只加 pattern 会「pattern 命中但贴不上→降级→词典 MISS」
6. 都不是？
   └→ 上探针（§5.3），别再推演
```

---

## 5. 验证手段升级路径（按成本递增，停在最便宜够用的那档）

### 5.1 静态走查（第一档，但知道它的边界）

适用：纯函数、判据、顺序在**源码可见**的逻辑。
**不适用**：依赖运行时状态的「滑动判据」——`canBlockReplace`（祖先链）、`coolIfPingPong`
（历史计数）、React 渲染时序。这类静态推演**必然有盲区**，走到「理论全通过但与实况矛盾」
时立即停手升档，禁止第 N 版推演——推演到「理论全通过」仍可能是错的，
探针数据推翻过推演结论。

### 5.2 domCache/数据反推（第二档，零重启成本）

读 `%APPDATA%\Vortex\vortex-modname-zh\` 的 cache.json / domCache.json / failCache.json：
某块**有没有入队痕迹**能定案「死在入队前还是入队后」；某译文是词典还是模型产出
（措辞风格）也能反推。

### 5.3 运行时探针（第三档，一次重启拿全链）

静态走查到极限、数据反推不够时用。做法：
- `dbg(tag, detail)` 去重防刷屏（Set + 条数上限 60），只对目标文本生效（正则过滤）
- 埋在**每个可能的短路出口**：入口、各 gate 的判定值、序列化产物、pattern 命中结果、
  词典查询结果、每层返回值
- 用户重启一次 → 读 `translator.log` 的 `dbg` 行 → 全链数据定案 → **立刻删光探针**

### 5.4 日志铁证（贯穿）

`translator.log` 是唯一可信的过程记录。纪律：不信推理信日志原文；
「每一步日志都在动、屏幕纹丝不动」= 中间环节生效但下游没接。

### 5.5 真模型 A/B（翻译质量改动专用）

改词条/遮蔽/提示词前**必须先跑**真模型对照：起一个本地模型（LM Studio 默认
`http://127.0.0.1:1234` 即可），固定一组样本（六条起：含域内专名、通用词、模组名、
让位全中文），新旧判据各跑一遍，拿到「各方案屏幕效果 + 命中率」再动源码。

---

## 6. 动手前检查单（提交/部署前过一遍）

- [ ] §1/§2 链路图走过一遍，改动落点全部列出（不只是第一处）
- [ ] 触发+判据两问答出来了（§3.5）
- [ ] 翻译质量类：真模型 A/B 跑了（§5.5）
- [ ] bump/打包前清 domCache.json + failCache.json；**部署到运行副本必清扩展缓存+写 seed-skip**
      （例外：对账功能验收需保留现存缓存）
- [ ] 部署时 Vortex 未运行；部署后 md5 比对 + 15 文件白名单
- [ ] 动了配置写盘/读取的：确认「只延迟写文件、内存立即生效」，且读盘处有 `flushCfgWrite()`
- [ ] 验收只认**屏幕上那个字变没变**，中间日志一条不算
