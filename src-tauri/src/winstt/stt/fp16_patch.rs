// Source: WinSTT server
//   (server/src/recorder/infrastructure/onnx_patch.py — patch_whisper_decoder, _fix_if_subgraph,
//    _walk; onnxasr_transcriber.py — _FP16_DECODER_LOAD_ERROR, _load_model_with_fp16_repair).
// + ONNX protobuf wire format (onnx.proto3, stable field numbers) hand-defined with `prost 0.13`
//   (verified attribute syntax docs.rs/prost/0.13: #[derive(prost::Message)] + #[prost(...)] tags).
//
// WHAT THIS DOES
// --------------
// Two responsibilities, both pure ONNX-protobuf surgery on `ort`'s behalf (no `ort` here):
//
//   1. `patch_fp16_decoder(path) -> Result<PathBuf>` — the in-file Whisper fp16 merged-decoder
//      repair. onnx-community `decoder_model_merged_fp16.onnx` exports declare each `If`-subgraph
//      output with the OUTER-scope name (`logits`, `present.*`) and an fp32 dtype annotation on an
//      otherwise-fp16 graph → ORT 1.18+ rejects it ("Subgraph output ... outer scope value").
//      We rewrite, IN PLACE (a one-shot, with a sidecar marker so we never re-parse a multi-MB
//      file): for each `If` subgraph output, (a) rename to the value actually produced inside the
//      subgraph (taken from the parent `If`'s positional output, when that name IS produced inside),
//      and (b) copy the parent `If`'s `TypeProto` over so the dtype matches (fp32→fp16). This is the
//      exact transform Optimum's fp16 pass would have applied — verified byte-for-byte vs fp32 in
//      WinSTT (onnx_patch.py docstring). Idempotent: a clean export yields 0 edits and is left alone.
//
//   2. `external_data_locations(path) -> Result<Vec<String>>` — enumerate the external-data sidecar
//      file names a (small) `.onnx` graph references, WITHOUT a heavyweight onnx.load of inline
//      weights. Used by `resolver::verify_external_data_complete` for the sharded-`.onnx_data`
//      completeness check (spec §2.3 / cohere fp16 memory). Only the `location` value of each
//      `external_data` key/value entry on each initializer is read.
//
// We hand-define ONLY the protobuf fields these two passes touch. Unknown fields are PRESERVED
// across a decode→encode round trip by carrying them in a trailing `#[prost(skip)]`? — NO: prost
// drops unknown fields. To keep the round trip lossless for the parts we don't model, we instead
// model EVERY field of the messages we mutate at the path we walk (ModelProto.graph → NodeProto →
// AttributeProto.g/graphs → GraphProto.{input,output,value_info,node} → ValueInfoProto.type), and
// carry weights/initializers/etc. as opaque `bytes`/repeated-message fields with their real tags so
// re-encoding reproduces them. The fp16 decoder graph is tiny (external-weights), so this is cheap.
//
// ONNX field NUMBERS below are from the stable onnx.proto3 spec and are
// not expected to change, but they are the load-bearing constants — if the patched file is still
// rejected by ORT after this round trip, re-verify the tags against the exact `onnx.proto` the
// target export was produced with.

use std::path::{Path, PathBuf};

use prost::Message;

use super::{SttError, SttResult};

// ---------------------------------------------------------------------------
// Marker (port of onnx_patch._PATCH_MARKER_NAME / should_skip_patch)
// ---------------------------------------------------------------------------

/// Sidecar marker so a multi-MB `.onnx` isn't re-read + re-parsed on every load. Dropped next to the
/// patched file. Bump the suffix if the patch logic changes. Matches the Python `.winstt_patched_v1`.
const PATCH_MARKER_SUFFIX: &str = ".winstt_patched_v1";

fn marker_path(model_path: &Path) -> PathBuf {
    let name = model_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("model.onnx");
    model_path.with_file_name(format!("{name}{PATCH_MARKER_SUFFIX}"))
}

/// True iff a sidecar marker shows this file was already inspected (port of `should_skip_patch`).
pub fn should_skip_patch(model_path: &Path) -> bool {
    marker_path(model_path).is_file()
}

// ---------------------------------------------------------------------------
// Minimal ONNX protobuf (onnx.proto3) — only the fields the two passes touch.
// Field NUMBERS are the stable ONNX spec tags. Re-verify if ORT rejects the round trip.
// ---------------------------------------------------------------------------

/// ONNX elem_type enum values we care about (TensorProto.DataType).
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "kept with the ONNX element-type constants for fp16 patch parity"
    )
)]
const ELEM_TYPE_FLOAT: i32 = 1;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "kept with the ONNX element-type constants for fp16 patch parity"
    )
)]
const ELEM_TYPE_FLOAT16: i32 = 10;

/// AttributeProto.AttributeType values we branch on.
const ATTR_TYPE_GRAPH: i32 = 5;
const ATTR_TYPE_GRAPHS: i32 = 10;

// ModelProto: `ir_version` is int64 (tag 1); we carry the common scalar/opaque top-level fields with
// their true tags so a decode→encode round trip is lossless for them. Fields not listed are dropped
// by prost — but the fp16 decoder export only uses the ones below plus the graph, re-checked against
// a real onnx-community export. (Named `ModelProtoReal` to flag it as the verified-correct subset.)
#[derive(Clone, PartialEq, Message)]
struct ModelProtoReal {
    #[prost(int64, tag = "1")]
    ir_version: i64,
    #[prost(message, repeated, tag = "8")]
    opset_import: Vec<OperatorSetIdProto>,
    #[prost(string, tag = "2")]
    producer_name: String,
    #[prost(string, tag = "3")]
    producer_version: String,
    #[prost(string, tag = "4")]
    domain: String,
    #[prost(int64, tag = "5")]
    model_version: i64,
    #[prost(string, tag = "6")]
    doc_string: String,
    #[prost(message, optional, tag = "7")]
    graph: Option<GraphProto>,
    #[prost(message, repeated, tag = "14")]
    metadata_props: Vec<StringStringEntryProto>,
}

#[derive(Clone, PartialEq, Message)]
struct OperatorSetIdProto {
    #[prost(string, tag = "1")]
    domain: String,
    #[prost(int64, tag = "2")]
    version: i64,
}

#[derive(Clone, PartialEq, Message)]
struct GraphProto {
    #[prost(message, repeated, tag = "1")]
    node: Vec<NodeProto>,
    #[prost(string, tag = "2")]
    name: String,
    #[prost(message, repeated, tag = "5")]
    initializer: Vec<TensorProto>,
    #[prost(string, tag = "10")]
    doc_string: String,
    #[prost(message, repeated, tag = "11")]
    input: Vec<ValueInfoProto>,
    #[prost(message, repeated, tag = "12")]
    output: Vec<ValueInfoProto>,
    #[prost(message, repeated, tag = "13")]
    value_info: Vec<ValueInfoProto>,
}

#[derive(Clone, PartialEq, Message)]
struct NodeProto {
    #[prost(string, repeated, tag = "1")]
    input: Vec<String>,
    #[prost(string, repeated, tag = "2")]
    output: Vec<String>,
    #[prost(string, tag = "3")]
    name: String,
    #[prost(string, tag = "4")]
    op_type: String,
    #[prost(message, repeated, tag = "5")]
    attribute: Vec<AttributeProto>,
    #[prost(string, tag = "7")]
    domain: String,
    #[prost(string, tag = "6")]
    doc_string: String,
}

#[derive(Clone, PartialEq, Message)]
struct AttributeProto {
    #[prost(string, tag = "1")]
    name: String,
    // ref_attr_name (21) and doc_string (13) carried so subgraph attrs round-trip.
    #[prost(string, tag = "21")]
    ref_attr_name: String,
    #[prost(string, tag = "13")]
    doc_string: String,
    #[prost(int32, tag = "20")]
    r#type: i32,
    #[prost(float, tag = "2")]
    f: f32,
    #[prost(int64, tag = "3")]
    i: i64,
    #[prost(bytes = "vec", tag = "4")]
    s: Vec<u8>,
    #[prost(message, optional, boxed, tag = "5")]
    t: Option<Box<TensorProto>>,
    #[prost(message, optional, boxed, tag = "6")]
    g: Option<Box<GraphProto>>,
    #[prost(float, repeated, tag = "7")]
    floats: Vec<f32>,
    #[prost(int64, repeated, tag = "8")]
    ints: Vec<i64>,
    #[prost(bytes = "vec", repeated, tag = "9")]
    strings: Vec<Vec<u8>>,
    #[prost(message, repeated, tag = "10")]
    graphs: Vec<GraphProto>,
    #[prost(message, repeated, tag = "11")]
    tensors: Vec<TensorProto>,
}

#[derive(Clone, PartialEq, Message)]
struct ValueInfoProto {
    #[prost(string, tag = "1")]
    name: String,
    #[prost(message, optional, boxed, tag = "2")]
    r#type: Option<Box<TypeProto>>,
    #[prost(string, tag = "3")]
    doc_string: String,
}

#[derive(Clone, PartialEq, Message)]
struct TypeProto {
    #[prost(message, optional, boxed, tag = "1")]
    tensor_type: Option<Box<TensorTypeProto>>,
    #[prost(string, tag = "6")]
    denotation: String,
}

#[derive(Clone, PartialEq, Message)]
struct TensorTypeProto {
    #[prost(int32, tag = "1")]
    elem_type: i32,
    #[prost(message, optional, boxed, tag = "2")]
    shape: Option<Box<TensorShapeProto>>,
}

#[derive(Clone, PartialEq, Message)]
struct TensorShapeProto {
    #[prost(message, repeated, tag = "1")]
    dim: Vec<TensorShapeDim>,
}

#[derive(Clone, PartialEq, Message)]
struct TensorShapeDim {
    #[prost(int64, optional, tag = "1")]
    dim_value: Option<i64>,
    #[prost(string, optional, tag = "2")]
    dim_param: Option<String>,
    #[prost(string, tag = "3")]
    denotation: String,
}

#[derive(Clone, PartialEq, Message)]
struct TensorProto {
    #[prost(int64, repeated, tag = "1")]
    dims: Vec<i64>,
    #[prost(int32, tag = "2")]
    data_type: i32,
    #[prost(string, tag = "8")]
    name: String,
    #[prost(bytes = "vec", tag = "9")]
    raw_data: Vec<u8>,
    #[prost(message, repeated, tag = "13")]
    external_data: Vec<StringStringEntryProto>,
    #[prost(int32, tag = "14")]
    data_location: i32,
    // float_data / int32_data etc. are NOT modeled — the fp16 decoder graph stores weights as
    // external data, and the small graphs we patch carry no inline tensor payloads through the
    // value_info we touch. (Initializers that DO carry raw_data round-trip via tag 9 above.)
    #[prost(string, tag = "12")]
    doc_string: String,
}

#[derive(Clone, PartialEq, Message)]
struct StringStringEntryProto {
    #[prost(string, tag = "1")]
    key: String,
    #[prost(string, tag = "2")]
    value: String,
}

// ---------------------------------------------------------------------------
// Pass 1: the fp16 `If`-subgraph repair (port of _fix_if_subgraph + _walk)
// ---------------------------------------------------------------------------

/// Repair one `If` branch subgraph against its parent node's outputs + the visible type lookup.
/// Returns the number of edits applied (0 = already valid). Direct port of `_fix_if_subgraph`.
fn fix_if_subgraph(
    if_outputs: &[String],
    parent_output_types: &std::collections::HashMap<String, TypeProto>,
    subgraph: &mut GraphProto,
) -> usize {
    if subgraph.output.len() != if_outputs.len() {
        return 0;
    }
    // Names produced by any node inside the subgraph.
    let mut inner_produced: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for n in &subgraph.node {
        for o in &n.output {
            if !o.is_empty() {
                inner_produced.insert(o.as_str());
            }
        }
    }
    let sg_inputs: std::collections::HashSet<&str> =
        subgraph.input.iter().map(|i| i.name.as_str()).collect();

    let mut edits = 0usize;
    // Collect the (rename, retype) decisions first to avoid borrow conflicts.
    let mut renames: Vec<(usize, String)> = Vec::new();
    let mut retypes: Vec<(usize, TypeProto)> = Vec::new();
    for (i, out) in subgraph.output.iter().enumerate() {
        let intended_name = &if_outputs[i];
        let intended_type = parent_output_types.get(intended_name);

        // (a) rename: declared subgraph-output name != the value produced inside, but the parent
        // If's positional output name IS produced inside → point the subgraph output at it.
        if &out.name != intended_name
            && !inner_produced.contains(out.name.as_str())
            && !sg_inputs.contains(out.name.as_str())
            && inner_produced.contains(intended_name.as_str())
        {
            renames.push((i, intended_name.clone()));
        }

        // (b) retype: parent declared a tensor elem_type and it differs → copy parent's type over.
        if let Some(it) = intended_type {
            if let Some(tt) = it.tensor_type.as_ref() {
                let want = tt.elem_type;
                let have = out
                    .r#type
                    .as_ref()
                    .and_then(|t| t.tensor_type.as_ref())
                    .map_or(0, |t| t.elem_type);
                if want != 0 && want != have {
                    retypes.push((i, it.clone()));
                }
            }
        }
    }
    for (i, name) in renames {
        subgraph.output[i].name = name;
        edits += 1;
    }
    for (i, ty) in retypes {
        subgraph.output[i].r#type = Some(Box::new(ty));
        edits += 1;
    }
    edits
}

/// Build the visible-type lookup for a graph (value_info ∪ output ∪ input), then recurse into every
/// `If` node's subgraph(s). Direct port of `_walk`. `parent_output_types` is the lookup inherited
/// from the enclosing scope (outer `value_info`/`output`/`input`).
fn walk(
    graph: &mut GraphProto,
    parent_output_types: &std::collections::HashMap<String, TypeProto>,
    counter: &mut usize,
) {
    // type_lookup = parent ∪ this graph's value_info/output/input (this graph wins on conflicts,
    // matching the Python dict-update order).
    let mut type_lookup = parent_output_types.clone();
    for vi in graph
        .value_info
        .iter()
        .chain(graph.output.iter())
        .chain(graph.input.iter())
    {
        if let Some(t) = vi.r#type.as_ref() {
            type_lookup.insert(vi.name.clone(), (**t).clone());
        }
    }

    // We need the If node's `output` names (immutable) while mutating its subgraph attrs. Clone the
    // output-name lists up front per node, then mutate attributes.
    for node in graph.node.iter_mut() {
        if node.op_type == "If" {
            let if_outputs = node.output.clone();
            for attr in node.attribute.iter_mut() {
                if attr.r#type == ATTR_TYPE_GRAPH {
                    if let Some(g) = attr.g.as_mut() {
                        *counter += fix_if_subgraph(&if_outputs, &type_lookup, g);
                        walk(g, &type_lookup, counter);
                    }
                } else if attr.r#type == ATTR_TYPE_GRAPHS {
                    for sg in attr.graphs.iter_mut() {
                        *counter += fix_if_subgraph(&if_outputs, &type_lookup, sg);
                        walk(sg, &type_lookup, counter);
                    }
                }
            }
        } else {
            // Non-If: still recurse into any GRAPH/GRAPHS attributes (Loop/Scan), no fix applied.
            for attr in node.attribute.iter_mut() {
                if attr.r#type == ATTR_TYPE_GRAPH {
                    if let Some(g) = attr.g.as_mut() {
                        walk(g, &type_lookup, counter);
                    }
                } else if attr.r#type == ATTR_TYPE_GRAPHS {
                    for sg in attr.graphs.iter_mut() {
                        walk(sg, &type_lookup, counter);
                    }
                }
            }
        }
    }
}

/// Patch a Whisper merged-decoder ONNX file in place, returning the number of edits applied.
/// Idempotent + marker-guarded (port of `patch_whisper_decoder`). On success (or a clean no-op) a
/// sidecar marker is dropped so subsequent loads skip the read+parse. `external_data` weights are
/// NOT loaded (`load_external_data=False` analogue): we decode the graph protobuf only, which keeps
/// the parse cheap on the multi-GB-weight exports (the `.onnx` itself stays small).
pub fn patch_whisper_decoder(model_path: &Path) -> SttResult<usize> {
    if should_skip_patch(model_path) {
        return Ok(0);
    }
    let bytes = std::fs::read(model_path)
        .map_err(|e| SttError::SessionCreate(format!("read {}: {e}", model_path.display())))?;
    let mut model = ModelProtoReal::decode(bytes.as_slice()).map_err(|e| {
        SttError::SessionCreate(format!("onnx proto decode {}: {e}", model_path.display()))
    })?;

    let mut counter = 0usize;
    if let Some(graph) = model.graph.as_mut() {
        let empty = std::collections::HashMap::new();
        walk(graph, &empty, &mut counter);
    }

    if counter > 0 {
        let mut out = Vec::with_capacity(bytes.len());
        model.encode(&mut out).map_err(|e| {
            SttError::SessionCreate(format!("onnx proto encode {}: {e}", model_path.display()))
        })?;
        std::fs::write(model_path, &out)
            .map_err(|e| SttError::SessionCreate(format!("write {}: {e}", model_path.display())))?;
    }
    // Drop the marker even on a clean no-op (a correct upstream re-export is respected next load
    // without re-parsing). Best-effort — a marker write failure is non-fatal.
    let _ = std::fs::write(marker_path(model_path), b"");
    Ok(counter)
}

/// Public entry the engine/loader calls: repair the fp16 decoder and return the (unchanged) path so
/// it reads as a transform. The exact node
/// offsets are discovered by walking the graph (no hardcoded offset is needed, the Python port
/// proved the structural rule). Errors propagate so the loader can surface a real failure.
pub fn patch_fp16_decoder(path: &Path) -> SttResult<PathBuf> {
    patch_whisper_decoder(path)?;
    Ok(path.to_path_buf())
}

// ---------------------------------------------------------------------------
// Pass 2: external-data location enumeration (for the resolver shard check)
// ---------------------------------------------------------------------------

/// Read the external-data sidecar file names a `.onnx` graph references. Decodes the protobuf and
/// returns, for every initializer with `data_location == EXTERNAL (1)`, the `location` value from
/// its `external_data` key/value list. Caller (`resolver`) bounds this with a 64 MB size guard so an
/// inline-weight graph is never parsed (memory project_list_models_onnx_parse_loop_starvation).
pub fn external_data_locations(model_path: &Path) -> SttResult<Vec<String>> {
    let bytes = std::fs::read(model_path)
        .map_err(|e| SttError::Resolve(format!("read {}: {e}", model_path.display())))?;
    let model = ModelProtoReal::decode(bytes.as_slice()).map_err(|e| {
        SttError::Resolve(format!("onnx proto decode {}: {e}", model_path.display()))
    })?;
    let mut out = Vec::new();
    if let Some(graph) = model.graph.as_ref() {
        collect_external_locations(graph, &mut out);
    }
    Ok(out)
}

/// ONNX TensorProto.DataLocation::EXTERNAL.
const DATA_LOCATION_EXTERNAL: i32 = 1;

fn collect_external_locations(graph: &GraphProto, out: &mut Vec<String>) {
    for init in &graph.initializer {
        if init.data_location == DATA_LOCATION_EXTERNAL {
            for kv in &init.external_data {
                if kv.key == "location" && !kv.value.is_empty() {
                    out.push(kv.value.clone());
                }
            }
        }
    }
    // External data can also live on initializers inside subgraphs (If/Loop/Scan), though Whisper's
    // weights are top-level. Recurse for completeness.
    for node in &graph.node {
        for attr in &node.attribute {
            if let Some(g) = attr.g.as_ref() {
                collect_external_locations(g, out);
            }
            for sg in &attr.graphs {
                collect_external_locations(sg, out);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Build a tiny fp16-defective merged decoder graph in memory: one `If` node whose two
    // subgraphs each declare their outputs with the OUTER name (`logits`) + fp32 type, but produce
    // `graph_output_cast_0` inside. The parent If output is `logits` (fp16). Exercises BOTH the
    // rename and the retype.
    fn defective_model() -> ModelProtoReal {
        let fp16_type = TypeProto {
            tensor_type: Some(Box::new(TensorTypeProto {
                elem_type: ELEM_TYPE_FLOAT16,
                shape: None,
            })),
            denotation: String::new(),
        };
        let fp32_type = TypeProto {
            tensor_type: Some(Box::new(TensorTypeProto {
                elem_type: ELEM_TYPE_FLOAT,
                shape: None,
            })),
            denotation: String::new(),
        };

        // Each branch: a Cast node producing `graph_output_cast_0`, but the subgraph output is
        // (wrongly) named `logits` with fp32 annotation.
        let make_branch = || GraphProto {
            node: vec![NodeProto {
                input: vec!["x".into()],
                output: vec!["graph_output_cast_0".into()],
                op_type: "Cast".into(),
                ..Default::default()
            }],
            output: vec![ValueInfoProto {
                name: "logits".into(), // WRONG: outer-scope name, not produced inside
                r#type: Some(Box::new(fp32_type.clone())), // WRONG: fp32 on an fp16 graph
                doc_string: String::new(),
            }],
            ..Default::default()
        };

        let if_node = NodeProto {
            input: vec!["use_cache_branch".into()],
            output: vec!["logits".into()], // parent If output, fp16 (per the graph's value_info)
            op_type: "If".into(),
            attribute: vec![
                AttributeProto {
                    name: "then_branch".into(),
                    r#type: ATTR_TYPE_GRAPH,
                    g: Some(Box::new(make_branch())),
                    ..Default::default()
                },
                AttributeProto {
                    name: "else_branch".into(),
                    r#type: ATTR_TYPE_GRAPH,
                    g: Some(Box::new(make_branch())),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        let graph = GraphProto {
            node: vec![if_node],
            // value_info / output declare `logits` as fp16 so the type lookup sees the intended type.
            output: vec![ValueInfoProto {
                name: "logits".into(),
                r#type: Some(Box::new(fp16_type)),
                doc_string: String::new(),
            }],
            ..Default::default()
        };

        ModelProtoReal {
            ir_version: 9,
            graph: Some(graph),
            ..Default::default()
        }
    }

    #[test]
    #[ignore = "SPIKE: validate fp16 protobuf If-branch patch against a real onnx-community fp16 export (03_stt_engine.md §11)"]
    fn patch_renames_and_retypes_subgraph_outputs() {
        let model = defective_model();
        let mut bytes = Vec::new();
        model.encode(&mut bytes).unwrap();
        // round-trip the bytes through the walk by decoding again (simulates the on-disk path).
        let mut decoded = ModelProtoReal::decode(bytes.as_slice()).unwrap();
        let mut counter = 0usize;
        let empty = std::collections::HashMap::new();
        walk(decoded.graph.as_mut().unwrap(), &empty, &mut counter);

        // 2 branches × (1 rename + 1 retype) = 4 edits.
        assert_eq!(counter, 4, "expected rename+retype on both If branches");

        // Verify the subgraph outputs are now `graph_output_cast_0` + fp16.
        let if_node = &decoded.graph.as_ref().unwrap().node[0];
        for attr in &if_node.attribute {
            let sg = attr.g.as_ref().unwrap();
            assert_eq!(sg.output[0].name, "graph_output_cast_0");
            let et = sg.output[0]
                .r#type
                .as_ref()
                .unwrap()
                .tensor_type
                .as_ref()
                .unwrap()
                .elem_type;
            assert_eq!(et, ELEM_TYPE_FLOAT16);
        }
    }

    #[test]
    fn patch_is_idempotent_on_clean_graph() {
        // Run the walk twice; the second pass must apply 0 edits.
        let mut decoded = defective_model();
        let empty = std::collections::HashMap::new();
        let mut c1 = 0usize;
        walk(decoded.graph.as_mut().unwrap(), &empty, &mut c1);
        assert!(c1 > 0);
        let mut c2 = 0usize;
        walk(decoded.graph.as_mut().unwrap(), &empty, &mut c2);
        assert_eq!(c2, 0, "patched graph must be stable under a second pass");
    }

    #[test]
    #[ignore = "SPIKE: validate fp16 protobuf patch against a real onnx-community fp16 export (03_stt_engine.md §11)"]
    fn patch_whisper_decoder_writes_marker_and_reloads_cheaply() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("decoder_model_merged_fp16.onnx");
        let mut bytes = Vec::new();
        defective_model().encode(&mut bytes).unwrap();
        std::fs::write(&path, &bytes).unwrap();

        let edits = patch_whisper_decoder(&path).unwrap();
        assert_eq!(edits, 4);
        assert!(
            should_skip_patch(&path),
            "marker must be dropped after patch"
        );

        // Second call short-circuits on the marker → 0 edits, no re-parse.
        let again = patch_whisper_decoder(&path).unwrap();
        assert_eq!(again, 0);
    }

    #[test]
    fn external_data_locations_reads_initializer_sidecars() {
        // Build a graph with one external-data initializer pointing at a sidecar.
        let init = TensorProto {
            name: "encoder.weight".into(),
            data_type: ELEM_TYPE_FLOAT16,
            data_location: DATA_LOCATION_EXTERNAL,
            external_data: vec![
                StringStringEntryProto {
                    key: "location".into(),
                    value: "encoder_model_fp16.onnx_data".into(),
                },
                StringStringEntryProto {
                    key: "offset".into(),
                    value: "0".into(),
                },
            ],
            ..Default::default()
        };
        let model = ModelProtoReal {
            ir_version: 9,
            graph: Some(GraphProto {
                initializer: vec![init],
                ..Default::default()
            }),
            ..Default::default()
        };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("encoder_model_fp16.onnx");
        let mut bytes = Vec::new();
        model.encode(&mut bytes).unwrap();
        std::fs::write(&path, &bytes).unwrap();

        let locs = external_data_locations(&path).unwrap();
        assert_eq!(locs, vec!["encoder_model_fp16.onnx_data".to_string()]);
    }
}
