/**
 * Configuration Settings for Discord Voice Recording Bot
 * 
 * This file contains all configurable settings for the bot's behavior.
 * Modify these values to change how the bot operates in different environments.
 */

const config = {
    // Pipeline Control
    RUN_FULL_PIPELINE: true,        // Set to true to run complete processing pipeline

    // File Management
    SAVE_TRANSCRIPT_LOCALLY: true,  // Save raw transcripts as text files
    KEEP_AUDIO_FOR_TESTING: true,   // Retain audio files for debugging/testing

    // AI Processing
    TEST_SUMMARY_LOCALLY: true,     // Use mock summaries instead of real AI (for testing)
};

module.exports = config;
