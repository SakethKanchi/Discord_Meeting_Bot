#!/usr/bin/env python3
"""
Audio Transcription Script using OpenAI Whisper
Transcribes audio files using the local Whisper model
Supports both WAV and MP3 files
"""

import sys
import os
import argparse
import whisper
import tempfile
import subprocess

def convert_mp3_to_wav(mp3_path, wav_path):
    """
    Convert MP3 file to WAV format using ffmpeg
    
    Args:
        mp3_path (str): Path to input MP3 file
        wav_path (str): Path to output WAV file
        
    Returns:
        bool: True if conversion successful, False otherwise
    """
    try:
        # Try to find ffmpeg in different locations
        ffmpeg_paths = [
            'ffmpeg',  # System PATH
            os.path.join(os.getcwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),  # Local ffmpeg-static
            os.path.join(os.getcwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg'),  # Linux/Mac version
        ]
        
        ffmpeg_cmd = None
        for path in ffmpeg_paths:
            if path == 'ffmpeg':
                # Try system ffmpeg first
                try:
                    subprocess.run(['ffmpeg', '-version'], capture_output=True, check=True)
                    ffmpeg_cmd = path
                    break
                except (subprocess.CalledProcessError, FileNotFoundError):
                    continue
            elif os.path.exists(path):
                ffmpeg_cmd = path
                break
        
        if not ffmpeg_cmd:
            print("Error: ffmpeg not found in system PATH or node_modules", file=sys.stderr)
            return False
        
        # Use ffmpeg to convert MP3 to WAV
        cmd = [
            ffmpeg_cmd, '-y',  # -y to overwrite output file
            '-i', mp3_path,
            '-ac', '1',        # Mono channel
            '-ar', '16000',    # 16kHz sample rate
            '-sample_fmt', 's16', # 16-bit samples
            wav_path
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if result.returncode == 0:
            print(f"Successfully converted {mp3_path} to {wav_path}", file=sys.stderr)
            return True
        else:
            print(f"FFmpeg error: {result.stderr}", file=sys.stderr)
            return False
            
    except FileNotFoundError:
        print("Error: ffmpeg not found. Please install ffmpeg.", file=sys.stderr)
        return False
    except Exception as e:
        print(f"Error during MP3 to WAV conversion: {str(e)}", file=sys.stderr)
        return False

def transcribe_audio(audio_file_path, model_size="base"):
    """
    Transcribe an audio file using Whisper model
    
    Args:
        audio_file_path (str): Path to the audio file to transcribe
        model_size (str): Whisper model size (tiny, base, small, medium, large)
        
    Returns:
        str: Transcribed text
    """
    
    # Check if audio file exists
    if not os.path.exists(audio_file_path):
        print(f"Error: Audio file '{audio_file_path}' does not exist", file=sys.stderr)
        return ""
    
    # Determine if we need to convert MP3 to WAV
    temp_wav_path = None
    wav_path = audio_file_path
    
    if audio_file_path.lower().endswith('.mp3'):
        # Create temporary WAV file
        temp_wav_path = tempfile.mktemp(suffix='.wav')
        if not convert_mp3_to_wav(audio_file_path, temp_wav_path):
            return ""
        wav_path = temp_wav_path
    
    try:
        # Load the Whisper model
        print(f"Loading Whisper model '{model_size}'...", file=sys.stderr)
        model = whisper.load_model(model_size)
        
        print(f"Transcribing audio file: {audio_file_path}", file=sys.stderr)
        
        # Transcribe the audio
        result = model.transcribe(wav_path)
        
        # Clean up temporary file
        if temp_wav_path and os.path.exists(temp_wav_path):
            os.unlink(temp_wav_path)
        
        # Extract the transcribed text
        transcript = result["text"].strip()
        
        if transcript:
            print(f"Transcription completed successfully", file=sys.stderr)
            return transcript
        else:
            print("Warning: No speech detected in audio file", file=sys.stderr)
            return ""
            
    except Exception as e:
        print(f"Error during transcription: {str(e)}", file=sys.stderr)
        # Clean up temporary file on error
        if temp_wav_path and os.path.exists(temp_wav_path):
            try:
                os.unlink(temp_wav_path)
            except:
                pass
        return ""

def transcribe_multiple_files(file_pattern=None, model_size="base"):
    """
    Transcribe multiple audio files and save results to text files
    
    Args:
        file_pattern (str): Pattern to match files (e.g., "*.mp3")
        model_size (str): Whisper model size
    """
    import glob
    
    if file_pattern:
        files = glob.glob(file_pattern)
    else:
        # Default to all MP3 files in current directory
        files = glob.glob("*.mp3")
    
    if not files:
        print("No audio files found to transcribe", file=sys.stderr)
        return
    
    print(f"Found {len(files)} audio files to transcribe", file=sys.stderr)
    
    for audio_file in files:
        print(f"\nProcessing: {audio_file}", file=sys.stderr)
        
        # Generate output filename
        base_name = os.path.splitext(audio_file)[0]
        output_file = f"{base_name}_transcript.txt"
        
        # Transcribe the audio
        transcript = transcribe_audio(audio_file, model_size)
        
        if transcript:
            # Save transcript to file
            with open(output_file, 'w', encoding='utf-8') as f:
                f.write(transcript)
            print(f"Transcript saved to: {output_file}", file=sys.stderr)
        else:
            print(f"No transcript generated for {audio_file}", file=sys.stderr)

def main():
    """Main function to handle command line arguments"""
    parser = argparse.ArgumentParser(description='Transcribe audio using Whisper')
    parser.add_argument('audio_file', nargs='?', help='Path to audio file to transcribe')
    parser.add_argument('--batch', action='store_true', help='Transcribe all MP3 files in current directory')
    parser.add_argument('--pattern', help='File pattern for batch processing (e.g., "*.mp3")')
    parser.add_argument('--model', default='base', choices=['tiny', 'base', 'small', 'medium', 'large'], 
                       help='Whisper model size (default: base)')
    
    args = parser.parse_args()
    
    if args.batch:
        # Batch process files
        transcribe_multiple_files(args.pattern, args.model)
    elif args.audio_file:
        # Transcribe single file
        transcript = transcribe_audio(args.audio_file, args.model)
        print(transcript)
    else:
        # Default: transcribe all MP3 files
        transcribe_multiple_files(model_size=args.model)

if __name__ == "__main__":
    main()