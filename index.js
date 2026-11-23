const MODULE = 'context_tracker';
const USAGE_KEYS = ['prompts', 'worldInfoBefore', 'persona', 'character', 'definitions', 'worldInfoAfter', 'history'];
const USAGE_ROWS = [
    ['prompts', '프롬프트', ['prompts']],
    ['worldInfo', '월드 인포', ['worldInfoBefore', 'worldInfoAfter']],
    ['character', '캐릭터 시트', ['character', 'definitions', 'persona']],
    ['history', '챗 히스토리', ['history']],
];
// 커스텀 프롬프트에서 다른 문구와 섞여도 분리할 시트 매크로와 그 분류.
const SHEET_MACROS = {
    description: 'character', persona: 'persona', personality: 'definitions',
    scenario: 'definitions', mesExamples: 'definitions', mesExamplesRaw: 'definitions',
};
const GAUGE_MIN = 16;
const GAUGE_MAX = 40;
const GAUGE_DEFAULT = 28;

let settings;
let badge;
let button;
let panel;
let toolbarHost;
let settingsPanel;
let snapshot = null;
let refreshPending = false;
let refreshError = '';
let warnedUnavailable = false;
let trackingFailed = false;
let generationKey = '';
let generationType;
let generationRevision = 0;
let refreshTimer;
let pendingTimeout;
let assemblyPending = false;
let assemblyDeferred = false;
let assemblyTimer;
let layoutFrame;
let layoutObserver;
let chatObserver;
let resizeObserver;
let active = false;
let removed = false;
let core;
let openai;
let revision = 0;
let assemblySequence = 0;
const completions = new WeakMap();
const promptResults = new WeakMap();
const restorers = [];
const subscriptions = [];
const missingEvents = [];
const listeners = new AbortController();

async function loadInternals() {
    // namespace를 보관해 나중에 초기화되는 promptManager도 최신 값으로 읽는다.
    const results = await Promise.allSettled([import('/script.js'), import('/scripts/openai.js')]);
    core = results[0].status === 'fulfilled' ? results[0].value : undefined;
    openai = results[1].status === 'fulfilled' ? results[1].value : undefined;
    return results.find(result => result.status === 'rejected')?.reason;
}

function internalsAvailable() {
    return typeof core?.isGenerating === 'function' && openai?.promptManager != null;
}

function trackAssembly() {
    const prototype = openai?.ChatCompletion?.prototype;
    const manager = openai?.promptManager;
    if (!prototype || typeof manager?.setChatCompletion !== 'function') throw new Error('Prompt assembly APIs unavailable');
    const wrap = (target, name, handler) => {
        const original = target[name];
        const descriptor = Object.getOwnPropertyDescriptor(target, name);
        if (typeof original !== 'function') throw new Error(`Prompt assembly API unavailable: ${name}`);
        const wrapped = function (...args) {
            if (!active || !settings.enabled) return original.apply(this, args);
            return handler.call(this, original, args);
        };
        target[name] = wrapped;
        restorers.push(() => {
            if (target[name] !== wrapped) return;
            if (descriptor) Object.defineProperty(target, name, descriptor);
            else delete target[name];
        });
    };
    wrap(prototype, 'setTokenBudget', function (original, args) {
        // 본체 try 밖에서 호출되므로 집계 준비가 실패해도 생성은 막지 않는다.
        try {
            const size = Math.max(0, Number(args[0]) || 0);
            const response = Math.max(0, Number(args[1]) || 0);
            completions.set(this, { revision: generationRevision, key: generationKey, type: generationType,
                sequence: ++assemblySequence, size, response, budget: Math.max(0, size - response), error: '', counts: null,
                categories: promptCategories(), sheets: promptSheets(), breakdown: null, historyVisibility: historyVisibility() });
        } catch (error) {
            console.warn('[ContextTracker] 조립 추적 실패', error);
        }
        return original.apply(this, args);
    });
    // 본체는 실패한 조립도 finally에서 전달하고, render(false)에서 error를 지운다.
    wrap(prototype, 'log', function (original, args) {
        const result = completions.get(this);
        if (result && /^(Mandatory prompts exceed the context size\.|Invalid character name|----- Unexpected error while preparing prompts -----)$/.test(String(args[0]))) {
            result.error = '프롬프트 조립에 실패했습니다. 입력 예산과 필수 프롬프트, 사용자·캐릭터 이름을 확인하세요.';
        }
        return original.apply(this, args);
    });
    wrap(manager, 'setChatCompletion', function (original, args) {
        const value = original.apply(this, args);
        const result = completions.get(args[0]);
        if (result) {
            try {
                result.counts = { ...this.tokenHandler.getCounts() };
                const messages = args[0].getMessages();
                // 동시 생성에서 전역 generationType이 덮일 수 있어 조립된 제어 프롬프트로 종류를 확정한다.
                const control = messages.getCollection?.().find(item => item?.identifier === 'controlPrompts');
                const ids = control?.flatten?.().map(message => message.identifier) ?? [];
                if (ids.includes('quietPrompt')) result.type = 'quiet';
                else if (ids.includes('impersonate')) result.type = 'impersonate';
                result.breakdown = usageBreakdown(result.counts, result.categories, messages);
                splitSheets(result, messages);
            }
            catch { result.error ||= '토큰 집계를 사용할 수 없습니다. SillyTavern 버전 호환성을 확인하세요.'; }
        }
        return value;
    });
    wrap(prototype, 'getChat', function (original, args) {
        const chat = original.apply(this, args);
        const result = completions.get(this);
        if (result && Array.isArray(chat)) promptResults.set(chat, result);
        return chat;
    });
}

function promptCategories(ctx = context()) {
    const categories = new Map();
    for (const prompt of ctx.chatCompletionSettings?.prompts ?? []) {
        const content = String(prompt.content ?? '');
        const macros = [...content.matchAll(/\{\{([^{}]*)\}\}/g)];
        if (!macros.length) continue;
        // 매크로와 공백만 있는 프롬프트만 통째로 분류한다. 문구가 섞이면 splitSheets가 값만 옮긴다.
        if (content.replace(/\{\{([^{}]*)\}\}/g, '').trim()) continue;
        const names = macros.map(match => macroName(match[1]));
        const category = names.length === 1 && names[0] === 'persona' ? 'persona'
            : names.length === 1 && names[0] === 'description' ? 'character'
                : names.every(name => ['personality', 'scenario', 'mesexamples', 'mesexamplesraw'].includes(name))
                    ? 'definitions' : null;
        if (category) categories.set(prompt.identifier, category);
    }
    return categories;
}

function macroName(name) {
    return name.trim().toLowerCase().replace(/^char(description|personality|scenario)$/, '$1');
}

function promptSheets(ctx = context()) {
    const sheets = new Map();
    for (const prompt of ctx.chatCompletionSettings?.prompts ?? []) {
        const macros = new Map();
        for (const match of String(prompt.content ?? '').matchAll(/\{\{([^{}]*)\}\}/g)) {
            const name = Object.keys(SHEET_MACROS).find(key => key.toLowerCase() === macroName(match[1]));
            if (name) macros.set(name, (macros.get(name) ?? 0) + 1);
        }
        if (macros.size) sheets.set(prompt.identifier, macros);
    }
    return sheets;
}

function countSheetValue(content, value, limit) {
    // 매크로 횟수까지만 세어 짧은 값이 문구 속 같은 글자로 더 집계되지 않게 한다.
    let count = 0;
    for (let index = content.indexOf(value); index >= 0 && count < limit; index = content.indexOf(value, index + value.length)) count++;
    return count;
}

// 시트 매크로가 다른 문구와 섞인 프롬프트는 매크로 값의 토큰만큼 시트로 옮긴다.
// 값은 설명란 토큰 카운터와 같은 getTokenCountAsync로 세어 본체 표시값과 맞추고 그 캐시를 함께 쓴다.
function splitSheets(result, messages, ctx = context()) {
    if (!result.sheets?.size || typeof ctx.substituteParams !== 'function' || typeof ctx.getTokenCountAsync !== 'function') return;
    const values = new Map();
    // 매크로 값과 메시지 내용은 조립 중에 읽어 이후 병합이나 발화자 변경의 영향을 받지 않는다.
    const valueOf = name => {
        if (!values.has(name)) values.set(name, String(ctx.substituteParams(`{{${name}}}`) ?? ''));
        return values.get(name);
    };
    const targets = [];
    for (const collection of messages?.getCollection?.() ?? []) {
        if (!(Number(result.counts?.[collection?.identifier]) > 0) || !collection.flatten
            || usageCategory(collection.identifier, result.categories) !== 'prompts') continue;
        for (const message of collection.flatten()) {
            const macros = result.sheets.get(message.identifier);
            const tokens = Number(message.getTokens());
            if (!macros || usageCategory(message.identifier, result.categories) !== 'prompts'
                || typeof message.content !== 'string' || !Number.isFinite(tokens) || tokens <= 0) continue;
            const parts = [];
            for (const [name, limit] of macros) {
                const value = valueOf(name);
                const count = value ? countSheetValue(message.content, value, limit) : 0;
                if (count) parts.push([SHEET_MACROS[name], value, count]);
            }
            if (parts.length) targets.push({ tokens, parts });
        }
    }
    if (!targets.length) return;
    const breakdown = result.breakdown;
    (async () => {
        const moves = Object.fromEntries(USAGE_KEYS.map(key => [key, 0]));
        for (const { tokens, parts } of targets) {
            let left = tokens;
            for (const [category, value, count] of parts) {
                const amount = Math.min(left, Number(await ctx.getTokenCountAsync(value)) * count);
                if (!(amount > 0)) continue;
                moves[category] += amount;
                moves.prompts -= amount;
                left -= amount;
            }
        }
        return moves;
    })().then(moves => {
        if (!active || result.breakdown !== breakdown) return;
        result.breakdown = Object.fromEntries(USAGE_KEYS.map(key => [key, breakdown[key] + moves[key]]));
        // 이미 표시 중인 같은 조립 결과만 갱신하고, 아직 수집 전이면 capturePrompt가 새 값을 읽는다.
        if (snapshot?.breakdown === breakdown) {
            snapshot.breakdown = result.breakdown;
            render();
        }
    }, () => {});
}

function usageCategory(id, categories) {
    if (id === 'chatHistory') return 'history';
    if (id === 'worldInfoBefore' || id === 'worldInfoAfter') return id;
    if (id === 'personaDescription') return 'persona';
    if (id === 'charDescription') return 'character';
    if (['charPersonality', 'scenario', 'dialogueExamples'].includes(id)) return 'definitions';
    return categories.get(id) ?? 'prompts';
}

function usageBreakdown(counts, categories, messages) {
    const breakdown = Object.fromEntries(USAGE_KEYS.map(key => [key, 0]));
    const collections = messages?.getCollection?.() ?? [];
    for (const [id, value] of Object.entries(counts)) {
        const tokens = Number(value);
        if (id === 'undefined' || !Number.isFinite(tokens) || tokens <= 0) continue;
        const category = usageCategory(id, categories);
        const collection = collections.find(item => item?.identifier === id);
        // main 안에 삽입된 별도 프롬프트도 원래 식별자로 분류하고 중복 합산하지 않는다.
        if (category === 'prompts' && collection?.flatten) {
            let classified = 0;
            for (const message of collection.flatten()) {
                const amount = Number(message.getTokens());
                if (!Number.isFinite(amount) || amount <= 0) continue;
                breakdown[usageCategory(message.identifier, categories)] += amount;
                classified += amount;
            }
            breakdown.prompts += tokens - classified;
        } else breakdown[category] += tokens;
    }
    return breakdown;
}

function visibleHistoryCount(ctx = context()) {
    if (!hasChat(ctx) || !Array.isArray(ctx.chat)) return null;
    // 원본 collect()의 숨김 판정을 유지한다. 토큰 예산으로 잘린 메시지도 개수에는 포함된다.
    return ctx.chat.filter(m => m && !m.is_system).length;
}

function historyVisibility(ctx = context()) {
    return Array.isArray(ctx.chat) ? ctx.chat.map(message => message?.is_system ? '1' : '0').join('') : null;
}

function refreshHiddenHistory(ctx = context()) {
    if (ctx.mainApi !== 'openai' || snapshot?.key !== chatKey(ctx) || snapshot.historyVisibility == null) return false;
    const visibility = historyVisibility(ctx);
    // 입력 조립 뒤 추가된 응답은 기존 메시지의 숨김 변경으로 보지 않는다.
    if (visibility == null || visibility.startsWith(snapshot.historyVisibility)) {
        // 그룹에서 숨김을 되돌리면 마지막 입력과 다시 같아진다.
        if (ctx.groupId != null) snapshot.stale = false;
        return false;
    }
    // DOM에 없는 오래된 메시지도 패널을 열 때만 확인한다.
    // 그룹은 추가 드라이런을 요청하지 않고 마지막 생성 입력을 유지하되, 다음 집계에 반영된다고 표시한다.
    if (ctx.groupId != null) snapshot.stale = true;
    else if (!core?.isGenerating?.()) snapshot = null;
    requestRefresh();
    return true;
}

function context() {
    return SillyTavern.getContext();
}

function chatKey(ctx = context()) {
    return JSON.stringify([ctx.groupId ?? null, ctx.groupId == null ? ctx.characterId ?? null : null, ctx.getCurrentChatId()]);
}

function hasChat(ctx = context()) {
    return ctx.groupId != null || ctx.characterId != null;
}

function limits(ctx = context()) {
    const config = ctx.chatCompletionSettings;
    const size = Math.max(0, Number(config?.openai_max_context) || 0);
    const response = Math.max(0, Number(config?.openai_max_tokens) || 0);
    return { size, response, budget: Math.max(0, size - response) };
}

function historyBudget(value, budget) {
    const number = Number(value);
    const valid = Number.isFinite(number) && number >= 1 ? Math.floor(number) : 50000;
    return budget > 0 ? Math.min(valid, Math.floor(budget)) : valid;
}

function syncHistorySettings(budget, notice, ctx = context()) {
    // 저장된 값은 사용자가 직접 입력한 값만 유지한다. 컨텍스트 크기가 일시적으로 바뀌어도
    // 설정을 덮어쓰지 않고, 적용되는 값(effective)만 표시용으로 계산한다.
    if (!settingsPanel) return;
    budget ??= limits(ctx).budget;
    const effective = historyBudget(settings.historyBudget, budget);
    const input = settingsPanel.querySelector('#ctt_history_budget');
    input.removeAttribute('max');
    input.disabled = !settings.historyOnly || ctx.mainApi !== 'openai' || budget < 1;
    // 다른 설정이 갱신될 때 작성 중인 숫자를 덮어쓰지 않는다.
    if (document.activeElement !== input || notice !== undefined) input.value = String(settings.historyBudget);
    let hint = `현재 입력 예산 ${format(budget)} 토큰 이하`;
    if (ctx.mainApi !== 'openai') hint = '히스토리 예산은 Chat Completion에서 사용할 수 있습니다.';
    else if (budget < 1) hint = '컨텍스트 크기를 최대 응답 길이보다 크게 설정하세요.';
    else if (effective < settings.historyBudget) {
        hint += ` 저장된 상한선이 입력 예산보다 커서 현재는 ${format(effective)} 토큰이 적용됩니다.`;
    }
    setText(settingsPanel.querySelector('.ctt-history-limit'), hint);
    if (notice !== undefined) setText(settingsPanel.querySelector('.ctt-history-notice'), notice);
}

function format(value) {
    return Number.isFinite(value) ? Math.round(value).toLocaleString('ko-KR') : '—';
}

function setValue(key, value) {
    setText(panel.querySelector(`[data-ctt="${key}"]`), format(value));
}

function setText(element, value) {
    if (element.textContent !== value) element.textContent = value;
}

function setAttribute(element, name, value) {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function render() {
    if (!badge) return;
    const ctx = context();
    const configured = limits(ctx);
    syncHistorySettings(configured.budget, undefined, ctx);
    const supported = ctx.mainApi === 'openai';
    const liveResult = snapshot?.source === 'assembly' && snapshot.dryRun === false && core?.isGenerating?.();
    const current = supported && hasChat(ctx) && snapshot?.key === chatKey(ctx)
        && (snapshot.size === configured.size && snapshot.response === configured.response || liveResult) ? snapshot : null;
    const { size, response, budget } = current ?? configured;
    const usage = settings.historyOnly ? current?.history : current?.total;
    const displayBudget = settings.historyOnly ? Math.min(settings.historyBudget, budget) : budget;
    const mode = settings.historyOnly ? '챗 히스토리' : '컨텍스트';
    const ratio = current && displayBudget > 0 ? usage / displayBudget : 0;
    const measured = Boolean(current) && displayBudget > 0;
    const percent = +(ratio * 100).toFixed(1);
    badge.hidden = !settings.enabled;
    badge.dataset.level = ratio >= 1 ? 'full' : ratio >= 0.9 ? 'high' : 'normal';
    badge.dataset.pending = String(refreshPending);
    button.querySelector('.ctt-ring-fill').style.strokeDashoffset = String(100 * (1 - Math.min(1, ratio)));
    setAttribute(button, 'aria-busy', String(refreshPending));
    const description = measured
        ? `${mode} ${percent}% 사용 · 추정 ${format(usage)} / ${format(displayBudget)} 토큰`
        : `${mode} 사용량`;
    setAttribute(button, 'aria-label', `${description}, 세부 내역 열기`);
    const historyCount = visibleHistoryCount(ctx);
    setText(panel.querySelector('[data-ctt-label="total-name"]'), settings.historyOnly ? '챗 히스토리' : '총 토큰');
    setText(panel.querySelector('.ctt-history-count'), settings.historyOnly && historyCount > 0 ? ` (${format(historyCount)}개)` : '');
    setText(panel.querySelector('[data-ctt-label="budget"]'), settings.historyOnly ? '히스토리 예산' : '입력 예산');
    panel.querySelector('[data-ctt-row="size"]').hidden = settings.historyOnly;
    panel.querySelector('[data-ctt-row="response"]').hidden = settings.historyOnly;
    panel.querySelector('[data-ctt-row="inputBudget"]').hidden = !settings.historyOnly;
    panel.querySelector('.ctt-usage-details').hidden = !settings.showUsageDetails;
    panel.querySelector('[data-ctt-usage-row="history"]').hidden = settings.historyOnly;
    setValue('total', usage);
    setValue('size', size);
    setValue('response', response);
    setValue('budget', displayBudget);
    setValue('inputBudget', budget);
    setValue('remaining', measured ? Math.max(0, displayBudget - usage) : undefined);
    for (const [key, , sources] of USAGE_ROWS) {
        const value = current?.breakdown ? sources.reduce((sum, source) => sum + current.breakdown[source], 0) : undefined;
        setValue(`usage-${key}`, value);
    }
    setText(panel.querySelector('#ctt-details-title'), measured ? `${percent}% 사용` : `${mode} 사용량`);
    setText(panel.querySelector('.ctt-headline-sub'), measured ? `${format(usage)} / ${format(displayBudget)} 토큰` : '');
    const status = !supported
        ? 'Chat Completion에서 사용할 수 있습니다.'
        : refreshError ? refreshError
            : !hasChat(ctx) ? '대화를 선택하세요.'
                : budget <= 0 ? '컨텍스트 크기가 최대 응답 길이보다 커야 합니다.'
                    : refreshPending ? '컨텍스트 계산 중…'
                        : !current ? (ctx.groupId != null ? '그룹 채팅은 메시지를 전송할 때 집계됩니다.' : '토큰 집계를 기다리는 중…')
                            : current.source === 'global' ? '추적되지 않은 집계입니다. 현재 입력과 다를 수 있습니다.'
                                : (ctx.groupId == null ? current.revision !== revision && !current.dryRun : current.stale)
                                    ? '생성에 사용된 입력입니다. 변경 사항은 다음 집계에 반영됩니다.' : '';
    setText(panel.querySelector('.ctt-status'), status);
    if (!settings.enabled) closePanel();
    if (!panel.hidden) positionPanel();
}

function countingUnavailable(error) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
    clearTimeout(pendingTimeout);
    refreshPending = false;
    refreshError = '토큰 집계를 사용할 수 없습니다. SillyTavern 버전 호환성을 확인하세요.';
    if (!warnedUnavailable) {
        warnedUnavailable = true;
        console.warn('[ContextTracker] 토큰 집계 API 호출 실패', error);
    }
    render();
}

function finishAssembly() {
    const deferred = assemblyDeferred;
    clearTimeout(assemblyTimer);
    assemblyTimer = undefined;
    assemblyPending = false;
    assemblyDeferred = false;
    return deferred;
}

function capturePrompt(data, dryRun) {
    const ctx = context();
    const result = promptResults.get(data?.prompt);
    if (!dryRun && assemblyPending && !['quiet', 'impersonate'].includes(result?.type ?? generationType)) finishAssembly();
    // 보조 확장의 원시 요청은 이 이벤트를 거치지 않아 현재 대화 집계를 덮어쓰지 않는다.
    if (!active || trackingFailed || !settings.enabled || ctx.mainApi !== 'openai' || !hasChat(ctx)
        || !Array.isArray(data?.prompt) || (result?.key ?? generationKey) !== chatKey(ctx)
        || (!dryRun && ['quiet', 'impersonate'].includes(result?.type ?? generationType))) return;
    if ((result?.revision ?? generationRevision) !== revision && (dryRun || !result || !core.isGenerating())) {
        // 이전 결과는 새 디바운스와 대기 상태를 건드리지 않는다.
        if (!refreshTimer && snapshot?.revision !== revision) requestRefresh();
        return;
    }
    if (result && snapshot?.key === result.key && snapshot.sequence > result.sequence) return;
    if (result?.error || (!result && openai?.promptManager?.error)) {
        snapshot = null;
        refreshPending = false;
        refreshError = result?.error || '프롬프트 조립에 실패했습니다. 입력 예산과 프롬프트 설정을 확인하세요.';
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
        clearTimeout(pendingTimeout);
        render();
        return;
    }
    let counts;
    try {
        counts = result?.counts ?? openai?.promptManager?.tokenHandler?.getCounts?.();
        if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new Error('Token counts unavailable');
    } catch (error) {
        countingUnavailable(error);
        return;
    }
    let total = 0;
    let history = 0;
    for (const [id, value] of Object.entries(counts)) {
        // 시스템 메시지 병합 등에서 누적된 임시 계산값은 프롬프트별 집계와 중복된다.
        if (id === 'undefined') continue;
        const tokens = Number(value);
        if (!Number.isFinite(tokens) || tokens <= 0) continue;
        total += tokens;
        if (id === 'chatHistory') history = tokens;
    }
    // 실제 생성은 변경 전 입력도 표시하되, 새 드라이런 결과와 구분한다.
    const captured = result ?? limits(ctx);
    snapshot = { key: chatKey(ctx), total, history, historyVisibility: result?.historyVisibility ?? historyVisibility(ctx),
        breakdown: result?.breakdown ?? usageBreakdown(counts, result?.categories ?? promptCategories(ctx)),
        revision: result?.revision ?? generationRevision,
        size: captured.size, response: captured.response, budget: captured.budget,
        sequence: result?.sequence ?? 0, dryRun: Boolean(dryRun), source: result?.counts != null ? 'assembly' : 'global' };
    refreshPending = false;
    refreshError = '';
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
    clearTimeout(pendingTimeout);
    render();
}

function requestRefresh() {
    if (!active) return;
    const ctx = context();
    syncHistorySettings(undefined, undefined, ctx);
    if (!settings.enabled) return;
    if (assemblyPending) {
        // 조립 전 변경(보낸 메시지, 재생성 삭제)은 이번 생성 입력에 포함되므로 대기 표시를 유지한다.
        generationRevision = ++revision;
        assemblyDeferred = true;
        return;
    }
    revision++;
    if (trackingFailed || !internalsAvailable()) {
        countingUnavailable(new Error('SillyTavern token APIs unavailable'));
        return;
    }
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
    clearTimeout(pendingTimeout);
    // 그룹의 발화 캐릭터가 선택되어 있어도 단일 캐릭터용 드라이런은 요청하지 않는다.
    refreshPending = ctx.mainApi === 'openai' && ctx.groupId == null && ctx.characterId != null && !core.isGenerating();
    if (refreshPending) refreshError = '';
    render();
    if (!refreshPending) return;
    const key = chatKey(ctx);
    refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        if (!active || !settings.enabled) return;
        if (key !== chatKey() || core.isGenerating()) {
            refreshPending = false;
            render();
            return;
        }
        // 기본 프롬프트 매니저와 같은 디바운서를 사용해 응답 후 재계산을 중복하지 않는다.
        try {
            const promptManager = openai?.promptManager;
            if (typeof promptManager?.renderDebounced !== 'function') throw new Error('Prompt refresh unavailable');
            promptManager.renderDebounced();
        } catch (error) {
            countingUnavailable(error);
            return;
        }
        // 드라이런 결과가 오지 않는 경우(조기 return, 예외 등)를 대비한 안전장치.
        clearTimeout(pendingTimeout);
        pendingTimeout = setTimeout(() => {
            if (!active || !refreshPending) return;
            refreshPending = false;
            refreshError = '토큰 집계가 지연되고 있습니다. 잠시 기다리거나 세부 패널을 다시 열어 재시도하세요.';
            render();
        }, 15000);
    }, 500);
}

function positionPanel() {
    const rect = button.getBoundingClientRect();
    const view = window.visualViewport;
    const leftEdge = (view?.offsetLeft ?? 0) + 8;
    const topEdge = (view?.offsetTop ?? 0) + 8;
    const rightEdge = leftEdge + (view?.width ?? window.innerWidth) - 16;
    const bottomEdge = topEdge + (view?.height ?? window.innerHeight) - 16;
    const style = getComputedStyle(panel);
    const naturalHeight = panel.scrollHeight
        + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const aboveSpace = Math.max(0, rect.top - topEdge - 8);
    const belowSpace = Math.max(0, bottomEdge - rect.bottom - 8);
    const placeAbove = aboveSpace >= naturalHeight || aboveSpace >= belowSpace;
    if (aboveSpace >= naturalHeight || belowSpace >= naturalHeight) {
        const availableHeight = placeAbove ? aboveSpace : belowSpace;
        panel.style.maxHeight = `${availableHeight}px`;
    } else {
        // 어느 쪽에도 다 들어가지 않으면 넓은 쪽에 맞추고 패널 안에서 스크롤해 게이지를 가리지 않는다.
        panel.style.maxHeight = `${Math.max(aboveSpace, belowSpace)}px`;
    }
    const { width, height } = panel.getBoundingClientRect();
    const above = rect.top - height - 8;
    const below = rect.bottom + 8;
    panel.style.left = `${Math.max(leftEdge, Math.min(rect.right - width, rightEdge - width))}px`;
    panel.style.top = `${Math.max(topEdge, Math.min(placeAbove ? above : below, bottomEdge - height))}px`;
}

function closePanel(focus = false) {
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (focus) button.focus();
}

function queueLayout() {
    if (!active || !settings.enabled || layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
        layoutFrame = null;
        mountBadge();
        if (!panel.hidden) positionPanel();
    });
}

function gaugeSize(value) {
    const size = Math.round(Number(value));
    return Number.isFinite(size) ? Math.min(GAUGE_MAX, Math.max(GAUGE_MIN, size)) : GAUGE_DEFAULT;
}

function applySize() {
    badge?.style.setProperty('--ctt-size', `${settings.size}px`);
    // 상단 배치 여백은 #send_form에서 계산하므로 같은 크기를 넘긴다.
    if (settings.enabled) toolbarHost?.style.setProperty('--ctt-size', `${settings.size}px`);
}

function releaseHost(host) {
    host?.removeAttribute('data-ctt-position');
    host?.style.removeProperty('--ctt-size');
}

function mountBadge() {
    if (!settings.enabled) return;
    const form = document.getElementById('send_form');
    if (!form) return;
    const input = form.querySelector('#nonQRFormItems');
    const host = settings.position === 'send-left' ? input?.querySelector('#leftSendForm')
        : settings.position === 'send-buttons' ? input?.querySelector('#rightSendForm') : form;
    if (!host) return;
    if (toolbarHost && toolbarHost !== form) releaseHost(toolbarHost);
    toolbarHost = form;
    if (form.dataset.cttPosition !== settings.position) form.dataset.cttPosition = settings.position;
    if (form.style.getPropertyValue('--ctt-size') !== `${settings.size}px`) form.style.setProperty('--ctt-size', `${settings.size}px`);
    if (badge.dataset.position !== settings.position) badge.dataset.position = settings.position;
    if (badge.parentElement !== host) host.prepend(badge);
}

function observe() {
    layoutObserver.disconnect();
    chatObserver.disconnect();
    resizeObserver.disconnect();
    if (!settings.enabled) return;
    const form = document.getElementById('send_form');
    const chat = document.getElementById('chat');
    if (form) {
        layoutObserver.observe(form, { childList: true, subtree: true });
        resizeObserver.observe(form);
    }
    if (chat) chatObserver.observe(chat, { attributes: true, subtree: true, attributeFilter: ['is_system'] });
    resizeObserver.observe(button);
}

function buildUI() {
    badge = document.createElement('div');
    badge.id = 'ctx-tracker-badge';
    badge.innerHTML = `<button type="button" class="ctt-gauge" aria-label="컨텍스트 사용량, 세부 내역 열기"
        aria-controls="ctt-details" aria-expanded="false" aria-haspopup="dialog">
        <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
            <circle class="ctt-ring-track" cx="16" cy="16" r="12" />
            <circle class="ctt-ring-fill" cx="16" cy="16" r="12" pathLength="100" />
        </svg>
    </button>`;
    button = badge.querySelector('button');
    applySize();
    panel = document.createElement('section');
    panel.id = 'ctt-details';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'ctt-details-title');
    panel.innerHTML = `<div class="ctt-panel-header">
        <div class="ctt-headline"><strong id="ctt-details-title">컨텍스트 사용량</strong><span class="ctt-headline-sub"></span></div>
        <button type="button" class="ctt-close" aria-label="세부 패널 닫기">×</button></div>
        <dl class="ctt-totals">
            <div class="ctt-total"><dt data-ctt-label="total"><span data-ctt-label="total-name">총 토큰</span><span class="ctt-history-count"></span></dt><dd data-ctt="total">—</dd></div>
            <div data-ctt-row="size"><dt>컨텍스트 크기</dt><dd data-ctt="size">—</dd></div>
            <div data-ctt-row="response"><dt>최대 응답 길이</dt><dd data-ctt="response">—</dd></div>
            <div data-ctt-row="inputBudget" hidden><dt>입력 예산</dt><dd data-ctt="inputBudget">—</dd></div>
            <div><dt data-ctt-label="budget">입력 예산</dt><dd data-ctt="budget">—</dd></div>
            <div><dt>잔여량</dt><dd data-ctt="remaining">—</dd></div>
        </dl>
        <dl class="ctt-usage-details" hidden>
            ${USAGE_ROWS.map(([key, label]) => `<div data-ctt-usage-row="${key}"><dt>${label}</dt><dd data-ctt="usage-${key}">—</dd></div>`).join('')}
        </dl>
        <p class="ctt-status" role="status"></p>`;
    document.body.append(panel);
    button.addEventListener('click', () => {
        if (!panel.hidden) return closePanel();
        panel.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        const historyChanged = refreshHiddenHistory();
        render();
        if (!historyChanged && !refreshPending && (refreshError || snapshot?.key !== chatKey())) requestRefresh();
        panel.querySelector('.ctt-close').focus();
    }, { signal: listeners.signal });
    panel.querySelector('.ctt-close').addEventListener('click', () => closePanel(true), { signal: listeners.signal });
    document.addEventListener('pointerdown', event => {
        if (!panel.hidden && !panel.contains(event.target) && !badge.contains(event.target)) closePanel();
    }, { signal: listeners.signal });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && !panel.hidden
            && (panel.contains(document.activeElement) || document.activeElement === button)
            && !document.querySelector('dialog[open]')) {
            event.preventDefault();
            event.stopPropagation();
            closePanel(true);
        }
    }, { capture: true, signal: listeners.signal });
    window.addEventListener('resize', queueLayout, { signal: listeners.signal });
    window.visualViewport?.addEventListener('resize', queueLayout, { signal: listeners.signal });
    window.visualViewport?.addEventListener('scroll', queueLayout, { signal: listeners.signal });
    document.addEventListener('scroll', event => {
        if (!panel.hidden && !panel.contains(event.target)) queueLayout();
    }, { capture: true, passive: true, signal: listeners.signal });
    layoutObserver = new MutationObserver(queueLayout);
    chatObserver = new MutationObserver(() => {
        if (context().groupId == null || !refreshHiddenHistory()) requestRefresh();
    });
    resizeObserver = new ResizeObserver(queueLayout);
    mountBadge();
    observe();
}

function addSettingsPanel() {
    const target = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!target) return;
    const container = document.createElement('div');
    settingsPanel = container;
    container.className = 'context-tracker-settings';
    container.innerHTML = `<div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>Context Tracker</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content"><div class="ctt-section">옵션 설정</div>
            <label class="checkbox_label"><input type="checkbox" id="ctt_enabled"><span>컨텍스트 트래커 표시</span></label>
            <label class="checkbox_label"><input type="checkbox" id="ctt_usage_details"><span>사용량 상세보기</span></label>
            <label class="checkbox_label"><input type="checkbox" id="ctt_history_only"><span>챗 히스토리 예산으로 계산</span></label>
            <div class="ctt-history-budget-field">
                <input type="number" id="ctt_history_budget" class="text_pole" min="1" step="1" aria-label="챗 히스토리 상한선 (토큰)" aria-describedby="ctt-history-limit ctt-history-notice">
                <small id="ctt-history-limit" class="ctt-history-limit"></small>
                <small id="ctt-history-notice" class="ctt-history-notice" role="status"></small>
            </div>
            <div class="ctt-section">게이지 설정</div>
            <div class="ctt-row">
                <label for="ctt_size" class="ctt-row-label">크기</label>
                <div class="ctt-size-field">
                    <input type="range" id="ctt_size" min="${GAUGE_MIN}" max="${GAUGE_MAX}" step="1" aria-label="게이지 크기">
                    <input type="number" id="ctt_size_value" min="${GAUGE_MIN}" max="${GAUGE_MAX}" step="1" inputmode="numeric" aria-label="게이지 크기 (px)"><span>px</span>
                </div>
            </div>
            <div class="ctt-row" role="radiogroup" aria-label="게이지 위치">
                <span class="ctt-row-label">위치</span>
                <div class="ctt-position-options">
                ${[['top-left', '좌측 상단'], ['top-right', '우측 상단'], ['send-left', '입력 좌측'], ['send-buttons', '입력 우측']].map(([value, label]) => `<label class="checkbox_label"><input type="radio" name="ctt_position" value="${value}"><span>${label}</span></label>`).join('')}
                </div>
            </div>
        </div></div>`;
    target.append(container);
    const usageDetails = container.querySelector('#ctt_usage_details');
    usageDetails.checked = settings.showUsageDetails;
    usageDetails.addEventListener('change', () => {
        settings.showUsageDetails = usageDetails.checked;
        context().saveSettingsDebounced();
        render();
    }, { signal: listeners.signal });
    const historyOnly = container.querySelector('#ctt_history_only');
    const historyInput = container.querySelector('#ctt_history_budget');
    historyOnly.checked = settings.historyOnly;
    syncHistorySettings();
    historyOnly.addEventListener('change', () => {
        settings.historyOnly = historyOnly.checked;
        context().saveSettingsDebounced();
        syncHistorySettings(limits().budget, '');
        render();
    }, { signal: listeners.signal });
    const commitHistoryBudget = () => {
        if (historyInput.value === String(settings.historyBudget)) return;
        const value = Number(historyInput.value);
        const budget = limits().budget;
        let notice = '';
        if (!Number.isFinite(value) || value < 1) notice = '1 이상의 토큰 수를 입력하세요. 이전 값을 유지했습니다.';
        else {
            const stored = historyBudget(value, budget);
            settings.historyBudget = stored;
            if (budget > 0 && value > budget) notice = `입력 예산을 초과해 ${format(stored)} 토큰으로 조정했습니다.`;
            else if (value !== stored) notice = '상한선은 정수 토큰 수로 저장됩니다.';
            context().saveSettingsDebounced();
        }
        syncHistorySettings(budget, notice);
        render();
    };
    historyInput.addEventListener('change', commitHistoryBudget, { signal: listeners.signal });
    historyInput.addEventListener('blur', commitHistoryBudget, { signal: listeners.signal });
    const enabled = container.querySelector('#ctt_enabled');
    enabled.checked = settings.enabled;
    enabled.addEventListener('change', () => {
        settings.enabled = enabled.checked;
        context().saveSettingsDebounced();
        if (!settings.enabled) {
            finishAssembly();
            revision++;
            clearTimeout(refreshTimer);
            refreshTimer = undefined;
            clearTimeout(pendingTimeout);
            refreshPending = false;
            refreshError = '';
            closePanel();
            releaseHost(toolbarHost);
        } else {
            mountBadge();
            snapshot = null;
        }
        observe();
        render();
        if (settings.enabled) requestRefresh();
    }, { signal: listeners.signal });
    const sizeRange = container.querySelector('#ctt_size');
    const sizeInput = container.querySelector('#ctt_size_value');
    const showSize = () => {
        sizeRange.value = String(settings.size);
        sizeRange.style.setProperty('--ctt-fill', `${(settings.size - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN) * 100}%`);
        if (document.activeElement !== sizeInput) sizeInput.value = String(settings.size);
    };
    const setSize = value => {
        const size = gaugeSize(value);
        if (size !== settings.size) {
            settings.size = size;
            context().saveSettingsDebounced();
            applySize();
            queueLayout();
        }
        showSize();
    };
    showSize();
    sizeRange.addEventListener('input', () => {
        sizeInput.value = sizeRange.value;
        setSize(sizeRange.value);
    }, { signal: listeners.signal });
    sizeInput.addEventListener('input', () => {
        // 입력 중에는 범위 안의 값일 때만 즉시 반영하고, 확정 시 범위 밖 값을 보정한다.
        const value = Number(sizeInput.value);
        if (sizeInput.value !== '' && value >= GAUGE_MIN && value <= GAUGE_MAX) setSize(value);
    }, { signal: listeners.signal });
    const commitSize = () => {
        setSize(sizeInput.value === '' ? settings.size : sizeInput.value);
        sizeInput.value = String(settings.size);
    };
    sizeInput.addEventListener('change', commitSize, { signal: listeners.signal });
    sizeInput.addEventListener('blur', commitSize, { signal: listeners.signal });
    sizeInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') sizeInput.blur();
    }, { signal: listeners.signal });
    for (const radio of container.querySelectorAll('[name="ctt_position"]')) {
        radio.checked = radio.value === settings.position;
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            settings.position = radio.value;
            context().saveSettingsDebounced();
            mountBadge();
            queueLayout();
        }, { signal: listeners.signal });
    }
}

function bind(name, handler) {
    const ctx = context();
    const event = ctx.eventTypes[name];
    if (!event) {
        missingEvents.push(name);
        return;
    }
    ctx.eventSource.on(event, handler);
    subscriptions.push([ctx.eventSource, event, handler]);
}

function bindEvents() {
    bind('GENERATION_STARTED', (type) => {
        generationKey = chatKey();
        generationRevision = revision;
        generationType = type;
    });
    // 슬래시 명령만 실행하고 끝나는 전송은 이 이벤트가 오지 않으므로 대기 표시도 여기서 시작한다.
    bind('GENERATION_AFTER_COMMANDS', (type, options, dryRun) => {
        if (dryRun || trackingFailed || !settings.enabled || context().mainApi !== 'openai' || !hasChat()
            || ['quiet', 'impersonate'].includes(type)) return;
        generationRevision = revision;
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
        clearTimeout(pendingTimeout);
        refreshError = '';
        refreshPending = true;
        render();
        // 프롬프트 조립 전에 생성이 실패해도 '계산 중' 상태가 남지 않게 한다.
        pendingTimeout = setTimeout(() => {
            if (!active || !refreshPending) return;
            refreshPending = false;
            render();
        }, 15000);
        assemblyPending = true;
        assemblyDeferred = false;
        clearTimeout(assemblyTimer);
        // 조립 전에 생성이 중단되어 종료 이벤트가 오지 않는 경우를 대비한다.
        assemblyTimer = setTimeout(() => {
            if (finishAssembly() && active) requestRefresh();
        }, 15000);
    });
    bind('GENERATE_AFTER_DATA', capturePrompt);
    const generationEnded = () => {
        finishAssembly();
        requestRefresh();
    };
    for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED']) bind(name, generationEnded);
    const reset = () => {
        finishAssembly();
        snapshot = null;
        refreshError = '';
        generationKey = '';
        closePanel();
        observe();
        queueLayout();
        requestRefresh();
    };
    for (const name of ['CHAT_CHANGED', 'CHAT_LOADED', 'MAIN_API_CHANGED']) bind(name, reset);
    for (const name of [
        'APP_READY', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED',
        'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_FILE_EMBEDDED',
        'MESSAGE_REASONING_EDITED', 'MESSAGE_REASONING_DELETED', 'GROUP_WRAPPER_FINISHED', 'CHATCOMPLETION_MODEL_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED',
        'OAI_PRESET_CHANGED_AFTER', 'WORLDINFO_SETTINGS_UPDATED', 'WORLDINFO_UPDATED',
        'CHARACTER_EDITED', 'PERSONA_CHANGED', 'PERSONA_UPDATED', 'CONNECTION_PROFILE_LOADED',
    ]) bind(name, requestRefresh);
    const refreshLimits = event => {
        if (['openai_max_context', 'openai_max_context_counter', 'openai_max_tokens'].includes(event.target.id)) requestRefresh();
    };
    document.addEventListener('input', refreshLimits, { signal: listeners.signal });
    document.addEventListener('change', refreshLimits, { signal: listeners.signal });
    window.addEventListener('pagehide', event => { if (!event.persisted) dispose(); }, { signal: listeners.signal });
    if (missingEvents.length) console.debug('[ContextTracker] 이 SillyTavern 버전에 없는 이벤트를 건너뜁니다:', missingEvents.join(', '));
}

function dispose() {
    active = false;
    clearTimeout(refreshTimer);
    clearTimeout(pendingTimeout);
    clearTimeout(assemblyTimer);
    cancelAnimationFrame(layoutFrame);
    layoutObserver?.disconnect();
    chatObserver?.disconnect();
    resizeObserver?.disconnect();
    listeners.abort();
    for (const [source, event, handler] of subscriptions.splice(0)) {
        try { source.removeListener?.(event, handler); }
        catch (error) { console.warn('[ContextTracker] 이벤트 해제 실패', error); }
    }
    releaseHost(toolbarHost);
    for (const restore of restorers.splice(0).reverse()) {
        try { restore(); }
        catch (error) { console.warn('[ContextTracker] 추적 API 복원 실패', error); }
    }
    document.querySelector('.context-tracker-settings')?.remove();
    settingsPanel = undefined;
    badge?.remove();
    panel?.remove();
}

export function onDelete() {
    removed = true;
    dispose();
}

// 본체는 비활성화 직후가 아니라 확장 관리자를 닫을 때 새로고침하므로 그 전에 정리한다.
export function onDisable() {
    onDelete();
}

export function onClean() {
    onDelete();
    // 본체 제거 흐름이 이 훅 이후 설정을 즉시 저장한다. 이전 버전의 필드도 함께 지운다.
    delete context().extensionSettings[MODULE];
}

jQuery(async () => {
    try {
        if (removed || document.getElementById('ctx-tracker-badge')) return;
        const store = context().extensionSettings;
        settings = store[MODULE] ??= {};
        if (typeof settings.enabled !== 'boolean') settings.enabled = true;
        if (typeof settings.historyOnly !== 'boolean') settings.historyOnly = false;
        if (typeof settings.showUsageDetails !== 'boolean') settings.showUsageDetails = false;
        settings.historyBudget = historyBudget(settings.historyBudget, 0);
        if (!['top-left', 'top-right', 'send-left', 'send-buttons'].includes(settings.position)) settings.position = 'top-right';
        settings.size = gaugeSize(settings.size);
        active = true;
        const importError = await loadInternals();
        if (!active) return;
        buildUI();
        addSettingsPanel();
        bindEvents();
        if (importError) {
            trackingFailed = true;
            countingUnavailable(importError);
        } else {
            try { trackAssembly(); requestRefresh(); }
            catch (error) {
                trackingFailed = true;
                for (const restore of restorers.splice(0).reverse()) restore();
                countingUnavailable(error);
            }
        }
    } catch (error) {
        console.error('[ContextTracker] 초기화 실패', error);
        dispose();
    }
});
