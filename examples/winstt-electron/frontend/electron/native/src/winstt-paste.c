/*
 * winstt-paste — Windows fast-paste binary for WinSTT.
 *
 * Modes:
 *   (default)    SendInput Ctrl+V (or Ctrl+Shift+V in terminals) — pastes
 *                whatever is currently on the system clipboard. This is the
 *                PRIMARY path WinSTT uses to deliver transcripts: the parent
 *                process snapshots the clipboard, writes the transcript,
 *                spawns this binary (no args), then restores the snapshot.
 *                One synthetic keystroke = one atomic paste in the target.
 *   --type       Read UTF-8 from stdin and inject each UTF-16 code unit via
 *                SendInput KEYEVENTF_UNICODE. The clipboard is never touched.
 *                Used by the parent as the FALLBACK path when Ctrl+V fails
 *                (e.g. Vim normal mode, some IMEs, DirectInput games).
 *                Per-char so visibly progressive — kept as a covering
 *                fallback rather than the default.
 *   --copy       SendInput Ctrl+C (or Ctrl+Shift+C in terminals) — used by
 *                the selection-capture trick when UIA can't read the focused
 *                control.
 *   --detect-only Print foreground window class / exe / terminal status.
 *
 * Why a native binary instead of PowerShell + SendInput:
 *  - PowerShell cold-start is 2-8s under Defender scanning.
 *  - Each fresh `.ps1` written to %TEMP% is re-scanned by AV.
 *  - SendInput from `winstt-paste.exe` doesn't trip AV's
 *    "paste-from-script" heuristic the same way as PowerShell does.
 *
 * Why SendInput Ctrl+V (and not WM_PASTE) in the clipboard-paste mode:
 *  - Modern Electron / browser / chat apps (Cursor, VS Code, Slack,
 *    Discord, Chromium-based editors, web inputs) don't process
 *    WM_PASTE — they listen for keyboard events directly. WM_PASTE
 *    works for native Win32 edit controls only, which is a small
 *    fraction of dictation targets.
 *  - SendInput Ctrl+V is the lingua franca of synthetic paste on
 *    Windows. The known failure mode is when an AV / accessibility
 *    keyboard hook stalls the input queue; we mitigate at the
 *    JS-side layer with a circuit-breaker cooldown after a timeout.
 *
 * Why KEYEVENTF_UNICODE for the typing fallback:
 *  - Covers targets that don't bind Ctrl+V to paste (Vim/Neovim normal
 *    mode, some IMEs). Each UTF-16 code unit becomes one keydown+keyup
 *    with `wVk=0, wScan=unit, dwFlags=KEYEVENTF_UNICODE`. Surrogate pairs
 *    are sent as two consecutive units in the same SendInput call so
 *    Windows recombines them.
 *  - Known limits: a few games and remote-desktop sessions ignore
 *    KEYEVENTF_UNICODE; if both primary and fallback fail, the parent
 *    trips a cooldown and drops the paste silently.
 *
 * Why only TWO modes, not a user-selectable PasteMethod enum:
 *  - Some paste utilities expose a `PasteMethod` enum with six choices
 *    (None / Direct / CtrlV / CtrlShiftV / ShiftInsert
 *    / ExternalScript). We deliberately don't. The clipboard-paste mode
 *    auto-picks Ctrl+Shift+V for the small set of terminal hosts that
 *    require it (see TERMINAL_CLASSES / TERMINAL_EXES below); the
 *    --type fallback covers anything that ignores Ctrl+V. Exposing more
 *    knobs to the user shifts a tuning problem onto them with no upside.
 *    If a future target genuinely needs ShiftInsert, add it to the
 *    terminal-detection branch — don't surface a method picker.
 *
 * Build: cl /O2 winstt-paste.c /Fe:winstt-paste.exe user32.lib
 *  - or: gcc -O2 winstt-paste.c -o winstt-paste.exe -luser32
 *
 * Cross-platform plan (NOT implemented — Windows-only today):
 *  - macOS: separate native module (Cocoa CGEventCreateKeyboardEvent
 *    with kVK_ANSI_V = 9, kCGEventFlagMaskCommand). Cmd+V is the system
 *    paste shortcut; like VK_V on Windows, kVK_ANSI_V is layout-
 *    independent. Needs accessibility-permission prompt at first run.
 *  - Linux/X11: XSendEvent on the focused window or libei (for Wayland-
 *    compatible apps). XK_V (0x76 keysym) ~ XKeysymToKeycode against
 *    the current XkbDescPtr; Wayland generally has no synthetic-input
 *    primitive outside privileged compositors, so on Wayland we'd
 *    likely fall back to xdotool-style ipc or wtype where available.
 *  - The JS orchestrator in `electron/lib/paste.ts` would dispatch per
 *    `process.platform` and the helpers would live alongside this file
 *    as `macstt-paste.m` and `linux-paste.c`. Today the JS guards with
 *    `process.platform !== "win32"` (see `shouldSkipPaste` in paste.ts).
 *
 * Exit codes:
 *   0 — paste/type/copy injected
 *   1 — SendInput refused some/all events
 *   2 — no foreground window
 *   3 — watchdog timeout (forced exit from watchdog thread)
 *   4 — --type with empty or unreadable stdin
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char* TERMINAL_CLASSES[] = {
    "ConsoleWindowClass",
    "CASCADIA_HOSTING_WINDOW_CLASS",
    "mintty",
    "VirtualConsoleClass",
    "PuTTY",
    "Alacritty",
    "org.wezfurlong.wezterm",
    "Hyper",
    "TMobaXterm",
    "kitty",
    NULL,
};

static const char* TERMINAL_EXES[] = {
    "termius.exe",
    "tabby.exe",
    "wave.exe",
    "rio.exe",
    "WindowsTerminal.exe",
    NULL,
};

static BOOL is_terminal_class(const char* class_name) {
    for (int i = 0; TERMINAL_CLASSES[i] != NULL; i++) {
        if (_stricmp(class_name, TERMINAL_CLASSES[i]) == 0) return TRUE;
    }
    return FALSE;
}

static BOOL is_terminal_exe(const char* exe_name) {
    for (int i = 0; TERMINAL_EXES[i] != NULL; i++) {
        if (_stricmp(exe_name, TERMINAL_EXES[i]) == 0) return TRUE;
    }
    return FALSE;
}

static BOOL get_exe_name(HWND hwnd, char* out, DWORD out_size) {
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == 0) return FALSE;

    HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!proc) return FALSE;

    char path[MAX_PATH];
    DWORD path_len = MAX_PATH;
    BOOL ok = QueryFullProcessImageNameA(proc, 0, path, &path_len);
    CloseHandle(proc);
    if (!ok || path_len == 0) return FALSE;

    const char* base = strrchr(path, '\\');
    base = base ? base + 1 : path;
    strncpy(out, base, out_size - 1);
    out[out_size - 1] = '\0';
    return TRUE;
}

/*
 * Build one INPUT record from a Win32 virtual-key code. Layout-INDEPENDENT
 * by construction:
 *
 *  - We set `wVk` (NOT `wScan`) and we do NOT set `KEYEVENTF_SCANCODE` in
 *    `dwFlags`. Per the Win32 KEYBDINPUT contract, with that flag clear the
 *    OS dispatches on `wVk` and silently ignores `wScan` for routing — it's
 *    carried along only so low-level keyboard hooks (some games, AV) can
 *    inspect a sensible scancode.
 *  - `wVk` is a virtual key code, not a character. ASCII letters A..Z
 *    (0x41..0x5A) double as VK codes for the corresponding alphabet keys
 *    by Microsoft's own definition (see learn.microsoft.com/.../virtual-
 *    key-codes — "0x56 V key"). So writing `'V'` is identical to writing
 *    a hypothetical `VK_V` macro; the Windows headers just don't define
 *    one because the ASCII fall-through is the documented convention.
 *  - Because we pass the VK code, the Windows input subsystem translates
 *    it against whatever keyboard layout the FOREGROUND THREAD currently
 *    has loaded. On AZERTY, ЙЦУКЕН, Dvorak, Colemak, etc. the kernel
 *    routes `wVk=0x56` to the physical key bound to V in THAT layout, so
 *    Ctrl+V always pastes regardless of layout.
 *  - `wScan` is filled in with `MapVirtualKeyA(vk, MAPVK_VK_TO_VSC)` for
 *    cosmetic completeness only — a few low-level hooks read it for
 *    diagnostics. `MapVirtualKeyA` itself is layout-aware (uses the
 *    current thread's layout), so even the cosmetic value matches what a
 *    real user keystroke would produce.
 *
 * If you ever switch to `KEYEVENTF_SCANCODE`, you MUST recompute `wScan`
 * against the target window's layout via
 * `MapVirtualKeyExA(vk, MAPVK_VK_TO_VSC_EX, GetKeyboardLayout(targetTid))`
 * or you will break Ctrl+V for every non-US-QWERTY user. Don't do it
 * without a reason; the current `wVk`-only path already covers that case.
 */
static void set_key(INPUT* input, WORD vk, DWORD flags) {
    input->type = INPUT_KEYBOARD;
    input->ki.wVk = vk;
    input->ki.wScan = (WORD)MapVirtualKeyA(vk, MAPVK_VK_TO_VSC);
    input->ki.dwFlags = flags;
    input->ki.time = 0;
    input->ki.dwExtraInfo = 0;
}

static const WORD MODIFIER_VKS[] = {
    VK_LCONTROL, VK_RCONTROL,
    VK_LSHIFT,   VK_RSHIFT,
    VK_LMENU,    VK_RMENU,
    VK_LWIN,     VK_RWIN,
};
#define NUM_MODIFIERS (sizeof(MODIFIER_VKS) / sizeof(MODIFIER_VKS[0]))

static int release_modifiers(WORD* released_out) {
    INPUT events[NUM_MODIFIERS];
    ZeroMemory(events, sizeof(events));
    int count = 0;
    for (int i = 0; i < (int)NUM_MODIFIERS; i++) {
        if (GetAsyncKeyState(MODIFIER_VKS[i]) & 0x8000) {
            released_out[count] = MODIFIER_VKS[i];
            set_key(&events[count], MODIFIER_VKS[i], KEYEVENTF_KEYUP);
            count++;
        }
    }
    if (count > 0) SendInput((UINT)count, events, sizeof(INPUT));
    return count;
}

static void restore_modifiers(WORD* released, int count) {
    if (count == 0) return;
    INPUT events[NUM_MODIFIERS];
    ZeroMemory(events, sizeof(events));
    for (int i = 0; i < count; i++) {
        set_key(&events[i], released[i], 0);
    }
    SendInput((UINT)count, events, sizeof(INPUT));
}

static int send_paste_normal(void) {
    INPUT events[4];
    ZeroMemory(events, sizeof(events));
    set_key(&events[0], VK_LCONTROL, 0);
    set_key(&events[1], 'V', 0);
    set_key(&events[2], 'V', KEYEVENTF_KEYUP);
    set_key(&events[3], VK_LCONTROL, KEYEVENTF_KEYUP);
    UINT sent = SendInput(4, events, sizeof(INPUT));
    return (sent == 4) ? 0 : 1;
}

static int send_paste_terminal(void) {
    INPUT events[6];
    ZeroMemory(events, sizeof(events));
    set_key(&events[0], VK_LCONTROL, 0);
    set_key(&events[1], VK_LSHIFT, 0);
    set_key(&events[2], 'V', 0);
    set_key(&events[3], 'V', KEYEVENTF_KEYUP);
    set_key(&events[4], VK_LSHIFT, KEYEVENTF_KEYUP);
    set_key(&events[5], VK_LCONTROL, KEYEVENTF_KEYUP);
    UINT sent = SendInput(6, events, sizeof(INPUT));
    return (sent == 6) ? 0 : 1;
}

static int send_copy_normal(void) {
    INPUT events[4];
    ZeroMemory(events, sizeof(events));
    set_key(&events[0], VK_LCONTROL, 0);
    set_key(&events[1], 'C', 0);
    set_key(&events[2], 'C', KEYEVENTF_KEYUP);
    set_key(&events[3], VK_LCONTROL, KEYEVENTF_KEYUP);
    UINT sent = SendInput(4, events, sizeof(INPUT));
    return (sent == 4) ? 0 : 1;
}

static int send_copy_terminal(void) {
    INPUT events[6];
    ZeroMemory(events, sizeof(events));
    set_key(&events[0], VK_LCONTROL, 0);
    set_key(&events[1], VK_LSHIFT, 0);
    set_key(&events[2], 'C', 0);
    set_key(&events[3], 'C', KEYEVENTF_KEYUP);
    set_key(&events[4], VK_LSHIFT, KEYEVENTF_KEYUP);
    set_key(&events[5], VK_LCONTROL, KEYEVENTF_KEYUP);
    UINT sent = SendInput(6, events, sizeof(INPUT));
    return (sent == 6) ? 0 : 1;
}

/*
 * Type a single UTF-16 code unit via SendInput. Used for both the high and
 * low halves of a surrogate pair (sent in the same SendInput batch so
 * Windows reassembles them into one Unicode codepoint).
 */
static void set_unicode_key(INPUT* input, WORD code_unit, DWORD extra_flags) {
    input->type = INPUT_KEYBOARD;
    input->ki.wVk = 0;
    input->ki.wScan = code_unit;
    input->ki.dwFlags = KEYEVENTF_UNICODE | extra_flags;
    input->ki.time = 0;
    input->ki.dwExtraInfo = 0;
}

/* Batched typing: we send a small fixed number of code units per SendInput
 * call. Anything larger risks SendInput dropping events under load, and the
 * surrogate-pair contract (high+low must arrive in the same call) is
 * preserved by always sending the pair together. */
#define TYPE_BATCH_UNITS 64

/*
 * Inject a UTF-16 string as synthetic keystrokes. Returns 0 on success, 1 if
 * SendInput refused any event. Each unit gets a paired keydown+keyup; high
 * and low surrogates are written into the same SendInput batch.
 */
static int send_unicode_text(const WCHAR* text, size_t units) {
    if (units == 0) return 0;

    INPUT batch[TYPE_BATCH_UNITS * 2];
    size_t i = 0;
    while (i < units) {
        size_t batch_units = 0;
        UINT event_count = 0;
        while (i < units && batch_units < TYPE_BATCH_UNITS) {
            WCHAR unit = text[i];
            BOOL is_high_surrogate = (unit >= 0xD800 && unit <= 0xDBFF);
            BOOL has_low_partner = (is_high_surrogate
                && i + 1 < units
                && text[i + 1] >= 0xDC00
                && text[i + 1] <= 0xDFFF);
            /* If a high surrogate would split across batches, flush now so
             * the pair goes together. */
            if (has_low_partner && batch_units + 2 > TYPE_BATCH_UNITS) {
                break;
            }
            ZeroMemory(&batch[event_count], sizeof(INPUT) * 2);
            set_unicode_key(&batch[event_count], unit, 0);
            set_unicode_key(&batch[event_count + 1], unit, KEYEVENTF_KEYUP);
            event_count += 2;
            i++;
            batch_units++;
            if (has_low_partner) {
                WCHAR low = text[i];
                ZeroMemory(&batch[event_count], sizeof(INPUT) * 2);
                set_unicode_key(&batch[event_count], low, 0);
                set_unicode_key(&batch[event_count + 1], low, KEYEVENTF_KEYUP);
                event_count += 2;
                i++;
                batch_units++;
            }
        }
        UINT sent = SendInput(event_count, batch, sizeof(INPUT));
        if (sent != event_count) {
            return 1;
        }
    }
    return 0;
}

/*
 * Read the entire stdin stream into a malloc'd UTF-8 buffer (NUL-terminated).
 * Caller frees with free(). Returns NULL on allocation failure or empty input.
 */
static char* read_stdin_utf8(size_t* out_len) {
    /* Put stdin in binary mode so CRLF isn't translated; we want bytes
     * exactly as the parent wrote them. */
    _setmode(_fileno(stdin), _O_BINARY);

    size_t cap = 1024;
    size_t len = 0;
    char* buf = (char*)malloc(cap);
    if (!buf) return NULL;

    while (1) {
        if (len + 1024 > cap) {
            size_t new_cap = cap * 2;
            char* new_buf = (char*)realloc(buf, new_cap);
            if (!new_buf) {
                free(buf);
                return NULL;
            }
            buf = new_buf;
            cap = new_cap;
        }
        size_t to_read = cap - len - 1;
        size_t n = fread(buf + len, 1, to_read, stdin);
        len += n;
        if (n < to_read) break; /* EOF or error */
    }

    if (len == 0) {
        free(buf);
        return NULL;
    }
    buf[len] = '\0';
    if (out_len) *out_len = len;
    return buf;
}

/*
 * Type the UTF-8 text on stdin into the foreground window. Returns the same
 * exit codes as the paste path. The caller is responsible for releasing /
 * restoring modifier keys around this call (we don't do it here so the main
 * function can keep the modifier handling identical to the paste path).
 */
static int do_type_from_stdin(void) {
    size_t utf8_len = 0;
    char* utf8 = read_stdin_utf8(&utf8_len);
    if (!utf8) {
        fprintf(stderr, "ERROR: --type received no input on stdin\n");
        return 4;
    }
    int wide_len = MultiByteToWideChar(CP_UTF8, 0, utf8, (int)utf8_len, NULL, 0);
    if (wide_len <= 0) {
        fprintf(stderr, "ERROR: stdin is not valid UTF-8\n");
        free(utf8);
        return 4;
    }
    WCHAR* wide = (WCHAR*)malloc(sizeof(WCHAR) * (size_t)wide_len);
    if (!wide) {
        free(utf8);
        fprintf(stderr, "ERROR: out of memory\n");
        return 4;
    }
    int converted = MultiByteToWideChar(CP_UTF8, 0, utf8, (int)utf8_len, wide, wide_len);
    free(utf8);
    if (converted != wide_len) {
        free(wide);
        fprintf(stderr, "ERROR: UTF-8 conversion produced %d / %d units\n", converted, wide_len);
        return 4;
    }
    int rc = send_unicode_text(wide, (size_t)wide_len);
    free(wide);
    return rc;
}

/*
 * Watchdog: if SendInput hangs because of an AV / accessibility
 * keyboard hook, we want THIS process to exit promptly so the
 * Electron parent's `child.on('close')` fires and the paste queue
 * advances. ExitProcess from a separate thread fires even when the
 * main thread is stuck in a kernel call, where TerminateProcess
 * from the parent would just sit waiting on the same kernel call.
 */
static DWORD WINAPI watchdog(LPVOID arg) {
    DWORD timeout_ms = (DWORD)(uintptr_t)arg;
    Sleep(timeout_ms);
    /* If we got here, the main thread didn't finish in time —
       force an immediate process exit. The parent will see exit
       code 3 and treat it as a paste failure. */
    ExitProcess(3);
    return 0;
}

#define WATCHDOG_TIMEOUT_MS 1500

int main(int argc, char* argv[]) {
    BOOL detect_only = FALSE;
    BOOL copy_mode = FALSE;
    BOOL type_mode = FALSE;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--detect-only") == 0) detect_only = TRUE;
        else if (strcmp(argv[i], "--copy") == 0) copy_mode = TRUE;
        else if (strcmp(argv[i], "--type") == 0) type_mode = TRUE;
    }

    HWND hwnd = GetForegroundWindow();
    if (!hwnd) {
        fprintf(stderr, "ERROR: no foreground window\n");
        return 2;
    }

    char class_name[256] = {0};
    if (GetClassNameA(hwnd, class_name, sizeof(class_name)) == 0) {
        fprintf(stderr, "ERROR: GetClassName failed (%lu)\n", GetLastError());
        return 1;
    }

    BOOL terminal = is_terminal_class(class_name);
    char exe_name[MAX_PATH] = {0};
    if (get_exe_name(hwnd, exe_name, sizeof(exe_name)) && !terminal) {
        terminal = is_terminal_exe(exe_name);
    }

    if (detect_only) {
        printf("WINDOW_CLASS %s\n", class_name);
        if (exe_name[0]) printf("EXE_NAME %s\n", exe_name);
        printf("IS_TERMINAL %s\n", terminal ? "true" : "false");
        fflush(stdout);
        return 0;
    }

    /* Arm the watchdog before we start touching the input queue. If
       any of release_modifiers / send_paste_* / restore_modifiers
       blocks (AV hook holding the queue), the watchdog forces
       ExitProcess(3) at WATCHDOG_TIMEOUT_MS, freeing the parent. */
    HANDLE wd = CreateThread(NULL, 0, watchdog, (LPVOID)(uintptr_t)WATCHDOG_TIMEOUT_MS, 0, NULL);

    Sleep(10); /* Tiny grace for focus to settle */

    WORD released[NUM_MODIFIERS];
    int released_count = release_modifiers(released);

    int rc;
    if (type_mode) {
        rc = do_type_from_stdin();
    } else if (copy_mode) {
        rc = terminal ? send_copy_terminal() : send_copy_normal();
    } else {
        rc = terminal ? send_paste_terminal() : send_paste_normal();
    }

    restore_modifiers(released, released_count);

    /* Disarm the watchdog — paste finished within budget. */
    if (wd != NULL) {
        TerminateThread(wd, 0);
        CloseHandle(wd);
    }

    if (rc != 0) {
        if (rc == 4) {
            /* read_stdin_utf8 / MultiByteToWideChar already wrote a
             * specific stderr message; preserve that exit code as-is. */
            return 4;
        }
        fprintf(stderr, "ERROR: SendInput failed (%lu)\n", GetLastError());
        return 1;
    }

    Sleep(20);
    if (type_mode) {
        printf("TYPE_OK %s\n", class_name);
    } else if (copy_mode) {
        printf("COPY_OK %s %s\n", class_name, terminal ? "ctrl+shift+c" : "ctrl+c");
    } else {
        printf("PASTE_OK %s %s\n", class_name, terminal ? "ctrl+shift+v" : "ctrl+v");
    }
    fflush(stdout);
    return 0;
}
