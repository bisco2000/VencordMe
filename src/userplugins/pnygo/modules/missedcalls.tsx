/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./missedcalls.css";

import { addContextMenuPatch, NavContextMenuPatchCallback, removeContextMenuPatch } from "@api/ContextMenu";
import { Logger } from "@utils/Logger";
import { OptionType } from "@utils/types";
import { ChannelStore, Menu, Modal, React, showToast, UserStore } from "@webpack/common";

import { hit } from "./probe";
import {
    Button,
    Card,
    CLS,
    Empty,
    Field,
    formatClock,
    fromLocalInputValue,
    ICON_PATHS,
    Icons,
    Input,
    Muted,
    openPanel,
    Select,
    svgIcon,
    toLocalInputValue,
} from "./ui";

const logger = new Logger("pnygo/MissedCalls");

const ROW_ATTR = "data-vc-pnygo-callrow";
const GROUP_ATTR = "data-vc-pnygo-callgroup";

// set from the merged plugin's start()
let storeRef: Record<string, any> = {};

// ---------------------------------------------------------------------------
// model — memory only, exactly as requested (no DataStore, no localStorage)
// ---------------------------------------------------------------------------

/** the only three lines Discord draws in a private call log */
export type CallKind = "outgoing" | "incoming" | "missed";

/** which side of the anchor message the row is drawn on */
export type CallSide = "above" | "below";

export interface CallRow {
    channelId: string;
    /** unique per call: one chat can hold any number of calls, even on one message */
    uid: string;
    /**
     * where the row lives in the conversation:
     *   "__top__"    -> on the first message currently in the list
     *   "__bottom__" -> after the last message currently in the list
     *   "<messageId> -> on that message (see `side` for the exact side)
     */
    anchor: string;
    /** above the message or right below it (ignored by "__bottom__") */
    side: CallSide;
    kind: CallKind;
    durationSec: number;
    ts: number;
    /** the other person's display name (only used by "incoming" / "missed") */
    name: string;
}

/** anchor used when the row must follow the end of the conversation */
export const ANCHOR_TOP = "__top__";
export const ANCHOR_BOTTOM = "__bottom__";

function newUid(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** rows are keyed per CALL, so a chat can hold several of them */
function rowKey(call: Pick<CallRow, "channelId" | "uid">): string {
    return `${call.channelId}:${call.uid}`;
}

/** calls sharing one place on screen are wrapped in a single container */
function groupKey(call: Pick<CallRow, "channelId" | "anchor" | "side">): string {
    return `${call.channelId}:${call.anchor}:${call.side}`;
}

/** calls keyed by `channelId:uid` */
const calls = new Map<string, CallRow>();
/** live DOM nodes, so edits repaint instead of re-creating */
const rowNodes = new Map<string, HTMLElement>();
/** one wrapper div per place on screen, holding every row that sits there */
const groupNodes = new Map<string, HTMLElement>();

export function getCalls(): CallRow[] {
    return [...calls.values()].sort((a, b) => b.ts - a.ts);
}

/** every call sitting exactly on that anchor (several are allowed) */
export function callsInAnchor(channelId: string, anchor: string): CallRow[] {
    return [...calls.values()]
        .filter(c => c.channelId === channelId && c.anchor === anchor)
        .sort((a, b) => b.ts - a.ts);
}

export function hasCall(channelId: string, anchor: string): boolean {
    return callsInAnchor(channelId, anchor).length > 0;
}

/** every call in this chat, newest first */
export function callsInChannel(channelId: string): CallRow[] {
    return [...calls.values()]
        .filter(c => c.channelId === channelId)
        .sort((a, b) => b.ts - a.ts);
}

/** the newest call attached anywhere in this chat (if any) */
export function callInChannel(channelId: string): CallRow | undefined {
    return callsInChannel(channelId)[0];
}

const KIND_LABELS: Record<CallKind, string> = {
    outgoing: "I started a call",
    incoming: "They called me",
    missed: "Missed call — I did not answer",
};

const KIND_MENU_LABELS: Record<CallKind, string> = {
    outgoing: "I started a call",
    incoming: "They called me (answered)",
    missed: "They called me, I did not answer",
};

// ---------------------------------------------------------------------------
// defaults from the message the user clicked
// ---------------------------------------------------------------------------

const SNOWFLAKE_EPOCH = 1420070400000n;

function messageTimestamp(message: any): number {
    try {
        const fromField = new Date(message?.timestamp).getTime();
        if (Number.isFinite(fromField)) return fromField;
    } catch { /* fall through to the snowflake */ }
    try {
        return Number(BigInt(message.id) >> 22n) + Number(SNOWFLAKE_EPOCH);
    } catch {
        return Date.now();
    }
}

/** display name of the account that is NOT me in this conversation */
function friendName(channelId: string, message: any): string {
    let me: any = null;
    try { me = UserStore.getCurrentUser(); } catch { /* store not ready */ }

    try {
        const channel = ChannelStore.getChannel(channelId) as any;
        const ids: string[] = channel?.getRecipientIds?.() ?? [];
        for (const id of ids) {
            if (id === me?.id) continue;
            const user = UserStore.getUser(id) as any;
            const name = user?.globalName || user?.global_name || user?.username;
            if (name) return name;
        }
    } catch { /* not a DM */ }

    const author = message?.author;
    const name = author?.globalName || author?.global_name || author?.username;
    return name || "Them";
}

function defaultDuration(): number {
    const value = Number(storeRef.missedCallDefaultDuration);
    return Number.isFinite(value) && value >= 0 ? Math.min(86_400, value) : 4;
}

/** a call anchored to a message the user right-clicked */
function callFromMessage(message: any, kind: CallKind, side: CallSide = "above"): CallRow {
    const channelId = String(message?.channel_id ?? "");
    return {
        channelId,
        uid: newUid(),
        anchor: String(message?.id ?? ANCHOR_BOTTOM),
        side,
        kind,
        durationSec: defaultDuration(),
        ts: messageTimestamp(message),
        name: friendName(channelId, message),
    };
}

/** a call anchored to the conversation itself (works with zero messages) */
function callForChannel(channelId: string): CallRow {
    return {
        channelId,
        uid: newUid(),
        anchor: ANCHOR_BOTTOM,
        side: "above",
        kind: "missed",
        durationSec: defaultDuration(),
        ts: Date.now(),
        name: friendName(channelId, null),
    };
}

// ---------------------------------------------------------------------------
// the sentence Discord writes
// ---------------------------------------------------------------------------

/** "a few seconds" / "47 seconds" / "2 minutes" / "1 hour 5 minutes" */
function humanDuration(sec: number): string {
    const total = Math.max(0, Math.floor(Number(sec) || 0));
    if (total < 5) return "a few seconds";
    if (total < 60) return `${total} seconds`;

    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    if (minutes < 60) {
        if (minutes === 1 && rest < 30) return "a minute";
        if (rest === 0) return `${minutes} minutes`;
        return `${minutes} minute${minutes > 1 ? "s" : ""} ${rest} second${rest === 1 ? "" : "s"}`;
    }

    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (mins === 0) return `${hours} hour${hours > 1 ? "s" : ""}`;
    return `${hours} hour${hours > 1 ? "s" : ""} ${mins} minute${mins > 1 ? "s" : ""}`;
}

/** plain text version (used by aria-label and by the list panel) */
function sentence(call: CallRow): string {
    const dur = call.durationSec > 0 ? ` that lasted ${humanDuration(call.durationSec)}` : "";
    const name = call.name || "them";
    switch (call.kind) {
        case "outgoing": return `You started a call${dur}.`;
        case "incoming": return `${name} started a call${dur}.`;
        case "missed":
        default: return `You missed a call from ${name}${dur}.`;
    }
}

function iconPathFor(kind: CallKind): string {
    return kind === "missed" ? ICON_PATHS.phoneMissed : ICON_PATHS.phone;
}

/** the line, split so names can be drawn bold + white exactly like Discord */
function appendSentence(node: HTMLElement, call: CallRow): void {
    const push = (text: string) => node.appendChild(document.createTextNode(text));
    const strong = (text: string) => {
        const el = document.createElement("strong");
        el.textContent = text;
        node.appendChild(el);
    };
    const dur = call.durationSec > 0 ? ` that lasted ${humanDuration(call.durationSec)}` : "";
    const name = call.name || "them";

    switch (call.kind) {
        case "outgoing":
            push(`You started a call${dur}.`);
            break;
        case "incoming":
            strong(name);
            push(` started a call${dur}.`);
            break;
        case "missed":
        default:
            push("You missed a call from ");
            strong(name);
            push(`${dur}.`);
            break;
    }
}

// ---------------------------------------------------------------------------
// the injected row (plain DOM: no React inside Discord's list)
// ---------------------------------------------------------------------------

function rowElementId(key: string): string {
    return `vc-pnygo-callrow-${key}`;
}

function groupElementId(key: string): string {
    return `vc-pnygo-callgrp-${key}`;
}

/** message ids currently rendered for this chat, in visual top -> bottom order */
function messageIdsIn(channelId: string): string[] {
    const out: string[] = [];
    const prefix = `chat-messages-${channelId}-`;
    document.querySelectorAll<HTMLElement>('[id^="chat-messages-"]').forEach(el => {
        if (el.id.startsWith(prefix)) out.push(el.id.slice(prefix.length));
    });
    return out;
}

/** the element the row hangs on — null only while the list is not on screen */
function resolveAnchorEl(call: CallRow): HTMLElement | null {
    if (call.anchor !== ANCHOR_TOP && call.anchor !== ANCHOR_BOTTOM) {
        return document.getElementById(`chat-messages-${call.channelId}-${call.anchor}`);
    }

    const ids = messageIdsIn(call.channelId);
    if (ids.length > 0) {
        const id = call.anchor === ANCHOR_TOP ? ids[0] : ids[ids.length - 1];
        return document.getElementById(`chat-messages-${call.channelId}-${id}`);
    }

    // brand new conversation with zero messages: hang it on the list container
    return document.querySelector<HTMLElement>('[data-list-id="chat-messages"]');
}

function isMessageElement(el: HTMLElement): boolean {
    return el.id.startsWith("chat-messages-");
}

/**
 * Where the group wrapper (and with it every row that sits there) goes.
 * Every slot stays INSIDE an element Discord already owns (extra child of a
 * list item or of the list itself), which is the shape that keeps the
 * virtualised message list happy.
 *   - "__bottom__" -> after the anchor's content (the end of the conversation)
 *   - side "below" -> after the message's content (right UNDER the message)
 *   - side "above" -> before the message's content (right OVER the message)
 */
function slotFor(call: CallRow, target: HTMLElement): { parent: Node; before: Node | null; } {
    if (!isMessageElement(target)) {
        return { parent: target, before: call.anchor === ANCHOR_TOP ? target.firstChild : null };
    }
    if (call.anchor === ANCHOR_BOTTOM) return { parent: target, before: null };
    return { parent: target, before: call.side === "below" ? null : target.firstChild };
}

function paintRow(node: HTMLElement, call: CallRow): void {
    node.className = `vc-pnygo-callrow vc-pnygo-callrow--${call.kind}`;
    node.setAttribute(ROW_ATTR, rowKey(call));
    node.setAttribute("role", "note");
    node.setAttribute("aria-label", sentence(call));
    node.title = "Click to edit this call";

    while (node.firstChild) node.removeChild(node.firstChild);

    const icon = document.createElement("div");
    icon.className = "vc-pnygo-callrow-icon";
    icon.appendChild(svgIcon(iconPathFor(call.kind), 18));
    node.appendChild(icon);

    const text = document.createElement("div");
    text.className = "vc-pnygo-callrow-text";
    appendSentence(text, call);

    const ts = document.createElement("span");
    ts.className = "vc-pnygo-callrow-ts";
    ts.textContent = formatClock(call.ts);
    text.appendChild(ts);

    node.appendChild(text);
}

function onRowClick(event: MouseEvent): void {
    const row = event.currentTarget as HTMLElement;
    const key = row.getAttribute(ROW_ATTR);
    if (!key) return;

    // never let the click reach Discord's message handlers underneath
    event.preventDefault();
    event.stopPropagation();

    const call = calls.get(key);
    if (!call) return;

    openCallEditor(call);
}

function buildRow(call: CallRow): HTMLElement {
    const node = document.createElement("div");
    node.id = rowElementId(rowKey(call));
    node.addEventListener("click", onRowClick);
    paintRow(node, call);
    return node;
}

/** true when the node already sits exactly where the slot wants it */
function isInPlace(node: HTMLElement, parent: Node, before: Node | null): boolean {
    if (node.parentNode !== parent) return false;
    if (before === node) return true; // the slot resolved to us
    if (before === null) return node.nextElementSibling === null;
    if (before instanceof Element) return node.nextElementSibling === before;
    return node.nextSibling === before;
}

function ensureGroup(key: string): HTMLElement {
    let group = groupNodes.get(key);
    if (!group) {
        group = document.createElement("div");
        group.id = groupElementId(key);
        group.className = "vc-pnygo-callgroup";
        group.setAttribute(GROUP_ATTR, key);
        groupNodes.set(key, group);
    }
    return group;
}

/** drop a wrapper that no longer holds any row */
function cleanupGroup(parent: Element | null): void {
    if (!parent || !(parent instanceof HTMLElement)) return;
    if (!parent.classList.contains("vc-pnygo-callgroup")) return;
    if (parent.childElementCount > 0) return;
    const key = parent.getAttribute(GROUP_ATTR);
    try { parent.remove(); } catch { /* already gone */ }
    if (key) groupNodes.delete(key);
}

/** where a row goes inside its group: chronological, oldest first */
function insertionIndex(group: HTMLElement, node: HTMLElement, ts: number): number {
    let index = 0;
    for (const child of Array.from(group.children)) {
        if (child === node) continue;
        const other = calls.get(child.getAttribute(ROW_ATTR) ?? "");
        if (other && other.ts < ts) index++;
    }
    return index;
}

/** Put the node in place, or take it away when its anchor cannot be found. */
function attachRow(call: CallRow): void {
    const key = rowKey(call);

    let node = rowNodes.get(key);
    if (!node) {
        node = buildRow(call);
        rowNodes.set(key, node);
    }

    const target = resolveAnchorEl(call);
    const slot = target && target.isConnected ? slotFor(call, target) : null;
    if (!slot) {
        // the chat is not on screen right now — keep the node, drop it from the DOM
        const parent = node.parentElement;
        if (node.parentNode) node.remove();
        cleanupGroup(parent);
        return;
    }

    const group = ensureGroup(groupKey(call));

    // the wrapper is the only node the slot moves -> no fight between rows
    if (!isInPlace(group, slot.parent, slot.before)) {
        slot.parent.insertBefore(group, slot.before);
        hit("callrow");
    }

    // keep the rows of this place in chronological order (oldest on top)
    const index = insertionIndex(group, node, call.ts);
    if (node.parentNode !== group || group.children[index] !== node) {
        const previousParent = node.parentElement;
        group.insertBefore(node, group.children[index] ?? null);
        hit("callrow");
        cleanupGroup(previousParent);
    }
}

function detachRow(key: string): void {
    const node = rowNodes.get(key);
    if (node) {
        const parent = node.parentElement;
        try { node.remove(); } catch { /* already gone */ }
        rowNodes.delete(key);
        cleanupGroup(parent);
    } else {
        document.getElementById(rowElementId(key))?.remove();
    }
}

// ---------------------------------------------------------------------------
// watcher: keep every row attached while the user scrolls / switches channel
// ---------------------------------------------------------------------------

let observer: MutationObserver | undefined;
let scanTimer: ReturnType<typeof setInterval> | undefined;
let scanQueued = false;

function scan(): void {
    if (!storeRef.enableMissedCalls || calls.size === 0) return;
    try {
        for (const call of calls.values()) attachRow(call);
    } catch (e) {
        logger.warn("call row scan failed:", e);
    }
}

function startWatcher(): void {
    if (!observer && typeof MutationObserver === "function") {
        try {
            observer = new MutationObserver(() => {
                if (scanQueued || calls.size === 0) return;
                scanQueued = true;
                try {
                    requestAnimationFrame(() => {
                        scanQueued = false;
                        scan();
                    });
                } catch {
                    scanQueued = false;
                    scan();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        } catch (e) {
            observer = undefined;
            logger.warn("could not observe the DOM, using the interval only:", e);
        }
    }
    if (!scanTimer) scanTimer = setInterval(scan, 2000);
}

function stopWatcher(): void {
    try { observer?.disconnect(); } catch { /* ignore */ }
    observer = undefined;
    if (scanTimer) {
        clearInterval(scanTimer);
        scanTimer = undefined;
    }
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

export function upsertCall(call: CallRow): void {
    const key = rowKey(call);
    calls.set(key, call);
    startWatcher();

    const existing = rowNodes.get(key);
    if (existing) paintRow(existing, call);
    attachRow(call);

    logger.info(`call row saved at "${call.anchor}" (${call.side}) in channel ${call.channelId}`);
}

export function removeCall(key: string): void {
    detachRow(key);
    calls.delete(key);
    if (calls.size === 0) stopWatcher();
}

/** Move ONE call to another message (or "__bottom__"), on a chosen side. */
export function moveCall(call: CallRow, anchor: string, side?: CallSide): boolean {
    const key = rowKey(call);
    const current = calls.get(key);
    if (!current) return false;

    const next: CallRow = { ...current, anchor, side: side ?? current.side };
    if (next.anchor === current.anchor && next.side === current.side) return false;

    calls.set(key, next);
    const node = rowNodes.get(key);
    if (node) paintRow(node, next);
    // the row is simply re-attached: it leaves its old group for the new one
    attachRow(next);
    logger.info(`call row moved to "${anchor}" (${next.side}) in channel ${next.channelId}`);
    return true;
}

/** Move the newest call of a chat to another place (a message id or "__bottom__"). */
export function moveCallTo(channelId: string, anchor: string, side?: CallSide): boolean {
    const existing = callInChannel(channelId);
    if (!existing) return false;
    return moveCall(existing, anchor, side);
}

/** Wipe every row (used by the list button and by stop()). */
export function clearAllCalls(silent = false): number {
    const removed = calls.size;
    for (const key of [...rowNodes.keys()]) detachRow(key);
    for (const key of [...calls.keys()]) {
        document.getElementById(rowElementId(key))?.remove();
    }
    rowNodes.clear();
    calls.clear();
    for (const group of groupNodes.values()) {
        try { group.remove(); } catch { /* already gone */ }
    }
    groupNodes.clear();
    // sweep anything a previous build left behind
    document.querySelectorAll<HTMLElement>(`[${ROW_ATTR}]`).forEach(el => el.remove());
    document.querySelectorAll<HTMLElement>(`[${GROUP_ATTR}]`).forEach(el => el.remove());
    stopWatcher();
    if (!silent) showToast({ text: `Removed ${removed} call row(s)`, variant: "success" });
    return removed;
}

function toastFor(kind: CallKind): string {
    return kind === "outgoing" ? "Call started (local only)"
        : kind === "incoming" ? "Incoming call added (local only)"
            : "Missed call added (local only)";
}

/** Quick add from a message's right-click menu (no dialog). */
function quickAddMessage(message: any, kind: CallKind, side: CallSide = "above"): void {
    upsertCall(callFromMessage(message, kind, side));
    showToast({ text: toastFor(kind), variant: "success" });
}

/** Quick add from the conversation's right-click menu — needs no messages. */
function quickAddChannel(channelId: string, kind: CallKind): void {
    const call = callForChannel(channelId);
    upsertCall({ ...call, kind });
    showToast({ text: toastFor(kind), variant: "success" });
}

// ---------------------------------------------------------------------------
// editor — type + duration + time, nothing else
// ---------------------------------------------------------------------------

const DURATION_PRESETS: Array<[label: string, seconds: number]> = [
    ["0:30", 30],
    ["1:00", 60],
    ["5:00", 300],
    ["15:00", 900],
    ["30:00", 1800],
    ["1:00:00", 3600],
    ["2:00:00", 7200],
];

function CallEditorPanel(props: any) {
    const { existing, onClose } = props;
    const base: CallRow = existing;

    const [kind, setKind] = React.useState<CallKind>(base.kind);
    const [minutes, setMinutes] = React.useState(Math.floor(base.durationSec / 60));
    const [seconds, setSeconds] = React.useState(base.durationSec % 60);
    const [ts, setTs] = React.useState(toLocalInputValue(base.ts));
    const [name, setName] = React.useState(base.name);
    const [side, setSide] = React.useState<CallSide>(base.side ?? "above");
    const onMessage = base.anchor !== ANCHOR_TOP && base.anchor !== ANCHOR_BOTTOM;

    const durationSec = Math.max(0, Math.min(86_400, (Number(minutes) || 0) * 60 + (Number(seconds) || 0)));

    const setDuration = (value: number) => {
        const safe = Math.max(0, Math.min(86_400, Math.floor(value)));
        setMinutes(Math.floor(safe / 60));
        setSeconds(safe % 60);
    };

    const save = () => {
        const parsedTs = fromLocalInputValue(ts);
        upsertCall({
            ...base,
            kind,
            side,
            durationSec,
            ts: parsedTs ?? base.ts,
            name: name.trim() || "Them",
        });
        showToast({ text: "Call saved in the chat (local only)", variant: "success" });
        onClose();
    };

    const actions = [
        {
            text: "Remove",
            variant: "critical-primary" as const,
            onClick: () => { removeCall(rowKey(base)); onClose(); },
        },
        { text: "Cancel", variant: "secondary" as const, onClick: onClose },
        { text: "Save", variant: "primary" as const, onClick: save },
    ];

    return (
        <Modal {...props} size="sm" title="Edit call" actions={actions}>
            <div className={CLS.panelBody}>
                <Field label="Type">
                    <Select value={kind} onChange={e => setKind(e.currentTarget.value as CallKind)}>
                        {(Object.keys(KIND_LABELS) as CallKind[]).map(id => (
                            <option key={id} value={id}>{KIND_LABELS[id]}</option>
                        ))}
                    </Select>
                </Field>

                <Field label="How long it lasted" hint="e.g. 60 min = a one hour call, 0 = it rang out">
                    <div className={CLS.btnRow}>
                        <Input
                            type="number"
                            min={0}
                            max={1440}
                            value={minutes}
                            style={{ width: 80 }}
                            onChange={e => setDuration((Number(e.currentTarget.value) || 0) * 60 + seconds)}
                        />
                        <span className="vc-pnygo-muted">min</span>
                        <Input
                            type="number"
                            min={0}
                            max={59}
                            value={seconds}
                            style={{ width: 80 }}
                            onChange={e => setDuration(minutes * 60 + (Number(e.currentTarget.value) || 0))}
                        />
                        <span className="vc-pnygo-muted">sec</span>
                        <span className="vc-pnygo-chip">{humanDuration(durationSec)}</span>
                    </div>
                </Field>

                <div className={CLS.btnRow}>
                    {DURATION_PRESETS.map(([label, value]) => (
                        <Button key={label} size="sm" variant="ghost" onClick={() => setDuration(value)}>
                            {label}
                        </Button>
                    ))}
                </div>

                <Field label="Time shown in the chat">
                    <Input type="datetime-local" value={ts} onChange={e => setTs(e.currentTarget.value)} />
                </Field>

                {onMessage && (
                    <Field label="Where the row sits" hint="Above = over that message, Below = right under it">
                        <Select value={side} onChange={e => setSide(e.currentTarget.value as CallSide)}>
                            <option value="above">Above the message</option>
                            <option value="below">Below the message</option>
                        </Select>
                    </Field>
                )}

                {kind !== "outgoing" && (
                    <Field label="Name of the other person" hint="Only used for incoming / missed calls">
                        <Input value={name} onChange={e => setName(e.currentTarget.value)} placeholder="Alex" />
                    </Field>
                )}

                <Muted>
                    Local only: the row lives in this client's memory, nothing is sent to Discord, and it disappears
                    when Discord restarts.
                </Muted>
            </div>
        </Modal>
    );
}

export function openCallEditor(existing?: CallRow): void {
    if (!existing) return;
    openPanel(props => <CallEditorPanel {...props} existing={existing} />);
}

// ---------------------------------------------------------------------------
// list of the rows added in this session
// ---------------------------------------------------------------------------

function CallListPanel(props: any) {
    const { onClose } = props;
    const rows = getCalls();

    return (
        <Modal
            {...props}
            size="sm"
            title="Call log (local)"
            actions={[
                { text: "Close", variant: "secondary", onClick: onClose },
                {
                    text: "Remove all",
                    variant: "critical-primary",
                    onClick: () => clearAllCalls(),
                    disabled: rows.length === 0,
                },
            ]}
        >
            <div className={CLS.panelBody}>
                <Card title={`${rows.length} call row(s)`} subtitle="Right-click a message or a conversation → Call (local)">
                    {rows.length === 0
                        ? <Empty>No calls yet. Right-click a conversation or a message → Call (local).</Empty>
                        : (
                            <div className={CLS.scroll}>
                                {rows.map(call => (
                                    <div key={rowKey(call)} className={CLS.row}>
                                        <div style={{ minWidth: 0, flex: 1 }}>
                                            <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                {sentence(call)}
                                            </div>
                                            <div className="vc-pnygo-muted">
                                                {channelLabel(call.channelId)} · {formatClock(call.ts)}
                                                {call.anchor === ANCHOR_BOTTOM ? " · end of chat"
                                                    : call.anchor === ANCHOR_TOP ? " · start of chat"
                                                        : ` · ${call.side === "below" ? "under that message" : "over that message"}`}
                                            </div>
                                        </div>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            title="Move this call to the end of the conversation"
                                            onClick={() => moveCall(call, ANCHOR_BOTTOM)}
                                        >
                                            To end
                                        </Button>
                                        <Button size="sm" variant="neutral" onClick={() => openCallEditor(call)}>
                                            Edit
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            title="Remove this row"
                                            onClick={() => removeCall(rowKey(call))}
                                        >
                                            <Icons.trash size={14} />
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        )}
                </Card>
                <Muted>
                    Rows live in memory only: restarting Discord clears them, and stopping the plugin removes them.
                </Muted>
            </div>
        </Modal>
    );
}

export function openCallList(): void {
    openPanel(props => <CallListPanel {...props} />);
}

// ---------------------------------------------------------------------------
// context menu
// ---------------------------------------------------------------------------

function channelLabel(channelId: string): string {
    try {
        const channel = ChannelStore.getChannel(channelId) as any;
        if (!channel) return "conversation";
        if (channel.isDM?.()) return "DM";
        if (channel.name) return `#${channel.name}`;
        return "conversation";
    } catch {
        return "conversation";
    }
}

function kindItems(make: (kind: CallKind) => void, prefix: string) {
    return (Object.keys(KIND_MENU_LABELS) as CallKind[]).map(kind => (
        <Menu.MenuItem
            key={kind}
            id={`${prefix}-${kind}`}
            label={KIND_MENU_LABELS[kind]}
            action={() => make(kind)}
        />
    ));
}

/** right-click a MESSAGE: pin a call over it or under it (several are allowed) */
const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    try {
        if (!storeRef.enableMissedCalls) return;

        const message = (props as any)?.message;
        if (!message?.id || !message.channel_id) return;
        if (!Menu?.MenuItem) return;

        hit("cm_missedcall");

        const channelId = String(message.channel_id);
        const anchor = String(message.id);
        const here = callsInAnchor(channelId, anchor); // newest first
        const newestHere = here[0];
        const inChannel = callInChannel(channelId); // newest call of the chat

        const canMoveAbove = !!inChannel && (inChannel.anchor !== anchor || inChannel.side !== "above");
        const canMoveBelow = !!inChannel && (inChannel.anchor !== anchor || inChannel.side !== "below");

        const move = (side: CallSide) => {
            if (!inChannel) return;
            if (moveCall(inChannel, anchor, side)) {
                showToast({ text: side === "below" ? "Call moved below this message (local only)" : "Call moved above this message (local only)", variant: "success" });
            }
        };

        children.push(
            <Menu.MenuItem id="vc-pnygo-call" label="Call (local)">
                {kindItems(kind => quickAddMessage(message, kind), "vc-pnygo-call")}
                <Menu.MenuItem id="vc-pnygo-call-under" label="Call (local) — below the message">
                    {kindItems(kind => quickAddMessage(message, kind, "below"), "vc-pnygo-call-under")}
                </Menu.MenuItem>
                {canMoveAbove ? (
                    <Menu.MenuItem
                        id="vc-pnygo-call-move"
                        label="Move the newest call here (above)"
                        action={() => move("above")}
                    />
                ) : null}
                {canMoveBelow ? (
                    <Menu.MenuItem
                        id="vc-pnygo-call-move-below"
                        label="Move the newest call here (below)"
                        action={() => move("below")}
                    />
                ) : null}
                {newestHere ? (
                    <Menu.MenuItem
                        id="vc-pnygo-call-edit"
                        label={here.length > 1 ? `Edit the newest of the ${here.length} calls here…` : "Edit this call…"}
                        action={() => openCallEditor(newestHere)}
                    />
                ) : null}
                {here.length > 0 ? (
                    <Menu.MenuItem
                        id="vc-pnygo-call-remove"
                        label={here.length > 1 ? `Remove the ${here.length} calls here` : "Remove this call"}
                        action={() => {
                            for (const call of here) removeCall(rowKey(call));
                            showToast({ text: `Removed ${here.length} call row(s)`, variant: "success" });
                        }}
                    />
                ) : null}
                <Menu.MenuItem
                    id="vc-pnygo-call-list"
                    label="Show the call log"
                    action={() => openCallList()}
                />
            </Menu.MenuItem>
        );
    } catch (e) {
        logger.warn("message context menu patch failed:", e);
    }
};

/** right-click a CONVERSATION in the sidebar: works with zero messages */
const channelContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    try {
        if (!storeRef.enableMissedCalls) return;
        if (!Menu?.MenuItem) return;

        const channel = (props as any)?.channel;
        const channelId = String(channel?.id ?? (props as any)?.channelId ?? "");
        if (!channelId) return;

        // private conversations only (DM / group DM) — this is a DM call log
        const isPrivate = typeof channel?.isPrivate === "function"
            ? !!channel.isPrivate()
            : !!channel?.isDM?.();
        if (channel && !isPrivate) return;

        hit("cm_missedcall");

        const inChannel = callInChannel(channelId);
        const all = callsInChannel(channelId);

        children.push(
            <Menu.MenuItem id="vc-pnygo-call-ch" label="Call (local)">
                {kindItems(kind => quickAddChannel(channelId, kind), "vc-pnygo-call-ch")}
                {inChannel && inChannel.anchor !== ANCHOR_BOTTOM ? (
                    <Menu.MenuItem
                        id="vc-pnygo-call-ch-move"
                        label="Move the newest call to the end of this chat"
                        action={() => {
                            moveCallTo(channelId, ANCHOR_BOTTOM);
                            showToast({ text: "Call moved (local only)", variant: "success" });
                        }}
                    />
                ) : null}
                {inChannel ? (
                    <Menu.MenuItem
                        id="vc-pnygo-call-ch-edit"
                        label={all.length > 1 ? `Edit the newest of the ${all.length} calls…` : "Edit this call…"}
                        action={() => openCallEditor(inChannel)}
                    />
                ) : null}
                {all.length > 0 ? (
                    <Menu.MenuItem
                        id="vc-pnygo-call-ch-remove"
                        label={all.length > 1 ? `Remove the ${all.length} calls in this chat` : "Remove this call"}
                        action={() => {
                            for (const call of all) removeCall(rowKey(call));
                            showToast({ text: `Removed ${all.length} call row(s)`, variant: "success" });
                        }}
                    />
                ) : null}
                <Menu.MenuItem
                    id="vc-pnygo-call-ch-list"
                    label="Show the call log"
                    action={() => openCallList()}
                />
            </Menu.MenuItem>
        );
    } catch (e) {
        logger.warn("channel context menu patch failed:", e);
    }
};

let contextMenuPatched = false;

// ---------------------------------------------------------------------------
// settings / titlebar / toolbox wiring
// ---------------------------------------------------------------------------

export const settings = {
    missedCallDefaultDuration: {
        type: OptionType.NUMBER,
        description: "MissedCalls — default call length in seconds used when you add a call from the right-click menu (4 = “a few seconds”)",
        default: 4,
    },
} as const;

export const toolboxActions = {
    "Call log": () => openCallList(),
    "Calls: remove every row": () => clearAllCalls(),
};

export function start(store: Record<string, any>): void {
    storeRef = store;

    try {
        addContextMenuPatch("message", messageContextMenuPatch);
        addContextMenuPatch("channel-context", channelContextMenuPatch);
        contextMenuPatched = true;
        logger.info("context menu patches registered");
    } catch (e) {
        logger.warn("could not register the context menu patches:", e);
    }

    // memory only: nothing is restored, rows only exist for this session
}

export function stop(): void {
    if (contextMenuPatched) {
        try {
            removeContextMenuPatch("message", messageContextMenuPatch);
            removeContextMenuPatch("channel-context", channelContextMenuPatch);
        } catch { /* ignore */ }
        contextMenuPatched = false;
    }
    clearAllCalls(true);
}
