/**
 * Scheduler Module
 * Manages bot operation hours (6 AM - 4 PM)
 * Handles automatic shutdown and cleanup at 4 PM
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { cleanupTemporarySummaryFiles } = require('./processor.js');

// Configuration
const START_HOUR = 6;  // 6 AM
const END_HOUR = 16;   // 4 PM (16:00)

// Use persistent storage if available, otherwise use local directories
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : process.cwd());
const PCM_FOLDER = path.join(DATA_DIR, 'PCM_Files');
const CHECK_INTERVAL = 60000; // Check every minute

let shutdownCallback = null;
let isOperatingHours = false;

/**
 * Get current time in 24-hour format
 */
function getCurrentHour() {
    const now = new Date();
    return now.getHours();
}

/**
 * Check if current time is within operating hours (6 AM - 4 PM)
 */
function isWithinOperatingHours() {
    const hour = getCurrentHour();
    return hour >= START_HOUR && hour < END_HOUR;
}

/**
 * Clean up PCM files
 */
function cleanupPCMFiles() {
    console.log('🧹 Cleaning up PCM files...');

    if (!fs.existsSync(PCM_FOLDER)) {
        console.log('ℹ️ PCM_Files folder does not exist. Skipping cleanup.');
        return;
    }

    try {
        const files = fs.readdirSync(PCM_FOLDER);
        let deletedCount = 0;

        files.forEach(file => {
            const filePath = path.join(PCM_FOLDER, file);
            try {
                if (fs.statSync(filePath).isFile()) {
                    fs.unlinkSync(filePath);
                    deletedCount++;
                }
            } catch (err) {
                console.error(`⚠️ Error deleting ${file}:`, err.message);
            }
        });

        console.log(`✅ Deleted ${deletedCount} PCM file(s)`);
    } catch (error) {
        console.error('❌ Error during PCM cleanup:', error.message);
    }
}

/**
 * Run uploader script
 */
async function runUploader() {
    return new Promise((resolve, reject) => {
        console.log('📤 Running uploader.js...');

        const uploader = spawn('node', ['uploader.js'], {
            cwd: process.cwd(),
            stdio: 'inherit'
        });

        uploader.on('error', (error) => {
            console.error('❌ Error spawning uploader process:', error);
            reject(error);
        });

        uploader.on('close', (code) => {
            if (code === 0) {
                console.log('✅ Uploader completed successfully');
                resolve();
            } else {
                console.error(`❌ Uploader exited with code ${code}`);
                reject(new Error(`Uploader exited with code ${code}`));
            }
        });
    });
}

/**
 * Execute end-of-day cleanup
 */
async function executeEndOfDayCleanup() {
    console.log('🕐 End of day reached (4 PM). Starting cleanup...');

    try {
        // Step 1: Run uploader
        await runUploader();

        // Step 2: Clean up PCM files
        cleanupPCMFiles();

        // Step 3: Clean up temporary summary files
        cleanupTemporarySummaryFiles();

        console.log('✅ End of day cleanup completed!');
    } catch (error) {
        console.error('❌ Error during end of day cleanup:', error);
        // Re-throw the error so callers can handle it properly
        throw error;
    }
}

/**
 * Initialize scheduler
 * @param {Function} onShutdown - Callback to execute when shutdown is needed
 */
function initializeScheduler(onShutdown) {
    shutdownCallback = onShutdown;

    // Check immediately
    checkOperatingHours();

    // Then check every minute
    setInterval(checkOperatingHours, CHECK_INTERVAL);

    console.log(`⏰ Scheduler initialized: Bot will operate from ${START_HOUR}:00 to ${END_HOUR}:00`);
}

/**
 * Check if we're within operating hours and handle shutdown
 */
function checkOperatingHours() {
    const currentlyWithinHours = isWithinOperatingHours();

    // If we just entered operating hours
    if (currentlyWithinHours && !isOperatingHours) {
        console.log('✅ Entered operating hours. Bot is active.');
        isOperatingHours = true;
    }

    // If we just left operating hours (hit 4 PM)
    if (!currentlyWithinHours && isOperatingHours) {
        console.log('🕐 Left operating hours. Initiating shutdown...');
        isOperatingHours = false;

        // Execute cleanup
        executeEndOfDayCleanup().finally(() => {
            // After cleanup, trigger shutdown
            if (shutdownCallback) {
                shutdownCallback();
            }
        });
    }

    // Update current state
    isOperatingHours = currentlyWithinHours;
}

/**
 * Check if bot should be active (for preventing recording outside hours)
 */
function shouldBeActive() {
    return isWithinOperatingHours();
}

module.exports = {
    initializeScheduler,
    shouldBeActive,
    isWithinOperatingHours,
    executeEndOfDayCleanup,
    cleanupPCMFiles,
    runUploader
};

