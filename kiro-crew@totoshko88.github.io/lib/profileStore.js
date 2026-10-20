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
    if (settings.get_value('profiles').n_children() > 0)
        return;
    const {profiles, activeId} = profilesFromLegacy(settings.get_string('endpoint'),
        settings.get_strv('endpoints'), settings.get_string('token'));
    writeProfiles(settings, profiles);
    settings.set_string('active-profile', activeId);
}

export function setProfileToken(settings, id, token) {
    const profiles = readProfiles(settings);
    const p = profiles.find(x => x.id === id);
    if (p && p.token !== token) {
        p.token = token;
        writeProfiles(settings, profiles);
    }
}
