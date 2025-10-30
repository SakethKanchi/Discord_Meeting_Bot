const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const prism = require('prism-media');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { summarizeTranscript, saveSummaryLocally } = require('./processor.js');

// Load environment variables
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages
    ]
});

// Configuration
const ffmpegPath = require('ffmpeg-static');
const PCM_FOLDER = './PCM_Files';
const SUMMARY_FOLDER = './Summary';

// Initialize Gemini AI client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Ensure folders exist
if (!fs.existsSync(PCM_FOLDER)) fs.mkdirSync(PCM_FOLDER, { recursive: true });
if (!fs.existsSync(SUMMARY_FOLDER)) fs.mkdirSync(SUMMARY_FOLDER, { recursive: true });

// Recording state
let recordingState = {
    isRecording: false,
    connection: null,
    channelId: null,
    channelName: null,
    timestamp: null,
    segmentCounter: 0,
    activeStreams: new Map(),
    segmentProcessingInterval: null,
    attendeeUpdateInterval: null,
    attendees: new Set()
};

/**
 * Clean PCM to WAV conversion - NO audio processing
 */
function convertPcmToWav(pcmPath, wavPath) {
    return new Promise((resolve, reject) => {
        console.log(`🔄 Converting ${pcmPath} → ${wavPath}...`);

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

        let ffmpegError = '';
        ffmpeg.stderr.on('data', (data) => {
            ffmpegError += data.toString();
        });

        ffmpeg.on('error', (error) => {
            console.error(`❌ FFmpeg process error:`, error);
            reject(new Error(`FFmpeg process error: ${error.message}`));
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                console.log('✅ PCM → WAV conversion successful');
                resolve(wavPath);
            } else {
                console.error(`❌ FFmpeg exited with code ${code}. Error: ${ffmpegError}`);
                reject(new Error(`FFmpeg process exited with code ${code}. Error: ${ffmpegError}`));
            }
        });
    });
}

/**
 * Process a 5-minute segment chronologically
 */
async function processSegmentChronologically(segmentKey) {
    console.log(`🔄 Processing segment ${segmentKey} chronologically...`);

    // Find all PCM files for this segment - look for files that match the current segment
    const segmentFiles = fs.readdirSync(PCM_FOLDER)
        .filter(file => {
            // Check if file contains the segment key (channel_timestamp_segment_X)
            return file.includes(segmentKey) && file.endsWith('.pcm');
        });

    if (segmentFiles.length === 0) {
        console.log(`⚠️ No PCM files found for segment ${segmentKey}`);
        return null;
    }

    console.log(`📁 Found ${segmentFiles.length} PCM files for segment ${segmentKey}`);

    // Parse files and extract user and timestamp
    const fileData = segmentFiles.map(file => {
        const parts = file.split('_');
        const timestamp = parseInt(parts.pop().replace('.pcm', ''));
        const username = parts[parts.length - 1];
        return { file, timestamp, username };
    });

    // Sort chronologically by timestamp
    fileData.sort((a, b) => a.timestamp - b.timestamp);

    console.log(`📊 Chronological order for segment ${segmentKey}:`);
    fileData.forEach(({ username, timestamp }, index) => {
        const time = new Date(timestamp).toLocaleTimeString();
        console.log(`   ${index + 1}. ${username} at ${time}`);
    });

    // Convert each PCM file to WAV
    const converted = [];
    for (let i = 0; i < fileData.length; i++) {
        const { file, username, timestamp } = fileData[i];
        const pcmPath = path.join(PCM_FOLDER, file);
        const wavFile = `temp_${segmentKey}_${i}.wav`;
        const wavPath = path.join(PCM_FOLDER, wavFile);

        try {
            // Check if file exists and is not empty
            const stats = fs.statSync(pcmPath);
            if (stats.size === 0) {
                console.log(`⚠️ Skipping empty PCM file: ${file}`);
                continue;
            }

            await convertPcmToWav(pcmPath, wavPath);
            converted.push({ wavPath, username, timestamp, originalPcm: file });
            console.log(`✅ Converted ${file} → ${wavFile}`);
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log(`⚠️ File no longer exists: ${file}, skipping`);
            } else {
                console.error(`❌ Failed to convert ${file}:`, error.message);
            }
        }
    }

    if (converted.length === 0) {
        console.log(`⚠️ No WAV files created for segment ${segmentKey}`);
        return null;
    }

    // Mix WAV files chronologically to preserve conversation flow
    const segmentWavFile = path.join(PCM_FOLDER, `${segmentKey}_processed.wav`);

    return new Promise((resolve, reject) => {
        console.log(`🔄 Mixing ${wavFiles.length} WAV files chronologically to preserve conversation flow...`);

        // Calculate timing offsets for each successfully converted input
        const startTime = converted[0].timestamp;
        const timingOffsets = converted.map(({ timestamp }) => (timestamp - startTime) / 1000);

        console.log(`📊 Timing offsets: ${timingOffsets.map((offset, i) => `${converted[i].username}: +${offset.toFixed(2)}s`).join(', ')}`);

        // Create a temporary filter file to avoid ENAMETOOLONG error
        const filterFilePath = path.join(PCM_FOLDER, `${segmentKey}_filter.txt`);

        let ffmpeg;
        let ffmpegError = '';

        try {
            // Write filter complex to file
            let filterContent = '';

            for (let i = 0; i < converted.length; i++) {
                const offset = timingOffsets[i];
                const ms = Math.round(offset * 1000);
                if (ms === 0) {
                    filterContent += `[${i}:a]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono[a${i}];`;
                } else {
                    filterContent += `[${i}:a]adelay=${ms},aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono[a${i}];`;
                }
            }

            // Mix all normalized streams together
            const delayedInputs = converted.map((_, i) => `[a${i}]`).join('');
            filterContent += `${delayedInputs}amix=inputs=${converted.length}:duration=longest[out]`;

            fs.writeFileSync(filterFilePath, filterContent);

            // Build FFmpeg command for proper audio mixing
            const ffmpegArgs = ['-y'];

            // Add input files
            converted.forEach(({ wavPath }) => {
                ffmpegArgs.push('-i', wavPath);
            });

            ffmpegArgs.push('-filter_complex_script', filterFilePath);
            ffmpegArgs.push('-map', '[out]');
            // Normalize output format to prevent encoder mismatch
            ffmpegArgs.push('-ac', '1', '-ar', '16000', '-sample_fmt', 's16');
            ffmpegArgs.push(segmentWavFile);

            ffmpeg = spawn(ffmpegPath, ffmpegArgs);

            ffmpeg.stderr.on('data', (data) => {
                ffmpegError += data.toString();
            });

            ffmpeg.on('error', (error) => {
                console.error(`❌ FFmpeg process error:`, error);
                reject(new Error(`FFmpeg process error: ${error.message}`));
            });

            ffmpeg.on('close', async (code) => {
                // Clean up temporary WAV files
                converted.forEach(({ wavPath }) => {
                    try {
                        fs.unlinkSync(wavPath);
                        console.log(`🗑️ Cleaned up temporary file: ${path.basename(wavPath)}`);
                    } catch (err) {
                        console.error(`❌ Failed to delete ${wavPath}:`, err);
                    }
                });

                // Clean up filter file
                try {
                    if (fs.existsSync(filterFilePath)) {
                        fs.unlinkSync(filterFilePath);
                        console.log(`🗑️ Cleaned up filter file`);
                    }
                } catch (err) {
                    console.error(`❌ Failed to delete filter file:`, err);
                }

                if (code === 0) {
                    // Keep original PCM files for now (no deletion)
                    console.log(`✅ Segment ${segmentKey} processed successfully: ${segmentWavFile}`);
                    resolve(segmentWavFile);
                } else {
                    console.error(`❌ FFmpeg merge exited with code ${code}. Error: ${ffmpegError}`);
                    reject(new Error(`FFmpeg merge process exited with code ${code}. Error: ${ffmpegError}`));
                }
            });

        } catch (error) {
            // Clean up filter file on error
            try {
                if (fs.existsSync(filterFilePath)) {
                    fs.unlinkSync(filterFilePath);
                }
            } catch (err) {
                // Ignore cleanup errors
            }
            reject(new Error(`Failed to create filter file: ${error.message}`));
        }
    });
}

/**
 * Start recording with proper chronological processing
 */
async function startRecording(connection, guild, channelId) {
    if (recordingState.isRecording) {
        console.log('⚠️ Already recording!');
        return;
    }

    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
        console.log('❌ Channel not found!');
        return;
    }

    recordingState.isRecording = true;
    recordingState.connection = connection;
    recordingState.channelId = channelId;
    recordingState.channelName = channel.name;
    recordingState.timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    recordingState.segmentCounter = 0;
    recordingState.activeStreams.clear();

    // Capture initial attendees
    recordingState.attendees = new Set(channel.members
        .filter(member => !member.user.bot)
        .map(member => member.displayName));

    console.log(`🎙️ Started recording in ${channel.name}`);
    console.log(`📊 Recording timestamp: ${recordingState.timestamp}`);
    console.log(`👥 Initial attendees: ${Array.from(recordingState.attendees).join(', ')}`);

    // Set up 5-minute segment processing for summary generation
    recordingState.segmentProcessingInterval = setInterval(async () => {
        console.log(`⏰ 5-minute interval reached. Processing segment ${recordingState.segmentCounter} for summary...`);

        const segmentKey = `${recordingState.channelName}_${recordingState.timestamp}_segment_${recordingState.segmentCounter}`;

        try {
            const segmentFile = await processSegmentChronologically(segmentKey);
            if (segmentFile) {
                console.log(`✅ Segment ${recordingState.segmentCounter} processed for summary generation`);
            } else {
                console.log(`⚠️ Segment ${recordingState.segmentCounter} processing returned null`);
            }
        } catch (error) {
            console.error(`❌ Error processing segment ${recordingState.segmentCounter}:`, error);
        }

        recordingState.segmentCounter++;
        console.log(`📊 Now recording to segment ${recordingState.segmentCounter}`);
    }, 5 * 60 * 1000); // 5 minutes

    // Set up voice activity detection
    connection.receiver.speaking.on('start', (userId) => {
        const user = guild.members.cache.get(userId);
        if (!user) return;

        console.log(`🎤 ${user.displayName} started speaking`);

        // Skip if already recording this user
        if (recordingState.activeStreams.has(userId)) {
            console.log(`⚠️ Already recording ${user.displayName}, skipping duplicate`);
            return;
        }

        const audioStream = connection.receiver.subscribe(userId, {
            end: { behavior: 'manual' }
        });

        const transcoder = new prism.opus.Decoder({ rate: 16000, channels: 1, frameSize: 320 });

        // Create filename with timestamp
        const fileName = `${recordingState.channelName}_${recordingState.timestamp}_segment_${recordingState.segmentCounter}_${user.displayName}_${Date.now()}.pcm`;
        const pcmFilePath = path.join(PCM_FOLDER, fileName);
        const userOutputStream = fs.createWriteStream(pcmFilePath);

        // Track initial size to detect empty files
        let bytesWritten = 0;

        // Monitor bytes written
        userOutputStream.on('data', (chunk) => {
            bytesWritten += chunk.length;
        });

        // Pipe with error handling
        audioStream.pipe(transcoder).pipe(userOutputStream);

        // Flag to prevent multiple calls to endHandler
        let isEnded = false;

        const endHandler = () => {
            if (isEnded) return; // Prevent multiple calls
            isEnded = true;

            console.log(`🔇 ${user.displayName} stopped speaking`);

            // Remove the speaking end listener to prevent memory leaks
            try {
                const streamData = recordingState.activeStreams.get(userId);
                if (streamData && streamData.speakingEndListener) {
                    connection.receiver.speaking.removeListener('end', streamData.speakingEndListener);
                }
            } catch (err) {
                // Listener might not exist
            }

            // Properly end the output stream
            try {
                userOutputStream.end();
            } catch (err) {
                console.error(`Error ending output stream for ${user.displayName}:`, err.message);
            }

            // Manually destroy the audio stream
            try {
                audioStream.destroy();
            } catch (err) {
                console.error(`Error destroying stream for ${user.displayName}:`, err.message);
            }

            // Check if file is empty and delete it if so
            setTimeout(() => {
                try {
                    const stats = fs.statSync(pcmFilePath);
                    if (stats.size === 0) {
                        fs.unlinkSync(pcmFilePath);
                        console.log(`🗑️ Deleted empty PCM file for ${user.displayName}`);
                    }
                } catch (err) {
                    // File might already be deleted or doesn't exist
                }
            }, 100);

            // Clean up listeners and remove from active streams
            recordingState.activeStreams.delete(userId);
        };

        const errorHandler = (error) => {
            if (isEnded) return;
            console.error(`❌ Audio stream error for ${user.displayName}:`, error.message);
            endHandler();
        };

        const transcoderErrorHandler = (error) => {
            if (isEnded) return;
            console.error(`❌ Transcoder error for ${user.displayName}:`, error.message);
            // Clean up immediately when transcoder fails
            endHandler();
        };

        // Create a per-user speaking end listener that can be removed
        const speakingEndListener = (endUserId) => {
            if (endUserId === userId) {
                endHandler();
            }
        };

        // Store the stream info with the listener for cleanup
        recordingState.activeStreams.set(userId, {
            stream: audioStream,
            transcoder: transcoder,
            outputStream: userOutputStream,
            user: user,
            pcmFilePath: pcmFilePath,
            bytesWritten: bytesWritten,
            speakingEndListener: speakingEndListener // Store for cleanup
        });

        // Listen for when user stops speaking
        connection.receiver.speaking.on('end', speakingEndListener);

        audioStream.on('error', errorHandler);
        audioStream.on('end', () => {
            console.log(`📡 Audio stream ended naturally for ${user.displayName}`);
            endHandler();
        });
        transcoder.on('error', transcoderErrorHandler);
    });

    // Set up dynamic attendee tracking
    const updateAttendees = () => {
        const currentMembers = channel.members
            .filter(member => !member.user.bot)
            .map(member => member.displayName);

        const currentAttendees = new Set(currentMembers);
        const previousAttendees = recordingState.attendees;

        // Check for new attendees
        for (const member of currentAttendees) {
            if (!previousAttendees.has(member)) {
                console.log(`👋 ${member} joined the meeting`);
                recordingState.attendees.add(member);
            }
        }

        // Check for attendees who left (but keep them in the list for historical accuracy)
        for (const member of previousAttendees) {
            if (!currentAttendees.has(member)) {
                console.log(`👋 ${member} left the meeting (keeping in attendee list)`);
            }
        }

        console.log(`👥 Current attendees: ${Array.from(recordingState.attendees).join(', ')}`);
    };

    // Update attendees every 30 seconds during recording
    const attendeeUpdateInterval = setInterval(updateAttendees, 30000);

    // Store the interval ID for cleanup
    recordingState.attendeeUpdateInterval = attendeeUpdateInterval;
}

/**
 * Transcribe audio using Whisper
 */
async function transcribeAudio(audioFilePath) {
    return new Promise((resolve, reject) => {
        console.log(`🔄 Transcribing audio with Whisper: ${audioFilePath}`);

        const pythonScript = spawn('python', ['transcribe.py', audioFilePath]);
        let transcript = '';
        let error = '';

        pythonScript.stdout.on('data', (data) => {
            transcript += data.toString();
        });

        pythonScript.stderr.on('data', (data) => {
            error += data.toString();
        });

        pythonScript.on('close', (code) => {
            if (code === 0) {
                console.log('✅ Whisper transcription completed');
                resolve(transcript.trim());
            } else {
                console.error(`❌ Transcription failed with code ${code}: ${error}`);
                reject(new Error(`Transcription failed: ${error}`));
            }
        });
    });
}


/**
 * Stop recording and create final chronological merge with transcription and summary
 */
async function stopRecording() {
    if (!recordingState.isRecording) {
        console.log('⚠️ Not currently recording!');
        return;
    }

    // Validate recording state
    if (!recordingState.channelName || !recordingState.timestamp) {
        console.error('❌ Invalid recording state - missing channelName or timestamp');
        // Try to continue anyway, but log the issue
        console.log('⚠️ Recording state is incomplete, attempting to proceed...');
    }

    console.log('🛑 Stopping recording...');

    // Clear the segment processing interval
    if (recordingState.segmentProcessingInterval) {
        clearInterval(recordingState.segmentProcessingInterval);
        recordingState.segmentProcessingInterval = null;
    }

    // Clear the attendee update interval
    if (recordingState.attendeeUpdateInterval) {
        clearInterval(recordingState.attendeeUpdateInterval);
        recordingState.attendeeUpdateInterval = null;
    }

    // Process the current segment
    const currentSegmentKey = `${recordingState.channelName}_${recordingState.timestamp}_segment_${recordingState.segmentCounter}`;
    try {
        const segmentFile = await processSegmentChronologically(currentSegmentKey);
        if (segmentFile) {
            console.log(`✅ Final segment ${recordingState.segmentCounter} processed`);
        }
    } catch (error) {
        console.error(`❌ Error processing final segment:`, error);
    }

    // Close all active streams
    recordingState.activeStreams.forEach((streamData, userId) => {
        console.log(`🔇 Closing stream for ${streamData.user.displayName}`);

        // Remove the speaking end listener
        try {
            if (streamData.speakingEndListener && recordingState.connection) {
                recordingState.connection.receiver.speaking.removeListener('end', streamData.speakingEndListener);
            }
        } catch (err) {
            console.error(`Error removing listener for ${streamData.user.displayName}:`, err.message);
        }

        // Properly end the output stream
        try {
            streamData.outputStream.end();
        } catch (err) {
            console.error(`Error ending output stream for ${streamData.user.displayName}:`, err.message);
        }

        // Manually destroy the audio stream
        try {
            streamData.stream.destroy();
        } catch (err) {
            console.error(`Error destroying stream for ${streamData.user.displayName}:`, err.message);
        }

        // Check if file is empty and delete it
        if (streamData.pcmFilePath) {
            setTimeout(() => {
                try {
                    if (fs.existsSync(streamData.pcmFilePath)) {
                        const stats = fs.statSync(streamData.pcmFilePath);
                        if (stats.size === 0) {
                            fs.unlinkSync(streamData.pcmFilePath);
                            console.log(`🗑️ Deleted empty PCM file for ${streamData.user.displayName}`);
                        }
                    }
                } catch (err) {
                    // File might already be deleted
                }
            }, 100);
        }

        recordingState.activeStreams.delete(userId);
    });

    // Generate final summary from all segments
    try {
        console.log('🔄 Generating final meeting summary...');

        // Validate recording state before processing
        if (!recordingState.channelName || !recordingState.timestamp) {
            console.error('❌ Invalid recording state - channelName or timestamp is null');
            console.log('⚠️ Cannot generate summary without valid channel/timestamp');
            return;
        }

        // Find all processed WAV files for this meeting
        const meetingFiles = fs.readdirSync(PCM_FOLDER)
            .filter(file => file.includes(`${recordingState.channelName}_${recordingState.timestamp}`) && file.endsWith('_processed.wav'));

        if (meetingFiles.length > 0) {
            console.log(`📁 Found ${meetingFiles.length} processed segments for final summary`);

            // Create final merged audio for transcription
            const finalAudioFile = path.join(PCM_FOLDER, `${recordingState.channelName}_${recordingState.timestamp}_final.wav`);

            if (meetingFiles.length === 1) {
                // Single segment - just rename it
                fs.renameSync(path.join(PCM_FOLDER, meetingFiles[0]), finalAudioFile);
            } else {
                // Multiple segments - concatenate them
                await new Promise((resolve, reject) => {
                    const ffmpeg = spawn(ffmpegPath, [
                        '-y',
                        ...meetingFiles.flatMap(file => ['-i', path.join(PCM_FOLDER, file)]),
                        '-filter_complex', `concat=n=${meetingFiles.length}:v=0:a=1[out]`,
                        '-map', '[out]',
                        finalAudioFile
                    ]);

                    ffmpeg.on('close', async (code) => {
                        if (code === 0) {
                            console.log(`✅ Final audio merged successfully`);
                            resolve();
                        } else {
                            reject(new Error(`FFmpeg merge failed with code ${code}`));
                        }
                    });

                    ffmpeg.on('error', reject);
                });
            }

            // Transcribe the final audio
            const transcript = await transcribeAudio(finalAudioFile);

            // Generate summary with attendees
            const attendees = Array.from(recordingState.attendees);
            const summary = await summarizeTranscript(transcript, attendees, recordingState.channelName, recordingState.timestamp);

            // Validate summary before saving
            if (!summary || summary.trim().length === 0) {
                console.error('❌ Generated summary is empty, skipping save');
            } else {
                // Save summary
                const summaryFileName = `${recordingState.channelName}_${recordingState.timestamp}_summary.txt`;
                const summaryPath = path.join(SUMMARY_FOLDER, summaryFileName);
                fs.writeFileSync(summaryPath, summary);

                // Also save to channel-specific meetings file
                await saveSummaryLocally(summary, attendees, recordingState.channelName, recordingState.timestamp);

                console.log(`✅ Summary saved: ${summaryPath}`);
                console.log(`📋 Summary: ${summaryPath}`);
                console.log(`👥 Attendees: ${attendees.join(', ')}`);
            }

            // Clean up processed files
            meetingFiles.forEach(file => {
                try {
                    const filePath = path.join(PCM_FOLDER, file);
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                        console.log(`🗑️ Cleaned up processed file: ${file}`);
                    }
                } catch (err) {
                    if (err.code !== 'ENOENT') {
                        console.error(`❌ Failed to delete ${file}:`, err.message);
                    }
                }
            });

            // Clean up final audio file
            try {
                if (fs.existsSync(finalAudioFile)) {
                    fs.unlinkSync(finalAudioFile);
                    console.log(`🗑️ Cleaned up final audio file`);
                }
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    console.error(`❌ Failed to delete final audio file:`, err);
                }
            }

            console.log('🎉 Meeting summary generation completed!');

        } else {
            console.log('⚠️ No processed segments found for summary generation');
        }

    } catch (error) {
        console.error('❌ Error generating final summary:', error);
    }

    // Reset recording state
    recordingState.isRecording = false;
    recordingState.connection = null;
    recordingState.channelId = null;
    recordingState.channelName = null;
    recordingState.timestamp = null;
    recordingState.segmentCounter = 0;
    recordingState.activeStreams.clear();
    recordingState.attendees.clear();
}

// Discord.js event handlers
client.once('ready', async () => {
    console.log(`🤖 Bot logged in as ${client.user.tag}`);

    // Automatically deploy slash commands on startup
    try {
        console.log('🔄 Auto-deploying slash commands...');
        const { REST, Routes } = require('discord.js');
        const { commands } = require('./commands.js');

        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );

        console.log('✅ Slash commands auto-deployed successfully!');
    } catch (error) {
        console.error('❌ Error auto-deploying commands:', error);
    }

    // Check for existing meetings when bot starts up
    console.log('🔍 Checking for existing meetings...');

    try {
        for (const guild of client.guilds.cache.values()) {
            for (const channel of guild.channels.cache.values()) {
                if (channel.type === 2) { // Voice channel
                    const membersCount = channel.members.filter(member => !member.user.bot).size;
                    if (membersCount > 1) {
                        console.log(`👥 Found existing meeting in ${channel.name} with ${membersCount} members. Auto-joining...`);

                        try {
                            const connection = joinVoiceChannel({
                                channelId: channel.id,
                                guildId: guild.id,
                                adapterCreator: guild.voiceAdapterCreator,
                                selfDeaf: false,
                                selfMute: false
                            });
                            await entersState(connection, VoiceConnectionStatus.Ready, 10_000); // Reduced timeout
                            await startRecording(connection, guild, channel.id);
                            console.log(`✅ Auto-joined existing meeting in ${channel.name}`);
                        } catch (error) {
                            console.error(`❌ Failed to auto-join ${channel.name}:`, error.message);
                            // Don't crash the bot, just log the error and continue
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('❌ Error during startup meeting check:', error.message);
        // Continue bot startup even if meeting check fails
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const args = message.content.split(' ');
    const command = args[0];

    if (command === '!join') {
        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
            return message.reply('❌ You need to be in a voice channel!');
        }

        try {
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: message.guild.id,
                adapterCreator: message.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false
            });
            await entersState(connection, VoiceConnectionStatus.Ready, 10_000); // Reduced timeout
            await startRecording(connection, message.guild, voiceChannel.id);
            message.reply(`✅ Joined ${voiceChannel.name} and started recording!`);
        } catch (error) {
            console.error('Error joining voice channel:', error);
            message.reply('❌ Failed to join voice channel!');
        }
    }

    if (command === '!leave') {
        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
            return message.reply('❌ You need to be in a voice channel!');
        }

        try {
            await stopRecording();
            // Get the connection and safely destroy it
            const connection = getVoiceConnection(voiceChannel.guild.id);
            if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
                try {
                    connection.destroy();
                    console.log('✅ Manual leave: Connection destroyed');
                } catch (destroyError) {
                    console.warn('⚠️ Manual leave: Connection was already destroyed:', destroyError.message);
                }
            }
            message.reply('✅ Left voice channel and stopped recording!');
        } catch (error) {
            console.error('Error leaving voice channel:', error);
            message.reply('❌ Failed to leave voice channel!');
        }
    }
});

// Handle slash command interactions
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;
    const { commandName, member, guild } = interaction;

    try {
        if (commandName === 'join') {
            if (!member.voice.channel) {
                return interaction.reply({
                    content: '❌ You must be in a voice channel to use this command.',
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });

            const connection = joinVoiceChannel({
                channelId: member.voice.channelId,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false
            });
            await entersState(connection, VoiceConnectionStatus.Ready, 10_000); // Reduced timeout
            await startRecording(connection, guild, member.voice.channelId);

            await interaction.editReply({ content: '✅ Joined voice channel and started recording!' });
        } else if (commandName === 'leave') {
            await interaction.deferReply({ ephemeral: true });

            if (recordingState.connection) {
                await stopRecording();
                // Get the connection and safely destroy it
                const connection = getVoiceConnection(recordingState.connection.joinConfig.guildId);
                if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    try {
                        connection.destroy();
                        console.log('✅ Slash command leave: Connection destroyed');
                    } catch (destroyError) {
                        console.warn('⚠️ Slash command leave: Connection was already destroyed:', destroyError.message);
                    }
                }
                await interaction.editReply({ content: '👋 Left voice channel and stopped recording!' });
            } else {
                await interaction.editReply({ content: "❌ I'm not currently in a voice channel." });
            }
        }
    } catch (error) {
        console.error('❌ Error during interaction:', error);
        const errorMessage = `❌ An error occurred: ${error.message}`;
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: errorMessage, ephemeral: true }).catch(e => console.error('Failed to edit reply:', e));
        } else {
            await interaction.reply({ content: errorMessage, ephemeral: true }).catch(e => console.error('Failed to send reply:', e));
        }
    }
});

// Handle automatic voice channel joining/leaving based on user activity
client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.member?.user.bot || (oldState.channelId === newState.channelId && oldState.channelId !== null)) return;
    const connection = getVoiceConnection(oldState.guild.id);
    const targetChannel = oldState.channel || newState.channel;
    if (!targetChannel) return;

    const membersCount = targetChannel.members.filter(member => !member.user.bot).size;

    if (!connection && newState.channelId === targetChannel.id && membersCount > 1) {
        console.log(`👥 User joined. There are now ${membersCount} members. Auto-joining channel...`);
        const newConnection = joinVoiceChannel({
            channelId: newState.channelId,
            guildId: newState.guild.id,
            adapterCreator: newState.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });
        entersState(newConnection, VoiceConnectionStatus.Ready, 10_000) // Reduced timeout
            .then(() => startRecording(newConnection, targetChannel.guild, targetChannel.id))
            .catch(err => console.error("❌ Failed to establish voice connection (Auto-Join):", err.message));
    } else if (connection && connection.joinConfig.channelId === targetChannel.id) {
        if (membersCount <= 1) {
            console.log(`👋 User left/moved. Human count is ${membersCount}. Auto-leaving.`);
            stopRecording().then(() => {
                // Check if connection still exists and isn't already destroyed
                if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    try {
                        connection.destroy();
                        console.log('✅ Bot left voice channel automatically');
                    } catch (destroyError) {
                        console.warn('⚠️ Connection was already destroyed or error during destruction:', destroyError.message);
                    }
                } else {
                    console.log('ℹ️ Connection already destroyed or not found');
                }
            }).catch(error => {
                console.error('❌ Error during auto-stop recording:', error);
                // Still try to leave the channel even if recording stop failed
                if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    try {
                        connection.destroy();
                    } catch (leaveError) {
                        console.error('❌ Error leaving voice channel:', leaveError);
                    }
                }
            });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
