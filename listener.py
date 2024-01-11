import numpy as np
import wave
import pyperclip
import torch
import threading
from utils import logger
from utils.utils import has_speech, get_model
from keyboard import KEY_DOWN, KEY_UP, hook_key, wait
from pynput.keyboard import Key, Controller
from Recorder import Recorder

# INT16_MAX_ABS_VALUE = 32768.0
MODEL_SIZES = ['tiny.en', 'tiny', 'base.en', 'base', 'small.en', 'small', 'medium.en', 'medium', 'large', 'large-v2', 'large-v3']
model_types = ['Faster-Whisper', 'Insanely-Fast-Whisper']

class AudioToTextRecorder:
    def __init__(self,
                    hook_key: str = 'right ctrl',
                    quit_key: str = 'ctrl+q',
                    model_type: str = "Faster-Whisper",
                    model_size: str = "small.en",
                    channels: int=1,
                    rate: int =16000,
                    ):
        
        self.hook_key = hook_key
        self.quit_key = quit_key
        self.cuda = torch.cuda.is_available()
        self.model_type = model_type
        if self.model_type != "Faster-Whisper":
            self.model_type = "Insanely-Fast-Whisper" if self.cuda else "Faster-Whisper"
        self.channels = channels
        self.model_size=model_size
        self.rate = rate
        self.rec = Recorder(channels=channels, rate=rate)
        self.recording = False #! Remove after activating rec events
        self.keyboard = Controller()
        self.start_recording_event = threading.Event()
        self.stop_recording_event = threading.Event()
        
        
    def capture_keys(self):
        # Set up key bindings
        hook_key(self.hook_key, self.transcribe_recording)
        wait(self.quit_key)

    def paste_transcription(self,transcript_text):
        if self.model_type == "Insanely-Fast-Whisper":
            transcript_text = transcript_text['text'].replace("New paragraph.", "\n\n")
            logger.info(transcript_text['text'])
        else:
            transcript_text = transcript_text.replace("New paragraph.", "\n\n")
            logger.info(transcript_text)
            
        transcript_text = transcript_text.strip()
        pyperclip.copy(transcript_text)
        self.keyboard.press(Key.ctrl)
        self.keyboard.press('v')
        self.keyboard.release('v')
        self.keyboard.release(Key.ctrl)
        
        
    def transcribe_recording(self, e):

        if e.event_type == KEY_DOWN and e.name == self.hook_key and not self.recording:
            self.recording = True
            logger.info("Recording started")
            try:
                self.rec.start()
                # if self.model_type == "Faster-Whisper":
                    # Splitting the data into chunks, running inference while speaking
                    # audio_array = np.frombuffer(
                    #         b''.join(self.rec._frames),
                    #         dtype=np.int8
                    #         )
                    
                    # # Normalize the array to a [-1, 1] range
                    # audio_array = audio_array.astype(np.float32) / \
                    #     INT16_MAX_ABS_VALUE
                        
                    # model = get_model(self.model_type, self.model_size)
                    # segments, info = model.transcribe('output.wav', beam_size=5)
                    # for segment in segments:
                    #     logger.info(segment.text)
                    #     self.paste_transcription(segment.text)Thank you.Thank you.Are you listening to what I am saying?Is the audio file changing?
                        
            except Exception as e:
                self.recording = False
                logger.exception("Invalid device configuration.", e)
                
                
        elif e.event_type == KEY_UP and e.name == self.hook_key and self.recording:
            self.recording = False
            self.rec.stop()
            self.rec.save("output.wav")
            logger.info("Recording stopped")
                    
            # Get length of audio data in seconds
            with wave.open("output.wav", "rb") as wav_file:
                frames = wav_file.getnframes()
                rate = wav_file.getframerate()
                length = frames / rate

                if length < 0.5:
                    logger.warning("Audio data is less than 0.5s long. Please make a longer recording.")
                    
                
                elif not has_speech("output.wav"):
                    logger.warning("No speech detected during the recording.")
                    
                    
                elif self.model_type == "Insanely-Fast-Whisper":
                    model = get_model(model_type=self.model_type, model_size=self.model_size)
                    outputs = model(
                        "output.wav",
                        chunk_length_s=30,
                        batch_size=24,
                        return_timestamps=True,
                    )
                    self.paste_transcription(outputs)
                
                else:
                    model = get_model(self.model_type, self.model_size)
                    segments, info = model.transcribe('output.wav', beam_size=5)
                    for segment in segments:
                        logger.info(segment.text)
                        self.paste_transcription(segment.text)
                        
if __name__ == "__main__":
    att = AudioToTextRecorder()
    while True:
        att.capture_keys()