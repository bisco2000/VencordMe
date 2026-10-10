/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { SnowflakeUtils } from "@webpack/common";

import { getOverrides, getRevision, hasAnyOverrides } from "./overrides";
import { shouldFake } from "./policy";

const logger = new Logger("pnygo/EditProfile");

/**
 * Circuit breaker: the moment something goes wrong repeatedly, faking is turned
 * off completely for this session. Discord keeps running normally and the
 * problem is logged, instead of taking the whole client down.
 */
const MAX_ERRORS = 50;
let errorCount = 0;
let disabled = false;

/** true once the circuit breaker tripped (faking is off for this session) */
export function isDisabled(): boolean {
    return disabled;
}

function noteError(where: string, e: unknown): void {
    errorCount++;
    if (errorCount === MAX_ERRORS) {
        disabled = true;
        logger.error(`EditProfile disabled after ${MAX_ERRORS} errors (last failure in ${where}):`, e);
    } else if (errorCount < MAX_ERRORS) {
        logger.warn(`${where} failed, using the real value:`, e);
    }
}

/** Discord epoch and the snowflake <-> timestamp shift, exactly like Discord uses them */
const DISCORD_EPOCH = 1420070400000;
const TIMESTAMP_SHIFT = 4194304; // 2 ** 22

interface CachedView<T extends object> {
    /** overrides revision this view was built for */
    rev: number;
    /** source object it was built from */
    src: object;
    /** what Discord gets */
    out: T;
}

const profileViews = new Map<string, CachedView<object>>();
const userViews = new Map<string, CachedView<object>>();

/** ids currently being built — breaks the getCurrentUser() -> userView() cycle */
const building = new Set<string>();

/** keep the caches bounded (they only ever hold users that have overrides) */
function remember<T extends object>(map: Map<string, CachedView<T>>, userId: string, entry: CachedView<T>): T {
    if (map.size > 200 && !map.has(userId)) map.clear();
    map.set(userId, entry);
    return entry.out;
}

/** read the user id of an unknown record/user object, never throws */
function idOf(record: unknown): string | null {
    if (!record || typeof record !== "object") return null;
    const rec = record as { id?: unknown; userId?: unknown; user?: { id?: unknown } };
    if (typeof rec.id === "string") return rec.id;
    if (typeof rec.userId === "string") return rec.userId;
    if (typeof rec.user?.id === "string") return rec.user.id;
    return null;
}

/**
 * Copy `source` and shadow the given properties, without touching the original.
 * Returns the source untouched when no property could be shadowed.
 */
export function cloneWith<T extends object>(source: T, overrides: Record<string, unknown>): T {
    const clone = Object.create(Object.getPrototypeOf(source), Object.getOwnPropertyDescriptors(source));
    let changed = false;
    for (const key of Object.keys(overrides)) {
        const value = overrides[key];
        if (value === undefined) continue;
        const existing = Object.getOwnPropertyDescriptor(clone, key);
        // a non configurable, non writable own property cannot be shadowed; skip it
        if (existing && !existing.configurable && !existing.writable) continue;
        Object.defineProperty(clone, key, {
            value,
            writable: true,
            // new properties stay invisible to key iteration, exactly like the
            // prototype getters they shadow (createdAt on User, for example)
            enumerable: existing ? existing.enumerable : false,
            configurable: true,
        });
        changed = true;
    }
    return changed ? clone : source;
}

/**
 * The fake account creation timestamp (ms since epoch) for a user, or null when
 * there is nothing to fake. The date is taken at local noon so the day Discord
 * prints is exactly the day that was picked, in every timezone.
 */
export function fakeCreatedAtMs(userId: string | null | undefined): number | null {
    if (!userId || disabled) return null;
    const ov = getOverrides(userId);
    if (ov.memberSince === "") return null; // fast path: nothing stored
    if (!shouldFake(userId)) return null;

    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ov.memberSince);
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
    const ms = date.getTime();
    return Number.isNaN(ms) ? null : ms;
}

/** the profile-record patch: bio (+ handle / display name on builds that read them there) */
function profilePatch(userId: string): Record<string, unknown> {
    const ov = getOverrides(userId);
    const patch: Record<string, unknown> = {};
    if (ov.bio !== "") patch.bio = ov.bio;
    if (ov.username !== "") patch.username = ov.username;
    if (ov.displayName !== "") patch.globalName = ov.displayName;
    const createdAt = fakeCreatedAtMs(userId);
    if (createdAt != null) patch.createdAt = new Date(createdAt);
    return patch;
}

/** the User-object patch: username, display name and created-at */
function userPatch(userId: string): Record<string, unknown> {
    const ov = getOverrides(userId);
    const patch: Record<string, unknown> = {};
    if (ov.username !== "") patch.username = ov.username;
    if (ov.displayName !== "") patch.globalName = ov.displayName;
    const createdAt = fakeCreatedAtMs(userId);
    if (createdAt != null) patch.createdAt = new Date(createdAt);
    return patch;
}

/**
 * Called from the patched `UserProfileStore.getUserProfile()`. Returns the real
 * profile object unless something should be faked for that user.
 */
export function profileView(profile: unknown): unknown {
    try {
        if (!profile || typeof profile !== "object") return profile;
        if (disabled || !hasAnyOverrides()) return profile; // fast path: nothing faked at all
        const userId = idOf(profile);
        if (!shouldFake(userId)) return profile;

        const patch = profilePatch(userId);
        if (Object.keys(patch).length === 0) return profile;

        const rev = getRevision();
        const hit = profileViews.get(userId);
        if (hit && hit.rev === rev && hit.src === profile) return hit.out;

        const out = cloneWith(profile as object, patch);
        if (out === profile) return profile;
        return remember(profileViews, userId, { rev, src: profile as object, out });
    } catch (e) {
        noteError("profileView", e);
        return profile;
    }
}

/**
 * Called from the patched `UserStore.getUser()` / `getCurrentUser()`.
 * Returns the real User unless something should be faked for that user.
 */
export function userView(user: unknown): unknown {
    try {
        if (!user || typeof user !== "object") return user;
        if (disabled || !hasAnyOverrides()) return user; // fast path: nothing faked at all
        const userId = idOf(user);
        if (!shouldFake(userId)) return user;
        if (building.has(userId)) return user; // recursive lookup while building -> keep the real object

        const patch = userPatch(userId);
        if (Object.keys(patch).length === 0) return user;

        const rev = getRevision();
        const hit = userViews.get(userId);
        if (hit && hit.rev === rev && hit.src === user) return hit.out;

        building.add(userId);
        let out: object;
        try {
            out = cloneWith(user as object, patch);
        } finally {
            building.delete(userId);
        }
        if (out === user) return user;
        return remember(userViews, userId, { rev, src: user as object, out });
    } catch (e) {
        noteError("userView", e);
        return user;
    }
}

/**
 * Called from the patched `get createdAt()` of Discord's User class, so code
 * that already holds a real User instance (message authors, caches, ...) sees
 * the fake date too.
 */
export function createdAtTimestamp(user: unknown, snowflakeUtils?: { extractTimestamp?: (id: string) => number }): number {
    const userId = idOf(user);
    const fake = fakeCreatedAtMs(userId);
    if (fake != null) return fake;

    const utils = snowflakeUtils ?? SnowflakeUtils;
    try {
        const extract = (utils as { extractTimestamp?: (id: string) => number } | undefined)?.extractTimestamp;
        if (typeof extract === "function") return extract.call(utils, userId as string);
    } catch (e) {
        noteError("createdAtTimestamp", e);
    }
    return Math.floor(Number(userId) / TIMESTAMP_SHIFT) + DISCORD_EPOCH;
}

/**
 * Called from the patched snowflake -> timestamp helper of Discord's own
 * snowflake utils. Anything that derives the account date from the user id
 * (badge tooltips, "member since" rows, account age, ...) goes through here.
 */
export function snowflakeMs(id: unknown): number {
    const fake = fakeCreatedAtMs(typeof id === "string" ? id : null);
    if (fake != null) return fake;
    return Math.floor(Number(id) / TIMESTAMP_SHIFT) + DISCORD_EPOCH;
}

/** drop every cached view and reset the circuit breaker (used on start/stop) */
export function clearViews(): void {
    profileViews.clear();
    userViews.clear();
    building.clear();
    errorCount = 0;
    disabled = false;
}
