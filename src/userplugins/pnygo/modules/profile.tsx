/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * pnygo - shared profile core (used by Girlfriend + Check ID)
 *
 * fetchUserProfile(id):
 *   Discord REST  GET /users/:id/profile?with_mutual_guilds=true
 *      (name, @username, avatar, avatar decoration = "the effect", bio, banner,
 *       badges, accent colour, mutual_guilds, primary_guild)
 *   -> falls back to GET /users/:id, then to the local UserStore cache when
 *      neither request answers. lookupState.note says which one happened, so
 *      the caller can show a sentence instead of an error.
 *
 *   An account you share nothing with is refused by Discord (403/404) — that
 *   is a rule, not a bug, and no retry moves it. When the settings hold a bot
 *   token, the bot is asked instead: BOTS are exempt from the rule, so this
 *   is the one way to read ANY id (see the "bot-token escape hatch" below).
 *
 * restGet(path): a REST helper that never throws — it answers with
 *   {status, body} or null, which is what keeps the panels error free.
 *
 * ProfileCard: the one card both features render. It shows EVERYTHING we
 * managed to read about the account, and every value can be clicked to copy.
 */

import "./profile.css";

import { get, set } from "@api/DataStore";
import { Settings } from "@api/Settings";
import { copyWithToast } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import { Constants, GuildMemberStore, GuildStore, React, RestAPI, UserProfileStore, UserStore, UserUtils } from "@webpack/common";

import { Icons } from "./ui";

const logger = new Logger("pnygo/Profile");

// the main process is the only place a bot token may be used from: Discord
// refuses `Authorization: Bot …` with the renderer's browser User-Agent
const Native = VencordNative.pluginHelpers.pnygo as PluginNative<typeof import("../native")>;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------

export interface UserProfile {
    id: string;
    displayName: string;
    username: string;
    avatar: string;
    /** avatar decoration png — Discord's "profile effect" */
    decoration: string;
    banner: string | null;
    accent: string | null;
    bio: string;
    badges: string[];
    /** account creation date (ms), 0 when unknown */
    createdAt: number;
    nitro: string;
    bot: boolean;
    verified: boolean;
    /** true when Discord's own REST answered, false for the local cache */
    fromDiscord: boolean;
    /** ids of the guilds both of you are in (Discord's mutual_guilds) */
    mutualGuildIds: string[];
    /** the ONE server whose tag they wear — not necessarily shared with you */
    primaryGuildId: string;
    primaryGuildTag: string;
}

const BADGE_NAMES: Record<string, string> = {
    staff: "Discord Staff",
    partner: "Partnered Server Owner",
    hypesquad: "HypeSquad Events",
    hypesquad_bravery: "HypeSquad Bravery",
    hypesquad_brilliance: "HypeSquad Brilliance",
    hypesquad_balance: "HypeSquad Balance",
    bug_hunter: "Bug Hunter",
    bug_hunter_level_2: "Bug Hunter Level 2",
    early_supporter: "Early Supporter",
    active_developer: "Active Developer",
    verified_developer: "Verified Bot Developer",
    certified_mod: "Certified Moderator",
    premium: "Discord Nitro",
    nitro: "Discord Nitro",
    nitro_early_supporter: "Nitro Early Supporter",
    boost: "Server Boost",
    boost_1: "Boost Level 1",
    boost_2: "Boost Level 2",
    boost_3: "Boost Level 3",
    bot: "Bot",
    verified: "Verified",
    qr_daily: "Quest Rewarded",
    hammy: "Hammy",
    volcano: "Volcano",
};

function labelForBadge(raw: unknown): string {
    const key = String(raw ?? "").toLowerCase();
    if (BADGE_NAMES[key]) return BADGE_NAMES[key];
    if (BADGE_NAMES[key.replace(/-/g, "_")]) return BADGE_NAMES[key.replace(/-/g, "_")];
    return String(raw ?? "")
        .replace(/_/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase());
}

export function isValidId(id: unknown): boolean {
    return /^\d{15,25}$/.test(String(id ?? "").trim());
}

export function defaultAvatar(id: string): string {
    try {
        const idx = Number((BigInt(id || "1") >> 22n) % 6n);
        return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
    } catch {
        return "https://cdn.discordapp.com/embed/avatars/0.png";
    }
}

export function snowflakeDate(id: string): number {
    try { return Number(BigInt(id) >> 22n) + 1420070400000; } catch { return 0; }
}

function customAvatarOf(user: any, id: string): string {
    const hash = user?.avatar;
    if (!hash) return "";
    const ext = String(hash).startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${id}/${hash}.${ext}?size=256`;
}

function decorationOf(user: any, profile: any): string {
    const raw = user?.avatarDecoration ?? user?.avatar_decoration
        // the plain user object (bot read) names it `avatar_decoration_data`
        ?? user?.avatar_decoration_data
        ?? profile?.avatarDecoration ?? profile?.avatar_decoration ?? null;
    const asset = typeof raw === "string" ? raw : raw?.asset;
    if (!asset) return "";
    return `https://cdn.discordapp.com/avatar-decoration-sprigs/${asset}.png?size=320`;
}

function bannerOf(user: any, profile: any, id: string): string | null {
    const hash = user?.banner ?? profile?.banner;
    if (!hash) return null;
    return `https://cdn.discordapp.com/banners/${id}/${hash}.png?size=512`;
}

function colorOf(value: unknown): string | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return `#${(value >>> 0).toString(16).padStart(6, "0")}`;
}

/**
 * The badges Discord exposes as a plain number on the user object
 * (`public_flags`). The bot read never carries the `badges` array — that is
 * profile-endpoint only — so this is how a bot-fetched card still shows the
 * little tags. Values are the documented User Flags table.
 */
const PUBLIC_FLAG_BADGES: Array<[number, string]> = [
    [1 << 0, "Discord Staff"],
    [1 << 1, "Partnered Server Owner"],
    [1 << 2, "HypeSquad Events"],
    [1 << 3, "Bug Hunter"],
    [1 << 6, "HypeSquad Bravery"],
    [1 << 7, "HypeSquad Brilliance"],
    [1 << 8, "HypeSquad Balance"],
    [1 << 9, "Early Supporter"],
    [1 << 14, "Bug Hunter Level 2"],
    [1 << 17, "Verified Bot Developer"],
    [1 << 18, "Certified Moderator"],
    [1 << 22, "Active Developer"],
];

function badgesFromFlags(user: any): string[] {
    const raw = Number(user?.public_flags ?? 0);
    if (!Number.isFinite(raw) || raw <= 0) return [];
    const out: string[] = [];
    for (const [bit, label] of PUBLIC_FLAG_BADGES) {
        if ((raw & bit) === bit) out.push(label);
    }
    return out;
}

function collectBadges(user: any, profile: any, body: any): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    // REST hands back strings on old endpoints and {description, icon} objects
    // on /users/:id/profile — both end up as one readable label.
    const push = (v: unknown) => {
        let raw = "";
        if (typeof v === "string") raw = v;
        else if (v && typeof v === "object") {
            const o = v as any;
            raw = String(o?.description ?? o?.id ?? o?.name ?? "");
        }
        if (!raw) return;
        const text = labelForBadge(raw);
        const key = text.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(text);
    };
    if (Array.isArray(body?.badges)) body.badges.forEach(push);
    if (Array.isArray(profile?.badges)) profile.badges.forEach(push);
    if (Array.isArray(user?.badges)) user.badges.forEach(push);
    if (Array.isArray(user?.profile_badges)) user.profile_badges.forEach(push);
    // the plain user object (the bot read) carries no badges array at all —
    // there the public flags are the only badges that exist
    if (out.length === 0) badgesFromFlags(user).forEach(push);
    return out;
}

/** ids from `mutual_guilds`, whether Discord sends objects or plain id strings */
function collectMutualGuilds(body: any): string[] {
    const raw = body?.mutual_guilds;
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const g of raw) {
        const id = typeof g === "string" ? g : String((g as any)?.id ?? "");
        if (/^\d{15,25}$/.test(id) && !out.includes(id)) out.push(id);
    }
    return out;
}

function nitroOf(user: any, profile: any): string {
    const t = Number(user?.premium_type ?? profile?.premium_type ?? 0);
    if (t >= 2) return "Nitro";
    if (t === 1) return "Nitro Classic";
    if (user?.premium_since || profile?.premium_since) return "Nitro";
    return "";
}

/** their server tag — ONE guild they are in that we do NOT have to share */
function primaryGuildOf(user: any, profile: any): { id: string; tag: string } {
    const source = user?.primary_guild ?? user?.clan ?? profile?.primary_guild ?? null;
    const id = String(source?.identity_guild_id ?? "");
    return {
        id: /^\d{15,25}$/.test(id) ? id : "",
        tag: String(source?.tag ?? ""),
    };
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

/**
 * A REST call that NEVER throws. Returns the status + parsed body, or null
 * when Discord could not be reached at all.
 *
 * It goes through Discord's own RestAPI (the same manager the client uses),
 * so the session token, the API version, rate-limit buckets and 429 retries
 * are handled for us — a bare fetch + getToken() used to 401 on some builds.
 */
export async function restGet(path: string, query?: Record<string, any>): Promise<{ status: number; body: any } | null> {
    if (!RestAPI || typeof RestAPI.get !== "function") return null;
    try {
        const res: any = await RestAPI.get({ url: path, ...(query ? { query } : {}) });
        const status = Number(res?.status ?? 200);
        const body = res?.body ?? res ?? null;
        return { status, body };
    } catch (e: any) {
        const status = Number(e?.status ?? 0);
        if (!status) return null;
        return { status, body: e?.body ?? null };
    }
}

/** why the last lookup came back empty — shown instead of a scary error */
export const lookupState = { note: "" };

function lookupNote(status: number): string {
    switch (status) {
        case 404:
            return "No Discord account has that user ID — the number is wrong or the account was deleted.";
        case 400:
            return "Discord did not accept that user ID — check the number and try again.";
        case 401:
            return "Discord did not accept your session — restart Discord and try again.";
        case 403:
            return "Discord hides this account from you: you share no server with it and it is not your friend. Paste a bot token into the pnygo settings (Check ID — bot token) and press Check again to read it anyway.";
        case 429:
            return "Discord is rate-limiting lookups right now — wait a few seconds and press Check again.";
        case 0:
            return "No answer from Discord — check your connection and try again.";
        default:
            return `Discord answered with an error (HTTP ${status}) — try again in a moment.`;
    }
}

// ---------------------------------------------------------------------------
// saved cards
//
// Discord answers 403 for a while when you ask about an account you share
// nothing with, and the very same request is accepted seconds later. Since
// the answer does not change, every card we ever got is kept in IndexedDB:
// a card younger than the TTL is served without touching the network, and an
// older one is served whenever Discord refuses. A lookup can therefore only
// show an error the very first time — never on a second press, never after a
// restart.
// ---------------------------------------------------------------------------

const PROFILE_CACHE_KEY = "vc-pnygo:profilecache";
const CACHE_TTL = 10 * 60_000;
const CACHE_MAX = 40;

const profileCache = new Map<string, { at: number; p: UserProfile }>();
let profileCacheLoaded = false;

async function loadProfileCache(): Promise<void> {
    if (profileCacheLoaded) return;
    profileCacheLoaded = true;
    try {
        const raw = await get(PROFILE_CACHE_KEY);
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
            for (const [key, value] of Object.entries(raw as Record<string, any>)) {
                const p = value?.p;
                if (p && p.id === key) profileCache.set(key, { at: Number(value.at) || 0, p });
            }
        }
    } catch { /* nothing saved yet */ }
}

async function rememberProfile(id: string, p: UserProfile): Promise<void> {
    await loadProfileCache();
    profileCache.set(id, { at: Date.now(), p });
    while (profileCache.size > CACHE_MAX) {
        let oldestKey = "";
        let oldestAt = Infinity;
        for (const [key, value] of profileCache) {
            if (value.at < oldestAt) {
                oldestAt = value.at;
                oldestKey = key;
            }
        }
        profileCache.delete(oldestKey);
    }
    try {
        const blob: Record<string, any> = {};
        for (const [key, value] of profileCache) blob[key] = value;
        await set(PROFILE_CACHE_KEY, blob);
    } catch { /* a full store is never worth an error */ }
}

// ---------------------------------------------------------------------------
// shared-server discovery
//
// Discord answers 403 (Unauthorized 40001) for /users/:id and 404 for
// /users/:id/profile when the two accounts share no server and are not
// friends. As soon as ONE shared server is known the full profile request is
// allowed again (guild_id), which is why a lookup that failed everywhere
// finally asks every server we are in whether that account is a member.
// ---------------------------------------------------------------------------

/** a guild where the client already knows this member — free, local only */
function localMutualGuild(userId: string): string {
    try {
        for (const gid of Object.keys(GuildStore.getGuilds?.() ?? {})) {
            if (GuildMemberStore.getMember?.(gid, userId)) return gid;
        }
    } catch { /* stores not ready */ }
    return "";
}

/** how many servers one refused lookup may ask before it gives up */
const MAX_PROBE_GUILDS = 60;

/** asks our servers one by one until one of them has that member */
async function findSharedGuild(userId: string): Promise<string> {
    let guildIds: string[] = [];
    try {
        guildIds = Object.keys(GuildStore.getGuilds?.() ?? {}).slice(0, MAX_PROBE_GUILDS);
    } catch {
        return "";
    }
    if (guildIds.length === 0) return "";

    let index = 0;
    let denied = 0;
    let rate = 0;
    let stopped = false;

    const worker = async (): Promise<string> => {
        while (index < guildIds.length && !stopped) {
            const gid = guildIds[index++];
            const res = await restGet(`/guilds/${gid}/members/${userId}`);
            if (res?.status === 200) {
                stopped = true;
                return gid;
            }
            // 404 simply means "not in this one" — keep asking the others
            if (res?.status === 401 || res?.status === 403) {
                if (++denied >= 6) stopped = true;
            } else if (res?.status === 429) {
                if (++rate >= 3) stopped = true;
            } else if (!res && ++denied >= 6) {
                stopped = true;
            }
        }
        return "";
    };

    const hits = await Promise.all(
        Array.from({ length: Math.min(6, guildIds.length) }, () => worker()),
    );
    const shared = hits.find(Boolean) ?? "";
    logger.info(
        `checkid: shared-server probe for ${userId} -> ${shared || "none"}`
        + ` (asked ${index}/${guildIds.length}, denied=${denied}, rate=${rate})`,
    );
    return shared;
}

/** a lookup that just refused is not worth repeating for half a minute */
const backoffUntil = new Map<string, { at: number; status: number }>();
const BACKOFF_MS = 30_000;

// ---------------------------------------------------------------------------
// the bot-token escape hatch
//
// A user token is refused for every account you share nothing with (403/404,
// discord-api-docs#6876) and no amount of retrying changes that. Bots are
// allowed to read any account by id — but only `GET /users/:id`: the profile
// endpoint answers "Bots cannot use this endpoint" (20001), and the request
// itself must NOT look like it comes from a browser (40333), which is why it
// travels through the main process (see native.ts → botApiGet).
//
// The token itself is read from the settings on every call (it can be pasted
// or cleared at any moment), it is never logged and it is only ever sent to
// discord.com, as the header of the request it authorizes.
// ---------------------------------------------------------------------------

const BOT_API = "https://discord.com/api/v10";
/** "who am I" answers, remembered so one token is only tested once */
const tokenCheck = new Map<string, { ok: boolean; note: string }>();

function readBotToken(): string {
    try {
        const value = (Settings as any)?.plugins?.pnygo?.checkIdBotToken;
        return typeof value === "string" ? value.trim() : "";
    } catch {
        return "";
    }
}

async function botGet(path: string, query?: Record<string, any>): Promise<{ status: number; body: any } | null> {
    const token = readBotToken();
    if (!token) return null;
    try {
        const url = new URL(BOT_API + path);
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
        }
        return await Native.botApiGet(url.toString(), token);
    } catch {
        return null;
    }
}

/** 200 = the token is a real bot, 401 = it is not (a user token never is) */
async function botTokenWorks(): Promise<{ ok: boolean; note: string }> {
    const token = readBotToken();
    if (!token) return { ok: false, note: "" };

    const cached = tokenCheck.get(token);
    if (cached) return cached;

    const res = await botGet("/users/@me");
    let answer: { ok: boolean; note: string };
    if (!res) {
        answer = { ok: false, note: "No answer from Discord while testing the bot token — check your connection and try again." };
    } else if (res.status === 200) {
        answer = { ok: true, note: "" };
        logger.info(`checkid: bot token accepted (@${String(res.body?.username ?? "?")})`);
    } else if (res.status === 401) {
        answer = { ok: false, note: "The bot token in the pnygo settings was rejected (401). Only a BOT token works here — a personal user token never will." };
        logger.warn("checkid: bot token rejected (401)");
    } else if (res.status === 429) {
        answer = { ok: false, note: "Discord is rate-limiting the bot token right now — try again in a few seconds." };
    } else {
        answer = { ok: false, note: `Discord answered the bot token test with HTTP ${res.status} — that token cannot be used.` };
    }

    // every answer except a rate limit is a fact about the token itself and
    // does not change until the token does
    if (res && res.status !== 429) tokenCheck.set(token, answer);
    return answer;
}

export async function fetchUserProfile(rawId: unknown, opts?: { guildId?: string }): Promise<UserProfile | null> {
    const id = String(rawId ?? "").trim().replace(/[^\d]/g, "");
    if (!isValidId(id)) {
        lookupState.note = "";
        return null;
    }

    lookupState.note = "";
    await loadProfileCache();
    const hit = profileCache.get(id);
    if (hit && Date.now() - hit.at < CACHE_TTL) {
        logger.info(`checkid: GET /users/${id} -> saved card (network skipped)`);
        return hit.p;
    }

    let body: any = null;
    let lastStatus = 0;
    let lastErr: any = null;
    let fallbackUser: any = null;
    const trace: string[] = [];

    // ONE shared server is what makes Discord allow the full profile request
    // (guild_id) — it may be known locally, passed in, or found by a probe
    const guildId = opts?.guildId || localMutualGuild(id);

    // /profile is the full payload (it also carries mutual_guilds);
    // the plain user endpoint is the fallback for when it 404s/403s.
    const plainUser = (() => {
        try { return String(Constants.Endpoints.USER(id) || `/users/${id}`); }
        catch { return `/users/${id}`; }
    })();
    const profilePath = `/users/${id}/profile`;
    const attempts: Array<[string, Record<string, any>?]> = [
        [profilePath, guildId
            ? { guild_id: guildId, with_mutual_guilds: "true" }
            : { with_mutual_guilds: "true" }],
        [profilePath],
        [plainUser],
    ];

    // a refusal we just hit is remembered: the next press goes straight to
    // the local sources instead of spending 4s and a dozen requests again
    const refused = backoffUntil.get(id);
    const inBackoff = !!refused && Date.now() - refused.at < BACKOFF_MS;
    if (inBackoff) {
        lastStatus = refused.status;
        trace.push(`|backoff-${Math.max(1, Math.round((BACKOFF_MS - (Date.now() - refused.at)) / 1000))}s`);
    }

    let profile404 = false;

    // Discord refuses with 403 for a while and accepts the identical request
    // a second later, so a refused round is normally repeated twice more.
    // With a bot token in the settings there is no point in sleeping through
    // those retries: the bot answers the very same account a moment later.
    const maxRounds = readBotToken() ? 1 : 3;
    for (let round = 0; round < maxRounds && !body && !inBackoff; round++) {
        if (round) {
            trace.push(`|retry${round}`);
            await sleep(round === 1 ? 1200 : 2600);
        }

        for (const [path, query] of attempts) {
            const label = path.includes("/profile") ? "profile" : "user";
            // the twin /profile call (same URL, no query) can only 404 again
            if (profile404 && path.endsWith("/profile")) continue;

            const res = await restGet(path, query);
            if (!res) {
                trace.push(`${label}=no-answer`);
                continue;
            }
            trace.push(`${label}=${res.status}`);
            lastStatus = res.status;

            if (res.status === 404 && path.endsWith("/profile")) {
                // no shared server / not friends: Discord hides the profile
                profile404 = true;
                continue;
            }
            if (res.status === 429) {
                const wait = Math.min(Number(res.body?.retry_after ?? 1) * 1000, 4000);
                await sleep(Number.isFinite(wait) ? wait : 1000);
                const again = await restGet(path, query);
                if (again) {
                    trace.push(`${label}=${again.status}`);
                    lastStatus = again.status;
                }
                if (again?.status === 200 && again.body && !again.body.message) {
                    body = again.body;
                }
                continue;
            }
            if (res.status === 200 && res.body && !res.body.message) {
                body = res.body;
                break;
            }
            lastErr = res.body;
        }

        if (body) break;
        // only answers that are known to be temporary are worth waiting for
        if (lastStatus !== 403 && lastStatus !== 429 && lastStatus !== 0) break;
    }

    // ---- anything the client already knows beats a red error ----------------
    if (!body) {
        // 1. Discord's own profile cache (filled whenever a profile is opened)
        const stored: any = (() => {
            try { return UserProfileStore.getUserProfile?.(id) ?? null; }
            catch { return null; }
        })();
        if (stored?.user || stored?.id) {
            body = stored;
            trace.push("|profileStore");
        }
    }

    // ---- your bot token: the way out when nothing else is allowed ----------
    let botNote = "";
    let botUsed = false;
    if (!body && readBotToken()) {
        const check = await botTokenWorks();
        if (!check.ok) {
            botNote = check.note;
            trace.push("|bot=refused");
        } else {
            // bots may only read GET /users/:id — the profile endpoint answers
            // "Bots cannot use this endpoint" (20001) for every request — so
            // this is exactly one call, with a single polite 429 retry
            let res = await botGet(plainUser);
            if (res) trace.push(`botUser=${res.status}`);
            if (res?.status === 429) {
                const wait = Math.min(Number(res.body?.retry_after ?? 1) * 1000, 4000);
                await sleep(Number.isFinite(wait) ? wait : 1000);
                res = await botGet(plainUser);
                if (res) trace.push(`botUser=${res.status}`);
            }
            if (res && res.status !== 200) lastStatus = res.status;
            if (res?.status === 401) {
                botNote = "The bot token in the pnygo settings was rejected (401). Only a BOT token works here — a personal user token never will.";
                tokenCheck.delete(readBotToken());
            } else if (res?.status === 200 && res.body && !res.body.message) {
                body = res.body;
                botUsed = true;
            }
        }
    }

    // anything local counts as "we can show a card" — no need to probe 60
    // servers for more when the alternative is a card, not an error
    const localUser = (() => {
        try { return UserStore.getUser(id) ?? null; }
        catch { return null; }
    })();

    if (!body && !guildId && !localUser && !inBackoff) {
        // 2. no shared server is known yet — ask ours which one has this
        //    member, then repeat the profile request with that server: this
        //    is exactly what turns "Unauthorized (40001)" into a full card
        const shared = await findSharedGuild(id);
        if (!shared) {
            trace.push("|probe:none");
        } else {
            trace.push(`|probe:${shared}`);
            const res = await restGet(profilePath, { guild_id: shared, with_mutual_guilds: "true" });
            if (res) {
                trace.push(`probeProfile=${res.status}`);
                lastStatus = res.status;
                lastErr = res.body;
            }
            if (res?.status === 200 && res.body && !res.body.message) {
                body = res.body;
            }
        }
    }

    if (!body && !localUser && !inBackoff) {
        // 3. Discord's own user resolver — its flow, its caching
        try {
            const u = await UserUtils.getUser(id);
            if (u) {
                fallbackUser = u;
                trace.push("|userUtils");
            }
        } catch (e: any) {
            trace.push(`|userUtils=${e?.status ?? "err"}`);
        }
    }

    // one line per lookup, so a failed check can be told apart from a
    // rate limit, a dead session or an account that really refuses us
    logger.info(
        `checkid: GET /users/${id} -> ${trace.join(", ")}${body ? " · body ok" : " · no body"}`
        + (body || !lastErr?.message ? "" : ` · ${lastErr.message}${lastErr.code ? ` (${lastErr.code})` : ""}`),
    );

    // remember the refusal so the next press does not repeat the whole trip
    if (!body) backoffUntil.set(id, { at: Date.now(), status: lastStatus });
    else backoffUntil.delete(id);

    // Discord said no — but we already know this account: show what we have
    // instead of a red error that only says the same thing again
    if (!body && hit) {
        logger.info(`checkid: /users/${id} refused — showing the saved card`);
        return hit.p;
    }

    // /users/:id/profile wraps the account in `user` + `profile`,
    // /users/:id returns the account itself.
    const user = body?.user ?? (body?.id ? body : null) ?? fallbackUser ?? localUser;
    if (!user) {
        lookupState.note = botNote || lookupNote(lastStatus);
        return null;
    }
    // the card still renders from the local cache, but the caller has to know
    // that Discord itself did not answer (mutual servers may be missing then)
    if (!body) lookupState.note = botNote || lookupNote(lastStatus);
    else if (botUsed) lookupState.note = "Read with your bot token — your own account is not allowed to see this profile.";

    const profile = body?.profile ?? null;
    const username = String(user.username ?? "");
    const displayName = user.globalName || user.global_name || username || "Unknown";
    const primary = primaryGuildOf(user, profile);

    const result: UserProfile = {
        id,
        displayName,
        username: username ? `@${username}` : "",
        avatar: customAvatarOf(user, id) || defaultAvatar(id),
        decoration: decorationOf(user, profile),
        banner: bannerOf(user, profile, id),
        accent: colorOf(user?.accent_color ?? profile?.accent_color ?? null),
        bio: String(profile?.bio ?? user?.bio ?? ""),
        badges: collectBadges(user, profile, body),
        createdAt: snowflakeDate(id),
        nitro: nitroOf(user, profile),
        bot: !!user?.bot,
        verified: !!user?.verified,
        fromDiscord: !!body,
        mutualGuildIds: collectMutualGuilds(body),
        primaryGuildId: primary.id,
        primaryGuildTag: primary.tag,
    };

    // only a real Discord answer is worth remembering (a store-only card is
    // half empty and must not block the next full fetch)
    if (body) void rememberProfile(id, result);

    return result;
}

// ---------------------------------------------------------------------------
// the card
// ---------------------------------------------------------------------------

function Fact({ k, v, copy, cls }: { k: string; v: React.ReactNode; copy?: string; cls?: string; }) {
    if (v === null || v === undefined || v === "") return null;
    return (
        <div className="vc-pnygo-pf-fact">
            <div className="vc-pnygo-pf-factKey">{k}</div>
            <div
                className={cls ? `vc-pnygo-pf-factVal ${cls}` : "vc-pnygo-pf-factVal"}
                title={copy ? "Click to copy" : undefined}
                onClick={copy ? () => copyWithToast(copy, `Copied ${copy}`) : undefined}
            >
                {v}
            </div>
        </div>
    );
}

export interface ProfileCardProps {
    profile: UserProfile | null;
    loading?: boolean;
    /** shows the beating heart badge (Girlfriend only) */
    heart?: boolean;
    /** hides the "Account created" row (Girlfriend card and Check ID card) */
    hideCreated?: boolean;
    /** hides the "Bio" and "Accent colour" rows (Check ID card) */
    hideDetails?: boolean;
    /** rendered ABOVE the facts table (the equalizer strip + song player) */
    aboveFacts?: React.ReactNode;
    /** rendered under the facts table (Check ID: right now / servers, hints…) */
    footer?: React.ReactNode;
    /** shown when there is no profile yet */
    placeholder?: React.ReactNode;
}

export function ProfileCard({ profile, loading, heart = false, hideCreated = false, hideDetails = false, aboveFacts, footer, placeholder }: ProfileCardProps) {
    if (loading && !profile) return <div className="vc-pnygo-pf"><div className="vc-pnygo-pf-empty">Loading…</div></div>;
    if (!profile) {
        return <div className="vc-pnygo-pf"><div className="vc-pnygo-pf-empty">{placeholder ?? "No profile."}</div></div>;
    }

    const facts: Array<{ k: string; v: React.ReactNode; copy?: string; cls?: string; }> = [
        { k: "User ID", v: profile.id, copy: profile.id, cls: "vc-pnygo-pf-factVal--code" },
        { k: "Username", v: profile.username || "—", copy: profile.username || undefined, cls: "vc-pnygo-pf-factVal--code" },
        { k: "Display name", v: profile.displayName },
        ...(!hideCreated && profile.createdAt
            ? [{ k: "Account created", v: new Date(profile.createdAt).toLocaleString() }]
            : []),
        ...(!hideDetails
            ? [
                { k: "Bio", v: profile.bio || "—", cls: "vc-pnygo-pf-factVal--bio" },
                {
                    k: "Accent colour",
                    v: profile.accent
                        ? <><span className="vc-pnygo-pf-dot" style={{ background: profile.accent, boxShadow: `0 0 10px ${profile.accent}` }} />{profile.accent}</>
                        : "—",
                    copy: profile.accent || undefined,
                },
            ]
            : []),
    ];

    return (
        <div
            className="vc-pnygo-pf"
            style={profile.accent ? { "--vc-pf-accent": profile.accent } as React.CSSProperties : undefined}
        >
            {profile.banner && <div className="vc-pnygo-pf-banner" style={{ backgroundImage: `url("${profile.banner}")` }} />}

            <div className="vc-pnygo-pf-avatarWrap">
                <div className="vc-pnygo-pf-avatarRing" />
                <img
                    className="vc-pnygo-pf-avatar"
                    src={profile.avatar}
                    alt=""
                    onError={e => {
                        const el = e.currentTarget;
                        if (el.dataset.fb === "1") return;
                        el.dataset.fb = "1";
                        el.src = defaultAvatar(profile.id);
                    }}
                />
                {profile.decoration && <img className="vc-pnygo-pf-decoration" src={profile.decoration} alt="" />}
                {heart && <span className="vc-pnygo-pf-badge"><Icons.heart size={16} /></span>}
            </div>

            <div className="vc-pnygo-pf-name">{profile.displayName}</div>
            {profile.username && <div className="vc-pnygo-pf-handle">{profile.username}</div>}

            {(profile.badges.length > 0 || profile.nitro || profile.bot || profile.verified) && (
                <div className="vc-pnygo-pf-tags">
                    {profile.nitro && <span className="vc-pnygo-pf-tag">★ {profile.nitro}</span>}
                    {profile.bot && <span className="vc-pnygo-pf-tag vc-pnygo-pf-tag--plain">Bot</span>}
                    {profile.verified && <span className="vc-pnygo-pf-tag vc-pnygo-pf-tag--plain">Verified</span>}
                    {profile.badges.map((b, i) => (
                        <span key={`${b}-${i}`} className="vc-pnygo-pf-tag vc-pnygo-pf-tag--plain">{b}</span>
                    ))}
                </div>
            )}

            {aboveFacts}

            <div className="vc-pnygo-pf-facts">
                {facts.map((f, i) => <Fact key={i} k={f.k} v={f.v} copy={f.copy} cls={f.cls} />)}
            </div>

            {footer}

            <div className="vc-pnygo-pf-note">
                {profile.fromDiscord
                    ? "Fetched from Discord · local only, nothing is sent anywhere."
                    : "Read from the local cache (Discord did not answer) · local only."}
            </div>
        </div>
    );
}
