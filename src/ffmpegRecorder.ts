import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import ffmpeg from '@ffmpeg-installer/ffmpeg';

let ffmpegProcess: ChildProcessWithoutNullStreams | null = null;
let outputPath: string = '';
let recordingStartTime: number | null = null;  // Used to record recording start time

// Start recording: Use FFmpeg to record and save as .webm file
export function startFFmpegRecording() {
    if (ffmpegProcess) {
        vscode.window.showWarningMessage('Recording is already in progress.');
        return;
    }

    outputPath = path.join(__dirname, 'recorded_audio.ogg'); // Use .ogg format, more suitable for speech recognition
    if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
    }

    const platform = process.platform;
    let inputArgs: string[] = [];

    if (platform === 'darwin') {
        inputArgs = ['-f', 'avfoundation', '-i', ':0'];
    } else if (platform === 'win32') {
        inputArgs = ['-f', 'dshow', '-i', 'audio=Microphone'];
    } else if (platform === 'linux') {
        inputArgs = ['-f', 'alsa', '-i', 'default'];
    } else {
        vscode.window.showErrorMessage('Unsupported platform for FFmpeg recording.');
        return;
    }

    const ffmpegArgs = [
        ...inputArgs,
        '-ar', '16000',         // Set sampling rate to 16kHz (Azure recommended)
        '-ac', '1',             // Mono channel (more stable than stereo)
        '-c:a', 'libopus',
        '-b:a', '64k',
        '-vbr', 'on',
        '-f', 'ogg',   // Output format as OGG (more suitable for speech recognition)
        outputPath
    ];

    // Use bundled FFmpeg instead of system FFmpeg
    ffmpegProcess = spawn(ffmpeg.path, ffmpegArgs);

    recordingStartTime = Date.now();  // Mark start time

    ffmpegProcess.stderr.on('data', data => {
        console.log('[FFmpeg]', data.toString());
    });

    ffmpegProcess.on('error', err => {
        vscode.window.showErrorMessage(`FFmpeg failed: ${err.message}`);
    });

    vscode.window.showInformationMessage('🎙️ Recording started...');
}

// Stop recording and return audio file path
export function stopFFmpegRecording(): Promise<string> {
    return new Promise((resolve, reject) => {
        if (!ffmpegProcess || !recordingStartTime) {
            reject(new Error('No recording is currently running.'));
            return;
        }

        const duration = Date.now() - recordingStartTime;
        const delay = Math.max(1000 - duration, 0);

        setTimeout(() => {
            ffmpegProcess!.on('close', code => {
                ffmpegProcess = null;
                recordingStartTime = null;

                if (fs.existsSync(outputPath)) {
                    vscode.window.showInformationMessage('✅ Recording finished.');
                    resolve(outputPath);
                } else {
                    reject(new Error(`Recording file not found after FFmpeg exit, code: ${code}`));
                }
            });

            ffmpegProcess!.kill('SIGINT');
        }, delay);
    });
}
