/**
 * Discord Slash Commands Deployment Script
 * 
 * This script registers slash commands with Discord for the voice recording bot.
 * Run this script whenever you modify command definitions or deploy to a new server.
 * 
 * Commands:
 * - /join: Makes the bot join your current voice channel
 * - /leave: Makes the bot leave the current voice channel
 */

// Load environment variables
require('dotenv').config();

// Import Discord.js REST API utilities
const { REST, Routes } = require('discord.js');
const { commands } = require('./commands.js');

// Bot configuration
const CLIENT_ID = '857110513988141096';
const GUILD_ID = '1362914118918602893'; // Sidequest server
// Alternative Guild ID for Solitude: 980738073283403786

// Initialize REST client
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

// Deploy commands
(async () => {
    try {
        console.log('🔄 Started refreshing application (/) commands...');

        // Use global commands instead of guild-specific commands
        // Global commands persist across bot restarts and don't need redeployment
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands },
        );

        console.log('✅ Successfully reloaded application (/) commands!');
    } catch (error) {
        console.error('❌ Error deploying commands:', error);
    }
})();