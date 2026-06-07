// Source: docs/archive/port/07_*.md §3 + lib_wiring.md §3,
// memory project_context_playground_debug. Wraps managers::ContextManager.
//
// Context-awareness debug command — gated behind
// `any(debug_assertions, feature = "context-playground")`: on automatically in
// dev builds, off in shipped builds (mirrors CONTEXT_PLAYGROUND_ENABLED, which is
// `import.meta.env.DEV` on the renderer side). Surfaces EXACTLY what the dictation
// capture pulls from the focused field, for the live debug window.

use serde::{Deserialize, Serialize};
use specta::Type;

#[cfg(any(debug_assertions, feature = "context-playground"))]
use std::sync::Arc;
#[cfg(any(debug_assertions, feature = "context-playground"))]
use tauri::State;

#[cfg(any(debug_assertions, feature = "context-playground"))]
use crate::winstt::context::ContextMode;
#[cfg(any(debug_assertions, feature = "context-playground"))]
use crate::winstt::managers::ContextManager;

/// One visible running app that can be selected for context-awareness scope.
/// `id`/`exe` are normalized executable basenames; `icon` is a best-effort
/// data URL extracted from the executable's shell icon on Windows.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextAppEntry {
    pub id: String,
    pub label: String,
    pub exe: String,
    pub title: Option<String>,
    pub icon: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn list_context_apps() -> Vec<ContextAppEntry> {
    tauri::async_runtime::spawn_blocking(list_context_apps_blocking)
        .await
        .unwrap_or_default()
}

#[cfg(not(target_os = "windows"))]
fn list_context_apps_blocking() -> Vec<ContextAppEntry> {
    Vec::new()
}

#[cfg(target_os = "windows")]
fn list_context_apps_blocking() -> Vec<ContextAppEntry> {
    use std::collections::BTreeMap;

    let mut raw = Vec::<RawContextWindow>::new();
    // SAFETY: `raw` lives for the duration of EnumWindows; the callback casts
    // the LPARAM back to this vector and pushes plain owned values only.
    let _ = unsafe {
        windows::Win32::UI::WindowsAndMessaging::EnumWindows(
            Some(enum_context_window),
            windows::Win32::Foundation::LPARAM(&mut raw as *mut _ as isize),
        )
    };

    let mut by_exe = BTreeMap::<String, ContextAppEntry>::new();
    for window in raw {
        let Some(path) = process_image_path(window.process_id) else {
            continue;
        };
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let exe = file_name.to_lowercase();
        if exe.is_empty() {
            continue;
        }
        by_exe
            .entry(exe.clone())
            .or_insert_with(|| ContextAppEntry {
                id: exe.clone(),
                label: app_label_from_path(&path),
                exe,
                title: Some(window.title),
                icon: icon_data_uri_for_path(&path),
            });
    }

    let mut apps: Vec<_> = by_exe.into_values().collect();
    apps.sort_by(|a, b| {
        a.label
            .to_lowercase()
            .cmp(&b.label.to_lowercase())
            .then_with(|| a.exe.cmp(&b.exe))
    });
    apps
}

#[cfg(target_os = "windows")]
struct RawContextWindow {
    process_id: u32,
    title: String,
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_context_window(
    hwnd: windows::Win32::Foundation::HWND,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::core::BOOL {
    use windows::Win32::Foundation::TRUE;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    };

    // SAFETY: The HWND comes from EnumWindows. Visibility/text calls do not take
    // ownership and tolerate stale/inaccessible windows by returning empty.
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return TRUE;
    }
    let text_len = unsafe { GetWindowTextLengthW(hwnd) };
    if text_len <= 0 {
        return TRUE;
    }
    let mut title = vec![0u16; text_len as usize + 1];
    let copied = unsafe { GetWindowTextW(hwnd, &mut title) };
    if copied <= 0 {
        return TRUE;
    }
    title.truncate(copied as usize);
    let title = String::from_utf16_lossy(&title).trim().to_string();
    if title.is_empty() {
        return TRUE;
    }

    let mut process_id = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    }
    if process_id == 0 || process_id == std::process::id() {
        return TRUE;
    }

    let windows = unsafe { &mut *(lparam.0 as *mut Vec<RawContextWindow>) };
    windows.push(RawContextWindow { process_id, title });
    TRUE
}

#[cfg(target_os = "windows")]
fn process_image_path(process_id: u32) -> Option<std::path::PathBuf> {
    use windows::Win32::Foundation::{CloseHandle, HMODULE};
    use windows::Win32::System::ProcessStatus::K32GetModuleFileNameExW;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };

    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
            false,
            process_id,
        )
        .ok()?
    };
    let mut buffer = vec![0u16; 32768];
    let len =
        unsafe { K32GetModuleFileNameExW(Some(handle), Some(HMODULE::default()), &mut buffer) };
    let _ = unsafe { CloseHandle(handle) };
    if len == 0 {
        return None;
    }
    buffer.truncate(len as usize);
    Some(std::path::PathBuf::from(String::from_utf16_lossy(&buffer)))
}

#[cfg(target_os = "windows")]
fn app_label_from_path(path: &std::path::Path) -> String {
    path.file_stem()
        .and_then(|n| n.to_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            path.file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_else(|| "Unknown app".to_string())
}

#[cfg(target_os = "windows")]
fn icon_data_uri_for_path(path: &std::path::Path) -> Option<String> {
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON};
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;

    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    let mut info = SHFILEINFOW::default();
    let flags = SHGFI_ICON | SHGFI_SMALLICON;
    let ok = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut info),
            size_of::<SHFILEINFOW>() as u32,
            flags,
        )
    };
    if ok == 0 || info.hIcon.is_invalid() {
        return None;
    }
    let data_uri = hicon_to_bmp_data_uri(info.hIcon);
    let _ = unsafe { DestroyIcon(info.hIcon) };
    data_uri
}

#[cfg(target_os = "windows")]
fn hicon_to_bmp_data_uri(hicon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<String> {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr::null_mut;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
        SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DrawIconEx, DI_NORMAL};

    const ICON_SIZE: usize = 32;
    const BYTES_PER_PIXEL: usize = 4;
    const PIXEL_BYTES: usize = ICON_SIZE * ICON_SIZE * BYTES_PER_PIXEL;

    unsafe {
        let screen_dc = GetDC(None);
        if screen_dc.is_invalid() {
            return None;
        }
        let memory_dc = CreateCompatibleDC(Some(screen_dc));
        if memory_dc.is_invalid() {
            let _ = ReleaseDC(None, screen_dc);
            return None;
        }

        let bitmap_info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: ICON_SIZE as i32,
                // Top-down DIB makes the copied memory order natural.
                biHeight: -(ICON_SIZE as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };

        let mut bits: *mut c_void = null_mut();
        let bitmap = match CreateDIBSection(
            Some(memory_dc),
            &bitmap_info,
            DIB_RGB_COLORS,
            &mut bits,
            None,
            0,
        ) {
            Ok(bitmap) => bitmap,
            Err(_) => {
                let _ = DeleteDC(memory_dc);
                let _ = ReleaseDC(None, screen_dc);
                return None;
            }
        };

        let previous = SelectObject(memory_dc, HGDIOBJ(bitmap.0));
        let draw_ok = DrawIconEx(
            memory_dc,
            0,
            0,
            hicon,
            ICON_SIZE as i32,
            ICON_SIZE as i32,
            0,
            None,
            DI_NORMAL,
        )
        .is_ok();

        let pixels = if draw_ok && !bits.is_null() {
            let mut pixels = std::slice::from_raw_parts(bits as *const u8, PIXEL_BYTES).to_vec();
            for px in pixels.chunks_mut(BYTES_PER_PIXEL) {
                if px[3] == 0 && (px[0] != 0 || px[1] != 0 || px[2] != 0) {
                    px[3] = 255;
                }
            }
            Some(pixels)
        } else {
            None
        };

        if !previous.is_invalid() {
            let _ = SelectObject(memory_dc, previous);
        }
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(memory_dc);
        let _ = ReleaseDC(None, screen_dc);

        pixels.map(|pixels| {
            let bmp = bmp_bytes_from_top_down_bgra(&pixels, ICON_SIZE, ICON_SIZE);
            format!("data:image/bmp;base64,{}", base64_encode(&bmp))
        })
    }
}

#[cfg(target_os = "windows")]
fn bmp_bytes_from_top_down_bgra(pixels: &[u8], width: usize, height: usize) -> Vec<u8> {
    let pixel_bytes = width * height * 4;
    let file_size = 14 + 40 + pixel_bytes;
    let mut out = Vec::with_capacity(file_size);

    out.extend_from_slice(b"BM");
    out.extend_from_slice(&(file_size as u32).to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&(54u32).to_le_bytes());

    out.extend_from_slice(&(40u32).to_le_bytes());
    out.extend_from_slice(&(width as i32).to_le_bytes());
    out.extend_from_slice(&(height as i32).to_le_bytes());
    out.extend_from_slice(&(1u16).to_le_bytes());
    out.extend_from_slice(&(32u16).to_le_bytes());
    out.extend_from_slice(&(0u32).to_le_bytes());
    out.extend_from_slice(&(pixel_bytes as u32).to_le_bytes());
    out.extend_from_slice(&(0i32).to_le_bytes());
    out.extend_from_slice(&(0i32).to_le_bytes());
    out.extend_from_slice(&(0u32).to_le_bytes());
    out.extend_from_slice(&(0u32).to_le_bytes());

    let row_bytes = width * 4;
    for row in (0..height).rev() {
        let start = row * row_bytes;
        out.extend_from_slice(&pixels[start..start + row_bytes]);
    }
    out
}

#[cfg(target_os = "windows")]
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((n >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(n & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// The debug capture payload — the raw snapshot fields + the formatted prompt
/// fragment the LLM would receive, plus the detection verdicts.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextDebugPayload {
    pub window_title: String,
    pub element_name: String,
    pub focused_text: String,
    pub app_exe: Option<String>,
    pub url: Option<String>,
    pub prompt_fragment: String,
    pub is_ide: bool,
    pub is_terminal: bool,
    pub is_canvas: bool,
    pub is_rich_field: bool,
}

/// `debug_read_context` — capture the focused-field context in `mode` and return
/// both the raw snapshot and the formatted fragment (debug only).
#[cfg(any(debug_assertions, feature = "context-playground"))]
#[tauri::command]
#[specta::specta]
pub fn debug_read_context(
    context: State<'_, Arc<ContextManager>>,
    mode: String,
) -> ContextDebugPayload {
    use crate::winstt::context::{debug_verdicts, format_context_for_prompt, ContextReader};

    let mode = match mode.as_str() {
        "selection" => ContextMode::Selection,
        "split" => ContextMode::Split,
        "tree" => ContextMode::Tree,
        _ => ContextMode::Focused,
    };
    let snapshot = context.read(mode);
    let verdicts = debug_verdicts(&snapshot);
    let fragment = format_context_for_prompt(&snapshot);
    ContextDebugPayload {
        window_title: snapshot.window_title.clone(),
        element_name: snapshot.element_name.clone(),
        focused_text: snapshot.focused_text.clone(),
        app_exe: snapshot.app_exe.clone(),
        url: snapshot.url.clone(),
        prompt_fragment: fragment,
        is_ide: *verdicts.get("ide").unwrap_or(&false),
        is_terminal: *verdicts.get("terminal").unwrap_or(&false),
        is_canvas: *verdicts.get("canvas").unwrap_or(&false),
        is_rich_field: *verdicts.get("rich_field").unwrap_or(&false),
    }
}
