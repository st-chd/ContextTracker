const MODULE = 'context_tracker';

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
        if (!active || !settings.enabled) return original.apply(this, args);
        const size = Math.max(0, Number(args[0]) || 0);
        const response = Math.max(0, Number(args[1]) || 0);
        completions.set(this, { revision: generationRevision, key: generationKey, type: generationType,
            sequence: ++assemblySequence, size, response, budget: Math.max(0, size - response), error: '', counts: null });
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
            try { result.counts = { ...this.tokenHandler.getCounts() }; }
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
    let hint = `현재 입력 예산: ${format(budget)} 토큰 (상한선은 이 값을 넘을 수 없습니다.)`;
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
    setText(panel.querySelector('[data-ctt-label="total"]'), settings.historyOnly ? '챗 히스토리' : '총 토큰');
    setText(panel.querySelector('[data-ctt-label="budget"]'), settings.historyOnly ? '히스토리 예산' : '입력 예산');
    setValue('total', usage);
    setValue('size', size);
    setValue('response', response);
    setValue('budget', displayBudget);
    setValue('remaining', measured ? Math.max(0, displayBudget - usage) : undefined);
    setText(panel.querySelector('#ctt-details-title'), measured ? `${percent}% 사용` : `${mode} 사용량`);
    setText(panel.querySelector('.ctt-headline-sub'), measured ? `추정 ${format(usage)} / ${format(displayBudget)} 토큰` : '');
    const status = !supported
        ? 'Chat Completion에서 사용할 수 있습니다.'
        : refreshError ? refreshError
            : !hasChat(ctx) ? '대화를 선택하세요.'
                : budget <= 0 ? '컨텍스트 크기가 최대 응답 길이보다 커야 합니다.'
                    : refreshPending ? '컨텍스트 계산 중…'
                        : !current ? (ctx.groupId != null ? '그룹 채팅은 메시지를 전송할 때 집계됩니다.' : '토큰 집계를 기다리는 중…')
                            : current.source === 'global' ? '추적되지 않은 집계입니다. 현재 입력과 다를 수 있습니다.'
                                : current.revision !== revision && !current.dryRun ? '생성에 사용된 입력입니다. 변경 사항은 다음 집계에 반영됩니다.' : '';
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

function capturePrompt(data, dryRun) {
    const ctx = context();
    const result = promptResults.get(data?.prompt);
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
    snapshot = { key: chatKey(ctx), total, history, revision: result?.revision ?? generationRevision,
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
        panel.style.maxHeight = `${Math.max(0, bottomEdge - topEdge)}px`;
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

function mountBadge() {
    if (!settings.enabled) return;
    const form = document.getElementById('send_form');
    if (!form) return;
    const input = form.querySelector('#nonQRFormItems');
    const host = settings.position === 'send-left' ? input?.querySelector('#leftSendForm')
        : settings.position === 'send-buttons' ? input?.querySelector('#rightSendForm') : form;
    if (!host) return;
    if (toolbarHost && toolbarHost !== form) toolbarHost.removeAttribute('data-ctt-position');
    toolbarHost = form;
    if (form.dataset.cttPosition !== settings.position) form.dataset.cttPosition = settings.position;
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
    panel = document.createElement('section');
    panel.id = 'ctt-details';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'ctt-details-title');
    panel.innerHTML = `<div class="ctt-panel-header">
        <div class="ctt-headline"><strong id="ctt-details-title">컨텍스트 사용량</strong><span class="ctt-headline-sub"></span></div>
        <button type="button" class="ctt-close" aria-label="세부 패널 닫기">×</button></div>
        <dl class="ctt-totals">
            <div class="ctt-total"><dt data-ctt-label="total">총 토큰</dt><dd data-ctt="total">—</dd></div>
            <div><dt>컨텍스트 크기</dt><dd data-ctt="size">—</dd></div>
            <div><dt>최대 응답 길이</dt><dd data-ctt="response">—</dd></div>
            <div><dt data-ctt-label="budget">입력 예산</dt><dd data-ctt="budget">—</dd></div>
            <div><dt>잔여량</dt><dd data-ctt="remaining">—</dd></div>
        </dl>
        <p class="ctt-status" role="status"></p>`;
    document.body.append(panel);
    button.addEventListener('click', () => {
        if (!panel.hidden) return closePanel();
        panel.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        render();
        if (!refreshPending && (refreshError || snapshot?.key !== chatKey())) requestRefresh();
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
    chatObserver = new MutationObserver(requestRefresh);
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
        <div class="inline-drawer-content"><label class="checkbox_label">
            <input type="checkbox" id="ctt_enabled"><span>입력 컨텍스트 게이지 표시</span></label>
            <label class="checkbox_label"><input type="checkbox" id="ctt_history_only"><span>챗 히스토리 예산으로 계산</span></label>
            <label for="ctt_history_budget">챗 히스토리 상한선 (토큰)</label>
            <input type="number" id="ctt_history_budget" class="text_pole" min="1" step="1" aria-describedby="ctt-history-limit ctt-history-notice">
            <small id="ctt-history-limit" class="ctt-history-limit"></small>
            <small id="ctt-history-notice" class="ctt-history-notice" role="status"></small>
            <fieldset class="ctt-position-options"><legend>게이지 위치</legend>
                ${[['top-left', '좌측 상단'], ['top-right', '우측 상단 (기본값)'], ['send-left', '입력 영역 좌측'], ['send-buttons', '입력 영역 우측']].map(([value, label]) => `<label class="checkbox_label"><input type="radio" name="ctt_position" value="${value}"><span>${label}</span></label>`).join('')}
            </fieldset>
        </div></div>`;
    target.append(container);
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
            revision++;
            clearTimeout(refreshTimer);
            refreshTimer = undefined;
            clearTimeout(pendingTimeout);
            refreshPending = false;
            refreshError = '';
            closePanel();
            toolbarHost?.removeAttribute('data-ctt-position');
        } else {
            mountBadge();
            snapshot = null;
        }
        observe();
        render();
        if (settings.enabled) requestRefresh();
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
    bind('GENERATION_STARTED', (type, options, dryRun) => {
        generationKey = chatKey();
        generationRevision = revision;
        generationType = type;
        if (!trackingFailed && settings.enabled && context().mainApi === 'openai' && hasChat() && !dryRun && !['quiet', 'impersonate'].includes(type)) {
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
        }
    });
    bind('GENERATE_AFTER_DATA', capturePrompt);
    const reset = () => {
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
        'MESSAGE_REASONING_EDITED', 'MESSAGE_REASONING_DELETED', 'GENERATION_ENDED', 'GENERATION_STOPPED',
        'GROUP_WRAPPER_FINISHED', 'CHATCOMPLETION_MODEL_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED',
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
    cancelAnimationFrame(layoutFrame);
    layoutObserver?.disconnect();
    chatObserver?.disconnect();
    resizeObserver?.disconnect();
    listeners.abort();
    for (const [source, event, handler] of subscriptions.splice(0)) {
        try { source.removeListener?.(event, handler); }
        catch (error) { console.warn('[ContextTracker] 이벤트 해제 실패', error); }
    }
    toolbarHost?.removeAttribute('data-ctt-position');
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
        settings.historyBudget = historyBudget(settings.historyBudget, 0);
        if (!['top-left', 'top-right', 'send-left', 'send-buttons'].includes(settings.position)) settings.position = 'top-right';
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
