#!/usr/bin/env node
/**
 * Standalone Cleanup Script
 * Runs uploader.js and deletes PCM files
 * Can be run manually or scheduled
 */

const { executeEndOfDayCleanup } = require('./scheduler.js');

(async () => {
    console.log('🧹 Starting cleanup process...');
    try {
        await executeEndOfDayCleanup();
        console.log('✅ Cleanup completed successfully!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Cleanup failed:', error);
        process.exit(1);
    }
})();

