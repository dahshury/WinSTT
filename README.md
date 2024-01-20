# WinSTT

![Alt text](<untitled.png>)

An application for desktop STT using [Insanely-Fast-Whisper](https://github.com/Vaibhavs10/insanely-fast-whisper) and [Faster-whisper](https://github.com/SYSTRAN/faster-whisper)

WinSTT is an application that leverages the power of OpenAI's Whisper STT model for efficient  voice typing functionality. This desktop tool allows users to transcribe speech into text in any application. With support for over 99 languages and the capability to run locally without the need for an internet connection.

<!-- You can download the CUDA 11.8 version from [WinSTT GPU](https://drive.google.com/file/d/1WG0pXaPl9BKXYLbGdh6Wb4UcwKa_vS0A/view?usp=sharing) (Must have the torch CUDA from below)

or you can download the CPU version from [WinSTT](https://drive.google.com/file/d/1I09x-8JnrZQ140ZHOAawxZEwS6HyPE3s/view?usp=sharing) -->

## Why

Existing Windows speech to text is slow, not accurate, and not intuitive. I think this app provides customizable hotkey activation, and fast and accurate transcription for rapid typing. This is especially useful to those who write articles, blogs, and even conversations.

## Python Version Setup

### Install Dependencies

- First, clone the repo:

```
git clone https://github.com/dahshury/Whisper-Typer.git
```

- Navigate to the cloned directory:

```
cd Whisper-Typer
```

initialize the environment using conda:

```
conda env create -f env.yml
```

install the requirements:

```
pip install -r requirements.txt
```

- For CUDA inference (If you have a CUDA GPU), run the following commands in your bash terminal (optional, highly recommended, must have for GPU version):

```
pip3 install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
```

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
