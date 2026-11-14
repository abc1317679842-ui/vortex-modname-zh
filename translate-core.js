'use strict';
// Vortex 模组名汉化扩展：翻译核心（可脱离 Vortex 独立测试）

const http = require('http');
const https = require('https');

function httpRequest(urlStr, method, headers, bodyStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(new Error('bad url: ' + urlStr));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: (u.pathname || '/') + (u.search || ''),
      method: method,
      headers: Object.assign({ Accept: 'application/json' }, headers || {}),
    };
    const req = lib.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.setTimeout(timeoutMs || 120000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr, 'utf8');
    req.end();
  });
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 全大写术语判定：字母 ≥2 且全大写（LOOT / UE4SS / HDT-SMP / F4SE）。
 *  这类词大小写敏感 —— 小写 loot 不该命中品牌 LOOT（③ 实录）；
 *  UE4SS 只有 5 个字母也够，单个字母的术语（如 X）不敏感处理。 */
function termIsAllCaps(en) {
  const L = String(en == null ? '' : en).replace(/[^A-Za-z]/g, '');
  return L.length >= 2 && L === L.toUpperCase();
}

/** 成人向 / 全年龄两族的判定词。两侧都要求「前后不是字母数字」，
 *  否则 `NSFW` 里的 `SFW` 会被当成 SFW（子串陷阱），`NSFWMod` 也会误命中。 */
const ADULT_MARK_I = /(?:^|[^A-Za-z0-9])NSFW(?:[^A-Za-z0-9]|$)|R18|18\+|成人向|成人版|成人内容|色情|工口/i;
const SAFE_MARK_I = /(?:^|[^A-Za-z0-9])SFW(?:[^A-Za-z0-9]|$)|全年龄|全年齢|安全向|一般向/i;

/** 反向缩写对检测（SFW ↔ NSFW）：模型侧语义反转守卫。
 *  和遮罩左边界是**两条独立来路**，别混：
 *    ① 遮罩腰斩：`NSFW` 被 `SFW` 词条遮成 `N『全年龄』`（applyTerms 左边界已修）；
 *    ② 模型幻觉：原文 `SFW`，译文却写成 `NSFW` —— 本判据管这条。实测 1/525：
 *       `Hazu_SFW_CrusaderSkin` → 「更干净的十字军战士皮肤**NSFW**模组」。
 *  判据（确定性，只看两侧的对立词）：
 *    原文有 SFW 且无 NSFW，译文出现成人向词 → 反转；
 *    原文有 NSFW 且无 SFW，译文出现全年龄向词 → 反转。
 *    两侧都没有 / 两侧都有（「无 NSFW 内容」这类对照句）→ 一律不判。
 *  只给 mod 模式：html/ui 是长段落，正文里正反对照是合法写法，
 *  为两个词把一整段退回英文，代价远大于收益。
 *  @returns true = 语义反转，调用方应退回重译 / 保留原文
 */
function sfwInverted(src, zh) {
  const a = String(src == null ? '' : src);
  const b = String(zh == null ? '' : zh);
  if (!b) return false;
  // 子串口径（F-109）：`CompanionDesireSFW` 这种**粘连**写法也要认 —— 边界口径要求
  // 左侧不是字母数字，实测漏掉 `CompanionDesireSFW V0.4 → 伴侣渴望NSFW版`（treat 臂 3 轮全中）。
  // 但必须**先把 NSFW 摘掉再找 SFW**：NSFW 里含 SFW，不摘的话「两侧都有」会永远成立。
  // 语料实测：含 SFW 不含 NSFW 的只有 4 条，边界口径漏的正好这 1 条 → 增量风险≈0。
  const sNsfw = /NSFW/i.test(a);
  const sSfw = /SFW/i.test(a.replace(/NSFW/ig, ' '));
  if (sSfw === sNsfw) return false;          // 两侧都没有 / 两侧都有（对照句）→ 不判
  if (sSfw && ADULT_MARK_I.test(b)) return true;
  if (sNsfw && SAFE_MARK_I.test(b)) return true;
  return false;
}

function applyTerms(text, terms, direction) {
  let out = text;
  // 排序：长词优先（Faster HDT-SMP 必须先于 HDT-SMP，否则长词被切碎）；
  // 同长时全大写品牌优先（LOOT 先于 Loot，否则用户术语把品牌吃掉 —— 组 2 实录）。
  const sorted = (terms || []).slice().sort((a, b) => {
    const d = (b.en || '').length - (a.en || '').length;
    if (d) return d;
    return (termIsAllCaps(b.en) ? 1 : 0) - (termIsAllCaps(a.en) ? 1 : 0);
  });
  // 单条术语的遮罩替换（mask 方向专用）。
  const maskOne = (text, t) => {
    // 右边界不能用 lookahead 表达「后面不是小写字母」：`i` 标志会让字符类 [a-z]
    // 连大写一起匹配，(?![a-z0-9]) 实际等价于 (?![A-Za-z0-9]) —— 实测 GwentCardSwap
    // 里的 Gwent 遮不上。改成匹配后用回调检查下一个字符，语义才可控。
    // 全大写品牌大小写敏感；其余术语大小写不敏感（Grass 要能匹配 grass）。
    const re = new RegExp(escapeRegExp(t.en), termIsAllCaps(t.en) ? 'g' : 'gi');
    // 已遮罩的段不再参与匹配：长词先遮出 『Faster HDT-SMP』 后，短词 HDT-SMP
    // 又会切进去变成 『Faster 『HDT-SMP』』（嵌套遮罩，还原必错）。
    return String(text).split(/(『[^』]*』)/g).map((seg) => {
      if (/^『[^』]*』$/.test(seg)) return seg;
      return seg.replace(re, (hit, offset, whole) => {
        // 左边界：左侧紧贴字母或数字就不是词边界，不能遮。
        // 以前只查右侧，于是「目标词正好落在 token 尾部」时必然腰斩：
        // NSFW←SFW（语义反了）、Approach←Roach、Community Patch←Unity、
        // Space Combat←Ace Combat、SpeedWheelControl←Control、EnRAGE←RAGE、
        // Zenderal←Enderal。现网 2431 条实测 10 条
        // （exp-out/left-boundary-violations.tsv），但 courage / controller / cockroach
        // 这类只是还没进语料，真实影响面远大于 10。
        // 有意接受的代价：WukongUE4SS、ModSummonandMountRoach、JFDAerosteon 这类
        // 全大写/驼峰粘连**会漏遮**。漏遮只留英文，模型大概率还能译对；误遮则会把
        // `Community` 切成 `Comm『Unity』`、把 `Approach` 切成 `App『萝卜』` —— 必错。
        // 所以宁可漏遮，换回数十条正常词不被破坏。
        // 别指望上游先做驼峰拆分：遮罩路径是 applyTerms(原文) 直接进这里
        // （translate-core.js:667），`camelSplitWord` 只在 index.js 的词级补翻里用
        // （处理译文残留），遮罩时**没有**任何 camel 预拆分 —— 实测
        // `applyTerms('ModSummonandMountRoach',[{en:'Roach',fuzzy:true}],'mask')` 不遮。
        // 想靠「命中词首字母大写 + 左邻小写」判驼峰也不成立：EnRAGE(R 大写、左邻 n)、
        // SpeedWheelControl(C 大写、左邻 l) 会一起复活，与左边界要修的东西分不开。
        // 这是**有意的能力回退**（验收里已按「第 2 条作废，记 F-75/F-76」处理）。
        // 只管「左边是不是词边界」，与 fuzzy（右边界）和大小写敏感（另一处逻辑）无关。
        const prev = offset > 0 ? String(whole).charAt(offset - 1) : '';
        if (/[A-Za-z0-9]/.test(prev)) return hit;
        const next = String(whole).charAt(offset + hit.length);
        if (/[A-Za-z0-9]/.test(next)) {
          // fuzzy 档（专名硬遮蔽）：驼峰里的大写照遮 —— `ModSummonandMountRoach`、
          // `GwentCardSwap` 这类连写名字，只要松一侧边界，模型就会自由发挥
          // （实测 Roach→蟑螂、Gwent 保留英文、Oils→油质）。
          // 小写后缀和数字仍然挡住（OilsX 之外，Roachs / oils2 都不遮）。
          // 注意左边界先判：`ModSummonandMountRoach` 里的 Roach 左邻是字母，
          // 这一侧不成立就整条遮不上（见上，属有意回退）；`GwentCardSwap` 的 Gwent 在词首，不受影响。
          if (!(t.fuzzy && /[A-Z]/.test(next))) return hit;
        }
        return '『' + t.zh + '』';
      });
    }).join('');
  };
  for (const t of sorted) {
    if (!t.en || !t.zh) continue;
    if (direction === 'mask') out = maskOne(out, t);
    // 0.20 F-020-06：还原必须用**函数式替换**。以前传字符串 t.zh，词库里只要出现
    // `$&` / `$1` / `$'` / `` $` `` 就会被 String.replace 当替换模式解释（`$&` 展开成
    // 匹配到的整段、`$'` 展开成剩余全文），静默写出错译文且无任何日志。
    // 概率极低（词库是人工维护的中文名），但一旦命中就是「无痕错译」，代价不对称。
    else out = out.replace(new RegExp('『' + escapeRegExp(t.zh) + '』', 'g'), () => t.zh);
  }
  return out;
}

// 少量高频繁体→简体映射：本地小模型偶尔整句吐繁体，这里兜一层
/** 繁 → 简 单字表。数据取自 OpenCC 的 TSCharacters（Apache-2.0，见 THIRD-PARTY-NOTICES.md），
 *  存成紧凑串（繁简交替排列），首次用到再建 Map —— 三千多个键的对象字面量没必要在启动时构造。
 *  以前的表是手写的百来字，缺 `後` `問` `會` `訂` 这些高频字，模型偶尔吐繁体时就漏成半繁半简。 */
const TRAD_PAIRS = '㑯㑔㑳㑇㑶㐹㓨刾㘚㘎㜄㚯㜏㛣㠏㟆㥮㤘㩜㨫㩳㧐㩵擜䁻䀥䃮鿎䊷䌶䋙䌺䋚䌻䋹䌿䋻䌾䍦䍠䎱䎬䙡䙌䜀䜧䝼䞍䥇䦂䥑鿏䥱䥾䦛䦶䦟䦷䯀䯅䰾鲃䱷䲣䱽䲝䲁鳚䲘鳤䴉鹮丟丢並并乾干亂乱亙亘亞亚佇伫佈布佔占併并來来侖仑侶侣侷局俁俣係系俔伣俠侠俥伡俬私倀伥倆俩倈俫倉仓個个們们倖幸倫伦倲㑈偉伟偑㐽側侧偵侦偽伪傌㐷傑杰傖伧傘伞備备傢家傭佣傯偬傳传傴伛債债傷伤傾倾僂偻僅仅僉佥僑侨僕仆僞伪僥侥僨偾僱雇價价儀仪儁俊儂侬億亿儈侩儉俭儎傤儐傧儔俦儕侪儘尽償偿優优儲储儷俪儸㑩儺傩儻傥儼俨兇凶兌兑兒儿兗兖內内兩两冊册冑胄冪幂凈净凍冻凜凛凱凯別别刪删剄刭則则剋克剎刹剗刬剛刚剝剥剮剐剴剀創创剷铲劃划劄札劇剧劉刘劊刽劌刿劍剑劏㓥劑剂劚㔉勁劲動动務务勛勋勝胜勞劳勢势勩勚勱劢勳勋勵励勸劝勻匀匭匦匯汇匱匮區区協协卹恤卻却卽即厙厍厠厕厤历厭厌厲厉厴厣參参叄叁叢丛吒咤吳吴吶呐呂吕咼呙員员唄呗唸念問问啓启啞哑啟启啢唡喎㖞喚唤喪丧喫吃喬乔單单喲哟嗆呛嗇啬嗊唝嗎吗嗚呜嗩唢嗶哔嘆叹嘍喽嘓啯嘔呕嘖啧嘗尝嘜唛嘩哗嘮唠嘯啸嘰叽嘵哓嘸呒嘽啴噁恶噓嘘噚㖊噝咝噠哒噥哝噦哕噯嗳噲哙噴喷噸吨噹当嚀咛嚇吓嚌哜嚐尝嚕噜嚙啮嚥咽嚦呖嚨咙嚮向嚲亸嚳喾嚴严嚶嘤囀啭囁嗫囂嚣囅冁囈呓囉啰囌苏囑嘱囪囱圇囵國国圍围園园圓圆圖图團团垻坝埡垭埰采執执堅坚堊垩堖垴堝埚堯尧報报場场塊块塋茔塏垲塒埘塗涂塚冢塢坞塤埙塵尘塹堑墊垫墜坠墮堕墰坛墳坟墶垯墻墙墾垦壇坛壋垱壎埙壓压壘垒壙圹壚垆壜坛壞坏壟垄壠垅壢坜壩坝壪塆壯壮壺壶壼壸壽寿夠够夢梦夥伙夾夹奐奂奧奥奩奁奪夺奬奖奮奋奼姹妝妆姍姗姦奸娛娱婁娄婦妇婭娅媧娲媯妫媰㛀媼媪媽妈嫋袅嫗妪嫵妩嫺娴嫻娴嫿婳嬀妫嬃媭嬈娆嬋婵嬌娇嬙嫱嬡嫒嬤嬷嬪嫔嬰婴嬸婶孃娘孋㛤孌娈孫孙學学孿孪宮宫寀采寢寝實实寧宁審审寫写寬宽寵宠寶宝將将專专尋寻對对導导尷尴屆届屍尸屓屃屜屉屢屡層层屨屦屬属岡冈峯峰峴岘島岛峽峡崍崃崑昆崗岗崙仑崢峥崬岽嵐岚嵗岁嵾㟥嶁嵝嶄崭嶇岖嶔嵚嶗崂嶠峤嶢峣嶧峄嶨峃嶮崄嶸嵘嶺岭嶼屿嶽岳巋岿巒峦巔巅巖岩巰巯巹卺帥帅師师帳帐帶带幀帧幃帏幓㡎幗帼幘帻幟帜幣币幫帮幬帱幷并幹干幾几庫库廁厕廂厢廄厩廈厦廎庼廕荫廚厨廝厮廟庙廠厂廡庑廢废廣广廩廪廬庐廳厅弒弑弔吊弳弪張张強强彆别彈弹彌弥彎弯彔录彙汇彠彟彥彦彫雕彲彨彿佛後后徑径從从徠徕復复徵征徹彻恆恒恥耻悅悦悞悮悵怅悶闷悽凄惡恶惱恼惲恽惻恻愛爱愜惬愨悫愴怆愷恺愾忾慄栗態态慍愠慘惨慚惭慟恸慣惯慤悫慪怄慫怂慮虑慳悭慶庆慺㥪慼戚慾欲憂忧憊惫憐怜憑凭憒愦憖慭憚惮憤愤憫悯憮怃憲宪憶忆懇恳應应懌怿懍懔懞蒙懟怼懣懑懤㤽懨恹懲惩懶懒懷怀懸悬懺忏懼惧懾慑戀恋戇戆戔戋戧戗戩戬戰战戱戯戲戏戶户扞捍拋抛拚拼挩捝挱挲挾挟捨舍捫扪捱挨捲卷掃扫掄抡掆㧏掗挜掙挣掛挂採采揀拣揚扬換换揮挥揯搄損损搖摇搗捣搧扇搵揾搶抢摑掴摜掼摟搂摯挚摳抠摶抟摺折摻掺撈捞撏挦撐撑撓挠撝㧑撟挢撣掸撥拨撫抚撲扑撳揿撻挞撾挝撿捡擁拥擄掳擇择擊击擋挡擓㧟擔担據据擠挤擡抬擣捣擬拟擯摈擰拧擱搁擲掷擴扩擷撷擺摆擻擞擼撸擽㧰擾扰攄摅攆撵攏拢攔拦攖撄攙搀攛撺攜携攝摄攢攒攣挛攤摊攪搅攬揽敎教敓敚敗败敘叙敵敌數数斂敛斃毙斆敩斕斓斬斩斷断於于旂旗旣既昇升時时晉晋晝昼暈晕暉晖暘旸暢畅暫暂曄晔曆历曇昙曉晓曏向曖暧曠旷曨昽曬晒書书會会朧胧朮术東东枴拐柵栅柺拐査查桿杆梔栀梘枧條条梟枭梲棁棄弃棊棋棖枨棗枣棟栋棡㭎棧栈棲栖棶梾椏桠椲㭏楊杨楓枫楨桢業业極极榘矩榦干榪杩榮荣榲榅榿桤構构槍枪槓杠槤梿槧椠槨椁槮椮槳桨槶椢槼椝樁桩樂乐樅枞樑梁樓楼標标樞枢樢㭤樣样樧榝樫㭴樳桪樸朴樹树樺桦樿椫橈桡橋桥機机橢椭橫横檁檩檉柽檔档檜桧檟槚檢检檣樯檮梼檯台檳槟檸柠檻槛櫃柜櫓橹櫚榈櫛栉櫝椟櫞橼櫟栎櫥橱櫧槠櫨栌櫪枥櫫橥櫬榇櫱蘖櫳栊櫸榉櫻樱欄栏欅榉權权欏椤欒栾欖榄欞棂欽钦歎叹歐欧歟欤歡欢歲岁歷历歸归歿殁殘残殞殒殤殇殨㱮殫殚殭僵殮殓殯殡殰㱩殲歼殺杀殻壳殼壳毀毁毆殴毿毵氂牦氈毡氌氇氣气氫氢氬氩氳氲氾泛汎泛汙污決决沒没沖冲況况泝溯洩泄洶汹浹浃涇泾涗涚涼凉淒凄淚泪淥渌淨净淩凌淪沦淵渊淶涞淺浅渙涣減减渢沨渦涡測测渾浑湊凑湞浈湧涌湯汤溈沩準准溝沟溫温溮浉溳涢溼湿滄沧滅灭滌涤滎荥滙汇滬沪滯滞滲渗滷卤滸浒滻浐滾滚滿满漁渔漊溇漚沤漢汉漣涟漬渍漲涨漵溆漸渐漿浆潁颍潑泼潔洁潙沩潚㴋潛潜潤润潯浔潰溃潷滗潿涠澀涩澆浇澇涝澐沄澗涧澠渑澤泽澦滪澩泶澮浍澱淀澾㳠濁浊濃浓濄㳡濕湿濘泞濚溁濛蒙濜浕濟济濤涛濧㳔濫滥濰潍濱滨濺溅濼泺濾滤瀂澛瀅滢瀆渎瀇㲿瀉泻瀋沈瀏浏瀕濒瀘泸瀝沥瀟潇瀠潆瀦潴瀧泷瀨濑瀰弥瀲潋瀾澜灃沣灄滠灑洒灕漓灘滩灝灏灡㳕灣湾灤滦灧滟灩滟災灾為为烏乌烴烃無无煉炼煒炜煙烟煢茕煥焕煩烦煬炀煱㶽熅煴熒荧熗炝熱热熲颎熾炽燁烨燈灯燉炖燒烧燙烫燜焖營营燦灿燬毁燭烛燴烩燶㶶燻熏燼烬燾焘爍烁爐炉爛烂爭争爲为爺爷爾尔牀床牆墙牘牍牴抵牽牵犖荦犛牦犢犊犧牺狀状狹狭狽狈猙狰猶犹猻狲獁犸獃呆獄狱獅狮獎奖獨独獪狯獫猃獮狝獰狞獱㺍獲获獵猎獷犷獸兽獺獭獻献獼猕玀猡現现琱雕琺珐琿珲瑋玮瑒玚瑣琐瑤瑶瑩莹瑪玛瑲玱璉琏璡琎璣玑璦瑷璫珰璯㻅環环璵玙璸瑸璽玺璿璇瓊琼瓏珑瓔璎瓚瓒甌瓯甕瓮產产産产畝亩畢毕畫画異异畵画當当疇畴疊叠痙痉痠酸痾疴瘂痖瘋疯瘍疡瘓痪瘞瘗瘡疮瘧疟瘮瘆瘲疭瘺瘘瘻瘘療疗癆痨癇痫癉瘅癒愈癘疠癟瘪癡痴癢痒癤疖癥症癧疬癩癞癬癣癭瘿癮瘾癰痈癱瘫癲癫發发皁皂皚皑皰疱皸皲皺皱盃杯盜盗盞盏盡尽監监盤盘盧卢盪荡眞真眥眦眾众睏困睜睁睞睐瞘眍瞜䁖瞞瞒瞶瞆瞼睑矇蒙矓眬矚瞩矯矫硃朱硜硁硤硖硨砗硯砚碕埼碩硕碭砀碸砜確确碼码碽䂵磑硙磚砖磠硵磣碜磧碛磯矶磽硗磾䃅礄硚礎础礙碍礦矿礪砺礫砾礬矾礱砻祕秘祿禄禍祸禎祯禕祎禡祃禦御禪禅禮礼禰祢禱祷禿秃秈籼稅税稈秆稏䅉稜棱稟禀種种稱称穀谷穇䅟穌稣積积穎颖穠秾穡穑穢秽穩稳穫获穭穞窩窝窪洼窮穷窯窑窵窎窶窭窺窥竄窜竅窍竇窦竈灶竊窃竪竖競竞筆笔筍笋筧笕筴䇲箇个箋笺箏筝箚札節节範范築筑篋箧篔筼篠筿篤笃篩筛篳筚簀箦簍篓簑蓑簞箪簡简簣篑簫箫簹筜簽签簾帘籃篮籌筹籔䉤籙箓籛篯籜箨籟籁籠笼籤签籩笾籪簖籬篱籮箩籲吁粵粤糉粽糝糁糞粪糧粮糰团糲粝糴籴糶粜糹纟糾纠紀纪紂纣約约紅红紆纡紇纥紈纨紉纫紋纹納纳紐纽紓纾純纯紕纰紖纼紗纱紘纮紙纸級级紛纷紜纭紝纴紡纺紬䌷紮扎細细紱绂紲绁紳绅紵纻紹绍紺绀紼绋紿绐絀绌終终絃弦組组絅䌹絆绊絎绗結结絕绝絛绦絝绔絞绞絡络絢绚給给絨绒絰绖統统絲丝絳绛絶绝絹绢綁绑綃绡綆绠綈绨綉绣綌绤綏绥綐䌼綑捆經经綜综綞缍綠绿綢绸綣绻綫线綬绶維维綯绹綰绾綱纲網网綳绷綴缀綵彩綸纶綹绺綺绮綻绽綽绰綾绫綿绵緄绲緇缁緊紧緋绯緑绿緒绪緓绬緔绱緗缃緘缄緙缂線线緝缉緞缎締缔緡缗緣缘緦缌編编緩缓緬缅緯纬緱缑緲缈練练緶缏緹缇緻致緼缊縈萦縉缙縊缢縋缒縐绉縑缣縕缊縗缞縛缚縝缜縞缟縟缛縣县縧绦縫缝縭缡縮缩縱纵縲缧縳䌸縴纤縵缦縶絷縷缕縹缥總总績绩繃绷繅缫繆缪繒缯織织繕缮繚缭繞绕繡绣繢缋繩绳繪绘繫系繭茧繮缰繯缳繰缲繳缴繸䍁繹绎繼继繽缤繾缱繿䍀纇颣纈缬纊纩續续纍累纏缠纓缨纔才纖纤纘缵纜缆缽钵罃䓨罈坛罌罂罎坛罰罚罵骂罷罢羅罗羆罴羈羁羋芈羣群羥羟羨羡義义羶膻習习翫玩翬翚翹翘翽翙耬耧耮耢聖圣聞闻聯联聰聪聲声聳耸聵聩聶聂職职聹聍聽听聾聋肅肃脅胁脈脉脛胫脣唇脩修脫脱脹胀腎肾腖胨腡脶腦脑腫肿腳脚腸肠膃腽膕腘膚肤膞䏝膠胶膩腻膽胆膾脍膿脓臉脸臍脐臏膑臘腊臚胪臟脏臠脔臢臜臥卧臨临臺台與与興兴舉举舊旧舖铺舘馆艙舱艤舣艦舰艫舻艱艰艷艳芻刍苧苎茲兹荊荆莊庄莖茎莢荚莧苋華华菴庵菸烟萇苌萊莱萬万萴荝萵莴葉叶葒荭葤荮葦苇葯药葷荤蒐搜蒓莼蒔莳蒕蒀蒞莅蒼苍蓀荪蓆席蓋盖蓮莲蓯苁蓴莼蓽荜蔔卜蔘参蔞蒌蔣蒋蔥葱蔦茑蔭荫蕁荨蕆蒇蕎荞蕒荬蕓芸蕕莸蕘荛蕢蒉蕩荡蕪芜蕭萧蕷蓣薀蕰薈荟薊蓟薌芗薑姜薔蔷薘荙薟莶薦荐薩萨薴苧薵䓓薹苔薺荠藍蓝藎荩藝艺藥药藪薮藭䓖藴蕴藶苈藹蔼藺蔺蘀萚蘄蕲蘆芦蘇苏蘊蕴蘋苹蘚藓蘞蔹蘢茏蘭兰蘺蓠蘿萝虆蔂處处虛虚虜虏號号虧亏虯虬蛺蛱蛻蜕蜆蚬蝕蚀蝟猬蝦虾蝨虱蝸蜗螄蛳螞蚂螢萤螮䗖螻蝼螿螀蟄蛰蟈蝈蟎螨蟣虮蟬蝉蟯蛲蟲虫蟶蛏蟻蚁蠁蚃蠅蝇蠆虿蠍蝎蠐蛴蠑蝾蠔蚝蠟蜡蠣蛎蠨蟏蠱蛊蠶蚕蠻蛮衆众衊蔑術术衕同衚胡衛卫衝冲袞衮袷夹裊袅裏里補补裝装裡里製制複复褌裈褘袆褲裤褳裢褸褛褻亵襇裥襉裥襏袯襖袄襝裣襠裆襤褴襪袜襬摆襯衬襲袭襴襕覈核見见覎觃規规覓觅視视覘觇覡觋覥觍覦觎親亲覬觊覯觏覲觐覷觑覺觉覽览覿觌觀观觴觞觶觯觸触訁讠訂订訃讣計计訊讯訌讧討讨訐讦訒讱訓训訕讪訖讫託托記记訛讹訝讶訟讼訢䜣訣诀訥讷訩讻訪访設设許许訴诉訶诃診诊註注証证詁诂詆诋詎讵詐诈詒诒詔诏評评詖诐詗诇詘诎詛诅詞词詠咏詡诩詢询詣诣試试詩诗詫诧詬诟詭诡詮诠詰诘話话該该詳详詵诜詼诙詿诖誄诔誅诛誆诓誇夸誌志認认誑诳誒诶誕诞誘诱誚诮語语誠诚誡诫誣诬誤误誥诰誦诵誨诲說说説说誰谁課课誶谇誹诽誼谊誾訚調调諂谄諄谆談谈諉诿請请諍诤諏诹諑诼諒谅論论諗谂諛谀諜谍諝谞諞谝諡谥諢诨諤谔諦谛諧谐諫谏諭谕諮咨諱讳諳谙諶谌諷讽諸诸諺谚諼谖諾诺謀谋謁谒謂谓謄誊謅诌謊谎謎谜謐谧謔谑謖谡謗谤謙谦謚谥講讲謝谢謠谣謡谣謨谟謫谪謬谬謭谫謳讴謹谨謾谩譁哗證证譎谲譏讥譖谮識识譙谯譚谭譜谱譟噪譫谵譭毁譯译議议譴谴護护譸诪譽誉譾谫讀读讅谉變变讋詟讌䜩讎雠讒谗讓让讕谰讖谶讚赞讜谠讞谳谿溪豈岂豎竖豐丰豔艳豬猪豶豮貍狸貓猫貙䝙貝贝貞贞貟贠負负財财貢贡貧贫貨货販贩貪贪貫贯責责貯贮貰贳貲赀貳贰貴贵貶贬買买貸贷貺贶費费貼贴貽贻貿贸賀贺賁贲賂赂賃赁賄贿賅赅資资賈贾賊贼賑赈賒赊賓宾賕赇賙赒賚赉賜赐賞赏賠赔賡赓賢贤賣卖賤贱賦赋賧赕質质賫赍賬账賭赌賰䞐賴赖賵赗賺赚賻赙購购賽赛賾赜贄贽贅赘贇赟贈赠贊赞贋赝贍赡贏赢贐赆贓赃贔赑贖赎贗赝贛赣贜赃赬赪趕赶趙赵趨趋趲趱跡迹踐践踰逾踴踊蹌跄蹕跸蹟迹蹠跖蹣蹒蹤踪蹺跷躂跶躉趸躊踌躋跻躍跃躎䟢躑踯躒跞躓踬躕蹰躚跹躡蹑躥蹿躦躜躪躏軀躯車车軋轧軌轨軍军軑轪軒轩軔轫軛轭軟软軤轷軫轸軲轱軸轴軹轵軺轺軻轲軼轶軾轼較较輅辂輇辁輈辀載载輊轾輒辄輓挽輔辅輕轻輛辆輜辎輝辉輞辋輟辍輥辊輦辇輩辈輪轮輬辌輯辑輳辏輸输輻辐輼辒輾辗輿舆轀辒轂毂轄辖轅辕轆辘轉转轍辙轎轿轔辚轟轰轡辔轢轹轤轳辦办辭辞辮辫辯辩農农迴回逕径這这連连週周進进遊游運运過过達达違违遙遥遜逊遞递遠远遡溯適适遲迟遶绕遷迁選选遺遗遼辽邁迈還还邇迩邊边邏逻邐逦郟郏郵邮鄆郓鄉乡鄒邹鄔邬鄖郧鄧邓鄭郑鄰邻鄲郸鄴邺鄶郐鄺邝酇酂酈郦醃腌醖酝醜丑醞酝醟蒏醣糖醫医醬酱醱酦釀酿釁衅釃酾釅酽釋释釐厘釒钅釓钆釔钇釕钌釗钊釘钉釙钋針针釣钓釤钐釦扣釧钏釩钒釵钗釷钍釹钕釺钎釾䥺鈀钯鈁钫鈃钘鈄钭鈅钥鈈钚鈉钠鈍钝鈎钩鈐钤鈑钣鈒钑鈔钞鈕钮鈞钧鈡钟鈣钙鈥钬鈦钛鈧钪鈮铌鈰铈鈳钶鈴铃鈷钴鈸钹鈹铍鈺钰鈽钸鈾铀鈿钿鉀钾鉅巨鉆钻鉈铊鉉铉鉋铇鉍铋鉑铂鉕钷鉗钳鉚铆鉛铅鉞钺鉢钵鉤钩鉦钲鉬钼鉭钽鉳锫鉶铏鉸铰鉺铒鉻铬鉿铪銀银銃铳銅铜銍铚銑铣銓铨銖铢銘铭銚铫銛铦銜衔銠铑銣铷銥铱銦铟銨铵銩铥銪铕銫铯銬铐銱铞銳锐銷销銹锈銻锑銼锉鋁铝鋃锒鋅锌鋇钡鋌铤鋏铗鋒锋鋙铻鋝锊鋟锓鋣铘鋤锄鋥锃鋦锔鋨锇鋩铓鋪铺鋭锐鋮铖鋯锆鋰锂鋱铽鋶锍鋸锯鋼钢錁锞錄录錆锖錇锫錈锩錏铔錐锥錒锕錕锟錘锤錙锱錚铮錛锛錟锬錠锭錡锜錢钱錦锦錨锚錩锠錫锡錮锢錯错録录錳锰錶表錸铼錼镎鍀锝鍁锨鍃锪鍅钫鍆钔鍇锴鍈锳鍊炼鍋锅鍍镀鍔锷鍘铡鍚钖鍛锻鍠锽鍤锸鍥锲鍩锘鍬锹鍰锾鍵键鍶锶鍺锗鍼针鍾钟鎂镁鎄锿鎇镅鎊镑鎌镰鎔镕鎖锁鎘镉鎚锤鎛镈鎡镃鎢钨鎣蓥鎦镏鎧铠鎩铩鎪锼鎬镐鎭镇鎮镇鎰镒鎲镋鎳镍鎵镓鎶鿔鎸镌鎿镎鏃镞鏇旋鏈链鏌镆鏍镙鏐镠鏑镝鏗铿鏘锵鏜镗鏝镘鏞镛鏟铲鏡镜鏢镖鏤镂鏨錾鏰镚鏵铧鏷镤鏹镪鏺䥽鏽锈鐃铙鐋铴鐐镣鐒铹鐓镦鐔镡鐘钟鐙镫鐝镢鐠镨鐥䦅鐦锎鐧锏鐨镄鐫镌鐮镰鐯䦃鐲镯鐳镭鐵铁鐶镮鐸铎鐺铛鐿镱鑄铸鑊镬鑌镔鑑鉴鑒鉴鑔镲鑕锧鑞镴鑠铄鑣镳鑥镥鑭镧鑰钥鑱镵鑲镶鑷镊鑹镩鑼锣鑽钻鑾銮鑿凿钁镢钂镋長长門门閂闩閃闪閆闫閈闬閉闭開开閌闶閎闳閏闰閑闲閒闲間间閔闵閘闸閡阂閣阁閤合閥阀閨闺閩闽閫阃閬阆閭闾閱阅閲阅閶阊閹阉閻阎閼阏閽阍閾阈閿阌闃阒闆板闇暗闈闱闊阔闋阕闌阑闍阇闐阗闒阘闓闿闔阖闕阙闖闯關关闞阚闠阓闡阐闢辟闤阛闥闼陘陉陝陕陞升陣阵陰阴陳陈陸陆陽阳隉陧隊队階阶隕陨際际隨随險险隯陦隱隐隴陇隸隶隻只雋隽雖虽雙双雛雏雜杂雞鸡離离難难雲云電电霑沾霢霡霧雾霽霁靂雳靄霭靆叇靈灵靉叆靚靓靜静靝靔靦腼靨靥鞏巩鞝绱鞦秋鞽鞒韁缰韃鞑韆千韉鞯韋韦韌韧韍韨韓韩韙韪韜韬韝鞲韞韫韻韵響响頁页頂顶頃顷項项順顺頇顸須须頊顼頌颂頎颀頏颃預预頑顽頒颁頓顿頗颇領领頜颌頡颉頤颐頦颏頭头頮颒頰颊頲颋頴颕頷颔頸颈頹颓頻频頽颓顆颗題题額额顎颚顏颜顒颙顓颛顔颜願愿顙颡顛颠類类顢颟顥颢顧顾顫颤顬颥顯显顰颦顱颅顳颞顴颧風风颭飐颮飑颯飒颱台颳刮颶飓颸飔颺飏颻飖颼飕飀飗飄飘飆飙飈飚飛飞飠饣飢饥飣饤飥饦飩饨飪饪飫饫飭饬飯饭飱飧飲饮飴饴飼饲飽饱飾饰飿饳餃饺餄饸餅饼餈糍餉饷養养餌饵餎饹餏饻餑饽餒馁餓饿餕馂餖饾餘余餚肴餛馄餜馃餞饯餡馅館馆餬糊餱糇餳饧餵喂餶馉餷馇餺馎餼饩餾馏餿馊饁馌饃馍饅馒饈馐饉馑饊馓饋馈饌馔饑饥饒饶饗飨饜餍饞馋饢馕馬马馭驭馮冯馱驮馳驰馴驯馹驲駁驳駐驻駑驽駒驹駔驵駕驾駘骀駙驸駛驶駝驼駟驷駡骂駢骈駭骇駰骃駱骆駸骎駿骏騁骋騂骍騅骓騌骔騍骒騎骑騏骐騖骛騙骗騤骙騧䯄騫骞騭骘騮骝騰腾騶驺騷骚騸骟騾骡驀蓦驁骜驂骖驃骠驄骢驅驱驊骅驌骕驍骁驏骣驕骄驗验驚惊驛驿驟骤驢驴驤骧驥骥驦骦驪骊驫骉骯肮髏髅髒脏體体髕髌髖髋髮发鬆松鬍胡鬚须鬢鬓鬥斗鬧闹鬨哄鬩阋鬮阄鬱郁鬹鬶魎魉魘魇魚鱼魛鱽魢鱾魨鲀魯鲁魴鲂魷鱿魺鲄鮁鲅鮃鲆鮊鲌鮋鲉鮍鲏鮎鲇鮐鲐鮑鲍鮒鲋鮓鲊鮚鲒鮜鲘鮝鲞鮞鲕鮣䲟鮦鲖鮪鲔鮫鲛鮭鲑鮮鲜鮳鲓鮶鲪鮺鲝鯀鲧鯁鲠鯇鲩鯉鲤鯊鲨鯒鲬鯔鲻鯕鲯鯖鲭鯗鲞鯛鲷鯝鲴鯡鲱鯢鲵鯤鲲鯧鲳鯨鲸鯪鲮鯫鲰鯰鲶鯴鲺鯷鳀鯽鲫鯿鳊鰁鳈鰂鲗鰃鳂鰆䲠鰈鲽鰉鳇鰌䲡鰍鳅鰏鲾鰐鳄鰒鳆鰓鳃鰛鳁鰜鳒鰟鳑鰠鳋鰣鲥鰥鳏鰧䲢鰨鳎鰩鳐鰭鳍鰮鳁鰱鲢鰲鳌鰳鳓鰵鳘鰷鲦鰹鲣鰺鲹鰻鳗鰼鳛鰾鳔鱂鳉鱅鳙鱈鳕鱉鳖鱒鳟鱔鳝鱖鳜鱗鳞鱘鲟鱝鲼鱟鲎鱠鲙鱣鳣鱤鳡鱧鳢鱨鲿鱭鲚鱯鳠鱷鳄鱸鲈鱺鲡鳥鸟鳧凫鳩鸠鳬凫鳲鸤鳳凤鳴鸣鳶鸢鳾䴓鴆鸩鴇鸨鴉鸦鴒鸰鴕鸵鴛鸳鴝鸲鴞鸮鴟鸱鴣鸪鴦鸯鴨鸭鴯鸸鴰鸹鴴鸻鴷䴕鴻鸿鴿鸽鵁䴔鵂鸺鵃鸼鵐鹀鵑鹃鵒鹆鵓鹁鵜鹈鵝鹅鵠鹄鵡鹉鵪鹌鵬鹏鵮鹐鵯鹎鵰雕鵲鹊鵷鹓鵾鹍鶄䴖鶇鸫鶉鹑鶊鹒鶓鹋鶖鹙鶘鹕鶚鹗鶡鹖鶥鹛鶩鹜鶪䴗鶬鸧鶯莺鶲鹟鶴鹤鶹鹠鶺鹡鶻鹘鶼鹣鶿鹚鷀鹚鷁鹢鷂鹞鷄鸡鷉䴘鷊鹝鷓鹧鷖鹥鷗鸥鷙鸷鷚鹨鷥鸶鷦鹪鷫鹔鷯鹩鷲鹫鷳鹇鷴鹇鷸鹬鷹鹰鷺鹭鷽鸴鸂㶉鸇鹯鸊䴙鸌鹱鸏鹲鸕鸬鸘鹴鸚鹦鸛鹳鸝鹂鸞鸾鹵卤鹹咸鹺鹾鹼碱鹽盐麗丽麥麦麩麸麪面麫面麯曲麴曲麵面麼么麽么黃黄黌黉點点黨党黲黪黴霉黶黡黷黩黽黾黿鼋鼂鼌鼉鼍鼕冬鼴鼹齊齐齋斋齎赍齏齑齒齿齔龀齕龁齗龂齙龅齜龇齟龃齠龆齡龄齣出齦龈齧啮齪龊齬龉齲龋齶腭齷龌龍龙龎厐龐庞龑䶮龔龚龕龛龜龟鿁䜤鿓鿒';
let TRAD_MAP = null;
function tradMap() {
  if (TRAD_MAP) return TRAD_MAP;
  const m = new Map();
  for (let i = 0; i + 1 < TRAD_PAIRS.length; i += 2) m.set(TRAD_PAIRS[i], TRAD_PAIRS[i + 1]);
  TRAD_MAP = m;
  return m;
}

/** BBcode 标签是否成对（只校验常见标签）。
 *  模型实测会把闭合标签写成 HTML 风格（[i]…[/i] → [i]…</i>），
 *  Vortex 的简介是当 BBcode 渲染的，多出来的 </i> 会原样露在界面上。 */
const BB_TAGS = new Set(['b', 'i', 'u', 's', 'list', 'quote', 'code', 'font', 'color', 'size',
  'url', 'img', 'center', 'spoiler', 'table', 'tr', 'td', 'h1', 'h2', 'h3']);
function bbcodeBalanced(s) {
  const re = /\[(\/?)([a-z]+)(?:=[^\]]*)?\]/gi;
  const stack = [];
  let m;
  while ((m = re.exec(String(s)))) {
    const tag = String(m[2]).toLowerCase();
    if (!BB_TAGS.has(tag)) continue;
    if (m[1] === '/') {
      if (stack.length === 0 || stack[stack.length - 1] !== tag) return false;
      stack.pop();
    } else {
      stack.push(tag);
    }
  }
  return stack.length === 0;
}

function toSimplified(s) {
  if (!s) return s;
  const m = tradMap();
  let out = '';
  for (const ch of String(s)) out += m.get(ch) || ch;
  return out;
}

/** 界面整句（长文本）和 MOD 名称要分开用不同提示词，否则长句会被截断 */
function isUiBatch(texts) {
  if (!texts || texts.length === 0) return false;
  const total = texts.reduce((a, t) => a + String(t).length, 0);
  const avg = total / texts.length;
  return avg > 24 || texts.some((t) => String(t).length > 70 || String(t).split(/\s+/).length > 7);
}

/** 全大写名称转 Title Case：小模型对 ALL CAPS 容易拒翻/原样返回，中文译文无大小写问题所以转换无损 */
function normalizeCase(t) {
  const s = String(t);
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 3 && letters === letters.toUpperCase()) {
    return s.toLowerCase().replace(/(^|[\s\-_(\['"\/])([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase());
  }
  return s;
}

/** 遮罩感知的大小写归一：品牌/术语先打成『』再送翻，归一化不许碰遮罩段。
 *  ① 『』内原样保留（UE4SS 不被改成 Ue4ss，否则词库再也匹配不上 —— ④ 实录）；
 *  ② 「是不是全大写」要连遮罩段一起判断：只看拆出来的段会把
 *     VAXIS_『血迹』_Physics 判成「VAXIS_ 全大写」→ 单独改成 Vaxis_（⑤ 实录）；
 *  ③ 混合大小写串整体不动（VAXIS_Blood_Physics_v1.5 原样保留）。 */
function normalizeCaseKeepMasks(t) {
  const s = String(t == null ? '' : t);
  const bare = s.replace(/『[^』]*』/g, '');
  const letters = bare.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3 || letters !== letters.toUpperCase()) return s;
  return s.split(/(『[^』]*』)/g)
    .map((seg) => (/^『[^』]*』$/.test(seg) ? seg : normalizeCase(seg)))
    .join('');
}

/** 专用工具 / 框架 / 脚本扩展器名（0.18 新增）。en === zh：模组名里必须原样保留。
 *
 *  为什么需要：这些词是玩家认路的路标，译成中文就找不到东西了。0.18 实测
 *  （116 条真实 N 网文件名 × 48 个工具、本机 hy-mt2-7b、**走真实链路**即含
 *  cfg.gameTerms 遮罩与「只带本批出现的术语」、**3 轮取均值**）：
 *  **旧版 81.3~83.0% → 本表 97.4%**（新版三轮 95.7 / 98.3 / 98.3，旧版两次三轮 81.3 / 83.0）。
 *  剩下 2 条是 `BodySlide`（遮罩后仍被模型删掉/黏连），其余全部保住。
 *  ⚠ 单轮数字会在 83~98% 之间跳（温度 0.2 也有 ±3 条抖动），**别拿单轮结果当结论**；
 *  裸文本口径（不遮罩、术语表全带）的 68.5% 更不代表生产——它把词库遮罩的功劳算没了。
 *
 *  ⚠ 两处都要用，但**只在 mod 模式**（`mergeToolTerms` 同时服务于提示词与遮罩表）：
 *    ✅ 提示词（术语对照表）：让模型知道这些词是名字，不是待译英文。
 *    ✅ 遮罩表：`cfg.gameTerms` 只覆盖 190 条词库里有的那 29 个工具词，剩下 19 个
 *       （ImprovedUI / EquipmentEX / TTW / ISL / ME3Tweaks / Baka …）只靠提示词管不住。
 *       并进遮罩后 116 条 × 3 轮：88.5% → **95.4%**（三轮一致），且黏连从 2 条降到 **0**。
 *    ⛔ ui / html 模式一律不加：整句遮罩会把长句拆碎（`maskTerms` 分支有注释）。
 *
 *  ⚠ 别再走「全量遮罩 + 不区分是否已在词库」的老路：那个版本（P1P4）在裸文本口径下
 *    保留率更高，但会把 `3BA Bodyslide` 黏成 `3BABodySlide`、`SB UE4SS` 颠倒成
 *    `UE4SS SB`、无据加「版」+12 条、还让别的专名不翻（`Dwemer→带粒子灯的Dwemer提灯`）。
 *
 *  ⚠ 与 BUILTIN_TERMS 上方那条历史教训的区别（别据此删掉本表）：
 *    以前删的是 `SKSE / F4SE / NVSE → 原样保留，不要翻译` —— 那条把**中文指令**写进了
 *    对照表，模型读成「这几个词该译成中文」，于是 SKSE 变成「天空风」。
 *    本表每条都是 `en => en` 同形，模型读到的是「原文就是译文」。0.18 实测有效。
 *
 *  ⚠ 规模硬约束：本表只准放**工具名**，不许把 gamenames-keep.json 那 190 条品牌词并进来。
 *    每条术语约 +17 token：48 条后 mod 提示词 1316 token（8192 余量 6684，4096 余量 2588）；
 *    再叠 190 条 = 4579 token，4096 窗口余量为负，会直接 CTX_OVER 劈批发不出去。 */
const TOOL_TERMS = [
  'ALOT', 'AMUMSS', 'ArchiveXL', 'Baka', 'BepInEx', 'BodySlide', 'CBBE', 'CET',
  'CNS', 'Codeware', 'ContentPatcher', 'DynDOLOD', 'ENB', 'EquipmentEX', 'F4SE',
  'FNIS', 'FOMOD', 'Fluffy', 'ISL', 'ImprovedUI', 'JIP', 'JohnnyGuitar', 'Jotunn',
  'LOOT', 'MCM', 'ME3Tweaks', 'MO2', 'NVSE', 'OBSE', 'OXA', 'QModManager',
  'REFramework', 'RaceMenu', 'Redscript', 'SFSE', 'SKSE', 'SKSE64', 'SMAPI',
  'SkyUI', 'SpaceCore', 'Stracker', 'TTW', 'TexGen', 'TweakXL', 'UE4SS', 'UXM',
  'YUP', 'red4ext',
].map((en) => ({ en, zh: en }));

/** 把 TOOL_TERMS 并进术语表 / 遮罩表（mod 模式专用）。已有同名词条不覆盖（用户自定义优先）。 */
function mergeToolTerms(terms) {
  const list = (terms || []).slice();
  const seen = new Set();
  for (const t of list) {
    const k = String((t && t.en) || '').trim().toLowerCase();
    if (k) seen.add(k);
  }
  for (const t of TOOL_TERMS) {
    if (seen.has(t.en.toLowerCase())) continue;
    list.push(t);
  }
  return list;
}

/** 内置对照：写死在提示词里，不依赖用户术语表。
 *  模型对缩写极易认错（实测 TW3 被当成《上古卷轴3》，用户的合集名一半带 TW3），
 *  这种错误用后处理救不回来，只能在提示词里先钉死。 */
const BUILTIN_TERMS = [
  // 一条一个词：以前写成 'TW3 / TW 3 / Witcher 3 / The Witcher 3 / W3' 一条，
  // 模型读成「一整串对应巫师3」，单写 TW3 时反而猜成《上古卷轴3》（用户真机高发）。
  { en: 'TW3', zh: '巫师3' },
  { en: 'TW 3', zh: '巫师3' },
  { en: 'Witcher 3', zh: '巫师3' },
  { en: 'CP2077', zh: '赛博朋克2077' },
  { en: 'BG3', zh: '博德之门3' },
  // 删掉 'SKSE / F4SE / NVSE → 原样保留，不要翻译'：这是**指令**不是术语，
  // 混在对照表里会被当成「这几个词该译成中文」，实测把 SKSE 译成「天空风」之类。
  // 缩写该不该保留由规则 2/8 统一管（保留原文只限对照表里没有的）。
  { en: 'Lite', zh: '轻量版' },
  { en: 'Lightweight', zh: '轻量版' },
  // Cleaner 以前写 '更清晰的 / 更干净的（不是"清洁版"）' —— 整串当译文输出，
  // 真机出现「Belly cns → 腹部猎魔感官模组」「Aerith cns → 艾瑞丝更清晰的模组」，
  // 即模型把注释性的「更X的」当词义。改成确定的单译法。
  { en: 'Cleaner', zh: '清理版' },
];

/** Vortex 自身的术语约定：界面文案里这几个词误译率最高 */
const VORTEX_GLOSSARY = [
  'profile = 配置档（不是账号）',
  'mod / mods = 模组',
  'deploy / deployment = 部署',
  'purge = 清除部署',
  'collection = 合集',
  'extension = 扩展',
  'dependency = 依赖',
  'staging folder = 暂存文件夹',
  'load order = 加载顺序',
];

/** 路径保护：7B 模型会把路径里的游戏名一起翻掉（The Witcher 3\mods → 巫师3\mods），
 *  路径一坏，用户照着复制粘贴就全废。所以发送前把路径换成 {{P1}} 占位，回来再原样换回。
 *  只保护「确知是路径」的片段，宁少勿多：多保护会留下英文碎片，少保护只是回到原文。 */
const PATH_GAME_ALIASES = [
  'The Witcher 3', 'Witcher 3', 'TW3', 'TW 3', 'W3',
  'Cyberpunk 2077', 'CP2077', 'Baldur\'s Gate 3', 'BG3',
  'Skyrim Special Edition', 'Skyrim', 'Fallout 4', 'Fallout New Vegas',
];

// BBCode 标签头清单（review4）：与 protectPaths / srcHead 三处必须一致 ——
// table 系列曾漏，[table]…[/table] 整值会被剥壳门吃掉标签本尊。
const BB_HEAD = 'b|i|u|s|url|img|quote|spoiler|list|\\*|color|size|font|center|code|table|tr|td|th|h[1-6]';

function protectPaths(text, box) {
  let s = String(text);
  // F-020-23（v4 审计 §8.2）：源文本**自带** `{{P1}}` 这类字面量时不能再用同号占位符。
  // 实锤：`has {{P1}} and C:\a\b.txt` → protect 成 `has {{P1}} and {{P1}}`，还原时
  // 两处都被换成路径 → **用户原文被静默篡改**，而且所有守卫都看不出来（占位符数量对得上、
  // 还原后也没有残留）。先把源里已占用的编号记下来，生成时跳过。
  const taken = new Set(s.match(/\{\{P\d+\}\}/g) || []);
  const put = (frag) => {
    let k = '{{P' + (box.seq++) + '}}';
    while (taken.has(k)) k = '{{P' + (box.seq++) + '}}';
    box.map.set(k, frag);
    return k;
  };
  // BBcode 标签：模型根本不认 [b]/[i]/[u]，会当普通文字删掉或写坏闭合；
  // 实测 7B 把「[i]次世代[/i]」输成「[i]次世代</i>」，页面上直接露出 </i>。
  // 换成占位符最稳：模型只需原样搬占位符，不可能写坏标签。
  s = s.replace(/\[\/?(?:b|i|u|s|url|img|quote|spoiler|list|\*|color|size|font|center|code|table|tr|td|th|h[1-6])(?:=[^\]]{0,64})?\]/gi,
    (m) => put(m));
  // 盘符路径 C:\Users\...\x.log
  // ⚠ 字符类里排除 `{}` 是**必须的**（F-020-22 / v4 审计 §8.1）：上一步刚把 BBCode
  // 换成 `{{P2}}`，不排除就会把紧贴路径的占位符一起吞进路径值里 —— 实测
  // `[b]C:\a\b.zip[/b]` → `{{P1}}C:\a\b.zip{{P2}}` → 路径正则把 `C:\a\b.zip{{P2}}`
  // 整段吃掉，还原时 `{{P2}}` 的轮次已经过去，永久残留在译文里。路径里不会有 `{`。
  s = s.replace(/[A-Za-z]:\\(?:[^\\\s"'<>|*?{}]+\\)*[^\\\s"'<>|*?{}]*/g, (m) => (m.length > 3 ? put(m) : m));
  // URL 整条
  // ⚠ 同样必须排除 `{}`：`[img]https://cdn.e.com/a.png[/img]` 里 URL 紧贴 `{{P2}}`，
  // 不排除就把占位符吞掉。这是 Nexus 描述里最常见的写法，命中后该条**永远翻不出来**
  // （占位符缺失 → 1242 的 box 校验打回 → 界面一直英文），不是偶发。
  s = s.replace(/https?:\/\/[^\s"'<>）)】{}]+/g, (m) => put(m));
  // 游戏名紧贴在路径分隔符前：The Witcher 3\mods\xxx
  for (const a of PATH_GAME_ALIASES) {
    const re = new RegExp(escapeRegExp(a) + '(?=\\s*[\\\\/])', 'g');
    s = s.replace(re, (m) => put(m));
  }
  // 无空格的路径片段 x\y\z\（正斜杠不碰：and/or、3/4 这类误伤概率高）
  s = s.replace(/[A-Za-z0-9_.\-]+(?:\\[A-Za-z0-9_.\-]*)+\\?/g, (m) => put(m));
  return s;
}

function restorePaths(s, box) {
  let t = String(s);
  if (!box || !box.map.size) return t;
  for (const [k, v] of box.map) t = t.split(k).join(v);
  return t;
}

/**
 * 结构修复（C5+C7 v6）：治「孤立/错配符号」与「英文驼峰粘连」，只对 mod 模式生效。
 *
 * 病根：模型把被遮蔽的『上古卷轴5：天际』改写成 `"上古卷轴5：天际」`（只开不闭/跨族半对），
 * 而前面三道还原（unmask 只认 `『zh』`、剥壳只认成对、术语括号清理要求左右都有符号）
 * 全部只认「成对」，于是这种半对一直漏到界面上。
 *
 * **本函数的前提（不是实现细节，别当 bug 改掉）**：中文译文里出现的半角 `"` 与 `『』`，
 * 一律视为「遮蔽残留或模型自产」。依据：91875 行真实模型输出里，译文含 `"` 的 85 行、
 * 其中原文也含 `"` 的是 **0 行**；且实测原文无引号的 `Skyrim SE - 1.6 Patch` 有 2/3 概率
 * 被模型自己写成 `"上古卷轴5：天际」SE-1.6补丁`。所以配对后两端一起换空格是安全动作。
 *
 * 两段式：
 *   ① 族感知配对：引号族「」『』" / 书名族《》 / 圆括号族（）() / 方括号族【】[]
 *      落单闭符号 → 栈里有位置在前的中文开符号就跨族归一（`《X』`→`《X》`），否则换空格（删了会粘连）；
 *      含 `"`/`『』` 的配对两端一起抹；未闭合开符号换空格，半角 `(` 除外（原文可能本就半个）。
 *   ② 驼峰粘连：`fooBar` → `foo Bar`，但后半段必须能在原文括号内容里找到，否则不动（幂等保障）。
 *
 * 实测：跨 45 份全量 91875 行命中 196 次 / 去重 50 条；76437 条负例 0 误伤；幂等 0；33µs/条。
 */
function repairStruct(s, orig) {
  var FAM = { '\u300c': 'q', '\u300d': 'q', '\u300e': 'q', '\u300f': 'q', '"': 'q', '\u300a': 'b', '\u300b': 'b', '\uff08': 'p', '\uff09': 'p', '\u3010': 'k', '\u3011': 'k', '[': 's', ']': 's' };
  var ISOPEN = { '\u300c': 1, '\u300e': 1, '\u300a': 1, '\uff08': 1, '\u3010': 1, '[': 1 };
  var ISMASK = { '"': 1, '\u300e': 1, '\u300f': 1 };
  var CNOPEN = { '\u300c': 1, '\u300e': 1, '\u300a': 1, '\uff08': 1, '\u3010': 1 };
  var CLOSE = { q: '\u300d', b: '\u300b', p: '\uff09', k: '\u3011', s: ']' };

  var chars = Array.from(String(s));
  var out = chars.slice();
  var stack = [], pairs = [], orphan = [];
  for (var i = 0; i < chars.length; i++) {
    var ch = chars[i];
    if (ch === '"') {
      var at = -1;
      for (var k = stack.length - 1; k >= 0; k--) if (stack[k].ch === '"') { at = k; break; }
      if (at >= 0) { var l0 = stack.splice(at, 1)[0]; pairs.push({ l: l0, r: { ch: ch, idx: i } }); }
      else stack.push({ ch: ch, idx: i });
      continue;
    }
    if (ISOPEN[ch]) { stack.push({ ch: ch, idx: i }); continue; }
    if (FAM[ch]) {
      var fam = FAM[ch], at2 = -1;
      for (var k2 = stack.length - 1; k2 >= 0; k2--) if (FAM[stack[k2].ch] === fam) { at2 = k2; break; }
      if (at2 >= 0) { var l1 = stack.splice(at2, 1)[0]; pairs.push({ l: l1, r: { ch: ch, idx: i } }); }
      else orphan.push(i);
    }
  }
  function blank(ix) { if (out[ix] !== ' ') out[ix] = ' '; }
  for (var oi = 0; oi < orphan.length; oi++) {
    var oix = orphan[oi], at3 = -1;
    for (var k3 = stack.length - 1; k3 >= 0; k3--) if (CNOPEN[stack[k3].ch] && stack[k3].idx < oix) { at3 = k3; break; }
    if (at3 >= 0) { var l2 = stack.splice(at3, 1)[0]; out[oix] = CLOSE[FAM[l2.ch]] || chars[oix]; }
    else blank(oix);
  }
  for (var pi = 0; pi < pairs.length; pi++) {
    var L = pairs[pi].l, R = pairs[pi].r;
    // 配对条件本身就是「同族才配得上」（见上面两处 `FAM[...] === fam` / `ch === '"'`），
    // 所以原来那句 `else if (FAM[L.ch] !== FAM[R.ch]) out[R.idx] = CLOSE[...]` 永远为假，
    // 是死分支（审计 0.16.5 实测报告 §4 指出，已核）。跨族归一发生在上面 orphan 分支。
    if (ISMASK[L.ch] || ISMASK[R.ch]) { blank(L.idx); blank(R.idx); }
  }
  for (var si = 0; si < stack.length; si++) { if (stack[si].ch !== '(') blank(stack[si].idx); }

  var t = out.join('');
  // 括号被吃掉 → 术语贴到英文词尾。后半段必须来自原文括号内容，否则 inZOI 这类品牌驼峰会拆错
  var origStr = String(orig == null ? '' : orig);
  var origLower = origStr.toLowerCase();
  var bro = origStr.match(/[\(\uff08\[\u3010]([^\)\uff09\]\u3011\u300b]{1,24})[\)\uff09\]\u3011\u300b]/g) || [];
  var toks = bro.map(function (x) { return x.slice(1, -1).trim(); }).filter(Boolean);
  t = t.replace(/([a-z]{2,})([A-Z][A-Za-z0-9]{2,})/g, function (m, a, b) {
    if (origLower.indexOf(m.toLowerCase()) >= 0) return m;
    var hit = false;
    for (var ti = 0; ti < toks.length; ti++) {
      if (toks[ti].indexOf(b) === 0 || toks[ti].toLowerCase().indexOf(b.toLowerCase()) === 0) { hit = true; break; }
    }
    return hit ? a + ' ' + b : m;
  });

  return t.replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([\uff0c\u3002\uff1b\uff1a\u3001\uff01\uff1f\uff09\u300b\u300d\u300f\u3011\]])/g, '$1')
    .replace(/([\uff08\u300a\u300c\u300e\u3010\[])+ +/g, '$1')
    .trim();
}

function buildSystemPrompt(terms, mode) {
  // 这个函数的 else 分支是「非 ui 即 mod」（html 生产走 buildHtmlPrompt，不经过这里），
  // 所以术语表与 9/10/11 三条必须用同一个判据，否则直接调用时会拿到
  // 「有规则、没对照表」的半套提示词。
  const modLike = mode !== 'ui';
  const termList = modLike ? mergeToolTerms(terms) : (terms || []);
  const termHint = termList.map((t) => `${t && t.en} => ${t && t.zh}`).join('\n');
  const builtinHint = BUILTIN_TERMS.map((t) => `${t.en} => ${t.zh}`).join('\n');
  const glossary = VORTEX_GLOSSARY.join('；');
  if (mode === 'ui') {
    return [
      '你是软件界面本地化译者，把英文界面文案翻译成简体中文。',
      '规则：',
      '1. 完整翻译整句，不许缩略、不许省略、不许把两句合并，译文长度要和原文相当。',
      '2. 保留所有占位符与变量原样：{{name}}、%s、${1}、<br/> 等。',
      '3. 『书名号』标记的是固定术语，原样输出对应中文，不要改写。',
      '4. 只输出简体中文（中国大陆用词），严禁繁体字。',
      '5. 只输出一个 JSON 数组，元素为字符串，顺序与输入完全一致，不要解释、不要代码块标记。哪怕只有一条输入，也必须输出形如 ["译文"] 的 JSON 数组，绝对禁止直接输出纯文本。',
      '6. 成人向（NSFW）内容的文案也照常翻译，这只是游戏软件界面，不要拒翻、不要原样返回英文。',
      '7. 游戏名、软件名、模组名的缩写必须按下面的对照译成完整中文名；对照表里没有的缩写，保留原文，绝对不要猜成另一个作品。',
      '8. 这是 Vortex 模组管理器：' + glossary + '。',
      '内置对照：\n' + builtinHint,
      termHint ? '术语对照：\n' + termHint : '',
    ].filter(Boolean).join('\n');
  }
  return [
    '你是单机游戏 MOD 的中文名翻译助手。',
    '任务：把用户给出的每一条英文 MOD 名称翻译成简体中文，让玩家一眼看懂这个 MOD 是干什么的。',
    '规则：',
    '1. 名称里『书名号』标记的是专业术语，输出时原样保留成对应中文，不要改写它。',
    '2. 版本号和数字原样保留（如 v1.4.9、4K、16x9）；『书名号』里的术语按对照输出，其余缩写见第 8 条。',
    '3. 只输出一个 JSON 数组，元素为字符串，顺序与输入完全一致，不要解释、不要代码块标记。哪怕只有一条输入，也必须输出形如 ["译文"] 的 JSON 数组，绝对禁止直接输出纯文本。',
    '4. 每条结果控制在 20 个汉字以内，宁短勿长。',
    '5. 只输出简体中文（中国大陆用词），严禁繁体字。',
    '6. 全部大写的名称（如 DELUXE PACK NEXT-GEN）也必须翻译成中文，绝对禁止原样返回英文。',
    '7. 成人向（NSFW）模组的名称也照常翻译，这只是游戏模组名，不要拒翻。',
    '8. 游戏名缩写必须按下面的对照译成正式中文名；对照表里没有的缩写，保留原文，绝对不要猜成别的游戏。',
    '内置对照：\n' + builtinHint,
    termHint ? '术语对照：\n' + termHint : '',
    // 9-11 是 0.18 新增。措辞是 A/B 选出来的，别改写成条件句：
    // 实测「**第 6 条的例外**：…英文与中文完全相同的条目」这种写法只有 91.4%，
    // 换成直白的「术语对照表里英文与中文相同的那些词…必须原样保留」是 94.0%
    // （全大写工具词 100%）。7B 不擅长解析条件判断，要给它直接命令。
    // 改这三条前先读 TOOL_TERMS 上方注释与 local-docs/0.18 文档。
    '9. 术语对照表里英文与中文相同的那些词（例如 SKSE => SKSE、BodySlide => BodySlide）是工具、框架、脚本扩展器名，必须原样保留、大小写也不许改，禁止翻译、改写成别的词或删除。',
    '10. 对照表里没有的词一律译成中文，哪怕它看起来像专有名词或作者名。',
    '11. 输出里不许出现「译文」「译名」这类字样。',
  ].filter(Boolean).join('\n');
}

/** HTML 段落模式：段落被序列化成「带伪标签的串」后送翻，要求逐字保留标签与占位符。
 * 伪标签 <i1>…</i1> 对应页面里的 <a>/<b>/<span> 等行内元素，{{1}} 对应图片/代码块等整块元素。
 * 这是同类插件（沉浸式翻译 / KISS-Translator）的做法：整段落一次翻、上下文完整，又不会破坏链接与图标 */
function buildHtmlPrompt(terms) {
  const termHint = (terms || []).map((t) => `${t.en} => ${t.zh}`).join('\n');
  const builtinHint = BUILTIN_TERMS.map((t) => `${t.en} => ${t.zh}`).join('\n');
  const glossary = VORTEX_GLOSSARY.join('；');
  return [
    '你是软件界面本地化译者。输入是一个 JSON 数组，每个元素是一段英文 HTML 片段（可能含伪标签）。',
    '规则：',
    '1. 伪标签 <i1>、</i1>、<i2>、</i2> 必须原样保留：位置不变、配对数不变、编号不变，绝对不许翻译或删除。',
    '2. 占位符 {{1}}、{{2}}、{{P1}} 必须原样保留在译文中，位置尽量不变；一个都不许丢、不许改号、不许翻译。',
    '3. 只翻译伪标签之间和占位符之外的英文文字。',
    '4. 完整翻译整句，不许缩略、不许省略、不许合并两条，译文长度和原文相当。',
    '5. 只输出简体中文（中国大陆用词），严禁繁体字。',
    '6. 只输出一个 JSON 数组，元素为字符串，顺序与输入完全一致；不要解释、不要代码块标记。',
    '7. 成人向（NSFW）内容照常翻译，这只是游戏软件界面，不要拒翻、不要原样返回英文。',
    '8. 数字、版本号、文件名、URL、代码保持原样。',
    '9. 文件路径必须整段原样复制：凡是带反斜杠 \\ 或斜杠 / 的串（如 The Witcher 3\\mods\\xxx\\、Content/Paks/LogicMods），里面的游戏名也不许翻、反斜杠不许换成斜杠、不许增删斜杠，一个字都不许改。',
    '10. 游戏名、软件名、模组名的缩写必须按下面的对照译成完整中文名；对照表里没有的缩写，保留原文，绝对不要猜成另一个作品。',
    '11. 这是 Vortex 模组管理器，专有词固定译法：' + glossary + '。',
    '内置对照：\n' + builtinHint,
    termHint ? '术语对照：\n' + termHint : '',
  ].filter(Boolean).join('\n');
}

function extractJsonArray(s) {
  let t = String(s).trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const v = JSON.parse(t);
    if (Array.isArray(v)) return v;
  } catch (e) { /* continue */ }
  const m = t.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const v = JSON.parse(m[0]);
      if (Array.isArray(v)) return v;
    } catch (e) { /* give up */ }
  }
  // 模型偶尔只吐 "译文1","译文2"（不带外层方括号），或者用中文逗号/弯引号分开
  if (/["“”]/.test(t) && t.indexOf('[') === -1) {
    const fixed = t.replace(/[“”]/g, '"').replace(/[，、]/g, ',');
    try {
      const v = JSON.parse('[' + fixed + ']');
      if (Array.isArray(v)) return v;
    } catch (e) { /* give up */ }
  }
  // 全角引号兜底：模型有时用 “” 包裹字符串，实测日志里有 `[""ModSkillSlotPages重制版 1.8""]`
  // 这种形态——上面三条路径都因引号不合法而失败，而第 266 行那条兜底又要求 t 里没有 '['，
  // 刚好把「带方括号 + 全角引号」挡在门外，整批直接作废。放在最后试：原文能用半角引号
  // 解析的（包括译文内部合法含全角引号的）在上面就已经返回了，不会走到这里被改写。
  // 注意引号还会写成双份（““X””），直接替换成半角会得到 ""X"" 照样不合法，先压成单份。
  if (/[“”‘’]/.test(t)) {
    const norm = t.replace(/[“”‘’]{2,}/g, (run) => run[0])
      .replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    try {
      const v = JSON.parse(norm);
      if (Array.isArray(v)) return v;
    } catch (e) { /* give up */ }
    const m2 = norm.match(/\[[\s\S]*\]/);
    if (m2) {
      try {
        const v = JSON.parse(m2[0]);
        if (Array.isArray(v)) return v;
      } catch (e) { /* give up */ }
    }
    // 不带外层方括号 + 双份引号（""译文A"",""译文B""）也一并救回来
    if (norm.indexOf('[') === -1 && /["']/.test(norm)) {
      try {
        const v = JSON.parse('[' + norm + ']');
        if (Array.isArray(v)) return v;
      } catch (e) { /* give up */ }
    }
  }
  return null;
}

/** 输出被 max_tokens 截断时的抢救：JSON 数组后半段缺失，但前面的元素是完整的。
 * 逐字符扫描字符串字面量，只收完整的那些，截断的最后一条丢弃。
 * 不抢救的话整批作废 → 又走逐条慢速重试，页面长时间半英文。 */
function salvageJsonArray(s) {
  const out = [];
  let i = String(s).indexOf('[');
  if (i < 0) return out;
  i += 1;
  const n = String(s).length;
  while (i < n) {
    while (i < n && /[\s,]/.test(s[i])) i += 1;
    if (s[i] !== '"') break;
    let j = i + 1, buf = '', closed = false;
    while (j < n) {
      const c = String(s)[j];
      if (c === '\\') { buf += c + (String(s)[j + 1] || ''); j += 2; continue; }
      if (c === '"') { closed = true; j += 1; break; }
      buf += c;
      j += 1;
    }
    if (!closed) break;                    // 这一条被截断了，丢掉
    try { out.push(JSON.parse('"' + buf + '"')); } catch (e) { break; }
    i = j;
  }
  return out;
}

/** 估算一段文本的 token 占用（按字符分类加权）。
 *  权重来自 2026-10-23 在 LM Studio + hy-mt2-7b 上的实测（内容 tok/char）：
 *  英文散文 0.207 / 中文 0.58 / 日文混合 0.803 / 西里尔希腊 0.629 / emoji 符号 1.322 /
 *  Base64 长串 0.695。权重全部比实测值高 6%~25%，故意高估：估高的代价只是批次
 *  略小（安全），估低的代价是服务端 400 整批作废、掉进逐条慢速重试。
 *  以前全站统一 inChars/1.6（=0.625/字符）：emoji 类内容低估 2.1 倍必撞 400，
 *  日文/Base64 也低估。另对 ≥20 字符的无空格 ASCII 长串（URL、哈希、Base64）
 *  每条加收 0.5/字符——实测长串 0.695，散文只有 0.207，差在能不能被合并成整词。 */
function estInputTokens(s) {
  const t = String(s == null ? '' : s);
  let tok = 0, run = 0;
  const endRun = () => { if (run >= 20) tok += run * 0.5; run = 0; };
  for (const ch of t) {
    const c = ch.codePointAt(0);
    if (c < 128) {
      tok += 0.25;
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') endRun();
      else run++;
      continue;
    }
    endRun();
    // 注意区间含继：假名(3040-30FF)、谚文(AC00-D7AF)、全角(FF00-FFEF)都被
    // 2E80-9FFF 包着，必须先判它们，剩下的 CJK 才算汉字
    if ((c >= 0x3040 && c <= 0x30FF) || (c >= 0x31F0 && c <= 0x31FF) ||
      (c >= 0x1B000 && c <= 0x1B2FF) || (c >= 0xAC00 && c <= 0xD7AF) ||
      (c >= 0x1100 && c <= 0x11FF) || (c >= 0x3130 && c <= 0x318F) ||
      (c >= 0xFF00 && c <= 0xFFEF)) tok += 0.95;                                              // 假名/谚文/全角（日文混合样本实测 0.803）
    else if ((c >= 0x2E80 && c <= 0x303F) || (c >= 0x3400 && c <= 0x4DBF) ||
      (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0xF900 && c <= 0xFAFF)) tok += 0.68;               // 汉字及中文标点（实测 0.58）
    else if (c >= 0x1F000 || (c >= 0x2600 && c <= 0x27BF) || (c >= 0x2B00 && c <= 0x2BFF) ||
      (c >= 0x2190 && c <= 0x21FF) || (c >= 0x2200 && c <= 0x22FF) ||
      (c >= 0x25A0 && c <= 0x25FF) || c === 0xFE0F) tok += 1.65;                                                       // emoji/符号（实测 1.32）
    else tok += 0.75;                                                                                                  // 西里尔/希腊等（实测 0.63）
  }
  endRun();
  return tok;
}

/** 端点类型判据（全项目唯一一份）：只看地址，不猜模型名、不发厂商字段。
 *  F-019-22：以前只有 probeContext 里一句 /127\.0\.0\.1|localhost/ 的正则，
 *  分档要复用判据就必须抽出来，绝不在第三处再写一遍。
 *  环回 / 本机别名 → 本地档；其余（含局域网自建、远程、云端）→ 云端档。
 *  局域网端点也按云端档：窗口通常远大于本地 7B，且 learnCtxFrom400 只减不增
 *  会自己收敛，估保守不会撞车。 */
function isLocalBase(base) {
  const s = String(base == null ? '' : base).trim().toLowerCase();
  if (!s) return false;
  // 去协议与路径，只留主机；再去端口（IPv6 字面量单独处理）
  let host = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0];
  // F-019-27：Basic Auth 形态 http://user:pass@127.0.0.1:1234/v1 —— 认证前缀
  // 不剥掉会把整串当主机名，漏判成云端档
  host = host.replace(/^.*@/, '');
  // 先剥端口：IPv6 字面量按 ] 收口，其余按 :数字 收口（顺序反了带端口的
  // [::ffff:127.0.0.1]:8080 会整个被当主机名，仍然漏判）
  const bracketEnd = host.indexOf(']');
  if (host.charAt(0) === '[' && bracketEnd > 0) host = host.slice(0, bracketEnd + 1);
  else host = host.replace(/:\d+$/, '');
  // 再判 IPv4 映射的 IPv6 字面量 → 只看 IPv4 尾巴
  const mapped = host.match(/^\[::ffff:(\d+\.\d+\.\d+\.\d+)\]$/);
  if (mapped) host = mapped[1];
  return host === 'localhost' || /\.localhost$/.test(host)
    || host === '127.0.0.1' || host === '[::1]'
    || host === '0.0.0.0' || host === '[::]' || host === 'host.docker.internal'
    // 127.a.b.c 完整回环 / 127.1 这类 BSD 简写；`127.example.com` 是域名不是本地
    || /^127\.\d+\.\d+\.\d+$/.test(host) || /^127\.\d+$/.test(host);
}

/** 按地址给出工程参数档位（唯一一份）。
 *  F-019-22 / §5.2：调的是我方能算的工程旋钮，**不是各家 thinking 强度**
 *  （F-019-17 ⛔：reasoning_effort / thinkingBudget / enable_thinking 一律不碰），
 *  也不按模型名分叉。用户已配的 concurrency / requestDelayMs / batchCharBudget
 *  一律不覆盖 —— 分档只改「探测失败时的 fallback」与「每组条数上限」。
 *  ctxFallback 是「probeContext 探测失败时的窗口估值」，**不是给模型设上限卡**（§5.3）：
 *  本地 8192、云端 1048576（「窗口未知」哨兵）。它只喂给 room / CTX_OVER 闸门，
 *  输出预算另由 outBudgetOf 的 8192 ceiling 决定、输入另由 batchCharBudget=1200 切批 ——
 *  所以这个值对云端几乎不改变实际行为，真正决定批次的是 maxItems 与字符预算。
 *  真超窗口时 learnCtxFrom400 取报错里最小的数字（即 n_ctx 真窗口）**一步收敛**，不是逐次减半。
 *  本地兜底 2026-11-13 从 4096 抬到 8192（F-019-46）：4096 会让「探测不到窗口但实际
 *  能有 8K」的服务把窗口白瞎（每批条数被砍半、请求数翻倍）。抬高的风险由
 *  learnCtxFrom400 兜住 —— 真只有 4K 时首请求 400，从报错里取 n_ctx 一步收敛。 */
function endpointProfileOf(base) {
  // 空地址按最保守的本地档：没配地址时预检本来就不发请求，档位不该反而放松
  const local = !String(base == null ? '' : base).trim() || isLocalBase(base);
  return {
    kind: local ? 'local' : 'cloud',
    ctxFallback: local ? 8192 : 1048576,
    maxItems: local ? 12 : 24,
    keyRequired: !local,     // 只用于设置页提示分类，不做阻断
  };
}

/** 探测模型「实际加载」的上下文窗口（多后端，F-019-46）。
 *  三家本地服务端各有一套端点，只认 LM Studio 会把 Ollama / llama.cpp / vLLM
 *  的窗口全部落到「探测失败」档，窗口再大也白瞎（用户 2026-11-13 提的就是这个）。
 *  按顺序试，谁先给出**运行时真实窗口**就用谁：
 *    ① LM Studio  GET  /api/v0/models  → loaded_context_length（优先）/ max_context_length
 *    ② Ollama     GET  /api/ps         → 已加载模型的 context_length（= 运行时 num_ctx）
 *    ③ llama.cpp  GET  /props          → default_generation_settings.n_ctx（或顶层 n_ctx）
 *    ④ vLLM/通用  GET  {base}/models   → max_model_len（或 context_length）
 *  都拿不到才落到 endpointProfileOf().ctxFallback。
 *
 *  ⚠ **故意不用 Ollama 的 /api/show**：它给的是 model_info.<arch>.context_length，
 *  那是**模型训练窗口**（可能 128K），不是运行时 num_ctx（常见 2048/4096）。拿它当
 *  窗口会估高，而 Ollama 超窗口不是报 400 而是**静默截断**——等于悄悄译半句，
 *  比估低还糟。宁可用 /api/ps 的已加载值，模型没加载就先按兜底跑，加载后下一轮
 *  （TTL 60 秒）自动读到真值。
 *
 *  LM Studio 的 /api/v0/models 必须优先用 loaded_context_length：模型本身 262144，
 *  界面里只加载了 8192 是常态。请求超过它，LM Studio 直接 400
 *  "Context size has been exceeded" —— 整批作废、队列看起来像空跑，
 *  这就是合集页等几分钟还是英文的根因。云端这些端点实测 401/404，拿不到窗口，
 *  于是按档位 fallback（本地 8192 / 云端 1048576 哨兵，F-019-26）。
 *  真撞到窗口时 learnCtxFrom400 从 400 报错里取最小数字（即 n_ctx 真窗口）一步收敛。 */
let ctxCache = { key: '', ctx: 0, at: 0, learned: false };
const CTX_TTL_MS = 60000;          // 探测值的有效期
const CTX_LEARNED_TTL_MS = 300000; // 从服务端 400 学到的值的有效期（长一些，避免每 60 秒重新撞同一堵墙）
async function probeContext(base, key, model) {
  const k = String(base) + '|' + String(model);
  const ttl = ctxCache.learned ? CTX_LEARNED_TTL_MS : CTX_TTL_MS;
  if (ctxCache.key === k && Date.now() - ctxCache.at < ttl) return ctxCache.ctx;

  const root = String(base).replace(/\/v1\/?$/i, '').replace(/\/+$/, '');
  const auth = key ? { Authorization: 'Bearer ' + key } : {};
  const getJson = async (url, ms) => {
    try {
      const r = await httpRequest(url, 'GET', auth, null, ms);
      if (r.status >= 200 && r.status < 300) return JSON.parse(r.body);
    } catch (e) { /* 端点不存在 / 超时 → 当作这家没有 */ }
    return null;
  };
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 1024 ? n : 0; };

  // 四家**并发**问，谁有按优先级取 —— 串行的话「四家都没有」要等 4 次超时叠起来
  // （云端最坏 6+4+4+6=20 秒，一次翻译开头就白等）；并发最坏只是最慢那一个（6 秒），
  // 和改动前「只问一家」的等待一致。局域网里的 LM Studio 也能覆盖到（不按地址分档）。
  const [jLm, jOl, jLl, jVl] = await Promise.all([
    getJson(root + '/api/v0/models', 4000),
    getJson(root + '/api/ps', 4000),
    getJson(root + '/props', 4000),
    getJson(String(base).replace(/\/+$/, '') + '/models', 6000),
  ]);

  let ctx = 0;
  // ① LM Studio：loaded 优先于 max（模型 262144 但只加载 8192 是常态）
  if (jLm) {
    const m = (jLm.data || []).find((x) => x.id === model) || {};
    ctx = num(m.loaded_context_length) || num(m.max_context_length);
  }
  // ② Ollama：/api/ps 的 context_length 就是已加载模型的运行时 num_ctx
  if (!ctx && jOl) {
    const list = jOl.models || [];
    const m = list.find((x) => x.name === model || x.model === model
      || String(x.name || '').indexOf(model) === 0) || list[0] || {};
    ctx = num(m.context_length);
  }
  // ③ llama.cpp server：n_ctx 是启动参数里的真实窗口
  if (!ctx && jLl) {
    ctx = num(jLl.default_generation_settings && jLl.default_generation_settings.n_ctx) || num(jLl.n_ctx);
  }
  // ④ vLLM / 其它 OpenAI 兼容：max_model_len 是 served 窗口
  if (!ctx && jVl) {
    const list = jVl.data || [];
    const m = list.find((x) => x.id === model) || list[0] || {};
    ctx = num(m.max_model_len) || num(m.context_length);
  }
  if (!ctx) {
    // 探测失败时**保留从 400 学到的真实窗口**：否则 4K 服务器会被兜底 8192 顶回去，
    // 每过一个 learned TTL 就重新撞一次同一堵墙（用户侧表现＝周期性整批失败）。
    if (ctxCache.key === k && ctxCache.learned && ctxCache.ctx > 0) {
      ctxCache.at = Date.now();
      return ctxCache.ctx;
    }
    // F-019-22：地址判据与档位值唯一一份，不再在这里另写正则 / 另写数字
    ctx = endpointProfileOf(base).ctxFallback;
  }
  ctxCache = { key: k, ctx, at: Date.now(), learned: false };
  return ctx;
}

/** 从服务端 400 报错里学习真实的上下文窗口。
 *  LM Studio / llama.cpp："Context size has been exceeded"（数字格式不固定）；
 *  云端："maximum context length is N tokens" / "context length exceeded"。
 *  实测真实 400 形体（2026-10-23，LM Studio + hy-mt2-7b）：
 *  "request (500002 tokens) exceeds the available context size (8192 tokens)…
 *   \"n_prompt_tokens\":500002,\"n_ctx\":8192" —— 请求量和窗口同时出现，
 *  窗口必然是小的那个，故抓报错里所有 1024..2000000 的整数取最小。
 *  采用规则（只减不增，这个信号只能证明「估高了」）：
 *   - 解析值 < 当前估值 → 采用（探测只拿到 max_context_length 时的主路径）；
 *   - 解析值 > 当前估值 → 不信，多半只抓到了请求量，退回减半；
 *   - 解析值 = 当前估值 → 探测本来就对，这条 400 是 estIn 低估造成的，窗口不用动；
 *   - 解析不到数字 → 减半，但不低于 minCtx（见下方 floor 注释）。
 *  没有当前估值做基线（cur=0）时分不清「窗口」和「请求量」，直接不学。
 * @param minCtx 减半时的窗口下限（调用方传 系统提示词估值 + 640）
 * @returns 学到的窗口（0 = 这条 400 没提供可靠信号，ctxCache 不动） */
function learnCtxFrom400(base, model, body, minCtx) {
  const text = String(body || '');
  if (!/context size|context length|context window|n_ctx|context_length|context_length_exceeded/i.test(text)) return 0;
  const k = String(base) + '|' + String(model);
  const cur = ctxCache.key === k ? ctxCache.ctx : 0;
  if (!cur) return 0;                                      // 没有估值做基线，分不清「窗口」和「请求量」
  const floor = Math.max(1024, Number(minCtx) || 0);
  const nums = (text.match(/\d{3,7}/g) || []).map(Number).filter((n) => n >= 1024 && n <= 2000000);
  let learned = nums.length > 0 ? Math.min.apply(null, nums) : 0;
  // 比当前估值大 → 抓错了（多半只抓到了请求量），不信；等于估值 → 探测本来就对，
  // 这条 400 是 estIn 低估造成的，窗口不用动（硬改只会把产能白白砍半）
  if (learned > cur) learned = 0;
  // 解析不到数字 → 减半收敛，但不低于 minCtx：提示词+最小条目都放不下的窗口
  // 没有意义，硬减会连单条都发不出去（CTX_OVER 循环到 TTL 过期）
  if (!learned) learned = cur > floor ? Math.max(floor, Math.floor(cur / 2)) : 0;
  if (!learned) return 0;                                  // 无可靠信号，保持原值，靠劈批收敛
  learned = Math.max(1024, Math.min(learned, 2000000));
  if (learned !== cur) ctxCache = { key: k, ctx: learned, at: Date.now(), learned: true };
  return learned;
}

async function pickModel(base, key) {
  try {
    const r = await httpRequest(base.replace(/\/+$/, '') + '/models', 'GET',
      key ? { Authorization: 'Bearer ' + key } : {}, null, 20000);
    const j = JSON.parse(r.body);
    const list = (j && j.data) || [];
    return list.length > 0 ? list[0].id : '';
  } catch (e) {
    return '';
  }
}

/** 出口判据（0.18）：原文明明有这些工具词，译文里一个都不剩 → 返回丢失清单。
 *  只认 TOOL_TERMS 里确定的词（不猜形态），所以实测误杀 0 条。
 *  ⚠ 大小写用**不敏感**匹配，是有意取舍（2026-11-09 真机数据定）：
 *    敏感匹配能放过 `Narrative Loot → 叙事战利品 GDPR`（普通词 Loot，译文正确），
 *    但会漏掉 `Belly cns → 腹部猎魔感官模组`（N 网作者写小写 cns，译文丢了它）这类
 *    真错译——两类在形态上无法区分，只能二选一。取「抓全真错译」：
 *    误伤的代价是该条被重翻成保留 `Loot` 的版本（Loot 本就是模组名组成部分，
 *    符合保留政策）；漏掉的代价是 6 条错译永远抓不到。
 *  用在两处：translateConcurrently 的单条重发闸门、index.js 收养分支的拒收闸门。 */
function lostToolTerms(src, zh) {
  const s = String(src || '');
  const o = String(zh || '');
  if (!s || !o) return [];
  const out = [];
  for (const t of TOOL_TERMS) {
    const re = new RegExp('(?<![A-Za-z])' + escapeRegExp(t.en) + '(?![A-Za-z])', 'i');
    if (re.test(s) && !re.test(o)) out.push(t.en);
  }
  return out;
}

/** 输出预算（F-019-15）：正文需求 + 思考余量，受窗口余量与硬上限约束。
 *  `max_tokens` 是**上限不是预分配**：不思考的模型（本地 hy-mt2-7b）到 stop 就结束，
 *  放大它不增加生成长度和耗时（本地对照实测 12 条 3.6s / 49 completion tokens）；
 *  思考型模型（deepseek-flash / Qwen3-Thinking / vLLM 推理族）的 reasoning_content
 *  与正文**共用这份预算**，不给余量就会得到 HTTP 200 + content:"" +
 *  finish_reason:"length"（2026-11-13 真机连出 6 次）。
 *  统一实现，不识别本地/云端：本地会被较小的 room 自动卡住，云端自然放开。
 *  自包含（不引模块级常量）：沙箱按函数名抽源码时可直接 new Function 执行。 */
function outBudgetOf(want, room, opts) {
  const o = opts || {};
  const headroom = Number(o.thinkHeadroom) > 0 ? Number(o.thinkHeadroom) : 4096;
  const ceiling = Number(o.ceiling) > 0 ? Number(o.ceiling) : 8192;
  const floor = 256;
  const w = Number(want) > 0 ? Number(want) : floor;
  const r = Number(room) > 0 ? Number(room) : floor;
  return Math.max(floor, Math.min(Math.max(w, floor) + headroom, r, ceiling));
}

/** 空正文后的重试预算：翻倍一次，仍受窗口余量与 2× 硬上限约束。
 *  拿不到更大的值就返回 0 = 不再重试（有界，绝不无限加倍）。 */
function retryBudgetOf(used, room, opts) {
  const o = opts || {};
  const ceiling = (Number(o.ceiling) > 0 ? Number(o.ceiling) : 8192) * 2;
  const u = Number(used) || 0;
  const r = Number(room) > 0 ? Number(room) : 0;
  const next = Math.min(u * 2, r, ceiling);
  return next > u ? next : 0;
}

/** 统一解析 chat/completions 响应：不只取 content，把判空要用的信号一起拿出来。
 *  旧实现只读 message.content / choices[0].text / j.content，看不见 finish_reason，
 *  于是把「预算被思考吃光」当成「模型不肯翻」，进逐条补发（单条预算更小，必然也空）。 */
function readChatCompletion(j) {
  const ch = (j && j.choices && j.choices[0]) || null;
  const msg = (ch && ch.message) || {};
  let content = '';
  if (msg.content != null) content = String(msg.content);
  else if (ch && ch.text != null) content = String(ch.text);
  else if (j && j.content != null) content = String(j.content);
  return {
    content: content,
    finishReason: String((ch && ch.finish_reason) || ''),
    reasoningLen: String(msg.reasoning_content || '').length,
    completionTokens: (j && j.usage && j.usage.completion_tokens) || 0,
  };
}

/** 空正文要不要加预算重发？返回新的预算；0 = 不重发。
 *  只认「content 空 + finish_reason=length」这一指纹：那是思考吃光预算，
 *  不是内容翻不了、也不是审核拦截。其它原因的空正文保持旧行为（不重试）。
 *  抽成单独函数是为了让判据能行为级测，而不是散在 llmTranslate 的胶水里。 */
function shouldRetryEmpty(parsed, used, room, opts) {
  const p = parsed || {};
  if (p.content) return 0;
  if (p.finishReason !== 'length') return 0;
  return retryBudgetOf(used, room, opts);
}

/** 空正文错误的结构化探针（F-019-16）。带现场判据，不把响应体整段塞进日志。 */
function emptyProbeOf(parsed, outTokens, body) {
  const p = parsed || {};
  return JSON.stringify({
    finishReason: p.finishReason || '',
    reasoningLen: p.reasoningLen || 0,
    completionTokens: p.completionTokens || 0,
    outTokens: Number(outTokens) || 0,
    body: String(body || '').slice(0, 220),
  });
}

async function llmTranslate(cfg, texts, modeOverride, extraRule) {
  const base = String((cfg.provider && cfg.provider.baseUrl) || '').replace(/\/+$/, '');
  const key = (cfg.provider && cfg.provider.apiKey) || '';
  const model = String((cfg.provider && cfg.provider.model) || '').trim();
  if (!base) throw new Error('未配置 provider.baseUrl');
  // 模型名必填：本地挂多个模型/云端列表几十个时自动选第一个不可靠，固定由用户指定
  if (!model) throw new Error('未配置模型名：本地模型可能有多个、云端列表更多，自动选择不可靠，请在扩展设置页填入模型名（如 hy-mt2-7b / deepseek-chat）');

  // 整名品牌短路（防模型加词）：名字整个就是词库品牌（Vortex / Nexus Mods / HDT-SMP）时，
  // 模型实测爱「补全」——HDT-SMP → "HDT-SMP叠加层"。这种条目根本不值得烧一次调用：
  // 从发送列表里摘出去原样返回（界面保持英文原名，正是「保留品牌」的预期结果）。
  const keepWholeSet = new Set((cfg.gameTerms || [])
    .filter((t) => t && t.brand && t.en)
    .map((t) => String(t.en).trim().toLowerCase()));
  const wholeBrand = (t) => {
    const srcTrim = String(t == null ? '' : t).trim();
    return keepWholeSet.has(srcTrim.toLowerCase());
  };
  if (keepWholeSet.size && texts.some(wholeBrand)) {
    if (texts.every(wholeBrand)) {
      const allKept = texts.map((t) => t);
      try { allKept._rejects = new Set(); } catch (e) { /* ignore */ }
      return allKept;
    }
    // 混合批：摘出品牌条目，剩下的照常发，最后按原位拼回。
    // mode 用整批的口径往下传 —— 子批改写模式会让遮蔽/归一化在两条条目间不一致。
    const mode0 = modeOverride || (isUiBatch(texts) ? 'ui' : 'mod');
    const kept = new Map();
    const rest = [];
    const restPos = [];
    texts.forEach((t, i) => {
      if (wholeBrand(t)) kept.set(i, t); else { rest.push(t); restPos.push(i); }
    });
    const out = await llmTranslate(cfg, rest, mode0);
    const merged = texts.slice();
    restPos.forEach((orig, j) => { merged[orig] = out[j]; });
    try { merged._rejects = out._rejects || new Set(); } catch (e) { /* ignore */ }
    return merged;
  }

  // 用户术语全带（量小）。游戏名只带「这一批文本里真出现了的」：
  // 以前是 slice(0, 200)，而 gamenames 按字母序排，第 200 条是 Dragon's Dogma，
  // 巫师3 / 天际 / 法环 / 辐射4 全在尾部 —— 86 款可用游戏只剩 18 款进得了提示词，
  // 等于「最需要的对照最先被砍掉」。
  const userTerms = (cfg.terms || []).slice(0, 200);
  const blob = texts.join('\n');
  const gameTerms = [];
  let plainTermN = 0;
  for (const t of (cfg.gameTerms || [])) {
    if (!t || !t.en || blob.indexOf(t.en) === -1) continue;
    gameTerms.push(t);
    // 品牌词（brand:true，来自 gamenames-keep 遮罩）不占这 40 条名额：
    // 少了它们，Vortex / Nexus Mods 这类词就会被翻成中文，比少几个游戏名严重得多（P2-e）。
    if (!t.brand && ++plainTermN >= 40) break;      // 一批里不会同时出现几十款游戏
  }
  const terms = userTerms.concat(gameTerms);
  const mode = modeOverride || (isUiBatch(texts) ? 'ui' : 'mod');
  // 全大写归一化只用于模组名（小模型对 ALL CAPS 易拒翻）。
  // html / ui 层不能做：页面上真有 CWSO、UE4SS 这种全大写专名，归一化后会变成 Cwso / Ue4ss，
  // 模型照抄回来值≠原文，就被当成「翻译成功」写进缓存，等于把专名改坏了。
  // 先遮罩、后归一（顺序反了 UE4SS 会先变成 Ue4ss，词库再也匹配不上 —— ④ 实录）。
  // 界面整句以前完全不遮术语（注释理由：遮了会把长句拆碎）。但那条理由只对
  // 「长短语」成立 —— `Geralt of Rivia` 这种遮进长句确实会打乱语序。
  // 代价是：ui/html 模式里裸送模型，`Stellar Blade` 被翻成「恒星之刃」、`Vortex`
  // 被翻成「漩涡」（同一个洞，0.16.3 续16 实测）。所以改成按粒度分级：
  //   mod 模式：全遮（模组名，术语越准越好）
  //   ui/html：只遮「品牌（zh===en，回填原样英文）」和 ≤3 词短术语（剑星/巫师3/次世代），
  //     并跳过 modOnly 词条 —— Oils/Reborn 这类通用英文词只服务模组名，长文本里遮它
  //     就是「更换发动机剑油」（2026-10-26 模型 A/B 实测）；域内专名（伊格尼/杰洛特）
  //     绝不 modOnly，裸送 ui/html 必夹英文。
  // 逐条遮，不要 join('\n') 再 split：只要任意一条文本自身含换行，拆出来的条数就比原来多，
  // payloadList / boxes / safeList 全部跟着错位 —— 第 N 条拿到的是前一条的一部分，静默错译。
  // mod 模式额外的工具词遮罩（0.18）：`cfg.gameTerms` 只覆盖 190 条词库里有的那 29 个
  // 工具词，剩下 19 个（ImprovedUI / EquipmentEX / TTW / ISL / ME3Tweaks / Baka …）只能
  // 靠提示词说，实测管不住。并进遮罩后：116 条 × 3 轮从 88.5%（其中两轮还出现黏连）
  // 提到 95.4%（三轮完全一致、零黏连）。合并用 mergeToolTerms，已被词库盖住的不重复遮。
  // ui/html 不加：整句遮罩会把长句拆碎（见下方分支的注释）。
  const maskTerms = (mode === 'mod')
    ? mergeToolTerms(terms)
    : terms.filter((t) => t.brand || (!t.modOnly && String(t.en || '').trim().split(/\s+/).length <= 3));
  const masked = maskTerms.length
    ? texts.map((t) => applyTerms(t, maskTerms, 'mask'))
    : texts.slice();
  const payloadList = (mode === 'mod') ? masked.map(normalizeCaseKeepMasks) : masked;

  // 路径占位保护（mod 名里基本没有路径，只为 html/ui 的说明书、报错提示服务）
  const boxes = payloadList.map(() => ({ seq: 1, map: new Map() }));
  const safeList = payloadList.map((t, i) => protectPaths(t, boxes[i]));

  // 系统提示词先构建：估算输入占用时要连它一起算（见下方 estIn）
  // ⛔ 2026-11-06 试过「提示词只放 userTerms、砍掉 gameTerms 术语表」，**实测否决，已回滚**：
  //   · 串味没消失：真实链路（先遮罩再送模型）A/B 20 组，对照 2/40 vs 处理 2/40 打平，
  //     而且 #20 DOOM 那组处理臂反而 2/2 被污染 —— 串味的主通道是**遮罩后中文进批内上下文**，
  //     不是术语表；
  //   · 粘连场景直接变差：游戏名藏在驼峰里遮罩遮不到时，术语表是唯一提示 ——
  //     `Cjayride.EpicValheimsAdditions` 对照译「英灵神殿」、处理译成音译「瓦尔海姆」；
  //     `SquadHud` 对照译「战术小队」、处理直接保留英文。
  // → 术语表在这一层是**净收益**，不要为了那个 3/3 单题材的特例去砍它。
  // `extraRule` 只给出口判据的单条重发用（指名「这一条必须保留 X」），默认不传，
  // 现有调用一个字节都不变；它进 sysPrompt，所以下面的 estIn 估算会自动把它算进去。
  const sysPrompt = (mode === 'html' ? buildHtmlPrompt(terms) : buildSystemPrompt(terms, mode))
    + (extraRule ? '\n' + extraRule : '');

  // 输出预算必须跟着输入走，但**绝不能超过模型实际加载的上下文**：
  // 之前写死 4096 撞 4096 的窗口，动态放大到 8192 更是直接超限，
  // LM Studio 返回 400「Context size has been exceeded」，整批作废。
  const inChars = safeList.reduce((n, s) => n + String(s).length, 0);
  const ctx = await probeContext(base, key, model);
  // estIn = 输入 + 系统提示词一起估。输入按字符分类加权（estInputTokens，权重全部
  // 高于 2026-10-23 实测值：中文 0.58 / 日文 0.80 / emoji 1.32 / 英文 0.21 tok/char），
  // 系统提示词按 1.2 字符/token（实测 0.632，留余量）。以前输入用统一 /1.6（=0.625），
  // emoji 类内容低估 2.1 倍必撞 400、日文/Base64 也低估；估高的代价只是批次略小。
  const estIn = Math.ceil(estInputTokens(safeList.join('\n'))) + Math.ceil(sysPrompt.length / 1.2) + 64;
  // 输出需求也要估，闸门只查输入会出大事：大批次的 room 被输入吃得只剩几百 token，
  // 发出去必被 max_tokens 截断 → JSON 解析失败整批作废 → 全部逐条慢速重试
  // （页面长期半翻译，且高频单发会把本地模型打到大量失败）。
  // 实测输出密度（2026-10-23，hy-mt2-7b，英→中）：短模组名约 0.4 token/源字符
  // （带版本号和术语标记开销），长简介约 0.2，html/ui 保留伪标签和结构、译文长度
  // 接近原文约 0.6。mod 取 0.5 / 其余取 0.85，各留 25%+ 边际。
  const want = Math.ceil(inChars * (mode === 'mod' ? 0.5 : 0.85)) + 256;
  const room = ctx - estIn - 128;                            // 留给输出的空间
  if (room < 400 || room < Math.min(want, 4096)) {
    const e = new Error('CTX_OVER 输入约 ' + estIn + ' token（含系统提示词 ' + Math.ceil(sysPrompt.length / 1.2) +
      '），输出约需 ' + Math.min(want, 4096) + '，模型上下文只有 ' + ctx);
    e.code = 'CTX_OVER';
    throw e;                                                 // 上层把这批劈半重发
  }
  // F-019-15：见 outBudgetOf 注释。统一实现，不识别本地/云端 —— 本地 4K 窗口算出的
  // room 会把预算自然卡住，云端窗口大就自然放开，不需要按地址分叉，也不需要发任何
  // 厂商专属的「关思考」字段（各家拼法不同、实测 28% 路由不认，见版本文档 §5.1）。
  const outTokens = outBudgetOf(want, room);

  const url = base + '/chat/completions';
  const headers = Object.assign({ 'Content-Type': 'application/json' },
    key ? { Authorization: 'Bearer ' + key } : {});

  // 一次 POST（含原有 429/502/503/504 退避，最多两次）。抽成闭包是为了让
  // 「空正文 + finish_reason=length → 加倍预算重发一次」复用同一套退避逻辑。
  const postChat = async (tokens) => {
    const payload = JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: JSON.stringify(safeList) },
      ],
      temperature: 0.2,
      max_tokens: tokens,
    });
    let rr = await httpRequest(url, 'POST', headers, payload, 180000);
    for (let attempt = 0; attempt < 2 &&
      (rr.status === 429 || rr.status === 502 || rr.status === 503 || rr.status === 504); attempt++) {
      const ra = Number((rr.headers && (rr.headers['retry-after'] || rr.headers['Retry-After'])) || 0);
      await delay(ra > 0 ? Math.min(ra * 1000, 15000) : 1200 * (attempt + 1));
      rr = await httpRequest(url, 'POST', headers, payload, 180000);
    }
    return rr;
  };

  let r = await postChat(outTokens);
  // 只在「成功响应 + 空正文 + finish_reason=length」时加预算重发一次。
  // 结构化 JSON 输出被截断时不能续写拼接（会漂移 / 重开键），只能整批丢弃重发。
  // 非 length 的空正文（模型真没吐东西 / 审核）保持旧行为，不重试。
  if (r.status >= 200 && r.status < 300) {
    let peek = null;
    try { peek = readChatCompletion(JSON.parse(r.body)); } catch (e) { peek = null; }
    const bigger = shouldRetryEmpty(peek, outTokens, room);
    if (bigger) r = await postChat(bigger);
  }

  if (r.status < 200 || r.status >= 300) {
    // 上下文超限的 400：从报错里学真实窗口并写进 probeContext 缓存（带 5 分钟有效期），
    // 下一个批次/重试立刻按学到的值估，不用反复撞同一堵墙。学不到就原样抛出。
    // minCtx 传「系统提示词 + 最小条目都放得下」的下限：减半低于它就连单条都发不出。
    if (r.status === 400) {
      const learned = learnCtxFrom400(base, model, r.body, Math.ceil(sysPrompt.length / 1.2) + 640);
      if (learned > 0) throw new Error('HTTP 400 ' + r.body.slice(0, 160) + ' [上下文窗口=' + learned + '，下批按此估算]');
    }
    throw new Error('HTTP ' + r.status + ' ' + r.body.slice(0, 200));
  }

  const got = readChatCompletion(JSON.parse(r.body));
  const content = got.content;
  if (!content) {
    // 探针（F-019-16）：把 finish_reason / reasoning 长度 / 用量结构化带上。
    // 上层 lastErr 已从 140 提到 600，这些字段能完整落到 translator.log，
    // 下次真机一翻译就能看到，不需要用户额外跑探针。
    throw new Error('模型返回为空: ' + emptyProbeOf(got, outTokens, r.body));
  }

  // 拒收要分原因：finishOne 里 5 个「宁可留英文」的出口都是**格式不合规**，
  // 不是「模型不肯翻」。以前它们统一返回原文，上层就按「照抄」处理，两次即判 -1 不可译、
  // 永久封杀。这里把被拒收的原串记下来，上层据此走「暂态失败」而不是「不可译」。
  const rejects = new Set();
  const markReject = (src) => { rejects.add(String(src)); return String(src); };
  const withRejects = (list) => { try { list._rejects = rejects; } catch (e) { /* ignore */ } return list; };

  function finishOne(s, src) {
    if (mode === 'mod') {
      // BBCode 闭合扶正（review4）：小模型把闭合写成 [b> 或 HTML 风格 </b>。
      // 只认已知 BB 标签名（[abc> 这种普通文本不动）；html 模式不碰 ——
      // </b> 在 HTML 里是合法标签，绝不能被转成 BBCode。
      s = s.replace(new RegExp('\\[(\\/?)(' + BB_HEAD + ')>', 'gi'), (m0, sl, nm) => '[' + sl + nm + ']');
      s = s.replace(new RegExp('<\\/(' + BB_HEAD + ')>', 'gi'), (m0, nm) => '[/' + nm + ']');
    }
    // unmask 必须所有模式都跑：ui/html 现在也遮蔽（见 maskTerms），
    // 漏了回填就会把『剑星』『Vortex』这些占位符原样露在界面上。
    if (maskTerms.length) {
      s = applyTerms(s, maskTerms, 'unmask');
      // 兜底剥壳只给 mod 模式做：ui/html 的正文里可能有合法的『』引用，
      // 全量剥会把正常文本改坏；模型自造的壳由下面的括号清理和标题壳剥离处理。
      if (mode === 'mod') s = s.replace(/『\s*([\s\S]*?)\s*』/g, '$1');
    }
    // 模型有时会把带『』标记的术语改写成「」等括号，统一清理掉包裹符号。
    // 容错要带上引号族：模型常把『术语』写成 '术语' / “术语”，以前只认中文括号，
    // 于是遮罩壳留在译文里（实测「SF6 迈克'三色'添加模组」）。
    // 0.18：这里必须遍历 maskTerms 而不是 terms —— TOOL_TERMS 里有一批词（CNS、CBBE、
    // ImprovedUI…）不在 190 条词库里，只存在于 maskTerms。用 terms 的话，模型把
    // 『CNS』改写成「CNS」时这一层就还原不了，界面上会留下「CNS」款赛车服模组（真机实录）。
    // F-020-28（2026-11-14 多样性专项实修）：这段循环本意是清「模型自己给术语套的壳」，
    // 但 `Skyrim Script Extender (SKSE64)` → `上古卷轴5脚本扩展（SKSE64）` 这种
    // **原文自带**的合法括注也会被剥成 `…扩展SKSE64`（粘连）。实测真实语料 49 条命中，
    // 旧逻辑只保住 1 条。修法：剥之前先看原始原文 `src` 里是否本来就用同一对括号
    // 包住这个术语 —— 是就整条跳过。src 是 texts[i]（未遮罩未保护的原文），可直接判。
    // 取舍：同一术语在译文里既出现合法括注、又出现模型自造壳时，连自造壳也不剥
    // （保守：宁可留壳，不剥合法括注）；实测「模型自造壳」正例剥离 8/10，与修前一致、无退化。
    // 三方案数据见 local-docs/audit-corpus/diversity2-fixes-probe.json（A 1/49、B 1/49、C 49/49）。
    const BRACKET_PAIRS = [['（', '）'], ['(', ')'], ['[', ']'], ['《', '》'],
      ['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'], ['"', '"']];
    const srcForBracket = String(src == null ? '' : src);
    const srcHasBracketed = (w) => BRACKET_PAIRS.some(([l, r]) => new RegExp(
      escapeRegExp(l) + '\\s*' + escapeRegExp(String(w)) + '\\s*' + escapeRegExp(r)
    ).test(srcForBracket));
    for (const t of maskTerms) {
      if (!t.zh) continue;
      // F-020-28 v2（用户质疑后复核）：v1 只比对 t.zh，漏掉「原文是英文术语、
      // 译文是中文术语」的同语义形态。实跑（f02028-en-zh-probe）：
      //   `(The Witcher 3) Wild Hunt Mod` → `（巫师3）狂猎模组`
      //   v1 剥成 `巫师3狂猎模组`（粘连），v2 保住括注。
      //   同时比 t.en 后：已覆盖的 (MO2)/(SKSE64) 形态不变、原文无括注的自造壳仍剥、
      //   括注里装别的内容 (Wild Hunt) 仍剥 —— 4 组对照零退化。
      //   数据：E1 修好、E2/E4 一致、E3 两版同样被 0.19 幻觉守卫拦（与本改动无关）。
      if (srcHasBracketed(t.zh) || (t.en && t.en !== t.zh && srcHasBracketed(t.en))) continue;
      s = s.replace(new RegExp('[「『\\[(（《"\u2018\u201c]' + escapeRegExp(t.zh) + '[」』\\])）》"\u2019\u201d]', 'g'), t.zh);
    }
    // 结构修复（C5+C7 v6）：成对的三道还原都跑完之后，剩下的孤立/错配符号交给它。
    // 只给 mod 模式：ui/html 的正文可能有合法的『』引用与英文引号，全量剥会改坏正常文本。
    if (mode === 'mod') s = repairStruct(s, src);
    // 错作品防火墙：模型对不认识的缩写会硬猜，而「巫师3」是它脑子里最响的中文游戏名
    // （实测 Legendary Edition 3 → 巫师3、Offline Covenants DS2 → 巫师3、DW DLC1 → 巫师3、
    //   Thedas IO → 《巫师3》泰达斯IO）。原文根本没提巫师系列时，译文里的「巫师3」一定是幻觉。
    // 边界只能用**左边界** `\bwitcher`，不能用 `\bwitcher\b`：
    //   · 左边界必须留 —— 裸 `witcher` 会命中 `Window Switcher`（实测），那是「切换器」不是猎魔人；
    //   · 右边界必须去掉 —— `Witcher3HD` / `WitcherIII` 这类**无空格粘连**里 `r` 后面紧跟字母数字，
    //     右边界不成立 → 守卫认不出来 → 真巫师模组译文里的「巫师3」会被当幻觉删掉。
    //     （2026-11-06 `wrong-work-guard-test` 实测：旧正则对这两种形态漏判。）
    // `wied[zź]min` 是波兰语原名，模型对它更可能音译，但库里有这类条目，漏了同样会误删。
    // 顺序必须在空格塌陷之前：「离线契约 巫师3」塌成「离线契约巫师3」后就找不到分隔位置了。
    // 先整段剥带括号的幻觉标题：`《巫师3：骑士圣殿》强化模组` 只剥「《巫师3」会剩一个孤立 `》`
    // （verify 实测 1/2201），所以凡「括号内出现巫师3」就整块拿掉，四个括号族都覆盖。
    if (mode === 'mod' && !/\bwitcher|巫师|猎魔人|杰洛特|\bTW\s?3\b|\bW3\b|wied[zź]min/i.test(String(src))) {
      s = s.replace(/[《【「『][^》】」』]*?巫师\s?3[^》】」』]*[》】」』]/g, ' ')
        .replace(/[《【「『"'（(]?\s*巫师\s?3\s*[》】」』"')）]?/g, ' ')
        .replace(/[\s,，、]{2,}/g, ' ')
        .replace(/^[\s\-–—,，:：、]+|[\s\-–—,，:：、]+$/g, '')
        .trim();
    }
    // 汉字段之间不该有半角空格：遮罩后的中文块（『黑暗之魂：重制版』）模型会当成独立短语，
    // 两边补空格 ——「烧焦的契约 黑暗之魂：重制版」「BTZ血红色 界面主题」。
    // 全语料 35/2431；只塌汉字↔汉字，汉字↔数字/英文的空格保留（「第 1 部分」不动）。
    if (mode === 'mod') s = s.replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1');
    s = toSimplified(s).trim();
    // 模型有时把路径反斜杠多转义一层（C:\\Users 变成 C:\\\\Users），原文没这层就压平
    if (String(src).indexOf('\\\\') === -1 && s.indexOf('\\\\') !== -1) s = s.replace(/\\\\/g, '\\');
    // 模型偶尔把整条译文用【】/「」/『』括起来当"标题"（实测短名称会这样），原文没有就剥掉
    // 注意：原文可能是被 JSON 包了一层的标题（["LogicMods Load Order"]），判断时要看壳里的真实内容
    const srcBare = String(src == null ? '' : src).replace(/^\s*\[\s*"([\s\S]*)"\s*\]\s*$/, '$1');
    // BBcode 文本（[b]Blood[/b]）开头也是「[」，但那不是标题括号，
    // 去掉 BBcode 标签后再判断，否则模型加的【】永远剥不掉（实测整段被包进【】）
    const srcHead = srcBare.replace(/\[\/?(?:b|i|u|s|url|img|quote|spoiler|list|\*|color|size|font|center|code|table|tr|td|th|h[1-6])(?:=[^\]]{0,64})?\]/gi, '').trim();
    if (!/^[【（「『\[\(]/.test(srcHead)) {
      const m2 = s.match(/^([【「『])([\s\S]*)([】」』])$/);
      if (m2) s = m2[2].trim();
      // 方括号 JSON 壳（review4）：模型把译文包成 [“模组内容”] / ["Mod Content"] 的壳，
      // 原文并没有方括号 → 剥掉。壳内不能含方括号，否则会把 [b]…[/b] 的标签本尊吃掉。
      const mShell = s.match(/^\[\s*["“”']*\s*([^\[\]【】「」『』]+?)\s*["“”']*\s*\]$/);
      if (mShell && mShell[1].trim()) s = mShell[1].trim();
    }
    // 模型也爱给游戏名/作品名套《》（实测游戏卡片显示成「《我的夏日座驾》」），原文没有就去掉
    if (s.indexOf('《') === 0 && s.indexOf('》') === s.length - 1 && String(src).indexOf('《') === -1) {
      s = s.slice(1, -1).trim();
    }
    // 模型有时给整条译文套一对弯引号（“…”），原文没有就剥掉
    if (!/^["'“”‘’]/.test(String(src == null ? '' : src))) {
      const m3 = s.match(/^["'“”‘’]([\s\S]*)["'“”‘’]$/);
      if (m3 && m3[1].trim()) s = m3[1].trim();
    }
    // 占位符丢了 → 这条算失败，宁可留英文也不要把界面搞坏
    const holes = String(src).match(/\{\{[^{}]+\}\}|%[sd]|\$\{\d+\}/g) || [];
    for (const h of holes) {
      if (s.indexOf(h) === -1) return markReject(src);
    }
    // html 模式：伪标签必须成对且编号一致，否则还原时会把链接/图标插错位置
    if (mode === 'html') {
      const want = (String(src).match(/<i(\d+)>/g) || []).map((x) => x.slice(2, -1)).sort();
      const got = (String(s).match(/<i(\d+)>/g) || []).map((x) => x.slice(2, -1)).sort();
      const gotClose = (String(s).match(/<\/i(\d+)>/g) || []).length;
      if (want.join(',') !== got.join(',') || gotClose !== got.length || got.length !== (String(src).match(/<\/i(\d+)>/g) || []).length) {
        return markReject(src);
      }
    }
    // BBcode：原文成对、译文拆了 → 宁可留英文，也不要在界面上露出 </i>
    if (/\[[a-z]+[\]=\/]/i.test(String(src)) && bbcodeBalanced(src) && !bbcodeBalanced(s)) {
      return markReject(src);
    }
    // 长文漏译保护：长段落译文短得离谱 → 模型偷懒概括或输出被截断。
    // 宁可返回原文让上层切片重翻，也不要把半截中文写进页面（用户实测「半页多没翻出来」）。
    // 正常英译中压缩比 0.4~0.6，低于 0.25 基本可以确定是漏译。
    const srcLen = String(src).length;
    if (mode === 'html' && srcLen > 300 && s.length < srcLen * 0.25) return markReject(src);
    // 反向缩写对：原文 SFW、译文写成 NSFW（或反过来）→ 语义反转，宁可留英文。
    // 返回原文后 out[k]===chunk[k]，retryEchoed 会再单条重试一次；仍反转就停在英文。
    if (mode === 'mod' && sfwInverted(src, s)) return markReject(src);
    return s;
  }

  let arr = extractJsonArray(content);
  if (!arr || arr.length === 0) {
    // 解析失败最常见的原因就是输出被 max_tokens 截断（长 changelog 批）：
    // 先把完整的前几条捞回来，缺的置 null 交给上层单条补发，别整批作废
    const salvaged = salvageJsonArray(content);
    if (salvaged.length > 0) arr = salvaged;
  }
  if (arr && arr.length > 0) {
    const mapped = arr.slice(0, texts.length).map((x, i) => {
      // 显式 null / "null" / "undefined" 一律归一成**真空位**（第九段）：
      // 模型偶尔在数组里吐字面量 null，`String(null)` 会把它变成文本 "null"，
      // 于是补 null 循环判 `!= null` 时它会通过（不补发）、守卫也看不见它，
      // 最后界面上留一个 "null"（verify 用桩复刻：`["甲",null] → ["甲","null"]`）。
      // 归一后才能走到补发/重译；正常译文不受影响。
      if (x == null) return null;
      if (typeof x === 'string' && /^(null|undefined)$/i.test(x.trim())) return null;
      const raw = String(x);
      const box = boxes[i];
      // 占位符被模型吃掉 = 路径没了。宁可这条留英文，也不要吐出坏路径让人照着删文件
      if (box && box.map.size) {
        for (const k of box.map.keys()) if (raw.indexOf(k) === -1) return markReject(texts[i]);
      }
      const done = restorePaths(finishOne(raw, texts[i]), box);
      // 模型会重新编号甚至臆造占位符（实测：URL 掩码是 {{P1}}，模型回成 {{P2}} 还多造
      // 一个 {{P1}}；另有 "Released under" 被译成 "以{{license}}许可发布"）。上面的 box
      // 校验只看「原占位符在不在」，防不住这种。还原后残留的字面量会直接显示给用户，
      // 所以译文里出现源文没有的 {{...}} 一律按格式不合规打回，宁可留英文。
      const srcHoles = new Set((String(texts[i]).match(/\{\{[^{}]+\}\}/g) || []));
      const outHoles = String(done).match(/\{\{[^{}]+\}\}/g) || [];
      if (outHoles.some((h) => !srcHoles.has(h))) return markReject(texts[i]);
      return done;
    });
    while (mapped.length < texts.length) mapped.push(null);
    return withRejects(mapped);
  }

  // 多条裸粘连：小批次时模型会把多条译文用「、」「，」连起来返回，不带数组语法
  // （实测 "“384 KB/秒”、“640 KB/秒”以及“896 KB/秒”。" 与 "药丸，品牌，药丸类型"）。
  // 整批判负 → 逐条重试，重试还可能再回声。按标点拆，仅当拆出条数正好等于输入条数、
  // 且至少一条确实变了才采用——条数对不上说明译文里自带标点，宁可不拆走逐条重试。
  // 第一轮不带「以及」，对不上再试带「以及」的，避免误拆含「和/以及」的正常译文。
  if (texts.length > 1) {
    let c = String(content).trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    c = c.replace(/^["'“”‘’\s]+/, '').replace(/["'“”‘’\s。．.]+$/, '');
    const trySplit = (sepRe) => {
      const parts = c.split(sepRe)
        .map((s) => s.trim().replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '').trim())
        .filter((s) => s.length > 0);
      if (parts.length !== texts.length) return null;
      if (!parts.some((p, i) => p !== String(texts[i]))) return null;
      return parts;
    };
    // ⛔ 2026-11-06 试过加第三轮 `：` 拆分（救「模型用冒号连多条」那种失败），**已撤销**：
    // 冒号在正常中文译文里太常见，条数约束挡不住误拆 —— 实测输入 2 条、模型只回
    // 「提示：启用此项」1 条时，会被拆成 ["提示","启用此项"] 正好 2 条而被采纳，
    // 结果是**静默错配**（比整批失败更难发现）。项目铁律：宁可留英文，绝不写错译文。
    const parts = trySplit(/[、，,；;]/) || trySplit(/[、，,；;]|以及/);
    if (parts) {
      const mapped2 = parts.map((p, i) => {
        const box = boxes[i];
        if (box && box.map.size) {
          for (const k of box.map.keys()) if (p.indexOf(k) === -1) return markReject(texts[i]);
        }
        try { return restorePaths(finishOne(p, texts[i]), box); } catch (e) { return markReject(texts[i]); }
      });
      return withRejects(mapped2);
    }
  }

  // 兜底：单条长文时小模型经常直接输出纯中文译文、不带 JSON 数组括号。
  if (texts.length === 1) {
    let raw = String(content).trim();
    raw = raw.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    raw = raw.replace(/^"+|"+$/g, '');
    const src = String(texts[0]);
    // 模型有时把整条译文用方括号括起来、且不带引号（实测 html 模式「inZOI Vortex Extension」
    // 稳定输出 [inZOI Vortex 扩展]）：这本身就是「只有一个元素的数组」，直接用括号里的内容
    const mOnly = raw.match(/^\[([^\[\]]{1,200})\]$/);
    if (mOnly && mOnly[1].trim() !== src.trim()) raw = mOnly[1].trim();
    // 模型偶尔输出「[原文] 译文」这种把原文包进方括号的格式（实测 inZOI 那条一直失败：
    // 「[inZOI Vortex Extension] 即为《inZOI Vortex》的扩展内容包。」），把前缀剥掉照样能用
    const mEcho = raw.match(/^\[([^\[\]]{1,160})\]\s*([\s\S]+)$/);
    if (mEcho && mEcho[1].trim().toLowerCase() === src.trim().toLowerCase() && /[\u4e00-\u9fff]/.test(mEcho[2])) {
      raw = mEcho[2].trim();
    }
    const cjkN = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
    // 中文占比门槛从 12% 降到 5%，且 html 模式不看占比、但要求至少一个汉字：
    // 实测「inZOI Vortex扩展」（8.3%）、「ModSkillSlotPages重制版1.8」（8.6%）都是有效
    // 译文被当成非中文丢弃；同一字符串模型多吐几个中文就能过——通过与否全看模型心情，
    // 是概率性失败。html 模式的伪标签配对、占位符齐全由下面的 finishOne 和 box 校验
    // 兜底，那里不过一样打回，这里再卡占比纯属误杀；但「一个汉字都没有」必须卡——
    // 英译中的译文不可能不含汉字，没有的一律是回声（含 [pillType] 这种括号粘连回声）。
    const structurallyOk = mode === 'html'
      ? (raw !== src && cjkN >= 1)
      : (cjkN >= 2 && cjkN / Math.max(1, raw.length) > 0.05);
    // 元话术拦截（2026-11-05）：模型有时不返回 JSON，而是回一段「这不是 JSON 数组，原因是…」
    // 的中文说明。单条兜底会把它当译文写进缓存 —— 实测 2 个位置被写成同一串、`_rejects` 空、
    // 不触发重试，用户看到的是界面文案变成一句解释。判据只留**真实语料零误伤**的三条：
    // 说明文字专属措辞（`JSON 数组`／`不是 JSON`）、两条长度失控（短标签回几百字、6 倍+200）。
    // 6420 条出厂译文（pack 6185 + domCache 235）实测三条合计误伤 0；『抱歉』『请注意』
    // 这类会出现在正常译文里（20/65 条命中），一律不进判据。
    const looksMeta = /不是\s*JSON|JSON\s*数组|返回的?(?:是)?\s*JSON/i.test(raw)
      || (src.length < 40 && raw.length > 300)
      || (src.length < 120 && raw.length > src.length * 6 + 200);
    // `raw !== src` 才拦：源文本身就是中文（含「JSON 数组」这种字面）时那是回声，
    // 应当走下面「无需翻译」的原样返回，不该被当成说明文字打回。
    if (looksMeta && raw !== src) throw new Error('模型回复是说明文字不是译文: ' + raw.slice(0, 200));
    if (raw !== src && structurallyOk) {
      const box0 = boxes[0];
      if (box0 && box0.map.size) {
        for (const k of box0.map.keys()) if (raw.indexOf(k) === -1) return withRejects([markReject(src)]);
      }
      return withRejects([restorePaths(finishOne(raw, src), box0)]);
    }
    // 回声分两种：真失败（该翻没翻）和「无需翻译」（源文已是中文 / 专名 / 标识符）。
    // 以前一律落到下面的 throw，上层记 failCache，两轮后 -1 永久跳过——每次出现都白烧
    // 一次调用，统计上的失败也是假的。无需翻译的返回原串算成功：界面无变化，也不进
    // failCache。真回声继续 throw，交给上层重试。
    // 判据：先把单层方括号剥掉再比（[pillType] 这种括号粘连回声），命中以下任一即无需翻译——
    // 源文已是中文；太短；没有小写开头单词的短串（NightSky 2.0.4、<i1>Steam</i1>、
    // SSEEdit、B.O.B. 这类专名，句子一定有 the/is/your 这类小写词）；纯符号。
    const bare = raw.replace(/^\[([^\[\]]{1,200})\]$/, '$1').trim();
    const srcBare = src.trim().replace(/^\[([^\[\]]{1,200})\]$/, '$1').trim();
    if (bare === srcBare) {
      const t = src.trim();
      const words = t.split(/\s+/).filter(Boolean);
      const hasLowerWord = words.some((w) => /^[a-z]/.test(w));
      const noop = /[\u4e00-\u9fff]/.test(src)
        || t.length < 4
        || (!hasLowerWord && words.length <= 3)
        || /^[A-Za-z0-9_.\-\/:{}+%]+$/.test(t)
        || /^[\W_]+$/.test(t);
      if (noop) return withRejects([src]);
    }
  }

  throw new Error('返回不是 JSON 数组: ' + content.slice(0, 300));
}

async function libreTranslate(cfg, one) {
  const eps = cfg.libreEndpoints || [];
  for (const ep of eps) {
    try {
      const body = JSON.stringify({ q: one, source: 'en', target: 'zh' });
      const r = await httpRequest(ep.replace(/\/+$/, '') + '/translate', 'POST',
        { 'Content-Type': 'application/json' }, body, 30000);
      if (r.status >= 200 && r.status < 300) {
        const j = JSON.parse(r.body);
        if (j && j.translatedText) return j.translatedText;
      }
    } catch (e) { /* try next */ }
  }
  return null;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 按字符预算切块：长文自动变小批，避免一批输出超出 max_tokens 被截断。
 * minChunks：并发保底——短文本总字符不够预算时也要切成 minChunks 块，
 * 否则 5 条并发车道只有 1 条有活干（用户实测“经常只有一路在跑”的根因）*/
function splitByBudget(texts, budget, minChunks) {
  const chunks = [];
  let cur = [], curLen = 0;
  for (const t of texts) {
    const len = String(t).length;
    if (cur.length > 0 && curLen + len > budget) { chunks.push(cur); cur = []; curLen = 0; }
    cur.push(t); curLen += len;
  }
  if (cur.length > 0) chunks.push(cur);
  const need = Math.max(1, Math.min(minChunks || 1, texts.length));
  if (chunks.length < need) {
    const per = Math.ceil(texts.length / need);
    const out = [];
    for (let i = 0; i < texts.length; i += per) out.push(texts.slice(i, i + per));
    return out;
  }
  return chunks;
}

/** 批量送翻时模型常把某几条整条照抄回来（看起来像拒翻），单条重发基本都肯翻。
 * 实证：27 条合集名/简介在一次批量里被整条照抄，逐条单独发都能正常译出。
 * 只在「照抄条数不多」时补发，避免整批都拒翻时白烧一串请求 */
/** 按「长句 / 短名」分桶后再按字符预算切块，返回**索引组**。
 * 为什么分桶：提示词是按整批平均长度选的（isUiBatch）——
 * 长简介和短模组名混在同一批时，模型会按长句模式处理，把短名整条照抄回来，
 * 实测 32 条混合批里 20 条被照抄；分开后短名批次走 mod 模式就不会了 */
function splitIndexed(texts, budget, minChunks, maxItems, splitKey) {
  // S1：可选 splitKey（与 texts 等长）→ 相邻两条 key 不同就强制断车，
  // 让「不同游戏的模组名」不再混在同一车（模型会拿别的游戏的上下文猜）。三条约定（§28.9）：
  //  ① 缺省 / 长度不等 → 完全走老路径，groups 与改动前逐字节一致（有断言守）
  //  ② 不可重编号：车里的 i 仍是**原 texts 的下标** → results 回填、onItem(idx)、
  //     onGroup({idxs}) 天然正确，**不需要 offset**（别以后看到分车就想加 offset）
  //  ③ 长度 ≠ texts.length 时按「忽略」处理，不抛错 —— 抛错会让整批失败，比不分组更糟
  const keys = (Array.isArray(splitKey) && splitKey.length === texts.length) ? splitKey : null;
  const long = [], short = [];
  for (let i = 0; i < texts.length; i++) {
    const t = String(texts[i]);
    if (t.length > 70 || t.split(/\s+/).length > 7) long.push(i); else short.push(i);
  }
  const groups = [];
  const build = (idxs) => {
    let cur = [], curLen = 0;
    const push = () => { if (cur.length > 0) { groups.push(cur); cur = []; curLen = 0; } };
    for (const i of idxs) {
      const len = String(texts[i]).length;
      // 单条就吃掉大半预算 → 独占一组。混进批里会把这批输出顶到 max_tokens 上限，
      // 结果整批截断、后半段全 null（更新日志这种长条目反复翻不出来就是这原因）
      if (len > budget * 0.55) { push(); groups.push([i]); continue; }
      if (cur.length > 0 && (curLen + len > budget || (maxItems && cur.length >= maxItems))) push();
      cur.push(i); curLen += len;
    }
    push();
  };
  if (!keys) {
    build(long);
    build(short);
  } else {
    // 有 splitKey 时：**先按 key 稳定排序，再沿排序后的连续段切，段内做长/短分桶** ——
    // 等价于「每款游戏按它自己的条目单独切」，长名/短名仍然分开（isUiBatch 那套保护不变）。
    // 不要改成「在 build 里遇到 key 变化就断」：那样全局长/短两桶会把同一游戏的条目劈到
    // 两个互不相邻的车里，每款游戏多出 1 车。
    //
    // 为什么先排序：不排序就只能按「输入里相邻的连续段」切，车数被输入顺序支配。
    // pending 现在是 collectTargets 出来的、天然按 gameId 连续，但那是**上游的巧合**：
    // 以后谁按名字排一次序、或把下载行插到中间，同一游戏就被切成十几段，每段各吃一辆
    // 装不满的车 —— 实测 304 车能顶到 2431 车（+700%）。排序把这一整类风险一次消掉，
    // 代价 O(n log n)，且交错输入 == 相邻输入（同 key 结果逐车相同）。
    // 排序稳定性：同 key 内按原下标升序（a - b），所以段内 long/short 的顺序、
    // 以及 build() 的装车结果与「不传 keys 的原序」完全一致（有断言守）。
    //
    // 请求数代价（2431 条全量 + `audit-corpus/filenames.json` join 的**真 gameId**：
    // 120 个游戏、每款 13~24 条、中位 20。用**绝对车数**报，百分比容易被误读）：
    //   装 1 个游戏（23 条）   4 → 4 车（+0）
    //   装 3 个游戏（62 条）   9 → 10 车（+1）
    //   装 5 个游戏（96 条）  13 → 16 车（+3）
    //   装 10 个游戏（204 条） 26 → 33 车（+7）
    //   全量 120 游戏（2431 条）304 → 387 车（+83）
    // 这是**结构下界**不是浪费：每款 20 条 + maxItems=8 → 每款至少 ceil(20/8)=3 车，
    // 120×3=360 是地板，387 已经贴着它。尾车最优合并最多回收 27 车，而合并会把两个游戏
    // 塞回同一车（正是分车要避免的）→ 不做尾车合并。
    // 作废的旧数（别再引用）：+18/+17/+24%（抽 N 款游戏的前几条当样本，小语料把边界浪费
    // 放大一个数量级）、+0.7/+1.6/+2.3%（把 2431 条均分成 k 份，每份 800 条能装满车，
    // 浪费被摊平）、+40%/+33.6%（同一类均分/极端口径）。
    //
    // 副作用（已知、可接受）：多游戏时 groups 的发射顺序变成按 key 字典序，不再跟随
    // pending 顺序。只影响进度面板里各游戏的先后（本来就是并发乱序），不影响任何回填：
    // 车里的 i 仍是原 texts 下标。minChunks 补块那段 groups.sort 本来就按长度重排，
    // 顺序从来不是契约。
    const isLong = new Set(long);
    const kOf = (i) => (keys[i] == null ? '' : String(keys[i]));
    const seq = [];
    for (let i = 0; i < texts.length; i++) seq.push(i);
    const order = seq.sort((a, b) => {
      const ka = kOf(a), kb = kOf(b);
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a - b;                     // 同 key 保原下标升序 → 稳定
    });
    let st = 0;
    while (st < order.length) {
      const k = kOf(order[st]);
      let en = st + 1;
      while (en < order.length && kOf(order[en]) === k) en++;
      const segLong = [], segShort = [];
      for (let p = st; p < en; p++) { const i = order[p]; (isLong.has(i) ? segLong : segShort).push(i); }
      build(segLong);
      build(segShort);
      st = en;
    }
  }
  const need = Math.max(1, Math.min(minChunks || 1, texts.length));
  if (groups.length < need) {
    // 并发保底：块数不够就把最大的几块再均分，保证每条并发车道有活干
    while (groups.length < need) {
      groups.sort((a, b) => b.length - a.length);
      const big = groups.shift();
      // 0.20 F-020-21（外审 O-4）：`!big` 以前和 `length < 2` 合成一句，而那句的
      // 动作是 `groups.push(big); break;` —— 空数组进来时 big 就是 undefined，
      // 结果**把 undefined 推回 groups**，splitIndexed([]) 返回 [undefined] 而不是 []。
      // 下游 `for (const g of groups) ... g.map(...)` 会直接 TypeError。
      // 实测确认可达：`splitIndexed([], 2400, 1, 0)` → `[undefined]`。
      if (!big) break;                        // 真没有可分的组 → 收手，绝不再 push
      if (big.length < 2) { groups.push(big); break; }
      const half = Math.ceil(big.length / 2);
      groups.push(big.slice(0, half), big.slice(half));
    }
  }
  return groups;
}

async function retryEchoed(cfg, chunk, out, results, idxs, mode) {
  const idx = [];
  for (let k = 0; k < chunk.length; k++) {
    if (out[k] === chunk[k]) idx.push(k);
  }
  if (idx.length === 0) return 0;
  // 多条整批照抄 = 模型状态异常，重发也没用（下一条可能就是好的）。
  // 但单条批次例外：实测同一字符串这次译下次抄（模型侧抖动，temperature 0.2 也在抖），
  // 单条回声重发一次约一半能救回来——而单条组恰恰是预算切分后最常见的形态，
  // 不救的话这些条目永远停在上一次的回声上。
  if (idx.length >= chunk.length && chunk.length > 1) return 0;
  if (idx.length > 20) return 0;                    // 太多说明批太大，交给下一次更小的批
  let fixed = 0;
  for (const k of idx) {
    try {
      const one = await llmTranslate(cfg, [chunk[k]], mode);
      if (one && one[0] && one[0] !== chunk[k]) { results[idxs[k]] = one[0]; fixed++; }
    } catch (e) { /* 保持原样，交给上层计失败 */ }
    await delay(cfg.requestDelayMs || 150);
  }
  return fixed;
}

/** 抽出「≥5 个拉丁字母」的词（C1bukii 的字母数够；UE4SS 只有 4 个字母，不算）。
 *  统一小写比较：mod 模式会把 ALL CAPS 归一化成首字母大写，大小写敏感会对不上。 */
function misalignWords(text) {
  const s = String(text == null ? '' : text);
  const re = /[A-Za-z0-9]+/g;
  const res = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[0].replace(/[^A-Za-z]/g, '').length < 5) continue;
    res.push(m[0].toLowerCase());
  }
  return res;
}

/** 串行错位守卫·路①（词证据）。一批里出现两条「只差标点/大小写」的名字时，
 *  本地小模型会把它们当成同一条、只给一个译文，再把最后一条译文重复一次补足
 *  数组长度 —— 长度对得上，`out.length !== chunk.length` 这种 shape 守卫**原理上**
 *  抓不到，结果后面条目整体位移：用户在界面上看到的是别的模组的译文
 *  （2431 条语料实测一次，位置 52-56）。
 *
 *  判据（两个方向，位移后两行都要命中）：chunk[k] **独有**的拉丁词（本批只出现在
 *  这一条里）既没留在 out[k] 里、又原样出现在**别的** out[j] 里；或者反过来，
 *  out[k] 里留着一条只属于 chunk[m] 的词，而 out[m] 自己没留住 —— 那只能是位置串了。
 *  词被模型翻成中文时无法判断（out[k] 里本来就不该有它），所以宁可漏判不可误判。
 *  **这条路覆盖率很低**：实测译文里保住锚点的只有 9.8%，纯词判据位置召回 9~15%
 *  （verify 独立量到 261/1787）。结构证据见 findRepeatPadding。
 * @returns {number[]} 错位条目下标（升序）；无异常返回 []
 */
function misalignLexical(chunk, out) {
  if (!Array.isArray(chunk) || !Array.isArray(out) || chunk.length === 0) return [];
  const n = Math.min(chunk.length, out.length);
  const mine = new Array(n);
  const seen = new Map();                     // 词 → 出现在几条 chunk 里（去重后按条计）
  for (let k = 0; k < n; k++) {
    const ws = Array.from(new Set(misalignWords(chunk[k])));
    mine[k] = ws;
    for (const w of ws) seen.set(w, (seen.get(w) || 0) + 1);
  }
  const have = new Array(n);                  // 每条译文里保留的拉丁词
  for (let k = 0; k < n; k++) have[k] = new Set(misalignWords(out[k]));
  const owner = new Map();                    // 唯一词 → 它唯一属于的那条下标
  for (let k = 0; k < n; k++) for (const w of mine[k]) if (seen.get(w) === 1) owner.set(w, k);
  const bad = [];
  for (let k = 0; k < n; k++) {
    if (out[k] == null) continue;             // 空条目走单条补发，不在这里判（避免重复烧调用）
    const lost = (mine[k] || []).filter((w) => seen.get(w) === 1 && !have[k].has(w));
    // ①「自己的独有词丢了，却出现在别人译文里」→ 自己被挤掉了。
    // 光「没保留」不算：可能只是被翻成了中文。只有它出现在别人译文里才是串位。
    const moved = lost.some((w) => {
      for (let j = 0; j < n; j++) if (j !== k && have[j].has(w)) return true;
      return false;
    });
    // ②「自己译文里留着一条只属于别人的词，而那条自己没留住」→ 自己装的是别人的内容。
    // 这一半不能省：位移之后「被偷的那条」和「偷的那条」是两行，只修前者等于没修
    // —— 用户真正看到错译文的恰恰是后者（52 号行显示 53 的译文）。
    let stole = false;
    if (!moved) {
      for (const w of have[k]) {
        const m = owner.get(w);
        if (m === undefined || m === k) continue;
        if (!have[m].has(w)) { stole = true; break; }
      }
    }
    if (moved || stole) bad.push(k);
  }
  return bad;
}

/** 两条源文是不是「本质同一条」：只差版本号/标点/大小写/结尾标记（PT BR T vs PT BR）。
 *  这种条目译文相同本来就是对的 —— 不能拿「译文重复」当错位证据。
 *  实测 304 个真实批次里有 4 批正是这种合法重复（Species Viewer Fix-1-1 vs -1-0、
 *  dao_extradogslot_1_41-664 vs -664、Mojo BetterBiomes ±MojoPrefabs、
 *  Perisno PT BR T vs PT BR），不设这道闸误报就从 0 变 4/304。 */
function nearSameSource(a, b) {
  const A = String(a == null ? '' : a).toLowerCase().replace(/[^a-z]/g, '');
  const B = String(b == null ? '' : b).toLowerCase().replace(/[^a-z]/g, '');
  if (!A || !B) return false;
  if (A === B) return true;
  if (A.indexOf(B) !== -1 || B.indexOf(A) !== -1) return true;   // 一条是另一条的前缀/子串
  if (Math.abs(A.length - B.length) > 2) return false;
  // 编辑距离 ≤2（只有「译文真重复」时才会走到这里，代价可忽略）
  let prev = [];
  for (let j = 0; j <= B.length; j++) prev[j] = j;
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= B.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > 2) return false;       // 整行都 >2 → 最终距离必然 >2
    prev = cur;
  }
  return prev[B.length] <= 2;
}

/** 串行错位守卫·路②（结构证据）。模型少给一条译文后会把最后一条重复一次补足
 *  数组长度 —— 这一步必然在 out 里留下一对**相邻完全相同**的译文。
 *  这是唯一不依赖「拉丁词被保留」的证据，而锚点在译文里的存活率只有 9.8%：
 *  纯词判据位置召回 9~15%，补上这条路后实测事故段（V6 52-56）5 个错位位置全进网。
 *  两道精度闸（缺一不可）：
 *    ① 两条译文 trim 后完全相等且非空；
 *    ② 两条源文不是「本质同一条」（见 nearSameSource）—— 只差版本号/标点的名字
 *      本来就该得到同一个译文，那种重复不是证据。
 *  @returns 首个可疑重复对的左下标 j（0..n-2）；没有返回 -1 */
function findRepeatPadding(chunk, out) {
  const n = Math.min(chunk.length, out.length);
  for (let j = 0; j + 1 < n; j++) {
    const a = String(out[j] == null ? '' : out[j]).trim();
    const b = String(out[j + 1] == null ? '' : out[j + 1]).trim();
    if (!a || a !== b) continue;
    if (nearSameSource(chunk[j], chunk[j + 1])) continue;
    return j;
  }
  return -1;
}

/** 串行错位守卫（B3）总入口：两路证据取并集。
 *  路①词证据见 misalignLexical；路②结构证据见 findRepeatPadding，命中后把 0..j
 *  全部交回单条重译（j 之前都可能被前移）。
 *  **只到 j，不含 j+1**：实测形态里模型重复的是最后一条、也是**正确**的那条译文
 *  （V6 的 57 号、构造样本的末条），动它只会白烧一次调用、还引入一次改写噪声。
 *  宁可漏判不可误判：误判 = 白烧调用 + 可能拿新结果盖掉一条本来正确的译文。
 *  该 bug 定向复现 60 次未成功，「能抓到」不能当验收判据；误报 0 才是。
 * @returns {number[]} 需要单条重译的下标（升序）；无异常返回 [] */
function findMisaligned(chunk, out) {
  if (!Array.isArray(chunk) || !Array.isArray(out) || chunk.length === 0) return [];
  const bad = misalignLexical(chunk, out);
  const j = findRepeatPadding(chunk, out);
  if (j >= 0) {
    const n = Math.min(chunk.length, out.length);
    for (let k = 0; k <= j && k < n; k++) {
      if (out[k] != null) bad.push(k);    // 空条目已由补 null 循环处理，不重复烧
    }
  }
  return Array.from(new Set(bad)).sort((x, y) => x - y);
}

/** F-019-33：全批「译文归属」守卫（跨组 / 跨车道）。
 *
 *  B3（findMisaligned）只在**同一组内**找「相邻重复译文」+「拉丁锚点保留」，
 *  而 splitIndexed 按字符预算 / `mod:`+`dl:` 分车把一批切成多组：云端模型把
 *  A 的译文填到 B 的位置时，两组各自都看不出异常；中文译文又几乎没有 ≥5 字母的
 *  拉丁锚点（注释自认存活率 9.8%）→ 两路证据同时失效，错译文直写 cache.json。
 *  这里拿**全批** texts + results 一起判，分强 / 弱两档：
 *    S1 强：同一译文被多条「非本质同源」的源文占用 → 至少一条串位。
 *           nearSameSource 复用 B3 的精度闸（同族 / 只差标点 / mod 与 dlname
 *           同键 属合法重复，不判）。
 *    S2 强：源文没有版本号，译文却带了**本批别的源文里出现过**的版本号 →
 *           这条译文是别人的（真机 `Lily…` 译文里冒出 `v2.7.4`）。
 *    W1 弱：源文带版本号、译文一个版本号都没有 → 可能串位，也可能只是模型
 *           省略版本号。所以弱档只触发一次单条重译、且只在「重译把版本号带
 *           回来」时才覆盖，**绝不置 null**（不能把合格译文改成英文）。
 *  @returns {{strong:number[], weak:number[]}} 下标升序、去重、weak 不含 strong
 */
function findCrossGroupClash(texts, results) {
  const strong = new Set();
  const weak = new Set();
  if (!Array.isArray(texts) || !Array.isArray(results)) return { strong: [], weak: [] };
  const n = Math.min(texts.length, results.length);
  if (n < 2) return { strong: [], weak: [] };       // 单条批次没有「跨组」概念
  const vals = new Array(n);
  for (let i = 0; i < n; i++) vals[i] = String(results[i] == null ? '' : results[i]).trim();

  // S1：按译文分组，只要组里存在两条源文不是「本质同一条」，整组标强可疑。
  const byVal = new Map();
  for (let i = 0; i < n; i++) {
    if (!vals[i]) continue;                        // 空条目走补 null，不在这里判
    if (!byVal.has(vals[i])) byVal.set(vals[i], []);
    byVal.get(vals[i]).push(i);
  }
  for (const idxs of byVal.values()) {
    if (idxs.length < 2) continue;
    let clash = false;
    for (let a = 0; a < idxs.length && !clash; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        if (!nearSameSource(texts[idxs[a]], texts[idxs[b]])) { clash = true; break; }
      }
    }
    if (clash) for (const i of idxs) strong.add(i);
  }

  // S2 / W1：版本号证据。正则内联字面量，避免全局正则的 lastIndex 与模块级常量依赖。
  const srcVers = new Set();
  for (let i = 0; i < n; i++) {
    const m = String(texts[i] == null ? '' : texts[i]).match(/\d+\.\d+(?:\.\d+)*/g) || [];
    for (const v of m) srcVers.add(v);
  }
  for (let i = 0; i < n; i++) {
    if (!vals[i] || strong.has(i)) continue;
    const sv = String(texts[i] == null ? '' : texts[i]);
    const hasSrcVer = (sv.match(/\d+\.\d+(?:\.\d+)*/g) || []).length > 0;
    const outVers = vals[i].match(/\d+\.\d+(?:\.\d+)*/g) || [];
    if (!hasSrcVer && outVers.some((v) => srcVers.has(v))) strong.add(i);
    else if (hasSrcVer && outVers.length === 0) weak.add(i);
  }
  const strongArr = Array.from(strong).sort((x, y) => x - y);
  const weakArr = Array.from(weak).filter((i) => !strong.has(i)).sort((x, y) => x - y);
  return { strong: strongArr, weak: weakArr };
}

/** F-019-33：把 findCrossGroupClash 的判据结果兑现成修复动作。
 *  强档：单条重译一次；新值不再触发强判据才覆盖，否则置 null（宁可留英文，绝不写错译文）。
 *  弱档：单条重译一次；只有「把版本号带回来」才覆盖，否则**保留原值**。
 *  两档都沿用「照抄原文不算修好」；每次重译之间照常 delay，不并发打模型。
 *  @returns {{changed:number[], retried:number}} changed 含「被置 null」的下标，
 *           调用方要据此撤掉按组贴屏已写下的旧值。
 */
async function repairCrossGroupClash(cfg, texts, results, mode) {
  const { strong, weak } = findCrossGroupClash(texts, results);
  const changed = [];
  let retried = 0;
  const askOne = async (i) => {
    try {
      const one = await llmTranslate(cfg, [texts[i]], mode);
      if (one && one[0] != null && one[0] !== texts[i]) return one[0];
    } catch (e) { /* 交给上层按失败处理 */ }
    return null;
  };
  // ★ 判据必须基于**事故现场快照**：串行重译时 results 会被前面的修复改掉，
  //   若拿「边修边变的中间态」去判，一条与原值一模一样的错译文会因为重复组
  //   已被前一条置 null 而不再构成重复 → 被误当成修好覆盖回去（审计实测）。
  const snapshot = results.slice();
  const stillStrong = (i, val) => {
    const probe = snapshot.slice();
    probe[i] = val;
    return findCrossGroupClash(texts, probe).strong.indexOf(i) >= 0;
  };
  // 0.20 F-020-03：以前只处理 `strong.slice(0,20)` / `weak.slice(0,10)`，越界项
  // **既不重译也不置 null**，带着可能错位的译文直接通过 —— 而冲突条目越多，越说明
  // 这一批的归属可信度低，恰恰是最该护栏的场景（长列表 / 大量同族名）。
  // 改法保留「串行重译有上限」这个性能约束（每条都要打一次模型 + delay，不能无界），
  // 但越界的**强冲突一律置 null 保持英文** —— 宁可留英文，绝不写错译文。
  // 弱冲突的越界项与「重译没改善」同口径（保留原值）：弱证据本就不足以判定错位，
  // 为它多烧一次模型没有根据，既定语义就是「没有改善证据就不动」。
  // ⚠ 「救谁」的语义边界（0.20 复核补）：`strong` 由 findCrossGroupClash 返回，
  //   已经是 `sort((x,y) => x-y)` 的**下标升序**，与遍历顺序无关（不是「谁先被发现就救谁」）。
  //   这个顺序**没有语义优先级**，也不打算编一个：判据只给布尔证据（S1/S2），
  //   没有「这条重译更可能成功」的信号；而上限是**成本预算**（每条一次模型调用 + delay），
  //   越界项一律置 null（留英文）而不是留错译文，所以挑选顺序不改变「最终有多少条是中文」
  //   的期望值，只改变是哪几条。谁要在这里按「看起来更严重」重排，先拿出可验证的强度信号，
  //   否则只是把下标序换成另一个同样任意的序。
  const STRONG_RETRY_CAP = 20;
  const WEAK_RETRY_CAP = 10;
  for (let n = 0; n < strong.length; n++) {
    const i = strong[n];
    if (n >= STRONG_RETRY_CAP) { results[i] = null; changed.push(i); continue; }
    const cand = await askOne(i);
    if (cand != null && !stillStrong(i, cand)) { results[i] = cand; retried++; }
    else results[i] = null;                    // 强证据仍成立 → 保持英文，绝不写错译文
    changed.push(i);
    await delay(cfg.requestDelayMs || 150);
  }
  for (let n = 0; n < weak.length; n++) {
    if (n >= WEAK_RETRY_CAP) continue;
    const i = weak[n];
    const cand = await askOne(i);
    // 弱证据只有「原本无版本号 → 重译后有版本号」才算改善；照抄 / 抛错都保留原值。
    const candHasVer = (String(cand == null ? '' : cand).match(/\d+\.\d+(?:\.\d+)*/g) || []).length > 0;
    if (cand != null && candHasVer && !stillStrong(i, cand)) { results[i] = cand; changed.push(i); retried++; }
    await delay(cfg.requestDelayMs || 150);
  }
  return { changed, retried };
}

async function translateBatch(cfg, cache, texts, mode, splitKey) {
  const rejects = new Set();
  const budget = Math.max(400, cfg.batchCharBudget || 2400);
  const groups = splitIndexed(texts, budget, 1, 0, splitKey);
  const res = new Array(texts.length).fill(null);
  // 最近一次取结果的失败原因（shape 不符 / 网络异常）。挂到返回值上给 DOM 层
  // 的 `err:` 字段看，否则日志里只有 `nullN` 没有原因。
  let batchErr = '';
  const run = async (g) => {
    const chunk = g.map((i) => texts[i]);
    // 逐条兜底（cache 优先 → 单条重发 → 可选 LibreTranslate）。
    // 抽成函数是因为有**两个入口**，两条必须走同一份实现，否则口径又漂：
    //   ① 取结果失败（返回不是 JSON 数组 / 条数不符 / 网络异常）—— 唯一的实际入口
    //   ② 正常处理段抛了非 CTX_OVER 的异常后落下来（罕见）
    // （早先这里还写过「②单条 shape 失败（拆不动了）」—— 那是拆半递归重试时代的话，
    //   拆半已删，见下面取结果那段注释。）
    const fallbackOne = async () => {
      for (let k = 0; k < chunk.length; k++) {
        const t = chunk[k];
        let r = cache[t];
        if (!r) {
          try {
            const single = await llmTranslate(cfg, [t], mode);
            // 0.20 F-020-19（外审 P2-5 的修正版）：llmTranslate 会把「格式被拒」
            // 的条目挂在返回数组的 `_rejects` 上（1109 的 withRejects）。正常路径在
            // 1824 汇总了它，**兜底路径以前只看 single[0]、把这份证据丢了** ——
            // 于是 DOM 层拿到「没有译文 + 没有被拒证据」，按「模型照抄原文」处理，
            // 计 2 次失败后置 -1 永久放弃；而真实原因是格式问题，本来可以换切分重试。
            // （注：`res._rejects` 本身一直有挂，1872 无条件执行；丢的是**单条那一份**。）
            if (single && single._rejects) for (const rr of single._rejects) rejects.add(rr);
            r = single[0];
          } catch (e) {
            // 公共 LibreTranslate 是隐私暗通道（文本逐条发往第三方服务器）：
            // 出厂配置不再预置 fallbackLibre / libreEndpoints，只有用户**显式**打开
            // 开关**并且**自己配了端点才启用（README 有说明）。单有条件都不触发。
            if (cfg.fallbackLibre === true && Array.isArray(cfg.libreEndpoints) && cfg.libreEndpoints.length > 0) {
              r = await libreTranslate(cfg, t);
            }
          }
        }
        res[g[k]] = r || null;
        await delay(cfg.requestDelayMs || 150);
      }
    };
    // 取结果失败（返回不是 JSON 数组 / 条数不符 / 网络异常）→ **逐条兜底重发**，不整批认输。
    // ⛔ 2026-11-06 这里曾经写过「拆半递归重试」，**已删除——改错地方了**：
    //   DOM 层走的是 translateConcurrently（index.js 同时注入了两个，DOM 层优先用并发版），
    //   translateBatch 只服务「预检探针」「探活」「并发版缺失时的 fallback」——全是 1 条调用，
    //   chunk.length===1，拆半分支**永远不会触发**，是纯死代码。
    //   真机实测（measure-real-dom-full.cjs，714 条真素材，concurrency=2/batchSize=20/budget=1200）：
    //   组级 shape 失败 1/15 批（6.7%），全部被下面 fallbackOne 的逐条重发救回，最终 null 0 条。
    //   → 真机需要的兜底本来就有，不用新加机制。
    let out;
    try {
      out = await llmTranslate(cfg, chunk, mode);
      if (!out || out.length !== chunk.length) throw new Error('batch shape ' + (out ? out.length : 'null') + '/' + chunk.length);
    } catch (e) {
      batchErr = String((e && e.message) || e).slice(0, 120);
      await fallbackOne();
      return;
    }
    try {
      if (out && out._rejects) for (const r of out._rejects) rejects.add(r);
      for (let k = 0; k < chunk.length; k++) res[g[k]] = out[k];
      await retryEchoed(cfg, chunk, out, res, g, mode);
      // 模型少返条目（max_tokens 截断后 salvage 的尾巴，或干脆漏译——实测 37 条
      // 长文批次 finish=stop 却只回 30 条）：llmTranslate 会把缺的补 null，
      // 这里必须像 translateConcurrently 一样单条补发，否则这些条目永远停空
      for (let k = 0; k < chunk.length; k++) {
        if (res[g[k]] != null) continue;
        try {
          const one = await llmTranslate(cfg, [chunk[k]], mode);
          if (one && one[0] != null) res[g[k]] = one[0];
        } catch (e) { /* 保持 null，上层计失败 */ }
        await delay(cfg.requestDelayMs || 150);
      }
      // 串行错位守卫（B3）：shape 守卫抓不到「长度对、内容整体位移」。
      // 放在补 null 之后，重译结果不会被补空循环盖掉。
      // ★ 判**补完 null 之后的有效结果**（同下标取 res），不要判原始 out：
      //   实测形态是「模型末位返 null、前一位填的是下一条的译文」，补 null 之后
      //   才出现相邻重复；判原始 out 会因为末位是 null 而看不见（verify 撞到的
      //   「命中却没救回」就是这一条，不是重译失败）。
      // 只给 mod 模式：本 bug 的实测证据全在模组名上，html/ui 的长文本单条重译贵得多，
      // 误判一次的成本不成比例 → 宁可那边不做（见 S4-T1 硬约束）。
      const eff = g.map((gi) => res[gi]);
      const shifted = mode === 'mod' ? findMisaligned(chunk, eff) : [];
      for (const k of shifted) {
        try {
          const one = await llmTranslate(cfg, [chunk[k]], mode);
          // 照抄原文不算修好：模型对 P1/Mods/BepInEx 这类短名的常见形态就是原样抄回。
          // 不加这个判据，一条**本来正确的中文译文**会被覆盖成英文原文 —— 那是把好的改坏，
          // 比不修更糟。口径与 retryEchoed 完全一致。
          if (one && one[0] != null && one[0] !== chunk[k]) res[g[k]] = one[0];
        } catch (e) { /* 保持原译文，交给上层计失败 */ }
        await delay(cfg.requestDelayMs || 150);
      }
      return;
    } catch (e) {
      // 上下文超限：劈半重发（模组简介动辄上千字符，整批塞进去会直接被服务端拒）
      if (e && e.code === 'CTX_OVER' && g.length > 1) {
        const half = Math.ceil(g.length / 2);
        // 与上面同一个理由：两半各自吞异常，不许把另一半和整次调用一起拖下水
        try { await run(g.slice(0, half)); } catch (e1) { batchErr = String((e1 && e1.message) || e1).slice(0, 120); }
        try { await run(g.slice(half)); } catch (e2) { batchErr = String((e2 && e2.message) || e2).slice(0, 120); }
        return;
      }
    }
    await fallbackOne();
  };
  for (const g of groups) await run(g);
  try { res._rejects = rejects; } catch (e) { /* ignore */ }
  // 失败原因带给调用方（DOM 层日志的 `err:` 读的就是这个字段）。
  // 以前 translateBatch 从不设 __err，DOM 日志里只有 nullN 没有原因。
  try { res.__err = batchErr; } catch (e) { /* ignore */ }
  // F-019-33：与 translateConcurrently 共用同一份全批归属守卫（同一判据不许两份实现）。
  // 本入口主要服务单条探针 / 探活（n===1 恒不命中，零开销）；DOM 层若走多文本批次同样受保护。
  if (mode === 'mod' && texts.length > 1) await repairCrossGroupClash(cfg, texts, res, mode);
  return res;
}

async function translateConcurrently(cfg, cache, texts, concurrency, onProgress, mode, onItem, onGroup, splitKey, onGroupDone, onCorrection) {
  const rejects = new Set();
  const lanes = Math.max(1, Math.min(10, concurrency || 5));
  // 按字符预算切块（不再固定每批 20 条）：20 条长文一批输出会爆 max_tokens 被截断，
  // JSON 解析失败整批作废 → 逐条慢速重试 → 页面长期半翻译。
  // minChunks=lanes：并发保底，短文本也要切满 lanes 块让每条车道都有活干
  const budget = Math.max(400, cfg.batchCharBudget || 1200);
  // 每组条数上限：小批更容易并行、单批输出不会爆 max_tokens；同类插件默认也是 8 条/批
  // 设置页那一项写的是 batchSize，这里以前只读 batchMaxItems（这个键 UI 里根本不存在），
  // 所以「每批送翻条数」改成 20 也没有任何效果，恒定 8 条。
  // F-019-22：硬上限不再写死 12，按地址档位取（本地 12 / 云端 24），仍受用户
  // batchSize 与下面 1200 字符预算双重约束。**不覆盖用户已配的并发 / 延迟 / 字符预算**。
  const ep = endpointProfileOf(cfg.provider && cfg.provider.baseUrl);
  const maxItems = Math.max(1, Math.min(ep.maxItems, cfg.batchMaxItems || cfg.batchSize || 8));
  const groups = splitIndexed(texts, budget, lanes, maxItems, splitKey);
  if (groups.length === 0) return [];

  const results = new Array(texts.length).fill(null);
  let cursor = 0;
  let finished = 0;
  let retried = 0;
  // F-019-16：错误串统一留 600 字符（原 140）。空正文探针带 finishReason /
  // reasoningLen / completionTokens / outTokens，140 会把它们全切掉，现场只剩
  // `"choices":[{"i` —— 本轮误判成内容审核就是这么来的。5 处调用点逐一对齐。
  let lastErr = '';
  // 面板用：告诉外面「这一组真的发出去了 / 回来了」，而不是把整批都算成正在翻译
  const emit = (ev) => { if (typeof onGroup === 'function') { try { onGroup(ev); } catch (e) { /* 面板回调不影响翻译 */ } } };
  // F-019-24 边翻边贴：一组译文「全部加工完毕」后按组贴屏。传的是**最终 results**
  // （补 null / 错位守卫 / 出口判据都已经跑完），不是模型原始 out。
  // 只有两条主链路传这个回调；translateAllFresh（有 doneMods 首中即胜，改序会翻车）
  // 与 DOM 层不传，保持全批完成再贴。回调抛错绝不能让整组被 catch 判失败、
  // 再走逐条兜底重发 —— 所以 core 与调用方两层都包 try/catch。
  const emitDone = (idxs) => {
    if (typeof onGroupDone !== 'function') return;
    try { onGroupDone(idxs, idxs.map((i) => results[i])); }
    catch (e) { /* 贴屏回调失败不影响翻译，调用方末尾补漏循环会兜住 */ }
  };

  const runGroup = async (g) => {
    const chunk = g.map((i) => texts[i]);
    emit({ type: 'start', idxs: g });
    // 0.20 F-020-20（外审 O-3）：一组的 start 只发一次，end 也必须只发一次。
    // 以前 CTX_OVER 劈半分支显式 `emit({type:'end'})`，然后 `return` 会走 `finally`
    // 再发一次 —— 同一条车道的结束事件发两遍。面板 `B.groups` 是「开始 +1 / 结束 -1」，
    // 收到两次 end 就会把别的仍在飞的车减掉（代码用 Math.max(0,…) 兜住不下溢，
    // 但计数已经偏小 → 「在飞几组」显示假低）。
    // 显式那次**不能删**：劈半前先放掉 inflight，否则整组会一直挂在「在飞」里
    // 直到两个半组跑完（长文分批时是几分钟）。所以改成「只发一次」而不是「只留 finally」。
    let ended = false;
    const endOnce = () => { if (ended) return; ended = true; emit({ type: 'end', idxs: g }); };
    try {
      const out = await llmTranslate(cfg, chunk, mode);
      if (out && out._rejects) for (const r of out._rejects) rejects.add(r);
      if (!out || out.length !== chunk.length) throw new Error('batch shape ' + (out ? out.length : 'null') + '/' + chunk.length);
      for (let k = 0; k < chunk.length; k++) results[g[k]] = out[k];
      const fixed = await retryEchoed(cfg, chunk, out, results, g, mode);
      if (fixed > 0) retried += fixed;
      // 被 max_tokens 截断时抢救出来的前半段是好的，后半段是 null：单条补发（一般只有 1-2 条）
      for (let k = 0; k < chunk.length; k++) {
        if (results[g[k]] != null) continue;
        try {
          const one = await llmTranslate(cfg, [chunk[k]], mode);
          if (one && one[0] != null) results[g[k]] = one[0];
          else lastErr = 'empty single';
        } catch (e) { lastErr = String((e && e.message) || e).slice(0, 600); }
        await delay(cfg.requestDelayMs || 150);
      }
      // 串行错位守卫（B3）：只差标点的两条名字会让模型少给一条译文再重复最后一条，
      // 长度刚好对上（shape 守卫看不见），后面整体位移。命中的条目单条重译并覆盖。
      // 放在补 null 之后，判**补完 null 的有效结果**（理由见 translateBatch 同处注释：
      // 实测是「末位 null + 前一位填了下一条译文」，判原始 out 会漏）。
      // 只给 mod 模式（同 translateBatch）。
      const eff = g.map((gi) => results[gi]);
      const shifted = mode === 'mod' ? findMisaligned(chunk, eff) : [];
      for (const k of shifted) {
        try {
          const one = await llmTranslate(cfg, [chunk[k]], mode);
          // 同 translateBatch：照抄原文不算修好（短名常态），否则会把一条正确的中文
          // 覆盖成英文原文。retried 只记真正被换掉的条数，照抄不计。
          if (one && one[0] != null && one[0] !== chunk[k]) { results[g[k]] = one[0]; retried++; }
        } catch (e) { lastErr = String((e && e.message) || e).slice(0, 600); }
        await delay(cfg.requestDelayMs || 150);
      }
      // 出口判据（0.18）：原文里的工具词在译文里一个都不剩 → 单条重问一次，指名要求保留。
      // 实测（116 条 × 1 轮、真实链路）：判可疑 5 条、**误杀 0 条**、救回 4 条 → 95.4% → 99.1%。
      // 三条保险：①只重试一次（不递归）②只在「全部丢失的词都回来」时才覆盖，
      // 只回来一部分就保留原译文 ③重试抛错也保留原译文 —— 任何情况都不丢条。
      if (mode === 'mod') {
        for (let k = 0; k < chunk.length; k++) {
          const cur = results[g[k]];
          if (cur == null) continue;
          const lost = lostToolTerms(chunk[k], cur);
          if (!lost.length) continue;
          try {
            const one = await llmTranslate(cfg, [chunk[k]], mode,
              '这一条必须原样保留这些词：' + lost.join('、') + '，一个字都不许改，也不许删除。');
            const cand = one && one[0];
            // cand !== chunk[k]：照抄原文不算修好（短名常态），与上面错位守卫同一口径
            if (cand != null && cand !== chunk[k] && !lostToolTerms(chunk[k], cand).length) {
              results[g[k]] = cand;
              retried++;
            }
          } catch (e) { lastErr = String((e && e.message) || e).slice(0, 600); }
          await delay(cfg.requestDelayMs || 150);
        }
      }
      finished += chunk.length;
      if (onProgress) onProgress(finished, texts.length);
      if (typeof onItem === 'function') {
        for (let k = 0; k < chunk.length; k++) {
          try { onItem(g[k], chunk[k], results[g[k]]); } catch (e) { /* 面板回调失败不影响翻译 */ }
        }
      }
      emitDone(g);   // F-019-24：这组可以贴屏了，不必等其他车道
      return;
    } catch (e) {
      // 上下文超限：劈半重发。整组直接判失败会让页面永远停在英文（用户实测「等几分钟还是英文」）
      if (e && e.code === 'CTX_OVER' && g.length > 1) {
        endOnce();
        const half = Math.ceil(g.length / 2);
        await runGroup(g.slice(0, half));
        await runGroup(g.slice(half));
        return;
      }
      lastErr = String((e && e.message) || e).slice(0, 600);
    } finally {
      endOnce();                                 // 与上面劈半分支共用，只发一次
    }
    for (let k = 0; k < chunk.length; k++) {
      // 缓存命中直接收：不进 onItem/onProgress（既有语义，改动会影响面板进度口径）
      const cached = cache[chunk[k]];
      if (cached) { results[g[k]] = cached; continue; }
      try {
        results[g[k]] = (await llmTranslate(cfg, [chunk[k]], mode))[0] || null;
      } catch (e) { lastErr = String((e && e.message) || e).slice(0, 600); }
      // F-020-24（v4 审计 §7.6）：逐条兜底这条路上的失败以前**一条都不报给面板** ——
      // 整组失败 → 逐条重发 → 仍然失败，`B.fail` 一动不动，面板显示「失败 0」。
      // 成功路径 2027 段是报的，这里补齐才有可比性；`B.ok - B.fail` 也才敢当成功率用。
      // 只在「真发了一次单独请求」之后报，缓存命中不报（不算一次尝试）。
      if (typeof onItem === 'function') {
        try { onItem(g[k], chunk[k], results[g[k]]); } catch (e) { /* 面板回调失败不影响翻译 */ }
      }
      finished += 1;
      if (onProgress) onProgress(finished, texts.length);
      await delay(cfg.requestDelayMs || 150);
    }
  };

  const worker = async () => {
    for (;;) {
      const my = cursor++;
      if (my >= groups.length) return;
      await runGroup(groups[my]);
    }
  };

  const workers = [];
  for (let i = 0; i < Math.min(lanes, groups.length); i++) workers.push(worker());
  await Promise.all(workers);
  // F-019-33：所有车道都回来之后才能判「跨组错位」——组内 B3 看不见别组的译文。
  // translateAllFresh 在本函数返回后才 apply，天然吃到纠正后的 results；
  // 两条流式链路已按组贴过屏，靠第 11 参 onCorrection 用纠正值强制覆盖。
  if (mode === 'mod' && texts.length > 1) {
    const rep = await repairCrossGroupClash(cfg, texts, results, mode);
    retried += rep.retried;
    if (rep.changed.length) {
      if (typeof onCorrection === 'function') {
        try { onCorrection(rep.changed, rep.changed.map((i) => results[i])); }
        catch (e) { /* 纠正回调失败不影响翻译结果 */ }
      }
      // 现场判据：真机一翻译就能在日志里看到有没有触发、触发几条，不用再猜。
      if (typeof log === 'function') log('info', 'cross group clash repaired', { n: rep.changed.length, retried: rep.retried });
    }
  }
  try { results.__err = lastErr; } catch (e) { /* ignore */ }
  // retried 只记「真被换掉」的条数（照抄不计）。挂出来给验收方核对口径用。
  try { results.__retried = retried; } catch (e) { /* ignore */ }
  try { results._rejects = rejects; } catch (e) { /* ignore */ }
  return results;
}

module.exports = {
  httpRequest,
  applyTerms,
  buildSystemPrompt,
  TOOL_TERMS,
  mergeToolTerms,
  lostToolTerms,
  isUiBatch,
  normalizeCase,
  normalizeCaseKeepMasks,
  toSimplified,
  extractJsonArray,
  splitByBudget,
  splitIndexed,
  pickModel,
  probeContext,
  isLocalBase,
  endpointProfileOf,
  estInputTokens,
  learnCtxFrom400,
  _ctxCache: () => ctxCache,
  outBudgetOf,
  retryBudgetOf,
  readChatCompletion,
  shouldRetryEmpty,
  emptyProbeOf,
  llmTranslate,
  libreTranslate,
  findMisaligned,
  findRepeatPadding,
  findCrossGroupClash,
  repairCrossGroupClash,
  sfwInverted,
  translateBatch,
  translateConcurrently,
  protectPaths,
  restorePaths,
  repairStruct,
};
