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

/**
 * Drop profiles left over from the SSH-tunnel era (0.1.5 and earlier): any
 * entry whose stored `kind` was 'remote' or whose `host` is a non-loopback
 * address. Remote machines are connected in the dashboard's Remote Crew now,
 * not in the extension. Returns the number removed so the caller can tell the
 * user once; writes nothing when there is nothing to prune. A local profile is
 * always kept — if pruning would empty the list, the default local profile is
 * written and made active.
 */
export function pruneRemoteProfiles(settings) {
    const raw = settings.get_value('profiles').deepUnpack();
    const isRemote = p => {
        const host = String(p.host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
        const nonLoopback = host && host !== 'localhost' && host !== '::1' &&
            !/^127(\.\d{1,3}){3}$/.test(host);
        return String(p.kind ?? '').trim() === 'remote' || nonLoopback;
    };
    const kept = raw.filter(p => !isRemote(p));
    const removed = raw.length - kept.length;
    if (removed === 0)
        return 0;
    const profiles = (kept.length ? kept : [defaultLocalProfile()]).map(normalizeProfile);
    writeProfiles(settings, profiles);
    if (!profiles.some(p => p.id === settings.get_string('active-profile')))
        settings.set_string('active-profile', profiles[0].id);
    return removed;
}

export function setProfileToken(settings, id, token) {
    const profiles = readProfiles(settings);
    const p = profiles.find(x => x.id === id);
    if (p && p.token !== token) {
        p.token = token;
        writeProfiles(settings, profiles);
    }
}
