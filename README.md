# Whisper-Typer

An application for desktop STT using [Insanely-Fast-Whisper](https://github.com/Vaibhavs10/insanely-fast-whisper)

This allows you to type in any desktop application using your voice in over 99 languages, with very high speed and accuracy.
The app runs locally, so there is no need for an internet connection.

## Setup

### Install Dependencies

- First, clone the repo:

```
git clone https://github.com/dahshury/Whisper-Typer.git
```

- Navigate to the cloned directory:

```
cd Whisper-Typer
```

install the requirements:

```
pip install -r requirements.txt
```

- For CUDA inference, run the following commands in your bash terminal (optional):

```
pip3 install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
```

### Start The App

- Start the app by running the bash command:

```
python listener.py
```

### Usage

After starting the app, wait until "Ready." is displayed in the terminal. Upon first usage, the application might take a while to download the required files.

Hold the right control key to start recording, release it to stop. There can be a very slight (0.2ms) delay between the start of the pressing and the start of the app listening to the audio from your microphone. You should only start speaking after hearing the audio cue, or seeing the "Ready." printed in the terminal.

Releasing the key will transcribe the audio you recorded, paste it wherever your typing pointer is.

### Notes

- The application only records while the record key is held down.
- The application does not transcribe audio that is less than 1 second long.

## Acknowledgments

- This tool is powered by Hugging Face's ASR models, primarily Whisper by OpenAI.
- [Silero's Voice Activity Detection (VAD)](https://github.com/snakers4/silero-vad) is implemented to prevent hallucinations on silence start.
- Optimizations are developed by [Vaibhavs10/insanely-fast-whisper](https://github.com/Vaibhavs10/insanely-fast-whisper)