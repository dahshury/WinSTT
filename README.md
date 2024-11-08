# <img src="./media/Windows 1 Theta.ico" alt="Alt text" width="30"> WinSTT

![Alt text](</media/untitled.png>)

An application for desktop STT using [Insanely-Fast-Whisper](https://github.com/Vaibhavs10/insanely-fast-whisper) and [Faster-whisper](https://github.com/SYSTRAN/faster-whisper)

WinSTT is an application that leverages the power of OpenAI's Whisper STT model for efficient voice typing functionality. This desktop tool allows users to transcribe speech into text in any application, with support for over 99 languages and the capability to run locally without the need for an internet connection.

<!-- You can download the CUDA 11.8 version from [WinSTT GPU](https://drive.google.com/file/d/1WG0pXaPl9BKXYLbGdh6Wb4UcwKa_vS0A/view?usp=sharing) (Must have the torch CUDA from below) -->

You can download the CPU version from [WinSTT v0.1 CPU](https://drive.google.com/file/d/1u20s9QokghYoQ3sNN6HsaEljVuM9Oo6f/view?usp=drive_link)

## Why

Existing Windows speech to text is slow, not accurate, and not intuitive. I think this app provides customizable hotkey activation, and fast and accurate transcription for rapid typing. This is especially useful to those who write articles, blogs, and even conversations.

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

- Initialize the environment using conda:

    ```bash
    conda env create -f env.yaml
    ```

- Activate the environment:

    ```bash
    conda activate WinSTT
    ```

- Install the requirements:

    <details>
    <summary>CPU VERSION</summary>

    ```bash
    pip install -r requirements.txt torch torchvision torchaudio
    ```

    </details>

    <details>
    <summary>GPU VERSION</summary>

    ```bash
    pip install -r requirements.txt 
    pip install torch==2.5.1+cu124 torchvision==0.20.1+cu124 torchaudio==2.5.1+cu124 --index-url https://download.pytorch.org/whl/cu124
    ```

    </details>

    <details>
    <summary>Linux users only: additional setup for PyAudio</summary>

    For Linux, you need to install `PortAudio`, which PyAudio depends on. Use the following commands to install PortAudio on common Linux distributions:

    - **Debian/Ubuntu**:
        ```bash
        sudo apt update
        sudo apt install 
        sudo apt install portaudio19-dev libxcb1 libxcb-cursor0 libxcb-keysyms1 libxcb-render0 libxcb-shape0 libxcb-shm0 libxcb-xfixes0 libxcb-icccm4 libxcb-image0 libxcb-sync1 libxcb-xinerama0 libxcb-randr0 libxcb-util1 libx11-xcb1 libxrender1 libxkbcommon-x11-0
        ```

    After installing PortAudio, retry installing the requirements:
        
    ```bash
    pip install -r requirements.txt
    ```

    </details>

### Start The App

- Start the python script by running the bash command:

```
python winSTT.py
```

- alternatively, you can use the python script listener.py, which contains the default functionality:

```
python listener.py
```

## Usage

After starting the app, wait until "Ready." is displayed in the terminal.

Hold the right control key to start recording, release it to stop. There can be a very slight (0.2ms) delay between the start of the pressing and the start of the app listening to the audio from your microphone. You should only start speaking after hearing the audio cue, or seeing the "Ready." printed in the terminal.

Releasing the key will transcribe the audio you recorded, paste it wherever your typing pointer is.

The app contains a "record key" button, which allows you to change the recording key that you have to hold to start recording. Press record key, and then press the button you wish to start the recording with, then click stop to change the recording key.

- This tool is powered by Hugging Face's ASR models, primarily Whisper by OpenAI. Whisper checkpoints come in five configurations of varying model sizes. The smallest four are trained on either English-only or multilingual data. The large checkpoints are multilingual only. The larger the model, the better the accuracy and the slower the speed. Try the model that best suits your hardware and needs.

## Notes

- The .EXE versions of the program can be detected as viruses. This is [common](https://medium.com/@markhank/how-to-stop-your-python-programs-being-seen-as-malware-bfd7eb407a7) as this program is compiled using Pyinstaller. You  can check the [CPU version Virustotal](https://www.virustotal.com/gui/file/dd6483c19dd3abc2ffa0508da80d9e514806413895b347655bfc45e49d45e681?nocache=1) to confirm this isn't malicious. You can also alternatively use the python .py version to avoid this problem.
- Upon loading the app for the first time, Please wait for the model files to be downloaded, (about 1 GB) this will depend on your internet connection. After the model is downloaded, no internet connection needed unless you change the model.
- The app will automatically detect if audio is present in the speech. If not, or if an error occurs, it will output a message inside the app.
- The application only records while the record key is held down.
- You can use this app using a CPU, it will run Faster-whisper small.en by default. However, if you have a CUDA GPU, this will increase the speed and the accuracy and is highly recommended.
- The application does not transcribe audio that is less than 0.5 second long.
- Currently, supporting only a single hotkey, not a combination of keys.
- Mashing the record key fast in sequence might crash the application.
- Currently, the progress bar is not really measuring the progress. It's there to indicate that the app is loading/downloading files.
<!-- - The app contains no viruses. It was compiled using Pyinstaller. -->

## Acknowledgments

- [Silero's Voice Activity Detection (VAD)](https://github.com/snakers4/silero-vad) is implemented to prevent hallucinations on silence start, and prevent empty file processing.
- Optimizations are developed by [Vaibhavs10/insanely-fast-whisper](https://github.com/Vaibhavs10/insanely-fast-whisper) and [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper).
