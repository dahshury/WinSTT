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
 * Modes:
 *   (default)   — Read focused element's text via TextPattern/ValuePattern.
 *                 Outputs windowTitle, elementName, focusedText.
 *   --selection — Like default but only returns the user's selected text.
 *   --split     — Caret-aware split: textBefore / textAfter around the
 *                 caret/selection. Falls back to whole-text if no caret.
 *   --tree      — Wispr-style: walks the focused window's UIA subtree and
 *                 emits a hierarchical axHTML serialization. Includes
 *                 process exe name + browser URL (when applicable) for
 *                 deny-list matching. Skips password fields entirely.
 *
 * Output (stdout, single line, UTF-8 JSON):
 *   {"windowTitle":"...","elementName":"...","focusedText":"...",
 *    "textBefore":"...","textAfter":"...","axHtml":"...","url":"...",
 *    "appExe":"..."}
 *
 *   Caret-mode and tree-mode are independent and can both be empty when
 *   the focused control exposes neither a caret nor a meaningful tree.
 *
 * Exit codes:
 *   0 — success (JSON emitted; fields may be empty strings)
 *   1 — COM init failure (no JSON)
 *   3 — watchdog timeout (process killed before main exit)
 *
 * Build:
 *   cl /O2 winstt-context.c /Fe:winstt-context.exe ole32.lib oleaut32.lib uuid.lib user32.lib
 *   gcc -O2 winstt-context.c -o winstt-context.exe -lole32 -loleaut32 -luuid -luser32
 *
 * (QueryFullProcessImageNameW lives in kernel32 since Vista, so we don't
 * need to link psapi.)
 */

#define WIN32_LEAN_AND_MEAN
#define CINTERFACE
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <oleauto.h>
#include <uiautomation.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* Hard caps. Keep payload small — we want to disambiguate names,
   not exfiltrate documents. */
#define MAX_TITLE_CHARS    200
#define MAX_NAME_CHARS     200
/* Whole-field + caret context budget. Raised 1000 → 6000 → 24000 so the LLM
   sees ~100 chat turns / a very long email or message being replied to, not
   just the last few hundred chars before the caret (a long quoted email used to
   get its opening cropped — see
   memory/project_context_capture_extraction_strategy.md). The escape buffers
   that scale with this (text/before/after) are heap-allocated in main() because
   at 24000 chars × 4 (UTF-8) × 8 (escape) they'd be ~768KB each — far too large
   for the stack. The three RAW context buffers (focused_text/context_before/
   context_after, CONTEXT_BUF_BYTES ≈ 96KB each) are declared `static` in main()
   for the same reason — 3 × 96KB of auto storage alongside the deep UIA
   recursion would risk a stack overflow. NOTE: the production consumer
   electron/lib/context-reader.ts must keep a maxBuffer >= ~4MB; raising this
   cap raised worst-case stdout to ~2.7MB. */
#define MAX_CONTEXT_CHARS  24000
#define MAX_EXE_CHARS      120
#define MAX_URL_CHARS      400

/* Caret-split caps. The tail right before the caret is what decides
   "continue this sentence vs. start fresh" AND carries the quoted email/message
   the user is replying to, so it gets the larger share; the lookahead after the
   caret only needs enough to avoid duplicating text the output sits in front of.
   Sum (21000 + 2000 = 23000) stays strictly UNDER MAX_CONTEXT_CHARS (24000).
   before/after are written to SEPARATE CONTEXT_BUF_BYTES buffers (never
   concatenated), so the real bound is per-half; the sum is kept < MAX anyway so
   the documented invariant holds with 1000 chars of slack. 21000 covers ~100
   chat turns / a very long email; a truly enormous one crops its oldest lines,
   which is acceptable (the recent text nearest the caret is highest-signal). */
#define CARET_BEFORE_CHARS 21000
#define CARET_AFTER_CHARS  2000

/* Tree-walk caps. Total payload + depth match Wispr Flow's documented
   limits (150,000 chars / forensic-observed depth 9); the element count
   is our own backstop.
   - 200 chars per INCIDENTAL name/value: enough to disambiguate a
     nav-bar label or proper noun without bloating the tree.
   - MAX_CONTENT_VALUE_CHARS: the focused field / Document / Edit element
     is the CONTENT the user acts on (an email body, a message, a doc).
     Capping it at 200 like everything else is exactly why "reply to this
     email" never saw the email — the body lives in one element whose
     GetText was truncated to the nav header. Give that one element the
     full pull (bounded by the 150,000-char axHtml budget regardless).
     See memory/project_context_capture_extraction_strategy.md. */
#define MAX_AXHTML_CHARS       150000
#define MAX_TREE_DEPTH         9
#define MAX_TREE_ELEMENTS      300
#define MAX_ELEMENT_VALUE_CHARS 200
#define MAX_CONTENT_VALUE_CHARS 50000

/* Buffer sizes in UTF-8 bytes. Worst-case UTF-16→UTF-8 expansion is 3x
   for BMP code points, 4x for surrogates. Use 4x to be safe. */
#define TITLE_BUF_BYTES    (MAX_TITLE_CHARS * 4 + 1)
#define NAME_BUF_BYTES     (MAX_NAME_CHARS * 4 + 1)
#define CONTEXT_BUF_BYTES  (MAX_CONTEXT_CHARS * 4 + 1)
#define EXE_BUF_BYTES      (MAX_EXE_CHARS * 4 + 1)
#define URL_BUF_BYTES      (MAX_URL_CHARS * 4 + 1)
#define AXHTML_BUF_BYTES   (MAX_AXHTML_CHARS + 1)
/* Heap-only (200KB+) — the focused content element's full text. Sized in
   chars*4 for worst-case UTF-8 expansion, like the other buffers. */
#define CONTENT_VALUE_BUF_BYTES (MAX_CONTENT_VALUE_CHARS * 4 + 1)
/* Per-element INCIDENTAL value buffer used inside the recursive tree walk. It
   only ever holds a ≤MAX_ELEMENT_VALUE_CHARS (200-char) nav/label value — the
   big focused/Document/Edit body uses the heap content_buf instead. Sized off
   MAX_ELEMENT_VALUE_CHARS (NOT MAX_CONTEXT_CHARS) so raising the context cap
   doesn't multiply this across the 9 recursion frames and overflow the stack. */
#define INCIDENTAL_VALUE_BUF_BYTES (MAX_ELEMENT_VALUE_CHARS * 4 + 1)

/* JSON-escaped buffer needs ~6x of raw (\uXXXX is the worst case for
   sub-0x20 bytes). 8x gives a safety margin. The axHtml buffer is
   already shaped like XML — quotes are the dominant escape and stay
   ≤2x — so a 3x cap keeps the worst-case stdout under 500KB. */
#define TITLE_ESC_BYTES    (TITLE_BUF_BYTES * 8)
#define NAME_ESC_BYTES     (NAME_BUF_BYTES * 8)
#define CONTEXT_ESC_BYTES  (CONTEXT_BUF_BYTES * 8)
#define EXE_ESC_BYTES      (EXE_BUF_BYTES * 8)
#define URL_ESC_BYTES      (URL_BUF_BYTES * 8)
#define AXHTML_ESC_BYTES   (AXHTML_BUF_BYTES * 3)

/* Watchdog kicks in if the UIA tree walk wedges (it can, on
   misbehaving apps or under accessibility hooks). 750ms matches
   Wispr Flow's documented ceiling exactly — short enough that the
   parent's spawn timeout fires reliably; long enough that a deep
   Outlook/Word tree finishes in time on a warm box. The tree walker
   itself checks elapsed time at every node and stops cleanly when
   ~600ms have passed, so the watchdog is the hard backstop, not the
   normal exit. */
#define WATCHDOG_TIMEOUT_MS 750
/* Cooperative deadline for the tree walker. Leaves 150ms headroom
   for the watchdog to wake up and JSON to flush after a graceful
   stop. */
#define TREE_WALK_BUDGET_MS 600

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
   Pass -1 (no source-side limit) and let the caller's `out_size` buffer
   decide how much we keep — this is Microsoft's canonical email-reader
   pattern (DocumentRange.GetText(-1)). A small buffer (incidental labels)
   still truncates cheaply; the focused content buffer is large on purpose
   so an email/message body survives instead of stopping at the header. */
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
    hr = IUIAutomationTextRange_GetText(range, -1, &text);
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
            /* static (NOT auto): at MAX_CONTEXT_CHARS=24000 this is
               CONTEXT_BUF_BYTES ≈ 96KB — too large for the stack frame of a
               function reachable from the UIA walk. It's filled then fully
               copied out before the next loop iteration / any recursion, so a
               single shared static instance is safe here (no re-entrant use of
               tmp's contents across calls). */
            static char tmp[CONTEXT_BUF_BYTES];
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

/* Lowercase an ASCII A-Z wide string in place. Exe names are ASCII, so this
   is enough for stable case-insensitive comparisons (deny-list, IDE match). */
static void lowercase_wide_ascii(wchar_t* s) {
    for (wchar_t* p = s; *p; p++) {
        if (*p >= L'A' && *p <= L'Z') *p = (wchar_t)(*p - L'A' + L'a');
    }
}

/* Return a pointer to the basename within a full path (after the last
   backslash or forward slash). */
static wchar_t* wide_basename(wchar_t* path) {
    wchar_t* base = path;
    for (wchar_t* p = path; *p; p++) {
        if (*p == L'\\' || *p == L'/') base = p + 1;
    }
    return base;
}

/* Primary resolver: open the process and read its image path. Exact and fast,
   but OpenProcess is DENIED when the target runs at a higher integrity level
   than this (non-elevated) helper. Returns 1 on success, 0 on failure. */
static int exe_via_open_process(DWORD pid, char* out, int out_size) {
    HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!proc) return 0;
    wchar_t path[MAX_PATH];
    DWORD path_len = MAX_PATH;
    if (!QueryFullProcessImageNameW(proc, 0, path, &path_len)) {
        CloseHandle(proc);
        return 0;
    }
    CloseHandle(proc);
    wchar_t* base = wide_basename(path);
    lowercase_wide_ascii(base);
    /* Pass the REAL length, not -1: wide_to_utf8 rejects src_len <= 0, so the
       "-1 means null-terminated" convention silently produced an empty string
       (the original bug that left appExe blank for EVERY app). */
    wide_to_utf8(base, (int)wcslen(base), out, out_size);
    return 1;
}

/* Fallback resolver: scan the system process list via a Toolhelp snapshot.
   Unlike OpenProcess this needs NO handle to the target, so it succeeds for
   ELEVATED / higher-integrity foreground windows (e.g. an admin-launched
   editor or terminal) where the primary path returns ACCESS_DENIED — the
   exact case that left appExe empty and silently disabled BOTH the deny-list
   and IDE detection. PROCESSENTRY32W.szExeFile is already a bare basename.
   Returns 1 on success, 0 if the pid wasn't found. */
static int exe_via_toolhelp(DWORD pid, char* out, int out_size) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W entry;
    entry.dwSize = sizeof(entry);
    int found = 0;
    if (Process32FirstW(snap, &entry)) {
        do {
            if (entry.th32ProcessID == pid) {
                lowercase_wide_ascii(entry.szExeFile);
                wide_to_utf8(entry.szExeFile, (int)wcslen(entry.szExeFile), out, out_size);
                found = 1;
                break;
            }
        } while (Process32NextW(snap, &entry));
    }
    CloseHandle(snap);
    return found;
}

/* Get the foreground window's process executable basename (lowercased,
   e.g. "chrome.exe", "outlook.exe", "code.exe"). This is the load-bearing
   signal for deny-list matching and for app/IDE detection downstream —
   exe name is far more reliable than the window title for "what app am
   I in." Tries OpenProcess first, then the handle-free Toolhelp snapshot so
   elevated targets still resolve. Empty only when the window has no pid. */
static void get_process_exe(HWND hwnd, char* out, int out_size) {
    if (out_size > 0) out[0] = '\0';
    if (!hwnd) return;
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (!pid) return;
    if (!exe_via_open_process(pid, out, out_size)) {
        exe_via_toolhelp(pid, out, out_size);
    }
    /* wide_to_utf8(-1) copies the NUL terminator; trim any trailing one. */
    int len = (int)strlen(out);
    if (len > 0 && out[len - 1] == '\0') {
        out[len - 1] = '\0';
    }
}

/* Caret-aware split: pull the tail of the document immediately BEFORE the
   caret/selection start and the head immediately AFTER the selection end.
   This lets the LLM decide whether the dictation continues an unfinished
   sentence (no capitalization, add a joining space/comma) or starts a new
   one. Returns 0 when the TextPattern + a selection range were obtained
   (either side may legitimately be empty — caret at the very start/end);
   -1 when the element exposes no TextPattern caret, so the caller can fall
   back to the whole-text read. */
static int read_caret_split(IUIAutomationElement* elem,
                            char* out_before, int out_before_size,
                            char* out_after, int out_after_size) {
    if (out_before_size > 0) out_before[0] = '\0';
    if (out_after_size > 0) out_after[0] = '\0';

    IUnknown* unk = NULL;
    HRESULT hr = IUIAutomationElement_GetCurrentPattern(elem, UIA_TextPatternId, &unk);
    if (FAILED(hr) || !unk) return -1;

    IUIAutomationTextPattern* pat = NULL;
    hr = IUnknown_QueryInterface(unk, &IID_IUIAutomationTextPattern, (void**)&pat);
    IUnknown_Release(unk);
    if (FAILED(hr) || !pat) return -1;

    IUIAutomationTextRange* doc = NULL;
    hr = IUIAutomationTextPattern_get_DocumentRange(pat, &doc);
    if (FAILED(hr) || !doc) {
        IUIAutomationTextPattern_Release(pat);
        return -1;
    }

    IUIAutomationTextRangeArray* sels = NULL;
    hr = IUIAutomationTextPattern_GetSelection(pat, &sels);
    IUIAutomationTextPattern_Release(pat);
    if (FAILED(hr) || !sels) {
        IUIAutomationTextRange_Release(doc);
        return -1;
    }
    int sel_len = 0;
    IUIAutomationTextRangeArray_get_Length(sels, &sel_len);
    IUIAutomationTextRange* sel = NULL;
    if (sel_len > 0) {
        IUIAutomationTextRangeArray_GetElement(sels, 0, &sel);
    }
    IUIAutomationTextRangeArray_Release(sels);
    if (!sel) {
        IUIAutomationTextRange_Release(doc);
        return -1;
    }

    int rc = -1;
    BSTR text = NULL;

    /* BEFORE: [docStart, caretStart], then keep only the trailing
       CARET_BEFORE_CHARS so a huge document doesn't crowd out the tail
       that actually decides the continuation. */
    IUIAutomationTextRange* before = NULL;
    if (SUCCEEDED(IUIAutomationTextRange_Clone(doc, &before)) && before) {
        IUIAutomationTextRange_MoveEndpointByRange(
            before, TextPatternRangeEndpoint_End,
            sel, TextPatternRangeEndpoint_Start);
        IUIAutomationTextRange* tail = NULL;
        if (SUCCEEDED(IUIAutomationTextRange_Clone(before, &tail)) && tail) {
            int moved = 0;
            IUIAutomationTextRange_MoveEndpointByRange(
                tail, TextPatternRangeEndpoint_Start,
                tail, TextPatternRangeEndpoint_End);
            IUIAutomationTextRange_MoveEndpointByUnit(
                tail, TextPatternRangeEndpoint_Start,
                TextUnit_Character, -CARET_BEFORE_CHARS, &moved);
            if (SUCCEEDED(IUIAutomationTextRange_GetText(tail, -1, &text)) && text) {
                bstr_to_utf8(text, out_before, out_before_size);
                SysFreeString(text);
                text = NULL;
            }
            IUIAutomationTextRange_Release(tail);
        }
        IUIAutomationTextRange_Release(before);
        rc = 0;
    }

    /* AFTER: [caretEnd, docEnd], capped at the head. */
    IUIAutomationTextRange* after = NULL;
    if (SUCCEEDED(IUIAutomationTextRange_Clone(doc, &after)) && after) {
        IUIAutomationTextRange_MoveEndpointByRange(
            after, TextPatternRangeEndpoint_Start,
            sel, TextPatternRangeEndpoint_End);
        if (SUCCEEDED(IUIAutomationTextRange_GetText(after, CARET_AFTER_CHARS, &text))
            && text) {
            bstr_to_utf8(text, out_after, out_after_size);
            SysFreeString(text);
            text = NULL;
        }
        IUIAutomationTextRange_Release(after);
        rc = 0;
    }

    IUIAutomationTextRange_Release(sel);
    IUIAutomationTextRange_Release(doc);
    return rc;
}

/* When non-NULL (set by --hwnd), focused-element reads are scoped to this
   window's UIA subtree instead of the OS-global focused element. Lets the
   context-harness capture a specific, possibly NON-foreground Chrome window
   deterministically — no flaky SetForegroundWindow race. NULL in normal
   dictation use, where the helper reads whatever window is foreground. */
static HWND g_scope_hwnd = NULL;

/* Find the keyboard-focused element inside g_scope_hwnd's window via a single
   FindFirst(HasKeyboardFocus==TRUE) over the whole subtree — depth-unbounded
   (Gmail's reply box sits ~15 levels deep, far past the walker's depth cap, so
   a bounded recursion missed it). Returns an AddRef'd element (caller releases)
   or NULL. */
static IUIAutomationElement* find_focused_in_window(IUIAutomation* uia, HWND hwnd) {
    IUIAutomationElement* root = NULL;
    if (FAILED(IUIAutomation_ElementFromHandle(uia, hwnd, &root)) || !root) return NULL;

    VARIANT v;
    VariantInit(&v);
    v.vt = VT_BOOL;
    v.boolVal = VARIANT_TRUE;
    IUIAutomationCondition* cond = NULL;
    HRESULT hr = IUIAutomation_CreatePropertyCondition(
        uia, UIA_HasKeyboardFocusPropertyId, v, &cond);
    VariantClear(&v);
    if (FAILED(hr) || !cond) { IUIAutomationElement_Release(root); return NULL; }

    IUIAutomationElement* focused = NULL;
    /* TreeScope_Subtree = the root itself + all descendants. */
    IUIAutomationElement_FindFirst(root, TreeScope_Subtree, cond, &focused);
    IUIAutomationCondition_Release(cond);
    IUIAutomationElement_Release(root);
    return focused;
}

/* Acquire the focused element. With --hwnd (g_scope_hwnd) the read is STRICTLY
   scoped to that window — we never fall back to GetFocusedElement, because the
   OS-global focus belongs to a DIFFERENT window (e.g. the launching terminal),
   and capturing it would be wrong-window data. Without --hwnd, normal dictation
   behaviour: the OS-global focused element. Caller releases. This is the ONLY
   focused-element entry point, so --hwnd transparently redirects every mode. */
static IUIAutomationElement* acquire_focused_element(IUIAutomation* uia) {
    if (g_scope_hwnd) {
        return find_focused_in_window(uia, g_scope_hwnd);
    }
    IUIAutomationElement* el = NULL;
    IUIAutomation_GetFocusedElement(uia, &el);
    return el;
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
    IUIAutomationElement* focused = acquire_focused_element(uia);
    if (!focused) return -1;

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

/* --split entry point. Reads the element name + the caret-split before/after
   text. If the focused control exposes no TextPattern caret, falls back to
   the whole-text read into out_text so callers still get *some* context
   (older behavior) rather than nothing. */
static void read_focused_split(IUIAutomation* uia,
                               char* out_before, int out_before_size,
                               char* out_after, int out_after_size,
                               char* out_text, int out_text_size,
                               char* out_name, int out_name_size) {
    IUIAutomationElement* focused = acquire_focused_element(uia);
    if (!focused) return;

    read_element_name(focused, out_name, out_name_size);

    if (read_caret_split(focused, out_before, out_before_size,
                          out_after, out_after_size) != 0) {
        /* No caret available — degrade to the legacy whole-text read. */
        if (read_text_pattern(focused, out_text, out_text_size) != 0) {
            read_value_pattern(focused, out_text, out_text_size);
        }
    }

    IUIAutomationElement_Release(focused);
}

/* ───────────────────────── --tree mode ─────────────────────────────── */

/* Map a UIA ControlType to a short XML tag name. Roles are intentionally
   compact (3-9 chars) — every byte counts against the 150K budget when
   walking a deep app like Outlook. Anything unrecognized maps to "el" so
   the LLM still sees structure.

   NOTE: UIA control-type IDs are declared `extern const CONTROLTYPEID`
   in uiautomation.h (resolved at link time from uiautomationclient),
   not compile-time constants — so they cannot be `case` labels. We use
   an if/else chain instead. The compiler folds this into a jump table
   under /O2, so the perf difference vs a switch is undetectable for a
   table this small. */
static const char* role_name(CONTROLTYPEID id) {
    if (id == UIA_WindowControlTypeId)      return "window";
    if (id == UIA_DocumentControlTypeId)    return "doc";
    if (id == UIA_EditControlTypeId)        return "edit";
    if (id == UIA_TextControlTypeId)        return "text";
    if (id == UIA_ButtonControlTypeId)      return "button";
    if (id == UIA_HyperlinkControlTypeId)   return "link";
    if (id == UIA_ListControlTypeId)        return "list";
    if (id == UIA_ListItemControlTypeId)    return "item";
    if (id == UIA_MenuControlTypeId)        return "menu";
    if (id == UIA_MenuItemControlTypeId)    return "menuitem";
    if (id == UIA_TabControlTypeId)         return "tabs";
    if (id == UIA_TabItemControlTypeId)     return "tab";
    if (id == UIA_TreeControlTypeId)        return "tree";
    if (id == UIA_TreeItemControlTypeId)    return "node";
    if (id == UIA_DataItemControlTypeId)    return "row";
    if (id == UIA_GroupControlTypeId)       return "group";
    if (id == UIA_PaneControlTypeId)        return "pane";
    if (id == UIA_ToolBarControlTypeId)     return "toolbar";
    if (id == UIA_StatusBarControlTypeId)   return "status";
    if (id == UIA_ComboBoxControlTypeId)    return "combo";
    if (id == UIA_CheckBoxControlTypeId)    return "check";
    if (id == UIA_RadioButtonControlTypeId) return "radio";
    if (id == UIA_HeaderItemControlTypeId)  return "header";
    if (id == UIA_ImageControlTypeId)       return "image";
    if (id == UIA_TableControlTypeId)       return "table";
    if (id == UIA_HeaderControlTypeId)      return "thead";
    return "el";
}

/* Skip rules: structural elements with no name and no value carry no
   semantic value for the LLM, but their children might — so we recurse
   THROUGH them without emitting a tag (saves ~20 bytes per skipped
   pane/group, which adds up fast in tree-heavy apps). */
static int is_structural_role(CONTROLTYPEID id) {
    return id == UIA_GroupControlTypeId
        || id == UIA_PaneControlTypeId
        || id == UIA_ToolBarControlTypeId;
}

/* Output appender. Bounds-checked at every call site so the buffer can
   never overflow even if a single emit would exceed the cap. Returns 0
   on success, -1 when the buffer is full (caller stops walking). */
typedef struct {
    char* buf;
    int   offset;
    int   capacity;
    int   element_count;
    DWORD start_tick;
    /* Scratch buffer for the focused/content element's full text. Heap
       (CONTENT_VALUE_BUF_BYTES is ~200KB) so it stays off the recursive
       stack; reused per content element. NULL when allocation failed —
       walk_tree falls back to the compact per-element cap. */
    char* content_buf;
    /* Longest content-element text captured this walk. Drives the cold-tree
       retry: a browser walk that yields ~0 content text is likely a lazy
       Chromium a11y tree that wasn't realized yet. */
    int   content_chars;
} TreeBuilder;

static int tb_has_budget(const TreeBuilder* tb) {
    if (tb->element_count >= MAX_TREE_ELEMENTS) return 0;
    if (tb->offset >= tb->capacity - 64) return 0;
    if ((GetTickCount() - tb->start_tick) >= TREE_WALK_BUDGET_MS) return 0;
    return 1;
}

static void tb_emit(TreeBuilder* tb, const char* s) {
    while (*s && tb->offset < tb->capacity - 1) {
        tb->buf[tb->offset++] = *s++;
    }
    tb->buf[tb->offset] = '\0';
}

static void tb_indent(TreeBuilder* tb, int depth) {
    int n = depth * 2;
    while (n-- > 0 && tb->offset < tb->capacity - 1) {
        tb->buf[tb->offset++] = ' ';
    }
    tb->buf[tb->offset] = '\0';
}

/* Escape a UTF-8 string into XML attribute/text form, capping at cap
   characters (chars, not bytes — multi-byte sequences are passed through
   intact). Trims trailing whitespace runs and collapses internal
   newlines to spaces so the output stays single-line per element. */
static void tb_emit_xml_escaped(TreeBuilder* tb, const char* s, int cap) {
    int emitted = 0;
    int last_space = 0;
    while (*s && emitted < cap && tb->offset < tb->capacity - 8) {
        unsigned char c = (unsigned char)*s;
        /* Drop pure-noise codepoints that web a11y trees splatter everywhere:
           U+FFFC OBJECT REPLACEMENT (every image/icon/avatar — the dominant
           noise, dozens per page), U+FFFD replacement char, U+FEFF BOM /
           zero-width no-break. All are 3-byte EF-prefixed; checking s[1]!=0
           keeps the s[2] read in-bounds (string is NUL-terminated). */
        if (c == 0xEF && (unsigned char)s[1] != 0) {
            unsigned char c1 = (unsigned char)s[1];
            unsigned char c2 = (unsigned char)s[2];
            if ((c1 == 0xBF && (c2 == 0xBC || c2 == 0xBD)) || (c1 == 0xBB && c2 == 0xBF)) {
                s += 3;
                continue;
            }
        }
        if (c == '<') { tb_emit(tb, "&lt;"); emitted++; last_space = 0; s++; continue; }
        if (c == '>') { tb_emit(tb, "&gt;"); emitted++; last_space = 0; s++; continue; }
        if (c == '"') { tb_emit(tb, "&quot;"); emitted++; last_space = 0; s++; continue; }
        if (c == '&') { tb_emit(tb, "&amp;"); emitted++; last_space = 0; s++; continue; }
        if (c == '\n' || c == '\r' || c == '\t' || c == ' ') {
            if (!last_space) {
                tb->buf[tb->offset++] = ' ';
                emitted++;
                last_space = 1;
            }
            s++;
            continue;
        }
        if (c < 0x20) { s++; continue; }
        tb->buf[tb->offset++] = (char)c;
        emitted++;
        last_space = 0;
        s++;
    }
    tb->buf[tb->offset] = '\0';
}

/* Read a value for tree-mode emission. Tries TextPattern then ValuePattern;
   no other fallbacks (we don't want to walk the element's own subtree just
   to pull a value out — that's the OUTER walker's job). */
static int tree_read_value(IUIAutomationElement* elem, char* out, int out_size) {
    if (read_text_pattern(elem, out, out_size) == 0 && out[0]) return 0;
    if (read_value_pattern(elem, out, out_size) == 0 && out[0]) return 0;
    if (out_size > 0) out[0] = '\0';
    return -1;
}

/* Recursive walker. depth is 0 at the root. Each call may emit one open
   tag, recurse into children, and emit a close tag — OR emit a single
   self-closing tag for leaf elements with values. Structural elements
   without a name pass through transparently.

   walker is a CONTROL-VIEW walker (skips noisy decorative elements
   automatically — this is the same view a screen reader sees, which
   matches what Wispr's accessibility-only approach effectively gets).

   Returns 1 to keep walking siblings, 0 to stop (budget exhausted). */
static int walk_tree(TreeBuilder* tb,
                     IUIAutomationTreeWalker* walker,
                     IUIAutomationElement* elem,
                     int depth) {
    if (!tb_has_budget(tb)) return 0;
    if (depth >= MAX_TREE_DEPTH) {
        /* At max depth, don't emit our own node — just signal truncation
           with an empty marker so the LLM knows the tree was cut. */
        tb_indent(tb, depth);
        tb_emit(tb, "<...truncated/>\n");
        return 1;
    }

    /* Hard exclusion: never expose password-bearing elements. Returning
       early without emitting also skips their children — a password
       field can't have semantically-useful children for a dictation LLM. */
    BOOL is_password = FALSE;
    IUIAutomationElement_get_CurrentIsPassword(elem, &is_password);
    if (is_password) return 1;

    CONTROLTYPEID ctype = 0;
    IUIAutomationElement_get_CurrentControlType(elem, &ctype);

    char name[NAME_BUF_BYTES] = {0};
    read_element_name(elem, name, sizeof(name));

    /* Detect focus first — it decides whether this element gets the large
       content cap (the focused field is the email/message the user acts on). */
    BOOL has_focus = FALSE;
    IUIAutomationElement_get_CurrentHasKeyboardFocus(elem, &has_focus);

    /* Read the element's text. Document/Edit/Text controls can carry it.
       The focused field, or any Document/Edit, holds the CONTENT the user
       acts on ("reply to this email") — pull its full body into the large
       heap content buffer and emit with the large cap. Incidental Text
       labels stay on the small stack buffer + 200-char cap so the tree
       (and the 150K axHtml budget) stays compact. */
    char value_stack[INCIDENTAL_VALUE_BUF_BYTES] = {0};
    char* value = value_stack;
    int value_cap = MAX_ELEMENT_VALUE_CHARS;
    if (ctype == UIA_EditControlTypeId
        || ctype == UIA_DocumentControlTypeId
        || ctype == UIA_TextControlTypeId) {
        int is_content = has_focus
                         || ctype == UIA_EditControlTypeId
                         || ctype == UIA_DocumentControlTypeId;
        if (is_content && tb->content_buf) {
            tree_read_value(elem, tb->content_buf, CONTENT_VALUE_BUF_BYTES);
            value = tb->content_buf;
            value_cap = MAX_CONTENT_VALUE_CHARS;
            int cl = (int)strlen(value);
            if (cl > tb->content_chars) {
                tb->content_chars = cl;
            }
        } else {
            tree_read_value(elem, value_stack, sizeof(value_stack));
        }
    }

    int has_name = (name[0] != '\0');
    int has_value = (value[0] != '\0');
    int structural_pass_through = is_structural_role(ctype) && !has_name && !has_value;

    const char* role = role_name(ctype);

    if (!structural_pass_through) {
        tb_indent(tb, depth);
        tb_emit(tb, "<");
        tb_emit(tb, role);
        if (has_name) {
            tb_emit(tb, " name=\"");
            tb_emit_xml_escaped(tb, name, MAX_ELEMENT_VALUE_CHARS);
            tb_emit(tb, "\"");
        }
        if (has_focus) {
            tb_emit(tb, " focus=\"1\"");
        }
        tb->element_count++;

        if (has_value) {
            tb_emit(tb, ">");
            tb_emit_xml_escaped(tb, value, value_cap);
            tb_emit(tb, "</");
            tb_emit(tb, role);
            tb_emit(tb, ">\n");
            return 1;
        }
        tb_emit(tb, ">\n");
    }

    /* Walk children. Releasing each child as we advance keeps the COM
       reference count bounded even on deep trees (Outlook's reading pane
       has been observed to expose 50+ children at a single level). */
    int child_depth = structural_pass_through ? depth : depth + 1;
    IUIAutomationElement* child = NULL;
    HRESULT hr = IUIAutomationTreeWalker_GetFirstChildElement(walker, elem, &child);
    if (SUCCEEDED(hr) && child) {
        while (child && tb_has_budget(tb)) {
            walk_tree(tb, walker, child, child_depth);
            IUIAutomationElement* next = NULL;
            hr = IUIAutomationTreeWalker_GetNextSiblingElement(walker, child, &next);
            IUIAutomationElement_Release(child);
            if (FAILED(hr)) break;
            child = next;
        }
        if (child) IUIAutomationElement_Release(child);
    }

    if (!structural_pass_through) {
        tb_indent(tb, depth);
        tb_emit(tb, "</");
        tb_emit(tb, role);
        tb_emit(tb, ">\n");
    }
    return 1;
}

/* Walk the foreground HWND's UIA subtree into axhtml. Always pairs the
   walker with the control view (the screen-reader-relevant subset) so
   we don't dump every decorative pane the app exposes. */
/* Below this much captured content text, a browser walk is treated as a
   cold/unrealized a11y tree and retried once. */
#define COLD_TREE_CONTENT_THRESHOLD 200

static void walk_foreground_tree(IUIAutomation* uia, HWND hwnd,
                                 char* axhtml, int axhtml_size,
                                 int allow_retry) {
    if (axhtml_size > 0) axhtml[0] = '\0';
    if (!hwnd) return;

    IUIAutomationTreeWalker* walker = NULL;
    if (FAILED(IUIAutomation_get_ControlViewWalker(uia, &walker)) || !walker) return;

    /* NULL is tolerated by walk_tree (degrades to the compact cap). Allocated
       once and reused across retry attempts. */
    char* content_buf = (char*)malloc(CONTENT_VALUE_BUF_BYTES);

    /* Chrome/Chromium builds its accessibility tree LAZILY (gated on AT
       detection via WM_GETOBJECT); a cold first read can return chrome but
       no rendered content. The act of this walk requests the tree, so if a
       browser yielded ~no content text, wait briefly and walk once more.
       Non-browsers don't have this behavior, so allow_retry=0 keeps them at
       a single pass (no added latency). The watchdog still bounds the total. */
    for (int attempt = 0; attempt < 2; attempt++) {
        IUIAutomationElement* root = NULL;
        if (FAILED(IUIAutomation_ElementFromHandle(uia, hwnd, &root)) || !root) break;

        TreeBuilder tb;
        tb.buf = axhtml;
        tb.offset = 0;
        tb.capacity = axhtml_size;
        tb.element_count = 0;
        tb.start_tick = GetTickCount();
        tb.content_buf = content_buf;
        tb.content_chars = 0;
        if (axhtml_size > 0) axhtml[0] = '\0';

        walk_tree(&tb, walker, root, 0);
        IUIAutomationElement_Release(root);

        if (!allow_retry || tb.content_chars >= COLD_TREE_CONTENT_THRESHOLD) break;
        Sleep(150);
    }

    free(content_buf);
    IUIAutomationTreeWalker_Release(walker);
}

/* Whether the foreground app is a browser whose a11y tree may be lazy
   (drives the cold-tree retry above). Superset of find_browser_url's list. */
static int is_browser_exe(const char* app_exe) {
    return strstr(app_exe, "chrome.exe") || strstr(app_exe, "msedge.exe")
        || strstr(app_exe, "brave.exe") || strstr(app_exe, "vivaldi.exe")
        || strstr(app_exe, "opera.exe") || strstr(app_exe, "arc.exe")
        || strstr(app_exe, "thorium.exe") || strstr(app_exe, "firefox.exe")
        || strstr(app_exe, "librewolf.exe") || strstr(app_exe, "zen.exe")
        || strstr(app_exe, "waterfox.exe") ? 1 : 0;
}

/* Best-effort browser-URL extraction. Looks for the foreground window's
   address bar by AutomationId (Chromium uses "omnibox"; Firefox uses
   "urlbar"). We scan only the top-level window's descendants — no need
   to find it by name, which varies by locale. Falls through silently
   when the foreground app isn't a known browser or the address bar
   isn't reachable (e.g. fullscreen video). */
static void find_browser_url(IUIAutomation* uia, HWND hwnd,
                              const char* app_exe,
                              char* out, int out_size) {
    if (out_size > 0) out[0] = '\0';
    if (!hwnd) return;
    /* Known Chromium-family + Firefox-family exe names. Lowercased to
       match get_process_exe(). Not exhaustive — the deny-list UI lets
       users handle anything we miss. */
    int is_chromium = strstr(app_exe, "chrome.exe") != NULL
                   || strstr(app_exe, "msedge.exe") != NULL
                   || strstr(app_exe, "brave.exe") != NULL
                   || strstr(app_exe, "vivaldi.exe") != NULL
                   || strstr(app_exe, "opera.exe") != NULL
                   || strstr(app_exe, "arc.exe") != NULL
                   || strstr(app_exe, "thorium.exe") != NULL;
    int is_firefox = strstr(app_exe, "firefox.exe") != NULL
                  || strstr(app_exe, "librewolf.exe") != NULL
                  || strstr(app_exe, "zen.exe") != NULL
                  || strstr(app_exe, "waterfox.exe") != NULL;
    if (!is_chromium && !is_firefox) return;

    IUIAutomationElement* root = NULL;
    if (FAILED(IUIAutomation_ElementFromHandle(uia, hwnd, &root)) || !root) return;

    /* Condition: AutomationId == "omnibox" (Chromium) or "urlbar" (Firefox). */
    BSTR target_id = SysAllocString(is_chromium ? L"omnibox" : L"urlbar");
    if (!target_id) {
        IUIAutomationElement_Release(root);
        return;
    }
    VARIANT v;
    VariantInit(&v);
    v.vt = VT_BSTR;
    v.bstrVal = target_id;
    IUIAutomationCondition* cond = NULL;
    HRESULT hr = IUIAutomation_CreatePropertyCondition(
        uia, UIA_AutomationIdPropertyId, v, &cond);
    VariantClear(&v); /* releases the BSTR via VARIANT */
    if (FAILED(hr) || !cond) {
        IUIAutomationElement_Release(root);
        return;
    }
    IUIAutomationElement* omnibox = NULL;
    IUIAutomationElement_FindFirst(root, TreeScope_Descendants, cond, &omnibox);
    IUIAutomationCondition_Release(cond);
    IUIAutomationElement_Release(root);
    if (!omnibox) return;

    /* Read the URL via ValuePattern. The omnibox displays a normalised
       URL even when the user has typed a partial query, so this gives
       us the current page's host. */
    if (read_value_pattern(omnibox, out, out_size) != 0) {
        out[0] = '\0';
    }
    IUIAutomationElement_Release(omnibox);
}

int main(int argc, char* argv[]) {
    int selection_only = 0;
    int split = 0;
    int tree = 0;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--selection") == 0) selection_only = 1;
        else if (strcmp(argv[i], "--split") == 0) split = 1;
        else if (strcmp(argv[i], "--tree") == 0) tree = 1;
        /* --hwnd <decimal> : capture THIS window instead of the OS-foreground
           one (used by the context-harness to target a specific Chrome window
           deterministically; see g_scope_hwnd). Accepts a following arg. */
        else if (strcmp(argv[i], "--hwnd") == 0 && i + 1 < argc) {
            g_scope_hwnd = (HWND)(uintptr_t)_strtoui64(argv[++i], NULL, 10);
        }
    }

    HANDLE wd = CreateThread(NULL, 0, watchdog,
                             (LPVOID)(uintptr_t)WATCHDOG_TIMEOUT_MS, 0, NULL);

    char window_title[TITLE_BUF_BYTES] = {0};
    char element_name[NAME_BUF_BYTES] = {0};
    /* static (NOT auto): at MAX_CONTEXT_CHARS=24000 each is CONTEXT_BUF_BYTES
       ≈ 96KB; 3 on the auto stack alongside the deep UIA recursion would risk a
       stack overflow. static lives in zero-initialised BSS (so `= {0}` is
       redundant), and this is a short-lived single-pass main(), so there is no
       re-entrancy concern. */
    static char focused_text[CONTEXT_BUF_BYTES];
    static char context_before[CONTEXT_BUF_BYTES];
    static char context_after[CONTEXT_BUF_BYTES];
    char app_exe[EXE_BUF_BYTES] = {0};
    char url[URL_BUF_BYTES] = {0};
    /* axHtml is large (~150KB) — keep it on the heap so a future build
       compiling with a smaller default stack still loads. */
    char* axhtml = (char*)calloc(AXHTML_BUF_BYTES, 1);
    if (!axhtml) {
        fprintf(stderr, "ERROR: out of memory allocating axHtml buffer\n");
        if (wd) { TerminateThread(wd, 0); CloseHandle(wd); }
        return 1;
    }

    /* Snapshot foreground window title + process exe up front — these
       are useful even when UIA fails (elevated target, hung tree).
       app_exe powers the deny-list match, so without it the deny-list
       silently never fires. */
    HWND fg = g_scope_hwnd ? g_scope_hwnd : GetForegroundWindow();
    get_window_title(fg, window_title, sizeof(window_title));
    get_process_exe(fg, app_exe, sizeof(app_exe));

    HRESULT hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    /* RPC_E_CHANGED_MODE is harmless — means COM was already initialized
       differently in this process (won't happen for a fresh helper but
       guard anyway). */
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
        fprintf(stderr, "ERROR: CoInitializeEx failed (0x%lx)\n", (unsigned long)hr);
        free(axhtml);
        if (wd) { TerminateThread(wd, 0); CloseHandle(wd); }
        return 1;
    }

    IUIAutomation* uia = NULL;
    hr = CoCreateInstance(&CLSID_CUIAutomation, NULL, CLSCTX_INPROC_SERVER,
                          &IID_IUIAutomation, (void**)&uia);
    if (SUCCEEDED(hr) && uia) {
        if (tree) {
            /* Tree mode is intentionally additive: we also read the focused
               element's caret split so the cleanup model still gets the
               continuation hint, then walk the full window tree for the
               surrounding context. URL extraction runs last because it
               does its own FindFirst on the root. */
            read_focused_split(uia,
                               context_before, sizeof(context_before),
                               context_after, sizeof(context_after),
                               focused_text, sizeof(focused_text),
                               element_name, sizeof(element_name));
            walk_foreground_tree(uia, fg, axhtml, AXHTML_BUF_BYTES,
                                 is_browser_exe(app_exe));
            find_browser_url(uia, fg, app_exe, url, sizeof(url));
        } else if (split) {
            read_focused_split(uia,
                               context_before, sizeof(context_before),
                               context_after, sizeof(context_after),
                               focused_text, sizeof(focused_text),
                               element_name, sizeof(element_name));
        } else {
            read_focused_context(uia, focused_text, sizeof(focused_text),
                                 element_name, sizeof(element_name),
                                 selection_only);
        }
        IUIAutomation_Release(uia);
    }

    CoUninitialize();

    /* Defensive truncation: even if the BSTR was big, never write more than
       the cap (escape stage allocates 8x of this). */
    if ((int)strlen(focused_text) > MAX_CONTEXT_CHARS * 4) {
        focused_text[MAX_CONTEXT_CHARS * 4] = '\0';
    }
    if ((int)strlen(context_before) > MAX_CONTEXT_CHARS * 4) {
        context_before[MAX_CONTEXT_CHARS * 4] = '\0';
    }
    if ((int)strlen(context_after) > MAX_CONTEXT_CHARS * 4) {
        context_after[MAX_CONTEXT_CHARS * 4] = '\0';
    }

    char  title_esc[TITLE_ESC_BYTES];
    char  name_esc[NAME_ESC_BYTES];
    char  exe_esc[EXE_ESC_BYTES];
    char  url_esc[URL_ESC_BYTES];
    /* text/before/after_esc scale with MAX_CONTEXT_CHARS (×4 UTF-8 ×8 escape ≈
       768KB each at the raised 24000-char cap) and axhtml_esc is ~450KB — all
       far too large for the stack, so heap-allocate. Worst-case stdout is then
       ~3×768KB + ~450KB + small fields ≈ 2.7MB — every consumer that buffers the
       whole output must allow >= ~4MB (the context-harness uses 4MB; the
       production reader electron/lib/context-reader.ts was bumped from 1MB to
       4MB to match; Node execFile's 1MB default would error with
       ERR_CHILD_PROCESS_STDIO_MAXBUFFER and silently drop ALL context). free(NULL)
       is a no-op, so the combined cleanup is safe even on a partial alloc failure. */
    char* text_esc   = (char*)malloc(CONTEXT_ESC_BYTES);
    char* before_esc = (char*)malloc(CONTEXT_ESC_BYTES);
    char* after_esc  = (char*)malloc(CONTEXT_ESC_BYTES);
    char* axhtml_esc = (char*)malloc(AXHTML_ESC_BYTES);
    if (!text_esc || !before_esc || !after_esc || !axhtml_esc) {
        fprintf(stderr, "ERROR: out of memory allocating escape buffers\n");
        free(text_esc); free(before_esc); free(after_esc); free(axhtml_esc);
        free(axhtml);
        if (wd) { TerminateThread(wd, 0); CloseHandle(wd); }
        return 1;
    }
    json_escape_into(title_esc,  sizeof(title_esc),  window_title);
    json_escape_into(name_esc,   sizeof(name_esc),   element_name);
    json_escape_into(text_esc,   CONTEXT_ESC_BYTES,  focused_text);
    json_escape_into(before_esc, CONTEXT_ESC_BYTES,  context_before);
    json_escape_into(after_esc,  CONTEXT_ESC_BYTES,  context_after);
    json_escape_into(exe_esc,    sizeof(exe_esc),    app_exe);
    json_escape_into(url_esc,    sizeof(url_esc),    url);
    json_escape_into(axhtml_esc, AXHTML_ESC_BYTES,   axhtml);

    printf("{\"windowTitle\":\"%s\",\"elementName\":\"%s\",\"focusedText\":\"%s\","
           "\"textBefore\":\"%s\",\"textAfter\":\"%s\",\"appExe\":\"%s\","
           "\"url\":\"%s\",\"axHtml\":\"%s\"}",
           title_esc, name_esc, text_esc, before_esc, after_esc,
           exe_esc, url_esc, axhtml_esc);
    fflush(stdout);

    free(text_esc); free(before_esc); free(after_esc);
    free(axhtml_esc);
    free(axhtml);
    if (wd) { TerminateThread(wd, 0); CloseHandle(wd); }
    return 0;
}
