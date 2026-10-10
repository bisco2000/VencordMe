/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { React } from "@webpack/common";

const logger = new Logger("EditProfile");

/** Bump this when the shape of ProfileOverrides changes; migrate() upgrades old data. */
export const SCHEMA_VERSION = 2;

/** DataStore key prefix: `editprofile:overrides:<userId>` */
const KEY_PREFIX = "editprofile:overrides:";

/** A single custom (user-made) badge: image URL + tooltip. */
export interface CustomBadge {
    imageUrl: string;
    tooltip: string;
}

/**
 * A badge in the override list. `officialId` refers to an entry in
 * BADGE_CATALOG (badges.ts), `custom` carries a user provided image.
 * The array order IS the display order (reorderable in the badge picker).
 */
export interface OverrideBadge {
    /** stable unique id: `editprofile-official-<badgeId>` or `editprofile-custom-<n>` */
    uid: string;
    kind: "official" | "custom";
    /** for kind === "official": the catalog badge id (e.g. "staff") */
    officialId?: string;
    /** for kind === "custom": image + tooltip */
    custom?: CustomBadge;
}

export interface ProfileOverrides {
    schemaVersion: number;
    /** fake display (global) name, "" = show the real one */
    displayName: string;
    /** fake username/handle (display only), "" = show the real one */
    username: string;
    /** fake "About me" text, "" = show the real one */
    bio: string;
    /** local avatar override URL (preview), "" = real */
    avatarUrl: string;
    /** local banner override URL (preview), "" = real */
    bannerUrl: string;
    /** fake account creation date as "YYYY-MM-DD", "" = show the real one */
    memberSince: string;
    /** ordered badge list injected on top of the real ones */
    badges: OverrideBadge[];
    /** hide the real badges and show only the injected list */
    hideRealBadges: boolean;
}

export function emptyOverrides(): ProfileOverrides {
    return {
        schemaVersion: SCHEMA_VERSION,
        displayName: "",
        username: "",
        bio: "",
        avatarUrl: "",
        bannerUrl: "",
        memberSince: "",
        badges: [],
        hideRealBadges: false,
    };
}

/** upgrade old/partial records to the current schema (future migrations go here) */
function migrate(raw: unknown): ProfileOverrides {
    const base = emptyOverrides();
    if (!raw || typeof raw !== "object") return base;
    const rec = raw as Record<string, unknown>;
    const merged = {
        ...base,
        ...rec,
        badges: Array.isArray(rec.badges) ? rec.badges as OverrideBadge[] : [],
        schemaVersion: SCHEMA_VERSION,
    } as ProfileOverrides;
    // normalise every field to its expected type, never trust stored data
    for (const key of ["displayName", "username", "bio", "avatarUrl", "bannerUrl", "memberSince"] as const) {
        if (typeof merged[key] !== "string") merged[key] = "";
    }
    if (typeof merged.hideRealBadges !== "boolean") merged.hideRealBadges = false;
    return merged;
}

// ---------------------------------------------------------------------------
// in-memory cache + subscription machinery
// ---------------------------------------------------------------------------

const cache = new Map<string, ProfileOverrides>();
const listeners = new Set<() => void>();
const EMPTY = emptyOverrides();
let loaded = false;

/**
 * Bumped on EVERY change. The cached "views" (views.ts) and the badge cache
 * compare against it, so a saved value is picked up immediately while the
 * object identity stays stable between changes (no render loops).
 */
let revision = 0;

function keyFor(userId: string) {
    return KEY_PREFIX + userId;
}

function emit() {
    revision++;
    for (const l of listeners) {
        try { l(); } catch (e) { logger.warn("listener error", e); }
    }
}

/** current revision — see the comment on `revision` above. */
export function getRevision(): number {
    return revision;
}

/**
 * Cheap global fast path: when nothing was ever faked, every patched getter can
 * hand Discord the original object immediately without any further work.
 */
export function hasAnyOverrides(): boolean {
    return cache.size > 0;
}

/** Subscribe to every override change (save / reset / load). Returns a stop function. */
export function subscribeOverrides(callback: () => void): () => void {
    listeners.add(callback);
    return () => {
        listeners.delete(callback);
    };
}

/** Load every stored override into memory. Called once from plugin start(). */
export async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
        const entries = await DataStore.entries<string, unknown>();
        for (const [key, value] of entries) {
            if (typeof key === "string" && key.startsWith(KEY_PREFIX)) {
                const userId = key.slice(KEY_PREFIX.length);
                if (userId) cache.set(userId, migrate(value));
            }
        }
        emit();
    } catch (e) {
        logger.warn("failed to load overrides from DataStore:", e);
    }
}

/** Synchronous snapshot for render code — always safe, never throws. */
export function getOverrides(userId: string | null | undefined): ProfileOverrides {
    if (!userId) return EMPTY;
    return cache.get(userId) ?? EMPTY;
}

/** True when at least one visual override is active for this user. */
export function hasVisualOverrides(userId: string | null | undefined): boolean {
    const ov = getOverrides(userId);
    return (
        ov.displayName !== "" ||
        ov.username !== "" ||
        ov.bio !== "" ||
        ov.avatarUrl !== "" ||
        ov.bannerUrl !== "" ||
        ov.memberSince !== "" ||
        ov.badges.length > 0 ||
        ov.hideRealBadges
    );
}

/** Merge a patch into the stored overrides for a user and persist it. */
export async function setOverrides(userId: string, patch: Partial<ProfileOverrides>): Promise<void> {
    if (!userId) return;
    const next = migrate({ ...getOverrides(userId), ...patch });
    cache.set(userId, next);
    emit(); // reactive: UI updates immediately
    try {
        await DataStore.set(keyFor(userId), next);
    } catch (e) {
        logger.warn("failed to persist overrides:", e);
    }
}

/** Reset a single field back to the real value. */
export async function resetField<K extends keyof ProfileOverrides>(userId: string, field: K): Promise<void> {
    const patch: Partial<ProfileOverrides> = {};
    (patch as Record<string, unknown>)[field] = emptyOverrides()[field];
    await setOverrides(userId, patch);
}

/** Reset everything for a user: profile looks 100% real again, no reload needed. */
export async function resetAll(userId: string): Promise<void> {
    if (!userId) return;
    cache.delete(userId);
    emit();
    try {
        await DataStore.del(keyFor(userId));
    } catch (e) {
        logger.warn("failed to delete overrides:", e);
    }
}

/** Remove every stored override (all users). Used by the settings button. */
export async function resetEverything(): Promise<void> {
    cache.clear();
    emit();
    try {
        const entries = await DataStore.entries<string, unknown>();
        for (const [key] of entries) {
            if (typeof key === "string" && key.startsWith(KEY_PREFIX)) {
                await DataStore.del(key);
            }
        }
    } catch (e) {
        logger.warn("failed to wipe overrides:", e);
    }
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * Subscribe a component to the overrides of one user.
 * Returns a stable object reference that only changes when the data changes,
 * so it is safe as a render dependency.
 */
export function useOverrides(userId: string | null | undefined): ProfileOverrides {
    const [snapshot, setSnapshot] = React.useState(() => getOverrides(userId));

    React.useEffect(() => {
        const update = () => setSnapshot(getOverrides(userId));
        update();
        listeners.add(update);
        return () => { listeners.delete(update); };
    }, [userId]);

    return snapshot;
}

