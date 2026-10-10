/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings,SettingsStore } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType } from "@utils/types";
import { React } from "@webpack/common";

import * as CheckId from "./modules/checkid";
import * as CleanDiscord from "./modules/cleandiscord";
import * as DeleteMessages from "./modules/deletemessages";
import * as EditMessage from "./modules/editmessage";
import * as EditProfile from "./modules/editprofile";
import * as Girlfriend from "./modules/girlfriend";
import * as JoinVcFriend from "./modules/joinvcfriend";
import * as MissedCalls from "./modules/missedcalls";
import { hit } from "./modules/probe";
import * as SelfCheck from "./modules/selfcheck";
import * as Thems from "./modules/thems";
import { TokenButton } from "./modules/tokentools";
import * as VoiceIPGrabber from "./modules/voiceipgrabber";

const settings = definePluginSettings({
    enableEditMessage: {
        type: OptionType.BOOLEAN,
        description: "EditMessage — right-click a DM message to edit it locally (own client only)",
        default: true,
    },
    enableEditProfile: {
        type: OptionType.BOOLEAN,
        description: "EditProfile — right-click a profile to edit it locally (name, bio, badges, member-since)",
        default: true,
    },
    enableDeleteMessages: {
        type: OptionType.BOOLEAN,
        description: "DeleteMessages — titlebar button to bulk-delete your own messages",
        default: true,
    },
    enableVoiceIP: {
        type: OptionType.BOOLEAN,
        description: "VoiceIPGrabber — capture and log the voice server IP:PORT you connect to",
        default: true,
    },
    enableCleanDiscord: {
        type: OptionType.BOOLEAN,
        description: "cleandiscord — titlebar button to clean this Discord version (locales, caches, shortcut)",
        default: true,
    },
    enableMissedCalls: {
        type: OptionType.BOOLEAN,
        description: "MissedCalls — right-click a message to add a local “missed call” row above it (memory only)",
        default: true,
    },
    enableGirlfriend: {
        type: OptionType.BOOLEAN,
        description: "Girlfriend — heart button in the titlebar that opens her profile card and plays your song",
        default: true,
    },
    enableCheckId: {
        type: OptionType.BOOLEAN,
        description: "Check ID — titlebar button that shows the full profile of any Discord user ID (plus status, last online, voice channel and mutual servers)",
        default: true,
    },
    checkIdBotToken: {
        type: OptionType.STRING,
        description: "Check ID — bot token used when your own account is not allowed to read a profile (Developer Portal → Bot → Token). Stored on this PC only and sent to discord.com alone. Leave empty to disable.",
        default: "",
        placeholder: "bot token (optional)",
    },
    enableJoinVcFriend: {
        type: OptionType.BOOLEAN,
        description: "JoinVC friend — DM a watched account the link of the voice room the moment they join it (a real Discord message)",
        default: true,
    },
    joinvcfriendIds: {
        type: OptionType.STRING,
        description: "JoinVC friend — user ids to watch, separated by comma, space or a new line",
        default: "",
    },
    joinvcfriendMessage: {
        type: OptionType.STRING,
        description: "JoinVC friend — message sent to their DM ({name} and {link} are replaced)",
        default: "🎙️ {name} دخل الروم: {link}",
    },
    joinvcfriendOnlyMutual: {
        type: OptionType.BOOLEAN,
        description: "JoinVC friend — only send when the room is in a server you share with them (private calls are skipped)",
        default: false,
    },
    joinvcfriendCooldown: {
        type: OptionType.NUMBER,
        description: "JoinVC friend — minimum seconds between two messages to the same account",
        default: 3,
    },
    enableThems: {
        type: OptionType.BOOLEAN,
        description: "Thems — titlebar button that shows a picture, GIF or video as your Discord background (local file or any https link)",
        default: true,
    },
    // extra options contributed by the sub-features
    ...EditProfile.settings,
    ...VoiceIPGrabber.settings,
    ...MissedCalls.settings,
    ...Girlfriend.settings,
    ...SelfCheck.settings,
    ...Thems.settings,
});

/** Titlebar group: renders only the buttons of the enabled features. */
function TitlebarButtons() {
    const s = settings.use();
    return (
        <>
            {<TokenButton />}
            {s.enableDeleteMessages && <DeleteMessages.TrashHeaderButton_ />}
            {s.enableVoiceIP && <VoiceIPGrabber.IpHeaderButton_ />}
            {s.enableCleanDiscord && <CleanDiscord.CleanHeaderButton />}
            {s.enableGirlfriend && <Girlfriend.GirlfriendHeaderButton_ />}
            {s.enableGirlfriend && <Girlfriend.GirlfriendSettingsHeaderButton_ />}
            {s.enableCheckId && <CheckId.CheckIdHeaderButton_ />}
            {s.enableJoinVcFriend && <JoinVcFriend.JoinVcFriendHeaderButton_ />}
            {s.enableThems && <Thems.ThemsHeaderButton_ />}
            <SelfCheck.SelfCheckHeaderButton />
        </>
    );
}

// last known toggle states, to react to changes
const prev = { enableDeleteMessages: true, enableMissedCalls: true, enableJoinVcFriend: true };
let settingsListener: ((data: any) => void) | undefined;

function onSettingsChange() {
    const s = settings.store;
    if (s.enableDeleteMessages && !prev.enableDeleteMessages) {
        // feature re-enabled mid-session: resume a paused deletion job
        DeleteMessages.resume();
    }
    if (prev.enableMissedCalls && !s.enableMissedCalls) {
        // feature switched off: drop every call row right away
        MissedCalls.clearAllCalls(true);
    }
    if (!prev.enableJoinVcFriend && s.enableJoinVcFriend) {
        // back on: remember where the watched accounts are sitting right now,
        // so an unchanged room is not read as a fresh join
        JoinVcFriend.seedAll();
    }
    prev.enableDeleteMessages = !!s.enableDeleteMessages;
    prev.enableMissedCalls = !!s.enableMissedCalls;
    prev.enableJoinVcFriend = !!s.enableJoinVcFriend;
}

export default definePlugin({
    name: "pnygo",
    description: "All-in-one: EditMessage + EditProfile + DeleteMessages + VoiceIPGrabber + cleandiscord + MissedCalls + Girlfriend + Check ID + JoinVC friend + Thems. Toggle each feature from the settings below.",
    tags: ["Utility"],
    authors: [{ name: "espacegamers", id: 275605725634494465n }],

    settings,

    patches: [
        // titlebar: inject a group that renders every enabled feature's button
        {
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(trailing:.{0,80}?\{children:\[)/,
                replace: "$1$self.TitleBarButton(),"
            }
        },
        // EditProfile: badges on the profile record.
        // Discord's own badge expression is passed through, so the real badges
        // are never lost — the fakes are only added on top (and de-duplicated).
        {
            find: "getLegacyUsername(){",
            replacement: {
                match: /getBadges\(\)\{return(.+?)\}(?=getLegacyUsername)/,
                replace: "getBadges(){return $self.badgesFor(this,$1)}"
            }
        },
        // EditProfile: profile record (bio / handle on builds that read it here).
        // Cached + identity stable, see modules/editprofile/views.ts
        {
            find: "UserProfileStore",
            replacement: {
                match: /(?<=getUserProfile\(\i\)\{return )(.+?)(?=})/,
                replace: "$self.profileView($1)"
            }
        },
        // EditProfile: the User object itself. THIS is where the username,
        // the display name and the account creation date are read from by every
        // profile view, so this is the patch that makes them change.
        {
            find: 'displayName="UserStore"',
            replacement: [
                {
                    match: /getUser\((\i)\)\{if\(null!=(\i)\)return (\i\[\i\])\}/,
                    replace: "getUser($1){if(null!=$2)return $self.userView($3)}"
                },
                {
                    match: /getCurrentUser\(\)\{return (\i\[\i\.default\.getId\(\)\])\}/,
                    replace: "getCurrentUser(){return $self.userView($1)}"
                }
            ]
        },
        // EditProfile: User#createdAt. Code that already holds a real User
        // instance (message authors, caches, ...) still gets the fake date.
        {
            find: "extractTimestamp(this.id)",
            replacement: {
                match: /get createdAt\(\)\{return new Date\((\i)\.default\.extractTimestamp\(this\.id\)\)\}/,
                replace: "get createdAt(){return new Date($self.createdAtTimestamp(this,$1.default))}"
            }
        },
        // EditProfile: the account date derived straight from the snowflake id
        // (Discord's own snowflake -> timestamp helper; only ids that have a
        // stored override are affected).
        {
            find: "Snowflake sequence number overflow",
            replacement: {
                match: /function (\i)\((\i)\)\{return Math\.floor\(Number\(\2\)\/4194304\)\+\i\}/,
                replace: "function $1($2){return $self.snowflakeMs($2)}"
            }
        }
    ],

    TitleBarButton() {
        hit("titlebar");
        return (
            <ErrorBoundary key="vc-pnygo-titlebar" noop>
                <TitlebarButtons />
            </ErrorBoundary>
        );
    },

    // exposed for the patch replacements above ($self.*).
    // Each one counts its calls so SelfCheck can prove the patch is alive.
    badgesFor: (record: unknown, real?: unknown) => { hit("badges"); return EditProfile.badgesFor(record, real as any); },
    profileView: (profile: unknown) => { hit("profileView"); return EditProfile.profileView(profile); },
    userView: (user: unknown) => { hit("userView"); return EditProfile.userView(user); },
    createdAtTimestamp: (user: unknown, snowflakeUtils?: any) => { hit("createdAt"); return EditProfile.createdAtTimestamp(user, snowflakeUtils); },
    snowflakeMs: (id: unknown) => { hit("snowflake"); return EditProfile.snowflakeMs(id); },

    toolboxActions: {
        ...VoiceIPGrabber.toolboxActions,
        ...MissedCalls.toolboxActions,
        ...Girlfriend.toolboxActions,
        ...CheckId.toolboxActions,
        ...JoinVcFriend.toolboxActions,
        ...Thems.toolboxActions,
        ...SelfCheck.toolboxActions,
    },
    flux: { ...VoiceIPGrabber.flux, ...CheckId.flux, ...EditMessage.flux, ...JoinVcFriend.flux },

    async start() {
        EditProfile.start(settings.store);
        EditMessage.start(settings.store);
        DeleteMessages.start(settings.store);
        VoiceIPGrabber.start(settings.store);
        CleanDiscord.start(settings.store);
        MissedCalls.start(settings.store);
        Girlfriend.start(settings.store);
        CheckId.start(settings.store);
        JoinVcFriend.start(settings.store);
        Thems.start(settings.store);

        prev.enableDeleteMessages = !!settings.store.enableDeleteMessages;
        prev.enableMissedCalls = !!settings.store.enableMissedCalls;
        prev.enableJoinVcFriend = !!settings.store.enableJoinVcFriend;
        settingsListener = onSettingsChange;
        SettingsStore.addPrefixChangeListener("plugins.pnygo", settingsListener);

        // never let the startup compatibility/update check break plugin start
        setTimeout(() => { void SelfCheck.runStartupCheck(settings.store); }, 5000);
    },

    stop() {
        if (settingsListener) {
            SettingsStore.removeChangeListener("plugins.pnygo", settingsListener);
            settingsListener = undefined;
        }
        SelfCheck.stop();
        EditProfile.stop();
        EditMessage.stop();
        DeleteMessages.stop();
        VoiceIPGrabber.stop();
        CleanDiscord.stop();
        MissedCalls.stop();
        Girlfriend.stop();
        CheckId.stop();
        JoinVcFriend.stop();
        Thems.stop();
    },
});
