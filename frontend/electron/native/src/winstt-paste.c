/*
 * winstt-paste — Windows fast-paste binary for WinSTT.
 *
 * Why a native binary instead of PowerShell + SendInput:
 *  - PowerShell cold-start is 2-8s under Defender scanning.
 *  - Each fresh `.ps1` written to %TEMP% is re-scanned by AV.
 *  - SendInput from `winstt-paste.exe` doesn't trip AV's
 *    "paste-from-script" heuristic the same way as PowerShell does.
 *
 * Why SendInput Ctrl+V (and not WM_PASTE):
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
 * Build: cl /O2 winstt-paste.c /Fe:winstt-paste.exe user32.lib
 *  - or: gcc -O2 winstt-paste.c -o winstt-paste.exe -luser32
 *
 * Exit codes:
 *   0 — paste injected
 *   1 — SendInput refused some/all events
 *   2 — no foreground window
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
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
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--detect-only") == 0) detect_only = TRUE;
        else if (strcmp(argv[i], "--copy") == 0) copy_mode = TRUE;
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
    if (copy_mode) {
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
        fprintf(stderr, "ERROR: SendInput failed (%lu)\n", GetLastError());
        return 1;
    }

    Sleep(20);
    if (copy_mode) {
        printf("COPY_OK %s %s\n", class_name, terminal ? "ctrl+shift+c" : "ctrl+c");
    } else {
        printf("PASTE_OK %s %s\n", class_name, terminal ? "ctrl+shift+v" : "ctrl+v");
    }
    fflush(stdout);
    return 0;
}
