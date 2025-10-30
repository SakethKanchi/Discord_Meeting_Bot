/**
 * Centralized Discord Slash Commands Definitions
 * 
 * This file contains all slash command definitions for the Discord bot.
 * Commands are automatically deployed when the bot starts up.
 */

const { SlashCommandBuilder } = require('discord.js');

/**
 * All slash commands for the voice recording bot
 */
const commands = [
    new SlashCommandBuilder()
        .setName('join')
        .setDescription('Makes the bot join your current voice channel and start recording'),

    new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Makes the bot leave the current voice channel and stop recording'),
];

/**
 * Export commands as JSON for deployment
 */
module.exports = {
    commands: commands.map(command => command.toJSON()),
    rawCommands: commands
};
