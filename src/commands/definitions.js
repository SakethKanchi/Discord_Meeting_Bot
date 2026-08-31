import { SlashCommandBuilder, ChannelType, PermissionFlagsBits } from 'discord.js';
import { SUPPORTED_PROVIDERS } from '../adapters/summarizer/index.js';
import { WHISPER_MODELS } from './setup-logic.js';
import { STT_PROVIDERS, STT_MODELS } from '../adapters/stt/index.js';
import { LANGUAGES } from '../adapters/summarizer/languages.js';

// Discord caps a string option at 25 choices; the cloud STT model ids comfortably
// fit. Flatten every provider's models into one choice list for `stt_model`.
const STT_MODEL_CHOICES = [...new Set(Object.values(STT_MODELS).flat())];

export function buildCommands() {
  return [
    new SlashCommandBuilder().setName('join').setDescription('Join your voice channel and start recording'),
    new SlashCommandBuilder().setName('leave').setDescription('Stop recording and leave'),
    new SlashCommandBuilder().setName('summary').setDescription('Show notes for a meeting')
      .addIntegerOption((o) => o.setName('meeting').setDescription('Meeting id (default: most recent)')),
    new SlashCommandBuilder().setName('post').setDescription('Post a meeting summary publicly in this channel')
      .addIntegerOption((o) => o.setName('meeting').setDescription('Meeting id (default: most recent)')),
    new SlashCommandBuilder().setName('history').setDescription('List recent meetings'),
    new SlashCommandBuilder().setName('status').setDescription('Check bot status and current recording'),
    new SlashCommandBuilder().setName('raw').setDescription('Dump raw meeting data')
      .addIntegerOption((o) => o.setName('meeting').setDescription('Meeting id (default: most recent)')),
    new SlashCommandBuilder().setName('search').setDescription('Search past meetings')
      .addStringOption((o) => o.setName('keyword').setDescription('Word or phrase').setRequired(true)),
    new SlashCommandBuilder().setName('setup').setDescription('Configure the bot (admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((o) => o.setName('provider').setDescription('Summarizer provider')
        .addChoices(...SUPPORTED_PROVIDERS.map((p) => ({ name: p, value: p }))))
      .addStringOption((o) => o.setName('model').setDescription('Summarizer model name'))
      .addStringOption((o) => o.setName('fallback_provider').setDescription('Backup summarizer used only if the primary fails')
        .addChoices(...SUPPORTED_PROVIDERS.map((p) => ({ name: p, value: p })), { name: 'none', value: 'none' }))
      .addStringOption((o) => o.setName('fallback_model').setDescription('Backup summarizer model name'))
      .addStringOption((o) => o.setName('stt_provider').setDescription('Speech-to-text provider')
        .addChoices(...STT_PROVIDERS.map((p) => ({ name: p, value: p }))))
      .addStringOption((o) => o.setName('stt_model').setDescription('Cloud STT model (OpenAI)')
        .addChoices(...STT_MODEL_CHOICES.map((m) => ({ name: m, value: m }))))
      .addStringOption((o) => o.setName('whisper_model').setDescription('Whisper model size (local sidecar)')
        .addChoices(...WHISPER_MODELS.map((m) => ({ name: m, value: m }))))
      .addChannelOption((o) => o.setName('notes_channel').setDescription('Where to post notes').addChannelTypes(ChannelType.GuildText))
      .addBooleanOption((o) => o.setName('thread').setDescription('Post notes in a thread'))
      .addBooleanOption((o) => o.setName('autojoin').setDescription('Auto-join when 2+ people are in voice'))
      .addStringOption((o) => o.setName('language').setDescription('Spoken language (pick German to fix DE/EN mixing)')
        .addChoices(...LANGUAGES.map((l) => ({ name: l.name, value: l.code })), { name: 'Auto-detect', value: 'auto' }))
      .addStringOption((o) => o.setName('summary_language').setDescription('Language for the notes/summary')
        .addChoices(...LANGUAGES.map((l) => ({ name: l.name, value: l.code })), { name: 'Match transcription', value: 'match' })),
  ];
}

export function commandsJSON() {
  return buildCommands().map((c) => c.toJSON());
}

// UI-facing catalog of the slash commands (single source for the dashboard's
// Commands page). Kept next to buildCommands() so they stay in sync. `admin`
// marks commands gated behind the Manage Server permission; `args` is a short
// human description of the options.
export const COMMAND_CATALOG = [
  { name: 'join', category: 'Recording', admin: false, args: null,
    summary: 'Join your current voice channel and start recording.',
    detail: 'Parley joins the voice channel you are in and begins capturing a separate audio track per speaker. Its nickname shows [REC] while recording.' },
  { name: 'leave', category: 'Recording', admin: false, args: null,
    summary: 'Stop recording, transcribe, and post the notes.',
    detail: 'Ends the meeting, transcribes every track locally, and posts the structured notes to the configured channel or a thread.' },
  { name: 'status', category: 'Recording', admin: false, args: null,
    summary: 'Show whether the bot is recording, plus recent meetings.' },
  { name: 'summary', category: 'Notes', admin: false, args: '[meeting]',
    summary: 'Show the notes for a meeting (defaults to the most recent).',
    detail: 'Posts the TL;DR, topics, decisions, open questions, action items and talk-time for a meeting, only visible to you.' },
  { name: 'post', category: 'Notes', admin: false, args: '[meeting]',
    summary: 'Post a meeting summary publicly in this channel.',
    detail: 'Like /summary but posts the notes visibly (in a thread if threads are enabled) so the whole channel can see them.' },
  { name: 'history', category: 'Notes', admin: false, args: null,
    summary: 'List recent meetings with their status.' },
  { name: 'raw', category: 'Notes', admin: false, args: '[meeting]',
    summary: 'Dump raw meeting data: metadata, attendees, utterances, summary.',
    detail: 'A JSON dump for debugging or exporting a meeting.' },
  { name: 'search', category: 'Notes', admin: false, args: '<keyword>',
    summary: 'Full-text search across every past meeting transcript.' },
  { name: 'setup', category: 'Configuration', admin: true,
    args: '[provider] [model] [fallback_provider] [fallback_model] [stt_provider] [stt_model] [whisper_model] [notes_channel] [thread] [autojoin] [language] [summary_language]',
    summary: 'Configure the bot for this server (admin only).',
    detail: 'Set the summarizer provider/model, an optional fallback summarizer used only when the primary fails (set fallback_provider to "none" to disable), the speech-to-text provider (local sidecar or OpenAI) and model, notes channel, threading, auto-join, and languages. You can also do all of this from this dashboard under Settings.' },
];
;
