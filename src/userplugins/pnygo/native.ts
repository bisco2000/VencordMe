/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn } from "child_process";
import dns from "dns";
import { clipboard,IpcMainInvokeEvent } from "electron";
import fs from "fs";
import os from "os";
import path from "path";

// ---------------------------------------------------------------------------
// VoiceIPGrabber helpers
// ---------------------------------------------------------------------------

export async function resolveVoiceHost(_: IpcMainInvokeEvent, host: string): Promise<{ ok: boolean; addresses: string[]; error?: string }> {
    if (!host) return { ok: false, addresses: [], error: "empty host" };
    try {
        const addresses = await dns.promises.resolve4(host);
        return { ok: true, addresses };
    } catch {
        try {
            const res = await dns.promises.lookup(host);
            return { ok: true, addresses: [res.address] };
        } catch (e) {
            return { ok: false, addresses: [], error: String(e) };
        }
    }
}

export async function copyText(_: IpcMainInvokeEvent, text: string): Promise<{ ok: boolean }> {
    try {
        clipboard.writeText(text ?? "");
        return { ok: true };
    } catch {
        return { ok: false };
    }
}

export async function sendWebhookPost(_: IpcMainInvokeEvent, url: string, payload: string): Promise<{ ok: boolean; status: number; error?: string }> {
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload
        });
        return { ok: res.ok, status: res.status };
    } catch (e) {
        return { ok: false, status: -1, error: String(e) };
    }
}

// ---------------------------------------------------------------------------
// cleandiscord helpers
// ---------------------------------------------------------------------------

export interface FlavorInfo {
    ok: boolean;
    flavor: string; // Discord | DiscordCanary | DiscordPTB
    exeName: string; // Discord.exe | DiscordCanary.exe | DiscordPTB.exe
    appDataName: string; // discord | discordcanary | discordptb  (%APPDATA% cache folder)
    baseDir: string; // %LOCALAPPDATA%\<flavor>
    exePath: string; // full path of the running client
    error?: string;
}

// Which installation is this client? Derived from the exe we are running as.
export function detect(_: IpcMainInvokeEvent): FlavorInfo {
    try {
        const exePath = process.execPath;
        const exeName = path.basename(exePath);
        const exeBase = exeName.replace(/\.exe$/i, "");

        let flavor = "Discord";
        if (/^discordcanary$/i.test(exeBase)) flavor = "DiscordCanary";
        else if (/^discordptb$/i.test(exeBase)) flavor = "DiscordPTB";
        else if (/^discord$/i.test(exeBase)) flavor = "Discord";
        else {
            try {
                const installFolder = path.basename(path.dirname(path.dirname(exePath)));
                flavor = /^discord(canary|ptb)?$/i.test(installFolder) ? installFolder : exeBase;
            } catch {
                flavor = exeBase;
            }
        }

        const appDataName = flavor.toLowerCase();
        const baseDir = path.join(process.env.LOCALAPPDATA ?? os.homedir(), flavor);

        return { ok: true, flavor, exeName, appDataName, baseDir, exePath };
    } catch (e) {
        return { ok: false, flavor: "", exeName: "", appDataName: "", baseDir: "", exePath: "", error: String(e) };
    }
}

// The standalone "clear discord" tool, re-scoped to a single flavour.
function buildBatch(info: FlavorInfo): string {
    const { flavor, exeName, appDataName } = info;

    const lines = [
        "@echo off",
        "setlocal EnableExtensions EnableDelayedExpansion",
        "rem Set console to UTF-8",
        "chcp 65001 >nul",
        "",
        `title Clear Discord (${flavor})`,
        "",
        "set \"BASE=%LOCALAPPDATA%\"",
        "",
        "echo ============================================",
        "echo   Clear Discord - locales + modules cleanup",
        "echo ============================================",
        "echo.",
        "",
        "rem Close the running client so files are not locked",
        `echo Closing ${exeName} processes...`,
        `taskkill /f /im ${exeName} >nul 2>&1`,
        "timeout /t 2 /nobreak >nul",
        "echo.",
        "",
        `set "DISCORD_DIR=!BASE!\\${flavor}"`,
        "if exist \"!DISCORD_DIR!\" (",
        `    echo [Processing] ${flavor}`,
        "    for /d %%A in (\"!DISCORD_DIR!\\app-*\") do (",
        "        echo     Found app folder: %%~nxA",
        "",
        "        set \"LOCALES=%%A\\locales\"",
        "        if exist \"!LOCALES!\" (",
        "            echo       - Cleaning locales ^(keep only en-US.pak^)",
        "            for %%F in (\"!LOCALES!\\*\") do (",
        "                if /I not \"%%~nxF\"==\"en-US.pak\" (",
        "                    del /f /q \"%%F\" >nul 2>&1",
        "                )",
        "            )",
        "            for /d %%S in (\"!LOCALES!\\*\") do rd /s /q \"%%S\" >nul 2>&1",
        "        ) else (",
        "            echo       - locales folder not found",
        "        )",
        "",
        "        set \"MODULES=%%A\\modules\"",
        "        if exist \"!MODULES!\" (",
        "            echo       - Removing selected modules...",
        "            for %%M in (discord_cloudsync-1 discord_dispatch-1 discord_erlpack-1 discord_rpc-1) do (",
        "                if exist \"!MODULES!\\%%M\" (",
        "                    rd /s /q \"!MODULES!\\%%M\" >nul 2>&1",
        "                    echo           removed %%M",
        "                )",
        "            )",
        "        ) else (",
        "            echo       - modules folder not found",
        "        )",
        "    )",
        "",
        "    echo     - Cleaning root: SquirrelSetup.exe / Update.exe / packages",
        "    if exist \"!DISCORD_DIR!\\SquirrelSetup.exe\" (",
        "        del /f /q \"!DISCORD_DIR!\\SquirrelSetup.exe\" >nul 2>&1",
        "        echo         removed SquirrelSetup.exe",
        "    )",
        "    if exist \"!DISCORD_DIR!\\Update.exe\" (",
        "        del /f /q \"!DISCORD_DIR!\\Update.exe\" >nul 2>&1",
        "        echo         removed Update.exe",
        "    )",
        "    if exist \"!DISCORD_DIR!\\packages\" (",
        "        rd /s /q \"!DISCORD_DIR!\\packages\" >nul 2>&1",
        "        echo         removed packages",
        "    )",
        ") else (",
        `    echo [Skip] ${flavor} not found`,
        ")",
        "echo.",
        "",
        "echo.",
        "echo ============================================",
        "echo   Performance: clearing Discord caches",
        "echo ============================================",
        `powershell -NoProfile -ExecutionPolicy Bypass -Command "$v='${appDataName}'; $p=Join-Path $env:APPDATA $v; if(Test-Path $p){ foreach($c in @('Cache','Code Cache','GPUCache','DawnCache','Service Worker\\CacheStorage','Service Worker\\ScriptCache')){ $t=Join-Path $p $c; if(Test-Path $t){ Remove-Item $t -Recurse -Force -ErrorAction SilentlyContinue; Write-Host ('  cleared ' + $v + '\\' + $c) } } }"`,
        "echo.",
        "echo ============================================",
        "echo   Creating \"Discord Performance\" shortcut",
        "echo ============================================",
        `powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $d=[Environment]::GetFolderPath('Desktop'); $lnk=$ws.CreateShortcut((Join-Path $d 'Discord Performance.lnk')); $app=Get-ChildItem (Join-Path $env:LOCALAPPDATA '${flavor}\\app-*\\${exeName}') -ErrorAction SilentlyContinue | Select-Object -First 1; if($app){ $lnk.TargetPath=$app.FullName; $lnk.Arguments='--disable-gpu --disable-gpu-compositing --disable-accelerated-2d-canvas'; $lnk.WorkingDirectory=$app.DirectoryName; $lnk.Save(); Write-Host ('  Created: ' + $lnk.FullPath) } else { Write-Host '  ${exeName} not found' }"`,
        "echo.",
        "",
        "echo ============================================",
        "echo   Done.",
        "echo ============================================",
        "echo.",
        "pause"
    ];

    return lines.join("\r\n");
}

export async function runClean(_: IpcMainInvokeEvent): Promise<{ ok: boolean; batPath?: string; flavor?: string; error?: string }> {
    try {
        const info = detect(_);
        if (!info.ok) return { ok: false, error: info.error ?? "could not detect this Discord version" };

        const bat = buildBatch(info);

        const tmp = process.env.TEMP ?? os.tmpdir();
        const batPath = path.join(tmp, `pnygo-cleandiscord-${info.flavor}.bat`);
        fs.writeFileSync(batPath, bat, "utf8");

        const cmd = path.join(process.env.windir ?? "C:\\Windows", "system32", "cmd.exe");
        const child = spawn(cmd, ["/c", batPath], {
            detached: true,
            stdio: "ignore",
            windowsHide: false
        });
        child.unref();

        return { ok: true, batPath, flavor: info.flavor };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

// ---------------------------------------------------------------------------
// Check ID helper — the one request the renderer is not allowed to make
// ---------------------------------------------------------------------------

/**
 * A single Discord REST GET made with a BOT token, from the main process.
 *
 * Discord answers `{"message":"internal network error","code":40333}` whenever
 * `Authorization: Bot …` arrives with a browser-like User-Agent, and the
 * renderer can neither change its User-Agent (forbidden header) nor send the
 * request without one — so the Check ID fallback can only happen out here,
 * where Node sets `DiscordBot` like every other bot client does.
 *
 * The URL is hard-limited to discord.com's own API, so the token can never be
 * handed to anyone else, and a wrong/revoked token simply comes back as its
 * HTTP status instead of throwing.
 */
export async function botApiGet(_: IpcMainInvokeEvent, url: string, token: string): Promise<{ status: number; body: any } | null> {
    if (typeof token !== "string" || !token) return null;
    if (typeof url !== "string" || !url.startsWith("https://discord.com/api/")) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const res = await fetch(url, {
            headers: {
                Authorization: `Bot ${token}`,
                "User-Agent": "DiscordBot (pnygo, 1.0)",
                Accept: "application/json",
            },
            signal: controller.signal,
        });
        let body: any = null;
        try { body = await res.json(); } catch { body = null; }
        return { status: res.status, body };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
// (unused helper section removed — feature disabled)
// ---------------------------------------------------------------------------
