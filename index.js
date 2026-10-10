// 柚月小手机增强（小白X记忆 + 智能滚动）
//
// 功能一：小白X记忆桥接
//   柚月小手机里的 AI 请求（微信 / 朋友圈 / 微博 / X / 日记…）是手机自己拼提示词，不走酒馆的生成流程，
//   所以读不到小白X(LittleWhiteBox)注入的记忆。本插件读取小白X写入的
//   extension_prompts["LittleWhiteBox_StorySummary"]，并包装手机的 ApiManager.callAI，
//   在每次手机 AI 请求里多插入一条 system 消息（位置：手机的「[Start a new chat]」分界线之前）。
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
    log: false,
});

/* ---- 纯逻辑（有单元测试） ---- */

export function isDivider(m) {
    if (!m || m.role !== 'system') return false;
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    return text === DIVIDER_TEXT || String(m.name || '').includes('分界线');
}

// 记忆消息应该插在 messages 的哪个位置
export function findInsertIndex(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return 0;
    const divider = messages.findIndex(isDivider);
    if (divider >= 0) return divider;
    const firstNonSystem = messages.findIndex(m => m && m.role !== 'system');
    if (firstNonSystem >= 0) return firstNonSystem;
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
    out.splice(findInsertIndex(messages), 0, {
        role: 'system',
        content,
        name: 'SYSTEM (小白X记忆)',
        isPhoneMessage: true,
        [MARK]: true,
    });
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

const stats = { containers: 0, blockedScrolls: 0, injected: 0 };

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
    if (!s.memoryEnabled) return messages;
    const appId = String(options?.appId || 'phone_online');
    if (Object.hasOwn(s.apps, appId) && s.apps[appId] === false) return messages;
    const mem = getMemory();
    if (!mem.text) {
        if (s.log) console.info(LOG, `${appId}：目前没有可用的小白X记忆`);
        return messages;
    }
    const out = injectMemory(messages, mem.text, { intro: s.intro, maxChars: Number(s.maxChars) || 0 });
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
        let next = messages;
        try { next = prepareMessages(messages, options || {}); } catch (e) { console.error(LOG, e); }
        return original.call(this, next, options);
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

function describeStatus() {
    const holder = getCallAiHolder();
    const hooked = !!holder?.callAI?.[PATCHED];
    const mem = getMemory();
    const live = document.querySelectorAll(CONTAINER_SELECTOR).length;
    const lines = [];
    lines.push(hooked ? '手机挂接：正常' : '手机挂接：未就绪（柚月小手机是否已安装并加载？）');
    if (mem.source === 'live') lines.push(`小白X记忆：${mem.text.length} 字（实时读取）`);
    else if (mem.source === 'cache') lines.push(`小白X记忆：${mem.text.length} 字（使用 ${new Date(mem.at).toLocaleString()} 保存的副本）`);
    else lines.push('小白X记忆：暂无。请先用开启了小白X记忆的聊天生成一次正文回复。');
    lines.push(`已向手机请求注入记忆：${stats.injected} 次`);
    lines.push(`通话界面：已接管 ${stats.containers} 个（当前打开 ${live} 个），已拦截强制滚动 ${stats.blockedScrolls} 次`);
    return { text: lines.join('\n'), memory: mem.text };
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
        <b>柚月小手机增强（小白X记忆 + 智能滚动）</b>
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
        <h4 style="margin:12px 0 6px">通话智能滚动</h4>
        <label class="checkbox_label"><input type="checkbox" id="yp_plus_smart"><span>我往上翻看通话消息时，不要再自动拉到最底部</span></label>
        <label class="checkbox_label"><input type="checkbox" id="yp_plus_send"><span>我自己发消息时，总是滚到最底部</span></label>
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
    $('#yp_plus_smart').prop('checked', s.smartScroll).on('change', function () { s.smartScroll = this.checked; save(); });
    $('#yp_plus_send').prop('checked', s.alwaysScrollOnSend).on('change', function () { s.alwaysScrollOnSend = this.checked; save(); });
    $('#yp_plus_log').prop('checked', s.log).on('change', function () { s.log = this.checked; save(); });
    $('#yp_plus_check').on('click', () => {
        const st = describeStatus();
        const preview = st.memory ? `\n\n记忆预览：\n${st.memory.slice(0, 300)}${st.memory.length > 300 ? ' ……' : ''}` : '';
        $('#yp_plus_status').text(st.text + preview);
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
            if (ev.APP_READY) eventSource.on(ev.APP_READY, () => { mountSettings(); startApiPatching(); startScrollObserver(); });
            // 每次正文生成后刷新记忆副本
            for (const name of ['GENERATION_ENDED', 'CHAT_COMPLETION_PROMPT_READY', 'MESSAGE_RECEIVED']) {
                if (ev[name]) eventSource.on(ev[name], snapshotAfterGeneration);
            }
        }
        mountSettings();
        startApiPatching();
        startScrollObserver();
    } catch (e) {
        console.error(LOG, '初始化失败', e);
    }
})();
