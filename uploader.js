#!/usr/bin/env node
/**
 * Google Drive OAuth2 Uploader
 * Works with personal Google Drive accounts.
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
const CREDENTIALS_PATH = './credentials.json';
const TOKEN_PATH = './token.json';
const SUMMARY_FOLDER = './Summary';
const FOLDER_ID = process.env.FOLDER_ID;

// --- Ensure Summary folder exists ---
if (!fs.existsSync(SUMMARY_FOLDER)) {
    console.error('❌ Summary folder does not exist.');
    process.exit(1);
}

/**
 * Load or request authorization
 */
async function authorize() {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirect_uris[0]
    );

    if (fs.existsSync(TOKEN_PATH)) {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
        oAuth2Client.setCredentials(token);
        return oAuth2Client;
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
}

/**
 * Initialize Google Drive API
 */
async function initializeDrive() {
    const auth = await authorize();
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
 * Main
 */
(async () => {
    const args = process.argv.slice(2);
    const drive = await initializeDrive();

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
})();
