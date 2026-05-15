/*
 * winstt-context — UI Automation focused-element text reader for WinSTT.
 *
 * Why a native binary instead of a Node FFI wrapper:
 *   - UIA COM calls from FFI need a free-threaded apartment and large
 *     marshalling shims that bloat the Electron process for a feature
 *     that fires twice per dictation. A short-lived helper exits the
 *     process when done, so a hung accessibility-tree call cannot
 *     wedge the parent.
 *   - Mirrors the pattern of winstt-paste.exe: small C binary, hard
 *     watchdog, JSON on stdout, error on stderr.
 *
 * Output (stdout, single line, UTF-8 JSON):
 *   {"windowTitle":"...","elementName":"...","focusedText":"..."}
 *
 * Exit codes:
 *   0 — success (JSON emitted; fields may be empty strings)
 *   1 — COM init failure (no JSON)
 *   3 — watchdog timeout (process killed before main exit)
 *
 * Build:
 *   cl /O2 winstt-context.c /Fe:winstt-context.exe ole32.lib oleaut32.lib uuid.lib user32.lib
 *   gcc -O2 winstt-context.c -o winstt-context.exe -lole32 -loleaut32 -luuid -luser32
 */

#define WIN32_LEAN_AND_MEAN
#define CINTERFACE
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <oleauto.h>
#include <uiautomation.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>

/* Hard caps. Keep payload small — we want to disambiguate names,
   not exfiltrate documents. */
#define MAX_TITLE_CHARS    200
#define MAX_NAME_CHARS     200
#define MAX_CONTEXT_CHARS  1000

/* Buffer sizes in UTF-8 bytes. Worst-case UTF-16→UTF-8 expansion is 3x
   for BMP code points, 4x for surrogates. Use 4x to be safe. */
#define TITLE_BUF_BYTES    (MAX_TITLE_CHARS * 4 + 1)
#define NAME_BUF_BYTES     (MAX_NAME_CHARS * 4 + 1)
#define CONTEXT_BUF_BYTES  (MAX_CONTEXT_CHARS * 4 + 1)

/* JSON-escaped buffer needs ~6x of raw (\uXXXX is the worst case for
   sub-0x20 bytes). 8x gives a safety margin. */
#define TITLE_ESC_BYTES    (TITLE_BUF_BYTES * 8)
#define NAME_ESC_BYTES     (NAME_BUF_BYTES * 8)
#define CONTEXT_ESC_BYTES  (CONTEXT_BUF_BYTES * 8)

/* Watchdog kicks in if the UIA tree walk wedges (it can, on
   misbehaving apps or under accessibility hooks). 800ms is generous
   for normal flows (typical read is sub-50ms) but short enough that
   the parent's spawn timeout fires reliably. */
#define WATCHDOG_TIMEOUT_MS 800

static DWORD WINAPI watchdog(LPVOID arg) {
    DWORD t = (DWORD)(uintptr_t)arg;
    Sleep(t);
    ExitProcess(3);
    return 0;
}

/* Write a wide string into a UTF-8 byte buffer (NUL-terminated, truncating
   silently if the source is too long). Returns bytes written excl. NUL. */
static int wide_to_utf8(const wchar_t* src, int src_len, char* out, int out_size) {
    if (out_size <= 0) return 0;
    out[0] = '\0';
    if (!src || src_len <= 0) return 0;
    int written = WideCharToMultiByte(CP_UTF8, 0, src, src_len,
                                      out, out_size - 1, NULL, NULL);
    if (written <= 0) {
        out[0] = '\0';
        return 0;
    }
    out[written] = '\0';
    return written;
}

static int bstr_to_utf8(BSTR bstr, char* out, int out_size) {
    if (!bstr) {
        if (out_size > 0) out[0] = '\0';
        return 0;
    }
    UINT len = SysStringLen(bstr);
    return wide_to_utf8(bstr, (int)len, out, out_size);
}

/* Escape UTF-8 bytes into JSON-safe form. We pass raw multi-byte chars
   through untouched (valid UTF-8 stays valid in a JSON string). Only the
   structural bytes and ASCII control chars get escaped. */
static int json_escape_into(char* out, int out_size, const char* value) {
    int o = 0;
    if (out_size <= 0) return 0;
    if (!value) { out[0] = '\0'; return 0; }
    for (int i = 0; value[i] != '\0'; i++) {
        if (o + 7 >= out_size) break;
        unsigned char c = (unsigned char)value[i];
        switch (c) {
            case '"':  out[o++] = '\\'; out[o++] = '"';  break;
            case '\\': out[o++] = '\\'; out[o++] = '\\'; break;
            case '\b': out[o++] = '\\'; out[o++] = 'b';  break;
            case '\f': out[o++] = '\\'; out[o++] = 'f';  break;
            case '\n': out[o++] = '\\'; out[o++] = 'n';  break;
            case '\r': out[o++] = '\\'; out[o++] = 'r';  break;
            case '\t': out[o++] = '\\'; out[o++] = 't';  break;
            default:
                if (c < 0x20) {
                    int n = snprintf(out + o, out_size - o, "\\u%04x", c);
                    if (n < 0 || n >= out_size - o) { out[o] = '\0'; return o; }
                    o += n;
                } else {
                    out[o++] = (char)c;
                }
        }
    }
    out[o] = '\0';
    return o;
}

/* TextPattern: rich editors (browsers, Office, modern editors).
   GetText(maxLength) caps the pull at the source so we don't yank a
   100-page document for one dictation. */
static int read_text_pattern(IUIAutomationElement* elem, char* out, int out_size) {
    IUnknown* unk = NULL;
    HRESULT hr = IUIAutomationElement_GetCurrentPattern(elem, UIA_TextPatternId, &unk);
    if (FAILED(hr) || !unk) return -1;

    IUIAutomationTextPattern* pat = NULL;
    hr = IUnknown_QueryInterface(unk, &IID_IUIAutomationTextPattern, (void**)&pat);
    IUnknown_Release(unk);
    if (FAILED(hr) || !pat) return -1;

    IUIAutomationTextRange* range = NULL;
    hr = IUIAutomationTextPattern_get_DocumentRange(pat, &range);
    if (FAILED(hr) || !range) {
        IUIAutomationTextPattern_Release(pat);
        return -1;
    }

    BSTR text = NULL;
    hr = IUIAutomationTextRange_GetText(range, MAX_CONTEXT_CHARS, &text);
    IUIAutomationTextRange_Release(range);
    IUIAutomationTextPattern_Release(pat);
    if (FAILED(hr) || !text) return -1;

    int n = bstr_to_utf8(text, out, out_size);
    SysFreeString(text);
    return n > 0 ? 0 : -1;
}

/* TextPattern selection: returns the user's currently-selected text, if the
   focused element supports TextPattern and a selection exists. The selection
   API returns an array of ranges (multi-caret editors); we concatenate them
   so a discontinuous selection still round-trips. */
static int read_text_pattern_selection(IUIAutomationElement* elem,
                                        char* out, int out_size) {
    if (out_size > 0) out[0] = '\0';

    IUnknown* unk = NULL;
    HRESULT hr = IUIAutomationElement_GetCurrentPattern(elem, UIA_TextPatternId, &unk);
    if (FAILED(hr) || !unk) return -1;

    IUIAutomationTextPattern* pat = NULL;
    hr = IUnknown_QueryInterface(unk, &IID_IUIAutomationTextPattern, (void**)&pat);
    IUnknown_Release(unk);
    if (FAILED(hr) || !pat) return -1;

    IUIAutomationTextRangeArray* ranges = NULL;
    hr = IUIAutomationTextPattern_GetSelection(pat, &ranges);
    IUIAutomationTextPattern_Release(pat);
    if (FAILED(hr) || !ranges) return -1;

    int length = 0;
    hr = IUIAutomationTextRangeArray_get_Length(ranges, &length);
    if (FAILED(hr) || length <= 0) {
        IUIAutomationTextRangeArray_Release(ranges);
        return -1;
    }

    int written_total = 0;
    int budget = out_size - 1;
    for (int i = 0; i < length && budget > 0; i++) {
        IUIAutomationTextRange* range = NULL;
        if (FAILED(IUIAutomationTextRangeArray_GetElement(ranges, i, &range)) || !range) {
            continue;
        }
        BSTR text = NULL;
        /* GetText(-1) returns the entire range — fine here because we already
           expect the user's selection to be bounded. */
        if (SUCCEEDED(IUIAutomationTextRange_GetText(range, -1, &text)) && text) {
            char tmp[CONTEXT_BUF_BYTES];
            bstr_to_utf8(text, tmp, sizeof(tmp));
            SysFreeString(text);

            int tmp_len = (int)strlen(tmp);
            if (tmp_len > 0) {
                int copy_len = tmp_len < budget ? tmp_len : budget;
                memcpy(out + written_total, tmp, (size_t)copy_len);
                written_total += copy_len;
                budget -= copy_len;
            }
        }
        IUIAutomationTextRange_Release(range);
    }
    IUIAutomationTextRangeArray_Release(ranges);

    out[written_total] = '\0';
    return written_total > 0 ? 0 : -1;
}

/* ValuePattern: plain edit controls (address bars, single-line inputs). */
static int read_value_pattern(IUIAutomationElement* elem, char* out, int out_size) {
    IUnknown* unk = NULL;
    HRESULT hr = IUIAutomationElement_GetCurrentPattern(elem, UIA_ValuePatternId, &unk);
    if (FAILED(hr) || !unk) return -1;

    IUIAutomationValuePattern* pat = NULL;
    hr = IUnknown_QueryInterface(unk, &IID_IUIAutomationValuePattern, (void**)&pat);
    IUnknown_Release(unk);
    if (FAILED(hr) || !pat) return -1;

    BSTR text = NULL;
    hr = IUIAutomationValuePattern_get_CurrentValue(pat, &text);
    IUIAutomationValuePattern_Release(pat);
    if (FAILED(hr) || !text) return -1;

    int n = bstr_to_utf8(text, out, out_size);
    SysFreeString(text);
    return n > 0 ? 0 : -1;
}

static int read_element_name(IUIAutomationElement* elem, char* out, int out_size) {
    BSTR name = NULL;
    HRESULT hr = IUIAutomationElement_get_CurrentName(elem, &name);
    if (FAILED(hr) || !name) return -1;
    int n = bstr_to_utf8(name, out, out_size);
    SysFreeString(name);
    return n > 0 ? 0 : -1;
}

static void get_window_title(HWND hwnd, char* out, int out_size) {
    if (out_size > 0) out[0] = '\0';
    if (!hwnd) return;
    wchar_t buf[512];
    int n = GetWindowTextW(hwnd, buf, 512);
    if (n > 0) wide_to_utf8(buf, n, out, out_size);
}

/* Read context from the focused element. Walks fallbacks: TextPattern →
   ValuePattern → element name. Returns 0 if anything was read. When
   selection_only is true, only the selection-range path is attempted —
   no fallback to document/value text, so the caller knows the field is
   intentionally empty when nothing is highlighted. */
static int read_focused_context(IUIAutomation* uia,
                                char* out_text, int out_text_size,
                                char* out_name, int out_name_size,
                                int selection_only) {
    IUIAutomationElement* focused = NULL;
    HRESULT hr = IUIAutomation_GetFocusedElement(uia, &focused);
    if (FAILED(hr) || !focused) return -1;

    read_element_name(focused, out_name, out_name_size);

    int rc;
    if (selection_only) {
        rc = read_text_pattern_selection(focused, out_text, out_text_size);
    } else {
        rc = read_text_pattern(focused, out_text, out_text_size);
        if (rc != 0) {
            rc = read_value_pattern(focused, out_text, out_text_size);
        }
    }

    IUIAutomationElement_Release(focused);
    return rc;
}

int main(int argc, char* argv[]) {
    int selection_only = 0;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--selection") == 0) selection_only = 1;
    }

    HANDLE wd = CreateThread(NULL, 0, watchdog,
                             (LPVOID)(uintptr_t)WATCHDOG_TIMEOUT_MS, 0, NULL);

    char window_title[TITLE_BUF_BYTES] = {0};
    char element_name[NAME_BUF_BYTES] = {0};
    char focused_text[CONTEXT_BUF_BYTES] = {0};

    /* Snapshot foreground window title up front — it's the most useful
       signal even when UIA fails (e.g., elevated target). */
    HWND fg = GetForegroundWindow();
    get_window_title(fg, window_title, sizeof(window_title));

    HRESULT hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    /* RPC_E_CHANGED_MODE is harmless — means COM was already initialized
       differently in this process (won't happen for a fresh helper but
       guard anyway). */
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
        fprintf(stderr, "ERROR: CoInitializeEx failed (0x%lx)\n", (unsigned long)hr);
        if (wd) { TerminateThread(wd, 0); CloseHandle(wd); }
        return 1;
    }

    IUIAutomation* uia = NULL;
    hr = CoCreateInstance(&CLSID_CUIAutomation, NULL, CLSCTX_INPROC_SERVER,
                          &IID_IUIAutomation, (void**)&uia);
    if (SUCCEEDED(hr) && uia) {
        read_focused_context(uia, focused_text, sizeof(focused_text),
                             element_name, sizeof(element_name),
                             selection_only);
        IUIAutomation_Release(uia);
    }

    CoUninitialize();

    /* Defensive truncation: even if the BSTR was big, never write more than
       the cap (escape stage allocates 8x of this). */
    if ((int)strlen(focused_text) > MAX_CONTEXT_CHARS * 4) {
        focused_text[MAX_CONTEXT_CHARS * 4] = '\0';
    }

    char title_esc[TITLE_ESC_BYTES];
    char name_esc[NAME_ESC_BYTES];
    char text_esc[CONTEXT_ESC_BYTES];
    json_escape_into(title_esc, sizeof(title_esc), window_title);
    json_escape_into(name_esc, sizeof(name_esc), element_name);
    json_escape_into(text_esc, sizeof(text_esc), focused_text);

    printf("{\"windowTitle\":\"%s\",\"elementName\":\"%s\",\"focusedText\":\"%s\"}",
           title_esc, name_esc, text_esc);
    fflush(stdout);

    if (wd) { TerminateThread(wd, 0); CloseHandle(wd); }
    return 0;
}
