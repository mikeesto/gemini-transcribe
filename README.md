# Gemini Transcribe

A web application for transcribing audio and video files using Google's Gemini Flash model.

**Try it here:** [https://gemini-transcribe.fly.dev/](https://gemini-transcribe.fly.dev/)

## Features

- Specify the desired language of the transcript
- Automatically detects and labels different speakers in the audio (Speaker 1, Speaker 2, etc.).
- Instead of a timestamp for every word, the transcript is logically grouped into paragraphs with a single timestamp, making it much more readable.
- Click on any timestamp to jump to that specific moment in the audio or video player.
- Download the final transcript as a plain .txt file (with or without timestamps) or as a .srt subtitle file for use in video players.

## Getting started

1. Prerequisites

- Node.js (v22 or later)
- A Google AI API Key

2.  Clone & install

    ```bash
    git clone https://github.com/mikeesto/gemini-transcribe.git
    cd gemini-transcribe
    ```

    Install dependencies (using npm, pnpm, or yarn)

    ```
    npm install
    ```

3.  Environment variables

    Create a `.env` file in the root of the project and add your Google API.

    ```bash
    GOOGLE_API_KEY="YOUR_API_KEY_HERE"
    ```

4.  Run the development server

    ```bash
    npm run dev
    ```

    The application should now be running at http://localhost:5173.

## Future work

Flash is a very interesting model to explore for audio transcription because it can attempt to detect not only words but also silence, sentiment, and sounds beyond human voices.

## Copy usage metrics database from Fly.io instance

```bash
fly sftp get /data/usage.db
```
