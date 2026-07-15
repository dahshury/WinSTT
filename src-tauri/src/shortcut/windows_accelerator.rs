use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VIRTUAL_KEY};

#[derive(Clone, Copy, Debug)]
pub(super) enum KeyRequirement {
    Exact(u16),
    Any(u16, u16),
}

impl KeyRequirement {
    pub(super) fn is_down(self) -> bool {
        match self {
            Self::Exact(vk) => vk_is_down(vk),
            Self::Any(left, right) => vk_is_down(left) || vk_is_down(right),
        }
    }

    pub(super) fn contains(self, vk: u16) -> bool {
        match self {
            Self::Exact(value) => value == vk,
            Self::Any(left, right) => left == vk || right == vk,
        }
    }
}

fn vk_is_down(vk: u16) -> bool {
    // SAFETY: reads the current async state for the requested virtual-key.
    (unsafe { GetAsyncKeyState(VIRTUAL_KEY(vk).0 as i32) } as u16 & 0x8000) != 0
}

pub(super) fn parse_requirements(accelerator: &str) -> Option<Vec<KeyRequirement>> {
    let requirements = accelerator
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(parse_token)
        .collect::<Option<Vec<_>>>()?;
    (!requirements.is_empty()).then_some(requirements)
}

fn parse_token(token: &str) -> Option<KeyRequirement> {
    let exact = |code| Some(KeyRequirement::Exact(code));
    let any = |left, right| Some(KeyRequirement::Any(left, right));
    match token.to_ascii_lowercase().as_str() {
        "lctrl" | "ctrl_left" | "controlleft" | "control_left" => exact(0xA2),
        "rctrl" | "ctrl_right" | "controlright" | "control_right" => exact(0xA3),
        "ctrl" | "control" => any(0xA2, 0xA3),
        "lalt" | "alt_left" | "altleft" | "option_left" | "optionleft" => exact(0xA4),
        "ralt" | "alt_right" | "altright" | "altgr" | "option_right" | "optionright" => exact(0xA5),
        "alt" | "option" | "opt" => any(0xA4, 0xA5),
        "lshift" | "shift_left" | "shiftleft" => exact(0xA0),
        "rshift" | "shift_right" | "shiftright" => exact(0xA1),
        "shift" => any(0xA0, 0xA1),
        "lmeta" | "lwin" | "win_left" | "winleft" | "super_left" | "superleft" | "meta_left"
        | "metaleft" => exact(0x5B),
        "rmeta" | "rwin" | "win_right" | "winright" | "super_right" | "superright"
        | "meta_right" | "metaright" => exact(0x5C),
        "meta" | "super" | "win" | "windows" | "cmd" | "command" => any(0x5B, 0x5C),
        "space" => exact(0x20),
        "tab" => exact(0x09),
        "enter" | "return" => exact(0x0D),
        "escape" | "esc" => exact(0x1B),
        "backspace" => exact(0x08),
        "delete" | "forwarddelete" => exact(0x2E),
        "insert" => exact(0x2D),
        "home" => exact(0x24),
        "end" => exact(0x23),
        "pageup" | "prior" => exact(0x21),
        "pagedown" | "next" => exact(0x22),
        "arrowleft" | "left" => exact(0x25),
        "arrowup" | "up" => exact(0x26),
        "arrowright" | "right" => exact(0x27),
        "arrowdown" | "down" => exact(0x28),
        function if function.len() >= 2 && function.starts_with('f') => {
            let number = function[1..].parse::<u16>().ok()?;
            (1..=24)
                .contains(&number)
                .then_some(KeyRequirement::Exact(0x6F + number))
        }
        key if key.len() == 1 => {
            let character = key.as_bytes()[0];
            if character.is_ascii_alphabetic() {
                exact(character.to_ascii_uppercase() as u16)
            } else if character.is_ascii_digit() {
                exact(character as u16)
            } else {
                None
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{KeyRequirement, parse_requirements};

    #[test]
    fn parses_supported_accelerators() {
        assert_eq!(parse_requirements("LCtrl+LMeta").unwrap().len(), 2);
        assert_eq!(parse_requirements("Ctrl+Space").unwrap().len(), 2);
        assert_eq!(parse_requirements("F2").unwrap().len(), 1);
    }

    #[test]
    fn detects_arrow_up() {
        let requirements = parse_requirements("LCtrl+ArrowUp").unwrap();
        assert!(
            requirements
                .iter()
                .any(|requirement| requirement.contains(0x26))
        );
        let requirements = parse_requirements("LCtrl+LMeta").unwrap();
        assert!(
            !requirements
                .iter()
                .any(|requirement| requirement.contains(0x26))
        );
    }

    #[test]
    fn rejects_unknown_tokens() {
        assert!(parse_requirements("LCtrl+NotAKey").is_none());
    }

    #[test]
    fn requirements_keep_exact_or_any_shape() {
        assert!(matches!(
            parse_requirements("F2").unwrap()[0],
            KeyRequirement::Exact(_)
        ));
        assert!(matches!(
            parse_requirements("Ctrl").unwrap()[0],
            KeyRequirement::Any(_, _)
        ));
    }
}
