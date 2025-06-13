# 🧃 Cocktail Queue Dashboard

This is a lightweight admin dashboard for managing cocktail orders submitted via WhatsApp, powered by the WhatsApp Cloud API and a Node.js backend. This dashboard allows authenticated users to:

- 🔐 Login securely with a JWT token
- 📋 View live cocktail orders
- ✅ Mark drinks as served
- 🗑️ Clear the queue
- 🔄 Auto-refresh every 5s with sound + visual indicators for new orders

---

## 🗂️ Project Structure

```
queue-dashboard/
├── index.html         # Login screen
├── dashboard.html     # Main dashboard interface
├── login.js           # Handles login requests
├── dashboard.js       # Handles live queue updates
├── style.css          # Extra custom styling
```

---

## 🚀 Deploying on Render

### ✅ Static Site Settings

- **Root Directory:** `queue-dashboard`
- **Build Command:** *(leave blank)*
- **Publish Directory:** `.`

---

## 🔧 Environment

- Requires a working backend running at:  
  `https://your-backend.onrender.com`

Ensure the backend has:
- `/login` for JWT auth
- `/queue`, `/done`, and `/clear` endpoints
- CORS enabled

---

## 🔐 Login

The admin password is stored in your backend `.env` as:

```env
DASHBOARD_PASS=yourpassword
```

Once logged in, a JWT token is stored in `localStorage`.

---

## 🌟 Features

- ✅ Mobile-friendly Tailwind layout
- ✅ Scroll-snapping horizontal queue
- ✅ Sound alerts for new orders
- ✅ Timestamp and refresh controls
- ✅ Error handling for expired sessions

---

## 🧪 Testing Locally

To test locally:
1. Start your backend server
2. Open `index.html` in your browser (VSCode Live Server works great!)
3. Enter your admin password to begin managing orders

---

## 🛠️ Tech Stack

- HTML + Tailwind CSS
- Vanilla JS (modular)
- Axios for HTTP
- Deployed via Render

---

## 👨‍💻 Author

Built by [@gmedinat911](https://github.com/gmedinat911)

---
