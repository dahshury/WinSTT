// Adapted from Handy 48a3d8e9 (c) 2025 CJ Pais. MIT license: ./LICENSE-Handy.
//! Windows reliable paste.
//!
//! Publishes the transcript as a *delayed-render* clipboard format
//! (`SetClipboardData(CF_UNICODETEXT, NULL)`) owned by a hidden message-only
//! window. Windows sends the owner `WM_RENDERFORMAT` when a consumer actually
//! requests the data — that message is the read receipt. The previous
//! clipboard contents (snapshotted with full format fidelity) are restored
//! once receipts go quiet (see `paste_tx::evaluate`), guarded by the clipboard
//! sequence number so we never clobber a newer user copy.
//!
//! Threading: clipboard ownership and delayed rendering are per-thread and
//! need a message pump, so the whole transaction lives on a dedicated worker
//! thread. The calling thread only sends the paste chord once the worker
//! signals the transcript is published, then returns; the wait, guarded
//! restore and auto-submit all finish on the worker.

use std::sync::{Arc, Mutex, Once, mpsc::Sender};
use std::thread;
use std::time::{Duration, Instant};

use log::{error, info, warn};
use tauri::Manager;
use windows::Win32::Foundation::{
    ERROR_SUCCESS, HANDLE, HGLOBAL, HINSTANCE, HWND, LPARAM, LRESULT, SetLastError, WPARAM,
};
use windows::core::{PCWSTR, w};

use super::{PasteFailure, TxState, WaitDecision, evaluate, send_chord};
use crate::clipboard::send_return_key;
use crate::input::EnigoState;
use crate::settings::{ClipboardHandling, PasteMethod};
use crate::winstt::settings_schema::AutoSubmitKey;
use windows::Win32::Foundation::GlobalFree;
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData, GetClipboardOwner,
    GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{
    GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock,
};
use windows::Win32::System::Ole::{CF_BITMAP, CF_UNICODETEXT};
use windows::Win32::UI::WindowsAndMessaging::{
    CopyImage, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GDI_IMAGE_TYPE,
    GWLP_USERDATA, GetMessageW, GetWindowLongPtrW, HWND_MESSAGE, IMAGE_FLAGS, KillTimer, MSG,
    PostQuitMessage, RegisterClassW, SetTimer, SetWindowLongPtrW, WINDOW_EX_STYLE, WINDOW_STYLE,
    WM_DESTROYCLIPBOARD, WM_RENDERALLFORMATS, WM_RENDERFORMAT, WM_TIMER, WNDCLASSW,
};

const CLASS_NAME: PCWSTR = w!("WinSTTPasteTxWindow");
const TIMER_ID: usize = 1;
const TIMER_INTERVAL_MS: u32 = 25;
/// Skip clipboard formats larger than this when snapshotting.
const MAX_FORMAT_BYTES: usize = 64 * 1024 * 1024;

const IMAGE_BITMAP_TYPE: GDI_IMAGE_TYPE = GDI_IMAGE_TYPE(0);
const LR_CREATEDIBSECTION_FLAG: IMAGE_FLAGS = IMAGE_FLAGS(0x2000);

struct SavedFormat {
    format: u32,
    data: Vec<u8>,
}

pub(super) struct WinTxShared {
    state: Mutex<TxState>,
    text: String,
    snapshot: Mutex<Vec<SavedFormat>>,
    /// Copied HBITMAP (as raw usize), restored via SetClipboardData.
    saved_bitmap: Mutex<Option<usize>>,
    sequence: Mutex<u32>,
    app_handle: tauri::AppHandle,
    auto_submit: bool,
    auto_submit_key: AutoSubmitKey,
    target_window: Mutex<usize>,
    /// ClipboardHandling::CopyToClipboard — settle by leaving the transcript
    /// on the clipboard as plain text instead of restoring the snapshot.
    preserve_transcript: bool,
}

impl Drop for WinTxShared {
    fn drop(&mut self) {
        if let Some(raw) = self
            .saved_bitmap
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            // SAFETY: CopyImage transferred this duplicate to us; restoration did not consume it.
            unsafe {
                let _ = windows::Win32::Graphics::Gdi::DeleteObject(
                    windows::Win32::Graphics::Gdi::HGDIOBJ(raw as *mut _),
                );
            }
        }
    }
}

/// The transaction currently holding the clipboard, if any. A new
/// transaction settles it before snapshotting (see `flush_pending`).
static PENDING: Mutex<Option<Arc<WinTxShared>>> = Mutex::new(None);
static PUBLISH_LOCK: Mutex<()> = Mutex::new(());

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn shared_ptr(hwnd: HWND) -> *const WinTxShared {
    // SAFETY: the caller owns these Win32 resources for the duration of this operation.
    unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const WinTxShared }
}

/// Sends the auto-submit Enter. Uses `try_lock` because the paste caller may
/// currently hold the enigo lock while waiting for this worker.
fn send_auto_submit(shared: &WinTxShared) {
    let target = *shared.target_window.lock().unwrap();
    if target == 0
        || unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow().0 as usize }
            != target
    {
        return;
    }
    {
        let mut st = match shared.state.lock() {
            Ok(st) => st,
            Err(_) => return,
        };
        if st.auto_submit_sent {
            return;
        }
        st.auto_submit_sent = true;
    }
    if let Some(enigo_state) = shared.app_handle.try_state::<EnigoState>() {
        match enigo_state.0.try_lock() {
            Some(mut enigo) => {
                let _ = send_return_key(&mut enigo, shared.auto_submit_key);
            }
            None => warn!("[reliable-paste] skipping auto-submit: input state busy"),
        }
    }
}

/// Renders the promised transcript into the clipboard, which must already be
/// open: the system opens it on our behalf for WM_RENDERFORMAT; every other
/// caller has to wrap this in OpenClipboard/CloseClipboard itself.
unsafe fn render_text(shared: &WinTxShared) {
    // SAFETY: the caller owns these Win32 resources for the duration of this operation.
    unsafe {
        let wide_text: Vec<u16> = shared
            .text
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let Ok(hg) = GlobalAlloc(GMEM_MOVEABLE, wide_text.len() * 2) else {
            return;
        };
        let ptr = GlobalLock(hg) as *mut u16;
        if ptr.is_null() {
            let _ = GlobalFree(Some(hg));
            return;
        }
        std::ptr::copy_nonoverlapping(wide_text.as_ptr(), ptr, wide_text.len());
        let _ = GlobalUnlock(hg);
        if SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(hg.0))).is_err() {
            let _ = GlobalFree(Some(hg));
        } else {
            *shared.sequence.lock().unwrap() = GetClipboardSequenceNumber();
        }
    }
}

unsafe extern "system" fn paste_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: the caller owns these Win32 resources for the duration of this operation.
    unsafe {
        let shared = shared_ptr(hwnd);
        match msg {
            WM_RENDERFORMAT => {
                if !shared.is_null() {
                    let shared = &*shared;
                    if let Ok(mut st) = shared.state.lock() {
                        st.record_receipt(Instant::now());
                    }
                    if wparam.0 as u32 == CF_UNICODETEXT.0 as u32 {
                        render_text(shared);
                    }
                }
                LRESULT(0)
            }
            WM_RENDERALLFORMATS => {
                // Sent when the window is destroyed while an unrendered promise is
                // still on the clipboard — not a consumer read, so no receipt.
                // Unlike WM_RENDERFORMAT the system does not open the clipboard on
                // our behalf here: open it and confirm we still own it first.
                if !shared.is_null() {
                    let shared = &*shared;
                    if OpenClipboard(Some(hwnd)).is_ok() {
                        if GetClipboardOwner().is_ok_and(|owner| owner == hwnd) {
                            render_text(shared);
                        }
                        let _ = CloseClipboard();
                    }
                }
                LRESULT(0)
            }
            WM_DESTROYCLIPBOARD => {
                if !shared.is_null()
                    && let Ok(mut st) = (&*shared).state.lock()
                {
                    st.ownership_lost = true;
                }
                LRESULT(0)
            }
            WM_TIMER => {
                if !shared.is_null() {
                    on_timer(hwnd, &*shared);
                }
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

fn ensure_window_class(hinstance: HINSTANCE) {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let wc = WNDCLASSW {
            lpfnWndProc: Some(paste_wnd_proc),
            hInstance: hinstance,
            lpszClassName: CLASS_NAME,
            ..Default::default()
        };
        unsafe {
            RegisterClassW(&wc);
        }
    });
}

/// If a previous transaction is still holding the clipboard, settle it now so
/// the snapshot below captures the user's original clipboard content. The
/// previous worker observes `cancelled` on its next timer tick and tears down
/// without restoring.
fn flush_pending() {
    let previous = match PENDING.lock() {
        Ok(mut slot) => slot.take(),
        Err(_) => None,
    };
    let Some(previous) = previous else {
        return;
    };
    let receipt = {
        let mut st = match previous.state.lock() {
            Ok(st) => st,
            Err(_) => return,
        };
        st.cancelled = true;
        st.any_receipt_after_injection()
    };
    if previous.auto_submit && receipt && !previous.state.lock().unwrap().ownership_lost {
        send_auto_submit(&previous);
    }
    let sequence = *previous.sequence.lock().unwrap();
    let still_ours = unsafe { GetClipboardSequenceNumber() } == sequence;
    if still_ours {
        unsafe { settle_clipboard(&previous) };
    }
}

/// Settle-time clipboard handling once we know we still own the clipboard:
/// restore the snapshot, or — for ClipboardHandling::CopyToClipboard — replace
/// the concealed promise with plain transcript text, so clipboard history and
/// managers record it and it survives this transaction's window going away.
unsafe fn settle_clipboard(shared: &WinTxShared) {
    // SAFETY: the caller owns these Win32 resources for the duration of this operation.
    unsafe {
        let restore_confirmed = shared
            .state
            .lock()
            .is_ok_and(|state| state.may_restore_previous());
        if !shared.preserve_transcript && restore_confirmed {
            restore_snapshot(shared);
            return;
        }
        if OpenClipboard(None).is_err() {
            warn!("[reliable-paste] could not open clipboard to leave transcript");
            return;
        }
        if GetClipboardSequenceNumber() != *shared.sequence.lock().unwrap() {
            let _ = CloseClipboard();
            return;
        }
        let _ = EmptyClipboard();
        render_text(shared);
        let _ = CloseClipboard();
        info!("[reliable-paste] left transcript on clipboard as plain text");
    }
}

/// Restores the snapshotted clipboard contents. Safe to call from any thread.
unsafe fn restore_snapshot(shared: &WinTxShared) {
    // SAFETY: the caller owns these Win32 resources for the duration of this operation.
    unsafe {
        if OpenClipboard(None).is_err() {
            warn!("[reliable-paste] could not open clipboard to restore");
            return;
        }
        // Check ownership again under the clipboard lock, closing the check/restore race.
        let sequence = *shared.sequence.lock().unwrap();
        if sequence != 0 && GetClipboardSequenceNumber() != sequence {
            let _ = CloseClipboard();
            return;
        }
        let _ = EmptyClipboard();
        if let Ok(formats) = shared.snapshot.lock() {
            for saved in formats.iter() {
                if saved.data.is_empty() {
                    continue;
                }
                let Ok(hg) = GlobalAlloc(GMEM_MOVEABLE, saved.data.len()) else {
                    continue;
                };
                let ptr = GlobalLock(hg) as *mut u8;
                if ptr.is_null() {
                    let _ = GlobalFree(Some(hg));
                    continue;
                }
                std::ptr::copy_nonoverlapping(saved.data.as_ptr(), ptr, saved.data.len());
                let _ = GlobalUnlock(hg);
                // SetClipboardData takes ownership of the handle on success.
                if SetClipboardData(saved.format, Some(HANDLE(hg.0))).is_err() {
                    let _ = GlobalFree(Some(hg));
                }
            }
        }
        if let Ok(mut bitmap) = shared.saved_bitmap.lock()
            && let Some(raw) = bitmap.take()
            && SetClipboardData(CF_BITMAP.0 as u32, Some(HANDLE(raw as *mut _))).is_err()
        {
            let _ = windows::Win32::Graphics::Gdi::DeleteObject(
                windows::Win32::Graphics::Gdi::HGDIOBJ(raw as *mut _),
            );
        }
        let _ = CloseClipboard();
        info!("[reliable-paste] restored previous clipboard");
    }
}

unsafe fn snapshot_clipboard(hwnd: HWND, shared: &WinTxShared) -> Result<(), String> {
    // SAFETY: the caller owns these Win32 resources for the duration of this operation.
    unsafe {
        OpenClipboard(Some(hwnd)).map_err(|e| format!("OpenClipboard failed: {e}"))?;
        let mut formats = Vec::new();
        let mut format = 0u32;
        loop {
            format = EnumClipboardFormats(format);
            if format == 0 {
                break;
            }
            if format == CF_BITMAP.0 as u32 {
                // GDI object, not global memory: duplicate the handle instead.
                if let Ok(handle) = GetClipboardData(CF_BITMAP.0 as u32)
                    && let Ok(copy) =
                        CopyImage(handle, IMAGE_BITMAP_TYPE, 0, 0, LR_CREATEDIBSECTION_FLAG)
                    && let Ok(mut slot) = shared.saved_bitmap.lock()
                {
                    *slot = Some(copy.0 as usize);
                }
                continue;
            }
            // Formats whose handles are not plain global memory cannot be
            // byte-copied; skipping them matches what the legacy path restored.
            if !crate::clipboard_snapshot::is_hglobal_format(format) {
                continue;
            }
            if let Ok(handle) = GetClipboardData(format) {
                let hg = HGLOBAL(handle.0);
                let size = GlobalSize(hg);
                if size == 0 || size > MAX_FORMAT_BYTES {
                    continue;
                }
                let ptr = GlobalLock(hg) as *const u8;
                if ptr.is_null() {
                    continue;
                }
                let data = std::slice::from_raw_parts(ptr, size).to_vec();
                let _ = GlobalUnlock(hg);
                formats.push(SavedFormat { format, data });
            }
        }
        let _ = CloseClipboard();
        if let Ok(mut slot) = shared.snapshot.lock() {
            *slot = formats;
        }
        Ok(())
    }
}

/// Publishes the transcript as a delayed-render promise plus clipboard
/// history / cloud / monitoring opt-out markers (the same formats Chrome uses
/// for Incognito copies). Returns the new clipboard sequence number.
unsafe fn publish(hwnd: HWND) -> Result<u32, String> {
    // SAFETY: the caller owns these Win32 resources for the duration of this operation.
    unsafe {
        OpenClipboard(Some(hwnd)).map_err(|e| format!("OpenClipboard failed: {e}"))?;
        let published = publish_formats();
        let closed = CloseClipboard();
        published?;
        closed.map_err(|e| format!("CloseClipboard failed: {e}"))?;
        Ok(GetClipboardSequenceNumber())
    }
}

/// Everything `publish` does while the clipboard is open, split out so
/// `publish` closes the clipboard on every path — bailing out while holding it
/// open (and possibly already emptied) would strand the clipboard and leave
/// the legacy fallback snapshotting nothing.
unsafe fn publish_formats() -> Result<(), String> {
    // SAFETY: the caller owns these Win32 resources for the duration of this operation.
    unsafe {
        EmptyClipboard().map_err(|e| format!("EmptyClipboard failed: {e}"))?;

        for (name, value) in [
            ("ExcludeClipboardContentFromMonitorProcessing", 1u32),
            ("CanIncludeInClipboardHistory", 0u32),
            ("CanUploadToCloudClipboard", 0u32),
        ] {
            let name_wide = wide(name);
            let format = RegisterClipboardFormatW(PCWSTR(name_wide.as_ptr()));
            if format == 0 {
                continue;
            }
            if let Ok(hg) = GlobalAlloc(GMEM_MOVEABLE, std::mem::size_of::<u32>()) {
                let ptr = GlobalLock(hg) as *mut u32;
                if !ptr.is_null() {
                    *ptr = value;
                    let _ = GlobalUnlock(hg);
                    if SetClipboardData(format, Some(HANDLE(hg.0))).is_err() {
                        let _ = GlobalFree(Some(hg));
                    }
                } else {
                    let _ = GlobalFree(Some(hg));
                }
            }
        }

        // NULL handle = delayed rendering: we are only asked for the data (via
        // WM_RENDERFORMAT) when a consumer actually reads it. SetClipboardData
        // returns the handle it was given, so for delayed rendering success is
        // also NULL and the windows crate reports it as an Err carrying
        // GetLastError(). Only a nonzero thread error is a real failure, and the
        // thread error must be cleared first so a stale value from an earlier
        // call can't masquerade as one.
        SetLastError(ERROR_SUCCESS);
        if let Err(e) = SetClipboardData(CF_UNICODETEXT.0 as u32, None)
            && e.code().is_err()
        {
            return Err(format!("SetClipboardData failed: {e}"));
        }
        Ok(())
    }
}

fn on_timer(_hwnd: HWND, shared: &WinTxShared) {
    let _publish = PUBLISH_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    let finish = {
        let mut st = match shared.state.lock() {
            Ok(st) => st,
            Err(_) => return,
        };
        if st.cancelled {
            true
        } else {
            match evaluate(&st, now) {
                WaitDecision::KeepWaiting => false,
                WaitDecision::Finish => {
                    st.cancelled = true;
                    true
                }
            }
        }
    };
    if !finish {
        return;
    }

    let (receipt, ownership_lost, injection_failed) = {
        let st = match shared.state.lock() {
            Ok(st) => st,
            Err(_) => return,
        };
        (
            st.any_receipt_after_injection(),
            st.ownership_lost,
            st.injection_failed,
        )
    };
    if ownership_lost {
        info!("[reliable-paste] settling: clipboard ownership lost");
    } else if receipt {
        info!("[reliable-paste] settling: reads went quiet");
    } else if injection_failed {
        info!(
            "[reliable-paste] settling: chord injection failed, retaining transcript without a receipt"
        );
    } else {
        info!(
            "[reliable-paste] settling: no confirmed read within timeout, leaving transcript available"
        );
    }

    // Auto-submit only once the target demonstrably read the transcript;
    // pressing Enter after an unconfirmed paste could submit stale content.
    if shared.auto_submit && receipt && !ownership_lost {
        send_auto_submit(shared);
    }

    let sequence = *shared.sequence.lock().unwrap();
    let still_ours = !ownership_lost && unsafe { GetClipboardSequenceNumber() } == sequence;
    if still_ours {
        unsafe { settle_clipboard(shared) };
    } else {
        info!("[reliable-paste] clipboard changed externally; leaving it untouched");
    }

    if let Ok(mut slot) = PENDING.lock() {
        let is_us = slot
            .as_ref()
            .is_some_and(|pending| std::ptr::eq(Arc::as_ptr(pending), shared));
        if is_us {
            *slot = None;
        }
    }

    unsafe {
        PostQuitMessage(0);
    }
}

unsafe fn destroy_window_and_shared(hwnd: HWND) {
    // SAFETY: the caller owns these Win32 resources for the duration of this operation.
    unsafe {
        let ptr = shared_ptr(hwnd);
        let _ = DestroyWindow(hwnd);
        if !ptr.is_null() {
            drop(Arc::from_raw(ptr));
        }
    }
}

fn pump_thread(shared: Arc<WinTxShared>, ready: Sender<Result<(), String>>) {
    unsafe {
        let publish_guard = PUBLISH_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        if shared.state.lock().unwrap().cancelled {
            return;
        }
        // Settle any previous transaction first so the snapshot captures the
        // user's original clipboard, not the previous transcript.
        flush_pending();

        let hinstance = match GetModuleHandleW(PCWSTR::null()) {
            Ok(hmodule) => HINSTANCE(hmodule.0),
            Err(e) => {
                let _ = ready.send(Err(format!("GetModuleHandle failed: {e}")));
                return;
            }
        };
        ensure_window_class(hinstance);

        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            CLASS_NAME,
            w!("WinSTTPasteTx"),
            WINDOW_STYLE::default(),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(hinstance),
            None,
        ) {
            Ok(hwnd) => hwnd,
            Err(e) => {
                let _ = ready.send(Err(format!("CreateWindowEx failed: {e}")));
                return;
            }
        };
        SetWindowLongPtrW(
            hwnd,
            GWLP_USERDATA,
            Arc::into_raw(shared.clone()) as *const _ as isize,
        );

        let published = match snapshot_clipboard(hwnd, &shared) {
            Ok(()) => match if shared.state.lock().unwrap().cancelled {
                Err("paste publication cancelled".into())
            } else {
                publish(hwnd)
            } {
                Ok(sequence) => Ok(sequence),
                Err(e) => {
                    // publish may have emptied the clipboard before failing;
                    // put the snapshot back so the legacy fallback's own
                    // snapshot captures the user's clipboard, not an empty one.
                    restore_snapshot(&shared);
                    Err(e)
                }
            },
            Err(e) => Err(e),
        };
        let sequence = match published {
            Ok(sequence) => sequence,
            Err(e) => {
                destroy_window_and_shared(hwnd);
                let _ = ready.send(Err(e));
                return;
            }
        };
        *shared.sequence.lock().unwrap() = sequence;
        shared.state.lock().unwrap().published_at = Instant::now();
        if let Ok(mut slot) = PENDING.lock() {
            *slot = Some(shared.clone());
        }
        let _ = SetTimer(Some(hwnd), TIMER_ID, TIMER_INTERVAL_MS, None);
        drop(publish_guard);
        if ready.send(Ok(())).is_err() {
            shared.state.lock().unwrap().injection_failed = true;
        }

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = DispatchMessageW(&msg);
        }

        let _ = KillTimer(Some(hwnd), TIMER_ID);
        destroy_window_and_shared(hwnd);
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "platform paste transaction forwards existing paste options"
)]
pub(super) fn run(
    text: &str,
    app_handle: &tauri::AppHandle,
    paste_method: &PasteMethod,
    enigo: &mut enigo::Enigo,
    auto_submit: bool,
    auto_submit_key: AutoSubmitKey,
    clipboard_handling: ClipboardHandling,
    paste_delay_ms: u64,
) -> Result<(), PasteFailure> {
    let shared = Arc::new(WinTxShared {
        state: Mutex::new(TxState::new()),
        text: text.to_string(),
        snapshot: Mutex::new(Vec::new()),
        saved_bitmap: Mutex::new(None),
        sequence: Mutex::new(0),
        app_handle: app_handle.clone(),
        auto_submit,
        auto_submit_key,
        target_window: Mutex::new(0),
        preserve_transcript: clipboard_handling == ClipboardHandling::CopyToClipboard,
    });

    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let shared_for_pump = shared.clone();
    thread::spawn(move || pump_thread(shared_for_pump, ready_tx));

    // Wait until the transcript is actually published (or the worker reports
    // why it could not) before injecting the chord.
    match ready_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e.into()),
        Err(_) => {
            shared.state.lock().unwrap().cancelled = true;
            return Err(PasteFailure::Input(
                "reliable paste worker did not publish within 2s".to_string(),
            ));
        }
    }
    info!("[reliable-paste] published transcript (delayed render)");

    thread::sleep(Duration::from_millis(paste_delay_ms));

    // Mark injection *before* sending: enigo holds the chord for ~100ms and a
    // fast target may legitimately read while the chord is still held.
    *shared.target_window.lock().unwrap() =
        unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow().0 as usize };
    shared.state.lock().unwrap().injected_at = Some(Instant::now());
    let mut input_error = None;
    match send_chord(enigo, paste_method) {
        Ok(()) => {
            info!("[reliable-paste] paste chord sent ({paste_method:?})");
        }
        Err(e) => {
            // Keep the transaction alive: the worker restores the clipboard
            // after the short failed-injection timeout.
            shared.state.lock().unwrap().injection_failed = true;
            error!("[reliable-paste] failed to send paste chord: {e}");
            input_error = Some(e);
        }
    }

    input_error.map_or(Ok(()), |error| Err(PasteFailure::Input(error)))
}
