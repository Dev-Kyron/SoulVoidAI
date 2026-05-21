# Discord MCP — VoidSoul server bootstrap

A small MCP server that lets VoidSoul Assistant configure a Discord
guild (create categories, channels, roles, post welcome messages).

Designed for one-shot server setup, not runtime chat operations — when
you're done bootstrapping, you can remove it from MCP Servers if you
don't want the tools cluttering your agent loop.

## One-time setup

### 1. Make a Discord bot

1. https://discord.com/developers/applications → **New Application** →
   call it `Void Soul Studio Bot`.
2. **Bot** tab → **Reset Token** → copy the token. Treat it like a
   password — anyone with this token can do anything in any server
   the bot is in.
3. **OAuth2 → URL Generator** → tick `bot` + `applications.commands` →
   permissions: tick **Administrator** (we revoke this after setup if
   you want a tighter ongoing scope).
4. Paste the generated URL in a browser → pick `Void Soul Studio` →
   **Authorise**. The bot now appears in your server's member list.

### 2. Find the guild (server) ID

Discord → **User Settings → Advanced → Developer Mode** ON.
Right-click your server icon → **Copy Server ID**.

### 3. Wire the MCP server into VoidSoul Assistant

VoidSoul → **Settings → MCP Servers → Add server**:

| Field   | Value                                                                          |
| ------- | ------------------------------------------------------------------------------ |
| Name    | `Discord`                                                                      |
| Command | `node`                                                                         |
| Args    | absolute path to `server.js`, e.g. `C:\Users\Kyron\VoidSoulAssistant\tools\discord-mcp\server.js` |
| Env     | `DISCORD_BOT_TOKEN=<the token>` and `DISCORD_GUILD_ID=<the server id>`          |

Save → toggle the server on. The agent now has these tools:

- `discord_get_server_info` — health probe, returns counts.
- `discord_list_channels`
- `discord_list_roles`
- `discord_create_category`
- `discord_create_text_channel`
- `discord_create_role`
- `discord_send_message`
- `discord_pin_message`

### 4. Bootstrap the server

Open VoidSoul Assistant → ask:

> Apply my Void Soul Studio server blueprint. Use the Discord MCP.
> First call `discord_get_server_info` to confirm the connection,
> then run `discord_list_channels` and `discord_list_roles` so you
> don't make duplicates. Then create the categories and channels
> following the structure I'll paste next.

Paste the blueprint (see the chat with Claude for the full one,
or `BLUEPRINT.md` if you've checked one in).

Watch the agent step through creating each category, channel, and
role. If anything fails (permissions, rate limit), the tool returns
the Discord error verbatim so you can fix it.

## Security

- The bot token lives only in your VoidSoul MCP env config. It never
  hits this repo.
- If the token leaks, regenerate it in the Developer Portal under
  Bot → Reset Token and update the MCP env.
- After bootstrap, you can downgrade the bot from Administrator to a
  narrower role (Manage Channels + Manage Roles is usually enough
  for ongoing maintenance) via Server Settings → Roles → the bot's
  auto-created role.
