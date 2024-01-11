import pyaudio
import wave
import subprocess
import os
import time
import threading


class Recorder():
    def __init__(self, chunk=1024, channels=2, rate=44100):
        self.CHUNK = chunk
        self.FORMAT = pyaudio.paInt16
        self.CHANNELS = channels
        self.RATE = rate
        self._running = threading.Event()
        self._frames = []
        self.data = None
        self.verbose = False

    def start(self):
        self._running.set()
        threading.Thread(target=self.__recording).start()

    def __recording(self):
        self._frames = []
        p = pyaudio.PyAudio()
        try:
            stream = p.open(format=self.FORMAT,
                            channels=self.CHANNELS,
                            rate=self.RATE,
                            input=True,
                            frames_per_buffer=self.CHUNK)
        except Exception as e:
            raise OSError("Invalid configuration", e)
        
        while self._running.is_set():
            self.data = stream.read(self.CHUNK)
            self._frames.append(self.data)

        stream.stop_stream()
        stream.close()
        p.terminate()

    def stop(self):
        self._running.clear()

    def save(self, filename):
        if self.verbose:
            print("Saving")
        p = pyaudio.PyAudio()
        if not filename.endswith(".wav"):
            filename = filename + ".wav"
        wf = wave.open(filename, 'wb')
        wf.setnchannels(self.CHANNELS)
        wf.setsampwidth(p.get_sample_size(self.FORMAT))
        wf.setframerate(self.RATE)
        wf.writeframes(b''.join(self._frames))
        wf.close()
        if self.verbose:
            print("Saved")

    @staticmethod
    def delete(filename):
        os.remove(filename)

    @staticmethod
    def wavTomp3(wav):
        mp3 = wav[:-3] + "mp3"
        if os.path.isfile(mp3):
            Recorder.delete(mp3)
        subprocess.call('ffmpeg -i "'+wav+'" "'+mp3+'"')


if __name__ == "__main__":
    rec = Recorder()
    print("Start recording")
    rec.start()
    
    # Allow some time for recording (adjust as needed)
    time.sleep(5)
    
    print("Stop recording")
    rec.stop()
    
    # Wait for the recording thread to finish
    rec_thread = threading.Thread(target=rec.start)
    rec_thread.join()

    print("Saving")
    rec.save("test.wav")
    print("Converting wav to mp3")
    Recorder.wavTomp3("test.wav")
    print("Deleting wav")
    Recorder.delete("test.wav")