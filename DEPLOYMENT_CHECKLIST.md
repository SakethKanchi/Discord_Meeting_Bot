# Deployment Checklist

Use this checklist to ensure a smooth deployment of your Discord bot.

## Pre-Deployment

### Cloud Provider / VPS Setup
- [ ] Cloud provider account created (AWS, GCP, Azure, DigitalOcean, etc.)
- [ ] Compute instance/VPS created (Ubuntu 22.04 recommended)
- [ ] Public IP address noted
- [ ] SSH key pair generated/uploaded
- [ ] Security rules/firewall configured (SSH port 22)

### Discord Bot Setup
- [ ] Discord application created
- [ ] Bot created in Discord Developer Portal
- [ ] Bot token obtained
- [ ] Client ID obtained
- [ ] Bot invited to server with necessary permissions:
  - [ ] Connect to voice channels
  - [ ] Speak in voice channels
  - [ ] Send messages
  - [ ] Use slash commands
- [ ] Bot permissions verified in server

### API Keys
- [ ] Google Gemini API key obtained
- [ ] Google Drive API enabled (if using uploads)
- [ ] Google Drive credentials.json created (if using uploads)
- [ ] Google Drive folder ID obtained (if using uploads)

## Server Setup

### Initial Connection
- [ ] Connected to server/VPS via SSH
- [ ] System packages updated
- [ ] User permissions verified

### Dependencies Installation
- [ ] Node.js 18.x installed
- [ ] npm installed and verified
- [ ] Python 3.8+ installed
- [ ] pip3 installed
- [ ] FFmpeg installed
- [ ] Git installed
- [ ] Build tools installed

### Bot Files
- [ ] Bot repository cloned or files uploaded
- [ ] All bot files present in project directory
- [ ] Node.js dependencies installed (`npm install`)
- [ ] Python dependencies installed (`pip3 install -r requirements.txt`)

### Configuration
- [ ] `.env` file created
- [ ] `DISCORD_TOKEN` set in `.env`
- [ ] `DISCORD_CLIENT_ID` set in `.env`
- [ ] `GEMINI_API_KEY` set in `.env`
- [ ] `DISCORD_GUILD_ID` set (optional)
- [ ] `FOLDER_ID` set (if using Google Drive)
- [ ] `.env` file permissions secured (not world-readable)
- [ ] `credentials.json` uploaded (if using Google Drive)
- [ ] `token.json` generated (if using Google Drive)

### Directories
- [ ] `PCM_Files/` directory exists
- [ ] `Summary/` directory exists
- [ ] Directory permissions set correctly

## Process Management

### Choose One Option:

#### Option A: systemd
- [ ] `discord-bot.service` file created/uploaded
- [ ] Service file paths updated for your user/directory
- [ ] Service file copied to `/etc/systemd/system/`
- [ ] systemd daemon reloaded
- [ ] Service enabled (`systemctl enable discord-bot`)
- [ ] Service started (`systemctl start discord-bot`)
- [ ] Service status verified (`systemctl status discord-bot`)

#### Option B: PM2
- [ ] PM2 installed globally
- [ ] `ecosystem.config.js` configured
- [ ] Bot started with PM2
- [ ] PM2 save configured
- [ ] PM2 startup configured

## Testing

### Bot Functionality
- [ ] Bot appears online in Discord
- [ ] Slash commands visible (`/join`, `/leave`)
- [ ] Bot can join voice channel (`/join`)
- [ ] Bot records audio (check logs)
- [ ] Bot leaves voice channel (`/leave`)
- [ ] Logs show no errors

### Logs Verification
- [ ] Logs accessible (systemd journal or PM2 logs)
- [ ] No critical errors in logs
- [ ] Bot connects to Discord successfully
- [ ] Audio processing working (if tested)

## Post-Deployment

### Monitoring
- [ ] Log monitoring set up
- [ ] Error alerting configured (optional)
- [ ] Disk space monitoring (for audio files)
- [ ] Bot uptime verified

### Maintenance
- [ ] Update procedure documented
- [ ] Backup strategy in place
- [ ] Cleanup scripts tested
- [ ] Scheduled tasks configured (if needed)

### Security
- [ ] `.env` file not committed to git
- [ ] SSH key authentication working
- [ ] Firewall configured (if needed)
- [ ] Regular updates scheduled

## Troubleshooting Reference

If any step fails, check:
1. **Logs**: `sudo journalctl -u discord-bot -n 100` or `pm2 logs discord-bot`
2. **Environment**: Verify all `.env` variables are set
3. **Dependencies**: Run `npm list` and `pip3 list` to verify
4. **Permissions**: Check file/directory ownership
5. **Network**: Verify internet connectivity and Discord API access

## Quick Verification Commands

```bash
# Check bot status
sudo systemctl status discord-bot
# or
pm2 status

# View recent logs
sudo journalctl -u discord-bot -n 50
# or
pm2 logs discord-bot --lines 50

# Verify environment
cat .env | grep -v "=" | wc -l  # Should show 0 (all vars have values)

# Check Node.js
node --version  # Should be v18.x.x

# Check Python
python3 --version  # Should be 3.8+

# Check FFmpeg
ffmpeg -version  # Should show version info

# Test bot manually
node bot.js  # Should connect and show ready message
```

## Success Criteria

✅ Bot is online in Discord
✅ Slash commands work
✅ Bot can join/leave voice channels
✅ Recording functionality works (if tested)
✅ No errors in logs
✅ Bot restarts automatically after reboot (if systemd/PM2 configured)

---

**Deployment Date**: _______________
**Deployed By**: _______________
**Instance IP**: _______________
**Notes**: _______________

