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
// 以下是随包发布的静态资源，永远读扩展目录
const SEED_PATH = path.join(EXT_DIR, 'domCache.seed.json');
const GAME_NAMES_PATH = path.join(EXT_DIR, 'gamenames.json');
// 明确「保持英文、不要译」的名字（官方就叫英文 / 中文圈没有通用译名）。
// 命中就写进缓存并标记已处理：0 次模型调用，也不会被当成「失败」反复重试。
const GAME_KEEP_PATH = path.join(EXT_DIR, 'gamenames-keep.json');
const PACK_PATH = path.join(EXT_DIR, 'pack.json');

const CJK = /[\u4e00-\u9fa5\u3400-\u4dbf]/;
const LATIN = /[A-Za-z]/;

let React = null;
let contextRef = null;
let va = null;
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
  terms: [],
};
let cfg = JSON.parse(JSON.stringify(DEFAULT_CFG));
let cache = {};
let domCache = {};
let failCache = {};
let termExact = null;
let gameKeep = [];      // 明确保持英文的名字（gamenames-keep.json）
let runtimeTerms = null; // 游戏名对照表（运行时，绝不写回 config.json）
let domStarted = false;  // DOM 层是否已启动（它是一次性注入的，启停不对称）
let startDomRef = null;  // 由 main() 赋值的启动函数，供设置页「打开实时翻译」时补启
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
  SEED_SKIP_PATH = path.join(dir, 'seed-skip.json');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
}

/** 首次切到 userData 时，把扩展目录里已有的配置与译文搬过去（不搬就白翻了） */
function migrateFromExtDir() {
  if (DATA_DIR === EXT_DIR) return 0;
  let n = 0;
  for (const name of ['config.json', 'cache.json', 'domCache.json', 'collected.json', 'failCache.json']) {
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
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function extVerOf() {
  try { return (JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'info.json'), 'utf8')).version) || ''; } catch (e) { return ''; }
}

/** 字典一律用 null 原型。普通对象的 `cache['toString']` 会拿到 Object.prototype.toString，
 *  于是「这段文本已翻译」被判成真、`lex['valueOf']` 甚至会把一个函数写进页面。 */
function asDict(o) {
  const d = Object.create(null);
  if (o && typeof o === 'object') for (const k of Object.keys(o)) d[k] = o[k];
  return d;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJson(file, data) {
  // 写 .tmp 再 rename：writeFileSync 是「先截断再写」，翻译过程中 domCache.json 每 1.2 秒
  // 被整体重写一次，此刻崩溃/断电就留下半截 JSON，下次读回落 {} → 用户攒的译文全丢。
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) { log('error', 'write fail', String(e)); }
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
 *  TW3 这类缩写会静默退回模型猜（译名质量下降且无任何提示）。 */
function mergeRuntimeTerms() {
  if (!runtimeTerms || runtimeTerms.length === 0) return;
  // 放独立键，不碰用户的 cfg.terms：
  // ① 保存设置/重载配置时用户的 16 条不会被 746 条覆盖；
  // ② 746 条不会跟着写进 config.json。
  cfg.gameTerms = runtimeTerms;
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
      const raw = rawNameOf(mod);
      if (!needsTranslate(raw)) continue;
      out.push({ gameId, modId, raw, cached: cache[raw] });
    }
  }
  return out;
}

function collectDownloadTargets(state) {
  const files = (state.persistent && state.persistent.downloads && state.persistent.downloads.files) || {};
  const out = [];
  for (const dlId of Object.keys(files)) {
    const f = files[dlId];
    const raw = f && f.modInfo && f.modInfo.name;
    if (!needsTranslate(raw)) continue;
    out.push({ dlId, raw, cached: cache[raw] });
  }
  return out;
}

function applyTranslation(item, zh) {
  if (item.dlId) return applyDownloadTranslation(item, zh);
  if (!zh) return false;
  const clean = String(zh).replace(/^["'\s]+|["'\s]+$/g, '');
  if (!clean) return false;
  // 译文=原文 = 无需翻译（专名/已中文）。不写 Vortex 持久化状态——originalName 和
  // customFileName 都写成原值没有意义，只在缓存里标记「这条处理过了」。
  if (clean === item.raw) { cache[item.raw] = clean; return true; }
  // dispatch 抛错（action 未注册/状态树异常/初始化竞态）时不写缓存、返回 false：
  // 以前三次 dispatch 无条件写缓存 → 界面还是英文、缓存说翻了，同批次 applied 还虚高。
  // 必需两项（originalName 留底 + customFileName 显示）任一失败就留给下一轮重送
  // （dispatch 幂等，重试安全）；name 字段是可选兜底，失败只记日志不影响判定。
  const okOrig = dispatch('originalName', item.gameId, item.modId, item.raw);
  const okCustom = dispatch('customFileName', item.gameId, item.modId, clean);
  if (cfg.writeToNameField) dispatch('name', item.gameId, item.modId, clean);
  if (!okOrig || !okCustom) return false;
  cache[item.raw] = clean;
  return true;
}

/** 下载条目（尚未安装的模组）也翻名字：官方 action setDownloadModInfo */
function applyDownloadTranslation(item, zh) {
  if (!zh) return false;
  const clean = String(zh).replace(/^["'\s]+|["'\s]+$/g, '');
  if (!clean) return false;
  // 译文=原文 = 无需翻译：不写 Vortex 状态，只标记缓存（同 applyTranslation）
  if (clean === item.raw) { cache[item.raw] = clean; return true; }
  try {
    contextRef.api.store.dispatch(va.actions.setDownloadModInfo(item.dlId, 'name', clean));
    cache[item.raw] = clean;
    return true;
  } catch (e) {
    log('error', 'setDownloadModInfo fail', String(e));
    return false;
  }
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
        if (cache[a.originalName] !== undefined) { delete cache[a.originalName]; dropped++; }
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
  if (Object.keys(dlFiles).length > 0 && Object.keys(cache).length > 0) {
    // 反查表：译文 → cache 键（原名）。同一译文可能对应多个原名，取第一个。
    const rev = new Map();
    for (const k of Object.keys(cache)) {
      const v = cache[k];
      if (typeof v === 'string' && !rev.has(v)) rev.set(v, k);
    }
    for (const dlId of Object.keys(dlFiles)) {
      const f = dlFiles[dlId];
      const cur = f && f.modInfo && f.modInfo.name;
      if (!cur || typeof cur !== 'string') continue;
      const orig = rev.get(cur);
      if (orig !== undefined && !needsTranslate(cur)) {
        // 当前显示名不是英文（是我们的译文）→ 写回原名、删缓存映射。
        // needsTranslate 守卫：防「译文恰好是另一个英文名」时把没翻过的条目改坏。
        try {
          contextRef.api.store.dispatch(va.actions.setDownloadModInfo(dlId, 'name', orig));
          n++;
        } catch (e) {
          log('error', 'setDownloadModInfo restore fail', String(e));
          continue;   // 没写成功就不删缓存，下次还能再试
        }
        if (cache[orig] !== undefined) { delete cache[orig]; dropped++; }
      } else if (cache[cur] !== undefined) {
        // 显示名仍是英文但缓存里有映射（翻过又被 Vortex 重置）→ 只清映射，
        // 否则重启后 applyCachedSilently 又会把中文写回来。
        delete cache[cur]; dropped++;
      }
    }
  }
  if (dropped > 0) writeJson(CACHE_PATH, cache);
  return n;
}

async function translate(list) {
  if (running) {
    notify({ type: 'info', message: '汉化正在运行中，请稍候' });
    return { applied: 0, failed: 0, error: '正在翻译中，请稍候再点' };
  }
  if (!list || list.length === 0) {
    notify({ type: 'info', message: '没有需要汉化的模组名' });
    return { applied: 0, failed: 0, none: true };
  }
  running = true;
  const nid = 'modname-zh-progress';
  try {
    // 必须是「原地改」，不能 cfg = readJson(...)：save() 靠 Object.assign 改同一个对象
    // 才能让 DOM 层立刻读到新配置。换引用后 DOM 层还持有启动时那份，设置项就会「改了不管用」。
    {
      // 兜底不能写 cfg 本身：readJson 失败时返回的就是这个引用，
      // 紧接着把 cfg 的键全删了，Object.assign(cfg, 自己) 等于拿到空对象，
      // 后面就会误报「模组名汉化已在设置中关闭」，并且 DOM 层失去全部配置。
      const raw = readJson(CONFIG_PATH, null);
      const fresh = (raw && typeof raw === 'object') ? raw : JSON.parse(JSON.stringify(DEFAULT_CFG));
      for (const k of Object.keys(cfg)) delete cfg[k];
      Object.assign(cfg, fresh);
      mergeRuntimeTerms();
    }
    if (!cfg.enabled) {
      notify({ type: 'info', message: '模组名汉化已在设置中关闭' });
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
      writeJson(CACHE_PATH, cache);
      notify({ id: nid, type: 'success', message: `模组名汉化：已处理 ${applied} 条（全部命中缓存）` });
      return { applied, failed: 0, cachedOnly: true };
    }

    notify({ id: nid, type: 'info', message: `开始汉化：${pending.length} 条待翻译（模型：${(cfg.provider && cfg.provider.baseUrl) || '?'}）` });

    const lanes = Math.max(1, Math.min(10, cfg.concurrency || 5));
    notify({
      id: nid, type: 'info',
      message: `开始汉化：${pending.length} 条待翻译，${lanes} 路并发（模型：${(cfg.provider && cfg.provider.baseUrl) || '?'}）`,
    });

    const texts = pending.map((p) => p.raw);
    const results = await core.translateConcurrently(cfg, cache, texts, lanes, (done, total) => {
      if (done % 25 === 0 || done === total) {
        notify({ id: nid, type: 'info', message: `汉化进度 ${done}/${total}` });
      }
    });
    for (let k = 0; k < pending.length; k++) {
      if (applyTranslation(pending[k], results[k])) applied++;
      else failed++;
    }
    writeJson(CACHE_PATH, cache);
    log('info', 'done', { applied, failed, lanes });
    if (failed > 0) {
      notify({
        id: nid,
        type: 'warning',
        message: `汉化完成：成功 ${applied}，失败 ${failed}。多数原因是模型接口没开或地址不对，请到 设置 → 模组名汉化 里点「测试连接」`,
      });
    } else {
      notify({ id: nid, type: 'success', message: `汉化完成：成功 ${applied} 条` });
    }
    return { applied, failed };
  } catch (e) {
    log('error', 'translate crashed', String((e && e.stack) || e));
    notify({ id: nid, type: 'error', message: '模组名汉化失败：' + String(e).slice(0, 200) });
    return { applied: 0, failed: 0, error: String(e).slice(0, 180) };
  } finally {
    running = false;
  }
}

function translateAll() {
  const state = contextRef.api.getState();
  return translate(collectTargets(state, null).concat(collectDownloadTargets(state)));
}

function applyCachedSilently() {
  const state = contextRef.api.getState();
  const targets = collectTargets(state, null).concat(collectDownloadTargets(state)).filter((t) => t.cached);
  let n = 0;
  for (const t of targets) {
    if (t.dlId) { if (applyDownloadTranslation(t, t.cached)) n++; continue; }
    const mod = ((state.persistent || {}).mods || {})[t.gameId] || {};
    const cur = (mod[t.modId] && mod[t.modId].attributes && mod[t.modId].attributes.customFileName) || '';
    if (cur === cache[t.raw]) continue;
    if (applyTranslation(t, t.cached)) n++;
  }
  if (n > 0) log('info', 'silent cache applied', { n });
}

// ---------- 界面语言包（接管官方 i18n） ----------

/** pack.json = 唯一的中文词库（构建期已把能收的译文全烧进来） */
function readPack() {
  return readJson(PACK_PATH, {});
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
        notify({
          type: 'info',
          message: `界面语言包已更新（${r.entries} 条词条，单个 common.json），重启 Vortex 后生效`,
          instructions: '重启 Vortex 才会加载新的语言包',
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
      const loaded = readJson(CONFIG_PATH, null) || JSON.parse(JSON.stringify(DEFAULT_CFG));
      this.state = {
        cfg: loaded,
        // 数值输入框的本地草稿：输入过程中不写配置、不做范围纠正，
        // 用户点「应用」才生效。之前边输边 save + clamp，删到空就被打回默认值，字都输不进去
        draft: {
          concurrency: String(loaded.concurrency == null ? DEFAULT_CFG.concurrency : loaded.concurrency),
          batchSize: String(loaded.batchSize == null ? DEFAULT_CFG.batchSize : loaded.batchSize),
        },
        flash: null,        // { text, ok } —— 按钮操作完成后的当场反馈
        queueOpen: false,   // 实时队列面板是否展开
        tick: 0,            // 面板刷新用的心跳（每秒变一次，触发重渲染）
        busy: '',           // 正在执行的按钮 key（执行期间禁用，防重复点）
        testing: false,
        testResult: '',
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
      this._flashTimer = null;
      this._alive = true;
    }

    componentDidMount() {
      try { flushPendingNotice(); } catch (e) { /* ignore */ }
      // 出厂配置是空接口地址（不带作者本机的模型参数），第一次打开设置页得让人知道要填什么，
      // 否则装完看到「界面中文、模组名还是英文」只会以为扩展坏了
      try {
        const c = this.state.cfg || {};
        if (!((c.provider && c.provider.baseUrl) || '').trim()) {
          this.flash('还没填翻译接口地址：界面汉化不受影响，但模组名 / 更新日志不会被翻译。在下面「翻译接口」里填 LM Studio 或云端地址。', false);
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
      if (this._flashTimer) clearTimeout(this._flashTimer);
      if (this._tick) clearInterval(this._tick);
    }

    save(patch) {
      const next = Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_CFG)), this.state.cfg, patch);
      this.setState({ cfg: next });
      writeJson(CONFIG_PATH, next);
      Object.assign(cfg, next); // 保持同一引用，DOM 层与翻译层才能即时读到新配置
      mergeRuntimeTerms();      // 用户在设置页改术语后，游戏名对照不能被 16 条覆盖掉
      // 启动时若关着实时翻译，DOM 层根本没被注入；这里补启，否则勾选后毫无反应
      if (patch && patch.domTranslate === true && !domStarted && typeof startDomRef === 'function') {
        try {
          if (!startDomRef()) this.flash('实时翻译启动失败，看日志 translator.log', false);
        } catch (e) { log('warn', 'dom start on toggle', String(e)); }
      }
      log('info', 'config updated', Object.keys(patch));
    }

    /** 当场反馈：页面内一行绿/红字 + 系统提示，几秒后自动消失 */
    flash(text, ok) {
      if (this._flashTimer) clearTimeout(this._flashTimer);
      if (this._alive) this.setState({ flash: { text, ok: ok !== false } });
      this._flashTimer = setTimeout(() => {
        if (this._alive) this.setState({ flash: null });
      }, 6000);
      try {
        notify({ id: 'modname-zh-flash', type: ok === false ? 'warning' : 'success', message: String(text).replace(/^[✓✗×]\s*/, '') });
      } catch (e) { /* 提示失败不影响主流程 */ }
    }

    /** 数值项：只在点「应用」/ 回车时校验并保存，输入过程不做任何纠正 */
    applyNum(key, min, max, label) {
      const raw = String(this.state.draft[key] == null ? '' : this.state.draft[key]).trim();
      const n = parseInt(raw, 10);
      if (!raw || !isFinite(n) || n <= 0) {
        return this.flash(`✗ ${label}：没填或不是数字，未保存（请输入 ${min}-${max} 的整数）`, false);
      }
      const v = Math.max(min, Math.min(max, n));
      this.save({ [key]: v });
      this.setState({ draft: Object.assign({}, this.state.draft, { [key]: String(v) }) });
      this.flash(`✓ ${label} 已应用：${v}${v !== n ? `（超出 ${min}-${max}，已按边界保存）` : ''}`, true);
    }

    async test() {
      this.setState({ testing: true, busy: 'test' });
      this.flash('… 正在向模型发一条测试文本', true);
      try {
        const c = this.state.cfg;
        const base = String((c.provider && c.provider.baseUrl) || '').replace(/\/+$/, '');
        if (!base) throw new Error('请先填接口地址');
        let model = (c.provider && c.provider.model) || await core.pickModel(base, (c.provider && c.provider.apiKey) || '');
        if (!model) throw new Error('连上了但拿不到模型列表，请手动填「模型名」');
        const probe = Object.assign({}, c, { provider: Object.assign({}, c.provider, { model }), batchSize: 5 });
        const out = await core.translateBatch(probe, {}, ['Dynamic Grass - Next Gen']);
        // translateBatch 失败时不抛异常、只返回含 null 的数组。以前这里照样拼出
        // 「✓ 连接正常（模型: X），示例: 空」——用户按提示去查模型，而真正错的是接口地址。
        // 没拿到有效译文就必须当失败抛，且不做后面的 failCache 复活。
        const got = out && out[0];
        if (!got || got === 'Dynamic Grass - Next Gen') {
          throw new Error('接口或模型不可用：没收到有效译文（请检查接口地址、模型名与密钥）');
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
          if (revived > 0) writeJson(FAIL_PATH, failCache);
        }
        const msg = `✓ 连接正常（模型: ${model}），示例: ${out[0] || '空'}` + (revived > 0 ? `；${revived} 条暂态失败已放回重试` : '');
        this.setState({ testResult: msg });
        this.flash(msg, true);
      } catch (e) {
        const msg = '✗ 连接失败：' + String(e).slice(0, 220);
        this.setState({ testResult: msg });
        this.flash(msg, false);
      } finally {
        this.setState({ testing: false, busy: '' });
      }
    }

    render() {
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

      const flashView = this.state.flash
        ? h('div', {
          style: {
            margin: '10px 0 0 158px', padding: '6px 10px', borderRadius: 3, lineHeight: 1.6,
            border: '1px solid ' + (this.state.flash.ok ? '#3f8f4f' : '#a94442'),
            background: this.state.flash.ok ? 'rgba(63,143,79,0.15)' : 'rgba(169,68,66,0.15)',
          },
        }, this.state.flash.text)
        : null;

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
              L.modelDown ? h('span', { style: { color: '#e08b2a' } }, ' ｜ 模型无响应，已暂停重试（每 2 分钟探活）') : null),
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
            '队列面板渲染出错（不影响翻译）：' + String(e).slice(0, 160));
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
          mkCheck(!!c.writeToNameField, (v) => this.save({ writeToNameField: v }), '列表没显示中文时勾选这个（同时写入 name 字段）')),
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
              this.flash('… 开始翻译全部模组名（完成后会报结果）', true);
              try {
                const r = await translateAll();
                const s = r || {};
                this.setState({
                  stats: { dom: this.state.stats.dom, mod: Object.keys(cache).length, fail: this.state.stats.fail },
                });
                if (s.error) this.flash('✗ ' + s.error, false);
                else if (s.none) this.flash('✓ 没有需要翻译的模组名（列表里已是中文或没有模组）', true);
                else if (s.failed > 0) this.flash(`△ 翻译完成：成功 ${s.applied} 条，失败 ${s.failed} 条。失败多半是模型没开/地址错/模型名不对，可点「测试连接」核对`, false);
                else this.flash(`✓ 翻译完成：成功 ${s.applied} 条`, true);
              } catch (e) {
                this.flash('✗ 翻译失败：' + String(e).slice(0, 180), false);
              } finally {
                this.setState({ busy: '' });
              }
            },
          }, this.state.busy === 'all' ? '翻译中…' : '立即翻译全部'),
          h('button', { style: btnStyle, onClick: () => {
            try {
              const before = {
                dom: Object.keys(domCache).filter((k) => typeof domCache[k] === 'string' && k !== '_ver').length,
                mod: Object.keys(cache).length,
                fail: Object.keys(failCache).filter((k) => k !== '_ver').length,
              };
              // 保留 _ver：手动清空后同版本内还能从 seed 恢复，删了就会被当成
              // 「跨版本」连 seed 一起跳过（那是升级才有的待遇）
              Object.keys(domCache).forEach((k) => { if (k !== '_ver') delete domCache[k]; });
              writeJson(DOM_CACHE_PATH, domCache);
              // 不能写包内的 domCache.seed.json：扩展目录是只读静态资源区，
              // 写失败时用户会看到「清空了，重启又回来」。改用 userData 里的忽略标记。
              writeJson(SEED_SKIP_PATH, { ver: extVerOf(), at: Date.now() });
              Object.keys(failCache).forEach((k) => delete failCache[k]);
              writeJson(FAIL_PATH, failCache);
              Object.keys(cache).forEach((k) => delete cache[k]);
              writeJson(CACHE_PATH, cache);
              resetLiveStatus();
              this.setState({
                stats: { dom: 0, mod: 0, fail: 0 },
                testResult: '',
                flash: {
                  text: `✓ 已清空：页面文本 ${before.dom} 条、模组名 ${before.mod} 条、失败名单 ${before.fail} 条。页面会重新开始翻译（模型没开的话会一直显示英文）`,
                  ok: true,
                },
              });
              notify({ id: 'modname-zh-flash', type: 'success', message: `已清空全部翻译缓存（${before.dom + before.mod} 条），正在重新翻译` });
            } catch (e) {
              log('error', 'clear dom cache', String(e));
              this.setState({ flash: { text: '✗ 清空失败：' + String(e).slice(0, 180), ok: false } });
            }
          } }, '清空全部翻译缓存(强制重翻)'),
          h('button', { style: btnStyle, onClick: () => {
            try {
              const n = restoreAll(contextRef.api.getState());
              this.setState({
                stats: { dom: this.state.stats.dom, mod: 0, fail: this.state.stats.fail },
                flash: { text: n > 0 ? `✓ 已还原 ${n} 个模组为英文原名` : '✓ 没有需要还原的模组（现在都是英文原名）', ok: true },
              });
              notify({ id: 'modname-zh-flash', type: 'success', message: `已还原 ${n} 个模组原名` });
            } catch (e) {
              this.setState({ flash: { text: '✗ 还原失败：' + String(e).slice(0, 180), ok: false } });
            }
          } }, '还原全部英文名'),
          h('button', { style: btnStyle, onClick: () => {
            try {
              const items = scanUntranslated(40);
              this.setState({ diag: { items, at: Date.now() } });
              this.flash(items.length > 0
                ? `✓ 本页还有 ${items.length} 条英文没翻，下面的清单里能看到它们在哪个元素上（含原因）`
                : '✓ 本页肉眼范围内没有残留英文（当前页面全部命中）', true);
            } catch (e) {
              this.setState({ diag: null });
              this.flash('✗ 自检失败：' + String(e).slice(0, 160), false);
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
                flash: {
                  text: r && r.changed
                    ? `✓ 界面语言包已重建：${r.entries} 条词条，重启 Vortex 后生效`
                    : `✓ 界面语言包已是最新：${(r && r.entries) || 0} 条，无需重建`,
                  ok: true,
                },
              });
            } catch (e) {
              this.setState({
                locMsg: '× 重建失败：' + String(e).slice(0, 160),
                flash: { text: '✗ 重建失败：' + String(e).slice(0, 160), ok: false },
              });
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
                flash: {
                  text: r.keptPack
                    ? '△ 未能确认 common.json 的归属，已保留不动（详见左侧说明）'
                    : (r.removed > 0
                      ? `✓ 已移除接管：删除 ${r.removed} 个文件${r.restoredFrom ? '，并已从备份还原' : ''}，重启 Vortex 后还原英文界面`
                      : '✓ 本来就没接管，无需移除'),
                  ok: !r.keptPack,
                },
              });
            } catch (e) {
              this.setState({
                locMsg: '× 移除失败：' + String(e).slice(0, 160),
                flash: { text: '✗ 移除失败：' + String(e).slice(0, 160), ok: false },
              });
            }
          } }, '移除接管（还原）'),
          h('button', { style: btnStyle, onClick: () => {
            try {
              let opened = false;
              try { va.util.opn(EXT_DIR); opened = true; } catch (e) { opened = false; }
              this.setState({
                flash: {
                  text: opened
                    ? `✓ 已在文件管理器中打开：${EXT_DIR}（词库 pack.json 就在里面）`
                    : `词库位置：${EXT_DIR}\\pack.json。改完点「重建界面语言包」再重启 Vortex`,
                  ok: true,
                },
              });
            } catch (e) {
              this.setState({ flash: { text: '✗ 打开失败：' + String(e).slice(0, 160), ok: false } });
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
      cfg.gameTerms = runtimeTerms;
      // 固定译名表（游戏名）→ DOM 层优先命中，不再过模型
      termExact = new Map();
      for (const k of Object.keys(gameMap)) {
        const v = gameMap[k];
        if (typeof v === 'string' && v) termExact.set(normKey(k).toLowerCase(), v);
      }
      gameKeep = readJson(GAME_KEEP_PATH, []);
      if (!Array.isArray(gameKeep)) gameKeep = [];
      // 明确保持英文的名字（gamenames-keep.json）：
      // **不要**写进 domCache 来表达「保持英文」。DOM 层启动自清洗的判据就是
      // 「值等于键 = 假翻译，删掉」，写进去会被同一进程立刻清光，机制等于没有。
      // 改为单独一张 Set 交给 DOM 层，在送翻入口直接短路。
      if (gameKeep.length) log('info', 'keep-en names loaded', { n: gameKeep.length });
      cache = asDict(readJson(CACHE_PATH, {}));
      domCache = asDict(readJson(DOM_CACHE_PATH, {}));
      failCache = asDict(readJson(FAIL_PATH, {}));
      // 版本标记：升级 → 译文缓存与失败名单整体作废。
      // 旧缓存是旧版本翻译管道的产物，新版本修过的 bug（全角引号/裸粘连/占位符/
      // 占比门槛/回声判定）在旧缓存里照样是坏的，留着等于留着 bug。
      // 用户填的配置在 config.json，不在此列，升级不受影响。
      let cacheResetFor = '';
      try {
        const extVer = (JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'info.json'), 'utf8')).version) || '';
        if (extVer && domCache._ver !== extVer) {
          domCache = asDict({ _ver: extVer });
          writeJson(DOM_CACHE_PATH, domCache);
          cacheResetFor = extVer;
          log('info', 'dom cache reset for new version', { version: extVer });
        }
        if (extVer && failCache._ver !== extVer) {
          failCache = asDict({ _ver: extVer });
          writeJson(FAIL_PATH, failCache);
          log('info', 'fail cache reset for new version', { version: extVer });
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
      const seedSkip = readJson(SEED_SKIP_PATH, null);
      const skipSeed = !!(seedSkip && (!seedSkip.ver || seedSkip.ver === extVerOf()));
      if (!cacheResetFor && !skipSeed && Object.keys(domCache).filter((k) => typeof domCache[k] === 'string' && k !== '_ver').length === 0) {
        const seed = readJson(SEED_PATH, {});
        const n = Object.keys(seed).filter((k) => typeof seed[k] === 'string' && k !== '_ver').length;
        if (n > 0) {
          domCache = asDict(seed);
          if (domCache._ver === undefined) domCache._ver = extVerOf();
          writeJson(DOM_CACHE_PATH, domCache);
          log('info', 'dom cache restored from seed', { n });
        }
      }
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

  reg('mods-action-icons', 300, 'settings', '一键汉化模组名', translateAll);
  reg('btn-toolbar', 300, 'settings', '模组名汉化', translateAll);
  reg('global-toolbar', 300, 'settings', '模组名汉化', translateAll);

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
    context.api.onStateChange(['persistent', 'mods'], autoHook);
    context.api.onStateChange(['persistent', 'downloads'], autoHook);
  } catch (e) {
    log('warn', 'auto hook', String(e));
  }

  // DOM 实时翻译层：覆盖浏览页/合集详情/安装说明等所有界面文本（实验性）
  // 抽成幂等函数：整个 DOM 层（扫描器、MutationObserver、重试定时器）是一次性注入的，
  // 启动时关着就不会存在；用户之后在设置页把它打开时必须能补启，否则勾了完全没反应。
  startDomRef = () => {
    if (domStarted) return true;
    try {
      domTranslator.startDomTranslator({
        cfg,
        cache: domCache,
        failCache: failCache,
        termExact: termExact,
        keepEn: new Set((gameKeep || []).filter((x) => typeof x === 'string' && x.trim())),
        // 采集是跨会话累积的素材：不载入已有文件，每次启动都会把上次采的清空
        collected: readJson(COLLECT_PATH, []),
        statusRef: liveStatus,
        lexicon: lex(),
        translateBatch: core.translateBatch,
        translateConcurrently: core.translateConcurrently,
        saveCollect: (arr) => writeJson(COLLECT_PATH, arr),
        saveFail: (obj) => writeJson(FAIL_PATH, obj),
        lastFailInit: failMtime,
        log,
        save: () => writeJson(DOM_CACHE_PATH, domCache),
      });
      domStarted = true;
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
          writeJson(path.join(DATA_DIR, 'games-available.json'), map);
          log('info', 'known games dumped', { n: Object.keys(map).length });
        }
        if (!((cfg.provider && cfg.provider.baseUrl) || '').trim() && !pendingNotice) {
          pendingNotice = {
            id: 'modname-zh-no-provider',
            type: 'info',
            message: '汉化扩展已就绪：界面已是中文；模组名 / 更新日志还需要一个翻译接口（设置 → 模组名汉化）。',
          };
        }
        flushPendingNotice();          // init 阶段攒下的通知，到这里 api 已经可用
        if (cfg && cfg.enabled) applyCachedSilently();
      } catch (e) { log('warn', 'autostart', String(e)); }
    }, 8000);
  } catch (e) {
    log('warn', 'autostart', String(e));
  }

  return true;
}

module.exports = { default: main };
