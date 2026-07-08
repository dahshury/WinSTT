//! Full-fidelity clipboard snapshot/restore for the paste pipeline.
//!
//! The clipboard "sandwich" (save → write transcription → Ctrl+V → restore) used to
//! save with `read_text()` only, so a copied image / file list / rich-text payload
//! was replaced by an empty string after every dictation paste. On Windows we now
//! snapshot the RAW clipboard — every HGLOBAL-backed format (CF_DIB screenshots,
//! CF_HDROP file lists, HTML, RTF, unicode text, registered formats) — and put the
//! exact bytes back afterwards, so Ctrl+V after a dictation pastes whatever the user
//! had copied before it. Other platforms get a text+image snapshot via the clipboard
//! plugin (arboard), which is the best fidelity available there.

use log::warn;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

pub enum ClipboardSnapshot {
    /// Raw Windows clipboard formats (format id → bytes). An empty vec means the
    /// clipboard was verified empty; restore clears it back to empty.
    #[cfg(target_os = "windows")]
    Native(Vec<(u32, Vec<u8>)>),
    /// Plain-text fallback (non-Windows, or when the raw snapshot failed).
    Text(String),
    /// RGBA image via the clipboard plugin (non-Windows platforms; Windows images
    /// ride along inside `Native` as CF_DIB/CF_DIBV5).
    #[cfg(not(target_os = "windows"))]
    Image {
        rgba: Vec<u8>,
        width: u32,
        height: u32,
    },
    /// Nothing readable was on the clipboard at capture time.
    Empty,
}

impl ClipboardSnapshot {
    /// One-line summary for the paste-phase logs (never the content itself).
    pub fn describe(&self) -> String {
        match self {
            #[cfg(target_os = "windows")]
            Self::Native(formats) => format!(
                "kind=native formats={} bytes={}",
                formats.len(),
                formats.iter().map(|(_, bytes)| bytes.len()).sum::<usize>()
            ),
            Self::Text(text) => format!("kind=text chars={}", text.chars().count()),
            #[cfg(not(target_os = "windows"))]
            Self::Image { width, height, .. } => format!("kind=image size={width}x{height}"),
            Self::Empty => "kind=empty".to_string(),
        }
    }
}

/// Snapshot the current clipboard with the highest fidelity the platform allows.
/// Never fails: degrades raw → text → image → `Empty`, logging each downgrade.
pub fn capture(app_handle: &AppHandle) -> ClipboardSnapshot {
    #[cfg(target_os = "windows")]
    {
        match win::capture_raw() {
            Ok(formats) => return ClipboardSnapshot::Native(formats),
            Err(e) => {
                warn!("[clipboard] raw snapshot failed ({e}); falling back to text-only save");
            }
        }
    }
    capture_via_plugin(app_handle)
}

fn capture_via_plugin(app_handle: &AppHandle) -> ClipboardSnapshot {
    let clipboard = app_handle.clipboard();
    match clipboard.read_text() {
        Ok(text) if !text.is_empty() => return ClipboardSnapshot::Text(text),
        Ok(_) => {}
        Err(e) => warn!("[clipboard] text snapshot failed: {e}"),
    }
    #[cfg(not(target_os = "windows"))]
    if let Ok(image) = clipboard.read_image() {
        return ClipboardSnapshot::Image {
            rgba: image.rgba().to_vec(),
            width: image.width(),
            height: image.height(),
        };
    }
    ClipboardSnapshot::Empty
}

/// Put the snapshot back on the clipboard. Best-effort: failures are logged, never
/// propagated (the paste itself already succeeded by the time we restore).
pub fn restore(app_handle: &AppHandle, snapshot: &ClipboardSnapshot) {
    match snapshot {
        #[cfg(target_os = "windows")]
        ClipboardSnapshot::Native(formats) => {
            if let Err(e) = win::restore_raw(formats) {
                warn!("[clipboard] raw restore failed: {e}");
            }
        }
        ClipboardSnapshot::Text(text) => restore_text(app_handle, text),
        #[cfg(not(target_os = "windows"))]
        ClipboardSnapshot::Image {
            rgba,
            width,
            height,
        } => {
            let image = tauri::image::Image::new(rgba, *width, *height);
            if let Err(e) = app_handle.clipboard().write_image(&image) {
                warn!("[clipboard] image restore failed: {e}");
            }
        }
        // Nothing was readable at capture time. On Windows this means the raw snapshot
        // AND the text fallback both failed (clipboard locked) — leave the clipboard
        // alone rather than destroy content we never managed to read. Elsewhere an
        // unreadable clipboard is indistinguishable from an empty one, so clear our
        // transcription text back out (the pre-snapshot behavior).
        ClipboardSnapshot::Empty => {
            #[cfg(not(target_os = "windows"))]
            restore_text(app_handle, "");
        }
    }
}

#[cfg_attr(target_os = "windows", allow(dead_code))]
fn restore_text(app_handle: &AppHandle, text: &str) {
    // On Wayland prefer wl-copy, matching the transcription-write path (umlaut fidelity).
    #[cfg(target_os = "linux")]
    if crate::utils::is_wayland() && crate::clipboard::command_available("wl-copy") {
        if let Err(e) = crate::clipboard::write_clipboard_via_wl_copy(text) {
            warn!("[clipboard] wl-copy restore failed: {e}");
        }
        return;
    }
    if let Err(e) = app_handle.clipboard().write_text(text) {
        warn!("[clipboard] text restore failed: {e}");
    }
}

#[cfg(target_os = "windows")]
mod win {
    use std::time::Duration;
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData, OpenClipboard,
        SetClipboardData,
    };
    use windows::Win32::System::Memory::{
        GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock,
    };

    /// Formats whose clipboard handles are NOT HGLOBAL memory (GDI objects, metafiles)
    /// or whose lifetime is owner-managed (owner-display/private/GDI-object ranges).
    /// Copying those as raw bytes is undefined; Windows re-synthesizes CF_BITMAP from
    /// the CF_DIB/CF_DIBV5 we do keep, so images still round-trip.
    pub(super) fn is_hglobal_format(format: u32) -> bool {
        const CF_BITMAP: u32 = 2;
        const CF_METAFILEPICT: u32 = 3;
        const CF_PALETTE: u32 = 9;
        const CF_ENHMETAFILE: u32 = 14;
        // 0x0080..=0x008F: CF_OWNERDISPLAY + the CF_DSP* display formats.
        // 0x0200..=0x02FF: CF_PRIVATEFIRST..CF_PRIVATELAST (owner-managed lifetime).
        // 0x0300..=0x03FF: CF_GDIOBJFIRST..CF_GDIOBJLAST (GDI handles).
        !matches!(
            format,
            CF_BITMAP | CF_METAFILEPICT | CF_PALETTE | CF_ENHMETAFILE
        ) && !(0x0080..=0x008F).contains(&format)
            && !(0x0200..=0x03FF).contains(&format)
    }

    /// RAII guard for the Win32 clipboard (a system-global mutex): always
    /// CloseClipboard, even on early return.
    struct ClipboardGuard;

    impl ClipboardGuard {
        fn open() -> Result<Self, String> {
            // Another process (often the one that just serviced our synthetic Ctrl+V)
            // can hold the clipboard for a few ms; retry briefly before giving up.
            for attempt in 0..20 {
                match unsafe { OpenClipboard(None) } {
                    Ok(()) => return Ok(Self),
                    Err(e) if attempt == 19 => return Err(format!("OpenClipboard failed: {e}")),
                    Err(_) => std::thread::sleep(Duration::from_millis(10)),
                }
            }
            unreachable!("OpenClipboard retry loop returns on the final attempt")
        }
    }

    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            let _ = unsafe { CloseClipboard() };
        }
    }

    pub(super) fn capture_raw() -> Result<Vec<(u32, Vec<u8>)>, String> {
        let _guard = ClipboardGuard::open()?;
        let mut formats: Vec<(u32, Vec<u8>)> = Vec::new();
        let mut format = 0u32;
        loop {
            format = unsafe { EnumClipboardFormats(format) };
            if format == 0 {
                break;
            }
            if !is_hglobal_format(format) {
                continue;
            }
            // GetClipboardData materializes delay-rendered formats. Any per-format
            // failure just skips that format (best-effort, like the OS itself).
            let Ok(handle) = (unsafe { GetClipboardData(format) }) else {
                continue;
            };
            if handle.is_invalid() {
                continue;
            }
            let hglobal = HGLOBAL(handle.0);
            let size = unsafe { GlobalSize(hglobal) };
            if size == 0 {
                continue;
            }
            let ptr = unsafe { GlobalLock(hglobal) };
            if ptr.is_null() {
                continue;
            }
            let bytes = unsafe { std::slice::from_raw_parts(ptr.cast::<u8>(), size) }.to_vec();
            // GlobalUnlock reports "now unlocked" as an Err(NO_ERROR); ignore it.
            let _ = unsafe { GlobalUnlock(hglobal) };
            formats.push((format, bytes));
        }
        Ok(formats)
    }

    pub(super) fn restore_raw(formats: &[(u32, Vec<u8>)]) -> Result<(), String> {
        let _guard = ClipboardGuard::open()?;
        unsafe { EmptyClipboard() }.map_err(|e| format!("EmptyClipboard failed: {e}"))?;
        for (format, bytes) in formats {
            let Ok(hglobal) = (unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) }) else {
                log::warn!(
                    "[clipboard] GlobalAlloc failed for format {format} ({} bytes)",
                    bytes.len()
                );
                continue;
            };
            let ptr = unsafe { GlobalLock(hglobal) };
            if ptr.is_null() {
                let _ = unsafe { GlobalFree(Some(hglobal)) };
                continue;
            }
            unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr.cast::<u8>(), bytes.len()) };
            let _ = unsafe { GlobalUnlock(hglobal) };
            // On success the clipboard owns the memory; free it only when handing it
            // over failed.
            if unsafe { SetClipboardData(*format, Some(HANDLE(hglobal.0))) }.is_err() {
                log::warn!("[clipboard] SetClipboardData failed for format {format}");
                let _ = unsafe { GlobalFree(Some(hglobal)) };
            }
        }
        Ok(())
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::win::is_hglobal_format;

    #[test]
    fn keeps_hglobal_backed_formats() {
        assert!(is_hglobal_format(1)); // CF_TEXT
        assert!(is_hglobal_format(8)); // CF_DIB (images)
        assert!(is_hglobal_format(13)); // CF_UNICODETEXT
        assert!(is_hglobal_format(15)); // CF_HDROP (copied files)
        assert!(is_hglobal_format(17)); // CF_DIBV5
        assert!(is_hglobal_format(0xC000)); // registered formats (HTML, RTF, …)
    }

    #[test]
    fn skips_non_hglobal_and_owner_managed_formats() {
        assert!(!is_hglobal_format(2)); // CF_BITMAP (GDI handle)
        assert!(!is_hglobal_format(3)); // CF_METAFILEPICT
        assert!(!is_hglobal_format(9)); // CF_PALETTE
        assert!(!is_hglobal_format(14)); // CF_ENHMETAFILE
        assert!(!is_hglobal_format(0x0080)); // CF_OWNERDISPLAY
        assert!(!is_hglobal_format(0x008E)); // CF_DSPENHMETAFILE
        assert!(!is_hglobal_format(0x0200)); // CF_PRIVATEFIRST
        assert!(!is_hglobal_format(0x03FF)); // CF_GDIOBJLAST
    }
}
