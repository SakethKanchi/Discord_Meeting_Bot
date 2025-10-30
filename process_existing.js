// Standalone processor for existing PCM files
// Usage: node process_existing.js

require('dotenv').config();

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');

const { summarizeTranscript, saveSummaryLocally } = require('./processor.js');

const PCM_FOLDER = './PCM_Files';
const SUMMARY_FOLDER = './Summary';

function convertPcmToWav(pcmPath, wavPath) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn(ffmpegPath, [
            '-y',
            '-f', 's16le',
            '-ar', '16000',
            '-ac', '1',
            '-i', pcmPath,
            '-ac', '1',
            '-ar', '16000',
            '-sample_fmt', 's16',
            wavPath
        ]);
        let err = '';
        ffmpeg.stderr.on('data', d => err += d.toString());
        ffmpeg.on('close', code => code === 0 ? resolve(wavPath) : reject(new Error(`FFmpeg pcm→wav failed (${code}): ${err}`)));
        ffmpeg.on('error', reject);
    });
}

async function mixSegmentChronologically(segmentKey, segmentFiles) {
    console.log(`\n🔄 Processing segment ${segmentKey} (${segmentFiles.length} PCM)`);

    // Parse chronological order
    const fileData = segmentFiles.map(file => {
        const parts = file.split('_');
        const timestamp = parseInt(parts.pop().replace('.pcm', ''));
        const username = parts[parts.length - 1];
        return { file, timestamp, username };
    }).sort((a, b) => a.timestamp - b.timestamp);

    // Convert successfully to wav
    const converted = [];
    for (let i = 0; i < fileData.length; i++) {
        const { file, username, timestamp } = fileData[i];
        const pcmPath = path.join(PCM_FOLDER, file);
        const wavPath = path.join(PCM_FOLDER, `temp_${segmentKey}_${i}.wav`);
        try {
            const stats = fs.statSync(pcmPath);
            if (stats.size === 0) { console.log(`⚠️ Skipping empty: ${file}`); continue; }
            await convertPcmToWav(pcmPath, wavPath);
            converted.push({ wavPath, username, timestamp, originalPcm: file });
            console.log(`✅ Converted ${file}`);
        } catch (e) {
            console.error(`❌ Convert failed for ${file}: ${e.message}`);
        }
    }

    if (converted.length === 0) {
        console.log('⚠️ No valid inputs for this segment');
        return null;
    }

    const startTime = converted[0].timestamp;
    const offsets = converted.map(x => (x.timestamp - startTime) / 1000);
    console.log(`📊 Offsets: ${offsets.map((o, i) => `${converted[i].username}:+${o.toFixed(2)}s`).join(', ')}`);

    const segmentWav = path.join(PCM_FOLDER, `${segmentKey}_processed.wav`);
    const filterFile = path.join(PCM_FOLDER, `${segmentKey}_filter.txt`);

    // Build filter script
    let content = '';
    for (let i = 0; i < converted.length; i++) {
        const ms = Math.round(offsets[i] * 1000);
        if (ms === 0) content += `[${i}:a]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono[a${i}];`;
        else content += `[${i}:a]adelay=${ms},aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono[a${i}];`;
    }
    const delayedInputs = converted.map((_, i) => `[a${i}]`).join('');
    content += `${delayedInputs}amix=inputs=${converted.length}:duration=longest[out]`;
    fs.writeFileSync(filterFile, content);

    // Run ffmpeg
    const ffArgs = ['-y'];
    converted.forEach(({ wavPath }) => { ffArgs.push('-i', wavPath); });
    ffArgs.push('-filter_complex_script', filterFile, '-map', '[out]', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', segmentWav);

    await new Promise((resolve, reject) => {
        const ff = spawn(ffmpegPath, ffArgs);
        let err = '';
        ff.stderr.on('data', d => err += d.toString());
        ff.on('close', code => {
            // Cleanup temps
            for (const c of converted) { try { fs.unlinkSync(c.wavPath); } catch { } }
            try { fs.unlinkSync(filterFile); } catch { }
            if (code === 0) {
                // Keep original PCM files for now (no deletion)
                console.log(`✅ Segment created: ${path.basename(segmentWav)}`);
                resolve();
            } else {
                console.error(`❌ Segment mix failed (${code}): ${err}`);
                reject(new Error('segment mix failed'));
            }
        });
        ff.on('error', reject);
    });

    return segmentWav;
}

function transcribeAudio(audioFilePath) {
    return new Promise((resolve, reject) => {
        console.log(`🔄 Transcribing with Whisper: ${audioFilePath}`);
        const py = spawn('python', ['transcribe.py', audioFilePath]);
        let out = '', err = '';
        py.stdout.on('data', d => out += d.toString());
        py.stderr.on('data', d => err += d.toString());
        py.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(`Transcription failed (${code}): ${err}`)));
        py.on('error', reject);
    });
}

async function main() {
    if (!fs.existsSync(PCM_FOLDER)) {
        console.log('ℹ️ PCM_Files does not exist. Nothing to process.');
        return;
    }

    const allPcm = fs.readdirSync(PCM_FOLDER).filter(f => f.endsWith('.pcm'));
    if (allPcm.length === 0) { console.log('ℹ️ No PCM files found.'); return; }

    // Group by segment key and meeting key
    const segmentKeyToFiles = new Map();
    const meetingKeyToFiles = new Map();
    for (const file of allPcm) {
        const base = file.replace(/\.pcm$/i, '');
        const parts = base.split('_');
        const segIdx = parts.findIndex(p => p === 'segment');
        if (segIdx === -1 || segIdx + 1 >= parts.length) { console.warn(`⚠️ Skip unrecognized ${file}`); continue; }
        const segmentKey = parts.slice(0, segIdx + 2).join('_');
        const meetingKey = parts.slice(0, segIdx).join('_');
        if (!segmentKeyToFiles.has(segmentKey)) segmentKeyToFiles.set(segmentKey, []);
        segmentKeyToFiles.get(segmentKey).push(file);
        if (!meetingKeyToFiles.has(meetingKey)) meetingKeyToFiles.set(meetingKey, []);
        meetingKeyToFiles.get(meetingKey).push(file);
    }

    console.log(`🧩 Segments: ${segmentKeyToFiles.size}, Meetings: ${meetingKeyToFiles.size}`);

    // Process each segment
    for (const [segmentKey, files] of segmentKeyToFiles.entries()) {
        try { await mixSegmentChronologically(segmentKey, files); } catch { }
    }

    // Finalize each meeting
    for (const [meetingKey, files] of meetingKeyToFiles.entries()) {
        try {
            console.log(`\n🎛️ Finalizing meeting ${meetingKey}`);
            const parts = meetingKey.split('_');
            const meetingTimestamp = parts[parts.length - 1];
            const channelName = parts.slice(0, parts.length - 1).join('_');

            // Attendees from filenames
            const attendees = new Set();
            for (const f of files) {
                const p = f.replace(/\.pcm$/i, '').split('_');
                const tsStr = p[p.length - 1];
                const maybeUser = p[p.length - 2];
                if (/^\d+$/.test(tsStr) && maybeUser) attendees.add(maybeUser);
            }

            // Collect processed wavs
            const processed = fs.readdirSync(PCM_FOLDER)
                .filter(f => f.includes(meetingKey) && f.endsWith('_processed.wav'))
                .map(f => path.join(PCM_FOLDER, f))
                .sort();

            if (processed.length === 0) { console.log('⚠️ No processed segments. Skipping.'); continue; }

            const finalAudio = path.join(PCM_FOLDER, `${meetingKey}_final.wav`);
            if (processed.length === 1) {
                fs.renameSync(processed[0], finalAudio);
                console.log('✅ Single segment promoted to final');
            } else {
                await new Promise((resolve, reject) => {
                    const ff = spawn(ffmpegPath, [
                        '-y',
                        ...processed.flatMap(f => ['-i', f]),
                        '-filter_complex', `concat=n=${processed.length}:v=0:a=1[out]`,
                        '-map', '[out]',
                        '-ac', '1', '-ar', '16000', '-sample_fmt', 's16',
                        finalAudio
                    ]);
                    let err = '';
                    ff.stderr.on('data', d => err += d.toString());
                    ff.on('close', code => {
                        if (code === 0) {
                            for (const f of processed) { try { fs.unlinkSync(f); } catch { } }
                            console.log('✅ Final audio merged');
                            resolve();
                        } else reject(new Error(`concat failed (${code}): ${err}`));
                    });
                    ff.on('error', reject);
                });
            }

            const transcript = await transcribeAudio(finalAudio);
            const attendeeList = Array.from(attendees);
            const summary = await summarizeTranscript(transcript, attendeeList, channelName, meetingTimestamp);
            if (summary && summary.trim()) {
                const summaryPath = path.join(SUMMARY_FOLDER, `${channelName}_${meetingTimestamp}_summary.txt`);
                fs.writeFileSync(summaryPath, summary);
                await saveSummaryLocally(summary, attendeeList, channelName, meetingTimestamp);
                console.log(`✅ Summary saved: ${summaryPath}`);
            } else {
                console.error('❌ Empty summary; skipped saving');
            }

            try { if (fs.existsSync(finalAudio)) fs.unlinkSync(finalAudio); } catch { }
        } catch (e) {
            console.error(`❌ Failed meeting ${meetingKey}: ${e.message}`);
        }
    }

    console.log('\n🎉 Done processing existing PCM files.');
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});


