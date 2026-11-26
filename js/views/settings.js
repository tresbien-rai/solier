/**
 * The Settings view: its tab strip, and the Advanced tab (AP-02).
 *
 * Settings used to be one long scroll of `.settings-section` blocks. Advanced
 * adds a whole surface of its own — prompt presets now, the block editor and the
 * prompt inspector next — which is more than a scroll can carry, so the sections
 * are grouped into tabs. The tab strip is built from the sections themselves
 * (each declares `data-settings-tab`), so adding a section to a tab is an
 * attribute, not a change here.
 *
 * Three layers live here, in order down the file (see docs/design/ADVANCED_PROMPTS_PLAN.md):
 *   AP-02  the preset lifecycle — create, duplicate, rename, delete, account default
 *   AP-03  the block editor behind a preset's Edit
 *   AP-04  selection — the composer pill + menu, and the persona editor's picker
 *
 * The AP-04 helpers mirror the server's resolvePromptPreset precedence. That
 * duplication is deliberate and load-bearing: the pill has to say what a send
 * will actually do. The server stays the authority — nothing here is trusted by
 * it — so the two are kept in step by the precedence test in
 * server/src/prompts/test-presets.js plus the end-to-end check in the PR.
 */

import { state } from '../state.js';
import { CONFIG } from '../config.js';
import { elements } from '../dom.js';
import { API } from '../api-client.js';
import { getActivePersona, getActiveConversation } from '../state.js';
import { escapeHtml } from '../util/format.js';
import { showToast } from '../components/toast.js';
import { displayError } from '../components/errors.js';
import { confirmDialog, promptName } from '../components/dialogs.js';
import { positionPopover, attachPopoverOutsideClose } from '../components/menus.js';
import { assemblePersonaPrompt } from '../persona-sections.js';
// AP-04 only: the composer pill's menu can jump to this view, and the persona
// editor's picker writes through the persona save path like every other field.
import { navigate } from '../shell.js';
import { savePersonas } from '../settings-store.js';
// AP-05: the inspector runs the real assembly, which needs the active model.
import { getActiveModelConfig, hasActiveModel } from '../model-layer.js';
// AP-06: the .tesserapreset exporter's second call site for the shared helper.
import { downloadBlob } from '../util/blob.js';

/**
 * Sentinel meaning "the built-in layer, explicitly" — mirrors PRESET_NONE in
 * server/src/prompts/presets.js. null means "inherit the next level down", so
 * without this a chat could never opt OUT of a preset its persona supplies.
 */
export const PRESET_NONE = 'none';

// Tab id → label, in strip order. A section opts in with data-settings-tab.
const SETTINGS_TABS = [
    { id: 'appearance', label: 'Appearance' },
    { id: 'files', label: 'Files' },
    { id: 'advanced', label: 'Advanced' },
    { id: 'account', label: 'Account' },
];

const DEFAULT_TAB = 'appearance';

// Session-local: which tab is showing. Deliberately not persisted — Settings is
// somewhere you visit to do one thing, and landing back on Advanced days later
// because you once opened it is disorienting.
let activeTab = DEFAULT_TAB;

/**
 * Build the tab strip and wire it. Called once, after the settings body has been
 * re-parented into #settingsView (main.js), because it inserts the strip above
 * the sections it controls.
 */
export function setupSettingsTabs() {
    const body = elements.settingsView && elements.settingsView.querySelector('.settings-modal-body');
    if (!body) return;

    const strip = document.createElement('div');
    strip.className = 'settings-tabs';
    strip.setAttribute('role', 'tablist');
    strip.innerHTML = SETTINGS_TABS.map(t => `
        <button type="button" class="settings-tab" role="tab" data-tab="${t.id}"
                aria-selected="false">${escapeHtml(t.label)}</button>`).join('');
    body.parentNode.insertBefore(strip, body);

    strip.addEventListener('click', (e) => {
        const btn = e.target.closest('.settings-tab');
        if (btn) showSettingsTab(btn.dataset.tab);
    });

    showSettingsTab(activeTab);
}

/**
 * Show one tab: highlight it and reveal only the sections that belong to it.
 * A section with no `data-settings-tab` falls in the first tab rather than
 * vanishing — a new section is then visible-but-misfiled, which is noticed and
 * fixed, where invisible is not.
 * @param {string} tabId
 */
export function showSettingsTab(tabId) {
    const known = SETTINGS_TABS.some(t => t.id === tabId);
    activeTab = known ? tabId : DEFAULT_TAB;

    document.querySelectorAll('#settingsView .settings-tab').forEach(btn => {
        const on = btn.dataset.tab === activeTab;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('#settingsView .settings-section').forEach(section => {
        const tab = section.dataset.settingsTab || DEFAULT_TAB;
        section.hidden = tab !== activeTab;
    });

    // Leaving Advanced with an edit still in its debounce window would let the
    // save land after the UI moved on; flush it while the editor is still here.
    if (activeTab !== 'advanced') flushPresetSave();

    // The list is fetched when its tab is first shown, not on boot: most
    // sessions never open Advanced, and presets aren't needed to send a message.
    if (activeTab === 'advanced') loadPresets();
}

// ===== Prompt presets =====

let presetsLoaded = false;
let presetsLoading = false;

/** Fetch the user's presets into state and render (once per session). */
export async function loadPresets({ force = false } = {}) {
    if (presetsLoading || (presetsLoaded && !force)) {
        renderPresetList();
        return;
    }
    presetsLoading = true;
    renderPresetList(); // shows the loading note
    try {
        const presets = await API.presets.list();
        state.presets = {};
        presets.forEach(p => { state.presets[p.id] = p; });
        presetsLoaded = true;
    } catch (err) {
        console.error('Failed to load prompt presets:', err);
        displayError(err, { action: 'load your prompt presets' });
    } finally {
        presetsLoading = false;
        renderPresetList();
        refreshPresetDependentUi();
    }
}

/** Presets newest-updated first — the order the server returns them in. */
function presetList() {
    return Object.values(state.presets).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * Repaint everything OUTSIDE the list that reads the preset set: the composer
 * pill and the persona editor's picker. Creating, deleting, or changing the
 * account default changes what those two say — the persona picker names the
 * account default in its "Inherit" row, so it goes stale otherwise.
 */
function refreshPresetDependentUi() {
    syncPresetPill();
    syncPersonaPresetControl();
}

/**
 * Render the preset list. The built-in layer is a row of its own rather than an
 * absence: "no preset" IS a choice (and the default one), so it needs to be
 * selectable and to show when it is active.
 */
export function renderPresetList() {
    const host = document.getElementById('presetList');
    if (!host) return;

    if (presetsLoading && !presetsLoaded) {
        host.innerHTML = '<p class="section-note">Loading presets…</p>';
        return;
    }

    const activeId = state.settings.defaultPresetId || null;
    const rows = [`
        <div class="preset-row${activeId === null ? ' active' : ''}" data-preset-id="">
            <div class="preset-row-main">
                <span class="preset-name">Built-in prompt</span>
                <span class="preset-note">${CONFIG.brand}'s default prompt layer</span>
            </div>
            ${activeId === null
                ? '<span class="preset-badge">Default</span>'
                : '<button type="button" class="preset-action" data-action="use">Use</button>'}
        </div>`];

    for (const p of presetList()) {
        const isDefault = p.id === activeId;
        rows.push(`
        <div class="preset-row${isDefault ? ' active' : ''}" data-preset-id="${escapeHtml(p.id)}">
            <div class="preset-row-main">
                <span class="preset-name">${escapeHtml(p.name)}</span>
                <span class="preset-note">${describeOverrides(p)}</span>
            </div>
            ${isDefault
                ? '<span class="preset-badge">Default</span>'
                : '<button type="button" class="preset-action" data-action="use">Use</button>'}
            <button type="button" class="preset-action" data-action="edit">Edit</button>
            <button type="button" class="preset-action" data-action="rename">Rename</button>
            <button type="button" class="preset-action" data-action="duplicate">Duplicate</button>
            <button type="button" class="preset-action danger-quiet" data-action="delete">Delete</button>
        </div>`);
    }

    host.innerHTML = rows.join('');
}

/** "2 blocks edited · 1 off", or "No changes from the built-in yet". */
function describeOverrides(preset) {
    const blocks = (preset.blocks && preset.blocks.blocks) || {};
    const order = (preset.blocks && preset.blocks.order) || [];
    const edited = Object.values(blocks).filter(b => typeof b.text === 'string').length;
    const disabled = Object.values(blocks).filter(b => b.enabled === false).length;
    const defaultOrder = presetDefaults?.systemBlockIds || ['orientation', 'persona', 'capabilities'];
    const reordered = blocks.profile?.layer === 'system'
        || blocks.state?.position === 'after'
        || (order.length > 0 && order.join(',') !== defaultOrder.join(','));
    const bits = [];
    if (edited) bits.push(`${edited} block${edited === 1 ? '' : 's'} edited`);
    if (disabled) bits.push(`${disabled} off`);
    if (reordered) bits.push('reordered');
    return bits.length ? escapeHtml(bits.join(' · ')) : 'No changes from the built-in yet';
}

/** Delegated handler for the preset list's buttons. */
export async function handlePresetListClick(e) {
    const btn = e.target.closest('.preset-action');
    if (!btn) return;
    const row = btn.closest('.preset-row');
    if (!row) return;
    const id = row.dataset.presetId || null;

    if (btn.dataset.action === 'use') return setDefaultPreset(id);
    if (!id) return; // the built-in row has no other actions
    if (btn.dataset.action === 'edit') return openPresetEditor(id);
    if (btn.dataset.action === 'rename') return renamePreset(id);
    if (btn.dataset.action === 'duplicate') return duplicatePreset(id);
    if (btn.dataset.action === 'delete') return deletePreset(id);
}

/**
 * Make a preset (or the built-in layer, for `null`) the account default.
 *
 * Optimistic: the row highlights immediately and rolls back if the write fails,
 * because the alternative is a click that appears to do nothing on a slow link.
 * @param {string|null} presetId
 */
export async function setDefaultPreset(presetId) {
    const previous = state.settings.defaultPresetId || null;
    if (previous === presetId) return;

    state.settings.defaultPresetId = presetId;
    renderPresetList();
    try {
        await API.settings.update({ defaultPresetId: presetId });
    } catch (err) {
        state.settings.defaultPresetId = previous;
        renderPresetList();
        displayError(err, { action: 'change your default preset' });
        return;
    }
    refreshPresetDependentUi();
    showToast(presetId
        ? `“${state.presets[presetId].name}” is now your default prompt.`
        : 'Back to the built-in prompt.');
}

/** Create an empty preset (all blocks inheriting the built-in) and select it. */
export async function createPreset() {
    const name = await promptName({
        title: 'New prompt preset',
        label: 'Preset name',
        placeholder: 'e.g. Roleplay',
        confirmLabel: 'Create',
    });
    if (!name) return;

    try {
        const preset = await API.presets.create({ name });
        state.presets[preset.id] = preset;
        renderPresetList();
        refreshPresetDependentUi(); // the first preset is what reveals the pill
        showToast(`Created “${preset.name}”. Open Edit to change its blocks.`);
    } catch (err) {
        displayError(err, { action: 'create the preset' });
    }
}

/** Copy a preset, blocks and all. The server does the copy — see the route. */
export async function duplicatePreset(presetId) {
    const original = state.presets[presetId];
    if (!original) return;
    const name = await promptName({
        title: 'Duplicate preset',
        label: 'Name for the copy',
        value: `${original.name} copy`,
        confirmLabel: 'Duplicate',
    });
    if (!name) return;

    try {
        const preset = await API.presets.create({ name, cloneFrom: presetId });
        state.presets[preset.id] = preset;
        renderPresetList();
        refreshPresetDependentUi();
        showToast(`Duplicated as “${preset.name}”.`);
    } catch (err) {
        displayError(err, { action: 'duplicate the preset' });
    }
}

export async function renamePreset(presetId) {
    const preset = state.presets[presetId];
    if (!preset) return;
    const name = await promptName({
        title: 'Rename preset',
        label: 'Preset name',
        value: preset.name,
        confirmLabel: 'Save',
    });
    if (!name || name === preset.name) return;

    try {
        const updated = await API.presets.update(presetId, { name });
        state.presets[presetId] = updated;
        renderPresetList();
        refreshPresetDependentUi(); // the name shows on the pill and the picker
    } catch (err) {
        displayError(err, { action: 'rename the preset' });
    }
}

/**
 * Delete a preset. The confirm names what else changes: the server clears every
 * pointer at it, so chats using it — and the account default, if it was this one
 * — fall back to the built-in layer. Silently reverting someone's prompt is
 * exactly the kind of thing they should be told before it happens, not after.
 */
export async function deletePreset(presetId) {
    const preset = state.presets[presetId];
    if (!preset) return;

    const wasDefault = state.settings.defaultPresetId === presetId;
    const ok = await confirmDialog({
        title: `Delete “${preset.name}”?`,
        body: wasDefault
            ? 'This is your default preset. Chats using it — and any new chat — will go back to the built-in prompt. This cannot be undone.'
            : 'Any chat using it will go back to the built-in prompt. This cannot be undone.',
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    try {
        await API.presets.delete(presetId);
    } catch (err) {
        displayError(err, { action: 'delete the preset' });
        return;
    }
    delete state.presets[presetId];
    if (wasDefault) state.settings.defaultPresetId = null;
    if (editingPresetId === presetId) closePresetEditor();
    renderPresetList();
    refreshPresetDependentUi();
    showToast(`Deleted “${preset.name}”.`);
}

// =============================================================================
// Block editor (AP-03)
// =============================================================================

/**
 * UI copy for each block. Lives here rather than coming from the server with the
 * text: the server owns what a block IS, the client owns how it is explained.
 *
 * `conditional` is the sentence that keeps Decision D3 honest on screen — these
 * blocks are sent only when something the preset does NOT control is true, and a
 * user editing the scratchpad wording deserves to know why it isn't showing up.
 */
const BLOCK_INFO = {
    orientation: {
        label: 'Orientation',
        // A getter, not a string: this object is built when the module loads,
        // which is BEFORE applyBrand() hears back from the server (BR-01), so a
        // baked-in string would freeze the fallback name.
        get description() {
            return `What ${CONFIG.brand} is (<operating_environment>) and how your persona shares the room with tools.`;
        },
    },
    persona: {
        label: 'Persona prompt',
        description: "The active persona's prompt, auto-wrapped in <main_persona> with its name. Position only — edit its text on the persona.",
        positionOnly: true,
    },
    capabilities: {
        label: 'Capabilities',
        description: 'Protected <capabilities> sub-layer wrapping whichever features are active (Workspace & Project, File Tools, Scratchpad, Avatar Expressions). Position can move; wording is server-managed for reliable tool use.',
        positionOnly: true,
        locked: true,
        lockedLabel: 'Protected',
        lockedTitle: 'Server-managed sub-layer — emitted automatically when any capability is active, and cannot be edited or turned off',
    },
    profile: {
        label: 'Your profile',
        description: 'Who you are (<user_profile>), placed at the start of the Message layer by default. Reword the framing here; content comes from your Profile page.',
        conditional: 'Sent only when you have written a profile and the persona is allowed to see it.',
    },
    context_ack: {
        label: 'Context acknowledgement',
        description: "Voice-neutral synthetic assistant reply after leading context (Your profile and/or Workspace/Project KB).",
        conditional: 'Sent only when leading context is injected.',
    },
    state: {
        label: 'Current context',
        description: 'Live <current_context> (<session_state>, active files, scratchpad) injected alongside your latest message. Omitted on bare chats.',
        positionOnly: true,
        locked: true,
        lockedLabel: 'Auto',
        lockedTitle: 'Generated from live session state and omitted on bare chats — cannot be edited or turned off',
    },
};

// Static informational cards that sit alongside preset blocks in the Message
// Layer so the editor reflects the COMPLETE assembled prompt picture (DF-03).
const INFO_CARDS = {
    workspace_kb: {
        id: 'workspace_kb',
        label: 'Workspace & Project KB',
        roleTag: 'User',
        roleClass: 'role-user',
        cacheTag: 'Cached',
        cacheClass: 'cache-cached',
        description: 'Active Workspace and Project instructions plus reference files. Injected in the leading context turn right alongside Your profile so they stay 100% inside the cached prefix.',
        note: 'Managed on each Workspace and Project page; omitted on unfiled chats.',
    },
    history: {
        id: 'history',
        label: 'Conversation history',
        roleTag: 'Multi-turn',
        roleClass: 'role-history',
        cacheTag: 'Cached',
        cacheClass: 'cache-cached',
        description: 'Prior user and assistant turns sent as native API messages (never flattened into XML) for multi-turn fidelity and incremental prompt caching.',
        note: 'Earlier assistant replies may include a one-line <tool_trail> when tools ran.',
    },
    latest_user: {
        id: 'latest_user',
        label: 'Latest user message',
        roleTag: 'User',
        roleClass: 'role-user',
        cacheTag: 'Volatile',
        cacheClass: 'cache-volatile',
        description: 'Your current message (plus any image, PDF, or file attachments for this turn). Sits below the cache boundary so earlier turns stay cached.',
        note: 'Use the Before / After toggle on Current context to choose whether <current_context> is prepended ahead of your message or appended after it.',
    },
};

// The built-in text + macro reference from GET /api/presets/defaults. Static per
// deployment, so it is fetched once and kept for the session.
let presetDefaults = null;

let editingPresetId = null;
let saveTimer = null;
// Tracks which block cards are expanded while editing the active preset so
// reordering, moving layers, or toggling Before/After never collapses open cards.
const expandedBlockIds = new Set();

/** The preset being edited, or null. */
function editingPreset() {
    return editingPresetId ? state.presets[editingPresetId] : null;
}

/** Open the editor for a preset, fetching the built-in text if we lack it. */
export async function openPresetEditor(presetId) {
    if (!state.presets[presetId]) return;
    if (editingPresetId !== presetId) expandedBlockIds.clear();
    editingPresetId = presetId;
    showEditorPanel(true);
    elements.presetEditor.innerHTML = '<p class="section-note">Loading…</p>';

    if (!presetDefaults) {
        try {
            presetDefaults = await API.presets.defaults();
        } catch (err) {
            displayError(err, { action: 'load the built-in prompt text' });
            closePresetEditor();
            return;
        }
    }
    // The user may have navigated away while that was in flight.
    if (editingPresetId !== presetId) return;
    renderPresetEditor();
}

/** Back to the list. Any pending edit is flushed rather than dropped. */
export function closePresetEditor() {
    flushPresetSave();
    editingPresetId = null;
    expandedBlockIds.clear();
    showEditorPanel(false);
    renderPresetList();
}

function showEditorPanel(showEditor) {
    if (elements.presetEditor) elements.presetEditor.hidden = !showEditor;
    if (elements.presetListPanel) elements.presetListPanel.hidden = showEditor;
}

/** The blocks object being edited (normalized server-side on every write). */
function editingBlocks() {
    const preset = editingPreset();
    return preset && preset.blocks ? preset.blocks : null;
}

/** Normalized built-in text for an editable block (LF line endings). */
function builtInText(id) {
    return String(presetDefaults?.blocks?.[id] || '').replace(/\r\n/g, '\n');
}

/** Effective text shown inside an editable textarea (override or built-in). */
function effectiveBlockText(id, block) {
    return typeof block?.text === 'string' ? block.text : builtInText(id);
}

/** Whether an editable block carries a custom override distinct from built-in. */
function isBlockOverridden(id, block) {
    return typeof block?.text === 'string' && block.text !== builtInText(id);
}

export function renderPresetEditor() {
    const preset = editingPreset();
    const blocks = editingBlocks();
    if (!elements.presetEditor || !preset || !blocks) return;

    const systemIds = presetDefaults.systemBlockIds;
    const crossLayerIds = presetDefaults.crossLayerBlockIds || [];
    const systemOrder = blocks.order.filter(
        id => systemIds.includes(id) || (crossLayerIds.includes(id) && blocks.blocks[id]?.layer === 'system')
    );
    const profileInMessage = !systemOrder.includes('profile');
    const statePosition = blocks.blocks.state?.position === 'after' ? 'after' : 'before';

    const volatileCardsHTML = statePosition === 'after'
        ? infoCardHTML(INFO_CARDS.latest_user) + blockCardHTML('state', blocks.blocks.state, { layer: 'message', draggable: false })
        : blockCardHTML('state', blocks.blocks.state, { layer: 'message', draggable: false }) + infoCardHTML(INFO_CARDS.latest_user);

    elements.presetEditor.innerHTML = `
        <div class="preset-editor-head">
            <button type="button" class="cp-crumb" id="presetEditorBack">‹ Prompt presets</button>
            <span class="preset-editor-head-actions">
                <span class="preset-save-status" id="presetSaveStatus"></span>
                <button type="button" class="preset-action" id="presetToggleAllBtn" aria-expanded="false">
                    <span class="toggle-all-expand">Expand all</span>
                    <span class="toggle-all-collapse">Collapse all</span>
                </button>
                <button type="button" class="preset-action" id="presetExportBtn">Export</button>
            </span>
        </div>
        <h4 class="preset-editor-title">${escapeHtml(preset.name)}</h4>
        <p class="section-note">Editable blocks start pre-filled with the built-in text and follow future updates until changed. Click any block to inspect or edit it; drag or use ↑ ↓ to reorder.</p>

        <section class="preset-layer" aria-labelledby="presetLayerSystemHeading">
            <div class="preset-layer-head">
                <span class="preset-layer-title" id="presetLayerSystemHeading">System Layer</span>
                <span class="preset-layer-hint">Cached prefix sent ahead of messages · drag to reorder</span>
            </div>
            <div class="preset-blocks" id="presetSystemBlocks" data-drop-layer="system">
                ${systemOrder.map((id, i) => blockCardHTML(id, blocks.blocks[id], {
                    layer: 'system',
                    index: i,
                    count: systemOrder.length,
                    draggable: true,
                    crossLayer: crossLayerIds.includes(id),
                })).join('')}
            </div>
        </section>

        <section class="preset-layer" aria-labelledby="presetLayerMessageHeading">
            <div class="preset-layer-head">
                <span class="preset-layer-title" id="presetLayerMessageHeading">Message Layer</span>
                <span class="preset-layer-hint">Leading cached context, native chat turns, and volatile per-turn tail</span>
            </div>
            <div class="preset-blocks" id="presetMessageCachedBlocks" data-drop-layer="message">
                ${profileInMessage ? blockCardHTML('profile', blocks.blocks.profile, {
                    layer: 'message',
                    draggable: true,
                    crossLayer: true,
                }) : ''}
                ${infoCardHTML(INFO_CARDS.workspace_kb)}
                ${blockCardHTML('context_ack', blocks.blocks.context_ack, { layer: 'message', draggable: false })}
                ${infoCardHTML(INFO_CARDS.history)}
            </div>

            <div class="preset-cache-divider" role="separator">
                <span>Cache boundary · volatile per-turn tail below</span>
            </div>

            <div class="preset-blocks" id="presetMessageVolatileBlocks">
                ${volatileCardsHTML}
            </div>
        </section>

        <div class="preset-editor-preview">
            <button type="button" class="preset-action" id="presetPreviewBtn">Preview this preset</button>
            <div class="prompt-inspector" id="presetInspector"></div>
        </div>

        <details class="preset-macros">
            <summary>Macros you can use</summary>
            <ul>
                ${presetDefaults.macros.map(m => `
                    <li><code>{{${escapeHtml(m.name)}}}</code> — ${escapeHtml(m.description)}</li>`).join('')}
            </ul>
            <p class="section-note">An unknown macro is left as-is rather than blanked, so a typo shows up in the prompt instead of vanishing.</p>
            <p class="section-note"><code>{{time}}</code> changes every minute, so a block using it rewrites the system prompt on every send and nothing in the conversation can be cached. <code>{{date}}</code> is stable within a day. Prefer putting either in your message over the system prompt if you care about cost.</p>
        </details>`;

    elements.presetEditor.querySelector('#presetEditorBack')
        .addEventListener('click', closePresetEditor);
    elements.presetEditor.querySelector('#presetExportBtn').addEventListener('click', () => {
        flushPresetSave(); // export what is on screen, not the last autosave
        exportPreset(editingPresetId);
    });
    elements.presetEditor.querySelector('#presetPreviewBtn').addEventListener('click', () => {
        // Flush first: previewing text still sitting in the debounce window
        // would show the PREVIOUS save and quietly mislead.
        flushPresetSave();
        renderPromptInspector(document.getElementById('presetInspector'), { presetId: editingPresetId });
    });
    wireEditorEvents();
    syncToggleAllButton();
}

/** Role + cache metadata badges for each preset block id. */
function blockMetaTags(id, layer) {
    if (layer === 'system') {
        return { role: 'System', roleClass: 'role-system', cache: 'Cached', cacheClass: 'cache-cached' };
    }
    if (id === 'context_ack') {
        return { role: 'Assistant', roleClass: 'role-assistant', cache: 'Cached', cacheClass: 'cache-cached' };
    }
    if (id === 'state') {
        return { role: 'User', roleClass: 'role-user', cache: 'Volatile', cacheClass: 'cache-volatile' };
    }
    return { role: 'User', roleClass: 'role-user', cache: 'Cached', cacheClass: 'cache-cached' };
}

/** One preset block card (accessible custom disclosure + sibling action bar). */
function blockCardHTML(id, block, { layer = 'system', index = 0, count = 1, draggable = false, crossLayer = false } = {}) {
    block = block || { enabled: true, text: null };
    const info = BLOCK_INFO[id] || { label: id, description: '' };
    const editable = !info.positionOnly;
    const overridden = editable && isBlockOverridden(id, block);
    const currentText = editable ? effectiveBlockText(id, block) : '';
    const stateLabel = block.enabled === false ? 'Off' : (overridden ? 'Edited' : 'Built-in');
    const stateClass = block.enabled === false ? 'state-off' : (overridden ? 'state-edited' : 'state-builtin');
    const tags = blockMetaTags(id, layer);
    const isOpen = expandedBlockIds.has(id);
    const bodyId = `presetBlockBody_${id}`;
    const statePosition = block.position === 'after' ? 'after' : 'before';

    const bodyContent = editable
        ? `
            <div class="preset-block-subbar">
                <span class="preset-block-sync" data-sync-note>${overridden ? 'Custom override for this preset' : 'Matches built-in text (follows updates)'}</span>
                <button type="button" class="preset-action preset-action-xs" data-action="reset"${overridden ? '' : ' disabled'}>Reset to built-in</button>
            </div>
            <textarea id="presetText_${escapeHtml(id)}" class="preset-block-text" data-block-text rows="6"
                      maxlength="${presetDefaults.limits.blockChars}"
                      aria-label="${escapeHtml(info.label)} prompt text">${escapeHtml(currentText)}</textarea>
            <p class="preset-block-warn" data-warn hidden></p>`
        : id === 'capabilities'
            ? capabilitiesSublistHTML()
            : id === 'persona'
                ? personaAnchorBodyHTML()
                : id === 'state'
                    ? statePositionBodyHTML(statePosition)
                    : '';

    return `
    <div class="preset-block${block.enabled === false ? ' is-off' : ''}${isOpen ? ' is-open' : ''}"
         data-block-id="${escapeHtml(id)}" data-layer="${escapeHtml(layer)}"${draggable ? ' draggable="true"' : ''}>
        <div class="preset-block-head">
            ${draggable ? '<span class="preset-block-grip" aria-hidden="true" title="Drag to reorder">⋮⋮</span>' : ''}
            <button type="button" class="preset-block-trigger" data-action="expand"
                    aria-expanded="${isOpen ? 'true' : 'false'}" aria-controls="${escapeHtml(bodyId)}">
                <span class="preset-block-chevron" aria-hidden="true"></span>
                <span class="preset-block-title">${escapeHtml(info.label)}</span>
                <span class="preset-pill-tag ${tags.roleClass}">${tags.role}</span>
                <span class="preset-pill-tag ${tags.cacheClass}">${tags.cache}</span>
                ${!info.locked ? `<span class="preset-pill-tag ${stateClass}" data-state>${stateLabel}</span>` : ''}
            </button>
            <div class="preset-block-actions">
                ${editable ? `<span class="preset-char-count" data-char-count>${currentText.length.toLocaleString()} ch</span>` : ''}
                ${crossLayer ? `
                    <button type="button" class="preset-action preset-action-xs" data-action="toggle-layer"
                            title="${layer === 'system' ? 'Move to Message Layer (cached prefix)' : 'Move to System Layer'}">
                        ${layer === 'system' ? '→ Message' : '↑ System'}
                    </button>` : ''}
                ${layer === 'system' ? `
                    <button type="button" class="preset-action preset-action-icon" data-action="move-up" aria-label="Move ${escapeHtml(info.label)} up"${index === 0 ? ' disabled' : ''}>↑</button>
                    <button type="button" class="preset-action preset-action-icon" data-action="move-down" aria-label="Move ${escapeHtml(info.label)} down"${index === count - 1 ? ' disabled' : ''}>↓</button>` : ''}
                ${id === 'state' ? `
                    <div class="segmented preset-pos-seg" role="group" aria-label="Current context placement">
                        <button type="button" data-action="state-pos" data-position="before" class="${statePosition === 'before' ? 'active' : ''}" aria-pressed="${statePosition === 'before'}">Before</button>
                        <button type="button" data-action="state-pos" data-position="after" class="${statePosition === 'after' ? 'active' : ''}" aria-pressed="${statePosition === 'after'}">After</button>
                    </div>` : ''}
                ${info.locked
                    ? `<span class="preset-block-locked" title="${escapeHtml(info.lockedTitle || 'Managed by the server — cannot be edited or turned off')}">${escapeHtml(info.lockedLabel || 'Protected')}</span>`
                    : `<input type="checkbox" role="switch" class="setting-switch preset-block-switch" data-action="toggle"
                              aria-label="Enable ${escapeHtml(info.label)}"${block.enabled === false ? '' : ' checked'}>`}
            </div>
        </div>
        <div class="preset-block-body" id="${escapeHtml(bodyId)}"${isOpen ? '' : ' hidden="until-found"'}>
            <p class="preset-block-desc">
                ${escapeHtml(info.description)}
                ${info.conditional ? `<em class="preset-block-cond">${escapeHtml(info.conditional)}</em>` : ''}
            </p>
            ${bodyContent}
        </div>
    </div>`;
}

/** Read-only informational data-slot card (Workspace KB, History, Latest message). */
function infoCardHTML(card) {
    const isOpen = expandedBlockIds.has(card.id);
    const bodyId = `presetInfoBody_${card.id}`;
    return `
    <div class="preset-block preset-block-info${isOpen ? ' is-open' : ''}" data-info-id="${escapeHtml(card.id)}">
        <div class="preset-block-head">
            <button type="button" class="preset-block-trigger" data-action="expand"
                    aria-expanded="${isOpen ? 'true' : 'false'}" aria-controls="${escapeHtml(bodyId)}">
                <span class="preset-block-chevron" aria-hidden="true"></span>
                <span class="preset-block-title">${escapeHtml(card.label)}</span>
                <span class="preset-pill-tag ${card.roleClass}">${card.roleTag}</span>
                <span class="preset-pill-tag ${card.cacheClass}">${card.cacheTag}</span>
            </button>
            <div class="preset-block-actions">
                <span class="preset-pill-tag state-data">Data</span>
            </div>
        </div>
        <div class="preset-block-body" id="${escapeHtml(bodyId)}"${isOpen ? '' : ' hidden="until-found"'}>
            <p class="preset-block-desc">${escapeHtml(card.description)}</p>
            <p class="preset-block-cond">${escapeHtml(card.note)}</p>
        </div>
    </div>`;
}

/** Read-only list of server-managed sub-sections inside `<capabilities>`. */
function capabilitiesSublistHTML() {
    const sections = presetDefaults?.capabilitySections || [];
    if (!sections.length) return '';
    return `
        <div class="preset-cap-list">
            ${sections.map(s => `
                <div class="preset-cap-item">
                    <div class="preset-cap-head">
                        <span class="preset-cap-title">${escapeHtml(s.title)}</span>
                        <span class="preset-cap-cond">${escapeHtml(s.condition)}</span>
                    </div>
                    <pre class="preset-cap-preview">${escapeHtml(s.text)}</pre>
                </div>`).join('')}
        </div>`;
}

/** Read-only preview note for the auto-wrapped `<main_persona>` slot. */
function personaAnchorBodyHTML() {
    const active = getActivePersona();
    const name = active?.name ? `# Persona: ${active.name}` : '# Persona: {{char}}';
    return `<pre class="preset-cap-preview">${escapeHtml(`<main_persona>\n${name}\nThis is who you are.\n\n…active persona sections & traits…\n</main_persona>`)}</pre>`;
}

/** Contextual hint inside the expanded `Current context` (`state`) card. */
function statePositionBodyHTML(position) {
    const detail = position === 'after'
        ? 'Currently appended right after your latest message.'
        : 'Currently prepended right before your latest message (recommended so your words stay last).';
    return `<p class="preset-block-cond">${escapeHtml(detail)}</p>`;
}

/** Open or close a single card and keep aria-expanded + Expand-all synced. */
function setCardExpanded(card, open) {
    const key = card.dataset.blockId || card.dataset.infoId;
    const trigger = card.querySelector('[data-action="expand"]');
    const body = card.querySelector('.preset-block-body');
    if (!trigger || !body) return;
    card.classList.toggle('is-open', open);
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
        body.removeAttribute('hidden');
        if (key) expandedBlockIds.add(key);
    } else {
        body.setAttribute('hidden', 'until-found');
        if (key) expandedBlockIds.delete(key);
    }
    syncToggleAllButton();
}

/** Mark Expand-all button expanded only when every card in the editor is open. */
function syncToggleAllButton() {
    const btn = document.getElementById('presetToggleAllBtn');
    if (!btn || !elements.presetEditor) return;
    const cards = [...elements.presetEditor.querySelectorAll('.preset-block')];
    const allOpen = cards.length > 0 && cards.every(c => c.classList.contains('is-open'));
    btn.setAttribute('aria-expanded', allOpen ? 'true' : 'false');
}

/** Wire the editor's controls. Re-run after every re-render. */
function wireEditorEvents() {
    const systemHost = document.getElementById('presetSystemBlocks');
    const messageHost = document.getElementById('presetMessageCachedBlocks');

    const toggleAllBtn = document.getElementById('presetToggleAllBtn');
    if (toggleAllBtn) {
        toggleAllBtn.addEventListener('click', () => {
            const expand = toggleAllBtn.getAttribute('aria-expanded') !== 'true';
            elements.presetEditor.querySelectorAll('.preset-block').forEach(card => {
                setCardExpanded(card, expand);
            });
        });
    }

    elements.presetEditor.querySelectorAll('.preset-block').forEach(card => {
        const id = card.dataset.blockId;

        const expandBtn = card.querySelector('[data-action="expand"]');
        if (expandBtn) {
            expandBtn.addEventListener('click', () => {
                setCardExpanded(card, !card.classList.contains('is-open'));
            });
        }

        // Native Find-in-Page reveals hidden="until-found" bodies automatically;
        // mirror that into aria-expanded, visual state, and expandedBlockIds.
        const body = card.querySelector('.preset-block-body');
        if (body) {
            body.addEventListener('beforematch', () => setCardExpanded(card, true));
        }

        // Only allow card dragging when the pointer starts on non-interactive
        // header space (such as the drag grip), never on buttons, switches, or
        // the expanded body/textarea so text selection and clicks aren't hijacked.
        if (card.draggable) {
            card.addEventListener('pointerdown', (e) => {
                if (e.target.closest('.preset-block-body, button, input, textarea, select')) {
                    card.draggable = false;
                }
            });
            const restoreDraggable = () => { card.draggable = true; };
            card.addEventListener('pointerup', restoreDraggable);
            card.addEventListener('pointercancel', restoreDraggable);
        }

        if (!id) return; // informational data card — expand/collapse only

        const textarea = card.querySelector('[data-block-text]');
        if (textarea) {
            textarea.addEventListener('input', () => {
                const blocks = editingBlocks();
                if (!blocks) return;
                const val = textarea.value;
                // Matching built-in text verbatim stores null so the block
                // continues following future built-in updates (Decision D2).
                blocks.blocks[id].text = val === builtInText(id) ? null : val;
                refreshBlockChrome(card, id);
                queuePresetSave();
            });
        }

        const toggle = card.querySelector('[data-action="toggle"]');
        if (toggle) toggle.addEventListener('change', (e) => {
            const blocks = editingBlocks();
            if (!blocks) return;
            blocks.blocks[id].enabled = e.target.checked;
            card.classList.toggle('is-off', !e.target.checked);
            refreshBlockChrome(card, id);
            queuePresetSave();
        });

        const reset = card.querySelector('[data-action="reset"]');
        if (reset) reset.addEventListener('click', () => {
            const blocks = editingBlocks();
            if (!blocks) return;
            const builtIn = builtInText(id);
            blocks.blocks[id].text = null;
            if (textarea) textarea.value = builtIn;
            refreshBlockChrome(card, id);
            queuePresetSave();
        });

        const toggleLayerBtn = card.querySelector('[data-action="toggle-layer"]');
        if (toggleLayerBtn) {
            toggleLayerBtn.addEventListener('click', () => {
                const targetLayer = card.dataset.layer === 'system' ? 'message' : 'system';
                moveBlockLayer(id, targetLayer);
            });
        }

        const up = card.querySelector('[data-action="move-up"]');
        const down = card.querySelector('[data-action="move-down"]');
        if (up) up.addEventListener('click', () => moveBlock(id, -1, 'move-up'));
        if (down) down.addEventListener('click', () => moveBlock(id, 1, 'move-down'));

        card.querySelectorAll('[data-action="state-pos"]').forEach(btn => {
            btn.addEventListener('click', () => {
                const blocks = editingBlocks();
                if (!blocks) return;
                const pos = btn.dataset.position === 'after' ? 'after' : 'before';
                if (blocks.blocks.state.position === pos) return;
                blocks.blocks.state.position = pos;
                renderPresetEditor();
                restoreEditorFocus(`.preset-block[data-block-id="state"] [data-action="state-pos"][data-position="${pos}"]`);
                queuePresetSave();
            });
        });
    });

    if (systemHost) wireBlockDragging(systemHost, messageHost);
}

/** Restore keyboard focus to a control after a full editor re-render. */
function restoreEditorFocus(selector, fallbackSelector) {
    if (!elements.presetEditor) return;
    let target = elements.presetEditor.querySelector(selector);
    if ((!target || target.disabled) && fallbackSelector) {
        target = elements.presetEditor.querySelector(fallbackSelector);
    }
    if (target && !target.disabled) target.focus();
}

/** Keep a card's state pill, char count, sync hint, and Reset button in step. */
function refreshBlockChrome(card, id) {
    const block = editingBlocks()?.blocks?.[id];
    if (!block) return;
    const info = BLOCK_INFO[id] || {};
    const editable = !info.positionOnly;
    const overridden = editable && isBlockOverridden(id, block);
    const pill = card.querySelector('[data-state]');
    if (pill) {
        pill.textContent = block.enabled === false ? 'Off' : (overridden ? 'Edited' : 'Built-in');
        pill.classList.remove('state-off', 'state-edited', 'state-builtin');
        pill.classList.add(block.enabled === false ? 'state-off' : (overridden ? 'state-edited' : 'state-builtin'));
    }
    const countEl = card.querySelector('[data-char-count]');
    if (countEl && editable) {
        countEl.textContent = `${effectiveBlockText(id, block).length.toLocaleString()} ch`;
    }
    const syncNote = card.querySelector('[data-sync-note]');
    if (syncNote) {
        syncNote.textContent = overridden
            ? 'Custom override for this preset'
            : 'Matches built-in text (follows updates)';
    }
    const reset = card.querySelector('[data-action="reset"]');
    if (reset) reset.disabled = !overridden;
}

/** Move a block within the system-layer order and re-render. */
function moveBlock(id, delta, focusAction) {
    const blocks = editingBlocks();
    if (!blocks) return;
    const order = blocks.order;
    const from = order.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    renderPresetEditor();
    if (focusAction) {
        const escaped = CSS.escape(id);
        const altAction = focusAction === 'move-up' ? 'move-down' : 'move-up';
        restoreEditorFocus(
            `.preset-block[data-block-id="${escaped}"] [data-action="${focusAction}"]`,
            `.preset-block[data-block-id="${escaped}"] [data-action="${altAction}"]`
        );
    }
    queuePresetSave();
}

/** Move a cross-layer block (`profile`) between System and Message layers. */
function moveBlockLayer(id, targetLayer, insertIndex = -1) {
    const blocks = editingBlocks();
    if (!blocks || !blocks.blocks[id]) return;
    blocks.blocks[id].layer = targetLayer;
    blocks.order = blocks.order.filter(x => x !== id);
    if (targetLayer === 'system') {
        if (insertIndex >= 0 && insertIndex <= blocks.order.length) {
            blocks.order.splice(insertIndex, 0, id);
        } else {
            blocks.order.push(id);
        }
    }
    renderPresetEditor();
    restoreEditorFocus(`.preset-block[data-block-id="${CSS.escape(id)}"] [data-action="toggle-layer"]`);
    queuePresetSave();
}

/**
 * Native HTML5 drag to reorder within System Layer and move cross-layer blocks
 * (`profile`) between System Layer and Message Layer. Keyboard/touch users have
 * ↑/↓ and → Message / ↑ System buttons covering the exact same actions.
 */
function wireBlockDragging(systemHost, messageHost) {
    let draggingId = null;
    let draggingLayer = null;
    let snapshotOrder = null;
    let snapshotLayer = null;
    let dropped = false;
    let changed = false;

    const isCrossLayer = (id) => (presetDefaults?.crossLayerBlockIds || []).includes(id);

    const onDragStart = (e) => {
        const card = e.target.closest('.preset-block[draggable="true"]');
        if (!card || !card.dataset.blockId) return;
        const blocks = editingBlocks();
        if (!blocks) return;
        draggingId = card.dataset.blockId;
        draggingLayer = card.dataset.layer;
        snapshotOrder = [...blocks.order];
        snapshotLayer = blocks.blocks[draggingId]?.layer;
        dropped = false;
        changed = false;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggingId);
    };

    const onDragEnd = () => {
        if (!draggingId) return;
        const id = draggingId;
        systemHost.classList.remove('is-drop-target');
        if (messageHost) messageHost.classList.remove('is-drop-target');
        draggingId = null;
        draggingLayer = null;

        if (!dropped) {
            // Cancelled drag (Escape or dropped outside valid zones): roll back
            // any live preview reorder so aborting never commits mutations.
            const blocks = editingBlocks();
            if (blocks && snapshotOrder) {
                blocks.order = snapshotOrder;
                if (snapshotLayer !== undefined && blocks.blocks[id]) {
                    blocks.blocks[id].layer = snapshotLayer;
                }
            }
            snapshotOrder = null;
            snapshotLayer = null;
            renderPresetEditor();
            return;
        }

        snapshotOrder = null;
        snapshotLayer = null;
        if (changed) {
            renderPresetEditor();
            queuePresetSave();
        } else {
            elements.presetEditor.querySelectorAll('.preset-block.dragging')
                .forEach(el => el.classList.remove('dragging'));
        }
    };

    systemHost.addEventListener('dragstart', onDragStart);
    systemHost.addEventListener('dragend', onDragEnd);
    if (messageHost) {
        messageHost.addEventListener('dragstart', onDragStart);
        messageHost.addEventListener('dragend', onDragEnd);
    }

    systemHost.addEventListener('dragover', (e) => {
        if (!draggingId) return;
        if (draggingLayer !== 'system' && !isCrossLayer(draggingId)) return;
        e.preventDefault();
        systemHost.classList.add('is-drop-target');
        if (messageHost) messageHost.classList.remove('is-drop-target');

        const blocks = editingBlocks();
        if (!blocks) return;
        const over = e.target.closest('#presetSystemBlocks > .preset-block[data-block-id]');

        // Cross-layer drag preview into System Layer
        if (draggingLayer !== 'system') {
            blocks.blocks[draggingId].layer = 'system';
            blocks.order = blocks.order.filter(x => x !== draggingId);
            const targetIdx = over ? blocks.order.indexOf(over.dataset.blockId) : blocks.order.length;
            blocks.order.splice(targetIdx >= 0 ? targetIdx : blocks.order.length, 0, draggingId);
            const dragged = elements.presetEditor.querySelector(`.preset-block[data-block-id="${CSS.escape(draggingId)}"]`);
            if (dragged) {
                dragged.dataset.layer = 'system';
                if (over) over.before(dragged);
                else systemHost.appendChild(dragged);
            }
            draggingLayer = 'system';
            changed = true;
            return;
        }

        if (!over || over.dataset.blockId === draggingId) return;
        const order = blocks.order;
        const from = order.indexOf(draggingId);
        const to = order.indexOf(over.dataset.blockId);
        if (from < 0 || to < 0) return;
        order.splice(to, 0, order.splice(from, 1)[0]);
        const dragged = systemHost.querySelector(`.preset-block[data-block-id="${CSS.escape(draggingId)}"]`);
        if (dragged) {
            if (from < to) over.after(dragged);
            else over.before(dragged);
        }
        changed = true;
    });

    systemHost.addEventListener('dragleave', (e) => {
        if (!systemHost.contains(e.relatedTarget)) {
            systemHost.classList.remove('is-drop-target');
        }
    });

    systemHost.addEventListener('drop', (e) => {
        e.preventDefault();
        systemHost.classList.remove('is-drop-target');
        if (draggingId && (draggingLayer === 'system' || isCrossLayer(draggingId))) {
            dropped = true;
        }
    });

    if (messageHost) {
        messageHost.addEventListener('dragover', (e) => {
            if (!draggingId || !isCrossLayer(draggingId)) return;
            e.preventDefault();
            messageHost.classList.add('is-drop-target');
            systemHost.classList.remove('is-drop-target');
        });
        messageHost.addEventListener('dragleave', (e) => {
            if (!messageHost.contains(e.relatedTarget)) {
                messageHost.classList.remove('is-drop-target');
            }
        });
        messageHost.addEventListener('drop', (e) => {
            e.preventDefault();
            messageHost.classList.remove('is-drop-target');
            if (!draggingId || !isCrossLayer(draggingId)) return;
            dropped = true;
            const blocks = editingBlocks();
            if (!blocks || blocks.blocks[draggingId]?.layer === 'message') return;
            blocks.blocks[draggingId].layer = 'message';
            blocks.order = blocks.order.filter(x => x !== draggingId);
            draggingLayer = 'message';
            changed = true;
        });
    }
}

// ===== Saving =====

function setSaveStatus(text) {
    const el = document.getElementById('presetSaveStatus');
    if (el) el.textContent = text;
}

/**
 * Debounced save, matching the rest of Settings (which auto-saves rather than
 * asking). Prompt text is typed in long runs, so the window is longer than the
 * settings tick — and every path that leaves the editor flushes it, so nothing
 * is lost to a fast exit.
 */
function queuePresetSave() {
    setSaveStatus('Saving…');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(savePreset, 800);
}

/** Write a pending edit immediately (leaving the editor, tab, or view). */
export function flushPresetSave() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    savePreset();
}

async function savePreset() {
    saveTimer = null;
    const preset = editingPreset();
    if (!preset) return;
    const id = preset.id;

    try {
        const updated = await API.presets.update(id, { blocks: preset.blocks });
        // Keep the local blocks object: replacing it wholesale would discard
        // keystrokes typed while the request was in flight.
        state.presets[id] = { ...updated, blocks: preset.blocks };
        if (editingPresetId === id) setSaveStatus('Saved');
    } catch (err) {
        if (editingPresetId === id) setSaveStatus('Not saved');
        displayError(err, { action: 'save the preset' });
    }
}

// =============================================================================
// Per-chat + per-persona selection (AP-04)
// =============================================================================

/**
 * These mirror the server's resolvePromptPreset precedence exactly:
 *
 *   chat override → persona base → account default → built-in
 *
 * with PRESET_NONE stopping the walk at any level. The UI has to agree with what
 * a send will actually do — a picker that says "Roleplay" while the server
 * resolves something else is worse than no picker at all. The server stays the
 * authority; this is a read-only mirror of the same rule.
 */

/** The persona's base preset choice: an id, PRESET_NONE, or null to inherit. */
export function personaPresetBase(persona) {
    const id = persona?.modelConfig?.presetId;
    return typeof id === 'string' && id ? id : null;
}

/** The active chat's override, including one chosen before the chat existed. */
export function getChatPresetOverride() {
    const convo = getActiveConversation();
    const value = convo ? convo.presetId : state.pendingPresetId;
    return typeof value === 'string' && value ? value : null;
}

/**
 * The preset that WILL be used for the active chat.
 * @returns {{id: string|null, source: 'chat'|'persona'|'account'|'builtin'}}
 *   `id` null means the built-in layer; `source` is which level decided.
 */
export function effectivePreset() {
    const chat = getChatPresetOverride();
    if (chat === PRESET_NONE) return { id: null, source: 'chat' };
    if (chat) return { id: chat, source: 'chat' };

    const base = personaPresetBase(getActivePersona());
    if (base === PRESET_NONE) return { id: null, source: 'persona' };
    if (base) return { id: base, source: 'persona' };

    const account = state.settings.defaultPresetId || null;
    if (account) return { id: account, source: 'account' };
    return { id: null, source: 'builtin' };
}

/** Display name for a preset id (or the built-in layer). */
export function presetLabel(id) {
    if (!id || id === PRESET_NONE) return 'Built-in prompt';
    const preset = state.presets[id];
    // A preset deleted elsewhere leaves a dangling id; the server falls back to
    // the built-in, so say that rather than showing a raw uuid.
    return preset ? preset.name : 'Built-in prompt';
}

/**
 * Reflect the effective preset on the composer pill.
 *
 * Hidden entirely when the user has no presets: until you make one there is
 * nothing to switch between, and an extra control in the composer would be pure
 * noise for the majority who never open Advanced.
 */
export function syncPresetPill() {
    const btn = elements.composerPresetButton;
    if (!btn) return;
    const any = Object.keys(state.presets).length > 0;
    btn.hidden = !any;
    if (!any) return;

    const { id, source } = effectivePreset();
    const label = presetLabel(id);
    const nameEl = btn.querySelector('.preset-pill-name');
    if (nameEl) nameEl.textContent = label;
    // The pill is filled only when THIS chat pins a preset — inherited state is
    // shown but not emphasised, the same distinction the tools toggle draws.
    btn.classList.toggle('pinned', source === 'chat');
    const from = {
        chat: 'this chat',
        persona: 'the persona',
        account: 'your account default',
        builtin: 'the default',
    };
    btn.title = `Prompt: ${label} (from ${from[source]}) — click to change for this chat`;
}

/** The quick-switch menu behind the composer pill. */
export function showPresetMenu(anchorEl) {
    const existing = document.querySelector('.context-menu, .key-popover');
    if (existing) existing.remove();

    const chat = getChatPresetOverride();
    const inherited = inheritedPreset();
    const menu = document.createElement('div');
    menu.className = 'context-menu context-menu-wide';

    const item = (value, label, note, active) => `
        <button class="context-menu-item${active ? ' active' : ''}" data-value="${escapeHtml(value)}">
            ${escapeHtml(label)}${note ? `<span class="preset-menu-note">${escapeHtml(note)}</span>` : ''}
        </button>`;

    let html = '<div class="context-menu-label">Prompt for this chat</div>';
    html += item('', `Inherit — ${presetLabel(inherited.id)}`,
        `from ${inherited.source === 'persona' ? 'the persona' : 'your account default'}`,
        chat === null);
    html += '<div class="context-menu-separator"></div>';
    html += item(PRESET_NONE, 'Built-in prompt', '', chat === PRESET_NONE);
    for (const p of presetList()) {
        html += item(p.id, p.name, '', chat === p.id);
    }
    html += '<div class="context-menu-separator"></div>';
    html += '<button class="context-menu-item" data-action="manage">Manage presets…</button>';
    menu.innerHTML = html;

    positionPopover(menu, anchorEl, 'right');
    menu.querySelectorAll('.context-menu-item').forEach(el => {
        el.addEventListener('click', () => {
            menu.remove();
            if (el.dataset.action === 'manage') {
                navigate({ type: 'settings' });
                showSettingsTab('advanced');
                return;
            }
            setChatPreset(el.dataset.value || null);
        });
    });
    attachPopoverOutsideClose(menu, anchorEl);
}

/** What this chat would fall back to with no override of its own. */
function inheritedPreset() {
    const base = personaPresetBase(getActivePersona());
    if (base === PRESET_NONE) return { id: null, source: 'persona' };
    if (base) return { id: base, source: 'persona' };
    return { id: state.settings.defaultPresetId || null, source: 'account' };
}

/**
 * Pin (or clear) the active chat's preset. Stashed as pending for a chat that
 * doesn't exist yet — createConversation applies it, exactly as the file-tools
 * override works.
 * @param {string|null} value - a preset id, PRESET_NONE, or null to inherit
 */
export async function setChatPreset(value) {
    const convo = getActiveConversation();
    if (!convo) {
        state.pendingPresetId = value;
        syncPresetPill();
        return;
    }
    const previous = convo.presetId ?? null;
    convo.presetId = value;
    syncPresetPill();
    try {
        await API.conversations.update(convo.id, { presetId: value });
    } catch (err) {
        convo.presetId = previous;
        syncPresetPill();
        displayError(err, { action: 'change this chat’s prompt preset' });
    }
}

// ===== Persona default =====

/** Fill the persona editor's preset select and reflect the persona's choice. */
export function syncPersonaPresetControl() {
    const select = elements.personaPresetSelect;
    if (!select) return;
    const current = personaPresetBase(getActivePersona());
    const accountLabel = presetLabel(state.settings.defaultPresetId || null);

    select.innerHTML = [
        `<option value="">Inherit — ${escapeHtml(accountLabel)} (account default)</option>`,
        `<option value="${PRESET_NONE}">Built-in prompt</option>`,
        ...presetList().map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`),
    ].join('');
    select.value = current || '';
    // A preset deleted elsewhere leaves an id with no <option>; the select would
    // show blank, so fall back to the inherit row it now behaves as.
    if (select.value !== (current || '')) select.value = '';
}

/** Persona editor: set this persona's base preset (absent = inherit). */
export function setPersonaPresetBase(value) {
    const persona = getActivePersona();
    if (!persona) return;
    persona.modelConfig = { ...persona.modelConfig };
    if (value) persona.modelConfig.presetId = value;
    else delete persona.modelConfig.presetId;
    persona.updatedAt = Date.now();
    savePersonas();
    syncPresetPill();
}

// =============================================================================
// Prompt inspector (AP-05)
// =============================================================================

/**
 * Why a block was left out, in the user's terms. The server sends stable codes;
 * the sentences live here with the rest of the UI copy.
 *
 * This is the half of the inspector that earns its keep: "my scratchpad wording
 * isn't showing up" is answered by a line that says the pad is off for this
 * chat, not by staring at the assembled prompt looking for something absent.
 */
const EXCLUSION_REASONS = {
    disabled: 'turned off in this preset',
    'no-capabilities': 'no workspace, tools, scratchpad, or inline expressions are active',
    'no-persona-prompt': 'the persona has no prompt text',
    'no-profile': 'you have not written a profile yet',
    'profile-off': 'this persona is set not to see your profile',
    'bare-chat': 'omitted on bare chats (no workspace, tools, scratchpad, or chat files)',
    'no-session-state': 'no session state was resolved for this request',
    'no-context': 'this chat has no leading profile or workspace context',
    empty: 'the text is empty',
};

const SOURCE_LABELS = {
    'built-in': 'Built-in',
    preset: 'Preset',
    persona: 'Persona',
    generated: 'Generated',
};

/**
 * Render the assembled-prompt inspector into `host`.
 *
 * Runs the REAL assembly through /api/chat/preview — the same endpoint and the
 * same code path a send uses — rather than composing anything client-side. The
 * point of the inspector is to show what will actually happen, so re-deriving
 * it here would defeat it.
 *
 * @param {HTMLElement} host
 * @param {Object} [options]
 * @param {string} [options.presetId] - preview THIS preset (the editor's
 *   "Preview" button) instead of whatever the active chat resolves to
 */
export async function renderPromptInspector(host, { presetId } = {}) {
    if (!host) return;
    host.innerHTML = '<p class="section-note">Assembling…</p>';

    // The inspector is reachable without ever opening the preset editor, which
    // is the only other thing that loads this — and it needs `messageBlockIds`
    // below to tell the two prompt layers apart.
    if (!presetDefaults) {
        try {
            presetDefaults = await API.presets.defaults();
        } catch (err) {
            host.innerHTML = '<p class="section-note">Could not assemble the prompt.</p>';
            displayError(err, { action: 'load the built-in prompt text' });
            return;
        }
    }

    const cfg = getActiveModelConfig();
    if (!hasActiveModel(cfg)) {
        host.innerHTML = '<p class="setting-desc" style="padding-top:12px;">Set a model in <strong>Models</strong> to preview the assembled prompt.</p>';
        return;
    }
    let result;
    try {
        result = await API.chat.preview({
            provider: cfg.provider,
            model: cfg.model,
            // One representative user turn: the assembly prepends per-turn blocks
            // to the LAST user message, so an empty thread would under-report.
            messages: [{ role: 'user', content: '…' }],
            // Assembled, exactly as the send path builds it (PS-01).
            systemPrompt: getActivePersona() ? assemblePersonaPrompt(getActivePersona()) : '',
            personaName: getActivePersona()?.name || '',
            expressionNames: Object.keys(getActivePersona()?.expressions || {}),
            conversationId: state.activeConversationId || undefined,
            ...(presetId ? { presetId } : {}),
        });
    } catch (err) {
        host.innerHTML = '<p class="section-note">Could not assemble the prompt.</p>';
        displayError(err, { action: 'preview the prompt' });
        return;
    }

    const blocks = Array.isArray(result.promptBlocks) ? result.promptBlocks : [];
    const messageIds = presetDefaults.messageBlockIds;
    const included = blocks.filter(b => b.included);
    const excluded = blocks.filter(b => !b.included);
    // Split by layer. Use each block's reported `layer` (supporting cross-layer
    // blocks like `profile` that a preset can move to System), falling back to
    // messageIds for older payloads.
    const isMessageBlock = (b) => b.layer === 'message' || (!b.layer && messageIds.includes(b.id));
    const systemBlocks = included.filter(b => !isMessageBlock(b));
    const messageBlocks = included.filter(isMessageBlock);
    const total = systemBlocks.reduce((n, b) => n + b.chars, 0);

    const blockHTML = (b) => `
            <details class="inspector-block">
                <summary>
                    <span class="inspector-block-name">${escapeHtml(blockLabel(b.id))}</span>
                    <span class="inspector-source source-${escapeHtml(b.source)}">${escapeHtml(SOURCE_LABELS[b.source] || b.source)}</span>
                    <span class="inspector-chars">${b.chars.toLocaleString()}</span>
                </summary>
                <pre class="inspector-text">${escapeHtml(b.text || '')}</pre>
            </details>`;

    host.innerHTML = `
        <p class="section-note">${describeInspectorContext(presetId)}</p>
        <div class="inspector-summary">
            <span><strong>${systemBlocks.length}</strong> block${systemBlocks.length === 1 ? '' : 's'}</span>
            <span><strong>${total.toLocaleString()}</strong> characters</span>
            <span>${result.presetApplied ? 'Preset applied' : 'Built-in prompt'}</span>
        </div>
        ${systemBlocks.map(blockHTML).join('')}
        ${messageBlocks.length === 0 ? '' : `
            <p class="preset-group-label">Sent with your message, not in the system prompt</p>
            ${messageBlocks.map(blockHTML).join('')}`}
        ${excluded.length === 0 ? '' : `
            <p class="preset-group-label">Not sent this time</p>
            <ul class="inspector-excluded">
                ${excluded.map(b => `
                    <li><strong>${escapeHtml(blockLabel(b.id))}</strong> — ${escapeHtml(EXCLUSION_REASONS[b.reason] || b.reason)}</li>`).join('')}
            </ul>`}`;
}

/** Human label for a block id, reusing the editor's copy. */
function blockLabel(id) {
    return (BLOCK_INFO[id] || {}).label || id;
}

/** One line naming what this preview was assembled against. */
function describeInspectorContext(presetId) {
    const convo = getActiveConversation();
    const persona = getActivePersona();
    const where = convo
        ? `the open chat “${convo.title || 'Untitled'}”`
        : 'no open chat (so no persona or per-chat override applies)';
    const preset = presetId
        ? `Previewing “${presetLabel(presetId)}”`
        : `Previewing the prompt for ${where}`;
    return convo && persona
        ? `${preset}, persona “${persona.name}”. This is the real assembly, not an approximation.`
        : `${preset}. This is the real assembly, not an approximation.`;
}

// =============================================================================
// Export / import (AP-06)
// =============================================================================

// Mirrors the persona bundle's envelope (js/views/personas.js) so the two files
// are recognisably the same family. `kind` is what tells them apart — importing
// a persona bundle here should fail with a sentence, not a stack trace.
const PRESET_FORMAT = 'tessera.bundle';
const PRESET_VERSION = 1;

/**
 * Download a preset as a `.tesserapreset` file.
 *
 * Only the name and blocks travel. Not the id (the importer mints its own), not
 * whether it was your default (that is the importer's choice, not the
 * exporter's), and no user content beyond the prompt text you wrote.
 * @param {string} presetId
 */
export function exportPreset(presetId) {
    const preset = state.presets[presetId];
    if (!preset) return;

    const bundle = {
        format: PRESET_FORMAT,
        version: PRESET_VERSION,
        kind: 'preset',
        exportedAt: Date.now(),
        preset: {
            name: preset.name || 'Untitled',
            blocks: preset.blocks,
        },
    };

    const json = JSON.stringify(bundle, null, 2);
    const filename = `${(preset.name || 'preset').replace(/[^\w-]+/g, '_')}.tesserapreset`;
    downloadBlob(new Blob([json], { type: 'application/json' }), filename);
    showToast(`Exported ${filename}`, { type: 'success' });
}

/** Open a file picker and import the chosen `.tesserapreset`. */
export function promptPresetImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.tesserapreset,.json,application/json';
    input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (file) importPresetFromFile(file);
    });
    input.click();
}

/**
 * Read a `.tesserapreset` and create a preset from it.
 *
 * Parsed here only to fail fast with a readable message — the file is untrusted,
 * so the SERVER does the real validation (same validateBlocks the editor writes
 * through). Anything malformed inside `blocks` is either rejected there or
 * normalised away, so a hand-edited file can't smuggle in a block that the
 * composer would then have to cope with.
 * @param {File} file
 */
export async function importPresetFromFile(file) {
    let bundle;
    try {
        bundle = JSON.parse(await file.text());
    } catch {
        showToast(`That file isn't a readable ${CONFIG.brand} preset.`, { type: 'warning' });
        return;
    }
    if (!bundle || bundle.kind !== 'preset' || !bundle.preset) {
        showToast(
            bundle && bundle.kind === 'persona'
                ? 'That is a persona bundle — import it from the Personas section.'
                : `That file isn't a ${CONFIG.brand} preset.`,
            { type: 'warning' }
        );
        return;
    }

    try {
        const preset = await API.presets.create({
            name: uniquePresetName(bundle.preset.name || 'Imported preset'),
            blocks: bundle.preset.blocks,
        });
        state.presets[preset.id] = preset;
        renderPresetList();
        refreshPresetDependentUi();
        showToast(`Imported “${preset.name}”.`, { type: 'success' });
    } catch (err) {
        console.error('Failed to import preset:', err);
        displayError(err, { action: 'import this preset' });
    }
}

/**
 * A name that doesn't collide with an existing preset. Importing the same file
 * twice is a normal thing to do (a tweak, a shared file re-downloaded), and two
 * rows with identical names would be indistinguishable in every picker.
 */
function uniquePresetName(name) {
    const taken = new Set(Object.values(state.presets).map(p => p.name));
    if (!taken.has(name)) return name;
    for (let n = 2; n < 100; n++) {
        const candidate = `${name} (${n})`;
        if (!taken.has(candidate)) return candidate;
    }
    return `${name} (${Date.now()})`;
}
