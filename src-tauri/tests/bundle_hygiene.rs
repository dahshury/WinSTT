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

#[test]
fn windows_bundle_preflight_covers_every_native_payload() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let build_script =
        std::fs::read_to_string(manifest_dir.join("../tools/windows/tauri-build.ps1"))
            .expect("read tools/windows/tauri-build.ps1");
    let bundle_config =
        std::fs::read_to_string(manifest_dir.join("tauri.windows.bundle.conf.json"))
            .expect("read tauri.windows.bundle.conf.json");

    for name in [
        "DirectML.dll",
        "msvcp140.dll",
        "msvcp140_1.dll",
        "vcruntime140.dll",
        "vcruntime140_1.dll",
        "winstt_context.exe",
    ] {
        assert!(
            build_script.contains(name),
            "Windows bundle preflight does not track required payload {name}"
        );
    }
    assert!(
        build_script.contains("Assert-NonEmptyFile -Path $SidecarPath")
            && build_script.contains("Assert-NonEmptyFile -Path (Join-Path $RuntimeDir $Dll)")
            && build_script.contains("$File.Length -le 0"),
        "Windows build must reject missing or empty staged sidecar/runtime files"
    );
    assert!(
        bundle_config.contains("\"binaries/runtime/*.dll\": \"./\"")
            && bundle_config.contains("\"target/release/winstt_context.exe\": \"./\""),
        "Windows bundle config must install the payloads covered by the preflight"
    );
}

#[test]
fn windows_installer_rejects_cpus_below_the_static_ort_minimum() {
    let template = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("nsis/installer.nsi"),
    )
    .expect("read custom NSIS installer template");

    assert!(
        template.contains("IsProcessorFeaturePresent(i ${PF_AVX2_INSTRUCTIONS_AVAILABLE})")
            && template.contains("requires an AVX2-capable processor"),
        "the installer must reject unsupported CPUs before launching static x86-64-v3 ORT code"
    );
}
