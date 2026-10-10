/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * pnygo - JoinVCFriend submodule
 *
 * Watches a list of Discord user ids (settings). The moment one of them sits
 * down in a voice channel, THIS client sends a DM to that person containing a
 * link to the room they just entered — and again every time they move to a
 * DIFFERENT room. The link is a normal `https://discord.com/channels/...` so a
 * tap on the message jumps straight to that room.
 *
 * The message is a REAL Discord message (Discord's own send path), so it shows
 * up in the DM for both sides. Nothing is patched, nothing is local-only — the
 * feature only listens to VOICE_STATE_UPDATES.
 *
 * No duplicates: the room every watched account is sitting in is remembered for
 * the session, so mute / deafen / stream / camera changes in the SAME room are
 * ignored. Leaving a room clears the memory, which means rejoining it later
 * sends again (that is a new join, not a duplicate).
 *
 * Everything runs inside try/catch and reads the stores lazily, so a missing
 * store or a payload Discord changed can never take the dispatcher down.
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { copyWithToast, sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { ChannelActionCreators, ChannelStore, GuildMemberStore, GuildStore, Modal, React, showToast, Toasts, UserStore, VoiceStateStore } from "@webpack/common";

import { hit } from "./probe";
import { Button, Card, Chip, CLS, Field, formatClock, Input, Muted, openPanel, Switch, TextArea, TitlebarButton, VIcon } from "./ui";

const logger = new Logger("pnygo/JoinVCFriend");

/** set from the merged plugin's start() */
let storeRef: Record<string, any> = {};

/** room each watched account sits in right now (session memory) */
const lastChannel = new Map<string, string>();
/** accounts whose message is waiting for the cooldown to expire */
const pending = new Set<string>();
/** when each account was last notified (cooldown) */
const lastSent = new Map<string, number>();

interface SentEntry {
    userId: string;
    name: string;
    link: string;
    at: number;
    ok: boolean;
}
/** newest first, what this feature sent while Discord is open */
const log: SentEntry[] = [];
const LOG_MAX = 30;
/** true once the first voice batch was seen — proves the event name is right */
let sawBatch = false;

function enabled(): boolean {
    return storeRef?.enableJoinVcFriend !== false;
}

/** the ids from the setting — any run of 15..25 digits, everything else ignored */
export function parsedIds(raw?: string): string[] {
    const text = String(raw ?? storeRef?.joinvcfriendIds ?? "");
    const out: string[] = [];
    for (const chunk of text.split(/[^0-9]+/)) {
        if (chunk.length >= 15 && chunk.length <= 25 && !out.includes(chunk)) out.push(chunk);
    }
    return out;
}

function watched(): Set<string> {
    return new Set(parsedIds());
}

function myId(): string {
    try {
        return String(UserStore.getCurrentUser?.()?.id ?? "");
    } catch {
        return "";
    }
}

function displayName(userId: string): string {
    try {
        const u: any = UserStore.getUser?.(userId);
        return String(u?.globalName || u?.global_name || u?.displayName || u?.username || "Someone");
    } catch {
        return "Someone";
    }
}

/** `.../channels/<guild>/<room>` in a server, `.../channels/@me/<room>` in a call */
function roomLink(guildId: string, channelId: string): string {
    return /^\d{15,25}$/.test(guildId)
        ? `https://discord.com/channels/${guildId}/${channelId}`
        : `https://discord.com/channels/@me/${channelId}`;
}

function buildMessage(name: string, link: string): string {
    const tpl = String(storeRef?.joinvcfriendMessage || "🎙️ {name} دخل الروم: {link}");
    const text = tpl
        .replaceAll("{name}", name)
        .replaceAll("{link}", link)
        .trim();
    return text || `${name}: ${link}`;
}

function cooldownMs(): number {
    const seconds = Number(storeRef?.joinvcfriendCooldown);
    return Math.max(1, Number.isFinite(seconds) && seconds > 0 ? seconds : 3) * 1000;
}

function pushLog(entry: SentEntry): void {
    try {
        log.unshift(entry);
        if (log.length > LOG_MAX) log.length = LOG_MAX;
    } catch { /* never break a send over the log */ }
}

/** remember where a watched account already sits, so a state change is not read as a join */
function seedUser(userId: string): void {
    try {
        let channelId = VoiceStateStore.getVoiceStateForUser?.(userId)?.channelId;
        if (!channelId) {
            const all: Record<string, any> = VoiceStateStore.getAllVoiceStates?.() ?? {};
            for (const guildId of Object.keys(all)) {
                const state = all[guildId]?.[userId];
                if (state?.channelId) {
                    channelId = state.channelId;
                    break;
                }
            }
        }
        if (channelId) lastChannel.set(userId, String(channelId));
    } catch { /* store not ready */ }
}

/** the DM channel with that account, created when it does not exist yet */
async function ensureDm(userId: string): Promise<string> {
    let dmId = ChannelStore.getDMFromUserId?.(userId) ?? "";
    if (dmId) return dmId;

    try {
        ChannelActionCreators.openPrivateChannel(userId);
    } catch (e) {
        logger.warn("openPrivateChannel failed:", e);
    }

    for (let i = 0; i < 20 && !dmId; i++) {
        await new Promise(resolve => setTimeout(resolve, 150));
        dmId = ChannelStore.getDMFromUserId?.(userId) ?? "";
    }
    return dmId;
}

async function notify(userId: string, channelId: string, guildId: string): Promise<void> {
    const wait = (lastSent.get(userId) ?? 0) + cooldownMs() - Date.now();
    if (wait > 0) {
        // too soon for this account — send it as soon as the cooldown is over
        if (pending.has(userId)) return;
        pending.add(userId);
        setTimeout(() => {
            pending.delete(userId);
            void notify(userId, channelId, guildId);
        }, wait + 25);
        return;
    }
    lastSent.set(userId, Date.now());

    const name = displayName(userId);
    const link = roomLink(guildId, channelId);
    try {
        const dmId = await ensureDm(userId);
        if (!dmId) throw new Error("no DM channel for " + userId);

        await sendMessage(dmId, { content: buildMessage(name, link) });
        pushLog({ userId, name, link, at: Date.now(), ok: true });
        logger.info(`joinvc: room link sent to ${name} (${userId}) -> ${link}`);
        showToast(`JoinVC — room link sent to ${name}`, Toasts.Type.SUCCESS);
    } catch (e) {
        logger.warn(`could not send the room link to ${userId}:`, e);
        pushLog({ userId, name, link, at: Date.now(), ok: false });
        showToast(`JoinVC — could not send the room link to ${name}`, Toasts.Type.FAILURE);
    }
}

function handleVoiceState(state: any): void {
    if (!enabled()) return;

    const userId = String(state?.userId ?? "");
    if (!/^\d{15,25}$/.test(userId)) return;
    if (userId === myId()) return;
    if (!watched().has(userId)) return;

    const channelId = String(state?.channelId ?? "");
    if (!channelId) {
        // left the room: rejoining later counts as a new join again
        lastChannel.delete(userId);
        return;
    }

    const oldChannelId = String(state?.oldChannelId ?? "");
    const previous = lastChannel.get(userId);
    if (previous === channelId) {
        logger.debug(`joinvc: ${userId} stayed in ${channelId} (state change only)`);
        return; // same room: mute/deafen/stream/...
    }
    if (oldChannelId === channelId) {
        logger.debug(`joinvc: ${userId} did not move (${channelId})`);
        return; // Discord says they did not move
    }
    lastChannel.set(userId, channelId);

    const guildId = String(state?.guildId ?? state?.guild_id ?? "");
    if (storeRef?.joinvcfriendOnlyMutual) {
        try {
            const shared = !!guildId && !!GuildStore.getGuild?.(guildId) && !!GuildMemberStore.getMember?.(guildId, userId);
            if (!shared) {
                logger.debug(`joinvc: skipped ${userId} — no shared server for ${guildId}`);
                return;
            }
        } catch {
            return;
        }
    }

    logger.info(`joinvc: ${previous ? "moved" : "joined"} — ${userId} -> ${channelId} (guild ${guildId || "dm"}, was ${previous ?? "nothing"})`);
    void notify(userId, channelId, guildId);
}

function handleVoiceStates(states: any): void {
    try {
        if (!Array.isArray(states)) return;
        if (!sawBatch) {
            sawBatch = true;
            logger.info(`joinvc: voice events are flowing (${states.length} state(s) in this batch)`);
        }
        for (const state of states) handleVoiceState(state);
    } catch (e) {
        // the dispatcher must never see this throw
        logger.error("voice state handling failed:", e);
    }
}

// ---------------------------------------------------------------------------
// panel (titlebar V button + the toolbox action open it)
// ---------------------------------------------------------------------------

function JoinVcPanel(props: any) {
    const { onClose } = props;

    const [ids, setIds] = React.useState(String(storeRef?.joinvcfriendIds ?? ""));
    const [draft, setDraft] = React.useState("");
    const [template, setTemplate] = React.useState(String(storeRef?.joinvcfriendMessage ?? ""));
    const [cooldown, setCooldown] = React.useState(String(storeRef?.joinvcfriendCooldown ?? 3));
    const [err, setErr] = React.useState("");
    const [, bump] = React.useReducer((x: number) => x + 1, 0);

    // the log is filled by the flux handler while this panel is open
    React.useEffect(() => {
        const timer = setInterval(bump, 1500);
        return () => clearInterval(timer);
    }, []);

    const persistIds = (raw: string) => {
        setIds(raw);
        try { storeRef.joinvcfriendIds = raw; } catch { /* settings not writable */ }
    };

    const list = parsedIds(ids);

    const add = () => {
        const id = (draft.match(/\d{15,25}/) ?? [""])[0];
        if (!id) {
            setErr("That is not a valid Discord user ID — it is 15 to 25 digits.");
            return;
        }
        if (list.includes(id)) {
            setErr("That ID is already on the list.");
            return;
        }
        setErr("");
        setDraft("");
        persistIds([...list, id].join(", "));
        seedUser(id);
    };

    return (
        <Modal
            {...props}
            size="md"
            title="JoinVC friend"
            actions={[{ text: "Close", variant: "secondary", onClick: onClose }]}
        >
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <Muted style={{ color: "var(--text-warning)", fontSize: 12 }}>
                    The message below is really sent on Discord — it lands in that person's DMs and
                    they can read it. It is NOT a local edit like the other pnygo features.
                    <br />
                    الرسالة دي بتتبعت فعليًا على ديسكورد — مش تعديل محلي زي باقي ميزات pnygo.
                </Muted>

                <Switch
                    checked={enabled()}
                    onChange={v => { try { storeRef.enableJoinVcFriend = v; } catch { } bump(); }}
                    label="Watch the accounts below"
                    hint="Turn the whole feature off without losing the list."
                />

                <Field
                    label="Watched accounts"
                    hint="Several ids — separated by comma, space or a new line. Any run of 15 to 25 digits counts."
                >
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                        {list.length === 0 && <Muted>No account watched yet.</Muted>}
                        {list.map(id => (
                            <span
                                key={id}
                                className={CLS.chip}
                                style={{ display: "inline-flex", alignItems: "center", gap: 6, fontVariantNumeric: "tabular-nums" }}
                            >
                                {id}
                                <button
                                    type="button"
                                    aria-label={`Stop watching ${id}`}
                                    onClick={() => { persistIds(list.filter(x => x !== id).join(", ")); lastChannel.delete(id); }}
                                    style={{ background: "none", border: 0, color: "inherit", cursor: "pointer", padding: 0, lineHeight: 1 }}
                                >
                                    ×
                                </button>
                            </span>
                        ))}
                    </div>
                </Field>

                <Field label="Add an account">
                    <div style={{ display: "flex", gap: 8 }}>
                        <Input
                            value={draft}
                            spellCheck={false}
                            placeholder="User ID or https://discord.com/users/…"
                            onChange={e => { setDraft(e.currentTarget.value); setErr(""); }}
                            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
                        />
                        <Button variant="primary" onClick={add}>Add</Button>
                    </div>
                    {err && <span className={CLS.hint} style={{ color: "var(--red-400)" }}>{err}</span>}
                </Field>

                <Field
                    label="Message sent to their DM"
                    hint="{name} becomes their display name, {link} becomes the room link."
                >
                    <TextArea
                        rows={2}
                        spellCheck={false}
                        value={template}
                        onChange={e => {
                            const v = e.currentTarget.value;
                            setTemplate(v);
                            try { storeRef.joinvcfriendMessage = v; } catch { }
                        }}
                    />
                </Field>

                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <Field label="Cooldown (seconds)" style={{ flex: "1 1 140px" }}>
                        <Input
                            type="number"
                            min={1}
                            max={3600}
                            value={cooldown}
                            onChange={e => {
                                const v = e.currentTarget.value;
                                setCooldown(v);
                                const n = Number(v);
                                try { storeRef.joinvcfriendCooldown = Number.isFinite(n) && n >= 1 ? n : 3; } catch { }
                            }}
                        />
                    </Field>

                    <div style={{ flex: "1 1 220px", display: "flex", alignItems: "center" }}>
                        <Switch
                            checked={!!storeRef?.joinvcfriendOnlyMutual}
                            onChange={v => { try { storeRef.joinvcfriendOnlyMutual = v; } catch { } bump(); }}
                            label="Only in servers you share"
                            hint="Skips private calls and servers where you are not a member too."
                        />
                    </div>
                </div>

                <Card title="Sent this session" subtitle="Newest first. Nothing is stored after Discord restarts.">
                    {log.length === 0 ? (
                        <Muted>
                            Nothing sent yet. Add an id above — the message goes out the moment that
                            account joins a voice room.
                        </Muted>
                    ) : (
                        <div style={{ display: "flex", flexDirection: "column" }}>
                            {log.map((entry, i) => (
                                <div
                                    key={`${entry.at}-${i}`}
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 8,
                                        padding: "5px 0",
                                        borderBottom: "1px dashed var(--background-modifier-accent)",
                                    }}
                                >
                                    <span style={{ opacity: .7, fontVariantNumeric: "tabular-nums" }}>{formatClock(entry.at)}</span>
                                    <span style={{ fontWeight: 600 }}>{entry.name}</span>
                                    <span
                                        title={entry.link}
                                        style={{ flex: 1, minWidth: 0, opacity: .75, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                    >
                                        {entry.link}
                                    </span>
                                    <Chip tone={entry.ok ? "ok" : "bad"}>{entry.ok ? "sent" : "failed"}</Chip>
                                    <Button size="sm" variant="ghost" onClick={() => void copyWithToast(entry.link, "Room link copied")}>
                                        copy
                                    </Button>
                                </div>
                            ))}
                        </div>
                    )}
                </Card>
            </div>
        </Modal>
    );
}

/** opens the panel (and counts as a live self-check probe) */
export function openJoinVcFriend(): boolean {
    hit("joinvc");
    return openPanel(props => <JoinVcPanel {...props} />);
}

// ---------------------------------------------------------------------------
// wiring (index.tsx pulls all of this in)
// ---------------------------------------------------------------------------

function JoinHeaderButton() {
    return (
        <TitlebarButton
            id="joinvc"
            tooltip="JoinVC friend — DM a watched account the link of the room they join"
            onClick={() => openJoinVcFriend()}
        >
            <VIcon size={18} />
        </TitlebarButton>
    );
}

export function JoinVcFriendHeaderButton_() {
    return (
        <ErrorBoundary key="vc-joinvc-titlebar" noop>
            <JoinHeaderButton />
        </ErrorBoundary>
    );
}

export const toolboxActions = {
    "JoinVC friend: open panel": () => openJoinVcFriend(),
};

export const flux = {
    VOICE_STATE_UPDATES: ({ voiceStates }: { voiceStates: any[]; }) => handleVoiceStates(voiceStates),
    VOICE_STATE_UPDATE: (data: any) => handleVoiceStates([data]),
};

export function start(store: Record<string, any>): void {
    storeRef = store ?? {};
    lastChannel.clear();
    pending.clear();
    lastSent.clear();
    log.length = 0;
    sawBatch = false;

    // remember the rooms watched accounts are already sitting in
    seedAll();

    const ids = parsedIds();
    logger.info(`joinvc: ${enabled() ? "armed" : "DISABLED in settings"}, watching ${ids.length} id(s)${ids.length ? `: ${ids.join(", ")}` : ""}`);
}

/** re-read the room of every watched account (used after the feature was off for a while) */
export function seedAll(): void {
    try {
        for (const id of parsedIds()) seedUser(id);
    } catch { /* nothing to seed */ }
}

export function stop(): void {
    storeRef = {};
    lastChannel.clear();
    pending.clear();
    lastSent.clear();
    log.length = 0;
    sawBatch = false;
}
