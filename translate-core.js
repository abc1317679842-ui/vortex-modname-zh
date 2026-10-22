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

function applyTerms(text, terms, direction) {
  let out = text;
  const sorted = (terms || []).slice().sort((a, b) => (b.en || '').length - (a.en || '').length);
  for (const t of sorted) {
    if (!t.en || !t.zh) continue;
    if (direction === 'mask') {
      // 必须带词边界。默认术语表里就有 Quest / Blood / Grass 这类短词，没有 \b 会切进别的单词：
      //   Bloody Mess → 『血迹』y Mess、Grasslands → 『草地』lands、Questionable → 『任务』ionable
      // 模型拿到这种半中半英的输入，译名就成了「血迹y 混乱」并被缓存下来。
      const bare = /^[A-Za-z0-9_]+$/.test(t.en);
      const re = new RegExp((bare ? '\\b' : '') + escapeRegExp(t.en) + (bare ? '\\b' : ''), 'gi');
      out = out.replace(re, '『' + t.zh + '』');
    } else {
      out = out.replace(new RegExp('『' + escapeRegExp(t.zh) + '』', 'g'), t.zh);
    }
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

/** 内置对照：写死在提示词里，不依赖用户术语表。
 *  模型对缩写极易认错（实测 TW3 被当成《上古卷轴3》，用户的合集名一半带 TW3），
 *  这种错误用后处理救不回来，只能在提示词里先钉死。 */
const BUILTIN_TERMS = [
  { en: 'TW3 / TW 3 / Witcher 3 / The Witcher 3 / W3', zh: '巫师3' },
  { en: 'CP2077', zh: '赛博朋克2077' },
  { en: 'BG3', zh: '博德之门3' },
  { en: 'SKSE / F4SE / NVSE', zh: '原样保留，不要翻译' },
  { en: 'Cleaner（做前缀时）', zh: '更清晰的 / 更干净的（不是"清洁版"）' },
  { en: 'Lite / Lightweight', zh: '轻量版' },
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

function protectPaths(text, box) {
  let s = String(text);
  const put = (frag) => {
    const k = '{{P' + (box.seq++) + '}}';
    box.map.set(k, frag);
    return k;
  };
  // BBcode 标签：模型根本不认 [b]/[i]/[u]，会当普通文字删掉或写坏闭合；
  // 实测 7B 把「[i]次世代[/i]」输成「[i]次世代</i>」，页面上直接露出 </i>。
  // 换成占位符最稳：模型只需原样搬占位符，不可能写坏标签。
  s = s.replace(/\[\/?(?:b|i|u|s|url|img|quote|spoiler|list|\*|color|size|font|center|code|h[1-6])(?:=[^\]]{0,64})?\]/gi,
    (m) => put(m));
  // 盘符路径 C:\Users\...\x.log
  s = s.replace(/[A-Za-z]:\\(?:[^\\\s"'<>|*?]+\\)*[^\\\s"'<>|*?]*/g, (m) => (m.length > 3 ? put(m) : m));
  // URL 整条
  s = s.replace(/https?:\/\/[^\s"'<>）)】]+/g, (m) => put(m));
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

function buildSystemPrompt(terms, mode) {
  const termHint = (terms || []).map((t) => `${t.en} => ${t.zh}`).join('\n');
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
    '2. 保留缩写与版本号（如 CWSO、HD、4K、v1.4.9、Next Gen 等），不要翻译它们。',
    '3. 只输出一个 JSON 数组，元素为字符串，顺序与输入完全一致，不要解释、不要代码块标记。哪怕只有一条输入，也必须输出形如 ["译文"] 的 JSON 数组，绝对禁止直接输出纯文本。',
    '4. 每条结果控制在 20 个汉字以内，宁短勿长。',
    '5. 只输出简体中文（中国大陆用词），严禁繁体字。',
    '6. 全部大写的名称（如 DELUXE PACK NEXT-GEN）也必须翻译成中文，绝对禁止原样返回英文。',
    '7. 成人向（NSFW）模组的名称也照常翻译，这只是游戏模组名，不要拒翻。',
    '8. 游戏名缩写必须按下面的对照译成正式中文名（TW3 是《巫师3》，不是《上古卷轴3》）；对照表里没有的缩写，保留原文，绝对不要猜成别的游戏。',
    '内置对照：\n' + builtinHint,
    termHint ? '术语对照：\n' + termHint : '',
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
    '10. 游戏名、软件名、模组名的缩写必须按下面的对照译成完整中文名（TW3 是《巫师3》，不是《上古卷轴3》）；对照表里没有的缩写，保留原文，绝对不要猜成另一个作品。',
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

/** 探测模型「实际加载」的上下文窗口。
 *  LM Studio 的 /api/v0/models 会给出 loaded_context_length（比如模型本身 256k，
 *  但界面里只加载了 4096）。请求超过它，LM Studio 直接 400
 *  "Context size has been exceeded" —— 整批作废、队列看起来像空跑，
 *  这就是合集页等几分钟还是英文的根因。拿不到就按本地 4096 / 云端 8192 保守估。 */
let ctxCache = { key: '', ctx: 0, at: 0 };
async function probeContext(base, key, model) {
  const k = String(base) + '|' + String(model);
  if (ctxCache.key === k && Date.now() - ctxCache.at < 60000) return ctxCache.ctx;
  let ctx = 0;
  try {
    const root = String(base).replace(/\/v1\/?$/i, '');
    const r = await httpRequest(root + '/api/v0/models', 'GET',
      key ? { Authorization: 'Bearer ' + key } : {}, null, 6000);
    if (r.status >= 200 && r.status < 300) {
      const j = JSON.parse(r.body);
      const m = (j.data || []).find((x) => x.id === model) || {};
      ctx = Number(m.loaded_context_length || m.max_context_length || 0) || 0;
    }
  } catch (e) { ctx = 0; }
  if (!ctx) ctx = /127\.0\.0\.1|localhost/i.test(String(base)) ? 4096 : 8192;
  ctxCache = { key: k, ctx, at: Date.now() };
  return ctx;
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

async function llmTranslate(cfg, texts, modeOverride) {
  const base = String((cfg.provider && cfg.provider.baseUrl) || '').replace(/\/+$/, '');
  const key = (cfg.provider && cfg.provider.apiKey) || '';
  const model = String((cfg.provider && cfg.provider.model) || '').trim();
  if (!base) throw new Error('未配置 provider.baseUrl');
  // 模型名必填：本地挂多个模型/云端列表几十个时自动选第一个不可靠，固定由用户指定
  if (!model) throw new Error('未配置模型名：本地模型可能有多个、云端列表更多，自动选择不可靠，请在扩展设置页填入模型名（如 hy-mt2-7b / deepseek-chat）');

  // 用户术语全带（量小）。游戏名只带「这一批文本里真出现了的」：
  // 以前是 slice(0, 200)，而 gamenames 按字母序排，第 200 条是 Dragon's Dogma，
  // 巫师3 / 天际 / 法环 / 辐射4 全在尾部 —— 86 款可用游戏只剩 18 款进得了提示词，
  // 等于「最需要的对照最先被砍掉」。
  const userTerms = (cfg.terms || []).slice(0, 200);
  const blob = texts.join('\n');
  const gameTerms = [];
  for (const t of (cfg.gameTerms || [])) {
    if (!t || !t.en || blob.indexOf(t.en) === -1) continue;
    gameTerms.push(t);
    if (gameTerms.length >= 40) break;      // 一批里不会同时出现几十款游戏
  }
  const terms = userTerms.concat(gameTerms);
  const mode = modeOverride || (isUiBatch(texts) ? 'ui' : 'mod');
  // 全大写归一化只用于模组名（小模型对 ALL CAPS 易拒翻）。
  // html / ui 层不能做：页面上真有 CWSO、UE4SS 这种全大写专名，归一化后会变成 Cwso / Ue4ss，
  // 模型照抄回来值≠原文，就被当成「翻译成功」写进缓存，等于把专名改坏了。
  const normalized = (mode === 'mod') ? texts.map(normalizeCase) : texts.slice();
  // 界面整句不遮术语（遮了会把长句拆碎，模型反而漏译）
  // 逐条遮，不要 join('\n') 再 split：只要任意一条文本自身含换行，拆出来的条数就比原来多，
  // payloadList / boxes / safeList 全部跟着错位 —— 第 N 条拿到的是前一条的一部分，静默错译。
  const payloadList = (mode === 'mod' && terms.length)
    ? normalized.map((t) => applyTerms(t, terms, 'mask'))
    : normalized;

  // 路径占位保护（mod 名里基本没有路径，只为 html/ui 的说明书、报错提示服务）
  const boxes = payloadList.map(() => ({ seq: 1, map: new Map() }));
  const safeList = payloadList.map((t, i) => protectPaths(t, boxes[i]));

  // 输出预算必须跟着输入走，但**绝不能超过模型实际加载的上下文**：
  // 之前写死 4096 撞 4096 的窗口，动态放大到 8192 更是直接超限，
  // LM Studio 返回 400「Context size has been exceeded」，整批作废。
  const inChars = safeList.reduce((n, s) => n + String(s).length, 0);
  const ctx = await probeContext(base, key, model);
  const estIn = Math.ceil(inChars / 1.6) + 500;             // 输入 token 估算（含系统提示词）
  const room = ctx - estIn - 128;                            // 留给输出的空间
  if (room < 400) {
    const e = new Error('CTX_OVER 输入约 ' + estIn + ' token，模型上下文只有 ' + ctx);
    e.code = 'CTX_OVER';
    throw e;                                                 // 上层把这批劈半重发
  }
  const want = Math.ceil(inChars * 1.8) + 256;               // 中文字数略多于英文
  const outTokens = Math.max(256, Math.min(want, room, 4096));

  const body = JSON.stringify({
    model: model,
    messages: [
      { role: 'system', content: mode === 'html' ? buildHtmlPrompt(terms) : buildSystemPrompt(terms, mode) },
      { role: 'user', content: JSON.stringify(safeList) },
    ],
    temperature: 0.2,
    max_tokens: outTokens,
  });

  const url = base + '/chat/completions';
  const headers = Object.assign({ 'Content-Type': 'application/json' },
    key ? { Authorization: 'Bearer ' + key } : {});
  let r = await httpRequest(url, 'POST', headers, body, 180000);

  // 429 / 502 / 503 / 504 是「服务端暂时不收」，不是「这段内容翻不了」。
  // 不在这里退避重试的话，云端一次限流就把整批打成失败、再逐条各失败一次，
  // 几轮之后条目被判放弃，用户只能清缓存重来。按 Retry-After 等，最多两次。
  for (let attempt = 0; attempt < 2 &&
    (r.status === 429 || r.status === 502 || r.status === 503 || r.status === 504); attempt++) {
    const ra = Number((r.headers && (r.headers['retry-after'] || r.headers['Retry-After'])) || 0);
    await delay(ra > 0 ? Math.min(ra * 1000, 15000) : 1200 * (attempt + 1));
    r = await httpRequest(url, 'POST', headers, body, 180000);
  }

  if (r.status < 200 || r.status >= 300) {
    throw new Error('HTTP ' + r.status + ' ' + r.body.slice(0, 200));
  }

  const j = JSON.parse(r.body);
  let content = '';
  if (j && j.choices && j.choices[0]) {
    content = (j.choices[0].message && j.choices[0].message.content) || j.choices[0].text || '';
  } else if (j && j.content) {
    content = j.content;
  }
  if (!content) throw new Error('模型返回为空: ' + r.body.slice(0, 300));

  // 拒收要分原因：finishOne 里 5 个「宁可留英文」的出口都是**格式不合规**，
  // 不是「模型不肯翻」。以前它们统一返回原文，上层就按「照抄」处理，两次即判 -1 不可译、
  // 永久封杀。这里把被拒收的原串记下来，上层据此走「暂态失败」而不是「不可译」。
  const rejects = new Set();
  const markReject = (src) => { rejects.add(String(src)); return String(src); };
  const withRejects = (list) => { try { list._rejects = rejects; } catch (e) { /* ignore */ } return list; };

  function finishOne(s, src) {
    if (mode === 'mod') s = applyTerms(s, terms, 'unmask');
    // 模型有时会把带『』标记的术语改写成「」等括号，统一清理掉包裹符号
    for (const t of terms) {
      if (!t.zh) continue;
      s = s.replace(new RegExp('[「『\\[(（《]' + escapeRegExp(t.zh) + '[」』\\])）》]', 'g'), t.zh);
    }
    s = toSimplified(s).trim();
    // 模型有时把路径反斜杠多转义一层（C:\\Users 变成 C:\\\\Users），原文没这层就压平
    if (String(src).indexOf('\\\\') === -1 && s.indexOf('\\\\') !== -1) s = s.replace(/\\\\/g, '\\');
    // 模型偶尔把整条译文用【】/「」/『』括起来当"标题"（实测短名称会这样），原文没有就剥掉
    // 注意：原文可能是被 JSON 包了一层的标题（["LogicMods Load Order"]），判断时要看壳里的真实内容
    const srcBare = String(src == null ? '' : src).replace(/^\s*\[\s*"([\s\S]*)"\s*\]\s*$/, '$1');
    // BBcode 文本（[b]Blood[/b]）开头也是「[」，但那不是标题括号，
    // 去掉 BBcode 标签后再判断，否则模型加的【】永远剥不掉（实测整段被包进【】）
    const srcHead = srcBare.replace(/\[\/?(?:b|i|u|s|url|img|quote|spoiler|list|\*|color|size|font|center|code|h[1-6])(?:=[^\]]{0,64})?\]/gi, '').trim();
    if (!/^[【（「『\[\(]/.test(srcHead)) {
      const m2 = s.match(/^([【「『])([\s\S]*)([】」』])$/);
      if (m2) s = m2[2].trim();
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
function splitIndexed(texts, budget, minChunks, maxItems) {
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
  build(long);
  build(short);
  const need = Math.max(1, Math.min(minChunks || 1, texts.length));
  if (groups.length < need) {
    // 并发保底：块数不够就把最大的几块再均分，保证每条并发车道有活干
    while (groups.length < need) {
      groups.sort((a, b) => b.length - a.length);
      const big = groups.shift();
      if (!big || big.length < 2) { groups.push(big); break; }
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

async function translateBatch(cfg, cache, texts, mode) {
  const rejects = new Set();
  const budget = Math.max(400, cfg.batchCharBudget || 2400);
  const groups = splitIndexed(texts, budget, 1);
  const res = new Array(texts.length).fill(null);
  const run = async (g) => {
    const chunk = g.map((i) => texts[i]);
    try {
      const out = await llmTranslate(cfg, chunk, mode);
      if (out && out._rejects) for (const r of out._rejects) rejects.add(r);
      if (!out || out.length !== chunk.length) throw new Error('batch shape ' + (out ? out.length : 'null') + '/' + chunk.length);
      for (let k = 0; k < chunk.length; k++) res[g[k]] = out[k];
      await retryEchoed(cfg, chunk, out, res, g, mode);
      return;
    } catch (e) {
      // 上下文超限：劈半重发（模组简介动辄上千字符，整批塞进去会直接被服务端拒）
      if (e && e.code === 'CTX_OVER' && g.length > 1) {
        const half = Math.ceil(g.length / 2);
        await run(g.slice(0, half));
        await run(g.slice(half));
        return;
      }
    }
    for (let k = 0; k < chunk.length; k++) {
      const t = chunk[k];
      let r = cache[t];
      if (!r) {
        try {
          const single = await llmTranslate(cfg, [t], mode);
          r = single[0];
        } catch (e) {
          if (cfg.fallbackLibre) r = await libreTranslate(cfg, t);
        }
      }
      res[g[k]] = r || null;
      await delay(cfg.requestDelayMs || 150);
    }
  };
  for (const g of groups) await run(g);
  try { res._rejects = rejects; } catch (e) { /* ignore */ }
  return res;
}

async function translateConcurrently(cfg, cache, texts, concurrency, onProgress, mode, onItem, onGroup) {
  const rejects = new Set();
  const lanes = Math.max(1, Math.min(10, concurrency || 5));
  // 按字符预算切块（不再固定每批 20 条）：20 条长文一批输出会爆 max_tokens 被截断，
  // JSON 解析失败整批作废 → 逐条慢速重试 → 页面长期半翻译。
  // minChunks=lanes：并发保底，短文本也要切满 lanes 块让每条车道都有活干
  const budget = Math.max(400, cfg.batchCharBudget || 1200);
  // 每组条数上限：小批更容易并行、单批输出不会爆 max_tokens；同类插件默认也是 8 条/批
  // 设置页那一项写的是 batchSize，这里以前只读 batchMaxItems（这个键 UI 里根本不存在），
  // 所以「每批送翻条数」改成 20 也没有任何效果，恒定 8 条。
  const maxItems = Math.max(1, Math.min(12, cfg.batchMaxItems || cfg.batchSize || 8));
  const groups = splitIndexed(texts, budget, lanes, maxItems);
  if (groups.length === 0) return [];

  const results = new Array(texts.length).fill(null);
  let cursor = 0;
  let finished = 0;
  let retried = 0;
  let lastErr = '';
  // 面板用：告诉外面「这一组真的发出去了 / 回来了」，而不是把整批都算成正在翻译
  const emit = (ev) => { if (typeof onGroup === 'function') { try { onGroup(ev); } catch (e) { /* 面板回调不影响翻译 */ } } };

  const runGroup = async (g) => {
    const chunk = g.map((i) => texts[i]);
    emit({ type: 'start', idxs: g });
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
        } catch (e) { lastErr = String((e && e.message) || e).slice(0, 140); }
        await delay(cfg.requestDelayMs || 150);
      }
      finished += chunk.length;
      if (onProgress) onProgress(finished, texts.length);
      if (typeof onItem === 'function') {
        for (let k = 0; k < chunk.length; k++) {
          try { onItem(g[k], chunk[k], results[g[k]]); } catch (e) { /* 面板回调失败不影响翻译 */ }
        }
      }
      return;
    } catch (e) {
      // 上下文超限：劈半重发。整组直接判失败会让页面永远停在英文（用户实测「等几分钟还是英文」）
      if (e && e.code === 'CTX_OVER' && g.length > 1) {
        emit({ type: 'end', idxs: g });
        const half = Math.ceil(g.length / 2);
        await runGroup(g.slice(0, half));
        await runGroup(g.slice(half));
        return;
      }
      lastErr = String((e && e.message) || e).slice(0, 140);
    } finally {
      emit({ type: 'end', idxs: g });
    }
    for (let k = 0; k < chunk.length; k++) {
      try {
        const c = cache[chunk[k]];
        if (c) { results[g[k]] = c; continue; }
        results[g[k]] = (await llmTranslate(cfg, [chunk[k]], mode))[0] || null;
      } catch (e) { lastErr = String((e && e.message) || e).slice(0, 140); }
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
  try { results.__err = lastErr; } catch (e) { /* ignore */ }
  try { results._rejects = rejects; } catch (e) { /* ignore */ }
  return results;
}

module.exports = {
  httpRequest,
  applyTerms,
  buildSystemPrompt,
  isUiBatch,
  normalizeCase,
  toSimplified,
  extractJsonArray,
  splitByBudget,
  splitIndexed,
  pickModel,
  probeContext,
  llmTranslate,
  libreTranslate,
  translateBatch,
  translateConcurrently,
  protectPaths,
  restorePaths,
};
