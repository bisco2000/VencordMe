/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addContextMenuPatch, NavContextMenuPatchCallback, removeContextMenuPatch } from "@api/ContextMenu";
import { get, set } from "@api/DataStore";
import ErrorBoundary from "@components/ErrorBoundary";
import { FluxDispatcher, Menu, MessageStore, Modal, openModal, React, showToast, Toasts, UserStore } from "@webpack/common";

import { Button, CLS } from "./ui";

// set from the merged plugin's start()
let storeRef: Record<string, any> = {};

// blob urls we created — kept alive while the client runs, revoked on stop()
// value = the original file bytes, so a url can be rebuilt after a restart
const objectUrls = new Map<string, Blob>();

/** one saved local change (edit or local delete) per message */
const EDITS_KEY = "vc-pnygo:editmessage:edits";

interface LocalAttachment {
    id: string;
    filename: string;
    size: number;
    spoiler: boolean;
    url: string;
    proxy_url: string;
    content_type?: string;
    width?: number;
    height?: number;
}

interface EditRecord {
    channelId: string;
    messageId: string;
    content: string;
    editedAt: string;
    /** what the message looked like before we touched it (for "Revert") */
    original?: { content: string; attachments: LocalAttachment[]; };
    attachments: LocalAttachment[];
    /** attachment id -> the bytes of a locally picked file */
    files: Record<string, Blob>;
    /** the message was hidden locally instead of edited */
    deleted?: boolean;
}

/** channel:message -> saved record */
const edits = new Map<string, EditRecord>();
/** message id -> the last time we pushed it into the store (loop guard) */
const appliedAt = new Map<string, number>();

let editsLoaded = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let createTimer: ReturnType<typeof setTimeout> | undefined;

function myId(): string {
    return UserStore.getCurrentUser()?.id ?? "";
}

function editKey(channelId: string, messageId: string): string {
    return `${channelId}:${messageId}`;
}

function getEditRecord(channelId?: string, messageId?: string): EditRecord | undefined {
    if (!channelId || !messageId) return undefined;
    return edits.get(editKey(channelId, messageId));
}

/** "blob:https://.../#" -> "blob:https://..." */
function stripHash(url: string): string {
    return url.endsWith("#") ? url.slice(0, -1) : url;
}

/** Raise the natural size of an image so Discord lays it out without jumping. */
function imageSize(url: string): Promise<{ width: number; height: number; } | null> {
    return new Promise(res => {
        const img = new Image();
        img.onload = () => res({ width: img.width, height: img.height });
        img.onerror = () => res(null);
        img.src = url;
    });
}

/** Turn a picked file into a local (blob) attachment Discord can render. */
async function fileToAttachment(file: File): Promise<LocalAttachment | null> {
    const type = file.type || "";
    // only images and videos — anything else is refused
    if (type && !type.startsWith("image/") && !type.startsWith("video/")) return null;

    const raw = URL.createObjectURL(file);
    objectUrls.set(raw, file);
    // a hash stops Discord from appending query params to the blob url
    const url = raw + "#";

    const attachment: LocalAttachment = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        filename: file.name || `media-${Date.now()}${type.startsWith("video/") ? ".mp4" : ".png"}`,
        size: file.size,
        spoiler: false,
        url,
        proxy_url: url,
        content_type: type || undefined,
    };

    if (type.startsWith("image/")) {
        const box = await imageSize(url);
        if (box) {
            attachment.width = box.width;
            attachment.height = box.height;
        }
    }

    return attachment;
}

// ---------------------------------------------------------------------------
// storage — the edit (and the bytes of every local image) survive a restart
// ---------------------------------------------------------------------------

/** give every local attachment a fresh blob url built from its stored bytes */
function restoreFiles(rec: EditRecord): void {
    if (!rec.files || !rec.attachments) return;
    for (const [id, blob] of Object.entries(rec.files)) {
        const attachment = rec.attachments.find(a => a.id === id);
        if (!attachment || !blob) continue;
        try {
            const raw = URL.createObjectURL(blob);
            objectUrls.set(raw, blob);
            attachment.url = raw + "#";
            attachment.proxy_url = attachment.url;
            if (blob.size) attachment.size = blob.size;
        } catch { /* keep the old url, it will simply not render */ }
    }
}

async function persistEdits(): Promise<void> {
    try {
        const data: Record<string, EditRecord> = {};
        for (const [key, rec] of edits) data[key] = rec;
        await set(EDITS_KEY, data);
    } catch (e) {
        console.warn("[pnygo/EditMessage] could not save the local edits:", e);
    }
}

function schedulePersist(): void {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
        persistTimer = undefined;
        void persistEdits();
    }, 300);
}

async function loadEdits(): Promise<void> {
    try {
        const data = await get<Record<string, EditRecord>>(EDITS_KEY);
        if (data && typeof data === "object") {
            for (const [key, rec] of Object.entries(data)) {
                if (!rec || typeof rec !== "object" || !rec.messageId || !rec.channelId) continue;
                restoreFiles(rec);
                edits.set(key, rec);
            }
        }
    } catch (e) {
        console.warn("[pnygo/EditMessage] could not load the saved local edits:", e);
    }
    editsLoaded = true;
    reapplyAll();
}

// ---------------------------------------------------------------------------
// applying a record to the local client
// ---------------------------------------------------------------------------

/** push one saved record into the client store; returns true if it did work */
function applyEdit(rec: EditRecord, known?: any): boolean {
    if (!storeRef.enableEditMessage) return false;
    try {
        const msg = known ?? MessageStore?.getMessage?.(rec.channelId, rec.messageId);
        if (!msg) return false;

        if (rec.deleted) {
            // the store already knows it is gone -> nothing to do
            if (msg.deleted) return false;
            FluxDispatcher.dispatch({
                type: "MESSAGE_DELETE",
                channelId: rec.channelId,
                id: rec.messageId,
            });
            return true;
        }

        const sameText = typeof msg.content === "string" && msg.content === rec.content;
        const storeCount = Array.isArray(msg.attachments) ? msg.attachments.length : 0;
        if (sameText && storeCount === rec.attachments.length) return false;

        const updated = Object.assign(Object.create(Object.getPrototypeOf(msg)), msg, {
            content: rec.content,
            attachments: rec.attachments.map(a => ({ ...a })),
            editedTimestamp: rec.editedAt,
            edited: true,
        });

        FluxDispatcher.dispatch({
            type: "MESSAGE_UPDATE",
            message: updated,
        });

        return true;
    } catch (e) {
        console.warn("[pnygo/EditMessage] could not apply a saved edit:", e);
        return false;
    }
}

/** re-apply every saved record (used at start, on MESSAGE_CREATE and on a tick) */
function reapplyAll(): void {
    if (!editsLoaded || !storeRef.enableEditMessage || edits.size === 0) return;
    const now = Date.now();
    for (const rec of edits.values()) {
        const last = appliedAt.get(rec.messageId) ?? 0;
        // never hammer the same message, Discord may be mid-reload
        if (now - last < 1500) continue;
        if (applyEdit(rec)) appliedAt.set(rec.messageId, now);
    }
}

// ---------------------------------------------------------------------------
// the three ways a message can be changed locally
// ---------------------------------------------------------------------------

function editMessageLocally(
    channelId: string,
    messageId: string,
    content: string,
    attachments: LocalAttachment[]
): boolean {
    if (!storeRef.enableEditMessage) return false;

    try {
        const msg = MessageStore?.getMessage?.(channelId, messageId);
        if (!msg) return false;

        const plain = attachments.map(a => ({ ...a }));
        const files: Record<string, Blob> = {};
        for (const a of plain) {
            const blob = objectUrls.get(stripHash(a.url));
            if (blob) files[a.id] = blob;
        }

        const prev = getEditRecord(channelId, messageId);
        const rec: EditRecord = {
            channelId,
            messageId,
            content,
            editedAt: new Date().toISOString(),
            attachments: plain,
            files,
            original: prev?.original ?? {
                content: typeof msg.content === "string" ? msg.content : "",
                attachments: Array.isArray(msg.attachments)
                    ? msg.attachments.map((a: any) => ({ ...a }))
                    : [],
            },
        };

        edits.set(editKey(channelId, messageId), rec);
        schedulePersist();

        return applyEdit(rec, msg);
    } catch {
        return false;
    }
}

/** hide the message from this client only, and keep it hidden */
function deleteMessageLocally(channelId: string, messageId: string): boolean {
    if (!storeRef.enableEditMessage) return false;

    try {
        const msg = MessageStore?.getMessage?.(channelId, messageId);
        if (!msg || msg.deleted) return false;

        const prev = getEditRecord(channelId, messageId);
        const rec: EditRecord = {
            channelId,
            messageId,
            content: "",
            editedAt: new Date().toISOString(),
            attachments: [],
            files: {},
            deleted: true,
            original: prev?.original ?? {
                content: typeof msg.content === "string" ? msg.content : "",
                attachments: Array.isArray(msg.attachments)
                    ? msg.attachments.map((a: any) => ({ ...a }))
                    : [],
            },
        };

        edits.set(editKey(channelId, messageId), rec);
        appliedAt.set(messageId, Date.now());
        schedulePersist();

        FluxDispatcher.dispatch({
            type: "MESSAGE_DELETE",
            channelId,
            id: messageId,
        });

        return true;
    } catch {
        return false;
    }
}

/** drop our record and put the message back the way Discord has it */
function revertEditLocally(channelId: string, messageId: string): boolean {
    const key = editKey(channelId, messageId);
    const rec = edits.get(key);
    if (!rec) return false;

    edits.delete(key);
    appliedAt.delete(messageId);
    schedulePersist();

    try {
        const { original } = rec;
        const msg = MessageStore?.getMessage?.(channelId, messageId);
        if (!original || !msg) return true;

        const updated = Object.assign(Object.create(Object.getPrototypeOf(msg)), msg, {
            content: original.content,
            attachments: original.attachments.map(a => ({ ...a })),
            editedTimestamp: null,
            edited: false,
        });

        FluxDispatcher.dispatch({
            type: "MESSAGE_UPDATE",
            message: updated,
        });
    } catch { /* the record is gone either way */ }

    return true;
}

function toastFor(ok: boolean, done: string): void {
    if (ok) showToast(done, Toasts.Type.SUCCESS);
    else showToast("Could not change that message in your client.", Toasts.Type.FAILURE);
}

function EditMessageModal(props: any) {
    const { message, onClose } = props;
    const saved = getEditRecord(message?.channel_id, message?.id);

    const [text, setText] = React.useState<string>(
        saved && !saved.deleted ? saved.content : (message?.content ?? "")
    );
    const [attachments, setAttachments] = React.useState<LocalAttachment[]>(
        saved && !saved.deleted
            ? saved.attachments.map(a => ({ ...a }))
            : (message?.attachments ? [...message.attachments] : [])
    );
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");

    const addFiles = async (files: FileList | null) => {
        if (!files?.length) return;
        const added: LocalAttachment[] = [];
        for (const f of Array.from(files)) {
            const a = await fileToAttachment(f);
            if (a) added.push(a);
        }
        if (!added.length) {
            setError("Unsupported file. Pick an image or a video.");
            return;
        }
        setError("");
        setAttachments(prev => [...prev, ...added]);
    };

    const pickMedia = () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*,video/*";
        input.multiple = true;
        input.addEventListener("change", () => addFiles(input.files));
        input.click();
    };

    const removeMedia = (id: string) => setAttachments(prev => prev.filter(a => a.id !== id));

    const submit = () => {
        if (!text.trim() && attachments.length === 0) {
            setError("Type something or add an image/video. (Or press Delete to hide it.)");
            return;
        }
        setBusy(true);
        const ok = editMessageLocally(message.channel_id, message.id, text, attachments);
        setBusy(false);
        if (ok) {
            onClose();
        } else {
            setError("Could not update this message in your client.");
        }
    };

    const remove = () => {
        setBusy(true);
        const ok = deleteMessageLocally(message.channel_id, message.id);
        setBusy(false);
        if (ok) {
            showToast("Message hidden in your client (local only)", Toasts.Type.SUCCESS);
            onClose();
        } else {
            setError("Could not hide this message in your client.");
        }
    };

    const revert = () => {
        const ok = revertEditLocally(message.channel_id, message.id);
        if (ok) {
            showToast("Back to the original message", Toasts.Type.SUCCESS);
            onClose();
        } else {
            setError("There is nothing to revert.");
        }
    };

    // If a Discord/Vencord update temporarily breaks the Modal export, fall
    // back to a plain overlay instead of crashing on <undefined>.
    if (typeof Modal !== "function") {
        return (
            <div style={{
                position: "fixed", inset: 0, zIndex: 10000,
                background: "rgba(0,0,0,.6)", display: "flex",
                alignItems: "center", justifyContent: "center"
            }}>
                <div style={{ background: "var(--background-secondary)", borderRadius: 8, padding: 16, maxWidth: 420 }}>
                    <div style={{ color: "var(--red-360)", fontSize: 13, marginBottom: 8 }}>
                        The Edit Message window can't open: a Discord/Vencord update broke the Modal module.
                        Run pnygo SelfCheck to verify compatibility.
                    </div>
                    <Button onClick={onClose}>Close</Button>
                </div>
            </div>
        );
    }

    return (
        <Modal
            {...props}
            size="sm"
            title="Edit Message (local only)"
            actions={[
                { text: "Cancel", variant: "secondary", onClick: onClose },
                { text: busy ? "Working..." : "Delete", variant: "critical-primary", onClick: remove, disabled: busy },
                { text: busy ? "Saving..." : "Save", variant: "primary", onClick: submit, disabled: busy }
            ]}
        >
            <div style={{ padding: "0 16px 10px" }}>
                <textarea
                    value={text}
                    onChange={e => setText(e.target.value)}
                    placeholder="New message text..."
                    rows={2}
                    style={{
                        width: "100%",
                        maxHeight: 90,
                        background: "var(--background-tertiary)",
                        color: "var(--text-default)",
                        border: "1px solid var(--background-modifier-accent)",
                        borderRadius: 6,
                        padding: "6px 9px",
                        fontSize: 13,
                        resize: "none",
                        outline: "none",
                        fontFamily: "inherit"
                    }}
                />

                {attachments.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                        {attachments.map(a => (
                            <div
                                key={a.id}
                                style={{
                                    position: "relative",
                                    width: 64,
                                    height: 64,
                                    borderRadius: 6,
                                    overflow: "hidden",
                                    border: "1px solid var(--background-modifier-accent)",
                                    background: "var(--background-tertiary)"
                                }}
                            >
                                {a.content_type?.startsWith("image/")
                                    ? <img src={a.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                                    : <video src={a.url} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                                <button
                                    title="Remove"
                                    onClick={() => removeMedia(a.id)}
                                    style={{
                                        position: "absolute",
                                        top: 2,
                                        right: 2,
                                        width: 18,
                                        height: 18,
                                        lineHeight: "16px",
                                        padding: 0,
                                        borderRadius: 4,
                                        border: "none",
                                        background: "rgba(0,0,0,0.65)",
                                        color: "#fff",
                                        cursor: "pointer",
                                        fontSize: 13
                                    }}
                                >
                                    ×
                                </button>
                            </div>
                        ))}
                    </div>
                )}

                <div className={CLS.btnRow} style={{ marginTop: 8 }}>
                    <Button size="sm" onClick={pickMedia}>+ Add image / video</Button>
                    {saved && (
                        <Button size="sm" variant="ghost" onClick={revert}>Revert to original</Button>
                    )}
                    {error && <span style={{ color: "var(--red-400)", fontSize: 12 }}>{error}</span>}
                </div>

                <div style={{ marginTop: 6, fontSize: 11, opacity: .7 }}>
                    {saved
                        ? "Saved on this device: the edit (and any image) comes back when the chat is reloaded or Discord restarts."
                        : "This change appears only in your client. It is not sent to Discord."}
                </div>
            </div>
        </Modal>
    );
}

/**
 * Never throw out of a context-menu patch: Discord renders menus on the hot
 * path and a single exception there takes down the whole menu (or the client
 * after a Discord update that changed the props shape).
 */
const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    try {
        if (!storeRef.enableEditMessage) return;
        const message = props?.message;
        if (!message?.id || !message?.channel_id) return;

        const label = message.author?.id === myId() ? "Edit My Message" : "Edit Message (local only)";
        children.push(
            <Menu.MenuItem
                id="vc-editmessage"
                label={label}
                action={() => openEditor(message)}
            />,
            <Menu.MenuItem
                id="vc-editmessage-delete"
                label="Delete Message (local only)"
                action={() => {
                    const ok = deleteMessageLocally(String(message.channel_id), String(message.id));
                    toastFor(ok, "Message hidden in your client (local only)");
                }}
            />
        );
    } catch (e) {
        console.error("[pnygo/EditMessage] context menu patch failed:", e);
    }
};

function openEditor(message: any) {
    try {
        if (typeof openModal !== "function") return;
        openModal(props => (
            <ErrorBoundary noop>
                <EditMessageModal {...props} message={message} />
            </ErrorBoundary>
        ));
    } catch (e) {
        console.error("[pnygo/EditMessage] could not open editor:", e);
    }
}

let contextMenuPatched = false;

export function start(store: Record<string, any>) {
    storeRef = store;
    try {
        addContextMenuPatch("message", messageContextMenuPatch);
        contextMenuPatched = true;
    } catch (e) {
        console.error("[pnygo/EditMessage] failed to register context menu patch:", e);
    }

    void loadEdits();

    // Discord re-downloads messages when a chat is reopened: put ours back.
    if (!tickTimer) tickTimer = setInterval(reapplyAll, 1200);
}

/** fast path: history loads dispatch MESSAGE_CREATE for every message */
export const flux = {
    MESSAGE_CREATE: () => {
        if (!edits.size) return;
        if (createTimer) clearTimeout(createTimer);
        createTimer = setTimeout(() => {
            createTimer = undefined;
            reapplyAll();
        }, 60);
    },
};

export function stop() {
    if (contextMenuPatched) {
        try { removeContextMenuPatch("message", messageContextMenuPatch); } catch { }
        contextMenuPatched = false;
    }
    if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = undefined;
    }
    if (createTimer) {
        clearTimeout(createTimer);
        createTimer = undefined;
    }
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = undefined;
        void persistEdits();
    }
    for (const url of objectUrls.keys()) {
        try { URL.revokeObjectURL(url); } catch { }
    }
    objectUrls.clear();
    edits.clear();
    appliedAt.clear();
    editsLoaded = false;
}
