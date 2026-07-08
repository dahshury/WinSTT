// Tauri's bundler ships EVERY cargo `[[bin]]` target of this crate inside the
// installer as an "additional binary" installed next to winstt.exe. A dev spike
// dropped into src/bin therefore ends up on user machines — 0.1.3-alpha.1 shipped
// a 21.8 MB context_prompt_smoke.exe that way, and an unbuilt bin target aborts
// the bundle step outright ("when getting size of ... .exe: file not found").
// Dev tools belong in src-tauri/examples/: `cargo build` skips them and the
// bundler never sees them.

#[test]
fn only_the_context_sidecar_lives_in_src_bin() {
    let bin_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/bin");
    let mut names: Vec<String> = std::fs::read_dir(&bin_dir)
        .expect("src-tauri/src/bin exists")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(
        names,
        vec!["winstt_context.rs".to_string()],
        "unexpected cargo bin target(s) in src-tauri/src/bin — Tauri bundles every [[bin]] \
		 into the installer; put dev tools in src-tauri/examples/ instead"
    );
}
