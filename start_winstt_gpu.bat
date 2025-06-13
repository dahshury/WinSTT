@echo off
echo === WinSTT GPU Starter mit cuDNN PATH Fix ===
echo.

REM cuDNN PATH hinzufuegen
set "CUDNN_PATH=C:\Program Files\NVIDIA\CUDNN\v9.10\bin\12.9"
set "CUDA_PATH_BIN=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9\bin"
set "PATH=%CUDNN_PATH%;%CUDA_PATH_BIN%;%PATH%"

echo [OK] cuDNN PATH hinzugefuegt: %CUDNN_PATH%
echo [OK] CUDA PATH hinzugefuegt: %CUDA_PATH_BIN%
echo.

echo Starte WinSTT mit GPU-Beschleunigung...
cd /d "C:\Development\WinSTT"
python winSTT.py

echo.
echo WinSTT beendet.
pause
