/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { PluginNative } from "@utils/types";
import { Forms, Modal, openModal, React } from "@webpack/common";

import { Button, CLS, Icons, TitlebarButton } from "./ui";

const Native = VencordNative.pluginHelpers.pnygo as PluginNative<typeof import("../native")>;

function CleanModal(props: any) {
    const { info, onClose } = props;
    const [busy, setBusy] = React.useState(false);

    const flavor = info?.flavor || "Discord";
    const exeName = info?.exeName || "Discord.exe";

    const confirm = async () => {
        setBusy(true);
        try {
            const res = await Native.runClean().catch(() => null);
            if (res?.ok) {
                showNotification({
                    title: "Clean Discord",
                    body: `Cleanup started for ${res.flavor ?? flavor}. ${exeName} will close now.`
                });
                onClose();
                return;
            }
            showNotification({
                title: "Clean Discord",
                body: `Could not start the cleanup${res?.error ? ": " + res.error : ""}.`
            });
        } catch { }
        setBusy(false);
    };

    return (
        <Modal {...props} size="sm" title="Clean Discord">
            <div style={{ padding: "8px 16px 4px" }}>
                <Forms.FormText>
                    Clean <b>{flavor}</b> — the version this plugin runs in:
                </Forms.FormText>
                <Forms.FormText style={{ opacity: .8 }}>
                    Locales (keeps en-US), unused modules, caches and the
                    Squirrel / Update leftovers. A "Discord Performance" shortcut
                    is created on the desktop.
                </Forms.FormText>
                <Forms.FormText style={{ color: "var(--red-400)", fontSize: 12 }}>
                    {exeName} will be closed to unlock the files. Continue?
                </Forms.FormText>
                <div className={CLS.btnRow} style={{ marginTop: 12, justifyContent: "flex-end" }}>
                    <Button onClick={onClose}>No</Button>
                    <Button variant="danger" disabled={busy} onClick={confirm}>
                        {busy ? "Starting…" : "Yes"}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

async function openCleanModal() {
    const info = await Native.detect().catch(() => null);
    openModal(props => (
        <CleanModal {...props} info={info?.ok ? info : null} />
    ));
}

export function CleanHeaderButton() {
    return (
        <TitlebarButton id="clean" tooltip="Clean Discord — clean this Discord version" onClick={() => openCleanModal()}>
            <Icons.broom size={18} />
        </TitlebarButton>
    );
}

export function start(_store: Record<string, any>) { /* no long-running work */ }
export function stop() { /* nothing to restore */ }
