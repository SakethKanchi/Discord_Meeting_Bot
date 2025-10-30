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

// Bot configuration from environment variables
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID; // Optional: if provided, uses guild-specific commands

if (!CLIENT_ID) {
    console.error('❌ DISCORD_CLIENT_ID is required in .env file');
    process.exit(1);
}

// Initialize REST client
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

// Deploy commands
(async () => {
    try {
        console.log('🔄 Started refreshing application (/) commands...');

        // Use guild-specific commands if GUILD_ID is provided, otherwise use global commands
        // Global commands persist across bot restarts and work in all servers
        // Guild-specific commands update instantly but only work in the specified server
        if (GUILD_ID) {
            console.log(`📝 Deploying guild-specific commands to guild: ${GUILD_ID}`);
            await rest.put(
                Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
                { body: commands },
            );
        } else {
            console.log('📝 Deploying global commands (available in all servers)');
            await rest.put(
                Routes.applicationCommands(CLIENT_ID),
                { body: commands },
            );
        }

        console.log('✅ Successfully reloaded application (/) commands!');
    } catch (error) {
        console.error('❌ Error deploying commands:', error);
    }
})();