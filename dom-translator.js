'use strict';
// DOM 实时翻译层 —— 段落单元（block-level）翻译引擎
//
// ── 为什么改成这样（对照沉浸式翻译 / KISS-Translator 的做法）────────────────
// 旧实现以「文本节点」为翻译单位，这在富文本里必然碎：
//   <p>Links are now <a>exposed over IPC</a> (<code>nxm://</code> links)</p>
//   → "Links are now" / "exposed over IPC" / "(nxm:// links)" 三条分别送模型
//   → 碎片没有上下文，模型要么照抄要么吐不出 JSON，全部计失败 → 堵死队列
//   → 用户看到的现象：GPU 满载好几分钟，界面还是英文
//
// 现在的做法（和同类插件一致）：
//   1) 以「段落单元」为单位 —— 最内层的块级元素（p/li/h1-h6/td/dd/dt/div…）
//   2) 段落先序列化成带伪标签的串再送翻，**不丢链接、不丢图标**：
//        <a href=x>exposed over IPC</a>  →  <i1>exposed over IPC</i1>
//        <img src=y>                     →  {{2}}
//        <code>nxm://</code>             →  {{3}}
//   3) 模型只翻标签之间的文字，伪标签与占位符必须原样保留（提示词硬约束 + 回填前校验）
//   4) 回填时按伪标签把原元素 clone 回来，所以 a/b/strong 的样式与点击都不受影响
//
// MutationObserver 的回调在绘制之前执行，命中本地词库的替换必须在这里**同步**完成，
// 用户看到的直接就是中文，不会先闪一下英文。只有词库也没有的才排队等模型。

const CJK = /[\u4e00-\u9fa5\u3400-\u4dbf]/;

// 自动重试上限：DOM 层与设置页共用同一个数（设置页「测试连接」要按这个边界只清暂态失败）
const RETRY_MAX = 3;

function startDomTranslator(opts) {
  const { cfg, cache, failCache, termExact, lexicon, keepEn, translateBatch, translateConcurrently, log, save, saveCollect, saveFail } = opts;
  // 采集是跨会话累积的素材，启动时接着上次的攒，不能每次清空
  const collected = new Set(Array.isArray(opts.collected) ? opts.collected : []);
  const failed = failCache || {};
  // 明确「保持英文」的名字（gamenames-keep.json）：不送模型、不记失败、不当成待翻。
  // 不能再靠「往 cache 里写值=原文」来表达 —— 下面就有一条自清洗专门删这种条目。
  const keepSet = keepEn instanceof Set ? keepEn : new Set();
  // 每条最后一次失败的时间：只有 failed 计数没有时间，idleRevive 每 10 秒把 failed<4 的全放回去，
  // 结果是「必失败的条目」10 秒重试一次、无限循环（实测 inZOI 那条烧了几十次调用）。用它做冷却。
  const lastFail = new Map();
  let collectTimer = null;
  if (typeof document === 'undefined' || !document.body) return;

  // ── 实时状态（设置页的「实时队列」面板直接读这个对象）──
  const live = opts.statusRef || {};
  live.inflight = [];      // [{ text, start }]  本批正在翻的
  live.recent = [];        // [{ text, zh, ok, ms }]  最近完成的（新→旧）
  live.queued = 0;
  live.ok = 0;
  live.fail = 0;
  live.hits = 0;           // 词库/缓存直接命中（0 次模型调用）
  live.skipped = 0;
  live.modelDown = false;
  live.lastBatchAt = 0;
  live.groups = 0;         // 当前真正在飞的组数
  live.lastDoneAt = 0;     // 上一批完成时间（面板空闲时显示「x 秒前完成」）
  live.per = 0;            // 上一批拆分出的组数
  live.lanes = 0;

  // 启动自检：清洗假翻译（译文=原文 / 译文不含中文），否则对应文本永久卡在英文
  {
    let cleaned = 0;
    for (const k of Object.keys(cache)) {
      if (keepSet.has(k)) continue;          // 显式要求保持英文的，不算假翻译
      const v = cache[k];
      if (!v || v === k || !CJK.test(v)) { delete cache[k]; cleaned++; }
    }
    if (cleaned > 0) { log('info', 'dom cache self-clean', { cleaned }); if (save) save(); }
  }

  // ── 标签分类 ──
  // 整棵跳过（内容不是可见文案，或者翻了会坏）
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'SVG', 'PATH', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED']);
  // 整块以占位符保留（不送翻，原样插回去）
  // PRE 也算原样保留：回填时 norm() 会把所有空白（包括换行）折叠成一个空格，
  // 多行 pre 会被粘成一行、排版塌掉。宁可整块不翻，也不要翻坏。
  const RAW_TAGS = new Set(['CODE', 'KBD', 'VAR', 'SAMP', 'TT', 'MATH', 'PRE']);
  // 行内元素：保留成 <iN>…</iN>，回填时 clone 原节点，链接与样式都保住
  const INLINE_TAGS = new Set(['A', 'B', 'STRONG', 'EM', 'I', 'U', 'S', 'SMALL', 'MARK', 'SUB', 'SUP',
    'SPAN', 'FONT', 'CITE', 'Q', 'ABBR', 'TIME', 'INS', 'DEL', 'BDI', 'BDO']);
  // 块级：段落单元的边界
  const BLOCK_TAGS = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'DD', 'DT',
    'BLOCKQUOTE', 'FIGCAPTION', 'SUMMARY', 'CAPTION', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE',
    'HEADER', 'FOOTER', 'MAIN', 'NAV', 'FORM', 'FIELDSET', 'ADDRESS', 'LABEL', 'PRE']);
  // 这些块整块替换会把控件/图标干掉 → 退回节点级
  const UNSAFE_SEL = 'button,input,select,textarea,[role="button"],[contenteditable="true"],video,audio,canvas,iframe';
  // 菜单/工具栏里的块不整块替换（里面是图标 + 短标签，整块换会把图标清掉）
  const NO_BLOCK_SEL = 'button,[role="button"],nav,[class*="menu"],[class*="toolbar"],[class*="breadcrumb"],[class*="pagination"],[class*="sidebar"]';
  // 通知 / 弹窗是 React 控件区：这里的元素常常绑着点击回调（不只是跳转），整块重建会把
  // 它们换掉，React 回来更新时找不到节点就陷入重渲染循环（Vortex 2.9.0 更新通知的下载
  // 按钮就是这个情况）。所以在这片区域里，链接也一并当交互元素，只改文字、不重建 DOM。
  const UI_INTERACTIVE_SEL = '[class*="notification"],[class*="toast"],[class*="modal"],[class*="dialog"]';
  // 但 changelog / 简介这类内容区常常就显示在弹窗里，里面的链接是纯外链，而且整块翻
  // 译文才连贯 —— 命中内容区就维持原样，不加严，免得长文翻译质量倒退。
  // 只保留「确定是纯内容区」的四个。原来还挂着 note / summary / preview 三个，
  // 但它们是子串匹配，太宽：任何叫 xx-preview、xx-summary 的容器都会被当成内容区，
  // 于是里面的 <a href> 不再算交互元素 → 整块重建把链接节点换掉。
  // 后果取决于那个链接是不是 React 绑了 onClick 的（0.15.9 卡死就是按钮被换掉这一套）。
  // 取证：Vortex 2.9 前端包里搜不到任何 note-panel / summary-bar / preview-strip 这类
  // 容器类名（命中的全是 AWS/markdown 的无关字符串），即这三个在现实里基本不命中，
  // 去掉它们不会让任何真实页面少翻一个字 —— 纯粹是拆掉一个没用的定时炸弹。
  const CONTENT_TEXT_SEL = '[class*="changelog"],[class*="description"],[class*="markdown"],[class*="readme"]';

  const ATTRS = ['title', 'placeholder', 'aria-label'];
  const MAX_LEN = 3000;   // 单个翻译单元上限；超过则切分成多片（见 splitUnit）
  const PART_LEN = 800;   // 超长块切片目标长度（本地 7B 一次 800 字符最稳，不会截断）

  // ── 重试预算 ──
  // failed[键] 的取值语义（持久化在 failCache.json，负数不要当成脏数据）：
  //   > 0       可重试失败次数，按 BACKOFF 退避；到 MAX_TRY+1 就是永久放弃
  //   -1        判定「不可译」：模型连续两次原样返回，或原文本身没有可译内容。
  //             永不自动重试 —— 之前没有这一档，模型稳定照抄的条目（inZOI Vortex Extension
  //             这类专名）会每 10 秒复活一次、无限烧调用。
  const MAX_TRY = RETRY_MAX;
  const BACKOFF = [45e3, 4 * 60e3, 15 * 60e3];   // 第 1/2/3 次重试前的等待
  const UNTRANSLATABLE = -1;
  // 同一段文字被「可见即复活」的上限：用户盯着看也只给 2 次补充机会，再多就是白烧
  const MAX_VISIBLE_REVIVE = 2;

  // 只有这些「内容容器」里的块才允许整块重建 DOM。
  // 其它地方（设置页、列表、卡片，都是 React 高频重渲染的区域）一律只改文本节点，
  // 绝不删节点 —— 否则 React 下次 insertBefore 找不到它记得的节点就整页崩
  const CONTENT_SEL = '[class*="changelog"],[class*="description"],[class*="markdown"],[class*="readme"],' +
    '[class*="install"],[class*="note"],[class*="summary"],[class*="tooltip"],[class*="preview"],' +
    '[class*="modal"],[class*="dialog"],[class*="notification"],[class*="toast"]';

  // ── 本地静态词典：整包词条 + 固定术语，命中即换，0 次模型调用、0 token ──
  const lex = lexicon || {};
  const lexLower = new Map();
  const lexNorm = new Map();       // 空白规范化后的索引（DOM 里的空白和词库里的换行对不上）
  for (const k of Object.keys(lex)) {
    if (typeof lex[k] !== 'string') continue;   // 嵌套对象（i18next 点路径结构）不是译文，跳过
    const lk = k.toLowerCase();
    if (!lexLower.has(lk)) lexLower.set(lk, lex[k]);
    const nk = normText(k);
    if (nk && !lexNorm.has(nk)) lexNorm.set(nk, lex[k]);
  }

  function normText(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  /** 最小 HTML 实体解码。serialize 的 esc() 把 & < > 转义成实体送给模型，
   *  而 applyInPlace 是直接写 nodeValue（不像 restore 走 innerHTML 会被浏览器解码），
   *  不解的话页面上会显示「Q&amp;A」。只处理这 6 个，不做完整 HTML 解码。 */
  function unescapeMin(s) {
    return String(s == null ? '' : s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');          // & 放最后，避免把 &amp;lt; 二次解码
  }

  /** 「["LogicMods Load Order"]」这种被 JSON 包了一层的标题：
   *  Vortex 渲染扩展注册的页面标题时会把它变成 JSON 数组字符串，
   *  翻译只该换里面的字，外壳不该跟着显示在界面上。 */
  const JSON_SHELL = /^\s*\[\s*"([\s\S]*)"\s*\]\s*$/;
  function shellInner(s) {
    // 壳可能被伪标签包着（块级序列化后是 <i1>["X"]</i1>），先剥掉伪标签再判断
    const plain = String(s == null ? '' : s).replace(/<\/?i\d+>/g, '');
    const m = plain.match(JSON_SHELL);
    return m ? m[1] : null;
  }
  function stripShell(src, zh) {
    if (zh == null) return zh;
    if (shellInner(src) == null) return zh;
    // 译文可能是 ["…"]，也可能是 <i1>["…"]</i1>：只剥括号和引号，标签留着
    const m = String(zh).match(/^(<i\d+>)?\s*\[\s*"([\s\S]*)"\s*\]\s*(<\/i\d+>)?$/);
    if (m) return (m[1] || '') + m[2] + (m[3] || '');
    return zh;
  }

  // ── 队列 ──
  // 队列里同时放两种单位：段落单元（序列化后的 src，含伪标签）与节点级纯文本
  const queue = new Set();
  const queueMeta = new Map();          // src -> { ts, visible }
  const pendingBySrc = new Map();       // src -> Set<el>  等待回填的元素（块级）
  let flushTimer = null;
  let saveTimer = null;
  let flushing = false;
  let writing = false;
  // 写入期间 MutationObserver 的回调直接被丢掉：如果 React 在我们写的时候同步重渲染
  // （redux dispatch 常常同步），那批 mutation 就永久丢失，元素停在英文等 2 秒后的重扫。
  // 改成「先记一笔，写完立刻补扫一次」。
  let pendingAfterWrite = false;
  // 页面自上次扫描后是否变化过。rescan 原来无条件每 2 秒 walk(document.body) 一遍，
  // 列表页挂机（200+ 模组、已经全中文）也照跑，白烧 CPU。没有变更就直接跳过。
  let docDirty = true;
  let modelDown = false;                // 连续 2 轮 0 成功 → 判定模型挂机，暂停重试

  // ── 抗卡死三件套（2026-10-21 修复 Vortex 更新下载时 renderer 吃满一个核）──
  // 1) 拉锯熔断：同一文本节点被改写超过 WRITE_PATIENCE 次就判定「写了被还原、还原了再写」
  const writeCount = new WeakMap();     // el -> Map<原文, 已改写次数>（不能按 textNode 记，会被重建）
  const WRITE_PATIENCE = 6;
  const PINGPONG_COOL_MS = 60000;       // 熔断后的冷却时长，到点再给一次机会
  let pingPong = 0;                     // 被熔断的节点总数（面板可看）
  // 2) 补扫退避：连续补扫次数越多，间隔越长，杜绝 120ms 一次的自持全树重扫
  let burst = 0;
  let lastBurstAt = 0;
  let afterWriteTimer = null;
  const BURST_GAPS = [120, 120, 300, 1000, 3000, 8000];
  const BURST_ALERT = 6;
  // 3) 扫描时间预算：单次 walk 超预算就收手，剩下的下一轮接着扫，不让长任务卡主线程
  const WALK_BUDGET_MS = 60;
  let walkTruncated = 0;
  let resumeNode = null;                // 被时间预算截断时的断点，下一轮从这里继续
  let downStreak = 0;

  // 可见性优先：用户正在看的弹窗/面板插队，不再被后台文本饿死
  const viewH = () => (typeof window !== 'undefined' && window.innerHeight) || 900;
  function inViewport(el) {
    try {
      const r = el.getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0)) return false;
      return r.bottom > 0 && r.top < viewH() && r.right > 0;
    } catch (e) { return false; }
  }

  /** 不该翻的东西：颜色值、版本号、文件大小、CSS 类名、纯数字、下载文件名、本地路径… */
  function isNoise(s) {
    if (/^#[0-9a-f]{3,8}$/i.test(s)) return true;
    if (/^[vV]?\d+(\.\d+)+([-a-z0-9.]*)?$/i.test(s)) return true;
    if (/^\d+(\.\d+)?\s?(B|KB|MB|GB|TB|KiB|MiB|GiB)$/i.test(s)) return true;
    // 下载速度 / 进度百分比这类动态数值：每刷新一次就是一个新串（"384 KB/s"），
    // 而且常被拼成一坨（实测 "384 KB/s640 KB/s896 KB/s"）。翻不出任何东西，还会
    // 不停产生新词条、失败后反复重试，白烧调用。整体只由「数字+单位+%/s」构成才算噪声。
    if (/^(\s*\d[\d.,]*\s*(B|KB|MB|GB|TB|KiB|MiB|GiB)?\s*(\/s|%)?\s*)+$/i.test(s)) return true;
    if (/^\d+$/.test(s)) return true;
    if (/^[\d\s.,:%+\-–—/()]+$/.test(s)) return true;
    if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(s) && !/[A-Z]/.test(s)) return true;
    if (/^(--|var\()/.test(s)) return true;
    if (/^(https?:|www\.)/i.test(s)) return true;
    if (/^[A-Za-z]:[\\/]/.test(s)) return true;
    if (/\d{4}-\d{2}-\d{2}T|\.(zip|7z|rar)$/i.test(s)) return true;
    if (!/\s/.test(s) && /^[A-Z]{2,}[a-z]/.test(s)) return true;      // REFramework 类驼峰专名
    if (!/\s/.test(s) && /^[a-z]{1,6}[A-Z]{2,}/.test(s)) return true;  // inZOI 这类小写开头的专名
    if (!/\s/.test(s) && s.length < 16 && /^(?=.*\d)[a-z0-9]+$/.test(s)) return true;
    return false;
  }

  /** 节点级（纯文本）是否值得送翻 */
  function isTranslatable(s, el) {
    if (s.length < 3 || s.length > MAX_LEN) return false;
    if (CJK.test(s)) return false;
    if (isNoise(s)) return false;
    // 句子碎片：富文本把一句话拆成 with / Added / Fixed 这种单词，单独送翻既翻不出东西
    // 又会让整批失败（模型对着没有上下文的单词只会照抄）→ 判断依据：它只是父块里的一小段
    if (!/\s/.test(s) && s.length <= 12 && /^[A-Za-z]+$/.test(s) && el) {
      const box = el.parentElement;
      const whole = box ? (box.textContent || '').trim() : '';
      if (whole.length > s.length + 4) return false;
    }
    // 首字符白名单：以前要求必须是 ASCII 字母或括号，结果 `· Added support…`、
    // `1. Fixed crash`、`- 新增难度` 这类 bullet 行整行被跳过，更新日志一片英文。
    // 改成「至少含 2 个连续英文字母」就行，纯符号/纯数字/路径交给 isNoise 和下面的字符占比。
    if (!/[A-Za-z]{2,}/.test(s)) return false;
    let ok = 0, total = 0;
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (cp > 0x2fff || cp === 0xfe0f || cp === 0x200d) continue;
      total++;
      if (/[A-Za-z0-9 ,.\-':&()%!?/\[\]{}"»«#+_…—–''"“”]/.test(ch)) ok++;
    }
    return total > 0 && ok / total > 0.85;
  }

  /** 段落单元（可能带 <iN> / {{N}}）是否值得送翻 */
  function okUnit(s) {
    if (!s || s.length < 2 || s.length > MAX_LEN) return false;
    if (CJK.test(s)) return false;
    const plain = s.replace(/<\/?i\d+>/g, ' ').replace(/\{\{\d+\}\}/g, ' ').replace(/\s+/g, ' ').trim();
    if (!plain || !/[A-Za-z]{2,}/.test(plain)) return false;
    if (isNoise(plain)) return false;
    if (!/[A-Za-z]{2,}/.test(plain)) return false;
    return true;
  }

  // ── 动态文案模板：Vortex 的通知是运行时拼出来的，词库穷举不了 ──
  // 例："8 mod updates available"（用户实测漏翻的就是这条）
  const PATTERNS = [
    [/^What'?s\s+new\s+in\s+(.+?)\s*\??$/i, (m) => `${m[1]} 新内容`],
    [/^What'?s\s+new\s*\??$/i, () => '新内容'],
    [/^Version\s+([\d][\d.]*\S*)$/i, (m) => `版本 ${m[1]}`],
    [/^v(ersion)?\s*([\d][\d.]*\S*)\s*\((.+)\)$/i, (m) => `版本 ${m[2]}（${m[3]}）`],
    [/^(\d[\d,]*)\s+mods?\s+updates?\s+available\.?$/i, (m) => `${m[1]} 个模组可更新`],
    [/^(\d[\d,]*)\s+(?:new\s+)?updates?\s+available\.?$/i, (m) => `${m[1]} 个更新可用`],
    [/^(\d[\d,]*)\s+mods?\s+installed\.?$/i, (m) => `已安装 ${m[1]} 个模组`],
    // 2.9.0 健康检查改版新增的两条动态文案（{{count}}/{{modName}} 渲染后是实际值）
    [/^Install\s+selected\s*\((\d+)\)$/i, (m) => `安装所选（${m[1]}）`],
    [/^Missing\s+mod\s+may\s+be\s+required\s+for:\s*(.+)$/i, (m) => `可能缺少 ${m[1]} 所需的模组`],
    [/^(\d[\d,]*)\s+mods?\s+enabled\.?$/i, (m) => `已启用 ${m[1]} 个模组`],
    [/^(\d[\d,]*)\s+mods?\s+disabled\.?$/i, (m) => `已停用 ${m[1]} 个模组`],
    [/^(\d[\d,]*)\s+mods?\s+deployed\.?$/i, (m) => `已部署 ${m[1]} 个模组`],
    [/^(\d[\d,]*)\s+files?\s+downloaded\.?$/i, (m) => `已下载 ${m[1]} 个文件`],
    [/^(\d[\d,]*)\s+mods?\s+need\s+updating\.?$/i, (m) => `${m[1]} 个模组需要更新`],
    [/^Downloading\s+(.+)$/i, (m) => `正在下载 ${m[1]}`],
    [/^Installing\s+(.+)$/i, (m) => `正在安装 ${m[1]}`],
    [/^Deploying\s+(.+)$/i, (m) => `正在部署 ${m[1]}`],
    [/^Deleting\s+(.+)$/i, (m) => `正在删除 ${m[1]}`],
    [/^Extracting\s+(.+)$/i, (m) => `正在解压 ${m[1]}`],
    [/^Update\s+available\s+for\s+(.+)$/i, (m) => `${m[1]} 有可用更新`],
    [/^(.+?)\s+update\s+available\.?$/i, (m) => `${m[1]} 有可用更新`],
    // 必须输出中文：写成 "2 / 10" 这种没有汉字的译文，applyInPlace 会判「没翻出来」回滚，
    // 而回滚本身又产生一条 mutation → 观察者再扫 → 再写 → 再回滚，界面当场冻死。
    [/^(\d[\d,]*)\s+of\s+(\d[\d,]*)$/, (m) => `第 ${m[1]} / 共 ${m[2]}`],
    [/^(\d[\d,]*)\s+selected\.?$/i, (m) => `已选中 ${m[1]} 项`],
    [/^(\d[\d,]*)\s+items?\s+selected\.?$/i, (m) => `已选中 ${m[1]} 项`],
  ];
  function patternHit(s) {
    const t = normText(String(s).replace(/<\/?i\d+>/g, '').replace(/\{\{\d+\}\}/g, ''));
    if (!t) return null;
    for (const [re, fn] of PATTERNS) {
      const m = t.match(re);
      if (!m) continue;
      let out = null;
      try { out = fn(m); } catch (e) { /* ignore */ }
      // 输出不含汉字的规则一律作废：写上去也会被 applyInPlace 判「没翻出来」回滚，
      // 而回滚本身又产生一条 mutation → 观察者再扫 → 再写 → 再回滚，
      // 整套循环跑在微任务里，定时器永远排不上队，界面直接冻死（"1 of 5" 就是这么卡的）。
      // 这里是总闸门：以后再加 pattern，输出没中文也不会把页面搞死。
      if (out && CJK.test(out)) return out;
    }
    return null;
  }

  function lookup(t) {
    const r = lookupRaw(t);
    return (r == null) ? r : stripShell(t, r);
  }

  function lookupRaw(t) {
    if (!t) return null;
    if (termExact) {
      // 建表时用 normKey 归一过（Vortex 的 known 游戏名有 13 个带制表符），
      // 这里必须同样归一，否则「Fallout://tNew Vegas」永远查不到。
      const hit = termExact.get(normText(t).toLowerCase());
      if (hit && hit !== t) return hit;
    }
    let lx = lex[t] || lexLower.get(String(t).toLowerCase());
    if (lx && typeof lx === 'object') lx = null;
    if (lx && lx !== t) return lx;
    // 无条件查一次归一化索引。以前这里有个 `if (nk !== t)` 短路，等于假设
    // 「文本自身已经规范化的就不用查了」—— 但词库里同一条内容可能有两个形态
    // （源码里的多行版 / DOM 里的单行版），合并成一条后，单行文本只有这条索引能命中，
    // 一短路就整条查不到、退回英文。
    const nth = lexNorm.get(normText(t));
    if (nth && nth !== t) return nth;
    const c = cache[t];
    if (c && c !== t) return c;
    return null;
  }

  // ── 段落单元：找最内层块级元素 ──
  function hasBlockChild(el) {
    for (const c of el.children) {
      if (BLOCK_TAGS.has(c.tagName) && (c.textContent || '').trim()) return true;
    }
    return false;
  }

  /** 扩展自己的设置页整页跳过（防止 React 重渲染冲突把设置页搞崩），
   *  但更新日志这类内容块例外：Vortex 的 changelog 可能嵌在设置容器里，
   *  整页跳过会把更新日志一起变回英文（用户实测「更新日志又变英文了」）。 */
  function isZhSkip(el) {
    if (!el || !el.closest || !el.closest('[data-zh-skip]')) return false;
    return !el.closest('[class*="changelog"]');
  }

  function leafBlockOf(node) {
    let el = node.parentElement;
    let guard = 0;
    while (el && el !== document.body && el !== document.documentElement) {
      if (++guard > 14) return null;
      if (SKIP_TAGS.has(el.tagName)) return null;
      if (isZhSkip(el)) return null;
      const tag = el.tagName;
      // 交互控件：它的文本单独走节点级（整块替换会把图标/边框干掉）
      if (tag === 'BUTTON' || tag === 'SUMMARY' || (el.getAttribute && el.getAttribute('role') === 'button')) return null;
      if (BLOCK_TAGS.has(tag)) return hasBlockChild(el) ? null : el;
      el = el.parentElement;
    }
    return null;
  }

  function canBlockReplace(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest && el.closest(NO_BLOCK_SEL)) return false;
    // 默认从严：只要块里含交互元素（含链接）就不整块重建，与容器叫什么名字无关。
    // 通知有更新 / 模组更新 / 错误 / 扩展更新好几种，类名各不相同，靠
    // [class*="notification"] 这种前缀匹配早晚漏一种 —— 与其猜名字，不如一律从严。
    // 只有 changelog / 简介这类「内容区」才放宽链接（那里的链接是纯外链，且整块翻才连贯）。
    let sel = UNSAFE_SEL + ',a[href]';
    try {
      if (el.closest && el.closest(CONTENT_TEXT_SEL)) sel = UNSAFE_SEL;
    } catch (e) { /* ignore */ }
    let bad;
    try { bad = el.querySelector(sel); } catch (e) { return false; }
    return !bad;
  }

  // ── 序列化：段落 → 带伪标签的串 ──
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function serialize(el) {
    const map = new Map();
    const slots = [];        // 原文的槽位序列，用于「原地回填」：{k:'t',node} / {k:'i',id,node}
    let n = 0;
    let out = '';
    const addRaw = (node) => {
      n++;
      map.set(String(n), node.cloneNode(true));
      slots.push({ k: 'p', id: String(n), node });
      out += '{{' + n + '}}';
    };
    const walk = (node) => {
      if (node.nodeType === 3) {
        out += esc(node.nodeValue);
        slots.push({ k: 't', node });
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (RAW_TAGS.has(tag) || tag === 'IMG' || tag === 'BR' || tag === 'HR') { addRaw(node); return; }
      if (SKIP_TAGS.has(tag)) {
        // svg/input 之类：整块原样保留成占位符（不会破坏布局）
        if (tag === 'SVG' || tag === 'CANVAS' || tag === 'VIDEO' || tag === 'AUDIO') addRaw(node);
        return;
      }
      if (INLINE_TAGS.has(tag)) {
        const id = ++n;
        // 必须登记原节点：回填时用它 clone 出真实的 <a>/<b>，链接与样式才保得住
        map.set(String(id), node.cloneNode(false));
        out += '<i' + id + '>';
        slots.push({ k: 'i', id: String(id), node });
        for (const c of Array.from(node.childNodes)) walk(c);
        out += '</i' + id + '>';
        return;
      }
      // 其它（块级/未知）：只取内容，不包标签
      for (const c of Array.from(node.childNodes)) walk(c);
    };
    for (const c of Array.from(el.childNodes)) walk(c);
    return { src: normText(out), map, slots };
  }

  // ── 还原：把带伪标签的译文换回真 DOM（链接、加粗、图标全部回来）──
  const SAFE_OUT = new Set(['B', 'STRONG', 'EM', 'I', 'U', 'S', 'SMALL', 'MARK', 'SUB', 'SUP', 'SPAN',
    'A', 'CITE', 'Q', 'ABBR', 'TIME', 'BR', 'P', 'DIV', 'LI', 'UL', 'OL']);

  function restore(zh, map) {
    let html = String(zh)
      .replace(/<i(\d+)>/g, '<span data-tag="$1">')
      .replace(/<\/i(\d+)>/g, '</span>')
      .replace(/\{\{(\d+)\}\}/g, '<span data-ph="$1"></span>');
    const tmp = document.createElement('div');
    try { tmp.innerHTML = html; } catch (e) { return null; }

    const fix = (node) => {
      if (node.nodeType === 3) return document.createTextNode(node.nodeValue);
      if (node.nodeType !== 1) return document.createTextNode('');
      if (node.hasAttribute('data-tag')) {
        const orig = map.get(node.getAttribute('data-tag'));
        if (!orig) return document.createTextNode(node.textContent || '');
        const clone = orig.cloneNode(false);          // 保留原标签与属性，只换内容
        for (const c of Array.from(node.childNodes)) clone.appendChild(fix(c));
        return clone;
      }
      if (node.hasAttribute('data-ph')) {
        const raw = map.get(node.getAttribute('data-ph'));
        return raw ? raw.cloneNode(true) : document.createTextNode('');
      }
      const tag = String(node.tagName || '').toLowerCase();
      if (!SAFE_OUT.has(node.tagName)) {
        const f = document.createDocumentFragment();
        for (const c of Array.from(node.childNodes)) f.appendChild(fix(c));
        return f;
      }
      const nel = document.createElement(tag);
      for (const a of Array.from(node.attributes)) {
        if (/^on/i.test(a.name) || /^data-/i.test(a.name)) continue;
        try { nel.setAttribute(a.name, a.value); } catch (e) { /* ignore */ }
      }
      for (const c of Array.from(node.childNodes)) nel.appendChild(fix(c));
      return nel;
    };

    const frag = document.createDocumentFragment();
    for (const c of Array.from(tmp.childNodes)) frag.appendChild(fix(c));
    return frag;
  }

  /** 把带伪标签的串解析成 token 树：{k:'t',v} / {k:'i',id,children} / {k:'p',id}
   *  支持嵌套（<span><b></b></span> 这种在列表和标题里很常见），
   *  结构不合法（标签不配对）返回 null */
  function parseTokens(s) {
    const src = String(s == null ? '' : s);
    let pos = 0;
    const NEXT = /<i\d+>|<\/i\d+>|\{\{\d+\}\}/;
    function level(stopId) {
      const out = [];
      while (pos < src.length) {
        let m = /^<i(\d+)>/.exec(src.slice(pos));
        if (m) {
          const id = m[1];
          pos += m[0].length;
          const kids = level(id);
          const close = '</i' + id + '>';
          if (!src.startsWith(close, pos)) throw new Error('unbalanced');
          pos += close.length;
          out.push({ k: 'i', id, children: kids });
          continue;
        }
        m = /^\{\{(\d+)\}\}/.exec(src.slice(pos));
        if (m) { pos += m[0].length; out.push({ k: 'p', id: m[1] }); continue; }
        m = /^<\/i(\d+)>/.exec(src.slice(pos));
        if (m) {
          if (stopId && m[1] === stopId) return out;
          throw new Error('unexpected close');
        }
        const rest = src.slice(pos);
        const nx = rest.search(NEXT);
        if (nx < 0) { out.push({ k: 't', v: rest }); pos = src.length; break; }
        if (nx > 0) { out.push({ k: 't', v: rest.slice(0, nx) }); pos += nx; continue; }
        throw new Error('stuck');
      }
      if (stopId) throw new Error('unclosed');
      return out;
    }
    try { return level(null); } catch (e) { return null; }
  }

  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  /** 原地回填：只改文本节点的 nodeValue，**不增删任何元素节点**。
   *  这是避免「React 找不到节点 → insertBefore 崩溃」的关键：结构不动，React 完全无感。
   *  递归处理嵌套行内元素；任何一层对不齐就整体放弃（交给重建或保持英文）*/
  function applyInPlace(el, zh, slots) {
    const toks = parseTokens(zh);
    if (!toks) return false;
    // 译文里一个汉字都没有就别动 DOM。写了也会在末尾被 CJK 校验判回滚，而回滚本身
    // 产生一条 mutation，观察者会立刻再扫一次 —— 「写→回滚→再写」全在微任务里转，
    // 定时器排不上队，界面就是卡死。预先判掉，一次 DOM 都不碰。
    if (!CJK.test(String(zh).replace(/<\/?i\d+>/g, '').replace(/\{\{\d+\}\}/g, ''))) return false;
    // id → 真实节点（serialize 的 slots 里存的是原节点引用）
    const idOfNode = new Map();
    for (const sl of slots) {
      if (sl.k === 'i' || sl.k === 'p') idOfNode.set(sl.node, { tag: sl.k, id: String(sl.id) });
    }
    // 文本节点全集，用于备份与整体 CJK 校验
    const allText = [];
    const collectAll = (nd) => {
      for (const c of Array.from(nd.childNodes)) {
        if (c.nodeType === 3) allText.push(c); else if (c.nodeType === 1) collectAll(c);
      }
    };
    collectAll(el);
    const backup = allText.map((nd) => [nd, nd.nodeValue]);
    // 回滚也必须挡在 writing 里，并且值没变就不赋值：
    // ① 赋值即产生 MutationRecord，不挡住就会被观察者当成「页面变了」再扫一轮；
    // ② 写回同一个值同样算一次 mutation，白白多一轮。
    const rollback = () => {
      writing = true;
      for (const [nd, v] of backup) { try { if (nd.nodeValue !== v) nd.nodeValue = v; } catch (e) { /* ignore */ } }
      endWrite();
    };

    function writeInto(node, toksList) {
      const W = [];
      for (const c of Array.from(node.childNodes)) {
        if (c.nodeType === 3) {
          const p = W[W.length - 1];
          if (p && p.k === 't') { p.nodes.push(c); p.raw += c.nodeValue || ''; }
          else W.push({ k: 't', nodes: [c], raw: c.nodeValue || '' });
        } else if (c.nodeType === 1) {
          const meta = idOfNode.get(c);
          if (meta) W.push({ k: meta.tag, id: meta.id, node: c });
        }
      }
      const G = [];
      for (const g of toksList) {
        if (g.k === 't') {
          const p = G[G.length - 1];
          if (p && p.k === 't') { p.v += g.v; continue; }
          G.push({ k: 't', v: g.v });
        } else G.push(g);
      }
      const wt = W.filter((w) => w.k !== 't' || norm(w.raw) !== '');
      const gt = G.filter((g) => g.k !== 't' || norm(g.v) !== '');
      if (wt.length !== gt.length) return false;
      for (let i = 0; i < wt.length; i++) {
        if (wt[i].k !== gt[i].k) return false;
        if (wt[i].k !== 't' && String(wt[i].id) !== String(gt[i].id)) return false;
      }
      for (let i = 0; i < wt.length; i++) {
        const w = wt[i];
        const g = gt[i];
        if (w.k === 'p') continue;                 // 图片/代码块：位置不变，原节点留着
        if (w.k === 't') {
          const first = w.nodes[0];
          const lead = String(first.nodeValue || '').match(/^\s*/)[0];
          const tail = String(w.nodes[w.nodes.length - 1].nodeValue || '').match(/\s*$/)[0];
          first.nodeValue = lead + norm(unescapeMin(g.v)) + tail;
          for (let k = 1; k < w.nodes.length; k++) w.nodes[k].nodeValue = '';
        } else {
          const kids = g.children || [];
          if (kids.length === 0) continue;         // 译文把这层标签吃了：保持原内容不动
          if (!writeInto(w.node, kids)) return false;
        }
      }
      return true;
    }

    writing = true;
    const ok = writeInto(el, toks);
    endWrite();
    // 失败必须整体回滚：writeInto 是逐层写的，返回 false 时前面的兄弟节点已经是中文了。
    // 不回滚就会留下「使用 this mod now」这种夹生文本，而且译文已进缓存，2 秒重扫也不会再修。
    if (!ok) { rollback(); return false; }
    // 写完必须真的有中文，否则回滚：宁可整块留英文，也不要留一坨半英半中被反复重翻
    if (!CJK.test(el.textContent || '')) { rollback(); return false; }
    return true;
  }

  /** 是否属于允许整块重建的内容容器 */
  function isContentBox(el) {
    try { return !!(el.closest && el.closest(CONTENT_SEL)); } catch (e) { return false; }
  }

  /** 超长块切分：按句子切（不切断伪标签与占位符），保证每片的 <iN> 配对完整
   *  关键点：一个块往往只有一个超长文本节点，光按「标签之间」切切不开，
   *  必须在文本内部按句末标点继续切，否则整段还是原封不动送出去（必被截断） */
  const SENT_SPLIT = /(?<=[.!?;:])\s+/;

  function splitUnit(src, limit) {
    const toks = parseTokens(src);
    if (!toks) return [src];
    // ① 把长文本 token 在内部按句子再拆，其余（标签/占位符）原样作为一个 token
    const fine = [];
    for (const tk of toks) {
      if (tk.k !== 't' || tk.v.length <= limit) { fine.push(tk); continue; }
      const sents = String(tk.v).split(SENT_SPLIT).filter((x) => x !== '');
      for (const s of sents) {
        if (s.length <= limit) { fine.push({ k: 't', v: s }); continue; }
        // 一句话本身还超长（没有标点）：按空格硬切
        let rest = s;
        while (rest.length > limit) {
          let cut = rest.lastIndexOf(' ', limit);
          if (cut < limit * 0.5) cut = limit;
          fine.push({ k: 't', v: rest.slice(0, cut) });
          rest = rest.slice(cut);
        }
        if (rest) fine.push({ k: 't', v: rest });
      }
    }
    // 注意：parseTokens 产出的行内 token 是 { k:'i', id, children }，**没有 v 字段**。
    // 这里曾经写成 tk.v，超长块一切片就变成字面量 <i1>undefined</i1>：
    // 行内元素的原文丢了，模型再顺手翻一下就成了「未定义」，而这段还会进缓存，清缓存照旧复现。
    const seg = (tk) => (tk.k === 't' ? tk.v
      : (tk.k === 'i' ? '<i' + tk.id + '>' + (tk.children || []).map(seg).join('') + '</i' + tk.id + '>'
        : '{{' + tk.id + '}}'));
    // ② 累积到 limit 就收一片，尽量在句子边界断开
    const parts = [];
    let cur = [], curLen = 0;
    for (let i = 0; i < fine.length; i++) {
      const tk = fine[i];
      const s = seg(tk);
      cur.push(tk); curLen += s.length;
      if (curLen < limit) continue;
      // 到量了还没到句末 → 再多吃几段，别切半句（上限 1.6 倍）
      const atEnd = (t) => t.k === 't' && /[.!?;:。！？；][)"'\]]*\s*$/.test(String(t.v).trim());
      while (!atEnd(fine[i]) && i + 1 < fine.length && curLen < limit * 1.6) {
        i++;
        cur.push(fine[i]); curLen += seg(fine[i]).length;
      }
      parts.push(cur); cur = []; curLen = 0;
    }
    if (cur.length) parts.push(cur);
    const out = parts.map((p) => p.map(seg).join('')).filter((s) => s.trim());
    return out.length > 1 ? out : [src];
  }

  function applyUnit(el, zh, map, slots) {
    if (!zh || zh === (el.textContent || '')) return false;
    // ① 优先原地回填：结构一个节点都不动（React 安全），链接与样式也天然保住
    if (slots && slots.length > 0 && applyInPlace(el, zh, slots)) {
      el.setAttribute('data-zh-block', '1');
      el.removeAttribute('data-zh-key');
      scheduleSave();
      return true;
    }
    // ② 结构对不上才重建 —— 但只在内容容器里做，且这块不能是我们不认识的 React 区域
    if (!isContentBox(el)) return false;
    const frag = restore(zh, map);
    if (!frag) return false;
    const txt = frag.textContent || '';
    if (!CJK.test(txt)) return false;         // 模型返回原文/空白 → 不动 DOM
    writing = true;
    try {
      el.setAttribute('data-zh-block', '1');
      el.removeAttribute('data-zh-key');
      while (el.firstChild) el.removeChild(el.firstChild);
      el.appendChild(frag);
    } catch (e) {
      endWrite();
      return false;
    }
    endWrite();
    scheduleSave();
    return true;
  }

  // ── 入队 / 出队 ──
  /** 失败/已放弃的条目：只要这块正被用户看着，冷却 90 秒后给它一次机会。
   *  之前是「失败过就永久跳过」，结果是更新日志这类长条目一旦被判失败，
   *  重新打开页面也永远是英文，只能清缓存重来。 */
  function reviveIfVisible(src, el) {
    const n = failed[src];
    if (n === undefined || n === 0) return true;
    // 还在可重试区间：交给 retrySweep 按退避走。见光就复活会把退避变成摆设，
    // 滚动一次列表就能让一批条目反复重试。
    if (n > 0 && n <= MAX_TRY) return false;
    // n === -1（不可译）或 > MAX_TRY（已放弃）：只有用户真的盯着这段英文看，才值得再给一次
    if (!el || !inViewport(el)) return false;
    const rv = reviveCount.get(src) || 0;
    if (rv >= MAX_VISIBLE_REVIVE) return false;
    if (Date.now() - (reviveAt.get(src) || 0) < 300000) return false;
    // 全局节流：20 秒内最多复活 4 条。不然模型一出错，几十条同时复活、
    // 又一起失败，日志里刷一屏 revive visible，队列和显存全被打满。
    const now = Date.now();
    if (now - reviveBudgetAt > 20000) { reviveBudgetAt = now; reviveBudget = 4; }
    if (reviveBudget <= 0) return false;
    reviveBudget -= 1;
    reviveAt.set(src, now);
    reviveCount.set(src, rv + 1);
    delete failed[src];
    if (saveFail) saveFail(failed);
    log('info', 'revive visible', { n, rv: rv + 1, sample: String(src).slice(0, 40) });
    return true;
  }

  function enqueue(src, el) {
    if (keepSet.has(src)) return;          // 明确保持英文
    if (cache[src] !== undefined) return;
    if (!reviveIfVisible(src, el)) return;
    if (queueMeta.has(src)) {
      // 已在队列：只把元素挂上（同一个 src 可能对应多个元素）
      let set = pendingBySrc.get(src);
      if (!set) { set = new Set(); pendingBySrc.set(src, set); }
      set.add(el);
      return;
    }
    queue.add(src);
    queueMeta.set(src, { ts: Date.now(), visible: inViewport(el) });
    let set = pendingBySrc.get(src);
    if (!set) { set = new Set(); pendingBySrc.set(src, set); }
    set.add(el);
    try { el.setAttribute('data-zh-key', '1'); } catch (e) { /* ignore */ }
    live.queued = queue.size;
  }

  /** 段落单元处理（同步命中即换；否则入队）
   *  返回 true=已替换 / false=已入队或无需处理 / 'nodelevel'=这块不适合整块翻，请按文本节点处理 */
  const seenLen = new WeakMap();   // el -> 上次处理时的文字长度，用来跳过没变化的块
  const reviveAt = new Map();      // src -> 上次「可见复活」时间，防止反复重试烧 token
  const reviveCount = new Map();   // src -> 被可见复活过几次（封顶 MAX_VISIBLE_REVIVE）
  let reviveBudget = 8;            // 当前 20 秒窗口内还能复活几条
  let reviveBudgetAt = 0;

  function processBlock(el) {
    if (!el || !el.isConnected) return false;
    if (el.getAttribute('data-zh-block') === '1') {
      // React 重渲染会把内容还原成英文，但标记还留着 → 会永久卡英文，这里摘掉重来
      const cur = el.textContent || '';
      if (cur && !CJK.test(cur)) el.removeAttribute('data-zh-block');
      else return false;
    }
    // 内容容器以外的地方（列表行、卡片、设置页…）：只要块里挂的子元素不多，
    // 照样整块翻 —— 回填走「原地改文本」的路子，不增删节点，React 不会跟着崩。
    // 子元素特别多的容器（整片区域）才退回节点级，避免一句话把十几个控件粘在一起
    if (!isContentBox(el) && el.children.length > 12) return 'nodelevel';

    const len = (el.textContent || '').length;
    if (el.getAttribute('data-zh-key') === '1' && seenLen.get(el) === len) return false;
    seenLen.set(el, len);

    const { src, map, slots } = serialize(el);
    if (!src) return false;

    // 显式要求保持英文的名字（gamenames-keep.json）：打标记后直接走，不送翻、不记失败
    if (keepSet.has(src) || keepSet.has(normText(src))) {
      try { el.setAttribute('data-zh-key', '1'); } catch (e) { /* ignore */ }
      return false;
    }

    // 超长块（整段更新日志动辄几千字符，单次送模型必截断）→ 切片翻译再拼
    if (src.length > MAX_LEN) return processLongBlock(el, src, map, slots);

    if (!okUnit(src)) return false;

    // 词库优先（0 token）。块级串带伪标签时，词库里存的往往是纯文本原文
    // （更新日志/简介都是这样）→ 去掉标签再查一次，命中就直接换，不调模型
    let hit = lookup(src);
    if (!hit) {
      // 被 JSON 包了一层的标题（["LogicMods Load Order"]）：去掉壳再查词库，省一次模型调用
      const bare = shellInner(src);
      if (bare && bare !== src) hit = lookup(bare);
    }
    if (!hit && /<i\d+>/.test(src)) {
      const plain = normText(src.replace(/<\/?i\d+>/g, '').replace(/\{\{\d+\}\}/g, ''));
      if (plain && plain !== src) hit = lookup(plain);
    }
    // 命中词库/缓存就立刻换。换不上（例如整块被一个 span 包住、译文只是纯文本）
    // 时若有内联子元素，就退回节点级逐段写 —— 否则这类块会永远停在英文
    const fallback = () => (slots.length > 1 ? 'nodelevel' : false);
    if (hit) {
      // 拉锯熔断（块级路径）：命中缓存/词库就立刻回填，而 React 重渲染可能把译文还原成英文，
      // 于是「回填→还原→再回填」自持 —— 每轮还要全树重扫，在下载/进度这类高频重渲染界面
      // 上能把 renderer 一个核吃满（Vortex 2.9.0 更新下载实测卡死）。同一元素+同一原文
      // 反复回填超过上限就判定拉锯，打跳过标记彻底退出。
      let bucket = writeCount.get(el);
      if (!bucket) { bucket = new Map(); writeCount.set(el, bucket); }
      const wc = (bucket.get(src) || 0) + 1;
      bucket.set(src, wc);
      if (wc > WRITE_PATIENCE) {
        // 冷却而不是永久放弃：拉锯多半是「那阵子在高频重渲染」，等它停了这块还是该翻的。
        // 60 秒后摘掉标记、清空计数再给一次机会；还在拉锯就再冻一轮。
        try {
          el.setAttribute('data-zh-skip', '1');
          setTimeout(() => {
            try { el.removeAttribute('data-zh-skip'); } catch (e) { /* ignore */ }
            bucket.delete(src);
          }, PINGPONG_COOL_MS);
        } catch (e) { /* ignore */ }
        pingPong += 1;
        if (pingPong === 1 || pingPong % 20 === 0) {
          log('warn', 'write ping-pong cooled', { n: pingPong, sec: PINGPONG_COOL_MS / 1000, sample: src.slice(0, 60) });
        }
        return false;
      }
      // 危险块守卫（命中缓存这条路径以前漏了）：applyUnit 会 removeChild 掉整块子节点再
      // 用译文重建，块里只要含 button / input / [role=button] 这类 React 自己管的交互元素，
      // 节点就被换掉了 —— React 下次 insertBefore 找不到它记得的节点，点一下就陷入重渲染
      // 循环（Vortex 2.9.0 更新通知里的下载按钮就是这个情况：按钮已经翻成中文，点它界面
      // 立刻卡死、CPU 吃满）。所以命中缓存同样要先过这道闸，过不了就退回节点级改文本。
      if (!canBlockReplace(el)) return 'nodelevel';
      const done = applyUnit(el, hit, map, slots);
      if (done) live.hits++;
      return done ? true : fallback();
    }

    const pat = patternHit(src);
    if (pat && canBlockReplace(el)) return applyUnit(el, pat, map, slots) ? true : fallback();
    if (pat) return 'nodelevel';

    if (!canBlockReplace(el)) return 'nodelevel';    // 危险块交给节点级
    enqueue(src, el);
    return false;
  }

  /** 超长块：按句子切成 ≤PART_LEN 的片，分别走缓存/队列，全部到齐后一次拼回 */
  function processLongBlock(el, src, map, slots) {
    // 控件保护优先于「内容容器」：以前写成 &&，等于在 changelog/description 里
    // 绕过 canBlockReplace，含按钮的长块一旦走 restore() 就会 removeChild 掉整棵子树，
    // React 记着的节点没了 —— 正是注释里写的「整页崩」。
    if (!canBlockReplace(el)) return 'nodelevel';
    const plain = src.replace(/<\/?i\d+>/g, ' ').replace(/\{\{\d+\}\}/g, ' ');
    if (!/[A-Za-z]{2,}/.test(plain)) return false;
    const parts = splitUnit(src, PART_LEN);
    if (parts.length < 2) return false;
    let all = true;
    const got = [];
    for (const p of parts) {
      // 纯标签/纯符号片：不需要翻译，原样留在结果里
      if (!okUnit(p)) { got.push(p); continue; }
      const h = lookup(p);
      if (h) { got.push(h); live.hits++; continue; }
      // 某片已经判「不可译」或重试耗尽 → 永远等不到「全部到齐」，整段会一直英文。
      // 这时候降级成逐节点翻译，碎一点但至少有中文。
      const st = failed[p];
      if (st === UNTRANSLATABLE || (typeof st === 'number' && st > MAX_TRY)) return 'nodelevel';
      all = false;
      if (cache[p] === undefined && !queueMeta.has(p) && reviveIfVisible(p, el)) {
        queue.add(p);
        queueMeta.set(p, { ts: Date.now(), visible: inViewport(el) });
      }
    }
    live.queued = queue.size;
    if (!all) return false;
    return applyUnit(el, got.join(''), map, slots);
  }

  /** 节点级：按钮文本、容器直挂文本、超长块 */
  function processNode(node, raw, t, el) {
    const hit = lookup(t) || (() => { const b = shellInner(t); return b ? lookup(b) : null; })();
    if (hit) {
      // 拉锯熔断：命中缓存/词库就会立刻改写，而 React 重渲染又可能把译文还原成英文，
      // 于是「写完→还原→再写」自持循环 —— 每循环一次还要全树重扫，在下载/进度这类
      // 高频重渲染界面上会把 renderer 一个核吃满、界面卡死。同一节点改写超过上限
      // 就判定拉锯，给它打跳过标记彻底退出（不再扫描、不再改写）。
      // 计数键必须是「元素 + 原文」而不是文本节点：React 重渲染（以及设置 textContent）
      // 会重建 text node，按节点记数的话每轮都是新节点、计数永远归 1，熔断永远不触发。
      let bucket = writeCount.get(el);
      if (!bucket) { bucket = new Map(); writeCount.set(el, bucket); }
      const wc = (bucket.get(t) || 0) + 1;
      bucket.set(t, wc);
      if (wc > WRITE_PATIENCE) {
        try { el.setAttribute('data-zh-skip', '1'); } catch (e) { /* ignore */ }
        pingPong += 1;
        if (pingPong === 1 || pingPong % 20 === 0) {
          log('warn', 'write ping-pong stopped', { n: pingPong, sample: t.slice(0, 60) });
        }
        return false;
      }
      // 第二参数用回调：直接传字符串的话，译文里的 $& / $` / $1 会被当成替换模式展开，
      // 该段文字会被吞掉半截，而且结果还会进缓存，重扫也修不回来。
      const next = raw.replace(t, () => hit);
      if (next !== raw) { writing = true; node.nodeValue = next; endWrite(); live.hits++; scheduleSave(); return true; }
      return false;
    }
    if (cfg.collectMode) collected.add(t);
    if (cache[t] !== undefined) return false;
    if (!reviveIfVisible(t, el)) return false;
    if (!isTranslatable(t, el)) return false;
    if (queueMeta.has(t)) return false;
    queue.add(t);
    queueMeta.set(t, { ts: Date.now(), visible: inViewport(el) });
    live.queued = queue.size;
    return false;
  }

  /** 作者行：只翻前缀（By / Created by / Uploaded by），作者名原样保留 */
  function handleAuthor(node, raw, t) {
    const m = t.match(/^(created by|uploaded by|by)\s+([\s\S]+)$/i);
    if (!m) return false;   // 纯作者名不翻
    const prefixZh = /^created by$/i.test(m[1]) ? '创建者：' : (/^uploaded by$/i.test(m[1]) ? '上传者：' : '作者：');
    const next = raw.replace(t, prefixZh + m[2]);
    if (next === raw) return false;
    writing = true; node.nodeValue = next; endWrite(); scheduleSave();
    return true;
  }

  function handleTextNode(node, visited) {
    const raw = node.nodeValue;
    if (!raw) return false;
    const t = raw.trim();
    if (!t) return false;
    const el0 = node.parentElement;
    if (!el0) return false;
    if (SKIP_TAGS.has(el0.tagName)) return false;
    if (isZhSkip(el0)) return false;
    if (keepSet.has(t)) {
      try { el0.setAttribute('data-zh-key', '1'); } catch (e) { /* ignore */ }
      return false;
    }

    // 作者行优先：永远走节点级前缀替换，绝不整块替换（作者名不许翻）
    if (el0.closest && el0.closest('[class*="author"],[class*="uploader"]')) return handleAuthor(node, raw, t);

    const blk = leafBlockOf(node);
    if (blk) {
      if (visited && visited.has(blk)) return false;
      if (visited) visited.add(blk);
      const r = processBlock(blk);
      if (r !== 'nodelevel') return r;
    }
    return processNode(node, raw, t, el0);
  }

  function walk(root) {
    if (!root) return 0;
    // 实时翻译总开关：关掉后不再扫描、不再发请求（已翻内容保留）。
    // 以前 domTranslate 只在启动时判断一次，设置页取消了也不生效。
    if (cfg && cfg.domTranslate === false) return 0;
    let walker;
    try { walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null); } catch (e) { return 0; }
    // 从上次被截断的位置接着扫：否则每轮都从头开始、又在同一处超时，
    // 页面靠后的文本永远扫不到（实测 3000 节点的页面里，末尾的条目一次都没被翻）。
    if (resumeNode && resumeNode.isConnected && root.contains(resumeNode)) {
      try { walker.currentNode = resumeNode; } catch (e) { /* ignore */ }
    }
    let n, replaced = 0, seen = 0, truncated = false;
    const visited = new Set();
    const clock = () => ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
    const t0 = clock();
    while ((n = walker.nextNode())) {
      if (handleTextNode(n, visited)) replaced++;
      if (++seen >= 8000) break;
      // 时间预算：大页面整树扫一遍可能上百毫秒，每 256 个节点查一次表，超预算就收手；
      // 记下断点并置脏，下一轮从这里接着扫，避免一次长任务把主线程（界面）卡住。
      if ((seen & 255) === 0 && clock() - t0 > WALK_BUDGET_MS) {
        walkTruncated += 1;
        docDirty = true;
        truncated = true;
        try { resumeNode = walker.currentNode; } catch (e) { resumeNode = null; }
        break;
      }
    }
    if (!truncated) resumeNode = null;
    return replaced;
  }

  /** 属性（悬停提示 / 占位符 / 无障碍标签）*/
  function handleAttrs(root) {
    if (cfg && cfg.translateAttrs === false) return 0;
    let els;
    try { els = root.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(',')); } catch (e) { return 0; }
    let count = 0;
    for (let i = 0; i < els.length && i < 1500; i++) {
      const el = els[i];
      if (el.closest && el.closest('[class*="author"],[class*="uploader"],[data-zh-skip]')) continue;
      if (isZhSkip(el)) continue;
      for (const attr of ATTRS) {
        const raw = el.getAttribute(attr);
        if (!raw) continue;
        const t = raw.trim();
        if (!t || t.length > MAX_LEN) continue;
        const hit = lookup(t);
        if (hit) {
          el.setAttribute(attr, raw.replace(t, () => hit));
          count++;
        } else if (isTranslatable(t) && cache[t] === undefined && !queueMeta.has(t) && reviveIfVisible(t, el)) {
          queue.add(t);
          queueMeta.set(t, { ts: Date.now(), visible: inViewport(el) });
          live.queued = queue.size;
        }
      }
    }
    return count;
  }

  /** 回填：把所有「已翻好但还没贴到页面」的段落贴上去 */
  function applyPending() {
    if (pendingBySrc.size === 0) return 0;
    let n = 0;
    for (const [src, els] of Array.from(pendingBySrc)) {
      const zh = cache[src];
      if (!zh) {
        if (failed[src]) {
          // 明确失败：清掉入队标记，下一轮重新判定（等 idleRevive 清掉失败计数后会再试）
          for (const el of Array.from(els)) {
            try { el.removeAttribute('data-zh-key'); } catch (e) { /* ignore */ }
            seenLen.delete(el);
          }
          pendingBySrc.delete(src);
        }
        continue;
      }
      for (const el of Array.from(els)) {
        if (!el || !el.isConnected) { els.delete(el); continue; }
        if (el.getAttribute('data-zh-block') === '1') { els.delete(el); continue; }
        const cur = serialize(el);
        if (cur.src !== src) {           // 内容变了（虚拟列表复用节点）→ 重新走一遍
          els.delete(el);
          try { el.removeAttribute('data-zh-key'); } catch (e) { /* ignore */ }
          continue;
        }
        if (applyUnit(el, stripShell(src, zh), cur.map, cur.slots)) {
          n++;
        } else {
          // 回填失败（结构对不齐 / 不在 CONTENT_SEL 不允许重建）：
          // 必须撤掉「已处理」标记，否则 processBlock 开头那句
          // `data-zh-key==='1' && seenLen===len` 会永久短路，译文明明在缓存里也贴不上去。
          try { el.removeAttribute('data-zh-key'); } catch (e) { /* ignore */ }
          try { seenLen.delete(el); } catch (e) { /* ignore */ }
        }
        els.delete(el);
      }
      if (els.size === 0) pendingBySrc.delete(src);
    }
    return n;
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; try { save && save(); } catch (e) { /* ignore */ } }, 1200);
  }

  function scheduleFlush(delay) {
    if (flushTimer || flushing || queue.size === 0) return;
    if (cfg && cfg.enabled === false) return;
    flushTimer = setTimeout(flush, delay === undefined ? 250 : delay);
  }

  const labelOf = (s) => String(s).replace(/<[^>]+>/g, '').replace(/\{\{\d+\}\}/g, '…').replace(/\s+/g, ' ').trim();

  async function flush() {
    flushTimer = null;
    if (flushing || queue.size === 0) return;
    if (cfg && cfg.enabled === false) return;
    if (cfg && cfg.domTranslate === false) {
      queue.clear(); queueMeta.clear(); live.queued = 0;
      // 光清队列不够：这些块身上还留着 data-zh-key，seenLen 也记着长度，
      // 重新打开实时翻译后会被双重短路，永久不再入队，只能重启 Vortex。
      for (const els of pendingBySrc.values()) {
        for (const el of els) {
          try { el.removeAttribute('data-zh-key'); } catch (e) { /* ignore */ }
          try { seenLen.delete(el); } catch (e) { /* ignore */ }
        }
      }
      pendingBySrc.clear();
      return;
    }
    if (modelDown) return;
    flushing = true;

    const lanes = Math.max(1, Math.min(10, cfg.concurrency || 5));
    // 每组条数：设置页的「每批送翻条数」按组上限算，但组内条数再多也就 12 条
    // （本地 7B 一次输出十几条 JSON 很容易跑偏/被截断）
    const per = Math.max(1, Math.min(12, cfg.batchMaxItems || cfg.batchSize || 8));
    // 一次取多少条：够喂满并发车道就行。之前是 per*lanes*4（20×2×4=160 条），
    // 一页合集 200+ 条文本会整批塞进上下文，直接撞模型窗口
    const cap = Math.max(Math.min(per * lanes * 2, 48), 8);
    const sorted = Array.from(queue).sort((a, b) => {
      const ma = queueMeta.get(a) || {};
      const mb = queueMeta.get(b) || {};
      if (!!ma.visible !== !!mb.visible) return ma.visible ? -1 : 1;
      if (a.length !== b.length) return a.length - b.length;
      return (ma.ts || 0) - (mb.ts || 0);
    });
    const items = sorted.slice(0, Math.min(sorted.length, cap));
    items.forEach((t) => { queue.delete(t); queueMeta.delete(t); });
    live.queued = queue.size;
    live.lanes = lanes;

    const t0 = Date.now();
    // 真正的「正在翻译」由 core 在每组发出时回调，不再是整批 54 条一起挂 30 秒
    const inflightMap = new Map();
    const onGroup = (ev) => {
      if (!ev || !Array.isArray(ev.idxs)) return;
      if (ev.type === 'start') {
        for (const i of ev.idxs) inflightMap.set(i, { text: labelOf(items[i]), start: Date.now() });
      } else {
        for (const i of ev.idxs) inflightMap.delete(i);
      }
      live.inflight = Array.from(inflightMap.values());
      live.groups = inflightMap.size > 0 ? Math.ceil(inflightMap.size / Math.max(1, per)) : 0;
    };
    live.inflight = [];
    live.groups = 0;
    live.per = Math.ceil(items.length / per);

    let ok = 0, refused = 0, failedN = 0;
    const failSamples = [];
    const recentAt = (i, res) => {
      const okk = res && res !== items[i];
      // 单条耗时用这一组真正发出去的时间算，不再拿整批开始时间（面板上会显示成 30 秒）
      const st = inflightMap.get(i);
      const ms = st ? Date.now() - st.start : Date.now() - t0;
      live.recent.unshift({ text: labelOf(items[i]), zh: okk ? labelOf(res) : '', ok: !!okk, ms });
      if (live.recent.length > 40) live.recent.length = 40;
    };

    try {
      const res = typeof translateConcurrently === 'function'
        ? await translateConcurrently(cfg, cache, items, lanes, null, 'html', (i, _src, zh) => recentAt(i, zh), onGroup)
        : await translateBatch(cfg, cache, items, 'html');

      const now = Date.now();
      const echoSamples = [];
      items.forEach((t, i) => {
        if (res[i] && res[i] !== t) {
          const zh = stripShell(t, res[i]);
          // 译文里一个中文都没有 = 模型只改了大小写/标点，不是翻译。
          // 这种值进缓存后 enqueue 会认为「已翻」永不重送，界面就永久停在英文。
          if (!CJK.test(zh)) {
            const pv = failed[t];
            failed[t] = Math.min((pv && pv > 0 ? pv : 0) + 1, MAX_TRY + 1);
            lastFail.set(t, Date.now()); failedN++; failSamples.push(String(t).slice(0, 50));
            return;
          }
          cache[t] = zh;
          delete failed[t]; lastFail.delete(t); reviveCount.delete(t); ok++;
          return;
        }
        if (res[i] === t) {
          // 模型原样返回有两种：①真「这条没得翻」（专名、品牌名）②我们的格式校验拒收
          // （占位符丢了 / 伪标签不配对 / BBcode 坏了 / 长文漏译）。后者是输出不合规，
          // 值得重试；以前两类都按「照抄」处理，第二次就判 -1 永久封杀，用户看到「这段永远不翻」。
          const rejected = !!(res && res._rejects && res._rejects.has(t));
          const prev = failed[t];
          failed[t] = (!rejected && (reviveCount.get(t) > 0 || (prev && prev > 0))) ? UNTRANSLATABLE : 1;
          lastFail.set(t, Date.now()); refused++;
          if (echoSamples.length < 3) echoSamples.push(String(t).slice(0, 40));
          return;
        }
        // 请求/解析失败：是模型或网络的问题，不是内容的问题 → 退避重试，有上界
        const prev = failed[t];
        failed[t] = Math.min((prev && prev > 0 ? prev : 0) + 1, MAX_TRY + 1);
        lastFail.set(t, Date.now()); failedN++; failSamples.push(String(t).slice(0, 50));
      });
      live.ok += ok;
      live.fail += failedN;
      live.inflight = [];
      live.lastBatchAt = now;
      live.lastDoneAt = now;

      // 连续两轮 0 成功且失败 ≥10 → 模型大概关了/挂了：暂停重试，探活通过后全量复活
      if (ok === 0 && failedN >= 10) {
        downStreak++;
        if (downStreak >= 2 && !modelDown) {
          modelDown = true;
          live.modelDown = true;
          log('warn', 'model unreachable, retries paused until probe passes');
        }
      } else if (ok > 0) {
        downStreak = 0;
        if (modelDown) { modelDown = false; live.modelDown = false; log('info', 'model recovered'); }
      }
      if (saveFail && (refused > 0 || ok > 0 || failedN > 0)) saveFail(failed);
      if (failedN > 0 || refused > 0) {
        // 带上原因：refused=模型照抄原文；null=请求/解析失败（err 里是真实异常）
        log('warn', 'dom batch detail', {
          ok, refused, echo: echoSamples, nullN: failedN, nullSample: failSamples.slice(0, 3),
          err: (res && res.__err) || '',
        });
      }

      const perm = items.filter((t) => failed[t] > MAX_TRY);
      if (perm.length > 0) log('warn', 'permanent give-up', { n: perm.length, sample: perm.slice(0, 2).map((s) => String(s).slice(0, 40)) });
      const untr = items.filter((t) => failed[t] === UNTRANSLATABLE);
      if (untr.length > 0) log('info', 'untranslatable (kept as-is)', { n: untr.length, sample: untr.slice(0, 3).map((s) => String(s).slice(0, 40)) });

      // 回填（块级）+ 节点级命中
      writing = true;
      const ap = applyPending();
      if (ok > 0) { walk(document.body); handleAttrs(document.body); }
      endWrite();
      if (ok > 0) scheduleSave();
      if (ap > 0) log('info', 'unit applied', { n: ap });
      log('info', 'dom batch', { ok, refused, pending: queue.size, groups: live.per });
    } catch (e) {
      log('warn', 'dom flush failed', String(e).slice(0, 140));
      live.inflight = [];
      // 整批抛错（模型挂了 / 网络断 / 参数错）时不能把条目丢掉，
      // 否则这批内容永远停在英文 —— 之前就是这里把条目吞了
      let lost = 0;
      for (const t of items) {
        const prev = failed[t];
        failed[t] = Math.min((prev && prev > 0 ? prev : 0) + 1, MAX_TRY + 1);
        lastFail.set(t, Date.now());
        lost++;
        // 这里绝不立刻重新入队。整批抛错是模型/网络的问题，立刻重发会变成
        // 150ms 一轮的忙循环（以前就是这样把调用打满的）。清掉处理标记，
        // 让 retrySweep 退避到点后由 2 秒重扫自然捡回来。
        const els = pendingBySrc.get(t);
        if (els) {
          for (const el of Array.from(els)) {
            try { el.removeAttribute('data-zh-key'); } catch (err) { /* ignore */ }
            seenLen.delete(el);
          }
          if (failed[t] > MAX_TRY) pendingBySrc.delete(t);
        }
      }
      live.fail += lost;
      if (saveFail) saveFail(failed);
      downStreak++;
      if (downStreak >= 2 && !modelDown) {
        modelDown = true;
        live.modelDown = true;
        log('warn', 'model unreachable (batch threw), retries paused until probe passes');
      }
    } finally {
      flushing = false;
      if (queue.size > 0) scheduleFlush(150);
    }
  }

  if (saveCollect) {
    collectTimer = setInterval(() => {
      if (cfg.collectMode && collected.size > 0) {
        try { saveCollect(Array.from(collected)); } catch (e) { /* ignore */ }
      }
    }, 4000);
    if (collectTimer && collectTimer.unref) collectTimer.unref();
  }

  // ── 观察器：回调里同步替换，赶在绘制之前 ──
  /** 结束写入：如果这期间有 DOM 变更被丢掉，立刻补扫（不等 2 秒节拍） */
  function endWrite() {
    writing = false;
    if (!pendingAfterWrite) return;
    pendingAfterWrite = false;
    // 补扫退避：写完立刻补扫本是为了救「React 同步重渲染丢掉的 mutation」，但只要页面
    // 上存在一个「写完就被还原」的拉锯点，这条路径就会自持 —— 每 120ms 一次全树重扫，
    // 实测能把 renderer 一个核吃满（Vortex 2.9.0 更新下载时就是这样，界面完全卡死）。
    // 连续补扫越多间隔越长（最多退到 8 秒一次），安静 6 秒后计数清零恢复正常响应。
    const now = Date.now();
    if (now - lastBurstAt > 6000) burst = 0;
    lastBurstAt = now;
    burst += 1;
    if (burst === BURST_ALERT) {
      log('warn', 'rescan burst high', { burst, gap: BURST_GAPS[BURST_GAPS.length - 1] });
    }
    const gap = BURST_GAPS[Math.min(burst - 1, BURST_GAPS.length - 1)];
    if (afterWriteTimer) clearTimeout(afterWriteTimer);
    afterWriteTimer = setTimeout(() => {
      afterWriteTimer = null;
      if (writing || flushing) return;
      try { walk(document.body); } catch (e) { /* ignore */ }
    }, gap);
  }

  const mo = new MutationObserver((muts) => {
    if (writing) { pendingAfterWrite = true; docDirty = true; return; }
    docDirty = true;
    let dirty = 0;
    for (const m of muts) {
      if (m.type === 'characterData') {
        if (m.target && m.target.nodeType === 3) {
          const el = m.target.parentElement;
          if (el && el.getAttribute && el.getAttribute('data-zh-block') === '1' && CJK.test(m.target.nodeValue || '')) continue;
          if (handleTextNode(m.target, null)) dirty++;
        }
      } else if (m.type === 'childList') {
        for (const node of m.addedNodes) {
          if (node.nodeType === 3) { if (handleTextNode(node, null)) dirty++; }
          else if (node.nodeType === 1) {
            if (SKIP_TAGS.has(node.tagName)) continue;
            dirty += walk(node);
            dirty += handleAttrs(node);
          }
        }
      }
    }
    if (dirty > 0) scheduleSave();
    scheduleFlush(dirty > 0 ? 200 : 150);
  });
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });

  // 启动时立刻同步扫一遍（不等定时器，避免首屏闪英文）
  writing = true;
  walk(document.body);
  handleAttrs(document.body);
  endWrite();
  scheduleFlush(250);

  // 周期性全页重扫：兜住虚拟滚动（列表复用 DOM 只改文字不一定触发 childList）与新的缓存命中
  const rescan = setInterval(() => {
    if (writing || flushing) return;
    if (cfg && cfg.enabled === false) return;
    if (queue.size > 0) scheduleFlush(200);
    live.pingPong = pingPong;         // 面板可看：被拉锯熔断的节点数 / 当前补扫档位 / 扫描被截断次数
    live.burst = burst;
    live.walkTruncated = walkTruncated;
    if (!docDirty) return;            // 页面没变过：不重扫（队列该推的上面已经推了）
    docDirty = false;
    try {
      const n = walk(document.body) + handleAttrs(document.body) + applyPending();
      if (n > 0) scheduleSave();
    } catch (e) { /* ignore */ }
  }, 2000);
  if (rescan && rescan.unref) rescan.unref();

  // 唯一的自动重试入口。以前这里是三个定时器（10 秒 / 10 分钟 / 20 分钟各复活一档），
  // 加上「可见即复活」，实际效果是「永远在重试」——必失败的条目每 10 秒烧一次调用。
  // 现在只有一条规则：可重试失败按 BACKOFF 退避，最多 MAX_TRY 次；不可译(-1) 永不自动重试。
  const retrySweep = setInterval(() => {
    if (modelDown || flushing || queue.size > 0) return;
    if (cfg && cfg.enabled === false) return;
    const now = Date.now();
    const ready = [];
    for (const k of Object.keys(failed)) {
      if (k === '_ver') continue;
      const n = failed[k];
      if (!(n > 0) || n > MAX_TRY) continue;        // -1 不可译 / 已放弃：不动
      if (now - (lastFail.get(k) || 0) < BACKOFF[n - 1]) continue;
      if ((reviveCount.get(k) || 0) >= MAX_VISIBLE_REVIVE) continue;
      ready.push(k);
    }
    if (ready.length === 0) return;
    const batch = ready.slice(0, 40);
    batch.forEach((k) => delete failed[k]);
    if (saveFail) saveFail(failed);
    // 光删计数没用：这些条目要重新被「发现」才会入队。rescan 现在有 docDirty 门控，
    // 页面静止（弹窗开着、列表不动）时不会自己跑，所以这里必须主动置脏。
    docDirty = true;
    log('info', 'retry sweep', { n: batch.length, waiting: ready.length - batch.length });
  }, 15000);
  if (retrySweep && retrySweep.unref) retrySweep.unref();

  // 探活：挂机期间每 2 分钟发一条短文本。恢复后只复活「暂态失败」（1..MAX_TRY），
  // 不动不可译(-1) 和已放弃的 —— 以前这里整表清空，等于把刚判死的又全都放回去。
  const probe = setInterval(async () => {
    if (!modelDown || typeof translateBatch !== 'function') return;
    try {
      const r = await translateBatch(cfg, {}, ['Download missing mods'], 'html');
      if (r && r[0] && CJK.test(String(r[0]))) {
        modelDown = false;
        live.modelDown = false;
        let revived = 0;
        for (const k of Object.keys(failed)) {
          if (k === '_ver') continue;
          if (failed[k] > 0 && failed[k] <= MAX_TRY) { delete failed[k]; revived++; }
        }
        if (saveFail) saveFail(failed);
        if (revived > 0) docDirty = true;   // 同上：探活恢复后要有一次重扫才会真正重试
        log('info', 'model probe passed', { revived });
      }
    } catch (e) { /* 下轮再试 */ }
  }, 120000);
  if (probe && probe.unref) probe.unref();

  log('info', 'dom translator started', { dict: Object.keys(lex).length, cache: Object.keys(cache).length, mode: 'block' });
}

module.exports = { startDomTranslator, RETRY_MAX };
