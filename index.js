// 柚月小手机增强（小白X记忆 + 智能滚动 + 微信时间）
//
// 功能一：小白X记忆桥接
//   柚月小手机里的 AI 请求（微信 / 朋友圈 / 微博 / X / 日记…）是手机自己拼提示词，不走酒馆的生成流程，
//   所以读不到小白X(LittleWhiteBox)注入的记忆。本插件读取小白X写入的
//   extension_prompts["LittleWhiteBox_StorySummary"]，并包装手机的 ApiManager.callAI，
//   在每次手机 AI 请求里多插入一条 system 消息（位置：手机带进来的主线正文聊天记录的末尾，紧挨在正文后面）。
//
// 功能一·附：给手机请求打缓存点
//   在稳定内容的结尾加 gproxy 魔法字符串（和 st-compress-cache 同一句），让 Claude 缓存手机请求的前缀。
//
// 功能二：通话智能滚动
//   手机在语音 / 视频 / 电话通话里，每出一条 AI 气泡都会执行 scrollTop = scrollHeight 强制拉到底。
//   本插件让你往上翻看时不再被拉回；只有本来就停在底部才自动跟随。
//
// 不修改柚月小手机和小白X的任何文件。找不到对应对象时静默失效，不影响它们正常使用。

const MODULE = 'yuzuki_phone_plus';
const LEGACY_BRIDGE = 'yuzuki_lwb_bridge'; // 旧版「记忆桥接」插件的设置，首次运行时迁移
const LWB_KEY = 'LittleWhiteBox_StorySummary';
const CACHE_KEY = 'yuzuki_lwb_bridge_cache_v1';
const CACHE_MAX_CHATS = 20;
const LOG = '[柚月小手机增强]';
const DIVIDER_TEXT = '[Start a new chat]';
// 与旧版独立插件使用相同的标记，万一没卸载旧插件，也不会重复包装
const PATCHED = Symbol.for('yuzuki_lwb_bridge.patched');
const MARK = '__yuzukiLwbBridge';
const SCROLL_FLAG = Symbol.for('yuzuki_call_comfort.patched');

/* ================================================================== 功能一：小白X记忆桥接 */

// 手机里各 App 的 appId（callAI 的 options.appId；没写的按 phone_online 算）
export const APPS = Object.freeze([
    ['wechat', '微信'],
    ['phone_online', '在线模式 / 默认'],
    ['phone_sms', '短信弹窗'],
    ['weibo', '微博'],
    ['x', 'X'],
    ['honey', '蜜语（直播）'],
    ['diary', '日记'],
    ['calendar', '日历'],
    ['wangxiang', '万象'],
    ['games', '游戏'],
    ['story', '剧情'],
]);

const DEFAULT_INTRO = '【主线剧情记忆（来自小白X）】以下是主线剧情里已经发生的事件、人物状态和关系的记忆摘要，只作背景参考。请严格遵守本次任务要求的输出格式，不要复述或引用这段记忆本身。';

export const DEFAULTS = Object.freeze({
    memoryEnabled: true,
    maxChars: 0, // 0 = 不限制
    intro: DEFAULT_INTRO,
    apps: Object.freeze(Object.fromEntries(APPS.map(([id]) => [id, true]))),
    smartScroll: true,
    alwaysScrollOnSend: true,
    cacheEnabled: true,      // 手机请求自动打缓存点（需要 gproxy 渠道打开 Magic-string cache）
    cacheTtl: '5m',          // 缓存时长：5m / 1h
    timeEnabled: true,       // 微信连发消息：放慢时间推进
    speedPercent: 100,       // 整体快慢：100 = 默认，50 = 快一倍，200 = 慢一倍
    sumEnabled: true,        // 微信聊天自动摘要
    sumTrigger: 300,         // 可见聊天攒到多少条就触发压缩
    sumTake: 200,            // 每次压缩最老的多少条（剩下的原文保留）
    sumMaxChars: 1500,       // 摘要大致上限（字）
    contextFollow: true,     // 手机读取的正文楼层数：跟随小白X的总结进度
    reasoningEffort: 'min',  // 手机请求的推理强度：off / min / low / medium / high / max
    log: false,
});

/* ---- 纯逻辑（有单元测试） ---- */

export function isDivider(m) {
    if (!m || m.role !== 'system') return false;
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    return text === DIVIDER_TEXT || String(m.name || '').includes('分界线');
}

// 从 start 开始，连续的「非 system」消息（= 手机带进来的主线正文聊天）结束的位置。
// 如果一路连到了最后一条（最后一条是本次请求的提问），要留出最后一条，记忆不能排到提问后面。
function endOfStoryRun(messages, start) {
    const n = messages.length;
    let end = start;
    while (end < n && messages[end] && messages[end].role !== 'system') end++;
    if (end >= n) end = Math.max(start, n - 1);
    return end;
}

// 记忆消息应该插在 messages 的哪个位置：主线正文聊天记录的「后面」（紧挨着正文结尾）
//   微信：  ……设定 → 分界线 → 正文聊天 → [记忆] → 其余
//   电话/短信：……设定 → 正文聊天 → [记忆] → 分界线 → 其余
//   微博等没有分界线的：……设定 → 正文聊天 → [记忆] → 其余
//   appId 用来判断正文在分界线的哪一边：微信（wechat）的正文在分界线后面，电话/短信等的正文在分界线前面
export function findInsertIndex(messages, appId) {
    if (!Array.isArray(messages) || messages.length === 0) return 0;
    const divider = messages.findIndex(isDivider);
    if (divider >= 0) {
        if (appId && appId !== 'wechat') return divider;
        const end = endOfStoryRun(messages, divider + 1);
        return end > divider + 1 ? end : divider; // 分界线后面没有正文（正文在分界线前面）时，放在分界线前
    }
    const firstNonSystem = messages.findIndex(m => m && m.role !== 'system');
    if (firstNonSystem >= 0) return endOfStoryRun(messages, firstNonSystem);
    return messages.length - 1; // 全是 system：保持最后一条仍在最后
}

export function buildMemoryContent(memory, intro, maxChars) {
    let body = String(memory || '').trim();
    if (!body) return '';
    if (maxChars > 0 && body.length > maxChars) body = body.slice(0, maxChars) + '\n…(记忆已截断)';
    const head = String(intro || '').trim();
    return head ? `${head}\n${body}` : body;
}

function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('');
    return '';
}

// 返回新数组（不改调用方的数组和消息对象）；无需处理时返回原数组
export function injectMemory(messages, memory, opts = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    const content = buildMemoryContent(memory, opts.intro, opts.maxChars);
    if (!content) return messages;
    if (messages.some(m => m && m[MARK])) return messages;
    // 请求里已经有同样的记忆（别的插件加的，或手动贴的）就不重复加
    const probe = String(memory).trim().slice(0, 60);
    if (probe && messages.some(m => m && contentToText(m.content).includes(probe))) return messages;
    const out = messages.slice();
    out.splice(findInsertIndex(messages, opts.appId), 0, {
        role: 'system',
        content,
        name: 'SYSTEM (小白X记忆)',
        isPhoneMessage: true,
        [MARK]: true,
    });
    return out;
}

/* ================================================================== 功能一·附：给手机请求打缓存点（gproxy 魔法字符串） */
// 做法和 st-compress-cache 一样：在要缓存的那条消息末尾加一句 gproxy 认识的魔法字符串，
// gproxy（渠道里打开 Magic-string cache）会把它删掉，并在那里打上 Claude 的 cache_control。
// 手机的请求不经过酒馆的发送流程，所以 st-compress-cache 管不到，这里自己加。
export const MAGIC = Object.freeze({
    '5m': 'GPROXY_MAGIC_STRING_TRIGGER_CACHING_CREATE_49VA1S5V19GR4G89W2V695G9W9GV52W95V198WV5W2FC9DF',
    '1h': 'GPROXY_MAGIC_STRING_TRIGGER_CACHING_CREATE_1FAS5GV9R5H29T5Y2J9584K6O95M2NBVW52C95CX984FRJY',
});
const MAGIC_PREFIX = 'GPROXY_MAGIC_STRING_TRIGGER_CACHING_CREATE_';
// 每次请求都会变的内容（排在它们前面的才算「稳定」）。名字是手机给消息起的。
const VOLATILE_NAMES = ['微信记录', '一起听歌', '通话 App 记录', '短信 App 记录', '朋友圈记录', '群成员朋友圈记录', '微信单聊记录', '通话 App 历史记录'];

function isVolatile(m) {
    const name = String(m?.name || '');
    return VOLATILE_NAMES.some(k => name.includes(k));
}

function withMarker(m, marker) {
    if (typeof m.content === 'string') return { ...m, content: m.content + '\n' + marker };
    if (Array.isArray(m.content)) return { ...m, content: [...m.content, { type: 'text', text: marker }] };
    return m;
}

// 返回新数组。打两个点（最多），都落在「稳定的内容」的结尾：
//   点1：正文 + 小白X记忆 的结尾（设定、世界书、正文、记忆，换聊天对象也基本不变）
//   点2：第一条「每次都变的内容」（微信记录、朋友圈、通话记录等）的前一条
// 最后一条（本次提问）和每次都变的内容永远不打点。
export function addCacheBreakpoints(messages, ttl = '5m', appId) {
    if (!Array.isArray(messages) || messages.length < 2) return messages;
    const marker = MAGIC[ttl] || MAGIC['5m'];
    if (messages.some(m => m && contentToText(m.content).includes(MAGIC_PREFIX))) return messages; // 已经有了
    const last = messages.length - 1;

    // 点1
    let bp1 = messages.findIndex(m => m && m[MARK]);
    if (bp1 < 0) {
        const cand = findInsertIndex(messages, appId) - 1;
        if (cand >= 0 && messages[cand] && messages[cand].role !== 'system') bp1 = cand;
    }
    // 点2
    let bp2 = -1;
    const firstVolatile = messages.findIndex(isVolatile);
    if (firstVolatile > 0) {
        bp2 = firstVolatile - 1;
        while (bp2 >= 0 && isDivider(messages[bp2])) bp2--; // 分界线的文字不能动
    }

    const targets = [...new Set([bp1, bp2])].filter(i => i >= 0 && i < last && !isVolatile(messages[i]) && !isDivider(messages[i]));
    if (!targets.length) return messages;
    const out = messages.slice();
    for (const i of targets) out[i] = withMarker(out[i], marker);
    return out;
}

/* ================================================================== 功能二：通话智能滚动 */

const BOTTOM_THRESHOLD = 80; // 距离底部不超过这么多像素，视为「在底部」
// 通话消息容器：微信视频 / 微信语音 / 电话App
export const CONTAINER_SELECTOR = '#video-chat-messages, #voice-chat-messages, #phone-call-messages';
// 我自己发的消息（发出时应当滚到底部）
const OWN_MESSAGE_RE = /justify-content:\s*flex-end|phone-call-message-user/;

// 是否应该拦截这次「滚到底部」
//   atBottom：滚动前用户是否停在底部；force：是否强制（比如我自己刚发了消息）
//   value：手机想设置的 scrollTop；maxTop：当前最大可滚动位置 (scrollHeight - clientHeight)
export function shouldBlockScroll({ enabled, smartScroll, atBottom, force, value, maxTop }) {
    if (!enabled || !smartScroll) return false;
    if (atBottom || force) return false;
    return Number(value) >= Number(maxTop) - 2; // 只拦「拉到底部」的赋值
}

export function isOwnMessageHtml(html) {
    return OWN_MESSAGE_RE.test(String(html || ''));
}

/* ================================================================== 功能三：微信连发消息的时间推进 */
// 手机里「线上」微信聊天的时间由手机自己推进（忽略 AI 写的时间）。原版每条消息要推进几分钟，
// 连发的短消息从第 3 条起还要额外加 1~3 分钟，一轮十几二十条就会跨十几分钟。
// 这里改成「每条消息的间隔只由这条消息本身决定」，像真人发消息：
//   固定的一点反应时间 + 字数 × 每字用时，再加一点随机；短句快、长句慢。
// 没有「一轮总共几分钟」的限制，条数多、消息长，时间自然就久。
// 「整体快慢」百分比把所有间隔统一放大或缩小。
// 聊天界面「距离上一个时间胶囊满 3 分钟才出现新的」是手机自带规则，这里不动。

export const REACT_SEC = 5;        // 每条消息固定的反应时间（秒）
export const SEC_PER_CHAR = 1.4;   // 每个字额外用时（秒）
export const MAX_ONE_MSG_SEC = 90; // 单条消息最多推进多久（防止一条超长消息把时间拉得离谱）

// 一条消息要推进多少毫秒
export function stepMs(textLength, speedPercent, rand = Math.random) {
    const len = Math.max(0, Number(textLength) || 0);
    const pct = Number.isFinite(Number(speedPercent)) && Number(speedPercent) > 0 ? Number(speedPercent) : 100;
    const sec = Math.min(MAX_ONE_MSG_SEC, REACT_SEC + len * SEC_PER_CHAR) * (0.75 + rand() * 0.5);
    return Math.max(1000, Math.round(sec * 1000 * pct / 100));
}

// 一轮开头的第一条只推几秒（不把 AI 请求的真实等待时间算进来）；其余按字数
export function advanceMs({ isFirst, speedPercent, textLength, rand = Math.random }) {
    if (isFirst) {
        const pct = Number(speedPercent) > 0 ? Number(speedPercent) : 100;
        return Math.max(1000, Math.round((4000 + Math.floor(rand() * 6000)) * pct / 100));
    }
    return stepMs(textLength, speedPercent, rand);
}
const CV_PATCHED = Symbol.for('yuzuki_phone_plus.chatview_patched2');

function currentBaseTimestamp(view, tm) {
    const own = Number(view._aiReplyTimestampCursor);
    if (Number.isFinite(own) && own > 0) return own;
    const cur = view._aiReplyTimeCursor || tm?.getCurrentStoryTime?.();
    if (!cur) return 0;
    const ts = Number(cur.timestamp);
    if (Number.isFinite(ts) && ts > 0) return ts;
    const parsed = Number(tm?.parseTimeToTimestamp?.(cur));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function patchChatViewProto(proto) {
    if (!proto || proto[CV_PATCHED]) return false;
    const needed = ['_applyAiReplyTimeline', '_buildShortWechatReplyGapMap',
        '_formatWechatTimeFromTimestamp', '_formatWechatDateFromTimestamp'];
    if (!needed.every(n => typeof proto[n] === 'function')) return false; // 手机改了内部名称：不处理
    proto[CV_PATCHED] = true;

    // 取消「连发短消息时第 3 条起额外加 1~3 分钟」
    const origGap = proto._buildShortWechatReplyGapMap;
    proto._buildShortWechatReplyGapMap = function (...args) {
        return safeSettings().timeEnabled ? new Map() : origGap.apply(this, args);
    };

    const origApply = proto._applyAiReplyTimeline;
    proto._applyAiReplyTimeline = function (msg, fallback, options = {}) {
        const s = safeSettings();
        const tm = globalThis.VirtualPhone?.timeManager;
        if (!s.timeEnabled || !msg || typeof msg !== 'object' || !tm) return origApply.call(this, msg, fallback, options);
        try {
            // 「线上时间按现实时间」模式：手机本来就按真实时间走，不处理
            if (typeof this._shouldUseRealTimeForOnlineChat === 'function' && this._shouldUseRealTimeForOnlineChat(options)) {
                return origApply.call(this, msg, fallback, options);
            }
            const isRoundStart = options?.isFirstInReplyBatch === true || !(Number(this._aiReplyTimestampCursor) > 0);
            let base = currentBaseTimestamp(this, tm);
            if (!(base > 0)) return origApply.call(this, msg, fallback, options);
            // 角色主动找你时，手机会给出「剧情里过了多久」，这个间隔保留
            if (isRoundStart) {
                // 剧情时间只记到分钟：上一轮最后一条如果带着秒数，这一轮不要倒退回去
                const last = Number(this._ypLastTs);
                if (Number.isFinite(last) && last > base && last - base < 60000) base = last;
                base += Math.max(0, Number(options?.extraGapMinutes) || 0) * 60 * 1000;
            }
            const text = String(msg.content || fallback || '').replace(/\s+/g, '');
            const add = advanceMs({ isFirst: isRoundStart, speedPercent: s.speedPercent, textLength: text.length });
            const ts = base + add;
            const prev = this._aiReplyTimeCursor || tm.getCurrentStoryTime?.() || {};
            msg.time = this._formatWechatTimeFromTimestamp(ts) || msg.time;
            msg.date = this._formatWechatDateFromTimestamp(ts) || msg.date;
            msg.weekday = this._getWechatWeekdayFromTimestamp?.(ts, prev.weekday) ?? msg.weekday ?? prev.weekday;
            msg.timestamp = ts;
            if (typeof tm.setTime === 'function' && msg.time && msg.date) {
                tm.setTime(msg.time, msg.date, msg.weekday || null);
                globalThis.VirtualPhone?.checkCalendarScheduleReminders?.(tm.getCurrentStoryTime?.() || { time: msg.time, date: msg.date, weekday: msg.weekday });
            }
            this._aiReplyTimeCursor = tm.getCurrentStoryTime?.() || { time: msg.time, date: msg.date, weekday: msg.weekday, timestamp: ts };
            this._aiReplyTimestampCursor = ts;
            this._ypLastTs = ts;
            stats.timeline++;
        } catch (e) {
            console.error(LOG, '时间推进出错，改用手机原来的算法', e);
            return origApply.call(this, msg, fallback, options);
        }
    };
    console.info(LOG, '已挂接微信连发消息的时间推进');
    return true;
}

function tryPatchChatView() {
    const cv = globalThis.VirtualPhone?.wechatApp?.chatView;
    if (!cv) return false;
    return patchChatViewProto(Object.getPrototypeOf(cv));
}

function startChatViewPatching() {
    if (tryPatchChatView()) return;
    // 微信 App 是懒加载的；等它出现
    const timer = setInterval(() => { if (tryPatchChatView()) clearInterval(timer); }, 2000);
}
/* ================================================================== 功能三：微信聊天自动摘要 */
// 微信聊天记录（含语音/视频通话）攒到「触发条数」后，把最老的一部分交给 AI 压缩成摘要，
// 这些旧消息只是打上手机自己的 hiddenFromPrompt 标记（手机里仍然看得到，AI 不再收到原文），
// 同时在发给 AI 的聊天记录最前面补上摘要。线上手机请求和酒馆正文都会带摘要。
// 摘要和「已被压缩的消息」都存在当前酒馆聊天里（手机存储里 chat_ 开头的键）。

const SUM_KEY = 'chat_yp_plus_summary';
const SUM_HEAD = '【更早的聊天摘要】';
const SUM_RETRY_MS = 5 * 60 * 1000;

const sumInt = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const sumClamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function sumParams(s = {}) {
    const trigger = sumClamp(sumInt(s.sumTrigger, 300), 40, 9999);
    const take = sumClamp(sumInt(s.sumTake, 200), 10, trigger - 10);
    return { trigger, take, keepLines: trigger - take, maxChars: sumClamp(sumInt(s.sumMaxChars, 1500), 300, 8000) };
}

// 手机发给 AI 时会跳过的消息（时间标记、已隐藏的）
export function isCountable(m) {
    return !!m && !(m.hiddenFromPrompt === true || m.isTimeMarker === true || m.type === 'time_marker');
}

// 和手机自己算「条数」的规则一致：接通的通话 = 通话里说的句数 + 2，其余 = 1
export function msgLines(m) {
    if (m?.type === 'call_record') {
        const n = Array.isArray(m.transcript) ? m.transcript.length : 0;
        return m.status === 'answered' ? n + 2 : 1;
    }
    return 1;
}

export function visibleLines(messages) {
    let t = 0;
    for (const m of messages || []) if (isCountable(m)) t += msgLines(m);
    return t;
}

// 返回 { cut, lines, count }：messages 里下标 < cut 的「可见消息」要被压缩；没到触发条数返回 null
//   keepLines：最少留下最近多少条；minKeepMessages：最少留下多少条消息（让正文注入不会和摘要重复）
//   maxLines：这一次最多压多少条（积压很多时分批压）
export function planCompression(messages, { trigger, keepLines, minKeepMessages = 0, maxLines = Infinity, force = false }) {
    if (!Array.isArray(messages)) return null;
    const total = visibleLines(messages);
    if (!force && !(total >= trigger)) return null;
    let acc = 0, cut = 0, enough = false;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (!isCountable(messages[i])) continue;
        acc += msgLines(messages[i]);
        cut = i;
        if (acc >= keepLines && messages.length - i >= minKeepMessages) { enough = true; break; }
    }
    if (!enough) return null; // 总共都不够留的
    let lines = 0, count = 0;
    for (let i = 0; i < cut; i++) {
        if (!isCountable(messages[i])) continue;
        lines += msgLines(messages[i]);
        count++;
        if (lines >= maxLines) { cut = i + 1; break; }
    }
    if (count === 0 || lines < 10) return null;
    return { cut, lines, count };
}

const oneLine = (t, n = 500) => String(t ?? '').replace(/<img[^>]*>/gi, '[图片]').replace(/\s*\n\s*/g, ' ').trim().slice(0, n);

function describeMessage(m) {
    const type = m.type || 'text';
    const content = String(m.content ?? '');
    if (type === 'text') return /^(data:image|https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$)/i.test(content.trim()) ? '[图片]' : oneLine(content);
    if (type === 'image') {
        const d = String(m.customEmojiDescription || m.customEmojiName || '').trim();
        return d ? `[表情包]（${d}）` : '[图片]';
    }
    if (type === 'transfer') return `[转账 ¥${m.amount ?? ''}]`;
    if (type === 'redpacket') return `[红包 ¥${m.amount ?? ''}]`;
    if (type === 'system') return oneLine(content);
    const text = /^data:/i.test(content.trim()) ? '' : oneLine(content, 200);
    return text ? `[${type}] ${text}` : `[${type}]`;
}

function describeCall(m, userName, chatName, t) {
    const kind = m.callType === 'video' ? '视频通话' : '语音通话';
    if (m.status !== 'answered') {
        const st = (m.status === 'rejected' || m.status === 'declined') ? '对方已拒绝' : m.status === 'cancelled' ? '已取消' : '未接听';
        return `${t}[${kind} - ${st}]\n`;
    }
    const lines = [`${t}[${kind}开始]`];
    for (const e of Array.isArray(m.transcript) ? m.transcript : []) {
        const text = oneLine(e?.text, 300);
        if (text) lines.push(`${e?.from === 'me' ? userName : String(e?.from || chatName || '对方')}: ${text}`);
    }
    lines.push(`[${kind}结束${m.duration ? `，时长 ${m.duration}` : ''}]`);
    return lines.join('\n') + '\n';
}

// 把一批消息整理成给 AI 读的文本
export function formatMessagesForSummary(msgs, chat, userName) {
    const isGroup = chat?.type === 'group';
    const chatName = chat?.name || '对方';
    let out = '', lastDate = '';
    for (const m of msgs || []) {
        if (!isCountable(m)) continue;
        if (m.date && m.date !== lastDate) { out += `--- ${m.date} ---\n`; lastDate = m.date; }
        const t = m.time ? `[${m.time}] ` : '';
        if (m.type === 'call_record') { out += describeCall(m, userName, chatName, t); continue; }
        const speaker = m.from === 'me' ? userName
            : (m.from === 'system' || m.type === 'system') ? '系统'
                : (isGroup && m.from ? m.from : chatName);
        out += `${t}${speaker}: ${describeMessage(m)}\n`;
    }
    return out.trim();
}

export function buildSummaryRequest({ oldSummary, transcript, chatName, isGroup, userName, maxChars }) {
    const system = [
        '你是微信聊天记录的摘要助手。你要把聊天记录压缩成一份给另一个 AI 阅读的备忘摘要，供它以后继续扮演聊天对象时参考。',
        '要求：',
        '1. 只保留对以后聊天有用的信息：双方关系和态度的变化、发生过的重要事件、约定和承诺、没有解决的事、双方的称呼和说话习惯、出现过的重要时间/地点/物品/数字。',
        '2. 语音通话、视频通话里说的内容和聊天一样重要，同样要提炼进去。',
        '3. 按时间顺序，用简洁的中文陈述句，不要逐句复述，不要写客套话，不要编造聊天里没有的内容。',
        `4. 用真实名字称呼双方（用户叫「${userName}」），不要用“用户”“对方”这类泛称。`,
        '5. 如果给了「已有摘要」，把新的聊天内容合并进去，输出一份完整的新摘要：旧摘要里仍然重要的要保留，已经不重要的细节可以压缩或删掉。',
        `6. 只输出摘要正文，不要标题、不要解释、不要加引号。总长度不超过 ${maxChars} 字。`,
    ].join('\n');
    const user = [
        `聊天窗口：${chatName}（${isGroup ? '群聊' : '单聊'}）`,
        '',
        '【已有摘要】',
        oldSummary ? oldSummary : '（还没有）',
        '',
        '【需要并入摘要的新聊天记录】',
        transcript,
        '',
        '请输出合并后的完整新摘要。',
    ].join('\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

export function cleanSummary(text, maxChars) {
    let t = String(text ?? '');
    t = t.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '').replace(/^```[a-z]*\n?|\n?```$/gi, '').trim();
    t = t.replace(/^(摘要|新摘要|合并后的摘要)\s*[:：]\s*/, '').trim();
    if (t.length > maxChars * 1.5) t = t.slice(0, Math.floor(maxChars * 1.5)) + '…';
    return t;
}

// ---- 酒馆正文去重 ----
// 手机往正文注入微信记录时，只会取「最近 N 条」，不会跳过已被压缩的消息。
// 这里把正文里该聊天开头属于已压缩消息的那几条删掉（摘要已经覆盖了它们），保留手机原有的格式。

const isTimeMarkerMsg = (m) => m?.isTimeMarker === true || m?.type === 'time_marker';

// 手机正文注入里，一条消息会变成几条「[时间] 说话人: 内容」：接通的通话 = 1 + 通话里非空句数，其余 = 1
export function entryCount(m, markersCount = true) {
    if (isTimeMarkerMsg(m) && !markersCount) return 0;
    if (m?.type === 'call_record' && m.status === 'answered' && Array.isArray(m.transcript)) {
        return 1 + m.transcript.filter(x => String(x?.text ?? '').trim()).length;
    }
    return 1;
}

const ENTRY_RE = /^\[(?:\d{1,2}:\d{2}|undefined|null|)\] /;
const DATE_RE = /^--- .+ ---$/;

// body：某个聊天在正文里的记录文本（不含标题行）。去掉最前面的 drop 条，并校验总条数 = expectedTotal
export function dropLeadingEntries(body, drop, expectedTotal) {
    const trail = (body.match(/\s*$/) || [''])[0];
    const lines = body.slice(0, body.length - trail.length).split('\n');
    const total = lines.filter(l => ENTRY_RE.test(l)).length;
    if (total !== expectedTotal) return { ok: false, body, total };
    if (drop <= 0) return { ok: true, body, total, dropped: 0 };
    let seen = 0, lastDate = '', i = 0;
    for (; i < lines.length; i++) {
        const l = lines[i];
        if (DATE_RE.test(l)) { lastDate = l; if (seen >= drop) break; continue; }
        if (ENTRY_RE.test(l)) { if (seen >= drop) break; seen++; }
    }
    const rest = lines.slice(i);
    if (rest.length && lastDate && !DATE_RE.test(rest[0])) rest.unshift(lastDate); // 保证剩下的第一条前面还有日期
    return { ok: true, body: rest.join('\n') + trail, total, dropped: drop };
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 在文本里每个聊天的标题行后面插入摘要。entries: [{ name, text, count }]
export function injectSummaryIntoText(text, entries) {
    if (typeof text !== 'string' || !text || text.includes(SUM_HEAD)) return text;
    let out = text;
    for (const e of entries) {
        const name = escapeRe(e.name);
        const block = `${SUM_HEAD}（更早的 ${e.count} 条聊天已被压缩成下面这段摘要，细节可能不全）\n${e.text}\n【以下是最近的原始聊天记录】\n`;
        const r1 = new RegExp(`━━━ ${name} 的聊天记录 ━━━\\n`);        // 微信线上请求 / 正文注入
        const r2 = new RegExp(`【💬 与 ${name} 的微信单聊记录】\\n[^\\n]*\\n`); // 电话里带的微信记录
        const hit = r1.exec(out);
        if (hit) {
            const start = hit.index + hit[0].length;
            let end = out.length;
            if (e.trim) {
                const next = /\n(?=━━━ |【)/g; next.lastIndex = start;
                const nm = next.exec(out);
                if (nm) end = nm.index + 1;
                const seg = out.slice(start, end);
                let res = { ok: false, body: seg };
                for (const v of e.trim) { res = dropLeadingEntries(seg, v.drop, v.total); if (res.ok) break; }
                e.trimResult = res.ok ? 'ok' : 'fail';
                out = out.slice(0, hit.index) + hit[0] + block + res.body + out.slice(end);
            } else {
                out = out.slice(0, start) + block + out.slice(start);
            }
        }
        else if (r2.test(out)) out = out.replace(r2, (m) => m + block);
    }
    return out;
}

// 返回新数组；没有变化返回原数组
export function addSummariesToMessages(messages, entries) {
    if (!Array.isArray(messages) || !entries?.length) return messages;
    let changed = false;
    const out = messages.map((m) => {
        if (!m) return m;
        if (typeof m.content === 'string') {
            const next = injectSummaryIntoText(m.content, entries);
            if (next === m.content) return m;
            changed = true;
            return { ...m, content: next };
        }
        if (Array.isArray(m.content)) {
            let any = false;
            const parts = m.content.map((p) => {
                if (p && p.type === 'text' && typeof p.text === 'string') {
                    const nt = injectSummaryIntoText(p.text, entries);
                    if (nt !== p.text) { any = true; return { ...p, text: nt }; }
                }
                return p;
            });
            if (any) { changed = true; return { ...m, content: parts }; }
        }
        return m;
    });
    return changed ? out : messages;
}

/* ---- 存取 ---- */

function phoneStorage() { return globalThis.VirtualPhone?.storage || null; }
function getWD() {
    const vp = globalThis.VirtualPhone;
    return vp?.wechatApp?.wechatData || vp?.cachedWechatData || globalThis.ggp_currentWechatApp?.wechatData || null;
}

function readSummaries() {
    try {
        const raw = phoneStorage()?.get?.(SUM_KEY, {});
        const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return o && typeof o === 'object' ? o : {};
    } catch { return {}; }
}
async function writeSummaries(o) { await phoneStorage()?.set?.(SUM_KEY, o); }

// 有效的摘要：聊天还在，并且里面确实有被我们压缩过的消息（聊天被清空后，旧摘要不再使用）
function summaryEntries(forMain = false) {
    const wd = getWD();
    if (!wd) return [];
    const out = [];
    for (const [id, rec] of Object.entries(readSummaries())) {
        if (!rec?.text) continue;
        try {
            const chat = wd.getChat?.(id);
            if (!chat?.name) continue;
            const all = wd.getMessages(id) || [];
            const n = all.filter(m => m?.ypPlusCompressed && !isTimeMarkerMsg(m)).length;
            if (n > 0) out.push({ name: chat.name, text: rec.text, count: n, trim: forMain ? planTrim(all, chat) : null });
        } catch { /* 忽略这个聊天 */ }
    }
    return out;
}

// 手机正文注入实际取的消息窗口 = 数组里最后 limit 条；算出里面开头有几条是已压缩的
function planTrim(all, chat) {
    const win = all.slice(-offlineLimit(chat));
    // 有的版本时间标记也会变成一条注入内容，有的不会；两种算法都准备好，哪个和正文对得上用哪个
    return [true, false].map((markersCount) => {
        const total = win.reduce((a, m) => a + entryCount(m, markersCount), 0);
        let drop = 0;
        for (const m of win) { if (!m?.ypPlusCompressed) break; drop += entryCount(m, markersCount); }
        return { drop, total };
    });
}

// 手机正文注入实际用的条数上限（和手机一样：读不出来或为 0 就用默认值）
function offlineLimit(chat) {
    const st = phoneStorage();
    const isGroup = chat?.type === 'group';
    return parseInt(st?.get?.(isGroup ? 'offline-group-chat-limit' : 'offline-single-chat-limit'), 10) || (isGroup ? 10 : 30);
}
function toast(kind, msg) { try { globalThis.toastr?.[kind]?.(msg, '微信聊天摘要'); } catch { /* 忽略 */ } }

// 当前是哪一个酒馆聊天（角色卡 / 群 / 聊天文件）。摘要请求要等 AI 返回，期间如果你切了聊天，结果必须作废
function tavernKey() {
    try {
        const c = ctx();
        return [c.groupId ?? '', c.characterId ?? '', c.chatId ?? ''].join('|');
    } catch { return ''; }
}

const sumRunning = new Set();
const sumFailedAt = new Map();

// -> { status: 'done' | 'skip' | 'fail', reason? }
export async function compressChat(chatId, { force = false, manual = false } = {}) {
    chatId = String(chatId);
    const tk = tavernKey();
    const runKey = tk + '##' + chatId;
    const s = getSettings();
    const wd = getWD();
    const holder = getCallAiHolder();
    if (!wd || !holder) return { status: 'skip', reason: '手机还没加载好' };
    if (sumRunning.has(runKey)) return { status: 'skip', reason: '正在压缩中' };
    if (!force && !manual && Date.now() - (sumFailedAt.get(runKey) || 0) < SUM_RETRY_MS) return { status: 'skip', reason: '刚失败过，稍后重试' };
    const chat = wd.getChat?.(chatId);
    if (!chat) return { status: 'skip', reason: '找不到这个聊天' };
    const msgs = wd.getMessages(chatId) || [];
    const p = sumParams(s);
    const plan = planCompression(msgs, { trigger: p.trigger, keepLines: p.keepLines, maxLines: p.take, force });
    if (!plan) return { status: 'skip', reason: '还没到触发条数' };

    const target = msgs.slice(0, plan.cut).filter(isCountable);
    let userName = '用户';
    try { userName = ctx().name1 || userName; } catch { /* 忽略 */ }
    const rawOld = readSummaries()[chatId];
    // 聊天被清空过（已没有被压缩的消息）时，旧摘要作废，不再并入新摘要
    const old = msgs.some(m => m?.ypPlusCompressed) ? rawOld : null;
    const req = buildSummaryRequest({
        oldSummary: old?.text || '',
        transcript: formatMessagesForSummary(target, chat, userName),
        chatName: chat.name, isGroup: chat.type === 'group', userName, maxChars: p.maxChars,
    });

    sumRunning.add(runKey);
    try {
        const res = await holder.callAI(req, { appId: 'wechat', ypPlusInternal: true, temperature: 0.3 });
        const text = cleanSummary(res?.summary ?? res?.content ?? res?.text, p.maxChars);
        if (!res || res.success === false || !text) throw new Error(res?.error || 'AI 返回为空');
        // 等 AI 的这段时间里如果切换了聊天 / 角色卡，这份摘要属于旧聊天，丢弃，什么都不写
        if (tavernKey() !== tk || getWD() !== wd) {
            console.info(LOG, '摘要生成期间切换了聊天，已丢弃这次结果，之后会重新压缩');
            return { status: 'skip', reason: '压缩期间切换了聊天，结果已丢弃' };
        }
        // 先存摘要，再隐藏原消息：中途出问题时，最坏只是摘要和原文同时存在，不会丢记录
        const all = readSummaries();
        all[chatId] = { text, at: Date.now(), rounds: (old?.rounds || 0) + 1 };
        await writeSummaries(all);
        // 读回来确认真的存进去了（没有打开的聊天时存储会静默失败），确认之前不隐藏任何原消息
        if (readSummaries()[chatId]?.text !== text) throw new Error('摘要没能保存到当前聊天');
        for (const m of target) { m.hiddenFromPrompt = true; m.ypPlusCompressed = true; }
        for (const m of msgs.slice(0, plan.cut)) if (isTimeMarkerMsg(m)) m.ypPlusCompressed = true; // 时间标记本来就不发给 AI，只做标记，方便正文去重时对数
        if (wd._messagesDirty) wd._messagesDirty[chatId] = true;
        await wd.saveData?.();
        stats.summarized++;
        sumFailedAt.delete(runKey);
        toast('success', `「${chat.name}」的 ${plan.count} 条旧聊天已压缩成摘要`);
        return { status: 'done', count: plan.count, chars: text.length };
    } catch (e) {
        sumFailedAt.set(runKey, Date.now());
        stats.sumFailed++;
        console.warn(LOG, '摘要失败', e);
        toast('warning', `「${chat.name}」的摘要生成失败（${e?.message || e}）。聊天记录没有被改动，稍后会自动重试。`);
        return { status: 'fail', reason: String(e?.message || e) };
    } finally {
        sumRunning.delete(runKey);
    }
}

let sumChecking = false;
async function checkSummaryTargets(manual = false) {
    if (sumChecking) return;
    sumChecking = true;
    try {
        const s = getSettings();
        if (!s.sumEnabled) return;
        const wd = getWD();
        if (!wd) return;
        const ids = new Set();
        const cur = globalThis.VirtualPhone?.wechatApp?.currentChat?.id;
        if (cur) ids.add(String(cur));
        for (const c of wd.getChatList?.() || []) if (wd._messagesLoaded?.[c.id]) ids.add(String(c.id));
        for (const id of ids) {
            for (let i = 0; i < 6; i++) { // 积压很多时分批压，最多连压 6 批
                const r = await compressChat(id, { manual });
                if (r.status !== 'done') break;
            }
        }
    } catch (e) {
        console.warn(LOG, '摘要检查出错', e);
    } finally {
        sumChecking = false;
    }
}

let sumTimer = null;
function scheduleSummaryCheck() {
    clearTimeout(sumTimer);
    sumTimer = setTimeout(() => { checkSummaryTargets(); }, 8000); // 等手机把 AI 的回复都存好
}

// 把某个聊天里被压缩的消息恢复成普通消息，返回恢复了几条
function restoreChatMessages(wd, chatId) {
    let n = 0;
    for (const m of wd.getMessages(chatId) || []) {
        if (m?.ypPlusCompressed) {
            delete m.ypPlusCompressed;
            if (!isTimeMarkerMsg(m)) { delete m.hiddenFromPrompt; n++; } // 时间标记本来就是隐藏的，不能取消
        }
    }
    if (n && wd._messagesDirty) wd._messagesDirty[chatId] = true;
    return n;
}

// 撤销：把被压缩的消息恢复成普通消息，并删除所有摘要
export async function undoAllSummaries() {
    const wd = getWD();
    let restored = 0;
    if (wd) {
        for (const c of wd.getChatList?.() || []) restored += restoreChatMessages(wd, c.id);
        await wd.saveData?.();
    }
    await writeSummaries({});
    return restored;
}

/* ---- 摘要管理：查看 / 修改 / 单独撤销某个微信窗口的摘要 ---- */

export function isSummaryBusy(chatId) { return sumRunning.has(tavernKey() + '##' + String(chatId)); }

// 当前酒馆聊天里所有微信窗口的摘要
export function listSummaries() {
    const wd = getWD();
    const out = [];
    for (const [id, rec] of Object.entries(readSummaries())) {
        if (!rec?.text) continue;
        let name = '', isGroup = false, count = 0, exists = false;
        try {
            const chat = wd?.getChat?.(id);
            if (chat?.name) {
                exists = true; name = chat.name; isGroup = chat.type === 'group';
                count = (wd.getMessages(id) || []).filter(m => m?.ypPlusCompressed && !isTimeMarkerMsg(m)).length;
            }
        } catch { /* 忽略 */ }
        out.push({
            id, name: name || '（这个聊天已经不存在）', isGroup, text: String(rec.text), at: rec.at || 0,
            rounds: rec.rounds || 1, edited: !!rec.edited, count, exists,
            active: exists && count > 0, // 没有被压缩的消息时（聊天被清空过），这份摘要不会再被使用
        });
    }
    return out;
}

const BUSY_MSG = '这个窗口正在生成摘要，请等它结束后再操作。';

// 手动修改摘要文字。不改压缩次数，也不动任何聊天消息
export async function saveSummaryText(chatId, text) {
    chatId = String(chatId);
    text = String(text ?? '').trim();
    if (!text) return { ok: false, reason: '摘要不能是空的。想删掉请用「撤销这个窗口的摘要」。' };
    if (text.length > 20000) return { ok: false, reason: '摘要太长了（超过 20000 字），请精简一下。' };
    if (isSummaryBusy(chatId)) return { ok: false, reason: BUSY_MSG };
    const all = readSummaries();
    const rec = all[chatId];
    if (!rec) return { ok: false, reason: '这份摘要已经不存在了，请刷新列表。' };
    all[chatId] = { ...rec, text, edited: true, editedAt: Date.now() };
    await writeSummaries(all);
    if (readSummaries()[chatId]?.text !== text) return { ok: false, reason: '没能保存到当前聊天，请重试。' };
    return { ok: true };
}

// 只撤销一个微信窗口：它被压缩的消息恢复成普通消息，并删掉它的摘要。别的窗口不动
export async function undoSummary(chatId) {
    chatId = String(chatId);
    if (isSummaryBusy(chatId)) return { ok: false, reason: BUSY_MSG };
    const wd = getWD();
    let restored = 0;
    // 先恢复消息并保存，再删摘要：中途出问题最坏只是摘要还在但已无效，不会丢聊天记录
    if (wd && wd.getChat?.(chatId)) {
        restored = restoreChatMessages(wd, chatId);
        await wd.saveData?.();
    }
    const all = readSummaries();
    delete all[chatId];
    await writeSummaries(all);
    return { ok: true, restored };
}

// 酒馆正文：手机在发送前把「微信历史」塞进了请求，这里在它后面补上摘要
function onPromptReady(data) {
    try {
        if (!getSettings().sumEnabled || !data || !Array.isArray(data.chat)) return;
        const entries = summaryEntries(true);
        if (!entries.length) return;
        const next = addSummariesToMessages(data.chat, entries);
        for (const e of entries) {
            if (e.trimResult === 'ok') stats.sumTrimOk++;
            else if (e.trimResult === 'fail') { stats.sumTrimFail++; console.warn(LOG, `「${e.name}」正文里的聊天记录条数和预期对不上，没有去掉已压缩的旧消息（摘要和这些旧消息会同时出现）`); }
        }
        if (next === data.chat) return;
        for (let i = 0; i < next.length; i++) data.chat[i] = next[i];
        stats.sumInjectedMain++;
    } catch (e) {
        console.warn(LOG, '正文摘要注入出错', e);
    }
}

/* ================================================================== 酒馆接入 */

function ctx() {
    return globalThis.SillyTavern.getContext();
}

export function getSettings() {
    const store = ctx().extensionSettings;
    const fresh = !store[MODULE];
    if (fresh) {
        store[MODULE] = {};
        const old = store[LEGACY_BRIDGE]; // 从旧版记忆桥接迁移
        if (old && typeof old === 'object') {
            if (Object.hasOwn(old, 'enabled')) store[MODULE].memoryEnabled = old.enabled;
            for (const k of ['maxChars', 'intro', 'apps', 'log']) if (Object.hasOwn(old, k)) store[MODULE][k] = old[k];
        }
    }
    const s = store[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (!Object.hasOwn(s, k)) s[k] = (k === 'apps') ? { ...v } : v;
    }
    for (const [id] of APPS) if (!Object.hasOwn(s.apps, id)) s.apps[id] = true;
    return s;
}

function safeSettings() {
    try { return getSettings(); } catch { return { ...DEFAULTS, memoryEnabled: false, smartScroll: false }; }
}

const stats = { containers: 0, blockedScrolls: 0, injected: 0, timeline: 0, cached: 0, summarized: 0, sumFailed: 0, sumInjectedMain: 0, sumTrimOk: 0, sumTrimFail: 0, sumInjectedPhone: 0 };

/* ---- 记忆读取与缓存 ---- */

function readCache() {
    try { return JSON.parse(globalThis.localStorage?.getItem(CACHE_KEY) || '{}') || {}; } catch { return {}; }
}

function remember(chatId, text) {
    if (!chatId || !text) return;
    try {
        const all = readCache();
        all[chatId] = { text, at: Date.now() };
        const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, CACHE_MAX_CHATS);
        globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(keep)));
    } catch (e) {
        console.warn(LOG, '记忆副本保存失败', e);
    }
}

export function clearCache() {
    try { globalThis.localStorage?.removeItem(CACHE_KEY); } catch { /* 忽略 */ }
}

// -> { text, source: 'live' | 'cache' | 'none', at? }
export function getMemory() {
    const c = ctx();
    const chatId = c.chatId ? String(c.chatId) : '';
    const live = c.extensionPrompts?.[LWB_KEY]?.value;
    if (typeof live === 'string' && live.trim()) {
        remember(chatId, live);
        return { text: live, source: 'live' };
    }
    const cached = chatId ? readCache()[chatId] : null;
    if (cached?.text) return { text: cached.text, source: 'cache', at: cached.at };
    return { text: '', source: 'none' };
}

function prepareMessages(messages, options) {
    const s = getSettings();
    const appId = String(options?.appId || 'phone_online');
    let out = withMemory(messages, s, appId);
    if (s.sumEnabled) {
        const entries = summaryEntries();
        const withSum = entries.length ? addSummariesToMessages(out, entries) : out;
        if (withSum !== out) stats.sumInjectedPhone++;
        out = withSum;
    }
    if (s.cacheEnabled) {
        const marked = addCacheBreakpoints(out, s.cacheTtl, appId);
        const added = marked !== out;
        if (added) stats.cached++;
        out = marked;
        if (s.log) console.info(LOG, `${appId}：缓存点 ${added ? '已添加' : '未添加'}`);
    }
    return out;
}

function withMemory(messages, s, appId) {
    if (!s.memoryEnabled) return messages;
    if (Object.hasOwn(s.apps, appId) && s.apps[appId] === false) return messages;
    const mem = getMemory();
    if (!mem.text) {
        if (s.log) console.info(LOG, `${appId}：目前没有可用的小白X记忆`);
        return messages;
    }
    const out = injectMemory(messages, mem.text, { intro: s.intro, maxChars: Number(s.maxChars) || 0, appId });
    if (out !== messages) stats.injected++;
    if (s.log) {
        console.info(LOG, `${appId}：${out === messages ? '已存在，跳过' : '已注入'} ` +
            `${mem.text.length} 字（来源：${mem.source === 'live' ? '实时' : '副本'}），消息 ${messages.length} -> ${out.length}`);
    }
    return out;
}

/* ---- 挂到手机的 ApiManager.callAI ---- */

function getCallAiHolder() {
    const manager = globalThis.VirtualPhone?.apiManager;
    if (!manager) return null;
    const holder = Object.hasOwn(manager, 'callAI') ? manager : Object.getPrototypeOf(manager);
    return holder && typeof holder.callAI === 'function' ? holder : null;
}

function tryPatchApi() {
    const holder = getCallAiHolder();
    if (!holder) return false;
    if (holder.callAI[PATCHED]) return true;
    const original = holder.callAI;
    const wrapped = function (messages, options) {
        if (options?.ypPlusInternal) return trackPhoneCall(() => original.call(this, messages, options)); // 摘要自己的请求：不加记忆/缓存点
        let next = messages;
        try { next = prepareMessages(messages, options || {}); } catch (e) { console.error(LOG, e); }
        const result = trackPhoneCall(() => original.call(this, next, options));
        try {
            const id = String(options?.appId || 'phone_online');
            if (id === 'wechat' || id === 'phone_online') Promise.resolve(result).then(scheduleSummaryCheck, scheduleSummaryCheck);
        } catch { /* 忽略 */ }
        return result;
    };
    wrapped[PATCHED] = true;
    holder.callAI = wrapped;
    console.info(LOG, '已挂接手机的 ApiManager.callAI');
    return true;
}

function startApiPatching() {
    if (tryPatchApi()) return;
    // 手机是懒加载的，等它的 ApiManager 出现
    const timer = setInterval(() => { if (tryPatchApi()) clearInterval(timer); }, 1500);
}

/* ================================================================== 功能五：手机请求的推理强度 */
// 手机发给酒馆后端的请求里没有 reasoning_effort，Claude 5 / Opus 4.7+ 这类自适应思考的模型会按模型自己的默认值思考。
// 这里在手机请求（且仅手机请求）发出去之前，补上 reasoning_effort。酒馆后端会把它转成 output_config.effort。
// 只对「自适应思考」的新模型生效；老模型（如 opus-4-5）不带这个参数时本来就不思考，加了反而会开启思考，所以跳过。
const EFFORT_LABELS = { off: '不设置（保持手机原样）', min: '极低', low: '低', medium: '中', high: '高', max: '最高' };
const ADAPTIVE_MODEL = /claude-(opus-4-7|opus-4-8|opus-5|sonnet-5|fable)/;
let phoneInflight = 0;
const effortState = { last: '' };

function trackPhoneCall(fn) {
    phoneInflight++;
    let result;
    try { result = fn(); } catch (e) { phoneInflight--; throw e; }
    const done = () => { phoneInflight = Math.max(0, phoneInflight - 1); };
    Promise.resolve(result).then(done, done);
    return result;
}

// -> { body: 新的请求体字符串 | null, note }
export function addReasoningEffort(bodyText, effort) {
    if (!effort || effort === 'off' || !Object.hasOwn(EFFORT_LABELS, effort)) return { body: null, note: '' };
    let b;
    try { b = JSON.parse(bodyText); } catch { return { body: null, note: '' }; }
    if (!b || typeof b !== 'object') return { body: null, note: '' };
    // 手机请求的特征：走酒馆后端的 claude 通道，并带 mode / instruction_mode = chat（酒馆自己的正文请求没有这两个字段）
    if (b.chat_completion_source !== 'claude' || b.instruction_mode !== 'chat') return { body: null, note: '' };
    if (Object.hasOwn(b, 'reasoning_effort')) return { body: null, note: '请求里已经有推理强度，没改' };
    if (!ADAPTIVE_MODEL.test(String(b.model || ''))) return { body: null, note: `模型 ${b.model || '未知'} 不是自适应思考的新模型，没加（它不带这个参数时本来就不思考）` };
    b.reasoning_effort = effort;
    return { body: JSON.stringify(b), note: `已加上（${EFFORT_LABELS[effort]}）` };
}

function tryPatchFetch() {
    const f = globalThis.fetch;
    if (typeof f !== 'function') return false;
    if (f[PATCHED]) return true;
    const wrapped = function (input, init) {
        try {
            if (phoneInflight > 0 && init && typeof init.body === 'string') {
                const url = typeof input === 'string' ? input : (input?.url || '');
                if (url.includes('/api/backends/chat-completions/generate')) {
                    const r = addReasoningEffort(init.body, safeSettings().reasoningEffort);
                    if (r.note) effortState.last = r.note;
                    if (r.body) init = { ...init, body: r.body };
                }
            }
        } catch (e) { console.error(LOG, e); }
        return f.call(this, input, init);
    };
    wrapped[PATCHED] = true;
    globalThis.fetch = wrapped;
    console.info(LOG, '已挂接手机请求的推理强度');
    return true;
}

function s_effortLines() {
    let s; try { s = getSettings(); } catch { return []; }
    const e = s.reasoningEffort;
    if (!e || e === 'off') return ['手机推理强度：不设置'];
    return [`手机推理强度：${EFFORT_LABELS[e] || e}` + (effortState.last ? `；最近一次手机请求：${effortState.last}` : '；还没有手机请求')];
}

/* ================================================================== 功能四：手机读取正文楼层 跟随小白X的总结进度 */
// 小手机里的「正文楼层数」(phone-context-limit) 原本永远取聊天最后 N 层。
// 小白X总结到第 70 楼、正文剩 30 楼时，N=20 就会漏掉中间的 10 楼。
// 这里让手机读取时的实际层数 = max(你设的 N, 小白X还没总结（还在正文里）的楼层数)。
const CTX_LIMIT_KEY = 'phone-context-limit';
const LWB_EXT_ID = 'LittleWhiteBox';
const CTX_FOLLOW_CAP = 200; // 防止小白X长期不总结时越读越多

// chat：酒馆聊天数组；boundary：小白X已总结到的楼层号（-1/空 = 没有总结）
export function followLimit(base, chat, boundary) {
    const b = parseInt(base, 10);
    if (!Number.isFinite(b) || b <= 0) return base; // 0 = 用户关了正文上下文，不动
    if (!Array.isArray(chat) || !chat.length) return b;
    if (!Number.isInteger(boundary) || boundary < 0) return b; // 小白X还没总结过
    // 小白X「隐藏已总结」：从第 1 楼开始连续隐藏到的位置，就是酒馆正文真正看不到的部分
    let h = -1;
    while (h + 1 < chat.length && chat[h + 1]?.is_system === true) h++;
    const hiddenThrough = (h >= 0 && h <= boundary) ? h : boundary;
    const extra = chat.length - 1 - hiddenThrough;
    return Math.max(b, Math.min(CTX_FOLLOW_CAP, extra));
}

function lwbBoundary() {
    try {
        const v = ctx().chatMetadata?.extensions?.[LWB_EXT_ID]?.storySummary?.lastSummarizedMesId;
        return Number.isInteger(v) ? v : -1;
    } catch { return -1; }
}

function tryPatchContextLimit() {
    const st = globalThis.VirtualPhone?.storage;
    if (!st || typeof st.get !== 'function') return false;
    if (st.get[PATCHED]) return true;
    const orig = st.get;
    const wrapped = function (key) {
        const v = orig.apply(this, arguments);
        if (key !== CTX_LIMIT_KEY) return v;
        try {
            if (!safeSettings().contextFollow) return v;
            // 手机的设置页要显示你自己填的数字，不能显示被调整后的
            if (/settings-app/.test(new Error().stack || '')) return v;
            const c = ctx();
            return followLimit(v, c.chat, lwbBoundary());
        } catch { return v; }
    };
    wrapped[PATCHED] = true;
    wrapped.orig = orig;
    st.get = wrapped;
    console.info(LOG, '已挂接手机的「正文楼层数」读取');
    return true;
}

function startContextPatching() {
    tryPatchContextLimit();
    tryPatchFetch();
    if (globalThis.__yuzukiPhonePlusCtxTimer) return;
    // 手机重新加载后 storage 可能换成新对象，所以一直检查（很轻）
    globalThis.__yuzukiPhonePlusCtxTimer = setInterval(() => { tryPatchContextLimit(); tryPatchFetch(); }, 3000);
}

function s_contextLine() {
    let s; try { s = getSettings(); } catch { return []; }
    if (!s.contextFollow) return ['手机正文楼层联动：已关闭'];
    const st = globalThis.VirtualPhone?.storage;
    const get = st?.get?.orig || st?.get;
    if (!get) return ['手机正文楼层联动：手机还没加载'];
    let base; try { base = get.call(st, CTX_LIMIT_KEY); } catch { base = undefined; }
    const c = ctx();
    const b = lwbBoundary();
    const eff = followLimit(base ?? 20, c.chat, b);
    if (b < 0) return [`手机正文楼层联动：已开启（小白X还没有总结，手机读最近 ${base ?? 20} 层）`];
    return [`手机正文楼层联动：已开启（小白X已总结到第 ${b + 1} 楼，聊天共 ${c.chat?.length || 0} 楼；手机设置读 ${base ?? 20} 层，现在实际读 ${eff} 层）`];
}

/* ---- 通话智能滚动：接管每个通话消息容器的 scrollTop 赋值 ---- */

export function patchContainer(el) {
    if (!el || el[SCROLL_FLAG]) return false;
    const ElementCtor = globalThis.Element;
    const desc = ElementCtor && Object.getOwnPropertyDescriptor(ElementCtor.prototype, 'scrollTop');
    if (!desc || !desc.get || !desc.set) return false;
    el[SCROLL_FLAG] = true;
    stats.containers++;

    let atBottom = true;
    let force = false;
    const distanceToBottom = () => el.scrollHeight - desc.get.call(el) - el.clientHeight;
    el.addEventListener('scroll', () => { atBottom = distanceToBottom() <= BOTTOM_THRESHOLD; }, { passive: true });

    Object.defineProperty(el, 'scrollTop', {
        configurable: true,
        get() { return desc.get.call(el); },
        set(value) {
            const s = safeSettings();
            const block = shouldBlockScroll({
                enabled: true, smartScroll: s.smartScroll, atBottom, force,
                value, maxTop: el.scrollHeight - el.clientHeight,
            });
            if (block) {
                stats.blockedScrolls++;
                if (s.log) console.info(LOG, '你在往上翻，已拦截一次强制滚到底部');
                return;
            }
            force = false;
            desc.set.call(el, value);
        },
    });

    const nativeInsert = el.insertAdjacentHTML.bind(el);
    el.insertAdjacentHTML = function (position, html) {
        const s = safeSettings();
        if (s.smartScroll && s.alwaysScrollOnSend && isOwnMessageHtml(html)) {
            force = true;
            setTimeout(() => { force = false; }, 0); // 手机紧接着会同步设置 scrollTop，这里只保留到本轮结束
        }
        return nativeInsert(position, html);
    };
    return true;
}

function scanAndPatch(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.matches?.(CONTAINER_SELECTOR)) patchContainer(root);
    root.querySelectorAll?.(CONTAINER_SELECTOR).forEach(patchContainer);
}

function startScrollObserver() {
    if (!globalThis.document?.body || globalThis.__yuzukiPhonePlusObserver) return;
    scanAndPatch(document.body);
    const observer = new MutationObserver((records) => {
        for (const r of records) r.addedNodes.forEach(scanAndPatch);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    globalThis.__yuzukiPhonePlusObserver = observer;
}

/* ---- 设置面板（中文） ---- */

function s_cacheLine() {
    let on = false; try { on = !!getSettings().cacheEnabled; } catch { /* 忽略 */ }
    return on ? '手机缓存点：已开启' : '手机缓存点：已关闭';
}

function s_sumLines() {
    let s; try { s = getSettings(); } catch { return []; }
    if (!s.sumEnabled) return ['微信聊天摘要：已关闭'];
    const p = sumParams(s);
    const out = [`微信聊天摘要：已开启（满 ${p.trigger} 条，压缩最老的 ${p.take} 条，留下约 ${p.keepLines} 条原文）`];
    const wd = getWD();
    if (!wd) { out.push('  手机的微信数据还没加载（先打开一次微信 App，或发一条微信消息）'); return out; }
    const sums = readSummaries();
    const rows = [];
    for (const c of wd.getChatList?.() || []) {
        const loaded = !!wd._messagesLoaded?.[c.id];
        const rec = sums[c.id];
        if (!loaded && !rec) continue;
        const msgs = loaded ? (wd.getMessages(c.id) || []) : [];
        const lines = visibleLines(msgs);
        const shown = msgs.filter(isCountable).length;
        const lim = offlineLimit(c);
        const warn = loaded && shown > lim ? `\n    ⚠ 小手机「线下注入条数」是 ${lim}，小于当前原文 ${shown} 条，酒馆正文里会漏掉中间的 ${shown - lim} 条。请把它调到 ${p.trigger + 100} 以上。` : '';
        rows.push(`  · ${c.name}${c.type === 'group' ? '（群）' : ''}：当前原文 ${lines} 条` + (rec ? `；摘要 ${rec.text.length} 字（已压缩 ${rec.rounds || 1} 次）` : '；还没有摘要') + warn);
    }
    out.push(...(rows.length ? rows : ['  （目前没有已加载的聊天）']));
    if (stats.sumTrimFail) out.push(`  ⚠ 正文去重有 ${stats.sumTrimFail} 次没对上（已压缩的旧消息和摘要同时出现，不会丢信息，只是重复）。`);
    return out;
}

function describeStatus() {
    const holder = getCallAiHolder();
    const hooked = !!holder?.callAI?.[PATCHED];
    const mem = getMemory();
    const lines = [];
    lines.push(hooked ? '手机挂接：正常' : '手机挂接：未就绪（柚月小手机是否已安装并加载？）');
    if (mem.source === 'live') lines.push(`小白X记忆：${mem.text.length} 字（实时读取）`);
    else if (mem.source === 'cache') lines.push(`小白X记忆：${mem.text.length} 字（使用 ${new Date(mem.at).toLocaleString()} 保存的副本）`);
    else lines.push('小白X记忆：暂无。请先用开启了小白X记忆的聊天生成一次正文回复。');

    lines.push(s_cacheLine());
    lines.push(...s_sumLines());
    lines.push(...s_contextLine());
    lines.push(...s_effortLines());

    lines.push(Object.getPrototypeOf(globalThis.VirtualPhone?.wechatApp?.chatView || {})?.[Symbol.for('yuzuki_phone_plus.chatview_patched2')]
        ? '微信时间推进：已生效'
        : '微信时间推进：还没生效（先打开一次微信 App；打开后仍这样，说明手机内部改了名字，需要适配）');
    return { text: lines.join('\n'), memory: mem.text };
}

export function renderSumPanel() {
    const $ = globalThis.jQuery;
    const box = $('#yp_plus_sum_panel');
    box.empty();
    if (!getWD()) { box.text('手机的微信数据还没加载（先打开一次微信 App，或发一条微信消息）。'); return; }
    const tk = tavernKey();
    const list = listSummaries();
    if (!list.length) { box.text('当前这个酒馆聊天里还没有摘要。'); return; }
    box.append($('<small>').text('这里是「当前打开的这个酒馆聊天」里，每个微信窗口的摘要（文字、语音、视频通话合在一份里）。改完点「保存修改」，下一次手机请求和酒馆正文就会用新的文字。'));
    for (const it of list) {
        const wrap = $('<div>').css({ margin: '8px 0', padding: '8px', border: '1px solid var(--SmartThemeBorderColor, #888)', borderRadius: '6px' });
        wrap.append($('<div>').css('font-weight', 'bold').text(`${it.name}${it.isGroup ? '（群）' : ''}`));
        const bits = [`已压缩 ${it.rounds} 次`];
        if (it.at) bits.push(`最后更新 ${new Date(it.at).toLocaleString()}`);
        if (it.exists) bits.push(`对应 ${it.count} 条已压缩的聊天`);
        if (it.edited) bits.push('已手动修改过');
        wrap.append($('<div>').append($('<small>').text(bits.join('；'))));
        if (!it.active) {
            wrap.append($('<div>').css('color', '#e0a030').append($('<small>').text(
                it.exists ? '⚠ 这个窗口里已经没有被压缩的消息（聊天可能被清空过），这份摘要现在不会被使用。' : '⚠ 这个微信聊天已经不存在了，这份摘要不会被使用，可以直接删除。')));
        }
        const ta = $('<textarea class="text_pole" rows="9">').css({ width: '100%', marginTop: '6px' }).val(it.text);
        const counter = $('<small>');
        const refreshCounter = () => counter.text(`${ta.val().length} 字`);
        refreshCounter();
        ta.on('input', refreshCounter);
        const status = $('<div>').css('margin-top', '4px').append($('<small>'));
        const say = (msg) => status.find('small').text(msg);
        const stale = () => {
            if (tavernKey() === tk) return false;
            say('你已经切换了聊天，这个列表已过期，请重新点「管理摘要」。');
            return true;
        };
        const save = $('<input type="button" class="menu_button" value="保存修改">').on('click', async () => {
            if (stale()) return;
            const r = await saveSummaryText(it.id, ta.val());
            say(r.ok ? `已保存（${ta.val().trim().length} 字）。` : `没保存：${r.reason}`);
        });
        const undo = $('<input type="button" class="menu_button" value="撤销这个窗口的摘要（恢复原文）">').on('click', async () => {
            if (stale()) return;
            const tip = it.exists
                ? `确定只撤销「${it.name}」的摘要？\n这个窗口被压缩的 ${it.count} 条消息会恢复成普通消息（重新发给 AI），这份摘要会被删除。别的窗口不受影响。\n如果恢复后原文又够触发条数，稍后会自动重新压缩。`
                : `确定删除这份摘要？`;
            if (!globalThis.confirm(tip)) return;
            const r = await undoSummary(it.id);
            if (!r.ok) { say(`没撤销：${r.reason}`); return; }
            renderSumPanel();
            $('#yp_plus_sum_panel').prepend($('<div>').append($('<small>').text(`已撤销「${it.name}」的摘要，恢复了 ${r.restored} 条消息。`)));
        });
        wrap.append(ta, $('<div>').append(counter), $('<div>').css({ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '4px' }).append(save, undo), status);
        box.append(wrap);
    }
}

function mountSettings() {
    const $ = globalThis.jQuery;
    if (!$ || $('#yp_plus_settings').length) return;
    const s = getSettings();
    const appBoxes = APPS.map(([id, label]) =>
        `<label class="checkbox_label"><input type="checkbox" class="yp_plus_app" data-app="${id}"><span>${label}</span></label>`).join('');
    const html = `
    <div id="yp_plus_settings" class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>柚月小手机增强（小白X记忆 + 缓存点 + 微信聊天摘要 + 正文楼层联动 + 推理强度 + 智能滚动 + 微信时间）</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <h4 style="margin:6px 0">小白X记忆</h4>
        <label class="checkbox_label"><input type="checkbox" id="yp_plus_mem"><span>让小手机里的 AI 请求也读到小白X的剧情记忆</span></label>
        <div style="margin:6px 0 2px">下列 App 会带上记忆（每个 App 的每次请求都会多出记忆的 token）：</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px 14px">${appBoxes}</div>
        <div style="margin:8px 0 2px">记忆最大字数（0 = 不限制）</div>
        <input type="number" min="0" step="500" id="yp_plus_max" class="text_pole" style="width:140px">
        <div style="margin:8px 0 2px">放在记忆前面的说明句</div>
        <textarea id="yp_plus_intro" class="text_pole" rows="3"></textarea>
        <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap">
          <input type="button" id="yp_plus_reset_intro" class="menu_button" value="恢复默认说明句">
          <input type="button" id="yp_plus_clear" class="menu_button" value="清除已保存的记忆副本">
        </div>
        <h4 style="margin:12px 0 6px">手机请求的缓存点</h4>
        <label class="checkbox_label"><input type="checkbox" id="yp_plus_cache"><span>给手机的 AI 请求自动打缓存点（要求：你的 API 走 gproxy，并且渠道里打开了 Magic-string cache）</span></label>
        <div style="margin:6px 0 2px">缓存时长</div>
        <select id="yp_plus_ttl" class="text_pole" style="width:200px"><option value="5m">5 分钟（默认，便宜）</option><option value="1h">1 小时（写入贵一倍）</option></select>
        <h4 style="margin:12px 0 6px">微信聊天自动摘要</h4>
        <label class="checkbox_label"><input type="checkbox" id="yp_plus_sum"><span>微信聊天（含语音、视频通话）太多时，自动把最老的压缩成摘要，不再直接丢掉</span></label>
        <div style="margin:6px 0 2px">满多少条触发压缩（通话里说的每句话也算一条）</div>
        <input type="number" min="40" max="9999" step="10" id="yp_plus_sum_trigger" class="text_pole" style="width:120px">
        <div style="margin:6px 0 2px">每次压缩最老的多少条（剩下的原文保留）</div>
        <input type="number" min="10" max="9990" step="10" id="yp_plus_sum_take" class="text_pole" style="width:120px">
        <div style="margin:6px 0 2px">摘要大致字数上限</div>
        <input type="number" min="300" max="8000" step="100" id="yp_plus_sum_max" class="text_pole" style="width:120px">
        <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap">
          <input type="button" id="yp_plus_sum_now" class="menu_button" value="现在检查并压缩">
          <input type="button" id="yp_plus_sum_undo" class="menu_button" value="撤销全部摘要（恢复原文）">
        </div>
        <div style="margin-top:6px"><input type="button" id="yp_plus_sum_manage" class="menu_button" value="管理摘要（查看 / 修改 / 单独撤销）"></div>
        <div id="yp_plus_sum_panel" style="margin-top:6px"></div>
        <small>摘要会作为「手机微信聊天记录」最前面的一段，同时带进手机的 AI 请求和酒馆正文。被压缩的老消息在手机里照常能看到，只是不再发给 AI。</small>
        <h4 style="margin:12px 0 6px">手机读取的正文楼层</h4>
        <label class="checkbox_label"><input type="checkbox" id="yp_plus_ctx"><span>手机读取的正文楼层数，跟随小白X的总结进度</span></label>
        <small>小白X总结到哪，手机就从那里往后把还没总结的楼层全部读进来，不会漏掉中间的楼层。小手机里设置的「正文楼层数」是最少读几层，不会比它少。</small>
        <h4 style="margin:12px 0 6px">手机请求的推理强度</h4>
        <select id="yp_plus_effort" class="text_pole" style="width:240px">
          <option value="off">不设置（保持手机原样）</option>
          <option value="min">极低</option>
          <option value="low">低</option>
          <option value="medium">中</option>
          <option value="high">高</option>
          <option value="max">最高</option>
        </select>
        <small>手机本来不发这个参数。这里选了之后，手机的每次 AI 请求（微信、通话、摘要等）都会带上它，数值越低回复越快。只对 Claude 5 / Opus 4.7 以上这类新模型生效，老模型会自动跳过。酒馆主聊天的推理强度不受影响。</small>
        <h4 style="margin:12px 0 6px">通话智能滚动</h4>
        <label class="checkbox_label"><input type="checkbox" id="yp_plus_smart"><span>我往上翻看通话消息时，不要再自动拉到最底部</span></label>
        <label class="checkbox_label"><input type="checkbox" id="yp_plus_send"><span>我自己发消息时，总是滚到最底部</span></label>
        <h4 style="margin:12px 0 6px">微信连发消息的时间</h4>
        <label class="checkbox_label"><input type="checkbox" id="yp_plus_time"><span>放慢微信里 AI 连发消息的时间推进</span></label>
        <div style="margin:6px 0 2px">整体快慢（百分比）：100 = 默认；调小更快，调大更慢，例如 70 或 150</div>
        <input type="number" min="10" max="500" step="5" id="yp_plus_speed" class="text_pole" style="width:120px">
        <h4 style="margin:12px 0 6px">其他</h4>
        <label class="checkbox_label"><input type="checkbox" id="yp_plus_log"><span>在控制台输出调试日志</span></label>
        <div style="margin-top:8px"><input type="button" id="yp_plus_check" class="menu_button" value="检查状态"></div>
        <pre id="yp_plus_status" style="white-space:pre-wrap;margin:8px 0 0"></pre>
        <small>不修改柚月小手机和小白X的任何文件。设置对下一次手机请求 / 下一次通话生效，不需要刷新页面。</small>
      </div>
    </div>`;
    $('#extensions_settings2').append(html);
    const save = () => ctx().saveSettingsDebounced();
    $('#yp_plus_mem').prop('checked', s.memoryEnabled).on('change', function () { s.memoryEnabled = this.checked; save(); });
    $('.yp_plus_app').each(function () {
        const id = this.dataset.app;
        $(this).prop('checked', s.apps[id] !== false).on('change', function () { s.apps[id] = this.checked; save(); });
    });
    $('#yp_plus_max').val(s.maxChars).on('change', function () { s.maxChars = Math.max(0, parseInt(this.value, 10) || 0); save(); });
    $('#yp_plus_intro').val(s.intro).on('input', function () { s.intro = this.value; save(); });
    $('#yp_plus_reset_intro').on('click', () => { s.intro = DEFAULT_INTRO; $('#yp_plus_intro').val(s.intro); save(); });
    $('#yp_plus_clear').on('click', () => { clearCache(); $('#yp_plus_status').text('已清除保存的记忆副本。'); });
    $('#yp_plus_cache').prop('checked', s.cacheEnabled).on('change', function () { s.cacheEnabled = this.checked; save(); });
    $('#yp_plus_ttl').val(s.cacheTtl).on('change', function () { s.cacheTtl = this.value === '1h' ? '1h' : '5m'; save(); });
    $('#yp_plus_ctx').prop('checked', s.contextFollow).on('change', function () { s.contextFollow = this.checked; save(); });
    $('#yp_plus_effort').val(s.reasoningEffort).on('change', function () { s.reasoningEffort = this.value; save(); });
    $('#yp_plus_smart').prop('checked', s.smartScroll).on('change', function () { s.smartScroll = this.checked; save(); });
    $('#yp_plus_send').prop('checked', s.alwaysScrollOnSend).on('change', function () { s.alwaysScrollOnSend = this.checked; save(); });
    $('#yp_plus_time').prop('checked', s.timeEnabled).on('change', function () { s.timeEnabled = this.checked; save(); });
    $('#yp_plus_speed').val(s.speedPercent).on('change', function () { const n = Number(this.value); s.speedPercent = Number.isFinite(n) && n > 0 ? Math.min(500, Math.max(10, n)) : 100; save(); });
    $('#yp_plus_sum').prop('checked', s.sumEnabled).on('change', function () { s.sumEnabled = this.checked; save(); });
    const sumNum = (sel, key, lo, hi) => $(sel).val(s[key]).on('change', function () {
        const n = parseInt(this.value, 10);
        s[key] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULTS[key];
        this.value = s[key]; save();
    });
    sumNum('#yp_plus_sum_trigger', 'sumTrigger', 40, 9999);
    sumNum('#yp_plus_sum_take', 'sumTake', 10, 9990);
    sumNum('#yp_plus_sum_max', 'sumMaxChars', 300, 8000);
    $('#yp_plus_sum_now').on('click', async () => {
        $('#yp_plus_status').text('正在检查……（需要压缩时会调用 AI，请稍等）');
        await checkSummaryTargets(true);
        $('#yp_plus_status').text(describeStatus().text);
    });
    $('#yp_plus_sum_undo').on('click', async () => {
        if (!globalThis.confirm('确定撤销？所有被压缩的消息会恢复成普通消息（重新发给 AI），已生成的摘要会被删除。')) return;
        const n = await undoAllSummaries();
        $('#yp_plus_status').text(`已恢复 ${n} 条消息，并删除了全部摘要。`);
    });
    $('#yp_plus_sum_manage').on('click', () => renderSumPanel());
    $('#yp_plus_check').on('click', () => {
        $('#yp_plus_status').text(describeStatus().text);
    });
}

function snapshotAfterGeneration() {
    try { getMemory(); } catch { /* 忽略 */ }
}

(function init() {
    try {
        const c = ctx();
        const { eventSource, event_types: ev } = c;
        if (eventSource && ev) {
            if (ev.APP_READY) eventSource.on(ev.APP_READY, () => { mountSettings(); startApiPatching(); startScrollObserver(); startChatViewPatching(); startContextPatching(); });
            if (ev.CHAT_COMPLETION_PROMPT_READY) eventSource.on(ev.CHAT_COMPLETION_PROMPT_READY, onPromptReady); // 在手机注入之后补上摘要
            for (const name of ['MESSAGE_RECEIVED', 'GENERATION_ENDED']) if (ev[name]) eventSource.on(ev[name], scheduleSummaryCheck);
            // 每次正文生成后刷新记忆副本
            for (const name of ['GENERATION_ENDED', 'CHAT_COMPLETION_PROMPT_READY', 'MESSAGE_RECEIVED']) {
                if (ev[name]) eventSource.on(ev[name], snapshotAfterGeneration);
            }
        }
        mountSettings();
        startApiPatching();
        startScrollObserver();
        startChatViewPatching();
        startContextPatching();
    } catch (e) {
        console.error(LOG, '初始化失败', e);
    }
})();
