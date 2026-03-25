# 🎵 Discogs MCP Server

[![Version](https://img.shields.io/badge/version-2.5.0-blue.svg)](https://github.com/rianvdm/discogs-mcp/releases/tag/v2.5.0)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MCP](https://img.shields.io/badge/MCP-2024--11--05-blue)](https://github.com/modelcontextprotocol)

A powerful **Model Context Protocol (MCP) server** that enables AI assistants to interact with your personal Discogs music collection. Built on Cloudflare Workers using the official **Cloudflare Agents SDK** and **@modelcontextprotocol/sdk**.

## ✨ Features

- 🔐 **Secure OAuth Authentication**: Connect your Discogs account safely
- 🧠 **Intelligent Mood Mapping**: Translate emotions into music ("mellow", "energetic", "Sunday evening vibes")
- 🔍 **Advanced Search Intelligence**: Multi-strategy search with OR logic and relevance scoring
- 📊 **Collection Analytics**: Comprehensive statistics and insights about your music
- 🎯 **Context-Aware Recommendations**: Smart suggestions based on mood, genre, and similarity
- ⚡ **Edge Computing**: Global low-latency responses via Cloudflare Workers
- 🗂️ **Smart Caching**: Intelligent KV-based caching for optimal performance

## 🚀 Quick Start

### Claude Desktop

1. Open Claude Desktop → **Settings** → **Integrations**
2. Click **Add Integration**
3. Enter the URL:
   ```
   https://discogs-mcp.com/mcp
   ```
4. Click **Add** - authenticate with Discogs when prompted

### Claude Code

```bash
claude mcp add --transport http discogs https://discogs-mcp.com/mcp
```

### Windsurf

Add to your Windsurf MCP config (`~/.codeium/windsurf/mcp_config.json`):

```json
{
	"mcpServers": {
		"discogs": {
			"serverUrl": "https://discogs-mcp.com/mcp"
		}
	}
}
```

### MCP Inspector (Testing)

```bash
npx @modelcontextprotocol/inspector https://discogs-mcp.com/mcp
```

### Other MCP Clients

**Continue.dev / Zed / Generic:**

```json
{
	"mcpServers": {
		"discogs": {
			"command": "npx",
			"args": ["-y", "mcp-remote", "https://discogs-mcp.com/mcp"]
		}
	}
}
```

## 🔐 Authentication

This server uses **MCP OAuth 2.1** with Discogs as the identity provider. When you connect for the first time:

1. Your MCP client automatically opens a browser window
2. Authorize the application on Discogs
3. You're redirected back and authenticated — no copy-pasting required
4. Your session persists for 7 days

## 🛠️ Available Tools

### 🔓 Public Tools (No Authentication Required)

| Tool          | Description                                            |
| ------------- | ------------------------------------------------------ |
| `ping`        | Test server connectivity                               |
| `server_info` | Get server information and capabilities                |
| `auth_status` | Check authentication status and get login instructions |

### 🔐 Authenticated Tools (Requires Login)

| Tool                   | Description                                                     |
| ---------------------- | --------------------------------------------------------------- |
| `search_collection`    | Search your collection with intelligent mood and genre matching |
| `get_release`          | Get detailed information about a specific release               |
| `get_collection_stats` | View comprehensive collection statistics                        |
| `get_recommendations`  | Get context-aware music recommendations                         |
| `get_cache_stats`      | Monitor cache performance (development)                         |

## 📚 MCP Resources

Access Discogs data via standardized MCP resource URIs:

```
discogs://collection             # Complete collection (JSON)
discogs://release/{id}           # Specific release details
discogs://search?q={query}       # Search results
```

## 🏗️ Development

### Prerequisites

- Node.js 18+
- Cloudflare account
- Discogs Developer Account (for API keys)

### Local Setup

1. **Clone and install**:

   ```bash
   git clone https://github.com/rianvdm/discogs-mcp.git
   cd discogs-mcp
   npm install
   ```

2. **Configure environment**:

   ```bash
   # Set your Discogs API credentials as Wrangler secrets
   wrangler secret put DISCOGS_CONSUMER_KEY
   wrangler secret put DISCOGS_CONSUMER_SECRET
   ```

3. **Start development server**:

   ```bash
   npm run dev
   ```

4. **Test with MCP Inspector**:
   ```bash
   npx @modelcontextprotocol/inspector http://localhost:8787/mcp
   ```

## 🚀 Deployment

1. **Create KV namespaces** and add their IDs to `wrangler.toml` under `[env.production]`:

   ```bash
   wrangler kv namespace create MCP_SESSIONS --env production
   wrangler kv namespace create MCP_LOGS --env production
   wrangler kv namespace create MCP_RL --env production
   wrangler kv namespace create OAUTH_KV --env production
   ```

2. **Set production secrets**:

   ```bash
   wrangler secret put DISCOGS_CONSUMER_KEY --env production
   wrangler secret put DISCOGS_CONSUMER_SECRET --env production
   ```

3. **Deploy**:
   ```bash
   npm run deploy:prod
   ```

## 🧪 Testing

```bash
npm test              # Run all tests
npm test -- --watch  # Run tests in watch mode
```

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Discogs](https://www.discogs.com/) for the music database API
- [Model Context Protocol](https://modelcontextprotocol.io/) for the standard
- [Cloudflare Workers](https://workers.cloudflare.com/) for the platform
