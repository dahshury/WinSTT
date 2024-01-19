import pyaudio
import wave
import subprocess
import os
import threading
from logger import setup_logger

logger = setup_logger()

class Recorder():
    def __init__(self, chunk=1024, channels=2, rate=44100):
        self.CHUNK = chunk
        self.FORMAT = pyaudio.paInt16
        self.CHANNELS = channels
        self.RATE = rate
        self._running = threading.Event()
        self._frames = []
        self.data = None
        self.p = pyaudio.PyAudio()
        self.stream = None

    def start(self, error_callback=None):
        self.error_callback = error_callback
        try:
            self._running.set()
            threading.Thread(target=self.__recording).start()
        except Exception as e:
            raise e

    def __recording(self):
        self._frames = []

        try:
            self.stream = self.p.open(format=self.FORMAT,
                            channels=self.CHANNELS,
                            rate=self.RATE,
                            input=True,
                            frames_per_buffer=self.CHUNK)

            while self._running.is_set():
                self.data = self.stream.read(self.CHUNK)
                self._frames.append(self.data)
            self.stream.stop_stream()
            self.stream.close()
            self.p.terminate()
        
        except Exception as e:
            if hasattr(self, 'error_callback') and callable(self.error_callback):
                self.error_callback(e)
            raise e

    def stop(self):
        self._running.clear()
        self.p = pyaudio.PyAudio()

    def save(self, filename):
        wf = wave.open(filename, 'wb')
        wf.setnchannels(self.CHANNELS)
        wf.setsampwidth(self.p.get_sample_size(self.FORMAT))
        wf.setframerate(self.RATE)
        wf.writeframes(b''.join(self._frames))
        wf.close()
        logger.debug("Saved")

    @staticmethod
    def delete(filename):
        os.remove(filename)

    @staticmethod
    def wavTomp3(wav):
        mp3 = wav[:-3] + "mp3"
        if os.path.isfile(mp3):
            Recorder.delete(mp3)
        subprocess.call('ffmpeg -i "'+wav+'" "'+mp3+'"')
