import { chat_metadata, eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext, saveMetadataDebounced } from '../../../extensions.js';
import { uuidv4 } from '../../../utils.js';

const extensionName = 'ConnectionRandomizer';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const metadataKey = extensionName;

const defaultSettings = Object.freeze({
    enabled: false,
    selectedPresetId: null,
    presets: [],
    cardPresetBindings: {},
});

let isSwitchingProfile = false;

function getSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = structuredClone(defaultSettings);
    }

    const settings = extension_settings[extensionName];
    settings.enabled = Boolean(settings.enabled);
    settings.presets = Array.isArray(settings.presets) ? settings.presets : [];
    settings.cardPresetBindings = settings.cardPresetBindings && typeof settings.cardPresetBindings === 'object'
        ? settings.cardPresetBindings
        : {};

    if (settings.presets.some(migratePreset)) {
        saveSettingsDebounced();
    }

    if (!settings.selectedPresetId && settings.presets.length) {
        settings.selectedPresetId = settings.presets[0].id;
    }

    return settings;
}

function getConnectionProfiles() {
    return extension_settings.connectionManager?.profiles || [];
}

function getProfileById(profileId) {
    return getConnectionProfiles().find(profile => profile.id === profileId);
}

function getPresetById(presetId) {
    return getSettings().presets.find(preset => preset.id === presetId);
}

function getActivePreset() {
    return getPresetById(getEffectivePresetId());
}

function createPreset(name = 'New Preset') {
    return {
        id: uuidv4(),
        name,
        randomMin: 5,
        randomMax: 5,
        profiles: [],
    };
}

function migratePreset(preset) {
    if (!Array.isArray(preset.sets)) {
        preset.profiles = Array.isArray(preset.profiles) ? preset.profiles : [];
        return false;
    }

    const state = chat_metadata[metadataKey];
    const legacyIndex = state?.activePresetId === preset.id && Number.isInteger(state.currentSetIndex)
        ? state.currentSetIndex
        : 0;
    const legacyGroup = preset.sets[legacyIndex] || preset.sets[0];

    preset.randomMin = legacyGroup?.randomMin ?? 5;
    preset.randomMax = legacyGroup?.randomMax ?? preset.randomMin;
    preset.profiles = structuredClone(legacyGroup?.profiles || []);
    delete preset.sets;
    return true;
}

function ensureInitialPreset() {
    const settings = getSettings();

    if (!settings.presets.length) {
        const preset = createPreset('Default');
        settings.presets.push(preset);
        settings.selectedPresetId = preset.id;
        saveSettingsDebounced();
    }
}

function getCurrentCardKey() {
    const context = getContext();

    if (context.groupId) {
        return null;
    }

    const character = context.characters?.[context.characterId];
    return character?.avatar || null;
}

function getCurrentCardName() {
    const context = getContext();

    if (context.groupId) {
        return 'Group chat';
    }

    const character = context.characters?.[context.characterId];
    return character?.name || 'No card selected';
}

function getEffectivePresetId() {
    const settings = getSettings();
    const cardKey = getCurrentCardKey();

    if (cardKey && settings.cardPresetBindings[cardKey]) {
        return settings.cardPresetBindings[cardKey];
    }

    return settings.selectedPresetId;
}

function setEffectivePresetId(presetId) {
    const settings = getSettings();
    const cardKey = getCurrentCardKey();

    if (cardKey && settings.cardPresetBindings[cardKey]) {
        settings.cardPresetBindings[cardKey] = presetId;
    } else {
        settings.selectedPresetId = presetId;
    }
}

function calculateTargetMessageCount(preset) {
    if (!preset) {
        return 1;
    }

    const { low, high } = getMessageBounds(preset);

    return low + Math.floor(Math.random() * (high - low + 1));
}

function getChatState() {
    if (!chat_metadata[metadataKey] || typeof chat_metadata[metadataKey] !== 'object') {
        chat_metadata[metadataKey] = {};
    }

    return chat_metadata[metadataKey];
}

function initializeChatStateForPreset(presetId) {
    const preset = getPresetById(presetId);
    const state = getChatState();

    state.activePresetId = presetId || null;
    state.assistantMessagesSinceSwitch = 0;
    state.currentTargetMessageCount = calculateTargetMessageCount(preset);
    state.lastProfileId = null;
    delete state.currentSetIndex;
    delete state.assistantMessagesInCurrentSet;

    return state;
}

function syncChatStateToEffectivePreset({ save = false } = {}) {
    const effectivePresetId = getEffectivePresetId();
    const state = getChatState();
    const preset = getPresetById(effectivePresetId);

    if (!preset) {
        state.activePresetId = null;
        state.assistantMessagesSinceSwitch = 0;
        state.currentTargetMessageCount = 1;
        return state;
    }

    if (state.assistantMessagesSinceSwitch === undefined && state.assistantMessagesInCurrentSet !== undefined) {
        state.assistantMessagesSinceSwitch = Number(state.assistantMessagesInCurrentSet) || 0;
        delete state.currentSetIndex;
        delete state.assistantMessagesInCurrentSet;
        if (save) {
            saveMetadataDebounced();
        }
    }

    if (state.activePresetId !== effectivePresetId) {
        initializeChatStateForPreset(effectivePresetId);
        if (save) {
            saveMetadataDebounced();
        }
    } else if (!state.currentTargetMessageCount) {
        state.currentTargetMessageCount = calculateTargetMessageCount(preset);
        if (save) {
            saveMetadataDebounced();
        }
    }

    return state;
}

function saveAll() {
    saveSettingsDebounced();
    saveMetadataDebounced();
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function getMessageBounds(preset) {
    const legacyFixedCount = Math.max(1, Number.parseInt(preset?.fixedMessageCount, 10) || 5);

    if (preset?.triggerMode && preset.triggerMode !== 'random') {
        return { low: legacyFixedCount, high: legacyFixedCount };
    }

    const min = Math.max(1, Number.parseInt(preset?.randomMin, 10) || legacyFixedCount);
    const max = Math.max(1, Number.parseInt(preset?.randomMax, 10) || min);

    return {
        low: Math.min(min, max),
        high: Math.max(min, max),
    };
}

function renderPresetOptions() {
    const settings = getSettings();
    const cardKey = getCurrentCardKey();
    const cardBinding = cardKey ? settings.cardPresetBindings[cardKey] : null;
    const options = settings.presets.map(preset => `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}</option>`).join('');

    $('#cr_preset_select').html(options).val(settings.selectedPresetId || '');
    $('#cr_card_preset_select')
        .html(`<option value="">Use default preset</option>${options}`)
        .prop('disabled', !cardKey)
        .val(cardBinding || '');
}

function renderProfilePool() {
    const preset = getActivePreset();
    const state = syncChatStateToEffectivePreset();

    if (!preset) {
        $('#cr_profile_pool').html('<div class="cr-editor-empty">No preset selected.</div>');
        return;
    }

    const { low, high } = getMessageBounds(preset);
    const target = state.currentTargetMessageCount || calculateTargetMessageCount(preset);
    const profileCount = (preset.profiles || []).length;

    $('#cr_profile_pool').html(`
        <div class="cr-editor-grid">
            <div class="cr-row cr-random-counts">
                <label class="cr-field cr-grow">
                    <span>Minimum Replies</span>
                    <input class="cr-random-min" type="number" min="1" step="1" value="${escapeHtml(low)}">
                </label>
                <label class="cr-field cr-grow">
                    <span>Maximum Replies</span>
                    <input class="cr-random-max" type="number" min="1" step="1" value="${escapeHtml(high)}">
                </label>
            </div>
        </div>
        <div class="cr-card-context cr-switch-context">
            <span>Current target</span>
            <strong>${escapeHtml(target)} replies. Weighted randomization with ${escapeHtml(profileCount)} profile${profileCount === 1 ? '' : 's'}</strong>
        </div>
        <div class="cr-profile-section">
            <div class="cr-profile-title">
                <strong>Profile Pool</strong>
                <div class="cr-row cr-wrap">
                    <button class="menu_button cr-profile-add cr-icon-label"><i class="fa-solid fa-plus"></i><span>Profile</span></button>
                    <button class="menu_button cr-profile-normalize cr-icon-label"><i class="fa-solid fa-scale-balanced"></i><span>Normalize</span></button>
                </div>
            </div>
            <div class="cr-profile-list">${renderProfileRowsHtml(preset)}</div>
        </div>
    `);
}

function renderProfileRowsHtml(preset) {
    const profiles = getConnectionProfiles();
    const options = profiles.map(profile => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`).join('');

    return (preset.profiles || []).map((entry, index) => {
        const profile = getProfileById(entry.profileId);
        const missingOption = profile ? '' : `<option value="${escapeHtml(entry.profileId)}">Missing profile (${escapeHtml(entry.profileId)})</option>`;
        const missingClass = profile ? '' : ' missing';

        return `
            <div class="cr-profile-row${missingClass}" data-index="${index}">
                <select class="cr-profile-select">${missingOption}${options}</select>
                <input class="cr-profile-weight-range" type="range" min="0" max="100" step="1" value="${escapeHtml(Number(entry.weight) || 0)}">
                <input class="cr-profile-weight" type="number" min="0" step="1" value="${escapeHtml(Number(entry.weight) || 0)}">
                <button class="menu_button cr-profile-remove cr-icon-button" title="Remove profile" aria-label="Remove profile"><i class="fa-solid fa-xmark"></i></button>
            </div>
        `;
    }).join('') || '<div class="cr-editor-empty">No profiles selected.</div>';
}

function renderAll() {
    ensureInitialPreset();
    syncChatStateToEffectivePreset({ save: true });
    renderPresetOptions();
    $('#cr_enabled').prop('checked', getSettings().enabled);
    $('#cr_current_card').text(getCurrentCardName());
    renderProfilePool();

    $('#cr_profile_pool .cr-profile-row').each(function () {
        const preset = getActivePreset();
        const index = Number($(this).data('index'));
        if (preset?.profiles?.[index]) {
            $(this).find('.cr-profile-select').val(preset.profiles[index].profileId);
        }
    });
}

function getValidProfileEntries(preset, currentProfileId = null) {
    const entries = (preset?.profiles || [])
        .filter(entry => Number(entry.weight) > 0)
        .filter(entry => getProfileById(entry.profileId));

    if (!currentProfileId) {
        return entries;
    }

    return entries.filter(entry => entry.profileId !== currentProfileId);
}

function pickWeightedProfile(preset) {
    const currentProfileId = String($('#connection_profiles').val() || '');
    const entries = getValidProfileEntries(preset, currentProfileId);
    const total = entries.reduce((sum, entry) => sum + Number(entry.weight), 0);

    if (!entries.length || total <= 0) {
        return null;
    }

    let roll = Math.random() * total;

    for (const entry of entries) {
        roll -= Number(entry.weight);

        if (roll <= 0) {
            return getProfileById(entry.profileId);
        }
    }

    return getProfileById(entries[entries.length - 1].profileId);
}

async function switchToProfile(profile) {
    if (!profile || isSwitchingProfile) {
        return false;
    }

    const select = document.getElementById('connection_profiles');

    if (!select) {
        console.warn('[ConnectionRandomizer] Connection Manager select was not found.');
        return false;
    }

    const optionIndex = Array.from(select.options).findIndex(option => option.value === profile.id);

    if (optionIndex < 0) {
        console.warn(`[ConnectionRandomizer] Connection profile option was not found: ${profile.name}`);
        return false;
    }

    isSwitchingProfile = true;

    try {
        const loaded = new Promise(resolve => {
            const timeout = setTimeout(() => resolve(false), 10000);
            eventSource.once(event_types.CONNECTION_PROFILE_LOADED, () => {
                clearTimeout(timeout);
                resolve(true);
            });
        });

        select.selectedIndex = optionIndex;
        select.dispatchEvent(new Event('change'));
        await loaded;

        const state = getChatState();
        state.lastProfileId = profile.id;
        saveMetadataDebounced();
        return true;
    } finally {
        isSwitchingProfile = false;
    }
}

async function handleMessageSent() {
    const settings = getSettings();

    if (!settings.enabled) {
        return;
    }

    const state = syncChatStateToEffectivePreset({ save: true });

    if ((state.assistantMessagesSinceSwitch ?? 0) < (state.currentTargetMessageCount || 1)) {
        return;
    }

    const preset = getActivePreset();
    const profile = pickWeightedProfile(preset);

    if (!profile) {
        return;
    }

    if (!await switchToProfile(profile)) {
        return;
    }

    state.assistantMessagesSinceSwitch = 0;
    state.currentTargetMessageCount = calculateTargetMessageCount(preset);
    console.debug(`[ConnectionRandomizer] Next weighted switch target: ${state.currentTargetMessageCount}`);
    saveMetadataDebounced();
    renderAll();
}

function handleMessageReceived(_messageId, type) {
    const settings = getSettings();

    if (!settings.enabled || type !== 'normal') {
        return;
    }

    const state = syncChatStateToEffectivePreset({ save: true });
    state.assistantMessagesSinceSwitch = (Number(state.assistantMessagesSinceSwitch) || 0) + 1;
    console.debug(`[ConnectionRandomizer] Message count: ${state.assistantMessagesSinceSwitch}/${state.currentTargetMessageCount}`);
    saveMetadataDebounced();
    renderAll();
}

function bindEvents() {
    $(document).on('change', '#cr_enabled', function () {
        getSettings().enabled = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
        renderAll();
    });

    $(document).on('change', '#cr_preset_select', function () {
        const settings = getSettings();
        settings.selectedPresetId = String($(this).val() || '');
        syncChatStateToEffectivePreset({ save: true });
        saveSettingsDebounced();
        renderAll();
    });

    $(document).on('click', '#cr_preset_rename', function () {
        const preset = getActivePreset();

        if (!preset) {
            return;
        }

        const name = window.prompt('Rename preset', preset.name);

        if (name === null) {
            return;
        }

        preset.name = String(name).trim() || 'Unnamed Preset';
        saveSettingsDebounced();
        renderAll();
    });

    $(document).on('click', '#cr_preset_new', function () {
        const settings = getSettings();
        const preset = createPreset(`Preset ${settings.presets.length + 1}`);
        settings.presets.push(preset);
        setEffectivePresetId(preset.id);
        initializeChatStateForPreset(preset.id);
        saveAll();
        renderAll();
    });

    $(document).on('click', '#cr_preset_duplicate', function () {
        const settings = getSettings();
        const source = getActivePreset();

        if (!source) {
            return;
        }

        const copy = structuredClone(source);
        copy.id = uuidv4();
        copy.name = `${source.name} Copy`;
        copy.profiles = structuredClone(copy.profiles || []);
        settings.presets.push(copy);
        setEffectivePresetId(copy.id);
        initializeChatStateForPreset(copy.id);
        saveAll();
        renderAll();
    });

    $(document).on('click', '#cr_preset_delete', function () {
        const settings = getSettings();

        if (settings.presets.length <= 1) {
            return;
        }

        const deletedId = getEffectivePresetId();
        settings.presets = settings.presets.filter(preset => preset.id !== deletedId);

        for (const [cardKey, presetId] of Object.entries(settings.cardPresetBindings)) {
            if (presetId === deletedId) {
                delete settings.cardPresetBindings[cardKey];
            }
        }

        if (settings.selectedPresetId === deletedId) {
            settings.selectedPresetId = settings.presets[0]?.id || null;
        }

        syncChatStateToEffectivePreset({ save: true });
        saveSettingsDebounced();
        renderAll();
    });

    $(document).on('change', '#cr_card_preset_select', function () {
        const settings = getSettings();
        const cardKey = getCurrentCardKey();

        if (!cardKey) {
            return;
        }

        const presetId = String($(this).val() || '');

        if (presetId) {
            settings.cardPresetBindings[cardKey] = presetId;
        } else {
            delete settings.cardPresetBindings[cardKey];
        }

        syncChatStateToEffectivePreset({ save: true });
        saveSettingsDebounced();
        renderAll();
    });

    $(document).on('input change', '.cr-random-min, .cr-random-max', function () {
        const preset = getActivePreset();

        if (!preset) {
            return;
        }

        const card = $(this).closest('#cr_profile_pool');
        delete preset.triggerMode;
        delete preset.fixedMessageCount;
        preset.randomMin = Math.max(1, Number.parseInt(String(card.find('.cr-random-min').val()), 10) || 1);
        preset.randomMax = Math.max(1, Number.parseInt(String(card.find('.cr-random-max').val()), 10) || preset.randomMin);

        const state = getChatState();
        state.currentTargetMessageCount = calculateTargetMessageCount(preset);
        saveMetadataDebounced();

        saveSettingsDebounced();
        renderAll();
    });

    $(document).on('click', '.cr-profile-add', function () {
        const preset = getActivePreset();
        const profile = getConnectionProfiles()[0];

        if (!preset || !profile) {
            return;
        }

        preset.profiles = preset.profiles || [];
        preset.profiles.push({ profileId: profile.id, weight: 100 });
        saveSettingsDebounced();
        renderAll();
    });

    $(document).on('click', '.cr-profile-normalize', function () {
        const preset = getActivePreset();

        if (!preset?.profiles?.length) {
            return;
        }

        const total = preset.profiles.reduce((sum, entry) => sum + Math.max(0, Number(entry.weight) || 0), 0);

        if (total <= 0) {
            return;
        }

        preset.profiles.forEach(entry => {
            entry.weight = Math.round((Math.max(0, Number(entry.weight) || 0) / total) * 100);
        });
        saveSettingsDebounced();
        renderAll();
    });

    $(document).on('change', '.cr-profile-select', function () {
        const preset = getActivePreset();
        const index = Number($(this).closest('.cr-profile-row').data('index'));

        if (!preset?.profiles?.[index]) {
            return;
        }

        preset.profiles[index].profileId = String($(this).val() || '');
        saveSettingsDebounced();
        renderAll();
    });

    $(document).on('input change', '.cr-profile-weight-range, .cr-profile-weight', function () {
        const preset = getActivePreset();
        const row = $(this).closest('.cr-profile-row');
        const index = Number(row.data('index'));
        const value = Math.max(0, Number.parseInt(String($(this).val()), 10) || 0);

        if (!preset?.profiles?.[index]) {
            return;
        }

        preset.profiles[index].weight = value;
        row.find('.cr-profile-weight-range').val(value);
        row.find('.cr-profile-weight').val(value);
        saveSettingsDebounced();
    });

    $(document).on('click', '.cr-profile-remove', function () {
        const preset = getActivePreset();
        const index = Number($(this).closest('.cr-profile-row').data('index'));

        if (!preset?.profiles?.[index]) {
            return;
        }

        preset.profiles.splice(index, 1);
        saveSettingsDebounced();
        renderAll();
    });

    eventSource.on(event_types.MESSAGE_SENT, handleMessageSent);
    eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED, () => renderAll());
    eventSource.on(event_types.CHAT_LOADED, () => renderAll());
    eventSource.on(event_types.CONNECTION_PROFILE_CREATED, () => renderAll());
    eventSource.on(event_types.CONNECTION_PROFILE_DELETED, () => renderAll());
    eventSource.on(event_types.CONNECTION_PROFILE_UPDATED, () => renderAll());
    eventSource.on(event_types.CONNECTION_PROFILE_LOADED, () => renderAll());
}

jQuery(async () => {
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $('#extensions_settings').append(settingsHtml);

    ensureInitialPreset();
    bindEvents();
    renderAll();
});
