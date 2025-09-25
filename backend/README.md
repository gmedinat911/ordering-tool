# WhatsApp Cocktail Queue Bot

Lightweight Node.js service enabling cocktail orders via WhatsApp and dashboard management for admins.

---

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Data Modeling (](#data-modeling-drinksjson)[`drinks.json`](#data-modeling-drinksjson)[)](#data-modeling-drinksjson)
- [Running Locally](#running-locally)
- [Usage](#usage)
  - [Customer Flow](#customer-flow)
  - [Admin Commands](#admin-commands)
  - [Admin Dashboard & API](#admin-dashboard--api)
- [Deployment](#deployment)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **WhatsApp Ordering**: Customers message: `I'd like to order the Cosmo Crush`.
- **Flexible Menu Mapping** via `drinks.json` for trigger phrases and display names.
- **In-Memory Queue**: FIFO order sorting by timestamp.
- **Admin via WhatsApp**: Whitelisted numbers send `queue`, `clear`, or an index to manage orders.
- **Protected API**: JWT-secured `/queue`, `/clear`, and `/done` endpoints for external dashboards.
- **Ready to Deploy**: Compatible with Render.com or any Node.js host.

---

## Prerequisites

- Node.js v16+ (LTS recommended)
- Meta WhatsApp Business API account
- Hosting platform (e.g., Render.com)

---

## Installation

```bash
git clone https://github.com/your-org/whatsapp-cocktail-bot.git
cd whatsapp-cocktail-bot
npm install
```

---

## Configuration

1. Copy and edit environment variables:
   ```bash
   cp .env.example .env
   ```
2. Update `.env`:
   ```ini
   PORT=3000                  # default: 3000
   DEBUG=true                 # verbose logging
   DASHBOARD_PASS=yourPass
   JWT_SECRET=yourJwtKey

   WHATSAPP_PHONE_NUMBER_ID=1234567890
   # Use either WHATSAPP_TOKEN or ACCESS_TOKEN for the Meta Graph API token
   WHATSAPP_TOKEN=EAA...ZD
   # ACCESS_TOKEN=EAA...ZD
   ADMIN_NUMBERS=+15551234567,+15557654321
   ```

---

## Data Modeling (`drinks.json`)

```json
{
  "cosmo crush": { "canonical": "Cosmopolitan", "display": "Cosmo Crush" },
  "mint mojito": { "canonical": "Mojito", "display": "Mint Mojito" }
}
```

- **Key**: lowercase trigger phrase
- ``: internal name
- ``: user-facing name

Fuzzy matching on `canonical` is supported when exact key is missing.

---

## Running Locally

```bash
npm start
```

Verify with browser or `curl`:

```bash
curl http://localhost:3000/health
# ✅ Server is alive
```

---

## Usage

### Customer Flow

1. WhatsApp message to bot:
   > I'd like to order the Espresso Chilltini
2. Bot replies:
   > 👨‍🍳 Hi Gabrielle, we received your order for "Espresso Chilltini".

Orders queue in FIFO and await admin action.

### Admin Commands

- `queue`: list pending orders
- `clear`: empty the queue
- `<number>`: serve that order (notifies customer)

Example:

```text
queue
#1 • Avi → Cosmopolitan
#2 • Gabrielle → Mojito
```

Reply `2` to serve Gabrielle’s Mojito.

### Admin Dashboard & API

1. Obtain JWT:
   ```bash
   curl -X POST http://localhost:3000/login \
     -H 'Content-Type: application/json' \
     -d '{"password":"yourPass"}'
   ```
2. Use JWT to call protected endpoints:
   ```bash
   curl http://localhost:3000/queue \
     -H 'Authorization: Bearer <TOKEN>'
   ```

| Method | Route    | Description            |
| ------ | -------- | ---------------------- |
| GET    | `/queue` | List all orders        |
| POST   | `/clear` | Clear the queue        |
| POST   | `/done`  | Mark one order as done |

Payload for `/done`:

```json
{ "id": 1625647382910 }
```

---

## Deployment

### Deploy on Render.com

1. Create Web Service and connect repo.
2. Set environment variables in Render dashboard.
3. Build & Start commands:
   ```bash
   npm install
   npm start
   ```
4. Point WhatsApp webhook to: `https://<your-service>.render.com/webhook`

---

## Contributing

1. Fork & branch
2. Code & test
3. PR for review

---

## License

This project is licensed under the [MIT License](LICENSE).

