import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import torch
import os
import keyboard
import threading
from utils.utils import get_model
from listener import AudioToTextRecorder
from ttkbootstrap import Style

class TTSApp:
    def __init__(self):
        self.root = tk.Tk()
        self.root.geometry("310x350")
        self.listener = AudioToTextRecorder()
        self.root.title("winTTS")
        # self.root.resizable(False, False)
        
        # Set ttkbootstrap dark theme
        self.style = Style(theme="darkly")

        # Set logo
        self.script_dir = os.path.dirname(os.path.abspath(__file__))
        icon_path = os.path.join(self.script_dir, "icon.png")
        img = tk.PhotoImage(file=icon_path)
        self.root.wm_iconphoto(self.root, img)
        
        self.label1 = ttk.Label(self.root, text="WinTTS", style="h1.TLabel", font=("Arial", 16))
        self.label1.pack(padx=10, pady=10)
        
        # Columns
        self.left_frame = ttk.Frame(self.root, height=330)
        self.left_frame.pack(side=tk.LEFT, ipady=200)

        self.right_frame = ttk.Frame(self.root,height=330)
        self.right_frame.pack(side=tk.RIGHT, ipady=200)
        
        # Record key section
        self.record_key_label = ttk.Label(self.left_frame, text="Current Key (Hold):", style="info.TLabel")
        self.record_key_label.pack(padx=10, pady=3)

        self.record_key_entry = ttk.Entry(self.left_frame, width=10, style="info.TEntry")
        self.record_key_entry.insert(0, "right ctrl")  # Default value
        self.record_key_entry.configure(state='readonly')
        self.record_key_entry.pack(padx=10)

        self.record_key_toggle = False
        
        self.record_key_button = ttk.Button(self.right_frame, text="Record Key", command=self.toggle_and_set, style="success.TButton")
        self.record_key_button.pack(pady=25, padx=20)

        # Enable/disable/select starting sound
        self.check1_state = tk.IntVar(value=1)
        self.check1 = ttk.Checkbutton(self.left_frame,
                                    text="Enable recording\nstarting sound",
                                    variable=self.check1_state,
                                    command=self.sound_status,
                                    onvalue=1,
                                    offvalue=0,
                                    style="primary.TCheckbutton")
        self.check1.pack(pady=50, padx=5)
        
        self.select_sound_btn = ttk.Button(self.right_frame, text="Browse", width=10, command=self.get_sound, style="info.TButton")
        self.select_sound_btn.pack(pady=25, padx=20)
        
        # GPU availability
        self.gpu_txt = ttk.Label(self.left_frame, text="GPU availability status:", font=("Arial", 10), style="info.TLabel")
        self.gpu_txt.pack(padx=15, pady=5)
        
        # Load image for GPU status
        self.icon_path2 = os.path.join(self.script_dir, "gpu_icon1.png")
        self.icon_path3 = os.path.join(self.script_dir, "gpu_icon2.png")

        # Resize the image to fit within your desired dimensions
        # Load original image
        self.gpu_img = tk.PhotoImage(file=self.icon_path3)
        self.check_gpu()
        # self.gpu_img2 = tk.PhotoImage(file=resized_img2)
        self.gpu_img_label = ttk.Label(self.right_frame, image=self.gpu_img)
        self.gpu_img_label.pack(pady=20, padx=20)
        
        self.selected_size = tk.StringVar(self.right_frame)
        self.selected_size.set("small")
        
        self.option_menu = tk.OptionMenu(self.right_frame, self.selected_size, *self.listener.model_sizes, command=self.select_model_size)
        
        self.option_menu.pack(padx=20, pady=15)
        
        self.select_size_txt = ttk.Label(self.left_frame, text="Select model size:", font=("Arial", 10), style="info.TLabel")
        self.select_size_txt.pack(padx=15, pady=40)
        
        self.load_txt = ttk.Label(self.root, text="", font=("Arial", 8), style="info.TLabel")
        self.load_txt.place(x=50, y=330)
        
        self.currently_hooked = None
        
        self.root.mainloop()
        
    def sound_status(self):
        if self.check1_state.get() == 1:
            self.listener.start_sound = os.path.join(self.script_dir, "splash.mp3")
        else:
            self.listener.start_sound = ""
        return
            
    def toggle_and_set(self):
        if not self.record_key_toggle:
            self.record_key_toggle = True
            self.currently_hooked = keyboard.hook(self.record_strokes)
            self.record_key_button.configure(text="Stop")
        else:
            self.record_key_toggle = False
            self.currently_hooked = None
            self.record_key_button.configure(text="Record Key")
            new_key = self.record_key_entry.get()
            self.listener.set_record_key(new_key)
    
    def record_strokes(self, event):
        if event.event_type == keyboard.KEY_DOWN and self.record_key_toggle:
            self.record_key_entry.configure(state='normal')
            self.record_key_entry.delete(0, tk.END)
            self.record_key_entry.insert(0, event.name)
            self.record_key_entry.configure(state='readonly')
    
    def get_sound(self):
        file_path = filedialog.askopenfilename(title="Select Sound File", filetypes=[("Sound files", "*.wav;*.mp3")])
        if file_path:
            self.listener.start_sound = file_path
    
    def check_gpu(self):
        if torch.cuda.is_available():
            self.gpu_img = tk.PhotoImage(file=self.icon_path2)
        else:
            self.gpu_img = tk.PhotoImage(file=self.icon_path3)
            
    def start_capture(self):
        while True:
            self.listener.capture_keys()
            
    def select_model_type(self):
        if torch.cuda.is_available():
            return self.listener.model_types
        else:
            return ["Faster-Whisper (CPU)"]
        
    def load_model(self, model_size):
        self.listener.model = get_model(self.listener.model_type, model_size)
        self.option_menu.configure(state='normal')
        self.load_txt.configure(text="")
        
    def select_model_size(self, model_size):
        self.load_txt.configure(text="Downloading & Loading model, please wait...")
        self.listener.model_size = self.selected_size.get()
        self.option_menu.configure(state='disabled')
        self.load_model_thread = threading.Thread(target=self.load_model, args=(self.listener.model_size,))
        self.load_model_thread.start()

        
if __name__ == "__main__":
    app = TTSApp()
    app.start_capture()
