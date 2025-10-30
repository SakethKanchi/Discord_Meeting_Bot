const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const prism = require('prism-media');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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
const RECORDINGS_FOLDER = './Recordings';
const PCM_FOLDER = './PCM_Files';
const PCM_BACKUP_FOLDER = './PCM_Backup';
const SEGMENTS_FOLDER = './Segments';
const TRANSCRIPTS_FOLDER = './Transcripts';
const SUMMARY_FOLDER = './Summary';

// Initialize Gemini AI client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Ensure folders exist
if (!fs.existsSync(RECORDINGS_FOLDER)) fs.mkdirSync(RECORDINGS_FOLDER, { recursive: true });
if (!fs.existsSync(PCM_FOLDER)) fs.mkdirSync(PCM_FOLDER, { recursive: true });
if (!fs.existsSync(PCM_BACKUP_FOLDER)) fs.mkdirSync(PCM_BACKUP_FOLDER, { recursive: true });
if (!fs.existsSync(SEGMENTS_FOLDER)) fs.mkdirSync(SEGMENTS_FOLDER, { recursive: true });
if (!fs.existsSync(TRANSCRIPTS_FOLDER)) fs.mkdirSync(TRANSCRIPTS_FOLDER, { recursive: true });
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
    allProcessedSegments: [],
    attendees: []
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
 * Backup PCM files to backup folder
 */
function backupPcmFiles(segmentFiles, segmentKey) {
    const backupDir = path.join(PCM_BACKUP_FOLDER, segmentKey);
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }

    segmentFiles.forEach(file => {
        const sourcePath = path.join(PCM_FOLDER, file);
        const backupPath = path.join(backupDir, file);

        try {
            fs.copyFileSync(sourcePath, backupPath);
            console.log(`📁 Backed up PCM file: ${file}`);
        } catch (error) {
            console.error(`❌ Failed to backup ${file}:`, error.message);
        }
    });

    return backupDir;
}

/**
 * Process a 5-minute segment chronologically with backup
 */
async function processSegmentChronologically(segmentKey) {
    console.log(`🔄 Processing segment ${segmentKey} chronologically...`);

    // Find all PCM files for this segment
    const segmentFiles = fs.readdirSync(PCM_FOLDER)
        .filter(file => file.includes(segmentKey) && file.endsWith('.pcm'));

    if (segmentFiles.length === 0) {
        console.log(`⚠️ No PCM files found for segment ${segmentKey}`);
        return null;
    }

    console.log(`📁 Found ${segmentFiles.length} PCM files for segment ${segmentKey}`);

    // Backup PCM files before processing
    const backupDir = backupPcmFiles(segmentFiles, segmentKey);
    console.log(`📁 PCM files backed up to: ${backupDir}`);

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
    const wavFiles = [];
    for (let i = 0; i < fileData.length; i++) {
        const { file } = fileData[i];
        const pcmPath = path.join(PCM_FOLDER, file);
        const wavFile = `temp_${segmentKey}_${i}.wav`;
        const wavPath = path.join(SEGMENTS_FOLDER, wavFile);

        try {
            await convertPcmToWav(pcmPath, wavPath);
            wavFiles.push(wavPath);
            console.log(`✅ Converted ${file} → ${wavFile}`);
        } catch (error) {
            console.error(`❌ Failed to convert ${file}:`, error.message);
        }
    }

    if (wavFiles.length === 0) {
        console.log(`⚠️ No WAV files created for segment ${segmentKey}`);
        return null;
    }

    // Merge WAV files chronologically
    const segmentWavFile = path.join(SEGMENTS_FOLDER, `${segmentKey}_processed.wav`);

    return new Promise((resolve, reject) => {
        console.log(`🔄 Merging ${wavFiles.length} WAV files chronologically...`);

        const ffmpeg = spawn(ffmpegPath, [
            '-y',
            ...wavFiles.flatMap(file => ['-i', file]),
            '-filter_complex', `concat=n=${wavFiles.length}:v=0:a=1[out]`,
            '-map', '[out]',
            segmentWavFile
        ]);

        let ffmpegError = '';
        ffmpeg.stderr.on('data', (data) => {
            ffmpegError += data.toString();
        });

        ffmpeg.on('error', (error) => {
            console.error(`❌ FFmpeg process error:`, error);
            reject(new Error(`FFmpeg process error: ${error.message}`));
        });

        ffmpeg.on('close', async (code) => {
            // Clean up temporary WAV files
            wavFiles.forEach(file => {
                try {
                    fs.unlinkSync(file);
                    console.log(`🗑️ Cleaned up temporary file: ${path.basename(file)}`);
                } catch (err) {
                    console.error(`❌ Failed to delete ${file}:`, err);
                }
            });

            if (code === 0) {
                console.log(`✅ Segment ${segmentKey} processed successfully: ${segmentWavFile}`);
                resolve(segmentWavFile);
            } else {
                console.error(`❌ FFmpeg merge exited with code ${code}. Error: ${ffmpegError}`);
                reject(new Error(`FFmpeg merge process exited with code ${code}. Error: ${ffmpegError}`));
            }
        });
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
    recordingState.allProcessedSegments = [];

    // Capture attendees
    recordingState.attendees = channel.members
        .filter(member => !member.user.bot)
        .map(member => member.displayName);

    console.log(`🎙️ Started TEST recording in ${channel.name}`);
    console.log(`📊 Recording timestamp: ${recordingState.timestamp}`);
    console.log(`👥 Attendees: ${recordingState.attendees.join(', ')}`);
    console.log(`📁 PCM files will be backed up to: ${PCM_BACKUP_FOLDER}`);
    console.log(`📁 Segments will be stored in: ${SEGMENTS_FOLDER}`);

    // Set up 5-minute segment processing
    recordingState.segmentProcessingInterval = setInterval(async () => {
        console.log(`⏰ 5-minute interval reached. Processing segment ${recordingState.segmentCounter}...`);

        const segmentKey = `${recordingState.channelName}_${recordingState.timestamp}_segment_${recordingState.segmentCounter}`;

        try {
            const segmentFile = await processSegmentChronologically(segmentKey);
            if (segmentFile) {
                recordingState.allProcessedSegments.push(segmentFile);
                console.log(`✅ Segment ${recordingState.segmentCounter} processed and added to final merge list`);
            } else {
                console.log(`⚠️ Segment ${recordingState.segmentCounter} processing returned null`);
            }
        } catch (error) {
            console.error(`❌ Error processing segment ${recordingState.segmentCounter}:`, error);
        }

        recordingState.segmentCounter++;
        console.log(`📊 Now recording to segment ${recordingState.segmentCounter}`);
        console.log(`📊 Total segments processed: ${recordingState.allProcessedSegments.length}`);
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
            end: { behavior: 'automatic' }
        });

        const transcoder = new prism.opus.Decoder({ rate: 16000, channels: 1, frameSize: 320 });
        const userOutputStream = fs.createWriteStream(
            path.join(PCM_FOLDER, `${recordingState.channelName}_${recordingState.timestamp}_segment_${recordingState.segmentCounter}_${user.displayName}_${Date.now()}.pcm`)
        );

        audioStream.pipe(transcoder).pipe(userOutputStream);

        recordingState.activeStreams.set(userId, {
            stream: audioStream,
            transcoder: transcoder,
            outputStream: userOutputStream,
            user: user
        });

        const endHandler = () => {
            console.log(`🔇 ${user.displayName} stopped speaking`);

            // Properly end the output stream
            userOutputStream.end();

            // Clean up listeners and remove from active streams
            audioStream.removeListener('end', endHandler);
            transcoder.removeListener('error', transcoderErrorHandler);
            audioStream.removeListener('error', errorHandler);

            recordingState.activeStreams.delete(userId);
        };

        const errorHandler = (error) => {
            console.error(`❌ Audio stream error for ${user.displayName}:`, error);
            endHandler();
        };

        const transcoderErrorHandler = (error) => {
            console.error(`❌ Transcoder error for ${user.displayName}:`, error);
            endHandler();
        };

        audioStream.on('error', errorHandler);
        transcoder.on('error', transcoderErrorHandler);
        audioStream.on('end', endHandler);
    });
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
 * Generate summary using Gemini AI
 */
async function generateSummary(transcript, attendees, channelName) {
    try {
        console.log('🔄 Generating summary with Gemini AI...');

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
        const currentDate = new Date().toLocaleString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZoneName: 'short'
        });

        const prompt = `Please provide a concise summary of this meeting transcript. Include key decisions, action items, and main discussion points.

Meeting Details:
- Channel: ${channelName}
- Attendees: ${attendees.join(', ')}
- Date: ${currentDate}

Transcript:
${transcript}

Please format the summary as:
========================================
Date: ${currentDate}
Attendees: ${attendees.join(', ')}
Summary: [Concise summary of the meeting]
========================================`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const summary = response.text();

        console.log('✅ Summary generated successfully');
        return summary;
    } catch (error) {
        console.error('❌ Error generating summary:', error);
        return `Error generating summary: ${error.message}`;
    }
}

/**
 * Stop recording and create final chronological merge with transcription and summary
 */
async function stopRecording() {
    if (!recordingState.isRecording) {
        console.log('⚠️ Not currently recording!');
        return;
    }

    console.log('🛑 Stopping TEST recording...');

    // Clear the segment processing interval
    if (recordingState.segmentProcessingInterval) {
        clearInterval(recordingState.segmentProcessingInterval);
        recordingState.segmentProcessingInterval = null;
    }

    // Process the current segment
    const currentSegmentKey = `${recordingState.channelName}_${recordingState.timestamp}_segment_${recordingState.segmentCounter}`;
    try {
        const segmentFile = await processSegmentChronologically(currentSegmentKey);
        if (segmentFile) {
            recordingState.allProcessedSegments.push(segmentFile);
            console.log(`✅ Final segment ${recordingState.segmentCounter} processed`);
        }
    } catch (error) {
        console.error(`❌ Error processing final segment:`, error);
    }

    // Close all active streams
    recordingState.activeStreams.forEach((streamData, userId) => {
        console.log(`🔇 Closing stream for ${streamData.user.displayName}`);
        streamData.outputStream.end();
        recordingState.activeStreams.delete(userId);
    });

    // Create final chronological merge
    if (recordingState.allProcessedSegments.length > 0) {
        console.log(`🔄 Creating final chronological merge of ${recordingState.allProcessedSegments.length} segments...`);

        const finalFileName = `${recordingState.channelName}_${recordingState.timestamp}_TEST_FINAL_CHRONOLOGICAL.wav`;
        const finalFilePath = path.join(RECORDINGS_FOLDER, finalFileName);

        try {
            await new Promise((resolve, reject) => {
                const ffmpeg = spawn(ffmpegPath, [
                    '-y',
                    ...recordingState.allProcessedSegments.flatMap(file => ['-i', file]),
                    '-filter_complex', `concat=n=${recordingState.allProcessedSegments.length}:v=0:a=1[out]`,
                    '-map', '[out]',
                    finalFilePath
                ]);

                let ffmpegError = '';
                ffmpeg.stderr.on('data', (data) => {
                    ffmpegError += data.toString();
                });

                ffmpeg.on('error', (error) => {
                    console.error(`❌ FFmpeg process error:`, error);
                    reject(new Error(`FFmpeg process error: ${error.message}`));
                });

                ffmpeg.on('close', async (code) => {
                    if (code === 0) {
                        console.log(`✅ Final chronological merge successful: ${finalFilePath}`);

                        // Generate transcription and summary
                        try {
                            console.log('🔄 Starting transcription and summary generation...');

                            // Transcribe the final audio
                            const transcript = await transcribeAudio(finalFilePath);

                            // Save transcript
                            const transcriptFileName = `${recordingState.channelName}_${recordingState.timestamp}_TEST_transcript.txt`;
                            const transcriptPath = path.join(TRANSCRIPTS_FOLDER, transcriptFileName);
                            fs.writeFileSync(transcriptPath, transcript);
                            console.log(`✅ Transcript saved: ${transcriptPath}`);

                            // Use captured attendees from recording state
                            const attendees = recordingState.attendees || [];

                            // Generate summary
                            const summary = await generateSummary(transcript, attendees, recordingState.channelName);

                            // Save summary
                            const summaryFileName = `${recordingState.channelName}_${recordingState.timestamp}_TEST_summary.txt`;
                            const summaryPath = path.join(SUMMARY_FOLDER, summaryFileName);
                            fs.writeFileSync(summaryPath, summary);
                            console.log(`✅ Summary saved: ${summaryPath}`);

                            console.log('🎉 Complete TEST processing pipeline finished!');
                            console.log(`📝 Final audio: ${finalFilePath}`);
                            console.log(`📄 Transcript: ${transcriptPath}`);
                            console.log(`📋 Summary: ${summaryPath}`);
                            console.log(`📁 PCM backups: ${PCM_BACKUP_FOLDER}`);
                            console.log(`📁 Segments: ${SEGMENTS_FOLDER}`);

                        } catch (error) {
                            console.error('❌ Error in transcription/summary pipeline:', error);
                        }

                        resolve(finalFilePath);
                    } else {
                        console.error(`❌ FFmpeg merge exited with code ${code}. Error: ${ffmpegError}`);
                        reject(new Error(`FFmpeg merge process exited with code ${code}. Error: ${ffmpegError}`));
                    }
                });
            });

            console.log('🎉 TEST recording completed successfully!');
            console.log(`📝 Final audio file: ${finalFilePath}`);
            console.log(`📊 Total segments processed: ${recordingState.allProcessedSegments.length}`);
            console.log('🔊 Perfect chronological conversation flow!');

        } catch (error) {
            console.error(`❌ Error creating final merge:`, error);
        }
    } else {
        console.log('⚠️ No segments were processed');
    }

    // Reset recording state
    recordingState.isRecording = false;
    recordingState.connection = null;
    recordingState.channelId = null;
    recordingState.channelName = null;
    recordingState.timestamp = null;
    recordingState.segmentCounter = 0;
    recordingState.activeStreams.clear();
    recordingState.allProcessedSegments = [];
    recordingState.attendees = [];
}

// Discord.js event handlers
client.once('ready', async () => {
    console.log(`🤖 TEST Bot logged in as ${client.user.tag}`);
    console.log(`📁 PCM Backup Folder: ${PCM_BACKUP_FOLDER}`);
    console.log(`📁 Segments Folder: ${SEGMENTS_FOLDER}`);

    // Check for existing meetings when bot starts up
    console.log('🔍 Checking for existing meetings...');

    for (const guild of client.guilds.cache.values()) {
        for (const channel of guild.channels.cache.values()) {
            if (channel.type === 2) { // Voice channel
                const membersCount = channel.members.filter(member => !member.user.bot).size;
                if (membersCount > 1) {
                    console.log(`👥 Found existing meeting in ${channel.name} with ${membersCount} members. Auto-joining for TEST recording...`);

                    try {
                        const connection = joinVoiceChannel({
                            channelId: channel.id,
                            guildId: guild.id,
                            adapterCreator: guild.voiceAdapterCreator,
                            selfDeaf: false,
                            selfMute: false
                        });
                        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
                        await startRecording(connection, guild, channel.id);
                        console.log(`✅ Auto-joined existing meeting in ${channel.name} for TEST recording`);
                    } catch (error) {
                        console.error(`❌ Failed to auto-join ${channel.name}:`, error);
                    }
                }
            }
        }
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
            await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
            await startRecording(connection, message.guild, voiceChannel.id);
            message.reply(`✅ Joined ${voiceChannel.name} and started TEST recording!`);
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
            voiceChannel.leave();
            message.reply('✅ Left voice channel and stopped TEST recording!');
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
            await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
            await startRecording(connection, guild, member.voice.channelId);

            await interaction.editReply({ content: '✅ Joined voice channel and started TEST recording!' });
        } else if (commandName === 'leave') {
            await interaction.deferReply({ ephemeral: true });

            if (recordingState.connection) {
                await stopRecording();
                await interaction.editReply({ content: '👋 Left voice channel and stopped TEST recording!' });
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
        console.log(`👥 User joined. There are now ${membersCount} members. Auto-joining channel for TEST recording...`);
        const newConnection = joinVoiceChannel({
            channelId: newState.channelId,
            guildId: newState.guild.id,
            adapterCreator: newState.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });
        entersState(newConnection, VoiceConnectionStatus.Ready, 30_000)
            .then(() => startRecording(newConnection, targetChannel.guild, targetChannel.id))
            .catch(err => console.error("❌ Failed to establish voice connection (Auto-Join TEST):", err));
    } else if (connection && connection.joinConfig.channelId === targetChannel.id) {
        if (membersCount <= 1) {
            console.log(`👋 User left/moved. Human count is ${membersCount}. Auto-leaving TEST recording.`);
            stopRecording().then(() => {
                connection.destroy();
                console.log('✅ Bot left voice channel automatically (TEST)');
            }).catch(error => {
                console.error('❌ Error during auto-stop TEST recording:', error);
                // Still try to leave the channel even if recording stop failed
                try {
                    connection.destroy();
                } catch (leaveError) {
                    console.error('❌ Error leaving voice channel (TEST):', leaveError);
                }
            });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
