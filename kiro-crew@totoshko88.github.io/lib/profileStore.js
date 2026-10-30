/* profileStore.js — gateway profiles in GSettings, shared by the shell and prefs. */

import GLib from 'gi://GLib';

import {
    normalizeProfile, serializeProfile, profilesFromLegacy, findActive, defaultLocalProfile
} from './profiles.js';

export function readProfiles(settings) {
    return settings.get_value('profiles').deepUnpack().map(normalizeProfile);
}

export function writeProfiles(settings, profiles) {
    settings.set_value('profiles', new GLib.Variant('aa{ss}', profiles.map(serializeProfile)));
}

export function readActiveProfile(settings) {
    return findActive(readProfiles(settings), settings.get_string('active-profile')) ??
        defaultLocalProfile();
}

/**
 * First start after 0.1.2: turn endpoint/endpoints/token into profiles. Both
 * processes may run this; the result is deterministic, so they agree.
 */
export function migrateLegacyProfiles(settings) {
    if (settings.get_value('profiles').n_children() > 0) {
        clearLegacyKeys(settings);
        return;
    }
    const {profiles, activeId} = profilesFromLegacy(settings.get_string('endpoint'),
        settings.get_strv('endpoints'), settings.get_string('token'));
    writeProfiles(settings, profiles);
    settings.set_string('active-profile', activeId);
    // Profiles own the connection now; drop the 0.1.2 keys so a stale endpoint
    // or a leftover token can't linger in GSettings or mislead a diagnosis.
    clearLegacyKeys(settings);
}

/**
 * Reset the one-shot 0.1.2 migration keys to their schema defaults. Safe to
 * run on every start: migration keys off `profiles` being non-empty, which it
 * is by the time this is reached, so reverting a migrated endpoint never
 * triggers a re-migration. Only resets a key whose stored value still differs
 * from its schema default (an actual 0.1.2 leftover), so it writes nothing on
 * the common already-clean path — important because `endpoint`/`endpoints`
 * default to a non-empty `localhost:5476`, not to an empty value.
 */
function clearLegacyKeys(settings) {
    for (const key of ['endpoint', 'endpoints', 'token']) {
        const current = settings.get_value(key);
        const fallback = settings.get_default_value(key);
        if (fallback !== null && !current.equal(fallback))
            settings.reset(key);
    }
}

export function setProfileToken(settings, id, token) {
    const profiles = readProfiles(settings);
    const p = profiles.find(x => x.id === id);
    if (p && p.token !== token) {
        p.token = token;
        writeProfiles(settings, profiles);
    }
}
