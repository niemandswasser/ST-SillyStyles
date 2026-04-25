// ============================================================
// ST-SillyStyles — Style Preset Manager
// Intercepts outgoing image-generation fetch() calls and
// substitutes the style block in the prompt with the active
// preset's style. Chat history is NEVER modified.
// ============================================================

const MODULE_NAME = 'ST-SillyStyles';

const defaultSettings = Object.freeze({
    enabled: true,
    stylePresets: [],
    activePresetId: null,
    collapsedSections: {},
});

function getSettings() {
    const context = SillyTavern.getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(context.extensionSettings[MODULE_NAME], key)) {
            context.extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    // Migrate preset schema: boundPrompt -> promptStart, add promptEnd.
    const presets = context.extensionSettings[MODULE_NAME].stylePresets || [];
    for (const p of presets) {
        if (p == null) continue;
        if (p.boundPrompt != null && p.promptStart == null) {
            p.promptStart = p.boundPrompt;
            delete p.boundPrompt;
        }
        if (p.promptStart == null) p.promptStart = '';
        if (p.promptEnd == null) p.promptEnd = '';
    }
    return context.extensionSettings[MODULE_NAME];
}

function saveSettings() {
    const context = SillyTavern.getContext();
    context.saveSettingsDebounced();
}

// Ephemeral in-memory selection state (not persisted).
const selectedIds = new Set();

// ============================================================
// PRESET HELPERS
// ============================================================

function generatePresetId() {
    return 'sstyle_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
}

function addStylePreset(name) {
    const settings = getSettings();
    const preset = {
        id: generatePresetId(),
        name: name || 'Стиль',
        style: '',
        promptStart: '',
        promptEnd: '',
        previewImage: null,
        createdAt: Date.now(),
    };
    settings.stylePresets.push(preset);
    saveSettings();
    return preset;
}

function removeStylePreset(presetId) {
    const settings = getSettings();
    if (settings.activePresetId === presetId) settings.activePresetId = null;
    settings.stylePresets = settings.stylePresets.filter(p => p.id !== presetId);
    selectedIds.delete(presetId);
    saveSettings();
}

function removeStylePresets(ids) {
    const settings = getSettings();
    const set = new Set(ids);
    if (set.has(settings.activePresetId)) settings.activePresetId = null;
    settings.stylePresets = settings.stylePresets.filter(p => !set.has(p.id));
    for (const id of ids) selectedIds.delete(id);
    saveSettings();
}

function setActivePreset(presetId) {
    const settings = getSettings();
    settings.activePresetId = settings.activePresetId === presetId ? null : presetId;
    saveSettings();
}

function getActivePreset() {
    const settings = getSettings();
    if (!settings.activePresetId) return null;
    return settings.stylePresets.find(p => p.id === settings.activePresetId) || null;
}

function updateStylePreset(presetId, patch) {
    const settings = getSettings();
    const preset = settings.stylePresets.find(p => p.id === presetId);
    if (!preset) return null;
    Object.assign(preset, patch);
    saveSettings();
    return preset;
}

// ============================================================
// IMAGE RESIZE (for preview thumbnails)
// ============================================================

async function resizeImageBase64(base64, maxSize = 512) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            let { width, height } = img;
            if (width <= maxSize && height <= maxSize) { resolve(base64); return; }
            const ratio = Math.min(maxSize / width, maxSize / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            const resized = canvas.toDataURL('image/png').split(',')[1];
            resolve(resized);
        };
        img.onerror = () => resolve(base64);
        img.src = 'data:image/png;base64,' + base64;
    });
}

// ============================================================
// STYLE INJECTION
// ============================================================

const STYLE_BLOCK_RE = /\[\s*style\s*:\s*[^\]]*\]/gi;

function injectStyleIntoPromptString(prompt) {
    const preset = getActivePreset();
    if (!preset || !preset.style?.trim()) return prompt;
    const newStyleBlock = `[STYLE: ${preset.style.trim()}]`;

    let modified;
    if (STYLE_BLOCK_RE.test(prompt)) {
        STYLE_BLOCK_RE.lastIndex = 0;
        let first = true;
        modified = prompt.replace(STYLE_BLOCK_RE, () => {
            if (first) { first = false; return newStyleBlock; }
            return '';
        });
    } else {
        modified = `${newStyleBlock}\n\n${prompt}`;
    }

    if (preset.promptStart?.trim()) {
        modified = `${preset.promptStart.trim()}\n\n${modified}`;
    }
    if (preset.promptEnd?.trim()) {
        modified = `${modified}\n\n${preset.promptEnd.trim()}`;
    }
    return modified;
}

// ============================================================
// FETCH INTERCEPTION
// ============================================================

function isImageGenUrl(url) {
    if (!url || typeof url !== 'string') return false;
    // OpenAI / Electron Hub / прочие OpenAI-совместимые: JSON body
    if (/\/v1\/images\/generations(\?|$)/i.test(url)) return true;
    // OpenAI gpt-image-*, dall-e-2, flux-kontext: multipart FormData body
    if (/\/v1\/images\/edits(\?|$)/i.test(url)) return true;
    // Gemini / nano-banana: JSON body
    if (/\/v1(beta)?\/models\/[^/]+:generateContent(\?|$)/i.test(url)) return true;
    return false;
}

function rewriteBodyJson(bodyText) {
    let parsed;
    try { parsed = JSON.parse(bodyText); }
    catch { return bodyText; }

    let changed = false;

    if (typeof parsed.prompt === 'string') {
        const updated = injectStyleIntoPromptString(parsed.prompt);
        if (updated !== parsed.prompt) { parsed.prompt = updated; changed = true; }
    }

    if (Array.isArray(parsed.contents)) {
        for (const c of parsed.contents) {
            if (!Array.isArray(c?.parts)) continue;
            for (const part of c.parts) {
                if (typeof part?.text === 'string') {
                    const updated = injectStyleIntoPromptString(part.text);
                    if (updated !== part.text) { part.text = updated; changed = true; }
                }
            }
        }
    }

    return changed ? JSON.stringify(parsed) : bodyText;
}

/**
 * Rewrites the `prompt` field of a multipart FormData body.
 * Used by `/v1/images/edits` (OpenAI gpt-image-*, dall-e-2, flux-kontext).
 * Returns a NEW FormData (or the same if no change).
 *
 * FormData entries preserve order; we rebuild to keep that order — some
 * proxies care about field ordering for image[] vs image vs prompt.
 */
function rewriteBodyFormData(form) {
    if (!(form instanceof FormData)) return form;

    const promptValue = form.get('prompt');
    if (typeof promptValue !== 'string') return form;

    const updated = injectStyleIntoPromptString(promptValue);
    if (updated === promptValue) return form;

    const next = new FormData();
    for (const [key, value] of form.entries()) {
        if (key === 'prompt') {
            next.append('prompt', updated);
        } else {
            next.append(key, value);
        }
    }
    return next;
}

/**
 * Detects the body kind on init / Request:
 *   - 'json'     — body is JSON string
 *   - 'formdata' — body is multipart FormData (OpenAI /v1/images/edits)
 *   - 'request'  — body is on a Request object (need to re-extract)
 *   - null       — nothing we can rewrite
 */
function detectBodyKind(init, input) {
    if (init && init.body != null) {
        if (typeof init.body === 'string') return 'json-init';
        if (typeof FormData !== 'undefined' && init.body instanceof FormData) return 'formdata-init';
    }
    if (input instanceof Request) return 'request';
    return null;
}

function installFetchInterceptor() {
    if (window.__sstylesFetchPatched) return;
    const original = window.fetch;
    window.fetch = async function(input, init) {
        try {
            const settings = getSettings();
            if (!settings.enabled || !getActivePreset()) {
                return original.call(this, input, init);
            }

            const url = typeof input === 'string'
                ? input
                : (input instanceof URL ? input.href : input?.url);

            if (!isImageGenUrl(url)) {
                return original.call(this, input, init);
            }

            const kind = detectBodyKind(init, input);
            if (!kind) return original.call(this, input, init);

            // ----- JSON body (init.body is string) -----
            if (kind === 'json-init') {
                const rewritten = rewriteBodyJson(init.body);
                if (rewritten === init.body) return original.call(this, input, init);
                console.log(`[${MODULE_NAME}] Injected preset style into ${url} (JSON init)`);
                return original.call(this, input, { ...init, body: rewritten });
            }

            // ----- FormData body (init.body is FormData) -----
            // Это путь OpenAI /v1/images/edits для gpt-image-* / dall-e-2 /
            // flux-1-kontext-*: тело — multipart, поле `prompt` — обычная
            // строка, остальные (`image`, `image[]`, `model`...) — Blob/strings.
            if (kind === 'formdata-init') {
                const next = rewriteBodyFormData(init.body);
                if (next === init.body) return original.call(this, input, init);
                console.log(`[${MODULE_NAME}] Injected preset style into ${url} (FormData init)`);
                return original.call(this, input, { ...init, body: next });
            }

            // ----- Request input -----
            // Тело может быть JSON или FormData. Сначала пытаемся как
            // FormData (через .clone().formData()). Если бросает — fallback
            // на text() и JSON path.
            if (kind === 'request') {
                const req = input;
                const ct = String(req.headers?.get?.('content-type') || '').toLowerCase();
                const looksLikeFormData = ct.includes('multipart/form-data');

                if (looksLikeFormData) {
                    let form = null;
                    try { form = await req.clone().formData(); } catch { /* fallback below */ }
                    if (form) {
                        const next = rewriteBodyFormData(form);
                        if (next === form) return original.call(this, input, init);
                        console.log(`[${MODULE_NAME}] Injected preset style into ${url} (FormData request)`);
                        // Не передаём content-type вручную — fetch проставит
                        // правильный multipart boundary под новый FormData.
                        const headers = new Headers(req.headers);
                        headers.delete('content-type');
                        const rebuilt = new Request(req.url, {
                            method: req.method,
                            headers,
                            body: next,
                            mode: req.mode,
                            credentials: req.credentials,
                            cache: req.cache,
                            redirect: req.redirect,
                            referrer: req.referrer,
                            integrity: req.integrity,
                        });
                        return original.call(this, rebuilt, init);
                    }
                }

                let bodyText = null;
                try { bodyText = await req.clone().text(); } catch { /* ignore */ }
                if (!bodyText) return original.call(this, input, init);

                const rewritten = rewriteBodyJson(bodyText);
                if (rewritten === bodyText) return original.call(this, input, init);
                console.log(`[${MODULE_NAME}] Injected preset style into ${url} (JSON request)`);
                const rebuilt = new Request(req.url, {
                    method: req.method,
                    headers: req.headers,
                    body: rewritten,
                    mode: req.mode,
                    credentials: req.credentials,
                    cache: req.cache,
                    redirect: req.redirect,
                    referrer: req.referrer,
                    integrity: req.integrity,
                });
                return original.call(this, rebuilt, init);
            }
        } catch (err) {
            console.error(`[${MODULE_NAME}] interceptor error:`, err);
        }
        return original.call(this, input, init);
    };
    window.__sstylesFetchPatched = true;
}

// ============================================================
// IMPORT / EXPORT
// ============================================================

function buildExportPayload(presets) {
    return {
        app: MODULE_NAME,
        version: 2,
        exportedAt: new Date().toISOString(),
        presets,
    };
}

function downloadJson(payload, filenameHint) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `sstyles-${filenameHint || 'export'}-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function exportAllPresets() {
    const settings = getSettings();
    const presets = settings.stylePresets || [];
    if (presets.length === 0) { toastr.info('Нет пресетов для экспорта'); return; }
    downloadJson(buildExportPayload(presets), 'all');
    toastr.success(`Экспортировано пресетов: ${presets.length}`);
}

function exportPresetsByIds(ids) {
    const settings = getSettings();
    const set = new Set(ids);
    const presets = (settings.stylePresets || []).filter(p => set.has(p.id));
    if (presets.length === 0) { toastr.info('Нечего экспортировать'); return; }
    const hint = presets.length === 1 ? safeFilename(presets[0].name) : `selected-${presets.length}`;
    downloadJson(buildExportPayload(presets), hint);
    toastr.success(`Экспортировано пресетов: ${presets.length}`);
}

function safeFilename(s) {
    return String(s || '').replace(/[^a-zA-Zа-яА-Я0-9_\-]+/g, '_').slice(0, 40) || 'preset';
}

function normalizeImportedPreset(p) {
    if (!p || typeof p !== 'object') return null;
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : 'Импорт';
    const style = typeof p.style === 'string' ? p.style : '';
    // Backward-compat: accept boundPrompt as promptStart.
    const promptStart = typeof p.promptStart === 'string'
        ? p.promptStart
        : (typeof p.boundPrompt === 'string' ? p.boundPrompt : '');
    const promptEnd = typeof p.promptEnd === 'string' ? p.promptEnd : '';
    const previewImage = typeof p.previewImage === 'string' && p.previewImage.length ? p.previewImage : null;
    return {
        id: generatePresetId(),
        name, style, promptStart, promptEnd, previewImage,
        createdAt: Date.now(),
    };
}

async function importPresetsFromText(text) {
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw new Error('Не JSON'); }

    let raw;
    if (Array.isArray(parsed)) raw = parsed;
    else if (Array.isArray(parsed.presets)) raw = parsed.presets;
    else if (Array.isArray(parsed.stylePresets)) raw = parsed.stylePresets;
    else throw new Error('Не найдено поле presets / stylePresets / массив');

    const settings = getSettings();
    let added = 0;
    for (const p of raw) {
        const norm = normalizeImportedPreset(p);
        if (norm) { settings.stylePresets.push(norm); added++; }
    }
    saveSettings();
    return added;
}

function pickJsonFile() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (!file) { resolve(null); return; }
            const reader = new FileReader();
            reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
            reader.onerror = () => resolve(null);
            reader.readAsText(file);
        });
        input.click();
    });
}

// ============================================================
// UI
// ============================================================

function createCollapsibleSection(sectionId, icon, title, content) {
    const settings = getSettings();
    const isCollapsed = settings.collapsedSections?.[sectionId];
    return `
        <div class="sstyles-section" data-section="${sectionId}">
            <div class="sstyles-section-header" data-section-toggle="${sectionId}">
                <span class="sstyles-section-icon">${icon}</span>
                <span class="sstyles-section-title">${title}</span>
                <i class="fa-solid fa-chevron-down sstyles-section-chevron ${isCollapsed ? 'sstyles-collapsed' : ''}"></i>
            </div>
            <div class="sstyles-section-body ${isCollapsed ? 'sstyles-section-hidden' : ''}">
                ${content}
            </div>
        </div>
    `;
}

function toggleSectionCollapsed(sectionId) {
    const settings = getSettings();
    if (!settings.collapsedSections) settings.collapsedSections = {};
    settings.collapsedSections[sectionId] = !settings.collapsedSections[sectionId];
    saveSettings();
}

function renderSelectionToolbar() {
    const container = document.getElementById('sstyles_toolbar');
    if (!container) return;
    const count = selectedIds.size;
    container.innerHTML = `
        <div class="sstyles-toolbar-row">
            <div id="sstyles_select_all" class="menu_button" title="Выбрать все"><i class="fa-solid fa-check-double"></i></div>
            <div id="sstyles_clear_sel" class="menu_button" title="Снять выбор"><i class="fa-solid fa-xmark"></i></div>
            <div class="sstyles-toolbar-spacer"></div>
            <div id="sstyles_export_sel" class="menu_button ${count === 0 ? 'disabled' : ''}" title="Экспорт выбранных">
                <i class="fa-solid fa-file-export"></i> Экспорт (${count})
            </div>
            <div id="sstyles_delete_sel" class="menu_button danger ${count === 0 ? 'disabled' : ''}" title="Удалить выбранные">
                <i class="fa-solid fa-trash"></i> Удалить (${count})
            </div>
        </div>
    `;

    document.getElementById('sstyles_select_all')?.addEventListener('click', () => {
        const settings = getSettings();
        for (const p of settings.stylePresets) selectedIds.add(p.id);
        renderStyleGrid();
    });

    document.getElementById('sstyles_clear_sel')?.addEventListener('click', () => {
        selectedIds.clear();
        renderStyleGrid();
    });

    document.getElementById('sstyles_export_sel')?.addEventListener('click', () => {
        if (selectedIds.size === 0) return;
        exportPresetsByIds(Array.from(selectedIds));
    });

    document.getElementById('sstyles_delete_sel')?.addEventListener('click', () => {
        if (selectedIds.size === 0) return;
        if (!window.confirm(`Удалить выбранные пресеты (${selectedIds.size})?`)) return;
        removeStylePresets(Array.from(selectedIds));
        renderStyleGrid();
        toastr.info('Выбранные пресеты удалены');
    });
}

function renderStyleGrid() {
    const settings = getSettings();
    const container = document.getElementById('sstyles_lib');
    if (!container) return;

    const items = settings.stylePresets || [];
    const activeId = settings.activePresetId;

    renderSelectionToolbar();

    if (items.length === 0) {
        container.innerHTML = `<div class="sstyles-empty">Нет стилей. Введите название и нажмите «Добавить» или импортируйте JSON.</div>`;
        renderStyleEditor();
        return;
    }

    container.innerHTML = items.map(item => `
        <div class="sstyles-card ${item.id === activeId ? 'sstyles-active' : ''} ${selectedIds.has(item.id) ? 'sstyles-selected' : ''}" data-style-id="${item.id}">
            <input type="checkbox" class="sstyles-card-check" data-style-check="${item.id}" ${selectedIds.has(item.id) ? 'checked' : ''} title="Выбрать">
            ${item.previewImage
                ? `<img src="data:image/png;base64,${item.previewImage}" class="sstyles-img" alt="${escapeAttr(item.name)}">`
                : `<div class="sstyles-img sstyles-img-placeholder"><i class="fa-solid fa-palette"></i></div>`}
            <div class="sstyles-card-overlay">
                <span class="sstyles-card-name" title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</span>
                <div class="sstyles-card-actions">
                    <i class="fa-solid fa-file-export sstyles-card-action" data-style-export="${item.id}" title="Экспортировать этот пресет"></i>
                    <i class="fa-solid fa-trash sstyles-card-action sstyles-delete" data-style-del="${item.id}" title="Удалить"></i>
                </div>
            </div>
            ${item.id === activeId ? '<div class="sstyles-check"><i class="fa-solid fa-check"></i></div>' : ''}
        </div>
    `).join('');

    container.querySelectorAll('.sstyles-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('.sstyles-card-action')) return;
            if (e.target.closest('.sstyles-card-check')) return;
            const id = card.dataset.styleId;
            if (!id) return;
            setActivePreset(id);
            renderStyleGrid();
        });
    });

    container.querySelectorAll('.sstyles-card-check').forEach(cb => {
        cb.addEventListener('change', (e) => {
            e.stopPropagation();
            const id = cb.getAttribute('data-style-check');
            if (!id) return;
            if (cb.checked) selectedIds.add(id);
            else selectedIds.delete(id);
            // Update classes/toolbar without rebuilding the whole grid.
            const card = cb.closest('.sstyles-card');
            card?.classList.toggle('sstyles-selected', cb.checked);
            renderSelectionToolbar();
        });
        cb.addEventListener('click', (e) => e.stopPropagation());
    });

    container.querySelectorAll('[data-style-export]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.getAttribute('data-style-export');
            if (!id) return;
            exportPresetsByIds([id]);
        });
    });

    container.querySelectorAll('[data-style-del]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.getAttribute('data-style-del');
            if (!id) return;
            if (!window.confirm('Удалить этот пресет стиля?')) return;
            removeStylePreset(id);
            renderStyleGrid();
            toastr.info('Пресет удалён');
        });
    });

    renderStyleEditor();
}

function renderStyleEditor() {
    const container = document.getElementById('sstyles_editor');
    if (!container) return;

    const active = getActivePreset();
    if (!active) {
        container.innerHTML = '<p class="sstyles-hint">Выберите пресет в сетке, чтобы редактировать его.</p>';
        return;
    }

    const styleFilled = (active.style || '').trim().length > 0;

    container.innerHTML = `
        <h5 class="sstyles-editor-title">Редактирование: ${escapeHtml(active.name)}</h5>
        <div class="sstyles-field">
            <label>Название</label>
            <input type="text" class="text_pole" data-style-field="name" value="${escapeAttr(active.name)}">
        </div>
        <div class="sstyles-field">
            <label class="${styleFilled ? '' : 'sstyles-required'}">
                Style <span class="sstyles-badge-req">обязательное</span>
                <span class="sstyles-label-hint">— попадёт в блок <code>[STYLE: …]</code> запроса на генерацию</span>
            </label>
            <textarea class="text_pole ${styleFilled ? '' : 'sstyles-input-required'}" rows="4" data-style-field="style" placeholder="masterpiece, 8k, best quality, anime semi-realistic...">${escapeHtml(active.style || '')}</textarea>
        </div>
        <div class="sstyles-field">
            <label>
                Начало промпта <span class="sstyles-badge-opt">опционально</span>
                <span class="sstyles-label-hint">— добавится в самое <b>начало</b> запроса</span>
            </label>
            <textarea class="text_pole" rows="3" data-style-field="promptStart" placeholder="Напр.: высокоприоритетные инструкции, общий сеттинг...">${escapeHtml(active.promptStart || '')}</textarea>
        </div>
        <div class="sstyles-field">
            <label>
                Конец промпта <span class="sstyles-badge-opt">опционально</span>
                <span class="sstyles-label-hint">— добавится в самый <b>конец</b> запроса</span>
            </label>
            <textarea class="text_pole" rows="3" data-style-field="promptEnd" placeholder="Напр.: пост-инструкции, negative hints, финальные правки стиля...">${escapeHtml(active.promptEnd || '')}</textarea>
        </div>
        <div class="sstyles-row">
            <input type="file" id="sstyles_preview_file" accept="image/*" style="display:none;">
            <div id="sstyles_preview_upload" class="menu_button flex1">
                <i class="fa-solid fa-image"></i> ${active.previewImage ? 'Заменить превью' : 'Загрузить превью'}
            </div>
            ${active.previewImage ? `<div id="sstyles_preview_clear" class="menu_button" title="Убрать превью"><i class="fa-solid fa-xmark"></i></div>` : ''}
        </div>
    `;

    container.querySelectorAll('[data-style-field]').forEach(el => {
        el.addEventListener('input', (e) => {
            const field = el.getAttribute('data-style-field');
            if (!field) return;
            updateStylePreset(active.id, { [field]: e.target.value });
            if (field === 'name') {
                // Live-update the card label and editor header without rebuilding
                // anything — rebuilding would steal focus from this input.
                const cardNameEl = document.querySelector(`.sstyles-card[data-style-id="${active.id}"] .sstyles-card-name`);
                if (cardNameEl) {
                    cardNameEl.textContent = e.target.value;
                    cardNameEl.title = e.target.value;
                }
                const editorTitle = container.querySelector('.sstyles-editor-title');
                if (editorTitle) editorTitle.textContent = `Редактирование: ${e.target.value}`;
            }
            if (field === 'style') {
                const ta = el;
                const labelEl = container.querySelector('.sstyles-field label.sstyles-required, .sstyles-field label:has(.sstyles-badge-req)');
                const filled = e.target.value.trim().length > 0;
                ta.classList.toggle('sstyles-input-required', !filled);
                labelEl?.classList.toggle('sstyles-required', !filled);
            }
        });
    });

    document.getElementById('sstyles_preview_upload')?.addEventListener('click', () => {
        document.getElementById('sstyles_preview_file')?.click();
    });

    document.getElementById('sstyles_preview_file')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onloadend = async () => {
            const resized = await resizeImageBase64(reader.result.split(',')[1], 512);
            updateStylePreset(active.id, { previewImage: resized });
            renderStyleGrid();
            toastr.success('Превью обновлено');
        };
        reader.readAsDataURL(file);
    });

    document.getElementById('sstyles_preview_clear')?.addEventListener('click', () => {
        updateStylePreset(active.id, { previewImage: null });
        renderStyleGrid();
    });
}

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');
}

function createSettingsUI() {
    const settings = getSettings();
    const container = document.getElementById('extensions_settings');
    if (!container) return;
    if (document.getElementById('sstyles_root')) return;

    const libraryContent = `
        <p class="sstyles-hint">Библиотека пресетов стилей. Активный пресет подставляется в блок <code>[STYLE: …]</code> запроса на генерацию картинки «на лету». История чата не изменяется.</p>
        <div id="sstyles_toolbar"></div>
        <div id="sstyles_lib" class="sstyles-grid"></div>
        <div class="sstyles-add-row">
            <input type="text" id="sstyles_new_name" class="text_pole flex1" placeholder="Название нового пресета">
            <div id="sstyles_add" class="menu_button"><i class="fa-solid fa-plus"></i> Добавить</div>
        </div>
        <div id="sstyles_editor"></div>
    `;

    const ioContent = `
        <p class="sstyles-hint">Экспортируй все пресеты в JSON-файл или загрузи ранее сохранённый. При импорте пресеты добавляются к существующим (не заменяют их). Для экспорта отдельных пресетов — выбери их галочками в библиотеке.</p>
        <div class="sstyles-row">
            <div id="sstyles_export_all" class="menu_button flex1"><i class="fa-solid fa-file-export"></i> Экспорт всех</div>
            <div id="sstyles_import" class="menu_button flex1"><i class="fa-solid fa-file-import"></i> Импорт JSON</div>
        </div>
    `;

    const html = `
        <div id="sstyles_root" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🖌️ ST-SillyStyles</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="sstyles-settings">
                    <label class="checkbox_label">
                        <input type="checkbox" id="sstyles_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Включить подстановку стиля</span>
                    </label>
                    ${createCollapsibleSection('library', '🎨', 'Библиотека стилей', libraryContent)}
                    ${createCollapsibleSection('io', '💾', 'Импорт / Экспорт', ioContent)}
                </div>
            </div>
        </div>
    `;

    container.insertAdjacentHTML('beforeend', html);

    document.querySelectorAll('#sstyles_root [data-section-toggle]').forEach(header => {
        header.addEventListener('click', () => {
            const sectionId = header.dataset.sectionToggle;
            if (!sectionId) return;
            toggleSectionCollapsed(sectionId);
            const section = header.closest('.sstyles-section');
            const body = section?.querySelector('.sstyles-section-body');
            const chevron = section?.querySelector('.sstyles-section-chevron');
            body?.classList.toggle('sstyles-section-hidden');
            chevron?.classList.toggle('sstyles-collapsed');
        });
    });

    document.getElementById('sstyles_enabled')?.addEventListener('change', (e) => {
        settings.enabled = e.target.checked;
        saveSettings();
    });

    document.getElementById('sstyles_add')?.addEventListener('click', () => {
        const nameInput = document.getElementById('sstyles_new_name');
        const name = nameInput?.value?.trim() || `Стиль ${(settings.stylePresets?.length || 0) + 1}`;
        const preset = addStylePreset(name);
        settings.activePresetId = preset.id;
        saveSettings();
        if (nameInput) nameInput.value = '';
        renderStyleGrid();
        toastr.success(`Пресет "${name}" создан`);
    });

    document.getElementById('sstyles_export_all')?.addEventListener('click', () => {
        exportAllPresets();
    });

    document.getElementById('sstyles_import')?.addEventListener('click', async () => {
        const text = await pickJsonFile();
        if (!text) return;
        try {
            const added = await importPresetsFromText(text);
            renderStyleGrid();
            toastr.success(`Импортировано пресетов: ${added}`);
        } catch (e) {
            toastr.error(`Ошибка импорта: ${e.message}`);
        }
    });

    renderStyleGrid();
}

// ============================================================
// INIT
// ============================================================

(function init() {
    const context = SillyTavern.getContext();
    getSettings();
    installFetchInterceptor();

    const onReady = () => {
        createSettingsUI();
        console.log(`[${MODULE_NAME}] loaded`);
    };

    if (context.event_types?.APP_READY) {
        context.eventSource.on(context.event_types.APP_READY, onReady);
    }
    setTimeout(onReady, 500);

    console.log(`[${MODULE_NAME}] initialized`);
})();
