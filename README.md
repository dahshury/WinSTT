# <img src="./media/Windows 1 Theta.ico" alt="Alt text" width="30"> WinSTT

![Alt text](</media/untitled.png>)

An application for desktop STT using [OpenAI-Whisper](https://github.com/openai/whisper)

Type in any application using your voice. WinSTT is an application that leverages the power of OpenAI's Whisper STT model for efficient voice typing functionality. This desktop tool allows users to transcribe speech into text, with support for over 99 languages and the capability to run locally without the need for an internet connection.

<!-- You can download the CPU version from [WinSTT v0.1 CPU](https://drive.google.com/file/d/1u20s9QokghYoQ3sNN6HsaEljVuM9Oo6f/view?usp=drive_link) -->

## Why

Existing Windows speech to text is slow, not accurate, and not intuitive. This app provides customizable hotkey activation, and fast and accurate transcription for rapid typing. This is especially useful to those who write articles, blogs, and even conversations.

## Python Version Setup

### Install Dependencies

- First, clone the repo:

    ```bash
    git clone https://github.com/dahshury/WinSTT
    ```

- Navigate to the cloned directory:

    ```bash
    cd WinSTT
    ```

- Initialize the environment and install the requirements:

    <details>
    <summary>CPU VERSION</summary>

    ```bash
    conda env create -f env.yaml
    ```

    </details>

    <details>
    <summary>GPU VERSION</summary>

    ```bash
    conda env create -f env-gpu.yaml
    ```

    </details>

    <details>
    <summary>Linux users only: additional setup for PyAudio</summary>

    For Linux, you need to install `PortAudio`, which PyAudio depends on. Use the following commands to install PortAudio on common Linux distributions:

    - **Debian/Ubuntu**:
        ```bash
        sudo apt update
        sudo apt install portaudio19-dev libxcb1 libxcb-cursor0 libxcb-keysyms1 libxcb-render0 libxcb-shape0 libxcb-shm0 libxcb-xfixes0 libxcb-icccm4 libxcb-image0 libxcb-sync1 libxcb-xinerama0 libxcb-randr0 libxcb-util1 libx11-xcb1 libxrender1 libxkbcommon-x11-0
        ```

    </details>

- Activate the environment:

    ```bash
    conda activate WinSTT
    ```

### Start The App

- Start the GUI by running the bash command:

```
python winSTT.py
```

- alternatively, you can use the python script listener.py, which contains the default functionality:

```
python -m utils.listener
```

## Usage

Hold the right control key to start recording, release it to stop. There can be a very slight (0.2s) delay between the start of the pressing and the start of the app listening to the audio from your microphone. You should only start speaking after hearing the audio cue.

Releasing the key will transcribe the audio you recorded, paste it wherever your typing pointer is in any application.

The app contains a "record key" button, which allows you to change the recording key that you have to hold to start recording. Press record key, and then press and hold the buttons you wish to start the recording with, then click stop to change the recording key.

- This tool is powered by Hugging Face's ASR models, primarily Whisper by OpenAI. The larger the model, the better the accuracy and the slower the speed. Try the model that best suits your hardware and needs.

## Notes

<!-- - The .EXE versions of the program can be detected as viruses. This is [common](https://medium.com/@markhank/how-to-stop-your-python-programs-being-seen-as-malware-bfd7eb407a7) as this program is compiled using Pyinstaller. You  can check the [CPU version Virustotal](https://www.virustotal.com/gui/file/dd6483c19dd3abc2ffa0508da80d9e514806413895b347655bfc45e49d45e681?nocache=1) to confirm this isn't malicious. You can also alternatively use the python .py version to avoid this problem. -->
- Upon loading the app for the first time, Please wait for the model files to be downloaded, (about 1 GB for CPU version, 3 GB for GPU version) this will depend on your internet connection. After the model is downloaded, no internet connection needed unless you change the model.
- The app will automatically detect if audio is present in the speech. If not, or if an error occurs, it will output a message inside the app and inside the logs folder.
- The application only records while the record key is held down.
- You can use this app using a CPU, it will run Whisper-Turbo quantized by default. However, if you have a CUDA GPU, the app will run the full version and this will increase the speed and the accuracy and is highly recommended.
- The application does not transcribe audio that is less than 0.5 second long. If your sentence is short, consider not letting go of the button until 0.5s has passed.
<!-- - The app contains no viruses. It was compiled using Pyinstaller. -->

## Acknowledgments

- [Silero's Voice Activity Detection (VAD)](https://github.com/snakers4/silero-vad) is implemented to prevent hallucinations on silence start, and prevent empty file processing.
