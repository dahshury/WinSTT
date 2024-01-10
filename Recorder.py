import pyaudio
import wave
import subprocess
import os
import time
import threading


class Recorder():
    #Defines sound properties like frequency and channels
    def __init__(self, chunk=1024, channels=2, rate=44100):
        self.CHUNK = chunk
        self.FORMAT = pyaudio.paInt16
        self.CHANNELS = channels
        self.RATE = rate
        self._running = True
        self._frames = []

    #Start recording sound
    def start(self):
        threading._start_new_thread(self.__recording, ())

    def __recording(self):
        #Set running to True and reset previously recorded frames
        self._running = True
        self._frames = []
        #Create pyaudio instance
        p = pyaudio.PyAudio()
        #Open stream
        stream = p.open(format=self.FORMAT,
                        channels=self.CHANNELS,
                        rate=self.RATE,
                        input=True,
                        frames_per_buffer=self.CHUNK)
        
        # To stop the streaming, new thread has to set self._running to false
        # append frames array while recording
        while(self._running):
            data = stream.read(self.CHUNK)
            self._frames.append(data)

        # Interrupted, stop stream and close it. Terinate pyaudio process.
        stream.stop_stream()
        stream.close()
        p.terminate()

    # Sets boolean to false. New thread needed.
    def stop(self):
        self._running = False

    #Save file to filename location as a wavefront file.
    def save(self, filename):
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
        print("Saved")

    # Delete a file
    @staticmethod
    def delete(filename):
        os.remove(filename)

    # Convert wav to mp3 with same name using ffmpeg.exe
    @staticmethod
    def wavTomp3(wav):
        mp3 = wav[:-3] + "mp3"
        # Remove file if existent
        if os.path.isfile(mp3):
            Recorder.delete(mp3)
        # Call CMD command
        subprocess.call('ffmpeg -i "'+wav+'" "'+mp3+'"')


if __name__ == "__main__":
    rec = Recorder()
    print("Start recording")
    rec.start()
    time.sleep(5)
    print("Stop recording")
    rec.stop()
    print("Saving")
    rec.save("test.wav")
    print("Converting wav to mp3")
    Recorder.wavTomp3("test.wav")
    print("deleting wav")
    Recorder.delete("test.wav")