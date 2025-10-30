/**
 * Discord Voice Recording Bot
 *
 * This bot's sole responsibility is to join voice channels and record audio.
 * The processing (merging, transcription, summarization) is handled by a separate script.
 */

// Load environment variables
require('dotenv').config();

// Import required Discord.js classes
const { Client, GatewayIntentBits } = require('discord.js');
const {
    getVoiceConnection,
    joinVoiceChannel,
    entersState,
    VoiceConnectionStatus
} = require('@discordjs/voice');

// Import file system utilities
const { createWriteStream, readdirSync, unlinkSync, existsSync, mkdirSync, copyFileSync } = require('fs');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

// Import audio processing libraries
const prism = require('prism-media');

// Global state variables for recording session
let recordingState = {
    channelName: '',
    attendees: [],
    timestamp: '',
    processingInterval: null,
    segmentCounter: 0,
    allSegments: []
};

// Create Discord client with required intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

// Bot ready event handler
client.once('clientReady', () => {
    console.log(`✅ Bot ready! Logged in as ${client.user.tag}`);
});

/**
 * Backs up PCM files to a backup directory before processing
 * @param {string[]} pcmFiles - Array of PCM file paths to backup
 * @param {string} segmentKey - Unique identifier for this segment
 * @returns {string} Path to backup directory
 */
function backupPcmFiles(pcmFiles, segmentKey) {
    const backupDir = `./PCM_Backups/${segmentKey}`;

    // Create backup directory if it doesn't exist
    if (!existsSync('./PCM_Backups')) {
        mkdirSync('./PCM_Backups', { recursive: true });
        console.log('📁 Created PCM_Backups directory');
    }

    if (!existsSync(backupDir)) {
        mkdirSync(backupDir, { recursive: true });
        console.log(`📁 Created backup directory: ${backupDir}`);
    }

    // Copy each PCM file to backup directory
    pcmFiles.forEach(file => {
        try {
            const backupPath = `${backupDir}/${file}`;
            copyFileSync(file, backupPath);
            console.log(`💾 Backed up: ${file} → ${backupPath}`);
        } catch (error) {
            console.error(`❌ Failed to backup ${file}:`, error.message);
        }
    });

    console.log(`✅ Backed up ${pcmFiles.length} PCM files to ${backupDir}`);
    return backupDir;
}

/**
 * Tests if a PCM file is valid and can be processed
 * @param {string} pcmPath - Path to PCM file
 * @returns {Promise<boolean>} True if file is valid
 */
function testPcmFile(pcmPath) {
    return new Promise((resolve) => {
        const ffmpeg = spawn(ffmpegPath, [
            '-f', 's16le',
            '-ar', '16000',
            '-ac', '1',
            '-i', pcmPath,
            '-t', '0.1', // Test only first 0.1 seconds
            '-f', 'null',
            '-'
        ]);

        let hasError = false;

        ffmpeg.stderr.on('data', (data) => {
            const output = data.toString();
            if (output.includes('Invalid data') || output.includes('error')) {
                hasError = true;
            }
        });

        ffmpeg.on('close', (code) => {
            resolve(code === 0 && !hasError);
        });

        ffmpeg.on('error', () => {
            resolve(false);
        });
    });
}

/**
 * Merges multiple WAV files into one
 * @param {string[]} wavFiles - Array of WAV file paths
 * @param {string} outputFile - Output file path
 * @returns {Promise<string>} Path to merged file
 */
async function mergeWavFiles(wavFiles, outputFile) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn(ffmpegPath, [
            '-y',
            ...wavFiles.flatMap(file => ['-i', file]),
            '-filter_complex', `concat=n=${wavFiles.length}:v=0:a=1[out]`,
            '-map', '[out]',
            '-ac', '1',        // Mono channel
            '-ar', '16000',    // 16kHz sample rate
            '-sample_fmt', 's16', // 16-bit samples
            outputFile
        ]);

        let ffmpegError = '';

        ffmpeg.stderr.on('data', (data) => {
            const errorMsg = data.toString();
            ffmpegError += errorMsg;
        });

        ffmpeg.on('error', (error) => {
            console.error(`❌ FFmpeg process error:`, error);
            reject(new Error(`FFmpeg process error: ${error.message}`));
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                console.log(`✅ Successfully concatenated ${wavFiles.length} WAV files`);
                resolve(outputFile);
            } else {
                console.error(`❌ FFmpeg concatenation failed with code ${code}`);
                reject(new Error(`FFmpeg concatenation process exited with code ${code}. Error: ${ffmpegError}`));
            }
        });
    });
}

/**
 * Processes PCM files from the current 5-minute segment and converts them to WAV
 * @param {string} segmentKey - Unique identifier for this segment
 * @returns {Promise<string>} Path to the merged WAV file
 */
async function processSegment(segmentKey) {
    console.log(`🔄 Processing segment ${segmentKey}...`);

    // Find all PCM files for this segment
    const files = readdirSync('./').filter(file =>
        file.includes(segmentKey) && file.endsWith('.pcm')
    );

    if (files.length === 0) {
        console.log(`⚠️ No PCM files found for segment ${segmentKey}`);
        return null;
    }

    // Filter out empty files and test validity
    const validFiles = [];
    for (const file of files) {
        try {
            const stats = require('fs').statSync(file);
            if (stats.size === 0) {
                console.log(`⚠️ Skipping empty file: ${file}`);
                continue;
            }

            console.log(`🧪 Testing file: ${file}`);
            const isValid = await testPcmFile(file);
            if (isValid) {
                validFiles.push(file);
                console.log(`✅ Valid file: ${file}`);
            } else {
                console.log(`❌ Invalid file: ${file}`);
            }
        } catch (err) {
            console.warn(`⚠️ Error checking file ${file}:`, err.message);
        }
    }

    if (validFiles.length === 0) {
        console.log(`⚠️ No valid PCM files found for segment ${segmentKey}`);
        return null;
    }

    console.log(`📁 Found ${validFiles.length} valid PCM files for segment ${segmentKey}`);

    // Backup PCM files before processing
    const backupDir = backupPcmFiles(validFiles, segmentKey);

    // Sort files chronologically by timestamp with better parsing
    validFiles.sort((a, b) => {
        // Extract timestamp from filename: ..._username_timestamp.pcm
        const timestampA = parseInt(a.split('_').pop().replace('.pcm', ''));
        const timestampB = parseInt(b.split('_').pop().replace('.pcm', ''));

        // If timestamps are equal, sort by filename to ensure consistent ordering
        if (timestampA === timestampB) {
            return a.localeCompare(b);
        }

        return timestampA - timestampB;
    });

    console.log(`📊 Sorted files chronologically. First: ${validFiles[0]}, Last: ${validFiles[validFiles.length - 1]}`);

    const wavFile = `${segmentKey}.wav`;

    if (validFiles.length === 1) {
        // Single file - just convert directly
        console.log(`📄 Single file detected, converting directly...`);
        try {
            await convertPcmToWav(validFiles[0], wavFile);
            console.log(`✅ Segment ${segmentKey} processed successfully`);
            return wavFile;
        } catch (error) {
            console.error(`❌ Error converting single file:`, error.message);
            return null;
        }
    } else {
        // Multiple files - convert each to WAV first, then concatenate
        console.log(`🔄 Converting ${validFiles.length} PCM files to WAV first...`);

        const tempWavFiles = [];

        for (let i = 0; i < validFiles.length; i++) {
            const tempWavFile = `${segmentKey}_temp_${i}.wav`;
            try {
                await convertPcmToWav(validFiles[i], tempWavFile);
                tempWavFiles.push(tempWavFile);
                console.log(`✅ Converted file ${i + 1}/${validFiles.length}`);
            } catch (error) {
                console.error(`❌ Failed to convert ${validFiles[i]}:`, error.message);
            }
        }

        if (tempWavFiles.length === 0) {
            console.log(`⚠️ No files were successfully converted for segment ${segmentKey}`);
            return null;
        }

        if (tempWavFiles.length === 1) {
            // Only one file converted successfully, rename it
            const fs = require('fs');
            fs.renameSync(tempWavFiles[0], wavFile);
            console.log(`✅ Segment ${segmentKey} processed successfully (single file)`);
            return wavFile;
        }

        // Concatenate multiple WAV files
        console.log(`🔄 Concatenating ${tempWavFiles.length} WAV files...`);

        try {
            await mergeWavFiles(tempWavFiles, wavFile);

            // Clean up temp files
            tempWavFiles.forEach(file => {
                try {
                    unlinkSync(file);
                } catch (err) {
                    console.error(`❌ Failed to delete temp file ${file}:`, err);
                }
            });

            console.log(`✅ Segment ${segmentKey} processed successfully`);
            return wavFile;
        } catch (error) {
            console.error(`❌ Error concatenating WAV files:`, error.message);

            // Clean up temp files
            tempWavFiles.forEach(file => {
                try {
                    unlinkSync(file);
                } catch (err) {
                    console.error(`❌ Failed to delete temp file ${file}:`, err);
                }
            });

            return null;
        }
    }
}

/**
 * Converts PCM file to WAV format.
 * @param {string} pcmPath - Path to input PCM file
 * @param {string} wavPath - Path to output WAV file
 * @returns {Promise<string>} Path to converted WAV file
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
            '-ac', '1',        // Mono channel
            '-ar', '16000',    // 16kHz sample rate
            '-sample_fmt', 's16', // 16-bit samples
            // NO SILENCE REMOVAL - keep original audio quality
            wavPath
        ]);

        let ffmpegError = '';

        ffmpeg.stderr.on('data', (data) => {
            const errorMsg = data.toString();
            ffmpegError += errorMsg;
            console.log(`FFmpeg Log: ${errorMsg}`);
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
                console.error(`❌ FFmpeg exited with code ${code}.`);
                console.error(`FFmpeg Error Output: ${ffmpegError}`);
                reject(new Error(`FFmpeg process exited with code ${code}. Error: ${ffmpegError}`));
            }
        });
    });
}

/**
 * Merges all WAV segments into a final audio file
 * @param {string[]} segmentFiles - Array of WAV segment file paths
 * @param {string} finalFileName - Name for the final merged file
 * @returns {Promise<string>} Path to the final merged WAV file
 */
async function mergeAllSegments(segmentFiles, finalFileName) {
    return new Promise((resolve, reject) => {
        if (segmentFiles.length === 0) {
            reject(new Error('No segments to merge'));
            return;
        }

        console.log(`🔄 Merging ${segmentFiles.length} segments into final audio...`);

        const ffmpeg = spawn(ffmpegPath, [
            '-y',
            ...segmentFiles.flatMap(file => ['-i', file]),
            '-filter_complex', `concat=n=${segmentFiles.length}:v=0:a=1[out]`,
            '-map', '[out]',
            '-ac', '1',        // Mono channel
            '-ar', '16000',    // 16kHz sample rate
            '-sample_fmt', 's16', // 16-bit samples
            finalFileName
        ]);

        let ffmpegError = '';

        ffmpeg.stderr.on('data', (data) => {
            const errorMsg = data.toString();
            ffmpegError += errorMsg;
            console.log(`FFmpeg Log: ${errorMsg}`);
        });

        ffmpeg.on('error', (error) => {
            console.error(`❌ FFmpeg process error:`, error);
            reject(new Error(`FFmpeg process error: ${error.message}`));
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                console.log('✅ Final audio merge successful');

                // Clean up segment files
                segmentFiles.forEach(file => {
                    try {
                        unlinkSync(file);
                    } catch (err) {
                        console.error(`❌ Failed to delete segment ${file}:`, err);
                    }
                });

                resolve(finalFileName);
            } else {
                console.error(`❌ FFmpeg merge exited with code ${code}.`);
                console.error(`FFmpeg Error Output: ${ffmpegError}`);
                reject(new Error(`FFmpeg merge process exited with code ${code}. Error: ${ffmpegError}`));
            }
        });
    });
}

/**
 * Starts recording audio from a voice channel by capturing individual streams.
 * @param {Object} connection - Discord voice connection
 * @param {Object} guild - Discord guild object
 * @param {string} channelId - Voice channel ID to record
 */
function startRecording(connection, guild, channelId) {
    const channel = guild.channels.cache.get(channelId);

    if (!channel) {
        console.error('❌ Error: Could not find channel object for recording');
        return;
    }

    const receiver = connection.receiver;
    recordingState.channelName = channel.name.replace(/[^a-zA-Z0-9]/g, '_');
    recordingState.attendees = channel.members
        .filter(member => !member.user.bot)
        .map(member => member.displayName);

    // Store a single meeting timestamp for all individual files
    recordingState.timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    recordingState.segmentCounter = 0;
    recordingState.allSegments = [];

    console.log(`🎙️ Starting recording individual PCM files for meeting at ${recordingState.timestamp}...`);

    // Start 5-minute processing interval
    recordingState.processingInterval = setInterval(async () => {
        console.log(`⏰ 5-minute interval reached. Processing segment ${recordingState.segmentCounter}...`);
        console.log(`📊 Current segment key: ${recordingState.channelName}_${recordingState.timestamp}_segment_${recordingState.segmentCounter}`);

        // Process the current segment BEFORE incrementing counter
        const segmentKey = `${recordingState.channelName}_${recordingState.timestamp}_segment_${recordingState.segmentCounter}`;

        try {
            const segmentFile = await processSegment(segmentKey);
            if (segmentFile) {
                recordingState.allSegments.push(segmentFile);
                console.log(`✅ Segment ${recordingState.segmentCounter} processed and added to final merge list`);
            } else {
                console.log(`⚠️ Segment ${recordingState.segmentCounter} processing returned null`);
            }
        } catch (error) {
            console.error(`❌ Error processing segment ${recordingState.segmentCounter}:`, error);
        }

        // Increment counter AFTER processing
        recordingState.segmentCounter++;
        console.log(`📊 Now recording to segment ${recordingState.segmentCounter}`);
        console.log(`📊 Total segments processed: ${recordingState.allSegments.length}`);
    }, 5 * 60 * 1000); // 5 minutes in milliseconds

    // Set max listeners to prevent memory leak warnings
    receiver.speaking.setMaxListeners(50);

    // Store active streams for cleanup
    const activeStreams = new Map();

    const speakingStartHandler = (userId) => {
        const user = client.users.cache.get(userId);
        if (user.bot) return;

        console.log(`🎤 ${user.displayName} started speaking`);

        try {
            // Create a unique file for this specific user's speaking session with segment info
            const userPcmFile = `${recordingState.channelName}_${recordingState.timestamp}_segment_${recordingState.segmentCounter}_${user.displayName.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.pcm`;
            const userOutputStream = createWriteStream(userPcmFile);

            // Subscribe to the audio stream
            const audioStream = receiver.subscribe(userId, { end: { behavior: 'manual' } });

            // Set max listeners for this stream
            audioStream.setMaxListeners(20);

            // Decode the Opus stream to PCM with optimized settings for voice
            const transcoder = new prism.opus.Decoder({ rate: 16000, channels: 1, frameSize: 320 });

            audioStream.pipe(transcoder).pipe(userOutputStream);

            // Store stream info for cleanup
            activeStreams.set(userId, {
                audioStream,
                transcoder,
                userOutputStream,
                userDisplayName: user.displayName
            });

            const errorHandler = (error) => console.error(`❌ Audio stream error for ${user.displayName}:`, error);
            const transcoderErrorHandler = (error) => console.error(`❌ Transcoder error for ${user.displayName}:`, error);

            audioStream.on('error', errorHandler);
            transcoder.on('error', transcoderErrorHandler);

            const endHandler = () => {
                console.log(`🔇 ${user.displayName} stopped speaking`);

                // Properly end the output stream
                userOutputStream.end();

                // Destroy the audio stream to stop recording
                audioStream.destroy();

                // Clean up listeners and remove from active streams
                audioStream.removeListener('error', errorHandler);
                transcoder.removeListener('error', transcoderErrorHandler);
                audioStream.removeListener('end', endHandler);

                activeStreams.delete(userId);
            };

            // Set up automatic stream ending when user stops speaking
            audioStream.on('end', endHandler);

            // Also set up a timeout to prevent streams from running too long
            const streamTimeout = setTimeout(() => {
                console.log(`⏰ Stream timeout for ${user.displayName}, ending stream`);
                endHandler();
            }, 30000); // 30 second timeout

            // Clear timeout when stream ends naturally
            audioStream.on('end', () => {
                clearTimeout(streamTimeout);
            });

        } catch (error) {
            console.error(`❌ Failed to subscribe to ${user.displayName}:`, error);
        }
    };

    receiver.speaking.on('start', speakingStartHandler);

    // Store cleanup function for later use
    recordingState.cleanup = () => {
        // Clear the processing interval
        if (recordingState.processingInterval) {
            clearInterval(recordingState.processingInterval);
            recordingState.processingInterval = null;
        }

        receiver.speaking.removeListener('start', speakingStartHandler);

        // Clean up any remaining active streams
        for (const [userId, streamInfo] of activeStreams) {
            try {
                streamInfo.audioStream.destroy();
                streamInfo.userOutputStream.end();
                console.log(`🧹 Cleaned up stream for user ${streamInfo.userDisplayName}`);
            } catch (error) {
                console.error(`❌ Error cleaning up stream for user ${streamInfo.userDisplayName}:`, error);
            }
        }
        activeStreams.clear();
    };
}

/**
 * Stops recording and disconnects from voice channel.
 * @param {Object} connection - Discord voice connection
 */
async function stopRecording(connection) {
    console.log('🛑 Stopping recording and disconnecting...');

    // Clean up event listeners and streams
    if (recordingState.cleanup) {
        recordingState.cleanup();
        recordingState.cleanup = null;
    }

    // Process any remaining PCM files from the current segment
    const currentSegmentKey = `${recordingState.channelName}_${recordingState.timestamp}_segment_${recordingState.segmentCounter}`;
    console.log(`🔄 Processing final segment ${recordingState.segmentCounter}...`);

    try {
        const finalSegmentFile = await processSegment(currentSegmentKey);
        if (finalSegmentFile) {
            recordingState.allSegments.push(finalSegmentFile);
            console.log(`✅ Final segment processed and added to merge list`);
        } else {
            console.log(`⚠️ Final segment processing returned null`);
        }
    } catch (error) {
        console.error(`❌ Error processing final segment:`, error);
    }

    // Merge all segments into final audio file
    if (recordingState.allSegments.length > 0) {
        console.log(`🔄 Merging ${recordingState.allSegments.length} segments into final audio...`);
        try {
            // Ensure Recordings directory exists
            if (!existsSync('./Recordings')) {
                mkdirSync('./Recordings', { recursive: true });
                console.log('📁 Created Recordings directory');
            }

            const finalAudioFile = `./Recordings/${recordingState.channelName}_${recordingState.timestamp}_final.wav`;
            await mergeAllSegments(recordingState.allSegments, finalAudioFile);

            // Create metadata file with attendee information
            const metadataFile = `./Recordings/${recordingState.channelName}_${recordingState.timestamp}_metadata.json`;
            const metadata = {
                channelName: recordingState.channelName,
                attendees: recordingState.attendees,
                timestamp: recordingState.timestamp,
                recordingDate: new Date().toISOString()
            };

            const fs = require('fs');
            fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));

            console.log(`✅ Final audio file created: ${finalAudioFile}`);
            console.log(`✅ Metadata file created: ${metadataFile}`);
            console.log(`📝 Run the processor script to transcribe: ${finalAudioFile}`);
        } catch (error) {
            console.error(`❌ Error merging final segments:`, error);
        }
    } else {
        console.log(`⚠️ No segments were processed during this recording session`);
    }

    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
        try {
            connection.destroy();
            console.log('🛑 Destroyed connection. Final audio file ready for transcription.');
        } catch (error) {
            console.warn('⚠️ Connection was already destroyed or error during destruction:', error.message);
        }
    }
}

// Handle slash command interactions
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;
    const { commandName, member, guild } = interaction;

    try {
        if (commandName === 'join') {
            if (!member.voice.channelId) {
                return interaction.reply({
                    content: '❌ You must be in a voice channel to use this command.',
                    flags: 64 // EPHEMERAL flag
                });
            }
            await interaction.deferReply({ flags: 64 }); // EPHEMERAL flag
            const connection = joinVoiceChannel({ channelId: member.voice.channelId, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
            await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
            startRecording(connection, guild, member.voice.channelId);
            await interaction.editReply({ content: '✅ Joined voice channel and started recording!' });
        } else if (commandName === 'leave') {
            await interaction.deferReply({ flags: 64 }); // EPHEMERAL flag
            const connection = getVoiceConnection(guild.id);
            if (connection) {
                await stopRecording(connection);
                await interaction.editReply({ content: '👋 Left voice channel and stopped recording!' });
            } else {
                await interaction.editReply({ content: "❌ I'm not currently in a voice channel." });
            }
        }
    } catch (error) {
        console.error('❌ Error during interaction:', error);
        const errorMessage = '❌ An unexpected error occurred. Please try again.';
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: errorMessage, flags: 64 }).catch(e => console.error('Failed to edit reply:', e));
        } else {
            await interaction.reply({ content: errorMessage, flags: 64 }).catch(e => console.error('Failed to send reply:', e));
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
        console.log(`👥 User joined. There are now ${membersCount} members. Joining channel...`);
        const newConnection = joinVoiceChannel({ channelId: newState.channelId, guildId: newState.guild.id, adapterCreator: newState.guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
        entersState(newConnection, VoiceConnectionStatus.Ready, 30_000)
            .then(() => startRecording(newConnection, targetChannel.guild, targetChannel.id))
            .catch(err => console.error("❌ Failed to establish voice connection (Auto-Join):", err));
    } else if (connection && connection.joinConfig.channelId === targetChannel.id) {
        if (membersCount <= 1) {
            console.log(`👋 User left/moved. Human count is ${membersCount}. Bot is leaving.`);
            stopRecording(connection).catch(error => {
                console.error('❌ Error during auto-stop recording:', error);
            });
        }
    }
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);