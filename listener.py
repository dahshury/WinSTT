import joblib
from keyboard import KEY_DOWN, KEY_UP, hook_key, wait
from pynput.keyboard import Key, Controller
from Recorder import Recorder
import wave
import time
import pyaudio
import pyperclip
import os
import torch
from transformers import pipeline
from transformers.utils import is_flash_attn_2_available

# Directory to store cached data
CACHE_DIR = "cache"

# Ensure the cache directory exists
os.makedirs(CACHE_DIR, exist_ok=True)

# pipe = pipeline(
#         "automatic-speech-recognition",
#         model="openai/whisper-large-v3",
#         torch_dtype=torch.float16,
#         device="cuda:0" if torch.cuda.is_available() else "cpu",
#         model_kwargs={"attn_implementation": "flash_attention_2"} if is_flash_attn_2_available() else {"attn_implementation": "sdpa"},
#     )
    
# Try loading the pipeline from cache
print("Loading...")
pipe_cache_file = os.path.join(CACHE_DIR, "pipeline_cache.joblib")

if os.path.exists(pipe_cache_file):
    pipe = joblib.load(pipe_cache_file)
    
else:
    # If not in cache, create the pipeline and save to cache
    pipe = pipeline(
        "automatic-speech-recognition",
        model="openai/whisper-large-v3",
        torch_dtype=torch.float16,
        device="cuda:0" if torch.cuda.is_available() else "cpu",
        model_kwargs={"attn_implementation": "flash_attention_2"} if is_flash_attn_2_available() else {"attn_implementation": "sdpa"},
    )
    joblib.dump(pipe, pipe_cache_file)


# Adjust channels based on your audio input setup
rec = Recorder(channels=1)
recording = False
keyboard = Controller()
print("Ready.")

def paste_transcription(transcript_text):
    print(transcript_text['text'])
    transcript_text = transcript_text['text'].replace("New paragraph.", "\n\n")
    transcript_text = transcript_text.strip()
    
    pyperclip.copy(transcript_text)
    keyboard.press(Key.ctrl)
    keyboard.press('v')
    keyboard.release('v')
    keyboard.release(Key.ctrl)

def transcribe_recording(e):
    global recording

    if e.event_type == KEY_DOWN and e.name == 'right ctrl' and not recording:
            recording = True
            print("Recording started")
            try:    
                rec.start()
                # time.sleep(2)
            except Exception as e:
                recording = False
                print("Invalid device configuration.", e)
                time.sleep(1)  # Brief pause before rebinding
                hook_key('right ctrl', transcribe_recording)  # Rebind for retry
            

    elif e.event_type == KEY_UP and e.name == 'right ctrl' and recording:
        recording = False
        rec.stop()
        rec.save("output.wav")
        print("Recording stopped")
        
        # Get length of audio data in seconds
        with wave.open("output.wav", "rb") as wav_file:
            frames = wav_file.getnframes()
            rate = wav_file.getframerate()
            length = frames / rate
            
            if length < 0.2:
                print("Audio data is less than 0.2s long. Please make a longer recording.")
                time.sleep(2)  # Brief pause before rebinding
                hook_key('right ctrl', transcribe_recording)  # Rebind for retry
                
            else:
                outputs = pipe(
                    "output.wav",
                    chunk_length_s=30,
                    batch_size=24,
                    return_timestamps=True,
                )
                
                paste_transcription(outputs)
                time.sleep(2)
        
# Set up key bindings
hook_key('right ctrl', transcribe_recording)

# Keep the program running until Ctrl+Q is pressed
wait('ctrl+q')