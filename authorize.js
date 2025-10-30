#!/usr/bin/env node

/**
 * Google OAuth2 Authorization Helper
 * 
 * This script helps you get the OAuth2 token for Google Drive access.
 * Run this once to authorize the app, then use uploader_oauth.js
 */

require('dotenv').config();
const { google } = require('googleapis');
const { readFileSync, writeFileSync, existsSync } = require('fs');

const OAUTH_CREDENTIALS_FILE = process.env.OAUTH_CREDENTIALS_FILE || './oauth_credentials.json';
const TOKEN_FILE = './token.json';

async function authorize() {
    try {
        if (!existsSync(OAUTH_CREDENTIALS_FILE)) {
            console.error('❌ OAuth credentials file not found.');
            console.log('📋 Please download oauth_credentials.json from Google Cloud Console:');
            console.log('   1. Go to https://console.cloud.google.com/');
            console.log('   2. Select your project');
            console.log('   3. Go to APIs & Services → Credentials');
            console.log('   4. Create OAuth client ID (Desktop application)');
            console.log('   5. Download the JSON file as oauth_credentials.json');
            process.exit(1);
        }

        const credentials = JSON.parse(readFileSync(OAUTH_CREDENTIALS_FILE, 'utf8'));
        const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: ['https://www.googleapis.com/auth/drive'],
        });

        console.log('🔐 Authorize this app by visiting this URL:');
        console.log('');
        console.log(authUrl);
        console.log('');
        console.log('📋 After authorization:');
        console.log('   1. Copy the authorization code from the URL');
        console.log('   2. Paste it here and press Enter');
        console.log('');

        // For simplicity, we'll use a manual approach
        console.log('💡 Alternative: Use Google OAuth2 Playground');
        console.log('   1. Go to https://developers.google.com/oauthplayground/');
        console.log('   2. Click the gear icon (settings)');
        console.log('   3. Check "Use your own OAuth credentials"');
        console.log('   4. Enter your Client ID and Client Secret');
        console.log('   5. Add scope: https://www.googleapis.com/auth/drive');
        console.log('   6. Authorize and get the refresh token');
        console.log('   7. Save the token as token.json in this format:');
        console.log('');
        console.log('{');
        console.log('  "access_token": "your_access_token",');
        console.log('  "refresh_token": "your_refresh_token",');
        console.log('  "scope": "https://www.googleapis.com/auth/drive",');
        console.log('  "token_type": "Bearer",');
        console.log('  "expiry_date": 1234567890123');
        console.log('}');

    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

authorize();

