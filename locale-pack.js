'use strict';

/**
 * locale-pack.js —— Vortex 界面语言包「接管」模块（自包含版）
 *
 * 反编译 app.asar 确认的官方机制：
 *   i18n init 参数：fallbackLng:'en'，fallbackNS:'common'，defaultNS:'common'，
 *                   ns:[common, collection, mod_management, ...]
 *   MultiBackend 只认「一个」来源，优先级写死：
 *     1) <userData>/locales/<lang>/           ← 自定义后端，优先级最高
 *     2) 某一个 type==="translation" 的扩展目录下的 <lang>/
 *     3) <安装目录>/resources/locales/<lang>/  （只有 en）
 *
 * 结论（已用 i18next 实测验证）：
 *   因为 fallbackNS === 'common'，只要 common.json 里有全量词条，
 *   任何 namespace 查不到的 key 都会回退到 common → 命中。
 *   ⇒ 一个 common.json 就能覆盖整个应用，不需要按 namespace 拆文件。
 *
 * 所以本模块：
 *   · 不再读别人的汉化包当基底（译文已在构建期烧进 pack.json）；
 *   · 只写 <userData>/locales/zh/common.json 一个文件；
 *   · 顺手清掉历史版本按 ns 拆出来的冗余文件（避免旧内容遮蔽）。
 *
 * 生效时机：i18n 在扩展加载前就 init 完毕，写完必须重启 Vortex。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LANG = 'zh';
const MANIFEST_NAME = '_vortex-modname-zh.json';
const PACK_FILE = 'common.json';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

function listDirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(p, d.name));
  } catch (e) { return []; }
}

/** 解析 %APPDATA%\Vortex（不依赖 vortex-api，任何环境都能跑） */
function resolveUserData(va) {
  const cands = [];
  try {
    if (va && va.util && typeof va.util.getVortexPath === 'function') cands.push(va.util.getVortexPath('userData'));
  } catch (e) { /* ignore */ }
  if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'Vortex'));
  if (process.env.HOME) cands.push(path.join(process.env.HOME, '.config', 'Vortex'));
  for (const c of cands) if (c && isDir(c)) return c;
  return cands[0];
}

/** 别人装的中文包目录（只用于状态展示；不再作为基底） */
function foreignPacks(userData, selfDir) {
  const out = [];
  const self = path.resolve(selfDir || '');
  for (const dir of listDirs(path.join(userData, 'plugins'))) {
    if (path.resolve(dir) === self) continue;
    for (const cand of [path.join(dir, LANG), path.join(dir, 'locales', LANG)]) {
      if (isDir(cand)) out.push(cand);
    }
  }
  return out;
}

function leaves(obj, acc) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, acc);
    else if (typeof v === 'string') acc.add(v);
  }
  return acc;
}

/**
 * 清理历史版本留下的按 namespace 拆分的文件。
 * 只删「内容确实是我们自己写出去的」——判定：该文件所有字符串值都能在我们 pack 里找到。
 */
function cleanupStaleFiles(targetDir, prev) {
  // 只删「manifest 明确记录过是我们写的」那些文件。
  // 以前是按「文件里所有译文都能在我们词库里找到」反推归属，但 pack.json 本身
  // 就是社区中文包合并来的，别人的小体量 ns 文件极易全部命中 → 被静默删掉，
  // 用户看到的是「一部分中文一部分英文」。
  const removed = [];
  const written = (prev && Array.isArray(prev.written)) ? prev.written : [];
  for (const f of written) {
    if (typeof f !== 'string' || f === PACK_FILE || f === MANIFEST_NAME) continue;
    if (!f.endsWith('.json')) continue;
    try { fs.unlinkSync(path.join(targetDir, f)); removed.push(f); } catch (e) { /* ignore */ }
  }
  return removed;
}

/** 备份目录只留最近 3 个，避免长期堆积 */
function pruneBackups(localesDir) {
  try {
    const baks = fs.readdirSync(localesDir).filter((d) => d.startsWith(LANG + '.backup-')).sort();
    while (baks.length > 3) {
      const gone = baks.shift();
      try { fs.rmSync(path.join(localesDir, gone), { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

/**
 * 写入/更新语言包。
 * @returns {{changed:boolean, reason:string, entries:number, dir:string, removed:string[]}}
 */
function build(opts) {
  const { userData, selfDir, pack, log, force } = opts;
  const targetDir = path.join(userData, 'locales', LANG);
  const target = path.join(targetDir, PACK_FILE);
  const manifestPath = path.join(targetDir, MANIFEST_NAME);

  // 空包守卫（review4-M2）：上游解析失败/被清空后误调 build，会把用户机器上的好
  // 语言包整份覆盖成 {}，界面悄悄回到英文且没有备份。空包一律拒写。
  if (!pack || Object.keys(pack).length === 0) {
    if (log) log('error', 'locale pack: empty pack, rebuild refused', {});
    return { changed: false, reason: 'empty-pack', entries: 0, dir: targetDir, removed: [] };
  }

  const payload = JSON.stringify(pack);
  let prevRaw = null;
  try { prevRaw = fs.readFileSync(target, 'utf8'); } catch (e) { /* ignore */ }
  const prev = readJson(manifestPath);

  if (!force && prevRaw === payload && prev && isDir(targetDir)) {
    return { changed: false, reason: 'up-to-date', entries: prev.entries || 0, dir: targetDir, removed: [] };
  }

  // 写入前先确认「磁盘上这份还是我们上次写的那份吗」，不是就先备份。
  // 以前只在首次接管时备份：接管之后再装别的中文包，下次启动会被我们整份覆盖，
  // 而且没有备份、restore 的哈希也对不上 —— 对方那份永久丢失。
  try {
    if (isDir(targetDir)) {
      const curPath = path.join(targetDir, PACK_FILE);
      let foreignFiles = [];
      if (!prev) {
        // 首次接管：目录里别人的 json 都备份（可能是按 namespace 拆分的旧语言包）
        foreignFiles = fs.readdirSync(targetDir).filter((f) => f.endsWith('.json') && f !== MANIFEST_NAME);
      } else if (fs.existsSync(curPath)) {
        const cur = fs.readFileSync(curPath, 'utf8');
        const h = crypto.createHash('sha256').update(cur, 'utf8').digest('hex');
        if (!prev.hash || h !== prev.hash) foreignFiles = [PACK_FILE];   // 被别的包改过
      }
      if (foreignFiles.length > 0) {
        const bak = path.join(userData, 'locales', `${LANG}.backup-${Date.now()}-foreign`);
        fs.mkdirSync(bak, { recursive: true });
        for (const f of foreignFiles) fs.copyFileSync(path.join(targetDir, f), path.join(bak, f));
        if (log) log('info', 'locale pack: backed up foreign files', { bak, files: foreignFiles });
        pruneBackups(path.join(userData, 'locales'));
      }
    }
  } catch (e) {
    // 备份不成功就不要覆盖别人的东西
    if (log) log('error', 'locale pack: backup failed, rebuild aborted', String(e));
    return { changed: false, reason: 'backup-failed', entries: 0, dir: targetDir, removed: [] };
  }

  fs.mkdirSync(targetDir, { recursive: true });
  writeJsonAtomic(target, pack);

  // 一次性迁移：老版本按 namespace 拆文件写（manifest 没有 mode 字段即是老格式）。
  // 残留的 ns 文件会遮蔽 common.json 里的新词条——i18next 先查请求的 ns、找不到才
  // 回退 common，旧 ns 文件里同名 key 的旧译文优先显示。而 cleanupStaleFiles 依赖的
  // manifest.written 对历史用户永远不存在（老 manifest 从来没写过这个字段），
  // 按「manifest 是我们产的旧格式」判定，**先备份再删**，归属存疑也不丢数据。
  let migrated = [];
  if (prev && prev.generator === 'vortex-modname-zh' && !prev.mode) {
    try {
      const leftovers = fs.readdirSync(targetDir)
        .filter((f) => f.endsWith('.json') && f !== PACK_FILE && f !== MANIFEST_NAME);
      if (leftovers.length > 0) {
        const bak = path.join(userData, 'locales', `${LANG}.backup-${Date.now()}-stale`);
        fs.mkdirSync(bak, { recursive: true });
        for (const f of leftovers) fs.copyFileSync(path.join(targetDir, f), path.join(bak, f));
        for (const f of leftovers) {
          try { fs.unlinkSync(path.join(targetDir, f)); migrated.push(f); } catch (e) { /* ignore */ }
        }
        if (log) log('info', 'locale pack: migrated stale ns files', { files: migrated, bak });
        pruneBackups(path.join(userData, 'locales'));
      }
    } catch (e) { if (log) log('warn', 'locale pack: stale migration failed', String(e)); }
  }

  // 新格式 manifest 的 written 里记着我们实际写过的文件；当前版本只写 common.json
  // （这个循环实际是空转），机制留着防止将来又拆文件时留残留。
  const removed = cleanupStaleFiles(targetDir, prev);

  let entries = 0;
  const count = (o) => { for (const k of Object.keys(o)) { const v = o[k]; if (v && typeof v === 'object') count(v); else if (typeof v === 'string') entries++; } };
  count(pack);

  writeJsonAtomic(manifestPath, {
    generator: 'vortex-modname-zh',
    mode: 'single-file',          // 新格式标记：只写 common.json 一个文件
    written: [PACK_FILE],         // 本次实际写出去的文件（供未来版本清理残留）
    migrated,                     // 本次从旧版 ns 拆分格式迁移走的残留文件
    entries,
    bytes: Buffer.byteLength(payload, 'utf8'),
    // 哈希用来回答「现在磁盘上这份 common.json 还是我们写的吗」。
    // 用户之后可能又装/覆盖了别的中文包，那时 restore 不该替别人做决定。
    hash: crypto.createHash('sha256').update(payload, 'utf8').digest('hex'),
    file: PACK_FILE,
    foreign: foreignPacks(userData, selfDir),
    builtAt: new Date().toISOString(),
  });

  return { changed: true, reason: prev ? 'updated' : 'created', entries, dir: targetDir, removed, migrated };
}

/** 移除接管：删掉我们的文件，有备份就还原 */
function restore(opts) {
  const { userData } = opts;
  const targetDir = path.join(userData, 'locales', LANG);
  const manifestPath = path.join(targetDir, MANIFEST_NAME);
  // 只删「确实是我们写的」那份：manifest 里的哈希对得上才动手。
  // 用户可能后来又装了别的中文包（同样叫 common.json），无条件 unlink 等于替别人做决定。
  // manifest 缺失 / 无 hash / 读取出错 → 无法证明归属 → **不动 common.json**，只删 manifest。
  // 以前这三种情况默认 mine=true，会把别人后装的包静默删掉（restore 路径不做备份，
 // 删掉即不可恢复），与 build()「归属不明就不动」的保守策略自相矛盾。
  const manifest = readJson(manifestPath);
  const packPath = path.join(targetDir, PACK_FILE);
  let mine = false;
  try {
    if (manifest && manifest.hash && fs.existsSync(packPath)) {
      const cur = fs.readFileSync(packPath, 'utf8');
      mine = crypto.createHash('sha256').update(cur, 'utf8').digest('hex') === manifest.hash;
    }
  } catch (e) { mine = false; }

  let removed = 0;
  for (const f of (mine ? [PACK_FILE, MANIFEST_NAME] : [MANIFEST_NAME])) {
    try { fs.unlinkSync(path.join(targetDir, f)); removed++; } catch (e) { /* ignore */ }
  }

  let restoredFrom = null;
  try {
    const parent = path.join(userData, 'locales');
    const baks = fs.readdirSync(parent).filter((d) => d.startsWith(LANG + '.backup-')).sort();
    // 只有当「现在这份文件还是我们写的」时才回灌备份。
    // 否则说明用户后来又装了/换了别的中文包，用我们那份旧备份盖回去等于把人家刚装的东西冲掉。
    if (mine && baks.length > 0) {
      const bak = path.join(parent, baks[baks.length - 1]);
      fs.mkdirSync(targetDir, { recursive: true });
      for (const f of fs.readdirSync(bak)) {
        try { fs.copyFileSync(path.join(bak, f), path.join(targetDir, f)); } catch (e) { /* ignore */ }
      }
      restoredFrom = bak;
    }
  } catch (e) { /* ignore */ }

  let emptied = false;
  try {
    if (fs.readdirSync(targetDir).length === 0) { fs.rmdirSync(targetDir); emptied = true; }
  } catch (e) { /* ignore */ }

  // keptPack：磁盘上有 common.json 但我们没能证明是归属自己 → 没删，让调用方告知用户
  const keptPack = !mine && fs.existsSync(packPath);
  return { removed, restoredFrom, emptied, dir: targetDir, keptPack };
}

/** 只读状态（给设置页展示，不写盘） */
function status(opts) {
  const { userData, selfDir } = opts;
  const targetDir = path.join(userData, 'locales', LANG);
  const manifest = readJson(path.join(targetDir, MANIFEST_NAME));
  const active = isDir(targetDir) && fs.existsSync(path.join(targetDir, PACK_FILE));
  return { active, dir: targetDir, manifest, foreign: foreignPacks(userData, selfDir), userData };
}

module.exports = { build, restore, status, resolveUserData, foreignPacks, LANG, PACK_FILE };
