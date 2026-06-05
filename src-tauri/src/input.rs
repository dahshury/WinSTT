use enigo::{Enigo, Key, Keyboard, Mouse, Settings};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_BACK, VK_LCONTROL, VK_LMENU, VK_LSHIFT,
    VK_LWIN, VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_RWIN,
};

/// Wrapper for Enigo to store in Tauri's managed state.
/// Enigo is wrapped in a Mutex since it requires mutable access.
pub struct EnigoState(pub Mutex<Enigo>);

impl EnigoState {
    pub fn new() -> Result<Self, String> {
        let enigo = Enigo::new(&Settings::default())
            .map_err(|e| format!("Failed to initialize Enigo: {}", e))?;
        Ok(Self(Mutex::new(enigo)))
    }
}

/// Get the current mouse cursor position using the managed Enigo instance.
/// Returns None if the state is not available or if getting the location fails.
pub fn get_cursor_position(app_handle: &AppHandle) -> Option<(i32, i32)> {
    let enigo_state = app_handle.try_state::<EnigoState>()?;
    let enigo = enigo_state.0.lock().ok()?;
    enigo.location().ok()
}

/// Sends a Ctrl+V or Cmd+V paste command using platform-specific virtual key codes.
/// This ensures the paste works regardless of keyboard layout (e.g., Russian, AZERTY, DVORAK).
/// Note: On Wayland, this may not work - callers should check for Wayland and use alternative methods.
pub fn send_paste_ctrl_v(enigo: &mut Enigo) -> Result<(), String> {
    // Platform-specific key definitions
    #[cfg(target_os = "macos")]
    let (modifier_key, v_key_code) = (Key::Meta, Key::Other(9));
    #[cfg(target_os = "windows")]
    let (modifier_key, v_key_code) = (Key::Control, Key::Other(0x56)); // VK_V
    #[cfg(target_os = "linux")]
    let (modifier_key, v_key_code) = (Key::Control, Key::Unicode('v'));

    // Press modifier + V
    enigo
        .key(modifier_key, enigo::Direction::Press)
        .map_err(|e| format!("Failed to press modifier key: {}", e))?;
    enigo
        .key(v_key_code, enigo::Direction::Click)
        .map_err(|e| format!("Failed to click V key: {}", e))?;

    std::thread::sleep(std::time::Duration::from_millis(100));

    enigo
        .key(modifier_key, enigo::Direction::Release)
        .map_err(|e| format!("Failed to release modifier key: {}", e))?;

    Ok(())
}

/// Sends a Ctrl+Shift+V paste command.
/// This is commonly used in terminal applications on Linux to paste without formatting.
/// Note: On Wayland, this may not work - callers should check for Wayland and use alternative methods.
pub fn send_paste_ctrl_shift_v(enigo: &mut Enigo) -> Result<(), String> {
    // Platform-specific key definitions
    #[cfg(target_os = "macos")]
    let (modifier_key, v_key_code) = (Key::Meta, Key::Other(9)); // Cmd+Shift+V on macOS
    #[cfg(target_os = "windows")]
    let (modifier_key, v_key_code) = (Key::Control, Key::Other(0x56)); // VK_V
    #[cfg(target_os = "linux")]
    let (modifier_key, v_key_code) = (Key::Control, Key::Unicode('v'));

    // Press Ctrl/Cmd + Shift + V
    enigo
        .key(modifier_key, enigo::Direction::Press)
        .map_err(|e| format!("Failed to press modifier key: {}", e))?;
    enigo
        .key(Key::Shift, enigo::Direction::Press)
        .map_err(|e| format!("Failed to press Shift key: {}", e))?;
    enigo
        .key(v_key_code, enigo::Direction::Click)
        .map_err(|e| format!("Failed to click V key: {}", e))?;

    std::thread::sleep(std::time::Duration::from_millis(100));

    enigo
        .key(Key::Shift, enigo::Direction::Release)
        .map_err(|e| format!("Failed to release Shift key: {}", e))?;
    enigo
        .key(modifier_key, enigo::Direction::Release)
        .map_err(|e| format!("Failed to release modifier key: {}", e))?;

    Ok(())
}

/// Sends a Shift+Insert paste command (Windows and Linux only).
/// This is more universal for terminal applications and legacy software.
/// Note: On Wayland, this may not work - callers should check for Wayland and use alternative methods.
pub fn send_paste_shift_insert(enigo: &mut Enigo) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let insert_key_code = Key::Other(0x2D); // VK_INSERT
    #[cfg(not(target_os = "windows"))]
    let insert_key_code = Key::Other(0x76); // XK_Insert (keycode 118 / 0x76, also used as fallback)

    // Press Shift + Insert
    enigo
        .key(Key::Shift, enigo::Direction::Press)
        .map_err(|e| format!("Failed to press Shift key: {}", e))?;
    enigo
        .key(insert_key_code, enigo::Direction::Click)
        .map_err(|e| format!("Failed to click Insert key: {}", e))?;

    std::thread::sleep(std::time::Duration::from_millis(100));

    enigo
        .key(Key::Shift, enigo::Direction::Release)
        .map_err(|e| format!("Failed to release Shift key: {}", e))?;

    Ok(())
}

/// Sends a Ctrl+A or Cmd+A select-all command using platform-specific virtual
/// key codes so full-field replacement works regardless of keyboard layout.
pub fn send_select_all(enigo: &mut Enigo) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let (modifier_key, a_key_code) = (Key::Meta, Key::Other(0)); // Cmd + A
    #[cfg(target_os = "windows")]
    let (modifier_key, a_key_code) = (Key::Control, Key::Other(0x41)); // VK_A
    #[cfg(target_os = "linux")]
    let (modifier_key, a_key_code) = (Key::Control, Key::Unicode('a'));

    enigo
        .key(modifier_key, enigo::Direction::Press)
        .map_err(|e| format!("Failed to press modifier key: {}", e))?;
    enigo
        .key(a_key_code, enigo::Direction::Click)
        .map_err(|e| format!("Failed to click A key: {}", e))?;

    std::thread::sleep(std::time::Duration::from_millis(100));

    enigo
        .key(modifier_key, enigo::Direction::Release)
        .map_err(|e| format!("Failed to release modifier key: {}", e))?;

    Ok(())
}

/// Release any physically-held keyboard modifiers (both L/R Ctrl, Shift, Alt, Win) by
/// injecting key-up events.
///
/// Used by paste paths that run while the user may still be holding the app hotkey. Clearing
/// the logical modifier state prevents Ctrl/Win/Shift/Alt from changing the injected text or
/// paste shortcut delivered to the target app.
/// Injecting a key-up for a key that isn't down is harmless. Windows only (no-op elsewhere).
#[cfg(target_os = "windows")]
pub fn release_held_modifiers() {
    let _ = release_current_modifiers();
}

#[cfg(target_os = "windows")]
fn modifier_vks() -> [VIRTUAL_KEY; 8] {
    [
        VK_LCONTROL,
        VK_RCONTROL,
        VK_LSHIFT,
        VK_RSHIFT,
        VK_LMENU,
        VK_RMENU,
        VK_LWIN,
        VK_RWIN,
    ]
}

#[cfg(target_os = "windows")]
fn vk_is_down(vk: VIRTUAL_KEY) -> bool {
    // SAFETY: GetAsyncKeyState is read-only for the requested virtual-key code.
    (unsafe { GetAsyncKeyState(vk.0 as i32) } as u16 & 0x8000) != 0
}

#[cfg(target_os = "windows")]
fn vk_input(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

#[cfg(target_os = "windows")]
fn send_vk_events(vks: &[VIRTUAL_KEY], flags: KEYBD_EVENT_FLAGS) -> Result<(), String> {
    if vks.is_empty() {
        return Ok(());
    }

    let inputs: Vec<INPUT> = vks.iter().map(|&vk| vk_input(vk, flags)).collect();
    // SAFETY: `inputs` is a valid, correctly-sized slice of INPUT for SendInput.
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return Err(format!(
            "SendInput sent {sent} of {} modifier events",
            inputs.len()
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn send_vk_clicks(vk: VIRTUAL_KEY, count: usize) -> Result<(), String> {
    if count == 0 {
        return Ok(());
    }

    let mut inputs = Vec::with_capacity(count * 2);
    for _ in 0..count {
        inputs.push(vk_input(vk, KEYBD_EVENT_FLAGS(0)));
        inputs.push(vk_input(vk, KEYEVENTF_KEYUP));
    }

    // SAFETY: `inputs` is a valid, correctly-sized slice of INPUT for SendInput.
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return Err(format!(
            "SendInput sent {sent} of {} key click events",
            inputs.len()
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn release_current_modifiers() -> Result<Vec<VIRTUAL_KEY>, String> {
    let released: Vec<VIRTUAL_KEY> = modifier_vks()
        .into_iter()
        .filter(|&vk| vk_is_down(vk))
        .collect();
    send_vk_events(&released, KEYEVENTF_KEYUP)?;
    Ok(released)
}

/// Inject Unicode text without pressing any accelerator keys. This is the Windows-safe path for
/// streaming paste while the dictation hotkey modifiers are still physically held.
#[cfg(target_os = "windows")]
fn paste_text_unicode(text: &str) -> Result<(), String> {
    const TYPE_BATCH_UNITS: usize = 64;

    let units: Vec<u16> = text.encode_utf16().collect();
    if units.is_empty() {
        return Ok(());
    }

    let mut i = 0;
    while i < units.len() {
        let mut batch_units = 0;
        let mut inputs = Vec::with_capacity(TYPE_BATCH_UNITS * 2);

        while i < units.len() && batch_units < TYPE_BATCH_UNITS {
            let unit = units[i];
            let has_low_partner = (0xD800..=0xDBFF).contains(&unit)
                && i + 1 < units.len()
                && (0xDC00..=0xDFFF).contains(&units[i + 1]);

            if has_low_partner && batch_units + 2 > TYPE_BATCH_UNITS {
                break;
            }

            push_unicode_unit(&mut inputs, unit);
            i += 1;
            batch_units += 1;

            if has_low_partner {
                push_unicode_unit(&mut inputs, units[i]);
                i += 1;
                batch_units += 1;
            }
        }

        // SAFETY: `inputs` is a valid INPUT slice. KEYEVENTF_UNICODE sends WM_CHAR-style
        // packets and does not depend on keyboard layout.
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize != inputs.len() {
            return Err(format!(
                "SendInput inserted {sent} of {} unicode key events",
                inputs.len()
            ));
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn unicode_input(unit: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: unit,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

#[cfg(target_os = "windows")]
fn push_unicode_unit(inputs: &mut Vec<INPUT>, unit: u16) {
    inputs.push(unicode_input(unit, KEYEVENTF_UNICODE));
    inputs.push(unicode_input(
        unit,
        KEYBD_EVENT_FLAGS(KEYEVENTF_UNICODE.0 | KEYEVENTF_KEYUP.0),
    ));
}

/// Apply a realtime text edit while a push-to-talk modifier combo may still be held.
pub fn edit_text_streaming(
    enigo: &mut Enigo,
    backspace_chars: usize,
    text: &str,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = enigo;
        let released = release_current_modifiers()?;
        if !released.is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        send_vk_clicks(VK_BACK, backspace_chars)?;
        paste_text_unicode(text)
    }

    #[cfg(not(target_os = "windows"))]
    {
        for _ in 0..backspace_chars {
            enigo
                .key(Key::Backspace, enigo::Direction::Click)
                .map_err(|e| format!("Failed to send backspace: {}", e))?;
        }
        if text.is_empty() {
            Ok(())
        } else {
            paste_text_direct(enigo, text)
        }
    }
}

/// Pastes text directly using the enigo text method.
/// This tries to use system input methods if possible, otherwise simulates keystrokes one by one.
pub fn paste_text_direct(enigo: &mut Enigo, text: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = enigo;
        return paste_text_unicode(text);
    }

    #[cfg(not(target_os = "windows"))]
    enigo
        .text(text)
        .map_err(|e| format!("Failed to send text directly: {}", e))
}
