// Generic single-graph ONNX prober for EP bring-up — loads ONE .onnx, synthesizes inputs, runs it
// on the chosen EP inside catch_unwind, and prints per-output shapes (or the crash). Built for
// bisecting WHERE inside a graph a DirectML kernel fault fires: pair it with a Python script that
// writes truncated copies (graph outputs swapped for an intermediate tensor) and binary-search.
//
//   PROBE_MODEL=path.onnx PROBE_PROVIDER=dml cargo run --release --example onnx_dml_probe
//
// Env:
//   PROBE_MODEL      path to the .onnx (required)
//   PROBE_PROVIDER   cpu | dml            (default dml)
//   PROBE_SEQ        seq_len for dynamic time dims (default 301 ≈ 3 s of 16 kHz mel frames)
//   PROBE_FILL       constant fill for float inputs (default 0.1)
//
// Input synthesis: float tensors get PROBE_FILL; (u)int64 tensors get the resolved dim value of the
// LAST dynamic axis (covers NeMo-style `length` inputs); dynamic dims resolve as batch→1,
// seq-like→PROBE_SEQ.

#[cfg(target_os = "windows")]
use ort::session::Session;
#[cfg(target_os = "windows")]
use ort::value::{DynValue, Tensor};

#[cfg(target_os = "windows")]
fn main() {
    let model = std::env::var("PROBE_MODEL").expect("PROBE_MODEL required");
    let provider = std::env::var("PROBE_PROVIDER").unwrap_or_else(|_| "dml".into());
    let seq: i64 = std::env::var("PROBE_SEQ")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(301);
    let fill: f32 = std::env::var("PROBE_FILL")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.1);

    let mut builder = Session::builder().expect("builder");
    // Optional session-config experiments (PROBE_CFG="key=val;key2=val2"), e.g. the DML fusion
    // switches `ep.dml.enable_graph_fusion` / `ep.dml.enable_graph_serialization`.
    if let Ok(cfg) = std::env::var("PROBE_CFG") {
        for pair in cfg.split(';').filter(|s| !s.is_empty()) {
            let (k, v) = pair.split_once('=').expect("PROBE_CFG key=val");
            builder = builder.with_config_entry(k, v).expect("config entry");
            eprintln!("config: {k}={v}");
        }
    }
    if let Ok(lvl) = std::env::var("PROBE_OPT") {
        use ort::session::builder::GraphOptimizationLevel as G;
        let l = match lvl.as_str() {
            "0" => G::Disable,
            "1" => G::Level1,
            "2" => G::Level2,
            _ => G::Level3,
        };
        builder = builder.with_optimization_level(l).expect("opt level");
        eprintln!("opt level: {lvl}");
    }
    if provider == "dml" {
        builder = builder.with_memory_pattern(false).expect("mem pattern");
        // PROBE_DML_OPTS="disable_metacommands=true;..." registers DML through the GENERIC
        // string-keyed provider-options API (SessionOptionsAppendExecutionProvider("DML", ...)),
        // which the `ort` crate's typed DirectML builder can't reach. ORT 1.24's DML factory parses
        // `disable_metacommands` there (dml_provider_factory.cc CreateFromProviderOptions). Empty →
        // the normal typed registration.
        if let Ok(opts) = std::env::var("PROBE_DML_OPTS") {
            use ort::AsPointer;
            let pairs: Vec<(std::ffi::CString, std::ffi::CString)> = opts
                .split(';')
                .filter(|s| !s.is_empty())
                .map(|p| {
                    let (k, v) = p.split_once('=').expect("PROBE_DML_OPTS key=val");
                    (
                        std::ffi::CString::new(k).unwrap(),
                        std::ffi::CString::new(v).unwrap(),
                    )
                })
                .collect();
            let keys: Vec<*const std::ffi::c_char> =
                pairs.iter().map(|(k, _)| k.as_ptr()).collect();
            let vals: Vec<*const std::ffi::c_char> =
                pairs.iter().map(|(_, v)| v.as_ptr()).collect();
            let ep_name = std::ffi::CString::new("DML").unwrap();
            let status = unsafe {
                (ort::api().SessionOptionsAppendExecutionProvider)(
                    builder.ptr_mut(),
                    ep_name.as_ptr(),
                    keys.as_ptr(),
                    vals.as_ptr(),
                    keys.len(),
                )
            };
            if !status.0.is_null() {
                eprintln!("💥 DML generic-append failed (status non-null)");
                std::process::exit(4);
            }
            eprintln!("registered DML via generic API with opts: {opts}");
        } else {
            builder = builder
                .with_execution_providers([ort::ep::DirectML::default().build()])
                .expect("dml ep");
        }
    }
    let mut session = match builder.commit_from_file(&model) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("💥 SESSION CREATE FAILED: {e}");
            std::process::exit(4);
        }
    };

    // Synthesize inputs from session metadata.
    let meta: Vec<(String, Option<ort::value::TensorElementType>, Vec<i64>)> = session
        .inputs()
        .iter()
        .map(|i| {
            let dtype = i.dtype().tensor_type();
            let shape: Vec<i64> = i
                .dtype()
                .tensor_shape()
                .map(|s| s.iter().copied().collect())
                .unwrap_or_default();
            (i.name().to_string(), dtype, shape)
        })
        .collect();
    let mut inputs: Vec<(String, DynValue)> = Vec::new();
    for (name, dtype, shape) in meta {
        let mut dims: Vec<i64> = shape.iter().map(|&d| if d > 0 { d } else { seq }).collect();
        // First dynamic axis is batch-like → 1.
        if shape.first().is_some_and(|&d| d <= 0) {
            dims[0] = 1;
        }
        let numel: usize = dims.iter().product::<i64>() as usize;
        eprintln!("input {name}: dtype={dtype:?} dims={dims:?}");
        let value: DynValue = match dtype {
            Some(ort::value::TensorElementType::Float32) => {
                Tensor::<f32>::from_array((dims.clone(), vec![fill; numel]))
                    .expect("f32")
                    .into_dyn()
            }
            Some(ort::value::TensorElementType::Int64) => {
                // length-style input: the time dim of the main input
                Tensor::<i64>::from_array((dims.clone(), vec![seq; numel]))
                    .expect("i64")
                    .into_dyn()
            }
            other => panic!("unsupported input dtype {other:?}"),
        };
        inputs.push((name, value));
    }

    let runs: usize = std::env::var("PROBE_RUNS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let input_refs: Vec<(&str, &DynValue)> =
            inputs.iter().map(|(n, v)| (n.as_str(), v)).collect();
        for i in 1..runs {
            if let Err(e) = session.run(input_refs.clone()) {
                eprintln!("run {i} failed: {e}");
                return Err(e);
            }
            eprintln!("run {i} ok");
        }
        session.run(input_refs).map(|outputs| {
            outputs
                .iter()
                .map(|(name, v)| {
                    let shape = match v.dtype() {
                        ort::value::ValueType::Tensor { shape, .. } => format!("{shape:?}"),
                        _ => "?".into(),
                    };
                    (name.to_string(), shape)
                })
                .collect::<Vec<_>>()
        })
    }));
    match run {
        Ok(Ok(outputs)) => {
            for (name, shape) in outputs {
                eprintln!("✅ output {name}: {shape}");
            }
        }
        Ok(Err(e)) => {
            eprintln!("❌ RUN ERROR: {e}");
            std::process::exit(6);
        }
        Err(_) => {
            eprintln!("💥 RUN PANIC");
            std::process::exit(7);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("onnx_dml_probe is only available on Windows");
}
