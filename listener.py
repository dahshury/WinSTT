import os
import threading
import torch
import time
import pyperclip
from logger import setup_logger
from utils.utils import has_speech, get_model
from keyboard import KEY_DOWN, KEY_UP, hook_key, wait, unhook_all
from pynput.keyboard import Key, Controller
from Recorder import Recorder
import pygame
import subprocess

class AudioToTextRecorder:
    def __init__(self,
                    callback_fn,
                    rec_key: str = 'right ctrl',
                    model_type: str = "",
                    model_size: str = "small",
                    channels: int=1,
                    rate: int =16000,
                    start_sound: str = "splash.mp3",
                    ):
        self.rec_key = rec_key
        self.cuda = torch.cuda.is_available()
        self.model_type = model_type
        if self.model_type == "":
            self.model_type = "Insanely-Fast-Whisper" if self.cuda else "Faster-Whisper"
        self.channels = channels
        self.model_size = model_size
        self.rate = rate
        self.start_sound = os.path.join(os.path.dirname(os.path.abspath(__file__)), start_sound)
        self.rec = Recorder(channels=channels, rate=rate)
        self.min_duration = 0.5
        self.recording = False
        self.keyboard = Controller()
        self.logger = setup_logger()
        self.sound_play_lock = threading.Lock()
        pygame.mixer.init()
        self.last_playback_time = 0
        self.last_press_time = 0
        self.set_key_toggle = False
        self.stream_status = ""
        self.stream_flag = False
        self.callback_fn = callback_fn
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = subprocess.SW_HIDE
        self.scriptdir = os.path.dirname(os.path.abspath(__file__))
        hook_key(self.rec_key, self.transcribe_recording)
        
    def initialize_model(self):
        self.model = get_model(self.model_type, self.model_size)
    
    def set_record_key(self, new_key):
        unhook_all()
        self.rec_key = new_key
        self.set_key_toggle = True
        hook_key(self.rec_key, self.transcribe_recording)
    
    def play_sound(self, sound_file):
        try:
            with self.sound_play_lock:
                # Check if the last playback is finished
                if not pygame.mixer.music.get_busy():
                    if os.path.exists(sound_file):
                        pygame.mixer.music.load(sound_file)
                        pygame.mixer.music.play()
                    else:
                        self.logger.debug(f"Starting sound {self.start_sound} is not found")
                        raise
                    
        except Exception as e:
            self.logger.debug(f"Error playing starting sound: {self.start_sound}, {e}")
            raise

    def play_sound_thread(self, sound_file):
        threading.Thread(target=self.play_sound, args=(sound_file,)).start()

    def capture_keys(self):
        hook_key(self.rec_key, self.transcribe_recording)
        
    def paste_transcription(self, transcript_text):
        if self.model_type == "Insanely-Fast-Whisper":
            transcript_text = transcript_text['text'].replace("New paragraph.", "\n\n")
        else:
            transcript_text = transcript_text.replace("New paragraph.", "\n\n")

        transcript_text = transcript_text.strip()
        pyperclip.copy(transcript_text)
        self.keyboard.press(Key.ctrl)
        self.keyboard.press('v')
        self.keyboard.release('v')
        self.keyboard.release(Key.ctrl)
        self.stream_flag = True
        self.capture_keys()

    def transcribe_recording(self, e):
        if e.event_type == KEY_DOWN and e.name == self.rec_key and not self.recording:
            self.recording = True
            self.last_playback_time = time.time()
            self.logger.debug("Recording started")
            try:
                self.rec.start()
            except Exception as e:
                self.logger.exception(f"Can't start recording due to an error.", e)
                self.stream_status = f"{e}"
                self.callback_fn(self.stream_status)
            # Start playing the sound in a separate thread
            if self.start_sound != "":
                self.play_sound_thread(self.start_sound)
        elif e.event_type == KEY_UP and e.name == self.rec_key and self.recording:
            self.recording = False
            current_time = time.time()
            self.rec.stop()
            time_since_last_press = current_time - self.last_playback_time
            self.last_press_time = time_since_last_press
            if time_since_last_press >= self.min_duration:
                wav_path = os.path.join(self.scriptdir ,"output.wav")
                self.rec.save(wav_path)
                self.logger.debug("Recording stopped")
                if os.path.getsize(wav_path) > 1024:
                    
                    if not has_speech(wav_path):
                        self.logger.warning("No speech detected during the recording.")
                        self.stream_status = "No speech detected during the recording."
                        self.callback_fn(self.stream_status)

                    elif self.model_type == "Insanely-Fast-Whisper":
                        outputs = self.model(
                            os.path.join(wav_path),
                            chunk_length_s=30,
                            batch_size=24,
                            return_timestamps=True,
                        )
                        self.paste_transcription(outputs)

                    else:
                        # Faster-Whisper inference
                        segments, info = self.model.transcribe(wav_path, beam_size=5)
                        for segment in segments:
                            self.logger.debug(segment.text)
                            self.paste_transcription(segment.text)
                            
                else:
                    self.stream_status = f"Invalid device configuratgion.\n Check log   for details"
                    self.callback_fn(self.stream_status)
            else:
                self.logger.warning(f"Audio duration is less than {self.min_duration}s long. Please make a longer recording.")
                self.stream_status = f"Audio duration is less than {self.min_duration}s long.\n Please make a longer recording."
                self.callback_fn(self.stream_status)
        # hook_key(self.rec_key, self.transcribe_recording)   
        # wait(self.rec_key)
if __name__ == "__main__":
    att = AudioToTextRecorder(print)
    att.initialize_model()
    while True:
        att.capture_keys()