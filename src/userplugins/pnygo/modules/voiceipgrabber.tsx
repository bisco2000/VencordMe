/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { get, set } from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import ErrorBoundary from "@components/ErrorBoundary";
import { copyWithToast } from "@utils/discord";
import { IconComponent,OptionType, PluginNative } from "@utils/types";
import {
    ChannelStore,
    Forms,
    GuildStore,
    MediaEngineStore,
    Modal,
    openModal,
    React,
    RTCConnectionStore,
    SelectedChannelStore,
    UserStore,
    VoiceStateStore,
} from "@webpack/common";

import { Button, CLS, Field, Input, TitlebarButton } from "./ui";

const Native = VencordNative.pluginHelpers.pnygo as PluginNative<typeof import("../native")>;

const HISTORY_KEY = "vcipgrab:history";
const MAX_HISTORY = 300;

// set from the merged plugin's start()
let storeRef: Record<string, any> = {};

export const settings = {
    autoCapture: {
        type: OptionType.BOOLEAN,
        description: "Automatically capture every new voice server IP:PORT when joining any room or stream",
        default: true,
    },
    notify: {
        type: OptionType.BOOLEAN,
        description: "Show a notification on every capture",
        default: true,
    },
    voiceIPWebhookUrl: {
        type: OptionType.STRING,
        description: "Discord webhook URL — every captured room IP is POSTed to it (leave empty to turn it off)",
        default: "",
    },
} as const;

interface StreamEvent {
    owner: string;
    ts: string; // HH:MM:SS when the stream started
    ip?: string; // only set when different from the room IP
    port?: number | string;
}

interface CaptureEntry {
    ts: string; // HH:MM:SS when the room was captured
    ip: string;
    port: number | string;
    type: "vc" | "stream";
    stream_owner: string;
    room: string;
    webhook: string;
    streams?: StreamEvent[]; // streamers observed in this room
}

interface StreamLive {
    owner: string;
    ts: string;
    ip?: string; // only set when different from the room endpoint
    port?: number | string;
}

interface CurrentState {
    room: string;
    roomEp: { ip: string; port: number | string } | null;
    streams: StreamLive[]; // currently active streams
    newStreams: StreamLive[]; // streams that just started (for reporting)
}

const listeners = new Set<() => void>();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const IPV4_RE = /^(\d{1,3}(?:\.\d{1,3}){3})$/;

function isIPv4(s: unknown): s is string {
    if (typeof s !== "string" || !IPV4_RE.test(s)) return false;
    return s.split(".").every(x => Number(x) <= 255);
}

function isPortNumber(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 65535;
}

/** Deep-scan an object for an {address/ip, port} pair. */
function findAddrPort(obj: unknown, depth = 0): { ip: string; port: number } | null {
    if (depth > 6 || obj == null || typeof obj !== "object") return null;
    const rec = obj as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
        if (!/(address|ip|host|server)/i.test(key)) continue;
        const v = rec[key];
        if (typeof v === "string" && v.trim().length > 0 && !v.includes("/")) {
            for (const pk of Object.keys(rec)) {
                if (!/port/i.test(pk)) continue;
                const pv = rec[pk];
                if (isPortNumber(pv)) return { ip: v.trim(), port: pv };
            }
        }
    }
    for (const key of Object.keys(rec)) {
        try {
            const r = findAddrPort(rec[key], depth + 1);
            if (r) return r;
        } catch { }
    }
    return null;
}

function userName(id?: string): string {
    if (!id) return "";
    const u = UserStore.getUser(id);
    return u?.globalName ?? u?.username ?? id;
}

function getCurrentVoiceChannelId(): string | undefined {
    try {
        return SelectedChannelStore.getVoiceChannelId?.()
            ?? RTCConnectionStore.getChannelId?.();
    } catch {
        return undefined;
    }
}

/** room parts: channel name FIRST, then server name */
function getRoomParts(): { channel: string; guild: string } {
    try {
        const channelId = getCurrentVoiceChannelId();
        if (!channelId) return { channel: "", guild: "" };
        const ch = ChannelStore.getChannel(channelId);
        if (!ch) return { channel: `channel ${channelId}`, guild: "" };
        const guild = (ch as any).guild_id ? GuildStore.getGuild((ch as any).guild_id) : null;
        return { channel: ch.name || "Private Call", guild: guild?.name ?? "" };
    } catch {
        return { channel: "", guild: "" };
    }
}

function getRoomName(): string {
    const { channel, guild } = getRoomParts();
    if (!channel) return "";
    return guild ? `${channel} — ${guild}` : channel;
}

function getRoomGuildId(): string | undefined {
    try {
        const channelId = getCurrentVoiceChannelId();
        return channelId ? (ChannelStore.getChannel(channelId) as any)?.guild_id : undefined;
    } catch {
        return undefined;
    }
}

/** users currently Go-Live streaming / with video on in my voice channel */
function getRoomStreamers(): string[] {
    const channelId = getCurrentVoiceChannelId();
    if (!channelId) return [];
    try {
        const states = VoiceStateStore.getVoiceStatesForChannel(channelId);
        return Object.values(states)
            .filter(st => st.selfStream || st.selfVideo)
            .map(st => userName(st.userId));
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// transport capture (the REAL UDP endpoint the client uses)
// ---------------------------------------------------------------------------

interface TransportCapture {
    address?: string;
    port?: number;
    ts: number;
}

const transports = new Map<string, TransportCapture>();
const endpointByGuild = new Map<string, { host: string; port?: number; ts: number }>();
const dnsCache = new Map<string, { ips: string[]; ts: number }>();
const DNS_TTL_MS = 5 * 60 * 1000;

// timestamp of the last VOICE_SERVER_UPDATE / room join - used to drop stale
// transport captures that belong to a PREVIOUS room (fixes wrong IP on first
// join after login/restart)
let lastRoomChange = 0;

function captureTransport(conn: any, opts: any) {
    if (!opts || typeof opts !== "object") return;
    const address = typeof opts.address === "string" ? opts.address.trim() : undefined;
    const port = isPortNumber(opts.port) ? opts.port : undefined;
    if (!address && port == null) return;
    const id = conn?.mediaEngineConnectionId ?? `anon${transports.size}`;
    transports.set(id, { address, port, ts: Date.now() });
}

/**
 * Monkey-patch the shared prototype's initialize() so EVERY connection
 * (current and future) reports its transport options to us.
 */
function wrapConnectionPrototypes() {
    const engine = MediaEngineStore.getMediaEngine?.() as any;
    const conns = engine?.connections;
    if (!conns) return;
    for (const conn of conns) {
        const proto = Object.getPrototypeOf(conn);
        if (!proto || proto.__vcipProtoWrapped) continue;
        if (typeof proto.initialize !== "function") continue;
        // only wrap on the prototype if initialize is not an own property
        if (Object.prototype.hasOwnProperty.call(conn, "initialize")) continue;
        proto.__vcipProtoWrapped = true;
        const orig = proto.initialize;
        proto.initialize = function (this: any, opts: any) {
            try { captureTransport(this, opts); } catch { }
            return orig.call(this, opts);
        };
    }
}

/** Wrap per-instance initialize (connections that keep their own copy). */
function wrapConnection(conn: any) {
    if (!conn || conn.__vcipInstWrapped) return;
    conn.__vcipInstWrapped = true;
    if (typeof conn.initialize === "function") {
        const orig = conn.initialize.bind(conn);
        conn.initialize = (opts: any) => {
            try { captureTransport(conn, opts); } catch { }
            return orig(opts);
        };
    }
}

function ensureWrapping() {
    try {
        wrapConnectionPrototypes();
        const engine = MediaEngineStore.getMediaEngine?.() as any;
        for (const conn of engine?.connections ?? []) wrapConnection(conn);
    } catch { }
}

async function resolveHostCached(host: string): Promise<string[]> {
    if (isIPv4(host)) return [host];
    const cached = dnsCache.get(host);
    if (cached && Date.now() - cached.ts < DNS_TTL_MS) return cached.ips;
    const res = await Native.resolveVoiceHost(host).catch(() => null);
    const ips = res?.ok ? res.addresses : [];
    dnsCache.set(host, { ips, ts: Date.now() });
    return ips;
}

// ---------------------------------------------------------------------------
// endpoint resolution
// ---------------------------------------------------------------------------

function connId(conn: any, idx: number): string {
    return conn?.mediaEngineConnectionId ?? `conn${idx}`;
}

async function resolveEndpointFor(conn: any, id: string): Promise<{ ip: string; port: number | string } | null> {
    // Source priority (most → least trusted for the CURRENT room):
    //   1. VOICE_SERVER_UPDATE endpoint for this guild (fresh on every join)
    //   2. RTCConnectionStore hostname (the live connection's own transport)
    //   3. the transport options captured from initialize() AFTER we joined
    // A deep scan of the connection object is deliberately NOT trusted up-front:
    // right after a restart / first join the connection object can still hold a
    // PREVIOUS room's address, which is exactly the "wrong IP on first join"
    // bug. We only fall back to it as a last resort.

    const guildId = getRoomGuildId();
    const ep = endpointByGuild.get(guildId ?? "");
    const epAge = ep ? Date.now() - ep.ts : Infinity;
    const hostFromRtc = (() => {
        try { return RTCConnectionStore.getHostname?.() || undefined; } catch { return undefined; }
    })();

    // captured transport options (initialize call) - only trusted if captured
    // AFTER the current room was joined (drop stale transports from a prev room)
    const cap = transports.get(id);
    const hasFreshCap = !!(cap && cap.ts >= lastRoomChange);

    let address: string | undefined;
    let port: number | string | undefined;

    // --- Trusted current-room sources first --------------------------------
    // 1) The transport options captured from initialize() for THIS live
    //    connection. This is the newest, most accurate source: it is read from
    //    the actual connection object right now (covers restart-in-place where
    //    no fresh VOICE_SERVER_UPDATE may arrive).
    if (hasFreshCap && cap.address) {
        address = cap.address;
        port = cap.port ?? port;
    }

    // 2) The guild's VOICE_SERVER_UPDATE endpoint while it is reasonably fresh
    //    (authoritative host Discord told us for THIS room).
    if (!address && ep?.host && epAge < 90_000) {
        address = ep.host;
        port = ep.port ?? port;
    }

    // 3) The live connection's own hostname (skip placeholder values).
    if (!address && hostFromRtc && hostFromRtc !== "0.0.0.0") {
        address = hostFromRtc;
    }

    // --- Resolve hostname -> IP --------------------------------------------
    if (address) {
        if (isIPv4(address)) {
            return { ip: address, port: port ?? "?" };
        }
        const ips = await resolveHostCached(address);
        if (ips.length) return { ip: ips[0], port: port ?? "?" };
        return { ip: address, port: port ?? "?" };
    }

    // --- Last resort: deep scan the connection object ----------------------
    // Only reached when we have NO trusted current-room data. This can return a
    // stale/previous-room address, so we gate it behind a "settle" window and
    // never prefer it over fresh room data (which is handled above).
    if (Date.now() - lastRoomChange < 4000) {
        // Too soon after joining/restarting to trust leftover object state.
        return null;
    }
    const r = findAddrPort(conn)
        ?? (await Promise.resolve(conn?.getStats?.()).then(findAddrPort).catch(() => null));
    if (!r) return null;

    if (isIPv4(r.ip)) return { ip: r.ip, port: r.port ?? "?" };
    const ips = await resolveHostCached(r.ip);
    if (ips.length) return { ip: ips[0], port: r.port ?? "?" };
    return { ip: r.ip, port: r.port ?? "?" };
}

// tracks currently-active streamers per room so we only log "stream started" once
const activeStreamers = new Map<string, string>(); // key: room|owner -> start HH:MM:SS

function hhmmss(d = new Date()): string {
    return d.toLocaleTimeString("en-GB", { hour12: false });
}

async function getCurrentState(consume = true): Promise<CurrentState> {
    ensureWrapping();
    const state: CurrentState = { room: "", roomEp: null, streams: [], newStreams: [] };
    try {
        const engine = MediaEngineStore.getMediaEngine?.() as any;
        if (!engine?.connections) return state;
        const me = UserStore.getCurrentUser()?.id;
        const room = getRoomName();
        state.room = room;

        let vcEp: { ip: string; port: number | string } | null = null;
        const streamEps: { owner: string; ep: { ip: string; port: number | string } | null }[] = [];

        let i = 0;
        for (const conn of engine.connections as Set<any>) {
            const id = connId(conn, i++);
            if (!conn || conn.destroyed) continue;
            wrapConnection(conn);

            const isStreamConn = conn.context === "stream" || (conn.streamUserId != null && conn.streamUserId !== me);
            const res = await resolveEndpointFor(conn, id);
            if (!res) continue;

            if (isStreamConn) {
                const owner = conn.streamUserId === me ? "my stream" : userName(conn.streamUserId);
                streamEps.push({ owner, ep: res });
            } else if (!vcEp) {
                vcEp = res;
            }
        }

        state.roomEp = vcEp;

        if (room) {
            // merge in voice-channel members who are Go-Live streaming / on video
            // (covers cases without a dedicated stream connection)
            const chanStreamers = getRoomStreamers().filter(n => n && !streamEps.some(s => s.owner === n));
            for (const owner of chanStreamers) {
                streamEps.push({ owner, ep: null });
            }

            for (const s of streamEps) {
                if (!s.owner) continue;
                const key = `${room}|${s.owner}`;
                let ts = activeStreamers.get(key);
                const isNew = ts == null;
                if (isNew) {
                    ts = hhmmss();
                    // only register when consuming - display refreshes must not
                    // eat the "new stream" event before scanOnce() sees it
                    if (consume) activeStreamers.set(key, ts);
                }

                // stream IP = ONLY the stream's own dedicated endpoint, and only
                // when it differs from the room's (never duplicate the VC IP)
                let ip: string | undefined;
                let port: number | string | undefined;
                if (s.ep && (!vcEp || s.ep.ip !== vcEp.ip || s.ep.port !== vcEp.port)) {
                    ip = s.ep.ip;
                    port = s.ep.port;
                }

                state.streams.push({ owner: s.owner, ts: ts!, ip, port });
                if (isNew && consume) state.newStreams.push({ owner: s.owner, ts: ts!, ip, port });
            }
        }

        // drop streamers that are no longer active
        if (consume) {
            const liveKeys = new Set(state.streams.map(s => `${room}|${s.owner}`));
            for (const key of [...activeStreamers.keys()]) {
                if (!liveKeys.has(key)) activeStreamers.delete(key);
            }
        }
    } catch { }
    return state;
}

// ---------------------------------------------------------------------------
// history / webhook / capture
// ---------------------------------------------------------------------------

let history: CaptureEntry[] = [];
let historyLoaded = false;

async function loadHistory() {
    if (historyLoaded) return;
    historyLoaded = true;
    try {
        const h = await get<CaptureEntry[]>(HISTORY_KEY);
        if (Array.isArray(h)) history = h;
    } catch { }
    seenSet = new Set(history.map(e => keyOf(e.ip, e.port)));
    seenIps = new Set(history.map(e => e.ip));
}

async function saveHistory() {
    try {
        await set(HISTORY_KEY, history);
    } catch { }
}

// Discord refuses message content longer than 2000 characters
const WH_MAX = 2000;

function webhookTarget(): string {
    const raw = String(storeRef.voiceIPWebhookUrl ?? "").trim();
    if (!raw) return "";
    if (!/^https:\/\//i.test(raw)) return "";
    if (!/discord(?:app)?\.com\/api\//i.test(raw)) return "";
    return raw;
}

/**
 * POSTs one message to the configured Discord webhook from the MAIN process
 * (renderer CSP / CORS would otherwise block it).
 * Returns what the history row records: "sent" | "off" | "error …".
 */
async function postWebhook(content: string): Promise<string> {
    const url = webhookTarget();
    if (!url) return "off";
    try {
        const res = await Native.sendWebhookPost(url, JSON.stringify({ content: content.slice(0, WH_MAX) }));
        if (res?.ok) return "sent";
        return res?.status && res.status > 0 ? `error ${res.status}` : "error";
    } catch {
        return "error";
    }
}

// permanent dedupe: every ip:port is only ever logged/sent once
// (derived from the saved history, so it survives restarts)
let seenSet = new Set<string>();

// de-duplicate by IP ONLY: Discord rotates the UDP port every re-check while
// the server IP usually stays the same, so keying on ip:port re-sent the
// SAME ip every minute. With ip-only dedupe each unique server IP is
// captured/reported exactly once (first room that used it keeps the name).
let seenIps = new Set<string>();

function keyOf(ip: string, port: number | string) {
    return `${ip}:${port}`;
}

// long bold separator between room blocks in webhook messages
const WH_SEP = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

/** one block: separator ABOVE and BELOW so back-to-back captures never blend */
function whBlock(body: string): string {
    return `${WH_SEP}\n\n${body}\n\n${WH_SEP}`;
}

/** Log + webhook for the ROOM's own IP — happens once per unique server IP ever. */
async function reportRoomEndpoint(room: string, ep: { ip: string; port: number | string }) {
    // skip if this server IP was already captured (even if port changed)
    if (seenIps.has(ep.ip)) return;
    seenIps.add(ep.ip);

    const key = keyOf(ep.ip, ep.port);
    if (seenSet.has(key)) return; // port-dedupe safety net
    seenSet.add(key);

    const entry: CaptureEntry = {
        ts: hhmmss(),
        ip: ep.ip,
        port: ep.port,
        type: "vc",
        stream_owner: "",
        room,
        webhook: "",
        streams: [],
    };

    entry.webhook = await postWebhook(whBlock(
        `**Room:** ${room || "Unknown"}\n\n`
        + `**IP:PORT:** \`${ep.ip}:${ep.port}\`\n\n`
        + `**Time:** \`${entry.ts}\``
    ));

    history = [entry, ...history].slice(0, MAX_HISTORY);
    await saveHistory();

    if (storeRef.notify) {
        showNotification({
            title: "Room IP captured",
            body: `${ep.ip}:${ep.port}\n${room || "Unknown room"}`
                + (entry.webhook === "sent" ? "\nwebhook: sent" : ""),
            noPersist: true,
        });
    }
    listeners.forEach(l => l());
}

/**
 * Log + webhook for a stream START — no room IP repetition:
 * merged into the room's entry; webhook shows owner + time (stream IP only
 * when it differs from the room's).
 */
async function reportStreamStart(room: string, s: StreamLive) {
    // find the room's entry (most recent vc row with the same room name)
    let row = history.find(e => e.type === "vc" && e.room === room);
    let created = false;

    if (!row) {
        // no room row yet (e.g. watched a stream without a captured VC socket):
        // create one so the room still has an anchor. Use the stream's own
        // endpoint if we have one.
        row = {
            ts: s.ts,
            ip: s.ip ?? "?",
            port: s.port ?? "?",
            type: "vc",
            stream_owner: "",
            room,
            webhook: "",
            streams: [],
        };
        created = true;
    }

    row.streams ??= [];

    // same stream already recorded (e.g. Discord restarted while it was live)?
    // refresh its time in place instead of duplicating the record / webhook
    const existing = row.streams.find(x =>
        x.owner === s.owner
        && (x.ip ?? undefined) === (s.ip ?? undefined)
        && String(x.port ?? "") === String(s.port ?? "")
    );
    if (existing) {
        existing.ts = s.ts;
        if (created) {
            seenSet.add(keyOf(row.ip, row.port));
            row.webhook = await postWebhook(whBlock(
                `**Room:** ${room || "Unknown"}\n\n`
                + `**IP:PORT:** \`${row.ip}:${row.port}\`\n\n`
                + `**Time:** \`${row.ts}\``
            ));
            history = [row, ...history].slice(0, MAX_HISTORY);
        } else {
            history = [row, ...history.filter(e => e !== row)].slice(0, MAX_HISTORY);
        }
        await saveHistory();
        listeners.forEach(l => l());
        return;
    }

    row.streams = [
        { owner: s.owner, ts: s.ts, ip: s.ip, port: s.port },
        ...row.streams,
    ].slice(0, 30);

    if (created) {
        seenSet.add(keyOf(row.ip, row.port));
        row.webhook = await postWebhook(whBlock(
            `**Room:** ${room || "Unknown"}\n\n`
            + `**IP:PORT:** \`${row.ip}:${row.port}\`\n\n`
            + `**Time:** \`${row.ts}\``
        ));
        history = [row, ...history].slice(0, MAX_HISTORY);
    } else {
        // update in place (streams list) and keep it at the top
        // webhook: rooms only - stream events are NOT posted
        history = [row, ...history.filter(e => e !== row)].slice(0, MAX_HISTORY);
    }

    await saveHistory();

    if (storeRef.notify) {
        showNotification({
            title: "Stream started",
            body: `${s.owner}\n${room || "Unknown room"} — ${s.ts}`,
            noPersist: true,
        });
    }
    listeners.forEach(l => l());
}

async function scanOnce() {
    await loadHistory();
    const st = await getCurrentState();
    if (st.roomEp) {
        await reportRoomEndpoint(st.room, st.roomEp);
    }
    for (const s of st.newStreams) {
        await reportStreamStart(st.room, s);
    }
}

async function recheck() {
    await scanOnce();
}

async function clearHistory() {
    history = [];
    seenSet = new Set();
    seenIps = new Set();
    activeStreamers.clear();
    await saveHistory();
    listeners.forEach(l => l());
}

// ---------------------------------------------------------------------------
// polling
// ---------------------------------------------------------------------------

let pollTimer: ReturnType<typeof setInterval> | undefined;
const scheduled = new Set<number>();

function scheduleScan(delayMs: number) {
    if (scheduled.has(delayMs)) return;
    scheduled.add(delayMs);
    setTimeout(() => {
        scheduled.delete(delayMs);
        if (storeRef.autoCapture) scanOnce().catch(() => { });
    }, delayMs);
}

function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
        if (storeRef.enableVoiceIP && storeRef.autoCapture) scanOnce().catch(() => { });
    }, 10000); // background: every 10 seconds (as requested)
}

function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const GrabberIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg
        width={width}
        height={height}
        className={className}
        viewBox="0 0 24 24"
    >
        <path
            fill="currentColor"
            d="M12 2a10 10 0 0 0-10 10 10 10 0 0 0 10 10 10 10 0 0 0 10-10A10 10 0 0 0 12 2m0 2c1.95 0 3.73.7 5.12 1.86A2.5 2.5 0 0 0 15 8.5 2.5 2.5 0 0 0 17.5 11c.57 0 1.09-.19 1.51-.51.32.95.49 1.96.49 3.01 0 4.96-4.04 9-9 9-.64 0-1.26-.07-1.86-.19 1.14-1.34 1.86-3.01 1.86-4.81 0-.9-.18-1.76-.49-2.55.74.34 1.56.55 2.49.55 1.28 0 2.46-.37 3.5-1a1 1 0 0 0-1-1.73c-.77.45-1.6.73-2.5.73a4.5 4.5 0 0 1-4.5-4.5c0-1.19.46-2.28 1.22-3.08A7.94 7.94 0 0 1 12 4"
        />
    </svg>
);

function useForceUpdate() {
    const [, setTick] = React.useState(0);
    return () => setTick(t => t + 1);
}

function GrabberPanel(props: any) {
    const refresh = useForceUpdate();
    const [entries, setEntries] = React.useState<CaptureEntry[]>([]);
    const [cur, setCur] = React.useState<CurrentState>({ room: "", roomEp: null, streams: [], newStreams: [] });
    const [whUrl, setWhUrl] = React.useState(String(storeRef.voiceIPWebhookUrl ?? ""));
    const [whMsg, setWhMsg] = React.useState("");
    const [whBusy, setWhBusy] = React.useState(false);

    React.useEffect(() => {
        loadHistory().then(() => setEntries([...history]));
        const onChange = () => setEntries([...history]);
        listeners.add(onChange);
        scanOnce().catch(() => { });

        const ivl = setInterval(async () => {
            setEntries([...history]);
            setCur(await getCurrentState(false));
            if (storeRef.autoCapture) scanOnce().catch(() => { });
        }, 2000); // open panel: faster refresh + re-check every 2s
        return () => {
            listeners.delete(onChange);
            clearInterval(ivl);
        };
    }, []);

    const copyEp = async (ip: string, port?: number | string) => {
        if (port == null) { copyWithToast("", "No port to copy"); return; }
        const text = `${ip}:${port}`;
        try {
            const r = await Native.copyText(text);
            if (r?.ok) return copyWithToast(text, `Copied ${text}`);
        } catch { }
        copyWithToast(text, `Copied ${text}`);
    };

    // copy stream IP: uses the stream's own endpoint when it has one,
    // otherwise the room IP (the stream is relayed through it)
    const copyStream = async (s: { ip?: string; port?: number | string }, roomIp?: string, roomPort?: number | string) => {
        if (s.ip) copyEp(s.ip, s.port);
        else if (roomIp) copyEp(roomIp, roomPort);
        else copyWithToast("", "No IP to copy");
    };

    // ---- discord webhook -------------------------------------------------
    const saveWebhook = () => {
        storeRef.voiceIPWebhookUrl = whUrl.trim();
        setWhMsg(whUrl.trim() ? "Saved — new captures will be posted." : "Saved — webhook is off.");
    };

    const clearWebhook = () => {
        storeRef.voiceIPWebhookUrl = "";
        setWhUrl("");
        setWhMsg("Webhook cleared.");
    };

    const testWebhook = async () => {
        const url = whUrl.trim();
        if (!url) { setWhMsg("Paste a webhook URL first."); return; }
        if (!/^https:\/\/discord(?:app)?\.com\/api\//i.test(url)) {
            setWhMsg("That does not look like a Discord webhook URL.");
            return;
        }
        storeRef.voiceIPWebhookUrl = url;
        setWhBusy(true);
        setWhMsg("Sending test message…");
        const r = await postWebhook(whBlock(
            "**Voice IP Grabber**\n\n"
            + "Webhook test — every captured room IP will be posted here."
        ));
        setWhBusy(false);
        setWhMsg(r === "sent"
            ? "Test message delivered."
            : r === "off" ? "No webhook URL configured."
                : `Failed to post (${r}).`);
    };

    // small transparent chip around an IP
    const ipChip: React.CSSProperties = {
        background: "rgba(255,255,255,0.07)",
        border: "1px solid rgba(255,255,255,0.18)",
        borderRadius: 6,
        padding: "2px 8px",
        display: "inline-block",
    };

    // room-name badge frame
    const roomBadge = (color: string): React.CSSProperties => ({
        display: "inline-block",
        padding: "4px 14px",
        borderRadius: 12,
        border: `2px solid ${color}`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        color,
        fontSize: 20,
        fontWeight: 800,
        lineHeight: 1.35,
    });

    return (
        <Modal
            {...props}
            size="lg"
            title="Voice IP Grabber — Room & Stream IPs"
        >
            <div style={{ padding: "8px 16px 16px" }}>
                <Forms.FormTitle tag="h5">Current Connection</Forms.FormTitle>
                <div
                    style={{
                        border: "1px solid rgba(255,255,255,0.16)",
                        borderRadius: 10,
                        background: "rgba(255,255,255,0.04)",
                        padding: 12,
                        margin: "4px 0 14px",
                    }}
                >
                    {cur.room ? (
                        <div style={{ marginBottom: 8 }}>
                            <span style={roomBadge("var(--red-360)")}>
                                #{getRoomParts().channel}
                                {getRoomParts().guild && (
                                    <span style={{ opacity: .75, fontWeight: 600, fontSize: 15 }}>
                                        {"  ·  "}{getRoomParts().guild}
                                    </span>
                                )}
                            </span>
                        </div>
                    ) : (
                        <div style={{ color: "var(--red-360)", fontSize: 16, fontWeight: 700 }}>
                            Not in a voice channel
                        </div>
                    )}
                    {cur.roomEp ? (
                        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                            <div>
                                <code
                                    style={{ ...ipChip, fontSize: 18, fontWeight: 700, color: "#FFF", cursor: "pointer" }}
                                    onClick={() => copyEp(cur.roomEp!.ip, cur.roomEp!.port)}
                                    title="Click to copy"
                                >
                                    {cur.roomEp.ip}:{cur.roomEp.port}
                                </code>
                                <div style={{ opacity: .65, fontSize: 11, marginTop: 3 }}>VC</div>
                            </div>
                            <div style={{ textAlign: "right" }}>
                                {cur.streams.map(s => (
                                    <div
                                        key={s.owner}
                                        style={{ color: "var(--green-360)", fontSize: 12, cursor: "pointer", marginBottom: 4 }}
                                        onClick={() => copyStream(s, cur.roomEp?.ip, cur.roomEp?.port)}
                                        title="Click to copy"
                                    >
                                        {s.owner}
                                        {s.ip && (
                                            <code
                                                style={{
                                                    ...ipChip,
                                                    marginLeft: 6,
                                                    fontSize: 11,
                                                    color: "var(--green-360)",
                                                    background: "rgba(0,255,120,0.07)",
                                                    borderColor: "rgba(0,255,120,0.25)",
                                                }}
                                            >
                                                {s.ip}:{s.port}
                                            </code>
                                        )}
                                        {"  "}{s.ts}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : (
                        cur.room && <Forms.FormText>Capturing server IP…</Forms.FormText>
                    )}
                </div>

                <Forms.FormTitle tag="h5">History — All rooms you joined</Forms.FormTitle>
                <div style={{ maxHeight: 380, overflowY: "auto", marginBottom: 8 }}>
                    {entries.length === 0 ? (
                        <Forms.FormText>Nothing saved yet.</Forms.FormText>
                    ) : (
                        entries.map((e, i) => (
                            <div
                                key={i}
                                style={{
                                    padding: "10px 0",
                                    borderBottom: i < entries.length - 1 ? "1px dashed var(--background-modifier-accent)" : undefined,
                                }}
                            >
                                <div style={{ marginBottom: 6 }}>
                                    <span style={roomBadge("#FF69B4")}>
                                        {e.room || "?"}
                                    </span>
                                </div>
                                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                                    <div>
                                        <code
                                            style={{ ...ipChip, fontSize: 17, fontWeight: 700, color: "#FFF", cursor: "pointer" }}
                                            onClick={() => copyEp(e.ip, e.port)}
                                            title="Click to copy"
                                        >
                                            {e.ip}:{e.port}
                                        </code>
                                        <span style={{ opacity: .7, fontSize: 12, marginLeft: 10 }}>{e.ts}</span>
                                        {e.webhook === "sent" ? <span style={{ color: "var(--green-360)", fontSize: 12, marginLeft: 6 }}>✔ webhook</span> : ""}
                                        <div style={{ opacity: .65, fontSize: 11, marginTop: 3 }}>VC</div>
                                    </div>
                                    <div style={{ textAlign: "right" }}>
                                        {(e.streams ?? []).map((s, j) => (
                                            <div
                                                key={j}
                                                style={{ color: "var(--green-360)", fontSize: 12, cursor: "pointer", marginBottom: 4 }}
                                                onClick={() => copyStream(s, e.ip, e.port)}
                                                title="Click to copy"
                                            >
                                                {s.owner}
                                                {s.ip && (
                                                    <code
                                                        style={{
                                                            ...ipChip,
                                                            marginLeft: 6,
                                                            fontSize: 11,
                                                            color: "var(--green-360)",
                                                            background: "rgba(0,255,120,0.07)",
                                                            borderColor: "rgba(0,255,120,0.25)",
                                                        }}
                                                    >
                                                        {s.ip}:{s.port}
                                                    </code>
                                                )}
                                                {"  "}{s.ts}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                <Forms.FormTitle tag="h5">Discord webhook</Forms.FormTitle>
                <div
                    style={{
                        border: "1px solid rgba(255,255,255,0.16)",
                        borderRadius: 10,
                        background: "rgba(255,255,255,0.04)",
                        padding: 12,
                        margin: "4px 0 14px",
                    }}
                >
                    <Field
                        label="Webhook URL"
                        hint="Settings → Webhooks → New webhook → Copy URL. Each captured room becomes one message, separated by a bold rule."
                    >
                        <Input
                            value={whUrl}
                            spellCheck={false}
                            placeholder="https://discord.com/api/webhooks/…"
                            onChange={e => { setWhUrl(e.currentTarget.value); setWhMsg(""); }}
                        />
                    </Field>

                    <div className={CLS.btnRow} style={{ marginTop: 4 }}>
                        <Button size="sm" variant="primary" onClick={saveWebhook}>Save</Button>
                        <Button size="sm" onClick={testWebhook} disabled={whBusy}>
                            {whBusy ? "Sending…" : "Send test"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={clearWebhook}>Clear</Button>
                        <span style={{ fontSize: 12, alignSelf: "center", marginLeft: 4 }}>
                            {webhookTarget()
                                ? <span style={{ color: "var(--green-360)" }}>● on</span>
                                : <span style={{ opacity: .6 }}>● off</span>}
                        </span>
                    </div>

                    {whMsg && <Forms.FormText style={{ marginTop: 6 }}>{whMsg}</Forms.FormText>}
                </div>

                <div className={CLS.btnRow} style={{ marginTop: 8 }}>
                    <Button size="sm" onClick={() => recheck().then(refresh)}>Re-check</Button>
                    <Button size="sm" onClick={() => {
                        if (cur.roomEp) copyEp(cur.roomEp.ip, cur.roomEp.port);
                        else copyWithToast("", "No voice connection");
                    }}>Copy Current IP</Button>
                    <Button size="sm" onClick={() => clearHistory().then(refresh)}>Clear History</Button>
                </div>

                <Forms.FormText style={{ marginTop: 8, opacity: .7 }}>
                    This is the IP of Discord's voice servers your device connects to (same as the standalone tool captured).
                </Forms.FormText>
            </div>
        </Modal>
    );
}

// dedicated button in the TOP titlebar (same place as the Vencord toolbox icon)
function IpHeaderButton() {
    return (
        <TitlebarButton id="voiceip" tooltip="Voice IP Grabber — Room IPs" onClick={() => openModal(props => <GrabberPanel {...props} />)}>
            <GrabberIcon width={18} height={18} />
        </TitlebarButton>
    );
}

// ---------------------------------------------------------------------------
// module exports (wired together by pnygo's index.tsx)
// ---------------------------------------------------------------------------

export function IpHeaderButton_() {
    return (
        <ErrorBoundary key="vc-ip-titlebar" noop>
            <IpHeaderButton />
        </ErrorBoundary>
    );
}

export const toolboxActions = {
    "Voice IP panel": () => openModal(props => <GrabberPanel {...props} />),
    "Re-check IPs": () => recheck(),
};

export const flux = {
    VOICE_SERVER_UPDATE: (data: any) => {
        if (!storeRef.enableVoiceIP) return;
        try {
            if (data?.endpoint) {
                const [host, portStr] = String(data.endpoint).split(":");
                if (host) {
                    endpointByGuild.set(data.guildId, {
                        host,
                        port: portStr ? Number(portStr) : undefined,
                        ts: Date.now(),
                    });
                    // new room join -> clear stale transports so we never read a
                    // previous room's endpoint as if it were the current one
                    transports.clear();
                    lastRoomChange = Date.now();
                }
            }
        } catch { }
        scheduleScan(50);
        scheduleScan(200);
        scheduleScan(1500);
        scheduleScan(4000);
    },
    STREAM_CREATE: () => {
        if (!storeRef.enableVoiceIP) return;
        scheduleScan(50);
        scheduleScan(1000);
        scheduleScan(3000);
    },
    STREAM_DELETE: () => {
        if (storeRef.enableVoiceIP) scheduleScan(50);
    },
    VOICE_CHANNEL_SELECT: (data: any) => {
        // user switched the selected voice channel - treat as a room change so
        // we re-capture promptly and don't mistake a previous room's endpoint
        // for the current one
        if (!storeRef.enableVoiceIP) return;
        try {
            if (data?.channelId) {
                transports.clear();
                lastRoomChange = Date.now();
            }
        } catch { }
        scheduleScan(50);
        scheduleScan(500);
    },
};

export function start(store: Record<string, any>) {
    storeRef = store;
    // fresh session: discard any endpoint/transport data left over from a
    // previous session so we never report a stale room's IP on first join
    transports.clear();
    endpointByGuild.clear();
    dnsCache.clear();
    lastRoomChange = Date.now();
    loadHistory().catch(() => { });
    ensureWrapping();
    startPolling();
    // capture promptly on load (user may already be sitting in a voice room)
    scheduleScan(100);
    scheduleScan(800);
}

export function stop() {
    stopPolling();
}

