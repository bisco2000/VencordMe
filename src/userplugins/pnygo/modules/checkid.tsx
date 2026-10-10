/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * pnygo - Check ID submodule
 *
 * Paste ANY Discord user ID (or a whole https://discord.com/users/<id> link)
 * and get the card back: display name, @username, avatar, avatar decoration,
 * badges, banner and the raw ID — everything Discord will tell us about that
 * account. No friendship, no shared server and no friend request are needed:
 * the lookup is one plain REST read, nothing is ever sent to them.
 *
 * On top of the shared card the panel adds everything only the local client
 * can know:
 *   - Status / Activity, live from PresenceStore
 *   - "Last online". Discord never sends a last-seen timestamp (not in the
 *     gateway, not in REST), so pnygo keeps its OWN timestamp in IndexedDB:
 *     it is written whenever this account shows up as online while Discord
 *     is open, and reused for the relative time afterwards.
 *   - the voice channel / call they are sitting in right now
 *   - EVERY server you share, with no list cap: mutual_guilds from REST
 *     merged with the local member cache, plus an optional deep scan that
 *     asks every one of your servers one by one (for when REST is silent)
 *   - their server tag (primary_guild) — the one server they are in that
 *     you do NOT have to share with them
 *
 * Honest limit: Discord exposes no endpoint that lists every guild an
 * arbitrary account belongs to. See the note rendered under the list.
 *
 * No settings: the feature IS the input box. The last id checked is only kept
 * for the current session so reopening the panel shows the same person again.
 */

import "./checkid.css";

import { get, set } from "@api/DataStore";
import ErrorBoundary from "@components/ErrorBoundary";
import { copyWithToast } from "@utils/discord";
import { ChannelStore, GuildChannelStore, GuildMemberStore, GuildStore, Modal, PresenceStore, React, VoiceStateStore } from "@webpack/common";

import { hit } from "./probe";
import { fetchUserProfile, lookupState, ProfileCard, restGet, type UserProfile } from "./profile";
import { Button, Icons, Input, openPanel, TitlebarButton } from "./ui";

// ---------------------------------------------------------------------------
// "last online" tracker — Discord does not expose one, so we keep our own
// ---------------------------------------------------------------------------

const LASTSEEN_KEY = "vc-pnygo:lastseen";
/** never write to IndexedDB more often than this for one account */
const TOUCH_GAP = 60_000;

let lastSeen: Record<string, number> = {};
let lastSeenLoaded = false;
let lastSeenDirty = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** false while the feature is switched off in the settings */
let tracking = false;

async function loadLastSeen(): Promise<void> {
    try {
        const raw = await get(LASTSEEN_KEY);
        lastSeen = raw && typeof raw === "object" && !Array.isArray(raw)
            ? { ...(raw as Record<string, unknown>) } as Record<string, number>
            : {};
    } catch {
        lastSeen = {};
    }
    lastSeenLoaded = true;
}

function flushLastSeen(): void {
    if (!lastSeenDirty) return;
    lastSeenDirty = false;
    const snapshot = { ...lastSeen };
    void set(LASTSEEN_KEY, snapshot).catch(() => {});
}

/** remember "this account is online right now" (throttled to once a minute) */
function touchOnline(userId: string, at?: number): void {
    if (!/^\d{15,25}$/.test(userId)) return;
    const raw = Number(at);
    const now = Number.isFinite(raw) && raw > 0 ? raw : Date.now();
    const prev = lastSeen[userId] ?? 0;
    if (now <= prev || now - prev < TOUCH_GAP) return;
    lastSeen[userId] = now;
    lastSeenDirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = undefined;
        flushLastSeen();
    }, 5000);
}

// ---------------------------------------------------------------------------
// store readers (all guarded — the stores may still be empty)
// ---------------------------------------------------------------------------

function safeStatus(userId: string): string {
    try {
        return String(PresenceStore.getStatus?.(userId) ?? "offline");
    } catch {
        return "unknown";
    }
}

function isOnline(status: string): boolean {
    return status === "online" || status === "idle" || status === "dnd" || status === "streaming";
}

const STATUS_LABEL: Record<string, string> = {
    online: "Online",
    idle: "Idle",
    dnd: "Do not disturb",
    streaming: "Streaming",
    invisible: "Offline (invisible)",
    offline: "Offline",
    unknown: "Unknown",
};

const STATUS_COLOR: Record<string, string> = {
    online: "#23a559",
    idle: "#f0b232",
    dnd: "#f23f43",
    streaming: "#593695",
    invisible: "#80848e",
    offline: "#80848e",
    unknown: "#80848e",
};

function activityLabel(userId: string): string {
    try {
        const list: any[] = PresenceStore.getActivities?.(userId) ?? [];
        // skip the "Custom Status" entry unless it is the only thing there
        const pick = list.find(a => a?.name && Number(a?.type) !== 4)
            ?? list.find(a => a?.name);
        if (!pick) return "";
        const actType = Number(pick.type);
        if (actType === 4) return String(pick.state ?? "").trim();
        const prefix =
            actType === 0 ? "Playing "
                : actType === 1 ? "Streaming "
                    : actType === 2 ? "Watching "
                        : actType === 3 ? "Listening to "
                            : actType === 5 ? "Competing in "
                                : "";
        return prefix + String(pick.name);
    } catch {
        return "";
    }
}

interface VoiceSpot {
    guildId: string;
    label: string;
    where: string;
    channelId: string;
}

function callLabel(ch: any): string {
    const kind = Number(ch?.type);
    if (kind === 1 || kind === 3) {
        if (ch?.name) return String(ch.name);
        const recipients: any[] = Array.isArray(ch?.rawRecipients) ? ch.rawRecipients : [];
        const names = recipients
            .map(r => String(r?.global_name || r?.display_name || r?.username || ""))
            .filter(Boolean);
        if (names.length) return names.slice(0, 4).join(", ");
        return kind === 1 ? "Direct call" : "Group call";
    }
    return String(ch?.name || "voice channel");
}

function findVoice(userId: string): VoiceSpot | null {
    try {
        let spot: any = null;
        try {
            spot = VoiceStateStore.getVoiceStateForUser?.(userId) ?? null;
        } catch {
            spot = null;
        }
        if (!spot?.channelId) {
            const all: Record<string, any> = VoiceStateStore.getAllVoiceStates?.() ?? {};
            for (const gid of Object.keys(all)) {
                const inGuild = all[gid]?.[userId];
                if (inGuild?.channelId) {
                    spot = inGuild;
                    break;
                }
            }
        }
        if (!spot?.channelId) return null;
        const ch: any = ChannelStore.getChannel?.(spot.channelId);
        if (!ch) return null;
        let guildId = "";
        try {
            guildId = String(ch.getGuildId?.() ?? ch.guild_id ?? "");
        } catch {
            guildId = "";
        }
        const guild: any = guildId ? GuildStore.getGuild?.(guildId) : null;
        return {
            guildId,
            label: callLabel(ch),
            where: guild?.name ? String(guild.name) : "",
            channelId: String(spot.channelId),
        };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// the server list
// ---------------------------------------------------------------------------

interface GuildRow {
    id: string;
    name: string;
    icon: string;
    nick: string;
}

interface GuildInfo {
    name: string;
    icon: string;
}

function guildIconUrl(id: string, icon: unknown): string {
    const hash = typeof icon === "string" ? icon : "";
    if (!hash) return "";
    if (hash.startsWith("http")) return hash;
    const ext = hash.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/icons/${id}/${hash}.${ext}?size=64`;
}

/** session cache so a server is only ever looked up once */
const guildInfoCache = new Map<string, GuildInfo>();
const guildInfoTried = new Set<string>();

/**
 * Name + icon for any guild id. Tries the local cache first (instant for
 * every server you are in), then REST, then the public widget. Returns an
 * empty object rather than throwing when Discord says no.
 */
async function resolveGuildInfo(guildId: string): Promise<GuildInfo> {
    const cached = guildInfoCache.get(guildId);
    if (cached) return cached;

    try {
        const local: any = GuildStore.getGuild?.(guildId);
        if (local?.name) {
            const info: GuildInfo = { name: String(local.name), icon: guildIconUrl(guildId, local.icon) };
            guildInfoCache.set(guildId, info);
            return info;
        }
    } catch { /* store not ready */ }

    if (guildInfoTried.has(guildId)) return { name: "", icon: "" };
    guildInfoTried.add(guildId);

    const full = await restGet(`/guilds/${guildId}`);
    if (full?.status === 200 && full.body?.name) {
        const info: GuildInfo = { name: String(full.body.name), icon: guildIconUrl(guildId, full.body.icon) };
        guildInfoCache.set(guildId, info);
        return info;
    }

    // not a member: the public widget is the only thing Discord opens up
    const widget = await restGet(`/guilds/${guildId}/widget.json`);
    if (widget?.status === 200 && widget.body?.name) {
        const info: GuildInfo = {
            name: String(widget.body.name),
            icon: guildIconUrl(guildId, widget.body.icon),
        };
        guildInfoCache.set(guildId, info);
        return info;
    }
    return { name: "", icon: "" };
}

/** servers this account is a member of, according to the local caches */
function localGuildsFor(userId: string): GuildRow[] {
    const out: GuildRow[] = [];
    try {
        const guilds: Record<string, any> = GuildStore.getGuilds?.() ?? {};
        for (const guildId of Object.keys(guilds)) {
            const guild = guilds[guildId];
            if (!guild) continue;
            let member: any = null;
            try {
                member = GuildMemberStore.getMember?.(guildId, userId);
            } catch {
                member = null;
            }
            if (!member) continue;
            out.push({
                id: guildId,
                name: String(guild.name ?? ""),
                icon: guildIconUrl(guildId, guild.icon),
                nick: String(member.nick ?? ""),
            });
        }
    } catch {
        /* the guild cache is not ready yet */
    }
    return out;
}

function uniqueIds(...lists: string[][]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const list of lists) {
        for (const value of list) {
            const id = String(value ?? "");
            if (!/^\d{15,25}$/.test(id) || seen.has(id)) continue;
            seen.add(id);
            out.push(id);
        }
    }
    return out;
}

/** every known id for this account, REST + local cache + deep scan results */
function mutualGuildsFor(userId: string, ids: string[]): GuildRow[] {
    const local = localGuildsFor(userId);
    const known = new Map(local.map(g => [g.id, g]));
    const rows: GuildRow[] = [];

    for (const guildId of ids) {
        rows.push(known.get(guildId) ?? { id: guildId, name: "", icon: "", nick: "" });
    }

    rows.sort((a, b) => {
        if (a.name && !b.name) return -1;
        if (!a.name && b.name) return 1;
        return a.name.localeCompare(b.name);
    });
    return rows;
}

function myGuildCount(): number {
    try {
        return Object.keys(GuildStore.getGuilds?.() ?? {}).length;
    } catch {
        return 0;
    }
}

// ---------------------------------------------------------------------------
// links — every server row carries its own server link + room link
// ---------------------------------------------------------------------------

function serverLink(guildId: string): string {
    return `https://discord.com/channels/${guildId}`;
}

/**
 * A link into that guild: the room they are sitting in right now when we know
 * it, otherwise the default channel, otherwise the system channel, otherwise
 * the first channel we happen to have cached for it.
 */
function roomLink(guildId: string, voice: VoiceSpot | null): { url: string; channelId: string; } {
    if (voice?.guildId === guildId && voice.channelId) {
        return { url: `${serverLink(guildId)}/${voice.channelId}`, channelId: voice.channelId };
    }
    try {
        const channels: string[] = ChannelStore.getChannelIds?.(guildId) ?? [];
        const candidates: string[] = [];
        try { candidates.push(String(GuildChannelStore.getDefaultChannel?.(guildId)?.id ?? "")); } catch { /* ignore */ }
        try { candidates.push(String(GuildStore.getGuild?.(guildId)?.systemChannelId ?? "")); } catch { /* ignore */ }
        candidates.push(...channels.filter(id => {
            const ch: any = ChannelStore.getChannel?.(id);
            return ch && Number(ch.type) === 0;
        }));
        candidates.push(...channels);

        const channelId = candidates.find(id => /^\d{15,25}$/.test(id)) ?? "";
        if (!channelId) return { url: "", channelId: "" };
        return { url: `${serverLink(guildId)}/${channelId}`, channelId };
    } catch {
        return { url: "", channelId: "" };
    }
}

// ---------------------------------------------------------------------------
// deep scan — ask every server you are in whether they are a member of it
// ---------------------------------------------------------------------------

interface ScanProgress {
    done: number;
    total: number;
    found: number;
    running: boolean;
    note: string;
}

/** bumped to cancel a scan (new lookup, new card, plugin stop) */
let scanGeneration = 0;

function scanNote(reason: string): string {
    if (reason === "auth" || reason === "denied") {
        return "Discord does not allow per-server member lookups from this account — the list from the profile request is used instead.";
    }
    if (reason === "ratelimit") {
        return "Discord rate-limited the scan — wait a moment and press Verify again.";
    }
    return "";
}

async function deepScan(
    userId: string,
    generation: number,
    onProgress: (p: ScanProgress) => void,
): Promise<{ ids: string[]; note: string; done: number; total: number }> {
    const guildIds = Object.keys(GuildStore.getGuilds?.() ?? {});
    const total = guildIds.length;
    const found: string[] = [];
    const alive = () => scanGeneration === generation;

    let index = 0;
    let done = 0;
    let ok = 0;
    let denied = 0;
    let rate = 0;
    let stopped = "";

    const worker = async (): Promise<void> => {
        while (index < guildIds.length && !stopped && alive()) {
            const guildId = guildIds[index++];
            const res = await restGet(`/guilds/${guildId}/members/${userId}`);
            done++;
            if (res?.status === 200) {
                ok++;
                found.push(guildId);
            } else if (res?.status === 429) {
                rate++;
            } else {
                // 404 = not a member, 401/403 = not allowed, null = offline
                denied++;
            }
            if (res?.status === 401) stopped = "auth";
            else if (rate >= 3) stopped = "ratelimit";
            else if (done >= 6 && ok === 0 && denied >= 6) stopped = "denied";

            if (done % 4 === 0 || done === total) {
                onProgress({ done, total, found: found.length, running: true, note: "" });
            }
        }
    };

    const workers = Array.from({ length: Math.max(1, Math.min(6, total)) }, () => worker());
    await Promise.all(workers);

    if (alive()) onProgress({ done, total, found: found.length, running: false, note: scanNote(stopped) });
    return { ids: found, note: scanNote(stopped), done, total };
}

function relTime(ts: number): string {
    const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (seconds < 45) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "yesterday";
    if (days < 30) return `${days} days ago`;
    return new Date(ts).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

/** pull "123456789012345678" out of a raw id, a link or anything else */
function extractId(value: string): string {
    const m = /\d{15,25}/.exec(value ?? "");
    if (m) return m[0];
    return String(value ?? "").replace(/[^\d]/g, "");
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
    if (v === null || v === undefined || v === "") return null;
    return (
        <div className="vc-pnygo-cid-row">
            <div className="vc-pnygo-cid-k">{k}</div>
            <div className="vc-pnygo-cid-v">{v}</div>
        </div>
    );
}

function CheckInfo({ profile }: { profile: UserProfile }) {
    const userId = profile.id;
    const [, force] = React.useReducer((x: number) => x + 1, 0);

    // re-render whenever presence / voice / guilds change
    React.useEffect(() => {
        const stores: any[] = [
            PresenceStore,
            VoiceStateStore,
            ChannelStore,
            GuildStore,
            GuildMemberStore,
        ];
        for (const store of stores) {
            try {
                store?.addChangeListener?.(force);
            } catch { /* store not ready */ }
        }
        return () => {
            for (const store of stores) {
                try {
                    store?.removeChangeListener?.(force);
                } catch { /* already gone */ }
            }
        };
    }, []);

    // keep our own "last online" timestamp fresh while the card is open
    React.useEffect(() => {
        if (!lastSeenLoaded) void loadLastSeen().then(() => force());
        if (isOnline(safeStatus(userId))) touchOnline(userId);
        const timer = setInterval(() => {
            if (isOnline(safeStatus(userId))) touchOnline(userId);
            force();
        }, 4000);
        return () => clearInterval(timer);
    }, [userId]);

    const [scan, setScan] = React.useState<ScanProgress | null>(null);
    const [scanIds, setScanIds] = React.useState<string[]>([]);
    const [resolved, setResolved] = React.useState<Record<string, GuildInfo>>({});
    const scanBusy = React.useRef(false);

    // cancel a running scan when the card changes or closes
    React.useEffect(() => () => {
        scanGeneration++;
        scanBusy.current = false;
    }, [userId]);

    const status = safeStatus(userId);
    const online = isOnline(status);
    const activity = activityLabel(userId);
    const voice = findVoice(userId);
    const seenAt = lastSeen[userId] ?? 0;

    const ids = uniqueIds(profile.mutualGuildIds, scanIds);
    const guilds = mutualGuildsFor(userId, ids);
    const primaryId = profile.primaryGuildId;
    const primaryShared = !!primaryId && ids.includes(primaryId);

    // fill in the name/icon of every id the local cache does not know yet
    const resolveKey = [...ids, primaryId].filter(Boolean).join(",");
    React.useEffect(() => {
        const missing = resolveKey
            .split(",")
            .filter(Boolean)
            .filter(id => resolved[id] === undefined);
        if (missing.length === 0) return;

        let cancelled = false;
        void (async () => {
            const patch: Record<string, GuildInfo> = {};
            for (const guildId of missing) {
                patch[guildId] = await resolveGuildInfo(guildId);
            }
            if (!cancelled) setResolved(prev => ({ ...prev, ...patch }));
        })();
        return () => {
            cancelled = true;
        };
    }, [resolveKey, resolved]);

    const startScan = React.useCallback(async () => {
        if (scanBusy.current) return;
        scanBusy.current = true;
        const generation = ++scanGeneration;
        setScan({ done: 0, total: myGuildCount(), found: 0, running: true, note: "" });
        try {
            const result = await deepScan(userId, generation, p => {
                if (scanGeneration === generation) setScan(p);
            });
            if (scanGeneration !== generation) return;
            setScanIds(prev => uniqueIds(prev, result.ids));
            setScan({
                done: result.done,
                total: result.total,
                found: result.ids.length,
                running: false,
                note: result.note,
            });
        } finally {
            scanBusy.current = false;
        }
    }, [userId]);

    const openGuild = (guildId: string) =>
        copyWithToast(guildId, `Copied server ID ${guildId}`);

    const copyLink = (url: string) =>
        copyWithToast(url, `Copied ${url}`);

    const renderGuild = (g: GuildRow, extra?: React.ReactNode) => {
        const info = resolved[g.id];
        const name = g.name || info?.name || "";
        const icon = g.icon || info?.icon || "";
        const server = serverLink(g.id);
        const room = roomLink(g.id, voice);
        return (
            <div
                key={g.id}
                className="vc-pnygo-cid-guild"
                title="Click to copy the server ID"
                onClick={() => openGuild(g.id)}
            >
                {icon
                    ? <img className="vc-pnygo-cid-guildIcon" src={icon} alt="" loading="lazy" />
                    : <span className="vc-pnygo-cid-guildPh">{(name || "?").slice(0, 1).toUpperCase()}</span>}
                <span className="vc-pnygo-cid-guildName">
                    {name || `Unknown server (${g.id})`}
                    {g.nick && <span className="vc-pnygo-cid-guildNick"> · {g.nick}</span>}
                </span>
                {extra}
                <span className="vc-pnygo-cid-links">
                    <button
                        type="button"
                        className="vc-pnygo-cid-link"
                        title={server}
                        onClick={e => { e.stopPropagation(); copyLink(server); }}
                    >
                        server link
                    </button>
                    {room.url && (
                        <button
                            type="button"
                            className="vc-pnygo-cid-link"
                            title={room.url}
                            onClick={e => { e.stopPropagation(); copyLink(room.url); }}
                        >
                            room link
                        </button>
                    )}
                </span>
            </div>
        );
    };

    return (
        <>
            {lookupState.note && (
                <div className="vc-pnygo-cid-hint vc-pnygo-cid-hint--warn">{lookupState.note}</div>
            )}

            <div className="vc-pnygo-cid-title">Right now</div>
            <div className="vc-pnygo-cid-block">
                <Row
                    k="Status"
                    v={
                        <>
                            <span
                                className="vc-pnygo-pf-dot"
                                style={{ background: STATUS_COLOR[status] ?? STATUS_COLOR.unknown }}
                            />
                            {STATUS_LABEL[status] ?? status}
                        </>
                    }
                />
                <Row
                    k="Last online"
                    v={
                        online
                            ? <span className="vc-pnygo-cid-live">Online now</span>
                            : seenAt
                                ? <span title={new Date(seenAt).toLocaleString()}>{relTime(seenAt)}</span>
                                : <span className="vc-pnygo-cid-muted">Not tracked yet</span>
                    }
                />
                <Row
                    k="In voice"
                    v={voice ? `${voice.label}${voice.where ? ` @ ${voice.where}` : ""}` : "Not in a voice channel"}
                />
                <Row k="Activity" v={activity} />
            </div>

            <div className="vc-pnygo-cid-title">Servers you share ({guilds.length})</div>

            <div className="vc-pnygo-cid-scan">
                <Button
                    size="sm"
                    variant="ghost"
                    disabled={!!scan?.running}
                    onClick={() => void startScan()}
                >
                    {scan?.running ? "Checking…" : "Verify across all your servers"}
                </Button>
                <span className="vc-pnygo-cid-scanText">
                    {scan
                        ? scan.running
                            ? `checked ${scan.done}/${scan.total} · ${scan.found} found`
                            : `${scan.found} confirmed out of ${scan.total} of your servers`
                        : `asks each of your ${myGuildCount()} servers one by one, in case the profile request missed some`}
                </span>
            </div>
            {scan?.note && <div className="vc-pnygo-cid-hint">{scan.note}</div>}

            {guilds.length > 0 ? (
                <div className="vc-pnygo-cid-guilds">
                    {guilds.map(g => renderGuild(
                        g,
                        voice?.guildId === g.id
                            ? <span className="vc-pnygo-cid-vc">in VC</span>
                            : undefined,
                    ))}
                </div>
            ) : (
                <div className="vc-pnygo-cid-hint">
                    Nothing yet. Discord only reports servers that both of you are a member of —
                    press Verify above to double check every server you are in. Each server row
                    carries a “server link” and a “room link” you can copy.
                </div>
            )}

            {primaryId && !primaryShared && (
                <>
                    <div className="vc-pnygo-cid-title">Their server tag</div>
                    <div className="vc-pnygo-cid-guilds">
                        {renderGuild(
                            { id: primaryId, name: "", icon: "", nick: "" },
                            profile.primaryGuildTag
                                ? <span className="vc-pnygo-cid-vc">tag {profile.primaryGuildTag}</span>
                                : undefined,
                        )}
                    </div>
                    <div className="vc-pnygo-cid-hint">
                        The one server they are in that you do not have to share with them.
                    </div>
                </>
            )}

            <div className="vc-pnygo-pf-note">
                Discord has no API that lists every server an account belongs to. It only reveals
                the servers you share with this account and the server whose tag they wear —
                everything above comes straight from Discord, nothing is guessed.
            </div>
            <div className="vc-pnygo-pf-note">
                Last online is tracked by pnygo itself, because Discord never sends a last-seen
                timestamp: it is written whenever this account shows up as online while Discord
                is open.
            </div>
        </>
    );
}

function CheckIdPanel(props: any) {
    const { onClose } = props;

    // always opens EMPTY: you type the id you want, nothing is prefilled
    // (it used to reopen the Girlfriend id and run a lookup on its own)
    const [value, setValue] = React.useState("");
    const [profile, setProfile] = React.useState<UserProfile | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [err, setErr] = React.useState("");

    const run = React.useCallback(async (raw?: string) => {
        const target = extractId(raw ?? value);
        if (target.length < 15 || target.length > 25) {
            setErr("That is not a valid Discord user ID — it is 15 to 25 digits.");
            setProfile(null);
            return;
        }

        // a card already on screen for this same id stays there: a failed
        // refresh must never replace good data with a red error
        const keep = profile?.id === target ? profile : null;

        setErr("");
        setLoading(true);
        if (!keep) setProfile(null);
        try {
            const p = await fetchUserProfile(target);
            if (p) {
                setProfile(p);
                setValue(p.id);
            } else if (!keep) {
                setErr(lookupState.note || "Discord returned nothing for that ID. Check the number and try again.");
            }
        } catch {
            if (!keep) setErr(lookupState.note || "The lookup failed — check your connection and try again.");
        } finally {
            setLoading(false);
        }
    }, [value, profile]);

    return (
        <Modal
            {...props}
            size="md"
            title="Check ID"
            actions={[{ text: "Close", variant: "secondary", onClick: onClose }]}
        >
            <div className="vc-pnygo-cid">
                <div className="vc-pnygo-cid-bar">
                    <Input
                        value={value}
                        spellCheck={false}
                        placeholder="User ID or https://discord.com/users/…"
                        onChange={e => { setValue(e.currentTarget.value); setErr(""); }}
                        onKeyDown={e => { if (e.key === "Enter") void run(); }}
                    />
                    <Button variant="primary" onClick={() => void run()} disabled={loading}>
                        {loading ? "Checking…" : "Check"}
                    </Button>
                </div>

                {err && <div className="vc-pnygo-cid-hint vc-pnygo-cid-hint--bad">{err}</div>}
                {!err && !profile && !loading && (
                    <div className="vc-pnygo-cid-hint">
                        Paste an ID or a profile link, then press Check (or Enter). It works for ANY
                        account — friend or not, shared server or not — and no friend request is ever
                        sent: the card is a plain read from Discord. Every value in the result can be
                        clicked to copy it. When your own account is not allowed to read a profile,
                        pnygo falls back to the bot token from the settings (if you pasted one).
                    </div>
                )}
            </div>

            {(profile || loading) && (
                <div className="vc-pnygo-cid-result">
                    <ProfileCard
                        profile={profile}
                        loading={loading}
                        hideCreated
                        hideDetails
                        footer={profile ? <CheckInfo profile={profile} /> : undefined}
                        placeholder="Looking that up…"
                    />
                </div>
            )}
        </Modal>
    );
}

/** opens the Check ID panel (and counts as a live self-check probe) */
export function openCheckId(): boolean {
    hit("checkid");
    return openPanel(props => <CheckIdPanel {...props} />);
}

// ---------------------------------------------------------------------------
// wiring (index.tsx pulls all of this in)
// ---------------------------------------------------------------------------

function UserHeaderButton() {
    return (
        <TitlebarButton
            id="checkid"
            tooltip="Check ID — look up any Discord account"
            onClick={() => openCheckId()}
        >
            <Icons.user size={18} />
        </TitlebarButton>
    );
}

export function CheckIdHeaderButton_() {
    return (
        <ErrorBoundary key="vc-cid-titlebar" noop>
            <UserHeaderButton />
        </ErrorBoundary>
    );
}

export const toolboxActions = {
    "Check ID": () => openCheckId(),
};

/** keeps our "last online" tracker alive while the feature is enabled */
export const flux = {
    PRESENCE_UPDATE: (data: any) => {
        if (!tracking) return;
        try {
            const id = String(data?.user?.id ?? data?.user_id ?? "");
            if (!/^\d{15,25}$/.test(id)) return;
            // some payloads still carry the old `last_modified` field
            const stamp = Number(data?.last_modified);
            if (Number.isFinite(stamp) && stamp > 0) {
                touchOnline(id, stamp > 1e12 ? stamp : stamp * 1000);
                return;
            }
            const status = String(data?.status ?? "");
            if (status && status !== "offline" && status !== "invisible") touchOnline(id);
        } catch { /* never break the dispatcher */ }
    },
};

export function start(store: Record<string, any>): void {
    tracking = store?.enableCheckId !== false;
    void loadLastSeen();
}

export function stop(): void {
    tracking = false;
    scanGeneration++;
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
    }
    flushLastSeen();
    lastSeen = {};
    lastSeenDirty = false;
    lastSeenLoaded = false;
}
