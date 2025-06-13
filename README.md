# 🥂 Ordering Tool – Monorepo

A multi-part system for managing cocktail orders via WhatsApp, built with Node.js, Express, and PostgreSQL. This monorepo includes:

- A WhatsApp-integrated **backend** with PostgreSQL queueing and admin command support
- A lightweight **dashboard frontend** for queue management
- A simple **user-facing landing page** for order entry or QR/menu promotion

---

## 🗂️ Repository Structure

```
ordering-tool-main/
├── backend/             # Node.js server with WhatsApp webhook + queue API
├── queue-dashboard/     # Static dashboard UI for staff/admin
├── user-frontend/       # User-facing HTML page or order flow
```

---

## 🚀 Quick Start

### 1. Backend Setup

```bash
cd backend
cp .env.example .env
npm install
node seedDrinks.js         # Seeds the drinks table if not already populated
node server.js             # Starts the backend server (port 3000 by default)
```

### 2. Dashboard / Frontend Preview

Open directly in browser:

- `queue-dashboard/index.html` – Admin/staff dashboard UI
- `user-frontend/index.html` – Landing page or QR menu

---

## 🔧 Environment Variables

Create a `.env` file in `/backend/` with the following:

```env
PORT=3000
DATABASE_URL=postgres://user:pass@host:5432/dbname
DASHBOARD_PASS=somepassword
JWT_SECRET=your_jwt_secret
WHATSAPP_PHONE_NUMBER_ID=xxx
ACCESS_TOKEN=your_facebook_access_token
ADMIN_NUMBERS=15555551234,15555559876
DEBUG=true
FORCE_SEED=false
```

---

## 📦 Scripts

| Command | Description |
|--------|-------------|
| `npm start` | Starts the backend server |
| `node seedDrinks.js` | Seeds the drinks table from `drinks.json` |
| `npm run lint` | (Optional) Runs linter if added |
| `curl /health` | Health check route (checks DB connection) |

---

## ⚙️ Deployment

- **Backend:** Deploy to [Render](https://render.com) with Node + PostgreSQL
- **Dashboard:** Host `queue-dashboard/` on Netlify or GitHub Pages
- **User Frontend:** Same as above — consider QR code to link to this

---

## 🧪 Health Checks

- `GET /ping` – Returns `✅ Server is alive`
- `GET /health` – Checks DB connectivity and server status
- `POST /login` – Auth endpoint for dashboard JWT

---

## ✨ Features

- WhatsApp webhook integration (Facebook Cloud API)
- Admin commands via WhatsApp:
  - `queue` – show current queue
  - `clear` – clear queue
  - number (e.g., `1`) – mark order complete
- Frontend dashboard with JWT-protected `/queue`, `/done`, `/clear`

---

## 📌 TODO

- Add test coverage for webhook logic
- Improve error handling/logging in queue system
- Add CI workflow to validate backend + `/health` after deploy

---

## 📄 License

MIT License — see `LICENSE` file if applicable
