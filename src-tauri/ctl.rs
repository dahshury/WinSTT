fn main() {
    for c in ['\u{9}', '\u{a}', '\u{b}', '\u{c}', '\u{d}', '\u{0}', '\u{85}', '\u{2028}', '\u{2029}', '\u{1b}'] {
        let bytes: Vec<String> = c.to_string().bytes().map(|b| format!("{b:02x}")).collect();
        println!("U+{:04X} is_control={} bytes={} has0a={}", c as u32, c.is_control(), bytes.join(" "), c.to_string().as_bytes().contains(&0x0a));
    }
}
