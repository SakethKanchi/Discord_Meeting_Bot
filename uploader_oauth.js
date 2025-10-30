#!/usr/bin/env node

/**
 * Google Drive Uploader Script (OAuth2 Version)
 * 
 * This script uploads summary files from the Summary folder to your personal Google Drive.
 * Uses OAuth2 authentication for personal Google accounts.
 * 
 * Usage:
 * - node uploader_oauth.js                    # Upload all summary files
 * - node uploader_oauth.js <filename>         # Upload specific file
 * - node uploader_oauth.js --watch            # Watch folder for new files
 */

// Load environment variables
require('dotenv').config();

// Import file system utilities
const {
    readdirSync,
    existsSync,
    statSync,
    readFileSync,
    writeFileSync
} = require('fs');

// Import Google APIs
const { google } = require('googleapis');

// Import path utilities
const path = require('path');

// Configuration
const OAUTH_CREDENTIALS_FILE = process.env.OAUTH_CREDENTIALS_FILE || './oauth_credentials.json';
const TOKEN_FILE = './token.json';
const FOLDER_ID = process.env.FOLDER_ID;
const SUMMARY_FOLDER = './Summary';

// Ensure Summary folder exists
if (!existsSync(SUMMARY_FOLDER)) {
    console.error('❌ Summary folder does not exist. Run processor.js first.');
    process.exit(1);
}

// Ensure OAuth credentials file exists
if (!existsSync(OAUTH_CREDENTIALS_FILE)) {
    console.error('❌ OAuth credentials file not found. Please download oauth_credentials.json from Google Cloud Console.');
    process.exit(1);
}

/**
 * Initialize Google Drive API with OAuth2
 * @returns {Object} Google Drive API instance
 */
async function initializeDriveAPI() {
    try {
        const credentials = JSON.parse(readFileSync(OAUTH_CREDENTIALS_FILE, 'utf8'));

        const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

        // Check if we have a previously stored token
        if (existsSync(TOKEN_FILE)) {
            const token = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
            oAuth2Client.setCredentials(token);
        } else {
            // Get new token
            const authUrl = oAuth2Client.generateAuthUrl({
                access_type: 'offline',
                scope: ['https://www.googleapis.com/auth/drive'],
            });

            console.log('🔐 Authorize this app by visiting this url:', authUrl);
            console.log('📋 After authorization, paste the code here:');

            // For now, we'll need to handle this manually
            // In a real app, you'd use a web server or read from stdin
            console.log('⚠️ Please run the authorization flow manually and save the token to token.json');
            console.log('💡 You can use the Google OAuth2 Playground: https://developers.google.com/oauthplayground/');
            process.exit(1);
        }

        const drive = google.drive({ version: 'v3', auth: oAuth2Client });
        console.log('✅ Google Drive API initialized with OAuth2');
        return drive;
    } catch (error) {
        console.error('❌ Failed to initialize Google Drive API:', error.message);
        throw error;
    }
}

/**
 * Upload a single file to Google Drive
 * @param {Object} drive - Google Drive API instance
 * @param {string} filePath - Path to the file to upload
 * @returns {Promise<string>} File ID of uploaded file
 */
async function uploadFileToDrive(drive, filePath) {
    try {
        const fileName = path.basename(filePath);
        console.log(`📤 Uploading ${fileName} to Google Drive...`);

        // Read file content
        const fileContent = readFileSync(filePath, 'utf8');

        // Upload file using simple text content
        const response = await drive.files.create({
            requestBody: {
                name: fileName,
                parents: FOLDER_ID ? [FOLDER_ID] : undefined,
                mimeType: 'text/plain',
            },
            media: {
                mimeType: 'text/plain',
                body: fileContent,
            },
            fields: 'id,name,webViewLink',
        });

        console.log(`✅ Successfully uploaded: ${fileName}`);
        console.log(`🔗 View at: ${response.data.webViewLink}`);

        return response.data.id;
    } catch (error) {
        console.error(`❌ Failed to upload ${filePath}:`, error.message);
        throw error;
    }
}

/**
 * Upload all summary files to Google Drive
 * @param {Object} drive - Google Drive API instance
 */
async function uploadAllSummaries(drive) {
    try {
        const files = readdirSync(SUMMARY_FOLDER).filter(file =>
            file.endsWith('.txt') && (file.includes('_summary') || file.includes('_meetings'))
        );

        if (files.length === 0) {
            console.log('ℹ️ No summary files found to upload');
            return;
        }

        console.log(`📁 Found ${files.length} file(s) to upload`);

        for (const file of files) {
            const filePath = path.join(SUMMARY_FOLDER, file);
            try {
                await uploadFileToDrive(drive, filePath);
            } catch (error) {
                console.error(`❌ Failed to upload ${file}:`, error.message);
            }
        }

        console.log('🎉 Upload process completed!');
    } catch (error) {
        console.error('❌ Error during upload process:', error.message);
    }
}

/**
 * Upload a specific file
 * @param {Object} drive - Google Drive API instance
 * @param {string} fileName - Name of the file to upload
 */
async function uploadSpecificFile(drive, fileName) {
    const filePath = path.join(SUMMARY_FOLDER, fileName);

    if (!existsSync(filePath)) {
        console.error(`❌ File not found: ${filePath}`);
        return;
    }

    try {
        await uploadFileToDrive(drive, filePath);
    } catch (error) {
        console.error(`❌ Failed to upload ${fileName}:`, error.message);
    }
}

/**
 * Watch folder for new files and upload them automatically
 * @param {Object} drive - Google Drive API instance
 */
async function watchFolder(drive) {
    console.log('👀 Watching Summary folder for new files...');

    const uploadedFiles = new Set();

    // Initial scan
    const initialFiles = readdirSync(SUMMARY_FOLDER).filter(file =>
        file.endsWith('.txt') && (file.includes('_summary') || file.includes('_meetings'))
    );

    initialFiles.forEach(file => uploadedFiles.add(file));
    console.log(`📋 Found ${initialFiles.length} existing files (will not re-upload)`);

    // Watch for changes
    setInterval(async () => {
        try {
            const currentFiles = readdirSync(SUMMARY_FOLDER).filter(file =>
                file.endsWith('.txt') && (file.includes('_summary') || file.includes('_meetings'))
            );

            const newFiles = currentFiles.filter(file => !uploadedFiles.has(file));

            for (const file of newFiles) {
                console.log(`🆕 New file detected: ${file}`);
                await uploadFileToDrive(drive, path.join(SUMMARY_FOLDER, file));
                uploadedFiles.add(file);
            }
        } catch (error) {
            console.error('❌ Error during folder watch:', error.message);
        }
    }, 5000); // Check every 5 seconds
}

/**
 * Main function
 */
async function main() {
    const args = process.argv.slice(2);

    try {
        const drive = await initializeDriveAPI();

        if (args.length === 0) {
            // Upload all files
            await uploadAllSummaries(drive);
        } else if (args[0] === '--watch') {
            // Watch mode
            await watchFolder(drive);
        } else {
            // Upload specific file
            await uploadSpecificFile(drive, args[0]);
        }
    } catch (error) {
        console.error('❌ Fatal error:', error.message);
        process.exit(1);
    }
}

// Run the script
if (require.main === module) {
    main();
}

module.exports = {
    uploadFileToDrive,
    uploadAllSummaries,
    initializeDriveAPI
};

