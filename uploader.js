#!/usr/bin/env node
/**
 * Google Drive Uploader
 * Supports both Service Account (recommended for GCP) and OAuth2 authentication.
 *
 * Service Account (Recommended for GCP):
 *   - Uses GOOGLE_APPLICATION_CREDENTIALS environment variable
 *   - Or SERVICE_ACCOUNT_KEY_PATH environment variable
 *   - No OAuth flow needed, more secure
 *
 * OAuth2 (Fallback):
 *   - Uses credentials.json and token.json
 *   - Requires OAuth flow for initial setup
 *
 * Usage:
 *   node uploader.js                  # Upload all files in Summary/
 *   node uploader.js <filename>       # Upload a specific file
 *   node uploader.js --watch          # Watch folder for new files
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const mime = require('mime-types');

// --- Config ---
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

// Use persistent storage if available, otherwise use local directories
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : process.cwd());
const SUMMARY_FOLDER = path.join(DATA_DIR, 'Summary');
const FOLDER_ID = process.env.FOLDER_ID;

// Service Account paths (preferred for GCP)
const SERVICE_ACCOUNT_KEY_PATH = process.env.SERVICE_ACCOUNT_KEY_PATH || 
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.join(DATA_DIR, 'service-account-key.json');

// OAuth2 paths (fallback)
const CREDENTIALS_PATH = path.join(DATA_DIR, 'credentials.json');
const TOKEN_PATH = path.join(DATA_DIR, 'token.json');

// --- Ensure Summary folder exists ---
if (!fs.existsSync(SUMMARY_FOLDER)) {
    console.error('❌ Summary folder does not exist.');
    process.exit(1);
}

/**
 * Authenticate using Service Account (recommended for GCP)
 */
async function authenticateWithServiceAccount() {
    let keyPath = SERVICE_ACCOUNT_KEY_PATH;
    
    // Check if file exists
    if (!fs.existsSync(keyPath)) {
        return null;
    }

    try {
        console.log('🔐 Using Service Account authentication...');
        const auth = new google.auth.GoogleAuth({
            keyFile: keyPath,
            scopes: SCOPES,
        });
        
        const authClient = await auth.getClient();
        console.log('✅ Service Account authenticated successfully');
        return authClient;
    } catch (error) {
        console.error('❌ Service Account authentication failed:', error.message);
        return null;
    }
}

/**
 * Authenticate using OAuth2 (fallback method)
 */
async function authenticateWithOAuth2() {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        return null;
    }

    try {
        console.log('🔐 Using OAuth2 authentication...');
        const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
        
        // Check if it's OAuth2 credentials (has 'installed' or 'web' property)
        if (!credentials.installed && !credentials.web) {
            console.log('⚠️ credentials.json does not appear to be OAuth2 credentials');
            return null;
        }

        const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
        const oAuth2Client = new google.auth.OAuth2(
            client_id,
            client_secret,
            redirect_uris ? redirect_uris[0] : 'http://localhost'
        );

        if (fs.existsSync(TOKEN_PATH)) {
            try {
                const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
                oAuth2Client.setCredentials(token);
                console.log('✅ OAuth2 token loaded');
                return oAuth2Client;
            } catch (error) {
                console.log('⚠️ Error reading token file, will re-authenticate');
                if (fs.existsSync(TOKEN_PATH)) {
                    fs.unlinkSync(TOKEN_PATH);
                }
            }
        }

        // Generate new token
        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
        });
        console.log('👉 Authorize this app by visiting this URL:\n', authUrl);

        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        const code = await new Promise(resolve => {
            readline.question('Enter the code from that page here: ', code => {
                readline.close();
                resolve(code);
            });
        });

        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
        console.log('✅ Token stored to', TOKEN_PATH);

        return oAuth2Client;
    } catch (error) {
        console.error('❌ OAuth2 authentication failed:', error.message);
        return null;
    }
}

/**
 * Initialize Google Drive API with automatic authentication method selection
 */
async function initializeDrive() {
    // Try Service Account first (recommended for GCP)
    let auth = await authenticateWithServiceAccount();
    
    // Fallback to OAuth2 if Service Account not available
    if (!auth) {
        auth = await authenticateWithOAuth2();
    }

    if (!auth) {
        throw new Error(
            '❌ No authentication method available.\n' +
            'For GCP hosting (recommended):\n' +
            '  1. Create a Service Account in GCP Console\n' +
            '  2. Download the JSON key file\n' +
            '  3. Set SERVICE_ACCOUNT_KEY_PATH environment variable or place it as service-account-key.json\n' +
            '  4. Share your Google Drive folder with the service account email\n\n' +
            'For OAuth2 (fallback):\n' +
            '  1. Create OAuth2 credentials in GCP Console\n' +
            '  2. Download as credentials.json\n' +
            '  3. Run uploader.js to complete OAuth flow'
        );
    }

    return google.drive({ version: 'v3', auth });
}

/**
 * Upload file
 */
async function uploadFileToDrive(drive, filePath) {
    const fileName = path.basename(filePath);
    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
    const fileStream = fs.createReadStream(filePath);

    // Step 1: Check if file already exists in folder
    const existing = await drive.files.list({
        q: `name='${fileName}' and '${FOLDER_ID}' in parents and trashed=false`,
        fields: 'files(id, name)',
    });

    let fileId;
    if (existing.data.files.length > 0) {
        fileId = existing.data.files[0].id;
        console.log(`♻️ Found existing file, updating: ${fileName}`);

        // Step 2: Update existing file content
        await drive.files.update({
            fileId,
            media: { mimeType, body: fileStream },
        });
    } else {
        console.log(`📤 Uploading new file: ${fileName}`);
        const res = await drive.files.create({
            requestBody: { name: fileName, parents: [FOLDER_ID] },
            media: { mimeType, body: fileStream },
            fields: 'id, webViewLink',
        });
        fileId = res.data.id;
    }

    console.log(`✅ Uploaded: ${fileName} (ID: ${fileId})`);
}
/**
 * Upload all summaries
 */
async function uploadAllSummaries(drive) {
    const files = fs.readdirSync(SUMMARY_FOLDER).filter(
        f => fs.statSync(path.join(SUMMARY_FOLDER, f)).isFile()
    );

    if (files.length === 0) {
        console.log('ℹ️ No files found to upload.');
        return;
    }

    console.log(`📁 Found ${files.length} file(s) to upload.\n`);
    for (const file of files) {
        await uploadFileToDrive(drive, path.join(SUMMARY_FOLDER, file));
    }

    console.log('🎉 All uploads completed!');
}

/**
 * Watch folder for new files
 */
async function watchFolder(drive) {
    console.log('👀 Watching Summary folder for new files...');
    const uploaded = new Set(fs.readdirSync(SUMMARY_FOLDER));

    setInterval(async () => {
        const files = fs.readdirSync(SUMMARY_FOLDER);
        for (const file of files) {
            if (!uploaded.has(file)) {
                console.log(`🆕 New file detected: ${file}`);
                await uploadFileToDrive(drive, path.join(SUMMARY_FOLDER, file));
                uploaded.add(file);
            }
        }
    }, 5000);
}

/**
 * Check if error is a token expiration error (OAuth2 only)
 */
function isTokenError(error) {
    return error?.response?.data?.error === 'invalid_grant' ||
           error?.message?.includes('invalid_grant') ||
           (error?.code === 401 && fs.existsSync(TOKEN_PATH));
}

/**
 * Main
 */
(async () => {
    const args = process.argv.slice(2);
    let drive = await initializeDrive();

    try {
        if (args.length === 0) {
            await uploadAllSummaries(drive);
        } else if (args[0] === '--watch') {
            await watchFolder(drive);
        } else {
            const filePath = path.join(SUMMARY_FOLDER, args[0]);
            if (!fs.existsSync(filePath)) {
                console.error(`❌ File not found: ${args[0]}`);
                return;
            }
            await uploadFileToDrive(drive, filePath);
        }
    } catch (error) {
        // If token expired, delete it and re-authenticate
        if (isTokenError(error)) {
            console.log('⚠️ Token expired or revoked. Re-authenticating...');
            if (fs.existsSync(TOKEN_PATH)) {
                fs.unlinkSync(TOKEN_PATH);
            }
            drive = await initializeDrive();
            
            // Retry the operation
            if (args.length === 0) {
                await uploadAllSummaries(drive);
            } else if (args[0] === '--watch') {
                await watchFolder(drive);
            } else {
                const filePath = path.join(SUMMARY_FOLDER, args[0]);
                await uploadFileToDrive(drive, filePath);
            }
        } else {
            throw error;
        }
    }
})();
