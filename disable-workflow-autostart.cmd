@echo off
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\manage-workflow-service.ps1" -Mode Disable
pause
