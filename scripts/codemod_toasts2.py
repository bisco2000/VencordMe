#!/usr/bin/env python3
"""Pass 2 codemod: showToast(msg, "variant") -> showToast({ text: msg, variant: "variant" }).

The new API (upstream v1.15.12) takes a single object argument:
    showToast({ text, variant })
Handles string literals, template literals and simple expressions as first arg.
"""
import re, sys, pathlib

FILES = [
    "src/plugins/DontControlMe/index.tsx",
    "src/plugins/FollowUser/index.tsx",
    "src/plugins/PasscodeLock/index.tsx",
    "src/plugins/questify/utils/completion.ts",
    "src/plugins/voiceReplayBuffer/index.tsx",
    "src/userplugins/pnygo/modules/editmessage.tsx",
    "src/userplugins/pnygo/modules/editprofile/index.tsx",
    "src/userplugins/pnygo/modules/joinvcfriend.tsx",
    "src/userplugins/pnygo/modules/missedcalls.tsx",
    "src/userplugins/pnygo/modules/selfcheck.tsx",
    "src/userplugins/pnygo/modules/tokentools.tsx",
]

# first arg: balanced-paren-less expression (no commas at top level inside call)
ARG = r'(?P<arg>(?:[^(),]|\((?:[^()]|\([^()]*\))*\))+)'

PAT = re.compile(
    r'\b(?P<fn>showToast|toast)\(\s*' + ARG +
    r'\s*,\s*"(?P<variant>success|critical|default)"\s*\)')

def fix(m: re.Match) -> str:
    arg = m.group("arg").strip()
    # collapse internal newlines/extra spaces in simple args for readability
    arg_one = re.sub(r'\s+', ' ', arg)
    return f'{m.group("fn")}({{ text: {arg_one}, variant: "{m.group("variant")}" }})'

def main() -> None:
    root = pathlib.Path(__file__).resolve().parent.parent
    for rel in FILES:
        p = root / rel
        txt = p.read_text(encoding="utf-8")
        new, n = PAT.subn(fix, txt)
        if n:
            p.write_text(new, encoding="utf-8", newline="\n")
            print(f"{rel}: {n} calls converted")
        else:
            print(f"{rel}: no positional calls")

if __name__ == "__main__":
    sys.exit(main())
