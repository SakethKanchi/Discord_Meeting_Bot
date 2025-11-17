# Scheduler Feature - Operating Hours

The bot now includes a scheduler that automatically manages operating hours and daily cleanup.

## Operating Hours

- **Start Time:** 6:00 AM (local server time)
- **End Time:** 4:00 PM (local server time)

## How It Works

### During Operating Hours (6 AM - 4 PM)
- ✅ Bot will automatically join voice channels when 2+ humans are present
- ✅ Bot accepts `/join` and `!join` commands
- ✅ Bot records meetings normally

### Outside Operating Hours (Before 6 AM, After 4 PM)
- ❌ Bot will NOT auto-join voice channels
- ❌ Bot rejects `/join` and `!join` commands with a message
- ℹ️ Bot stays online but in standby mode
- ℹ️ Bot will automatically resume at 6 AM next day

### At 4:00 PM (Daily)
When the clock hits 4 PM, the bot automatically:

1. **Stops any active recording** - Gracefully stops current recordings
2. **Leaves voice channels** - Disconnects from all voice channels
3. **Runs uploader.js** - Uploads all summary files to Google Drive
4. **Deletes PCM files** - Cleans up temporary audio files from `PCM_Files/` folder
5. **Enters standby mode** - Bot stays online but won't record until 6 AM

## Configuration

You can modify the operating hours in `scheduler.js`:

```javascript
const START_HOUR = 6;  // 6 AM
const END_HOUR = 16;   // 4 PM (16:00)
```

## Manual Cleanup

If you need to manually run the cleanup (upload + delete PCM files), you can use:

```javascript
const { executeEndOfDayCleanup } = require('./scheduler.js');
await executeEndOfDayCleanup();
```

Or run the cleanup script directly:
```bash
node cleanup.js
```

## Timezone Considerations

⚠️ **Important:** The scheduler uses the server's local time. Make sure your hosting server is set to the correct timezone.

- For cloud hosting platforms, check their timezone settings
- For local development, the bot uses your computer's timezone
- Consider using environment variables for timezone if needed

## Troubleshooting

### Bot not recording during operating hours
- Check server timezone settings
- Verify current time is between 6 AM - 4 PM
- Check bot logs for scheduler messages

### Cleanup not running at 4 PM
- Check if `uploader.js` has valid credentials
- Verify `token.json` exists and is valid
- Check bot logs for errors

### Bot staying offline after 4 PM
- This is normal - bot enters standby mode
- Bot will automatically resume at 6 AM
- If using a process manager, ensure it keeps the bot running

## Process Manager Setup (Recommended)

For production hosting, use a process manager to ensure the bot restarts if it crashes:

### PM2 (Recommended)
```bash
npm install -g pm2
pm2 start bot.js --name discord-bot
pm2 save
pm2 startup
```

### Systemd (Linux)
Create `/etc/systemd/system/discord-bot.service`:
```ini
[Unit]
Description=Discord Bot
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/Discord_Bot
ExecStart=/usr/bin/node bot.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable discord-bot
sudo systemctl start discord-bot
```

## Notes

- The bot checks operating hours every minute
- If a recording is active when 4 PM hits, it will be stopped gracefully
- Summary files are uploaded BEFORE PCM files are deleted
- Bot status remains online during standby (just doesn't record)

