'use strict';

const fs = require('fs');
const path = require('path');
const core = require('./translate-core');
const domTranslator = require('./dom-translator');
const localePack = require('./locale-pack');

const EXT_DIR = __dirname;
// 运行时数据（用户配置、译文缓存、日志）默认也读扩展目录，main() 里会改到
// %APPDATA%\Vortex\vortex-modname-zh\ —— 扩展目录在升级时被整个覆盖，
// 配置和积累的译文放那儿等于每次升级都丢一遍。
let DATA_DIR = EXT_DIR;
let CONFIG_PATH = path.join(DATA_DIR, 'config.json');
let CACHE_PATH = path.join(DATA_DIR, 'cache.json');
let DOM_CACHE_PATH = path.join(DATA_DIR, 'domCache.json');
let COLLECT_PATH = path.join(DATA_DIR, 'collected.json');
let FAIL_PATH = path.join(DATA_DIR, 'failCache.json');
let LOG_PATH = path.join(DATA_DIR, 'translator.log');
let SEED_SKIP_PATH = path.join(DATA_DIR, 'seed-skip.json');   // 用户点过「清空缓存」后别再灌种子
let NAME_FAIL_PATH = path.join(DATA_DIR, 'nameFail.json');    // 模组名 give-up 记账（烧模型的有界退让）
let WORD_PATH = path.join(DATA_DIR, 'wordCache.json');        // 词级补翻词表（Gwent → 昆特牌）
let GATE_SHOWN_PATH = path.join(DATA_DIR, 'gate-shown.json'); // 升级首启「模型连不上」弹窗已提示过的版本
// 以下是随包发布的静态资源，永远读扩展目录
const SEED_PATH = path.join(EXT_DIR, 'domCache.seed.json');
const GAME_NAMES_PATH = path.join(EXT_DIR, 'gamenames.json');
// 明确「保持英文、不要译」的名字（官方就叫英文 / 中文圈没有通用译名）。
// 命中就写进缓存并标记已处理：0 次模型调用，也不会被当成「失败」反复重试。
const GAME_KEEP_PATH = path.join(EXT_DIR, 'gamenames-keep.json');
const PACK_PATH = path.join(EXT_DIR, 'pack.json');

const CJK = /[\u4e00-\u9fa5\u3400-\u4dbf]/;
const LATIN = /[A-Za-z]/;

// 模组名 give-up 记账上限：同一名字试满这么多次就不再烧模型（TTL 过后的旧账重新计数）
const NAME_FAIL_MAX = 3;
const NAME_FAIL_TTL = 7 * 24 * 3600 * 1000;

// 版别标记短语表（用户 2026-10-24 拍板：ULTRA Plus → 超强版）：整词短语替换，零模型调用。
// 模型对「大写 + 空格」的版别标记经常照抄，而 residueWords 把全大写的 ULTRA 当专名放行、
// 只留 Plus 当残留 → 词级补翻只能补出半个。边界用「非字母数字」：连写（ULTRAPLUS）不换。
// 词级补翻提示词：一次送一批残留英文词，按行对应返回。
const WORD_PROMPT = [
  '你是游戏模组名翻译助手。下面每行是一个需要翻译的英文单词或短语，出自游戏模组名。',
  '请逐行给出对应简体中文，行数与顺序一一对应，不要输出解释、编号或引号。',
  '专有名词（模组名、工具名、作者名）没有通用译法时可保留英文原文。',
].join('\n');

// seed 质检（P3-1）：整值被引号壳包裹的译文是坏的（模型把输出又包了一层引号），
// 灌进 domCache 会让界面显示 “下载” 这种带壳文本。原文自己以引号开头时放行
// （"Show hidden games" → “显示隐藏游戏”… 是合法译文，壳在原文里）。
const seedEntryOk = (k, v) => {
  const s = String(v == null ? '' : v).trim();
  const kk = String(k == null ? '' : k).trim();
  if (!s || !kk) return false;
  if (s === kk) return false;                        // 假翻译：译文与原文一字不差
  if (!/[\u4e00-\u9fff]/.test(s)) return false;      // 译文里一个汉字都没有（内联判据：本函数自包含，不引 CJK）
  if (/^["'“”‘’]/.test(kk)) return true;             // 原文以引号开头（功能名句式）：放行
  // 整值被引号/括号壳包住 → 壳，拒（原文自带方括号的不算，见 [HP] bar → [血量]条；
  // 花括号不算壳 —— {{otherMod}} … {{thisMod}} 这类占位符开头的译文是合法的）
  if (s.length >= 2 && /^["'“”‘’\[(]/.test(s) && /["'“”‘’\])]$/.test(s)) return false;
  // 占位符必须一个不少（写法差异宽容：{{ count }} 与 {{count}} 算同一个 ——
  // 只对齐内容、不比对空格；pack 里两种写法都有，严格按字面比对会误杀好条目）
  const holesOf = (t) => (String(t).match(/\{\{\s*[^{}\s][^{}]*?\s*\}\}/g) || [])
    .map((h) => '{{' + h.slice(2, -2).replace(/\s+/g, '') + '}}').sort().join('\u0001');
  if (holesOf(kk) !== holesOf(s)) return false;
  // 伪标签编号必须一致
  const it = (kk.match(/<i\d+>/g) || []).sort().join(',');
  const iv = (s.match(/<i\d+>/g) || []).sort().join(',');
  if (it !== iv) return false;
  // 弯引号不配对（未安装 “X 这种半句）
  const lq = (s.match(/[“‘]/g) || []).length, rq = (s.match(/[”’]/g) || []).length;
  if (lq !== rq) return false;
  // BBCode 同一标签重复出现 = 拼接坏的痕迹（缺失[br][/br][br][/br]）
  const tc = {};
  for (const t of (s.match(/\[[^\]]+\]/g) || [])) { const l = t.toLowerCase(); tc[l] = (tc[l] || 0) + 1; }
  for (const n of Object.values(tc)) if (n >= 2) return false;
  return true;
      };

// 用户点过「清空缓存」后别再灌种子（同版本内生效；0.16.5 起跨版本升级也不灌 ——
// 升级清空段会自己写一条同版本 seed-skip，理由同上：塞回来等于没清）。
// （下一行的缩进是 audit2 组 2 的区间切片标记，勿动）
      const seedSkip = () => {
  const s = readJson(SEED_SKIP_PATH, null);
  return !!(s && (!s.ver || s.ver === extVerOf()));
};

let React = null;
let contextRef = null;
let va = null;
// 自动翻译钩子：init 阶段 context.api 还没就绪，Vortex 会拒绝（"extension uses api in
// init function"），偏偏 onStateChange 是**静默失效**——不报错、监听器也不挂上。
// 0.16.3 实测：日志里 "auto translate scheduled" 一次都没出现过，等于这个开关从生下来就是死的。
// 所以这里只存函数，真正 onStateChange 挪到 autostart 段（api 可用后）。
let autoHookRef = null;
let autoHookBound = false;
// 默认配置：新用户没有 config.json 时也能开箱即用（否则 enabled undefined 会被「已在设置中关闭」拦截）
const DEFAULT_CFG = {
  enabled: true,
  autoTranslateOnInstall: true,
  requestDelayMs: 300,
  provider: { type: 'openai', baseUrl: '', apiKey: '', model: '' },
  fallbackLibre: false,
  includeCollections: true,
  writeToNameField: false,
  batchSize: 20,
  concurrency: 5,
  collectMode: false,
  domTranslate: true,
  translateAttrs: true,
  domWriteNames: true,   // DOM 层贴模组名缓存译文的总开关（false = 整档回退 step2 行为）
  terms: [],
};
let cfg = JSON.parse(JSON.stringify(DEFAULT_CFG));
let cache = {};
// 升级清空模组名缓存后置真：autostart 段据此自动触发一次全量重翻（0.16.5）。
// 只在本进程内有效 —— 重启就丢，但那没关系：清空动作本身带 _ver 标记，
// 重启后不会再清第二遍，缺席的条目下次「立即翻译全部」照样能补。
let cacheRebuildPending = false;
let domCache = {};
let failCache = {};
let nameFail = {};    // 模组名 give-up 记账：键 → {n, ts, model}（试满 NAME_FAIL_MAX 不再烧模型）
let wordCache = {};   // 词级补翻词表：英文词 → 中文（跨会话，落在数据目录）
/** 词级固定译名（0.16.3 续 18）：官方中文译名不许模型猜。
 *  实测三条「半中半英」全出在这一层 ——
 *    `GwentCardSwap 1.3`      → `Gwent卡牌交换模组`   （驼峰词被当专名照抄）
 *    `Summon and Mount Roach` → `召唤并骑乘roach…`    （模型自己写成小写，躲过残留检测）
 *    `Auto Apply Oils Reborn` → `自动应用 Oils 重生…`  （4 字母词被 `<5` 门槛跳过）
 *  这里只在启动时并进 wordCache，`refineByWords` 命中即零模型替换。
 *  大小写必须逐条列：wordCache 查表是大小写敏感的（`roach` ≠ `Roach`）。
 *  注意：这张表**不能**放进 config.json —— 老用户的配置文件已存在，加进去也不会生效。 */
const WORD_FIXES = {
  Gwent: '昆特牌', gwent: '昆特牌',
  Roach: '萝卜', roach: '萝卜',
  Oils: '剑油', oils: '剑油', Oil: '剑油', oil: '剑油',
  // 巫师 3 五法印：全是 4~5 字母，正好卡在旧的「≥5 字符」盲区上
  Igni: '伊格尼', igni: '伊格尼',
  Quen: '昆恩', quen: '昆恩',
  Aard: '阿尔德', aard: '阿尔德',
  Yrden: '亚登', yrden: '亚登',
  Axii: '亚克席', axii: '亚克席',
  // 主要人物官方译名（模型有时给「杰洛特」，有时照抄 Geralt）
  Geralt: '杰洛特', geralt: '杰洛特',
  Yennefer: '叶奈法', yennefer: '叶奈法',
  Ciri: '希里', ciri: '希里',
  Triss: '特莉丝', triss: '特莉丝',
  Dandelion: '丹德里恩', dandelion: '丹德里恩',
  // 通用模组后缀（高频，模型有时翻「重生」有时照抄 Reborn）
  Reborn: '重生', reborn: '重生',
  // 版别短语：原 EDITION_PHRASES 唯一条目（审计 ③ 死链拆除后挪到这里走遮蔽通道）。
  // 词级补翻（refineByWords 逐词查表）用不上短语键 —— 残留词拆分后是 ULTRA / Plus
  // 各查各的；短语键只服务 wordFixTerms 的整词遮蔽（fuzzy gi，大小写都能中）。
  'ULTRA Plus': '超强版',
};
let termExact = null;
let gameKeep = [];      // 明确保持英文的名字（gamenames-keep.json）
let keepNameSet = new Set();  // 同上，小写集合（residueWords 判「品牌词不算残留」用）
let runtimeTerms = null; // 游戏名对照表（运行时，绝不写回 config.json）
let domStarted = false;  // DOM 层是否已启动（它是一次性注入的，启停不对称）
let startDomRef = null;  // 由 main() 赋值的启动函数，供设置页「打开实时翻译」时补启
let domKickRef = null;   // DOM 层的 kick：手动翻译时立刻解除「模型挂机暂停」，不等 2 分钟探活

/** 手动动作叫醒 DOM 层（0.16.5 补）。用户点了按钮却要等最长 120 秒才开始翻界面文本，
 *  就是缺这一下：探活是自动路径的兜底节奏，不能拿来当手动操作的响应时间。 */
function kickDomLayer(reason) {
  if (typeof domKickRef !== 'function') return;
  try { domKickRef(reason); } catch (e) { log('warn', 'kick dom fail', String(e)); }
}
// DOM 层写入的实时翻译状态，设置页「实时队列」面板直接读它（每秒刷新）
const liveStatus = { inflight: [], recent: [], queued: 0, ok: 0, fail: 0, hits: 0, lanes: 0, per: 0, modelDown: false, lastBatchAt: 0, lastDoneAt: 0, groups: 0 };

function resetLiveStatus() {
  liveStatus.inflight = [];
  liveStatus.recent = [];
  liveStatus.queued = 0;
  liveStatus.ok = 0;
  liveStatus.fail = 0;
  liveStatus.hits = 0;
  liveStatus.modelDown = false;
  liveStatus.lastBatchAt = 0;
  liveStatus.lastDoneAt = 0;
  liveStatus.groups = 0;
}
let running = false;

let logBytes = -1;
function log(level, msg, meta) {
  try {
    const line = `${new Date().toISOString()} [${level}] ${msg} ${meta === undefined ? '' : JSON.stringify(meta)}\n`;
    // 日志无上限会长到几 MB，而且里面含用户模组名和页面片段（用户求助时会整份发出来）。
    // 超过 1 MB 轮转一份 .1，只留最近两代。
    if (logBytes < 0) { try { logBytes = fs.statSync(LOG_PATH).size; } catch (e) { logBytes = 0; } }
    logBytes += Buffer.byteLength(line, 'utf8');
    if (logBytes > 1024 * 1024) {
      try { fs.renameSync(LOG_PATH, LOG_PATH + '.1'); } catch (e) { /* ignore */ }
      logBytes = 0;
    }
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch (e) { /* ignore */ }
}

function useDataDir(dir) {
  if (!dir || dir === DATA_DIR) return;
  DATA_DIR = dir;
  CONFIG_PATH = path.join(dir, 'config.json');
  CACHE_PATH = path.join(dir, 'cache.json');
  DOM_CACHE_PATH = path.join(dir, 'domCache.json');
  COLLECT_PATH = path.join(dir, 'collected.json');
  FAIL_PATH = path.join(dir, 'failCache.json');
  LOG_PATH = path.join(dir, 'translator.log');
  // 换了日志文件就必须让轮转计数重新 stat —— 否则 logBytes 还记着上一个目录那个文件的
  // 体积：新目录的日志可能才几 KB 就被判超 1MB 白轮转一次，或者反过来早已几 MB 却永不轮转。
  logBytes = -1;
  SEED_SKIP_PATH = path.join(dir, 'seed-skip.json');
  NAME_FAIL_PATH = path.join(dir, 'nameFail.json');
  WORD_PATH = path.join(dir, 'wordCache.json');
  GATE_SHOWN_PATH = path.join(dir, 'gate-shown.json');
  USER_KEEP_PATH = path.join(dir, 'userKeep.json');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
}

/** 首次切到 userData 时，把扩展目录里已有的配置与译文搬过去（不搬就白翻了） */
function migrateFromExtDir() {
  if (DATA_DIR === EXT_DIR) return 0;
  let n = 0;
  for (const name of ['config.json', 'cache.json', 'domCache.json', 'collected.json', 'failCache.json', 'nameFail.json', 'wordCache.json', 'userKeep.json']) {
    const dest = path.join(DATA_DIR, name);
    const src = path.join(EXT_DIR, name);
    try {
      if (fs.existsSync(dest)) continue;
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, dest);
      n++;
    } catch (e) { /* ignore */ }
  }
  if (n > 0) log('info', 'data files migrated to userData', { n, dir: DATA_DIR });
  return n;
}

/** 本扩展版本号（读 info.json；失败返回空串） */
/** 和 dom-translator 的 normText 保持一致：空白折叠 + trim。
 *  Vortex 的 known 游戏名里有 13 个把空格写成了制表符（"Fallout://tNew Vegas"），
 *  不归一化的话 termExact 精确查表永远落空。 */
function normKey(s) {
  // 先剥零宽再折叠空白：'10\u200b mod\u200b updates' 要归一成 '10 mod updates'，
  // 而 \s 不认零宽字符，顺序反了会留下粘住的词。
  // 零宽字面量与 dom-translator.js 的 ZW_RE 必须逐字符一致（namepaste 组 9 对拍）；
  // 这里刻意内联而不引用模块级常量 —— 测试沙箱只抽函数，引用外部变量会 ReferenceError。
  return String(s == null ? '' : s).replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

function extVerOf() {
  try { return (JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'info.json'), 'utf8')).version) || ''; } catch (e) { return ''; }
}

// ═══════════════════════════════════════════════════════════════════════
// 名字闸门全家桶（0.16.3 重建）
//
// 背景：Vortex 是 Electron，模组名是 DOM 文本节点实时渲染，没有更底层字库可换。
// 下载页「未安装 / 同名另一版本」那行 UI 读 modInfo.nexus.fileInfo.name（英文），
// 状态层写的 modInfo.name 界面根本不显示 → 那一行只能由实时层贴。
//
// 三条设计不变式（modname-namepaste-test.js 43 条钉住）：
//   D1 单一缓存源：贴名的数据只来自 nameTranslationOf（cache.json），DOM 层不写 domCache
//      —— 两个写者抢同一个位置的事故（step2 实录）不许重演；
//   D2 精确对应：1.8 的行只拿 1.8 的译文，缓存只有 1.9 时 1.8 行保持英文，零跨版本兜底；
//   D3 kill switch：cfg.domWriteNames === false 时一律不贴，可整档回退 step2 行为。
// ═══════════════════════════════════════════════════════════════════════

/** 剥掉块级序列化用的伪标签（<i1> / {{1}}），拿纯文本 */
function stripPseudo(s) {
  return String(s == null ? '' : s)
    .replace(/<\/?i\d+>/g, '')
    .replace(/\{\{\d+\}\}/g, '');
}

/** 名字用的纯文本：剥伪标签 + 空白折叠（normKey 与 DOM 侧 normText 同一口径） */
function plainForName(s) {
  return normKey(stripPseudo(s));
}

/** 界面显示名（可能已经是译文）——右键点到中文名时反查英文原名用 */
function displayNameOf(mod) {
  const a = (mod && mod.attributes) || {};
  return String(a.customFileName || a.logicalFileName || a.name || a.modName || a.fileName || '').trim();
}

/** 译文里残留的英文词（没翻掉的部分）。
 *  连续大写＝专名（UE4SS / SkyUI / REFramework / VAXIS）不算残留；
 *  版本号（1.5 / v1.5 / 2023）不算；词库明确保留的（Vortex / Nexus Mods）不算；
 *  split 不拆数字（`Ue4ss` 是一个词，拆成 Ue/ss 两个都不算残留就漏判了）；
 *  只认「大写开头且 ≥5 字母」的词（0.16.3 续 13 阈值下调带出的两个误伤：
 *    `v.1.5` 的 v + `Plus` 4 字母曾被当漏翻 → 整行反复重翻最后落定全英文；
 *    `roach` 5 字符小写词曾被词级补翻成「蟑螂」——普通英文小写词不是模组名残留）。
 *  反向边界照旧钉死：`Ue4ss`/`Gwent`（大写开头 5 字母）必须算残留，
 *  `UE4SS`（连续大写）/`SkyUI` 放行。 */
function residueWords(name) {
  const s = String(name == null ? '' : name).replace(/_+/g, ' ');
  const out = [];
  const seen = new Set();
  for (const w of s.split(/[^A-Za-z0-9]+/)) {
    if (!w || w.length < 2) continue;
    if (/^v?\d/i.test(w)) continue;                      // 版本号（v1.5 / 1.5 / 5.01）、fileId（913）
    if (/[A-Z]{2,}/.test(w)) continue;                   // 连续大写＝专名（VAXIS / UE4SS / ULTRA）
    if (w.length < 4) continue;                          // 最短 4：Oils / Quen / Igni / Aard / Axii 全在这一档
    // 0.16.3 续 18：小写普通词不再是免检牌。`召唤并骑乘roach功能` 里的 roach 是模型
    // 自己写成小写的（原文 Roach），旧规则 `!/^[A-Z]/ → continue` 让它彻底隐身 ——
    // residue/modNameOk/healWorthy 三个判据全判「合格」，永远不会被救。
    // 代价是英文虚词可能被当残留，用一张短词黑名单挡掉（约定俗成不翻的那批）。
    if (/^(?:with|from|into|mod|mods|pack|plus|also|only|full|more|next|best|this|that|your|when|then|than|over|under)$/i.test(w)) continue;
    const lw = w.toLowerCase();
    if (keepNameSet && keepNameSet.has(lw)) continue;    // 品牌词保留英文
    if (seen.has(lw)) continue;
    seen.add(lw);
    out.push(w);
  }
  return out;
}

// ---------- 品牌/工具名遮蔽（0.16.3 续 12：只信词库，结构推断默认关闭） ----------
// 用户拍板（2026-10-25）：品牌/工具名只走词库 gamenames-keep.json（187 条，公开榜单来源），
//   命中 → 遮蔽不翻、只翻剩下的字；未命中 → 全量翻译。词库外出口＝右键「这个名字保留英文」。
// 结构推断 structuralBrandsOf 实测 31 个常见模组名命中 27 ＝ 87% 误伤
//   （Better Combat Manager 保留 Combat、Weight Manager 保留 Weight），已用总开关关死；
//   改回 true 之前必须重跑 probe-brand.js。
// 遮罩不是「藏起来」：打成『固定译名』标记送模型，模型按提示词原样保留，译后原样还原
//   （translate-core 的 applyTerms mask/unmask；『』内不参与后续匹配，防嵌套）。

/** 多词工具尾的合法品牌头：只有这些头才配拆 Mod Manager（Weather Mod Manager 不拆 —— P2-a） */
const BRAND_HEAD_COMMON = /^(?:fluffy|frosty|ultraplus)$/i;
/** 工具尾（多词三个 + 单词六个）。多词分支仅当头是已知品牌头；单词分支要求头带驼峰或数字 */
const BRAND_TAIL_COMMON = /^(?:mod\s+manager|mod\s+browser|mod\s+toolkit|manager|mods|tool|tools|loader|suite)$/i;
/** 结构推断用的工具尾全集。probe-brand 27/31 误伤率依赖它不含 armor/water/storm/damage */
const TOOL_TAIL_EN = /^(?:manager|mods|mod|modder|tool|tools|editor|merger|loader|launcher|patcher|generator|installer|updater|converter|compiler|injector|optimizer|cleaner|scanner|viewer|browser|wrapper|bridge|adapter|plugin|addon|extension|framework|library|studio|kit|suite|engine|extender|organizer|system|patch|swapper|distributor|helper)$/i;
/** 中文工具尾：词级补翻时识别「已经翻成中文的尾巴」，不当成漏翻 residue */
const TOOL_TAIL_ZH = /(?:管理器|管理工具|模组管理|模组管理器|工具|加载器|框架|插件|组件|套件|编辑器|优化器|补丁|修复|增强|扩展|合集|安装包|助手|引擎|系统|生成器|安装程序|更新程序|转换器|编译器|扫描器|查看器|浏览器|包装器|桥接|适配器|整理器|交换器|分发器|合并器)$/;
/** 结构品牌推断总开关：87% 误伤率，默认关闭（只信词库） */
const USE_STRUCTURAL_BRAND = false;

/** 名字 → 遮罩规格。en 是要原样保留的部分（品牌头或整名），zh 恒等于 en。
 *  后缀扫描，不做噪音正则：从第二个词起找工具尾 ——
 *    ① 多词工具尾（Mod Manager / Mod Browser / Mod Toolkit）：仅当头是已知品牌头才拆，
 *       真机长键（Fluffy Mod Manager 818 3.084 2026-09-22T08-00Z Ilz9HtdUr）扫描到
 *       第一处多词尾就命中，fileId/版本/时间戳噪音天然被跳过；
 *    ② 单词工具尾（Manager / Mods / Tool / Tools / Loader / Suite）：仅当头带驼峰或数字才拆，
 *       Nexus Mods / Trophy Manager / Divine Tool / Frosty Tool Suite 一律整名；
 *    ③ 尾巴不是工具名（Wrye Bash / Address Library / Script Merger）→ 整名。
 *  自包含：只引用两个 BRAND 常量（测试沙箱按最小注入集抠函数，多一个自由变量就 ReferenceError）。 */
function brandMaskSpec(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return { en: '', zh: '' };
  const words = s.split(/\s+/);
  if (words.length >= 3) {
    for (let i = 1; i <= words.length - 2; i++) {
      if (BRAND_TAIL_COMMON.test(words[i] + ' ' + words[i + 1]) && BRAND_HEAD_COMMON.test(words.slice(0, i).join(' '))) {
        const en = words.slice(0, i).join(' ');
        return { en: en, zh: en };
      }
    }
  }
  if (words.length >= 2) {
    for (let i = 1; i < words.length; i++) {
      if (BRAND_TAIL_COMMON.test(words[i]) && /[a-z][A-Z]|\d/.test(words[0])) {
        const en = words.slice(0, i).join(' ');
        return { en: en, zh: en };
      }
    }
  }
  return { en: s, zh: s };
}

/** 与遮蔽粒度一致：返回这个名字里要原样保留的 token（品牌头或整名） */
function brandTokenOf(name) {
  return brandMaskSpec(name).en;
}

/** 精确匹配：整个名字就在保英文词库里（大小写不敏感） */
function isKnownBrand(s) {
  const t = String(s == null ? '' : s).trim().toLowerCase();
  if (!t || !keepNameSet) return false;
  return keepNameSet.has(t);
}

/** 名单名识别（容忍真机长键）：逐级缩短试词前缀，命中中间那份名单名 */
function isKnownBrandName(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return false;
  if (isKnownBrand(t)) return true;
  const words = t.split(/\s+/);
  for (let n = words.length - 1; n >= 1; n--) {
    if (isKnownBrand(words.slice(0, n).join(' '))) return true;
  }
  return false;
}

/** 这个名字里必须保留英文的品牌头（residueWords 豁免 / 词级补翻跳过用）。
 *  只有词库名（含真机长键）才产出；普通模组名一律空 —— P2-a，
 *  weight / weather / potion 不许因为长得像就被灌进白名单。 */
function keptBrandsOf(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s || !isKnownBrandName(s)) return [];
  const spec = brandMaskSpec(s);
  if (spec.en && spec.en !== s) return [spec.en];
  const words = s.split(/\s+/);
  for (let n = words.length; n >= 1; n--) {
    const head = words.slice(0, n).join(' ');
    if (isKnownBrand(head)) return [head];
  }
  return spec.en ? [spec.en] : [];
}

/** 把名单名的品牌头登记进 keepNameSet（residueWords 据此豁免，Fluffy 不会变残留）。
 *  幂等；非名单名一律 no-op（Some Random Mod 1.2 / Wobbly Mod Manager 不登记）。 */
function registerKeptBrands(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s || !keepNameSet || !isKnownBrandName(s)) return;
  const spec = brandMaskSpec(s);
  if (spec.en) keepNameSet.add(spec.en.toLowerCase());
}

/** 结构品牌推断（这就是 87% 误伤率的来源，默认关闭）：
 *  名字以通用工具尾结尾 → 把头当作品牌。probe-brand 31 样本命中 27 条全是普通词。
 *  typeof 守卫：probe 沙箱不注入开关时仍走激进分支，否则直接 ReferenceError。 */
function structuralBrandsOf(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return [];
  if (typeof USE_STRUCTURAL_BRAND !== 'undefined' && !USE_STRUCTURAL_BRAND) return [];
  const words = s.split(/\s+/);
  if (words.length < 2) return [];
  for (let i = 1; i < words.length; i++) {
    if (!BRAND_TAIL_COMMON.test(words.slice(i).join(' '))) continue;
    const head = words.slice(0, i).join(' ');
    if (head && !TOOL_TAIL_EN.test(head)) return [head];
  }
  return [];
}

/** 品牌遮蔽术语表：喂给 translate-core（brand:true 不计 40 条提示词上限 —— P2-e）。
 *  词库整表 + 用户右键保留；整名不拆、名单名只出品牌头，去重后全部带 brand 标记。 */
/** 固定译名**硬遮蔽**（2026-10-26 真机）：模型会把 `Roach` 翻成「蟑螂」、`Oils` 翻成
 *  「油质」、`GwentCardSwap` 里的 Gwent 直接保留英文。翻错之后 `modNameOk` 还判它合格
 *  —— 译文里没有英文残留了 —— 于是永久固化，`refineByWords` 也无从下手（它只换看得见的词）。
 *  唯一可靠的办法：翻译前就把这些词遮成 `『萝卜』`，模型只能原样带回来，unmask 直接落地。
 *  与品牌遮蔽（brandMaskTerms）的区别：品牌遮成**英文原名**，这里遮成**固定中文译名**。
 *  `Oil` / `oil` 不进遮蔽：3 个字母，`Boil` / `Coil` / `Spoil` / `Soil` 全会被误遮；
 *  它留在 WORD_FIXES 里给 refineByWords 用就够了（那条路是按词判定的）。 */
/** 通用英文词（模型本来就会翻，长文本里裸送不会夹英文）：只进模组名遮蔽通道。
 *  没有这道隔离，「Change engine oils regularly」会被遮成「更换发动机剑油」
 *  （2026-10-26 本地模型 A/B 实测，wordfix-ui-test）。域内专名（法印/人物/Gwent/
 *  Roach）绝不进这张表 —— 裸送 ui/html 必夹英文（Igni 与 Quen 实录）。 */
const WORD_FIX_MOD_ONLY = new Set(['oils', 'reborn']);

function wordFixTerms() {
  const out = [];
  const seen = new Set();
  const skip = new Set(['oil']);
  for (const en of Object.keys(WORD_FIXES)) {
    const k = en.toLowerCase();
    if (skip.has(k)) continue;
    if (seen.has(k)) continue;      // Roach / roach 只留一条：fuzzy 是 gi 匹配，大小写都能中
    seen.add(k);
    out.push({ en, zh: WORD_FIXES[en], fuzzy: true, modOnly: WORD_FIX_MOD_ONLY.has(k) });
  }
  return out;
}

/** 词库版本戳：WORD_FIXES 遮蔽表内容的指纹（djb2）。表一变戳就变，
 *  下次启动触发一次漂移对账（见 auditGlossaryDrift）。 */
function glossaryStampOf(terms) {
  const sig = (terms || []).map((t) => t.en + '→' + t.zh).sort().join('|');
  let h = 5381;
  for (let i = 0; i < sig.length; i++) h = ((h * 33) ^ sig.charCodeAt(i)) >>> 0;
  // 'wfg2'：前缀带版本。v1 只写不验曾让「已落戳但收养回灌」的条目永久逃审，
  // 改戳前缀强制全体用户重审一次；配合下方「有漂移不落戳」策略自收敛。
  return 'wfg2' + h.toString(36);
}

/** 词库漂移对账（纯函数，零模型）：找出「译文缺固定译名」的缓存条目。
 *  遮蔽是翻译时的硬保证——名字里含可遮蔽词，走词库后的译文**必然**含固定
 *  译名（unmask 原样落地）。缺了 = 这条译文是词库定型/更新之前翻的
 *  （词库前 Roach 被翻成「蟑螂」，结构合格、自愈判 ok，永远轮不到自动修，
 *  只能用户右键重翻 —— 等于词库改进全靠手动，2026-10-26 用户点破）。
 *  判据与遮蔽同源（同一个 applyTerms mask），绝不另写第二套边界规则。
 *  只看值是中文的条目：保英文名条目值是英文，天然跳过；
 *  Oil/oil 不在 wordFixTerms 里（防 Boil/Soil 误遮），自然也不参与对账。 */
function auditGlossaryDrift(cache, terms, applyTermsFn, cjkRe) {
  const stale = [];
  let checked = 0;
  if (!cache || typeof cache !== 'object') return { checked, stale };
  for (const k of Object.keys(cache)) {
    if (!k || k.charAt(0) === '_') continue;
    const v = cache[k];
    if (typeof v !== 'string' || !v || !cjkRe.test(v)) continue;
    checked++;
    const masked = String(applyTermsFn(k, terms, 'mask') || '');
    const expects = (masked.match(/『([^』]+)』/g) || [])
      .map((s) => s.slice(1, -1))
      .filter((s, i, a) => a.indexOf(s) === i);
    if (!expects.length) continue;
    const missing = expects.filter((zh) => v.indexOf(zh) === -1);
    if (missing.length) stale.push({ k: k, missing: missing.join('/') });
  }
  return { checked, stale };
}

/** 单条漂移判定（对账的复用入口，判据零分叉）：英文名 en 的中文译文 zh
 *  是否缺「可遮蔽词的固定译名」。供状态层收养入口做闸——
 *  2026-10-26 实录：对账删了漂移键，dl 收养又把状态层里同款旧译文灌回缓存，
 *  自动翻译一看「有缓存」全跳过，修复等于没发生。 */
function glossaryDrifted(en, zh) {
  if (!en || !zh || typeof zh !== 'string' || !CJK.test(zh)) return false;
  return auditGlossaryDrift({ [en]: zh }, wordFixTerms(), core.applyTerms, CJK).stale.length > 0;
}

function brandMaskTerms() {
  const out = [];
  const seen = new Set();
  const names = (typeof gameKeep !== 'undefined' && Array.isArray(gameKeep) ? gameKeep.slice() : []);
  if (typeof userKeepList === 'function') {
    try {
      for (const n of userKeepList()) names.push(n);
    } catch (e) { /* 用户表读不到不影响词库部分 */ }
  }
  for (const n of names) {
    if (typeof n !== 'string' || !n.trim()) continue;
    const spec = brandMaskSpec(n);
    if (!spec.en) continue;
    const k = spec.en.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ en: spec.en, zh: spec.zh, brand: true });
  }
  return out;
}

/** 名字里出现的品牌词（cache 启动清洗用：品牌被硬译成中文的条目删掉重翻）。
 *  全大写品牌（LOOT / UE4SS / HDT-SMP）大小写敏感 —— 否则 Boss 会命中 BOSS，
 *  译文不含 BOSS → 每次启动删一次 → 死循环；其余大小写不敏感（模型爱改大小写）。
 *  边界用显式 lookaround 不用 \b：下划线是 JS 词字符，UE4SS_v3.1.0 会漏匹配。 */
function brandsInName(name) {
  const s = String(name == null ? '' : name);
  if (!s || typeof gameKeep === 'undefined' || !Array.isArray(gameKeep)) return [];
  const out = [];
  for (const n of gameKeep) {
    if (typeof n !== 'string' || !n.trim()) continue;
    const t = n.trim();
    const letters = t.replace(/[^A-Za-z]/g, '');
    const caps = letters.length >= 2 && letters === letters.toUpperCase();
    const re = new RegExp('(?<![A-Za-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])', caps ? '' : 'i');
    if (re.test(s)) out.push(t);
  }
  return out;
}

/** 品牌被硬译：原文里的品牌词在译文里一个都不剩。
 *  判据只对「原文确实含品牌词」成立——没有品牌词的条目永远返回 false，
 *  不会误伤普通模组名。seed 质检与状态库清洗共用这一份（同一判据不许写两遍）。 */
function brandLost(src, out) {
  const brands = brandsInName(src);
  if (!brands.length) return false;
  const low = String(out == null ? '' : out).toLowerCase();
  return !brands.some((t) => low.indexOf(String(t).toLowerCase()) !== -1);
}

/** 保英文词的大小写还原：模型爱把 UE4SS 抄成 Ue4ss，按英文原名的形态改回来。
 *  只动 keep 表里的词；原文里没有对应形态的词不碰（普通英文词留给验收管）。 */
function restoreKeepCase(en, zh) {
  const src = String(en == null ? '' : en);
  let out = String(zh == null ? '' : zh);
  if (!src || !out || !keepNameSet) return out;
  const canon = {};
  for (const w of src.split(/[^A-Za-z0-9]+/)) {
    if (!w || w.length < 2) continue;
    canon[w.toLowerCase()] = w;
  }
  out = out.replace(/[A-Za-z][A-Za-z0-9]*/g, (m) => {
    const lw = m.toLowerCase();
    if (!keepNameSet.has(lw)) return m;
    const c = canon[lw];
    return c && c !== m ? c : m;
  });
  return out;
}

/** 重建保英文名单 + 装配品牌遮蔽术语。mergeRuntimeTerms 的唯一实现体，
 *  启动 / 设置页保存 / 右键保留英文 三条路都收敛到这里（测试沙箱里它是空实现）。 */
function rebuildKeepNames() {
  keepNameSet = new Set(gameKeep.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().toLowerCase()));
  // 约定俗成保留英文的短词（0.16.3 续 18）：它们不是漏翻，是本来就不翻。
  // 放在这里而不是 gamenames-keep.json —— 那份是公开榜单来源，不该混进通用词。
  for (const n of ['plus', 'ultra', 'nextgen', 'next gen', 'hd', 'dlc', 'mod', 'mods', 'pack', 'ui']) keepNameSet.add(n);
  const userKept = (typeof userKeepList === 'function' ? userKeepList() : []).filter((x) => typeof x === 'string' && x.trim());
  for (const n of userKept) keepNameSet.add(String(n).trim().toLowerCase());
  for (const n of gameKeep.concat(userKept)) registerKeptBrands(n);
  // P3-4：术语表里 zh===en 的条目是「保持英文」的另一种写法，也并进保英文名单
  //（否则 refineByWords 会把 Vortex 这类词硬译成中文，与品牌遮蔽机制打架）
  for (const t of (runtimeTerms || []).concat((cfg && cfg.terms) || [])) {
    if (!t) continue;
    const en = String(t.en || '').trim().toLowerCase();
    const zh = String(t.zh || '').trim().toLowerCase();
    if (zh === en) keepNameSet.add(en);
  }
  cfg.gameTerms = (runtimeTerms || []).concat(brandMaskTerms(), wordFixTerms());
}

/** 品牌被硬译的存量缓存清掉（「剑星 Vortex 扩展包 → 星辰之刃漩涡扩展模组」那批旧账）：
 *  整名就是品牌的条目 —— 译文必须原样带着这个 token（大小写敏感，否则放过了 Ue4ss）；
 *  名字里含品牌词的条目 —— 译文至少保住其中一个（大小写不敏感，模型爱改大小写）。
 *  两条都不占的删掉，让自愈/重翻重来。 */
function purgeBrandTranslations() {
  let dropped = 0;
  const byLower = new Map();
  for (const n of (typeof gameKeep !== 'undefined' ? gameKeep : [])) {
    if (typeof n === 'string' && n.trim()) byLower.set(n.trim().toLowerCase(), n.trim());
  }
  for (const k of Object.keys(cache)) {
    if (!k || k.charAt(0) === '_') continue;
    const v = cache[k];
    if (typeof v !== 'string' || !CJK.test(v)) continue;
    const orig = byLower.get(String(k).trim().toLowerCase());
    if (orig) {
      if (String(v).indexOf(brandTokenOf(orig)) !== -1) continue;
    } else {
      const brands = brandsInName(k);
      if (!brands.length) continue;
      const lowV = String(v).toLowerCase();
      if (brands.some((t) => lowV.indexOf(t.toLowerCase()) !== -1)) continue;
    }
    delete cache[k];
    dropped++;
  }
  if (dropped) {
    if (saveJson(CACHE_PATH, cache, 'brand cache purge')) log('info', 'brand cache purged', { n: dropped });
  }
}

/** `<游戏名> Vortex Extension` → `<游戏官方译名> Vortex 扩展包`（零模型，审计 v4 #5）。
 *
 *  为什么不能交给模型：Vortex 扩展包的显示名就是这个形态，整句送翻会被自由发挥 ——
 *  实测「Stellar Blade Vortex Extension」→「恒星之刃：漩涡扩展包」：国内译名「剑星」
 *  丢了、品牌词 Vortex 被硬翻成「漩涡」。这不是模型差，是名字本身不该整句送翻：
 *  它的结构是 `<游戏名> + Vortex Extension`，游戏译名词库里现成有 746 条。
 *  这里直接按词库拼，写进 cache.json，让 DOM 贴名通道（fileStemOf 剥尾巴 → 查表）能命中。
 *
 *  幂等：已有合格译文的不动；游戏名查不到词库的不动（交回原逻辑）。
 *  返回补种条数。 */
function seedExtensionNames(state) {
  const st = state || (contextRef.api && contextRef.api.getState ? contextRef.api.getState() : null);
  if (!st || !termExact) return 0;
  const seen = new Set();
  const grab = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (!s || s.length > 120) return;
    if (!/\bvortex\s+extension$/i.test(s)) return;
    if (CJK.test(s)) return;                    // 已经是中文 → 不是要补的
    seen.add(s);
  };
  try {
    const modsRoot = ((st.persistent || {}).mods) || {};
    for (const g of Object.keys(modsRoot)) {
      const table = modsRoot[g] || {};
      for (const id of Object.keys(table)) {
        const a = (table[id] || {}).attributes || {};
        grab(a.customFileName); grab(a.logicalFileName); grab(a.name);
      }
    }
  } catch (e) { /* 状态树形状变了也不影响下载侧 */ }
  try {
    const files = (((st.persistent || {}).downloads) || {}).files || {};
    for (const id of Object.keys(files)) {
      const mi = (files[id] || {}).modInfo || {};
      grab(mi.name);
      grab((((mi.nexus || {}).fileInfo) || {}).name);
    }
  } catch (e) { /* ignore */ }
  let n = 0;
  for (const en of seen) {
    const cur = String(nameCacheOf(en) == null ? '' : nameCacheOf(en)).trim();
    // 「<游戏名> Vortex Extension」：左端必须非空，右端必须是 extension 整词
    const m = en.match(/^(.+?)[\s:：\-–—]+vortex\s+extension$/i);
    if (!m) continue;
    const game = String(m[1]).trim();
    if (!game) continue;
    let zh = '';
    try { zh = termExact.get(normKey(game).toLowerCase()) || ''; } catch (e) { zh = ''; }
    if (!zh || !CJK.test(zh)) continue;         // 词库查不到游戏译名 → 不拼（不猜）
    // 词库里 `inZOI` 写成 `inZOI (云族裔)`，已经带原文了就直接接，不再补一遍英文
    const out = zh + ' Vortex 扩展包';
    if (out.length > 80) continue;
    // 已有译文里带着游戏官方译名 → 认为可接受，不动（尊重人工/模型的结果）。
    // 否则强制覆盖：纯中文的坏译文（`恒星之刃：漩涡扩展包`）在 residueWords 眼里
    // 「没有英文残留」＝ 合格，modNameOk 拦不住它 —— 这正是审计 v4 P1-1 那条漏网。
    if (cur === out || (cur && cur.indexOf(zh) >= 0)) continue;
    const ckSeed = cacheKeyOf(en);
    // cacheKeyOf 拒绝中文/空键时返回 ''，此时不写（写出 '' 键等于制造一条永远读不到的垃圾）
    if (ckSeed) cache[ckSeed] = out;
    n++;
  }
  if (n > 0) {
    if (saveJson(CACHE_PATH, cache, 'extension names seed')) log('info', 'extension names seeded', { n });
  }
  return n;
}

/** 缓存死账通道（0.16.3 续 18）——专治「半中半英」里最难的那一类。
 *  死角长这样：状态层（modInfo.fileInfo.name / customFileName）**还是英文**，
 *  译文只存在于 cache.json，而 cache.json 里那条就是坏的。三个通道全都够不着：
 *    ① healStale* 系列：第一行 `if (!CJK.test(cur)) continue` —— 状态是英文，直接跳过；
 *    ② 批量重翻：`needsTranslate` 要求「纯英文」才送模型，状态是英文但缓存有译文，
 *       DOM 直接贴缓存，模型永远拿不到这条；
 *    ③ refineByWords：只吃中文显示串，而这条在状态层不存在中文。
 *  结果就是永久固化（实测 `Gwent卡牌交换模组 1.3版` / `召唤并骑乘roach…`）。
 *
 *  判据三层，全部零模型：
 *    a) 译文含汉字，且 residueWords 非空；
 *    b) modNameOk 判不合格；
 *    c) 残留词必须在**英文原键里出现过**（大小写不敏感）—— 源感知，杜绝
 *       「模型故意保留的英文」被误删（`Plus` / `ULTRA` 这类不在键里就动都不动）。
 *  能靠 wordCache 修的直接改；修不了且属于重伤（`badlyUnfinished`）的删掉让模型重来；
 *  轻伤修不了的留着不动 —— 删掉只会让界面退回英文，比半中半英更糟。 */
async function healStaleCacheEntries() {
  // ① 脏键清理：含 ISO 日期戳的缓存键一定是「状态键被当原名」的产物，
  // 正常模组名不会有 `2026-10-03T17-14Z`。这类键的译文必然是「把 fileId、更新日期、
  // 随机 id 一起翻进中文」的垃圾，而且会通过 nameCacheOf 反过来盖掉干净键的译文
  // （2026-10-26 真机：`Clean Water` 和 `Clean Water 13392 1 2026-10-03T17-14Z …`
  // 两份键同时存在，界面上赢的是脏的那份）。先清掉，后面的判据才有干净基准。
  let dirtyKeys = 0;
  for (const k of Object.keys(cache)) {
    if (!k || k.charAt(0) === '_') continue;
    if (!/\d\d\d\d-\d\d-\d\dT\d\d[-:]\d\d/.test(k)) continue;
    delete cache[k];
    dirtyKeys++;
  }
  if (dirtyKeys > 0) {
    if (saveJson(CACHE_PATH, cache, 'dirty cache keys drop')) log('info', 'dirty cache keys dropped', { n: dirtyKeys });
  }
  // 键压平后做子串匹配：`GwentCardSwap 1.3` → `gwentcardswap13`，能对上残留词 `Gwent`。
  // 按空格分词是不行的 —— 驼峰词 `GwentCardSwap` 切不出 `gwent`（实测漏掉这一条）。
  const flatKey = (en) => String(en == null ? '' : en).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const hits = [];
  for (const k of Object.keys(cache)) {
    if (!k || k.charAt(0) === '_') continue;
    const v = cache[k];
    if (typeof v !== 'string' || !v || !CJK.test(v)) continue;
    const res = residueWords(v);
    if (!res.length) continue;
    if (modNameOk(v)) continue;
    const flat = flatKey(k);
    if (!res.some((w) => flat.indexOf(String(w).toLowerCase()) >= 0)) continue;  // 源里没有 → 不是漏翻
    hits.push(k);
  }
  if (!hits.length) return dirtyKeys;
  let fixed = 0;
  let dropped = 0;
  for (const k of hits) {
    const before = cache[k];
    let after = before;
    try { after = await refineByWords(before); } catch (e) { after = before; }
    if (after && after !== before && modNameOk(after)) {
      cache[k] = after;
      fixed++;
      log('info', 'stale cache fixed', { key: k, from: before, to: after });
    } else if (badlyUnfinished(before)) {
      delete cache[k];
      dropped++;
      log('info', 'stale cache dropped', { key: k, was: before });
    }
  }
  if (fixed || dropped) {
    saveJson(CACHE_PATH, cache, 'stale cache drop');
  }
  log('info', 'stale cache healed', { seen: hits.length, fixed, dropped, dirtyKeys });
  return fixed + dropped + dirtyKeys;
}

/** 状态库清洗：品牌词被硬译进显示名（`蓬松模组管理器`）的条目还原成英文原名。
 *  为什么必须单独做一次：customFileName 是**存进去的死文本**，品牌遮蔽只保护「新翻译」
 *  那一条路；当年还没有词库时写进状态的坏译文不会自己变回来，界面就一直显示它，
 *  看上去像「词库没生效」。判据用 brandLost（品牌词一个不剩）；合格译文
 *  （`Fluffy 模组管理器`）品牌词还在，不动。
 *  还原值是英文原名而不是本地拼装：宁可直接显示英文，也不给一个半对半错的缝合名。 */
function restoreBrandNames(state) {
  const modsRoot = ((state || {}).persistent || {}).mods || {};
  let n = 0;
  for (const gameId of Object.keys(modsRoot)) {
    const table = modsRoot[gameId] || {};
    for (const modId of Object.keys(table)) {
      const mod = table[modId];
      if (!mod) continue;
      const a = mod.attributes || {};
      const cur = String(a.customFileName || '').trim();
      if (!cur || !CJK.test(cur)) continue;              // 已经是英文/空的不用管
      let en = '';
      try {
        const list = englishBaseNameOf(mod, modId);
        en = (Array.isArray(list) && list[0]) || '';
      } catch (e) { en = ''; }
      if (!en || CJK.test(en)) continue;
      if (!brandLost(en, cur)) continue;
      if (dispatch('customFileName', gameId, modId, en)) {
        n++;
        log('info', 'brand name restored', {
          modId: String(modId).slice(0, 40), from: cur.slice(0, 40), to: en.slice(0, 40),
        });
      }
    }
  }
  return n;
}

// ---------- 名字译文验收（三规则 + 半成品拦截） ----------
// 目标不是「翻得完美」，是「坏结果不落地」：不达标的译文不写状态、不贴屏，
// 最坏结局是保持英文原文（Vortex 天然状态，零危害）。
// R1 译文里必须真的翻成了中文（整串照抄英文 = 拒）
// R2 用引号把整串包起来、又没多翻几个字的缝合怪 = 拒（实测 `“GwentCardSwap 1.3”版本`）
// R3 原文照抄 + ≤2 个汉字凑数 = 拒（同 R2 家族，引号变体之外的兜底）
// R4 译文残留 ≥12 字符长英文串且原文里也有它 = 拒（半拉子，如 `ModSkillSlotPages 重制版 1.8`；
//    短词不算 —— `Half Done 重制版 3.0` 这种放行）
// 双模：两参＝「原文 vs 译文」对判；单参＝自判「这个显示名本身是不是合格译文」
//   （healWorthy / 一键重翻的判据 / 测试契约全是单参）。单参时 src 取 zh 自身，
//   跳过「译文=原文」守卫，R2/R3/R4 全部退化成自比较，再补一条残留规则（见下）。
// 这是全项目唯一一份验收实现：nameAcceptable / cacheLooksDone 都只是它的别名，
// 不许再抄第二份（同一判据两份实现的亏，0.16.3 吃过）。
function modNameOk(raw, out) {
  const single = out === undefined;
  const src = String(raw == null ? '' : raw).trim();
  const zh = single ? src : String(out == null ? '' : out).trim();
  if (!src || !zh) return false;
  if (!single && zh === src) return false;
  if (!CJK.test(zh)) return false; // R1
  // 注意：两个正则都要以 `(` 开头 —— 测试沙箱的源码抽取器不认「空格后接正则」，
  // 会把字符类里的引号当成字符串起点，切片直接越界（实测 modNameOk 被抽成 522 行）。
  if ((/^[“”"'‘'「『《]/.test(zh)) && (/[””"'’'」』》]$/.test(zh)) && zh.length <= src.length + 6) return false; // R2
  const asciiOf = (s) => (String(s).match(/[A-Za-z0-9._]+/g) || []).join('');
  const aSrc = asciiOf(src);
  const aZh = asciiOf(zh);
  const cjkN = (zh.match(/[\u4e00-\u9fa5\u3400-\u4dbf]/g) || []).length; // 必须带 g：非全局 match 只回第一个
  // R3 只在两参模式生效：单参自判时 src 就是 zh，「原文照抄 + ≤2 汉字凑数」退化成
  // 「≤2 汉字就拒」，会把 `样例42` 这种合法短译名误杀（probe 组 6 实录）——
  // 单参模式下真有照抄残留由下面的残留规则管（Remastered版 / Gwent卡牌12 都拦得住）。
  if (!single && aSrc && aZh.length >= aSrc.length * 0.9 && cjkN <= 2) return false; // R3
  const runs = zh.match(/[A-Za-z][A-Za-z0-9._]{11,}/g) || [];
  if (runs.some((r) => src.indexOf(r) !== -1)) return false; // R4
  // 单参自判的补充规则：残留英文词里有「真词」（≥4 字母）就不算翻好。
  //   'VAXIS血迹物理效果v1.5.zip' 的 zip（3 字母）放行 —— 文件尾巴不是漏翻；
  //   'Wobbly 模组管理器' 的 Wobbly、'缺失的Gwent卡牌…' 的 Gwent 拒
  //   （0.16.3 续 12：未登记品牌词照常算残留，出口是右键「这个名字保留英文」）。
  //   专名（连续大写）/版本号/词库保留词 residueWords 已经滤掉，这里只管剩下的。
  if (single) {
    for (const w of residueWords(zh)) if (w.length >= 4) return false;
  }
  return true;
}

/** 兼容名（applyTranslation 等老调用点 + accept-test 沙箱）——别在这里抄规则 */
function nameAcceptable(raw, out) {
  return modNameOk(raw, out);
}

/** 缓存译文验收：贴屏/自愈/查表前的同一道闸（D1：贴名的数据也必须过验收）。
 *  双模（与 modNameOk 同思路）：两参 = 「原文 vs 译文」对判；
 *  单参 = 自判「这个值本身是不是完整译文」—— 半拉子 `ModSettings 重制版 1.0`
 *  两参能过（ASCII 占比低），单参过不了（有残留词），而查表/自愈要的是后者。 */
function cacheLooksDone(raw, zh) {
  const single = zh === undefined;
  const v = single ? String(raw == null ? '' : raw).trim() : String(zh == null ? '' : zh).trim();
  if (!v || !CJK.test(v)) return false;
  return single ? modNameOk(v) : modNameOk(raw, v);
}

/** 一对 (原文, 译文) 的判定 + 理由（日志/诊断用）。双模：
 *   两参 = 「原文 vs 译文」对判（老行为，回 {ok, reason}）；
 *   单参 = 自判「这个显示名本身是不是合格译文」（回理由串 —— 探针复本与
 *   hit.judge 都用它：nameJudge(zh) === 'ok' 是「状态层这行翻好了」的唯一口径，
 *   再各写一份判据必然漂移，0.16.3 已经吃过两次）。 */
function nameJudge(raw, zh) {
  const single = zh === undefined;
  const src = String(raw == null ? '' : raw).trim();
  const out = single ? src : String(zh == null ? '' : zh).trim();
  const bad = (reason) => (single ? reason : { ok: false, reason });
  if (!src || !out) return bad('empty');
  if (!single && out === src) return bad('same');
  if (!CJK.test(out)) return bad('no-cjk');
  if (!(single ? modNameOk(src) : modNameOk(src, out))) return bad('unfinished');
  return single ? 'ok' : { ok: true, reason: 'ok' };
}

// ---------- 状态层签名表（nameGate 的数据源） ----------
// 10 秒 TTL：Vortex 状态树在高频重写（下载进度），每轮全扫太贵；
// 但模组装卸又要尽快反映，10 秒是「界面响应」与「CPU」之间的折中。
//
// 三条通道（按优先级）：
//   ① byShort 精确：plainForName 全等（下划线保留 —— 下载行的 DOM 文本常带
//      `SomeUniqueName_Here` 这种原样文件名，归一成空格就查不到）；
//   ② 同族：文本 token ⊆ 条目 token 且文本含该条目一个长「族特征词」
//      （≥10 字母；单 token 文本要求 ≥12 —— `审判之眼：死神的遗言 Remastered`
//      这种「中文名 + 通用词 Remastered」实测会被子集规则误杀，6165 条 pack.json
//      全量预演钉死的边界）。版本号不算 token，所以 1.8 的行能命中 1.9 的条目；
//   ③ 什么都不沾 → 不是名字（界面文案绝大多数死在这一步，且不遍历 items）。
//
// 单 token 名（UE4SS / REFramework）只走①：签名通道对它们没有意义，
// 短词进同族通道就是误伤（`UE4SS Proxy`、`Hair Color` 都是这么来的）。
//
// bySig / re 只是给观测探针（modname-probe-test）用的复本：按「同族不同版本
// 共享签名」把 items 归组，生产代码只读 byShort/longIdx，re 懒构建零成本。
//
// 所有助手一律内联为局部闭包：测试沙箱只抽列出的函数，引用没被抽的模块级
// 助手会 ReferenceError，再被 nameGate 的 try/catch 吞成「闸门不命中」。
let nameProbeCache = null;
let nameProbeAt = 0;
let nameProbeLogged = false;

function nameProbeIndex(state) {
  const now = Date.now();
  if (nameProbeCache && now - nameProbeAt < 10000) return nameProbeCache;
  const items = [];
  const seen = new Set();
  // 名字用纯文本：剥伪标签 + 空白折叠（与 plainForName 同口径，保留下划线）
  const shortOf = (s) => plainForName(String(s == null ? '' : s)).toLowerCase();
  // 归一化：下划线当空格（token 切分用），版本号/时间戳尾巴由调用方处理
  const normOf = (s) => shortOf(s).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  const toksOf = (s) => {
    const out = [];
    for (const w of normOf(s).split(/[^a-z0-9]+/)) {
      if (!w) continue;
      if (/^v?\d+(\.\d+)*[a-z]?$/i.test(w)) continue;   // 版本号不进 token
      out.push(w);
    }
    return out;
  };
  // mods 表键 `<名字> <fileId> <版本> <时间戳> <随机id>`：属性里没有英文名时
  // （合集 / 无属性模组）按时间戳锚定剥出名字（名字本身可含空格）。
  const nameFromModKey = (key) => {
    const parts = String(key == null ? '' : key).trim().split(/\s+/);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (/^\d\d\d\d-\d\d-\d\dT[\d:Z.-]+$/i.test(parts[i])) return parts.slice(0, Math.max(0, i - 2)).join(' ');
    }
    return parts.slice(0, Math.max(1, parts.length - 2)).join(' ');
  };
  // 下载文件名 → 族基名：唯一实现是 dom-translator 的 fileStemOf（S-1 合并）。
  // 以前这里有一份自己的循环正则，两处判据双向不一致：
  //   剥不掉空格分隔的尾巴（`名字 版本 版本-日期-hash.zip` 整串进签名表）
  //   反过来把 `1.2.3.zip` 剥成 `1`、`a1b2c3d4e5f6.zip` 原样返回当名字。
  // requireArchive:false —— 下载记录的 fileName 不一定带 .zip 后缀（手动装的目录）。
  // 沙箱注不到 domTranslator 时退化为「只去后缀」，宁可少剥也不能抛（见文件头沙箱约定）。
  // ★守卫必须写成 `typeof domTranslator !== 'undefined'`：裸写 `domTranslator && …`
  //   在 new Function 沙箱里是 ReferenceError（typeof 的豁免只对 typeof 形式有效），
  //   会被 catch 吞掉 → 静默退化成兜底，测试测的就不是真实现（0.16.3 续17 踩过）。
  const fileBaseName = (fn) => {
    const raw = String(fn == null ? '' : fn).trim();
    if (!raw) return '';
    if (typeof domTranslator !== 'undefined' && domTranslator
      && typeof domTranslator.fileStemOf === 'function') {
      try {
        const stem = String(domTranslator.fileStemOf(raw, { requireArchive: false }) || '');
        if (stem) return stem;
      } catch (e) { /* 退化到下面 */ }
    }
    return raw.replace(/\.(zip|7z|rar)$/i, '').trim();
  };
  // zh = 状态层现值（displayNameOf / modInfo.name），judge/state 都取它
  const push = (en, kind, ref, zh) => {
    const s = String(en == null ? '' : en).trim();
    if (!s || s.length < 3 || s.length > 200) return;
    const lw = s.toLowerCase();
    if (seen.has(lw)) return;
    seen.add(lw);
    items.push({ en: s, kind, ref, zh: String(zh == null ? '' : zh).trim(), norm: normOf(s), toks: toksOf(s) });
  };
  try {
    const modsRoot = ((state || {}).persistent || {}).mods || {};
    for (const gameId of Object.keys(modsRoot)) {
      const table = modsRoot[gameId] || {};
      for (const modId of Object.keys(table)) {
        const mod = table[modId] || {};
        const ref = { gameId, modId };
        const a = mod.attributes || {};
        // englishBaseNameOf 返候选数组（originalName / logicalFileName / 键派生…）；
        // 全部进签名表——DOM 文本可能是其中任何一个形态（实测下载行带下划线原名）。
        const ens = englishBaseNameOf(mod, modId) || [];
        const list = (Array.isArray(ens) ? ens : [ens]).map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
        const en = list[0] || nameFromModKey(modId);
        const disp = String(displayNameOf(mod) || '').trim();
        push(en, mod.type === 'collection' ? 'collection' : 'mod', ref, disp);
        for (const c of list) push(c, mod.type === 'collection' ? 'collection' : 'mod', ref, disp);
        const lf = String(a.logicalFileName || '').trim();
        if (lf && lf.toLowerCase() !== en.toLowerCase()) push(lf, 'mod', ref, disp);
      }
    }
    // 下载记录：P1-a —— 判据字段是 nexus.fileInfo.name，签名表必须同源，
    // 否则「状态层已是中文 → 被 CJK 判据丢弃 → 闸门假 → 贴名路走不到 →
    // 退通用文本路写 domCache（违反 D1）」。
    // modInfo.name 与 fileInfo.name 都推 'download'（probe 组 3：只有 modInfo.name
    // 的记录也必须是 download）；fileName 剥名后推 'download-file'。
    const files = (((state || {}).persistent || {}).downloads || {}).files || {};
    for (const dlId of Object.keys(files)) {
      const d = files[dlId] || {};
      const mi = d.modInfo || {};
      const ref = { dlId };
      const fi = String((mi.nexus && mi.nexus.fileInfo && mi.nexus.fileInfo.name) || '').trim();
      const mn = String(mi.name || '').trim();
      const disp = mn || fi;
      if (fi) push(fi, 'download', ref, disp);
      if (mn) push(mn, 'download', ref, mn);
      if (d.fileName) {
        const base = fileBaseName(d.fileName);
        if (base) push(base, 'download-file', ref, disp);
      }
    }
  } catch (e) {
    if (!nameProbeLogged) { nameProbeLogged = true; log('warn', 'name probe failed', { err: String(e && e.message || e) }); }
  }
  // ── 通道索引 ──
  const byShort = new Map();   // plain 全等（保留下划线）→ items[]
  const bySig = new Map();     // 族签名（版本无关）→ items[]（探针复本用）
  const shortExact = new Set();// 单 token 名的 plain 全等集合（短名护栏）
  const longIdx = new Map();   // ≥10 字母 token → items[]（同族反查）
  const sigAdd = (map, key, it) => {
    if (!key) return;
    const k = key.toLowerCase();
    const arr = map.get(k);
    if (arr) { if (arr.indexOf(it) < 0) arr.push(it); } else map.set(k, [it]);
  };
  // 短名全等通道：整名（单 token）入表要过「含数字或驼峰」门 ——
  // `Hair`/`Body`/`Map` 这种 4 字母普通词进去，界面文案整句就被判成名字不翻了；
  // 长名（≥8 字母）直接进，`UE4SS` 靠数字进，`SkyUI` 靠驼峰进。
  const addShort = (flat, item) => { shortExact.add(String(flat).toLowerCase()); };
  for (const item of items) {
    const arr = byShort.get(item.norm);
    if (arr) { if (arr.indexOf(item) < 0) arr.push(item); } else byShort.set(item.norm, [item]);
    if (item.toks.length === 1) {
      const flat = item.en;
      if (flat.length >= 8) addShort(flat, item);
      if (flat.length < 8 && (/\d/.test(flat) || /[a-z][A-Z]/.test(flat))) addShort(flat, item);
      // 单 token 只有长名才进签名：`Remastered`（10 字母）这种通用词进去，
      // 「Remastered Edition Notes」整句就被探针复本判成名字（probe 组 4a）
      if (item.toks[0].length >= 12) sigAdd(bySig, item.norm, item);
    } else {
      sigAdd(bySig, item.norm, item);
      const tj = item.toks.join(' ');
      if (tj && tj !== item.norm) sigAdd(bySig, tj, item);
      // 前缀签名：含 ≥10 字母 token 的前缀（同族共享，探针复本按最长者取代表）
      for (let i = 1; i < item.toks.length; i++) {
        const pre = item.toks.slice(0, i);
        if (pre.some((w) => w.length >= 10)) sigAdd(bySig, pre.join(' '), item);
      }
    }
    for (const tk of item.toks) if (tk.length >= 10) {
      const la = longIdx.get(tk);
      if (la) { if (la.indexOf(item) < 0) la.push(item); } else longIdx.set(tk, [item]);
    }
  }
  const findBest = (text) => {
    const s = plainForName(String(text == null ? '' : text));
    if (!s) return null;
    const shortHits = byShort.get(s.toLowerCase());
    if (shortHits && shortHits.length) return { it: shortHits[0], cands: shortHits.length };
    const tt = toksOf(s);
    if (!tt.length) return null;
    const tset = new Set(tt);
    const pool = [];
    for (const tk of tset) {
      if (tk.length < 10) continue;
      const arr = longIdx.get(tk);
      if (!arr) continue;
      for (const c of arr) if (pool.indexOf(c) < 0) pool.push(c);
    }
    let best = null;
    let n = 0;
    for (const c of pool) {
      let sub = true;
      for (const x of tset) if (c.toks.indexOf(x) < 0) { sub = false; break; }
      if (!sub) continue;
      // 单 token 文本只认 ≥12 字母的长名（中文名 + 通用词尾巴放行）
      if (tt.length < 2 && tt[0].length < 12) continue;
      n++;
      if (!best || c.en.length > best.en.length) best = c;
    }
    return best ? { it: best, cands: n } : null;
  };
  const isName = (s) => findBest(s) !== null;
  const match = (text) => {
    const r = findBest(text);
    if (!r) return null;
    return { en: r.it.en, kind: r.it.kind, isName: true, judge: nameJudge(r.it.zh), state: r.it.zh, cands: r.cands, ref: r.it.ref };
  };
  const idx = { items, isName, match, bySig, byShort, shortExact, re: null };
  // re 懒构建：只有探针复本读它，生产零成本；空签名表回 null（gate2 组 8 钉住）
  Object.defineProperty(idx, 're', {
    enumerable: false,
    get() {
      if (idx.__re === undefined) {
        const keys = Array.from(bySig.keys()).sort((a, b) => b.length - a.length);
        idx.__re = keys.length
          ? new RegExp('(?<![A-Za-z0-9])(' + keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![A-Za-z0-9])', 'i')
          : null;
      }
      return idx.__re;
    },
  });
  nameProbeCache = idx;
  nameProbeAt = now;
  return nameProbeCache;
}

/** 闸门：这段 DOM 文本是不是一个模组名（→ 走贴名路，不进模型、不写 domCache）。
 *  恒返 {hit, epoch}：hit = {en, kind, isName, judge, state, cands, ref} 或 null。
 *  F1（续14）：`<游戏名> Vortex Extension` 是扩展显示名不是模组名（同名不同物），
 *  拦下来反而一个写者都没有（cache.json 无此键 → 不贴；prune 又删 domCache →
 *  永久英文），必须放行去送模型。 */
function nameGate(text) {
  const t = String(text == null ? '' : text).trim();
  let idx = null;
  try { idx = nameProbeIndex(contextRef.api.getState()); } catch (e) { idx = null; }
  if (!t || t.length < 3 || t.length > 200) return { hit: null, epoch: nameProbeAt };
  if (/\bvortex\s+extension$/i.test(t)) return { hit: null, epoch: nameProbeAt };
  let hit = null;
  if (idx) { try { hit = idx.match(t); } catch (e) { hit = null; } }
  return { hit, epoch: nameProbeAt };
}

// ---------- 名字查译文（状态层 cache.json 是唯一名字译文源，D1） ----------
// 精确键 → 归一化键（空白折叠，10 秒 TTL 索引）→ cacheLooksDone 验收；查不到返回 null。
// DOM 层拿到 null 就按老行为走（没有译文就不贴），绝不为此送模型。
let nameNormIdx = null;
let nameNormIdxAt = 0;
// 索引 TTL 刻意声明在这个区间里：dlname/namepaste 的测试沙箱按「let nameNormIdx」
// 到「badlyUnfinished」整段切片，常量写在区间外它们会 ReferenceError；
// 而 audit2/refresh/audit4 各自在前缀里声明了同名常量 + 只抽函数声明，不会重复。
const NAME_NORM_IDX_TTL = 10000;
function nameTranslationOf(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || !cache) return null;
  // 字典一律走 hasOwnProperty：普通对象的 cache['toString'] 会把函数当译文写进页面
  const direct = (k) => (k && Object.prototype.hasOwnProperty.call(cache, k) ? cache[k] : undefined);
  let v = direct(t);
  const now = Date.now();
  const idxOf = () => {
    if (!nameNormIdx || now - nameNormIdxAt > 10000) {
      nameNormIdx = new Map();
      for (const k of Object.keys(cache)) nameNormIdx.set(normKey(k), k);
      nameNormIdxAt = now;
    }
    return nameNormIdx;
  };
  // ② 归一化键（空白折叠）
  if (v === undefined) {
    const k2 = idxOf().get(normKey(t));
    if (k2 !== undefined) v = cache[k2];
  }
  // ③ 规范键 —— **必须在 normKey 之后补这一级**。
  //    写侧（applyTranslation / applyDownloadTranslation / 下载补缓存）一律用
  //    `canonicalName` 存键：`SwordFXRemaster` → `Sword FXRemaster`，
  //    `ModSettingsMenuFix` → `Mod Settings Menu Fix`，`VAXIS_B_x.zip` → `VAXIS B x`。
  //    而屏幕上是**原串**（驼峰连写、下划线、带 .zip）。读侧以前只做 ①②，
  //    这两种形态 normKey 都归不到一起 → 键明明在缓存里却查不到，
  //    表现就是「已卸载行、下载行永远是英文」。
  //    这是 P-NAME-05 的直接原因：不是没翻，是读了不算。
  if (v === undefined && typeof canonicalName === 'function') {
    const ck = canonicalName(t);
    if (ck && ck !== t) {
      v = direct(ck);
      if (v === undefined) {
        const k3 = idxOf().get(normKey(ck));
        if (k3 !== undefined) v = cache[k3];
      }
    }
  }
  if (typeof v !== 'string' || !v || v === t) return null;
  if (!cacheLooksDone(t, v)) return null;
  return v;
}

/** 归一化索引（10 秒 TTL）：normKey(k) → k。贴名/自愈/重翻共用同一份。 */
function nameNormIndex() {
  const now = Date.now();
  if (!nameNormIdx || now - nameNormIdxAt > NAME_NORM_IDX_TTL) {
    nameNormIdx = new Map();
    for (const k of Object.keys(cache)) nameNormIdx.set(normKey(k), k);
    nameNormIdxAt = now;
  }
  return nameNormIdx;
}

/** 脏键清洗：`VAXIS_Blood_Physics_v1.5.zip` → `VAXIS Blood Physics v1.5`
 *  （下载行/本地文件名的形态与缓存键差一个后缀和下划线，不清就永远查不到）。 */
function cleanKeyForm(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  s = s.replace(/\.(zip|7z|rar)$/i, '');
  s = s.replace(/_+/g, ' ');
  return normKey(s);
}

/** 规范名字键 —— **唯一**的名字身份算法。
 *
 *  缓存键、送模型的 raw、失败记账键、DOM 查询用的键，全部由它算出来。
 *  为什么要收成一个：Vortex 给同一个模组存了 7 个名字字段
 *  （customFileName / logicalFileName / name / originalName / fileName / modName / 表键），
 *  形态各不相同（整串键 `Clean Water 13392 1 2026-10-03T17-14Z GpMW8t9md`、带 .zip、
 *  下划线、驼峰）。0.16.3 之前每个环节各自决定用哪个字段、各自清洗一次，
 *  于是只要两处口径不一致就出 bug ——
 *    ① 送模型用整串     → 模型把 fileId/日期/hash 翻进中文（元数据污染）
 *    ② 写缓存用干净骨架、查询用整串 → 清空缓存重翻后界面查不到，停在英文
 *    ③ 失败不记账       → 翻不过的条目每次收集都重来（无限重试）
 *  这三个是同一个病，只是从三个地方冒出来。
 *
 *  与 cleanKeyForm 的分工（**别合并**）：
 *    cleanKeyForm 只剥后缀 / 下划线换空格 / 折叠空白，它被
 *    `versionTailOf(cleanKeyForm(raw))` 依赖来取版本尾巴 —— 往里加剥日期，
 *    「借同族译文」的版本精确判断立刻失效（D2 红线）。
 *    canonicalName 才是「这个名字的身份」，可以把整串键彻底剥干净。
 *
 *  正则不用 {n} 量词：测试沙箱按花括号配平切函数体。 */
function canonicalName(text) {
  let s = String(text == null ? '' : text);
  // 零宽字符先去掉，再把空白折叠成单空格
  s = s.replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // 压缩包后缀不是名字。**必须支持出现在中间**：
  // `VAXIS_Blood_Physics_v1.4.zip 13506 1.4 2026-10-07T20-54Z hw6Xp1` 这形态是
  // 下载行的标准键（Vortex 直接把 localPath 里的文件名当名字），只剥行尾就剩个
  // `.zip` 卡在中间，与缓存键 `VAXIS Blood Physics v1.4` 永远对不上（v9 组 3 实测）。
  s = s.replace(/\.(zip|7z|rar)(?![A-Za-z0-9])/gi, ' ').replace(/\s+/g, ' ').trim();
  // `<名字> <fileId> <版本> <日期T时-分Z> <hash>`：日期戳锚定，
  // 切掉它前面的「fileId + 版本」两段、以及它之后的全部。
  // 名字自带的版本（`ModSkillSlotPages Remaster 1.7a`、`Enemy Scaling Offset 1.2.0`）
  // 在名字段里，不受影响。
  const at = s.search(/\d\d\d\d-\d\d-\d\dT\d\d[-:]\d\d/);
  if (at > 0) {
    const seg = s.slice(0, at).trim().split(' ').filter(Boolean);
    if (seg.length >= 3) s = seg.slice(0, seg.length - 2).join(' ');
  }
  // 下划线是文件名的分词符，不是名字的一部分
  s = s.replace(/_+/g, ' ');
  // 驼峰拆词：ModSkillSlotPages → Mod Skill Slot Pages。
  // **只在小写字母后接大写处拆**（不含数字）：`UE4SS` 这种「缩写+数字+缩写」的
  // 专名一旦按数字后接大写拆成 `UE4 SS`，模型就敢把 SS 翻成别的词
  // （2026-10-26 端到端演练实测：UE4SS 被拆坏，它还是保英文名单里的条目）。
  // 同理 REFramework / CWSO / VAXIS / UE5 全部原样保留。
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
  return s.replace(/\s+/g, ' ').trim();
}

/** 缓存键一次性规范化（升级迁移）。**不做这个，改键就是一次事故**：
 *  读/写/删三侧现在都按 canonicalName 取键，而旧 cache.json 里是原串键
 *  （`ModSkillSlotPages Remaster 1.7a`、`Clean Water 13392 1 2026-…`）。
 *  不迁移 → 升级后所有旧译文突然查不到 → 界面整体退回英文，
 *  用户看到的现象跟「缓存被清空」一模一样，只会被当成模型坏了（0.16.3 反复复发的坑）。
 *  冲突（两个旧键规范化后重合）时保留先到的非空译文，绝不合并拼接。
 *  返回改名的键数；只在 >0 时由调用方落盘。 */
function normalizeCacheKeys(dict) {
  if (!dict || typeof dict !== 'object') return 0;
  const keys = Object.keys(dict);
  let n = 0;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(dict, k)) continue;
    if (!k || k.charAt(0) === '_') continue;        // 元信息键（_ver 之类）不是名字
    if (/^[a-z]+:/.test(k)) continue;               // sh:/dl: 前缀键装的是显示名，不许归一化
    const ck = typeof cacheKeyOf === 'function' ? cacheKeyOf(k) : k;
    if (!ck || ck === k) continue;
    const v = dict[k];
    const has = Object.prototype.hasOwnProperty.call(dict, ck);
    const prev = has ? dict[ck] : undefined;
    const pv = typeof prev === 'string' ? prev.trim() : '';
    const nv = typeof v === 'string' ? v.trim() : '';
    if (!has || (!pv && nv)) dict[ck] = v;
    delete dict[k];
    n++;
  }
  return n;
}

/** 缓存写入键 = 规范键。所有 `cache[...] = 译文` 都必须经这里，
 *  这样「写」和 `nameCacheOf` 的「读」永远是同一个算法算出来的键。
 *
 *  ★ 返回 `''` = **拒绝写入**（空键 / 中文键）。调用方必须判空，直接
 *  `cache[cacheKeyOf(x)] = y` 会在 x 是中文时写出一个 `''` 键，同样是垃圾。
 *
 *  为什么中文键必须拒绝（2026-10-26 审查反馈 #2，二次污染入口）：
 *  cache 的键必须是**英文原名**。读侧 `nameTranslationOf` 查中文时取到的是自己
 *  （v === t），会按「没翻」返回 null —— 所以中文键永远贴不上屏，纯占地方。
 *  更危险的是它会重开「键不对称」那个事故：`downloadTargetOf` 在
 *  `fileInfo.name` 缺失时 base 会退化成中文显示名（`base = en && !CJK.test(en) ? en : disp`），
 *  那一支以前会把「中→中」写进缓存。中文键一旦混进来，读侧第三级的
 *  `canonicalName` 对中文不做拆词，键照样对不上 —— 下一次「同源」事故从这里进。 */
function cacheKeyOf(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return '';
  let key = raw;
  if (typeof canonicalName === 'function') {
    const c = canonicalName(raw);
    if (c) key = c;
  }
  // CJK 正则用 typeof 守卫：audit2 / v9 的老沙箱只抽了本函数、没注 CJK 常量。
  const cjk = typeof CJK !== 'undefined' ? CJK : /[\u4e00-\u9fa5\u3400-\u4dbf]/;
  if (cjk.test(key)) return '';
  return key;
}

/** 缓存删除键 = 规范键 + 原串键。删除是读写之外的**第三个**入口，
 *  必须和 `cacheKeyOf` / `nameCacheOf` 用同一套算法 —— 它们三者一起才是
 *  「单一缓存源」。漏了删除侧就是 0.16.3 那个「还原为英文点了没反应」：
 *  写进去的是规范键 `Clean Water`，删除删的是原串键 `Clean Water 13392 1 …`，
 *  规范键原封不动 → 重启 8 秒后 applyCachedSilently 又按缓存把中文贴回去。
 *  返回删掉的条数。沙箱里没注 cacheKeyOf 时自动退化成精确键删除（老行为）。 */
function dropTranslation(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || !cache) return 0;
  const ck = typeof cacheKeyOf === 'function' ? cacheKeyOf(t) : t;
  const keys = ck && ck !== t ? [ck, t] : [t];
  let n = 0;
  for (const k of keys) {
    if (k && Object.prototype.hasOwnProperty.call(cache, k)) { delete cache[k]; n++; }
  }
  return n;
}

/** 名字缓存统一入口（P1-3）：四处入口（自愈/重翻/下载收集/启动套缓存）都走它。
 *  查找序：**规范键** → 原串精确键（旧缓存兼容）→ 清洗键（去后缀/下划线）→ 归一化索引。
 *  值必须本身是合格译文（单参自判）—— 闸门上线前写进去的半拉子
 *  （`ModSettings 重制版 1.0`）有键也不当译文，走模型重翻（dlname 组 4）。
 *  刻意不建缓存索引的模块级依赖：refresh/audit4 沙箱抽它时没注 nameNormIndex。 */
function nameCacheOf(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t || !cache) return null;
  let v;
  // ① 规范键 —— 主路径。所有写入口（applyTranslation / applyDownloadTranslation /
  //    healStaleDisplayNames）都按 canonicalName 存，查询必须用同一个算法，
  //    否则「写进去查不到」= 清空缓存重翻后界面停在英文（2026-10-26 端到端演练 25/30）。
  //    typeof 守卫：refresh/audit4 的老沙箱只抽了本函数，没注 canonicalName。
  if (typeof canonicalName === 'function') {
    const ck = canonicalName(t);
    if (ck && Object.prototype.hasOwnProperty.call(cache, ck)) v = cache[ck];
  }
  // ② 原串精确键（旧缓存兼容；沙箱没有 canonicalName 时这就是主路径）
  if (v === undefined && Object.prototype.hasOwnProperty.call(cache, t)) v = cache[t];
  // ③ 清洗键（去后缀 / 下划线换空格 / 折叠空白）
  if (v === undefined) {
    const clean = cleanKeyForm(t);
    if (clean && clean !== t && Object.prototype.hasOwnProperty.call(cache, clean)) v = cache[clean];
  }
  if (v === undefined) {
    // 归一化兜底：只差空白/零宽的键（10 秒 TTL 索引，勿退化成线性扫 ——
    // 下载收集对每条记录都调本函数，5195 条 × 几千键就是上亿次 normKey）。
    // typeof 守卫：refresh/audit4 的沙箱只抽了部分函数，没注 nameNormIndex；
    // 生产里它一定在（就在本函数上方声明）。
    if (typeof nameNormIndex === 'function') {
      const k2 = nameNormIndex().get(normKey(t));
      if (k2 !== undefined) v = cache[k2];
    }
  }
  if (typeof v !== 'string' || !v) return null;
  if (!cacheLooksDone(v)) return null;   // 单参自判：半拉子不当译文
  return v;
}

// ---------- F2：domCache 里的模组名条目必须清掉（D1 单一缓存源） ----------
// 名字的译文只在 cache.json；domCache 里出现模组名条目，说明旧版本/旧路径写过它，
// 留着就有两个写者抢同一个位置。启动时清一遍。
// 扩展名（<游戏名> Vortex Extension）不是模组名：状态层从不管它，译文只能来自 domCache，
// 一旦被当模组名删掉就永久英文（续14 实录：一次启动删掉 3 条）→ 豁免必须排在
// isName 判定**之前**，排在后面等于没跳过。
function pruneDomCacheNames() {
  let idx = null;
  try { idx = nameProbeIndex(contextRef.api.getState()); } catch (e) { return 0; }
  if (!idx || !idx.items.length) {
    // 状态树还没加载好（启动竞态，常态）：一条都不删，安排一次有界重试。
    // 没有这一轮就是「prune 空跑 → domCache 里的名字条目活到下次重启」，
    // 而它们正是双写者（D1）的源头。上限 6 次 × 5 秒，防死循环。
    if (domCachePruneTries < 6) {
      domCachePruneTries++;
      try {
        setTimeout(() => { try { pruneDomCacheNames(); } catch (e) {} }, 5000);
      } catch (e) {}
    }
    return 0;
  }
  domCachePruneTries = 0;   // 状态就绪：重置计数（之后每次调用都能再重试）
  let gone = 0;
  for (const k of Object.keys(domCache)) {
    if (k === '_ver') continue;
    const plain = plainForName(k);
    if (!plain) continue;
    // F2 豁免（必须排在 isName 之前）：`<游戏名> Vortex Extension` 这类扩展显示名。
    // 用户机上装了**同名**的扩展包 mod，签名表里有同一串 → isName 判真 →
    // prune 会把扩展名的译文当模组名删掉，而扩展名的译文只有 domCache 一个来源
    // （状态层从不管扩展显示名），删掉就是永久英文。
    // 0.16.3 续17：再加「剥尾形态」—— 下载行整串文件名剥出骨架后也可能是它。
    if (/\bvortex\s+extension$/i.test(plain)) continue;
    if (typeof domTranslator !== 'undefined' && domTranslator
      && typeof domTranslator.fileStemOf === 'function') {
      try {
        const stem = String(domTranslator.fileStemOf(plain) || '');
        if (stem && /\bvortex\s+extension$/i.test(stem)) continue;
      } catch (e) { /* 剥不出来 → 按原逻辑走 */ }
    }
    if (!idx.isName(plain)) continue;
    delete domCache[k];
    gone++;
  }
  if (gone > 0) {
    if (saveJson(DOM_CACHE_PATH, domCache, 'dom cache prune')) log('info', 'pruned mod names from dom cache', { n: gone });
  }
  return gone;
}

// ---------- F4：同族多版本的译文统一（骨架 + 本条版本号） ----------
// 一个模组分 1.7a / 1.8 / 1.9 多行时，各行的译文必须是同一骨架 + 各自版本号，
// 否则用户看到同一个模组三四种叫法。红线：**取不到版本尾巴就绝不覆盖** ——
// `CWSO 1.4.9 (Asi)` 这种以括号结尾的，旧代码拿同族骨架（1.4.5）整句盖回来，
// cache 里两条键值变得一字不差（「宁可不统一，绝不跨版本覆盖」）。
function versionTailOf(s) {
  const t = String(s == null ? '' : s).trim();
  const m = t.match(/(?:^|[\s_\-–—(（])(v?\d+(?:\.\d+)*[a-z]?)$/i);
  return m ? m[1] : '';
}

/** 族特征 token（版本号不算）：`Mod X 1.8` 与 `Mod X 1.9` 同族 */
function familyTokens(name) {
  const out = [];
  for (const w of String(name == null ? '' : name).replace(/_+/g, ' ').split(/[^A-Za-z0-9]+/)) {
    if (!w) continue;
    if (/^v?\d+(\.\d+)*[a-z]?$/i.test(w)) continue;
    out.push(w.toLowerCase());
  }
  return out;
}

function sameFamily(a, b) {
  const fa = familyTokens(a);
  const fb = familyTokens(b);
  if (!fa.length || fa.length !== fb.length) return false;
  for (let i = 0; i < fa.length; i++) if (fa[i] !== fb[i]) return false;
  return true;
}

/** 译文去皮：砍掉尾巴上的版本号（`模组技能槽页面重制版1.9` → `模组技能槽页面重制版`）。
 *  先剥「数字紧跟 版本」形态的冗余后缀（`灵敏移动1.7.1版本` → `灵敏移动1.7.1`，
 *  否则同族骨架分裂成三种、多数派统一失效 —— audit2 组 1 实录）；
 *  只认数字在前的形态，`显示历史版本` 这种正文咬不到。 */
function nameSkin(zh) {
  return String(zh == null ? '' : zh).trim()
    .replace(/(v?\d+(?:\.\d+)*[a-z]?)(?:版本|version)$/i, '$1')
    .replace(/v?\d+(?:\.\d+)*[a-z]?$/i, '')
    .trim();
}

/** 同族多版本译名统一（audit2 组 1 钉死四条）：
 *  ① 译文尾巴上冗余的「版本」后缀归零（原文没有 version 字样时）——
 *     `灵敏移动1.7.1版本` → `灵敏移动1.7.1`；只认「数字紧跟 版本」的形态，
 *     防 `显示历史版本` 这种把正文咬掉的情况；
 *  ② 同族缓存译文骨架唯一 → 拉回多数派（`响应式移动1.7.0` → `灵敏移动1.7.0`）；
 *  ③ 骨架冲突（≥2 种译法）→ 一个字都不动（不猜）；
 *  ④ 无同族 → 只做①。
 *  红线照旧：取不到版本尾巴就绝不覆盖（`CWSO 1.4.9 (Asi)` 以括号结尾，宁可不统一）。
 *  只能引用 cache/CJK/keepNameSet + 下面几个助手：audit2 组 1 的沙箱只注了这些。 */
function unifyFamilyName(raw, out) {
  const src = String(raw == null ? '' : raw).trim();
  const orig = String(out == null ? '' : out).trim();
  if (!src || !orig) return out;
  let zh = orig;
  const ver = versionTailOf(src);
  // 红线：取不到版本尾巴就绝不覆盖（CWSO 1.4.9 (Asi) 以括号结尾，宁可不统一）
  if (!ver) return out;
  // ① 「版本」后缀归零（原文自己没有 version 字样时，译文尾巴上那个是冗余的）
  if (!/version|版本/i.test(src)) {
    const m = zh.match(/(v?\d+(?:\.\d+)*[a-z]?)(?:版本|version)$/i);
    if (m) zh = zh.slice(0, m.index) + m[1];
  }
  // ② 同族骨架统一
  {
    const tok0 = (familyTokens(src)[0] || '').toLowerCase();
    const skins = [];
    const seenSkin = new Set();
    if (tok0) {
      for (const k of Object.keys(cache)) {
        // 廉价预筛：同族要求首 token 相同，先比前缀再走 sameFamily（免去每个键的数组分配）
        if (k.toLowerCase().indexOf(tok0) !== 0) continue;
        if (!sameFamily(src, k)) continue;
        // 骨架来源必须是完整译文：半拉子（'ModSettings 重制版 1.0'）的骨架会把
        // 好译文往沟里带（dlname 组 4 实录：统一后英文词又回到译文里）
        const val = String(cache[k] == null ? '' : cache[k]).trim();
        if (!val || !modNameOk(val)) continue;
        const sk = nameSkin(val);
        if (!sk || seenSkin.has(sk)) continue;
        seenSkin.add(sk);
        skins.push(sk);
      }
    }
    if (skins.length === 1) {
      const unified = skins[0] + ver;
      // 拼出来还得过验收：拼坏了就原样返回，绝不为了统一写出更差的结果
      if (unified !== zh && modNameOk(src, unified)) zh = unified;
    }
    // 骨架冲突（≥2 种）→ 不动（不猜）
  }
  return zh === orig ? out : zh;
}

/** 残留 ≥12 字符：重伤档（自愈时可以用更激进的手段） */
function badlyUnfinished(display) {
  const res = residueWords(display);
  let n = 0;
  for (const w of res) n += w.length;
  return n >= 12;
}
/** 自愈门槛（P1-c）：轻伤也要救，但轻伤只准词级补翻，绝不拿缓存里另一份译文整句覆盖
 *  （整句覆盖就是「剑星 Vortex 扩展包 → 星辰之刃漩涡扩展模组」事故的来源）。 */
function healWorthy(display) {
  const d = String(display == null ? '' : display).trim();
  if (!d || !CJK.test(d)) return false;
  const res = residueWords(d);
  if (!res.length) return false;
  let n = 0;
  for (const w of res) n += w.length;
  // 显示名本身已经是合格译文 → 不用救（单参自判；两参 (d,d) 会恒假，那是死代码）
  if (modNameOk(d)) return false;
  // 门槛 5 → 4（0.16.3 续 18）：residueWords 的最短词现在是 4 字符，
  // 而 modNameOk 早就在 `w.length >= 4` 上判不合格 —— 两边不同源会让
  // 「Oils」这类 4 字母残留处于「判不合格但永远不去救」的僵持态。
  return badlyUnfinished(d) || n >= 4;
}

/** DOM 层探针：这个显示名是不是「翻了一半」的（供日志/后续词级补翻）。
 *  口径与状态层同一份 residueWords，参数序 (raw, display) 与 gate2 组 3 一致，
 *  返布尔（测试契约：=== true / === false 严格比较）。
 *  残留检查排在 modNameOk 之前：`胸部丰满的胖 Ashley` 这种人名漏翻，
 *  modNameOk 两参判它「合格」（R3 只拦 ASCII 占比高的），但残留口径必须拒 ——
 *  「该翻没翻」与「翻得好不好」是两个问题，这里只问前者。 */
function unfinishedName(raw, display) {
  const d = String(display == null ? '' : display).trim();
  if (!d || !CJK.test(d)) return false;
  return residueWords(d).length > 0;
}

// ---------- 名字右键菜单的两个动作 ----------
// 「保留此英文」：名字进 userKeep.json（跨会话），状态层已翻的还原成英文原名。
// let 而不是 const：useDataDir 换数据目录时要跟着重算（升级不丢靠的就是它在数据目录）
let USER_KEEP_PATH = path.join(DATA_DIR, 'userKeep.json');
let userKeepLoaded = false;
let userKeepArr = [];
let keepEnSetRef = null;
function userKeepList() {
  if (!userKeepLoaded) {
    userKeepArr = (readJson(USER_KEEP_PATH, {}) || {}).names || [];
    userKeepLoaded = true;
  }
  return userKeepArr;
}
function keepNameEn(text) {
  let t = String(text == null ? '' : text).trim();
  if (!t) return { kept: false, restored: 0 };
  // 屏幕上点到的可能是中文译文：反查回英文原名再记（记中文没有意义）
  const nk0 = normKey(t);
  if (!Object.keys(cache).some((k) => normKey(k) === nk0)) {
    const back = Object.keys(cache).find((k) => normKey(String(cache[k])) === nk0);
    if (back) t = back;
  }
  const list = userKeepList();
  if (!list.includes(t)) list.push(t);
  saveJson(USER_KEEP_PATH, { ver: extVerOf(), at: Date.now(), names: list }, 'userKeep add');
  if (keepEnSetRef) keepEnSetRef.add(t);
  // 新保留的名字要立刻进 keepNameSet（residueWords 豁免）和品牌遮蔽术语（整名不翻）
  try {
    mergeRuntimeTerms(); // 重新算遮蔽表
  } catch (e) { log('warn', 'rebuild keep names fail', String(e)); }
  let restored = 0;
  try {
    const state = contextRef.api.getState();
    const modsRoot = (state.persistent || {}).mods || {};
    for (const gameId of Object.keys(modsRoot)) {
      const mods = modsRoot[gameId] || {};
      for (const modId of Object.keys(mods)) {
        const mod = mods[modId];
        if (!mod) continue;
        if (normKey(rawNameOf(mod)) !== normKey(t)) continue;
        const a = mod.attributes || {};
        if (a.originalName) { dispatch('customFileName', gameId, modId, a.originalName); restored++; }
      }
    }
  } catch (e) { log('error', 'keepName restore', String(e)); }
  // 删除走统一算法 dropTranslation（cacheKeyOf）：normKey 比对对不上规范键 ——
  // 右键传进来的是下载行显示串 VAXIS_Blood_Physics_v1.5.zip，缓存键是规范键（审计 ①）
  dropTranslation(t);
  saveJson(CACHE_PATH, cache, 'keepName cache drop');
  log('info', 'name kept as english', { name: t.slice(0, 60), restored });
  return { kept: true, restored };
}

/** 「取消保留英文」：把名字从 userKeep.json 里摘掉，让它可以重新被翻译。
 *  0.16.5 之前只有加没有减 —— 右键误点一下，那个模组名就永久保持英文，
 *  除了手改 %APPDATA%\Vortex\vortex-modname-zh\userKeep.json 没有任何出口。
 *  只摘名单、不动缓存：能不能翻出来交给随后的重翻流程（模型没开时不会假装成功）。 */
function unkeepName(text) {
  let t = String(text == null ? '' : text).trim();
  if (!t) return { removed: 0, note: 'empty' };
  // 屏幕上点到的可能是中文译文：userKeep 里存的是英文原名，反查回去再比
  const nk0 = normKey(t);
  if (!Object.keys(cache).some((k) => normKey(k) === nk0)) {
    const back = Object.keys(cache).find((k) => normKey(String(cache[k])) === nk0);
    if (back) t = back;
  }
  const nk = normKey(t);
  const list = userKeepList();
  const at = list.findIndex((x) => normKey(String(x)) === nk);
  if (at < 0) return { removed: 0, note: 'not-kept' };
  const gone = list[at];
  list.splice(at, 1);
  saveJson(USER_KEEP_PATH, { ver: extVerOf(), at: Date.now(), names: list }, 'userKeep remove');
  // 名单变了，遮蔽表必须立刻重算：不重算的话本轮它仍被当成「整名不翻」，
  // 重翻会原样退回英文，用户看到的就是「取消了还是英文」。
  try { mergeRuntimeTerms(); } catch (e) { log('warn', 'rebuild keep names fail', String(e)); }
  if (keepEnSetRef) {
    for (const x of Array.from(keepEnSetRef)) if (normKey(String(x)) === nk) keepEnSetRef.delete(x);
  }
  log('info', 'name unkept', { name: String(gone).slice(0, 60), left: list.length });
  return { removed: 1, name: t, left: list.length };
}

/** 清空用户保留词表（设置页按钮）。词库 gamenames-keep.json 不动 —— 那是出厂的，
 *  用户清的是自己右键加的那份。返回清掉的条数。 */
function clearUserKeep() {
  const list = userKeepList();
  const n = list.length;
  if (n > 0) {
    list.length = 0;
    saveJson(USER_KEEP_PATH, { ver: extVerOf(), at: Date.now(), names: [] }, 'userKeep clear');
  }
  try { mergeRuntimeTerms(); } catch (e) { log('warn', 'rebuild keep names fail', String(e)); }
  // 只重建、不 clear()：keepEnSetRef 里混着出厂词库 gameKeep，
  // 整表清空会把 gamenames-keep.json 的保留词一起抹掉 —— DOM 层随后就会把
  // UE4SS 这类工具名翻成中文（正是 0.16.3 反复投诉的那种坏译文）。
  if (keepEnSetRef) {
    keepEnSetRef = new Set(
      [].concat(gameKeep || [], userKeepList()).filter((x) => typeof x === 'string' && x.trim())
    );
  }
  log('info', 'user keep cleared', { n });
  return n;
}
// 「重新翻译此名」：只清这一条的缓存（模组名缓存 + domCache 里含它的键 + 失败名单），只重翻这一条
function retranslateName(text) {
  let t = String(text == null ? '' : text).trim();
  if (!t) return { queued: 0 };
  // 屏幕上的可能是中文译文：反查回英文原名（否则清缓存/重翻都对不上号）
  const nk0 = normKey(t);
  if (!Object.keys(cache).some((k) => normKey(k) === nk0)) {
    const back = Object.keys(cache).find((k) => normKey(String(cache[k])) === nk0);
    if (back) t = back;
  }
  const nk = normKey(t);
  // 缓存删除走统一算法 dropTranslation（审计 ①）；domCache/failCache 的键既可能是
  // 显示串也可能是规范串，两种针都扫（只扫显示串 t 会漏规范键形态的条目）。
  dropTranslation(t);
  saveJson(CACHE_PATH, cache, 'keepName cache drop');
  const ckt = cacheKeyOf(t);
  for (const nd of (ckt && ckt !== t ? [t, ckt] : [t])) {
    Object.keys(domCache).forEach((k) => { if (k.indexOf(nd) !== -1) delete domCache[k]; });
    Object.keys(failCache).forEach((k) => { if (k.indexOf(nd) !== -1) delete failCache[k]; });
  }
  saveJson(DOM_CACHE_PATH, domCache, 'keepName domCache drop');
  saveJson(FAIL_PATH, failCache, 'keepName failCache drop');
  // 重翻必须**排队**：批量批次正在跑时 translate() 会立刻早退（只有一条「正在翻译中」
  // 提示、连日志都不写），用户看到的就是「取消保留英文点了没反应」
  // —— 2026-10-29 真机实录：unkeep 在 21:48:31、自动批次 21:48:31.578 才 done，正好撞死。
  const fire = (tries) => {
    try {
      if (running) {
        if (tries <= 0) { log('warn', 'retranslate busy give up', { name: nk.slice(0, 40) }); return; }
        setTimeout(() => fire(tries - 1), 1500);
        return;
      }
      const st = contextRef.api.getState();
      const items = collectTargets(st, null).concat(collectDownloadTargets(st))
        .filter((it) => normKey(it.raw) === nk);
      if (!items.length) {
        log('info', 'retranslate nothing to do', { name: nk.slice(0, 40) });
        return;
      }
      Promise.resolve(translate(items, { manual: true })).catch((e) => log('warn', 'retranslate fail', String(e)));
    } catch (e) { log('warn', 'retranslate retry fail', String(e)); }
  };
  fire(20);   // 最多等 30 秒（20 × 1.5s），批量批次跑完就接上
  return { queued: 1 };
}
// 右键菜单接管判据：命中的是「已知模组名」才接管，普通界面文本照常弹 Vortex 原生菜单
function isKnownName(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || t.length < 3 || t.length > 160) return false;
  const nk = normKey(t);
  for (const k of Object.keys(cache)) {
    if (normKey(k) === nk) return true;
    if (normKey(String(cache[k])) === nk) return true; // 屏幕上是中文译文时也接管
  }
  try {
    const state = contextRef.api.getState();
    const all = collectTargets(state, null).concat(collectDownloadTargets(state));
    for (const it of all) if (normKey(it.raw) === nk) return true;
  } catch (e) {}
  return false;
}

/** 字典一律用 null 原型。普通对象的 `cache['toString']` 会拿到 Object.prototype.toString，
 *  于是「这段文本已翻译」被判成真、`lex['valueOf']` 甚至会把一个函数写进页面。 */
function asDict(o) {
  const d = Object.create(null);
  if (o && typeof o === 'object') for (const k of Object.keys(o)) d[k] = o[k];
  return d;
}

/** 真实条目数（排除 `_ver` / `_st` / `_gl` 这类元信息键）。
 *  0.16.5 起 cache.json 也带 `_ver`，裸 `Object.keys(cache).length` 会恒 +1：
 *  统计面板永远多一条，更糟的是「cache 有内容才做某事」这类判断会恒真。
 *  与 domCache / failCache 早就在用的 `filter(k => k !== '_ver')` 同一口径。 */
function cacheEntryCount(dict) {
  let n = 0;
  for (const k of Object.keys(dict || {})) {
    if (k && k.charAt(0) !== '_') n++;
  }
  return n;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

/** 同步睡 ms 毫秒。Windows 上 rename 抛 EPERM/EBUSY 多半是瞬时的（杀软扫描完就放手），
 *  睡一下再试一次比直接降级安全（降级写会失去 rename 的原子性）。
 *  Atomics.wait 是 Node 里唯一不阻塞事件循环之外的同步 sleep；不支持就算了。 */
function sleepBlocking(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (e) { /* 环境不支持就跳过重试间隔，直接进下一次尝试 */ }
}

/** 落盘唯一入口。返回 true = 数据确实写到了磁盘。
 *
 *  ★ 失败**不能静默**（2026-10-26 审查反馈 #4）：以前 rename 抛异常只 `log` 一句就吞，
 *  用户攒的译文会悄悄消失，界面上看不出任何异常。Windows 上 rename 会被杀软 /
 *  同步工具（OneDrive、坚果云）短暂持有目标句柄 → EPERM/EBUSY/EACCES，属于**常见**路径
 *  而不是异常路径。现在：① 睡 30ms 重试一次；② 仍失败则回退直接覆写目标文件
 *  （丢原子性，但「可能半截」远好过「整份没写」，且 .tmp 保留完整副本可救）；
 *  ③ 两条路都失败才记 error 并返回 false，让调用方能看见。 */
function writeJson(file, data) {
  // 写 .tmp 再 rename：writeFileSync 是「先截断再写」，翻译过程中 domCache.json 每 1.2 秒
  // 被整体重写一次，此刻崩溃/断电就留下半截 JSON，下次读回落 {} → 用户攒的译文全丢。
  const tmp = file + '.tmp';
  const shortName = String(file).replace(/^.*[\\/]/, '');
  let body;
  try {
    body = JSON.stringify(data, null, 2);
  } catch (e) {
    log('error', 'write fail: stringify', { file: shortName, err: String(e).slice(0, 120) });
    return false;
  }
  try {
    fs.writeFileSync(tmp, body, 'utf8');
  } catch (e) {
    // 磁盘满 / 无权限 / 目录被删 —— 数据确实没落盘，必须留 error
    log('error', 'write fail: tmp', { file: shortName, code: (e && e.code) || '', err: String(e).slice(0, 120) });
    return false;
  }
  for (let i = 0; i < 2; i++) {
    try {
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      const code = (e && e.code) || '';
      if (i === 0) {
        log('warn', 'rename busy, retry once', { file: shortName, code });
        sleepBlocking(30);
        continue;
      }
      log('warn', 'rename fail, fallback to direct write', { file: shortName, code });
    }
  }
  // 回退：直接覆写。目标文件可能被杀软短暂锁着，所以这一路也可能失败。
  try {
    fs.writeFileSync(file, body, 'utf8');
    try { fs.unlinkSync(tmp); } catch (e2) { /* tmp 留着无害，下次覆盖 */ }
    return true;
  } catch (e) {
    log('error', 'write fail: fallback', { file: shortName, code: (e && e.code) || '', err: String(e).slice(0, 120) });
    return false;
  }
}

// ── 备份治理（审计 N2）已拆除（2026-10-26 用户拍板）──────────────────
// 缓存是**派生数据**：设置页就有「清空全部翻译缓存(强制重翻)」，丢了大不了重翻一遍。
// 备份它救不回任何不可再生的东西；而唯一一次实证（2 字节空壳备份）恰恰被
// 「<64 字节不备」这条规则挡在外面 —— 它救不到自己要防的那个场景。
// 真正不可再生的是用户手点的「保留英文」词表（userKeep.json），备份从没覆盖它。
// 留痕能力没丢：写盘失败有 saveJson 记 not persisted，缓存被清有
// cleaned / reset for new version / purged 三类日志。**不要再加回来。**

/** writeJson 的「必留痕」包装。
 *
 * writeJson 自己失败时会 log('error')，但它返回 bool，而 13 处调用点写的是
 * `try { writeJson(...) } catch (e) {}` —— 于是紧跟其后的 log('info', '... purged', {n})
 * 照样宣布成功。日志里「真写进去了」和「没写进去」长得一模一样，用户攒的译文
 * 丢得无声无息（审计 N4）。这里统一补一条 warn，让没落盘这件事在日志里看得见。
 */
function saveJson(file, data, what) {
  let ok = false;
  try {
    ok = writeJson(file, data);
  } catch (e) {
    // writeJson 内部已尽力兜住，能抛到这里说明是它自己都没预料到的错
    log('error', 'save threw', { what, err: String(e).slice(0, 120) });
    return false;
  }
  if (!ok) log('warn', 'not persisted', { what, file: String(file).replace(/^.*[\\/]/, '') });
  return ok;
}

// 配置写盘防抖（0.16.5）：设置页输入框每敲一个字符都会调 save()，以前每个字符写一次
// config.json。这里**只延迟「写文件」这一步**，内存里的 cfg 仍然立即更新 ——
// 若连内存一起延迟，填完地址马上点「立即翻译」时翻译层读到的还是旧配置，会拿旧地址去连。
// ⚠ 凡是「要按配置去连模型」或「要重新读盘」的地方，先调 flushCfgWrite()，
//   否则读到的是延迟前的旧文件（翻译入口、设置页 init 三处）。
const CFG_WRITE_DELAY = 400;
let cfgWriteTimer = null;

function scheduleCfgWrite() {
  if (cfgWriteTimer) clearTimeout(cfgWriteTimer);
  cfgWriteTimer = setTimeout(() => {
    cfgWriteTimer = null;
    saveJson(CONFIG_PATH, cfg, 'settings save');
  }, CFG_WRITE_DELAY);
}

/** 有没落盘的配置就立刻写掉。返回是否真的写了。 */
function flushCfgWrite() {
  if (!cfgWriteTimer) return false;
  clearTimeout(cfgWriteTimer);
  cfgWriteTimer = null;
  return saveJson(CONFIG_PATH, cfg, 'settings save flush');
}

// Vortex 禁止扩展在 init 阶段使用 context.api（报 "extension uses api in init function"）。
// 语言包重建正好发生在 init 里，所以「界面语言包已更新，重启后生效」这条通知
// 以前 100% 发不出去（日志里 6 次启动全是 locale pack built → notify fail）。
// 现在遇到这个错就先存着，等 api 可用（首个 tick / 设置页打开）再发。
let pendingNotice = null;
function notify(payload) {
  try { contextRef.api.sendNotification(payload); }
  catch (e) {
    const msg = String(e);
    if (/uses api in init/i.test(msg)) { pendingNotice = payload; log('info', 'notify deferred (init phase)'); return; }
    log('warn', 'notify fail', msg);
  }
}
function flushPendingNotice() {
  if (!pendingNotice) return;
  const p = pendingNotice;
  pendingNotice = null;
  try { contextRef.api.sendNotification(p); log('info', 'deferred notify sent'); }
  catch (e) { pendingNotice = p; log('warn', 'deferred notify fail', String(e)); }
}

// ─── 通知三档（0.16.5，规则从 renderer.js 里读出来的，不是猜的）──────────────
// ① canBeToast：displayMS<=5000 且 type 不是 warning/activity 且无 actions → 底部 toast，
//    直接 return，根本不进通知列表；
// ② 否则 dispatch(addNotification)：只要带 displayMS，到点 dispatch(dismissNotification) 删掉这条；
// ③ 铃铛面板：有 displayMS 就用它，没给才按类型兜底（warning/error 10s、success/info 5s）；
//    带 actions 或 activity 的 dispTime = null，面板自己不按时间过滤。
//    ⚠ 但「面板不过滤」≠「永久」：store 层只要 id 与 displayMS 同时存在就挂删除定时器，
//    根本不看 actions。所以永久卡片必须是「有 actions + 不给 displayMS」。见 notifySticky。
// 由此三档（用户要求：一律从铃铛弹，底部不闪）：过程类 6 秒／结果类 10 秒／异常类挂「知道了」永久留。
// 关键：displayMS 必须 >5000，否则会被 canBeToast 抢去走底部 toast——底部只有 5 秒上限，也根本看不住。
const ACK_ACTIONS = [{ title: '知道了', action: (dismiss) => { try { dismiss(); } catch (e) { /* 点掉失败无所谓 */ } } }];
// 异常类通知：永久留在铃铛，直到用户点「知道了」。
// 必须主动剥掉 displayMS——addNotification 的删除定时器条件是
// 「id 与 displayMS 都存在」，它不看 actions，到点照样 dismiss 掉。
// actions 只让铃铛面板跳过「按类型兜底时长」，拦不住 store 层这个定时删除。
// （0.16.5 早期版本就是两侧都给了，所以异常卡片 6 秒后自己没了，用户实测「根本没变永久」。）
function notifySticky(payload) {
  const p = Object.assign({}, payload, { actions: ACK_ACTIONS });
  delete p.displayMS;
  return notify(p);
}
/** 结果类停留时长：手动点出来的 10 秒；自动批次 6 秒。两者都 >5000，都走铃铛。 */
function resultMS(manual) { return manual ? 10000 : 6000; }

// 异常卡片是「永久」的，所以必须有人负责撤：否则问题修好后，那张红卡还挂在铃铛里，
// 让用户去点一个已经不存在的故障。策略只有一条——后面成功了就把前面的撤掉。
const ANOMALY_IDS = ['modname-zh-gate', 'modname-zh-allfail', 'modname-zh-partial', 'modname-zh-crash'];
/** @param ids 不给就撤全部异常卡片；探活通过时只撤闸门那条 */
function clearAnomaly(ids) {
  const api = contextRef && contextRef.api;
  if (!api || typeof api.dismissNotification !== 'function') return;
  for (const id of (ids || ANOMALY_IDS)) {
    try { api.dismissNotification(id); } catch (e) { log('warn', 'clear anomaly fail', id + ' ' + String(e)); }
  }
}
/** 异常卡片互斥：同一时刻只留最近的一条。否则「先全失败、后来部分成功」，那张「全部失败」还挂着。 */
function notifyAnomaly(payload) {
  clearAnomaly(['modname-zh-allfail', 'modname-zh-partial', 'modname-zh-crash']);
  return notifySticky(payload);
}

// ─── 翻译前置闸门（0.16.5）─────────────────────────────────────────────────
// 以前没有任何预检：几十条全烧完，结尾才甩一句「多数原因是模型接口没开或地址不对」。
// 「没填地址 / 密钥错 / 模型名错 / 服务没启动」四种原因被塞进同一句话，用户只能自己猜。
// 现在发请求前先探一次 GET {base}/models，按类型分开报；确定的那几类直接拦住，
// 一批请求都不发。探活只管「地址通不通、密钥认不认、模型名在不在列表里」——
// 不代替真正的翻译验证，那一步仍然是设置页的「测试连接」。
let preflightCache = { at: 0, res: null };  // 60 秒内复用「连通」结论：autoHook 每次状态变更都会踢一次
let lastPreflight = null;                   // 最近一次结论，失败提示引用同一份，不另编一套说法
const preGateNotified = {};                 // code → 已提示过（自动路径不重复刷屏）

function preHost(base) {
  try { return new URL(base).host || String(base || ''); } catch (e) { return String(base || ''); }
}

/** 一次轻量探活。@param force 跳过缓存（用户主动点按钮时用，要看到当下的真结果） */
async function modelPreflight(force) {
  const p = (cfg && cfg.provider) || {};
  const base = String(p.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, code: 'noprovider', blocking: true };
  const model = String(p.model || '').trim();
  // 有地址没模型名：请求照样发不出去，而且这种错不必再打一次网络
  if (!model) return { ok: false, code: 'nomodel', blocking: true, base };
  const now = Date.now();
  if (!force && preflightCache.res) {
    const ttl = preflightCache.res.ok ? 60000 : 10000;
    if (now - preflightCache.at < ttl) return preflightCache.res;
  }
  let res;
  try { res = await probeOnce(base, model, p.apiKey || ''); }
  catch (e) { res = { ok: false, code: 'neterr', blocking: true, base, model, detail: String(e).slice(0, 120) }; }
  preflightCache = { at: now, res };
  return res;
}

async function probeOnce(base, model, key) {
  let r;
  try {
    // 8 秒是给「地址通但服务卡住」留的余量：正常 /models 是毫秒级（本机实测 7ms），
    // 云端再慢也不该超过这个数；真超了就是地址指错或服务假死，值得报出来。
    r = await core.httpRequest(base + '/models', 'GET', key ? { Authorization: 'Bearer ' + key } : {}, null, 8000);
  } catch (e) {
    const code = String((e && e.code) || '');
    const msg = String((e && e.message) || e);
    if (/timeout/i.test(msg)) return { ok: false, code: 'timeout', blocking: true, base, model };
    if (code === 'ECONNREFUSED') return { ok: false, code: 'refused', blocking: true, base, model };
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { ok: false, code: 'dns', blocking: true, base, model };
    return { ok: false, code: 'neterr', blocking: true, base, model, detail: msg.slice(0, 120) };
  }
  if (r.status === 401 || r.status === 403) return { ok: false, code: 'auth', blocking: true, base, model, status: r.status };
  if (r.status >= 400) {
    // /models 不是所有 OpenAI 兼容端点都实现（404/405 很常见），5xx 是服务端自己的事。
    // 这两类不能拦：拦了就是「端点不提供模型列表」的用户永远翻不了。
    return { ok: true, code: 'http', base, model, status: r.status };
  }
  let ids = null;
  try {
    const j = JSON.parse(r.body);
    ids = Array.isArray(j && j.data) ? j.data.map((x) => String((x && x.id) || '')) : null;
  } catch (e) { ids = null; }
  if (!ids) return { ok: true, code: 'badjson', base, model, status: r.status };
  if (ids.length > 0 && ids.indexOf(model) === -1) return { ok: true, code: 'modelmissing', base, model, ids };
  return { ok: true, code: 'ok', base, model, ids };
}

/** 预检结论 → 短话（通知）+ 长话（弹窗）。两种文案同源，不许各写一份。 */
function describePreflight(res) {
  const base = res.base || '';
  const host = preHost(base);
  const s = (title, short, text, kind) => ({ blocking: true, kind: kind || 'error', title, short, text });
  switch (res.code) {
    case 'noprovider':
      return {
        blocking: true, kind: 'info', title: '还没填翻译接口',
        short: '没填接口地址，请求发不出去',
        // 正文走弹窗的 text 字段（纯文本，\n 换行）—— 不是 bbcode。
        // 以前这里写 HTML 的 <br/>：bbcode 字段会不会把标签渲染成换行，取决于宿主版本，
        // 万一不认就是一屏字面 "<br/>"，用户看不懂还以为是扩展坏了。
        text: '界面汉化不需要模型，已经生效；模组名、合集名、更新日志要调用一个翻译模型才能翻。'
          + '\n\n怎么修：设置 → 模组名汉化 → 翻译接口，填「接口地址」和「模型名」，再点「测试连接」。'
          + '\n本地 LM Studio 一般是 http://127.0.0.1:1234/v1'
          + '\n本地 Ollama 一般是 http://127.0.0.1:11434/v1'
          + '\n云端填服务商给的 …/v1 地址，密钥填进 API Key'
          + '\n\n只想让界面是中文、不打算翻模组名？忽略这条就行 —— 界面汉化不用模型，已经生效。',
      };
    case 'nomodel':
      return s('还差一个模型名', '填了接口地址，但模型名是空的',
        '接口地址已填：' + base + '\n但「模型名」空着，请求发不出去。'
        + '\n\n怎么修：同一页填「模型名」。本地常见 hy-mt2-7b、qwen2.5-7b-instruct；云端照服务商文档填。'
        + '\n不知道填什么，先点「测试连接」，接口支持的话它会把能用的模型名列出来。', 'info');
    case 'refused':
      return s('连不上模型服务', '连不上 ' + host,
        '地址 ' + base + ' 直接拒绝了连接 —— 服务没启动，或者端口不对。'
        + '\n\n本地模型：LM Studio 要开 Developer → Start Server；Ollama 要让 ollama serve 跑着。'
        + '\n云端：确认地址末尾是 /v1，斜杠别多也别少。改完点「测试连接」。');
    case 'timeout':
      return s('模型服务没有响应', host + ' 8 秒内没响应',
        '地址 ' + base + ' 8 秒内没有响应。'
        + '\n\n本地大模型刚启动时第一轮加载要几十秒，等它加载完再点「测试连接」；'
        + '\n一直不通就是端口或地址不对（也可能走了不通的代理）。');
    case 'dns':
      return s('地址解析不了', '解析不了 ' + host,
        '域名 ' + host + ' 解析不了。'
        + '\n\n检查地址有没有拼错、有没有多出来的空格；云端接口在断网或代理没开时也会这样。');
    case 'auth':
      return s('密钥被拒绝（HTTP ' + res.status + '）', '密钥被拒绝（HTTP ' + res.status + '）',
        '接口 ' + host + ' 拒绝了这次请求的密钥。'
        + '\n\n本地模型不需要密钥 —— 误填了就把 API Key 清空。'
        + '\n云端核对三件事：密钥是否复制完整、是否过期、额度是否用完。');
    case 'neterr':
      return s('请求发不出去', '网络错误' + (res.detail ? '：' + res.detail : ''),
        '连 ' + host + ' 时出错' + (res.detail ? '：' + res.detail : '') + '。'
        + '\n\n检查本机代理、防火墙，以及地址里的端口。');
    default:
      return null;
  }
}

/** 放行但有疑点（端点不给模型列表 / 模型名不在列表里）：只在真失败时补一句，不单独弹。 */
function preflightHint() {
  const r = lastPreflight;
  if (!r || r.ok === false) return '';
  if (r.code === 'http') return '；另外接口返回 HTTP ' + r.status + '，地址可能少了 /v1';
  if (r.code === 'badjson') return '；另外接口没返回模型列表，地址可能少了 /v1';
  if (r.code === 'modelmissing') {
    const ids = r.ids || [];
    const s = ids.slice(0, 3).join(' / ');
    return '；另外模型名 ' + r.model + ' 不在接口列表里' + (s ? '（现有：' + s + (ids.length > 3 ? ' …' : '') + '）' : '');
  }
  return '';
}

/** 通知正文里能塞下的疑点：一句话，不超过 12 字；塞不下就不说。
 *  通知区域只够一两行，详情留给弹窗、「测试连接」和 translator.log。 */
function hintShort() {
  const r = lastPreflight;
  if (!r || r.ok === false) return '';
  if (r.code === 'modelmissing') return '，模型名不在接口列表';
  if (r.code === 'http' || r.code === 'badjson') return '，地址可能少了 /v1';
  return '';
}

function showModelDialog(kind, title, text) {
  try {
    const api = contextRef.api;
    if (api && typeof api.showDialog === 'function') {
      // 用 text 不用 bbcode：bbcode 要按 BBCode 语法解析，标签写法随宿主版本变；
      // text 是纯文本、保留 \n 换行，正文里写的换行一定会正确显示。
      const content = { text: String(text == null ? '' : text), options: { wrap: true } };
      Promise.resolve(api.showDialog(kind, title, content, [{ label: '知道了' }]))
        .catch((e) => log('warn', 'model dialog fail', String(e)));
      return true;
    }
  } catch (e) { log('warn', 'model dialog fail', String(e)); }
  return false;
}

/**
 * 升级后首次自动重建时，模型没连上 → 弹一次窗（每个版本只弹一次）。
 * 为什么不能只发系统通知：通知几秒就消失，用户装完新版第一眼看到「界面还是旧的模组名」，
 * 只会以为汉化坏了，根本不知道是模型没开。这个弹窗就是「更新完第一次」的那次交代。
 * 落盘 gate-shown.json 记版本，同版本不再弹；下个版本升级重新弹。
 * 返回 true = 弹窗已出（调用方别再叠通知，两条通道只走一条）。
 */
function showGateDialogOnce(d, code) {
  const ver = extVerOf();
  const shown = readJson(GATE_SHOWN_PATH, null);
  if (ver && shown && shown.ver === ver) return false;   // 本版已交代过
  const ok = showModelDialog(d.kind, d.title, d.text);
  if (ok) {
    try { saveJson(GATE_SHOWN_PATH, { ver, code, at: Date.now() }, 'gate dialog shown'); }
    catch (e) { log('warn', 'gate shown mark fail', String(e)); }
  }
  return ok;
}

/** 翻译类动作的统一闸门。true = 放行。
 *  manual：用户主动点的（按钮 / 右键 / 菜单）→ 弹窗说清，弹不出来才退回通知；
 *  opts.dialogOnce：升级后首次自动重建 → 弹窗，但每个版本只弹一次（见 showGateDialogOnce）；
 *  其它自动触发（安装钩子 / 状态变更）→ 只发一次通知、不弹窗，否则每次状态变更都糊一脸。
 *  预检自己出错一律放行：宁可让真正的翻译流程去报错，也不能卡在探活上。 */
async function gateModel(manual, action, opts) {
  let res;
  try { res = await modelPreflight(!!manual); }
  catch (e) { log('warn', 'preflight crash', String(e)); return true; }
  lastPreflight = res;
  log('info', 'model preflight', { code: res.code, ok: res.ok, manual: !!manual });
  if (res.ok) { clearAnomaly(['modname-zh-gate']); return true; }
  const d = describePreflight(res);
  if (!d) return true;
  if (manual) {
    // 用户是点完按钮才看到这个弹窗的：正文末尾补一句因果，否则他只看懂「配置有问题」，
    // 不知道刚才那一下到底跑没跑。
    const body = d.text + '\n\n（这一次没有开始翻译，按上面的步骤改好再点一次就行。）';
    if (!showModelDialog(d.kind, d.title, body)) {
      notifySticky({ id: 'modname-zh-gate', type: d.kind === 'info' ? 'warning' : 'error', title: d.title, message: '这次' + (action || '翻译') + '没有开始', noDismiss: true });
    }
  } else if (opts && opts.dialogOnce) {
    // 弹窗成功就不再发通知；本版本已经弹过则完全静默（上次已经交代过，不必每次启动刷）
    showGateDialogOnce(d, res.code);
  } else if (!preGateNotified[res.code]) {
    preGateNotified[res.code] = 1;
    notifySticky({ id: 'modname-zh-gate', type: d.kind === 'info' ? 'warning' : 'error', title: d.title, message: '这次' + (action || '翻译') + '没有开始' });
  }
  return false;
}

function dispatch(key, gameId, modId, value) {
  try {
    contextRef.api.store.dispatch(va.actions.setModAttribute(gameId, modId, key, value));
    return true;
  } catch (e) {
    log('error', 'setModAttribute fail', String(e));
    return false;
  }
}

/** 游戏名 → 术语列表（去重）。这张表不写盘，只用来在送翻时按需注入提示词。 */
function toTermList(gameMap) {
  const out = [];
  const seen = new Set();
  for (const k of Object.keys(gameMap || {})) {
    const zh = gameMap[k];
    if (typeof zh !== 'string' || !zh || typeof k !== 'string' || !k.trim()) continue;
    const key = k.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ en: k.trim(), zh });
  }
  return out;
}

/** 配置被从文件重载或保存后，把运行时术语并回去。
 *  cfg.terms 一旦掉回文件里的那 16 条，746 条游戏名对照就从提示词和术语遮蔽里消失，
 *  TW3 这类缩写会静默退回模型猜（译名质量下降且无任何提示）。
 *  0.16.3 续 12：保英文名单重建 + 品牌头登记 + 品牌遮蔽术语全部收敛到 rebuildKeepNames
 *  （沙箱测试只抽函数体，那边 rebuildKeepNames 是空实现 —— 调用必须走这个名字）。 */
function mergeRuntimeTerms() {
  // 术语口径（0.16.3 续 11）：gameTerms 与 terms 是两个键 —— terms 掉回文件里
  // 那 16 条时，746 条游戏名对照不能从提示词和术语遮蔽里消失。
  cfg.gameTerms = runtimeTerms;
  rebuildKeepNames();
}

function rawNameOf(mod) {
  const a = (mod && mod.attributes) || {};
  return a.originalName || a.customFileName || a.modName || a.name || a.logicalFileName || a.fileName || (mod && mod.id) || '';
}

function needsTranslate(text) {
  return !!text && LATIN.test(text) && !CJK.test(text);
}

function collectTargets(state, gameIdFilter) {
  const modsRoot = (state.persistent && state.persistent.mods) || {};
  const out = [];
  for (const gameId of Object.keys(modsRoot)) {
    if (gameIdFilter && gameId !== gameIdFilter) continue;
    const mods = modsRoot[gameId] || {};
    for (const modId of Object.keys(mods)) {
      const mod = mods[modId];
      if (!mod) continue;
      if (mod.type === 'collection' && !(cfg && cfg.includeCollections)) continue;
      // 不能直接用 rawNameOf 的输出：它优先返回 originalName，而那是 Vortex 安装时
      // 写进去的**整串键**（`Clean Water 13392 1 2026-10-03T17-14Z GpMW8t9md`）。
      // 原样送翻，模型会把 fileId / 更新日期 / 随机 id 一起翻进中文，脏串再以 cache
      // 键的形式留下来盖掉干净键（2026-10-26 真机 12 条：`清洁水源模组 13392 1 …`）。
      // 净化只在 englishBaseNameOf 里做过 —— 批量翻译（主流程）必须走同一条路，
      // 否则改了等于没改。typeof 守卫：测试沙箱只抽单个函数体，没注这个就退回原值。
      const bases = typeof englishBaseNameOf === 'function' ? englishBaseNameOf(mod, modId) : [];
      const raw = bases[0] || rawNameOf(mod);
      // 真机长键（Fluffy Mod Manager 818 …）路过时把品牌头登记进白名单，
      // 否则 residueWords 会把 Fluffy 当残留 → 验收不过 → 补翻成「蓬松」。
      // typeof 守卫：测试沙箱（dlname BLOCK_A）没抽品牌那簇函数，production 里一定有。
      if (typeof registerKeptBrands === 'function') registerKeptBrands(raw);
      if (!needsTranslate(raw)) continue;
      // F3：整条没有一个可翻的英文词（REFramework / UE4SS / SkyUI）→ 不进队列。
      // 送模型必然照抄或吐空 → 验收不过 → 记一次假失败，还触发误导提示。
      if (nothingToTranslate(raw)) continue;
      // 整名在保英文名单里（右键「这个名字保留英文」）→ 不送模型。
      // 以前只在 keepNameEn 里 dispatch 回原名，批量路径照旧把它送翻：模型遵守
      // 品牌遮蔽原样退回，applyTranslation 又当成功 —— 白烧一次还报「1 条成功」。
      if (typeof isKnownBrand === 'function' && isKnownBrand(raw)) continue;
      // 翻不动就退让：被验收拒满 NAME_FAIL_MAX 次的不再自动重来。
      // 少了这一句，翻不过的条目每次收集都重新进队列 → 翻 → 被拒 → 下次再来，
      // 用户看到的就是「怎么点都翻不了、一直提示未通过验收」（2026-10-26 真机）。
      // typeof 守卫：沙箱只抽本函数，没注这两个。
      if (typeof isGivenUp === 'function') {
        const gk = typeof cacheKeyOf === 'function' ? cacheKeyOf(raw) : raw;
        if (gk && isGivenUp(gk)) continue;
      }
      out.push({ gameId, modId, raw, cached: nameCacheOf(raw) });
    }
  }
  return out;
}

/** 单条下载记录 → 待翻目标。判据字段是 nexus.fileInfo.name（屏幕上那串），
 *  不是 modInfo.name（状态层写了界面也不显示 —— 续 15 LevelDB 实证）。
 *  返回 null = 不需要翻。借译文规则（D2）：已安装条目只有在「版本尾巴对得上」时
 *  才借它的缓存译文，1.3 的行绝不拿 1.5 的译名。 */
/** 下载行的名字：**只读 modInfo.name**，绝不拿 nexus.fileInfo.name 当判据。
 *
 *  ★ 2026-10-26 第二次踩这个坑（PITFALLS P-NAME-03）：上一版为了「对齐界面字段」
 *  改成 fileInfo.name 优先，结果 raw 变成英文、状态层却被写成中文，
 *  Vortex 的 processAttributes 拿中文当 fileName 做 fuzzRatio → 写出
 *  `customFileName = "英文原名 - 中文译文"` 拼装名，整个模组列表炸开。
 *
 *  定论（0.16.2 就是对的）：modInfo.name 是安全字段，界面靠 DOM 层从 cache.json 贴。
 *  状态库只做「我翻过了没有」的判断依据，不承担显示职责。 */
function downloadShownNameOf(f) {
  const mi = (f && f.modInfo) || {};
  const mn = String(mi.name == null ? '' : mi.name).trim();
  if (mn) return mn;
  const fi = (((mi.nexus || {}).fileInfo) || {}).name;
  return String(fi == null ? '' : fi).trim();
}

/** 写下载行的名字：**只写 modInfo.name**。
 *
 *  绝不写 nexus.fileInfo.name —— 那条路径会触发 Vortex 的 processAttributes：
 *    customFileName = fuzzRatio < 50 ? `${modName} - ${fileName}` : undefined
 *  一旦 fileInfo.name 是中文、modName 是英文，fuzzRatio 必然 < 50，
 *  于是每个 mod 的显示名都变成「英文 - 中文」，比不翻更糟，且要手工清。
 *  界面显示由 DOM 层负责，不归状态库管。 */
function setDownloadShownName(dlId, zh) {
  try {
    contextRef.api.store.dispatch(va.actions.setDownloadModInfo(dlId, 'name', zh));
    return true;
  } catch (e) {
    log('error', 'setDownloadModInfo fail', String(e));
    return false;
  }
}

function downloadTargetOf(f, modsRoot, force) {
  if (!f) return null;
  const mi = f.modInfo || {};
  const disp = downloadShownNameOf(f);
  if (!disp) return null;
  // 状态层已经是中文 → 这行翻过了。**什么都不写回状态库**，只把译文补进 cache.json
  // （DOM 层读它贴屏）。这是 0.16.2 被验证过的老路，也是 2026-10-25 13:08 的结案结论：
  // 未安装/已卸载行的中文一直来自 DOM 层贴名，改成写状态库是方向性错误。
  // ★ 写 nexus.fileInfo.name 会触发 Vortex 的 fuzzRatio 拼名，把整个列表变成
  //   「英文原名 - 中文译文」（PITFALLS P-NAME-03，2026-10-26 第二次踩）。
  if (CJK.test(disp)) {
    // 缓存键必须是英文原名；fileInfo.name 是唯一还能拿到原名的字段（只读，不改）
    const en0 = String((((mi.nexus || {}).fileInfo) || {}).name || '').trim();
    const baseEn = en0 && !CJK.test(en0) ? en0 : '';
    if (modNameOk(disp)) {
      const base = baseEn || disp;
      const key = typeof cacheKeyOf === 'function' ? cacheKeyOf(base) : base;
      // 漂移闸（2026-10-26）：对账刚删掉的旧译文，不能从状态层收养回来 ——
      // 否则删了键、收养又灌回，自动翻译一看「有缓存」全跳过（当日实录）。
      // 判据与对账同源（glossaryDrifted → auditGlossaryDrift → applyTerms）。
      if (key && nameCacheOf(base) == null && !glossaryDrifted(base, disp)) cache[key] = disp;
    }
    // force = 用户右键亲手点的「翻译此模组」。这时不能因为「状态层已经是中文」
    // 就返回 null —— 返回 null 会让 translateSelected 的 dlTargets 为空，
    // 用户看到的就是「手动点翻译没反应」。重翻的 raw 用英文原名（只读 fileInfo.name），
    // 结果仍然只写回 modInfo.name（安全字段，不触发 fuzzRatio 拼名）。
    //
    // 漂移放行（2026-10-26 第三次补链）：状态层中文 + 词库已换代 = 这份旧译文是死账。
    // 「要翻」的判据是状态层非中文、不查缓存 —— 对账删了缓存键后这里照样 return null，
    // autoHook/translateAll 永远看不见它（真机实录：audit stale=1、收养闸拦住了回流，
    // 但 dl name miss 之后整条管线静默，显示纹丝不动）。漂移时与 force 同路放行，
    // 让它以「未翻条目」身份重进管线，翻完走 applyDownloadTranslation 覆盖 modInfo.name。
    const drift = !!baseEn && typeof glossaryDrifted === 'function' && glossaryDrifted(baseEn, disp);
    if (!force && !drift) return null;
    if (!baseEn) return null;
    const rawF = typeof canonicalName === 'function' ? canonicalName(baseEn) : baseEn;
    if (!rawF) return null;
    return { dlId: undefined, raw: rawF, cached: undefined, f };
  }
  if (!needsTranslate(disp)) return null;
  // 送模型 / 写缓存都用规范键：`ModSkillSlotPages Remaster 1.8` 这种驼峰整串
  // 模型翻不动本体、只会补个「重制版」尾巴，然后被验收拒掉 → 无限循环
  // （2026-10-26 真机 7 条全中）。拆成 Mod Skill Slot Pages 才能真翻。
  // 界面上那串（disp）原样保留给还原/留底用，不进这里。
  const raw = typeof canonicalName === 'function' ? canonicalName(disp) : disp;
  if (!raw) return null;
  let cached = nameCacheOf(raw);
  // nameCacheOf 未命中返 null（不是 undefined）—— 借译文判断必须覆盖两种「没有」
  if (cached == null && f.installed && f.installed.modId && f.installed.gameId) {
    // 借已安装条目的译文：版本尾巴必须严丝合缝，否则不借（零跨版本兜底）
    try {
      const m = (modsRoot[f.installed.gameId] || {})[f.installed.modId];
      if (m) {
        const b = rawNameOf(m);
        const dver = versionTailOf(cleanKeyForm(raw));
        if (b && dver && versionTailOf(b) === dver) {
          const cv = nameCacheOf(b);
          if (cv !== undefined && cv !== null) cached = cv;
        }
      }
    } catch (e) { /* 状态形状异常就当作没得借 */ }
  }
  // 借不到、屏幕上那串又是压缩包文件名本身 → 看它还剩不剩可翻的东西。
  // `CWSO-13311-1-4-9-1770000000.zip`：一串缩写 + 编号，送模型只会臆造出个中文名，
  // 或者把编号翻进中文（2026-10-26 实测 `清洁水源模组 13392 1 …`）。到此为止。
  // `VAXIS_Blood_Physics_v1.5.zip`：下划线分隔、三个真实英文词，该翻 —— 不能一刀切。
  // 判据：去掉后缀后没有空格分隔，且非纯数字的段少于 2 个 → 没有可翻的名字。
  // 必须放在「借译文」之后、且只在没借到时生效（借到译文就不必烧模型）。
  if (cached == null && /\.(zip|7z|rar)$/i.test(disp)) {
    const stem = disp.replace(/\.(zip|7z|rar)$/i, '');
    if (!/\s/.test(stem)) {
      const words = stem.split(/[_.\-]+/).filter((w) => w && !/^\d+$/.test(w) && /[A-Za-z]/.test(w));
      if (words.length < 2) return null;
    }
  }
  return { dlId: undefined, raw, cached: cached === null ? undefined : cached, f };
}

function collectDownloadTargets(state) {
  const files = (state.persistent && state.persistent.downloads && state.persistent.downloads.files) || {};
  const modsRoot = (state.persistent && state.persistent.mods) || {};
  const out = [];
  // downloadTargetOf 的「状态层已是中文」分支会往 cache 里补译文（DOM 层贴屏用）。
  // 那条分支不返回 target，所以没人写盘 —— 补进去的译文以前只活在内存里，
  // 关掉 Vortex 就没了，下次启动重算。这里统一落一次盘。
  const cacheBefore = cacheEntryCount(cache);
  for (const dlId of Object.keys(files)) {
    const f = files[dlId];
    const raw0 = downloadShownNameOf(f);
    if (typeof registerKeptBrands === 'function') registerKeptBrands(raw0);
    const t = downloadTargetOf(f, modsRoot);
    if (!t) continue;
    const raw = t.raw;
    // nameCacheOf 未命中返 null；统一成 undefined，让 given-up 豁免判断
    // （「有缓存就不跳」）对「没有」的两种形态都成立（null 漏判 → given-up 连坐缓存）
    const good = nameCacheOf(raw) || undefined;
    // given-up 只挡「烧模型」，不挡「套缓存」—— 旧账连坐缓存正是续 7 那条
    // 「缓存明明有译文却被跳过」的死路（用户截图实锤）
    if (isGivenUp(typeof cacheKeyOf === 'function' ? cacheKeyOf(raw) : raw) && good === undefined) continue;
    out.push({ dlId, raw, cached: t.cached, f });
  }
  const added = cacheEntryCount(cache) - cacheBefore;
  if (added > 0) {
    saveJson(CACHE_PATH, cache, 'dl cache write');
    log('info', 'dl cache filled', { added, total: cacheEntryCount(cache) });
  }

  // 诊断（P-NAME-05）：哪些下载行「有英文原名、cache 却查不到译文」——这些行只能显示英文。
  // 打出来是为了确认缺的键长什么样（fileInfo.name 原样？还是得剥压缩包骨架？）。
  try {
    const miss = [];
    for (const dlId of Object.keys(files)) {
      const f = files[dlId] || {};
      const mi = f.modInfo || {};
      const en = String((((mi.nexus || {}).fileInfo) || {}).name || '').trim();
      if (!en || CJK.test(en)) continue;
      if (nameTranslationOf(en)) continue;
      const zh = String(mi.name == null ? '' : mi.name).trim();
      miss.push({ en: en.slice(0, 60), zh: zh.slice(0, 24) });
    }
    if (miss.length) log('info', 'dl name miss', { n: miss.length, sample: miss.slice(0, 15) });
  } catch (e) { /* 诊断失败不影响主流程 */ }
  return out;
}

// ---------- 给用户看的两个助手：失败原因 / 进度节流 ----------
/** 最近一次 applyTranslation / applyDownloadTranslation 返回 false 的原因代码。
 *  这两个函数同步执行、在 for 循环里逐条调用、中间没有 await —— 用「最后一次原因」
 *  不会串台，比给两个函数改签名（调用点 7 处）风险小得多。 */
let lastApplyFail = '';
const FAIL_LABEL = {
  noreply: '没返回译文',
  blank: '返回空',
  nocjk: '没译成中文',
  half: '仍夹英文',
  write: '写不进列表',
};
/** 失败原因一句话，只报数量最多的两项；拿不到原因就返回空串，调用方只报条数。 */
function failCauseText(tally) {
  const ks = Object.keys(tally || {}).filter((k) => tally[k] > 0).sort((a, b) => tally[b] - tally[a]);
  if (!ks.length) return '';
  const head = ks.slice(0, 2).map((k) => `${tally[k]} 条${FAIL_LABEL[k] || k}`);
  return '（' + head.join('，') + (ks.length > 2 ? ' 等' : '') + '）';
}
/** 进度通知节流：跨过 25% / 50% / 75% 各发一条，100% 交给结果通知。
 *  以前是每 25 条一条 —— 300 条会连刷 12 个 toast，用户根本看不过来，而且
 *  「60/300」这种中间值对用户没有任何信息量（进度条在按钮上）。 */
function makeProgressNotifier(nid, total) {
  let last = 0;
  return (done) => {
    if (!(total >= 40)) return;                    // 一两批就跑完，报进度没有意义
    const step = Math.floor((done / total) * 4);
    if (step <= last || step >= 4) return;         // 100% 交给结果通知，别叠一条
    last = step;
    notify({ id: nid, type: 'info', displayMS: 6000, title: '翻译进度', message: `${done}/${total}` });
  };
}
/** 译文被拒的具体原因（只给用户看的一句话）。
 *  合格与否仍由 modNameOk 独家判定，这里只是把「被拒」再分个类，不改判据。 */
function whyRejected(raw, zh) {
  const s = String(zh == null ? '' : zh).trim();
  if (!s) return 'blank';
  if (!CJK.test(s)) return 'nocjk';                                   // R1：一个汉字都没有
  if (s === String(raw == null ? '' : raw).trim()) return 'nocjk';    // 原样抄回去
  return 'half';                                                      // 有中文但夹残留/被引号包着
}

function applyTranslation(item, zh) {
  if (item.dlId) return applyDownloadTranslation(item, zh);
  lastApplyFail = 'noreply';
  if (!zh) return false;
  // let：下面同族统一要把结果写回 clean（const 会抛 TypeError 中断整批 —— dlname 组 4 实录）
  let clean = String(zh).replace(/^["'\s]+|["'\s]+$/g, '');
  lastApplyFail = 'blank';
  if (!clean) return false;
  // 译文=原文 分两种，以前混为一谈（2026-10-29 真机：右键「取消保留英文」后
  // 点「立即翻译」提示 1 条成功，界面仍是英文）：
  //  ① 整名在保英文名单里 → 本来就该是英文，算成功、不写缓存（写了读侧也不认）
  //  ② 原文里有待翻英文、模型却原样退回 → **没翻**，按失败记账走有界退让。
  //     旧代码把它当成功并写缓存，于是「点几次都报成功、界面一次都不变」。
  if (clean === item.raw) {
    if (typeof isKnownBrand === 'function' && isKnownBrand(item.raw)) return true;
    const wantTr = typeof needsTranslate === 'function' ? needsTranslate(item.raw) : false;
    if (wantTr) {
      lastApplyFail = 'nocjk';
      return typeof rejectName === 'function' ? rejectName(item.raw, clean, 'mod') : false;
    }
    const ckSame = cacheKeyOf(item.raw);
    if (ckSame) cache[ckSame] = clean;     // 中文/空键不写（cacheKeyOf 返回 '' 即拒绝）
    return true;
  }
  // 验收三规则：不达标的译文不写状态、不入缓存（最坏结局=保持英文，绝不比原文更差）
  // 直接调 modNameOk（唯一实现；nameAcceptable 只是它的别名，测试沙箱没抽那个名字）
  // 拒绝必须走 rejectName：它会记 give-up 账，试满 3 次就不再反复烧模型
  if (!modNameOk(item.raw, clean)) {
    lastApplyFail = whyRejected(item.raw, clean);
    return rejectName(item.raw, clean, 'mod');
  }
  // F4：同族多版本统一（骨架 + 本条版本号）；取不到版本尾巴时原样返回，绝不跨版本覆盖
  const unified = unifyFamilyName(item.raw, clean);
  if (unified !== clean) {
    log('info', 'family name unified', { raw: item.raw.slice(0, 60), from: clean.slice(0, 60), to: unified.slice(0, 60) });
    clean = unified;
  }
  // dispatch 抛错（action 未注册/状态树异常/初始化竞态）时不写缓存、返回 false：
  // 以前三次 dispatch 无条件写缓存 → 界面还是英文、缓存说翻了，同批次 applied 还虚高。
  // 必需两项（originalName 留底 + customFileName 显示）任一失败就留给下一轮重送
  // （dispatch 幂等，重试安全）；name 字段是可选兜底，失败只记日志不影响判定。
  const okOrig = dispatch('originalName', item.gameId, item.modId, item.raw);
  const okCustom = dispatch('customFileName', item.gameId, item.modId, clean);
  if (cfg.writeToNameField) dispatch('name', item.gameId, item.modId, clean);
  if (!okOrig || !okCustom) { lastApplyFail = 'write'; return false; }
  const ckOk = cacheKeyOf(item.raw);
  if (ckOk) {
    cache[ckOk] = clean;
    clearNameFail(ckOk);       // 成功了就销账，别让 7 天前的败绩继续挡着
  }
  return true;
}

/** 下载条目（尚未安装的模组）也翻名字：官方 action setDownloadModInfo */
function applyDownloadTranslation(item, zh) {
  lastApplyFail = 'noreply';
  if (!zh) return false;
  // let：同族统一写回（与 applyTranslation 同一个坑）
  let clean = String(zh).replace(/^["'\s]+|["'\s]+$/g, '');
  lastApplyFail = 'blank';
  if (!clean) return false;
  // 译文=原文 = 无需翻译：不写 Vortex 状态，只标记缓存（同 applyTranslation）
  // 译文=原文：与 applyTranslation 同一口径（名单内=成功不写缓存 / 待翻英文原样退回=失败）
  if (clean === item.raw) {
    if (typeof isKnownBrand === 'function' && isKnownBrand(item.raw)) return true;
    const wantTrDl = typeof needsTranslate === 'function' ? needsTranslate(item.raw) : false;
    if (wantTrDl) {
      lastApplyFail = 'nocjk';
      return typeof rejectName === 'function' ? rejectName(item.raw, clean, 'dl') : false;
    }
    const ckSameDl = cacheKeyOf(item.raw);
    if (ckSameDl) cache[ckSameDl] = clean;   // 中文/空键不写
    return true;
  }
  // 拒绝必须走 rejectName：下载行以前只打日志、不记账，同一个名字每次收集都重来
  // —— 用户看到的就是「点了也没用、一直提示未通过验收」的无限循环（2026-10-26 真机）。
  if (!modNameOk(item.raw, clean)) {
    lastApplyFail = whyRejected(item.raw, clean);
    return rejectName(item.raw, clean, 'dl');
  }
  // F4：同族多版本统一（下载行同样适用；取不到版本尾巴就原样返回）
  const unified = unifyFamilyName(item.raw, clean);
  if (unified !== clean) clean = unified;
  // 写 modInfo.name —— **不是** nexus.fileInfo.name。
  // 0.16.5 曾按 asar 里 `rowFromDownload` 的字段映射改成写 nexus，理由是「那才是界面渲染的字段」。
  // 结果是 Vortex 的 `processAttributes` 拿中文 fileName 和英文 modName 算 fuzzRatio，
  // 必然 < 50，于是给每个 mod 写出 `customFileName = \`${modName} - ${fileName}\``
  // → 整个列表炸成「英文 - 中文」拼装名（PITFALLS P-NAME-03，已踩两次）。
  // 界面显示归 DOM 层从 cache.json 贴；状态库只回答「我翻过没有」。
  if (!setDownloadShownName(item.dlId, clean)) { lastApplyFail = 'write'; return false; }
  const ckDl = cacheKeyOf(item.raw);
  if (ckDl) {
    cache[ckDl] = clean;
    clearNameFail(ckDl);
  }
  return true;
}

function restoreAll(state) {
  const modsRoot = (state.persistent && state.persistent.mods) || {};
  let n = 0;
  let dropped = 0;
  for (const gameId of Object.keys(modsRoot)) {
    const mods = modsRoot[gameId] || {};
    for (const modId of Object.keys(mods)) {
      const a = (mods[modId] && mods[modId].attributes) || {};
      if (a.originalName) {
        dispatch('customFileName', gameId, modId, a.originalName);
        dispatch('originalName', gameId, modId, undefined);
        if (cfg.writeToNameField) dispatch('name', gameId, modId, a.originalName);
        // 缓存里「原名 → 中文」必须一起清：否则重启 8 秒后 applyCachedSilently()
        // 按缓存把中文又写回 customFileName，用户会以为「还原」按钮根本没生效。
        // 走 dropTranslation 而不是裸 delete：写侧是规范键，删侧删原串键 = 一条都没删掉。
        dropped += typeof dropTranslation === 'function'
          ? dropTranslation(a.originalName)
          : (cache[a.originalName] !== undefined ? (delete cache[a.originalName], 1) : 0);
        n++;
      }
    }
  }
  // 下载条目（尚未安装的模组）：译文是 setDownloadModInfo 直接覆盖 modInfo.name
  // 写进 Vortex 状态的，没有 originalName 可依，原名只存在于 cache 的键里。
  // 不遍历这里，「还原为英文」对下载页的条目毫无作用；而 applyCachedSilently()
  // 对下载路径没有 cur 比对（不像 mods 路径那样先看当前值），重启约 8 秒后会把
  // 中文按缓存又写回该条目；用户改用手动清缓存则原名映射永久丢失。
  const dlFiles = (((state.persistent || {}).downloads || {}).files) || {};
  if (Object.keys(dlFiles).length > 0 && cacheEntryCount(cache) > 0) {
    // 反查表：译文 → cache 键（原名）。同一译文可能对应多个原名，取第一个。
    const rev = new Map();
    for (const k of Object.keys(cache)) {
      if (!k || k.charAt(0) === '_') continue;   // _ver/_st/_gl 是元信息，不是原名
      const v = cache[k];
      if (typeof v === 'string' && !rev.has(v)) rev.set(v, k);
    }
    for (const dlId of Object.keys(dlFiles)) {
      const f = dlFiles[dlId];
      // 判据必须是界面真正显示的那串（nexus.fileInfo.name）。读 modInfo.name
      // 等于在比对一个没人看的字段 —— 译文写成功了这里也永远判定「没翻过」。
      const cur = downloadShownNameOf(f);
      if (!cur) continue;
      const orig = rev.get(cur);
      if (orig !== undefined && !needsTranslate(cur)) {
        // 当前显示名不是英文（是我们的译文）→ 写回原名、删缓存映射。
        // needsTranslate 守卫：防「译文恰好是另一个英文名」时把没翻过的条目改坏。
        // 写回值优先用记录自带的英文原名：全量重翻后缓存键统一成了规范键
        // （`Clean Water`），直接拿键当原名会把 Nexus 的 fileId / 版本号一起丢掉。
        const mi = (f && f.modInfo) || {};
        // 英文原名只读 nexus.fileInfo.name（我们从没写过它，写它会触发 fuzzRatio 拼名）
        const ownEn = String(mi.zhSourceName
          || (((mi.nexus || {}).fileInfo || {}).name) || '').trim();
        const back = ownEn && !CJK.test(ownEn) ? ownEn : orig;
        if (!setDownloadShownName(dlId, back)) continue;  // 没写成功就不删缓存，下次还能再试
        n++;
        dropped += typeof dropTranslation === 'function'
          ? dropTranslation(orig)
          : (cache[orig] !== undefined ? (delete cache[orig], 1) : 0);
      } else if (cache[cur] !== undefined) {
        // 显示名仍是英文但缓存里有映射（翻过又被 Vortex 重置）→ 只清映射，
        // 否则重启后 applyCachedSilently 又会把中文写回来。
        dropped += typeof dropTranslation === 'function'
          ? dropTranslation(cur)
          : (cache[cur] !== undefined ? (delete cache[cur], 1) : 0);
      }
    }
  }
  if (dropped > 0) saveJson(CACHE_PATH, cache, 'restore all');
  return n;
}

async function translate(list, opts) {
  // 手动触发（工具栏按钮 / 一键汉化 / 取消保留后的重翻）的结果通知留在通知中心，
  // 全部通知都走铃铛（用户要求：底部不要闪）。停留时长靠 displayMS > 5000 保证不被
  // canBeToast 抢走；不设 displayMS 反而是坑——store 里永不删除，徽标越挂越多。
  const manual = !!(opts && opts.manual);
  if (running) {
    notify({ id: 'modname-zh-busy', type: 'info', displayMS: 6000, title: '正在翻译中', message: '等这一轮跑完再点' });
    return { applied: 0, failed: 0, error: '正在翻译中，等这一轮跑完再点' };
  }
  if (!list || list.length === 0) {
    notify({ id: 'modname-zh-busy', type: 'info', displayMS: 6000, title: '没有要翻的条目', message: '列表里已是中文' });
    return { applied: 0, failed: 0, none: true };
  }
  running = true;
  // 手动点了就立刻叫醒界面翻译层：DOM 层因模型挂机进入暂停时，
  // 只有 2 分钟一次的探活能恢复，手动按钮必须有最高优先级（0.16.5 补）。
  if (manual) kickDomLayer('translate');
  const nid = 'modname-zh-progress';
  try {
    // 必须是「原地改」，不能 cfg = readJson(...)：save() 靠 Object.assign 改同一个对象
    // 才能让 DOM 层立刻读到新配置。换引用后 DOM 层还持有启动时那份，设置项就会「改了不管用」。
    {
      // 兜底不能写 cfg 本身：readJson 失败时返回的就是这个引用，
      // 紧接着把 cfg 的键全删了，Object.assign(cfg, 自己) 等于拿到空对象，
      // 后面就会误报「模组名汉化已在设置中关闭」，并且 DOM 层失去全部配置。
      // 先把手上的配置写下去：设置页刚填的地址可能还在 400ms 防抖窗口里，
      // 直接读文件会拿到旧地址，导致「刚填完就点翻译」反而报未配置。
      flushCfgWrite();
      const raw = readJson(CONFIG_PATH, null);
      if (raw && typeof raw === 'object') {
        for (const k of Object.keys(cfg)) delete cfg[k];
        Object.assign(cfg, raw);
      } else {
        // 审计 v10 发现 4：读失败（杀软读锁/文件被占）时**保留内存现值**——
        // 它就是最近一次成功加载/保存的配置，翻译照常跑。回退 DEFAULT_CFG 会让
        // baseUrl 变空（发布红线要求出厂为空），本次必报「未配置」全灭 = 偶发
        // 不可复现的「配置丢了」观感。不碰 cfg 引用，彻底避开上面警告的别名坑。
        log('warn', 'config read fail; keep runtime cfg', { file: 'config.json' });
      }
      mergeRuntimeTerms();
    }
    if (!cfg.enabled) {
      notify({ id: 'modname-zh-off', type: 'info', displayMS: 6000, title: '模组名翻译已关闭', message: '在设置里打开后再试' });
      return { applied: 0, failed: 0, error: '模组名汉化已在设置里被关掉了' };
    }

    let applied = 0;
    let failed = 0;
    const pending = [];

    for (const t of list) {
      if (t.cached) {
        if (applyTranslation(t, t.cached)) applied++;
      } else {
        pending.push(t);
      }
    }

    if (pending.length === 0) {
      saveJson(CACHE_PATH, cache, 'translate done');
      notify({ id: nid, type: 'success', displayMS: resultMS(manual), title: '模组名翻译完成', message: `${applied} 条（命中缓存）` });
      return { applied, failed: 0, cachedOnly: true };
    }

    // 发请求前先确认模型连不连得上（0.16.5）：连不上就一条都不烧。
    // manual 必须透传：手动点按钮时要弹窗把四类原因说清。
    // 之前这里写死 false，手动点完模型没开会静默返回 —— 用户看到的就是「点了没反应」。
    if (!(await gateModel(manual, '汉化'))) {
      const d = describePreflight(lastPreflight);
      return { applied, failed: 0, error: '模型接口未就绪：' + ((d && d.short) || '未知原因') };
    }

    const lanes = Math.max(1, Math.min(10, cfg.concurrency || 5));
    notify({
      id: nid, type: 'info', displayMS: 6000, title: '开始翻译模组名',
      message: `${pending.length} 条`,
    });

    const texts = pending.map((p) => p.raw);
    // 显式 mode='mod'（审计 v10 发现 1）：模组名批必须走全遮蔽，不能让 isUiBatch
    // 按批长度猜——批均 >24 字符的真实长名会被误判 ui，modOnly 词条（Oils→剑油/
    // Reborn→重生）不遮蔽，产出缺固定译名的「合格译文」→ 对账全量词表判漂移 →
    // 删键重翻 → 再缺 → 循环。遮蔽是硬保证，提示词对照只是模型自觉。
    const results = await core.translateConcurrently(cfg, cache, texts, lanes, makeProgressNotifier(nid, pending.length), 'mod');
    const why = {};
    for (let k = 0; k < pending.length; k++) {
      if (applyTranslation(pending[k], results[k])) applied++;
      else { failed++; why[lastApplyFail] = (why[lastApplyFail] || 0) + 1; }
    }
    saveJson(CACHE_PATH, cache, 'translate done');
    log('info', 'done', { applied, failed, lanes, why });
    if (failed > 0) {
      // 有成功 = 接口一定是通的，这时再提「模型没连上」就是自相矛盾的提示。
      // 全失败才可能整批被模型拒；但预检已经放行了，所以也不能甩「去测连接」——
      // 只能说「没拿到可用结果」，把具体原文与返回指到日志里。
      const whole = failed >= pending.length;
      if (whole) {
        notifyAnomaly({ id: 'modname-zh-allfail', type: 'error', title: '模组名没翻出来', message: `${failed} 条全部失败` + failCauseText(why) + hintShort() });
      } else {
        notifyAnomaly({ id: 'modname-zh-partial', type: 'warning', title: '模组名翻译完成', message: `${applied} 条成功，${failed} 条失败` + failCauseText(why) });
      }
    } else {
      clearAnomaly();
      notify({ id: nid, type: 'success', displayMS: resultMS(manual), title: '模组名翻译完成', message: `${applied} 条成功` });
    }
    return { applied, failed };
  } catch (e) {
    log('error', 'translate crashed', String((e && e.stack) || e));
    notifyAnomaly({ id: 'modname-zh-crash', type: 'error', title: '翻译出错', message: String(e).slice(0, 50) });
    return { applied: 0, failed: 0, error: String(e).slice(0, 60) };
  } finally {
    running = false;
  }
}

function translateAll(opts) {
  const state = contextRef.api.getState();
  return translate(collectTargets(state, null).concat(collectDownloadTargets(state)), opts);
}

function applyCachedSilently() {
  const state = contextRef.api.getState();
  const targets = collectTargets(state, null).concat(collectDownloadTargets(state)).filter((t) => t.cached);
  let n = 0;
  for (const t of targets) {
    if (t.dlId) { if (applyDownloadTranslation(t, t.cached)) n++; continue; }
    const mod = ((state.persistent || {}).mods || {})[t.gameId] || {};
    const cur = (mod[t.modId] && mod[t.modId].attributes && mod[t.modId].attributes.customFileName) || '';
    // 比的是「要写进去的那份译文」，不是「按 raw 直接取的缓存项」——
    // 写侧键已统一到 canonicalName，裸取 cache[t.raw] 在旧缓存键下恒为 undefined，
    // 于是每次启动都白跑一遍 applyTranslation（还会顺手覆盖掉人工改过的显示名）。
    if (cur === t.cached) continue;
    if (applyTranslation(t, t.cached)) n++;
  }
  if (n > 0) log('info', 'silent cache applied', { n });
}

// ---------- 界面语言包（接管官方 i18n） ----------

/** pack.json = 唯一的中文词库（构建期已把能收的译文全烧进来） */
function readPack() {
  let raw = null;
  try { raw = fs.readFileSync(PACK_PATH, 'utf8'); } catch (e) { return {}; }   // 文件不存在是首启正常态
  try {
    return JSON.parse(raw);
  } catch (e) {
    // 解析失败不再静默（review4-M2）：静默返 {} 会被上层当「词库为空」，界面悄悄回英文
    // 还查不到原因。报出来，让 build() 的空包守卫拒写、日志里能看到根因。
    try { log('error', 'pack.json unparseable, lexicon disabled this session', String(e).slice(0, 120)); } catch (e2) { /* ignore */ }
    return {};
  }
}

/** 摊平成「英文 → 中文」映射，供 DOM 层做零延迟替换 */
function lex() {
  const pack = readPack();
  const out = Object.create(null);   // 见 asDict：普通对象会被原型链污染
  const walk = (o) => {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v);
      else if (typeof v === 'string' && v) out[k] = v;
    }
  };
  walk(pack);
  return out;
}

/** Vortex 当前界面语言（i18n 按这个值选 locales/<lang> 目录，不是按目录是否存在） */
function currentUiLang() {
  try {
    const st = contextRef.api.getState();
    return String((st && st.settings && st.settings.interface && st.settings.interface.language) || '');
  } catch (e) { return ''; }
}

function localeOpts() {
  return { userData: localePack.resolveUserData(va), selfDir: EXT_DIR, pack: readPack(), log, force: false };
}

/** 启动时按需重建语言包；返回结果对象 */
function ensureLocalePack(isStartup) {
  try {
    const o = localeOpts();
    if (!o.userData) {
      log('error', 'locale pack: userData path unresolved');
      return { changed: false, reason: 'no-userdata' };
    }
    const r = localePack.build(o);
    if (r.changed) {
      log('info', 'locale pack built', { entries: r.entries, reason: r.reason, removed: (r.removed || []).length });
      if (isStartup) {
        // 阶段性提示：6 秒后自己消失。>5000 是为了避开底部 toast（用户要求一律走铃铛）。
        notify({
          id: 'modname-zh-pack',
          type: 'info',
          displayMS: 6000,
          title: '界面语言包已更新',
          message: `${r.entries} 条词条，重启生效`,
        });
      }
    }
    return r;
  } catch (e) {
    log('error', 'locale pack failed', String((e && e.stack) || e));
    return { changed: false, reason: 'error', error: String(e) };
  }
}

// ---------- 自检：列出当前页面还没翻成中文的英文 ----------
// 用途：用户报「这句一直不翻」时，先看这句到底在不在 DOM 里、挂在哪个元素上，
// 再决定是排队失败、元素被跳过、还是压根没被扫到
function scanUntranslated(limit) {
  const out = [];
  if (typeof document === 'undefined' || !document.body) return out;
  const seen = new Set();
  let walker;
  try { walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null); } catch (e) { return out; }
  let n;
  let guard = 0;
  while ((n = walker.nextNode())) {
    if (++guard > 20000 || out.length >= (limit || 40)) break;
    const t = (n.nodeValue || '').trim();
    if (t.length < 8 || t.length > 600) continue;
    if (CJK.test(t) || !LATIN.test(t)) continue;
    if ((t.match(/[A-Za-z]{2,}/g) || []).length < 2) continue;
    const el = n.parentElement;
    const cls = el ? String(el.className || '').slice(0, 44) : '';
    // 段落单元视角：外层容器的一整段文字才是送翻单位，单看一个文本节点会误判成"碎片"
    const box = el && el.closest ? (el.closest('p,li,h1,h2,h3,h4,h5,h6,td,th,dd,dt,summary,label') || el) : el;
    const whole = box ? String(box.textContent || '').replace(/\s+/g, ' ').trim() : t;
    if (seen.has(whole)) continue;
    seen.add(whole);
    let reason = '排队等模型';
    const inflight = (liveStatus.inflight || []).some((it) => String(it.text || '').indexOf(t.slice(0, 20)) !== -1);
    if (inflight) reason = '正在翻译中（看「实时队列」能看耗时）';
    else if ((failCache[t] === -1) || (failCache[whole] === -1)) reason = '判定为不可译（专名/品牌名，不再自动重试）';
    else if ((failCache[t] > domTranslator.RETRY_MAX) || (failCache[whole] > domTranslator.RETRY_MAX)) reason = `已放弃重试（失败 ${failCache[t] || failCache[whole]} 次）→ 点「清空全部翻译缓存」才会重来`;
    else if (failCache[t] || failCache[whole]) reason = `失败 ${failCache[t] || failCache[whole]} 次，等自动重试`;
    else if (domCache[t] || domCache[whole]) reason = '已翻但页面没换（重渲染覆盖）';
    else if (el && /^(CODE|PRE)$/.test(el.tagName)) reason = '代码块被跳过';
    else if (el && el.closest && el.closest('[data-zh-skip]')) reason = '扩展自身跳过';
    else if (el && el.closest && el.closest('[class*="author"],[class*="uploader"]')) reason = '作者行保护（只翻 By 前缀）';
    else if (box && box.getAttribute && box.getAttribute('data-zh-block') === '1') reason = '标记为已翻但内容是英文（标记已失效，下一轮会重来）';
    out.push({ text: whole.slice(0, 90), tag: box ? box.tagName : '?', cls, reason, cached: !!(domCache[t] || domCache[whole]) });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// 名字管线全家桶（0.16.3 重建）：族切词 / 自愈 / 重翻 / 词级补翻 / 右键单修
//
// 位置纪律：本块必须整体位于 mergeRuntimeTerms 之后、hitFromDownload 之前 ——
// dlname 测试沙箱按这两个函数名整段切片（BLOCK_A），translateAllFresh /
// resetModName 要被包进去；hitFromDownload 是切片收口标记，签名勿改。
// 本块内不许出现顶层 const（沙箱会重复注入同名常量 → SyntaxError）。
// ═══════════════════════════════════════════════════════════════════════

/** 整条名字没有一个可翻的英文词（REFramework / UE4SS / SkyUI）→ 不进待翻队列。
 *  送模型必然「照抄」或吐空 → 验收不过 → 记一次假失败，还会触发
 *  「多数原因是模型接口没开」的误导提示（实测成功 30 失败 3，模型一直是好的）。
 *  下划线必须先拆：`VAXIS_Blood_Physics_v1.5` 整串会被 residueWords 当成一个
 *  token，含连续大写 VAXIS 就整串放行 → 误判「无可翻」。 */
function nothingToTranslate(name) {
  const s = String(name == null ? '' : name);
  if (!s || CJK.test(s)) return false;   // 已含中文的不归它管（交给 needsTranslate）
  return residueWords(s.replace(/_+/g, ' ')).length === 0;
}

/** 族特征 token（小写；版本号/fileId/时间戳不算）。
 *  `ModSkillSlotPages Remaster 1.8` → ['modskillslotpages','remaster'] */
function modNameTokens(name) {
  const out = [];
  for (const w of String(name == null ? '' : name).replace(/_+/g, ' ').split(/[^A-Za-z0-9]+/)) {
    if (!w) continue;
    if (/^v?\d+(\.\d+)*[a-z]?$/i.test(w)) continue;
    // 时间戳碎片：键里的 `2026-10-01T00-00Z` 被切成 01T00 这种，不滤掉会把
    // `Smooth Map`(10 字符) 的公共前缀撑过 12 → 短名模组被误判同族连坐（refresh 组 10）
    if (/^\d+[TZ]\d*$/i.test(w)) continue;
    out.push(w.toLowerCase());
  }
  return out;
}

/** 两条 token 序列的公共前缀长度（按字符）。同族判据：≥12 才认。
 *  `Smooth Map`(10) / `Clean Water`(11) 这种短主干不许连坐；
 *  `ModSkillSlotPages Remaster`(27) / CWSO 长名才连坐。 */
function commonTokenPrefixLen(a, b) {
  const A = a || [];
  const B = b || [];
  let n = 0;
  const lim = Math.min(A.length, B.length);
  for (let i = 0; i < lim; i++) {
    if (A[i] !== B[i]) break;
    n += A[i].length + 1;   // +1 = 词间空格
  }
  return n > 0 ? n - 1 : 0;
}

/** 族主干 token：先按时间戳锚定剥掉键尾（fileId/版本/随机id），再切词。
 *  与 modNameTokens 的分工：后者是纯切词（组 10 直接用），本函数管「键形态」。 */
function stemTokens(key) {
  const k = String(key == null ? '' : key).trim();
  const parts = k.split(/\s+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^\d\d\d\d-\d\d-\d\dT[\d:Z.-]+$/i.test(parts[i])) {
      return modNameTokens(parts.slice(0, Math.max(0, i - 2)).join(' '));
    }
  }
  return modNameTokens(k);
}

/** 主干反查：缓存里同族（公共前缀 ≥12）且版本号对得上的译文。
 *  版本对齐防串台：1.8 的行只拿 1.8 的译文（refresh 组 11-6/11-7 钉死）。
 *  只能引用 cache/CJK + 抽出来的助手：refresh 组 11 的沙箱只注了这些，
 *  所以验收走**两参** modNameOk（单参会调 residueWords → 那边没注 keepNameSet）。 */
function findCacheByStem(key) {
  const k = String(key == null ? '' : key);
  const st = stemTokens(k);
  if (!st.length) return '';
  // 版本对齐用的「本键出现过的版本串」：空白切分保留 `1.8` 整体（缓存键的版本
  // 尾巴带点，只按非字母数字切会把 1.8 拆成 1/8，对齐永远不命中 —— refresh 11-6 实录），
  // 再补一份纯字母数字切分（`1-8` 横线式键形）。
  const words = new Set();
  for (const w of k.replace(/_+/g, ' ').split(/\s+/)) {
    const t = String(w || '').trim().toLowerCase();
    if (!t) continue;
    words.add(t);
    for (const w2 of t.split(/[^A-Za-z0-9]+/)) if (w2) words.add(w2);
  }
  for (const ck of Object.keys(cache)) {
    if (commonTokenPrefixLen(st, stemTokens(ck)) < 12) continue;
    const cv = /(?:^|[\s_\-–—(（])(v?\d+(?:\.\d+)*[a-z]?)$/i.exec(String(ck).trim());
    if (cv && !words.has(cv[1].toLowerCase())) continue;
    const v = cache[ck];
    if (typeof v !== 'string' || !v || !CJK.test(v)) continue;
    if (!modNameOk(ck, v)) continue;
    return v;
  }
  return '';
}

/** give-up 记账：同一名字试满 NAME_FAIL_MAX 次就不再烧模型（TTL 过后旧账作废） */
function isGivenUp(key) {
  const k = String(key == null ? '' : key);
  const live = (kk) => {
    const e = nameFail && nameFail[kk];
    if (!e || !e.n) return false;
    if (Date.now() - (e.ts || 0) > NAME_FAIL_TTL) return false;
    return e.n >= NAME_FAIL_MAX;
  };
  if (live(k)) return true;
  // 兼容旧账：0.16.3 之前记账键是原始名字串（没规范化），键换成 canonicalName 后
  // 那些账会集体「查不到」→ 该退让的条目又开始无限重试。带前缀的（sh:/dl:）不归一化，
  // 它们是显示名不是原名，交给 canonicalName 会被剥掉日期/后缀变成另一个键。
  if (/^[a-z]+:/.test(k) || typeof cacheKeyOf !== 'function') return false;
  const ck = cacheKeyOf(k);
  return !!ck && ck !== k && live(ck);
}
function bumpNameFail(key, model) {
  const k = String(key == null ? '' : key);
  // 空键不记账：`cacheKeyOf` 拒绝中文后可能返回 `''`，若调用方没判空就写出
  // `nameFail['']` —— 又造一个所有条目共用的桶。与 `clearNameFail` 的判空对齐。
  if (!k) return 0;
  const e = (nameFail && nameFail[k]) || { n: 0, ts: 0 };
  e.n = (e.n || 0) + 1;
  e.ts = Date.now();
  if (model) e.model = String(model);
  nameFail[k] = e;
  saveJson(NAME_FAIL_PATH, nameFail, 'nameFail bump');
  return e.n;
}

/** 成功就销账：否则一条条目失败 3 次后即使后来翻好了，7 天内仍按 given-up 挡着。 */
function clearNameFail(key) {
  const k = String(key == null ? '' : key);
  if (!k || !nameFail) return;
  // 两种键形态都销：旧账记在原串、新账记在规范键，漏一种就会留下永远查不到的僵尸账
  const keys = [k];
  if (!/^[a-z]+:/.test(k) && typeof cacheKeyOf === 'function') {
    const ck = cacheKeyOf(k);
    if (ck && ck !== k) keys.push(ck);
  }
  let hit = false;
  for (const kk of keys) {
    if (nameFail[kk] !== undefined) { delete nameFail[kk]; hit = true; }
  }
  if (hit) saveJson(NAME_FAIL_PATH, nameFail, 'nameFail clear');
}

/** **统一的验收拒绝出口** —— 所有「译文没过验收」都必须走这里，不许各分支自己
 *  `log + return false`。
 *
 *  0.16.3 的实况：`applyTranslation` / `applyDownloadTranslation` 的拒绝分支只打一行日志
 *  就返回，**一处都没记账**。于是翻不过的条目每次收集都重新进队列 → 翻 → 被拒 →
 *  不写缓存 → 下次再来，用户看到的就是「一直提示未通过验收、怎么点都翻不了」
 *  （2026-10-26 真机：`ModSkillSlotPages Remaster 1.8` 连续被拒两次、无任何退让）。
 *
 *  记账键用 canonicalName —— 和缓存键同源，不会出现「这个分支记的账那个分支查不到」。
 *  日志名保持原样（`name translation rejected` / `download name translation rejected`），
 *  测试按这两个字符串断言。 */
function rejectName(raw, got, where) {
  const key = typeof canonicalName === 'function'
    ? canonicalName(raw)
    : String(raw == null ? '' : raw).trim();
  let n = 0;
  if (key) n = bumpNameFail(key, cfg && cfg.provider && cfg.provider.model);
  log('warn', where === 'dl' ? 'download name translation rejected' : 'name translation rejected', {
    raw: String(raw == null ? '' : raw).slice(0, 60),
    got: String(got == null ? '' : got).slice(0, 60),
    tries: n,
  });
  return false;
}

/** 驼峰拆词：ModSkillSlotPages → Mod Skill Slot Pages（词级补翻的输入） */
function camelSplitWord(w) {
  return String(w == null ? '' : w)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
}

/** 词级补翻的模型调用：一批英文词 → 一行一个中文。逻辑与 gate-e2e 的复本对拍。 */
async function translateWords(words) {
  const list = (words || []).map((w) => String(w == null ? '' : w).trim()).filter(Boolean);
  if (!list.length) return [];
  const p = (cfg && cfg.provider) || {};
  const base = String(p.baseUrl || '').replace(/\/+$/, '');
  const model = String(p.model || '');
  if (!base || !model) return [];
  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: WORD_PROMPT }, { role: 'user', content: list.join('\n') }],
    temperature: 0.2,
    max_tokens: Math.max(160, list.length * 32 + 80),
  });
  const headers = Object.assign({ 'Content-Type': 'application/json' }, p.apiKey ? { Authorization: 'Bearer ' + p.apiKey } : {});
  try {
    const r = await core.httpRequest(base + '/chat/completions', 'POST', headers, body, 60000);
    if (!r || r.status < 200 || r.status >= 300) return [];
    const j = JSON.parse(r.body);
    const txt = String((((j.choices || [])[0] || {}).message || {}).content || '').trim();
    return txt.split(/\r?\n/)
      .map((s) => s.replace(/^\s*\d+\s*[.、)．]\s*/, '').replace(/^["'\s]+|["'\s]+$/g, '').trim())
      .filter(Boolean).slice(0, list.length);
  } catch (e) { return []; }
}

/** 词级补翻：把译文里残留的英文词逐个翻掉（驼峰词先拆开）。
 *  只换没翻的那个词，绝不整句重译 —— 整句覆盖就是「剑星」事故的来源。 */
async function refineByWords(text) {
  const t = String(text == null ? '' : text);
  if (!t || !CJK.test(t)) return t;
  const res = residueWords(t);
  if (!res.length) return t;
  const partsOf = (w) => (/[a-z][A-Z]/.test(w) ? camelSplitWord(w).split(/\s+/).filter(Boolean) : [w]);
  const need = [];
  const table = Object.create(null);
  for (const w of res) {
    const parts = partsOf(w);
    const miss = [];
    for (const p of parts) {
      const hit = wordCache && wordCache[p];
      if (hit) table[p] = hit; else miss.push(p);
    }
    for (const p of miss) need.push(p);
  }
  if (need.length) {
    const zhs = await translateWords(need);
    for (let i = 0; i < need.length && i < zhs.length; i++) {
      if (zhs[i]) { wordCache[need[i]] = zhs[i]; table[need[i]] = zhs[i]; }
    }
    saveJson(WORD_PATH, wordCache, 'word cache fill');
  }
  let out = t;
  for (const w of res) {
    const parts = partsOf(w);
    const all = parts.every((p) => table[p]);
    if (!all) continue;                       // 有词没翻回来就整个词不动（不留半成品）
    const rep = parts.map((p) => table[p]).join('');
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('(?<![A-Za-z0-9])' + esc + '(?![A-Za-z0-9])', 'g'), rep);
  }
  // 中文夹中文的空格去掉：`自动应用 剑油 重生 插件` → `自动应用剑油重生插件`。
  // 只吃「汉字 + 空格 + 汉字」，`模组技能槽页面重制版 1.8` 这种中文接数字不受影响。
  out = out.replace(/([\u4e00-\u9fa5])[ \t]+(?=[\u4e00-\u9fa5])/g, '$1');
  return out;
}

/** 中文译文 → 英文缓存键（右键时靠它找原名）。并列命中（两条都译成同一个中文）
 *  时不猜，返回空。非中文输入直接空。 */
function englishKeyOfZh(zh) {
  const t = String(zh == null ? '' : zh).trim();
  if (!t || !CJK.test(t)) return '';
  let hit = '';
  let n = 0;
  for (const k of Object.keys(cache)) {
    if (String(cache[k] == null ? '' : cache[k]).trim() === t) { n++; if (!hit) hit = k; }
  }
  return n === 1 ? hit : '';
}

/** 选中项归一化：Vortex 传进来的形状有三种（{modIds:[…]} / 单个 id / id 数组） */
function normSelection(sel) {
  if (sel == null) return [];
  if (typeof sel === 'string') return sel ? [sel] : [];
  if (Array.isArray(sel)) return sel.filter((x) => typeof x === 'string' && x);
  if (Array.isArray(sel.modIds)) return sel.modIds.filter((x) => typeof x === 'string' && x);
  return [];
}

/** 强制重翻（清模组名缓存后从英文原名重翻）。
 *  KEY 稳定性铁律：送翻输入一律取 r.base（属性里的英文原名），绝不取当前显示名 ——
 *  显示名可能是半中半英，拿它当 key 就是永动机（续 7 实录）。
 *  已翻好的条目跳过（skipped 只统计这一类）；半拉子要清要翻。
 *  下载记录不清缓存：判据是界面显示串，缓存是「显示串 → 译文」的映射，
 *  清了就白烧模型（given-up + 有缓存的条目正是这么被救回来的）。 */
/** @param opts.manual 用户主动点的是 true：模型连不上时弹窗说清原因。
 *  升级后的自动重建走默认 false（只发通知，不弹窗，不打断启动）。 */
async function translateAllFresh(want, dlIds, opts) {
  const manual = !!(opts && opts.manual);
  // keepExisting：只补缺的/失败的/被放弃的，已有合格译文一律不动。
  // 「立即翻译」与「清空缓存并全部重翻」必须是两个语义（用户 2026-10-29 定）：
  //   keepExisting=true  → 立即翻译：插队把当前该翻的跑一遍，不推倒重来
  //   keepExisting=false → 强制重翻：先删译文再翻，一个不留
  const keepExisting = !!(opts && opts.keepExisting);
  if (running) {
    notify({ id: 'modname-zh-busy', type: 'info', displayMS: 6000, title: '正在翻译中', message: '等这一轮跑完再点' });
    return { applied: 0, failed: 0, error: '正在翻译中，等这一轮跑完再点' };
  }
  if (!cfg || !cfg.enabled) {
    notify({ id: 'modname-zh-off', type: 'info', displayMS: 6000, title: '模组名翻译已关闭', message: '在设置里打开后再试' });
    return { applied: 0, failed: 0, error: '模组名汉化已在设置里被关掉了' };
  }
  running = true;
  if (manual) kickDomLayer('fresh');
  const nid = 'modname-zh-fresh';
  try {
    // 枚举用一次状态快照（变量名刻意不叫 st：契约钉住「不用重新 getState 的显示名」）
    const state = contextRef.api.getState();
    const modsRoot = (state.persistent && state.persistent.mods) || {};
    const list = [];
    let skipped = 0;
    let givenUp = 0;
    let cleared = 0;
    for (const gameId of Object.keys(modsRoot)) {
      const table = modsRoot[gameId] || {};
      for (const modId of Object.keys(table)) {
        const mod = table[modId] || {};
        if (mod.type === 'collection' && !(cfg && cfg.includeCollections)) continue;
        // 当前显示名已是完整译文 → 不重翻（半拉子不跳，要清要翻）
        const disp = String((mod.attributes || {}).customFileName || '').trim();
        const bases = englishBaseNameOf(mod, modId);
        // 但「形式合格」不等于「翻对了」：品牌被硬译的『蓬松模组管理器』有中文、无残留英文，
        // cacheLooksDone 判它合格 → 永久跳过。品牌丢了必须重翻，否则全量重翻永远碰不到它
        // （0.16.3 实测：30 条模组跳过 29 条，Fluffy 就是被这道门挡住的）。
        const brandBad = disp
          ? brandLost((Array.isArray(bases) && bases[0]) || rawNameOf(mod), disp)
          : false;
        // 「显示名已合格」不等于「不用重翻」：缓存被清空后，状态层（customFileName）还是
        // 中文，只查显示名会把每一条都判成跳过 —— 实测用户点「清空全部翻译缓存(强制重翻)」
        // 之后 fresh translate 返回 {todo:0,dl:0}，一条都没翻，缓存永远补不回来
        // （2026-10-25 真机）。判据改成「显示名合格 且 缓存里确有对应条目」才算一致。
        const cachedHas = bases.some((b) => b && cache[b] !== undefined);
        if (disp && cacheLooksDone(disp) && !brandBad && cachedHas) { skipped++; continue; }
        for (const base of bases) {
          const r = { base };
          if (!r.base) continue;                    // 找不到原名不猜
          if (typeof registerKeptBrands === 'function') registerKeptBrands(r.base);
          if (nothingToTranslate(r.base)) continue;
          // 翻不动就退让（与 collectTargets 同一判据）。这里**连清缓存都不做** ——
          // 否则条目既被删了译文、又被拉黑，界面停在英文且永远不再试，比不打补丁更糟。
          // 手动「强制重翻」不吃放弃名单：用户点它就是要求再来一遍，
          // 按 isGivenUp 跳过会得到 todo:0，看起来就是「清了缓存也不翻」（0.16.5 补）。
          if (!manual && typeof isGivenUp === 'function' && isGivenUp(cacheKeyOf(r.base))) { givenUp++; continue; }
          // keepExisting（「立即翻译」）时不删旧译文：那是「强制重翻」才做的事。
          // 以前这里无条件删，导致点了「立即翻译」等于悄悄清了一次缓存。
          if (!keepExisting && cache[cacheKeyOf(r.base)] !== undefined && typeof dropTranslation === 'function') {
            dropTranslation(r.base);
            cleared++;
          }
          // 强制重翻：缓存刚被删光，这里恒为空。刻意不走 nameCacheOf 归一化反查——
          // 那会把旧译文捞回来，违背「全部重翻」的本意（0.16.3 审计 P1-3 例外）
          list.push({ gameId, modId, raw: r.base, cached: undefined });
        }
      }
    }
    // 下载记录：判据是界面显示串；有缓存就套（不清），没有才送模型
    const files = ((state.persistent || {}).downloads || {}).files || {};
    const dlWanted = dlIds === undefined ? Object.keys(files) : (dlIds || []);
    const dlList = [];
    let dlApplied = 0;
    for (const id of dlWanted) {
      const f = files[id];
      if (!f) continue;
      const t = downloadTargetOf(f, modsRoot);
      if (!t) continue;
      const b0 = t.raw;
      // 判据统一走 nameCacheOf（内部含 cacheLooksDone 验收）—— 下载记录的缓存不清：
      // 判据是界面显示串，清了就白烧模型（given-up + 有缓存的条目正是这么被救回的）
      if (b0 && nameCacheOf(b0)) {
        if (applyDownloadTranslation({ dlId: id, raw: b0 }, nameCacheOf(b0))) dlApplied++;
        continue;
      }
      if (t.cached) {
        // 借已安装条目的译文（版本尾巴严丝合缝才借，D2 零跨版本兜底）
        if (applyDownloadTranslation({ dlId: id, raw: b0 }, t.cached)) dlApplied++;
        continue;
      }
      if (!manual && isGivenUp(cacheKeyOf(b0))) { givenUp++; continue; }
      dlList.push({ dlId: id, raw: b0 });
    }
    if (cleared > 0) saveJson(CACHE_PATH, cache, 'retranslate cleared');
    log('info', 'fresh translate', { todo: list.length + dlList.length, dl: dlList.length + dlApplied, skipped, givenUp, cleared });
    const full = list.concat(dlList);
    // 真正发请求的那一步抽成局部函数：指名 / 不指名共用同一条路径
    // （两份实现必然漂移，0.16.3 续 7 的两处死路就是这么来的）。
    // 命中缓存的条目在上面就已经就地套好了，这里只处理还需要送模型的。
    const translate = async (batch) => {
      if (batch.length === 0) {
        notify({ id: nid, type: 'success', displayMS: resultMS(manual), title: '模组名重翻完成', message: `已合格 ${skipped} 条，无需重翻` });
        return { applied: dlApplied, failed: 0, none: true, skipped };
      }
      // 先探模型（0.16.5）：连不上就在这里收手，一条都不烧。
      // 以前是先烧完整批，再在结尾甩一句「多数原因是模型接口没开或地址不对」。
      if (!(await gateModel(manual, '重翻', opts))) {
        const d = describePreflight(lastPreflight);
        return {
          applied: dlApplied, failed: 0, skipped,
          error: '模型接口未就绪：' + ((d && d.short) || '未知原因'),
          preflight: (lastPreflight && lastPreflight.code) || '',
        };
      }
      notify({ id: nid, type: 'info', displayMS: 6000, title: '开始重翻模组名', message: `${batch.length} 条` });
      const lanes = Math.max(1, Math.min(10, cfg.concurrency || 5));
      const texts = batch.map((p) => p.raw);
      const results = await core.translateConcurrently(cfg, cache, texts, lanes, makeProgressNotifier(nid, batch.length), 'mod');
      let applied = dlApplied;
      let failed = 0;
      const retry = [];
      const retryWhy = [];        // 与 retry 同下标的失败原因：重试救回来时要把它从统计里扣掉
      const why = {};
      for (let k = 0; k < batch.length; k++) {
        const item = batch[k];
        const okOne = item.dlId ? applyDownloadTranslation(item, results[k]) : applyTranslation(item, results[k]);
        if (okOne) applied++;
        else {
          failed++;
          retry.push(item);
          retryWhy.push(lastApplyFail);
          why[lastApplyFail] = (why[lastApplyFail] || 0) + 1;
        }
      }
      // ── 失败条目单独重试一次 ────────────────────────────────────────────
      // 模型在 20 条一起送时会被别的条目带偏：实测 `ModSkillSlotPages Remaster 1.8`
      // 单条连翻 6 次 6 次都过，混在批量里却连续 2 次原样照抄主体
      // （`ModSkillSlotPages 重制版 1.8` → 有英文残留 → 验收拒）。单条重送能救回来。
      // 只在「部分失败」时做：全失败说明模型/接口有问题，重试只是白等。
      if (retry.length > 0 && retry.length < batch.length && retry.length <= 10) {
        notify({ id: nid, type: 'info', displayMS: 6000, title: '单独重试', message: `${retry.length} 条没过验收，再试一次` });
        const once = await core.translateConcurrently(cfg, cache, retry.map((p) => p.raw), 1, null, 'mod');
        for (let k = 0; k < retry.length; k++) {
          const item = retry[k];
          const okOne = item.dlId ? applyDownloadTranslation(item, once[k]) : applyTranslation(item, once[k]);
          if (okOne) {
            applied++; failed--;
            const w = retryWhy[k];
            if (w && why[w] > 0) why[w]--;   // 重试救回来了，这次失败不该再出现在原因统计里
          }   // 重试救回来的算成功，不再计入失败数
        }
      }
      saveJson(CACHE_PATH, cache, 'retranslate fresh');
      log('info', 'fresh translate done', { applied, failed, skipped, retried: retry.length, why });
      if (failed > 0) {
        const whole = failed >= batch.length;
        notifyAnomaly({
          id: whole ? 'modname-zh-allfail' : 'modname-zh-partial',
          type: whole ? 'error' : 'warning',
          title: whole ? '模组名没翻出来' : '模组名重翻完成',
          message: whole
            ? `${failed} 条全部失败` + failCauseText(why) + hintShort()
            : `${applied} 条成功，${failed} 条失败` + failCauseText(why) + (givenUp ? `，${givenUp} 条已暂停` : ''),
        });
      } else {
        clearAnomaly();
        notify({
          id: nid, type: 'success', displayMS: resultMS(manual), title: '模组名重翻完成',
          message: `${applied} 条成功` + (givenUp ? `，${givenUp} 条已暂停` : ''),
        });
      }
      return { applied, failed, skipped };
    };
    // 「一键全部」（未指名）也要扫下载记录：通用批量翻译只认模组条目，
    // 下载行必须由 healStaleDownloadNames 补扫，否则点一次「全部」就漏掉整页下载行。
    if (!want) return translate(full).then((r) => healStaleDownloadNames(state)
      .then((h) => Object.assign({}, r, { dlHealed: h })));
    return translate(full);
  } catch (e) {
    log('error', 'translateAllFresh crashed', String((e && e.stack) || e));
    notifyAnomaly({ id: 'modname-zh-crash', type: 'error', title: '重翻出错', message: String(e).slice(0, 50) });
    return { applied: 0, failed: 0, error: String(e).slice(0, 60) };
  } finally {
    running = false;
  }
}

/** 重置单条模组名（右键「重新翻译此名」的状態层半边）：
 *  删 domCache 里的名字匹配项 + 同族旧版本残留 + 该条所有候选缓存键，
 *  把英文原名写回 originalName / customFileName（自愈，否则下次又要猜）。
 *  domCache 只删名字匹配项，绝不整清、不碰 pack（契约钉死）。
 *  只许用 cache/domCache/cfg/dispatch/writeJson + 抽出来的助手：
 *  refresh 组 5 的沙箱只注了这些（没有路径常量 → 落盘由调用方负责）。 */
function resetModName(state, gameId, modId) {
  const modsRoot = (state.persistent && state.persistent.mods) || {};
  const mod = (modsRoot[gameId] || {})[modId] || {};
  const names = englishBaseNameOf(mod, modId);
  const rawKeys = [modId, mod && mod.id].filter((x) => typeof x === 'string' && x);
  const base = names[0] || '';
  // domCache：整名匹配（f === n || f.indexOf(n) === 0）+ 同族旧版本残留
  // （1.8 与 1.7a 版本号不同，只按整名比会漏 —— 实测残留一活就是几个月）
  const stems = names.map((n) => modNameTokens(n)).filter((t) => t.length);
  let domDropped = 0;
  for (const dk of Object.keys(domCache)) {
    if (dk === '_ver') continue;
    const f = stripPseudo(dk).trim();
    if (!f) continue;
    let hit = false;
    for (const n of names) {
      if (f === n || f.indexOf(n) === 0) { hit = true; break; }
    }
    if (!hit && stems.length) {
      const dt = modNameTokens(f);
      for (const st of stems) {
        if (commonTokenPrefixLen(st, dt) >= 12) { hit = true; break; }
      }
    }
    if (hit) { delete domCache[dk]; domDropped++; }
  }
  // 模组名缓存：删该条所有候选键（含原始键形态 —— raw 与 cleaned 两个键只删一个，
  // 下次读侧归一化又把它翻出来，P3-6）
  let dropped = 0;
  for (const n of names.concat(rawKeys)) {
    if (n && cache[n] !== undefined) { delete cache[n]; dropped++; }
  }
  // 原名写回（自愈）：否则 originalName 丢了下次又要从键里猜
  if (base) {
    dispatch('originalName', gameId, modId, base);
    dispatch('customFileName', gameId, modId, base);
    if (cfg && cfg.writeToNameField) dispatch('name', gameId, modId, base);
  }
  return { domDropped, dropped, base };
}

/** 英文原名候选（重翻的输入、签名表的匹配键、自愈的缓存键）——返回字符串数组。
 *  半中半英的显示名（customFileName/modName/name 已被我们写过）一律不收：
 *  拿它当缓存键就是永动机（续 7 实录：键跟着显示名飘，每次启动都判「没翻过」）。
 *  属性里没有英文名时（合集 / 无属性模组）从 mod.id 或 mods 键名剥：
 *    空格式 `<名字> <fileId> <版本> <时间戳> <随机id>`（时间戳锚定，名字可含空格）
 *    横线式 `<名字>-<fileId>-<版本>-<子版本>-<epoch>`（从尾部剥纯数字段，
 *      名字自带的 `-1.8` 不是纯数字，不会被误剥 —— `Cool-Mod-1.8` 实测）
 *  摆放位置有硬约束：必须留在 mergeRuntimeTerms → hitFromDownload 这个区间里
 *  （dlname 测试沙箱按这两个标记整段切片，声明在区间外 → translateAllFresh 里
 *  ReferenceError）。测试各自按函数名抽取，位置对它们无所谓。 */
function englishBaseNameOf(mod, modId) {
  const a = (mod && mod.attributes) || {};
  const out = [];
  const seen = new Set();
  const add = (s) => {
    // 压缩包后缀不是名字的一部分。原来只在 add(a.fileName) 那一处剥，
    // 但整串键净化后可能只剩 `VAXIS_Blood_Physics_v1.4.zip`（日期戳切完就没有尾巴了），
    // 落到显示名上是 `VAXIS血迹物理模组 v1.4.zip` —— 真机实测。
    let t = String(s == null ? '' : s).trim().replace(/\.(zip|7z|rar)$/i, '');
    if (!t || t.length < 3 || t.length > 200) return;
    if (CJK.test(t)) return;                    // 半中半英的显示名绝不是原名
    // 状态键 / 下载文件名的形态：`<名字> <fileId> <版本> <日期T时-分Z> <hash>`。
    // a.name 里存的就是整串键（实测 `ModSkillSlotPages Remaster 1.7a 13188 12 2026-10-05T15-05Z yShfiQa4f`），
    // a.fileName 是带 .zip 的整串 —— 直接送翻会让模型把 fileId、更新日期、随机 id 一起
    // 翻进中文（2026-10-26 真机 11 条：`清洁水源功能 13392 1 2026-10-03T17-14Z GpMW8t9md`），
    // 而且脏串会以 cache 键的形式留下来，反过来盖掉干净键的译文。
    // 净化：日期戳前正好是「fileId + 版本」两段，切掉它们和日期之后的全部；
    // 只按空格分段，不猜数字含义 —— `The Witcher 3` 里的 3 在名字段，不会被吃掉。
    if (/\d\d\d\d-\d\d-\d\dT[\d:Z.\-]+$/i.test(t) || /\d\d\d\d-\d\d-\d\dT[\d:Z.\-]+\s/i.test(t)) {
      const at = t.search(/\d\d\d\d-\d\d-\d\dT[\d:Z.\-]+/i);
      if (at <= 0) return;                      // 日期在开头 → 整条不是名字
      const parts = t.slice(0, at).trim().split(/\s+/).filter(Boolean);
      if (parts.length < 3) return;             // 名字段 + fileId + 版本，至少 3 段
      t = parts.slice(0, parts.length - 2).join(' ');
      if (!t || !/[A-Za-z]/.test(t)) return;
      // 净化后 t 被重新赋过值，开头那次剥扩展名已经失效 —— 这里必须再剥一次
      // （`VAXIS_Blood_Physics_v1.4.zip 13506 1.4 2026-…` 切完尾巴正好剩个 .zip）
      t = t.replace(/\.(zip|7z|rar)$/i, '').trim();
      if (!t) return;
    }
    const lw = t.toLowerCase();
    if (seen.has(lw)) return;
    seen.add(lw);
    out.push(t);
  };
  const stripExt = (s) => String(s == null ? '' : s).replace(/\.(zip|7z|rar)$/i, '');
  add(a.originalName);
  add(a.logicalFileName);
  add(a.name);
  add(a.modName);
  add(stripExt(a.fileName));
  // 键/id 兜底：先试空格式（时间戳锚定），再试横线式（剥尾部纯数字段）
  const key = String((mod && mod.id) || modId || '').trim();
  if (key) {
    const parts = key.split(/\s+/);
    let base = '';
    for (let i = parts.length - 1; i >= 0; i--) {
      if (/^\d\d\d\d-\d\d-\d\dT[\d:Z.-]+$/i.test(parts[i])) { base = parts.slice(0, Math.max(0, i - 2)).join(' '); break; }
    }
    if (!base && key.indexOf('-') > 0) {
      const seg = key.split('-');
      let n = seg.length;
      while (n > 1 && /^\d+$/.test(seg[n - 1].trim())) n--;
      base = seg.slice(0, n).join('-').trim();
    }
    if (base) {
      const spaced = base.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
      if (spaced !== base) add(spaced);         // 空格形态优先（缓存键/显示名常用它）
      add(base);                                // 下划线形态一起给（DOM 文本常带下划线）
    }
  }
  // 全部候选统一收敛到规范键：写缓存 / 送模型 / 失败记账用的必须是同一个形态。
  // 放在这里一次做完，而不是在每条 add 里各写一遍剥法 —— 那正是「五套口径」的来源。
  // typeof 守卫：早期沙箱只抽本函数，没注 canonicalName。
  if (typeof canonicalName === 'function') {
    const uniq = [];
    const seenC = new Set();
    for (const x of out) {
      const c = canonicalName(x);
      if (!c) continue;
      const lk = c.toLowerCase();
      if (seenC.has(lk)) continue;
      seenC.add(lk);
      uniq.push(c);
    }
    return uniq;
  }
  return out;
}

function hitFromDownload(state, modsRoot, id) {
  try {
    const files = ((state || {}).persistent || {}).downloads || {};
    const f = (files.files || {})[id];
    if (!f) return '';
    const inst = f.installed || {};
    // ① installed.modId 精确反查（「旧副本找不到」的正解）
    if (inst.modId && inst.gameId && modsRoot[inst.gameId] && modsRoot[inst.gameId][inst.modId]) {
      return inst.gameId + ':' + inst.modId;
    }
    // ② localPath 文件名锚点：去目录和压缩包后缀
    const lp = String(f.localPath || '');
    const base = lp.replace(/^.*[\\/]/, '').replace(/\.(zip|7z|rar)$/i, '');
    if (!base) return '';
    for (const g of Object.keys(modsRoot || {})) {
      if (modsRoot[g][base]) return g + ':' + base;
    }
    // ③ 主干前缀（同族换代：SwordFX 1.3.28 的行 → 1.2.4 的现存条目）
    const st = modNameTokens(base);
    if (st.length && st.join(' ').length >= 12) {
      let best = '';
      let bestLen = 0;
      for (const g of Object.keys(modsRoot || {})) {
        for (const k of Object.keys(modsRoot[g] || {})) {
          const n = commonTokenPrefixLen(st, modNameTokens(k));
          if (n >= 12 && n > bestLen) { best = g + ':' + k; bestLen = n; }
        }
      }
      if (best) return best;
    }
  } catch (e) { /* 状态形状异常就安静返回空 */ }
  return '';
}

/** 右键「翻译此模组」：点下载行就修下载记录（F2，与反查结果无关），
 *  点模组行按 m.id 反查（Vortex 传的是纯 UUID，在 mods 键里匹配不上）。
 *  只修点名的 + 有缓存的，不把没缓存的拖去烧模型。 */
async function translateSelected(instanceIds) {
  // 批量批次在跑时不能直接丢弃：右键是用户亲手点的一次请求，等它跑完自动接上
  // （最多等 30 秒，与「取消保留英文」的重翻排队同一口径）。以前这里立刻 return
  // 「正在翻译中」，用户看到的就是「右键点了没反应」。
  for (let i = 0; running && i < 20; i++) {
    if (i === 0) notify({ id: 'modname-zh-busy', type: 'info', displayMS: 6000, title: '正在翻译中', message: '已排队，这一轮跑完自动接上' });
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (running) {
    notify({ id: 'modname-zh-busy', type: 'info', displayMS: 6000, title: '仍在翻译中', message: '这一轮太久，等它跑完再点一次' });
    return { applied: 0, failed: 0, error: '正在翻译中，等这一轮跑完再点' };
  }
  const ids = normSelection(instanceIds);
  const state = contextRef.api.getState();
  const modsRoot = (state.persistent && state.persistent.mods) || {};
  const dlFiles = ((state.persistent || {}).downloads || {}).files || {};
  const list = [];
  const dlIds = [];
  const miss = [];
  const kept = [];   // 整名在保英文名单里：不送模型，单独提示（0.16.5）
  const diag = { ids: ids.length, mods: 0, dl: 0, miss };
  for (const id of ids) {
    let hit = null;
    for (const g of Object.keys(modsRoot)) {
      const table = modsRoot[g] || {};
      for (const mid of Object.keys(table)) {
        const m = table[mid] || {};
        if (mid === id || String(m.id) === id) { hit = { gameId: g, modId: mid, mod: m }; break; }
      }
      if (hit) break;
    }
    // F2：点中下载行就修这条记录本身 —— 反查成功也照记（老代码把 dlIds 挂在 else 上，
    // 反查越成功，下载记录本人漏得越彻底）。只有反查失败才算「没找到模组」。
    if (dlFiles[id]) dlIds.push(id);
    else if (!hit) miss.push(id);
    if (dlFiles[id]) diag.dl++;
    if (hit) diag.mods++;
    if (!hit) continue;
    const found = hit;
    const bases = englishBaseNameOf(found.mod, found.modId);
    const raw = bases[0] || rawNameOf(found.mod);
    if (!raw) continue;
    if (typeof registerKeptBrands === 'function') registerKeptBrands(raw);
    // 整名在保英文名单里 → 点了「立即翻译」也不该送模型：模型只会原样退回，
    // 旧代码把它记成成功并报「1 条成功」，界面一动不动（2026-10-29 真机）。
    if (typeof isKnownBrand === 'function' && isKnownBrand(raw)) { kept.push(raw); continue; }
    // 右键是用户亲手点的「再来一次」—— 唯一能突破有界退让的出口。
    // 不清账的话：批量路径试满 3 次拉黑后，右键也只会静默跳过，用户看到的就是
    // 「手动点翻译没反应 / 提示未通过验收」，这正是 0.16.3 里被反复投诉的无限循环。
    if (typeof clearNameFail === 'function') clearNameFail(cacheKeyOf(raw));
    list.push({ gameId: found.gameId, modId: found.modId, raw, cached: nameCacheOf(raw) });
  }
  log('info', 'translate selected diag', diag);
  const dlTargets = [];
  for (const id of dlIds) {
    // 第三个参数 force=true：右键是用户亲手点的「再来一次」，
    // 状态层已是中文也必须给出目标，否则这里为空 → 用户看到「没找到模组」。
    const t = downloadTargetOf(dlFiles[id], modsRoot, true);
    if (t) {
      if (typeof clearNameFail === 'function') clearNameFail(cacheKeyOf(t.raw));
      dlTargets.push({ dlId: id, raw: t.raw, cached: t.cached, f: t.f || dlFiles[id] });
    }
  }
  running = true;
  kickDomLayer('selected');
  try {
    let applied = 0;
    let failed = 0;
    const why = {};
    const unsat = (k) => { why[k] = (why[k] || 0) + 1; };
    const pending = [];
    for (const t of list) {
      if (t.cached) { if (applyTranslation(t, t.cached)) applied++; else { failed++; unsat(lastApplyFail); } }
      else pending.push(t);
    }
    for (const t of dlTargets) {
      if (t.cached) { if (applyDownloadTranslation(t, t.cached)) applied++; else { failed++; unsat(lastApplyFail); } }
      else pending.push(t);
    }
    log('info', 'fresh translate', { todo: list.length + dlTargets.length, dl: dlTargets.length, skipped: 0 });
    // 点名的下载行还要过一遍存量自愈（半中半英那档批量路径不收）；
    // 修好就得算进结果，否则右键点下载行会被当成「没找到模组」甩错。
    const dlFixed = await healStaleDownloadNames(state, dlIds);
    applied += dlFixed;
    if (dlFixed > 0) {
      log('info', 'fix download rows by hand', { n: dlFixed });
    }
    if (pending.length === 0) {
      // 全部命中缓存 = 这一批确实修好了，旧的红卡没有理由继续挂着
      if (applied > 0) { clearAnomaly(); notify({ id: 'modname-zh-sel', type: 'success', displayMS: 10000, title: '已修好', message: `${applied} 条（命中缓存）` }); }
      // 名单内条目以前会走「没有要翻的条目 / 选中的已是中文」，用户以为程序坏了
      else if (kept.length > 0) notify({ id: 'modname-zh-sel', type: 'info', displayMS: 10000, title: '这条保留英文', message: '要翻先右键取消保留' });
      else notify({ id: 'modname-zh-sel', type: 'info', displayMS: 6000, title: '没有要翻的条目', message: '选中的已是中文' });
      return { applied, failed, none: applied === 0, kept: kept.length };
    }
    // 右键是用户主动点的（manual=true）：模型连不上就弹窗说清是哪一种原因
    if (!(await gateModel(true, '翻译'))) {
      const d = describePreflight(lastPreflight);
      return { applied, failed, error: '模型接口未就绪：' + ((d && d.short) || '未知原因') };
    }
    notify({ id: 'modname-zh-sel', type: 'info', displayMS: 6000, title: '开始翻译模组名', message: `${pending.length} 条` });
    const lanes = Math.max(1, Math.min(10, cfg.concurrency || 5));
    const results = await core.translateConcurrently(cfg, cache, pending.map((p) => p.raw), lanes, () => {}, 'mod');
    for (let k = 0; k < pending.length; k++) {
      const item = pending[k];
      const okOne = item.dlId ? applyDownloadTranslation(item, results[k]) : applyTranslation(item, results[k]);
      if (okOne) applied++; else { failed++; unsat(lastApplyFail); }
    }
    saveJson(CACHE_PATH, cache, 'translateAll batch');
    if (failed > 0) {
      notifyAnomaly({
        id: 'modname-zh-partial', type: 'warning', title: '翻译完成',
        message: `${applied} 条成功，${failed} 条失败` + failCauseText(why),
      });
    } else {
      clearAnomaly();
      notify({ id: 'modname-zh-sel', type: 'success', displayMS: 10000, title: '翻译完成', message: `${applied} 条成功` });
    }
    return { applied, failed };
  } catch (e) {
    log('error', 'translateSelected crashed', String((e && e.stack) || e));
    notifyAnomaly({ id: 'modname-zh-crash', type: 'error', title: '翻译出错', message: String(e).slice(0, 50) });
    return { applied: 0, failed: 0, error: String(e).slice(0, 60) };
  } finally {
    running = false;
  }
}

/** 界面自愈（存量半中半英显示名）。不经过任何闸门，专门把「缓存对了、界面没跟上」
 *  的条目写回去。两档：
 *    重伤（残留 ≥12 字符）→ 缓存里那份完整译文（键取自本条属性，版本天然精确）；
 *      缓存没有 → 主干反查（按版本号选）；都没有 → 词级补翻。
 *    轻伤 → 只准词级补翻（只换没翻的那个词），绝不许拿缓存里另一份译文整句覆盖
 *      —— 整句覆盖就是「剑星 Vortex 扩展包 → 星辰之刃漩涡扩展模组」事故的来源。
 *  轻伤补不上必须有界退让：记 nameFail（sh: 前缀），试满 NAME_FAIL_MAX 不再调模型。 */
async function healStaleDisplayNames(state) {
  const modsRoot = (state.persistent && state.persistent.mods) || {};
  // 内联不引模块级常量：测试沙箱按函数名切源码，引用外部变量就是 ReferenceError。
  // 正则也不用 {n} 量词 —— 沙箱按花括号配平切函数体，`\d{2}` 会把深度算错，
  // 拼出来的脚本直接语法错误（audit4-v3 实测）。
  const metaDirt = /\d\d\d\d-\d\d-\d\dT\d\d[-:]\d\d/;
  let n = 0;
  for (const gameId of Object.keys(modsRoot)) {
    const table = modsRoot[gameId] || {};
    for (const modId of Object.keys(table)) {
      const mod = table[modId] || {};
      if (mod.type === 'collection' && !(cfg && cfg.includeCollections)) continue;
      const a = mod.attributes || {};
      const cur = String(a.customFileName || a.name || a.logicalFileName || '').trim();
      if (!cur || !CJK.test(cur)) continue;      // 纯英文归正常翻译流程，自愈不插手
      // 元数据污染（2026-10-26 真机 11 条）：状态键被当原名送翻，模型把 fileId / 更新日期 /
      // 随机 id 一起翻进中文 —— `清洁水源功能 13392 1 2026-10-03T17-14Z GpMW8t9md`。
      // 这不是「半中半英」，refineByWords 换不掉数字串，只会白烧一次调用然后记失败。
      // 只能整句重置；而重置**只允许用同条目 logicalFileName 的译文**，
      // 红线「绝不跨条目整句覆盖」不变（脏串里带着别的版本的 fileId，跨条目等于乱配）。
      if (metaDirt.test(cur)) {
        const lf = String(a.logicalFileName || '').trim();
        const clean = lf && !metaDirt.test(lf) ? nameCacheOf(lf) : '';
        if (clean && modNameOk(clean) && !metaDirt.test(clean)) {
          if (dispatch('customFileName', gameId, modId, clean)) n++;
        }
        continue;                                // 干净译文还没有 → 不动，交给「立即翻译全部」重翻
      }
      if (!healWorthy(cur)) continue;            // 已合格 / 无残留 → 不动
      const strict = badlyUnfinished(cur);
      let zh = '';
      if (strict) {
        const bases = englishBaseNameOf(mod, modId);
        for (const b of bases) {
          const v = nameCacheOf(b);
          if (v) { zh = v; break; }
        }
        if (!zh) {
          for (const b of bases) { const v = findCacheByStem(b); if (v) { zh = v; break; } }
        }
      }
      // 轻伤档（P1-c）：只准词级补翻，绝不拿缓存里另一份译文整句覆盖 ——
      // 整句覆盖正是「剑星 Vortex 扩展包 → 星辰之刃漩涡扩展模组」事故的来源。
      if (!strict && healWorthy(cur)) {
        const failKey = 'sh:' + cur;
        if (isGivenUp(failKey)) continue;        // 有界退让：不每次启动烧一次调用
        const refined = await refineByWords(cur);
        if (refined && refined !== cur && modNameOk(refined)) {
          zh = refined;
          // 救回来了就销账：否则「失败 2 次 → 第 3 次救回来」之后仍挂着 n=2，
          // 再失败一次就永久 given-up（TTL 内）。销账与 bump 必须成对出现在同一分支上。
          if (typeof clearNameFail === 'function') clearNameFail(failKey);
        } else {
          bumpNameFail(failKey, cfg && cfg.provider && cfg.provider.model);
          continue;                              // 补不上就不写（不留半成品）
        }
      }
      if (!zh && strict) {
        // 重伤档缓存也没命中：同样只做词级补翻，一样不许跨条目整句覆盖
        const failKey = 'sh:' + cur;
        if (isGivenUp(failKey)) continue;
        const refined = await refineByWords(cur);
        if (refined && refined !== cur && modNameOk(refined)) {
          zh = refined;
          if (typeof clearNameFail === 'function') clearNameFail(failKey);  // 同上：救回即销账
        }
        else {
          bumpNameFail(failKey, cfg && cfg.provider && cfg.provider.model);
          continue;
        }
      }
      if (!zh) continue;
      if (dispatch('customFileName', gameId, modId, zh)) n++;
    }
  }
  if (n > 0) log('info', 'healed stale display names', { n });
  return n;
}

/** 下载记录自愈：Vortex 把 modInfo.name 同步回英文后，重启能按缓存套回中文。
 *  与 healStaleDisplayNames 同一条护栏：现值已是合格译文就绝不动。 */
/** 下载行的存量自愈（半中半英的 modInfo.name）。
 *  只做一件能保证正确的事：**词级补翻当前这串**，补完必须过硬验收才写回；
 *  绝不拿缓存里另一份译文整句覆盖（那是「剑星 → 星辰之刃」事故的做法），
 *  也绝不碰纯英文行（那是批量翻译的活）。
 *  补不上记失败账（键 `dl:` + 当前显示名，与模组原名的 `sh:` 分开），
 *  试满 NAME_FAIL_MAX 次就安静放弃，不许每次启动都烧一次模型。
 *  依赖全部内联：下载测试沙箱只注了 CJK/modNameOk/cacheLooksDone/healWorthy/
 *  isGivenUp/bumpNameFail/refineByWords/va，多引一个模块级函数就是 ReferenceError。 */
async function healStaleDownloadNames(state, only) {
  const st = state || contextRef.api.getState();
  const files = ((st.persistent || {}).downloads || {}).files || {};
  const onlySet = only && only.length ? new Set(only) : null;
  let n = 0;
  for (const dlId of Object.keys(files)) {
    if (onlySet && !onlySet.has(dlId)) continue;
    const f = files[dlId] || {};
    // 判据 = 界面真正显示的那串。以前读 modInfo.name —— 那是我们写的字段，
    // 表格根本不渲染它，于是自愈通道永远在看一份「没人看的副本」。
    const cur = downloadShownNameOf(f);
    if (!cur) continue;
    if (!CJK.test(cur)) continue;                 // 纯英文 → 批量翻译的活，自愈不插手
    // 自愈门槛：与 mods 表那条通道（healStaleDisplayNames）用同一个判据 healWorthy。
    // 以前这里是 `if (modNameOk(cur)) continue;` —— 语义是反的坑：modNameOk 真值 =
    // 「合格、跳过」，healWorthy 真值 = 「值得救、继续」，所以必须写成 `!healWorthy`。
    // 两份判据并存时，将来谁改 modNameOk 的残留口径，两条通道就会各走一边
    // （审计 v4 #1：同一判据两份实现，0.16.3 已经吃过这个亏）。
    if (!healWorthy(cur)) continue;               // 已合格 / 无残留 → 不动
    // 记账键 = 显示名原串，**绝不能过 `cacheKeyOf`**。
    // 2026-10-26 v7.1 事故：写成 `'dl:' + cacheKeyOf(cur)`，而 `cur` 上一行刚被
    // `if (!CJK.test(cur)) continue` 保证含中文，`cacheKeyOf` 对中文返回 `''`
    // → failKey 恒为裸 `'dl:'`，全通道共用一个桶。任意 3 行补不上就
    // `isGivenUp('dl:')` 恒真 → 之后每一行都被跳过，且无人 `clearNameFail('dl:')`，
    // TTL 7 天内不可恢复（用户症状：翻到某行之后再也不自愈，躺一周又突然好了）。
    // 与 sh: 通道（`'sh:' + cur`）保持一致：记账键是**显示名**，不是规范键。
    const failKey = 'dl:' + cur;
    if (isGivenUp(failKey)) continue;             // 有界退让：不每次启动烧一次调用
    let zh = '';
    if (typeof refineByWords === 'function') {
      try { zh = await refineByWords(cur); } catch (e) { zh = ''; }
    }
    zh = String(zh == null ? '' : zh).trim();
    if (!zh || zh === cur || !CJK.test(zh) || !modNameOk(zh)) {
      bumpNameFail(failKey, cfg && cfg.provider && cfg.provider.model);
      continue;                                   // 补不上就不写（不留半成品）
    }
    // 只写 modInfo.name —— 安全字段。界面靠 DOM 层从 cache 贴，
    // 绝不写 nexus.fileInfo.name（会触发 Vortex 的 fuzzRatio 拼名，见 PITFALLS P-NAME-03）。
    if (!setDownloadShownName(dlId, zh)) {
      bumpNameFail(failKey, cfg && cfg.provider && cfg.provider.model);
      continue;
    }
    // 缓存键必须是英文原名：只读 fileInfo.name（我们从不写它），没留底就别硬拼中文键。
    const mi = f.modInfo || {};
    let en = String(mi.zhSourceName
      || (((mi.nexus || {}).fileInfo || {}).name) || '').trim();
    if (!en || CJK.test(en)) en = CJK.test(cur) ? '' : cur;
    // typeof 守卫：modname-download 的 heal 沙箱只注了 CJK，没注 cacheKeyOf
    // （2026-10-26 去掉守卫后该测试直接 ReferenceError，是它先红的）
    const ckHeal = typeof cacheKeyOf === 'function' ? cacheKeyOf(en) : en;
    // 回退到原串时也要过 CJK：键必须是英文原名，中文键读侧永远贴不上屏
    if (ckHeal && !CJK.test(ckHeal)) cache[ckHeal] = zh;
    // 救回来了就销账（与 sh: 通道同口径）。不清账的话：失败 2 次之后第 3 次救回来，
    // 账上仍挂着 n=2，再失败一次就永久 given-up —— 用户会看到「明明修好了又开始不翻」。
    if (typeof clearNameFail === 'function') clearNameFail(failKey);
    n++;
  }
  if (n > 0) log('info', 'healed stale download names', { n });
  return n;
}

// ---------- 设置页（React，无 JSX） ----------

function makeSettingsComponent() {
  const h = React.createElement;

  return class ModNameZhSettings extends React.Component {
    constructor(props) {
      super(props);
      const dm = readJson(DOM_CACHE_PATH, {});
      const fl = readJson(FAIL_PATH, {});
      const mn = readJson(CACHE_PATH, {});
      let locStat = null;
      try {
        locStat = localePack.status({ userData: localePack.resolveUserData(va), selfDir: EXT_DIR });
        locStat.uiLang = currentUiLang();
      } catch (e) { /* ignore */ }
      // 同样要深拷贝：读到 DEFAULT_CFG 本体的话，设置页的 state.cfg
      // 和「出厂配置」就是同一个对象，后面任何赋值都会污染它。
      // 同上：设置页 init 会拿磁盘值重建 state.cfg，不先落盘会把刚填的内容回退掉
      flushCfgWrite();
      const loaded = readJson(CONFIG_PATH, null) || JSON.parse(JSON.stringify(DEFAULT_CFG));
      this.state = {
        cfg: loaded,
        // 数值输入框的本地草稿：输入过程中不写配置、不做范围纠正，
        // 用户点「应用」才生效。之前边输边 save + clamp，删到空就被打回默认值，字都输不进去
        draft: {
          concurrency: String(loaded.concurrency == null ? DEFAULT_CFG.concurrency : loaded.concurrency),
          batchSize: String(loaded.batchSize == null ? DEFAULT_CFG.batchSize : loaded.batchSize),
        },
        // 页面内提示已取消（全部走铃铛），state.flash 不再存在
        queueOpen: false,   // 实时队列面板是否展开
        tick: 0,            // 面板刷新用的心跳（每秒变一次，触发重渲染）
        busy: '',           // 正在执行的按钮 key（执行期间禁用，防重复点）
        testing: false,
        stats: {
          // _ver 是版本标记不是条目，两条缓存都带它，不过滤的话计数恒 +1
          //（和「清空全部翻译缓存」按钮里的 before 快照口径保持一致）
          dom: Object.keys(dm).filter((k) => k !== '_ver').length,
          mod: Object.keys(mn).length,
          fail: Object.keys(fl).filter((k) => k !== '_ver').length,
        },
        lexCount: Object.keys(lex()).length,
        loc: locStat,
        locMsg: '',
      };
      this._alive = true;
    }

    componentDidMount() {
      try { flushPendingNotice(); } catch (e) { /* ignore */ }
      // 出厂配置是空接口地址（不带作者本机的模型参数），第一次打开设置页得让人知道要填什么，
      // 否则装完看到「界面中文、模组名还是英文」只会以为扩展坏了
      try {
        const c = this.state.cfg || {};
        const pv = c.provider || {};
        // 与翻译闸门同一套说法（0.16.5）：缺什么就说什么，不写「接口地址」三个字了事
        if (!String(pv.baseUrl || '').trim()) {
          this.flash('还没填翻译接口，在下面填地址和模型名', false);
        } else if (!String(pv.model || '').trim()) {
          this.flash('还差「模型名」，填好再点测试连接', false);
        }
      } catch (e) { /* ignore */ }
      // 面板开没开都要刷新：按钮上得能看到「正在翻 N 条 / 排队 M 条」，
      // 空闲时显示「上次完成 x 秒前」——一直挂个 0 不叫实时。
      // 忙 → 1 秒一次；空闲 → 4 秒一次（少折腾重渲染）
      let last = 0;
      this._tick = setInterval(() => {
        if (!this._alive) return;
        const L = liveStatus || {};
        const busy = (Array.isArray(L.inflight) && L.inflight.length > 0) || (L.queued || 0) > 0 || this.state.queueOpen;
        const gap = busy ? 1000 : 4000;
        const now = Date.now();
        if (now - last < gap) return;
        last = now;
        this.setState({ tick: now });
      }, 1000);
    }

    componentWillUnmount() {
      this._alive = false;
      if (this._tick) clearInterval(this._tick);
    }

    save(patch) {
      const next = Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_CFG)), this.state.cfg, patch);
      this.setState({ cfg: next });
      // 防抖写盘：只推迟写文件，内存 cfg 仍立刻更新（连内存一起延迟会让「填完就点翻译」用旧配置）
      scheduleCfgWrite();
      Object.assign(cfg, next); // 保持同一引用，DOM 层与翻译层才能即时读到新配置
      mergeRuntimeTerms();      // 用户在设置页改术语后，游戏名对照不能被 16 条覆盖掉
      // 改了接口地址/密钥/模型名 → 上一次的预检结论作废，否则 10 秒内还按旧地址拦人
      preflightCache = { at: 0, res: null };
      // 启动时若关着实时翻译，DOM 层根本没被注入；这里补启，否则勾选后毫无反应
      if (patch && patch.domTranslate === true && !domStarted && typeof startDomRef === 'function') {
        try {
          if (!startDomRef()) this.flash('实时翻译启动失败，看日志 translator.log', false);
        } catch (e) { log('warn', 'dom start on toggle', String(e)); }
      }
      log('info', 'config updated', Object.keys(patch));
    }

    /** 操作反馈统一走通知中心（铃铛），设置页里不再叠一行字（用户 2026-10-29 要求）。
     *  以前是「页面内一行 + 铃铛一条」双发，同一个结果在屏幕上出现两遍。
     *  opts.quiet：这条已经在别处通知过（例如翻译管线内部发过带明细的通知），这里完全静默。 */
    flash(text, ok, opts) {
      if (opts && opts.quiet) return;
      try {
        const one = String(text).replace(/^[✓✗×…]\s*/, '').replace(/\s+/g, ' ');
        // 阶段性反馈：6 秒后自己消失。>5000 才不会被 canBeToast 抢去走底部 toast。
        notify({ id: 'modname-zh-flash', type: ok === false ? 'error' : 'success', displayMS: 6000, message: one.length > 30 ? one.slice(0, 30) + '…' : one });
      } catch (e) { /* 提示失败不影响主流程 */ }
    }

    /** 数值项：只在点「应用」/ 回车时校验并保存，输入过程不做任何纠正 */
    applyNum(key, min, max, label) {
      const raw = String(this.state.draft[key] == null ? '' : this.state.draft[key]).trim();
      const n = parseInt(raw, 10);
      if (!raw || !isFinite(n) || n <= 0) {
        return this.flash(`✗ ${label}：要 ${min}-${max} 的整数`, false);
      }
      const v = Math.max(min, Math.min(max, n));
      this.save({ [key]: v });
      this.setState({ draft: Object.assign({}, this.state.draft, { [key]: String(v) }) });
      this.flash(`✓ ${label} = ${v}${v !== n ? '（已按边界）' : ''}`, true);
    }

    async test() {
      this.setState({ testing: true, busy: 'test' });
      this.flash('… 正在连模型', true);
      try {
        const c = this.state.cfg;
        const p = c.provider || {};
        const base = String(p.baseUrl || '').trim().replace(/\/+$/, '');
        // 第一步：分类探活（0.16.5）。预检能说出「服务没启动 / 密钥被拒 / 模型名不在列表」，
        // 而下面那条测试翻译只能说「没收到有效译文」—— 用户正是被那句话带去查错地方。
        const pre = await modelPreflight(true);
        lastPreflight = pre;
        // 只差模型名：顺手把接口里能用的列出来，省得用户去别处翻
        if (pre.code === 'nomodel' && base) {
          const lib = await probeOnce(base, '', p.apiKey || '');
          if (lib.ids && lib.ids.length) {
            throw new Error('还差「模型名」。接口里能用的有：' + lib.ids.slice(0, 6).join('、')
              + (lib.ids.length > 6 ? ' 等' : '') + '。挑一个填进「模型名」再点这里');
          }
        }
        const d = describePreflight(pre);
        if (d) throw new Error(d.title + '：' + d.short);
        if (!base) throw new Error('请先填接口地址');
        let model = String(p.model || '').trim() || await core.pickModel(base, p.apiKey || '');
        if (!model) throw new Error('拿不到模型列表，请手动填模型名');
        const probe = Object.assign({}, c, { provider: Object.assign({}, p, { model }), batchSize: 5 });
        const out = await core.translateBatch(probe, {}, ['Dynamic Grass - Next Gen']);
        // translateBatch 失败时不抛异常、只返回含 null 的数组。以前这里照样拼出
        // 「✓ 连接正常（模型: X），示例: 空」——用户按提示去查模型，而真正错的是接口地址。
        // 没拿到有效译文就必须当失败抛，且不做后面的 failCache 复活。
        const got = out && out[0];
        if (!got || got === 'Dynamic Grass - Next Gen') {
          // 走到这里说明地址通、密钥没被拒（预检都过了），不许再让人回去查接口地址。
          // 只剩两类可查：模型类型不对 / 上下文不够。
          throw new Error('接口和密钥都通，但模型没给出译文（查模型是不是对话模型）' + preflightHint());
        }
        // 模型可用 → 只给「暂态失败」重新来过的机会。
        // -1 是已判定不可译的专名（模型两次原样返回），> RETRY_MAX 是重试用尽，
        // 这两类清掉只会让它们再各烧一轮调用、然后照样失败。
        let revived = 0;
        if (failCache && typeof failCache === 'object') {
          for (const k of Object.keys(failCache)) {
            if (k === '_ver') continue;
            const n = failCache[k];
            if (typeof n === 'number' && n > 0 && n <= domTranslator.RETRY_MAX) { delete failCache[k]; revived++; }
          }
          if (revived > 0) saveJson(FAIL_PATH, failCache, 'fail revive');
        }
        // 连接测试通过 = 模型确实活了：顺手叫醒 DOM 层（它可能还卡在 modelDown，
        // 否则界面文本得再等一次 2 分钟探活 —— 用户点这里就是想让它马上好）。
        kickDomLayer('test');
        const msg = `✓ 连接正常（模型：${model}）` + (revived > 0 ? `，${revived} 条已放回重试` : '');
        this.flash(msg, true);
      } catch (e) {
        const msg = '✗ ' + String(e && e.message ? e.message : e).slice(0, 80);
        this.flash(msg, false);
      } finally {
        this.setState({ testing: false, busy: '' });
      }
    }

    render() {
      // L3：计数随 tick 刷新（_lastStatRead 记着上次统计对应的 tick）——
      // 后台在持续写 domCache，面板上的「已缓存 N 条」不能停在打开面板那一刻
      if (this._lastStatRead !== this.state.tick) {
        this._lastStatRead = this.state.tick;
        this.state.stats = {
          dom: Object.keys(domCache).filter((k) => typeof domCache[k] === 'string' && k !== '_ver').length,
          mod: cacheEntryCount(cache),
          fail: Object.keys(failCache).filter((k) => k !== '_ver').length,
        };
      }
      const c = this.state.cfg || {};
      const p = c.provider || {};
      const draft = this.state.draft || {};

      const inputStyle = {
        flex: 1, minWidth: 0, padding: '4px 8px',
        background: 'var(--brand-bg-2, #2d2d2d)', color: 'inherit',
        border: '1px solid var(--brand-border, #555)', borderRadius: 3,
      };
      const row = (label, control) => h('div', {
        key: label, style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
      }, h('label', { style: { width: 150, flexShrink: 0, textAlign: 'right' } }, label), control);

      const mkInput = (value, onChange, ph, type) => h('input', {
        type: type || 'text', value: value == null ? '' : value,
        placeholder: ph || '', style: inputStyle,
        onChange: (e) => onChange(e.target.value),
      });

      const mkCheck = (value, onChange, label) => h('label', {
        style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' },
      },
        h('input', { type: 'checkbox', checked: !!value, onChange: (e) => onChange(e.target.checked) }),
        label);

      const btnStyle = {
        padding: '4px 14px', cursor: 'pointer', borderRadius: 3,
        border: '1px solid var(--brand-border, #666)',
        background: 'var(--brand-bg-3, #3c3c3c)', color: 'inherit',
      };
      const btnStyleBusy = Object.assign({}, btnStyle, { opacity: 0.5, cursor: 'default' });

      /** 数值行：输入框只改草稿，点「应用」或回车才写配置；改过没应用会提示「未应用」 */
      const numRow = (label, key, min, max, hint) => {
        const d = draft[key] == null ? '' : String(draft[key]);
        const dirty = d !== String(c[key] == null ? '' : c[key]);
        return h('div', { key, style: { marginBottom: 8 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('label', { style: { width: 150, flexShrink: 0, textAlign: 'right' } }, label),
            h('input', {
              type: 'text', inputMode: 'numeric', value: d,
              style: Object.assign({}, inputStyle, { flex: '0 0 80px', textAlign: 'center' }),
              onChange: (e) => this.setState({
                draft: Object.assign({}, this.state.draft, { [key]: String(e.target.value).replace(/[^\d]/g, '') }),
              }),
              onKeyDown: (e) => { if (e.key === 'Enter') this.applyNum(key, min, max, label); },
            }),
            h('button', {
              style: dirty ? Object.assign({}, btnStyle, { borderColor: '#e08b2a' }) : btnStyle,
              onClick: () => this.applyNum(key, min, max, label),
            }, '应用'),
            dirty ? h('span', { style: { fontSize: 12, color: '#e08b2a' } },
              c[key] == null
                ? `未应用（当前未设置，将使用默认值 ${DEFAULT_CFG[key] === undefined ? '（无）' : DEFAULT_CFG[key]}）`
                : `未应用（当前已存 ${c[key]}）`) : null,
          ),
          h('div', { style: { margin: '2px 0 0 158px', opacity: 0.6, fontSize: 12, lineHeight: 1.6 } }, hint),
        );
      };

      // 页面内提示已取消：所有操作反馈统一走铃铛，避免同一个结果在屏幕上出现两遍。
      const flashView = null;

      // ── 实时队列面板：正在翻哪条、耗时多久、成功没成功、还剩多少排队 ──
      // 整个面板包在 try 里：这只是个诊断工具，任何异常都不许把设置页带崩
      const queueView = (() => {
        if (!this.state.queueOpen) return null;
        try {
          const L = liveStatus || {};
          const nowMs = Date.now();
          const secs = (ms) => ((ms || 0) / 1000).toFixed(1) + 's';
          const arr = (v) => (Array.isArray(v) ? v : []);
          const inflight = arr(L.inflight);
          const recent = arr(L.recent);
          return h('div', {
            style: {
              margin: '10px 0 0 158px', padding: '8px 10px', borderRadius: 3, fontSize: 12, lineHeight: 1.75,
              border: '1px solid var(--brand-border, #555)', background: 'rgba(127,127,127,0.08)',
              maxHeight: 340, overflow: 'auto',
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 } },
              h('span', { style: { fontWeight: 600 } }, '实时队列 · 当前页面'),
              h('span', {
                style: { cursor: 'pointer', padding: '0 8px', opacity: 0.8, fontSize: 15, lineHeight: 1.2 },
                onClick: () => this.setState({ queueOpen: false }),
                title: '关闭',
              }, '✕')),
            h('div', { style: { opacity: 0.9, marginBottom: 2 } },
              inflight.length > 0
                ? h('span', null,
                  h('b', null, '当前正在翻译 ' + inflight.length + ' 条'),
                  '（' + Math.max(1, Number(L.groups) || 1) + ' 组并发）')
                : h('span', { style: { opacity: 0.8 } }, '当前没有进行中的请求',
                  L.lastDoneAt ? ' · 上次完成 ' + Math.max(0, Math.round((nowMs - L.lastDoneAt) / 1000)) + ' 秒前' : ' · 还没开始翻'),
              h('span', { style: { opacity: 0.7 } },
                ' ｜ 排队 ' + (L.queued || 0) + ' 条 · 并发 ' + (L.lanes || 0) + ' 路')),
            h('div', { style: { opacity: 0.85 } },
              '词库直接命中 ' + (L.hits || 0) + ' 条（不调模型）· 模型翻译 ' + (L.ok || 0) + ' 条 · 失败 ' + (L.fail || 0),
              L.per ? ' · 本批共 ' + L.per + ' 组' : '',
              L.modelDown ? h('span', { style: { color: '#e08b2a' } }, ' ｜ 模型无响应，已暂停重试（每 2 分钟自动探活；点「测试连接」或任意翻译按钮会立刻重试）') : null),
            inflight.length > 0
              ? h('div', null,
                h('div', { style: { opacity: 0.65, margin: '6px 0 2px' } }, '正在发送（每条从真正发出时开始计时）'),
                inflight.slice(0, 12).map((it, i) => h('div', { key: 'if' + i, style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                  h('span', { style: { opacity: 0.5 } }, ' › '),
                  String((it && it.text) || '').slice(0, 90),
                  h('span', { style: { opacity: 0.55 } }, '  ' + secs(nowMs - ((it && it.start) || nowMs))))))
              : null,
            recent.length > 0
              ? h('div', null,
                h('div', { style: { opacity: 0.65, margin: '8px 0 2px' } }, '最近完成'),
                recent.slice(0, 15).map((it, i) => h('div', {
                  key: 'rc' + i, style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
                },
                  h('span', { style: { color: (it && it.ok) ? '#4caf6a' : '#d9534f' } }, (it && it.ok) ? ' ✓ ' : ' ✗ '),
                  String((it && it.text) || '').slice(0, 46),
                  (it && it.ok) ? h('span', { style: { opacity: 0.8 } }, ' → ' + String(it.zh || '').slice(0, 34)) : null,
                  h('span', { style: { opacity: 0.45 } }, '  ' + secs(it && it.ms)))))
              : null,
            h('div', { style: { opacity: 0.5, marginTop: 6 } },
              '失败数一直涨、页面还是英文 → 多半是模型上下文不够（日志里会写 Context size has been exceeded）：把 LM Studio 的 Context Length 调大，或把「每批送翻条数」调小。正在发送的条目卡很久 → 本地 7B 算力不够，并发填成和 LM Studio 的 Parallel Requests 一样。'));
        } catch (e) {
          return h('div', { style: { margin: '10px 0 0 158px', opacity: 0.9 } },
            '队列面板渲染出错（不影响翻译）：' + String(e).slice(0, 60));
        }
      })();

      return h('div', { style: { maxWidth: 760, fontSize: '13px', padding: '8px 0' }, 'data-zh-skip': '1' },
        h('div', { style: { marginBottom: 10, opacity: 0.85 } },
          '把模组列表里的英文名自动翻译成中文。支持本地 LM Studio / Ollama / 任意 OpenAI 兼容云端接口。'),
        row('接口地址 (baseUrl)',
          mkInput(p.baseUrl, (v) => this.save({ provider: Object.assign({}, p, { baseUrl: v }) }),
            '本地: http://127.0.0.1:1234/v1    云端: https://api.xxx.com/v1')),
        row('API Key（本地可留空）',
          mkInput(p.apiKey, (v) => this.save({ provider: Object.assign({}, p, { apiKey: v }) }),
            '本地模型不用填；云接口填 sk-...', 'password')),
        row('模型名（必填）',
          mkInput(p.model, (v) => this.save({ provider: Object.assign({}, p, { model: v }) }),
            '本地多个/云端几十个模型时自动选不可靠，必须指定：如 hy-mt2-7b / deepseek-chat')),
        row('',
          mkCheck(!!c.collectMode, (v) => this.save({ collectMode: v }), '采集模式：把页面上遇到的英文记录到 collected.json（补全固定词表用）')),
        numRow('并发路数', 'concurrency', 1, 10,
          '同时向模型发几个请求。LM Studio 里 Parallel Requests 填几，这里就填几（本地一般 2-4）。填多了只会排队超时，不会更快。'),
        numRow('每批送翻条数', 'batchSize', 1, 50,
          '一次最多把多少条文本交给模型（默认 20 条文本，不是 20 个字）。注意：受本地小模型输出稳定性限制，每组实际最多 12 条，调更大只影响切批策略、不会突破 12。长文本仍会自动按长度再切小批，一般不用改。'),
        row('',
          mkCheck(c.domTranslate !== false, (v) => this.save({ domTranslate: v }), '实验性：实时翻译页面上的英文（浏览页/合集详情/安装说明等）')),
        row('',
          mkCheck(c.autoTranslateOnInstall !== false, (v) => this.save({ autoTranslateOnInstall: v }), '新安装的模组自动翻译')),
        row('',
          mkCheck(!!c.includeCollections, (v) => this.save({ includeCollections: v }), '同时汉化「合集 (Collections)」的名称')),
        row('',
          // 2026-10-26 白盒核实（asar renderer.js @2842013）：Vortex 显示名取
          // customFileName || logicalFileName || fileName || name —— name 优先级最低，
          // 而本扩展每次都会写 customFileName，所以勾这个**通常看不出任何变化**。
          // 旧文案「列表没显示中文时勾选这个」会让人以为它是万能开关，勾了没反应就当成
          // 「翻译又坏了」来报（这几天反复误判的来源之一）。文案必须说清它只在
          // 前三个字段都为空时才兜底生效。
          mkCheck(!!c.writeToNameField, (v) => this.save({ writeToNameField: v }), '兜底：仅当模组名前三个字段都为空时才生效（极少见，一般不必勾选）')),
        h('div', { style: { margin: '10px 0 4px 158px', display: 'flex', gap: 10, flexWrap: 'wrap' } },
          h('button', {
            style: this.state.busy === 'test' ? btnStyleBusy : btnStyle,
            disabled: this.state.busy === 'test',
            onClick: () => this.test(),
          }, this.state.busy === 'test' ? '测试中…' : '测试连接'),
          h('button', {
            style: this.state.busy === 'all' ? btnStyleBusy : btnStyle,
            disabled: this.state.busy === 'all',
            onClick: async () => {
              this.setState({ busy: 'all' });
              this.flash('… 正在补翻缺失的模组名', true);
              try {
                // 「立即翻译」= 只补缺的 / 失败的 / 被放弃的，已有合格译文不动（keepExisting）。
                // 要连旧译文一起推翻重来，用下面那个「清空缓存并全部重翻」。
                Object.keys(failCache).forEach((k) => { delete failCache[k]; });
                saveJson(FAIL_PATH, failCache, 'fail record');
                const r = await translateAllFresh(undefined, undefined, { manual: true, keepExisting: true });
                const s = r || {};
                // 销账（0.16.5 审计补）：_rebuild 是「清空过、还没重建」的欠账标记，
                // 升级自动重建成功后由 clearRebuildFlag 销；手动这条路径跑成功了同样该销 ——
                // 否则标记留在盘上，下次启动还会空跑一轮全量巡检（模型没开时白等 60 秒重试）。
                if (!s.error && cache._rebuild) {
                  delete cache._rebuild;
                  saveJson(CACHE_PATH, cache, 'rebuild flag cleared');
                }
                this.setState({
                  stats: { dom: this.state.stats.dom, mod: cacheEntryCount(cache), fail: this.state.stats.fail },
                });
                // 这几条只写页面内那行字：系统通知已经由 translateAllFresh 内部发过
                // （带失败名单的完整版），再叠一条同义通知就是两条重复提示。
                if (s.error) this.flash('✗ ' + s.error, false, { quiet: true });
                else if (s.none) this.flash('✓ 没有要翻的模组名（列表里已是中文或没有模组）', true, { quiet: true });
                else if (s.failed > 0) this.flash(`✓ ${s.applied} 条成功，${s.failed} 条失败（下次自动重试）`, true, { quiet: true });
                else this.flash(`✓ ${s.applied} 条成功`, true, { quiet: true });
              } catch (e) {
                this.flash('✗ 重翻出错：' + String(e && e.message ? e.message : e).slice(0, 60), false);
              } finally {
                this.setState({ busy: '' });
              }
            },
          }, this.state.busy === 'all' ? '翻译中…' : '立即翻译（只补缺的）'),
          h('button', { style: btnStyle, onClick: async () => {
            try {
              const before = {
                dom: Object.keys(domCache).filter((k) => typeof domCache[k] === 'string' && k !== '_ver').length,
                mod: cacheEntryCount(cache),
                fail: Object.keys(failCache).filter((k) => k !== '_ver').length,
                nf: Object.keys(nameFail).filter((k) => k !== '_ver').length,
              };
              // 保留 _ver：手动清空后同版本内还能从 seed 恢复，删了就会被当成
              // 「跨版本」连 seed 一起跳过（那是升级才有的待遇）
              Object.keys(domCache).forEach((k) => { if (k !== '_ver') delete domCache[k]; });
              saveJson(DOM_CACHE_PATH, domCache, 'dom cache purge');
              // 不能写包内的 domCache.seed.json：扩展目录是只读静态资源区，
              // 写失败时用户会看到「清空了，重启又回来」。改用 userData 里的忽略标记。
              saveJson(SEED_SKIP_PATH, { ver: extVerOf(), at: Date.now() }, 'seed skip write');
              Object.keys(failCache).forEach((k) => delete failCache[k]);
              saveJson(FAIL_PATH, failCache, 'fail cache purge');
              // 保留 _ver 并落戳：升级清空逻辑（cache reset for new version）按 _ver 判断，
              // 手动清完若不留戳，下次重启会被判「跨版本」再清一遍并自动全量重翻
              // —— 每重启一次就白烧一轮模型。留戳 = 只在这次版本内认账。
              Object.keys(cache).forEach((k) => { if (k !== '_ver') delete cache[k]; });
              cache._ver = extVerOf();
              // 同样落 _rebuild：手动清完不点「立即翻译全部」就退出，重启能自动补建，
              // 不会留下「清了却不建」的空缓存。
              cache._rebuild = 1;
              saveJson(CACHE_PATH, cache, 'cache purge');
              // give-up 记账一并清（0.16.5）：按钮写着「清空全部翻译缓存(强制重翻)」，
              // 而 isGivenUp 会让试满 3 次的条目直接跳过模型 —— 不清这份账本，
              // 「强制重翻」对那批条目就是空话。清空后退让状态归零，本轮重新试满。
              nameFail = asDict({ _ver: extVerOf() });
              saveJson(NAME_FAIL_PATH, nameFail, 'nameFail purge');
              // 清空后立刻补回零模型种子。扩展名的译文只有「游戏译名词库 + 固定后缀」
              // 这一个正确来源（整串送模型会翻成「恒星之刃：漩涡扩展包」，实测）；
              // 而 seedExtensionNames 在 autostart 里本轮已经跑过 —— 那时 cache 还有值
              // → 它判「已有合格译文」返 0，不会重跑。不在这里补，下载行的剥尾通道
              // 整轮都查不到东西，只能退回英文（2026-10-25 真机）。
              try { seedExtensionNames(contextRef.api.getState()); } catch (e) { /* 补不上就保持英文 */ }
              resetLiveStatus();
              // 清完必须叫醒 DOM 层：它若还卡在 modelDown，清空后也不会重扫，
              // 用户看到的就是「清了缓存也没用」（0.16.5 补）。
              kickDomLayer('purge');
              const reseeded = cacheEntryCount(cache);
              this.setState({ stats: { dom: 0, mod: reseeded, fail: 0 } });
              this.flash(`✓ 已清空 ${before.dom + before.mod + before.fail + before.nf} 条，开始全部重翻`
                + (reseeded > 0 ? `（扩展名补回 ${reseeded} 条）` : ''), true);
              // 这里以前还有一条内容完全相同的 notify，同 id 会覆盖，属于冗余；已删。
              // 按钮名字写着「并全部重翻」，就必须真的翻。以前这里只清不翻，
              // 提示却写「正在重翻」—— 用户等半天一条都没动（2026-10-29 用户指出）。
              this.setState({ busy: 'all' });
              const rr = await translateAllFresh(undefined, undefined, { manual: true });
              // 重翻成功就把「欠账」标记销掉，否则下次启动还会白跑一轮全量巡检
              // （与上面「立即翻译」那条同一口径）。
              if (rr && !rr.error && cache._rebuild) {
                delete cache._rebuild;
                saveJson(CACHE_PATH, cache, 'rebuild flag cleared');
              }
              if (rr && rr.error) {
                this.flash('✗ 已清空，但重翻没跑起来：' + rr.error, false);
              }
            } catch (e) {
              log('error', 'clear dom cache', String(e));
              this.flash('✗ 清空失败：' + String(e).slice(0, 60), false);
            } finally {
              this.setState({ busy: '' });
            }
          } }, '清空缓存并全部重翻（强制）'),
          h('button', { style: btnStyle, onClick: () => {
            try {
              const n = restoreAll(contextRef.api.getState());
              this.setState({ stats: { dom: this.state.stats.dom, mod: 0, fail: this.state.stats.fail } });
              // 只发一条：flash 已经走铃铛，再 notify 就是同义两条
              this.flash(n > 0 ? `✓ 已还原 ${n} 个模组为英文原名` : '✓ 没有需要还原的模组（现在都是英文原名）', true);
            } catch (e) {
              this.flash('✗ 还原失败：' + String(e).slice(0, 60), false);
            }
          } }, '还原全部英文名'),
          h('button', { style: btnStyle, onClick: () => {
            // 只清用户右键加的那份；出厂词库 gamenames-keep.json 不动
            try {
              const n = clearUserKeep();
              this.flash(n > 0
                ? `✓ 已清空 ${n} 条保留英文，这些名字以后照常翻译`
                : '✓ 保留名单本来就是空的', true);
            } catch (e) {
              this.flash('✗ 清空失败：' + String(e).slice(0, 60), false);
            }
          } }, `清空保留英文词表${userKeepList().length ? `（${userKeepList().length} 条）` : ''}`),
          h('button', { style: btnStyle, onClick: () => {
            try {
              const items = scanUntranslated(40);
              this.setState({ diag: { items, at: Date.now() } });
              this.flash(items.length > 0
                ? `✓ 本页还有 ${items.length} 条英文没翻（见下面清单）`
                : '✓ 本页肉眼范围内没有残留英文（当前页面全部命中）', true);
            } catch (e) {
              this.setState({ diag: null });
              this.flash('✗ 自检失败：' + String(e).slice(0, 60), false);
            }
          } }, '自检：本页还有哪些英文没翻'),
          h('button', {
            style: this.state.queueOpen ? Object.assign({}, btnStyle, { borderColor: '#3f8f4f' }) : btnStyle,
            onClick: () => this.setState({ queueOpen: !this.state.queueOpen, tick: Date.now() }),
          }, (() => {
            const infl = Array.isArray(liveStatus.inflight) ? liveStatus.inflight.length : 0;
            const q = liveStatus.queued || 0;
            const tag = infl > 0 ? `正在翻 ${infl} · 排队 ${q}` : (q > 0 ? `排队 ${q}` : '空闲');
            return (this.state.queueOpen ? '收起实时队列' : '实时队列') + ' · ' + tag;
          })())),
        // 按钮说明：每个按钮旁边都必须能读懂它到底清不清缓存、发不发请求
        h('div', { style: { margin: '0 0 8px 158px', opacity: 0.65, fontSize: 12, lineHeight: 1.85 } },
          h('div', null, '「测试连接」只探模型通不通，不翻任何东西。'),
          h('div', null, '「立即翻译（只补缺的）」补齐当前缺译文的、失败的、被放弃的名字；已有译文与界面文本都不动。'),
          h('div', null, '「清空缓存并全部重翻（强制）」把界面文本与模组名译文一起清掉重来，失败的和已放弃的一并重试；出厂词库、词级固定译名表、模型配置、保留英文名单都不动。'),
          h('div', null, '「还原全部英文名」只把模组显示名改回英文，不删任何译文缓存。'),
          h('div', null, '「清空保留英文词表」只清你自己右键保留的那份，出厂词库不动。'),
          h('div', null, '「自检」列出本页还有哪些英文没翻，只读，不发请求、不改缓存。'),
          h('div', null, '「实时队列」看正在翻哪一条、还剩多少、模型有没有响应；模型挂了会在这里写明。')),
        flashView,
        queueView,
        this.state.diag && this.state.diag.items.length > 0
          ? h('div', {
            style: {
              margin: '10px 0 0 158px', maxHeight: 260, overflow: 'auto', fontSize: 12,
              border: '1px solid var(--brand-border, #555)', borderRadius: 3, padding: '6px 8px', lineHeight: 1.7,
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 } },
              h('span', { style: { opacity: 0.75 } },
                '未翻译清单（原文 → 所在元素 / 判断原因）。若某条一直不翻，把这一行发给我即可定位。'),
              h('span', {
                style: { cursor: 'pointer', padding: '0 8px', opacity: 0.8, fontSize: 15, lineHeight: 1.2, flexShrink: 0 },
                onClick: () => this.setState({ diag: null }),
                title: '关闭',
              }, '✕')),
            this.state.diag.items.map((it, i) => h('div', { key: String(i) + it.text },
              h('span', { style: { opacity: 0.75 } }, it.reason + ' · '),
              h('span', { style: { opacity: 0.55 } }, '<' + it.tag.toLowerCase() + (it.cls ? ' class="' + it.cls + '"' : '') + '> '),
              it.text)))
          : null,

        // ---- 界面语言包 ----
        h('div', { style: { margin: '16px 0 6px 158px', fontWeight: 600 } }, '界面汉化（语言包接管）'),
        h('div', { style: { margin: '0 0 6px 158px', opacity: 0.8, lineHeight: 1.7 } },
          'Vortex 的界面文字走 i18next 语言包，只认一份来源：优先 %APPDATA%\\Vortex\\locales\\zh\\。',
          h('br'),
          '本扩展把全部词条写成一个 common.json 塞进那个最高优先级目录 —— 不依赖、也不需要另装任何中文包。'),
        h('div', { style: { margin: '0 0 8px 158px', opacity: 0.9 } },
          (() => {
            const L = this.state.loc || {};
            const lang = String(L.uiLang || '');
            const zhUi = !lang || /^zh/i.test(lang);
            if (L.active && !zhUi) {
              return h('span', { style: { color: '#e6a23c' } },
                `状态：已接管，但 Vortex 界面语言是「${lang}」—— 语言包不会被加载。`,
                h('br'),
                '去 设置 → 界面 → 语言 选「中文（简体）」，然后重启 Vortex。');
            }
            return L.active
              ? `状态：已接管 · ${(L.manifest && L.manifest.entries) || 0} 条词条 · 单个 common.json${zhUi ? '' : '（界面语言未确认）'}`
              : '状态：未接管（点下方「重建界面语言包」后重启 Vortex）';
          })()),
        h('div', { style: { margin: '0 0 6px 158px', opacity: 0.65, fontSize: 12 } },
          `目标文件：${(this.state.loc && this.state.loc.dir) || '-'}\\common.json`),
        h('div', { style: { margin: '0 0 4px 158px', display: 'flex', gap: 10, flexWrap: 'wrap' } },
          h('button', { style: btnStyle, onClick: () => {
            try {
              const r = ensureLocalePack(false);
              const st = localePack.status({ userData: localePack.resolveUserData(va), selfDir: EXT_DIR });
              this.setState({
                loc: st,
                locMsg: r && r.changed
                  ? `✓ 已重建：${r.entries} 条词条。重启 Vortex 生效。`
                  : `✓ 已是最新（${(r && r.entries) || 0} 条），无需重建。`,
              });
              this.flash(r && r.changed
                ? `✓ 界面语言包已重建：${r.entries} 条词条，重启 Vortex 后生效`
                : `✓ 界面语言包已是最新：${(r && r.entries) || 0} 条，无需重建`, true);
            } catch (e) {
              this.setState({ locMsg: '× 重建失败：' + String(e).slice(0, 60) });
              this.flash('✗ 重建失败：' + String(e).slice(0, 60), false);
            }
          } }, '重建界面语言包'),
          h('button', { style: btnStyle, onClick: () => {
            try {
              const r = localePack.restore({ userData: localePack.resolveUserData(va) });
              const st = localePack.status({ userData: localePack.resolveUserData(va), selfDir: EXT_DIR });
              this.setState({
                loc: st,
                locMsg: r.keptPack
                  ? `未删除 common.json：无法确认它是本扩展写的（manifest 缺失或哈希不符）。如确认要删，请手动删除 ${r.dir} 下的 common.json`
                  : `已移除接管：删除 ${r.removed} 个文件${r.restoredFrom ? '，并已从备份还原' : ''}。重启 Vortex 生效。`,
              });
              this.flash(r.keptPack
                ? '△ 未能确认 common.json 的归属，已保留不动（详见下方说明）'
                : (r.removed > 0
                  ? `✓ 已移除接管：删除 ${r.removed} 个文件${r.restoredFrom ? '，并已从备份还原' : ''}，重启 Vortex 后还原英文界面`
                  : '✓ 本来就没接管，无需移除'), !r.keptPack);
            } catch (e) {
              this.setState({ locMsg: '× 移除失败：' + String(e).slice(0, 60) });
              this.flash('✗ 移除失败：' + String(e).slice(0, 60), false);
            }
          } }, '移除接管（还原）'),
          h('button', { style: btnStyle, onClick: () => {
            try {
              let opened = false;
              try { va.util.opn(EXT_DIR); opened = true; } catch (e) { opened = false; }
              this.flash(opened
                ? `✓ 已在文件管理器中打开：${EXT_DIR}（词库 pack.json 就在里面）`
                : `词库位置：${EXT_DIR}\\pack.json。改完点「重建界面语言包」再重启 Vortex`, true);
            } catch (e) {
              this.flash('✗ 打开失败：' + String(e).slice(0, 60), false);
            }
          } }, '打开词库位置')),
        this.state.locMsg
          ? h('div', { style: { margin: '6px 0 0 158px', opacity: 0.9 } }, this.state.locMsg)
          : null,

        h('div', { style: { margin: '12px 0 0 158px', opacity: 0.7, lineHeight: 1.6 } },
          `内置词库 ${this.state.lexCount} 条（DOM 页面替换词典，按去重键计）· 界面语言包 ${(this.state.loc && this.state.loc.manifest && this.state.loc.manifest.entries) || 0} 条（写入 locales/zh/common.json 的条数，见 manifest.entries），硬编码文案由页面层零延迟替换。`,
          h('br'),
          `已缓存：模组名 ${this.state.stats.mod} 条 · 页面文本 ${this.state.stats.dom} 条 · 放弃(失败3次) ${this.state.stats.fail} 条。`,
          h('br'),
          `缓存命中即不再调用模型、不耗 token。位置：${EXT_DIR}`),
      );
    }
  };
}

// ---------- 扩展入口 ----------

function main(context) {
  contextRef = context;
  try { React = require('react'); } catch (e) {
    log('error', 'react missing', String(e));
  }
  try { va = require('vortex-api'); } catch (e) {
    log('error', 'vortex-api missing', String(e));
    return false;
  }
  // 配置与缓存搬到 userData（扩展目录升级会被覆盖）。失败就继续用扩展目录，不影响功能。
  try {
    const ud = localePack.resolveUserData(va);
    if (ud) { useDataDir(path.join(ud, 'vortex-modname-zh')); migrateFromExtDir(); }
  } catch (e) { log('warn', 'data dir setup', String(e)); }

      // 兜底必须深拷贝：readJson 失败时返回的就是 fallback 本身，
      // 若直接传 DEFAULT_CFG，cfg 会和这个常量变成同一个对象，
      // 后面 cfg.gameTerms 一赋值就把「出厂配置」污染成 746 条游戏名，
      // 之后任何一次保存都会把 30 KB 的术语表写进 config.json。
      cfg = readJson(CONFIG_PATH, null) || JSON.parse(JSON.stringify(DEFAULT_CFG));
      const gameMap = readJson(GAME_NAMES_PATH, {});
      // 术语表去重（游戏译名并进术语表，只作用于运行时，不回写 config.json，
      // 否则每启动一次 config 就胖一圈）
      runtimeTerms = toTermList(gameMap);
      // gameTerms 留到 gameKeep 载入后由 rebuildKeepNames 统一装配（含品牌遮蔽术语）
      // 固定译名表（游戏名）→ DOM 层优先命中，不再过模型
      termExact = new Map();
      for (const k of Object.keys(gameMap)) {
        const v = gameMap[k];
        if (typeof v === 'string' && v) termExact.set(normKey(k).toLowerCase(), v);
      }
      gameKeep = readJson(GAME_KEEP_PATH, []);
      if (!Array.isArray(gameKeep)) gameKeep = [];
      keepNameSet = new Set(gameKeep.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().toLowerCase()));
      // 明确保持英文的名字（gamenames-keep.json）：
      // **不要**写进 domCache 来表达「保持英文」。DOM 层启动自清洗的判据就是
      // 「值等于键 = 假翻译，删掉」，写进去会被同一进程立刻清光，机制等于没有。
      // 改为单独一张 Set 交给 DOM 层，在送翻入口直接短路。
      if (gameKeep.length) log('info', 'keep-en names loaded', { n: gameKeep.length });
      // 用户右键「这个名字保留英文」记的词（userKeep.json，数据目录，升级不丢）——
      // 与词库合并成同一张保英文表由下面的 rebuildKeepNames 统一做
      const userKept0 = (typeof userKeepList === 'function' ? userKeepList() : []).filter((x) => typeof x === 'string' && x.trim());
      if (userKept0.length) log('info', 'user keep names loaded', { n: userKept0.length });
      // 保英文名单（词库 + 用户右键保留）+ 品牌头登记 + 品牌遮蔽术语进 gameTerms 的唯一定装配点
      rebuildKeepNames();
      cache = asDict(readJson(CACHE_PATH, {}));
      // 键一次性规范化：读/写/删都改成 canonicalName 之后，旧键不迁移就等于集体失效
      try {
        const nm = typeof normalizeCacheKeys === 'function' ? normalizeCacheKeys(cache) : 0;
        if (nm > 0) {
          saveJson(CACHE_PATH, cache, 'cache normalize');
          log('info', 'cache keys normalized', { n: nm });
        }
      } catch (e) { log('warn', 'cache key normalize fail', String(e)); }
      // 上次清空后没等到重建就退出了（_rebuild 还烙在 cache.json 上）→ 本次接着建。
      // 标志由重建流程成功收尾时清掉：中途再退还会续，模型没开则留着等下次。
      if (cache._rebuild) cacheRebuildPending = true;
      domCache = asDict(readJson(DOM_CACHE_PATH, {}));
      failCache = asDict(readJson(FAIL_PATH, {}));
      nameFail = asDict(readJson(NAME_FAIL_PATH, {}));
      // 失败账的键也归一化：旧版本记的是原串，新版本查的是规范键，
      // 不迁移就等于「旧账全部失效 → 试满 3 次的条目又开始无限重试」（就是用户投诉的那个循环）
      try {
        const nf = typeof normalizeCacheKeys === 'function' ? normalizeCacheKeys(nameFail) : 0;
        if (nf > 0) { saveJson(NAME_FAIL_PATH, nameFail, 'namefail normalize'); log('info', 'nameFail keys normalized', { n: nf }); }
      } catch (e) { /* 迁移失败不影响主流程 */ }
      wordCache = asDict(readJson(WORD_PATH, {}));
      // P3-2：词级补翻词表里属于保英文名单的词删掉（vortex→漩涡 这类旧账：
      // 补翻管线会把「明确保持英文」的品牌词硬译成中文，与品牌遮蔽机制直接打架）
      {
        const wBefore = Object.keys(wordCache).length;
        for (const wk of Object.keys(wordCache)) {
          if (keepNameSet && keepNameSet.has(String(wk).toLowerCase())) delete wordCache[wk];
        }
        const wDropped = wBefore - Object.keys(wordCache).length;
        if (wDropped) {
          if (saveJson(WORD_PATH, wordCache, 'word cache drop keep-en')) log('info', 'word cache dropped keep-en', { n: wDropped });
        }
      }
      // 词级固定译名并进 wordCache（0.16.3 续 18）：
      // 上面那个循环刚把「保英文名单里的词」从 wordCache 删掉，这里再盖固定译名 ——
      // 顺序不能反，反了会把 plus/ultra 这类刚加进保英文名单的词又写回译文。
      // 只补「还没有」的键；已有且不同的（模型之前翻的）直接用官方译名覆盖，
      // 因为这张表就是「固定翻译」的唯一真理源。
      try {
        let wSeed = 0;
        for (const wk of Object.keys(WORD_FIXES)) {
          if (keepNameSet && keepNameSet.has(String(wk).toLowerCase())) continue;
          if (wordCache[wk] === WORD_FIXES[wk]) continue;
          wordCache[wk] = WORD_FIXES[wk];
          wSeed++;
        }
        if (wSeed) {
          saveJson(WORD_PATH, wordCache, 'word cache write');
          log('info', 'word fixes seeded', { n: wSeed });
        }
      } catch (e) { log('warn', 'word fixes seed fail', String(e)); }
      // 版本标记：升级 → 译文缓存与失败名单整体作废。
      // 旧缓存是旧版本翻译管道的产物，新版本修过的 bug（全角引号/裸粘连/占位符/
      // 占比门槛/回声判定）在旧缓存里照样是坏的，留着等于留着 bug。
      // 用户填的配置在 config.json，不在此列，升级不受影响。
      // （曾经这里还有个 cacheResetFor 进程内变量参与种子恢复判断，重启即丢；
      //   0.16.3 起改为 domCount 实测 + seedSkip 二条件，不依赖任何内存状态）
      try {
        const extVer = (JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'info.json'), 'utf8')).version) || '';
        if (extVer && domCache._ver !== extVer) {
          // 只有「确实有存量译文」才算升级清空。首次安装时 domCache 是空的、_ver 也没有，
          // 这里同样会命中 —— 那种情况下必须放 seed 进来，否则新用户一进来满屏英文。
          const hadDom = Object.keys(domCache).some((k) => k !== '_ver' && typeof domCache[k] === 'string');
          domCache = asDict({ _ver: extVer });
          saveJson(DOM_CACHE_PATH, domCache, 'dom cache write');
          // 堵 seed 回灌（0.16.5 补刀）：seed 恢复段在**同一次启动**里紧跟在本节之后，
          // 判据是 `!skipSeed && domCount === 0`，而上面刚把 domCache 清成空 ——
          // 不写这条，包里那份 40KB 的旧页面译文会立刻被灌回来并盖上 _ver=当前版本，
          // 版本清空等于白做（下次启动 _ver 已匹配，连重试的机会都没有）。
          // seedSkip() 认「seed-skip.json 的 ver === 当前版本」，写一版即视为本次已灌过。
          // 代价：升级后首启页面文本没有种子兜底，按需重翻；seed 从此只服务首次安装。
          if (hadDom) saveJson(SEED_SKIP_PATH, { ver: extVer, at: Date.now() }, 'seed skip on version reset');
          log('info', 'dom cache reset for new version', { version: extVer, hadDom });
        }
        if (extVer && failCache._ver !== extVer) {
          failCache = asDict({ _ver: extVer });
          saveJson(FAIL_PATH, failCache, 'fail cache write');
          log('info', 'fail cache reset for new version', { version: extVer });
        }
        // 模组名缓存同样按版本作废（0.16.5）。前两条只清「页面文本」和「失败名单」，
        // cache.json 从来没被清过 —— 于是老用户升级后继续用旧规则+旧词库翻出来的译名：
        // 这类译名往往已是全中文（`帕尔架构`），needsTranslate 判「不用翻」、
        // healWorthy 判「没残留」→ 两道自愈都不开门，永久固化。
        // 清完在本节末尾置 cacheRebuildPending，由 autostart 自动跑一次
        // translateAllFresh 重建：它的判据是「显示名合格 且 缓存里确有条目」
        // （cachedHas），缓存一空必然全量重翻，翻完由 applyTranslation dispatch 回
        // customFileName，界面跟着变 —— 不需要额外写状态层。
        // 必须写 _ver：老用户 cache.json 没有版本标记，不写就会每次启动被判「跨版本」清一遍。
        if (extVer && cache._ver !== extVer) {
          // _rebuild 落盘（0.16.5 补刀）：cacheRebuildPending 只活在内存里，而重建要等
          // 25 秒才发起 —— 清空后这段时间退出 Vortex，标志就丢了；下次启动 _ver 已匹配，
          // 既不清也不建，缓存空着没人管（界面靠 customFileName 撑着，看不出来）。
          // 所以标志跟 _ver 一起写进 cache.json，启动时读到就续。
          cache = asDict({ _ver: extVer, _rebuild: 1 });
          saveJson(CACHE_PATH, cache, 'cache reset for new version');
          log('info', 'cache reset for new version', { version: extVer });
          cacheRebuildPending = true;
        }
        // give-up 记账（nameFail.json）同样按版本作废（0.16.5）。
        // 它是「这条试满 NAME_FAIL_MAX 次就别再烧模型」的账本，TTL 7 天、**跨版本存活**。
        // 不清就会挡住上面刚加的「清空重翻」：translateAllFresh 里
        // `if (isGivenUp(cacheKeyOf(r.base))) { givenUp++; continue; }` 直接跳过，
        // 老用户那些被放弃过的条目升级后永远重建不到，缓存等于白清。
        // 代价：旧困难条目在新版白试一轮（有界：再失败又重新记账退让，不会无限刷）。
        if (extVer && nameFail._ver !== extVer) {
          nameFail = asDict({ _ver: extVer });
          saveJson(NAME_FAIL_PATH, nameFail, 'nameFail reset for new version');
          log('info', 'nameFail reset for new version', { version: extVer });
        }
      } catch (e) { /* info.json 读不到就跳过 */ }
      // 退避状态跨重启恢复：failCache 只存失败计数、不存时间，dom-translator 的
      // lastFail 是内存 Map，重启后归零 → 重启后立即对同一批失败条目全速重试
      // （配置错误时每次重启都白打一轮请求 + 刷一屏错误日志）。
      // 用 failCache.json 的最后写入时间当「最晚一次失败时刻」的近似：每次
      // saveFail 都会更新它，重启后按 BACKOFF 接着算，零格式改动、零新键。
      let failMtime = 0;
      try { failMtime = fs.statSync(FAIL_PATH).mtime.getTime() || 0; } catch (e) { /* 没有文件就没有失败条目 */ }
      // 发版前按规矩清空了 domCache，但已经翻好的译文没必要跟着丢。
      // 打包时会把清空前的内容留一份 domCache.seed.json，同版本内缓存为空就自动恢复，
      // 这样误清缓存后界面文案立刻还是中文，不必等模型重翻一遍（重翻还经常失败）。
      // **跨版本不恢复**：刚因升级被清空正是为了扔掉旧译文，塞回来等于没清。
      const skipSeed = seedSkip();
      const domCount = Object.keys(domCache).filter((k) => typeof domCache[k] === 'string' && k !== '_ver').length;
      if (!skipSeed && domCount === 0) {
        const seed = readJson(SEED_PATH, {});
        // seed 质检：引号壳/空值/假翻译/占位符丢/伪标签错/引号不配对/BBCode 重复不灌
        const good = {};
        for (const k of Object.keys(seed)) {
          if (k === '_ver' || typeof seed[k] !== 'string') continue;
          if (!seedEntryOk(k, seed[k])) continue;
          // 出厂 seed 是历史快照，里面留着「品牌被硬译」的坏条目
          // （`<i1>Fluffy Mod Manager</i1>` → `绒毛模组管理器`）。词库加进来之后
          // seedEntryOk 那条通用质检看不出这种错，必须单独按品牌判据拦一次，
          // 否则每次启动都把它灌回 domCache，用户看到的就是「词库又没生效」。
          if (brandLost(k, seed[k])) continue;
          good[k] = seed[k];
        }
        const n = Object.keys(good).length;
        if (n > 0) {
          domCache = asDict(good);
          domCache._ver = extVerOf();
          saveJson(DOM_CACHE_PATH, domCache, 'dom cache flush');
          log('info', 'dom cache restored from seed', { n });
        }
      }
  // 品牌被硬译的存量缓存清掉（0.16.3 续 12 那批「剑星漩涡扩展模组」旧账）：
  // 判据是「键里带品牌词、译文里却没有」——译文把品牌翻没了，是坏的，删掉重翻。
  try { purgeBrandTranslations(); } catch (e) { log('warn', 'brand cache purge fail', String(e)); }
  // 缓存清完之后再动状态库：顺序反了会先拿坏缓存把英文名又翻一遍。
  // 但**这里不能调 restoreBrandNames** —— 它第一行是 contextRef.api.getState()，
  // Vortex 在 init 阶段直接拒（"extension uses api in init function"），
  // 整段抛错等于一条都没还原（0.16.3 实测日志实锤）。实际调用点在 autostart 段。

  let extVer = '';
  try { extVer = (JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'info.json'), 'utf8')).version) || ''; } catch (e) { /* ignore */ }
  log('info', 'loaded v' + (extVer || '?'), { dir: EXT_DIR, baseUrl: cfg.provider && cfg.provider.baseUrl });

  // 界面语言包接管：写 %APPDATA%\Vortex\locales\zh\（i18n 只认一份来源，那个目录优先级最高）
  try {
    ensureLocalePack(true);
  } catch (e) {
    log('error', 'locale pack startup', String(e));
  }

  // 设置页：官方签名 registerSettings(group, component, props, visible, priority)
  // 2.8 新版布局下，全局设置页只显示 visible === undefined 的页面，第 4 参必须不传！
  try {
    if (React) {
      context.registerSettings('模组名汉化', makeSettingsComponent(), () => ({}), undefined, 85);
      log('info', 'settings page registered');
    } else {
      log('error', 'settings skipped: react unavailable');
    }
  } catch (e) {
    log('error', 'settings register failed', String(e));
  }

  const reg = (group, pos, icon, title, cb) => {
    try {
      context.registerAction(group, pos, icon, {}, title, cb);
      log('info', 'registered: ' + group, title);
    } catch (e) {
      log('warn', 'register fail ' + group, String(e));
    }
  };

  // 右键动作：300 一键重翻（清缓存）/ 301 翻译此模组（单条）/ 302 保留英文
  // 300 必须包箭头函数：Vortex 会往回调塞 instanceIds，直接传会被当成 want
  reg('mods-action-icons', 300, 'settings', '一键汉化模组名（全部重翻）', () => translateAllFresh(undefined, undefined, { manual: true }));
  reg('mods-action-icons', 301, 'settings', '翻译此模组', translateSelected);
  reg('mods-action-icons', 302, 'settings', '这个名字保留英文（记入词表）', (ids) => {
    // 右键传的是 UUID，先反查出屏幕上那条名字再记（记中文没有意义）
    try {
      const state = contextRef.api.getState();
      const modsRoot = (state.persistent && state.persistent.mods) || {};
      for (const id of normSelection(ids)) {
        for (const g of Object.keys(modsRoot)) {
          for (const mid of Object.keys(modsRoot[g] || {})) {
            const m = modsRoot[g][mid] || {};
            if (mid !== id && String(m.id) !== id) continue;
            const r = keepNameEn(rawNameOf(m) || displayNameOf(m));
            notify(r && r.kept
              ? { id: 'modname-zh-keep', type: 'success', displayMS: 10000, title: '已记入保英文词表', message: '以后不再翻译它' }
              : { id: 'modname-zh-keep', type: 'info', displayMS: 10000, title: '没能解析出名字', message: '换一条再试' });
            return r;
          }
        }
      }
      notify({ id: 'modname-zh-keep', type: 'info', displayMS: 6000, title: '没能解析出名字', message: '只能用在模组行上' });
    } catch (e) { log('warn', 'keep name action', String(e)); }
    return null;
  });
  reg('mods-action-icons', 303, 'settings', '取消保留英文（改回翻译）', (ids) => {
    // 与 302 对称：只认模组行，反查出名字再摘名单，摘完立刻重翻这一条
    try {
      const state = contextRef.api.getState();
      const modsRoot = (state.persistent && state.persistent.mods) || {};
      for (const id of normSelection(ids)) {
        for (const g of Object.keys(modsRoot)) {
          for (const mid of Object.keys(modsRoot[g] || {})) {
            const m = modsRoot[g][mid] || {};
            if (mid !== id && String(m.id) !== id) continue;
            const r = unkeepName(rawNameOf(m) || displayNameOf(m));
            if (!r || !r.removed) {
              notify({ id: 'modname-zh-unkeep', type: 'info', displayMS: 6000, title: '不在保留名单里', message: '这条本来就会翻译' });
              return r;
            }
            notify({ id: 'modname-zh-unkeep', type: 'success', displayMS: 10000, title: '已取消保留英文', message: '正在重翻这一条' });
            // 摘完立刻重翻：不重翻的话界面上仍是英文，用户会以为没生效。
            // retranslateName 内部走 gateModel(自动) 路径，模型没开只会发一条提示，不会假装成功。
            Promise.resolve(retranslateName(r.name)).catch((e) => log('warn', 'unkeep retranslate fail', String(e)));
            return r;
          }
        }
      }
      notify({ id: 'modname-zh-unkeep', type: 'info', displayMS: 6000, title: '没能解析出名字', message: '只能用在模组行上' });
    } catch (e) { log('warn', 'unkeep name action', String(e)); }
    return null;
  });
  reg('btn-toolbar', 300, 'settings', '模组名汉化', () => translateAll({ manual: true }));
  reg('global-toolbar', 300, 'settings', '模组名汉化', () => translateAll({ manual: true }));

  // 新装模组自动汉化（修复：合集下载期间 state 高频变化会不断重置定时器，
  // 改为首次触发后固定延迟执行一次）
  try {
    let scheduled = false;
    // 退避：模型挂机时状态变化会不断触发 autoHook，以前每 5 秒一次全量重试 +
    // 每条失败通知，刷屏且持续打已挂机的模型。现在：挂机直接跳过（等探活恢复）；
    // 一轮翻完有失败就按 5s→30s→2min→10min 退避，成功一批立即归零。
    let hookFails = 0;
    let hookNextAt = 0;
    const HOOK_BACKOFF = [5000, 30000, 120000, 600000];
    const autoHook = () => {
      try {
        if (!cfg || !cfg.enabled || !cfg.autoTranslateOnInstall || scheduled || running) return;
        if (liveStatus && liveStatus.modelDown) return;   // 模型挂机：不白刷
        if (Date.now() < hookNextAt) return;
        const st = context.api.getState();
        const todo = collectTargets(st, null).filter((t) => !t.cached)
          .concat(collectDownloadTargets(st).filter((t) => !t.cached));
        if (todo.length === 0) { hookFails = 0; return; }
        scheduled = true;
        const wait = HOOK_BACKOFF[Math.min(hookFails, HOOK_BACKOFF.length - 1)];
        log('info', 'auto translate scheduled', { todo: todo.length, wait });
        setTimeout(() => {
          scheduled = false;
          const done = (r) => {
            if (r && !r.error && (r.failed || 0) === 0 && ((r.applied || 0) > 0 || r.none)) hookFails = 0;
            else hookFails = Math.min(hookFails + 1, HOOK_BACKOFF.length - 1);
            hookNextAt = Date.now() + HOOK_BACKOFF[hookFails];
          };
          Promise.resolve(translateAll()).then(done).catch(() => {
            hookFails = Math.min(hookFails + 1, HOOK_BACKOFF.length - 1);
            hookNextAt = Date.now() + HOOK_BACKOFF[hookFails];
          });
        }, wait);
      } catch (e) {
        log('warn', 'auto hook inner', String(e));
      }
    };
    // 注册延后：init 阶段 context.api 不可用，onStateChange 静默失效（不抛错、不生效）。
    // 真正绑定在 autostart 段（api 就绪后），见 autoHookRef / autoHookBound。
    autoHookRef = autoHook;
  } catch (e) {
    log('warn', 'auto hook', String(e));
  }

  // DOM 实时翻译层：覆盖浏览页/合集详情/安装说明等所有界面文本（实验性）
  // 抽成幂等函数：整个 DOM 层（扫描器、MutationObserver、重试定时器）是一次性注入的，
  // 启动时关着就不会存在；用户之后在设置页把它打开时必须能补启，否则勾了完全没反应。
  startDomRef = () => {
    if (domStarted) return true;
    try {
      // F2：启动先清 domCache 里的模组名条目（D1 单一缓存源；扩展名豁免）。
      // 必须在 DOM 层首次扫描之前 —— 否则那批条目会被老路径贴上去，又变成两个写者。
      try { pruneDomCacheNames(); } catch (e) { log('warn', 'prune dom cache names fail', String(e)); }
      // 保英文名单的快照源：keepNameEn 右键保留时往 keepEnSetRef 里加词。
      // 传给 DOM 层的是一份拷贝（字面 keepEn: new Set(keepEnSetRef) 是
      // review-fix 第 4 条的契约锚点，别并回去）——同会话内新保留的词靠
      // index 侧 keepNameSet + residueWords 豁免兜底，重启后全量同步。
      keepEnSetRef = new Set(
        [].concat(gameKeep || [], userKeepList()).filter((x) => typeof x === 'string' && x.trim())
      );
      // 审计 v10 发现 3：startDomTranslator 拿不到 body 会明确返回 false（P2-2），
      // 返回值必须接住 —— false 时不能置 domStarted，否则设置页补启条件 (!domStarted)
      // 恒假，该会话 DOM 层静默死亡且无法自救。判据用 === false：undefined（老形态）
      // 按成功，防御性兼容。
      const domRes = domTranslator.startDomTranslator({
        cfg,
        cache: domCache,
        failCache: failCache,
        termExact: termExact,
        keepEn: new Set(keepEnSetRef),
        // 采集是跨会话累积的素材：每次启动都把已有文件读进来，新采的追加在旧素材后面
        collected: readJson(COLLECT_PATH, []),
        statusRef: liveStatus,
        lexicon: lex(),
        translateBatch: core.translateBatch,
        translateConcurrently: core.translateConcurrently,
        // 采集落盘也走 saveJson：DOM 层那一侧是 `try { saveCollect() } catch(e) {}`，
        // 写失败在日志里完全看不见（审计 E5 / N4 同一类问题）。
        saveCollect: (arr) => saveJson(COLLECT_PATH, arr, 'collected'),
        saveFail: (obj) => saveJson(FAIL_PATH, obj, 'dom fail save'),
        lastFailInit: failMtime,
        log,
        save: () => saveJson(DOM_CACHE_PATH, domCache, 'dom cache save'),
        // 名字译文源（cache.json）。右键动作一律走官方 registerAction，DOM 层不接管右键
        nameGate,
        unfinishedName,
        nameTranslationOf: nameTranslationOf,
      });
      const domOk = domRes !== false;
      if (!domOk) {
        log('warn', 'dom layer not started (body not ready); retry via settings toggle');
        return false;
      }
      domStarted = true;
      // kick 只在新形态下拿得到（老形态返回 undefined，按成功处理）
      domKickRef = (domRes && typeof domRes.kick === 'function') ? domRes.kick : null;
      log('info', 'dom layer started');
      return true;
    } catch (e) {
      log('error', 'dom translator start failed', String(e));
      return false;
    }
  };
  if (cfg.domTranslate !== false) startDomRef();

  // 启动时只静默套用缓存（不联网、不弹通知）；新装模组才自动联网翻译
  try {
    setTimeout(() => {
      try {
        // 顺手把 Vortex 内部的「全部支持游戏」列表导出，供词表对账补漏（纯本地，不联网）
        const st = contextRef.api.getState();
        const known = st.session && st.session.gameMode && st.session.gameMode.known;
        if (Array.isArray(known) && known.length > 0) {
          const map = {};
          for (const g of known) { if (g && g.id && g.name) map[g.name] = g.id; }
          // 这是诊断用的对账文件，不是包内静态资源；扩展目录在升级时会被覆盖，
          // 而且可能只读。落到数据目录，和「扩展目录只读」的纪律保持一致。
          saveJson(path.join(DATA_DIR, 'games-available.json'), map, 'games available dump');
          log('info', 'known games dumped', { n: Object.keys(map).length });
        }
        // 出厂配置是空接口地址：装完第一眼就要知道「界面中文已好，模组名还差一步」，
        // 而且要说清差的是哪一步 —— 「缺接口地址」和「有地址没模型名」修法不一样。
        const pv0 = (cfg && cfg.provider) || {};
        const missCfg = !String(pv0.baseUrl || '').trim() ? 'baseUrl'
          : (!String(pv0.model || '').trim() ? 'model' : '');
        if (missCfg && !pendingNotice) {
          pendingNotice = {
            id: 'modname-zh-no-provider',
            type: 'warning',
            title: missCfg === 'baseUrl' ? '还没填翻译接口' : '还差一个模型名',
            message: missCfg === 'baseUrl'
              ? '界面已中文，模组名还翻不了（设置 → 模组名汉化）'
              : '模型名空着（设置 → 模组名汉化）',
          };
          // 上面这条已经把话说清了，别让安装钩子再因同一件事补一条「汉化没有开始」
          preGateNotified[missCfg === 'baseUrl' ? 'noprovider' : 'nomodel'] = 1;
        }
        flushPendingNotice();          // init 阶段攒下的通知，到这里 api 已经可用
        if (cfg && cfg.enabled) {
          // 品牌还原：必须等 api 就绪（init 段调会抛 "extension uses api in init function"，
          // 整段等于没跑——0.16.3 实测「蓬松模组管理器」一直没被还原就是这个原因）。
          // 还原成英文后，下一轮 collectTargets 会把它当未翻条目重新送模型 → 「Fluffy 模组管理器」。
          try {
            const bn = restoreBrandNames(contextRef.api.getState());
            if (bn) log('info', 'brand names restored', { n: bn });
          } catch (e) { log('warn', 'brand name restore fail', String(e)); }
          // 扩展名零模型补种（审计 v4 #5）：`<游戏名> Vortex Extension` 按词库拼，
          // 不写进 cache 的话，DOM 的剥尾贴名通道永远查不到（用户机实测：
          // cache.json 42 条键里含 `Vortex Extension` 的 0 条 → 一条也贴不出来）。
          // 必须在 restoreBrandNames 之后：先还原坏译文，再补正确译文。
          try { seedExtensionNames(contextRef.api.getState()); } catch (e) { log('warn', 'extension seed fail', String(e)); }
          // 自动翻译钩子：init 里注册静默失效，这里才是有效点（api 已可用）。
          if (autoHookRef && !autoHookBound) {
            autoHookBound = true;
            try {
              context.api.onStateChange(['persistent', 'mods'], autoHookRef);
              context.api.onStateChange(['persistent', 'downloads'], autoHookRef);
              log('info', 'auto hook bound');
            } catch (e) { log('warn', 'auto hook bind', String(e)); }
          }
          // 存量结构清洗（v6 配套）已于 2026-10-29 删除：同一次改动给 cache.json 加了
          // 「按 _ver 清空」，升级时缓存必为空 → 这块永远在空对象上遍历，只多一次无意义写盘。
          // 老译名的修复实际是靠「清空 → 全量重翻 → finishOne 里的 repairStruct」达成的。
          // 别再加回来：真要兜某类存量数据，先确认它在清空之后还活着。
          // 词库漂移对账（2026-10-26 用户方案，替代「一键清状态层」）：
          // 词表指纹变了才扫（平时零成本）。漂移条目删缓存键后，随后的
          // 自动翻译 / 立即翻译全部把它当未翻条目重做——走正常管线，
          // 遮蔽自动生效，重翻完成由管线 dispatch 覆盖 customFileName，
          // 状态层从头到尾不被批量改写。删了键 = 普通未翻条目，重试/退让
          // 全部交给既有机制，这里不own重试。
          try {
            const glStamp = glossaryStampOf(wordFixTerms());
            if (cache._gl !== glStamp) {
              const audit = auditGlossaryDrift(cache, wordFixTerms(), core.applyTerms, CJK);
              for (const s of audit.stale) dropTranslation(s.k);
              if (audit.stale.length === 0) {
                // 全干净才落戳：有漂移不落戳，下次启动再审（重翻失败/又被灌回的还能被抓到）
                cache._gl = glStamp;
                saveJson(CACHE_PATH, cache, 'glossary drift audit');
              } else {
                saveJson(CACHE_PATH, cache, 'glossary drift drop');
              }
              log('info', 'glossary drift audit', {
                checked: audit.checked, stale: audit.stale.length,
                stamped: audit.stale.length === 0,
                sample: audit.stale.slice(0, 5),
              });
              // 主动踢管线（2026-10-26 真机实录第三课）：删了键 ≠ 回到未翻队列 ——
              // 「要翻」的判据看状态层（中文=翻过），且 autoHook 只挂在
              // onStateChange 上，启动后 mods/downloads 表没人动它一次都不跑
              // （上一次部署后就是死在这里：audit 打了、管线静默、显示纹丝不动）。
              // ★ 只要执行了重审就踢，不要求本轮 stale>0 —— 上一次启动可能刚删过键
              //   （本次重审 stale=0、只落戳），但状态层的旧译文还在等重翻；
              //   todo 为空时 autoHook 自己空手返回，多踢一次零成本。
              if (autoHookRef) {
                setTimeout(() => {
                  try { autoHookRef(); } catch (e) { log('warn', 'drift auto hook', String(e)); }
                }, 15000);
              }
            }
          } catch (e) { log('warn', 'glossary drift audit', String(e)); }
          applyCachedSilently();
          // 版本清空后的自动重建（0.16.5）：清 cache.json 只是第一步 ——
          // 界面判据看状态层（中文=已翻），不主动踢一次全量重翻，界面纹丝不动。
          // translateAllFresh 的跳过判据是「显示名合格 且 缓存里确有条目」（cachedHas），
          // 缓存刚被清空 → 每条都判「不一致」→ 必然全量重翻 → applyTranslation
          // 写 cache 并 dispatch customFileName，界面从英文/旧译名换成新译名。
          // 只在这里调得到：init 阶段 context.api 未就绪，Vortex 直接拒。
          if (cacheRebuildPending) {
            cacheRebuildPending = false;
            if (liveStatus && liveStatus.modelDown) {
              // 模型挂机时不清空状态层的显示（本来就还在），只是不白烧一轮请求。
              // 落盘标志故意留着：下次带着模型启动时接着建。
              log('warn', 'version rebuild skipped: model down');
              // 但「更新完第一次」还是要交代：模型挂着正是 DOM 层连续两轮 0 成功判出来的，
              // 升级首启撞上它，用户只会看到模组名没换、也不见任何弹窗。探一次拿真实原因，
              // 弹一次（每版本一次）。探活本身不发翻译请求，不烧模型。
              Promise.resolve()
                .then(() => modelPreflight(true))
                .then((r) => {
                  lastPreflight = r;
                  if (!r || r.ok) return;
                  const d = describePreflight(r);
                  if (d) showGateDialogOnce(d, r.code);
                })
                .catch((e) => log('warn', 'gate dialog probe fail', String(e)));
            } else {
              // 重建成功收尾才清 _rebuild：跑完一次（哪怕有条目没过验收）就不再自动重跑，
              // 否则每次启动都白烧一轮全量；中途退出或 running 被占则留着，下次续。
              const clearRebuildFlag = () => {
                if (!cache._rebuild) return;
                delete cache._rebuild;
                try { saveJson(CACHE_PATH, cache, 'rebuild flag cleared'); } catch (e) { /* 清标志失败不影响翻译 */ }
              };
              // 延后 25s：启动期自愈链（healStale* 会调模型）和自动钩子都可能正占着
              // translateAllFresh 的 running 锁，撞上就会返回 error、一条都翻不了。
              const tryRebuild = (attempt) => {
                Promise.resolve()
                  .then(() => translateAllFresh(undefined, undefined, { dialogOnce: true }))
                  .then((r) => {
                    const res = r || {};
                    log('info', 'version rebuild done', Object.assign({ attempt }, res));
                    // 被 running 拒（启动期自动钩子正在翻）→ 再等 60s 补一次。
                    // 不许无限重试：real 失败（模型没开/验收全拒）重试也是白烧。
                    if (res.error) {
                      // 预检拦住（模型没开 / 配置缺）→ 重试必然还是同一个结果，
                      // 直接留 _rebuild 在盘上，等下次带着模型启动再建。
                      if (res.preflight) {
                        log('warn', 'version rebuild held by preflight', { code: res.preflight });
                        return;
                      }
                      if (attempt < 2) setTimeout(() => tryRebuild(attempt + 1), 60000);
                      return;
                    }
                    clearRebuildFlag();
                  })
                  .catch((e) => log('warn', 'version rebuild fail', String(e)));
              };
              setTimeout(() => tryRebuild(1), 25000);
            }
          }
          // 界面自愈（存量半中半英）：异步不阻塞启动；轻伤档有 nameFail 有界退让。
          // 模组显示名 / 下载行两条线都在这一步走完 —— 只修显示名会留下整页下载行英文。
          // 模型晚开是常态（先开 Vortex 再开 LM Studio）：以前探活不过就 return，
          // 这一轮自愈整批作废到下次重启，用户看到的就是「模型开了也不翻」。
          // 现在 60 秒后补做，最多 3 次；每次重取 state（旧快照可能已过期）。
          const runStartupHeal = async (attempt) => {
            let n = 0;
            // 缓存死账先修：DOM 贴的是 cache.json，先把坏的改对，
            // 下面两条状态层通道才不会拿坏译文当基准（顺序反了会白跑一轮）。
            // 这一步不调模型（只查词表），模型没开也照跑。
            n += await healStaleCacheEntries();
            // 下面两条会调模型：先探一次（0.16.5）。模型连不上时硬跑，每条都会被判
            // 「只翻了一半」，记进 nameFail，试满 3 次就永久放弃 —— 等模型开起来时
            // 这些条目已经挂了免战牌，得手动清放弃名单才能救。
            const pre = await modelPreflight(false);
            if (!pre.ok) {
              log('warn', 'startup heal skipped: model not ready', { code: pre.code, attempt });
              if (attempt < 3) {
                setTimeout(() => {
                  runStartupHeal(attempt + 1).catch((e) => log('warn', 'heal retry fail', String(e)));
                }, 60000);
              }
              return n;
            }
            const st = contextRef.api.getState();
            n += await healStaleDisplayNames(st);
            n += await healStaleDownloadNames(st);
            return n;
          };
          runStartupHeal(1)
            .then((n) => { if (n > 0) log('info', 'startup heal done', { n }); })
            .catch((e) => { log('warn', 'heal names fail', String(e)); });
        }
      } catch (e) { log('warn', 'autostart', String(e)); }
    }, 8000);
  } catch (e) {
    log('warn', 'autostart', String(e));
  }

  return true;
}

module.exports = { default: main };
