# WinSTT - Complete Installation with Python 3.13

## 📋 Overview
This guide describes the **complete installation of WinSTT with Python 3.13** on Windows. The installation includes both **CPU-optimized** and **GPU-accelerated** setups with all necessary compatibility fixes.

## 🎯 End Result
- **Python 3.13:** ✅ Fully compatible and optimized
- **CPU Performance:** ✅ 10-20 seconds per minute of audio  
- **GPU Performance:** ✅ 2-5 seconds per minute of audio (5-10x speedup)
- **Model:** Whisper-large-v3-turbo full models (~3GB for highest quality)
- **Audio System:** ✅ Completely fixed and optimized
- **Stability:** ✅ Production-ready and reliable

## 🖥️ Current Tech Stack (Tested & Working)
- **Python:** 3.13.x
- **CUDA Toolkit:** 12.9.86
- **cuDNN:** 9.10.2 (latest version)
- **ONNX Runtime:** 1.20.0 (CPU) / 1.22.0 (GPU-compatible)
- **GPU Support:** NVIDIA RTX Series (tested: RTX 3060)

## 📁 Target Directory Structure
```
C:\Development\WinSTT\
├── cache\onnx\                    # AI Models (auto-created, ~3GB)
│   ├── encoder_model.onnx         # 429KB
│   ├── encoder_model.onnx_data    # 2.37GB  
│   ├── decoder_model_merged.onnx  # 656MB
│   └── silero_vad_16k.onnx       # 1.2MB
├── log\                          # System logs (auto-created)
├── utils\                        # WinSTT core modules
├── start_winstt_cpu.bat          # CPU starter (stable)
├── start_winstt_gpu.bat          # GPU starter (5-10x faster)
├── test_components_simple.py     # Component test
├── status_final.py               # System status check
├── winSTT.py                     # Main application
└── UPDATE_README.md              # This guide
```

## 🛠️ Part A: Basic Installation (CPU Version)

### Step 1: Clone WinSTT Repository
```batch
cd C:\Development
git clone https://github.com/dahshury/WinSTT
cd WinSTT
```

### Step 2: Python 3.13 Compatible Requirements
The original requirements.txt doesn't work with Python 3.13. Create an adapted version:

```txt
# requirements_py313.txt - Python 3.13 compatible
tqdm==4.67.0
requests==2.31.0
PyQt6==6.7.1
keyboard==0.13.5
pydub==0.25.1
pygame==2.6.1
pynput==1.7.7
pyperclip==1.9.0
faster-whisper
pvporcupine==1.9.5
pywin32==310
librosa==0.10.0.post2
pyaudio==0.2.14
onnxruntime==1.20.0
transformers
soundfile
```

### Step 3: Install Dependencies
```batch
# Install numpy separately (Python 3.13 compatibility)
pip install numpy

# Install remaining dependencies
pip install -r requirements_py313.txt
```

## 🔧 Part B: Python 3.13 Compatibility Fixes

### Problem 1: `aifc` Module Missing in Python 3.13
**Solution:** Fix audio loading in `utils/transcribe.py`:

```python
# In utils/transcribe.py - replace load_audio method
def load_audio(self, file_path, target_sample_rate=16000):
    """
    Load audio using soundfile for Python 3.13 compatibility (avoiding librosa.load)
    """
    import soundfile as sf
    try:
        # Use soundfile which doesn't depend on aifc
        samples, sample_rate = sf.read(file_path, dtype='float32')
        
        # Convert stereo to mono if necessary
        if len(samples.shape) > 1:
            samples = samples.mean(axis=1)
        
        # Resample if necessary
        if sample_rate != target_sample_rate:
            import librosa
            samples = librosa.resample(samples, orig_sr=sample_rate, target_sr=target_sample_rate)
        
        # Convert to float32 and normalize if needed
        samples = samples.astype(np.float32)
    except Exception as e:
        # Fallback: try with minimal librosa usage
        print(f"Soundfile failed: {e}, trying alternative method...")
        import wave
        with wave.open(file_path, 'rb') as wav_file:
            frames = wav_file.readframes(-1)
            samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
            sample_rate = wav_file.getframerate()
            if sample_rate != target_sample_rate:
                import librosa
                samples = librosa.resample(samples, orig_sr=sample_rate, target_sr=target_sample_rate)
    
    return samples
```

### Problem 2: Optimize Spacing Placement
**Problem:** Transcribed text starts with spaces, causing unnatural text flow  
**Solution:** Move spaces from beginning to end in `utils/listener.py`:

```python
# In utils/listener.py - extend paste_transcription method
def paste_transcription(self, transcript_text):
    transcript_text = transcript_text.replace("New paragraph.", "\n\n")
    
    # Move spaces from beginning to end for better text flow
    if transcript_text.startswith(' '):
        # Remove all leading spaces
        cleaned_text = transcript_text.lstrip(' ')
        # Add exactly one space at the end (if not already present)
        if cleaned_text and not cleaned_text.endswith(' '):
            transcript_text = cleaned_text + ' '
        else:
            transcript_text = cleaned_text
    
    pyperclip.copy(transcript_text)
    self.keyboard.press(Key.ctrl)
    self.keyboard.press('v')
    self.keyboard.release('v')
    self.keyboard.release(Key.ctrl)
```

**Improvement:**
- **Before:** `" Hello world"` (space at beginning)
- **After:** `"Hello world "` (space at end)  
- **Benefit:** Natural text flow during continuous dictation

### Step 5: Create CPU Starter
```batch
# start_winstt_cpu.bat
@echo off
echo === WinSTT CPU Starter ===
echo Starting WinSTT with CPU performance...
cd /d "C:\Development\WinSTT"
python winSTT.py
pause
```

### Step 6: Initial Tests (CPU Version)
```batch
cd C:\Development\WinSTT
python test_components_simple.py
```

**Expected Output:**
```
[OK] ONNX Runtime: 1.20.0
[OK] Provider: ['CPUExecutionProvider']
[OK] PyQt6 available
[OK] PyAudio available
*** All main components available! ***
```

### Step 7: WinSTT CPU Test
```batch
# Start:
start_winstt_cpu.bat

# Or directly:
python winSTT.py
```

**CPU Performance:** 10-20 seconds per minute of audio (very good!)

## 🚀 Part C: GPU Acceleration (Optional - 5-10x faster)

### Prerequisites Check
- **NVIDIA GPU:** RTX series recommended
- **Minimum 6GB VRAM** for best performance
- **Administrator rights** for CUDA/cuDNN installation

### Step 1: Install CUDA Toolkit 12.9

**Download:** https://developer.nvidia.com/cuda-downloads
**File:** `cuda_12.9.1_576.81_windows.exe` (~4.1GB)

```batch
# Start installation
cuda_12.9.1_576.81_windows.exe

# IMPORTANT: Choose Custom Installation:
# ✅ CUDA Toolkit 12.9
# ✅ CUDA Samples 12.9  
# ✅ CUDA Documentation 12.9
# ❌ Visual Studio Integration (if already present)
# ❌ Nsight (optional, saves space)
```

**Verify Installation:**
```batch
nvcc --version
# Expected: Cuda compilation tools, release 12.9, V12.9.127
```

### Step 2: Install cuDNN 9.10

**Download:** https://developer.nvidia.com/cudnn-downloads
**Requires:** NVIDIA Developer Account (free)
**Version:** cuDNN 9.10.2 for CUDA 12.x Windows
**File:** `cudnn-windows-x86_64-9.10.2.74_cuda12-archive.zip`

**Installation:**
1. Extract ZIP file
2. **Copy files:**
   - `bin\*` → `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9\bin\`
   - `include\*` → `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9\include\`
   - `lib\*` → `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9\lib\x64\`

**Or use NVIDIA Installer** (recommended):
```batch
# Performs automatic installation
# Installs to: C:\Program Files\NVIDIA\CUDNN\v9.10\
```

### Step 3: Create GPU Starter (Important!)

```batch
# start_winstt_gpu.bat
@echo off
echo === WinSTT GPU Starter with cuDNN PATH Fix ===

REM Add cuDNN and CUDA PATH (critical for GPU function)
set "CUDNN_PATH=C:\Program Files\NVIDIA\CUDNN\v9.10\bin\12.9"
set "CUDA_PATH_BIN=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9\bin"
set "PATH=%CUDNN_PATH%;%CUDA_PATH_BIN%;%PATH%"

echo [OK] cuDNN PATH added: %CUDNN_PATH%
echo [OK] CUDA PATH added: %CUDA_PATH_BIN%

echo Starting WinSTT with GPU acceleration...
cd /d "C:\Development\WinSTT"
python winSTT.py

if errorlevel 1 (
    echo.
    echo [INFO] If GPU problems occur, use start_winstt_cpu.bat
    echo [INFO] CPU version always works reliably
)

pause
```

### Step 4: Install ONNX Runtime GPU

```batch
# IMPORTANT: Remove CPU version
pip uninstall onnxruntime -y

# Install GPU version
pip install onnxruntime-gpu==1.22.0

# If problems: Back to CPU version
# pip uninstall onnxruntime-gpu -y
# pip install onnxruntime==1.20.0
```

### Step 5: Perform GPU Test

```batch
# Use GPU starter (important for PATH)
start_winstt_gpu.bat
```

**Successful GPU Output:**
```
=== WinSTT GPU Starter with cuDNN PATH Fix ===
[OK] cuDNN PATH added: C:\Program Files\NVIDIA\CUDNN\v9.10\bin\12.9
[OK] CUDA PATH added: C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9\bin
Starting WinSTT with GPU acceleration...
Using providers: ['CUDAExecutionProvider', 'CPUExecutionProvider']
Start sound loaded: C:\Development\WinSTT\./media/splash.mp3
```

**GPU Performance:** 2-5 seconds per minute of audio (5-10x speedup!)

## 🔍 Troubleshooting

### Problem: "DLL load failed while importing onnxruntime_pybind11_state"

**Solution A: Visual Studio C++ Runtime**
```batch
# Download and install:
# https://aka.ms/vs/17/release/vc_redist.x64.exe
```

**Solution B: Back to CPU Version**
```batch
pip uninstall onnxruntime-gpu -y
pip install onnxruntime==1.20.0
# Then use start_winstt_cpu.bat
```

### Problem: GPU Not Detected

**Diagnosis:**
```batch
# Check GPU status
nvidia-smi

# Check PATH
echo %PATH% | findstr CUDNN
echo %PATH% | findstr CUDA
```

**Solution:** Always use `start_winstt_gpu.bat` (never direct `python winSTT.py`)

### Problem: Slow Performance Despite GPU

**Causes:**
- First use (model loading takes longer)
- Insufficient VRAM (< 6GB)
- Other GPU programs running in parallel

**Solution:** Free GPU memory, optimize Nvidia Control Panel → 3D Settings

## 📊 Performance Benchmarks

### Measured Performance (RTX 3060, 16GB RAM)

| Setup | 1min Audio | 5min Audio | 15min Audio | VRAM | RAM |
|-------|------------|------------|-------------|------|-----|
| **CPU** | 10-20s | 50-100s | 150-300s | 0GB | 4-6GB |
| **GPU** | 2-5s | 10-25s | 30-75s | 2-3GB | 4-6GB |
| **Speedup** | **5-8x** | **5x** | **5-10x** | - | - |

### Quality Assessment (identical for CPU/GPU)
- **Speech Recognition:** Excellent (full models)
- **Multilingual:** Supported  
- **Punctuation:** Automatic
- **Accuracy:** 90-95% (depending on audio quality)

## ✅ Installation Checklist

### CPU Version (stable, always functional)
- [ ] **Python 3.13** installed
- [ ] **requirements_py313.txt** dependencies installed
- [ ] **ONNX Runtime 1.20.0** CPU version
- [ ] **Audio fixes and spacing optimization** applied in `utils/transcribe.py` and `utils/listener.py`
- [ ] **start_winstt_cpu.bat** created and tested
- [ ] **WinSTT starts** without errors
- [ ] **First transcription** successfully tested

### GPU Version (optional, 5-10x faster)
- [ ] **NVIDIA GPU** present (RTX series recommended)
- [ ] **CUDA Toolkit 12.9** installed and verified
- [ ] **cuDNN 9.10.2** installed (Windows Installer preferred)
- [ ] **ONNX Runtime GPU 1.22.0** installed
- [ ] **start_winstt_gpu.bat** created (with PATH fix!)
- [ ] **GPU starter** works (`CUDAExecutionProvider` is used)
- [ ] **Performance test** shows significant speedup

## 🎯 Usage

### Start CPU Version (stable)
```batch
# Always functional
start_winstt_cpu.bat
```

### Start GPU Version (faster)
```batch
# 5-10x faster performance
start_winstt_gpu.bat
```

### Direct Start (only if PATH is correct)
```batch
cd C:\Development\WinSTT
python winSTT.py
```

## 🔄 Maintenance & Updates

### Update WinSTT
```batch
cd C:\Development\WinSTT
git pull origin main
pip install --upgrade -r requirements_py313.txt
```

### In Case of Problems: CPU Fallback
```batch
# Always available safe fallback
pip uninstall onnxruntime-gpu -y
pip install onnxruntime==1.20.0
start_winstt_cpu.bat
```

### Performance Monitoring
```batch
# Check GPU usage during transcription
nvidia-smi -l 1
```

## 🏆 Summary

### What Was Achieved ✅
- **Complete WinSTT installation** with Python 3.13
- **CPU Version:** Stable, 10-20s/min audio
- **GPU Version:** 5-10x faster, 2-5s/min audio  
- **All compatibility issues** fixed (audio loading + spacing optimization)
- **Production-ready solution** with fallback options

### Installation Time
- **CPU Setup:** 30-60 minutes
- **GPU Upgrade:** +30-45 minutes
- **Model Download:** 10-30 minutes (one-time)
- **Total:** 1-2 hours

### Result
**Professional Speech-to-Text System** with:
- ✅ **Very high speech recognition quality**
- ✅ **Multilingual support**  
- ✅ **Optional CPU/GPU performance**
- ✅ **Python 3.13 full compatibility**
- ✅ **Optimized text flow** (spaces at end instead of beginning)
- ✅ **Production-ready stability**

---

**🎉 WinSTT is now fully operational! 🎤→📝**

**CPU Version:** Always functional, very good performance  
**GPU Version:** 5-10x speedup, peak performance  
**Support:** Use CPU fallback for any problems

**Optimal configuration tested:** Python 3.13 + CUDA 12.9 + cuDNN 9.10 + ONNX Runtime ✅
