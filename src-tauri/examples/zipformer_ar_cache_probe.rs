// One-off check that the picker's cache probe badges the seeded zipformer-ar-ctc quants.
// NOT shipped — `cargo run --release --example zipformer_ar_cache_probe`.

use winstt_app_lib::winstt::stt::cache_probe::{ProbeModel, probe_cache};

fn main() {
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    let models = vec![ProbeModel {
        id: "zipformer-ar-ctc".into(),
        family: "kaldi".into(),
        onnx_name: "Muno459/zipformer_p-arabic-v2".into(),
        quantizations: vec!["".into(), "int8".into()],
    }];
    let out = rt.block_on(probe_cache(&models));
    let Some(cache) = out.get("zipformer-ar-ctc") else {
        eprintln!("no probe result for zipformer-ar-ctc");
        std::process::exit(1);
    };
    let mut ok = true;
    for (quant, (state, downloaded, total)) in &cache.by_quant {
        let label = if quant.is_empty() {
            "fp32(default)"
        } else {
            quant
        };
        println!("{label}: {} ({downloaded}/{total} bytes)", state.as_str());
        ok &= state.as_str() == "cached";
    }
    if !ok {
        eprintln!("FAIL: expected every quant to badge cached");
        std::process::exit(1);
    }
    println!("OK: both quants badge cached");
}
