/**
 * Summary Processing Pipeline
 *
 * This module processes meeting summaries from the bot.
 * It focuses on generating and saving meeting summaries with attendee information.
 */

// Load environment variables
require('dotenv').config();

// Import file system utilities
const {
    existsSync,
    readdirSync,
    promises: fsPromises,
    mkdirSync
} = require('fs');

// Import AI services
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Folder paths
const SUMMARY_FOLDER = './Summary';

// Ensure folders exist
if (!existsSync(SUMMARY_FOLDER)) mkdirSync(SUMMARY_FOLDER);

// Initialize Gemini AI client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Summarizes a transcript using Google Gemini AI with attendee information.
 * @param {string} transcript - Raw transcript text to summarize
 * @param {string[]} attendees - List of meeting attendees
 * @param {string} channelName - Name of the meeting channel
 * @param {string} meetingTimestamp - Optional meeting timestamp to use instead of current time
 * @returns {Promise<string>} Generated summary
 */
async function summarizeTranscript(transcript, attendees, channelName, meetingTimestamp = null) {
    console.log('🤖 Generating summary with Gemini AI...');
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

    let meetingDate;
    if (meetingTimestamp) {
        // Parse the timestamp from filename (e.g., "2025-10-24T19-31-20-967Z")
        // Convert to proper ISO format: 2025-10-24T19:31:20.967Z
        const isoTimestamp = meetingTimestamp.replace(/(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, '$1:$2:$3.$4Z');
        const date = new Date(isoTimestamp);
        meetingDate = date.toLocaleString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZoneName: 'short'
        });
    } else {
        // Fallback to current time if no timestamp provided
        meetingDate = new Date().toLocaleString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZoneName: 'short'
        });
    }

    const prompt = `Provide a comprehensive meeting summary as a flowing narrative paragraph (no bullets or lists). Capture major topics, decisions (with rationale if present), action items, blockers, timelines, and follow-ups. Avoid naming specific people. Aim for substance over brevity; write at least 8–12 sentences when the transcript has enough content.

Meeting Details:
- Channel: ${channelName}
- Attendees: ${attendees.join(', ')}
- Date: ${meetingDate}

Transcript:
${transcript}

Output requirements:
- Only output the summary paragraph, no headers or extra text.
- If the transcript seems very short or incomplete, note that the transcript may be partial before summarizing.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let summary = response.text();

    // Clean up any unwanted formatting that AI might add
    summary = summary.trim();

    // Remove any duplicate formatting if AI still added it
    summary = summary.replace(/^========================================[\s\S]*?Summary:\s*/i, '');
    summary = summary.replace(/\n+========================================\s*$/i, '');
    summary = summary.trim();

    console.log('✅ Summary generated successfully');
    return summary;
}

/**
 * Saves the summary to a local text file, appending to channel-specific file.
 * @param {string} summary - The generated summary
 * @param {string[]} attendees - List of meeting attendees
 * @param {string} channelName - Name of the meeting channel
 * @param {string} meetingTimestamp - Optional meeting timestamp to use instead of current time
 * @returns {Promise<void>}
 */
async function saveSummaryLocally(summary, attendees, channelName, meetingTimestamp = null) {
    console.log('📄 Saving summary locally...');

    // Validate that summary is not empty
    if (!summary || summary.trim().length === 0) {
        console.error('❌ Cannot save empty summary');
        return;
    }

    // Create a single file per channel that appends new meetings
    const channelSummaryPath = `${SUMMARY_FOLDER}/${channelName}_meetings.txt`;

    // Format the meeting entry with date, attendees, and summary
    let meetingDate, meetingTime;

    if (meetingTimestamp) {
        // Parse the timestamp from filename (e.g., "2025-10-24T19-31-20-967Z")
        // Convert to proper ISO format: 2025-10-24T19:31:20.967Z
        const isoTimestamp = meetingTimestamp.replace(/(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, '$1:$2:$3.$4Z');
        const date = new Date(isoTimestamp);
        meetingDate = date.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        meetingTime = date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });
    } else {
        // Fallback to current time if no timestamp provided
        meetingDate = new Date().toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        meetingTime = new Date().toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });
    }

    const meetingEntry = `\n\n========================================\nDate: ${meetingDate} at ${meetingTime}\nAttendees: ${attendees.join(', ')}\n\nSummary:\n${summary}\n========================================\n`;

    // Append to the channel file
    try {
        await fsPromises.appendFile(channelSummaryPath, meetingEntry);
        console.log(`✅ Meeting summary appended to channel file: ${channelSummaryPath}`);
    } catch (error) {
        console.error('❌ Error appending to channel summary file:', error);
        // Fallback: create the file if it doesn't exist
        try {
            await fsPromises.writeFile(channelSummaryPath, meetingEntry);
            console.log(`✅ Created new channel summary file: ${channelSummaryPath}`);
        } catch (createError) {
            console.error('❌ Failed to create channel summary file:', createError);
        }
    }
}

// Export functions for use by the main bot
module.exports = {
    summarizeTranscript,
    saveSummaryLocally
};