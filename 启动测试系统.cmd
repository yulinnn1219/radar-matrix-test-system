@echo off
chcp 65001 >nul
title 矩阵智测 - 本地测试服务
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 pause
