// macOS (ScreenCaptureKit) system-audio loopback for Listen mode.
//
// SCK (macOS 13+) is the only supported way to capture render/system audio. We
// build an AUDIO-ONLY `SCStream`: fetch `SCShareableContent`, wrap its first
// display in an `SCContentFilter` (SCK requires a content filter even for
// audio), configure `capturesAudio = true`, install an `SCStreamOutput` delegate
// on the `.audio` output, and in `stream:didOutputSampleBuffer:ofType:` pull the
// `CMSampleBuffer` audio into f32 frames. Those frames go through the SAME
// slow-tracking AGC (int16 domain, Python parity) and the SAME 16 kHz / 30 ms
// resampler as the Windows path, then onto the manager's `sink` — an unchanged
// downstream contract.
//
// Two objc2 realities shaped this file:
//   * `getShareableContentWithCompletionHandler:` needs an ObjC block, and the
//     `block2` crate is not a direct dependency here, so we hand-roll a global
//     (non-copying) block and rendezvous its async result over a `Condvar`.
//   * The `CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer` extraction
//     touches CoreAudio types that live behind a non-direct dependency, so we
//     declare the couple of C functions and mirror the small C structs locally
//     (they resolve to the same CoreMedia/CoreFoundation symbols at link time).
//
// If macOS < 13 (SCK audio unavailable) we return `LoopbackError::Unsupported`.

#![allow(non_upper_case_globals)]

use std::ffi::{c_int, c_ulong, c_void};
use std::sync::mpsc::Sender;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{AllocAnyThread, ClassType, DefinedClass, define_class, msg_send};
use objc2_core_media::CMSampleBuffer;
use objc2_foundation::{NSArray, NSInteger, NSObject, NSObjectProtocol, NSProcessInfo};
use objc2_screen_capture_kit::{
    SCContentFilter, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamOutput,
    SCStreamOutputType, SCWindow,
};

use super::{
    DeviceInfo, LoopbackDeviceInfo, LoopbackError, SlowTrackingAgc, i16_to_f32,
    interleaved_f32_to_mono_i16,
};
use crate::audio_toolkit::audio::FrameResampler;
use crate::audio_toolkit::constants::WHISPER_SAMPLE_RATE;

/// Audio sample rate requested from SCK (its documented default). The real
/// per-buffer rate is read from the sample-buffer format and the resampler is
/// (re)built to match, so this is only a request.
const CAPTURE_RATE: u32 = 48_000;
/// Resampler frame size (matches the recorder's 30 ms emit cadence so the
/// downstream Silero VAD receives whole 30 ms / 480-sample frames).
const RESAMPLER_FRAME_MS: u64 = 30;

// ═════════════════════════════════════════════════════════════════════════════
// OS gate
// ═════════════════════════════════════════════════════════════════════════════

fn macos_at_least_13() -> bool {
    NSProcessInfo::processInfo()
        .operatingSystemVersion()
        .majorVersion
        >= 13
}

// ═════════════════════════════════════════════════════════════════════════════
// Stream-output delegate (declared with objc2's define_class!)
// ═════════════════════════════════════════════════════════════════════════════

/// Per-session capture state, mutated only inside the delegate callback (guarded
/// by a Mutex because SCK invokes the callback on its own dispatch queue).
struct CaptureState {
    /// `None` after stop(): dropping the sender closes the consumer channel.
    sink: Option<Sender<Vec<f32>>>,
    agc: SlowTrackingAgc,
    /// Built lazily once the real input rate is known; rebuilt if it changes.
    resampler: Option<FrameResampler>,
    input_rate: u32,
}

impl CaptureState {
    fn process(&mut self, mut mono: Vec<i16>, in_rate: u32) {
        if self.sink.is_none() || in_rate == 0 || mono.is_empty() {
            return;
        }
        if self.resampler.is_none() || self.input_rate != in_rate {
            match FrameResampler::try_new(
                in_rate as usize,
                WHISPER_SAMPLE_RATE as usize,
                Duration::from_millis(RESAMPLER_FRAME_MS),
            ) {
                Ok(r) => {
                    self.resampler = Some(r);
                    self.input_rate = in_rate;
                }
                Err(e) => {
                    log::error!("[loopback] resampler build failed: {e}");
                    return;
                }
            }
        }

        // AGC at the device rate, int16 domain (Python parity), then f32 + resample.
        self.agc.process(&mut mono);
        let device_f32 = i16_to_f32(&mono);
        let mut closed = false;
        {
            let sink = self.sink.as_ref().expect("sink present (checked above)");
            let resampler = self.resampler.as_mut().expect("resampler present");
            resampler.push(&device_f32, |frame: &[f32]| {
                if closed {
                    return;
                }
                if sink.send(frame.to_vec()).is_err() {
                    closed = true;
                }
            });
        }
        if closed {
            self.sink = None; // consumer gone → close the channel
        }
    }
}

struct StreamOutputIvars {
    state: Mutex<CaptureState>,
}

define_class!(
    // SAFETY:
    // - The superclass NSObject has no subclassing requirements.
    // - `StreamOutput` does not implement `Drop` (objc2 drops the ivars on dealloc).
    #[unsafe(super = NSObject)]
    #[ivars = StreamOutputIvars]
    struct StreamOutput;

    // SAFETY: `NSObjectProtocol` has no safety requirements.
    unsafe impl NSObjectProtocol for StreamOutput {}

    // SAFETY: the selector + argument types match `SCStreamOutput`.
    unsafe impl SCStreamOutput for StreamOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn stream_did_output(
            &self,
            _stream: &SCStream,
            sample_buffer: &CMSampleBuffer,
            of_type: SCStreamOutputType,
        ) {
            if of_type.0 != SCStreamOutputType::Audio.0 {
                return;
            }
            // SAFETY: `sample_buffer` is a valid audio CMSampleBuffer from SCK.
            let extracted = unsafe { extract_mono_i16(sample_buffer) };
            if let Some((mono, in_rate)) = extracted {
                let mut state = self.ivars().state.lock().unwrap_or_else(|e| e.into_inner());
                state.process(mono, in_rate);
            }
        }
    }
);

impl StreamOutput {
    fn new(sink: Sender<Vec<f32>>) -> Retained<Self> {
        let ivars = StreamOutputIvars {
            state: Mutex::new(CaptureState {
                sink: Some(sink),
                agc: SlowTrackingAgc::new(),
                resampler: None,
                input_rate: 0,
            }),
        };
        let this = Self::alloc().set_ivars(ivars);
        // SAFETY: NSObject's `init` signature is correct.
        unsafe { msg_send![super(this), init] }
    }

    /// Drop the sink so the consumer channel closes even if SCK still holds a
    /// reference to this delegate after stop.
    fn close(&self) {
        let mut state = self.ivars().state.lock().unwrap_or_else(|e| e.into_inner());
        state.sink = None;
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Session
// ═════════════════════════════════════════════════════════════════════════════

pub(super) struct MacosSession {
    stream: Retained<SCStream>,
    output: Retained<StreamOutput>,
    _queue: DispatchRetained<DispatchQueue>,
}

// SAFETY: `SCStream` and GCD queues are internally thread-safe, and the
// delegate's mutable state is behind a Mutex. The session is created on one
// thread and torn down (stopCapture + release) on possibly another, which SCK
// supports; nothing here is thread-affine.
unsafe impl Send for MacosSession {}

impl MacosSession {
    pub(super) fn stop(self) {
        // SAFETY: valid stream/output; nil completion handlers are allowed.
        unsafe {
            let out = ProtocolObject::from_ref(&*self.output);
            let _ = self
                .stream
                .removeStreamOutput_type_error(out, SCStreamOutputType::Audio);
            self.stream.stopCaptureWithCompletionHandler(None);
        }
        // Close the channel promptly regardless of SCK's release timing.
        self.output.close();
        // Retained fields are released here.
    }
}

pub(super) fn start(
    _device_id: Option<String>,
    sink: Sender<Vec<f32>>,
) -> Result<(DeviceInfo, MacosSession), LoopbackError> {
    if !macos_at_least_13() {
        return Err(LoopbackError::Unsupported);
    }

    // 1. Shareable content (async completion handler; we block briefly for it).
    let content = fetch_shareable_content(Duration::from_secs(10))?;
    // SAFETY: `displays` is a valid accessor on shareable content.
    let display = unsafe { content.displays() }.firstObject().ok_or_else(|| {
        LoopbackError::Backend("no shareable display for ScreenCaptureKit".to_string())
    })?;

    // 2. Content filter (audio-only still needs one) + audio configuration.
    let excluded: Retained<NSArray<SCWindow>> = NSArray::new();
    // SAFETY: valid display + (empty) window array.
    let filter = unsafe {
        SCContentFilter::initWithDisplay_excludingWindows(
            SCContentFilter::alloc(),
            &display,
            &excluded,
        )
    };

    // SAFETY: all setters are plain property writes on a fresh configuration.
    let config = unsafe {
        let c = SCStreamConfiguration::new();
        c.setCapturesAudio(true);
        c.setSampleRate(CAPTURE_RATE as NSInteger);
        c.setChannelCount(1);
        c.setExcludesCurrentProcessAudio(true);
        // SCK requires non-zero video dimensions even for audio-only capture.
        c.setWidth(2);
        c.setHeight(2);
        c
    };

    // 3. Delegate + serial callback queue.
    let output = StreamOutput::new(sink);
    let queue = DispatchQueue::new("com.winstt.loopback.audio", None);

    // 4. Stream: install the audio output and start.
    // SAFETY: valid filter/config; None delegate is allowed.
    let stream = unsafe {
        SCStream::initWithFilter_configuration_delegate(SCStream::alloc(), &filter, &config, None)
    };
    // SAFETY: valid stream, output conforms to SCStreamOutput, valid queue.
    unsafe {
        stream
            .addStreamOutput_type_sampleHandlerQueue_error(
                ProtocolObject::from_ref(&*output),
                SCStreamOutputType::Audio,
                Some(&*queue),
            )
            .map_err(|e| LoopbackError::Backend(format!("addStreamOutput(audio): {e:?}")))?;
        stream.startCaptureWithCompletionHandler(None);
    }

    let info = DeviceInfo {
        id: "system-audio".to_string(),
        name: "System Audio".to_string(),
        sample_rate: CAPTURE_RATE,
        channels: 1,
    };
    Ok((
        info,
        MacosSession {
            stream,
            output,
            _queue: queue,
        },
    ))
}

pub(super) fn list_devices() -> Result<Vec<LoopbackDeviceInfo>, LoopbackError> {
    if !macos_at_least_13() {
        return Ok(Vec::new());
    }
    // System audio is captured globally via SCK, not per output device.
    Ok(vec![LoopbackDeviceInfo {
        id: "system-audio".to_string(),
        name: "System Audio".to_string(),
        is_default: true,
    }])
}

// ═════════════════════════════════════════════════════════════════════════════
// SCShareableContent async rendezvous (hand-rolled global ObjC block)
// ═════════════════════════════════════════════════════════════════════════════

struct ShareableSlot {
    ready: bool,
    /// A +1-retained `*mut SCShareableContent` as usize, or 0 for none/error.
    content: usize,
}

static SHAREABLE: Mutex<ShareableSlot> = Mutex::new(ShareableSlot {
    ready: false,
    content: 0,
});
static SHAREABLE_CV: Condvar = Condvar::new();

#[repr(C)]
struct BlockDescriptor {
    reserved: c_ulong,
    size: c_ulong,
}

#[repr(C)]
struct ShareableBlock {
    isa: *const c_void,
    flags: c_int,
    reserved: c_int,
    invoke: unsafe extern "C-unwind" fn(*mut ShareableBlock, *mut SCShareableContent, *mut c_void),
    descriptor: *const BlockDescriptor,
}

// `_NSConcreteGlobalBlock` is the isa for statically-allocated (never-copied,
// never-freed) blocks; provided by libSystem.
unsafe extern "C" {
    static _NSConcreteGlobalBlock: c_void;
}

/// BLOCK_IS_GLOBAL: tells `Block_copy`/`Block_release` this block is static
/// (no-op copy/release), so our leaked heap allocation stays valid.
const BLOCK_IS_GLOBAL: c_int = 1 << 28;

static SHAREABLE_DESCRIPTOR: BlockDescriptor = BlockDescriptor {
    reserved: 0,
    size: core::mem::size_of::<ShareableBlock>() as c_ulong,
};

unsafe extern "C-unwind" fn shareable_invoke(
    _block: *mut ShareableBlock,
    content: *mut SCShareableContent,
    _error: *mut c_void,
) {
    // Retain so the object survives past this callback / its autorelease pool.
    // SAFETY: `content` is a valid (or null) SCShareableContent from SCK.
    let stored = unsafe { Retained::retain(content) }.map_or(0, |r| Retained::into_raw(r) as usize);
    let mut slot = SHAREABLE.lock().unwrap_or_else(|e| e.into_inner());
    if slot.content != 0 {
        // Drop stale content from a previous (timed-out) fetch.
        // SAFETY: `slot.content` was produced by a prior `Retained::into_raw`.
        drop(unsafe { Retained::from_raw(slot.content as *mut SCShareableContent) });
    }
    slot.content = stored;
    slot.ready = true;
    SHAREABLE_CV.notify_all();
}

fn fetch_shareable_content(
    timeout: Duration,
) -> Result<Retained<SCShareableContent>, LoopbackError> {
    // Reset the rendezvous slot.
    {
        let mut slot = SHAREABLE.lock().unwrap_or_else(|e| e.into_inner());
        if slot.content != 0 {
            // SAFETY: prior `Retained::into_raw` pointer.
            drop(unsafe { Retained::from_raw(slot.content as *mut SCShareableContent) });
            slot.content = 0;
        }
        slot.ready = false;
    }

    // Build a global (non-copying) block on the heap and leak it: libclosure never
    // frees global blocks, and the completion handler runs asynchronously, so the
    // block must outlive this call. The small per-start leak is bounded.
    let block = Box::new(ShareableBlock {
        // Taking the address of the libSystem symbol (no read) — `&raw const`
        // of an extern static needs no `unsafe`.
        isa: &raw const _NSConcreteGlobalBlock,
        flags: BLOCK_IS_GLOBAL,
        reserved: 0,
        invoke: shareable_invoke,
        descriptor: &raw const SHAREABLE_DESCRIPTOR,
    });
    let block_ptr = Box::into_raw(block);

    // SAFETY: class method taking a block; a block encodes as an object pointer.
    unsafe {
        let cls = SCShareableContent::class();
        let _: () = msg_send![
            cls,
            getShareableContentWithCompletionHandler: block_ptr.cast::<AnyObject>()
        ];
    }

    // Wait (bounded) for the callback.
    let mut slot = SHAREABLE.lock().unwrap_or_else(|e| e.into_inner());
    let deadline = Instant::now() + timeout;
    while !slot.ready {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        let (guard, _res) = SHAREABLE_CV
            .wait_timeout(slot, deadline - now)
            .unwrap_or_else(|e| e.into_inner());
        slot = guard;
    }

    if !slot.ready {
        return Err(LoopbackError::Backend(
            "timed out waiting for ScreenCaptureKit shareable content (screen-recording \
             permission may be required)"
                .to_string(),
        ));
    }
    let ptr = slot.content;
    slot.content = 0;
    slot.ready = false;
    drop(slot);

    if ptr == 0 {
        return Err(LoopbackError::Backend(
            "ScreenCaptureKit returned no shareable content".to_string(),
        ));
    }
    // SAFETY: `ptr` is a +1-retained SCShareableContent from `shareable_invoke`.
    Ok(
        unsafe { Retained::from_raw(ptr as *mut SCShareableContent) }
            .expect("non-null retained content"),
    )
}

// ═════════════════════════════════════════════════════════════════════════════
// CMSampleBuffer audio extraction (self-declared CoreMedia/CoreFoundation FFI)
// ═════════════════════════════════════════════════════════════════════════════

#[repr(C)]
#[derive(Clone, Copy)]
struct AudioStreamBasicDescription {
    sample_rate: f64,
    format_id: u32,
    format_flags: u32,
    bytes_per_packet: u32,
    frames_per_packet: u32,
    bytes_per_frame: u32,
    channels_per_frame: u32,
    bits_per_channel: u32,
    reserved: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct AudioBufferC {
    number_channels: u32,
    data_byte_size: u32,
    data: *mut c_void,
}

/// Upper bound on planar buffers we accept (channels for non-interleaved audio).
const MAX_AUDIO_BUFFERS: usize = 16;

/// `AudioBufferList` with inline capacity for up to `MAX_AUDIO_BUFFERS` buffers.
#[repr(C)]
struct AudioBufferListC {
    number_buffers: u32,
    buffers: [AudioBufferC; MAX_AUDIO_BUFFERS],
}

/// kAudioFormatFlagIsFloat
const K_AUDIO_FORMAT_FLAG_IS_FLOAT: u32 = 1 << 0;
/// kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment
const CM_ASSURE_16BYTE_ALIGNMENT: u32 = 1 << 0;

#[allow(non_snake_case)]
unsafe extern "C-unwind" {
    fn CMSampleBufferGetFormatDescription(sbuf: *const c_void) -> *const c_void;
    fn CMAudioFormatDescriptionGetStreamBasicDescription(
        desc: *const c_void,
    ) -> *const AudioStreamBasicDescription;
    fn CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sbuf: *const c_void,
        buffer_list_size_needed_out: *mut usize,
        buffer_list_out: *mut c_void,
        buffer_list_size: usize,
        block_buffer_structure_allocator: *const c_void,
        block_buffer_block_allocator: *const c_void,
        flags: u32,
        block_buffer_out: *mut *mut c_void,
    ) -> i32;
    fn CFRelease(cf: *const c_void);
}

/// Pull a `CMSampleBuffer`'s audio into mono i16, returning `(samples, in_rate)`.
/// Handles interleaved (1 buffer, N channels) and planar (N buffers) float PCM.
///
/// # Safety
/// `sample_buffer` must be a valid audio `CMSampleBuffer`.
unsafe fn extract_mono_i16(sample_buffer: &CMSampleBuffer) -> Option<(Vec<i16>, u32)> {
    let sbuf = (sample_buffer as *const CMSampleBuffer).cast::<c_void>();

    // SAFETY: valid sample buffer; the returned format description is +0 (owned by
    // the sample buffer) so we must not release it.
    let fmt = unsafe { CMSampleBufferGetFormatDescription(sbuf) };
    if fmt.is_null() {
        return None;
    }
    // SAFETY: `fmt` is a valid audio format description.
    let asbd_ptr = unsafe { CMAudioFormatDescriptionGetStreamBasicDescription(fmt) };
    if asbd_ptr.is_null() {
        return None;
    }
    // SAFETY: non-null ASBD pointer valid for the lifetime of `fmt`.
    let asbd = unsafe { *asbd_ptr };
    let in_rate = asbd.sample_rate.round() as u32;
    let is_float = asbd.format_flags & K_AUDIO_FORMAT_FLAG_IS_FLOAT != 0;
    // SCK delivers 32-bit float LPCM; bail on anything else rather than mis-decode.
    if in_rate == 0 || !is_float || asbd.bits_per_channel != 32 {
        return None;
    }

    let mut list = AudioBufferListC {
        number_buffers: MAX_AUDIO_BUFFERS as u32,
        buffers: [AudioBufferC {
            number_channels: 0,
            data_byte_size: 0,
            data: core::ptr::null_mut(),
        }; MAX_AUDIO_BUFFERS],
    };
    let mut size_needed: usize = 0;
    let mut block_buffer: *mut c_void = core::ptr::null_mut();
    // SAFETY: `list` has room for MAX_AUDIO_BUFFERS; we pass its true byte size.
    let status = unsafe {
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sbuf,
            &mut size_needed,
            (&mut list as *mut AudioBufferListC).cast::<c_void>(),
            core::mem::size_of::<AudioBufferListC>(),
            core::ptr::null(),
            core::ptr::null(),
            CM_ASSURE_16BYTE_ALIGNMENT,
            &mut block_buffer,
        )
    };
    if status != 0 {
        if !block_buffer.is_null() {
            // SAFETY: a retained block buffer may still be returned on error.
            unsafe { CFRelease(block_buffer) };
        }
        return None;
    }

    let nbuf = (list.number_buffers as usize).min(MAX_AUDIO_BUFFERS);
    // Copy the PCM into an owned buffer BEFORE releasing the block buffer (the
    // sample pointers reference the block buffer's memory).
    let mono = if nbuf == 0 {
        None
    } else if nbuf == 1 {
        // Interleaved (or truly mono): one buffer of `number_channels` channels.
        let b = list.buffers[0];
        let ch = b.number_channels.max(1) as usize;
        let n = (b.data_byte_size as usize) / core::mem::size_of::<f32>();
        if b.data.is_null() || n == 0 {
            None
        } else {
            // SAFETY: `n` float samples valid until CFRelease below.
            let samples = unsafe { core::slice::from_raw_parts(b.data.cast::<f32>(), n) };
            Some(interleaved_f32_to_mono_i16(samples, ch))
        }
    } else {
        // Non-interleaved / planar: one buffer per channel; average per frame.
        let frames = (list.buffers[0].data_byte_size as usize) / core::mem::size_of::<f32>();
        let mut planes: Vec<&[f32]> = Vec::with_capacity(nbuf);
        for i in 0..nbuf {
            let b = list.buffers[i];
            let n = (b.data_byte_size as usize) / core::mem::size_of::<f32>();
            if b.data.is_null() {
                planes.push(&[]);
            } else {
                // SAFETY: `n` float samples valid until CFRelease below.
                planes.push(unsafe { core::slice::from_raw_parts(b.data.cast::<f32>(), n) });
            }
        }
        let mut out = Vec::with_capacity(frames);
        for f in 0..frames {
            let mut sum = 0.0f32;
            let mut cnt = 0u32;
            for p in &planes {
                if let Some(&s) = p.get(f) {
                    sum += s;
                    cnt += 1;
                }
            }
            let mono_s = if cnt > 0 { sum / cnt as f32 } else { 0.0 };
            out.push((mono_s * 32768.0).clamp(-32768.0, 32767.0) as i16);
        }
        Some(out)
    };

    if !block_buffer.is_null() {
        // SAFETY: balance the retained block buffer from the extraction call.
        unsafe { CFRelease(block_buffer) };
    }
    mono.map(|m| (m, in_rate))
}
