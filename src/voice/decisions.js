export function shouldAutoJoin({ humanCount, autoJoin, connected, channelId, allowedChannelIds }) {
  // An empty/absent allow-list means "any voice channel" (the pre-list behavior).
  const allowed = !allowedChannelIds?.length || allowedChannelIds.includes(channelId);
  return !!autoJoin && !connected && humanCount > 1 && allowed;
}

// Deliberately channel-list-unaware: a channel being removed from the allow-list
// mid-meeting must not stop the bot from leaving it when it empties.
export function shouldAutoLeave({ humanCount, connected }) {
  return !!connected && humanCount <= 1;
}
