# VencordMe

[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0--or--later-blue?style=for-the-badge&label=)](LICENSE)
![Version](https://img.shields.io/github/package-json/v/bisco2000/VencordMe?style=for-the-badge&label=&color=1d2021&labelColor=282828)

A fork of [Vencord](https://github.com/Vendicated/Vencord) with personal plugins bundled,
shipped with a **one-click Windows installer**.

> VencordMe — نسخة من Vencord مع إضافاتك الخاصة، مع مُثبِّت ويندوز بضغطة واحدة.

## What's different from Vencord

-   **Bundled personal plugin** [`pnygo`](src/userplugins/pnygo/index.tsx) (off by default):
    -   `EditMessage` - right-click a DM message to edit it locally (own client only)
    -   `EditProfile` - right-click a profile to edit it locally (name, bio, badges, member-since)
    -   `DeleteMessages` - titlebar button to bulk-delete your own messages
    -   `VoiceIPGrabber` - log the voice server `IP:PORT` you connect to
    -   `Thems` - use any https image/GIF/video as a background
    -   plus: `CheckId`, `CleanDiscord`, `Girlfriend`, `JoinVcFriend`, `MissedCalls`, `SelfCheck`, `TokenTools`
-   **`VencordMe-Setup.exe`** - a small standalone Windows installer (no runtime required) that finds your
    Discord install(s), backs up the original `app.asar` and patches it.
-   **Own data folder** - everything lives in `%APPDATA%\VencordMe`, so it never touches an existing
    Vencord installation.
-   **Updater disabled in shipped builds** - an update can never silently replace the bundled plugins.

Everything else (patches, 100+ plugins, themes, custom CSS) is upstream Vencord 1.15.7.
Vencord's identity is kept as-is inside Discord (**Settings -> Vencord**).

## Install

1. Download **`VencordMe-Setup.exe`** from the [Releases](../../releases/latest) page.
2. Run it. It lists every Discord install it can find (Stable / Canary / PTB) - pick one (or several)
   with **Browse...** if your Discord lives somewhere non-standard, then choose:
    - **Install** - patches Discord and writes the default settings (**all 210 plugins disabled**),
    - **Install + Settings** - patches Discord and applies the bundled settings profile
      (everything enabled as configured, `pnygo` stays **disabled**),
    - **Uninstall** - restores the original `app.asar`.
3. Restart Discord, open **Settings -> Vencord**, enable the plugins you want.

The file is unsigned, so SmartScreen may show "Windows protected your PC" ->
**More info -> Run anyway**.

**Uninstall:** run the same exe and press **Uninstall**, or:

```powershell
VencordMe-Setup.exe --uninstall
```

## Build from source

Requirements: Node.js >= 22, [pnpm](https://pnpm.io) and the .NET Framework compiler (`csc.exe`).

```powershell
pnpm install --frozen-lockfile

# build the runtime (standalone, updater disabled)
pnpm buildStandalone --disable-updater

# regenerate the shipped settings (all plugins disabled) - optional
node installer\makeSettings.mjs

# compile the installer
powershell -ExecutionPolicy Bypass -File installer\build.ps1
# -> VencordMe-Setup.exe
```

Run `pnpm test` before pushing (build + tsc + eslint + stylelint).

See [`installer/README.md`](installer/README.md) for how the installer works, its CLI options
and how to test it against a copy of Discord without touching the real one.

## Layout

| Path                  | What it is                                     |
| --------------------- | ---------------------------------------------- |
| `src/plugins/`        | Vencord's built-in plugins                     |
| `src/userplugins/`    | personal plugins (`pnygo`) - built automatically |
| `installer/`          | `VencordMe-Setup.exe` source (`Setup.cs`)      |
| `.github/workflows/`  | tests, DevBuild and Windows installer release  |

## Disclaimer

Client modifications are against [Discord's Terms of Service](https://discord.com/terms).
Use them at your own risk, and never on an account you cannot afford to lose.

Discord is a trademark of Discord Inc., mentioned only for descriptiveness.

## Credits & license

This is a fork of [Vencord](https://github.com/Vendicated/Vencord) by
[Vendicated](https://github.com/Vendicated) and contributors - all credit for the client mod,
its patches and its plugins belongs to them.

Licensed under the [GPL-3.0-or-later](LICENSE) license - the same license as Vencord.
